// ============================================================================
// FILE: src/lib/macro/adapters.ts
// MODULE: MACRO V2 LIVE FEED ADAPTERS
// PRINCIPLE: Truthful Feed Ingestion — No Synthetic Fallbacks & No Hardcoded Stubs (DEC-005)
// ============================================================================

import {
  createLiveDatum,
  createUnavailableDatum,
} from "./helpers";
import type {
  MacroDatum,
  VietnamBreadthData,
  VietnamForeignFlowData,
  VietnamLiquidityData,
} from "./types";

export interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly json: () => Promise<unknown>;
}

export type FetchFn = (url: string) => Promise<FetchResponse>;

export interface AdapterOptions {
  readonly fetchFn?: FetchFn;
  readonly fetchedAt?: number;
}

const defaultFetchFn: FetchFn = async (url: string) => {
  const res = await fetch(url);
  return {
    ok: res.ok,
    status: res.status,
    json: () => res.json(),
  };
};

/**
 * Parses Binance daily klines response payload.
 * Scans backward to extract the latest valid close price and source bar timestamp (ms)
 * from the SAME valid observation row.
 */
export function parseBinanceKlines(
  data: unknown
): { value: number; asOf: number } | null {
  if (!Array.isArray(data) || data.length === 0) return null;

  for (let i = data.length - 1; i >= 0; i -= 1) {
    const row = data[i];
    if (!Array.isArray(row) || row.length < 5) continue;

    const asOf = Number(row[0]);
    const valStr = row[4] != null ? String(row[4]) : "";
    const value = parseFloat(valStr);

    if (
      Number.isFinite(asOf) &&
      asOf > 0 &&
      Number.isFinite(value)
    ) {
      return { value, asOf };
    }
  }

  return null;
}

interface YahooChartResponse {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      indicators?: { quote?: Array<{ close?: Array<number | null> }> };
    }>;
  };
}

/**
 * Parses Yahoo Finance v8 chart response payload.
 * Extracts the latest valid finite close price and corresponding source timestamp (ms).
 */
export function parseYahooChart(
  data: unknown
): { value: number; asOf: number } | null {
  if (typeof data !== "object" || data === null) return null;
  const chartRes = data as YahooChartResponse;
  const result = chartRes.chart?.result?.[0];
  if (!result) return null;

  const stamps = result.timestamp ?? [];
  const closes = result.indicators?.quote?.[0]?.close ?? [];

  if (!Array.isArray(stamps) || !Array.isArray(closes) || stamps.length === 0) {
    return null;
  }

  // Find latest valid non-null close from end of array
  for (let i = stamps.length - 1; i >= 0; i -= 1) {
    const close = closes[i];
    const stamp = stamps[i];

    if (
      close != null &&
      Number.isFinite(close) &&
      stamp != null &&
      Number.isFinite(stamp) &&
      stamp > 0
    ) {
      return {
        value: close,
        asOf: stamp * 1000, // Convert seconds to milliseconds
      };
    }
  }

  return null;
}

async function tryFetchUrls(
  urls: readonly string[],
  fetchFn: FetchFn
): Promise<unknown | null> {
  for (const url of urls) {
    try {
      const res = await fetchFn(url);
      if (!res.ok) continue;
      return await res.json();
    } catch {
      // Continue to next proxy/URL
    }
  }
  return null;
}

/**
 * Adapter A: BTC
 * Primary: Binance BTCUSDT
 * Fallback: Yahoo BTC-USD (LIVE)
 * Failure: UNAVAILABLE
 */
