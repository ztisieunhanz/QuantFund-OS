// ============================================================================
// FILE: src/lib/quant/riskEngine.ts
// MODULE: QUANTITATIVE RISK ENGINE & VOLATILITY TARGETING
// PRINCIPLE: Capital preservation > Trade conviction
// ============================================================================

import type {
  RiskOutput,
  StrategyId,
  PointInTimeBar,
  CircuitBreakerStatus,
} from "@/lib/quant/types";

// ----------------------------------------------------------------------------
// 1. CONFIGURATION INTERFACES & DEFAULT PARAMETERS
// ----------------------------------------------------------------------------

export interface RiskEngineConfig {
  readonly targetAnnualVol: number;          // Biến động danh mục mục tiêu (mặc định 0.12 = 12%)
  readonly volLookbackBars: number;          // Chu kỳ tính realized volatility (mặc định 20 phiên)
  readonly minVolScaleFactor: number;        // Hệ số quy mô vol tối thiểu (mặc định 0.2)
  readonly maxVolScaleFactor: number;        // Hệ số quy mô vol tối đa (mặc định 1.5)
  readonly maxBaseGrossExposure: number;     // Giới hạn đòn bẩy gộp tiêu chuẩn (mặc định 1.0 = 100% NAV)
  readonly warningDrawdownThreshold: number; // Mốc drawdown cảnh báo cấp độ 1 (mặc định 0.05 = 5%)
  readonly tripDrawdownThreshold: number;    // Mốc drawdown ngắt mạch cấp độ 2 (mặc định 0.10 = 10%)
  readonly trippedMaxGrossCap: number;       // Trần đòn bẩy gộp khi Circuit Breaker bị ngắt (mặc định 0.20 = 20%)
  readonly defaultVolFallback: number;       // Biến động dự phòng khi thiếu nến (mặc định 0.20)
}

export const DEFAULT_RISK_ENGINE_CONFIG: RiskEngineConfig = {
  targetAnnualVol: 0.12,
  volLookbackBars: 20,
  minVolScaleFactor: 0.2,
  maxVolScaleFactor: 1.5,
  maxBaseGrossExposure: 1.0,
  warningDrawdownThreshold: 0.05,
  tripDrawdownThreshold: 0.10,
  trippedMaxGrossCap: 0.20,
  defaultVolFallback: 0.20,
};

// ----------------------------------------------------------------------------
// 2. MATHEMATICAL RISK ESTIMATION
// ----------------------------------------------------------------------------

/**
 * Tính toán Realized Volatility năm hóa từ chuỗi giá Point-in-Time
 */
export function calculateAnnualizedRealizedVol(
  bars: readonly PointInTimeBar[],
  lookback = 20
): number | null {
  if (bars.length < lookback + 1) return null;
  const slice = bars.slice(-lookback - 1);
  const logReturns: number[] = [];

  for (let i = 1; i < slice.length; i++) {
    const prev = slice[i - 1].close;
    const curr = slice[i].close;
    if (prev <= 0 || curr <= 0) return null;
    logReturns.push(Math.log(curr / prev));
  }

  if (logReturns.length < 2) return null;
  const mean = logReturns.reduce((acc, val) => acc + val, 0) / logReturns.length;
  const variance = logReturns.reduce((acc, val) => acc + (val - mean) ** 2, 0) / (logReturns.length - 1);
  return Math.sqrt(variance * 252);
}

// ----------------------------------------------------------------------------
// 3. CORE RISK EVALUATION ENGINE
// ----------------------------------------------------------------------------

export interface RiskEvaluationParams {
  readonly scope: StrategyId | "PORTFOLIO_AGGREGATE";
  readonly currentNav: number;
  readonly peakNav: number;
  readonly priceHistory: readonly PointInTimeBar[];
  readonly currentGrossExposure: number;
  readonly forecastVolOverride?: number | null;
}

