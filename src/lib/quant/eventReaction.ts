// ============================================================================
// FILE: src/lib/quant/eventReaction.ts
// MODULE: STRATEGY 2 - EVENT REACTION ALPHA ENGINE
// ARCHITECTURE: Point-in-Time Event Context -> Surprise -> Price Confirmation -> SignalOutput
// ============================================================================

import type {
  StrategyContext,
  StrategyState,
  SignalOutput,
  PointInTimeBar,
  AssetId,
} from "@/lib/quant/types";
import { BAR_DURATION_MS, BARS_PER_YEAR } from "@/lib/quant/timeDomain";

// ----------------------------------------------------------------------------
// 1. CONFIGURATION INTERFACE & DEFAULT PARAMETERS
// ----------------------------------------------------------------------------

export interface EventReactionConfig {
  readonly minSurpriseRelativeThreshold: number; // Độ lệch tối thiểu (|Actual - Consensus| / |Consensus|) (mặc định 0.05 = 5%)
  readonly halfLifeDecayBars: number;            // Chu kỳ bán rã của cú sốc tin tức (mặc định 2 phiên)
  readonly maxHoldingPeriodBars: number;         // Kỳ hạn nắm giữ tối đa theo sự kiện (mặc định 5 phiên)
  readonly priceConfirmationToleranceBps: number;// Ngưỡng biến động giá tối thiểu để xác nhận đà (mặc định 15 bps = 0.0015)
  readonly volSpikeFilterZScore: number;         // Ngưỡng VIX Z-Score biến động quá cao làm méo tín hiệu (mặc định 2.5)
  readonly assumedInformationRatio: number;      // Giả định IR phục vụ tính expectedReturn (mặc định 0.45)
  readonly defaultVolAnnualized: number;         // Mức biến động sàn nếu thiếu dữ liệu (mặc định 0.25)
}

export const DEFAULT_EVENT_REACTION_CONFIG: EventReactionConfig = {
  minSurpriseRelativeThreshold: 0.05,
  halfLifeDecayBars: 2,
  maxHoldingPeriodBars: 5,
  priceConfirmationToleranceBps: 0.0015,
  volSpikeFilterZScore: 2.5,
  assumedInformationRatio: 0.45,
  defaultVolAnnualized: 0.25,
};

// ----------------------------------------------------------------------------
// 2. MATH & POINT-IN-TIME SENSITIVITY HELPERS
// ----------------------------------------------------------------------------

function calculateRealizedVolAnnualized(bars: readonly PointInTimeBar[], period = 20): number | null {
  if (bars.length < period + 1) return null;
  const slice = bars.slice(-period - 1);
  const logReturns: number[] = [];

  for (let i = 1; i < slice.length; i++) {
    const prev = slice[i - 1].close;
    const curr = slice[i].close;
    if (prev <= 0 || curr <= 0) return null;
    logReturns.push(Math.log(curr / prev));
  }

  if (logReturns.length === 0) return null;
  const mean = logReturns.reduce((sum, r) => sum + r, 0) / logReturns.length;
  const variance = logReturns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (logReturns.length - 1);
  // Annualize using 1H bars per year (BARS_PER_YEAR = 8760), not 252 trading days
  return Math.sqrt(variance * BARS_PER_YEAR);
}

/**
 * Xác định giả thuyết tác động của Surprise lên từng lớp tài sản.
 * Trả về: +1 (Kỳ vọng tăng giá), -1 (Kỳ vọng giảm giá), 0 (Không nhạy cảm)
 */
