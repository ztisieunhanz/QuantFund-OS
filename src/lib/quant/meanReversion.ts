// ============================================================================
// FILE: src/lib/quant/meanReversion.ts
// MODULE: STRATEGY 3 - SHORT-HORIZON MEAN REVERSION ALPHA ENGINE
// ARCHITECTURE: Point-in-Time Context -> Z-Score + Exhaustion - TrendGuard -> SignalOutput
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

export interface MeanReversionConfig {
  readonly zScoreLookbackBars: number;       // Chu kỳ đo lường độ lệch chuẩn và MA (mặc định 20)
  readonly deviationThresholdZ: number;      // Ngưỡng Z-Score tối thiểu để kích hoạt (mặc định 2.0)
  readonly maxZScoreCap: number;             // Mốc Z-Score bão hòa lực hồi quy (mặc định 3.5)
  readonly maxAllowedTrendSlopeBps: number;  // Độ dốc tối đa của đường MA20 (mặc định 25 bps = 0.0025)
  readonly volumeExhaustionRatio: number;    // Khối lượng bar / MA20 Vol <= ngưỡng này để xác nhận cạn kiệt (mặc định 1.15)
  readonly baseHoldingPeriodBars: number;    // Kỳ hạn nắm giữ hồi quy ngắn hạn (mặc định 3 phiên)
  readonly maxHoldingPeriodBars: number;     // Kỳ hạn tối đa trước khi cưỡng bức đóng vị thế (mặc định 6 phiên)
  readonly assumedInformationRatio: number;  // Giả định IR phục vụ tính expectedReturn (mặc định 0.50)
  readonly defaultVolAnnualized: number;     // Biến động sàn khi thiếu nến (mặc định 0.22)
}

export const DEFAULT_MEAN_REVERSION_CONFIG: MeanReversionConfig = {
  zScoreLookbackBars: 20,
  deviationThresholdZ: 2.0,
  maxZScoreCap: 3.5,
  maxAllowedTrendSlopeBps: 0.0025,
  volumeExhaustionRatio: 1.15,
  baseHoldingPeriodBars: 3,
  maxHoldingPeriodBars: 6,
  assumedInformationRatio: 0.50,
  defaultVolAnnualized: 0.22,
};

// ----------------------------------------------------------------------------
// 2. MATH HELPERS (POINT-IN-TIME, STRICTLY ISOLATED)
// ----------------------------------------------------------------------------


function calculateMeanAndStdDev(bars: readonly PointInTimeBar[], period: number): { mean: number; stdDev: number } | null {
  if (bars.length < period) return null;
  const slice = bars.slice(-period);
  const mean = slice.reduce((acc, bar) => acc + bar.close, 0) / period;
  const variance = slice.reduce((acc, bar) => acc + (bar.close - mean) ** 2, 0) / (period - 1);
  return { mean, stdDev: Math.sqrt(variance) };
}

function calculateAverageVolume(bars: readonly PointInTimeBar[], period: number): number | null {
  if (bars.length < period) return null;
  const slice = bars.slice(-period);
  const sum = slice.reduce((acc, bar) => acc + bar.volume, 0);
  return sum / period;
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
  // Annualize using 1H bars per year (BARS_PER_YEAR = 8760), not 252 trading days
  return Math.sqrt(variance * BARS_PER_YEAR);
}

// ----------------------------------------------------------------------------
// 3. CORE ALPHA EVALUATION ENGINE
// ----------------------------------------------------------------------------

