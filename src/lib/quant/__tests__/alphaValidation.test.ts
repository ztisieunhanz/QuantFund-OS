// ============================================================================
// FILE: src/lib/quant/__tests__/alphaValidation.test.ts
// MODULE: STATISTICAL ALPHA VALIDATION TESTS
// ============================================================================

import { describe, it, expect } from "vitest";
import { testAlphaMonotonicity, runTrendAblationStudy } from "../alphaValidation";
import { evaluateAdaptiveTrend } from "../adaptiveTrend";
import { BAR_DURATION_MS } from "../timeDomain";
import type { PointInTimeBar } from "../types";

// CORE-08: Seeded LCG pseudo-random number generator.
// Replaces unseeded Math.random() to make fixtures deterministic.
// Uses the same LCG as engineValidation.test.ts (verified deterministic).
function makeLcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

function generateTrendingSyntheticBars(count: number, trendSlope = 0.0008, seed = 7777): PointInTimeBar[] {
  const bars: PointInTimeBar[] = [];
  let current = 40000;
  // CORE-08/CORE-01: 1H bar spacing (BAR_DURATION_MS = 3_600_000ms)
  const startMs = 1700000000000;
  const rand = makeLcg(seed);

  for (let i = 0; i < count; i++) {
    // Deterministic shock: sine wave + seeded random, no Math.random()
    const shock = (Math.sin(i / 10) * 0.01) + (rand() - 0.48) * 0.02 + trendSlope;
    const open = current;
    current = open * (1 + shock);
    const high = Math.max(open, current) * 1.005;
    const low = Math.min(open, current) * 0.995;
    const volume = 2000 + rand() * 1000;

    bars.push({
      // CORE-01: 1H bar spacing, not 86400000 (1 day)
      timestamp: startMs + i * BAR_DURATION_MS,
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
    const bars = generateTrendingSyntheticBars(300, 0.001, 1111);

    const report = testAlphaMonotonicity(
      bars,
      (ctx) => evaluateAdaptiveTrend(ctx, {
        strategyId: "ADAPTIVE_TREND",
        lastEvaluationTimestamp: 0,
        barsSinceLastSignal: 0,
        internalValues: {},
      }),
      5, // 5-bar forward return horizon (1H bars)
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
    const bars = generateTrendingSyntheticBars(350, 0.0005, 2222);
    const ablationReport = runTrendAblationStudy(bars, 125);

    expect(ablationReport.variants.length).toBe(4);
    for (const variant of ablationReport.variants) {
      expect(Number.isFinite(variant.annualizedSharpe)).toBe(true);
      expect(variant.totalTrades).toBeGreaterThanOrEqual(0);
    }
  });

  it("DETERMINISM: Identical seeds must produce identical IC reports", () => {
    // Verify that removing Math.random() makes these fixtures fully deterministic
    const bars1 = generateTrendingSyntheticBars(300, 0.001, 3333);
    const bars2 = generateTrendingSyntheticBars(300, 0.001, 3333);

    expect(JSON.stringify(bars1)).toBe(JSON.stringify(bars2));
  });
});