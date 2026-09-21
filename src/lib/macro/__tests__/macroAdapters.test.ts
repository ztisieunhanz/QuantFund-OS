// ============================================================================
// FILE: src/lib/macro/__tests__/macroAdapters.test.ts
// MODULE: MACRO V2 LIVE FEED ADAPTER UNIT TESTS
// PRINCIPLE: Fully Deterministic Testing with Mocked Fetch Injection (No Live Network)
// ============================================================================

import { describe, expect, it } from "vitest";
import {
  type FetchFn,
  type FetchResponse,
  fetchBtcDatumV2,
  fetchDxyDatumV2,
  fetchGoldDatumV2,
  fetchUs10yDatumV2,
  fetchUs2yDatumV2,
  fetchVietnamBreadthV2,
  fetchVietnamForeignFlowV2,
  fetchVietnamLiquidityV2,
  fetchVixDatumV2,
  fetchVnIndexDatumV2,
  parseBinanceKlines,
  parseYahooChart,
} from "../adapters";
import { loadMacroUniverseV2 } from "../loader";

function createMockFetch(
  routeMap: Record<string, { status?: number; data: unknown }>
): FetchFn {
  return async (url: string): Promise<FetchResponse> => {
    const decodedUrl = decodeURIComponent(url);
    for (const [routePattern, mock] of Object.entries(routeMap)) {
      if (url.includes(routePattern) || decodedUrl.includes(routePattern)) {
        const status = mock.status ?? 200;
        const ok = status >= 200 && status < 300;
        return {
          ok,
          status,
          json: async () => mock.data,
        };
      }
    }
    return {
      ok: false,
      status: 404,
      json: async () => ({ error: "Not found" }),
    };
  };
}