export function evaluatePortfolioRisk(
  params: RiskEvaluationParams,
  config: RiskEngineConfig = DEFAULT_RISK_ENGINE_CONFIG
): RiskOutput {
  const {
    scope,
    currentNav,
    peakNav,
    priceHistory,
    currentGrossExposure,
    forecastVolOverride,
  } = params;

  const riskFlags: string[] = [];

  // 1. ĐO LƯỜNG DRAWDOWN HIỆN HỮU SO VỚI ĐỈNH NAV LỊCH SỬ
  const highWaterMark = Math.max(currentNav, peakNav > 0 ? peakNav : currentNav);
  const currentDrawdown = highWaterMark > 0 ? (highWaterMark - currentNav) / highWaterMark : 0;

  // 2. KIỂM TRA TRẠNG THÁI CIRCUIT BREAKER
  let circuitBreakerStatus: CircuitBreakerStatus = "NORMAL";
  let circuitBreakerReason: string | null = null;
  let dynamicGrossCap = config.maxBaseGrossExposure;

  if (currentDrawdown >= config.tripDrawdownThreshold) {
    circuitBreakerStatus = "TRIPPED";
    circuitBreakerReason = `CIRCUIT_BREAKER_TRIPPED: Drawdown ${(currentDrawdown * 100).toFixed(2)}% >= ${(config.tripDrawdownThreshold * 100).toFixed(1)}% threshold`;
    dynamicGrossCap = config.trippedMaxGrossCap;
    riskFlags.push("DRAWDOWN_EMERGENCY_PROTECTION");
  } else if (currentDrawdown >= config.warningDrawdownThreshold) {
    circuitBreakerStatus = "WARNING";
    circuitBreakerReason = `CIRCUIT_BREAKER_WARNING: Drawdown ${(currentDrawdown * 100).toFixed(2)}% >= ${(config.warningDrawdownThreshold * 100).toFixed(1)}% threshold`;
    dynamicGrossCap = config.maxBaseGrossExposure * 0.75;
    riskFlags.push("DRAWDOWN_WARNING_DELEVERAGE");
  }

  // 3. TÍNH TOÁN REALIZED VOLATILITY
  const realizedVol = calculateAnnualizedRealizedVol(priceHistory, config.volLookbackBars) ?? config.defaultVolFallback;
  const forecastVol = forecastVolOverride && forecastVolOverride > 0 ? forecastVolOverride : realizedVol;

  // 4. VOLATILITY TARGETING SCALE FACTOR
  // Position Sizing Multiplier = Target Vol / Realized Vol
  let volMultiplier = config.targetAnnualVol / realizedVol;
  volMultiplier = Math.max(config.minVolScaleFactor, Math.min(config.maxVolScaleFactor, volMultiplier));

  if (volMultiplier < 0.6) {
    riskFlags.push(`HIGH_VOLATILITY_COMPRESSION: RealizedVol (${(realizedVol * 100).toFixed(1)}%) > TargetVol (${(config.targetAnnualVol * 100).toFixed(1)}%)`);
  }

  // 5. TÍNH TOÁN HẠN MỨC PHƠI NHIỄM MỤC TIÊU (TARGET EXPOSURE)
  // Target Exposure = Dynamic Gross Cap * Volatility Scale Multiplier
  let targetExposure = dynamicGrossCap * volMultiplier;
  targetExposure = Math.max(0.0, Math.min(dynamicGrossCap, targetExposure));
  targetExposure = Math.round(targetExposure * 1000) / 1000;

  return {
    scope,
    targetExposure,
    grossExposure: Math.round(currentGrossExposure * 1000) / 1000,
    targetVolatility: config.targetAnnualVol,
    realizedVol: Math.round(realizedVol * 1000) / 1000,
    forecastVol: Math.round(forecastVol * 1000) / 1000,
    circuitBreakerStatus,
    circuitBreakerReason,
    riskFlags,
  };
}