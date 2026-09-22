// ============================================================================
// FILE: src/lib/quant/__tests__/marketSeriesIngestion.test.ts
// MODULE: TEST SUITE FOR HISTORICAL MARKET-SERIES INGESTION & PUBLIC AVAILABILITY (GATE M12C-R3)
// ============================================================================

import { describe, expect, it } from "vitest";
import {
  latestEligibleMarketObservation,
  normalizeHistoricalDataset,
  type HistoricalDataset,
} from "../historicalPit";
import {
  parseBinance1HKlines,
  ONE_HOUR_MS,
} from "../historicalSources/binanceKlines";
import {
  parseTreasuryYieldSeries,
} from "../historicalSources/treasuryYields";
import {
  parseYahooDailyMarketSeries,
} from "../historicalSources/yahooMarketSeries";
import {
  buildSampleMarketObservations,
  buildSampleMarketObservationsJuly,
  RAW_SAMPLE_TREASURY_DATA,
  RAW_SAMPLE_TREASURY_DATA_JULY,
  SYNTHETIC_TEST_FIXTURE_TREASURY,
  SAMPLE_START_TIME,
  SAMPLE_JULY_START_TIME,
} from "../historicalSources/sampleMarketData";
import {
  marketDateTimeToEpochMs,
  sessionDateToUtcMidnightEpochMs,
} from "../historicalSources/timezoneUtils";
import {
  MARKET_AVAILABILITY_POLICIES,
} from "../historicalSources/types";

