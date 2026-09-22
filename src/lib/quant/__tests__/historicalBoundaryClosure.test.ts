// ============================================================================
// FILE: src/lib/quant/__tests__/historicalBoundaryClosure.test.ts
// MODULE: GATE M12F-B TEST SUITE: HISTORICAL REPLAY BOUNDARY CLOSURE (B1 - B28)
// PRINCIPLE: Single Traded-Bar Truth, Carry-Forward PIT Slicing, Strategy Non-Mutation
// ============================================================================

import { describe, expect, it } from "vitest";
import {
  type HistoricalDataset,
  type HistoricalMarketObservation,
  type HistoricalMacroRelease,
  type HistoricalEventRecord,
  validateHistoricalDataset,
  buildHistoricalContextAtTime,
  sliceHistoricalDataset,
  isEventReactionEligible,
} from "../historicalPit";
import { runBacktest, type BacktestDataset } from "../backtestEngine";
import { runWalkForwardValidation } from "../walkForward";
import { evaluateEventReaction } from "../eventReaction";
import type { BacktestConfig, PointInTimeBar } from "../types";
import { BAR_DURATION_MS } from "../timeDomain";
import { marketDateTimeToEpochMs } from "../historicalSources/timezoneUtils";

// ----------------------------------------------------------------------------
// TEST FIXTURES & DETERMINISTIC HELPERS
// ----------------------------------------------------------------------------

function createSyntheticBars(count: number, startMs: number, startPrice = 50000): PointInTimeBar[] {
  const bars: PointInTimeBar[] = [];
  let current = startPrice;

  let seed = 12345;
  const lcg = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };

  for (let i = 0; i < count; i++) {
    const open = current;
    const change = (lcg() - 0.48) * (startPrice * 0.005);
    current = Math.max(100, open + change);
    const high = Math.max(open, current) * (1 + lcg() * 0.002);
    const low = Math.min(open, current) * (1 - lcg() * 0.002);
    const volume = 1000 + lcg() * 500;

    bars.push({
      timestamp: startMs + i * BAR_DURATION_MS,
      open: Math.round(open * 100) / 100,
      high: Math.round(high * 100) / 100,
      low: Math.round(low * 100) / 100,
      close: Math.round(current * 100) / 100,
      volume: Math.round(volume * 10) / 10,
    });
  }

  return bars;
}

function createTestConfig(runId = "m12f-b-test"): BacktestConfig {
  return {
    runId,
    startDate: 0,
    endDate: 0,
    warmupPeriod: 125,
    initialCapital: 10000,
    commissionRate: 0.001,
    slippageModel: { type: "FIXED_BPS", baseBps: 5 },
    executionRule: "NEXT_BAR_OPEN",
    deterministicSeed: 20260922,
    dataQuality: "LIVE",
  };
}

// Fixed reference epoch timestamps (Feb - Mar 2024)
const T_FEB_01_0000 = 1706745600000;
const T_FEB_02_0830_EST = 1706880600000; // Jan NFP initial (+353k)
const T_FEB_15_0000 = 1707955200000;
const T_MAR_08_0830_EST = marketDateTimeToEpochMs("2024-03-08", "08:30", "America/New_York"); // Jan NFP rev (+229k)
const T_MAR_15_0000 = 1710460800000;

// ----------------------------------------------------------------------------
// TEST SUITE: GATE M12F-B BOUNDARY CLOSURE
// ----------------------------------------------------------------------------

