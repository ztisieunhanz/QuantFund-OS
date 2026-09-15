// ============================================================================
// FILE: src/lib/quant/riskEngine.ts
// MODULE: PORTFOLIO RISK ENGINE (WITH HYSTERESIS CIRCUIT BREAKER & VOL FLOOR)
// ============================================================================

import type {
  RiskOutput,
  CircuitBreakerStatus,
  PointInTimeBar,
} from "@/lib/quant/types";

export interface RiskEngineConfig {
  readonly targetAnnualVolatility: number;  // Giả định chính sách (mặc định 12%)
  readonly maxGrossExposureCap: number;      // Trần đòn bẩy (mặc định 1.0x)
  readonly minGrossExposureFloor: number;    // Sàn phơi nhiễm phòng vệ (mặc định 0.20x)
  readonly volFloorAnnualized: number;       // Sàn biến động tránh đòn bẩy bùng nổ (mặc định 0.05 = 5%)
  readonly maxDrawdownWarningPct: number;    // Ngưỡng cảnh báo (mặc định 8%)
  readonly maxDrawdownTripPct: number;       // Ngưỡng ngắt mạch (mặc định 15%)
  readonly cooldownRequiredBars: number;     // Số phiên trễ làm mát sau khi ngắt mạch (mặc định 5 phiên)
  readonly recoveryDrawdownPct: number;      // Ngưỡng Drawdown an toàn để thoát ngắt mạch (mặc định 10%)
  readonly volLookbackBars: number;          // Chu kỳ đo Realized Vol (mặc định 20 phiên)
}

export const DEFAULT_RISK_ENGINE_CONFIG: RiskEngineConfig = {
  targetAnnualVolatility: 0.12,
  maxGrossExposureCap: 1.0,
  minGrossExposureFloor: 0.20,
  volFloorAnnualized: 0.05,
  maxDrawdownWarningPct: 0.08,
  maxDrawdownTripPct: 0.15,
  cooldownRequiredBars: 5,
  recoveryDrawdownPct: 0.10,
  volLookbackBars: 20,
};

export interface RiskEngineState {
  circuitBreakerStatus: CircuitBreakerStatus;
  cooldownRemainingBars: number;
}

export function createInitialRiskState(): RiskEngineState {
  return {
    circuitBreakerStatus: "NORMAL",
    cooldownRemainingBars: 0,
  };
}

function calculateBenchmarkRealizedVol(
  bars: readonly PointInTimeBar[],
  lookback: number,
  volFloor: number
): number {
  if (bars.length < lookback + 1) return Math.max(0.20, volFloor);
  const slice = bars.slice(-lookback - 1);
  const returns: number[] = [];

  for (let i = 1; i < slice.length; i++) {
    const prev = slice[i - 1].close;
    const curr = slice[i].close;
    if (prev > 0 && curr > 0) {
      returns.push(Math.log(curr / prev));
    }
  }

  if (returns.length < 5) return Math.max(0.20, volFloor);
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1);
  const rawVol = Math.sqrt(variance * 252);

  // Bảo đảm luôn có sàn biến động để không chia cho số quá nhỏ
  return Math.max(rawVol, volFloor);
}