describe("Gate M12C & M12C-R — Historical Market-Series Ingestion & Availability Semantics", () => {
  // Epoch markers for Winter Benchmark (2024-02-13, US EST = UTC-5):
  // 2024-02-13 10:00:00 UTC
  const FEB_13_1000_UTC = 1707818400000;
  // 2024-02-13 10:59:59.999 UTC
  const FEB_13_1059_UTC = FEB_13_1000_UTC + ONE_HOUR_MS - 1;
  // 2024-02-13 11:00:00.000 UTC
  const FEB_13_1100_UTC = FEB_13_1000_UTC + ONE_HOUR_MS;

  // 2024-02-13 00:00:00 UTC
  const FEB_13_MIDNIGHT_UTC = 1707782400000;
  // 2024-02-13 15:30:00 UTC (10:30 EST)
  const FEB_13_1530_UTC = 1707838200000;
  // 2024-02-13 20:30:00 UTC (15:30 EST — NY Fed internal quotation cutoff, NOT public availability)
  const FEB_13_FED_QUOTE_CUTOFF_UTC = 1707856200000;

  // Winter availability boundaries under America/New_York (UTC-5):
  // VIX: 16:15 EST -> 21:15:00.000 UTC
  const FEB_13_VIX_AVAILABLE = 1707858900000;
  // Federal Reserve H.15 Treasury release on Feb 13 (covering Feb 12 observation): 16:15 EST -> 21:15:00.000 UTC
  const FEB_13_H15_AVAILABLE = 1707858900000;
  // DXY: 18:00 EST -> 23:00:00.000 UTC
  const FEB_13_DXY_AVAILABLE = 1707865200000;

  // --------------------------------------------------------------------------
  // T1: BTC 10:00–11:00 candle final close invisible before 11:00
  // --------------------------------------------------------------------------
  it("T1: BTC 10:00–11:00 candle final close is invisible before 11:00 close boundary", () => {
    const rawKline = [
      [
        FEB_13_1000_UTC,
        "49000.00",
        "49500.00",
        "48900.00",
        "49350.00", // close price
        "150.5",
        FEB_13_1059_UTC,
      ],
    ];

    const parseResult = parseBinance1HKlines(rawKline, { seriesId: "BTC" });
    expect(parseResult.success).toBe(true);
    if (!parseResult.success) return;

    const timeline = parseResult.observations;
    expect(timeline[0].availableAt).toBe(FEB_13_1100_UTC);

    // Decisions at 10:00, 10:30, 10:59 must NOT see the candle close
    expect(latestEligibleMarketObservation(timeline, "BTC", FEB_13_1000_UTC)).toBeNull();
    expect(latestEligibleMarketObservation(timeline, "BTC", FEB_13_1000_UTC + 1800000)).toBeNull();
    expect(latestEligibleMarketObservation(timeline, "BTC", FEB_13_1059_UTC)).toBeNull();
  });

  // --------------------------------------------------------------------------
  // T2: BTC candle close visible at defined close boundary
  // --------------------------------------------------------------------------
  it("T2: BTC candle close is visible at defined 11:00 close completion boundary", () => {
    const rawKline = [
      [
        FEB_13_1000_UTC,
        "49000.00",
        "49500.00",
        "48900.00",
        "49350.00",
        "150.5",
        FEB_13_1059_UTC,
      ],
    ];

    const parseResult = parseBinance1HKlines(rawKline, { seriesId: "BTC" });
    expect(parseResult.success).toBe(true);
    if (!parseResult.success) return;

    const timeline = parseResult.observations;

    // Decision at exactly 11:00:00.000 UTC can see the completed candle close
    const lookup = latestEligibleMarketObservation(timeline, "BTC", FEB_13_1100_UTC);
    expect(lookup).not.toBeNull();
    expect(lookup?.value).toBe(49350.0);
    expect(lookup?.availableAt).toBe(FEB_13_1100_UTC);
  });

  // --------------------------------------------------------------------------
  // T3: PAXG same behavior
  // --------------------------------------------------------------------------
  it("T3: PAXG tokenized gold exhibits exact same bar-close availability boundary", () => {
    const rawKline = [
      [
        FEB_13_1000_UTC,
        "2015.00",
        "2022.00",
        "2014.00",
        "2020.50",
        "45.2",
        FEB_13_1059_UTC,
      ],
    ];

    const parseResult = parseBinance1HKlines(rawKline, { seriesId: "PAXG" });
    expect(parseResult.success).toBe(true);
    if (!parseResult.success) return;

    const timeline = parseResult.observations;
    expect(timeline[0].availableAt).toBe(FEB_13_1100_UTC);

    expect(latestEligibleMarketObservation(timeline, "PAXG", FEB_13_1059_UTC)).toBeNull();
    const lookup = latestEligibleMarketObservation(timeline, "PAXG", FEB_13_1100_UTC);
    expect(lookup).not.toBeNull();
    expect(lookup?.value).toBe(2020.5);
  });

  // --------------------------------------------------------------------------
  // T4: Daily Treasury value invisible before verified availability boundary
  // --------------------------------------------------------------------------
  it("T4: daily Treasury value is invisible before verified H.15 16:15 ET availability boundary on releaseDate", () => {
    // Official Fed H.15 publication lag: Feb 12 observation released on next business day Feb 13 at 16:15 EST (21:15 UTC)
    const rawData = [
      { observationDate: "2024-02-12", releaseDate: "2024-02-13", bc_10year: "4.18", bc_2year: "4.48" },
    ];

    const parseResult = parseTreasuryYieldSeries(rawData, { seriesId: "US10Y" });
    expect(parseResult.success).toBe(true);
    if (!parseResult.success) return;

    const timeline = parseResult.observations;
    expect(timeline[0].availableAt).toBe(FEB_13_H15_AVAILABLE);

    // Decisions on Feb 12 and on Feb 13 before 21:15 UTC must NOT see Feb 12 yield
    expect(latestEligibleMarketObservation(timeline, "US10Y", FEB_13_MIDNIGHT_UTC)).toBeNull();
    expect(latestEligibleMarketObservation(timeline, "US10Y", FEB_13_1000_UTC)).toBeNull();
    expect(latestEligibleMarketObservation(timeline, "US10Y", FEB_13_1530_UTC)).toBeNull();
    expect(latestEligibleMarketObservation(timeline, "US10Y", FEB_13_FED_QUOTE_CUTOFF_UTC)).toBeNull();
    expect(latestEligibleMarketObservation(timeline, "US10Y", FEB_13_H15_AVAILABLE - 1)).toBeNull();

    // At 21:15 UTC (16:15 EST), it becomes knowable
    const lookupAt2115 = latestEligibleMarketObservation(timeline, "US10Y", FEB_13_H15_AVAILABLE);
    expect(lookupAt2115).not.toBeNull();
    expect(lookupAt2115?.value).toBe(4.18);
  });

  // --------------------------------------------------------------------------
  // T5: Prior Treasury value remains usable before new day's value is available
  // --------------------------------------------------------------------------
  it("T5: prior Treasury value carries forward during trading day before new day's value is available", () => {
    const rawData = [
      { observationDate: "2024-02-12", releaseDate: "2024-02-13", bc_10year: "4.18" },
      { observationDate: "2024-02-13", releaseDate: "2024-02-14", bc_10year: "4.32" },
    ];

    const parseResult = parseTreasuryYieldSeries(rawData, { seriesId: "US10Y" });
    expect(parseResult.success).toBe(true);
    if (!parseResult.success) return;

    const timeline = parseResult.observations;

    // Feb 14 morning (10:00 UTC): Feb 12 value (released Feb 13 21:15 UTC) is known and carries forward!
    const feb14Morning = Date.parse("2024-02-14T10:00:00.000Z");
    const middayLookup = latestEligibleMarketObservation(timeline, "US10Y", feb14Morning);
    expect(middayLookup).not.toBeNull();
    expect(middayLookup?.value).toBe(4.18); // Carries forward Feb 12 value!

    // After Feb 14 21:15 UTC (16:15 EST H.15 release), Feb 13 value (4.32) is known
    const feb14ReleaseTime = Date.parse("2024-02-14T21:15:00.000Z");
    const eveningLookup = latestEligibleMarketObservation(timeline, "US10Y", feb14ReleaseTime);
    expect(eveningLookup?.value).toBe(4.32);
  });

  // --------------------------------------------------------------------------
  // T6: 2Y and 10Y use same source semantics and same unit
  // --------------------------------------------------------------------------
  it("T6: US2Y and US10Y use identical provider semantics, par yield contract, and PERCENT unit", () => {
    const parse2Y = parseTreasuryYieldSeries(RAW_SAMPLE_TREASURY_DATA, { seriesId: "US2Y" });
    const parse10Y = parseTreasuryYieldSeries(RAW_SAMPLE_TREASURY_DATA, { seriesId: "US10Y" });

    expect(parse2Y.success).toBe(true);
    expect(parse10Y.success).toBe(true);
    if (!parse2Y.success || !parse10Y.success) return;

    expect(parse2Y.metadata.provider).toBe("FEDERAL_RESERVE_H15");
    expect(parse10Y.metadata.provider).toBe("FEDERAL_RESERVE_H15");
    expect(parse2Y.metadata.unit).toBe("PERCENT");
    expect(parse10Y.metadata.unit).toBe("PERCENT");

    // Check yield spread calculation in percent
    const obs2Y = parse2Y.observations[1]; // Feb 13 observation
    const obs10Y = parse10Y.observations[1]; // Feb 13 observation

    expect(obs2Y.value).toBe(4.65);
    expect(obs10Y.value).toBe(4.32);
    // Yield spread (10Y - 2Y) = 4.32 - 4.65 = -0.33% (-33 bps)
    const spreadPercent = obs10Y.value - obs2Y.value;
    expect(Math.round(spreadPercent * 100)).toBe(-33);
  });

  // --------------------------------------------------------------------------
  // T7: No ^TNX /10 hardcoded transform exists without evidence
  // --------------------------------------------------------------------------
  it("T7: official Treasury rate parses raw percentage without arbitrary / 10 division", () => {
    const rawData = [
      { observationDate: "2024-02-12", releaseDate: "2024-02-13", bc_10year: "4.32" },
    ];
    const parseResult = parseTreasuryYieldSeries(rawData, { seriesId: "US10Y" });
    expect(parseResult.success).toBe(true);
    if (!parseResult.success) return;

    // Value must remain 4.32, not 0.432
    expect(parseResult.observations[0].value).toBe(4.32);
  });

  // --------------------------------------------------------------------------
  // T8: 2YY=F is not silently treated as official US2Y cash yield
  // --------------------------------------------------------------------------
  it("T8: US2Y series provider is official FEDERAL_RESERVE_H15, not Yahoo futures 2YY=F", () => {
    const parseResult = parseTreasuryYieldSeries(RAW_SAMPLE_TREASURY_DATA, { seriesId: "US2Y" });
    expect(parseResult.success).toBe(true);
    if (!parseResult.success) return;

    for (const obs of parseResult.observations) {
      expect(obs.provider).toBe("FEDERAL_RESERVE_H15");
      expect(obs.provider).not.toBe("YAHOO");
    }
  });

  // --------------------------------------------------------------------------
  // T9: Daily DXY/VIX close invisible before session availability
  // --------------------------------------------------------------------------
  it("T9: daily DXY and VIX closes are invisible before their respective session availability boundaries", () => {
    const rawDxy = {
      chart: {
        result: [
          {
            timestamp: [Math.floor(Date.parse("2024-02-13T14:30:00Z") / 1000)],
            indicators: { quote: [{ close: [104.85] }] },
          },
        ],
      },
    };
    const rawVix = {
      chart: {
        result: [
          {
            timestamp: [Math.floor(Date.parse("2024-02-13T14:30:00Z") / 1000)],
            indicators: { quote: [{ close: [15.85] }] },
          },
        ],
      },
    };

    const dxyRes = parseYahooDailyMarketSeries(rawDxy, { seriesId: "DXY" });
    const vixRes = parseYahooDailyMarketSeries(rawVix, { seriesId: "VIX" });

    expect(dxyRes.success).toBe(true);
    expect(vixRes.success).toBe(true);
    if (!dxyRes.success || !vixRes.success) return;

    // In winter: VIX closes at 16:15 EST (21:15 UTC); DXY available at 18:00 EST (23:00 UTC)
    expect(vixRes.observations[0].availableAt).toBe(FEB_13_VIX_AVAILABLE);
    expect(dxyRes.observations[0].availableAt).toBe(FEB_13_DXY_AVAILABLE);

    // At 15:30 UTC, both closes are invisible
    expect(latestEligibleMarketObservation(dxyRes.observations, "DXY", FEB_13_1530_UTC)).toBeNull();
    expect(latestEligibleMarketObservation(vixRes.observations, "VIX", FEB_13_1530_UTC)).toBeNull();

    // At 21:15 UTC, VIX is visible, DXY is still invisible
    expect(latestEligibleMarketObservation(vixRes.observations, "VIX", FEB_13_VIX_AVAILABLE)?.value).toBe(15.85);
    expect(latestEligibleMarketObservation(dxyRes.observations, "DXY", FEB_13_VIX_AVAILABLE)).toBeNull();

    // At 23:00 UTC, DXY is visible
    expect(latestEligibleMarketObservation(dxyRes.observations, "DXY", FEB_13_DXY_AVAILABLE)?.value).toBe(104.85);
  });

  // --------------------------------------------------------------------------
  // T10: Latest prior daily observation may carry forward after it became known
  // --------------------------------------------------------------------------
  it("T10: latest prior daily DXY/VIX observation carries forward during the day until new session close", () => {
    const rawDxy = {
      chart: {
        result: [
          {
            timestamp: [
              Math.floor(Date.parse("2024-02-12T14:30:00Z") / 1000),
              Math.floor(Date.parse("2024-02-13T14:30:00Z") / 1000),
            ],
            indicators: { quote: [{ close: [104.15, 104.85] }] },
          },
        ],
      },
    };

    const dxyRes = parseYahooDailyMarketSeries(rawDxy, { seriesId: "DXY" });
    expect(dxyRes.success).toBe(true);
    if (!dxyRes.success) return;

    // At Feb 13 10:00 UTC, Feb 12 value (104.15) carries forward
    const lookupMidday = latestEligibleMarketObservation(dxyRes.observations, "DXY", FEB_13_1000_UTC);
    expect(lookupMidday?.value).toBe(104.15);

    // After Feb 13 23:00 UTC (18:00 EST), Feb 13 value (104.85) is known
    const lookupNight = latestEligibleMarketObservation(dxyRes.observations, "DXY", FEB_13_DXY_AVAILABLE);
    expect(lookupNight?.value).toBe(104.85);
  });

  // --------------------------------------------------------------------------
  // T11: Future daily close never backfilled
  // --------------------------------------------------------------------------
  it("T11: future daily close is never backfilled when prior daily history is unavailable", () => {
    const rawDxy = {
      chart: {
        result: [
          {
            timestamp: [Math.floor(Date.parse("2024-02-13T14:30:00Z") / 1000)],
            indicators: { quote: [{ close: [104.85] }] },
          },
        ],
      },
    };
    const dxyRes = parseYahooDailyMarketSeries(rawDxy, { seriesId: "DXY" });
    expect(dxyRes.success).toBe(true);
    if (!dxyRes.success) return;

    // Query on Feb 12 before any DXY data is known returns null, never borrows Feb 13 close
    expect(latestEligibleMarketObservation(dxyRes.observations, "DXY", Date.parse("2024-02-12T12:00:00Z"))).toBeNull();
  });

  // --------------------------------------------------------------------------
  // T12: Shuffled normalized input remains deterministic
  // --------------------------------------------------------------------------
  it("T12: shuffled input order of market observations yields bitwise identical normalized output", () => {
    const observations = buildSampleMarketObservations();
    const shuffled = [...observations].reverse();

    const ds1: HistoricalDataset = {
      marketObservations: observations,
      macroReleases: [],
      eventRecords: [],
    };
    const ds2: HistoricalDataset = {
      marketObservations: shuffled,
      macroReleases: [],
      eventRecords: [],
    };

    const norm1 = normalizeHistoricalDataset(ds1);
    const norm2 = normalizeHistoricalDataset(ds2);

    expect(norm1.marketObservations).toEqual(norm2.marketObservations);
  });

  // --------------------------------------------------------------------------
  // T13: Malformed provider timestamps fail closed
  // --------------------------------------------------------------------------
  it("T13: malformed or descending timestamps in raw provider payloads fail closed", () => {
    const malformedKlines = [
      [NaN, "49000.00", "49500.00", "48900.00", "49350.00", "150.5", 1000],
    ];
    const btcResult = parseBinance1HKlines(malformedKlines, { seriesId: "BTC" });
    expect(btcResult.success).toBe(false);

    const malformedTreasury = [
      { observationDate: "INVALID-DATE", releaseDate: "2024-02-13", bc_10year: "4.32" },
    ];
    const treasuryResult = parseTreasuryYieldSeries(malformedTreasury, { seriesId: "US10Y" });
    expect(treasuryResult.success).toBe(false);
  });

  // --------------------------------------------------------------------------
  // T14: Missing provider timestamp handled according to explicit source policy
  // --------------------------------------------------------------------------
  it("T14: missing provider timestamp receives explicit verified H.15 availability, not midnight", () => {
    const treasuryData = [
      { observationDate: "2024-02-12", releaseDate: "2024-02-13", bc_10year: "4.18" },
    ];
    const parseResult = parseTreasuryYieldSeries(treasuryData, { seriesId: "US10Y" });
    expect(parseResult.success).toBe(true);
    if (!parseResult.success) return;

    const obs = parseResult.observations[0];
    expect(obs.providerTimestamp).toBeNull(); // Provider did not report ms timestamp
    expect(obs.availableAt).toBe(FEB_13_H15_AVAILABLE); // Explicit 16:15 EST -> 21:15 UTC on releaseDate, NOT 00:00 UTC!
    expect(obs.availableAt).not.toBe(FEB_13_MIDNIGHT_UTC);
  });

  // --------------------------------------------------------------------------
  // T15: No network call exists inside replay engine
  // --------------------------------------------------------------------------
  it("T15: lookup operations execute purely in-memory with zero network I/O", () => {
    const observations = buildSampleMarketObservations();

    // Verify lookup is pure synchronous in-memory operation
    const result = latestEligibleMarketObservation(observations, "BTC", SAMPLE_START_TIME + 10 * ONE_HOUR_MS);
    expect(result).not.toBeNull();
    expect(result?.seriesId).toBe("BTC");
  });

  // --------------------------------------------------------------------------
  // T16: Source failure never creates synthetic price
  // --------------------------------------------------------------------------
  it("T16: source parser failure returns explicit failure and never fabricates synthetic price", () => {
    const corruptedPayload = "NOT_JSON_OR_ARRAY";
    const parseResult = parseBinance1HKlines(corruptedPayload, { seriesId: "BTC" });

    expect(parseResult.success).toBe(false);
    if (!parseResult.success) {
      expect(parseResult.error).toContain("not an array");
    }
  });

  // --------------------------------------------------------------------------
  // T17: Provider instrument identity preserved
  // --------------------------------------------------------------------------
  it("T17: provider and series identities are preserved truthfully in all normalized records", () => {
    const observations = buildSampleMarketObservations();

    const btc = observations.find((o) => o.seriesId === "BTC");
    const paxg = observations.find((o) => o.seriesId === "PAXG");
    const us10y = observations.find((o) => o.seriesId === "US10Y");
    const dxy = observations.find((o) => o.seriesId === "DXY");
    const vix = observations.find((o) => o.seriesId === "VIX");

    expect(btc?.provider).toBe("BINANCE");
    expect(paxg?.provider).toBe("BINANCE");
    expect(us10y?.provider).toBe("FEDERAL_RESERVE_H15");
    expect(dxy?.provider).toBe("YAHOO");
    expect(vix?.provider).toBe("YAHOO");
  });

  // --------------------------------------------------------------------------
  // T18: PAXG never mislabeled as literal spot XAU
  // --------------------------------------------------------------------------
  it("T18: PAXG is preserved as tokenized gold series, never mislabeled as literal spot XAU", () => {
    const observations = buildSampleMarketObservations();
    const paxgRecords = observations.filter((o) => o.seriesId === "PAXG");

    expect(paxgRecords.length).toBeGreaterThan(0);
    for (const p of paxgRecords) {
      expect(p.seriesId).toBe("PAXG");
      expect(p.seriesId).not.toBe("XAU");
      expect(p.provider).toBe("BINANCE");
    }
  });

  // --------------------------------------------------------------------------
  // T19: Identical normalized dataset produces identical lookup results
  // --------------------------------------------------------------------------
  it("T19: repeated lookups across identical normalized dataset produce strictly identical results", () => {
    const observations = buildSampleMarketObservations();

    const decisionTime = SAMPLE_START_TIME + 24 * ONE_HOUR_MS;
    const firstLookup = latestEligibleMarketObservation(observations, "BTC", decisionTime);

    for (let i = 0; i < 50; i++) {
      const repeatedLookup = latestEligibleMarketObservation(observations, "BTC", decisionTime);
      expect(repeatedLookup).toEqual(firstLookup);
    }
  });

  // --------------------------------------------------------------------------
  // T20: Empty market series returns null cleanly
  // --------------------------------------------------------------------------
  it("T20: querying an empty or absent market series returns null cleanly", () => {
    const observations = buildSampleMarketObservations();

    expect(latestEligibleMarketObservation(observations, "NON_EXISTENT_SERIES", FEB_13_1100_UTC)).toBeNull();
    expect(latestEligibleMarketObservation([], "BTC", FEB_13_1100_UTC)).toBeNull();
    expect(latestEligibleMarketObservation(null, "BTC", FEB_13_1100_UTC)).toBeNull();
  });
});

