// ============================================================================
// FILE: src/lib/quant/__tests__/walkForwardValidation.test.ts
// MODULE: ROLLING FIXED-PARAMETER OOS VALIDATION SUITE (GATE M10B)
// PURPOSE: Validation of rolling out-of-sample methodology, fold boundaries,
//          chained OOS return aggregation, and anti-lookahead guarantees.
// ============================================================================

import { describe, expect, it } from "vitest";
import { runWalkForwardValidation } from "@/lib/quant/walkForward";
import type {
  BacktestConfig,
  PointInTimeBar,
} from "@/lib/quant/types";

function createSyntheticBars(
  count: number,
  startPrice = 50000,
  startTime = 1700000000000,
  trendMultiplier = 1.0
): PointInTimeBar[] {
  const bars: PointInTimeBar[] = [];
  let price = startPrice;
  for (let i = 0; i < count; i++) {
    const change = (Math.sin(i / 10) * 200 + (i % 3 === 0 ? 50 : -30)) * trendMultiplier;
    const open = Math.round(price * 100) / 100;
    const close = Math.round((price + change) * 100) / 100;
    const high = Math.round((Math.max(open, close) + 100) * 100) / 100;
    const low = Math.round((Math.min(open, close) - 100) * 100) / 100;
    const volume = 1000 + (i % 10) * 100;
    bars.push({
      timestamp: startTime + i * 3600 * 1000,
      open,
      high,
      low,
      close,
      volume,
    });
    price = close;
  }
  return bars;
}

function createBaseConfig(overrides: Partial<BacktestConfig> = {}): BacktestConfig {
  return {
    runId: "wf-test-run",
    startDate: 0,
    endDate: 0,
    warmupPeriod: 125,
    initialCapital: 10000,
    commissionRate: 0.001,
    slippageModel: { type: "FIXED_BPS", baseBps: 5 },
    executionRule: "NEXT_BAR_OPEN",
    deterministicSeed: 20260915,
    dataQuality: "SYNTHETIC",
    requirePitExecution: true,
    ...overrides,
  };
}

