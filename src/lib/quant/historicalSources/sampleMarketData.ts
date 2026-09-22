// ============================================================================
// FILE: src/lib/quant/historicalSources/sampleMarketData.ts
// MODULE: COMPACT DETERMINISTIC SAMPLE MARKET FIXTURES (GATE M12C-R)
// PRINCIPLE: Small Representative Offline Fixtures for Anti-Lookahead Validation
// ============================================================================

import {
  type HistoricalMarketObservation,
  type HistoricalDataset,
  normalizeHistoricalDataset,
} from "../historicalPit";
import { parseBinance1HKlines, ONE_HOUR_MS } from "./binanceKlines";
import { parseTreasuryYieldSeries } from "./treasuryYields";
import { parseYahooDailyMarketSeries } from "./yahooMarketSeries";

/**
 * Benchmark 3-day winter period for deterministic test validation:
 * 2024-02-12 00:00:00 UTC to 2024-02-14 23:00:00 UTC (72 hours, US EST period).
 */
export const SAMPLE_START_TIME = 1707696000000; // 2024-02-12 00:00:00 UTC

/**
 * Benchmark 3-day summer period for DST validation:
 * 2024-07-15 00:00:00 UTC to 2024-07-17 23:00:00 UTC (72 hours, US EDT period).
 */
export const SAMPLE_JULY_START_TIME = 1721001600000; // 2024-07-15 00:00:00 UTC

/**
 * Raw Binance 1H klines fixture generator for deterministic testing.
 */
export function generateSampleBinanceKlines(
  basePrice: number,
  barsCount = 72,
  startEpochMs = SAMPLE_START_TIME
): Array<[number, string, string, string, string, string, number]> {
  const klines: Array<[number, string, string, string, string, string, number]> = [];
  let price = basePrice;

  for (let i = 0; i < barsCount; i++) {
    const openTime = startEpochMs + i * ONE_HOUR_MS;
    const closeTime = openTime + ONE_HOUR_MS - 1;
    // Deterministic sine wave drift for testing
    const drift = Math.sin(i / 6) * (basePrice * 0.005);
    const close = Math.round((price + drift) * 100) / 100;
    const open = price;
    const high = Math.max(open, close) + 20;
    const low = Math.min(open, close) - 20;
    price = close;

    klines.push([
      openTime,
      open.toFixed(2),
      high.toFixed(2),
      low.toFixed(2),
      close.toFixed(2),
      "125.45", // volume
      closeTime,
    ]);
  }

  return klines;
}

/**
 * Real Historical Federal Reserve H.15 Daily CMT Yields fixture (Winter / EST).
 * Official Fed publication lag: observations on trading day T are published
 * on next business day T+1 at 16:15 ET.
 */
export const RAW_SAMPLE_TREASURY_DATA = [
  { observationDate: "2024-02-12", releaseDate: "2024-02-13", bc_2year: "4.48", bc_10year: "4.18" },
  { observationDate: "2024-02-13", releaseDate: "2024-02-14", bc_2year: "4.65", bc_10year: "4.32" },
  { observationDate: "2024-02-14", releaseDate: "2024-02-15", bc_2year: "4.58", bc_10year: "4.26" },
];

/**
 * Real Historical Federal Reserve H.15 Daily CMT Yields fixture (Summer / EDT).
 * Official Fed publication lag: observations on trading day T are published
 * on next business day T+1 at 16:15 ET.
 */
export const RAW_SAMPLE_TREASURY_DATA_JULY = [
  { observationDate: "2024-07-15", releaseDate: "2024-07-16", bc_2year: "4.45", bc_10year: "4.23" },
  { observationDate: "2024-07-16", releaseDate: "2024-07-17", bc_2year: "4.42", bc_10year: "4.17" },
  { observationDate: "2024-07-17", releaseDate: "2024-07-18", bc_2year: "4.44", bc_10year: "4.16" },
];

