// ============================================================================
// FILE: src/lib/quant/__tests__/riskStressTest.test.ts
// MODULE: RISK POLICY STRESS-TEST SUITE
// ============================================================================

import { describe, it, expect } from "vitest";
import { stressTestCircuitBreakerAsymmetry, stressTestVolFloorBoundary } from "../riskStressTest";
import type { PointInTimeBar } from "../types";

function generateVShapedMarketBars(count: number): PointInTimeBar[] {
  const bars: PointInTimeBar[] = [];
  let price = 60000;
  const startMs = 1700000000000;

  for (let i = 0; i < count; i++) {
    // Pha 1: Sập mạnh từ bar 20 đến bar 40 (-40%)
    // Pha 2: Hồi phục chữ V từ bar 41 đến bar 80 (+60%)
    let shock = (Math.random() - 0.49) * 0.01;
    if (i >= 20 && i <= 40) {
      shock = -0.025; // Sập liên tục
    } else if (i > 40 && i <= 75) {
      shock = +0.022; // Hồi phục mạnh
    }

    price = Math.max(1000, price * (1 + shock));
    bars.push({
      timestamp: startMs + i * 86400000,
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
    const bars = generateVShapedMarketBars(100);
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
});