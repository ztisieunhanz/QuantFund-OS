// ============================================================================
// FILE: src/lib/quant/adaptiveTrend.ts
// MODULE: STRATEGY 1 - ADAPTIVE TREND ALPHA ENGINE
// ARCHITECTURE: Point-in-Time Context -> Multi-Horizon Momentum -> SignalOutput
// ============================================================================

import type {
  StrategyContext,
  StrategyState,
  SignalOutput,
  PointInTimeBar,
} from "@/lib/quant/types";

// ----------------------------------------------------------------------------
// 1. CONFIGURATION INTERFACE & DEFAULT PARAMETERS
// ----------------------------------------------------------------------------

export interface AdaptiveTrendConfig {
  readonly lookbackShortBars: number;       // Mốc xu hướng ngắn hạn (mặc định 20)
  readonly lookbackMediumBars: number;      // Mốc xu hướng trung hạn (mặc định 60)
  readonly lookbackLongBars: number;        // Mốc xu hướng cấu trúc dài hạn (mặc định 120)
  readonly atrPeriodBars: number;           // Chu kỳ tính True Range (mặc định 14)
  readonly chandelierAtrMultiplier: number; // Hệ số Chandelier trailing distance (mặc định 3.0)
  readonly trendPersistenceThreshold: number; // Tỷ lệ phiên đồng thuận tối thiểu (mặc định 0.55)
  readonly baseHoldingPeriodBars: number;   // Kỳ hạn giữ lệnh danh định (mặc định 20)
  readonly assumedInformationRatio: number; // Giả định IR để tính expectedReturn (mặc định 0.4)
}

export const DEFAULT_ADAPTIVE_TREND_CONFIG: AdaptiveTrendConfig = {
  lookbackShortBars: 20,
  lookbackMediumBars: 60,
  lookbackLongBars: 120,
  atrPeriodBars: 14,
  chandelierAtrMultiplier: 3.0,
  trendPersistenceThreshold: 0.55,
  baseHoldingPeriodBars: 20,
  assumedInformationRatio: 0.4,
};

// ----------------------------------------------------------------------------
// 2. MATH HELPERS (POINT-IN-TIME, STRICTLY LOCAL)
// ----------------------------------------------------------------------------

function calculateTrueRange(current: PointInTimeBar, previous: PointInTimeBar): number {
  const highLow = current.high - current.low;
  const highPrevClose = Math.abs(current.high - previous.close);
  const lowPrevClose = Math.abs(current.low - previous.close);
  return Math.max(highLow, highPrevClose, lowPrevClose);
}

function calculateAtr(bars: readonly PointInTimeBar[], period: number): number | null {
  if (bars.length < period + 1) return null;
  const slice = bars.slice(-period - 1);
  let trSum = 0;
  for (let i = 1; i < slice.length; i++) {
    trSum += calculateTrueRange(slice[i], slice[i - 1]);
  }
  return trSum / period;
}

function calculateRealizedVolAnnualized(bars: readonly PointInTimeBar[], period: number): number | null {
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
  return Math.sqrt(variance * 252);
}

function calculateSMA(bars: readonly PointInTimeBar[], period: number): number | null {
  if (bars.length < period) return null;
  const slice = bars.slice(-period);
  const sum = slice.reduce((acc, bar) => acc + bar.close, 0);
  return sum / period;
}

// ----------------------------------------------------------------------------
// 3. CORE ALPHA EVALUATION ENGINE
// ----------------------------------------------------------------------------