export function evaluatePortfolioRisk(
  currentNav: number,
  peakNav: number,
  benchmarkBars: readonly PointInTimeBar[],
  state: RiskEngineState,
  config: RiskEngineConfig = DEFAULT_RISK_ENGINE_CONFIG
): { risk: RiskOutput; nextState: RiskEngineState } {
  const riskFlags: string[] = [];

  // 1. BIẾN ĐỘNG THỰC TẾ (CÓ SÀN BIẾN ĐỘNG BẢO VỆ)
  const realizedVol = calculateBenchmarkRealizedVol(
    benchmarkBars,
    config.volLookbackBars,
    config.volFloorAnnualized
  );

  // 2. VOLATILITY TARGETING CO GIÃN ĐÒN BẨY
  const rawVolMultiplier = config.targetAnnualVolatility / realizedVol;
  let targetExposure = Math.max(
    config.minGrossExposureFloor,
    Math.min(config.maxGrossExposureCap, rawVolMultiplier)
  );

  // 3. CIRCUIT BREAKER CÓ CƠ CHẾ TRỄ (HYSTERESIS & COOLDOWN)
  const currentDrawdown = peakNav > 0 ? Math.max(0, (peakNav - currentNav) / peakNav) : 0;
  let nextStatus: CircuitBreakerStatus = state.circuitBreakerStatus;
  let nextCooldown = state.cooldownRemainingBars;
  let circuitBreakerReason: string | null = null;

  if (state.circuitBreakerStatus === "TRIPPED") {
    // Nếu đang trong trạng thái ngắt mạch, chỉ hồi phục khi DD co hẹp về dưới recoveryDrawdownPct
    // VÀ trải qua đủ số phiên cooldown
    if (currentDrawdown <= config.recoveryDrawdownPct) {
      if (nextCooldown > 0) {
        nextCooldown--;
        circuitBreakerReason = `HYSTERESIS_COOLDOWN: DD ${(currentDrawdown * 100).toFixed(1)}% safe, remaining cooldown ${nextCooldown} bars`;
        targetExposure = config.minGrossExposureFloor;
      } else {
        nextStatus = "WARNING";
        circuitBreakerReason = `RECOVERING_FROM_TRIP: DD reduced to ${(currentDrawdown * 100).toFixed(1)}%, promoting to WARNING`;
        targetExposure *= 0.70;
      }
    } else {
      // Tiếp tục bị khóa ở sàn tối thiểu
      nextCooldown = config.cooldownRequiredBars;
      circuitBreakerReason = `CIRCUIT_BREAKER_LOCKED: DD ${(currentDrawdown * 100).toFixed(1)}% > Recovery ${(config.recoveryDrawdownPct * 100).toFixed(1)}%`;
      targetExposure = config.minGrossExposureFloor;
    }
    riskFlags.push(circuitBreakerReason);
  } else {
    // Trạng thái bình thường hoặc cảnh báo
    if (currentDrawdown >= config.maxDrawdownTripPct) {
      nextStatus = "TRIPPED";
      nextCooldown = config.cooldownRequiredBars;
      circuitBreakerReason = `CIRCUIT_BREAKER_TRIPPED: DD ${(currentDrawdown * 100).toFixed(1)}% >= Trip ${(config.maxDrawdownTripPct * 100).toFixed(1)}%`;
      targetExposure = config.minGrossExposureFloor;
      riskFlags.push(circuitBreakerReason);
    } else if (currentDrawdown >= config.maxDrawdownWarningPct) {
      nextStatus = "WARNING";
      circuitBreakerReason = `DRAWDOWN_WARNING: DD ${(currentDrawdown * 100).toFixed(1)}% >= Warning ${(config.maxDrawdownWarningPct * 100).toFixed(1)}%`;
      targetExposure *= 0.70;
      riskFlags.push(circuitBreakerReason);
    } else {
      nextStatus = "NORMAL";
      nextCooldown = 0;
    }
  }

  if (realizedVol > config.targetAnnualVolatility * 1.5) {
    riskFlags.push(`HIGH_VOLATILITY: Realized ${(realizedVol * 100).toFixed(1)}% > 1.5x Target`);
  }

  const riskOutput: RiskOutput = {
    scope: "PORTFOLIO_AGGREGATE",
    targetExposure: Math.round(targetExposure * 1000) / 1000,
    grossExposure: Math.round(targetExposure * 1000) / 1000,
    targetVolatility: config.targetAnnualVolatility,
    realizedVol: Math.round(realizedVol * 1000) / 1000,
    forecastVol: Math.round(realizedVol * 1000) / 1000,
    riskFlags,
    circuitBreakerStatus: nextStatus,
    circuitBreakerReason,
  };

  return {
    risk: riskOutput,
    nextState: {
      circuitBreakerStatus: nextStatus,
      cooldownRemainingBars: nextCooldown,
    },
  };
}