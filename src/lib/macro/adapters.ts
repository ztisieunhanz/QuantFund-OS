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
import {
  fetchPaginatedVndirectFinfo,
  fetchVndirectDchart,
  fetchVndirectFinfo,
} from "./vndirectClient";
import {
  calculateVietnamBreadth,
  calculateVietnamLiquidity,
  parseAndCalculateVietnamForeignFlow,
  parseVndirectForeigns,
  parseVndirectSecurityMaster,
  parseVndirectStockPrices,
  type ParsedStockPriceRow,
} from "./vndirectParsers";
import {
  addSecurityCloseObservation,
  createEmptyHistoryMap,
  type PerSecurityHistoryMap,
} from "./vietnamHistory";

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

let globalHistoryMap: PerSecurityHistoryMap = createEmptyHistoryMap();
let globalDailyLiquidityHistory: Array<{ date: string; rows: ParsedStockPriceRow[] }> = [];
let globalDailyForeignHistory: Array<{ date: string; payload: unknown }> = [];

/**
 * Resets in-memory Vietnam history caches (primarily used for deterministic test isolation).
 */
export function resetVietnamAdapterCaches(): void {
  globalHistoryMap = createEmptyHistoryMap();
  globalDailyLiquidityHistory = [];
  globalDailyForeignHistory = [];
}

interface DchartHistoryResponse {
  readonly t?: number[];
  readonly o?: number[];
  readonly h?: number[];
  readonly l?: number[];
  readonly c?: number[];
  readonly v?: number[];
  readonly s?: string;
}

/**
 * Adapter G: VNINDEX
 * Primary: VNDirect DChart symbol=VNINDEX
 * Failure: UNAVAILABLE (NO YAHOO AND NO SYNTHETIC FALLBACK IN V2)
 */
export async function fetchVnIndexDatumV2(
  opts?: AdapterOptions
): Promise<MacroDatum<number>> {
  const fetchFn = opts?.fetchFn;
  const fetchedAt = opts?.fetchedAt ?? Date.now();

  const customFetch = fetchFn
    ? async (url: string) => {
        const res = await fetchFn(url);
        return { ok: res.ok, status: res.status, json: res.json };
      }
    : undefined;

  const result = await fetchVndirectDchart<DchartHistoryResponse>(
    "/history?symbol=VNINDEX&resolution=D",
    customFetch
  );

  if (!result.success || !result.data || result.data.s !== "ok") {
    return createUnavailableDatum("vnindex", {
      provider: "VNDirect",
      instrument: "VNINDEX",
      reason: "VNDirect DChart VNINDEX feed failed or malformed",
      fetchedAt,
    });
  }

  const { t, c } = result.data;
  if (!Array.isArray(t) || !Array.isArray(c) || t.length === 0 || c.length === 0) {
    return createUnavailableDatum("vnindex", {
      provider: "VNDirect",
      instrument: "VNINDEX",
      reason: "VNDirect DChart VNINDEX payload missing timestamp/close arrays",
      fetchedAt,
    });
  }

  for (let i = t.length - 1; i >= 0; i -= 1) {
    const close = c[i];
    const stamp = t[i];

    if (
      close != null &&
      Number.isFinite(close) &&
      close > 0 &&
      stamp != null &&
      Number.isFinite(stamp) &&
      stamp > 0
    ) {
      return createLiveDatum({
        id: "vnindex",
        value: close,
        provider: "VNDirect",
        instrument: "VNINDEX",
        asOf: stamp * 1000,
        fetchedAt,
        basis: "SPOT_INDEX",
      });
    }
  }

  return createUnavailableDatum("vnindex", {
    provider: "VNDirect",
    instrument: "VNINDEX",
    reason: "No valid finite close observation found in DChart VNINDEX response",
    fetchedAt,
  });
}

/**
 * Retrieves official provider-derived VNINDEX market trading session dates (newest to oldest).
 */
