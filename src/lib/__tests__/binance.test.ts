import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchBtcKlines } from "../binance";
import { getMarketSourceLabel, useMarketStore } from "@/stores/marketStore";
import { useTradingStore } from "@/stores/tradingStore";

const BASE_OPEN_TIME = 1_700_000_000_000;
const HOUR_MS = 3_600_000;

const gatewayBars = (close: string, count = 60, start = BASE_OPEN_TIME) => Array.from({ length: count }, (_, index) => {
  const openTime = start + index * HOUR_MS;
  return [
    openTime,
    close,
    String(Number(close) + 100),
    String(Number(close) - 100),
    close,
    "100",
    openTime + HOUR_MS - 1,
    "100",
    1,
    "0",
    "0",
    "0",
  ];
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const marketResponse = (close: string) => new Response(
  JSON.stringify(gatewayBars(close)),
  { status: 200, headers: { "Content-Type": "application/json" } },
);

describe("active Binance market feed boundary", () => {
  afterEach(() => {
    useTradingStore.getState().reset();
    useMarketStore.setState({
      bars: [],
      source: null,
      interval: "1h",
      loading: false,
      lastPrice: 0,
      error: null,
      refreshedAt: null,
    });
    vi.unstubAllGlobals();
  });

  it("does not claim synthetic provenance before any market evidence exists", () => {
    expect(useMarketStore.getState().bars).toEqual([]);
    expect(useMarketStore.getState().lastPrice).toBe(0);
    expect(useMarketStore.getState().source).toBeNull();
    expect(getMarketSourceLabel(null)).toBe("FEED: UNAVAILABLE");
    expect(getMarketSourceLabel("live")).toBe("FEED: LIVE BINANCE");
    expect(getMarketSourceLabel("synthetic")).toBe("FEED: SYNTHETIC");
  });

  it("uses only the same-origin gateway route", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("/api/binance/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=500");
      return new Response(
        JSON.stringify(gatewayBars("76050")),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchBtcKlines("1h", 500);

    expect(result.source).toBe("live");
    expect(result.bars).toHaveLength(60);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("publishes only candles whose canonical availability boundary has passed", async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify(gatewayBars("76050")),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const openCandleObservation = BASE_OPEN_TIME + 59 * HOUR_MS + HOUR_MS / 2;
    const openCandleResult = await fetchBtcKlines("1h", 500, openCandleObservation);
    expect(openCandleResult.bars).toHaveLength(59);
    expect(openCandleResult.bars.at(-1)?.time).toBe(Math.floor((BASE_OPEN_TIME + 58 * HOUR_MS) / 1000));

    const closeTimeObservation = BASE_OPEN_TIME + 60 * HOUR_MS - 1;
    const beforeBoundaryResult = await fetchBtcKlines("1h", 500, closeTimeObservation);
    expect(beforeBoundaryResult.bars).toHaveLength(59);

    const boundaryResult = await fetchBtcKlines("1h", 500, BASE_OPEN_TIME + 60 * HOUR_MS);
    expect(boundaryResult.bars).toHaveLength(60);
  });

  it("retains closed bars beside an open candle without synthesizing a replacement", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify(gatewayBars("76050")),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )));

    const result = await fetchBtcKlines("1h", 500, BASE_OPEN_TIME + 59 * HOUR_MS + HOUR_MS / 2);

    expect(result.source).toBe("live");
    expect(result.bars).toHaveLength(59);
    expect(result.bars.at(-1)?.close).toBe(76050);
    expect(result.bars.some((bar) => bar.time === Math.floor((BASE_OPEN_TIME + 59 * HOUR_MS) / 1000))).toBe(false);
  });

  it("rejects malformed candle boundaries and responses with no usable closed evidence", async () => {
    const malformed = gatewayBars("76050");
    malformed[10][6] = Number(malformed[10][6]) - 1;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(malformed), { status: 200 }))
      .mockResolvedValueOnce(new Response(
        JSON.stringify(gatewayBars("76050", 60, BASE_OPEN_TIME + 100 * HOUR_MS)),
        { status: 200 },
      ));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchBtcKlines("1h", 500, BASE_OPEN_TIME + 60 * HOUR_MS)).rejects.toThrow("BTC market feed unavailable.");
    await expect(fetchBtcKlines("1h", 500, BASE_OPEN_TIME)).rejects.toThrow("BTC market feed unavailable.");
  });

  it("fails closed without synthetic bars when the gateway is unavailable", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toMatch(/^\/api\/binance\//);
      return new Response("", { status: 502 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchBtcKlines("1h", 500)).rejects.toThrow("BTC market feed unavailable.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("recovers from provider failure without synthetic replacement or stale trading state", async () => {
    const responses = [
      marketResponse("76050"),
      new Response("", { status: 502 }),
      marketResponse("76150"),
    ];
    vi.stubGlobal("fetch", vi.fn(async () => responses.shift()!));

    await useMarketStore.getState().load("1h");
    expect(useMarketStore.getState().source).toBe("live");
    expect(useMarketStore.getState().bars).toHaveLength(60);
    expect(useMarketStore.getState().lastPrice).toBe(76050);
    expect(useMarketStore.getState().error).toBeNull();

    const staleBars = Array.from({ length: 140 }, (_, index) => ({
      time: 1_700_000_000 + index * 3_600,
      open: 70_000 + index,
      high: 70_100 + index,
      low: 69_900 + index,
      close: 70_050 + index,
      volume: 100,
    }));
    useTradingStore.getState().runOnBars(staleBars, { interval: "1h", source: "live" });
    expect(useTradingStore.getState().latestDecision).not.toBeNull();

    await useMarketStore.getState().load("1h");
    expect(useMarketStore.getState().bars).toEqual([]);
    expect(useMarketStore.getState().lastPrice).toBe(0);
    expect(useMarketStore.getState().source).toBeNull();
    expect(useMarketStore.getState().error).toBe("BTC market feed unavailable.");
    expect(useTradingStore.getState().latestDecision).toBeNull();
    expect(useTradingStore.getState().actionDecision).toBeNull();

    await useMarketStore.getState().load("1h");
    expect(useMarketStore.getState().bars).toHaveLength(60);
    expect(useMarketStore.getState().lastPrice).toBe(76150);
    expect(useMarketStore.getState().source).toBe("live");
    expect(useMarketStore.getState().error).toBeNull();
  });

  it("keeps the newer successful request authoritative over a stale success", async () => {
    const requestA = deferred<Response>();
    const requestB = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn()
      .mockImplementationOnce(() => requestA.promise)
      .mockImplementationOnce(() => requestB.promise));

    const loadA = useMarketStore.getState().load("1h");
    const loadB = useMarketStore.getState().load("1h");
    requestB.resolve(marketResponse("81000"));
    await loadB;
    requestA.resolve(marketResponse("80000"));
    await loadA;

    expect(useMarketStore.getState().lastPrice).toBe(81000);
    expect(useMarketStore.getState().source).toBe("live");
    expect(useMarketStore.getState().error).toBeNull();
    expect(useMarketStore.getState().loading).toBe(false);
  });

  it("keeps newer evidence after a stale request fails", async () => {
    const requestA = deferred<Response>();
    const requestB = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn()
      .mockImplementationOnce(() => requestA.promise)
      .mockImplementationOnce(() => requestB.promise));

    const loadA = useMarketStore.getState().load("1h");
    const loadB = useMarketStore.getState().load("1h");
    requestB.resolve(marketResponse("82000"));
    await loadB;
    requestA.reject(new Error("stale provider failure"));
    await loadA;

    expect(useMarketStore.getState().lastPrice).toBe(82000);
    expect(useMarketStore.getState().bars).toHaveLength(60);
    expect(useMarketStore.getState().error).toBeNull();
  });

  it("does not resurrect stale evidence after the current request fails", async () => {
    const requestA = deferred<Response>();
    const requestB = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn()
      .mockImplementationOnce(() => requestA.promise)
      .mockImplementationOnce(() => requestB.promise));

    const loadA = useMarketStore.getState().load("1h");
    const loadB = useMarketStore.getState().load("1h");
    requestB.reject(new Error("current provider failure"));
    await loadB;
    requestA.resolve(marketResponse("83000"));
    await loadA;

    expect(useMarketStore.getState().bars).toEqual([]);
    expect(useMarketStore.getState().lastPrice).toBe(0);
    expect(useMarketStore.getState().source).toBeNull();
    expect(useMarketStore.getState().error).toBe("BTC market feed unavailable.");
    expect(useMarketStore.getState().loading).toBe(false);
  });

  it("allows a new request to recover after a current failure", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockRejectedValueOnce(new Error("current provider failure"))
      .mockResolvedValueOnce(marketResponse("84000")));

    await useMarketStore.getState().load("1h");
    expect(useMarketStore.getState().source).toBeNull();
    expect(useMarketStore.getState().error).toBe("BTC market feed unavailable.");

    await useMarketStore.getState().load("1h");
    expect(useMarketStore.getState().source).toBe("live");
    expect(useMarketStore.getState().lastPrice).toBe(84000);
    expect(useMarketStore.getState().error).toBeNull();
  });
});