export async function fetchBtcDatumV2(
  opts?: AdapterOptions
): Promise<MacroDatum<number>> {
  const fetchFn = opts?.fetchFn ?? defaultFetchFn;
  const fetchedAt = opts?.fetchedAt ?? Date.now();

  // 1. Try Binance
  const binanceUrls = [
    "/api/binance/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=250",
    "https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=250",
  ];
  const binanceData = await tryFetchUrls(binanceUrls, fetchFn);
  const binanceParsed = parseBinanceKlines(binanceData);

  if (binanceParsed) {
    return createLiveDatum({
      id: "btc",
      value: binanceParsed.value,
      provider: "Binance",
      instrument: "BTCUSDT",
      asOf: binanceParsed.asOf,
      fetchedAt,
      basis: "SPOT",
    });
  }

  // 2. Try Yahoo
  const yahooUrls = [
    `/api/yahoo/v8/finance/chart/${encodeURIComponent("BTC-USD")}?interval=1d&range=2y`,
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent("BTC-USD")}?interval=1d&range=2y`,
  ];
  const yahooData = await tryFetchUrls(yahooUrls, fetchFn);
  const yahooParsed = parseYahooChart(yahooData);

  if (yahooParsed) {
    return createLiveDatum({
      id: "btc",
      value: yahooParsed.value,
      provider: "Yahoo",
      instrument: "BTC-USD",
      asOf: yahooParsed.asOf,
      fetchedAt,
      basis: "SPOT",
    });
  }

  return createUnavailableDatum("btc", {
    provider: "Binance/Yahoo",
    instrument: "BTCUSDT/BTC-USD",
    reason: "All BTC live feeds failed or returned malformed payloads",
    fetchedAt,
  });
}

/**
 * Adapter B: Gold
 * Primary: Binance PAXGUSDT (basis: PAXG_TOKEN)
 * Fallback: Yahoo GC=F (basis: GOLD_FUTURES_CONTINUOUS)
 * Failure: UNAVAILABLE
 */
export async function fetchGoldDatumV2(
  opts?: AdapterOptions
): Promise<MacroDatum<number>> {
  const fetchFn = opts?.fetchFn ?? defaultFetchFn;
  const fetchedAt = opts?.fetchedAt ?? Date.now();

  // 1. Try Binance PAXG
  const binanceUrls = [
    "/api/binance/api/v3/klines?symbol=PAXGUSDT&interval=1d&limit=250",
    "https://data-api.binance.vision/api/v3/klines?symbol=PAXGUSDT&interval=1d&limit=250",
  ];
  const binanceData = await tryFetchUrls(binanceUrls, fetchFn);
  const binanceParsed = parseBinanceKlines(binanceData);

  if (binanceParsed) {
    return createLiveDatum({
      id: "gold",
      value: binanceParsed.value,
      provider: "Binance",
      instrument: "PAXGUSDT",
      asOf: binanceParsed.asOf,
      fetchedAt,
      basis: "PAXG_TOKEN",
    });
  }

  // 2. Try Yahoo Gold Futures (GC=F)
  const yahooUrls = [
    `/api/yahoo/v8/finance/chart/${encodeURIComponent("GC=F")}?interval=1d&range=2y`,
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent("GC=F")}?interval=1d&range=2y`,
  ];
  const yahooData = await tryFetchUrls(yahooUrls, fetchFn);
  const yahooParsed = parseYahooChart(yahooData);

  if (yahooParsed) {
    return createLiveDatum({
      id: "gold",
      value: yahooParsed.value,
      provider: "Yahoo",
      instrument: "GC=F",
      asOf: yahooParsed.asOf,
      fetchedAt,
      basis: "GOLD_FUTURES_CONTINUOUS",
    });
  }

  return createUnavailableDatum("gold", {
    provider: "Binance/Yahoo",
    instrument: "PAXGUSDT/GC=F",
    reason: "All Gold live feeds failed or returned malformed payloads",
    fetchedAt,
  });
}

/**
 * Adapter C: DXY
 * Yahoo DX-Y.NYB
 * Failure: UNAVAILABLE
 */