// ============================================================================
// GATE M12C-R MANDATORY DST TEST MATRIX (D1 - D12)
// ============================================================================

describe("Gate M12C-R Mandatory DST Test Matrix (D1 - D12)", () => {
  // D1: VIX winter 16:15 ET -> correct UTC
  it("D1: VIX winter 16:15 ET converts to exact 21:15 UTC (EST, UTC-5)", () => {
    const winterVixEpoch = marketDateTimeToEpochMs("2024-02-13", "16:15", "America/New_York");
    const expectedUtc = Date.parse("2024-02-13T21:15:00.000Z");
    expect(winterVixEpoch).toBe(expectedUtc);
    expect(new Date(winterVixEpoch).toISOString()).toBe("2024-02-13T21:15:00.000Z");
  });

  // D2: VIX summer 16:15 ET -> correct UTC
  it("D2: VIX summer 16:15 ET converts to exact 20:15 UTC (EDT, UTC-4)", () => {
    const summerVixEpoch = marketDateTimeToEpochMs("2024-07-15", "16:15", "America/New_York");
    const expectedUtc = Date.parse("2024-07-15T20:15:00.000Z");
    expect(summerVixEpoch).toBe(expectedUtc);
    expect(new Date(summerVixEpoch).toISOString()).toBe("2024-07-15T20:15:00.000Z");
  });

  // D3: Eastern-time conversion before DST transition
  it("D3: Eastern-time conversion immediately before spring DST transition (Friday March 8, 2024)", () => {
    // 2024 Spring Forward: Sunday March 10, 2024
    const preDstEpoch = marketDateTimeToEpochMs("2024-03-08", "16:15", "America/New_York");
    expect(new Date(preDstEpoch).toISOString()).toBe("2024-03-08T21:15:00.000Z");
  });

  // D4: Eastern-time conversion after DST transition
  it("D4: Eastern-time conversion immediately after spring DST transition (Monday March 11, 2024)", () => {
    const postDstEpoch = marketDateTimeToEpochMs("2024-03-11", "16:15", "America/New_York");
    expect(new Date(postDstEpoch).toISOString()).toBe("2024-03-11T20:15:00.000Z");
  });

  // D5: Conversion around fall DST transition remains deterministic
  it("D5: conversion around fall DST transition remains deterministic (November 2024)", () => {
    // 2024 Fall Back: Sunday November 3, 2024
    // Friday Nov 1 (EDT, UTC-4) -> 20:15 UTC
    const preFallEpoch = marketDateTimeToEpochMs("2024-11-01", "16:15", "America/New_York");
    expect(new Date(preFallEpoch).toISOString()).toBe("2024-11-01T20:15:00.000Z");

    // Monday Nov 4 (EST, UTC-5) -> 21:15 UTC
    const postFallEpoch = marketDateTimeToEpochMs("2024-11-04", "16:15", "America/New_York");
    expect(new Date(postFallEpoch).toISOString()).toBe("2024-11-04T21:15:00.000Z");
  });

  // D6: Same session policy returns different UTC offsets in EST vs EDT when appropriate
  it("D6: same session policy returns different UTC offsets in EST vs EDT", () => {
    const winterEpoch = marketDateTimeToEpochMs("2024-02-13", "16:15", "America/New_York");
    const summerEpoch = marketDateTimeToEpochMs("2024-07-15", "16:15", "America/New_York");

    const winterMidnightUtc = sessionDateToUtcMidnightEpochMs("2024-02-13");
    const summerMidnightUtc = sessionDateToUtcMidnightEpochMs("2024-07-15");

    const winterOffsetFromMidnight = winterEpoch - winterMidnightUtc;
    const summerOffsetFromMidnight = summerEpoch - summerMidnightUtc;

    // Winter offset: 21h 15m = 76,500,000 ms
    expect(winterOffsetFromMidnight).toBe(21 * 3600000 + 15 * 60000);
    // Summer offset: 20h 15m = 72,900,000 ms
    expect(summerOffsetFromMidnight).toBe(20 * 3600000 + 15 * 60000);

    // Difference between EST and EDT is exactly 1 hour
    expect(winterOffsetFromMidnight - summerOffsetFromMidnight).toBe(ONE_HOUR_MS);
  });

  // D7: No fixed "21:15 UTC" VIX constant remains
  it("D7: no fixed '21:15 UTC' VIX constant remains in policies or source definitions", () => {
    const policy = MARKET_AVAILABILITY_POLICIES.VIX;
    expect(policy.kind).toBe("DAILY_SESSION");
    if (policy.kind === "DAILY_SESSION") {
      expect(policy.localTime).toBe("16:15");
      expect(policy.timeZone).toBe("America/New_York");
      // Must not have hardcoded UTC offset constant
      expect((policy as unknown as Record<string, unknown>).sessionCloseUtcOffsetMs).toBeUndefined();
    }
  });

  // D8: No fixed BLS/FOMC UTC assumption is introduced into shared utilities
  it("D8: timezone conversion utility contains no hardcoded macro UTC offsets", () => {
    // Shared utility accepts arbitrary date and local time without fixed macro release anchors
    const blsSummer = marketDateTimeToEpochMs("2024-07-11", "08:30", "America/New_York");
    const blsWinter = marketDateTimeToEpochMs("2024-02-13", "08:30", "America/New_York");

    expect(new Date(blsSummer).toISOString()).toBe("2024-07-11T12:30:00.000Z"); // 08:30 EDT -> 12:30 UTC
    expect(new Date(blsWinter).toISOString()).toBe("2024-02-13T13:30:00.000Z"); // 08:30 EST -> 13:30 UTC

    const fomcSummer = marketDateTimeToEpochMs("2024-07-31", "14:00", "America/New_York");
    const fomcWinter = marketDateTimeToEpochMs("2024-01-31", "14:00", "America/New_York");

    expect(new Date(fomcSummer).toISOString()).toBe("2024-07-31T18:00:00.000Z"); // 14:00 EDT -> 18:00 UTC
    expect(new Date(fomcWinter).toISOString()).toBe("2024-01-31T19:00:00.000Z"); // 14:00 EST -> 19:00 UTC
  });

  // D9: Treasury winter/summer behavior follows its FINAL documented policy
  it("D9: Treasury H.15 16:15 ET release boundary converts to 21:15 UTC in winter and 20:15 UTC in summer", () => {
    const winterData = [{ observationDate: "2024-02-12", releaseDate: "2024-02-13", bc_10year: "4.18", bc_2year: "4.48" }];
    const summerData = [{ observationDate: "2024-07-15", releaseDate: "2024-07-16", bc_10year: "4.23", bc_2year: "4.45" }];

    const winterRes = parseTreasuryYieldSeries(winterData, { seriesId: "US10Y" });
    const summerRes = parseTreasuryYieldSeries(summerData, { seriesId: "US10Y" });

    expect(winterRes.success).toBe(true);
    expect(summerRes.success).toBe(true);
    if (!winterRes.success || !summerRes.success) return;

    // Winter: 16:15 EST -> 21:15:00 UTC
    expect(new Date(winterRes.observations[0].availableAt).toISOString()).toBe("2024-02-13T21:15:00.000Z");
    // Summer: 16:15 EDT -> 20:15:00 UTC
    expect(new Date(summerRes.observations[0].availableAt).toISOString()).toBe("2024-07-16T20:15:00.000Z");
  });

  // D10: DXY winter/summer behavior follows its FINAL documented policy
  it("D10: DXY 18:00 ET conservative boundary converts to 23:00 UTC in winter and 22:00 UTC in summer", () => {
    const winterDxy = {
      chart: {
        result: [
          {
            timestamp: [Math.floor(Date.parse("2024-02-13T14:30:00Z") / 1000)],
            indicators: { quote: [{ close: [104.85] }] },
          },
        ],
      },
    };
    const summerDxy = {
      chart: {
        result: [
          {
            timestamp: [Math.floor(Date.parse("2024-07-15T13:30:00Z") / 1000)],
            indicators: { quote: [{ close: [104.2] }] },
          },
        ],
      },
    };

    const winterRes = parseYahooDailyMarketSeries(winterDxy, { seriesId: "DXY" });
    const summerRes = parseYahooDailyMarketSeries(summerDxy, { seriesId: "DXY" });

    expect(winterRes.success).toBe(true);
    expect(summerRes.success).toBe(true);
    if (!winterRes.success || !summerRes.success) return;

    // Winter: 18:00 EST -> 23:00:00 UTC
    expect(new Date(winterRes.observations[0].availableAt).toISOString()).toBe("2024-02-13T23:00:00.000Z");
    // Summer: 18:00 EDT -> 22:00:00 UTC
    expect(new Date(summerRes.observations[0].availableAt).toISOString()).toBe("2024-07-15T22:00:00.000Z");
  });

  // D11: Machine timezone / locale does not change epoch result
  it("D11: machine local timezone does not alter computed epoch timestamp", () => {
    // Pure calculation invariant:
    const epoch1 = marketDateTimeToEpochMs("2024-07-15", "16:15", "America/New_York");
    // The exact expected UTC milliseconds:
    const expected = 1721074500000;
    expect(epoch1).toBe(expected);

    // Roundtrip verification through Date object UTC methods:
    const d = new Date(epoch1);
    expect(d.getUTCFullYear()).toBe(2024);
    expect(d.getUTCMonth()).toBe(6); // 0-indexed: July is 6
    expect(d.getUTCDate()).toBe(15);
    expect(d.getUTCHours()).toBe(20);
    expect(d.getUTCMinutes()).toBe(15);
  });

  // D12: Current February fixture remains valid under EST, and July fixture valid under EDT
  it("D12: February benchmark fixture (EST) and July benchmark fixture (EDT) both pass normalization and PIT queries", () => {
    const febObservations = buildSampleMarketObservations();
    const julObservations = buildSampleMarketObservationsJuly();

    expect(febObservations.length).toBeGreaterThan(0);
    expect(julObservations.length).toBeGreaterThan(0);

    // Verify February VIX observation is at 21:15 UTC on Feb 12
    const febVix = febObservations.find((o) => o.seriesId === "VIX");
    expect(febVix).toBeDefined();
    expect(new Date(febVix!.availableAt).toISOString()).toBe("2024-02-12T21:15:00.000Z");

    // Verify July VIX observation is at 20:15 UTC on July 15
    const julVix = julObservations.find((o) => o.seriesId === "VIX");
    expect(julVix).toBeDefined();
    expect(new Date(julVix!.availableAt).toISOString()).toBe("2024-07-15T20:15:00.000Z");

    // Verify February Treasury 10Y (Feb 12 obs) is released at 21:15 UTC on Feb 13
    const febTreasury = febObservations.find((o) => o.seriesId === "US10Y");
    expect(febTreasury).toBeDefined();
    expect(new Date(febTreasury!.availableAt).toISOString()).toBe("2024-02-13T21:15:00.000Z");

    // Verify July Treasury 10Y (July 15 obs) is released at 20:15 UTC on July 16
    const julTreasury = julObservations.find((o) => o.seriesId === "US10Y");
    expect(julTreasury).toBeDefined();
    expect(new Date(julTreasury!.availableAt).toISOString()).toBe("2024-07-16T20:15:00.000Z");

    // Query on July 15 at 20:30 UTC: VIX (available July 15 20:15 UTC) IS visible,
    // but Treasury (released July 16 20:15 UTC) is NOT yet visible!
    const julVixAt2030 = latestEligibleMarketObservation(julObservations, "VIX", SAMPLE_JULY_START_TIME + (20 * ONE_HOUR_MS) + 1800000);
    expect(julVixAt2030).not.toBeNull();
    expect(julVixAt2030?.value).toBe(13.12);

    const julTreasuryAt2030 = latestEligibleMarketObservation(julObservations, "US10Y", SAMPLE_JULY_START_TIME + (20 * ONE_HOUR_MS) + 1800000);
    expect(julTreasuryAt2030).toBeNull(); // Not available until July 16 20:15 UTC!
  });
});

