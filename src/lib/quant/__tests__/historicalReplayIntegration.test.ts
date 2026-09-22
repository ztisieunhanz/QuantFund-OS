// ============================================================================
// FILE: src/lib/quant/__tests__/historicalReplayIntegration.test.ts
// MODULE: INTEGRATION TEST SUITE: CANONICAL HISTORICAL DATASET -> REPLAY PIT (GATE M12E)
// PRINCIPLE: Anti-Lookahead Plumbing & Truthful Point-in-Time Availability (I1 - I32)
// ============================================================================

import { describe, expect, it } from "vitest";
import {
  type HistoricalDataset,
  type HistoricalMarketObservation,
  type HistoricalMacroRelease,
  type HistoricalEventRecord,
  HistoricalDatasetValidationError,
  validateHistoricalDataset,
  buildHistoricalContextAtTime,
  isEventReactionEligible,
  sliceHistoricalDataset,
  latestEligibleVintage,
} from "../historicalPit";
import { marketDateTimeToEpochMs } from "../historicalSources/timezoneUtils";
import { runBacktest } from "../backtestEngine";
import { PaperEngine } from "@/lib/paperEngine";
import type { BacktestConfig, PointInTimeBar } from "../types";
import { BAR_DURATION_MS } from "../timeDomain";
import { evaluateEventReaction } from "../eventReaction";
import {
  buildRealHistoricalMacroReleases,
  buildRealHistoricalEventRecords,
  REAL_HISTORICAL_FIXTURE_BLS_NFP,
} from "../historicalSources/sampleMacroData";
import { parseBlsEmploymentRelease } from "../historicalSources/blsReleases";

// ----------------------------------------------------------------------------
// TEST HELPERS & SYNTHETIC FIXTURES
// ----------------------------------------------------------------------------

