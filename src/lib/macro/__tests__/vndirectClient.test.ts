// ============================================================================
// FILE: src/lib/macro/__tests__/vndirectClient.test.ts
// MODULE: VNDIRECT TRANSPORT CLIENT UNIT TESTS (GATE M6E-2)
// PRINCIPLE: Mock Network Verification of Bounded Pagination & Fail-Closed Transport
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchPaginatedVndirectFinfo,
  fetchVndirectDchart,
  fetchVndirectFinfo,
  MAX_TRANSPORT_PAGINATION_PAGES,
} from "../vndirectClient";

describe("VNDirect Transport Client & Dev Gateway Contract (Gate M6E-2)", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("A. FINfo one-page success returns all rows when totalPages is 1", async () => {
    const mockRows = [{ code: "AAA" }, { code: "BBB" }];
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: mockRows,
        currentPage: 1,
        size: 500,
        totalElements: 2,
        totalPages: 1,
      }),
    } as unknown as Response);

    const result = await fetchPaginatedVndirectFinfo<{ code: string }>("/v4/stock_prices?q=floor:HOSE");

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(mockRows);
      expect(result.url).toContain("/api/vndirect/finfo/v4/stock_prices");
      expect(global.fetch).toHaveBeenCalledTimes(1);
    }
  });

  it("B. FINfo multi-page success preserves all rows across pages in order", async () => {
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("page=1")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [{ code: "STOCK_1" }, { code: "STOCK_2" }],
            currentPage: 1,
            size: 2,
            totalElements: 5,
            totalPages: 3,
          }),
        } as unknown as Response;
      }
      if (url.includes("page=2")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [{ code: "STOCK_3" }, { code: "STOCK_4" }],
            currentPage: 2,
            size: 2,
            totalElements: 5,
            totalPages: 3,
          }),
        } as unknown as Response;
      }
      if (url.includes("page=3")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [{ code: "STOCK_5" }],
            currentPage: 3,
            size: 2,
            totalElements: 5,
            totalPages: 3,
          }),
        } as unknown as Response;
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const result = await fetchPaginatedVndirectFinfo<{ code: string }>("/v4/stock_prices?q=floor:HOSE");

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(5);
      expect(result.data.map((r) => r.code)).toEqual(["STOCK_1", "STOCK_2", "STOCK_3", "STOCK_4", "STOCK_5"]);
      expect(global.fetch).toHaveBeenCalledTimes(3);
    }
  });

  it("C. Page N failure fails the entire operation immediately without returning partial rows", async () => {
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("page=1")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [{ code: "STOCK_1" }],
            currentPage: 1,
            totalPages: 2,
          }),
        } as unknown as Response;
      }
      if (url.includes("page=2")) {
        return {
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
        } as unknown as Response;
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const result = await fetchPaginatedVndirectFinfo<{ code: string }>("/v4/stock_prices?q=floor:HOSE");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe("HTTP_ERROR");
      expect(result.statusCode).toBe(500);
    }
  });

  it("D. Malformed totalPages fails closed with INVALID_PAGINATION", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [{ code: "AAA" }],
        totalPages: "invalid_string", // Non-numeric totalPages
      }),
    } as unknown as Response);

    const result = await fetchPaginatedVndirectFinfo<{ code: string }>("/v4/stock_prices");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe("INVALID_PAGINATION");
    }
  });

  it("E. Pagination guard exceeded fails closed with PAGINATION_GUARD_EXCEEDED", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [{ code: "AAA" }],
        totalPages: MAX_TRANSPORT_PAGINATION_PAGES + 1, // Exceeds cap (51 > 50)
      }),
    } as unknown as Response);

    const result = await fetchPaginatedVndirectFinfo<{ code: string }>("/v4/stock_prices");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe("PAGINATION_GUARD_EXCEEDED");
    }
  });

  it("F. Malformed JSON fails closed with MALFORMED_JSON", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token in JSON");
      },
    } as unknown as Response);

    const result = await fetchVndirectFinfo("/v4/stock_prices");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe("MALFORMED_JSON");
    }
  });

  it("G. Client uses same-origin routes and never attempts direct fallback to VNDirect external domains", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
    } as unknown as Response);
    global.fetch = fetchSpy;

    const result = await fetchVndirectFinfo("/v4/stocks");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe("HTTP_ERROR");
      expect(result.url).toBe("/api/vndirect/finfo/v4/stocks");
    }

    // Verify fetch was called EXACTLY ONCE and strictly with same-origin URL
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const calledUrl = fetchSpy.mock.calls[0][0] as string;
    expect(calledUrl).toMatch(/^\/api\/vndirect\/finfo/);
    expect(calledUrl).not.toContain("api-finfo.vndirect.com.vn");
  });

  it("H. DChart client helper routes cleanly to same-origin dchart endpoint", async () => {
    const mockDchartData = { t: [1700000000], c: [1250.5] };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockDchartData,
    } as unknown as Response);

    const result = await fetchVndirectDchart<typeof mockDchartData>("/dchart/history?symbol=VNINDEX&resolution=D");

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(mockDchartData);
      expect(result.url).toBe("/api/vndirect/dchart/dchart/history?symbol=VNINDEX&resolution=D");
    }
  });
});
