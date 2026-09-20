// ============================================================================
// FILE: src/lib/quant/__tests__/riskStressTest.test.ts
// MODULE: RISK POLICY STRESS-TEST SUITE
// ============================================================================

import { describe, it, expect } from "vitest";
import { stressTestCircuitBreakerAsymmetry, stressTestVolFloorBoundary } from "../riskStressTest";
import { BAR_DURATION_MS } from "../timeDomain";
import type { PointInTimeBar } from "../types";

// CORE-08: Seeded LCG pseudo-random number generator.
// Replaces unseeded Math.random() to make fixtures deterministic.
function makeLcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

function generateVShapedMarketBars(count: number, seed = 4444): PointInTimeBar[] {
  const bars: PointInTimeBar[] = [];
  let price = 60000;
  // CORE-08/CORE-01: 1H bar spacing (BAR_DURATION_MS = 3_600_000ms)
  const startMs = 1700000000000;
  const rand = makeLcg(seed);

  for (let i = 0; i < count; i++) {
    // Pha 1: Sập mạnh từ bar 20 đến bar 40 (-40%)
    // Pha 2: Hồi phục chữ V từ bar 41 đến bar 80 (+60%)
    let shock = (rand() - 0.49) * 0.01; // deterministic, seeded
    if (i >= 20 && i <= 40) {
      shock = -0.025; // Sập liên tục
    } else if (i > 40 && i <= 75) {
      shock = +0.022; // Hồi phục mạnh
    }

    price = Math.max(1000, price * (1 + shock));
    bars.push({
      // CORE-01: 1H bar spacing, not 86400000 (1 day)
      timestamp: startMs + i * BAR_DURATION_MS,
      open: price,
      high: price * 1.01,
      low: price * 0.99,
      close: price,
      volume: 5000,
    });
  }
  return bars;
}

describe("Portfolio & Risk Policy Stress-Testing", () => {
  it("CIRCUIT BREAKER STRESS: Quantifies V-shape recovery penalty and max drawdown protection", () => {
    const bars = generateVShapedMarketBars(100, 5555);
    const report = stressTestCircuitBreakerAsymmetry(bars);

    expect(Number.isFinite(report.finalNavWithCb)).toBe(true);
    expect(Number.isFinite(report.maxDrawdownWithCb)).toBe(true);
    // Max Drawdown khi có Circuit Breaker phải nhỏ hơn hoặc bằng khi thả nổi hoàn toàn
    expect(report.maxDrawdownWithCb).toBeLessThanOrEqual(report.maxDrawdownWithoutCb + 0.01);
  });

  it("VOL FLOOR STRESS: Verifies leverage is safely capped under extreme low volatility", () => {
    const volReport = stressTestVolFloorBoundary();
    expect(volReport.isLeverageSafelyCapped).toBe(true);
    expect(volReport.resultingTargetExposure).toBeLessThanOrEqual(1.0);
  });

  it("DETERMINISM: Identical seeds must produce identical stress-test results", () => {
    // Verify that removing Math.random() makes these fixtures fully deterministic
    const bars1 = generateVShapedMarketBars(100, 6666);
    const bars2 = generateVShapedMarketBars(100, 6666);
    expect(JSON.stringify(bars1)).toBe(JSON.stringify(bars2));
  });
});