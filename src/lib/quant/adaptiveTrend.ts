// ============================================================================
// FILE: src/lib/quant/adaptiveTrend.ts
// MODULE: STRATEGY 1 - ADAPTIVE TREND ALPHA ENGINE
// ARCHITECTURE: Point-in-Time Context -> Multi-Horizon Momentum -> SignalOutput
// ============================================================================

import type {
  StrategyContext,
  StrategyState,
  SignalOutput,
  ProvenancedSignalOutput,
  PointInTimeBar,
} from "@/lib/quant/types";
import { BAR_DURATION_MS, BARS_PER_YEAR } from "@/lib/quant/timeDomain";
import { createSignalOutput } from "@/lib/quant/producerProvenance";

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
  if (bars.length < period + 1 || period <= 0) return null;
  const slice = bars.slice(-period - 1);
  let trSum = 0;
  for (let i = 1; i < slice.length; i++) {
    trSum += calculateTrueRange(slice[i], slice[i - 1]);
  }
  return trSum / period;
}

function calculateRealizedVolAnnualized(bars: readonly PointInTimeBar[], period: number): number | null {
  if (bars.length < period + 1 || period <= 1) return null;
  const slice = bars.slice(-period - 1);
  const logReturns: number[] = [];

  for (let i = 1; i < slice.length; i++) {
    const prev = slice[i - 1].close;
    const curr = slice[i].close;
    if (prev <= 0 || curr <= 0) return null;
    logReturns.push(Math.log(curr / prev));
  }

  // Khắc phục Lỗi 2: Tránh chia cho 0 khi chỉ có 1 phần tử
  if (logReturns.length <= 1) return null;
  const mean = logReturns.reduce((sum, r) => sum + r, 0) / logReturns.length;
  const variance = logReturns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (logReturns.length - 1);
  // Annualize using 1H bars per year (BARS_PER_YEAR = 8760), not 252 trading days
  return Math.sqrt(variance * BARS_PER_YEAR);
}

function calculateSMA(bars: readonly PointInTimeBar[], period: number): number | null {
  if (bars.length < period || period <= 0) return null;
  const slice = bars.slice(-period);
  const sum = slice.reduce((acc, bar) => acc + bar.close, 0);
  return sum / period;
}

// ----------------------------------------------------------------------------
// 3. CORE ALPHA EVALUATION ENGINE
// ----------------------------------------------------------------------------

