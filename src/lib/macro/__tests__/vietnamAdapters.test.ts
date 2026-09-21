// ============================================================================
// FILE: src/lib/macro/__tests__/vietnamAdapters.test.ts
// MODULE: VIETNAM LAYER 1 ADAPTER INTEGRATION UNIT TESTS (GATE M6E-4)
// PRINCIPLE: Deterministic Verification of VNDirect Adapters, History, and Session Isolation
// ============================================================================

import { beforeEach, describe, expect, it } from "vitest";
import {
  type FetchFn,
  type FetchResponse,
  fetchVietnamBreadthV2,
  fetchVietnamForeignFlowV2,
  fetchVietnamLiquidityV2,
  fetchVnIndexDatumV2,
  resetVietnamAdapterCaches,
} from "../adapters";
import { MACRO_V2_CONFIG } from "../config";
import { evaluateMacroRegimeV2 } from "../interpretation";
import type { MarketSnapshotData } from "../types";

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

describe("Vietnam Layer 1 Adapter Integration (Gate M6E-4)", () => {
  const FETCHED_AT = 1_700_100_000_000;
  const SESSION_DATE = "2026-07-02";

  const validSecurityMasterPayload = {
    data: [
      { code: "AAA", floor: "HOSE", type: "STOCK", status: "listed" },
      { code: "BBB", floor: "HOSE", type: "STOCK", status: "listed" },
    ],
    currentPage: 1,
    totalPages: 1,
  };

  const validStockPricesPayload = {
    data: [
      { code: "AAA", date: SESSION_DATE, close: 20.0, basicPrice: 19.0, nmValue: 10e9, ptValue: 50e9 },
      { code: "BBB", date: SESSION_DATE, close: 18.0, basicPrice: 19.0, nmValue: 20e9, ptValue: 0 },
    ],
    currentPage: 1,
    totalPages: 1,
  };

  const validDchartPayload = {
    s: "ok",
    t: [1700000000, 1700086400],
    c: [1240.5, 1250.8],
  };

  beforeEach(() => {
    resetVietnamAdapterCaches();
  });

  it("A. VNINDEX valid DChart response returns LIVE VNDirect VNINDEX datum", async () => {
    const fetchFn = createMockFetch({
      "/api/vndirect/dchart/history": { data: validDchartPayload },
    });

    const datum = await fetchVnIndexDatumV2({ fetchFn, fetchedAt: FETCHED_AT });

    expect(datum.status).toBe("AVAILABLE");
    if (datum.status === "AVAILABLE") {
      expect(datum.sourceClassification).toBe("LIVE");
      expect(datum.provider).toBe("VNDirect");
      expect(datum.instrument).toBe("VNINDEX");
      expect(datum.value).toBe(1250.8);
      expect(datum.asOf).toBe(1700086400 * 1000);
      expect(datum.basis).toBe("SPOT_INDEX");
    }
  });

  it("B. VNINDEX failed DChart response returns UNAVAILABLE without Yahoo/synthetic fallback", async () => {
    const requestedUrls: string[] = [];
    const failingFetch: FetchFn = async (url: string) => {
      requestedUrls.push(url);
      return { ok: false, status: 500, json: async () => ({}) };
    };

    const datum = await fetchVnIndexDatumV2({ fetchFn: failingFetch, fetchedAt: FETCHED_AT });

    expect(datum.status).toBe("UNAVAILABLE");
    expect(datum.value).toBeNull();
    // Verify no Yahoo fallback requested
    expect(requestedUrls.some((u) => u.includes("/api/yahoo"))).toBe(false);
  });

  it("C & E. Complete Security Master & stock_prices payload produces available breadth datum", async () => {
    const fetchFn = createMockFetch({
      "/v4/stocks": { data: validSecurityMasterPayload },
      "/v4/stock_prices": { data: validStockPricesPayload },
    });

    const breadth = await fetchVietnamBreadthV2({ fetchFn, fetchedAt: FETCHED_AT });

    expect(breadth.status).toBe("AVAILABLE");
    if (breadth.status === "AVAILABLE") {
      expect(breadth.sourceClassification).toBe("LIVE");
      expect(breadth.provider).toBe("VNDirect");
      expect(breadth.instrument).toBe("HOSE_BREADTH");
      expect(breadth.value.advancing).toBe(1);
      expect(breadth.value.declining).toBe(1);
      expect(breadth.value.adRatio).toBe(1.0);
      // Cold-start history has 1 bar (< 20) -> MA fields evaluate to null cleanly
      expect(breadth.value.pctAboveMA20).toBeNull();
      expect(breadth.value.pctAboveMA50).toBeNull();
      expect(breadth.value.pctAboveMA200).toBeNull();
    }
  });

  it("D. Incomplete/malformed Security Master causes breadth, liquidity, foreignFlow to fail closed", async () => {
    const fetchFn = createMockFetch({
      "/v4/stocks": { status: 500, data: { error: "Security Master failed" } },
    });

    const breadth = await fetchVietnamBreadthV2({ fetchFn, fetchedAt: FETCHED_AT });
    const liquidity = await fetchVietnamLiquidityV2({ fetchFn, fetchedAt: FETCHED_AT });
    const foreignFlow = await fetchVietnamForeignFlowV2({ fetchFn, fetchedAt: FETCHED_AT });

    expect(breadth.status).toBe("UNAVAILABLE");
    expect(liquidity.status).toBe("UNAVAILABLE");
    expect(foreignFlow.status).toBe("UNAVAILABLE");
  });

  it("G. Cold/incomplete MA history results in null MA fields without fabrication", async () => {
    const fetchFn = createMockFetch({
      "/v4/stocks": { data: validSecurityMasterPayload },
      "/v4/stock_prices": { data: validStockPricesPayload },
    });

    const breadth = await fetchVietnamBreadthV2({ fetchFn, fetchedAt: FETCHED_AT });

    expect(breadth.status).toBe("AVAILABLE");
    if (breadth.status === "AVAILABLE") {
      expect(breadth.value.advancing).toBe(1);
      expect(breadth.value.pctAboveMA20).toBeNull();
      expect(breadth.value.pctAboveMA50).toBeNull();
      expect(breadth.value.pctAboveMA200).toBeNull();
    }
  });

  it("H & K. Liquidity uses nmValue, requires 20 completed sessions, and status remains null", async () => {
    // Generate 20 dates and DChart timestamps
    const timestamps: number[] = [];
    const routeMap: Record<string, { status?: number; data: unknown }> = {
      "/v4/stocks": { data: validSecurityMasterPayload },
    };

    for (let i = 1; i <= 20; i++) {
      const dayStr = String(i).padStart(2, "0");
      const date = `2026-06-${dayStr}`;
      const stamp = Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000);
      timestamps.push(stamp);

      routeMap[`/v4/stock_prices?q=floor:HOSE~type:STOCK~date:${date}`] = {
        data: {
          data: [
            { code: "AAA", date, close: 20.0, basicPrice: 19.0, nmValue: 10e9, ptValue: 50e9 },
            { code: "BBB", date, close: 18.0, basicPrice: 19.0, nmValue: 20e9, ptValue: 0 },
          ],
          currentPage: 1,
          totalPages: 1,
        },
      };
    }

    // Default probe route
    routeMap["/v4/stock_prices?q=floor:HOSE~type:STOCK&sort=date:desc&size=1"] = {
      data: {
        data: [{ code: "AAA", date: "2026-06-20", close: 20.0, basicPrice: 19.0, nmValue: 10e9, ptValue: 50e9 }],
      },
    };

    // 19 sessions DChart calendar
    routeMap["/api/vndirect/dchart/history"] = {
      data: {
        s: "ok",
        t: timestamps.slice(0, 19),
        c: Array(19).fill(1200),
      },
    };

    const fetchFn19 = createMockFetch(routeMap);
    const liq19 = await fetchVietnamLiquidityV2({ fetchFn: fetchFn19, fetchedAt: FETCHED_AT });
    expect(liq19.status).toBe("UNAVAILABLE");

    // 20 sessions DChart calendar
    routeMap["/api/vndirect/dchart/history"] = {
      data: {
        s: "ok",
        t: timestamps,
        c: Array(20).fill(1200),
      },
    };

    const fetchFn20 = createMockFetch(routeMap);
    const liq20 = await fetchVietnamLiquidityV2({ fetchFn: fetchFn20, fetchedAt: FETCHED_AT });
    expect(liq20.status).toBe("AVAILABLE");
    if (liq20.status === "AVAILABLE") {
      expect(liq20.value.matchingValueBillion).toBe(30); // (10 + 20)
      expect(liq20.value.ma20ValueBillion).toBe(30);
      expect(liq20.value.ratioToMa20).toBe(1.0);
      expect(liq20.value.status).toBeNull(); // K: status remains null
      expect(liq20.basis).toBe("HOSE_COMMON_EQUITY_NORMAL_MATCHED_VALUE_BILLION_VND");
    }
  });

  it("I & K. Foreign flow uses netVal, requires 5 completed sessions, and can skip incomplete sessions", async () => {
    const timestamps: number[] = [];
    const routeMap: Record<string, { status?: number; data: unknown }> = {
      "/v4/stocks": { data: validSecurityMasterPayload },
    };

    for (let i = 1; i <= 6; i++) {
      const dayStr = String(i).padStart(2, "0");
      const date = `2026-06-${dayStr}`;
      const stamp = Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000);
      timestamps.push(stamp);

      // Session 3 is incomplete/missing foreign data
      if (i === 3) {
        routeMap[`/v4/foreigns?q=floor:HOSE~type:STOCK~tradingDate:${date}`] = {
          data: { data: [] },
        };
      } else {
        routeMap[`/v4/foreigns?q=floor:HOSE~type:STOCK~tradingDate:${date}`] = {
          data: {
            data: [
              { code: "AAA", tradingDate: date, netVal: 100e9 },
              { code: "BBB", tradingDate: date, netVal: 50e9 },
            ],
            currentPage: 1,
            totalPages: 1,
          },
        };
      }
    }

    routeMap["/api/vndirect/dchart/history"] = {
      data: {
        s: "ok",
        t: timestamps,
        c: Array(6).fill(1200),
      },
    };

    const fetchFn = createMockFetch(routeMap);
    const ff = await fetchVietnamForeignFlowV2({ fetchFn, fetchedAt: FETCHED_AT });

    expect(ff.status).toBe("AVAILABLE");
    if (ff.status === "AVAILABLE") {
      expect(ff.value.net1dBillion).toBe(150); // (100 + 50)
      expect(ff.value.net5dBillion).toBe(750); // 150 * 5 (skipping missing session 3)
      expect(ff.value.status).toBeNull(); // K: status remains null
      expect(ff.basis).toBe("HOSE_COMMON_EQUITY_FOREIGN_NET_VALUE_BILLION_VND");
    }
  });

  it("J. Independent session dates do not invalidate unrelated Vietnam datums", async () => {
    // VNINDEX returns date A, Breadth returns date B
    const fetchFn = createMockFetch({
      "/api/vndirect/dchart/history": { data: validDchartPayload },
      "/v4/stocks": { data: validSecurityMasterPayload },
      "/v4/stock_prices": { data: validStockPricesPayload },
    });

    const vnindex = await fetchVnIndexDatumV2({ fetchFn, fetchedAt: FETCHED_AT });
    const breadth = await fetchVietnamBreadthV2({ fetchFn, fetchedAt: FETCHED_AT });

    expect(vnindex.status).toBe("AVAILABLE");
    expect(breadth.status).toBe("AVAILABLE");
  });

  it("M. No synthetic or hardcoded fallback data returned when feeds fail", async () => {
    const failingFetch: FetchFn = async () => ({ ok: false, status: 500, json: async () => ({}) });

    const vnindex = await fetchVnIndexDatumV2({ fetchFn: failingFetch, fetchedAt: FETCHED_AT });
    const breadth = await fetchVietnamBreadthV2({ fetchFn: failingFetch, fetchedAt: FETCHED_AT });
    const liquidity = await fetchVietnamLiquidityV2({ fetchFn: failingFetch, fetchedAt: FETCHED_AT });
    const foreignFlow = await fetchVietnamForeignFlowV2({ fetchFn: failingFetch, fetchedAt: FETCHED_AT });

    expect(vnindex.status).toBe("UNAVAILABLE");
    expect(vnindex.value).toBeNull();

    expect(breadth.status).toBe("UNAVAILABLE");
    expect(breadth.value).toBeNull();

    expect(liquidity.status).toBe("UNAVAILABLE");
    expect(liquidity.value).toBeNull();

    expect(foreignFlow.status).toBe("UNAVAILABLE");
    expect(foreignFlow.value).toBeNull();
  });

  it("N. Vietnam metrics do not enter coreMetricIds or change macro regime scoring", async () => {
    expect(MACRO_V2_CONFIG.coreMetricIds).not.toContain("vnindex");
    expect(MACRO_V2_CONFIG.coreMetricIds).not.toContain("breadth");
    expect(MACRO_V2_CONFIG.coreMetricIds).not.toContain("liquidity");
    expect(MACRO_V2_CONFIG.coreMetricIds).not.toContain("foreignFlow");

    const baseSnapshot: MarketSnapshotData = {
      dxy: { status: "AVAILABLE", id: "dxy", value: 104.2, provider: "Yahoo", instrument: "DX-Y.NYB", asOf: FETCHED_AT, fetchedAt: FETCHED_AT, quality: "USABLE", sourceClassification: "LIVE" },
      us2y: { status: "AVAILABLE", id: "us2y", value: 4.2, provider: "Yahoo", instrument: "2YY=F", asOf: FETCHED_AT, fetchedAt: FETCHED_AT, quality: "USABLE", sourceClassification: "LIVE" },
      us10y: { status: "AVAILABLE", id: "us10y", value: 4.5, provider: "Yahoo", instrument: "^TNX", asOf: FETCHED_AT, fetchedAt: FETCHED_AT, quality: "USABLE", sourceClassification: "LIVE" },
      vix: { status: "AVAILABLE", id: "vix", value: 14.5, provider: "Yahoo", instrument: "^VIX", asOf: FETCHED_AT, fetchedAt: FETCHED_AT, quality: "USABLE", sourceClassification: "LIVE" },
      gold: { status: "UNAVAILABLE", id: "gold", value: null, provider: "Binance", instrument: "PAXGUSDT", quality: "UNAVAILABLE", sourceClassification: "UNAVAILABLE" },
      btc: { status: "UNAVAILABLE", id: "btc", value: null, provider: "Binance", instrument: "BTCUSDT", quality: "UNAVAILABLE", sourceClassification: "UNAVAILABLE" },
      vnindex: { status: "UNAVAILABLE", id: "vnindex", value: null, provider: "VNDirect", instrument: "VNINDEX", quality: "UNAVAILABLE", sourceClassification: "UNAVAILABLE" },
      breadth: { status: "UNAVAILABLE", id: "breadth", value: null, provider: "VNDirect", instrument: "HOSE_BREADTH", quality: "UNAVAILABLE", sourceClassification: "UNAVAILABLE" },
      liquidity: { status: "UNAVAILABLE", id: "liquidity", value: null, provider: "VNDirect", instrument: "HOSE_LIQUIDITY", quality: "UNAVAILABLE", sourceClassification: "UNAVAILABLE" },
      foreignFlow: { status: "UNAVAILABLE", id: "foreignFlow", value: null, provider: "VNDirect", instrument: "HOSE_FOREIGN_FLOW", quality: "UNAVAILABLE", sourceClassification: "UNAVAILABLE" },
    };

    const snapshotWithActiveVietnam: MarketSnapshotData = {
      ...baseSnapshot,
      vnindex: { status: "AVAILABLE", id: "vnindex", value: 1300.0, provider: "VNDirect", instrument: "VNINDEX", asOf: FETCHED_AT, fetchedAt: FETCHED_AT, quality: "USABLE", sourceClassification: "LIVE" },
      breadth: { status: "AVAILABLE", id: "breadth", value: { advancing: 250, declining: 100, unchanged: 50, adRatio: 2.5, pctAboveMA20: 80, pctAboveMA50: 75, pctAboveMA200: 70 }, provider: "VNDirect", instrument: "HOSE_BREADTH", asOf: FETCHED_AT, fetchedAt: FETCHED_AT, quality: "USABLE", sourceClassification: "LIVE" },
      liquidity: { status: "AVAILABLE", id: "liquidity", value: { matchingValueBillion: 25000, ma20ValueBillion: 20000, ratioToMa20: 1.25, status: null }, provider: "VNDirect", instrument: "HOSE_LIQUIDITY", asOf: FETCHED_AT, fetchedAt: FETCHED_AT, quality: "USABLE", sourceClassification: "LIVE" },
      foreignFlow: { status: "AVAILABLE", id: "foreignFlow", value: { net1dBillion: 500, net5dBillion: 1200, status: null }, provider: "VNDirect", instrument: "HOSE_FOREIGN_FLOW", asOf: FETCHED_AT, fetchedAt: FETCHED_AT, quality: "USABLE", sourceClassification: "LIVE" },
    };

    const baseAssessment = evaluateMacroRegimeV2(baseSnapshot, FETCHED_AT);
    const withVietnamAssessment = evaluateMacroRegimeV2(snapshotWithActiveVietnam, FETCHED_AT);

    expect(withVietnamAssessment.regime).toBe(baseAssessment.regime);
    expect(withVietnamAssessment.confidence).toBe(baseAssessment.confidence);
    expect(withVietnamAssessment.evidence).toEqual(baseAssessment.evidence);
    expect(withVietnamAssessment.conflicts).toEqual(baseAssessment.conflicts);
  });

  it("O. FINfo session-date telemetry asOf does not fabricate a 15:00 market-close timestamp", async () => {
    const fetchFn = createMockFetch({
      "/v4/stocks": { data: validSecurityMasterPayload },
      "/v4/stock_prices": { data: validStockPricesPayload },
    });

    const breadth = await fetchVietnamBreadthV2({ fetchFn, fetchedAt: FETCHED_AT });

    expect(breadth.status).toBe("AVAILABLE");
    if (breadth.status === "AVAILABLE") {
      expect(breadth.asOf).toBe(new Date("2026-07-02T00:00:00Z").getTime());
      const d = new Date(breadth.asOf);
      expect(d.getUTCHours()).toBe(0);
      expect(d.getUTCMinutes()).toBe(0);
      expect(d.getUTCSeconds()).toBe(0);
      expect(d.toISOString().slice(0, 10)).toBe("2026-07-02");
    }
  });
});