export async function fetchDxyDatumV2(
  opts?: AdapterOptions
): Promise<MacroDatum<number>> {
  const fetchFn = opts?.fetchFn ?? defaultFetchFn;
  const fetchedAt = opts?.fetchedAt ?? Date.now();

  const yahooUrls = [
    `/api/yahoo/v8/finance/chart/${encodeURIComponent("DX-Y.NYB")}?interval=1d&range=2y`,
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent("DX-Y.NYB")}?interval=1d&range=2y`,
  ];
  const yahooData = await tryFetchUrls(yahooUrls, fetchFn);
  const yahooParsed = parseYahooChart(yahooData);

  if (yahooParsed) {
    return createLiveDatum({
      id: "dxy",
      value: yahooParsed.value,
      provider: "Yahoo",
      instrument: "DX-Y.NYB",
      asOf: yahooParsed.asOf,
      fetchedAt,
      basis: "INDEX",
    });
  }

  return createUnavailableDatum("dxy", {
    provider: "Yahoo",
    instrument: "DX-Y.NYB",
    reason: "Yahoo DXY feed failed",
    fetchedAt,
  });
}

/**
 * Adapter D: US10Y
 * Yahoo ^TNX
 * Failure: UNAVAILABLE
 */
export async function fetchUs10yDatumV2(
  opts?: AdapterOptions
): Promise<MacroDatum<number>> {
  const fetchFn = opts?.fetchFn ?? defaultFetchFn;
  const fetchedAt = opts?.fetchedAt ?? Date.now();

  const yahooUrls = [
    `/api/yahoo/v8/finance/chart/${encodeURIComponent("^TNX")}?interval=1d&range=2y`,
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent("^TNX")}?interval=1d&range=2y`,
  ];
  const yahooData = await tryFetchUrls(yahooUrls, fetchFn);
  const yahooParsed = parseYahooChart(yahooData);

  if (yahooParsed) {
    return createLiveDatum({
      id: "us10y",
      value: yahooParsed.value,
      provider: "Yahoo",
      instrument: "^TNX",
      asOf: yahooParsed.asOf,
      fetchedAt,
      basis: "YIELD_PERCENT",
    });
  }

  return createUnavailableDatum("us10y", {
    provider: "Yahoo",
    instrument: "^TNX",
    reason: "Yahoo US10Y feed failed",
    fetchedAt,
  });
}

/**
 * Adapter E: US2Y
 * Yahoo 2YY=F
 * Failure: UNAVAILABLE (NEVER DERIVED FROM US10Y IN V2)
 */
export async function fetchUs2yDatumV2(
  opts?: AdapterOptions
): Promise<MacroDatum<number>> {
  const fetchFn = opts?.fetchFn ?? defaultFetchFn;
  const fetchedAt = opts?.fetchedAt ?? Date.now();

  const yahooUrls = [
    `/api/yahoo/v8/finance/chart/${encodeURIComponent("2YY=F")}?interval=1d&range=2y`,
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent("2YY=F")}?interval=1d&range=2y`,
  ];
  const yahooData = await tryFetchUrls(yahooUrls, fetchFn);
  const yahooParsed = parseYahooChart(yahooData);

  if (yahooParsed) {
    return createLiveDatum({
      id: "us2y",
      value: yahooParsed.value,
      provider: "Yahoo",
      instrument: "2YY=F",
      asOf: yahooParsed.asOf,
      fetchedAt,
      basis: "YIELD_PERCENT",
    });
  }

  return createUnavailableDatum("us2y", {
    provider: "Yahoo",
    instrument: "2YY=F",
    reason: "Yahoo US2Y feed failed (Never derived from US10Y)",
    fetchedAt,
  });
}

/**
 * Adapter F: VIX
 * Yahoo ^VIX
 * Failure: UNAVAILABLE
 */
export async function fetchVixDatumV2(
  opts?: AdapterOptions
): Promise<MacroDatum<number>> {
  const fetchFn = opts?.fetchFn ?? defaultFetchFn;
  const fetchedAt = opts?.fetchedAt ?? Date.now();

  const yahooUrls = [
    `/api/yahoo/v8/finance/chart/${encodeURIComponent("^VIX")}?interval=1d&range=2y`,
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent("^VIX")}?interval=1d&range=2y`,
  ];
  const yahooData = await tryFetchUrls(yahooUrls, fetchFn);
  const yahooParsed = parseYahooChart(yahooData);

  if (yahooParsed) {
    return createLiveDatum({
      id: "vix",
      value: yahooParsed.value,
      provider: "Yahoo",
      instrument: "^VIX",
      asOf: yahooParsed.asOf,
      fetchedAt,
      basis: "INDEX",
    });
  }

  return createUnavailableDatum("vix", {
    provider: "Yahoo",
    instrument: "^VIX",
    reason: "Yahoo VIX feed failed",
    fetchedAt,
  });
}

