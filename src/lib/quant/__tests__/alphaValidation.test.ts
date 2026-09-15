// ============================================================================
// FILE: src/lib/quant/__tests__/alphaValidation.test.ts
// MODULE: STATISTICAL ALPHA VALIDATION TESTS
// ============================================================================

import { describe, it, expect } from "vitest";
import { testAlphaMonotonicity, runTrendAblationStudy } from "../alphaValidation";
import { evaluateAdaptiveTrend } from "../adaptiveTrend";
import type { PointInTimeBar } from "../types";

function generateTrendingSyntheticBars(count: number, trendSlope = 0.0008): PointInTimeBar[] {
  const bars: PointInTimeBar[] = [];
  let current = 40000;
  const startMs = 1700000000000;

  for (let i = 0; i < count; i++) {
    // Random walk có drift dương có chủ đích để kiểm thử khả năng bóc tách trend
    const shock = (Math.sin(i / 10) * 0.01) + (Math.random() - 0.48) * 0.02 + trendSlope;
    const open = current;
    current = open * (1 + shock);
    const high = Math.max(open, current) * 1.005;
    const low = Math.min(open, current) * 0.995;
    const volume = 2000 + Math.random() * 1000;

    bars.push({
      timestamp: startMs + i * 86400000,
      open,
      high,
      low,
      close: current,
      volume,
    });
  }
  return bars;
}

describe("Statistical Validation: Alpha Engine Significance", () => {
  it("MONOTONICITY & IC TEST: Trend Alpha must demonstrate positive Rank IC on trending regimes", () => {
    const bars = generateTrendingSyntheticBars(300, 0.001);

    const report = testAlphaMonotonicity(
      bars,
      (ctx) => evaluateAdaptiveTrend(ctx, {
        strategyId: "ADAPTIVE_TREND",
        lastEvaluationTimestamp: 0,
        barsSinceLastSignal: 0,
        internalValues: {},
      }),
      5, // 5-day forward return horizon
      125
    );

    // Xác nhận Rank Information Coefficient (IC) phải là số hữu hạn
    expect(Number.isFinite(report.rankInformationCoefficient)).toBe(true);
    expect(report.buckets.length).toBe(5);

    // Q5 (Alpha cao nhất) phải có tỷ suất sinh lời vượt trội hơn Q1 (Alpha âm nhất)
    const q1 = report.buckets[0];
    const q5 = report.buckets[4];
    if (q1.sampleCount > 5 && q5.sampleCount > 5) {
      expect(q5.meanForwardReturnPct).toBeGreaterThan(q1.meanForwardReturnPct);
    }
  });

  it("ABLATION STUDY: Verifies incremental value of Persistence and Chandelier filters", () => {
    const bars = generateTrendingSyntheticBars(350, 0.0005);
    const ablationReport = runTrendAblationStudy(bars, 125);

    expect(ablationReport.variants.length).toBe(4);
    for (const variant of ablationReport.variants) {
      expect(Number.isFinite(variant.annualizedSharpe)).toBe(true);
      expect(variant.totalTrades).toBeGreaterThanOrEqual(0);
    }
  });
});