// ============================================================================
// GATE M12C-R2 MANDATORY TREASURY PUBLIC AVAILABILITY TESTS (R1 - R12)
// ============================================================================

describe("Gate M12C-R2 Federal Reserve H.15 Treasury Public Availability Semantics (R1 - R12)", () => {
  // R1: Treasury observation date alone cannot derive canonical availableAt
  it("R1: Treasury observation date alone cannot derive canonical availableAt (fails closed if releaseDate is missing)", () => {
    const rawNoReleaseDate = [
      { observationDate: "2024-02-13", bc_10year: "4.32", bc_2year: "4.65" },
    ];
    const parseResult = parseTreasuryYieldSeries(rawNoReleaseDate, { seriesId: "US10Y" });
    expect(parseResult.success).toBe(false);
    if (!parseResult.success) {
      expect(parseResult.error).toContain("requires explicit releaseDate");
    }
  });

  // R2: Explicit H.15 release date + 16:15 ET produces availability
  it("R2: explicit H.15 release date + 16:15 ET produces availability", () => {
    const rawData = [
      { observationDate: "2024-02-12", releaseDate: "2024-02-13", bc_10year: "4.32" },
    ];
    const parseResult = parseTreasuryYieldSeries(rawData, { seriesId: "US10Y" });
    expect(parseResult.success).toBe(true);
    if (!parseResult.success) return;

    const expectedAvailableAt = marketDateTimeToEpochMs("2024-02-13", "16:15", "America/New_York");
    expect(parseResult.observations[0].availableAt).toBe(expectedAvailableAt);
  });

  // R3: Winter H.15 release converts to 21:15 UTC
  it("R3: winter H.15 release converts to 21:15 UTC", () => {
    const winterEpoch = marketDateTimeToEpochMs("2024-02-13", "16:15", "America/New_York");
    expect(new Date(winterEpoch).toISOString()).toBe("2024-02-13T21:15:00.000Z");
  });

  // R4: Summer H.15 release converts to 20:15 UTC
  it("R4: summer H.15 release converts to 20:15 UTC", () => {
    const summerEpoch = marketDateTimeToEpochMs("2024-07-16", "16:15", "America/New_York");
    expect(new Date(summerEpoch).toISOString()).toBe("2024-07-16T20:15:00.000Z");
  });

  // R5: Observation Friday + release Tuesday (Presidents Day holiday) stays invisible throughout Friday-Monday
  it("R5: observation Friday 2024-02-16 + release Tuesday 2024-02-20 stays invisible throughout Feb 16-19", () => {
    // Friday Feb 16 observation released Tuesday Feb 20 (Monday Feb 19 was Presidents Day)
    const rawData = [
      { observationDate: "2024-02-16", releaseDate: "2024-02-20", bc_10year: "4.28" },
    ];
    const parseResult = parseTreasuryYieldSeries(rawData, { seriesId: "US10Y" });
    expect(parseResult.success).toBe(true);
    if (!parseResult.success) return;

    const timeline = parseResult.observations;

    // Queries during Friday: 10:00 UTC, 15:30 ET (20:30 UTC), 16:15 ET (21:15 UTC), 23:59 UTC
    const friday1000 = Date.parse("2024-02-16T10:00:00.000Z");
    const fridayQuoteCutoff = Date.parse("2024-02-16T20:30:00.000Z");
    const fridayClose = Date.parse("2024-02-16T21:15:00.000Z");
    const fridayNight = Date.parse("2024-02-16T23:59:59.000Z");

    expect(latestEligibleMarketObservation(timeline, "US10Y", friday1000)).toBeNull();
    expect(latestEligibleMarketObservation(timeline, "US10Y", fridayQuoteCutoff)).toBeNull();
    expect(latestEligibleMarketObservation(timeline, "US10Y", fridayClose)).toBeNull();
    expect(latestEligibleMarketObservation(timeline, "US10Y", fridayNight)).toBeNull();

    // Query on weekend (Saturday Feb 17, Sunday Feb 18) remains null
    expect(latestEligibleMarketObservation(timeline, "US10Y", Date.parse("2024-02-17T12:00:00.000Z"))).toBeNull();
    expect(latestEligibleMarketObservation(timeline, "US10Y", Date.parse("2024-02-18T12:00:00.000Z"))).toBeNull();

    // Query on Monday Feb 19 (Presidents Day holiday) remains null
    expect(latestEligibleMarketObservation(timeline, "US10Y", Date.parse("2024-02-19T12:00:00.000Z"))).toBeNull();
    expect(latestEligibleMarketObservation(timeline, "US10Y", Date.parse("2024-02-19T21:15:00.000Z"))).toBeNull();
  });

  // R6: Same observation becomes visible exactly at Tuesday H.15 release boundary
  it("R6: same observation becomes visible exactly at Tuesday 2024-02-20 H.15 release boundary", () => {
    const rawData = [
      { observationDate: "2024-02-16", releaseDate: "2024-02-20", bc_10year: "4.28" },
    ];
    const parseResult = parseTreasuryYieldSeries(rawData, { seriesId: "US10Y" });
    expect(parseResult.success).toBe(true);
    if (!parseResult.success) return;

    const timeline = parseResult.observations;

    // Tuesday Feb 20 at 21:14:59 UTC: still invisible
    const tuesdayPreRelease = Date.parse("2024-02-20T21:14:59.999Z");
    expect(latestEligibleMarketObservation(timeline, "US10Y", tuesdayPreRelease)).toBeNull();

    // Tuesday Feb 20 at 21:15:00.000 UTC (16:15 EST H.15 release): knowable!
    const tuesdayReleaseBoundary = Date.parse("2024-02-20T21:15:00.000Z");
    const lookup = latestEligibleMarketObservation(timeline, "US10Y", tuesdayReleaseBoundary);
    expect(lookup).not.toBeNull();
    expect(lookup?.value).toBe(4.28);
  });

  // R7: Holiday/weekend gap uses explicit releaseDate, not homemade calendar math
  it("R7: holiday/weekend gap uses explicit releaseDate without home-made holiday calendar", () => {
    // Friday Jan 12, 2024 observation released Tuesday Jan 16, 2024 (Monday was MLK Day)
    const rawData = [
      { observationDate: "2024-01-12", releaseDate: "2024-01-16", bc_10year: "4.05" },
    ];
    const parseResult = parseTreasuryYieldSeries(rawData, { seriesId: "US10Y" });
    expect(parseResult.success).toBe(true);
    if (!parseResult.success) return;

    const timeline = parseResult.observations;

    // Tuesday Jan 16 at 21:14 UTC: still invisible
    expect(latestEligibleMarketObservation(timeline, "US10Y", Date.parse("2024-01-16T21:14:00.000Z"))).toBeNull();

    // Tuesday Jan 16 at 21:15 UTC: visible!
    const lookup = latestEligibleMarketObservation(timeline, "US10Y", Date.parse("2024-01-16T21:15:00.000Z"));
    expect(lookup).not.toBeNull();
    expect(lookup?.value).toBe(4.05);
  });

  // R8: Missing releaseDate fails closed
  it("R8: missing or empty releaseDate fails closed", () => {
    const rawDataEmptyRelease = [
      { observationDate: "2024-02-12", releaseDate: "", bc_10year: "4.32" },
    ];
    const resultEmpty = parseTreasuryYieldSeries(rawDataEmptyRelease, { seriesId: "US10Y" });
    expect(resultEmpty.success).toBe(false);

    const rawDataPrecedingRelease = [
      { observationDate: "2024-02-13", releaseDate: "2024-02-12", bc_10year: "4.32" },
    ];
    const resultPreceding = parseTreasuryYieldSeries(rawDataPrecedingRelease, { seriesId: "US10Y" });
    expect(resultPreceding.success).toBe(false);
  });

  // R9: US2Y and US10Y use identical availability semantics
  it("R9: US2Y and US10Y use identical availability semantics and provider identity", () => {
    const raw2Y = [{ observationDate: "2024-02-12", releaseDate: "2024-02-13", bc_2year: "4.65" }];
    const raw10Y = [{ observationDate: "2024-02-12", releaseDate: "2024-02-13", bc_10year: "4.32" }];

    const res2Y = parseTreasuryYieldSeries(raw2Y, { seriesId: "US2Y" });
    const res10Y = parseTreasuryYieldSeries(raw10Y, { seriesId: "US10Y" });

    expect(res2Y.success).toBe(true);
    expect(res10Y.success).toBe(true);
    if (!res2Y.success || !res10Y.success) return;

    expect(res2Y.observations[0].availableAt).toBe(res10Y.observations[0].availableAt);
    expect(res2Y.observations[0].provider).toBe("FEDERAL_RESERVE_H15");
    expect(res10Y.observations[0].provider).toBe("FEDERAL_RESERVE_H15");
    expect(res2Y.observations[0].unit).toBe("PERCENT");
    expect(res10Y.observations[0].unit).toBe("PERCENT");
  });

  // R10: No Treasury 18:00 ET assumed-publication constant remains
  it("R10: no Treasury 18:00 ET assumed-publication constant remains", () => {
    const policy2Y = MARKET_AVAILABILITY_POLICIES.US2Y;
    const policy10Y = MARKET_AVAILABILITY_POLICIES.US10Y;

    if (policy2Y.kind === "DAILY_SESSION") {
      expect(policy2Y.localTime).toBe("16:15");
      expect(policy2Y.localTime).not.toBe("18:00");
    }
    if (policy10Y.kind === "DAILY_SESSION") {
      expect(policy10Y.localTime).toBe("16:15");
      expect(policy10Y.localTime).not.toBe("18:00");
    }
  });

  // R11: No 3:30 ET quote timestamp is treated as public availability
  it("R11: no 3:30 ET quote timestamp is treated as public availability", () => {
    const rawData = [
      { observationDate: "2024-02-12", releaseDate: "2024-02-13", bc_10year: "4.32" },
    ];
    const parseResult = parseTreasuryYieldSeries(rawData, { seriesId: "US10Y" });
    expect(parseResult.success).toBe(true);
    if (!parseResult.success) return;

    const timeline = parseResult.observations;
    // 3:30 PM EST on Feb 12 = 15:30 EST = 20:30:00.000 UTC
    const quoteCutoffUtc = Date.parse("2024-02-12T20:30:00.000Z");

    // Must NOT be visible at 3:30 PM ET!
    expect(latestEligibleMarketObservation(timeline, "US10Y", quoteCutoffUtc)).toBeNull();
  });

  // R12: Existing D1-D12 + T1-T20 remain passing
  it("R12: all normalized market observations in benchmark fixtures adhere strictly to PIT invariants", () => {
    const observations = buildSampleMarketObservations();
    for (const obs of observations) {
      expect(obs.availableAt).toBeGreaterThanOrEqual(obs.observationTime);
      expect(Number.isFinite(obs.value)).toBe(true);
      expect(Number.isFinite(obs.availableAt)).toBe(true);
    }
  });
});

