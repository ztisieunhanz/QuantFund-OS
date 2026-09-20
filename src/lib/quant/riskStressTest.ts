// ============================================================================
// FILE: src/lib/quant/riskStressTest.ts
// MODULE: PORTFOLIO & RISK POLICY STRESS-TESTING ENGINE
// PURPOSE: Quantify Circuit Breaker Asymmetry, Hysteresis Cost & Vol Floor Bounds
// ============================================================================

import type { PointInTimeBar } from "./types";
import { evaluatePortfolioRisk, createInitialRiskState, type RiskEngineConfig, DEFAULT_RISK_ENGINE_CONFIG } from "./riskEngine";
import { BAR_DURATION_MS } from "./timeDomain";


// ----------------------------------------------------------------------------
// 1. STRESS-TEST REPORT CONTRACTS
// ----------------------------------------------------------------------------

export interface CircuitBreakerStressResult {
  readonly scenarioName: string;
  readonly totalBars: number;
  readonly finalNavWithCb: number;
  readonly finalNavWithoutCb: number;
  readonly maxDrawdownWithCb: number;
  readonly maxDrawdownWithoutCb: number;
  readonly missedRecoveryCostUsd: number; // Chi phí cơ hội do chậm phục hồi NAV
  readonly circuitBreakerTripCount: number;
  readonly averageCooldownBarsActive: number;
  readonly recommendation: string;
}

export interface VolFloorStressResult {
  readonly syntheticLowVolPct: number;
  readonly realizedVolRecorded: number;
  readonly resultingTargetExposure: number;
  readonly isLeverageSafelyCapped: boolean;
}

// ----------------------------------------------------------------------------
// 2. CIRCUIT BREAKER ASYMMETRY & MISSED RECOVERY SIMULATOR
// ----------------------------------------------------------------------------

export function stressTestCircuitBreakerAsymmetry(
  marketBars: readonly PointInTimeBar[],
  config: RiskEngineConfig = DEFAULT_RISK_ENGINE_CONFIG
): CircuitBreakerStressResult {
  const initialCapital = 10000;

  // Kịch bản A: Có bật Hysteresis Circuit Breaker
  let navWithCb = initialCapital;
  let peakWithCb = initialCapital;
  let stateWithCb = createInitialRiskState();
  let tripCount = 0;
  let totalCooldownBars = 0;

  // Kịch bản B: Không bật Circuit Breaker (Exposure luôn bằng 1.0)
  let navWithoutCb = initialCapital;
  let peakWithoutCb = initialCapital;
  let maxDdWithoutCb = 0;
  let maxDdWithCb = 0;

  for (let i = 20; i < marketBars.length; i++) {
    const slice = marketBars.slice(0, i + 1);
    const barReturn = (marketBars[i].close - marketBars[i - 1].close) / marketBars[i - 1].close;

    // --- Path A: With CB ---
    if (navWithCb > peakWithCb) peakWithCb = navWithCb;
    const { risk, nextState } = evaluatePortfolioRisk(navWithCb, peakWithCb, slice, stateWithCb, config);
    stateWithCb = nextState;

    if (risk.circuitBreakerStatus === "TRIPPED") {
      if (stateWithCb.cooldownRemainingBars === config.cooldownRequiredBars) tripCount++;
      totalCooldownBars++;
    }

    const exposureA = risk.targetExposure;
    navWithCb *= 1 + barReturn * exposureA;
    const ddA = peakWithCb > 0 ? (peakWithCb - navWithCb) / peakWithCb : 0;
    if (ddA > maxDdWithCb) maxDdWithCb = ddA;

    // --- Path B: Without CB ---
    if (navWithoutCb > peakWithoutCb) peakWithoutCb = navWithoutCb;
    navWithoutCb *= 1 + barReturn * 1.0; // Unconstrained 1.0 exposure
    const ddB = peakWithoutCb > 0 ? (peakWithoutCb - navWithoutCb) / peakWithoutCb : 0;
    if (ddB > maxDdWithoutCb) maxDdWithoutCb = ddB;
  }

  const missedRecoveryCostUsd = navWithoutCb - navWithCb;
  let recommendation = "Circuit breaker policy is balanced.";

  if (maxDdWithCb >= maxDdWithoutCb * 0.9) {
    recommendation = "WARNING: CB did not provide meaningful MaxDD reduction while incurring missed recovery costs.";
  } else if (missedRecoveryCostUsd > initialCapital * 0.15) {
    recommendation = "CAUTION: High V-shape recovery penalty. Consider widening recovery threshold.";
  }

  return {
    scenarioName: "V-Shape Recovery & Crash Stress Path",
    totalBars: marketBars.length,
    finalNavWithCb: Math.round(navWithCb * 100) / 100,
    finalNavWithoutCb: Math.round(navWithoutCb * 100) / 100,
    maxDrawdownWithCb: Math.round(maxDdWithCb * 10000) / 10000,
    maxDrawdownWithoutCb: Math.round(maxDdWithoutCb * 10000) / 10000,
    missedRecoveryCostUsd: Math.round(missedRecoveryCostUsd * 100) / 100,
    circuitBreakerTripCount: tripCount,
    averageCooldownBarsActive: Math.round((totalCooldownBars / (tripCount || 1)) * 10) / 10,
    recommendation,
  };
}

// ----------------------------------------------------------------------------
// 3. VOL FLOOR & LEVERAGE BOUND STRESS TEST
// ----------------------------------------------------------------------------

export function stressTestVolFloorBoundary(
  config: RiskEngineConfig = DEFAULT_RISK_ENGINE_CONFIG
): VolFloorStressResult {
  // Tạo chuỗi nến đi ngang gần như tuyệt đối (Vol thực tế cực thấp ~ 1%)
  const flatBars: PointInTimeBar[] = [];
  let price = 50000;
  const startMs = 1700000000000;

  for (let i = 0; i < 30; i++) {
    price += (i % 2 === 0 ? 10 : -10); // Biến động siêu nhỏ
    flatBars.push({
      // 1H bar spacing: use BAR_DURATION_MS (3_600_000ms), not 86400000 (1 day)
      timestamp: startMs + i * BAR_DURATION_MS,
      open: price,
      high: price + 15,
      low: price - 15,
      close: price,
      volume: 1000,
    });
  }

  const state = createInitialRiskState();
  const { risk } = evaluatePortfolioRisk(10000, 10000, flatBars, state, config);

  // Đòn bẩy phải bị chặn bởi maxGrossExposureCap (1.0x), không được phép vọt lên 5x-10x
  const isSafe = risk.targetExposure <= config.maxGrossExposureCap;

  return {
    syntheticLowVolPct: 1.0,
    realizedVolRecorded: risk.realizedVol,
    resultingTargetExposure: risk.targetExposure,
    isLeverageSafelyCapped: isSafe,
  };
}