describe("Macro V2 Live Feed Adapters & Loader", () => {
  const FETCHED_AT = 1_700_100_000_000;
  const ASOF_TIMESTAMP_SEC = 1_700_000_000;
  const ASOF_TIMESTAMP_MS = ASOF_TIMESTAMP_SEC * 1000;

  // Sample valid Binance 25-bar klines
  const validBinanceKlines = Array.from({ length: 25 }, (_, i) => [
    ASOF_TIMESTAMP_MS + i * 86_400_000,
    "76000",
    "77000",
    "75500",
    (76000 + i * 10).toString(),
    "100.5",
  ]);

  // Sample valid Yahoo chart payload
  const validYahooChart = (value: number, stampSec: number = ASOF_TIMESTAMP_SEC) => ({
    chart: {
      result: [
        {
          timestamp: [stampSec - 86400, stampSec],
          indicators: {
            quote: [{ close: [value - 1, value] }],
          },
        },
      ],
    },
  });

  it("1. BTC Binance success -> LIVE / Binance / BTCUSDT", async () => {
    const fetchFn = createMockFetch({
      BTCUSDT: { data: validBinanceKlines },
    });

    const btc = await fetchBtcDatumV2({ fetchFn, fetchedAt: FETCHED_AT });

    expect(btc.status).toBe("AVAILABLE");
    if (btc.status === "AVAILABLE") {
      expect(btc.sourceClassification).toBe("LIVE");
      expect(btc.provider).toBe("Binance");
      expect(btc.instrument).toBe("BTCUSDT");
      expect(btc.basis).toBe("SPOT");
      expect(btc.value).toBe(76240); // 76000 + 24*10
      expect(btc.asOf).toBe(ASOF_TIMESTAMP_MS + 24 * 86_400_000);
      expect(btc.fetchedAt).toBe(FETCHED_AT);
    }
  });

  it("2. BTC Binance failure + Yahoo success -> LIVE / Yahoo / BTC-USD", async () => {
    const fetchFn = createMockFetch({
      BTCUSDT: { status: 500, data: { error: "Binance error" } },
      "BTC-USD": { data: validYahooChart(76800, ASOF_TIMESTAMP_SEC) },
    });

    const btc = await fetchBtcDatumV2({ fetchFn, fetchedAt: FETCHED_AT });

    expect(btc.status).toBe("AVAILABLE");
    if (btc.status === "AVAILABLE") {
      expect(btc.sourceClassification).toBe("LIVE");
      expect(btc.provider).toBe("Yahoo");
      expect(btc.instrument).toBe("BTC-USD");
      expect(btc.basis).toBe("SPOT");
      expect(btc.value).toBe(76800);
      expect(btc.asOf).toBe(ASOF_TIMESTAMP_MS);
      expect(btc.fetchedAt).toBe(FETCHED_AT);
    }
  });

  it("3. BTC all sources fail -> UNAVAILABLE (not synthetic)", async () => {
    const fetchFn = createMockFetch({
      BTCUSDT: { status: 502, data: null },
      "BTC-USD": { status: 502, data: null },
    });

    const btc = await fetchBtcDatumV2({ fetchFn, fetchedAt: FETCHED_AT });

    expect(btc.status).toBe("UNAVAILABLE");
    expect(btc.value).toBeNull();
    expect(btc.sourceClassification).toBe("UNAVAILABLE");
    expect(btc.quality).toBe("UNAVAILABLE");
  });

  it("4. Gold PAXG success -> LIVE with PAXG_TOKEN basis", async () => {
    const fetchFn = createMockFetch({
      PAXGUSDT: { data: validBinanceKlines },
    });

    const gold = await fetchGoldDatumV2({ fetchFn, fetchedAt: FETCHED_AT });

    expect(gold.status).toBe("AVAILABLE");
    if (gold.status === "AVAILABLE") {
      expect(gold.sourceClassification).toBe("LIVE");
      expect(gold.provider).toBe("Binance");
      expect(gold.instrument).toBe("PAXGUSDT");
      expect(gold.basis).toBe("PAXG_TOKEN");
    }
  });

  it("5. Gold Yahoo fallback -> LIVE with GOLD_FUTURES_CONTINUOUS basis", async () => {
    const fetchFn = createMockFetch({
      PAXGUSDT: { status: 500, data: null },
      "GC=F": { data: validYahooChart(2750.5, ASOF_TIMESTAMP_SEC) },
    });

    const gold = await fetchGoldDatumV2({ fetchFn, fetchedAt: FETCHED_AT });

    expect(gold.status).toBe("AVAILABLE");
    if (gold.status === "AVAILABLE") {
      expect(gold.sourceClassification).toBe("LIVE");
      expect(gold.provider).toBe("Yahoo");
      expect(gold.instrument).toBe("GC=F");
      expect(gold.basis).toBe("GOLD_FUTURES_CONTINUOUS");
      expect(gold.value).toBe(2750.5);
    }
  });

  it("6. DXY failure -> UNAVAILABLE", async () => {
    const fetchFn = createMockFetch({
      "DX-Y.NYB": { status: 404, data: null },
    });

    const dxy = await fetchDxyDatumV2({ fetchFn, fetchedAt: FETCHED_AT });

    expect(dxy.status).toBe("UNAVAILABLE");
    expect(dxy.value).toBeNull();
    expect(dxy.sourceClassification).toBe("UNAVAILABLE");
  });

  it("7. US2Y failure -> UNAVAILABLE and NEVER derived from US10Y", async () => {
    // Both 10Y succeeds and 2Y fails
    const fetchFn = createMockFetch({
      "^TNX": { data: validYahooChart(4.58, ASOF_TIMESTAMP_SEC) },
      "2YY=F": { status: 500, data: null },
    });

    const us10y = await fetchUs10yDatumV2({ fetchFn, fetchedAt: FETCHED_AT });
    const us2y = await fetchUs2yDatumV2({ fetchFn, fetchedAt: FETCHED_AT });

    expect(us10y.status).toBe("AVAILABLE");
    expect(us2y.status).toBe("UNAVAILABLE");
    expect(us2y.value).toBeNull();
    expect(us2y.sourceClassification).toBe("UNAVAILABLE");
    if (us2y.status === "UNAVAILABLE") {
      expect(us2y.reason).toContain("Never derived from US10Y");
    }
  });

  it("8. VNINDEX failure -> UNAVAILABLE (no synthetic base fallback)", async () => {
    const fetchFn = createMockFetch({
      "^VNINDEX": { status: 500, data: null },
    });

    const vnindex = await fetchVnIndexDatumV2({ fetchFn, fetchedAt: FETCHED_AT });

    expect(vnindex.status).toBe("UNAVAILABLE");
    expect(vnindex.value).toBeNull();
    expect(vnindex.sourceClassification).toBe("UNAVAILABLE");
  });

  it("9. breadth/liquidity/foreignFlow -> UNAVAILABLE without hardcoded static values", async () => {
    const breadth = await fetchVietnamBreadthV2({ fetchedAt: FETCHED_AT });
    const liquidity = await fetchVietnamLiquidityV2({ fetchedAt: FETCHED_AT });
    const foreignFlow = await fetchVietnamForeignFlowV2({ fetchedAt: FETCHED_AT });

    expect(breadth.status).toBe("UNAVAILABLE");
    expect(breadth.value).toBeNull();

    expect(liquidity.status).toBe("UNAVAILABLE");
    expect(liquidity.value).toBeNull();

    expect(foreignFlow.status).toBe("UNAVAILABLE");
    expect(foreignFlow.value).toBeNull();
  });

  it("10. asOf is sourced from latest valid observation timestamp (not fetchedAt)", async () => {
    const SOURCE_STAMP_SEC = 1_695_000_000;
    const fetchFn = createMockFetch({
      "^VIX": { data: validYahooChart(18.5, SOURCE_STAMP_SEC) },
    });

    const vix = await fetchVixDatumV2({ fetchFn, fetchedAt: FETCHED_AT });

    expect(vix.status).toBe("AVAILABLE");
    if (vix.status === "AVAILABLE") {
      expect(vix.asOf).toBe(SOURCE_STAMP_SEC * 1000);
      expect(vix.fetchedAt).toBe(FETCHED_AT);
      expect(vix.asOf).not.toBe(vix.fetchedAt);
    }
  });

  it("11. Malformed / non-finite payload -> UNAVAILABLE", () => {
    // Test parser helpers directly for invalid shapes
    expect(parseBinanceKlines(null)).toBeNull();
    expect(parseBinanceKlines([])).toBeNull();
    expect(parseBinanceKlines([["invalid", "NaN"]])).toBeNull();

    expect(parseYahooChart(null)).toBeNull();
    expect(parseYahooChart({})).toBeNull();
    expect(parseYahooChart({ chart: { result: [{ timestamp: [100], indicators: { quote: [{ close: [null] }] } }] } })).toBeNull();
  });

  it("12. Universe loader preserves mixed provider/provenance metadata", async () => {
    const fetchFn = createMockFetch({
      BTCUSDT: { data: validBinanceKlines },
      "DX-Y.NYB": { data: validYahooChart(104.2, ASOF_TIMESTAMP_SEC) },
      "^TNX": { data: validYahooChart(4.58, ASOF_TIMESTAMP_SEC) },
    });

    const snapshotData = await loadMacroUniverseV2({ fetchFn, fetchedAt: FETCHED_AT });

    expect(snapshotData.btc.status).toBe("AVAILABLE");
    expect(snapshotData.btc.provider).toBe("Binance");

    expect(snapshotData.dxy.status).toBe("AVAILABLE");
    expect(snapshotData.dxy.provider).toBe("Yahoo");

    expect(snapshotData.us10y.status).toBe("AVAILABLE");
    expect(snapshotData.us10y.provider).toBe("Yahoo");

    expect(snapshotData.us2y.status).toBe("UNAVAILABLE");
    expect(snapshotData.vnindex.status).toBe("UNAVAILABLE");
    expect(snapshotData.breadth.status).toBe("UNAVAILABLE");
    expect(snapshotData.liquidity.status).toBe("UNAVAILABLE");
    expect(snapshotData.foreignFlow.status).toBe("UNAVAILABLE");
  });

  it("13. parseBinanceKlines accepts a single valid Binance bar (no >= 25 bar requirement)", () => {
    const singleBar = [[1700000000000, "76000", "77000", "75500", "76500.5"]];
    const parsed = parseBinanceKlines(singleBar);
    expect(parsed).toEqual({ value: 76500.5, asOf: 1700000000000 });
  });

  it("14. parseBinanceKlines skips malformed final bar and returns previous valid bar", () => {
    const dataWithMalformedEnd = [
      [1700000000000, "76000", "77000", "75500", "76100.0"], // valid row 0
      [1700086400000, "76100", "77200", "75800", "76800.0"], // valid row 1
      [1700172800000, "76800", "77500", "76000", "NaN"],     // malformed close in row 2
      ["invalid_stamp", "76800", "77500", "76000", "77000"], // invalid stamp in row 3
    ];
    const parsed = parseBinanceKlines(dataWithMalformedEnd);
    expect(parsed).toEqual({ value: 76800.0, asOf: 1700086400000 });
  });

  it("15. parseBinanceKlines guarantees timestamp and value come from the exact same row", () => {
    const rows = [
      [1000000, "10", "12", "9", "100.5"], // row 0: stamp 1000000, val 100.5
      [2000000, "10", "12", "9", null],    // row 1: stamp 2000000, invalid val
    ];
    const parsed = parseBinanceKlines(rows);
    expect(parsed).toEqual({ value: 100.5, asOf: 1000000 });
    expect(parsed?.asOf).not.toBe(2000000);
  });

  it("16. parseBinanceKlines returns null for all-invalid rows or non-array inputs", () => {
    expect(parseBinanceKlines([])).toBeNull();
    expect(parseBinanceKlines(null)).toBeNull();
    expect(parseBinanceKlines("not an array")).toBeNull();
    expect(parseBinanceKlines([["invalid", "NaN"]])).toBeNull();
    expect(parseBinanceKlines([[0, "10", "12", "9", "100"]])).toBeNull(); // 0 timestamp
    expect(parseBinanceKlines([[-100, "10", "12", "9", "100"]])).toBeNull(); // negative timestamp
  });

  // 17. Gate M5C: Yahoo-backed adapters use ONLY /api/yahoo same-origin contract and never direct query1.finance.yahoo.com
  it("17. Yahoo-backed adapters use ONLY /api/yahoo same-origin contract and never direct query1.finance.yahoo.com", async () => {
    const requestedUrls: string[] = [];
    const trackingFetch: FetchFn = async (url: string): Promise<FetchResponse> => {
      requestedUrls.push(url);
      if (url.includes("/api/yahoo")) {
        return {
          ok: true,
          status: 200,
          json: async () => validYahooChart(100.0, ASOF_TIMESTAMP_SEC),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };

    await fetchDxyDatumV2({ fetchFn: trackingFetch, fetchedAt: FETCHED_AT });
    await fetchUs10yDatumV2({ fetchFn: trackingFetch, fetchedAt: FETCHED_AT });
    await fetchUs2yDatumV2({ fetchFn: trackingFetch, fetchedAt: FETCHED_AT });
    await fetchVixDatumV2({ fetchFn: trackingFetch, fetchedAt: FETCHED_AT });

    expect(requestedUrls.every((url) => url.startsWith("/api/yahoo/"))).toBe(true);
    expect(requestedUrls.some((url) => url.includes("query1.finance.yahoo.com"))).toBe(false);
  });

  // 18. Gate M5C: Failed /api/yahoo request returns UNAVAILABLE without direct fallback or synthetic defaults
  it("18. Failed /api/yahoo request returns UNAVAILABLE without direct query1 fallback or synthetic defaults", async () => {
    const requestedUrls: string[] = [];
    const failingFetch: FetchFn = async (url: string): Promise<FetchResponse> => {
      requestedUrls.push(url);
      return { ok: false, status: 404, json: async () => ({ error: "Not found" }) };
    };

    const dxy = await fetchDxyDatumV2({ fetchFn: failingFetch, fetchedAt: FETCHED_AT });
    const vnindex = await fetchVnIndexDatumV2({ fetchFn: failingFetch, fetchedAt: FETCHED_AT });

    expect(dxy.status).toBe("UNAVAILABLE");
    expect(dxy.value).toBeNull();
    expect(vnindex.status).toBe("UNAVAILABLE");
    expect(vnindex.value).toBeNull();

    expect(requestedUrls.every((url) => url.startsWith("/api/yahoo/") || url.startsWith("/api/vndirect/"))).toBe(true);
    expect(requestedUrls.some((url) => url.includes("query1.finance.yahoo.com"))).toBe(false);
  });

  // 19. Gate M5C: BTC and Gold use Binance primary and fallback only to /api/yahoo
  it("19. BTC and Gold use Binance primary and fallback only to /api/yahoo", async () => {
    const requestedUrls: string[] = [];
    const fallbackFetch: FetchFn = async (url: string): Promise<FetchResponse> => {
      requestedUrls.push(url);
      if (url.includes("binance")) {
        return { ok: false, status: 500, json: async () => ({}) };
      }
      if (url.includes("/api/yahoo")) {
        return { ok: true, status: 200, json: async () => validYahooChart(2000.0, ASOF_TIMESTAMP_SEC) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };

    const gold = await fetchGoldDatumV2({ fetchFn: fallbackFetch, fetchedAt: FETCHED_AT });

    expect(gold.status).toBe("AVAILABLE");
    if (gold.status === "AVAILABLE") {
      expect(gold.provider).toBe("Yahoo");
    }
    expect(requestedUrls.some((url) => url.includes("/api/yahoo/"))).toBe(true);
    expect(requestedUrls.some((url) => url.includes("query1.finance.yahoo.com"))).toBe(false);
  });
});