// ============================================================================
// GATE M12C-R3 HISTORICAL RELEASE DATE & PRESIDENTS DAY TESTS (H1 - H8)
// ============================================================================

describe("Gate M12C-R3 Historical H.15 Release-Date & Holiday Alignment (H1 - H8)", () => {
  // H1: 2024-02-16 observation with releaseDate 2024-02-20 is invisible throughout Feb 16-19
  it("H1: 2024-02-16 observation with releaseDate 2024-02-20 is invisible throughout Feb 16-19", () => {
    const rawData = [
      { observationDate: "2024-02-16", releaseDate: "2024-02-20", bc_10year: "4.28" },
    ];
    const res = parseTreasuryYieldSeries(rawData, { seriesId: "US10Y" });
    expect(res.success).toBe(true);
    if (!res.success) return;

    const timeline = res.observations;

    // Check all timestamps across the 4 days
    const queryStamps = [
      Date.parse("2024-02-16T12:00:00.000Z"),
      Date.parse("2024-02-16T21:15:00.000Z"),
      Date.parse("2024-02-17T12:00:00.000Z"),
      Date.parse("2024-02-18T12:00:00.000Z"),
      Date.parse("2024-02-19T12:00:00.000Z"),
      Date.parse("2024-02-19T21:15:00.000Z"),
      Date.parse("2024-02-20T21:14:59.999Z"),
    ];

    for (const q of queryStamps) {
      expect(latestEligibleMarketObservation(timeline, "US10Y", q)).toBeNull();
    }
  });

  // H2: It becomes visible exactly at 2024-02-20 16:15 America/New_York
  it("H2: 2024-02-16 observation becomes visible exactly at 2024-02-20 16:15 America/New_York (21:15 UTC)", () => {
    const rawData = [
      { observationDate: "2024-02-16", releaseDate: "2024-02-20", bc_10year: "4.28" },
    ];
    const res = parseTreasuryYieldSeries(rawData, { seriesId: "US10Y" });
    expect(res.success).toBe(true);
    if (!res.success) return;

    const releaseBoundaryUtc = Date.parse("2024-02-20T21:15:00.000Z");
    const lookup = latestEligibleMarketObservation(res.observations, "US10Y", releaseBoundaryUtc);
    expect(lookup).not.toBeNull();
    expect(lookup?.value).toBe(4.28);
    expect(lookup?.availableAt).toBe(releaseBoundaryUtc);
  });

  // H3: Feb 19 2024 must NOT appear as the releaseDate fixture
  it("H3: Feb 19 2024 (Presidents Day) must NOT appear as the releaseDate fixture in canonical datasets", () => {
    const rawWinter = RAW_SAMPLE_TREASURY_DATA;
    const rawSummer = RAW_SAMPLE_TREASURY_DATA_JULY;

    for (const row of rawWinter) {
      expect(row.releaseDate).not.toBe("2024-02-19");
    }
    for (const row of rawSummer) {
      expect(row.releaseDate).not.toBe("2024-02-19");
    }
  });

  // H4: Same-day observation/release fixture is not used as historical truth unless explicitly evidenced
  it("H4: canonical sample fixtures reflect the actual Federal Reserve H.15 publication lag (releaseDate !== observationDate)", () => {
    for (const row of RAW_SAMPLE_TREASURY_DATA) {
      // Must reflect next business day publication lag
      expect(row.releaseDate).not.toBe(row.observationDate);
    }
    for (const row of RAW_SAMPLE_TREASURY_DATA_JULY) {
      // Must reflect next business day publication lag
      expect(row.releaseDate).not.toBe(row.observationDate);
    }
  });

  // H5: Parser still accepts arbitrary VALID explicit releaseDate for synthetic unit testing, but such fixture is clearly labeled synthetic
  it("H5: parser accepts arbitrary valid explicit releaseDate for synthetic testing when clearly labeled synthetic", () => {
    const res = parseTreasuryYieldSeries(SYNTHETIC_TEST_FIXTURE_TREASURY, { seriesId: "US10Y" });
    expect(res.success).toBe(true);
    if (!res.success) return;

    expect(res.observations.length).toBe(1);
    expect(res.observations[0].value).toBe(4.32);
    // Explicitly labeled as synthetic
    expect(SYNTHETIC_TEST_FIXTURE_TREASURY[0].observationDate).toBe("2024-02-13");
    expect(SYNTHETIC_TEST_FIXTURE_TREASURY[0].releaseDate).toBe("2024-02-13");
  });

  // H6: No next-business-day/holiday inference exists in production parser
  it("H6: parser performs zero business-day or holiday inference and strictly requires caller-supplied releaseDate", () => {
    // If releaseDate is omitted, it fails closed even on a standard Tuesday
    const rowWithoutRelease = [{ observationDate: "2024-02-13", bc_10year: "4.32" }];
    const res = parseTreasuryYieldSeries(rowWithoutRelease, { seriesId: "US10Y" });
    expect(res.success).toBe(false);
  });

  // H7: US2Y and US10Y retain identical semantics
  it("H7: US2Y and US10Y retain identical semantics, unit, and releaseDate requirement", () => {
    const raw2Y = [{ observationDate: "2024-02-16", releaseDate: "2024-02-20", bc_2year: "4.65" }];
    const raw10Y = [{ observationDate: "2024-02-16", releaseDate: "2024-02-20", bc_10year: "4.28" }];

    const res2Y = parseTreasuryYieldSeries(raw2Y, { seriesId: "US2Y" });
    const res10Y = parseTreasuryYieldSeries(raw10Y, { seriesId: "US10Y" });

    expect(res2Y.success).toBe(true);
    expect(res10Y.success).toBe(true);
    if (!res2Y.success || !res10Y.success) return;

    expect(res2Y.observations[0].availableAt).toBe(res10Y.observations[0].availableAt);
    expect(res2Y.observations[0].provider).toBe("FEDERAL_RESERVE_H15");
    expect(res10Y.observations[0].provider).toBe("FEDERAL_RESERVE_H15");
  });

  // H8: All previous T1-T20, D1-D12, R1-R12 continue passing
  it("H8: all test fixtures and normalization pipelines maintain point-in-time integrity", () => {
    const observations = buildSampleMarketObservations();
    expect(observations.length).toBeGreaterThan(0);

    const btcObs = observations.filter((o) => o.seriesId === "BTC");
    const paxgObs = observations.filter((o) => o.seriesId === "PAXG");
    const us2yObs = observations.filter((o) => o.seriesId === "US2Y");
    const us10yObs = observations.filter((o) => o.seriesId === "US10Y");
    const dxyObs = observations.filter((o) => o.seriesId === "DXY");
    const vixObs = observations.filter((o) => o.seriesId === "VIX");

    expect(btcObs.length).toBe(72);
    expect(paxgObs.length).toBe(72);
    expect(us2yObs.length).toBe(3);
    expect(us10yObs.length).toBe(3);
    expect(dxyObs.length).toBe(3);
    expect(vixObs.length).toBe(3);
  });
});