async function getMarketSessionCalendar(
  opts?: AdapterOptions
): Promise<string[]> {
  const fetchFn = opts?.fetchFn;
  const customFetch = fetchFn
    ? async (url: string) => {
        const res = await fetchFn(url);
        return { ok: res.ok, status: res.status, json: res.json };
      }
    : undefined;

  const result = await fetchVndirectDchart<DchartHistoryResponse>(
    "/history?symbol=VNINDEX&resolution=D",
    customFetch
  );

  if (!result.success || !result.data || result.data.s !== "ok" || !Array.isArray(result.data.t)) {
    return [];
  }

  const dates: string[] = [];
  const seen = new Set<string>();

  for (let i = result.data.t.length - 1; i >= 0; i--) {
    const stamp = result.data.t[i];
    if (stamp != null && Number.isFinite(stamp) && stamp > 0) {
      const d = new Date(stamp * 1000);
      const year = d.getUTCFullYear();
      const month = String(d.getUTCMonth() + 1).padStart(2, "0");
      const day = String(d.getUTCDate()).padStart(2, "0");
      const dateStr = `${year}-${month}-${day}`;
      if (!seen.has(dateStr)) {
        seen.add(dateStr);
        dates.push(dateStr);
      }
    }
  }

  return dates;
}

/**
 * Loads Authoritative Security Master universe set (floor:HOSE, type:STOCK, status:listed).
 */
async function getAuthoritativeUniverse(
  opts?: AdapterOptions
): Promise<Set<string> | null> {
  const fetchFn = opts?.fetchFn;
  const customFetch = fetchFn
    ? async (url: string) => {
        const res = await fetchFn(url);
        return { ok: res.ok, status: res.status, json: res.json };
      }
    : undefined;

  const res = await fetchPaginatedVndirectFinfo<unknown>(
    "/v4/stocks?q=floor:HOSE~type:STOCK~status:listed&size=500",
    customFetch
  );

  if (!res.success) {
    return null;
  }

  const parsed = parseVndirectSecurityMaster(res.data);
  if (!parsed.success) {
    return null;
  }

  return parsed.data;
}

/**
 * Vietnam Internal Metric Adapter: Breadth
 */
export async function fetchVietnamBreadthV2(
  opts?: AdapterOptions
): Promise<MacroDatum<VietnamBreadthData>> {
  const fetchFn = opts?.fetchFn;
  const fetchedAt = opts?.fetchedAt ?? Date.now();

  const customFetch = fetchFn
    ? async (url: string) => {
        const res = await fetchFn(url);
        return { ok: res.ok, status: res.status, json: res.json };
      }
    : undefined;

  const authSymbols = await getAuthoritativeUniverse(opts);
  if (!authSymbols) {
    return createUnavailableDatum("breadth", {
      provider: "VNDirect",
      instrument: "HOSE_BREADTH",
      reason: "Authoritative Security Master universe could not be established",
      fetchedAt,
    });
  }

  // 1. Discover latest stock_prices session date D from global HOSE probe
  const probeRes = await fetchVndirectFinfo<unknown>(
    "/v4/stock_prices?q=floor:HOSE~type:STOCK&sort=date:desc&size=1",
    customFetch
  );

  let sessionDate: string | null = null;
  if (probeRes.success && probeRes.data) {
    const rawData = probeRes.data as Record<string, unknown>;
    const items = Array.isArray(rawData)
      ? rawData
      : Array.isArray(rawData.data)
      ? (rawData.data as unknown[])
      : [];
    const firstRow = items[0] as Record<string, unknown> | undefined;
    if (typeof firstRow?.date === "string") {
      sessionDate = firstRow.date.trim();
    }
  }

  if (!sessionDate) {
    return createUnavailableDatum("breadth", {
      provider: "VNDirect",
      instrument: "HOSE_BREADTH",
      reason: "VNDirect stock_prices probe failed or missing session date",
      fetchedAt,
    });
  }

  // 2. Fetch exact D cross-section using bounded pagination helper (totalPages = 1 for size=500)
  const stockPricesRes = await fetchPaginatedVndirectFinfo<unknown>(
    `/v4/stock_prices?q=floor:HOSE~type:STOCK~date:${sessionDate}&size=500`,
    customFetch
  );

  if (!stockPricesRes.success || !Array.isArray(stockPricesRes.data) || stockPricesRes.data.length === 0) {
    return createUnavailableDatum("breadth", {
      provider: "VNDirect",
      instrument: "HOSE_BREADTH",
      reason: `VNDirect stock_prices fetch for date ${sessionDate} failed or empty`,
      fetchedAt,
    });
  }

  const parseRes = parseVndirectStockPrices(stockPricesRes.data, sessionDate, authSymbols);
  if (!parseRes.success) {
    return createUnavailableDatum("breadth", {
      provider: "VNDirect",
      instrument: "HOSE_BREADTH",
      reason: parseRes.error,
      fetchedAt,
    });
  }

  const parsedRows = parseRes.data;

  for (const row of parsedRows) {
    globalHistoryMap = addSecurityCloseObservation(
      globalHistoryMap,
      row.code,
      sessionDate,
      row.close
    );
  }

  const existingIndex = globalDailyLiquidityHistory.findIndex((item) => item.date === sessionDate);
  if (existingIndex >= 0) {
    globalDailyLiquidityHistory[existingIndex] = { date: sessionDate, rows: parsedRows };
  } else {
    globalDailyLiquidityHistory.push({ date: sessionDate, rows: parsedRows });
    globalDailyLiquidityHistory.sort((a, b) => a.date.localeCompare(b.date));
  }

  const breadthValue = calculateVietnamBreadth(parsedRows, sessionDate, globalHistoryMap);
  // Session-date anchor (UTC midnight for date YYYY-MM-DD). Does NOT represent a provider-reported intraday observation or exchange close clock.
  const sessionAsOf = new Date(`${sessionDate}T00:00:00Z`).getTime();

  return createLiveDatum({
    id: "breadth",
    value: breadthValue,
    provider: "VNDirect",
    instrument: "HOSE_BREADTH",
    asOf: Number.isFinite(sessionAsOf) ? sessionAsOf : fetchedAt,
    fetchedAt,
    basis: "HOSE_COMMON_EQUITY_EOD",
  });
}