export function evaluateAdaptiveTrend(
  context: StrategyContext,
  _state: StrategyState,
  config: AdaptiveTrendConfig = DEFAULT_ADAPTIVE_TREND_CONFIG
): ProvenancedSignalOutput {
  const { priceHistory, currentPrice, currentBarTimestamp, strategyId, assetId } = context;
  const produce = (signal: Omit<SignalOutput, "provenance">) => createSignalOutput(signal, { context, state: _state }, config);

  // Khắc phục Lỗi 1: Bắt buộc tối thiểu (lookbackLongBars + 1) nến để tránh index âm (-1)
  const requiredBars = Math.max(
    config.lookbackLongBars + 1,
    config.lookbackMediumBars + 1,
    config.lookbackShortBars + 1,
    config.atrPeriodBars + 1
  );

  if (priceHistory.length < requiredBars) {
    return produce({
      strategyId,
      assetId,
      timestamp: currentBarTimestamp,
      alphaScore: 0,
      heuristicExpectedReturn: 0,
      confidence: 0,
      forecastVol: 0,
      holdingPeriod: config.baseHoldingPeriodBars,
      decayRate: null,
      validUntil: null,
      rationale: `INSUFFICIENT_WARMUP: History length (${priceHistory.length}) < Required (${requiredBars})`,
      metadata: { warmupRemainingBars: requiredBars - priceHistory.length },
    });
  }

  const len = priceHistory.length;
  const pCurrent = currentPrice > 0 ? currentPrice : (priceHistory[len - 1]?.close ?? 0);

  // Truy xuất an toàn với fallback về nến đầu tiên nếu có bất thường
  const pShort = (priceHistory[len - 1 - config.lookbackShortBars] ?? priceHistory[0]).close;
  const pMedium = (priceHistory[len - 1 - config.lookbackMediumBars] ?? priceHistory[0]).close;
  const pLong = (priceHistory[len - 1 - config.lookbackLongBars] ?? priceHistory[0]).close;

  // 1. TÍNH LỢI NHUẬN ĐA KỲ HẠN
  const returnShort = pShort > 0 ? (pCurrent - pShort) / pShort : 0;
  const returnMedium = pMedium > 0 ? (pCurrent - pMedium) / pMedium : 0;
  const returnLong = pLong > 0 ? (pCurrent - pLong) / pLong : 0;

  // 2. ĐO LƯỜNG TÍNH KIÊN ĐỊNH CỦA XU HƯỚNG
  const smaShort = calculateSMA(priceHistory, config.lookbackShortBars);
  const mediumWindow = priceHistory.slice(-config.lookbackMediumBars);
  let aboveSmaCount = 0;

  for (const bar of mediumWindow) {
    if (smaShort !== null && bar.close > smaShort) {
      aboveSmaCount++;
    }
  }
  const persistenceRatio = config.lookbackMediumBars > 0
    ? aboveSmaCount / config.lookbackMediumBars
    : 0.5;

  // 3. BIẾN ĐỘNG DỰ BÁO
  const forecastVol = calculateRealizedVolAnnualized(priceHistory, config.lookbackShortBars) ?? 0.20;

  // 4. KIỂM TRA CHANDELIER TRAILING STOP
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
  const signShort = Math.sign(returnShort);
  const signMed = Math.sign(returnMedium);
  const signLong = Math.sign(returnLong);

  let rawScore = signLong * 0.40 + signMed * 0.35 + signShort * 0.25;

  if (rawScore > 0 && persistenceRatio >= config.trendPersistenceThreshold) {
    rawScore = Math.min(1.0, rawScore * (1 + (persistenceRatio - config.trendPersistenceThreshold)));
  } else if (rawScore < 0 && (1 - persistenceRatio) >= config.trendPersistenceThreshold) {
    rawScore = Math.max(-1.0, rawScore * (1 + ((1 - persistenceRatio) - config.trendPersistenceThreshold)));
  }

  if (rawScore > 0 && chandelierExitTriggered) {
    rawScore = 0.0;
  }

  // 6. ĐÁNH GIÁ ĐỘ TIN CẬY THỐNG KÊ
  const directionalAgreement = (signShort === signMed && signMed === signLong)
    ? 1.0
    : (signMed === signLong ? 0.65 : 0.30);
  const confidence = Math.min(
    1.0,
    Math.max(0.1, directionalAgreement * (persistenceRatio >= 0.5 ? persistenceRatio : 1 - persistenceRatio))
  );

  // 7. DỰ BÁO TỶ SUẤT KỲ VỌNG (GRINOLD-KAHN)
  const expectedReturn = rawScore * forecastVol * config.assumedInformationRatio;

  // 8. TÍNH TOÁN HOLDING PERIOD
  const holdingPeriod = directionalAgreement === 1.0
    ? Math.round(config.baseHoldingPeriodBars * 1.5)
    : config.baseHoldingPeriodBars;

  return produce({
    strategyId,
    assetId,
    timestamp: currentBarTimestamp,
    alphaScore: Math.round(rawScore * 1000) / 1000,
    heuristicExpectedReturn: Math.round(expectedReturn * 10000) / 10000,
    confidence: Math.round(confidence * 100) / 100,
    forecastVol: Math.round(forecastVol * 1000) / 1000,
    holdingPeriod,
    decayRate: null,
    // validUntil uses 1H BAR_DURATION_MS, not 86_400_000 (1 day)
    validUntil: currentBarTimestamp + holdingPeriod * BAR_DURATION_MS,
    rationale: `AdaptiveTrend[${signLong >= 0 ? "+" : "-"}${signMed >= 0 ? "+" : "-"}${signShort >= 0 ? "+" : "-"}]: Persistence=${persistenceRatio.toFixed(2)}, ChandelierBreak=${chandelierExitTriggered}`,
    // Khắc phục Lỗi 3: Đổi rawFeatures sang metadata đúng chuẩn types.ts
    metadata: {
      returnShort,
      returnMedium,
      returnLong,
      persistenceRatio,
      forecastVol,
      chandelierExitTriggered,
      currentPrice: pCurrent,
    },
  });
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
      lastExpectedReturn: signal.heuristicExpectedReturn,
      confidence: signal.confidence,
      evaluationPrice: context.currentPrice,
    },
  };
}