function getExpectedDirectionHypothesis(
  eventType: string,
  assetId: AssetId,
  surprise: number
): number {
  const typeLower = eventType.toLowerCase();
  const isTighteningSurprise = surprise > 0; // Số liệu lạm phát cao hơn dự báo, hoặc tăng lãi suất ngoài dự kiến

  // 1. Nhóm sự kiện Lạm phát / Lãi suất (CPI, PPI, Fed Rate Decision, Non-farm Payrolls)
  if (typeLower.includes("cpi") || typeLower.includes("inflation") || typeLower.includes("rate") || typeLower.includes("fed") || typeLower.includes("payroll")) {
    if (assetId === "BTC" || assetId === "VNINDEX") {
      // Thắt chặt tiền tệ / Lạm phát cao -> Bất lợi cho tài sản rủi ro (Equities, Crypto)
      return isTighteningSurprise ? -1 : 1;
    }
    if (assetId === "DXY" || assetId === "US10Y" || assetId === "US2Y") {
      // Lãi suất kỳ vọng tăng -> Hỗ trợ Dollar và đẩy lợi suất trái phiếu tăng
      return isTighteningSurprise ? 1 : -1;
    }
    if (assetId === "GOLD") {
      // Vàng chịu 2 lực đối nghịch: phòng hộ lạm phát (+) nhưng chịu áp lực từ USD & lợi suất cao (-)
      // Ngắn hạn: Lợi suất thực tăng vọt thường ép giá vàng giảm
      return isTighteningSurprise ? -1 : 1;
    }
  }

  // 2. Nhóm sự kiện Địa chính trị / Cú sốc chiến sự (War, Geopolitics, Sanctions)
  if (typeLower.includes("geopolitic") || typeLower.includes("war") || typeLower.includes("conflict") || typeLower.includes("crisis")) {
    if (assetId === "GOLD" || assetId === "DXY") return 1; // Hầm trú ẩn an toàn
    if (assetId === "VNINDEX" || assetId === "BTC") return -1; // Rút lui tài sản rủi ro
  }

  return 0;
}

// ----------------------------------------------------------------------------
// 3. CORE EVENT REACTION EVALUATION ENGINE
// ----------------------------------------------------------------------------