/**
 * Adapter G: VNINDEX
 * Yahoo ^VNINDEX
 * Failure: UNAVAILABLE (NO SYNTHETIC BASE SERIES FALLBACK IN V2)
 */
export async function fetchVnIndexDatumV2(
  opts?: AdapterOptions
): Promise<MacroDatum<number>> {
  const fetchFn = opts?.fetchFn ?? defaultFetchFn;
  const fetchedAt = opts?.fetchedAt ?? Date.now();

  const yahooUrls = [
    `/api/yahoo/v8/finance/chart/${encodeURIComponent("^VNINDEX")}?interval=1d&range=2y`,
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent("^VNINDEX")}?interval=1d&range=2y`,
  ];
  const yahooData = await tryFetchUrls(yahooUrls, fetchFn);
  const yahooParsed = parseYahooChart(yahooData);

  if (yahooParsed) {
    return createLiveDatum({
      id: "vnindex",
      value: yahooParsed.value,
      provider: "Yahoo",
      instrument: "^VNINDEX",
      asOf: yahooParsed.asOf,
      fetchedAt,
      basis: "INDEX",
    });
  }

  return createUnavailableDatum("vnindex", {
    provider: "Yahoo",
    instrument: "^VNINDEX",
    reason: "Yahoo VNINDEX feed failed (No synthetic base series fallback in V2)",
    fetchedAt,
  });
}

/**
 * Vietnam Internal Metric Adapter: Breadth
 * Return UNAVAILABLE (No verified live feed connected yet)
 */
export async function fetchVietnamBreadthV2(
  opts?: AdapterOptions
): Promise<MacroDatum<VietnamBreadthData>> {
  const fetchedAt = opts?.fetchedAt ?? Date.now();
  return createUnavailableDatum("breadth", {
    provider: "VietnamExchange",
    instrument: "HOSE_BREADTH",
    reason: "No verified live market breadth feed connected",
    fetchedAt,
  });
}

/**
 * Vietnam Internal Metric Adapter: Liquidity
 * Return UNAVAILABLE (No verified live feed connected yet)
 */
export async function fetchVietnamLiquidityV2(
  opts?: AdapterOptions
): Promise<MacroDatum<VietnamLiquidityData>> {
  const fetchedAt = opts?.fetchedAt ?? Date.now();
  return createUnavailableDatum("liquidity", {
    provider: "VietnamExchange",
    instrument: "HOSE_LIQUIDITY",
    reason: "No verified live market liquidity feed connected",
    fetchedAt,
  });
}

/**
 * Vietnam Internal Metric Adapter: Foreign Flow
 * Return UNAVAILABLE (No verified live feed connected yet)
 */
export async function fetchVietnamForeignFlowV2(
  opts?: AdapterOptions
): Promise<MacroDatum<VietnamForeignFlowData>> {
  const fetchedAt = opts?.fetchedAt ?? Date.now();
  return createUnavailableDatum("foreignFlow", {
    provider: "VietnamExchange",
    instrument: "HOSE_FOREIGN_FLOW",
    reason: "No verified live foreign flow feed connected",
    fetchedAt,
  });
}