export function evaluateAdaptiveTrend(
  context: StrategyContext,
  state: StrategyState,
  config: AdaptiveTrendConfig = DEFAULT_ADAPTIVE_TREND_CONFIG
): SignalOutput {
  const { priceHistory, currentPrice, currentBarTimestamp, strategyId, assetId } = context;

  // WARM-UP GUARD: Bắt buộc đủ số nến lookback tối đa để tránh bóp méo thống kê
  if (priceHistory.length < config.lookbackLongBars) {
    return {
      strategyId,
      assetId,
      timestamp: currentBarTimestamp,
      alphaScore: 0,
      expectedReturn: 0,
      confidence: 0,
      forecastVol: 0,
      holdingPeriod: config.baseHoldingPeriodBars,
      decayRate: null,
      validUntil: null,
      rationale: `INSUFFICIENT_WARMUP: History length (${priceHistory.length}) < LookbackLong (${config.lookbackLongBars})`,
      metadata: { warmupRemainingBars: config.lookbackLongBars - priceHistory.length },
    };
  }

  const len = priceHistory.length;
  const pCurrent = currentPrice > 0 ? currentPrice : priceHistory[len - 1].close;

  // 1. TÍNH LỢI NHUẬN ĐA KỲ HẠN (MULTI-HORIZON RETURN MOMENTUM)
  const pShort = priceHistory[len - 1 - config.lookbackShortBars].close;
  const pMedium = priceHistory[len - 1 - config.lookbackMediumBars].close;
  const pLong = priceHistory[len - 1 - config.lookbackLongBars].close;

  const returnShort = (pCurrent - pShort) / pShort;
  const returnMedium = (pCurrent - pMedium) / pMedium;
  const returnLong = (pCurrent - pLong) / pLong;

  // 2. ĐO LƯỜNG TÍNH KIÊN ĐỊNH CỦA XU HƯỚNG (TREND PERSISTENCE)
  // Tỷ lệ số nến đóng cửa trên đường MA ngắn hạn trong chu kỳ trung hạn
  const smaShort = calculateSMA(priceHistory, config.lookbackShortBars);
  const mediumWindow = priceHistory.slice(-config.lookbackMediumBars);
  let aboveSmaCount = 0;

  for (const bar of mediumWindow) {
    if (smaShort !== null && bar.close > smaShort) {
      aboveSmaCount++;
    }
  }
  const persistenceRatio = aboveSmaCount / config.lookbackMediumBars;

  // 3. BIẾN ĐỘNG DỰ BÁO (FORECAST VOLATILITY TỪ LOG RETURN ĐÃ QUA)
  const forecastVol = calculateRealizedVolAnnualized(priceHistory, config.lookbackShortBars) ?? 0.20;

  // 4. KIỂM TRA CHANDELIER TRAILING STOP LEVEL (KHÔNG PHỤC VỤ CUT LOSS, DÙNG ĐỂ NHẬN DIỆN EXHAUSTION)
  const atr = calculateAtr(priceHistory, config.atrPeriodBars);
  let chandelierExitTriggered = false;

  if (atr !== null) {
    const recentBars = priceHistory.slice(-config.lookbackShortBars);
    const highestHigh = Math.max(...recentBars.map((b) => b.high));
    const chandelierStopPrice = highestHigh - config.chandelierAtrMultiplier * atr;
    if (pCurrent < chandelierStopPrice) {
      chandelierExitTriggered = true;
    }
  }

  // 5. TỔNG HỢP VECTOR TÍN HIỆU ALPHA SCORE [-1.0 .. +1.0]
  // Gán trọng số giảm dần từ dài hạn đến ngắn hạn: Long(40%), Med(35%), Short(25%)
  const signShort = Math.sign(returnShort);
  const signMed = Math.sign(returnMedium);
  const signLong = Math.sign(returnLong);

  let rawScore = signLong * 0.40 + signMed * 0.35 + signShort * 0.25;

  // Điều chỉnh xung lực xu hướng nếu tính kiên định (persistence) vượt ngưỡng
  if (rawScore > 0 && persistenceRatio >= config.trendPersistenceThreshold) {
    rawScore = Math.min(1.0, rawScore * (1 + (persistenceRatio - config.trendPersistenceThreshold)));
  } else if (rawScore < 0 && (1 - persistenceRatio) >= config.trendPersistenceThreshold) {
    rawScore = Math.max(-1.0, rawScore * (1 + ((1 - persistenceRatio) - config.trendPersistenceThreshold)));
  }

  // Nếu vi phạm Chandelier Stop trong pha tăng, bẻ gãy Alpha Score về Neutral
  if (rawScore > 0 && chandelierExitTriggered) {
    rawScore = 0.0;
  }

  // 6. ĐÁNH GIÁ ĐỘ TIN CẬY THỐNG KÊ (CONFIDENCE [0.0 .. 1.0])
  // Đồng thuận 3 khung = độ tin cậy tối đa; phân kỳ giữa các khung = độ tin cậy thấp
  const directionalAgreement = (signShort === signMed && signMed === signLong) ? 1.0 : (signMed === signLong ? 0.65 : 0.30);
  const confidence = Math.min(1.0, Math.max(0.1, directionalAgreement * (persistenceRatio >= 0.5 ? persistenceRatio : 1 - persistenceRatio)));

  // 7. DỰ BÁO TỶ SUẤT KỲ VỌNG (EXPECTED RETURN)
  // Phỏng theo nguyên lý Grinold-Kahn: Expected Return = AlphaScore * ForecastVol * IR
  const expectedReturn = rawScore * forecastVol * config.assumedInformationRatio;

  // 8. TÍNH TOÁN HOLDING PERIOD LINH HOẠT THEO ĐỘ MẠNH CỦA TREND
  const holdingPeriod = directionalAgreement === 1.0 
    ? Math.round(config.baseHoldingPeriodBars * 1.5) 
    : config.baseHoldingPeriodBars;

  return {
    strategyId,
    assetId,
    timestamp: currentBarTimestamp,
    alphaScore: Math.round(rawScore * 1000) / 1000,
    expectedReturn: Math.round(expectedReturn * 10000) / 10000,
    confidence: Math.round(confidence * 100) / 100,
    forecastVol: Math.round(forecastVol * 1000) / 1000,
    holdingPeriod,
    decayRate: null, // Trend Strategy không dùng exponential time decay như Event Strategy
    validUntil: currentBarTimestamp + holdingPeriod * 86_400_000,
    rationale: `AdaptiveTrend[${signLong >= 0 ? "+" : "-"}${signMed >= 0 ? "+" : "-"}${signShort >= 0 ? "+" : "-"}]: Persistence=${persistenceRatio.toFixed(2)}, ChandelierBreak=${chandelierExitTriggered}`,
    rawFeatures: {
      returnShort,
      returnMedium,
      returnLong,
      persistenceRatio,
      forecastVol,
      chandelierExitTriggered,
      currentPrice: pCurrent,
    },
  };
}

// ----------------------------------------------------------------------------
// 4. STRATEGY STATE TRANSITION HANDLER
// ----------------------------------------------------------------------------

export function updateAdaptiveTrendState(
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
      lastExpectedReturn: signal.expectedReturn,
      confidence: signal.confidence,
      evaluationPrice: context.currentPrice,
    },
  };
}