/**
 * Vietnam Internal Metric Adapter: Liquidity
 */
export async function fetchVietnamLiquidityV2(
  opts?: AdapterOptions
): Promise<MacroDatum<VietnamLiquidityData>> {
  const fetchFn = opts?.fetchFn;
  const fetchedAt = opts?.fetchedAt ?? Date.now();

  const customFetch = fetchFn
    ? async (url: string) => {
        const res = await fetchFn(url);
        return { ok: res.ok, status: res.status, json: res.json };
      }
    : undefined;

  const authSymbols = await getAuthoritativeUniverse(opts);
  if (!authSymbols) {
    return createUnavailableDatum("liquidity", {
      provider: "VNDirect",
      instrument: "HOSE_LIQUIDITY",
      reason: "Authoritative Security Master universe could not be established",
      fetchedAt,
    });
  }

  // Use provider-derived VNINDEX market-session calendar
  const candidateDates = await getMarketSessionCalendar(opts);

  for (const dateStr of candidateDates) {
    if (globalDailyLiquidityHistory.length >= 20) {
      break;
    }

    const alreadyCached = globalDailyLiquidityHistory.some((item) => item.date === dateStr);
    if (alreadyCached) {
      continue;
    }

    // Fetch exact date cross-section
    const stockPricesRes = await fetchPaginatedVndirectFinfo<unknown>(
      `/v4/stock_prices?q=floor:HOSE~type:STOCK~date:${dateStr}&size=500`,
      customFetch
    );

    if (stockPricesRes.success && Array.isArray(stockPricesRes.data) && stockPricesRes.data.length > 0) {
      const parseRes = parseVndirectStockPrices(stockPricesRes.data, dateStr, authSymbols);
      if (parseRes.success) {
        globalDailyLiquidityHistory.push({ date: dateStr, rows: parseRes.data });
        globalDailyLiquidityHistory.sort((a, b) => a.date.localeCompare(b.date));
      }
    }
  }

  if (globalDailyLiquidityHistory.length < 20) {
    return createUnavailableDatum("liquidity", {
      provider: "VNDirect",
      instrument: "HOSE_LIQUIDITY",
      reason: `Insufficient 20-session liquidity history (available: ${globalDailyLiquidityHistory.length}/20)`,
      fetchedAt,
    });
  }

  const latest20Sessions = globalDailyLiquidityHistory.slice(
    globalDailyLiquidityHistory.length - 20
  );
  const currentSession = latest20Sessions[latest20Sessions.length - 1];

  const liquidityRes = calculateVietnamLiquidity(
    currentSession.rows,
    latest20Sessions.map((s) => s.rows)
  );

  if (!liquidityRes.success) {
    return createUnavailableDatum("liquidity", {
      provider: "VNDirect",
      instrument: "HOSE_LIQUIDITY",
      reason: liquidityRes.error,
      fetchedAt,
    });
  }

  // Session-date anchor (UTC midnight for date YYYY-MM-DD). Does NOT represent a provider-reported intraday observation or exchange close clock.
  const sessionAsOf = new Date(`${currentSession.date}T00:00:00Z`).getTime();

  return createLiveDatum({
    id: "liquidity",
    value: liquidityRes.data,
    provider: "VNDirect",
    instrument: "HOSE_LIQUIDITY",
    asOf: Number.isFinite(sessionAsOf) ? sessionAsOf : fetchedAt,
    fetchedAt,
    basis: "HOSE_COMMON_EQUITY_NORMAL_MATCHED_VALUE_BILLION_VND",
  });
}