/**
 * Clearly labeled synthetic test fixture for unit testing parser acceptance of arbitrary valid releaseDate.
 * NOT presented as historical truth.
 */
export const SYNTHETIC_TEST_FIXTURE_TREASURY = [
  { observationDate: "2024-02-13", releaseDate: "2024-02-13", bc_2year: "4.65", bc_10year: "4.32" },
];

/**
 * Raw Yahoo Daily Chart fixture for DXY and VIX (Winter / EST session start at 14:30 UTC).
 */
export function generateSampleYahooChartData(
  symbol: "DX-Y.NYB" | "^VIX",
  closes: [number, number, number]
) {
  // Session start timestamps at 14:30 UTC (09:30 EST) for Feb 12, 13, 14
  const timestampsSec = [
    Math.floor(Date.parse("2024-02-12T14:30:00Z") / 1000),
    Math.floor(Date.parse("2024-02-13T14:30:00Z") / 1000),
    Math.floor(Date.parse("2024-02-14T14:30:00Z") / 1000),
  ];

  return {
    chart: {
      result: [
        {
          timestamp: timestampsSec,
          indicators: {
            quote: [
              {
                close: closes,
              },
            ],
          },
          meta: {
            symbol,
          },
        },
      ],
    },
  };
}

/**
 * Raw Yahoo Daily Chart fixture for DXY and VIX (Summer / EDT session start at 13:30 UTC).
 */
export function generateSampleYahooChartDataJuly(
  symbol: "DX-Y.NYB" | "^VIX",
  closes: [number, number, number]
) {
  // Session start timestamps at 13:30 UTC (09:30 EDT) for July 15, 16, 17
  const timestampsSec = [
    Math.floor(Date.parse("2024-07-15T13:30:00Z") / 1000),
    Math.floor(Date.parse("2024-07-16T13:30:00Z") / 1000),
    Math.floor(Date.parse("2024-07-17T13:30:00Z") / 1000),
  ];

  return {
    chart: {
      result: [
        {
          timestamp: timestampsSec,
          indicators: {
            quote: [
              {
                close: closes,
              },
            ],
          },
          meta: {
            symbol,
          },
        },
      ],
    },
  };
}

/**
 * Builds a complete normalized HistoricalMarketObservation[] covering all 6 market series:
 * BTC, PAXG, DXY, US2Y, US10Y, VIX (Winter / EST benchmark period).
 */
export function buildSampleMarketObservations(): readonly HistoricalMarketObservation[] {
  const btcRaw = generateSampleBinanceKlines(48000, 72, SAMPLE_START_TIME);
  const paxgRaw = generateSampleBinanceKlines(2020, 72, SAMPLE_START_TIME);
  const dxyRaw = generateSampleYahooChartData("DX-Y.NYB", [104.15, 104.85, 104.7]);
  const vixRaw = generateSampleYahooChartData("^VIX", [12.9, 15.85, 14.38]);

  const btcRes = parseBinance1HKlines(btcRaw, { seriesId: "BTC" });
  const paxgRes = parseBinance1HKlines(paxgRaw, { seriesId: "PAXG" });
  const us2yRes = parseTreasuryYieldSeries(RAW_SAMPLE_TREASURY_DATA, { seriesId: "US2Y" });
  const us10yRes = parseTreasuryYieldSeries(RAW_SAMPLE_TREASURY_DATA, { seriesId: "US10Y" });
  const dxyRes = parseYahooDailyMarketSeries(dxyRaw, { seriesId: "DXY" });
  const vixRes = parseYahooDailyMarketSeries(vixRaw, { seriesId: "VIX" });

  if (
    !btcRes.success ||
    !paxgRes.success ||
    !us2yRes.success ||
    !us10yRes.success ||
    !dxyRes.success ||
    !vixRes.success
  ) {
    throw new Error("Failed to parse sample market fixtures");
  }

  const allObservations: HistoricalMarketObservation[] = [
    ...btcRes.observations,
    ...paxgRes.observations,
    ...us2yRes.observations,
    ...us10yRes.observations,
    ...dxyRes.observations,
    ...vixRes.observations,
  ];

  const dataset: HistoricalDataset = {
    marketObservations: allObservations,
    macroReleases: [],
    eventRecords: [],
    metadata: {
      interval: "1h",
      startTime: SAMPLE_START_TIME,
      endTime: SAMPLE_START_TIME + 72 * ONE_HOUR_MS,
      sourceIdentifiers: {
        BTC: "BINANCE:BTCUSDT",
        PAXG: "BINANCE:PAXGUSDT",
        US2Y: "FEDERAL_RESERVE_H15:2_YEAR_CMT",
        US10Y: "FEDERAL_RESERVE_H15:10_YEAR_CMT",
        DXY: "YAHOO:DX-Y.NYB",
        VIX: "YAHOO:^VIX",
      },
    },
  };

  const normalized = normalizeHistoricalDataset(dataset);
  return normalized.marketObservations;
}

