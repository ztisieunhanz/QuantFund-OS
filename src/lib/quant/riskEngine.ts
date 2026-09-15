// ============================================================================
// FILE: src/lib/quant/riskEngine.ts
// MODULE: PORTFOLIO RISK ENGINE
// ARCHITECTURE: Realized Volatility + Drawdown Breaker -> RiskOutput
// ============================================================================

import type {
  RiskOutput,
  CircuitBreakerStatus,
  PointInTimeBar,
} from "@/lib/quant/types";

export interface RiskEngineConfig {
  readonly targetAnnualVolatility: number;  // Mục tiêu biến động năm hóa danh mục (mặc định 0.12 = 12%)
  readonly maxGrossExposureCap: number;      // Trần đòn bẩy gộp tối đa (mặc định 1.0 = 100% vốn)
  readonly minGrossExposureFloor: number;    // Sàn phơi nhiễm khi thị trường biến động cực đoan (mặc định 0.20)
  readonly maxDrawdownWarningPct: number;    // Ngưỡng cảnh báo sụt giảm NAV (mặc định 0.08 = 8%)
  readonly maxDrawdownTripPct: number;       // Ngưỡng ngắt mạch cưỡng bức giảm rủi ro (mặc định 0.15 = 15%)
  readonly volLookbackBars: number;          // Số phiên đo realized vol (mặc định 20 phiên)
}

export const DEFAULT_RISK_ENGINE_CONFIG: RiskEngineConfig = {
  targetAnnualVolatility: 0.12,
  maxGrossExposureCap: 1.0,
  minGrossExposureFloor: 0.20,
  maxDrawdownWarningPct: 0.08,
  maxDrawdownTripPct: 0.15,
  volLookbackBars: 20,
};

function calculateBenchmarkRealizedVol(bars: readonly PointInTimeBar[], lookback: number): number {
  if (bars.length < lookback + 1) return 0.20; // Giá trị tham chiếu an toàn
  const slice = bars.slice(-lookback - 1);
  const returns: number[] = [];

  for (let i = 1; i < slice.length; i++) {
    const prev = slice[i - 1].close;
    const curr = slice[i].close;
    if (prev > 0 && curr > 0) {
      returns.push(Math.log(curr / prev));
    }
  }

  if (returns.length < 5) return 0.20;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance * 252);
}

export function evaluatePortfolioRisk(
  currentNav: number,
  peakNav: number,
  benchmarkBars: readonly PointInTimeBar[],
  config: RiskEngineConfig = DEFAULT_RISK_ENGINE_CONFIG
): RiskOutput {
  const riskFlags: string[] = [];

  // 1. ĐO LƯỜNG BIẾN ĐỘNG THỰC TẾ (REALIZED VOLATILITY)
  const realizedVol = calculateBenchmarkRealizedVol(benchmarkBars, config.volLookbackBars);

  // 2. TÍNH TOÁN HỆ SỐ CO GIÃN ĐÒN BẨY THEO VOLATILITY TARGETING
  // Formula: Scale = TargetVol / RealizedVol
  const rawVolMultiplier = realizedVol > 0 ? config.targetAnnualVolatility / realizedVol : 1.0;
  let targetExposure = Math.max(
    config.minGrossExposureFloor,
    Math.min(config.maxGrossExposureCap, rawVolMultiplier)
  );

  // 3. KIỂM TRA DRAWDOWN VÀ NGẮT MẠCH BẢO VỆ (CIRCUIT BREAKER)
  const currentDrawdown = peakNav > 0 ? Math.max(0, (peakNav - currentNav) / peakNav) : 0;
  let circuitBreakerStatus: CircuitBreakerStatus = "NORMAL";
  let circuitBreakerReason: string | null = null;

  if (currentDrawdown >= config.maxDrawdownTripPct) {
    circuitBreakerStatus = "TRIPPED";
    circuitBreakerReason = `CIRCUIT_BREAKER_TRIPPED: Drawdown ${(currentDrawdown * 100).toFixed(1)}% >= MaxTrip ${(config.maxDrawdownTripPct * 100).toFixed(1)}%`;
    // Ép phơi nhiễm về sàn phòng thủ tối thiểu
    targetExposure = config.minGrossExposureFloor;
    riskFlags.push(circuitBreakerReason);
  } else if (currentDrawdown >= config.maxDrawdownWarningPct) {
    circuitBreakerStatus = "WARNING";
    circuitBreakerReason = `DRAWDOWN_WARNING: Drawdown ${(currentDrawdown * 100).toFixed(1)}% >= Warning ${(config.maxDrawdownWarningPct * 100).toFixed(1)}%`;
    // Giảm 30% ngân sách phơi nhiễm được phép
    targetExposure *= 0.70;
    riskFlags.push(circuitBreakerReason);
  }

  if (realizedVol > config.targetAnnualVolatility * 1.5) {
    riskFlags.push(`HIGH_VOLATILITY: Realized ${(realizedVol * 100).toFixed(1)}% > 1.5x Target ${(config.targetAnnualVolatility * 100).toFixed(1)}%`);
  }

  return {
    scope: "PORTFOLIO_AGGREGATE",
    targetExposure: Math.round(targetExposure * 100) / 100,
    grossExposure: Math.round(targetExposure * 100) / 100, // Sẽ được Omega Allocator kiểm soát trần
    targetVolatility: config.targetAnnualVolatility,
    realizedVol: Math.round(realizedVol * 1000) / 1000,
    forecastVol: Math.round(realizedVol * 1000) / 1000,
    riskFlags,
    circuitBreakerStatus,
    circuitBreakerReason,
  };
}