/**
 * Vietnam Internal Metric Adapter: Foreign Flow
 */
export async function fetchVietnamForeignFlowV2(
  opts?: AdapterOptions
): Promise<MacroDatum<VietnamForeignFlowData>> {
  const fetchFn = opts?.fetchFn;
  const fetchedAt = opts?.fetchedAt ?? Date.now();

  const customFetch = fetchFn
    ? async (url: string) => {
        const res = await fetchFn(url);
        return { ok: res.ok, status: res.status, json: res.json };
      }
    : undefined;

  const authSymbols = await getAuthoritativeUniverse(opts);
  if (!authSymbols) {
    return createUnavailableDatum("foreignFlow", {
      provider: "VNDirect",
      instrument: "HOSE_FOREIGN_FLOW",
      reason: "Authoritative Security Master universe could not be established",
      fetchedAt,
    });
  }

  // Use provider-derived VNINDEX market-session calendar
  const candidateDates = await getMarketSessionCalendar(opts);

  for (const dateStr of candidateDates) {
    if (globalDailyForeignHistory.length >= 5) {
      break;
    }

    const alreadyCached = globalDailyForeignHistory.some((item) => item.date === dateStr);
    if (alreadyCached) {
      continue;
    }

    // Fetch exact tradingDate cross-section
    const foreignRes = await fetchPaginatedVndirectFinfo<unknown>(
      `/v4/foreigns?q=floor:HOSE~type:STOCK~tradingDate:${dateStr}&size=500`,
      customFetch
    );

    if (foreignRes.success && Array.isArray(foreignRes.data) && foreignRes.data.length > 0) {
      const parseCheck = parseVndirectForeigns(foreignRes.data, dateStr, authSymbols);
      if (parseCheck.success) {
        globalDailyForeignHistory.push({ date: dateStr, payload: foreignRes.data });
        globalDailyForeignHistory.sort((a, b) => a.date.localeCompare(b.date));
      }
    }
  }

  if (globalDailyForeignHistory.length < 5) {
    return createUnavailableDatum("foreignFlow", {
      provider: "VNDirect",
      instrument: "HOSE_FOREIGN_FLOW",
      reason: `Insufficient 5-session foreign flow history (available: ${globalDailyForeignHistory.length}/5)`,
      fetchedAt,
    });
  }

  const latest5Sessions = globalDailyForeignHistory.slice(
    globalDailyForeignHistory.length - 5
  );

  const currentSession = latest5Sessions[latest5Sessions.length - 1];
  const sessionDate = currentSession.date;
  const currentPayload = currentSession.payload;
  const history5Payloads = latest5Sessions.map((s) => s.payload);

  const calcRes = parseAndCalculateVietnamForeignFlow(
    currentPayload,
    sessionDate,
    history5Payloads,
    authSymbols
  );

  if (!calcRes.success) {
    return createUnavailableDatum("foreignFlow", {
      provider: "VNDirect",
      instrument: "HOSE_FOREIGN_FLOW",
      reason: calcRes.error,
      fetchedAt,
    });
  }

  // Session-date anchor (UTC midnight for date YYYY-MM-DD). Does NOT represent a provider-reported intraday observation or exchange close clock.
  const sessionAsOf = new Date(`${sessionDate}T00:00:00Z`).getTime();

  return createLiveDatum({
    id: "foreignFlow",
    value: calcRes.data,
    provider: "VNDirect",
    instrument: "HOSE_FOREIGN_FLOW",
    asOf: Number.isFinite(sessionAsOf) ? sessionAsOf : fetchedAt,
    fetchedAt,
    basis: "HOSE_COMMON_EQUITY_FOREIGN_NET_VALUE_BILLION_VND",
  });
}