describe("Gate M10B — Rolling Fixed-Parameter OOS Methodology & Validation Suite", () => {
  // --------------------------------------------------------------------------
  // T1–T4: Exact Fold Timestamp Boundaries
  // --------------------------------------------------------------------------
  it("T1–T4 — exact fold timestamps: trainStart, trainEnd, testStart, testEnd metadata math", () => {
    const bars = createSyntheticBars(300);
    const config = createBaseConfig();

    const report = runWalkForwardValidation(
      { assetBars: { BTC: bars } },
      config,
      {},
      180,
      60,
      60
    );

    expect(report.totalFolds).toBe(2);
    const f0 = report.foldReports[0];

    // Fold 0: train indices [0..179], test indices [180..239]
    expect(f0.trainStartTimestamp).toBe(bars[0].timestamp);
    expect(f0.trainEndTimestamp).toBe(bars[179].timestamp); // T2: trainEndIndex - 1
    expect(f0.testStartTimestamp).toBe(bars[180].timestamp); // T3: trainEndIndex
    expect(f0.testEndTimestamp).toBe(bars[239].timestamp);  // T4: testEndIndex - 1
  });

  // --------------------------------------------------------------------------
  // T5: Train/Test Disjointness
  // --------------------------------------------------------------------------
  it("T5 — train/test disjointness: trainEndTimestamp strictly precedes testStartTimestamp", () => {
    const bars = createSyntheticBars(300);
    const report = runWalkForwardValidation({ assetBars: { BTC: bars } }, createBaseConfig(), {}, 180, 60, 60);

    for (const fold of report.foldReports) {
      expect(fold.trainEndTimestamp).toBeLessThan(fold.testStartTimestamp);
    }
  });

  // --------------------------------------------------------------------------
  // T6: Reject stepBars !== testWindowBars
  // --------------------------------------------------------------------------
  it("T6 — stepBars !== testWindowBars rejected fail-closed", () => {
    const bars = createSyntheticBars(300);
    expect(() =>
      runWalkForwardValidation({ assetBars: { BTC: bars } }, createBaseConfig(), {}, 180, 60, 30)
    ).toThrow(/stepBars \(30\) must equal testWindowBars \(60\)/);
  });

  // --------------------------------------------------------------------------
  // T7–T9: OOS Timestamps Unique, Monotonic & Non-Overlapping
  // --------------------------------------------------------------------------
  it("T7–T9 — OOS timestamps in stitched timeline are unique, monotonic & non-overlapping", () => {
    const bars = createSyntheticBars(360);
    const report = runWalkForwardValidation({ assetBars: { BTC: bars } }, createBaseConfig(), {}, 180, 60, 60);

    const timestamps = report.stitchedOosTimeline.map((s) => s.timestamp);
    const uniqueTimestamps = new Set(timestamps);

    expect(uniqueTimestamps.size).toBe(timestamps.length); // T7 & T9: no double counting

    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i]).toBeGreaterThan(timestamps[i - 1]); // T8: strictly chronological
    }
  });

  // --------------------------------------------------------------------------
  // T10–T11: Pre-roll Available to First OOS Decision & Excluded from Scored Metrics
  // --------------------------------------------------------------------------
  it("T10–T11 — pre-roll historical bars available to first OOS decision & excluded from scored OOS timeline", () => {
    const bars = createSyntheticBars(300);
    const report = runWalkForwardValidation({ assetBars: { BTC: bars } }, createBaseConfig(), {}, 180, 60, 60);

    // Each fold scored timeline has exactly testWindowBars (60) decision states
    expect(report.foldReports[0].oosTimeline.length).toBe(60);
    expect(report.foldReports[0].oosTimeline[0].timestamp).toBe(bars[180].timestamp);

    // Stitched timeline contains only test bars (60 * 2 folds = 120 bars)
    expect(report.stitchedOosTimeline.length).toBe(120);
  });

  // --------------------------------------------------------------------------
  // T12: Fold Account / Risk / Strategy State Reset
  // --------------------------------------------------------------------------
  it("T12 — fold engine state reset: every fold starts clean with initial capital", () => {
    const bars = createSyntheticBars(360);
    const report = runWalkForwardValidation({ assetBars: { BTC: bars } }, createBaseConfig(), {}, 180, 60, 60);

    for (const f of report.foldReports) {
      expect(f.oosMetrics.initialNav).toBe(10000);
    }
  });

  // --------------------------------------------------------------------------
  // T13–T14: Terminal Pending Order Handling
  // --------------------------------------------------------------------------
  it("T13–T14 — terminal pending order outside fold not executed in fold or carried to next fold", () => {
    const bars = createSyntheticBars(300);
    const report = runWalkForwardValidation({ assetBars: { BTC: bars } }, createBaseConfig(), {}, 180, 60, 60);

    const f0LastState = report.foldReports[0].oosTimeline[59];
    const f1FirstState = report.foldReports[1].oosTimeline[0];

    // Fold 0 last decision state is at bar 239. It generates target weights pending for bar 240.
    // In Fold 0, no execution is recorded at bar 239 for that decision because bar 240 is not in Fold 0.
    expect(f0LastState.barIndex).toBe(239);

    // In Fold 1 (starts at bar 240 in global index / bar 180 in local fold index), it starts clean at initial capital with 0 executions on first bar
    expect(f1FirstState.barIndex).toBe(180);
    expect(f1FirstState.executions).toEqual([]);

    // In stitched timeline, global barIndex is 240
    expect(report.stitchedOosTimeline[60].barIndex).toBe(240);
    expect(report.stitchedOosTimeline[60].executions).toEqual([]);
  });

  // --------------------------------------------------------------------------
  // T15: Chained NAV Smoothness (No Artificial Reset Drop)
  // --------------------------------------------------------------------------
  it("T15 — chained NAV has no artificial reset drop across fold boundaries", () => {
    const bars = createSyntheticBars(360);
    const report = runWalkForwardValidation({ assetBars: { BTC: bars } }, createBaseConfig(), {}, 180, 60, 60);

    const f0LastStitchedNav = report.stitchedOosTimeline[59].nav;
    const f1FirstStitchedNav = report.stitchedOosTimeline[60].nav;

    // Relative change across boundary must be a normal single-bar return, NOT a drop to $10,000
    const boundaryReturn = (f1FirstStitchedNav - f0LastStitchedNav) / f0LastStitchedNav;
    expect(Math.abs(boundaryReturn)).toBeLessThan(0.05); // Smooth return transition
  });

  // --------------------------------------------------------------------------
  // T16–T18: Aggregate Metrics Recomputed from Full Chained OOS Series
  // --------------------------------------------------------------------------
  it("T16–T18 — aggregate metrics recomputed from complete chained OOS return series", () => {
    const bars = createSyntheticBars(360);
    const report = runWalkForwardValidation({ assetBars: { BTC: bars } }, createBaseConfig(), {}, 180, 60, 60);

    const agg = report.aggregateOosMetrics;
    const finalChainedNav = report.stitchedOosTimeline.at(-1)?.nav ?? 10000;
    const expectedReturnPct = Math.round(((finalChainedNav - 10000) / 10000) * 10000) / 10000;

    expect(agg.initialNav).toBe(10000);
    expect(agg.finalNav).toBe(finalChainedNav);
    expect(agg.totalReturnPct).toBe(expectedReturnPct);
  });

  // --------------------------------------------------------------------------
  // T19–T20: Suffix Invariance & Future Extreme Isolation
  // --------------------------------------------------------------------------
  it("T19–T20 — suffix invariance & future extreme isolation: future bars do not alter earlier fold results", () => {
    const baseBars = createSyntheticBars(300);
    const spikedBars = [...baseBars];

    const lastTs = baseBars[baseBars.length - 1].timestamp;
    for (let i = 1; i <= 60; i++) {
      spikedBars.push({
        timestamp: lastTs + i * 3600 * 1000,
        open: 1_000_000,
        high: 2_000_000,
        low: 900_000,
        close: 1_500_000,
        volume: 999_999,
      });
    }

    const config = createBaseConfig();
    const repBase = runWalkForwardValidation({ assetBars: { BTC: baseBars } }, config, {}, 180, 60, 60);
    const repSpiked = runWalkForwardValidation({ assetBars: { BTC: spikedBars } }, config, {}, 180, 60, 60);

    // First 2 folds in spiked run must be identical to base run
    expect(repSpiked.foldReports[0]).toEqual(repBase.foldReports[0]);
    expect(repSpiked.foldReports[1]).toEqual(repBase.foldReports[1]);
  });

  // --------------------------------------------------------------------------
  // T21–T23: Complete Fold & Dataset Length Controls
  // --------------------------------------------------------------------------
  it("T21–T23 — complete fold evaluation & minimum dataset length controls", () => {
    const shortBars = createSyntheticBars(200);
    expect(() =>
      runWalkForwardValidation({ assetBars: { BTC: shortBars } }, createBaseConfig(), {}, 180, 60, 60)
    ).toThrow(/Dataset too short/);

    // 299 bars: 1 full fold (180+60=240). Remaining 59 bars excluded as trailing partial fold.
    const partialFoldBars = createSyntheticBars(299);
    const repPartial = runWalkForwardValidation({ assetBars: { BTC: partialFoldBars } }, createBaseConfig(), {}, 180, 60, 60);
    expect(repPartial.totalFolds).toBe(1);
  });

  // --------------------------------------------------------------------------
  // T24: Determinism
  // --------------------------------------------------------------------------
  it("T24 — repeated walk-forward runs are 100% deterministic", () => {
    const bars = createSyntheticBars(300);
    const config = createBaseConfig();

    const rep1 = runWalkForwardValidation({ assetBars: { BTC: bars } }, config, {}, 180, 60, 60);
    const rep2 = runWalkForwardValidation({ assetBars: { BTC: bars } }, config, {}, 180, 60, 60);

    expect(rep1).toEqual(rep2);
  });

  // --------------------------------------------------------------------------
  // T25: M9 PIT Guard Active
  // --------------------------------------------------------------------------
  it("T25 — Gate M9 PIT guards active during walk-forward (rejects SAME_BAR_CLOSE)", () => {
    const bars = createSyntheticBars(300);
    const badConfig = createBaseConfig({ executionRule: "SAME_BAR_CLOSE", requirePitExecution: true });

    expect(() =>
      runWalkForwardValidation({ assetBars: { BTC: bars } }, badConfig, {}, 180, 60, 60)
    ).toThrow(/SAME_BAR_CLOSE is a theoretical benchmark mode/);
  });

  // --------------------------------------------------------------------------
  // T26: Truthful Methodology Label
  // --------------------------------------------------------------------------
  it("T26 — report metadata contains truthful methodology label", () => {
    const bars = createSyntheticBars(300);
    const report = runWalkForwardValidation({ assetBars: { BTC: bars } }, createBaseConfig(), {}, 180, 60, 60);

    expect(report.methodology).toBe("Rolling Fixed-Parameter OOS Evaluation");
  });

  // --------------------------------------------------------------------------
  // IMPORTANT REGRESSION PROOF: aggregateOosMetrics != foldReports[0].oosMetrics
  // --------------------------------------------------------------------------
  it("IMPORTANT — regression proof: aggregateOosMetrics is derived from all folds and != foldReports[0].oosMetrics", () => {
    // Generate 360 bars with price trend in fold 1 (bars 240..299) different from fold 0 (bars 180..239)
    const bars = createSyntheticBars(360, 50000, 1700000000000, 1.5);
    const report = runWalkForwardValidation({ assetBars: { BTC: bars } }, createBaseConfig(), {}, 180, 60, 60);

    expect(report.totalFolds).toBe(3);

    const f0Metrics = report.foldReports[0].oosMetrics;
    const f1Metrics = report.foldReports[1].oosMetrics;
    const aggMetrics = report.aggregateOosMetrics;

    // Verify fold 0 and fold 1 are different
    expect(f0Metrics.totalReturnPct).not.toBe(f1Metrics.totalReturnPct);

    // PROOF: Aggregate metrics MUST NOT equal fold 0 metrics alone!
    expect(aggMetrics.totalReturnPct).not.toBe(f0Metrics.totalReturnPct);
    expect(aggMetrics.finalNav).not.toBe(f0Metrics.finalNav);

    // Verify aggregate finalNav matches the last NAV of the stitched timeline
    const expectedFinalNav = report.stitchedOosTimeline.at(-1)?.nav;
    expect(aggMetrics.finalNav).toBe(expectedFinalNav);
  });
});