export function evaluateEventReaction(
  context: StrategyContext,
  _state: StrategyState,
  config: EventReactionConfig = DEFAULT_EVENT_REACTION_CONFIG
): SignalOutput {
  const { latestEvent, decisionTimestamp, currentBarTimestamp, currentPrice, priceHistory, strategyId, assetId, macro } = context;

  // RULE A: LOOK-AHEAD BIAS GUARD
  // Nếu không có sự kiện, hoặc sự kiện chưa tới giờ công bố chính thức tại thời điểm quyết định T
  if (!latestEvent || decisionTimestamp < latestEvent.publicationTimestamp) {
    return {
      strategyId,
      assetId,
      timestamp: currentBarTimestamp,
      alphaScore: 0,
      heuristicExpectedReturn: 0,
      confidence: 0,
      forecastVol: 0,
      holdingPeriod: 0,
      decayRate: null,
      validUntil: null,
      rationale: !latestEvent 
        ? "NO_EVENT_PRESENT" 
        : `EVENT_UNPUBLISHED: DecisionTime (${decisionTimestamp}) < PublicationTime (${latestEvent.publicationTimestamp})`,
      metadata: null,
    };
  }

  // RULE B: SURPRISE INTEGRITY CHECK
  // Bắt buộc phải có Actual và Consensus để tính Surprise
  if (latestEvent.actual === null || latestEvent.consensus === null || latestEvent.surprise === null) {
    return {
      strategyId,
      assetId,
      timestamp: currentBarTimestamp,
      alphaScore: 0,
      heuristicExpectedReturn: 0,
      confidence: 0,
      forecastVol: 0,
      holdingPeriod: 0,
      decayRate: null,
      validUntil: null,
      rationale: "EVENT_MISSING_SURPRISE_DATA: Actual or Consensus is null",
      metadata: null,
    };
  }

  // RULE C: TUỔI CỦA SỰ KIỆN & CHU KỲ NẮM GIỮ TỐI ĐA (EXPIRY)
  // Count elapsed 1H bars, not calendar days. 1 bar = BAR_DURATION_MS = 3_600_000ms
  const elapsedMs = decisionTimestamp - latestEvent.publicationTimestamp;
  const elapsedBars = Math.floor(elapsedMs / BAR_DURATION_MS);

  if (elapsedBars >= config.maxHoldingPeriodBars) {
    return {
      strategyId,
      assetId,
      timestamp: currentBarTimestamp,
      alphaScore: 0,
      heuristicExpectedReturn: 0,
      confidence: 0,
      forecastVol: 0,
      holdingPeriod: 0,
      decayRate: null,
      validUntil: null,
      rationale: `EVENT_EXPIRED: Elapsed bars (${elapsedBars}) >= MaxHoldingPeriod (${config.maxHoldingPeriodBars})`,
      metadata: { elapsedBars },
    };
  }

  // 1. TÍNH TOÁN ĐỘ LỆCH TƯƠNG ĐỐI CỦA SURPRISE
  const consensusAbs = Math.abs(latestEvent.consensus) || 1.0;
  const relativeSurprise = Math.abs(latestEvent.surprise) / consensusAbs;

  if (relativeSurprise < config.minSurpriseRelativeThreshold) {
    return {
      strategyId,
      assetId,
      timestamp: currentBarTimestamp,
      alphaScore: 0,
      heuristicExpectedReturn: 0,
      confidence: 0,
      forecastVol: 0,
      holdingPeriod: 0,
      decayRate: null,
      validUntil: null,
      rationale: `INSIGNIFICANT_SURPRISE: Relative surprise (${(relativeSurprise * 100).toFixed(2)}%) < Threshold (${(config.minSurpriseRelativeThreshold * 100).toFixed(2)}%)`,
      metadata: { relativeSurprise },
    };
  }

  // 2. THIẾT LẬP GIẢ THUYẾT HƯỚNG TÁC ĐỘNG (THEORETICAL TRANSMISSION)
  const expectedDirection = getExpectedDirectionHypothesis(latestEvent.eventType, assetId, latestEvent.surprise);
  if (expectedDirection === 0) {
    return {
      strategyId,
      assetId,
      timestamp: currentBarTimestamp,
      alphaScore: 0,
      heuristicExpectedReturn: 0,
      confidence: 0,
      forecastVol: 0,
      holdingPeriod: 0,
      decayRate: null,
      validUntil: null,
      rationale: `ASSET_EVENT_NEUTRAL: ${assetId} has no systematic exposure to ${latestEvent.eventType}`,
      metadata: null,
    };
  }

  // 3. XÁC NHẬN TỪ PHẢN ỨNG CỦA THỊ TRƯỜNG (MARKET CONFIRMATION CHECK)
  // Tìm mức giá đóng cửa gần nhất trước thời điểm tin tức công bố
  let preEventPrice = currentPrice;
  for (let i = priceHistory.length - 1; i >= 0; i--) {
    if (priceHistory[i].timestamp <= latestEvent.publicationTimestamp) {
      preEventPrice = priceHistory[i].close;
      break;
    }
  }

  const postEventReturn = preEventPrice > 0 ? (currentPrice - preEventPrice) / preEventPrice : 0;
  const marketDirection = Math.sign(postEventReturn);

  // So sánh phản ứng thị trường với giả thuyết ban đầu
  let confirmationMultiplier = 0.5; // Mặc định nếu giá chưa kịp biến động
  let marketConfirms = false;

  if (Math.abs(postEventReturn) >= config.priceConfirmationToleranceBps) {
    if (marketDirection === expectedDirection) {
      // Thị trường đồng thuận với giả thuyết vĩ mô -> Đà tăng cường (Momentum)
      marketConfirms = true;
      confirmationMultiplier = 1.0;
    } else {
      // Thị trường hành động ngược lại (Fade / Disagreement) -> Triệt tiêu tín hiệu
      marketConfirms = false;
      confirmationMultiplier = 0.15;
    }
  }

  // 4. BỘ LỌC BIẾN ĐỘNG CỰC ĐOAN (VOLATILITY PANIC FILTER)
  // Nếu VIX Z-Score quá cao, tin tức tạo nhiễu nhiều hơn xu hướng, giảm mức độ tin cậy
  const vixZ = macro?.vixZScore ?? 0;
  const volFilterMultiplier = vixZ > config.volSpikeFilterZScore ? 0.5 : 1.0;

  // 5. TÍNH TOÁN SUY GIẢM TÍN HIỆU THEO THỜI GIAN (EXPONENTIAL HALF-LIFE DECAY)
  // Công thức: DecayMultiplier = 0.5 ^ (elapsedBars / halfLife)
  // elapsedBars counts 1H bars elapsed since the event publication
  const decayMultiplier = Math.pow(0.5, elapsedBars / config.halfLifeDecayBars);
  const decayRatePerBar = 1.0 - Math.pow(0.5, 1.0 / config.halfLifeDecayBars);

  // 6. TÍNH TOÁN ALPHA SCORE VÀ CONFIDENCE
  const sourceWeight = latestEvent.sourceQuality === "TIER_1_OFFICIAL" ? 1.0 : latestEvent.sourceQuality === "TIER_2_BROKER" ? 0.7 : 0.3;
  const noveltyBonus = latestEvent.noveltyScore !== null ? 0.8 + 0.4 * latestEvent.noveltyScore : 1.0;

  let rawAlphaScore = expectedDirection * confirmationMultiplier * decayMultiplier * sourceWeight;
  rawAlphaScore = Math.max(-1.0, Math.min(1.0, rawAlphaScore));

  const confidence = Math.min(1.0, Math.max(0.05, 
    sourceWeight * confirmationMultiplier * volFilterMultiplier * decayMultiplier * noveltyBonus
  ));

  // 7. BIẾN ĐỘNG DỰ BÁO VÀ KỲ VỌNG LỢI NHUẬN (GRINOLD-KAHN)
  const forecastVol = calculateRealizedVolAnnualized(priceHistory, 20) ?? config.defaultVolAnnualized;
  const expectedReturn = rawAlphaScore * forecastVol * config.assumedInformationRatio;

  const remainingHoldingPeriod = Math.max(1, config.maxHoldingPeriodBars - elapsedBars);
  // validUntil uses 1H BAR_DURATION_MS, not 86_400_000 (1 day)
  const validUntilTimestamp = latestEvent.publicationTimestamp + config.maxHoldingPeriodBars * BAR_DURATION_MS;

  return {
    strategyId,
    assetId,
    timestamp: currentBarTimestamp,
    alphaScore: Math.round(rawAlphaScore * 1000) / 1000,
    heuristicExpectedReturn: Math.round(expectedReturn * 10000) / 10000,
    confidence: Math.round(confidence * 100) / 100,
    forecastVol: Math.round(forecastVol * 1000) / 1000,
    holdingPeriod: remainingHoldingPeriod,
    decayRate: Math.round(decayRatePerBar * 1000) / 1000,
    validUntil: validUntilTimestamp,
    rationale: `EventReaction[${latestEvent.eventType}]: Surprise=${latestEvent.surprise > 0 ? "+" : ""}${latestEvent.surprise}, Confirms=${marketConfirms}, Decay=${decayMultiplier.toFixed(2)}`,
    metadata: {
      eventId: latestEvent.eventId,
      eventType: latestEvent.eventType,
      surprise: latestEvent.surprise,
      relativeSurprise,
      expectedDirection,
      postEventReturn,
      marketConfirms,
      elapsedBars,
      decayMultiplier,
      sourceQuality: latestEvent.sourceQuality,
    },
  };
}

// ----------------------------------------------------------------------------
// 4. STRATEGY STATE TRANSITION HANDLER
// ----------------------------------------------------------------------------

export function updateEventReactionState(
  context: StrategyContext,
  previousState: StrategyState,
  signal: SignalOutput
): StrategyState {
  const isSignalActive = Math.abs(signal.alphaScore) > 0.05;

  return {
    strategyId: context.strategyId,
    lastEvaluationTimestamp: context.decisionTimestamp,
    barsSinceLastSignal: isSignalActive ? 0 : previousState.barsSinceLastSignal + 1,
    internalValues: {
      lastAlphaScore: signal.alphaScore,
      lastExpectedReturn: signal.heuristicExpectedReturn,
      confidence: signal.confidence,
      activeEventId: context.latestEvent?.eventId ?? null,
      holdingPeriodRemaining: signal.holdingPeriod,
    },
  };
}