describe("Gate M12F-B — Historical Replay Boundary Closure", () => {
  // ==========================================================================
  // SECTION 13: SOURCE OF TRUTH (B1 - B4)
  // ==========================================================================
  describe("Section 13: Source of Truth (B1 - B4)", () => {
    it("B1: HistoricalDataset contract no longer contains marketBars", () => {
      const dataset: HistoricalDataset = {
        marketObservations: [],
        macroReleases: [],
        eventRecords: [],
      };
      // Property marketBars must NOT exist on HistoricalDataset interface
      expect((dataset as any).marketBars).toBeUndefined();
      expect(() => validateHistoricalDataset(dataset)).not.toThrow();
    });

    it("B2: execution still uses BacktestDataset.assetBars exactly as before", () => {
      const bars = createSyntheticBars(140, T_FEB_01_0000, 50000);
      const config = createTestConfig("b2-exec");
      const res = runBacktest(config, { assetBars: { BTC: bars } });

      expect(res.totalBarsEvaluated).toBe(15);
      expect(res.metrics.initialNav).toBe(10000);
      expect(res.timeline.length).toBe(15);
      // Execution price matches assetBars prices
      for (const state of res.timeline) {
        expect(state.nav).toBeGreaterThan(0);
      }
    });

    it("B3: historical factor observation cannot replace or override assetBars", () => {
      const bars = createSyntheticBars(140, T_FEB_01_0000, 50000);
      const config = createTestConfig("b3-override");

      const factorObs: HistoricalMarketObservation = {
        seriesId: "BTC",
        value: 100000, // Factor observation differs from traded bar close (50,000)
        observationTime: T_FEB_01_0000,
        availableAt: T_FEB_01_0000,
        provider: "BINANCE",
      };

      const resBaseline = runBacktest(config, { assetBars: { BTC: bars } });
      const resWithFactor = runBacktest(config, {
        assetBars: { BTC: bars },
        historicalDataset: {
          marketObservations: [factorObs],
          macroReleases: [],
          eventRecords: [],
        },
      });

      // Factor observation does NOT change NAV or execution fills
      expect(resWithFactor.metrics.finalNav).toBe(resBaseline.metrics.finalNav);
      expect(resWithFactor.metrics.totalReturnPct).toBe(resBaseline.metrics.totalReturnPct);
      expect(resWithFactor.metrics.totalTrades).toBe(resBaseline.metrics.totalTrades);
    });

    it("B4: contradictory factor BTC value does not alter execution price/NAV solely by existing in marketObservations", () => {
      const bars = createSyntheticBars(140, T_FEB_01_0000, 45000);
      const config = createTestConfig("b4-contradictory");

      const extremeFactorObs: HistoricalMarketObservation = {
        seriesId: "BTC",
        value: 999999, // Wildly contradictory price
        observationTime: bars[126].timestamp,
        availableAt: bars[126].timestamp,
        provider: "BINANCE",
      };

      const resBaseline = runBacktest(config, { assetBars: { BTC: bars } });
      const resContradictory = runBacktest(config, {
        assetBars: { BTC: bars },
        historicalDataset: {
          marketObservations: [extremeFactorObs],
          macroReleases: [],
          eventRecords: [],
        },
      });

      for (let t = 0; t < resBaseline.timeline.length; t++) {
        expect(resContradictory.timeline[t].nav).toBe(resBaseline.timeline[t].nav);
        expect(resContradictory.timeline[t].cash).toBe(resBaseline.timeline[t].cash);
        expect(resContradictory.timeline[t].dailyPnl).toBe(resBaseline.timeline[t].dailyPnl);
      }
    });
  });

  // ==========================================================================
  // SECTION 14: SLICE LOWER BOUND (B5 - B10)
  // ==========================================================================
  describe("Section 14: Slice Lower Bound (B5 - B10)", () => {
    it("B5: market observation before startTime is retained as latest seed", () => {
      const obsOld: HistoricalMarketObservation = {
        seriesId: "VIX",
        value: 14.0,
        observationTime: 1000,
        availableAt: 1000,
        provider: "YAHOO",
      };
      const obsSeed: HistoricalMarketObservation = {
        seriesId: "VIX",
        value: 18.5,
        observationTime: 2000,
        availableAt: 2000,
        provider: "YAHOO",
      };
      const obsInWindow: HistoricalMarketObservation = {
        seriesId: "VIX",
        value: 22.0,
        observationTime: 4000,
        availableAt: 4000,
        provider: "YAHOO",
      };

      const dataset: HistoricalDataset = {
        marketObservations: [obsOld, obsSeed, obsInWindow],
        macroReleases: [],
        eventRecords: [],
      };

      const sliced = sliceHistoricalDataset(dataset, 3000, 6000);
      // obsSeed (2000 < 3000) is retained as seed; obsOld (1000) is omitted
      expect(sliced.marketObservations.length).toBe(2);
      expect(sliced.marketObservations[0].value).toBe(18.5);
      expect(sliced.marketObservations[0].availableAt).toBe(2000);
      expect(sliced.marketObservations[1].value).toBe(22.0);
    });

    it("B6: macro release before startTime is retained as latest seed", () => {
      const relSeed: HistoricalMacroRelease = {
        seriesId: "US_CPI_YOY",
        observationTime: 1000,
        publishedAt: 2000,
        availableAt: 2000,
        revisionIndex: 0,
        value: 3.1,
        provider: "BLS",
      };
      const relInWindow: HistoricalMacroRelease = {
        seriesId: "US_CPI_YOY",
        observationTime: 2000,
        publishedAt: 4000,
        availableAt: 4000,
        revisionIndex: 0,
        value: 3.2,
        provider: "BLS",
      };

      const dataset: HistoricalDataset = {
        marketObservations: [],
        macroReleases: [relSeed, relInWindow],
        eventRecords: [],
      };

      const sliced = sliceHistoricalDataset(dataset, 3000, 6000);
      expect(sliced.macroReleases.length).toBe(2);
      expect(sliced.macroReleases[0].value).toBe(3.1);
      expect(sliced.macroReleases[1].value).toBe(3.2);
    });

    it("B7: latest pre-start event is retained as at most one seed", () => {
      const ev1: HistoricalEventRecord = {
        eventId: "EV1",
        eventType: "TEST",
        observationTime: 1000,
        publishedAt: 1000,
        availableAt: 1000,
        actual: 1.0,
        consensus: null,
        consensusFrozenAt: null,
        previous: null,
        surprise: null,
        provider: "BLS",
        sourceQuality: "TIER_1_OFFICIAL",
      };
      const ev2: HistoricalEventRecord = {
        eventId: "EV2",
        eventType: "TEST",
        observationTime: 2000,
        publishedAt: 2000,
        availableAt: 2000,
        actual: 2.0,
        consensus: null,
        consensusFrozenAt: null,
        previous: null,
        surprise: null,
        provider: "BLS",
        sourceQuality: "TIER_1_OFFICIAL",
      };
      const evInWindow: HistoricalEventRecord = {
        eventId: "EV3",
        eventType: "TEST",
        observationTime: 4000,
        publishedAt: 4000,
        availableAt: 4000,
        actual: 3.0,
        consensus: null,
        consensusFrozenAt: null,
        previous: null,
        surprise: null,
        provider: "BLS",
        sourceQuality: "TIER_1_OFFICIAL",
      };

      const dataset: HistoricalDataset = {
        marketObservations: [],
        macroReleases: [],
        eventRecords: [ev1, ev2, evInWindow],
      };

      const sliced = sliceHistoricalDataset(dataset, 3000, 6000);
      // At most one seed (EV2) + EV3
      expect(sliced.eventRecords.length).toBe(2);
      expect(sliced.eventRecords[0].eventId).toBe("EV2");
      expect(sliced.eventRecords[1].eventId).toBe("EV3");
    });

    it("B8: records after endTime are excluded", () => {
      const obsFuture: HistoricalMarketObservation = {
        seriesId: "VIX",
        value: 30.0,
        observationTime: 7000,
        availableAt: 7000,
        provider: "YAHOO",
      };

      const dataset: HistoricalDataset = {
        marketObservations: [obsFuture],
        macroReleases: [],
        eventRecords: [],
      };

      const sliced = sliceHistoricalDataset(dataset, 3000, 6000);
      expect(sliced.marketObservations.length).toBe(0);
    });

    it("B9: records inside [startTime, endTime] remain present", () => {
      const obsInWindow: HistoricalMarketObservation = {
        seriesId: "DXY",
        value: 103.5,
        observationTime: 4500,
        availableAt: 4500,
        provider: "YAHOO",
      };

      const dataset: HistoricalDataset = {
        marketObservations: [obsInWindow],
        macroReleases: [],
        eventRecords: [],
      };

      const sliced = sliceHistoricalDataset(dataset, 4000, 5000);
      expect(sliced.marketObservations.length).toBe(1);
      expect(sliced.marketObservations[0].seriesId).toBe("DXY");
    });

    it("B10: no full pre-start event history is copied", () => {
      const events: HistoricalEventRecord[] = [];
      for (let i = 0; i < 20; i++) {
        events.push({
          eventId: `EV_${i}`,
          eventType: "TEST",
          observationTime: 1000 + i * 100,
          publishedAt: 1000 + i * 100,
          availableAt: 1000 + i * 100,
          actual: i,
          consensus: null,
          consensusFrozenAt: null,
          previous: null,
          surprise: null,
          provider: "BLS",
          sourceQuality: "TIER_1_OFFICIAL",
        });
      }

      const dataset: HistoricalDataset = {
        marketObservations: [],
        macroReleases: [],
        eventRecords: events,
      };

      const sliced = sliceHistoricalDataset(dataset, 5000, 10000);
      // All 20 events are before 5000; exactly 1 seed must be retained (EV_19)
      expect(sliced.eventRecords.length).toBe(1);
      expect(sliced.eventRecords[0].eventId).toBe("EV_19");
    });
  });

  // ==========================================================================
  // SECTION 15: REVISION SEMANTICS (B11 - B15)
  // ==========================================================================
  describe("Section 15: Revision Semantics (B11 - B15)", () => {
    const nfpInitial: HistoricalMacroRelease = {
      seriesId: "US_NFP_NET_CHANGE",
      observationTime: T_FEB_01_0000,
      publishedAt: T_FEB_02_0830_EST,
      availableAt: T_FEB_02_0830_EST,
      revisionIndex: 0,
      value: 353,
      provider: "BLS",
    };
    const nfpRevision: HistoricalMacroRelease = {
      seriesId: "US_NFP_NET_CHANGE",
      observationTime: T_FEB_01_0000,
      publishedAt: T_MAR_08_0830_EST,
      availableAt: T_MAR_08_0830_EST,
      revisionIndex: 1,
      value: 229,
      provider: "BLS",
    };

    const datasetWithRevisions: HistoricalDataset = {
      marketObservations: [],
      macroReleases: [nfpInitial, nfpRevision],
      eventRecords: [],
    };

    it("B11: fold starts after NFP initial +353 but before +229 revision: context begins with +353", () => {
      // Fold starts Feb 15 (after Feb 2 +353, before Mar 8 +229)
      const sliced = sliceHistoricalDataset(datasetWithRevisions, T_FEB_15_0000, T_MAR_15_0000);

      // Context at fold start (Feb 15) sees initial +353
      const ctx = buildHistoricalContextAtTime(sliced, T_FEB_15_0000);
      expect(ctx.macro["US_NFP_NET_CHANGE"]?.value).toBe(353);
      expect(ctx.macro["US_NFP_NET_CHANGE"]?.revisionIndex).toBe(0);
    });

    it("B12: +229 future revision remains absent until its availableAt", () => {
      const sliced = sliceHistoricalDataset(datasetWithRevisions, T_FEB_15_0000, T_MAR_15_0000);

      // One second before Mar 8 release: still +353
      const ctxBefore = buildHistoricalContextAtTime(sliced, T_MAR_08_0830_EST - 1);
      expect(ctxBefore.macro["US_NFP_NET_CHANGE"]?.value).toBe(353);
    });

    it("B13: once revision occurs inside fold it becomes latest eligible value", () => {
      const sliced = sliceHistoricalDataset(datasetWithRevisions, T_FEB_15_0000, T_MAR_15_0000);

      // At/after Mar 8 release: +229
      const ctxAt = buildHistoricalContextAtTime(sliced, T_MAR_08_0830_EST);
      expect(ctxAt.macro["US_NFP_NET_CHANGE"]?.value).toBe(229);
      expect(ctxAt.macro["US_NFP_NET_CHANGE"]?.revisionIndex).toBe(1);
    });

    it("B14: fold starting after +229 seeds the revised PIT state correctly", () => {
      // Fold starts March 15 (after Mar 8 +229 revision)
      const sliced = sliceHistoricalDataset(datasetWithRevisions, T_MAR_15_0000, T_MAR_15_0000 + 86400000 * 30);

      // Context at fold start immediately sees +229
      const ctx = buildHistoricalContextAtTime(sliced, T_MAR_15_0000);
      expect(ctx.macro["US_NFP_NET_CHANGE"]?.value).toBe(229);
      expect(ctx.macro["US_NFP_NET_CHANGE"]?.revisionIndex).toBe(1);
    });

    it("B15: future revision beyond testEnd is physically excluded from fold dataset", () => {
      // Fold ends March 1 (before Mar 8 +229 revision)
      const sliced = sliceHistoricalDataset(datasetWithRevisions, T_FEB_01_0000, T_FEB_15_0000);

      // The +229 revision must not exist anywhere in the sliced fold dataset
      const revPresent = sliced.macroReleases.some((r) => r.revisionIndex === 1);
      expect(revPresent).toBe(false);
    });
  });

  // ==========================================================================
  // SECTION 16: WALK-FORWARD (B16 - B22)
  // ==========================================================================
  describe("Section 16: Walk-Forward (B16 - B22)", () => {
    it("B16: walk-forward fold now receives historicalDataset when supplied", () => {
      const bars = createSyntheticBars(300, T_FEB_01_0000);
      const config = createTestConfig("b16-wf");

      const obs: HistoricalMarketObservation = {
        seriesId: "VIX",
        value: 15.0,
        observationTime: T_FEB_01_0000,
        availableAt: T_FEB_01_0000,
        provider: "YAHOO",
      };

      const dataset: BacktestDataset = {
        assetBars: { BTC: bars },
        historicalDataset: {
          marketObservations: [obs],
          macroReleases: [],
          eventRecords: [],
        },
      };

      const report = runWalkForwardValidation(dataset, config, {}, 180, 60, 60);
      expect(report.totalFolds).toBeGreaterThan(0);
      // Fold OOS timeline has historicalContext populated
      const firstDecision = report.foldReports[0].oosTimeline[0];
      expect(firstDecision.historicalContext).toBeDefined();
      expect(firstDecision.historicalContext?.market["VIX"]?.value).toBe(15.0);
    });

    it("B17: no historicalDataset supplied preserves old M10 behavior", () => {
      const bars = createSyntheticBars(300, T_FEB_01_0000);
      const config = createTestConfig("b17-wf-baseline");

      const dataset: BacktestDataset = {
        assetBars: { BTC: bars },
      };

      const report = runWalkForwardValidation(dataset, config, {}, 180, 60, 60);
      const firstDecision = report.foldReports[0].oosTimeline[0];
      expect(firstDecision.historicalContext).toBeUndefined();
    });

    it("B18: future historical records from later folds cannot change earlier fold DecisionStates", () => {
      const bars = createSyntheticBars(300, T_FEB_01_0000);
      const config = createTestConfig("b18-wf-future");

      const obsFold0: HistoricalMarketObservation = {
        seriesId: "VIX",
        value: 14.0,
        observationTime: bars[0].timestamp,
        availableAt: bars[0].timestamp,
        provider: "YAHOO",
      };
      const obsFold1Future: HistoricalMarketObservation = {
        seriesId: "VIX",
        value: 40.0, // Shock in fold 1
        observationTime: bars[250].timestamp,
        availableAt: bars[250].timestamp,
        provider: "YAHOO",
      };

      const datasetWithoutFuture: BacktestDataset = {
        assetBars: { BTC: bars },
        historicalDataset: {
          marketObservations: [obsFold0],
          macroReleases: [],
          eventRecords: [],
        },
      };
      const datasetWithFuture: BacktestDataset = {
        assetBars: { BTC: bars },
        historicalDataset: {
          marketObservations: [obsFold0, obsFold1Future],
          macroReleases: [],
          eventRecords: [],
        },
      };

      const reportWithout = runWalkForwardValidation(datasetWithoutFuture, config, {}, 180, 60, 60);
      const reportWith = runWalkForwardValidation(datasetWithFuture, config, {}, 180, 60, 60);

      // Fold 0 decisions are bit-for-bit identical regardless of future fold 1 observation
      expect(reportWith.foldReports[0].oosMetrics).toEqual(reportWithout.foldReports[0].oosMetrics);
      for (let t = 0; t < reportWith.foldReports[0].oosTimeline.length; t++) {
        expect(reportWith.foldReports[0].oosTimeline[t].nav).toBe(
          reportWithout.foldReports[0].oosTimeline[t].nav
        );
        expect(reportWith.foldReports[0].oosTimeline[t].historicalContext?.market["VIX"]?.value).toBe(14.0);
      }
    });

    it("B19: pre-fold latest-known VIX/yield carries into fold correctly", () => {
      const bars = createSyntheticBars(300, T_FEB_01_0000);
      const config = createTestConfig("b19-wf-carry");

      // Observation available before the entire walk-forward dataset start
      const preObs: HistoricalMarketObservation = {
        seriesId: "US10Y",
        value: 4.15,
        observationTime: T_FEB_01_0000 - 86400000,
        availableAt: T_FEB_01_0000 - 86400000,
        provider: "US_TREASURY",
      };

      const dataset: BacktestDataset = {
        assetBars: { BTC: bars },
        historicalDataset: {
          marketObservations: [preObs],
          macroReleases: [],
          eventRecords: [],
        },
      };

      const report = runWalkForwardValidation(dataset, config, {}, 180, 60, 60);
      const oosFirst = report.foldReports[0].oosTimeline[0];
      expect(oosFirst.historicalContext?.market["US10Y"]?.value).toBe(4.15);
    });

    it("B20: pre-fold macro release carries into fold correctly", () => {
      const bars = createSyntheticBars(300, T_FEB_01_0000);
      const config = createTestConfig("b20-wf-rel-carry");

      const preRel: HistoricalMacroRelease = {
        seriesId: "US_CPI_YOY",
        observationTime: T_FEB_01_0000 - 86400000 * 30,
        publishedAt: T_FEB_01_0000 - 86400000,
        availableAt: T_FEB_01_0000 - 86400000,
        revisionIndex: 0,
        value: 3.4,
        provider: "BLS",
      };

      const dataset: BacktestDataset = {
        assetBars: { BTC: bars },
        historicalDataset: {
          marketObservations: [],
          macroReleases: [preRel],
          eventRecords: [],
        },
      };

      const report = runWalkForwardValidation(dataset, config, {}, 180, 60, 60);
      const oosFirst = report.foldReports[0].oosTimeline[0];
      expect(oosFirst.historicalContext?.macro["US_CPI_YOY"]?.value).toBe(3.4);
    });

    it("B21: historicalContext timestamps within a fold still obey availableAt <= T", () => {
      const bars = createSyntheticBars(300, T_FEB_01_0000);
      const config = createTestConfig("b21-wf-pit-invar");

      const obs1: HistoricalMarketObservation = {
        seriesId: "VIX",
        value: 16.0,
        observationTime: bars[50].timestamp,
        availableAt: bars[50].timestamp,
        provider: "YAHOO",
      };
      const obs2: HistoricalMarketObservation = {
        seriesId: "VIX",
        value: 20.0,
        observationTime: bars[200].timestamp,
        availableAt: bars[200].timestamp,
        provider: "YAHOO",
      };

      const dataset: BacktestDataset = {
        assetBars: { BTC: bars },
        historicalDataset: {
          marketObservations: [obs1, obs2],
          macroReleases: [],
          eventRecords: [],
        },
      };

      const report = runWalkForwardValidation(dataset, config, {}, 180, 60, 60);
      for (const fold of report.foldReports) {
        for (const dec of fold.oosTimeline) {
          if (dec.historicalContext?.market["VIX"]) {
            expect(dec.historicalContext.market["VIX"].availableAt).toBeLessThanOrEqual(dec.timestamp);
          }
        }
      }
    });

    it("B22: same input produces deterministic walk-forward output", () => {
      const bars = createSyntheticBars(300, T_FEB_01_0000);
      const config = createTestConfig("b22-deterministic");

      const dataset: BacktestDataset = {
        assetBars: { BTC: bars },
        historicalDataset: {
          marketObservations: [
            { seriesId: "VIX", value: 15.0, observationTime: T_FEB_01_0000, availableAt: T_FEB_01_0000, provider: "YAHOO" },
          ],
          macroReleases: [],
          eventRecords: [],
        },
      };

      const r1 = runWalkForwardValidation(dataset, config, {}, 180, 60, 60);
      const r2 = runWalkForwardValidation(dataset, config, {}, 180, 60, 60);

      expect(r1.aggregateOosMetrics).toEqual(r2.aggregateOosMetrics);
      expect(r1.totalFolds).toBe(r2.totalFolds);
      expect(r1.robustnessScore).toBe(r2.robustnessScore);
    });
  });

  // ==========================================================================
  // SECTION 17: STRATEGY NON-MUTATION (B23 - B28)
  // ==========================================================================
  describe("Section 17: Strategy Non-Mutation (B23 - B28)", () => {
    it("B23: historical market factors do NOT populate PermissionGate macro state", () => {
      const bars = createSyntheticBars(140, T_FEB_01_0000);
      const config = createTestConfig("b23-perm");

      const extremeFactors: HistoricalMarketObservation[] = [
        { seriesId: "VIX", value: 50.0, observationTime: T_FEB_01_0000, availableAt: T_FEB_01_0000, provider: "YAHOO" },
        { seriesId: "US10Y", value: 6.0, observationTime: T_FEB_01_0000, availableAt: T_FEB_01_0000, provider: "US_TREASURY" },
        { seriesId: "US2Y", value: 8.0, observationTime: T_FEB_01_0000, availableAt: T_FEB_01_0000, provider: "US_TREASURY" },
      ];

      const res = runBacktest(config, {
        assetBars: { BTC: bars },
        historicalDataset: {
          marketObservations: extremeFactors,
          macroReleases: [],
          eventRecords: [],
        },
      });

      // PermissionGate receives macroState = null -> defaults to Transitional Mixed
      const permTrend = res.timeline[0].permissions.find((p) => p.strategyId === "ADAPTIVE_TREND");
      expect(permTrend?.regime).toBe("Transitional Mixed");
      expect(permTrend?.permission).toBe(0.7);
    });

    it("B24: Permission outputs remain baseline-identical solely from supplying market factors/macros that are audit-only", () => {
      const bars = createSyntheticBars(140, T_FEB_01_0000);
      const config = createTestConfig("b24-perm-identical");

      const resBaseline = runBacktest(config, { assetBars: { BTC: bars } });
      const resWithHist = runBacktest(config, {
        assetBars: { BTC: bars },
        historicalDataset: {
          marketObservations: [
            { seriesId: "VIX", value: 45.0, observationTime: T_FEB_01_0000, availableAt: T_FEB_01_0000, provider: "YAHOO" },
          ],
          macroReleases: [
            { seriesId: "US_CPI_YOY", observationTime: T_FEB_01_0000, publishedAt: T_FEB_01_0000, availableAt: T_FEB_01_0000, revisionIndex: 0, value: 5.5, provider: "BLS" },
          ],
          eventRecords: [],
        },
      });

      for (let t = 0; t < resBaseline.timeline.length; t++) {
        expect(resWithHist.timeline[t].permissions).toEqual(resBaseline.timeline[t].permissions);
      }
    });

    it("B25: Risk outputs remain baseline-identical", () => {
      const bars = createSyntheticBars(140, T_FEB_01_0000);
      const config = createTestConfig("b25-risk-identical");

      const resBaseline = runBacktest(config, { assetBars: { BTC: bars } });
      const resWithHist = runBacktest(config, {
        assetBars: { BTC: bars },
        historicalDataset: {
          marketObservations: [
            { seriesId: "VIX", value: 99.0, observationTime: T_FEB_01_0000, availableAt: T_FEB_01_0000, provider: "YAHOO" },
          ],
          macroReleases: [],
          eventRecords: [],
        },
      });

      for (let t = 0; t < resBaseline.timeline.length; t++) {
        expect(resWithHist.timeline[t].risk).toEqual(resBaseline.timeline[t].risk);
      }
    });

    it("B26: Omega behavior receives no direct historical macro input", () => {
      const bars = createSyntheticBars(140, T_FEB_01_0000);
      const config = createTestConfig("b26-omega-identical");

      const resBaseline = runBacktest(config, { assetBars: { BTC: bars } });
      const resWithHist = runBacktest(config, {
        assetBars: { BTC: bars },
        historicalDataset: {
          marketObservations: [
            { seriesId: "VIX", value: 80.0, observationTime: T_FEB_01_0000, availableAt: T_FEB_01_0000, provider: "YAHOO" },
          ],
          macroReleases: [],
          eventRecords: [],
        },
      });

      for (let t = 0; t < resBaseline.timeline.length; t++) {
        expect(resWithHist.timeline[t].targetWeights).toEqual(resBaseline.timeline[t].targetWeights);
      }
    });

    it("B27: AdaptiveTrend and MeanReversion remain unchanged", () => {
      const bars = createSyntheticBars(140, T_FEB_01_0000);
      const config = createTestConfig("b27-alphas-identical");

      const resBaseline = runBacktest(config, { assetBars: { BTC: bars } });
      const resWithHist = runBacktest(config, {
        assetBars: { BTC: bars },
        historicalDataset: {
          marketObservations: [
            { seriesId: "VIX", value: 35.0, observationTime: T_FEB_01_0000, availableAt: T_FEB_01_0000, provider: "YAHOO" },
          ],
          macroReleases: [],
          eventRecords: [],
        },
      });

      for (let t = 0; t < resBaseline.timeline.length; t++) {
        const trendBase = resBaseline.timeline[t].signals.find((s) => s.strategyId === "ADAPTIVE_TREND");
        const trendHist = resWithHist.timeline[t].signals.find((s) => s.strategyId === "ADAPTIVE_TREND");
        expect(trendHist?.alphaScore).toBe(trendBase?.alphaScore);

        const mrBase = resBaseline.timeline[t].signals.find((s) => s.strategyId === "MEAN_REVERSION");
        const mrHist = resWithHist.timeline[t].signals.find((s) => s.strategyId === "MEAN_REVERSION");
        expect(mrHist?.alphaScore).toBe(mrBase?.alphaScore);
      }
    });

    it("B28: official null-consensus events remain EventReaction alpha = 0", () => {
      const nullConsensusEvent: HistoricalEventRecord = {
        eventId: "BLS-CPI-OFFICIAL-202402",
        eventType: "US_CPI_REPORT",
        observationTime: T_FEB_01_0000,
        publishedAt: T_FEB_02_0830_EST,
        availableAt: T_FEB_02_0830_EST,
        actual: 3.1,
        consensus: null, // Official BLS publication without consensus
        consensusFrozenAt: null,
        previous: 3.4,
        surprise: null,
        provider: "BLS",
        sourceQuality: "TIER_1_OFFICIAL",
      };

      expect(isEventReactionEligible(nullConsensusEvent, T_FEB_02_0830_EST)).toBe(false);

      const signal = evaluateEventReaction(
        {
          strategyId: "EVENT_REACTION",
          assetId: "BTC",
          currentBarTimestamp: T_FEB_02_0830_EST,
          decisionTimestamp: T_FEB_02_0830_EST,
          currentPrice: 50000,
          priceHistory: createSyntheticBars(30, T_FEB_01_0000),
          macro: null,
          latestEvent: {
            eventId: nullConsensusEvent.eventId,
            eventType: nullConsensusEvent.eventType,
            eventTimestamp: nullConsensusEvent.observationTime,
            publicationTimestamp: nullConsensusEvent.publishedAt,
            consensusSnapshotTimestamp: nullConsensusEvent.publishedAt,
            actual: nullConsensusEvent.actual,
            consensus: nullConsensusEvent.consensus,
            previous: nullConsensusEvent.previous,
            surprise: nullConsensusEvent.surprise,
            sourceQuality: nullConsensusEvent.sourceQuality,
            noveltyScore: null,
          },
        },
        {
          strategyId: "EVENT_REACTION",
          lastEvaluationTimestamp: 0,
          barsSinceLastSignal: 0,
          internalValues: {},
        }
      );

      expect(signal.alphaScore).toBe(0);
      expect(signal.confidence).toBe(0);
      expect(signal.rationale).toBe("EVENT_MISSING_SURPRISE_DATA: Actual or Consensus is null");
    });
  });
});
