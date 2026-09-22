// ============================================================================
// FILE: src/lib/quant/__tests__/macroPitContract.test.ts
// MODULE: TEST SUITE FOR HISTORICAL POINT-IN-TIME CONTRACTS & LOOKUPS (GATE M12B)
// ============================================================================

import { describe, expect, it } from "vitest";
import {
  type HistoricalMarketObservation,
  type HistoricalMacroRelease,
  type HistoricalEventRecord,
  type HistoricalDataset,
  HistoricalDatasetValidationError,
  validateHistoricalMarketObservation,
  validateHistoricalMacroRelease,
  validateHistoricalEvent,
  validateHistoricalDataset,
  normalizeHistoricalDataset,
  latestEligibleMarketObservation,
  latestEligibleMacroRelease,
  latestEligibleVintage,
  isEventReactionEligible,
  getEligibleEventsInWindow,
  latestEligibleEvent,
} from "../historicalPit";

describe("Gate M12B — Historical PIT Contracts & Deterministic Lookup Foundations", () => {
  // Epoch timestamps for clear test scenarios:
  // Jan 31, 2024 00:00:00 UTC
  const JAN_31_2024 = 1706659200000;
  // Feb 01, 2024 00:00:00 UTC
  const FEB_01_2024 = 1706745600000;
  // Feb 13, 2024 13:30:00 UTC (BLS Jan CPI initial release at 08:30 ET)
  const FEB_13_2024_0830_ET = 1707831000000;
  // Feb 20, 2024 12:00:00 UTC
  const FEB_20_2024 = 1708430400000;
  // Feb 29, 2024 00:00:00 UTC
  const FEB_29_2024 = 1709164800000;
  // Mar 01, 2024 00:00:00 UTC
  const MAR_01_2024 = 1709251200000;
  // Mar 12, 2024 12:30:00 UTC (BLS Feb CPI initial release & Jan CPI revision at 08:30 EDT)
  const MAR_12_2024_0830_ET = 1710246600000;
  // Mar 15, 2024 12:00:00 UTC
  const MAR_15_2024 = 1710504000000;

  // --------------------------------------------------------------------------
  // T1: Future availableAt is invisible
  // --------------------------------------------------------------------------
  it("T1: future availableAt is invisible across market, macro, and event lookups", () => {
    const decisionTime = FEB_01_2024;

    const marketTimeline: HistoricalMarketObservation[] = [
      {
        seriesId: "BTC",
        value: 45000,
        observationTime: FEB_13_2024_0830_ET,
        availableAt: FEB_13_2024_0830_ET,
        provider: "BINANCE",
      },
    ];
    expect(latestEligibleMarketObservation(marketTimeline, "BTC", decisionTime)).toBeNull();

    const macroTimeline: HistoricalMacroRelease[] = [
      {
        seriesId: "US_CPI_YOY",
        value: 3.1,
        observationTime: JAN_31_2024,
        publishedAt: FEB_13_2024_0830_ET,
        availableAt: FEB_13_2024_0830_ET,
        revisionIndex: 0,
        provider: "BLS",
      },
    ];
    expect(latestEligibleMacroRelease(macroTimeline, "US_CPI_YOY", decisionTime)).toBeNull();

    const eventTimeline: HistoricalEventRecord[] = [
      {
        eventId: "CPI-2024-02-13",
        eventType: "US_CPI_REPORT",
        observationTime: JAN_31_2024,
        publishedAt: FEB_13_2024_0830_ET,
        availableAt: FEB_13_2024_0830_ET,
        actual: 3.1,
        consensus: 2.9,
        consensusFrozenAt: FEB_13_2024_0830_ET - 1800000,
        previous: 3.4,
        surprise: 0.2,
        provider: "BLS",
        sourceQuality: "TIER_1_OFFICIAL",
      },
    ];
    expect(latestEligibleEvent(eventTimeline, decisionTime)).toBeNull();
    expect(getEligibleEventsInWindow(eventTimeline, decisionTime - 3600000, decisionTime)).toEqual([]);
  });

  // --------------------------------------------------------------------------
  // T2: availableAt == decisionTime is visible (exact boundary condition)
  // --------------------------------------------------------------------------
  it("T2: availableAt == decisionTime boundary is visible", () => {
    const exactTime = FEB_13_2024_0830_ET;

    const marketObs: HistoricalMarketObservation = {
      seriesId: "VIX",
      value: 14.5,
      observationTime: exactTime,
      availableAt: exactTime,
      provider: "YAHOO",
    };
    expect(latestEligibleMarketObservation([marketObs], "VIX", exactTime)).toEqual(marketObs);

    const macroRel: HistoricalMacroRelease = {
      seriesId: "US_CPI_YOY",
      value: 3.1,
      observationTime: JAN_31_2024,
      publishedAt: exactTime,
      availableAt: exactTime,
      revisionIndex: 0,
      provider: "BLS",
    };
    expect(latestEligibleMacroRelease([macroRel], "US_CPI_YOY", exactTime)).toEqual(macroRel);

    const eventRec: HistoricalEventRecord = {
      eventId: "CPI-2024-02-13",
      eventType: "US_CPI_REPORT",
      observationTime: JAN_31_2024,
      publishedAt: exactTime,
      availableAt: exactTime,
      actual: 3.1,
      consensus: 2.9,
      consensusFrozenAt: exactTime - 1800000,
      previous: 3.4,
      surprise: 0.2,
      provider: "BLS",
      sourceQuality: "TIER_1_OFFICIAL",
    };
    expect(latestEligibleEvent([eventRec], exactTime)).toEqual(eventRec);
  });

  // --------------------------------------------------------------------------
  // T3: observationTime earlier but release later remains invisible
  // --------------------------------------------------------------------------
  it("T3: observationTime earlier but release later remains invisible (no observation-date lookahead)", () => {
    // January CPI refers to period ending Jan 31, but was published Feb 13
    const janCpi: HistoricalMacroRelease = {
      seriesId: "US_CPI_YOY",
      value: 3.1,
      observationTime: JAN_31_2024,
      publishedAt: FEB_13_2024_0830_ET,
      availableAt: FEB_13_2024_0830_ET,
      revisionIndex: 0,
      provider: "BLS",
    };

    // At Feb 01, observationTime (Jan 31) <= Feb 01, BUT availableAt (Feb 13) > Feb 01
    // Must remain strictly invisible!
    const resultAtFeb01 = latestEligibleMacroRelease([janCpi], "US_CPI_YOY", FEB_01_2024);
    expect(resultAtFeb01).toBeNull();
  });

  // --------------------------------------------------------------------------
  // T4: Initial vintage visible before revision
  // --------------------------------------------------------------------------
  it("T4: initial vintage is visible before revision release", () => {
    const janCpiInitial: HistoricalMacroRelease = {
      seriesId: "US_CPI_YOY",
      value: 3.1,
      observationTime: JAN_31_2024,
      publishedAt: FEB_13_2024_0830_ET,
      availableAt: FEB_13_2024_0830_ET,
      revisionIndex: 0,
      provider: "BLS",
    };
    const janCpiRevised: HistoricalMacroRelease = {
      seriesId: "US_CPI_YOY",
      value: 3.2,
      observationTime: JAN_31_2024,
      publishedAt: MAR_12_2024_0830_ET,
      availableAt: MAR_12_2024_0830_ET,
      revisionIndex: 1,
      provider: "BLS",
    };

    const timeline = [janCpiInitial, janCpiRevised];

    // At Feb 20, initial release is available, revised release is in the future
    const lookupAtFeb20 = latestEligibleMacroRelease(timeline, "US_CPI_YOY", FEB_20_2024);
    expect(lookupAtFeb20).not.toBeNull();
    expect(lookupAtFeb20?.revisionIndex).toBe(0);
    expect(lookupAtFeb20?.value).toBe(3.1);
  });

  // --------------------------------------------------------------------------
  // T5: Later revision invisible before its availableAt
  // --------------------------------------------------------------------------
  it("T5: later revision invisible before its availableAt (retains initial vintage)", () => {
    const janCpiInitial: HistoricalMacroRelease = {
      seriesId: "US_CPI_YOY",
      value: 3.1,
      observationTime: JAN_31_2024,
      publishedAt: FEB_13_2024_0830_ET,
      availableAt: FEB_13_2024_0830_ET,
      revisionIndex: 0,
      provider: "BLS",
    };
    const janCpiRevised: HistoricalMacroRelease = {
      seriesId: "US_CPI_YOY",
      value: 3.2,
      observationTime: JAN_31_2024,
      publishedAt: MAR_12_2024_0830_ET,
      availableAt: MAR_12_2024_0830_ET,
      revisionIndex: 1,
      provider: "BLS",
    };

    const timeline = [janCpiInitial, janCpiRevised];

    // At Mar 01, revision is not yet released (available Mar 12)
    const lookupAtMar01 = latestEligibleVintage(timeline, "US_CPI_YOY", JAN_31_2024, MAR_01_2024);
    expect(lookupAtMar01?.revisionIndex).toBe(0);
    expect(lookupAtMar01?.value).toBe(3.1);
  });

  // --------------------------------------------------------------------------
  // T6: Latest eligible vintage selected after revision
  // --------------------------------------------------------------------------
  it("T6: latest eligible vintage selected after revision publication", () => {
    const janCpiInitial: HistoricalMacroRelease = {
      seriesId: "US_CPI_YOY",
      value: 3.1,
      observationTime: JAN_31_2024,
      publishedAt: FEB_13_2024_0830_ET,
      availableAt: FEB_13_2024_0830_ET,
      revisionIndex: 0,
      provider: "BLS",
    };
    const janCpiRevised: HistoricalMacroRelease = {
      seriesId: "US_CPI_YOY",
      value: 3.2,
      observationTime: JAN_31_2024,
      publishedAt: MAR_12_2024_0830_ET,
      availableAt: MAR_12_2024_0830_ET,
      revisionIndex: 1,
      provider: "BLS",
    };

    const timeline = [janCpiInitial, janCpiRevised];

    // At Mar 15, revision was published on Mar 12, so revisionIndex 1 is selected
    const lookupAtMar15 = latestEligibleVintage(timeline, "US_CPI_YOY", JAN_31_2024, MAR_15_2024);
    expect(lookupAtMar15?.revisionIndex).toBe(1);
    expect(lookupAtMar15?.value).toBe(3.2);
  });

  // --------------------------------------------------------------------------
  // T7: Future observation never backfilled
  // --------------------------------------------------------------------------
  it("T7: future observation is never backfilled when prior history is missing", () => {
    const febCpi: HistoricalMacroRelease = {
      seriesId: "US_CPI_YOY",
      value: 3.0,
      observationTime: FEB_29_2024,
      publishedAt: MAR_12_2024_0830_ET,
      availableAt: MAR_12_2024_0830_ET,
      revisionIndex: 0,
      provider: "BLS",
    };

    // Querying at Feb 01 before any CPI is published must return null, not backfill Feb CPI
    expect(latestEligibleMacroRelease([febCpi], "US_CPI_YOY", FEB_01_2024)).toBeNull();
  });

  // --------------------------------------------------------------------------
  // T8: Missing / non-finite availableAt rejected
  // --------------------------------------------------------------------------
  it("T8: missing or non-finite availableAt is rejected fail-closed", () => {
    const invalidMarket = {
      seriesId: "BTC",
      value: 45000,
      observationTime: FEB_01_2024,
      availableAt: NaN,
      provider: "BINANCE",
    } as unknown as HistoricalMarketObservation;
    expect(() => validateHistoricalMarketObservation(invalidMarket)).toThrowError(HistoricalDatasetValidationError);

    const negativeAvail = {
      seriesId: "DXY",
      value: 104.2,
      observationTime: FEB_01_2024,
      availableAt: -100,
      provider: "YAHOO",
    } as unknown as HistoricalMarketObservation;
    expect(() => validateHistoricalMarketObservation(negativeAvail)).toThrowError(HistoricalDatasetValidationError);
  });

  // --------------------------------------------------------------------------
  // T9: No midnight default exists for date-only release
  // --------------------------------------------------------------------------
  it("T9: no midnight default exists; date-level strings without explicit ms fail closed", () => {
    const dateOnlyRelease = {
      seriesId: "US_CPI_YOY",
      value: 3.1,
      observationTime: JAN_31_2024,
      publishedAt: "2024-02-13" as unknown as number, // String instead of epoch ms
      availableAt: "2024-02-13" as unknown as number,
      revisionIndex: 0,
      provider: "BLS",
    } as unknown as HistoricalMacroRelease;

    expect(() => validateHistoricalMacroRelease(dateOnlyRelease)).toThrowError(HistoricalDatasetValidationError);
  });

  // --------------------------------------------------------------------------
  // T10: Same logical dataset with shuffled insertion order gives same lookup
  // --------------------------------------------------------------------------
  it("T10: same logical dataset with shuffled insertion order yields identical normalized and lookup results", () => {
    const relA: HistoricalMacroRelease = {
      seriesId: "US_CPI_YOY",
      value: 3.1,
      observationTime: JAN_31_2024,
      publishedAt: FEB_13_2024_0830_ET,
      availableAt: FEB_13_2024_0830_ET,
      revisionIndex: 0,
      provider: "BLS",
    };
    const relB: HistoricalMacroRelease = {
      seriesId: "US_CPI_YOY",
      value: 3.2,
      observationTime: JAN_31_2024,
      publishedAt: MAR_12_2024_0830_ET,
      availableAt: MAR_12_2024_0830_ET,
      revisionIndex: 1,
      provider: "BLS",
    };
    const relC: HistoricalMacroRelease = {
      seriesId: "US_CPI_YOY",
      value: 3.0,
      observationTime: FEB_29_2024,
      publishedAt: MAR_12_2024_0830_ET,
      availableAt: MAR_12_2024_0830_ET,
      revisionIndex: 0,
      provider: "BLS",
    };

    const dataset1: HistoricalDataset = {
      marketObservations: [],
      macroReleases: [relA, relB, relC],
      eventRecords: [],
    };
    const dataset2: HistoricalDataset = {
      marketObservations: [],
      macroReleases: [relC, relA, relB], // Shuffled order
      eventRecords: [],
    };

    const norm1 = normalizeHistoricalDataset(dataset1);
    const norm2 = normalizeHistoricalDataset(dataset2);

    expect(norm1.macroReleases).toEqual(norm2.macroReleases);

    const lookup1 = latestEligibleMacroRelease(norm1.macroReleases, "US_CPI_YOY", MAR_15_2024);
    const lookup2 = latestEligibleMacroRelease(norm2.macroReleases, "US_CPI_YOY", MAR_15_2024);
    expect(lookup1).toEqual(lookup2);
  });

  // --------------------------------------------------------------------------
  // T11: Conflicting duplicate fails closed
  // --------------------------------------------------------------------------
  it("T11: conflicting duplicate records fail closed", () => {
    const obsA: HistoricalMarketObservation = {
      seriesId: "BTC",
      value: 45000,
      observationTime: FEB_01_2024,
      availableAt: FEB_01_2024,
      provider: "BINANCE",
    };
    const obsBConflicting: HistoricalMarketObservation = {
      seriesId: "BTC",
      value: 46000, // Conflict!
      observationTime: FEB_01_2024,
      availableAt: FEB_01_2024,
      provider: "BINANCE",
    };

    const dataset: HistoricalDataset = {
      marketObservations: [obsA, obsBConflicting],
      macroReleases: [],
      eventRecords: [],
    };

    expect(() => validateHistoricalDataset(dataset)).toThrowError(/Conflicting duplicate/);
  });

  // --------------------------------------------------------------------------
  // T12: Legitimate multiple revisions do not trigger duplicate rejection
  // --------------------------------------------------------------------------
  it("T12: legitimate multiple revisions for the same observation period validate successfully", () => {
    const janInitial: HistoricalMacroRelease = {
      seriesId: "US_GDP_QOQ",
      value: 2.8,
      observationTime: JAN_31_2024,
      publishedAt: FEB_13_2024_0830_ET,
      availableAt: FEB_13_2024_0830_ET,
      revisionIndex: 0,
      provider: "BEA",
    };
    const janSecondEstimate: HistoricalMacroRelease = {
      seriesId: "US_GDP_QOQ",
      value: 3.0,
      observationTime: JAN_31_2024, // Same observation period!
      publishedAt: MAR_12_2024_0830_ET,
      availableAt: MAR_12_2024_0830_ET,
      revisionIndex: 1, // Different revision index
      provider: "BEA",
    };

    const dataset: HistoricalDataset = {
      marketObservations: [],
      macroReleases: [janInitial, janSecondEstimate],
      eventRecords: [],
    };

    expect(() => validateHistoricalDataset(dataset)).not.toThrow();
  });

  // --------------------------------------------------------------------------
  // T13: Market observation latest eligible lookup
  // --------------------------------------------------------------------------
  it("T13: market observation latest eligible lookup returns the newest record knowable at decisionTime", () => {
    const obs1: HistoricalMarketObservation = {
      seriesId: "US10Y",
      value: 4.15,
      observationTime: FEB_01_2024,
      availableAt: FEB_01_2024,
      provider: "US_TREASURY",
    };
    const obs2: HistoricalMarketObservation = {
      seriesId: "US10Y",
      value: 4.25,
      observationTime: FEB_20_2024,
      availableAt: FEB_20_2024,
      provider: "US_TREASURY",
    };
    const obs3Future: HistoricalMarketObservation = {
      seriesId: "US10Y",
      value: 4.35,
      observationTime: MAR_15_2024,
      availableAt: MAR_15_2024,
      provider: "US_TREASURY",
    };

    const timeline = [obs1, obs2, obs3Future];

    // At Mar 01, obs2 is the latest known; obs3Future is invisible
    const lookup = latestEligibleMarketObservation(timeline, "US10Y", MAR_01_2024);
    expect(lookup).toEqual(obs2);
  });

  // --------------------------------------------------------------------------
  // T14: Event future publication invisible
  // --------------------------------------------------------------------------
  it("T14: event with publishedAt/availableAt in the future is invisible", () => {
    const futureEvent: HistoricalEventRecord = {
      eventId: "FOMC-2024-03-20",
      eventType: "FED_RATE_DECISION",
      observationTime: MAR_15_2024,
      publishedAt: MAR_15_2024 + 86400000,
      availableAt: MAR_15_2024 + 86400000,
      actual: 5.5,
      consensus: 5.5,
      consensusFrozenAt: MAR_15_2024,
      previous: 5.5,
      surprise: 0.0,
      provider: "FEDERAL_RESERVE",
      sourceQuality: "TIER_1_OFFICIAL",
    };

    expect(latestEligibleEvent([futureEvent], MAR_15_2024)).toBeNull();
    expect(getEligibleEventsInWindow([futureEvent], MAR_01_2024, MAR_15_2024)).toEqual([]);
  });

  // --------------------------------------------------------------------------
  // T15: Event missing consensus is visible as historical information but NOT EventReaction-eligible
  // --------------------------------------------------------------------------
  it("T15: event missing consensus is visible as historical event record but NOT EventReaction-eligible", () => {
    const historicalReleaseNoConsensus: HistoricalEventRecord = {
      eventId: "CPI-2020-05-12",
      eventType: "US_CPI_REPORT",
      observationTime: JAN_31_2024,
      publishedAt: FEB_13_2024_0830_ET,
      availableAt: FEB_13_2024_0830_ET,
      actual: 0.3,
      consensus: null, // Unverified consensus in raw historical archive
      consensusFrozenAt: null,
      previous: 0.2,
      surprise: null,
      provider: "BLS",
      sourceQuality: "TIER_1_OFFICIAL",
    };

    // 1. Record validates cleanly as a factual historical event
    expect(() => validateHistoricalEvent(historicalReleaseNoConsensus)).not.toThrow();

    // 2. Visible in historical event timeline lookup
    const visibleEvent = latestEligibleEvent([historicalReleaseNoConsensus], FEB_20_2024);
    expect(visibleEvent).toEqual(historicalReleaseNoConsensus);

    // 3. BUT strictly rejected by isEventReactionEligible to prevent fabricating alpha
    const isEligibleForAlpha = isEventReactionEligible(historicalReleaseNoConsensus, FEB_20_2024);
    expect(isEligibleForAlpha).toBe(false);
  });

  // --------------------------------------------------------------------------
  // T16: Verified event actual+consensus+freeze is eligible
  // --------------------------------------------------------------------------
  it("T16: verified event with actual, consensus, frozen cutoff, and surprise is eligible for EventReaction", () => {
    const verifiedEvent: HistoricalEventRecord = {
      eventId: "CPI-2024-02-13",
      eventType: "US_CPI_REPORT",
      observationTime: JAN_31_2024,
      publishedAt: FEB_13_2024_0830_ET,
      availableAt: FEB_13_2024_0830_ET,
      actual: 3.1,
      consensus: 2.9,
      consensusFrozenAt: FEB_13_2024_0830_ET - 1800000, // 30 min before release
      previous: 3.4,
      surprise: 0.2,
      provider: "BLS",
      sourceQuality: "TIER_1_OFFICIAL",
    };

    expect(() => validateHistoricalEvent(verifiedEvent)).not.toThrow();
    expect(isEventReactionEligible(verifiedEvent, FEB_20_2024)).toBe(true);
  });

  // --------------------------------------------------------------------------
  // T17: consensusFrozenAt > publishedAt rejected
  // --------------------------------------------------------------------------
  it("T17: consensusFrozenAt > publishedAt fails closed as lookahead violation", () => {
    const lookaheadConsensus: HistoricalEventRecord = {
      eventId: "BAD-EVENT-1",
      eventType: "US_CPI_REPORT",
      observationTime: JAN_31_2024,
      publishedAt: FEB_13_2024_0830_ET,
      availableAt: FEB_13_2024_0830_ET,
      actual: 3.1,
      consensus: 2.9,
      consensusFrozenAt: FEB_13_2024_0830_ET + 3600000, // Frozen AFTER release! Lookahead!
      previous: 3.4,
      surprise: 0.2,
      provider: "BLS",
      sourceQuality: "TIER_1_OFFICIAL",
    };

    expect(() => validateHistoricalEvent(lookaheadConsensus)).toThrowError(/Lookahead violation/);
    expect(isEventReactionEligible(lookaheadConsensus, FEB_20_2024)).toBe(false);
  });

  // --------------------------------------------------------------------------
  // T18: Surprise mismatch rejected
  // --------------------------------------------------------------------------
  it("T18: surprise mismatch beyond tolerance is rejected fail-closed", () => {
    const mismatchedSurprise: HistoricalEventRecord = {
      eventId: "BAD-SURPRISE-1",
      eventType: "US_CPI_REPORT",
      observationTime: JAN_31_2024,
      publishedAt: FEB_13_2024_0830_ET,
      availableAt: FEB_13_2024_0830_ET,
      actual: 3.1,
      consensus: 2.9,
      consensusFrozenAt: FEB_13_2024_0830_ET - 1800000,
      previous: 3.4,
      surprise: 0.5, // 3.1 - 2.9 = 0.2, NOT 0.5!
      provider: "BLS",
      sourceQuality: "TIER_1_OFFICIAL",
    };

    expect(() => validateHistoricalEvent(mismatchedSurprise)).toThrowError(/surprise mismatch/);
  });

  // --------------------------------------------------------------------------
  // T19: Numeric epoch comparison is timezone/locale independent
  // --------------------------------------------------------------------------
  it("T19: numeric epoch comparisons are independent of host timezone or machine locale", () => {
    // Exact same numeric epoch timestamp regardless of whether tested in Hanoi (UTC+7), London (UTC+0), or New York (UTC-5)
    const tRelease = 1707831000000; // 2024-02-13 13:30:00 UTC
    const tBefore = 1707830999999;
    const tExact = 1707831000000;
    const tAfter = 1707831000001;

    const obs: HistoricalMarketObservation = {
      seriesId: "GOLD",
      value: 2025.5,
      observationTime: tRelease,
      availableAt: tRelease,
      provider: "BINANCE",
    };

    expect(latestEligibleMarketObservation([obs], "GOLD", tBefore)).toBeNull();
    expect(latestEligibleMarketObservation([obs], "GOLD", tExact)).toEqual(obs);
    expect(latestEligibleMarketObservation([obs], "GOLD", tAfter)).toEqual(obs);
  });

  // --------------------------------------------------------------------------
  // T20: Empty historical timelines return null and preserve existing semantics
  // --------------------------------------------------------------------------
  it("T20: empty historical timelines return null and preserve existing semantics", () => {
    expect(latestEligibleMarketObservation([], "BTC", FEB_01_2024)).toBeNull();
    expect(latestEligibleMarketObservation(null, "BTC", FEB_01_2024)).toBeNull();
    expect(latestEligibleMacroRelease([], "US_CPI_YOY", FEB_01_2024)).toBeNull();
    expect(latestEligibleMacroRelease(undefined, "US_CPI_YOY", FEB_01_2024)).toBeNull();
    expect(latestEligibleVintage([], "US_CPI_YOY", JAN_31_2024, FEB_01_2024)).toBeNull();
    expect(latestEligibleEvent([], FEB_01_2024)).toBeNull();
    expect(getEligibleEventsInWindow([], 0, FEB_01_2024)).toEqual([]);
  });

  // --------------------------------------------------------------------------
  // T21: No Date.now dependency
  // --------------------------------------------------------------------------
  it("T21: pure lookup functions have zero Date.now() dependency", () => {
    // Pure deterministic functions accept decisionTime explicitly
    const obs: HistoricalMarketObservation = {
      seriesId: "BTC",
      value: 50000,
      observationTime: 1000,
      availableAt: 1000,
      provider: "BINANCE",
    };

    // Lookups at epoch 500 and 1500 behave strictly according to passed argument
    expect(latestEligibleMarketObservation([obs], "BTC", 500)).toBeNull();
    expect(latestEligibleMarketObservation([obs], "BTC", 1500)).toEqual(obs);
  });

  // --------------------------------------------------------------------------
  // T22: Deterministic repeated lookup produces identical output
  // --------------------------------------------------------------------------
  it("T22: repeated lookups in loop produce strictly identical output", () => {
    const obsA: HistoricalMarketObservation = {
      seriesId: "DXY",
      value: 103.5,
      observationTime: FEB_01_2024,
      availableAt: FEB_01_2024,
      provider: "YAHOO",
    };
    const obsB: HistoricalMarketObservation = {
      seriesId: "DXY",
      value: 104.1,
      observationTime: FEB_20_2024,
      availableAt: FEB_20_2024,
      provider: "YAHOO",
    };
    const timeline = [obsA, obsB];

    const firstResult = latestEligibleMarketObservation(timeline, "DXY", MAR_01_2024);
    for (let i = 0; i < 100; i++) {
      const iterResult = latestEligibleMarketObservation(timeline, "DXY", MAR_01_2024);
      expect(iterResult).toEqual(firstResult);
    }
  });
});