/**
 * Builds a complete normalized HistoricalMarketObservation[] covering all 6 market series:
 * BTC, PAXG, DXY, US2Y, US10Y, VIX (Summer / EDT benchmark period).
 */
export function buildSampleMarketObservationsJuly(): readonly HistoricalMarketObservation[] {
  const btcRaw = generateSampleBinanceKlines(63000, 72, SAMPLE_JULY_START_TIME);
  const paxgRaw = generateSampleBinanceKlines(2410, 72, SAMPLE_JULY_START_TIME);
  const dxyRaw = generateSampleYahooChartDataJuly("DX-Y.NYB", [104.2, 103.85, 103.75]);
  const vixRaw = generateSampleYahooChartDataJuly("^VIX", [13.12, 13.19, 14.48]);

  const btcRes = parseBinance1HKlines(btcRaw, { seriesId: "BTC" });
  const paxgRes = parseBinance1HKlines(paxgRaw, { seriesId: "PAXG" });
  const us2yRes = parseTreasuryYieldSeries(RAW_SAMPLE_TREASURY_DATA_JULY, { seriesId: "US2Y" });
  const us10yRes = parseTreasuryYieldSeries(RAW_SAMPLE_TREASURY_DATA_JULY, { seriesId: "US10Y" });
  const dxyRes = parseYahooDailyMarketSeries(dxyRaw, { seriesId: "DXY" });
  const vixRes = parseYahooDailyMarketSeries(vixRaw, { seriesId: "VIX" });

  if (
    !btcRes.success ||
    !paxgRes.success ||
    !us2yRes.success ||
    !us10yRes.success ||
    !dxyRes.success ||
    !vixRes.success
  ) {
    throw new Error("Failed to parse summer sample market fixtures");
  }

  const allObservations: HistoricalMarketObservation[] = [
    ...btcRes.observations,
    ...paxgRes.observations,
    ...us2yRes.observations,
    ...us10yRes.observations,
    ...dxyRes.observations,
    ...vixRes.observations,
  ];

  const dataset: HistoricalDataset = {
    marketObservations: allObservations,
    macroReleases: [],
    eventRecords: [],
    metadata: {
      interval: "1h",
      startTime: SAMPLE_JULY_START_TIME,
      endTime: SAMPLE_JULY_START_TIME + 72 * ONE_HOUR_MS,
      sourceIdentifiers: {
        BTC: "BINANCE:BTCUSDT",
        PAXG: "BINANCE:PAXGUSDT",
        US2Y: "FEDERAL_RESERVE_H15:2_YEAR_CMT",
        US10Y: "FEDERAL_RESERVE_H15:10_YEAR_CMT",
        DXY: "YAHOO:DX-Y.NYB",
        VIX: "YAHOO:^VIX",
      },
    },
  };

  const normalized = normalizeHistoricalDataset(dataset);
  return normalized.marketObservations;
}
