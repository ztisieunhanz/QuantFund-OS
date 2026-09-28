import { describe, expect, it, vi } from "vitest";
import {
  handleMarketGatewayRequest,
  MARKET_GATEWAY_MAX_UPSTREAM_BODY_BYTES,
  type MarketGatewayRequest,
} from "../marketGateway";

function request(
  pathname: string,
  query: string,
  method = "GET"
): MarketGatewayRequest {
  return { method, pathname, query: new URLSearchParams(query) };
}

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const validBinancePayload = [[
  1_700_000_000_000,
  "100.00",
  "101.00",
  "99.00",
  "100.50",
  "12.5",
  1_700_000_060_000,
  "1256.25",
  10,
  "5.0",
  "7.0",
  "0",
]];

const validYahooPayload = {
  chart: {
    result: [{
      timestamp: [1_700_000_000],
      indicators: { quote: [{ close: [100] }] },
    }],
  },
};

const validDchartPayload = {
  s: "ok",
  t: [1_700_000_000, 1_700_086_400],
  c: [1_250, 1_260],
};

describe("M16-E1C1 runtime-neutral market gateways", () => {
  it("maps valid Binance requests to the fixed upstream and preserves payload shape", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response(validBinancePayload));
    const result = await handleMarketGatewayRequest(
      request("/api/binance/api/v3/klines", "symbol=BTCUSDT&interval=1h&limit=500"),
      { fetchFn }
    );

    expect(result).toEqual({ statusCode: 200, body: validBinancePayload });
    expect(fetchFn.mock.calls[0][0]).toBe(
      "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=500"
    );
  });

  it("rejects Binance symbols, intervals, limits, and extra query keys", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    for (const query of [
      "symbol=ETHUSDT&interval=1h&limit=500",
      "symbol=BTCUSDT&interval=2h&limit=500",
      "symbol=BTCUSDT&interval=1h&limit=59",
      "symbol=BTCUSDT&interval=1h&limit=300",
      "symbol=BTCUSDT&interval=1h&limit=500&host=https://evil.invalid",
    ]) {
      const result = await handleMarketGatewayRequest(request("/api/binance/api/v3/klines", query), { fetchFn });
      expect(result).toMatchObject({ statusCode: 400, body: { error: { code: "INVALID_REQUEST" } } });
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("fails Binance provider errors and malformed success payloads closed", async () => {
    const rejectedFetch = vi.fn<typeof fetch>().mockResolvedValue(response({ message: "secret-provider-error" }, 503));
    const rejected = await handleMarketGatewayRequest(
      request("/api/binance/api/v3/klines", "symbol=PAXGUSDT&interval=1d&limit=250"),
      { fetchFn: rejectedFetch }
    );
    expect(rejected).toMatchObject({ statusCode: 502, body: { error: { code: "UPSTREAM_FAILURE" } } });
    expect(JSON.stringify(rejected)).not.toContain("secret-provider-error");

    const malformedFetch = vi.fn<typeof fetch>().mockResolvedValue(response({ nope: true }));
    const malformed = await handleMarketGatewayRequest(
      request("/api/binance/api/v3/klines", "symbol=BTCUSDT&interval=1d&limit=250"),
      { fetchFn: malformedFetch }
    );
    expect(malformed).toMatchObject({ statusCode: 502, body: { error: { code: "MALFORMED_UPSTREAM_RESPONSE" } } });
  });

  it("allows only application Yahoo symbols and the fixed interval/range contract", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response(validYahooPayload));
    const result = await handleMarketGatewayRequest(
      request("/api/yahoo/v8/finance/chart/^VNINDEX", "interval=1d&range=2y"),
      { fetchFn }
    );
    expect(result).toEqual({ statusCode: 200, body: validYahooPayload });
    expect(fetchFn.mock.calls[0][0]).toBe(
      "https://query1.finance.yahoo.com/v8/finance/chart/%5EVNINDEX?interval=1d&range=2y"
    );

    for (const [pathname, query] of [
      ["/api/yahoo/v8/finance/chart/UNKNOWN", "interval=1d&range=2y"],
      ["/api/yahoo/v8/finance/chart/^VIX", "interval=1h&range=2y"],
      ["/api/yahoo/v8/finance/chart/^VIX", "interval=1d&range=1y"],
      ["/api/yahoo/v8/finance/chart/^VIX", "interval=1d&range=2y&foo=bar"],
    ]) {
      const invalid = await handleMarketGatewayRequest(request(pathname, query), { fetchFn });
      expect(invalid).toMatchObject({ statusCode: 400, body: { error: { code: "INVALID_REQUEST" } } });
    }
  });

  it("fails malformed Yahoo payloads closed", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response({ chart: { result: null } }));
    const result = await handleMarketGatewayRequest(
      request("/api/yahoo/v8/finance/chart/BTC-USD", "interval=1d&range=2y"),
      { fetchFn }
    );
    expect(result).toMatchObject({ statusCode: 502, body: { error: { code: "MALFORMED_UPSTREAM_RESPONSE" } } });
  });

  it("represents the three bounded FINfo resources with application query grammar", async () => {
    const cases = [
      [
        "/api/vndirect/finfo/v4/stocks",
        "q=floor%3AHOSE~type%3ASTOCK~status%3Alisted&size=500&page=1",
        { data: [{ code: "AAA" }], totalPages: 1 },
      ],
      [
        "/api/vndirect/finfo/v4/stock_prices",
        "q=floor%3AHOSE~type%3ASTOCK&sort=date%3Adesc&size=1",
        [{ code: "AAA", date: "2026-07-02" }],
      ],
      [
        "/api/vndirect/finfo/v4/foreigns",
        "q=floor%3AHOSE~type%3ASTOCK~tradingDate%3A2026-07-02&size=500&page=1",
        { data: [{ code: "AAA" }], totalPages: 1 },
      ],
    ] as const;

    for (const [pathname, query, payload] of cases) {
      const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response(payload));
      const result = await handleMarketGatewayRequest(request(pathname, query), { fetchFn });
      expect(result).toEqual({ statusCode: 200, body: payload });
      expect(fetchFn.mock.calls[0][0]).toContain("https://api-finfo.vndirect.com.vn/v4/");
    }
  });

  it("rejects unknown FINfo resources and unsafe query grammar", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const unknown = await handleMarketGatewayRequest(
      request("/api/vndirect/finfo/v4/accounts", "q=floor%3AHOSE&size=500"),
      { fetchFn }
    );
    const unsafe = await handleMarketGatewayRequest(
      request("/api/vndirect/finfo/v4/stocks", "q=anything&size=500&page=1&url=https%3A%2F%2Fevil.invalid"),
      { fetchFn }
    );
    const invalidDate = await handleMarketGatewayRequest(
      request("/api/vndirect/finfo/v4/foreigns", "q=floor%3AHOSE~type%3ASTOCK~tradingDate%3A2026-99-99&size=500&page=1"),
      { fetchFn }
    );
    expect(unknown).toMatchObject({ statusCode: 404, body: { error: { code: "INVALID_REQUEST" } } });
    expect(unsafe).toMatchObject({ statusCode: 400, body: { error: { code: "INVALID_REQUEST" } } });
    expect(invalidDate).toMatchObject({ statusCode: 400, body: { error: { code: "INVALID_REQUEST" } } });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("validates the fixed VNDirect DChart history request and payload", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response(validDchartPayload));
    const result = await handleMarketGatewayRequest(
      request("/api/vndirect/dchart/history", "symbol=VNINDEX&resolution=D"),
      { fetchFn }
    );
    expect(result).toEqual({ statusCode: 200, body: validDchartPayload });
    expect(fetchFn.mock.calls[0][0]).toBe(
      "https://dchart-api.vndirect.com.vn/dchart/history?symbol=VNINDEX&resolution=D"
    );

    for (const query of [
      "symbol=HNXINDEX&resolution=D",
      "symbol=VNINDEX&resolution=60",
      "symbol=VNINDEX&resolution=D&from=1",
    ]) {
      const invalid = await handleMarketGatewayRequest(
        request("/api/vndirect/dchart/history", query),
        { fetchFn }
      );
      expect(invalid).toMatchObject({ statusCode: 400, body: { error: { code: "INVALID_REQUEST" } } });
    }
  });

  it("rejects non-GET provider requests and awaits a deterministic timeout", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation((_input, init) => (
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("provider timeout")), { once: true });
      })
    ));
    const methodResult = await handleMarketGatewayRequest(
      request("/api/binance/api/v3/klines", "symbol=BTCUSDT&interval=1h&limit=500", "POST"),
      { fetchFn }
    );
    const timeoutResult = await handleMarketGatewayRequest(
      request("/api/yahoo/v8/finance/chart/BTC-USD", "interval=1d&range=2y"),
      { fetchFn, upstreamTimeoutMs: 5 }
    );
    expect(methodResult).toMatchObject({ statusCode: 405, body: { error: { code: "INVALID_REQUEST" } } });
    expect(timeoutResult).toMatchObject({ statusCode: 502, body: { error: { code: "UPSTREAM_FAILURE" } } });
  });

  it("fails closed when an upstream response exceeds 1 MiB", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("x".repeat(MARKET_GATEWAY_MAX_UPSTREAM_BODY_BYTES + 1), { status: 200 })
    );
    const result = await handleMarketGatewayRequest(
      request("/api/binance/api/v3/klines", "symbol=BTCUSDT&interval=1d&limit=250"),
      { fetchFn }
    );
    expect(result).toMatchObject({ statusCode: 502, body: { error: { code: "MALFORMED_UPSTREAM_RESPONSE" } } });
  });
});