function createSyntheticBars(count: number, startMs: number, startPrice = 50000): PointInTimeBar[] {
  const bars: PointInTimeBar[] = [];
  let current = startPrice;

  // Linear congruential generator for reproducible deterministic bars
  let seed = 42;
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

function createTestConfig(): BacktestConfig {
  return {
    runId: "m12e-integration-test",
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

// ----------------------------------------------------------------------------
// TEST SUITE: GATE M12E INTEGRATION
// ----------------------------------------------------------------------------

describe("Gate M12E — Canonical Historical Dataset -> Replay PIT Integration", () => {
  // Common epoch markers (February 2024)
  const T_FEB_01_0000 = 1706745600000;
  const T_FEB_02_0830_EST = 1706880600000; // Jan NFP initial release (+353k)
  const T_FEB_02_0900_EST = 1706882400000;
  const T_FEB_13_0830_EST = 1707831000000; // Jan CPI release
  const T_FEB_13_0900_EST = 1707832800000;
  const T_MAR_08_0830_EST = marketDateTimeToEpochMs("2024-03-08", "08:30", "America/New_York"); // Jan NFP 1st revision (+229k)
  const T_MAR_08_0900_EST = marketDateTimeToEpochMs("2024-03-08", "09:00", "America/New_York");

  // ==========================================================================
  // 22. MARKET DATA PIT TESTS (I1 - I6)
  // ==========================================================================
  describe("22. Market Data PIT Tests (I1 - I6)", () => {
    it("I1: BTC completed candle invisible before availableAt", () => {
      // 1H candle for 10:00 - 11:00 UTC: observationTime = 10:00, availableAt = 11:00
      const candle: HistoricalMarketObservation = {
        seriesId: "BTC",
        value: 52000,
        observationTime: 1707818400000, // 10:00 UTC
        availableAt: 1707822000000,     // 11:00 UTC
        provider: "BINANCE",
      };

      const dataset: HistoricalDataset = {
        marketObservations: [candle],
        macroReleases: [],
        eventRecords: [],
      };

      // Query 1 ms before availability: candle must be completely invisible
      const beforeAvailable = 1707822000000 - 1;
      const ctx = buildHistoricalContextAtTime(dataset, beforeAvailable);
      expect(ctx.market["BTC"]).toBeUndefined();
    });

    it("I2: visible at equality boundary", () => {
      const candle: HistoricalMarketObservation = {
        seriesId: "BTC",
        value: 52000,
        observationTime: 1707818400000,
        availableAt: 1707822000000,
        provider: "BINANCE",
      };

      const dataset: HistoricalDataset = {
        marketObservations: [candle],
        macroReleases: [],
        eventRecords: [],
      };

      // Exact equality: availableAt === decisionTime -> visible
      const ctx = buildHistoricalContextAtTime(dataset, 1707822000000);
      expect(ctx.market["BTC"]).toBeDefined();
      expect(ctx.market["BTC"].value).toBe(52000);
    });

    it("I3: future BTC candle mutation cannot change earlier decision", () => {
      const bars = createSyntheticBars(140, T_FEB_01_0000);
      const cutoffIdx = 130;
      const cutoffTime = bars[cutoffIdx].timestamp;

      // Create base market observations matching bars
      const obsD: HistoricalMarketObservation[] = bars.map((b) => ({
        seriesId: "BTC",
        value: b.close,
        observationTime: b.timestamp,
        availableAt: b.timestamp + BAR_DURATION_MS,
        provider: "BINANCE",
      }));

      // In D', mutate ONLY observations with availableAt > cutoffTime
      const obsDPrime: HistoricalMarketObservation[] = obsD.map((obs) => {
        if (obs.availableAt > cutoffTime) {
          return { ...obs, value: obs.value * 10 }; // massive future mutation
        }
        return obs;
      });

      const config = createTestConfig();
      const resD = runBacktest(config, {
        assetBars: { BTC: bars },
        historicalDataset: { marketObservations: obsD, macroReleases: [], eventRecords: [] },
      });
      const resDPrime = runBacktest(config, {
        assetBars: { BTC: bars },
        historicalDataset: { marketObservations: obsDPrime, macroReleases: [], eventRecords: [] },
      });

      expect(resD.timeline.length).toBeGreaterThan(0);
      for (let t = 0; t < resD.timeline.length; t++) {
        if (resD.timeline[t].timestamp <= cutoffTime) {
          // All decisions at t <= cutoffTime must be strictly identical
          expect(resD.timeline[t].nav).toBe(resDPrime.timeline[t].nav);
          expect(resD.timeline[t].cash).toBe(resDPrime.timeline[t].cash);
          expect(resD.timeline[t].signals).toEqual(resDPrime.timeline[t].signals);
          expect(resD.timeline[t].targetWeights).toEqual(resDPrime.timeline[t].targetWeights);
          expect(resD.timeline[t].historicalContext?.market["BTC"]?.value).toBe(
            resDPrime.timeline[t].historicalContext?.market["BTC"]?.value
          );
        }
      }
    });

    it("I4: future VIX/DXY daily observation cannot affect earlier decision", () => {
      const bars = createSyntheticBars(140, T_FEB_01_0000);
      const cutoffIdx = 130;
      const cutoffTime = bars[cutoffIdx].timestamp;

      const dailyObs: HistoricalMarketObservation[] = [
        {
          seriesId: "VIX",
          value: 15.0,
          observationTime: T_FEB_01_0000,
          availableAt: T_FEB_01_0000 + 21 * 3600_000,
          provider: "YAHOO",
        },
        {
          seriesId: "VIX",
          value: 20.0,
          observationTime: cutoffTime + 86400_000,
          availableAt: cutoffTime + 86400_000 + 21 * 3600_000,
          provider: "YAHOO",
        },
      ];

      // Mutate future VIX in DPrime
      const dailyObsPrime: HistoricalMarketObservation[] = [
        dailyObs[0],
        { ...dailyObs[1], value: 95.0 }, // extreme future spike
      ];

      const config = createTestConfig();
      const resD = runBacktest(config, {
        assetBars: { BTC: bars },
        historicalDataset: { marketObservations: dailyObs, macroReleases: [], eventRecords: [] },
      });
      const resDPrime = runBacktest(config, {
        assetBars: { BTC: bars },
        historicalDataset: { marketObservations: dailyObsPrime, macroReleases: [], eventRecords: [] },
      });

      for (let t = 0; t < resD.timeline.length; t++) {
        if (resD.timeline[t].timestamp <= cutoffTime) {
          expect(resD.timeline[t].nav).toBe(resDPrime.timeline[t].nav);
          expect(resD.timeline[t].historicalContext?.market["VIX"]?.value).toBe(
            resDPrime.timeline[t].historicalContext?.market["VIX"]?.value
          );
        }
      }
    });

    it("I5: future H.15 yield release cannot affect earlier decision", () => {
      const bars = createSyntheticBars(140, T_FEB_01_0000);
      const cutoffIdx = 130;
      const cutoffTime = bars[cutoffIdx].timestamp;

      const baseYields: HistoricalMarketObservation[] = [
        {
          seriesId: "US10Y",
          value: 4.15,
          observationTime: T_FEB_01_0000,
          availableAt: T_FEB_01_0000 + 21 * 3600_000,
          provider: "US_TREASURY",
        },
        {
          seriesId: "US10Y",
          value: 4.25,
          observationTime: cutoffTime + 86400_000,
          availableAt: cutoffTime + 86400_000 + 21 * 3600_000,
          provider: "US_TREASURY",
        },
      ];

      const mutatedYields: HistoricalMarketObservation[] = [
        baseYields[0],
        { ...baseYields[1], value: 9.99 }, // future yield shock
      ];

      const config = createTestConfig();
      const resA = runBacktest(config, {
        assetBars: { BTC: bars },
        historicalDataset: { marketObservations: baseYields, macroReleases: [], eventRecords: [] },
      });
      const resB = runBacktest(config, {
        assetBars: { BTC: bars },
        historicalDataset: { marketObservations: mutatedYields, macroReleases: [], eventRecords: [] },
      });

      for (let t = 0; t < resA.timeline.length; t++) {
        if (resA.timeline[t].timestamp <= cutoffTime) {
          expect(resA.timeline[t].nav).toBe(resB.timeline[t].nav);
          expect(resA.timeline[t].historicalContext?.market["US10Y"]?.value).toBe(
            resB.timeline[t].historicalContext?.market["US10Y"]?.value
          );
        }
      }
    });

    it("I6: latest prior daily observation carries forward only after availability", () => {
      // Day 1: Feb 12 observation, available on Feb 12 at 21:15 UTC
      const day1Obs: HistoricalMarketObservation = {
        seriesId: "VIX",
        value: 14.5,
        observationTime: 1707696000000, // Feb 12 00:00 UTC
        availableAt: 1707772500000,     // Feb 12 21:15 UTC
        provider: "YAHOO",
      };
      // Day 2: Feb 13 observation, available on Feb 13 at 21:15 UTC
      const day2Obs: HistoricalMarketObservation = {
        seriesId: "VIX",
        value: 15.8,
        observationTime: 1707782400000, // Feb 13 00:00 UTC
        availableAt: 1707858900000,     // Feb 13 21:15 UTC
        provider: "YAHOO",
      };

      const dataset: HistoricalDataset = {
        marketObservations: [day1Obs, day2Obs],
        macroReleases: [],
        eventRecords: [],
      };

      // 1. Feb 12 12:00 UTC: Day 1 observation is NOT yet available (< 21:15 UTC)
      const ctx1 = buildHistoricalContextAtTime(dataset, 1707739200000);
      expect(ctx1.market["VIX"]).toBeUndefined();

      // 2. Feb 13 12:00 UTC: Day 1 observation carries forward (Day 2 not yet available)
      const ctx2 = buildHistoricalContextAtTime(dataset, 1707825600000);
      expect(ctx2.market["VIX"]).toBeDefined();
      expect(ctx2.market["VIX"].value).toBe(14.5);
      expect(ctx2.market["VIX"].observationTime).toBe(day1Obs.observationTime);

      // 3. Feb 13 22:00 UTC: Day 2 observation becomes available (> 21:15 UTC)
      const ctx3 = buildHistoricalContextAtTime(dataset, 1707861600000);
      expect(ctx3.market["VIX"]).toBeDefined();
      expect(ctx3.market["VIX"].value).toBe(15.8);
      expect(ctx3.market["VIX"].observationTime).toBe(day2Obs.observationTime);
    });
  });

  // ==========================================================================
  // 23. MACRO REVISION TESTS (I7 - I11)
  // ==========================================================================
  describe("23. Macro Revision Tests (I7 - I11)", () => {
    // Parse verified BLS NFP fixtures
    const nfpResult = parseBlsEmploymentRelease(REAL_HISTORICAL_FIXTURE_BLS_NFP);
    if (!nfpResult.success) throw new Error(nfpResult.error);
    const nfpReleases = nfpResult.macroReleases;

    it("I7: initial NFP +353 visible after Feb 2 release", () => {
      const dataset: HistoricalDataset = {
        marketObservations: [],
        macroReleases: nfpReleases,
        eventRecords: [],
      };

      // At Feb 2 09:00 EST (after 08:30 EST initial release)
      const ctx = buildHistoricalContextAtTime(dataset, T_FEB_02_0900_EST);
      const rel = ctx.macro["US_NFP_NET_CHANGE"];
      expect(rel).toBeDefined();
      expect(rel.value).toBe(353);
      expect(rel.revisionIndex).toBe(0);
    });

    it("I8: March revision +229 invisible before Mar 8 release", () => {
      // Isolate Jan 2024 releases (initial + revision 1)
      const janReleases = nfpReleases.filter((r) => r.observationTime === nfpReleases[0].observationTime);
      const dataset: HistoricalDataset = {
        marketObservations: [],
        macroReleases: janReleases,
        eventRecords: [],
      };

      // At March 8 08:00 EST (30 minutes before 08:30 EST publication)
      const ctx = buildHistoricalContextAtTime(dataset, T_MAR_08_0830_EST - 1800_000);
      const rel = ctx.macro["US_NFP_NET_CHANGE"];
      expect(rel).toBeDefined();
      // Must still be the initial +353k vintage! Revision +229k is strictly invisible!
      expect(rel.value).toBe(353);
      expect(rel.revisionIndex).toBe(0);

      // Also verify via latestEligibleVintage primitive
      const janObsTime = janReleases[0].observationTime;
      const vintageBefore = latestEligibleVintage(dataset.macroReleases, "US_NFP_NET_CHANGE", janObsTime, T_MAR_08_0830_EST - 1800_000);
      expect(vintageBefore?.value).toBe(353);
      expect(vintageBefore?.revisionIndex).toBe(0);
    });

    it("I9: +229 visible at/after Mar 8 boundary", () => {
      // Isolate Jan 2024 releases (initial + revision 1)
      const janReleases = nfpReleases.filter((r) => r.observationTime === nfpReleases[0].observationTime);
      const dataset: HistoricalDataset = {
        marketObservations: [],
        macroReleases: janReleases,
        eventRecords: [],
      };

      // Exactly at publication boundary (08:30 EST)
      const ctxBoundary = buildHistoricalContextAtTime(dataset, T_MAR_08_0830_EST);
      expect(ctxBoundary.macro["US_NFP_NET_CHANGE"].value).toBe(229);
      expect(ctxBoundary.macro["US_NFP_NET_CHANGE"].revisionIndex).toBe(1);

      // At 09:00 EST
      const ctxAfter = buildHistoricalContextAtTime(dataset, T_MAR_08_0900_EST);
      expect(ctxAfter.macro["US_NFP_NET_CHANGE"].value).toBe(229);
      expect(ctxAfter.macro["US_NFP_NET_CHANGE"].revisionIndex).toBe(1);

      // Also verify on full dataset with latestEligibleVintage for Jan 2024 observation period
      const janObsTime = janReleases[0].observationTime;
      const fullDataset: HistoricalDataset = { marketObservations: [], macroReleases: nfpReleases, eventRecords: [] };
      const vintageAt = latestEligibleVintage(fullDataset.macroReleases, "US_NFP_NET_CHANGE", janObsTime, T_MAR_08_0830_EST);
      expect(vintageAt?.value).toBe(229);
      expect(vintageAt?.revisionIndex).toBe(1);
    });

    it("I10: deleting/mutating future +229 revision does not change pre-Mar-8 decision", () => {
      // Create bars covering Feb 1 to Feb 20
      const bars = createSyntheticBars(140, T_FEB_01_0000);

      // Dataset A has initial release AND future revision
      const datasetA: HistoricalDataset = {
        marketObservations: [],
        macroReleases: nfpReleases,
        eventRecords: [],
      };

      // Dataset B has the revision completely REMOVED
      const datasetB: HistoricalDataset = {
        marketObservations: [],
        macroReleases: nfpReleases.filter((r) => r.revisionIndex === 0),
        eventRecords: [],
      };

      const config = createTestConfig();
      const resA = runBacktest(config, { assetBars: { BTC: bars }, historicalDataset: datasetA });
      const resB = runBacktest(config, { assetBars: { BTC: bars }, historicalDataset: datasetB });

      // Entire replay occurs in Feb (well before Mar 8) -> results must be 100% identical
      expect(resA.timeline.length).toBe(resB.timeline.length);
      for (let t = 0; t < resA.timeline.length; t++) {
        expect(resA.timeline[t].nav).toBe(resB.timeline[t].nav);
        expect(resA.timeline[t].signals).toEqual(resB.timeline[t].signals);
        expect(resA.timeline[t].historicalContext?.macro["US_NFP_NET_CHANGE"]?.value).toBe(
          resB.timeline[t].historicalContext?.macro["US_NFP_NET_CHANGE"]?.value
        );
      }
    });

    it("I11: vintageDate alone cannot make a revision visible", () => {
      // Construct a record where vintageDate says "2024-02-02" but availableAt is Mar 8
      const delayedRelease: HistoricalMacroRelease = {
        seriesId: "US_NFP_NET_CHANGE",
        observationTime: 1706745600000,
        publishedAt: T_MAR_08_0830_EST,
        availableAt: T_MAR_08_0830_EST,
        vintageDate: "2024-02-02", // deceptive vintage date metadata
        revisionIndex: 1,
        value: 229,
        provider: "BLS",
      };

      const dataset: HistoricalDataset = {
        marketObservations: [],
        macroReleases: [delayedRelease],
        eventRecords: [],
      };

      // At Feb 2, despite vintageDate="2024-02-02", availableAt is in March: must be invisible
      const ctx = buildHistoricalContextAtTime(dataset, T_FEB_02_0900_EST);
      expect(ctx.macro["US_NFP_NET_CHANGE"]).toBeUndefined();
    });
  });

  // ==========================================================================
  // 24. EVENT TESTS (I12 - I18)
  // ==========================================================================
  describe("24. Event Tests (I12 - I18)", () => {
    const realEvents = buildRealHistoricalEventRecords();

    it("I12: CPI event invisible before release", () => {
      const cpiEvent = realEvents.find((e) => e.eventType === "US_CPI_REPORT");
      expect(cpiEvent).toBeDefined();

      const dataset: HistoricalDataset = {
        marketObservations: [],
        macroReleases: [],
        eventRecords: [cpiEvent!],
      };

      // 1 ms before publication
      const ctx = buildHistoricalContextAtTime(dataset, cpiEvent!.availableAt - 1);
      expect((ctx as any).events).toBeUndefined();
      expect(ctx.latestEvent).toBeNull();
    });

    it("I13: visible at release equality boundary", () => {
      const cpiEvent = realEvents.find((e) => e.eventType === "US_CPI_REPORT")!;
      const dataset: HistoricalDataset = {
        marketObservations: [],
        macroReleases: [],
        eventRecords: [cpiEvent],
      };

      // At exact equality boundary
      const ctx = buildHistoricalContextAtTime(dataset, cpiEvent.availableAt);
      expect((ctx as any).events).toBeUndefined();
      expect(ctx.latestEvent?.eventId).toBe(cpiEvent.eventId);
    });

    it("I14: visible CPI event with null consensus does not activate EventReaction", () => {
      const cpiEvent = realEvents.find((e) => e.eventType === "US_CPI_REPORT")!;
      expect(cpiEvent.consensus).toBeNull();
      expect(cpiEvent.surprise).toBeNull();

      // 1. Check PIT eligibility predicate directly
      expect(isEventReactionEligible(cpiEvent, cpiEvent.availableAt)).toBe(false);

      // 2. Evaluate EventReaction strategy with this event
      const bars = createSyntheticBars(20, cpiEvent.availableAt - 10 * BAR_DURATION_MS);
      const signal = evaluateEventReaction(
        {
          strategyId: "EVENT_REACTION",
          assetId: "BTC",
          currentBarTimestamp: cpiEvent.availableAt,
          decisionTimestamp: cpiEvent.availableAt,
          currentPrice: 50000,
          priceHistory: bars,
          macro: null,
          latestEvent: {
            eventId: cpiEvent.eventId,
            eventType: cpiEvent.eventType,
            eventTimestamp: cpiEvent.observationTime,
            publicationTimestamp: cpiEvent.publishedAt,
            consensusSnapshotTimestamp: cpiEvent.publishedAt,
            actual: cpiEvent.actual,
            consensus: null,
            previous: cpiEvent.previous,
            surprise: null,
            sourceQuality: cpiEvent.sourceQuality,
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
      expect(signal.heuristicExpectedReturn).toBe(0);
      expect(signal.rationale).toContain("EVENT_MISSING_SURPRISE_DATA");
    });

    it("I15: visible NFP event with null consensus does not activate EventReaction", () => {
      const nfpEvent = realEvents.find((e) => e.eventType === "NON_FARM_PAYROLLS_REPORT")!;
      expect(nfpEvent).toBeDefined();
      expect(nfpEvent.consensus).toBeNull();
      expect(isEventReactionEligible(nfpEvent, nfpEvent.availableAt)).toBe(false);
    });

    it("I16: visible FOMC event with null consensus does not activate EventReaction", () => {
      const fomcEvent = realEvents.find((e) => e.eventType === "FED_RATE_DECISION")!;
      expect(fomcEvent.consensus).toBeNull();
      expect(isEventReactionEligible(fomcEvent, fomcEvent.availableAt)).toBe(false);
    });

    it("I17: future event mutation cannot affect earlier decisions", () => {
      const bars = createSyntheticBars(140, T_FEB_01_0000);
      const cutoffIdx = 130;
      const cutoffTime = bars[cutoffIdx].timestamp;

      const eventA: HistoricalEventRecord = {
        eventId: "PAST_EV",
        eventType: "TEST",
        observationTime: T_FEB_01_0000,
        publishedAt: T_FEB_01_0000,
        availableAt: T_FEB_01_0000,
        actual: 1.0,
        consensus: null,
        consensusFrozenAt: null,
        previous: 1.0,
        surprise: null,
        provider: "BLS",
        sourceQuality: "TIER_1_OFFICIAL",
      };

      const futureEvent: HistoricalEventRecord = {
        eventId: "FUTURE_EV",
        eventType: "TEST",
        observationTime: cutoffTime + 86400_000,
        publishedAt: cutoffTime + 86400_000,
        availableAt: cutoffTime + 86400_000,
        actual: 99.0,
        consensus: null,
        consensusFrozenAt: null,
        previous: 1.0,
        surprise: null,
        provider: "BLS",
        sourceQuality: "TIER_1_OFFICIAL",
      };

      const config = createTestConfig();
      const resA = runBacktest(config, {
        assetBars: { BTC: bars },
        historicalDataset: { marketObservations: [], macroReleases: [], eventRecords: [eventA] },
      });
      const resB = runBacktest(config, {
        assetBars: { BTC: bars },
        historicalDataset: { marketObservations: [], macroReleases: [], eventRecords: [eventA, futureEvent] },
      });

      for (let t = 0; t < resA.timeline.length; t++) {
        if (resA.timeline[t].timestamp <= cutoffTime) {
          expect(resA.timeline[t].nav).toBe(resB.timeline[t].nav);
          expect(resA.timeline[t].signals).toEqual(resB.timeline[t].signals);
        }
      }
    });

    it("I18: legacy synthetic newsFeed event never enters canonical historical context", () => {
      const syntheticNewsFeedEvent: HistoricalEventRecord = {
        eventId: "pit-hist-fake",
        eventType: "CPI_INFLATION_RELEASE",
        observationTime: T_FEB_01_0000,
        publishedAt: T_FEB_01_0000,
        availableAt: T_FEB_01_0000,
        actual: 2.8,
        consensus: 3.2,
        consensusFrozenAt: null, // missing freeze timestamp while claiming surprise
        previous: 3.2,
        surprise: -0.4,
        provider: "BLS",
        sourceQuality: "TIER_1_OFFICIAL",
      };

      expect(() =>
        validateHistoricalDataset({
          marketObservations: [],
          macroReleases: [],
          eventRecords: [syntheticNewsFeedEvent],
        })
      ).toThrowError(HistoricalDatasetValidationError);
    });
  });

  // ==========================================================================
  // 25. EMPTY / ABSENT DATASET TESTS (I19 - I22)
  // ==========================================================================
  describe("25. Empty / Absent Dataset Tests (I19 - I22)", () => {
    it("I19: no HistoricalDataset supplied preserves baseline behavior", () => {
      const bars = createSyntheticBars(140, T_FEB_01_0000);
      const config = createTestConfig();

      const resBaseline = runBacktest(config, { assetBars: { BTC: bars } });
      expect(resBaseline.totalBarsEvaluated).toBe(15);
      expect(resBaseline.timeline.length).toBe(15);
      expect(resBaseline.timeline[0].historicalContext).toBeUndefined();
    });

    it("I20: supplied dataset with empty market/macro/event arrays preserves baseline", () => {
      const bars = createSyntheticBars(140, T_FEB_01_0000);
      const config = createTestConfig();

      const resBaseline = runBacktest(config, { assetBars: { BTC: bars } });
      const resEmpty = runBacktest(config, {
        assetBars: { BTC: bars },
        historicalDataset: {
          marketObservations: [],
          macroReleases: [],
          eventRecords: [],
        },
      });

      expect(resEmpty.metrics.finalNav).toBe(resBaseline.metrics.finalNav);
      expect(resEmpty.metrics.totalReturnPct).toBe(resBaseline.metrics.totalReturnPct);
      expect(resEmpty.metrics.totalTrades).toBe(resBaseline.metrics.totalTrades);

      for (let t = 0; t < resBaseline.timeline.length; t++) {
        expect(resEmpty.timeline[t].nav).toBe(resBaseline.timeline[t].nav);
        expect(resEmpty.timeline[t].signals).toEqual(resBaseline.timeline[t].signals);
        expect(resEmpty.timeline[t].targetWeights).toEqual(resBaseline.timeline[t].targetWeights);
      }
    });

    it("I21: missing optional series returns unavailable/null, not fabricated fallback", () => {
      const dataset: HistoricalDataset = {
        marketObservations: [
          {
            seriesId: "BTC",
            value: 50000,
            observationTime: T_FEB_01_0000,
            availableAt: T_FEB_01_0000,
            provider: "BINANCE",
          },
        ],
        macroReleases: [],
        eventRecords: [],
      };

      const ctx = buildHistoricalContextAtTime(dataset, T_FEB_01_0000);
      expect(ctx.market["BTC"]).toBeDefined();
      expect(ctx.market["GOLD"]).toBeUndefined();
      expect(ctx.market["DXY"]).toBeUndefined();
      expect(ctx.macro["US_CPI_YOY"]).toBeUndefined();
    });

    it("I22: provider/source failure is represented as missing data, not synthetic value", () => {
      const dataset: HistoricalDataset = {
        marketObservations: [], // Provider failed to acquire VIX
        macroReleases: [],
        eventRecords: [],
      };

      const ctx = buildHistoricalContextAtTime(dataset, T_FEB_01_0000);
      expect(ctx.market["VIX"]).toBeUndefined();
    });
  });

  // ==========================================================================
  // 26. DETERMINISM TESTS (I23 - I26)
  // ==========================================================================
  describe("26. Determinism Tests (I23 - I26)", () => {
    it("I23: shuffled input historical arrays normalize to identical replay behavior", () => {
      const bars = createSyntheticBars(140, T_FEB_01_0000);
      const macroReleases = buildRealHistoricalMacroReleases();
      const events = buildRealHistoricalEventRecords();

      const datasetOrdered: HistoricalDataset = {
        marketObservations: [
          { seriesId: "BTC", value: 48000, observationTime: T_FEB_01_0000, availableAt: T_FEB_01_0000, provider: "BINANCE" },
          { seriesId: "BTC", value: 49000, observationTime: T_FEB_02_0830_EST, availableAt: T_FEB_02_0830_EST, provider: "BINANCE" },
          { seriesId: "VIX", value: 14.2, observationTime: T_FEB_01_0000, availableAt: T_FEB_01_0000, provider: "YAHOO" },
        ],
        macroReleases,
        eventRecords: events,
      };

      // Reverse and shuffle arrays
      const datasetShuffled: HistoricalDataset = {
        marketObservations: [...datasetOrdered.marketObservations].reverse(),
        macroReleases: [...datasetOrdered.macroReleases].reverse(),
        eventRecords: [...datasetOrdered.eventRecords].reverse(),
      };

      const config = createTestConfig();
      const resOrdered = runBacktest(config, { assetBars: { BTC: bars }, historicalDataset: datasetOrdered });
      const resShuffled = runBacktest(config, { assetBars: { BTC: bars }, historicalDataset: datasetShuffled });

      expect(resOrdered.metrics).toEqual(resShuffled.metrics);
      expect(resOrdered.timeline.length).toBe(resShuffled.timeline.length);
      for (let t = 0; t < resOrdered.timeline.length; t++) {
        expect(resOrdered.timeline[t].nav).toBe(resShuffled.timeline[t].nav);
        expect(resOrdered.timeline[t].historicalContext?.macro).toEqual(
          resShuffled.timeline[t].historicalContext?.macro
        );
        expect(resOrdered.timeline[t].historicalContext?.market).toEqual(
          resShuffled.timeline[t].historicalContext?.market
        );
      }
    });

    it("I24: same dataset + same config + same seed produces identical replay", () => {
      const bars = createSyntheticBars(140, T_FEB_01_0000);
      const dataset: HistoricalDataset = {
        marketObservations: [
          { seriesId: "BTC", value: 48000, observationTime: T_FEB_01_0000, availableAt: T_FEB_01_0000, provider: "BINANCE" },
        ],
        macroReleases: buildRealHistoricalMacroReleases(),
        eventRecords: buildRealHistoricalEventRecords(),
      };

      const config = createTestConfig();
      const run1 = runBacktest(config, { assetBars: { BTC: bars }, historicalDataset: dataset });
      const run2 = runBacktest(config, { assetBars: { BTC: bars }, historicalDataset: dataset });

      expect(run1.metrics).toEqual(run2.metrics);
      expect(run1.timeline).toEqual(run2.timeline);
    });

    it("I25: machine timezone does not alter replay context", () => {
      // Lookups depend purely on numeric epoch millisecond comparisons (availableAt <= decisionTime)
      const dataset: HistoricalDataset = {
        marketObservations: [
          { seriesId: "BTC", value: 51200, observationTime: 1707818400000, availableAt: 1707822000000, provider: "BINANCE" },
        ],
        macroReleases: [],
        eventRecords: [],
      };

      const ctxBefore = buildHistoricalContextAtTime(dataset, 1707822000000 - 1);
      const ctxAt = buildHistoricalContextAtTime(dataset, 1707822000000);

      expect(ctxBefore.market["BTC"]).toBeUndefined();
      expect(ctxAt.market["BTC"]?.value).toBe(51200);
    });

    it("I26: repeated lookup at same T is identical", () => {
      const dataset: HistoricalDataset = {
        marketObservations: [
          { seriesId: "BTC", value: 50000, observationTime: T_FEB_01_0000, availableAt: T_FEB_01_0000, provider: "BINANCE" },
        ],
        macroReleases: buildRealHistoricalMacroReleases(),
        eventRecords: buildRealHistoricalEventRecords(),
      };

      const ctx1 = buildHistoricalContextAtTime(dataset, T_FEB_13_0900_EST);
      const ctx2 = buildHistoricalContextAtTime(dataset, T_FEB_13_0900_EST);

      expect(ctx1).toEqual(ctx2);
    });
  });

  // ==========================================================================
  // 27. FAIL-CLOSED TESTS (I27 - I32)
  // ==========================================================================
  describe("27. Fail-Closed Tests (I27 - I32)", () => {
    it("I27: malformed timestamp rejects dataset before replay", () => {
      const invalidObs: HistoricalMarketObservation = {
        seriesId: "BTC",
        value: 50000,
        observationTime: -100, // negative timestamp
        availableAt: 1000,
        provider: "BINANCE",
      };

      const bars = createSyntheticBars(140, T_FEB_01_0000);
      const config = createTestConfig();

      expect(() =>
        runBacktest(config, {
          assetBars: { BTC: bars },
          historicalDataset: {
            marketObservations: [invalidObs],
            macroReleases: [],
            eventRecords: [],
          },
        })
      ).toThrowError(HistoricalDatasetValidationError);
    });

    it("I28: conflicting duplicate rejects dataset", () => {
      const obs1: HistoricalMarketObservation = {
        seriesId: "BTC",
        value: 50000,
        observationTime: T_FEB_01_0000,
        availableAt: T_FEB_01_0000,
        provider: "BINANCE",
      };
      const obsConflict: HistoricalMarketObservation = {
        seriesId: "BTC",
        value: 51000, // conflicting price at exact same timestamp
        observationTime: T_FEB_01_0000,
        availableAt: T_FEB_01_0000,
        provider: "BINANCE",
      };

      expect(() =>
        validateHistoricalDataset({
          marketObservations: [obs1, obsConflict],
          macroReleases: [],
          eventRecords: [],
        })
      ).toThrowError(HistoricalDatasetValidationError);
    });

    it("I29: invalid macro revision rejects dataset", () => {
      const invalidRelease: HistoricalMacroRelease = {
        seriesId: "US_CPI_YOY",
        observationTime: T_FEB_01_0000,
        publishedAt: T_FEB_13_0830_EST,
        availableAt: T_FEB_13_0830_EST,
        revisionIndex: -1, // invalid negative revision index
        value: 3.1,
        provider: "BLS",
      };

      expect(() =>
        validateHistoricalDataset({
          marketObservations: [],
          macroReleases: [invalidRelease],
          eventRecords: [],
        })
      ).toThrowError(HistoricalDatasetValidationError);
    });

    it("I30: invalid event consensus/surprise relationship rejects dataset", () => {
      const invalidEvent: HistoricalEventRecord = {
        eventId: "TEST-EV",
        eventType: "TEST",
        observationTime: T_FEB_01_0000,
        publishedAt: T_FEB_01_0000,
        availableAt: T_FEB_01_0000,
        actual: 3.0,
        consensus: 2.5,
        consensusFrozenAt: T_FEB_01_0000,
        previous: 2.0,
        surprise: 0.1, // MISMATCH: actual (3.0) - consensus (2.5) = 0.5 != 0.1
        provider: "BLS",
        sourceQuality: "TIER_1_OFFICIAL",
      };

      expect(() =>
        validateHistoricalDataset({
          marketObservations: [],
          macroReleases: [],
          eventRecords: [invalidEvent],
        })
      ).toThrowError(HistoricalDatasetValidationError);
    });

    it("I31: non-finite market value rejects dataset", () => {
      const nonFiniteObs: HistoricalMarketObservation = {
        seriesId: "BTC",
        value: NaN, // non-finite
        observationTime: T_FEB_01_0000,
        availableAt: T_FEB_01_0000,
        provider: "BINANCE",
      };

      expect(() =>
        validateHistoricalDataset({
          marketObservations: [nonFiniteObs],
          macroReleases: [],
          eventRecords: [],
        })
      ).toThrowError(HistoricalDatasetValidationError);
    });

    it("I32: historical dataset cannot change canonical 1H interval", () => {
      const non1hDataset: any = {
        marketObservations: [],
        macroReleases: [],
        eventRecords: [],
        metadata: {
          interval: "4h", // invalid interval (only 1h supported)
        },
      };

      expect(() => validateHistoricalDataset(non1hDataset)).toThrowError(
        HistoricalDatasetValidationError
      );
    });
  });

  // ==========================================================================
  // SLICE & PAPER ENGINE SMOKE TESTS
  // ==========================================================================
  describe("Slice & PaperEngine Integration Smoke", () => {
    it("sliceHistoricalDataset preserves PIT bounds with lower-bound seeding", () => {
      const obs1: HistoricalMarketObservation = {
        seriesId: "BTC",
        value: 40000,
        observationTime: 1000,
        availableAt: 1000,
        provider: "BINANCE",
      };
      const obs2: HistoricalMarketObservation = {
        seriesId: "BTC",
        value: 50000,
        observationTime: 2000,
        availableAt: 2000,
        provider: "BINANCE",
      };
      const obs3: HistoricalMarketObservation = {
        seriesId: "BTC",
        value: 60000,
        observationTime: 3000,
        availableAt: 3000, // Beyond endTime (2500)
        provider: "BINANCE",
      };

      const dataset: HistoricalDataset = {
        marketObservations: [obs1, obs2, obs3],
        macroReleases: [],
        eventRecords: [],
      };

      const sliced = sliceHistoricalDataset(dataset, 1500, 2500);
      // M12F-B: obs1 is preserved as pre-start seed, obs2 is in-window, obs3 is excluded
      expect(sliced.marketObservations.length).toBe(2);
      expect(sliced.marketObservations[0].value).toBe(40000);
      expect(sliced.marketObservations[1].value).toBe(50000);
      expect(sliced.marketObservations.some((m) => m.availableAt > 2500)).toBe(false);
    });

    it("PaperEngine.replay forwards optional historicalDataset cleanly", () => {
      const engine = new PaperEngine();
      const bars = createSyntheticBars(140, T_FEB_01_0000).map((b) => ({
        time: b.timestamp,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
      }));

      // 1. Without historicalDataset: baseline behavior
      const resNoHist = engine.replay(bars, { interval: "1h", source: "live" });
      expect(resNoHist.latestDecision?.historicalContext).toBeUndefined();

      // 2. With historicalDataset: historicalContext is derived per bar
      const dataset: HistoricalDataset = {
        marketObservations: [
          { seriesId: "BTC", value: 50000, observationTime: T_FEB_01_0000, availableAt: T_FEB_01_0000, provider: "BINANCE" },
        ],
        macroReleases: [],
        eventRecords: [],
      };
      const resWithHist = engine.replay(bars, { interval: "1h", source: "live" }, dataset);
      expect(resWithHist.latestDecision?.historicalContext).toBeDefined();
      expect(resWithHist.latestDecision?.historicalContext?.market["BTC"]?.value).toBe(50000);
    });
  });

  // ==========================================================================
  // GATE M12E-R1: COMPACT HISTORICAL EVENT AUDIT CONTEXT (A1 - A10)
  // ==========================================================================
  describe("Gate M12E-R1: Compact Historical Event Audit Context (A1 - A10)", () => {
    it("A1: HistoricalContextAtTime does not contain complete historical event prefix", () => {
      const dataset: HistoricalDataset = {
        marketObservations: [],
        macroReleases: [],
        eventRecords: [
          {
            eventId: "EV_1",
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
          },
        ],
      };

      const ctx = buildHistoricalContextAtTime(dataset, 2000);
      // Property 'events' must NOT exist on HistoricalContextAtTime
      expect((ctx as any).events).toBeUndefined();
      expect(ctx.latestEvent?.eventId).toBe("EV_1");
    });

    it("A2: dataset with 100 past events produces compact context at T", () => {
      const events: HistoricalEventRecord[] = [];
      for (let i = 0; i < 100; i++) {
        events.push({
          eventId: `EV_${i}`,
          eventType: "TEST",
          observationTime: 1000 + i * 1000,
          publishedAt: 1000 + i * 1000,
          availableAt: 1000 + i * 1000,
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

      const ctx = buildHistoricalContextAtTime(dataset, 150_000);
      expect((ctx as any).events).toBeUndefined();
      expect(ctx.latestEvent?.eventId).toBe("EV_99");
      // Verify strictly compact keys
      expect(Object.keys(ctx).sort()).toEqual(["decisionTime", "latestEvent", "macro", "market"]);
    });

    it("A3: latestEvent is the newest event with availableAt <= T", () => {
      const events: HistoricalEventRecord[] = [
        {
          eventId: "EV_OLD",
          eventType: "TEST",
          observationTime: 1000,
          publishedAt: 1000,
          availableAt: 1000,
          actual: 1,
          consensus: null,
          consensusFrozenAt: null,
          previous: null,
          surprise: null,
          provider: "BLS",
          sourceQuality: "TIER_1_OFFICIAL",
        },
        {
          eventId: "EV_NEWEST",
          eventType: "TEST",
          observationTime: 2000,
          publishedAt: 2000,
          availableAt: 2000,
          actual: 2,
          consensus: null,
          consensusFrozenAt: null,
          previous: null,
          surprise: null,
          provider: "BLS",
          sourceQuality: "TIER_1_OFFICIAL",
        },
      ];

      const dataset: HistoricalDataset = {
        marketObservations: [],
        macroReleases: [],
        eventRecords: events,
      };

      const ctx = buildHistoricalContextAtTime(dataset, 2500);
      expect(ctx.latestEvent?.eventId).toBe("EV_NEWEST");
    });

    it("A4: future event remains invisible", () => {
      const events: HistoricalEventRecord[] = [
        {
          eventId: "EV_PAST",
          eventType: "TEST",
          observationTime: 1000,
          publishedAt: 1000,
          availableAt: 1000,
          actual: 1,
          consensus: null,
          consensusFrozenAt: null,
          previous: null,
          surprise: null,
          provider: "BLS",
          sourceQuality: "TIER_1_OFFICIAL",
        },
        {
          eventId: "EV_FUTURE",
          eventType: "TEST",
          observationTime: 5000,
          publishedAt: 5000,
          availableAt: 5000,
          actual: 2,
          consensus: null,
          consensusFrozenAt: null,
          previous: null,
          surprise: null,
          provider: "BLS",
          sourceQuality: "TIER_1_OFFICIAL",
        },
      ];

      const dataset: HistoricalDataset = {
        marketObservations: [],
        macroReleases: [],
        eventRecords: events,
      };

      const ctx = buildHistoricalContextAtTime(dataset, 3000);
      expect(ctx.latestEvent?.eventId).toBe("EV_PAST");
    });

    it("A5: adding 1,000 OLD already-visible events does not make DecisionState contain a 1,000-element event array", () => {
      const bars = createSyntheticBars(140, T_FEB_01_0000);
      const events: HistoricalEventRecord[] = [];
      for (let i = 0; i < 1000; i++) {
        events.push({
          eventId: `OLD_EV_${i}`,
          eventType: "TEST",
          observationTime: T_FEB_01_0000 - 100_000 - i * 1000,
          publishedAt: T_FEB_01_0000 - 100_000 - i * 1000,
          availableAt: T_FEB_01_0000 - 100_000 - i * 1000,
          actual: i,
          consensus: null,
          consensusFrozenAt: null,
          previous: null,
          surprise: null,
          provider: "BLS",
          sourceQuality: "TIER_1_OFFICIAL",
        });
      }

      const config = createTestConfig();
      const res = runBacktest(config, {
        assetBars: { BTC: bars },
        historicalDataset: { marketObservations: [], macroReleases: [], eventRecords: events },
      });

      expect(res.timeline.length).toBeGreaterThan(0);
      for (const step of res.timeline) {
        expect((step.historicalContext as any)?.events).toBeUndefined();
        // Constant-size audit footprint: only a single latestEvent reference
        expect(step.historicalContext?.latestEvent).toBeDefined();
        expect(typeof step.historicalContext?.latestEvent).toBe("object");
      }
    });

    it("A6: EventReaction still receives correct latest eligible event semantics", () => {
      const bars = createSyntheticBars(140, T_FEB_01_0000);
      const eventTime = bars[126].timestamp;

      // Event with verified surprise
      const verifiedEvent: HistoricalEventRecord = {
        eventId: "VERIFIED_CPI",
        eventType: "US_CPI_REPORT",
        observationTime: eventTime,
        publishedAt: eventTime,
        availableAt: eventTime,
        actual: 3.5,
        consensus: 3.1,
        consensusFrozenAt: eventTime,
        previous: 3.0,
        surprise: 0.4,
        provider: "BLS",
        sourceQuality: "TIER_1_OFFICIAL",
      };

      const config = createTestConfig();
      const res = runBacktest(config, {
        assetBars: { BTC: bars },
        historicalDataset: { marketObservations: [], macroReleases: [], eventRecords: [verifiedEvent] },
      });

      // At bar 126, the verified event is knowable
      const decisionAtEvent = res.timeline.find((d) => d.timestamp === eventTime);
      expect(decisionAtEvent).toBeDefined();
      expect(decisionAtEvent?.historicalContext?.latestEvent?.eventId).toBe("VERIFIED_CPI");
    });

    it("A7: null-consensus latest event still produces EventReaction alpha 0", () => {
      const bars = createSyntheticBars(140, T_FEB_01_0000);
      const eventTime = bars[126].timestamp;

      // Official event lacking consensus
      const officialEvent: HistoricalEventRecord = {
        eventId: "OFFICIAL_NFP",
        eventType: "NON_FARM_PAYROLLS_REPORT",
        observationTime: eventTime,
        publishedAt: eventTime,
        availableAt: eventTime,
        actual: 353,
        consensus: null,
        consensusFrozenAt: null,
        previous: null,
        surprise: null,
        provider: "BLS",
        sourceQuality: "TIER_1_OFFICIAL",
      };

      const config = createTestConfig();
      const res = runBacktest(config, {
        assetBars: { BTC: bars },
        historicalDataset: { marketObservations: [], macroReleases: [], eventRecords: [officialEvent] },
      });

      const decisionAtEvent = res.timeline.find((d) => d.timestamp === eventTime);
      expect(decisionAtEvent).toBeDefined();
      expect(decisionAtEvent?.historicalContext?.latestEvent?.eventId).toBe("OFFICIAL_NFP");
      const eventSignal = decisionAtEvent?.signals.find((s) => s.strategyId === "EVENT_REACTION");
      expect(eventSignal?.alphaScore).toBe(0);
      expect(eventSignal?.confidence).toBe(0);
    });

    it("A8: future-suffix invariance still passes", () => {
      const bars = createSyntheticBars(140, T_FEB_01_0000);
      const cutoffIdx = 130;
      const cutoffTime = bars[cutoffIdx].timestamp;

      const pastEvent: HistoricalEventRecord = {
        eventId: "PAST_1",
        eventType: "TEST",
        observationTime: T_FEB_01_0000,
        publishedAt: T_FEB_01_0000,
        availableAt: T_FEB_01_0000,
        actual: 1.0,
        consensus: null,
        consensusFrozenAt: null,
        previous: null,
        surprise: null,
        provider: "BLS",
        sourceQuality: "TIER_1_OFFICIAL",
      };
      const futureEvent: HistoricalEventRecord = {
        eventId: "FUTURE_1",
        eventType: "TEST",
        observationTime: cutoffTime + 86400_000,
        publishedAt: cutoffTime + 86400_000,
        availableAt: cutoffTime + 86400_000,
        actual: 99.0,
        consensus: null,
        consensusFrozenAt: null,
        previous: null,
        surprise: null,
        provider: "BLS",
        sourceQuality: "TIER_1_OFFICIAL",
      };

      const config = createTestConfig();
      const resA = runBacktest(config, {
        assetBars: { BTC: bars },
        historicalDataset: { marketObservations: [], macroReleases: [], eventRecords: [pastEvent] },
      });
      const resB = runBacktest(config, {
        assetBars: { BTC: bars },
        historicalDataset: { marketObservations: [], macroReleases: [], eventRecords: [pastEvent, futureEvent] },
      });

      for (let t = 0; t < resA.timeline.length; t++) {
        if (resA.timeline[t].timestamp <= cutoffTime) {
          expect(resA.timeline[t].nav).toBe(resB.timeline[t].nav);
          expect(resA.timeline[t].signals).toEqual(resB.timeline[t].signals);
          expect(resA.timeline[t].targetWeights).toEqual(resB.timeline[t].targetWeights);
          expect(resA.timeline[t].historicalContext?.latestEvent?.eventId).toBe(
            resB.timeline[t].historicalContext?.latestEvent?.eventId
          );
        }
      }
    });

    it("A9: no HistoricalDataset behavior remains unchanged", () => {
      const bars = createSyntheticBars(140, T_FEB_01_0000);
      const config = createTestConfig();
      const res = runBacktest(config, { assetBars: { BTC: bars } });
      for (const step of res.timeline) {
        expect(step.historicalContext).toBeUndefined();
      }
      expect(res.totalBarsEvaluated).toBe(15);
    });

    it("A10: empty HistoricalDataset behavior remains unchanged", () => {
      const bars = createSyntheticBars(140, T_FEB_01_0000);
      const config = createTestConfig();
      const resBaseline = runBacktest(config, { assetBars: { BTC: bars } });
      const resEmpty = runBacktest(config, {
        assetBars: { BTC: bars },
        historicalDataset: { marketObservations: [], macroReleases: [], eventRecords: [] },
      });

      expect(resEmpty.metrics).toEqual(resBaseline.metrics);
      for (let t = 0; t < resBaseline.timeline.length; t++) {
        expect(resEmpty.timeline[t].nav).toBe(resBaseline.timeline[t].nav);
        expect(resEmpty.timeline[t].signals).toEqual(resBaseline.timeline[t].signals);
        expect(resEmpty.timeline[t].historicalContext).toEqual({
          decisionTime: resBaseline.timeline[t].timestamp,
          market: {},
          macro: {},
          latestEvent: null,
        });
      }
    });
  });
});