export function evaluateMeanReversion(
  context: StrategyContext,
  _state: StrategyState,
  config: MeanReversionConfig = DEFAULT_MEAN_REVERSION_CONFIG
): ProvenancedSignalOutput {
  const { priceHistory, currentPrice, currentBarTimestamp, strategyId, assetId } = context;
  const produce = (signal: Omit<SignalOutput, "provenance">) => createSignalOutput(signal, { context, state: _state }, config);

  // WARM-UP GUARD: Bắt buộc tối thiểu (lookback + 5) nến để tính ổn định các chỉ số
  const requiredBars = config.zScoreLookbackBars + 5;
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
      metadata: null,
    });
  }

  const len = priceHistory.length;
  const pCurrent = currentPrice > 0 ? currentPrice : priceHistory[len - 1].close;
  const currentVolume = priceHistory[len - 1].volume;

  // 1. TÍNH TOÁN Z-SCORE ĐỘ LỆCH CHUẨN SO VỚI FAIR VALUE (SMA20)
  const stats = calculateMeanAndStdDev(priceHistory, config.zScoreLookbackBars);
  if (!stats || stats.stdDev <= 0) {
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
      rationale: "DEVIATION_CALCULATION_FAILED: Zero or null standard deviation",
      metadata: null,
    });
  }

  const { mean: smaPrice, stdDev } = stats;
  const rawZScore = (pCurrent - smaPrice) / stdDev;
  const absZ = Math.abs(rawZScore);

  // 2. TREND GUARD (BỘ LỌC CHỐNG BẮT DAO RƠI / BẺ GÃY TREND MẠNH)
  // Kiểm tra độ dốc của MA20 giữa hiện tại và 5 nến trước
  const pastSmaStats = calculateMeanAndStdDev(priceHistory.slice(0, len - 5), config.zScoreLookbackBars);
  let isStrongTrend = false;
  let trendSlopePct = 0;

  if (pastSmaStats && pastSmaStats.mean > 0) {
    trendSlopePct = Math.abs((smaPrice - pastSmaStats.mean) / pastSmaStats.mean) / 5;
    if (trendSlopePct > config.maxAllowedTrendSlopeBps) {
      isStrongTrend = true;
    }
  }

  // 3. EXHAUSTION CHECK (XÁC NHẬN CẠN KIỆT KHỐI LƯỢNG)
  const avgVolume = calculateAverageVolume(priceHistory, config.zScoreLookbackBars) || 1.0;
  const volumeRatio = currentVolume / avgVolume;
  const isVolumeExhausted = volumeRatio <= config.volumeExhaustionRatio;

  // 4. ĐÁNH GIÁ ĐIỀU KIỆN KÍCH HOẠT MEAN REVERSION
  // Nếu độ lệch chưa chạm ngưỡng, hoặc đang trong pha trend mạnh với volume bung lớn -> HỦY LỆNH
  if (absZ < config.deviationThresholdZ || (isStrongTrend && !isVolumeExhausted)) {
    return produce({
      strategyId,
      assetId,
      timestamp: currentBarTimestamp,
      alphaScore: 0,
      heuristicExpectedReturn: 0,
      confidence: 0,
      forecastVol: calculateRealizedVolAnnualized(priceHistory, config.zScoreLookbackBars) ?? config.defaultVolAnnualized,
      holdingPeriod: config.baseHoldingPeriodBars,
      decayRate: null,
      validUntil: null,
      rationale: absZ < config.deviationThresholdZ
        ? `INSIGNIFICANT_Z_SCORE: |Z| (${absZ.toFixed(2)}) < Threshold (${config.deviationThresholdZ})`
        : `TREND_EXPANSION_BLOCK: TrendSlope (${(trendSlopePct * 10000).toFixed(1)} bps) > Threshold with expanding volume (${volumeRatio.toFixed(2)}x)`,
      metadata: { rawZScore, trendSlopePct, volumeRatio },
    });
  }

  // 5. TỔNG HỢP ALPHA SCORE [-1.0 .. +1.0]
  // Z < -2.0 -> Kỳ vọng hồi phục (AlphaScore > 0)
  // Z > +2.0 -> Kỳ vọng điều chỉnh (AlphaScore < 0)
  const direction = rawZScore < 0 ? 1.0 : -1.0;

  // Cường độ tăng dần theo mức độ bão hòa Z-score: normalize từ [Threshold .. MaxCap] về [0.5 .. 1.0]
  const normalizedIntensity = Math.min(
    1.0,
    0.5 + 0.5 * ((absZ - config.deviationThresholdZ) / (config.maxZScoreCap - config.deviationThresholdZ))
  );

  // Khối lượng cạn kiệt càng rõ thì lực hồi quy càng sắc nét
  const exhaustionMultiplier = isVolumeExhausted ? 1.0 : 0.65;
  const rawAlphaScore = direction * normalizedIntensity * exhaustionMultiplier;

  // 6. CONFIDENCE & FORECAST VOLATILITY
  const forecastVol = calculateRealizedVolAnnualized(priceHistory, config.zScoreLookbackBars) ?? config.defaultVolAnnualized;
  
  // Độ tin cậy giảm nếu độ dốc MA lớn hoặc volume đột biến
  const trendPenalty = isStrongTrend ? 0.4 : 1.0;
  const confidence = Math.min(1.0, Math.max(0.15, normalizedIntensity * exhaustionMultiplier * trendPenalty));

  // 7. KỲ VỌNG LỢI NHUẬN (GRINOLD-KAHN MODEL)
  const expectedReturn = rawAlphaScore * forecastVol * config.assumedInformationRatio;

  // 8. TÍNH TOÁN DECAY RATE VÀ HOLDING PERIOD
  // Mean Reversion là chiến lược hồi quy nhanh, holding period ngắn (3-5 bar)
  const holdingPeriod = Math.min(config.maxHoldingPeriodBars, config.baseHoldingPeriodBars);
  const decayRatePerBar = 1.0 / holdingPeriod; // Suy giảm tuyến tính sau mỗi bar không chạm target
  // validUntil uses 1H BAR_DURATION_MS, not 86_400_000 (1 day)
  const validUntilTimestamp = currentBarTimestamp + holdingPeriod * BAR_DURATION_MS;

  return produce({
    strategyId,
    assetId,
    timestamp: currentBarTimestamp,
    alphaScore: Math.round(rawAlphaScore * 1000) / 1000,
    heuristicExpectedReturn: Math.round(expectedReturn * 10000) / 10000,
    confidence: Math.round(confidence * 100) / 100,
    forecastVol: Math.round(forecastVol * 1000) / 1000,
    holdingPeriod,
    decayRate: Math.round(decayRatePerBar * 1000) / 1000,
    validUntil: validUntilTimestamp,
    rationale: `MeanReversion[${direction > 0 ? "OVERSOLD_LONG" : "OVERBOUGHT_SHORT"}]: Z=${rawZScore.toFixed(2)}, VolRatio=${volumeRatio.toFixed(2)}, Slope=${(trendSlopePct * 10000).toFixed(1)}bps`,
    metadata: {
      rawZScore,
      smaPrice,
      stdDev,
      volumeRatio,
      isVolumeExhausted,
      trendSlopePct,
      isStrongTrend,
      currentPrice: pCurrent,
    },
  });
}

// ----------------------------------------------------------------------------
// 4. STRATEGY STATE TRANSITION HANDLER
// ----------------------------------------------------------------------------

export function updateMeanReversionState(
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
      holdingPeriodRemaining: signal.holdingPeriod,
      evaluationZScore: signal.metadata?.rawZScore ?? null,
    },
  };
}
