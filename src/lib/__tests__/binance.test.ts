import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchBtcKlines } from "../binance";
import { getMarketSourceLabel, useMarketStore } from "@/stores/marketStore";
import { getStorageApi, useTradingStore } from "@/stores/tradingStore";

const BASE_OPEN_TIME = 1_700_000_000_000;
const HOUR_MS = 3_600_000;

const gatewayBars = (close: string, count = 60, start = BASE_OPEN_TIME, step = 0) => Array.from({ length: count }, (_, index) => {
  const openTime = start + index * HOUR_MS;
  const candleClose = Number(close) + index * step;
  return [
    openTime,
    String(candleClose),
    String(candleClose + 100),
    String(candleClose - 100),
    String(candleClose),
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

const marketResponse = (close: string, count = 60, step = 0) => new Response(
  JSON.stringify(gatewayBars(close, count, BASE_OPEN_TIME, step)),
  { status: 200, headers: { "Content-Type": "application/json" } },
);

const activeReplayBars = (basePrice: number) => Array.from({ length: 140 }, (_, index) => ({
  time: 1_700_000_000 + index * 3_600,
  open: basePrice + index,
  high: basePrice + 100 + index,
  low: basePrice - 100 + index,
  close: basePrice + 50 + index,
  volume: 100,
}));

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
      marketResponse("76150", 140, 1),
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
    const durableBeforeOutage = useTradingStore.getState();
    expect(durableBeforeOutage.latestDecision).not.toBeNull();
    expect(durableBeforeOutage.lifecycleCheckpoint).not.toBeNull();
    expect(durableBeforeOutage.actionDecision).not.toBeNull();
    const persistedBeforeOutage = JSON.parse(getStorageApi().getItem("quant_paper_engine_state")!);

    await useMarketStore.getState().load("1h");
    expect(useMarketStore.getState().bars).toEqual([]);
    expect(useMarketStore.getState().lastPrice).toBe(0);
    expect(useMarketStore.getState().source).toBeNull();
    expect(useMarketStore.getState().error).toBe("BTC market feed unavailable.");
    expect(useTradingStore.getState().latestDecision).toEqual(durableBeforeOutage.latestDecision);
    expect(useTradingStore.getState().lifecycleCheckpoint).toEqual(durableBeforeOutage.lifecycleCheckpoint);
    expect(useTradingStore.getState().actionDecision).toBeNull();
    expect(useTradingStore.getState().trend.status).toBeUndefined();
    const persistedDuringOutage = JSON.parse(getStorageApi().getItem("quant_paper_engine_state")!);
    expect(persistedDuringOutage.state.latestDecision).toEqual(persistedBeforeOutage.state.latestDecision);
    expect(persistedDuringOutage.state.lifecycleCheckpoint).toEqual(persistedBeforeOutage.state.lifecycleCheckpoint);

    await useMarketStore.getState().load("1h");
    expect(useMarketStore.getState().bars).toHaveLength(140);
    expect(useMarketStore.getState().lastPrice).toBe(76289);
    expect(useMarketStore.getState().source).toBe("live");
    expect(useMarketStore.getState().error).toBeNull();

    useTradingStore.getState().runOnBars(useMarketStore.getState().bars, { interval: "1h", source: "live" });
    expect(useTradingStore.getState().latestDecision).not.toBeNull();
    expect(useTradingStore.getState().actionDecision).not.toBeNull();
    expect(useTradingStore.getState().latestDecision).not.toEqual(durableBeforeOutage.latestDecision);
  });

  it("preserves a rehydrated lifecycle across the current provider outage", async () => {
    const durableBars = activeReplayBars(70_000);
    useTradingStore.getState().runOnBars(durableBars, { interval: "1h", source: "live" });
    const persistedBeforeRestart = getStorageApi().getItem("quant_paper_engine_state")!;
    const beforeRestart = useTradingStore.getState();
    expect(beforeRestart.latestDecision).not.toBeNull();
    expect(beforeRestart.lifecycleCheckpoint).not.toBeNull();
    expect(beforeRestart.actionDecision).not.toBeNull();

    useTradingStore.getState().reset();
    getStorageApi().setItem("quant_paper_engine_state", persistedBeforeRestart);
    await useTradingStore.persist.rehydrate();

    const restored = useTradingStore.getState();
    expect(restored.isRestored).toBe(true);
    expect(restored.latestDecision).toEqual(beforeRestart.latestDecision);
    expect(restored.lifecycleCheckpoint).toEqual(beforeRestart.lifecycleCheckpoint);
    expect(restored.actionDecision).not.toBeNull();
    const restoredDecision = restored.latestDecision;
    const restoredCheckpoint = restored.lifecycleCheckpoint;
    const restoredLastRunAt = restored.lastRunAt;

    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 502 })));
    await useMarketStore.getState().load("1h");

    expect(useMarketStore.getState().bars).toEqual([]);
    expect(useMarketStore.getState().lastPrice).toBe(0);
    expect(useMarketStore.getState().source).toBeNull();
    expect(useMarketStore.getState().error).toBe("BTC market feed unavailable.");
    expect(useTradingStore.getState().actionDecision).toBeNull();
    expect(useTradingStore.getState().latestDecision).toEqual(restoredDecision);
    expect(useTradingStore.getState().lifecycleCheckpoint).toEqual(restoredCheckpoint);
    expect(useTradingStore.getState().lastRunAt).toBe(restoredLastRunAt);

    const persistedAfterOutage = JSON.parse(getStorageApi().getItem("quant_paper_engine_state")!);
    expect(persistedAfterOutage.state.latestDecision).toEqual(JSON.parse(persistedBeforeRestart).state.latestDecision);
    expect(persistedAfterOutage.state.lifecycleCheckpoint).toEqual(JSON.parse(persistedBeforeRestart).state.lifecycleCheckpoint);
    expect(persistedAfterOutage.state.lastRunAt).toBe(JSON.parse(persistedBeforeRestart).state.lastRunAt);
    expect(persistedAfterOutage.state.actionDecision).toBeUndefined();
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

  it("does not let a stale failure invalidate B's active trading state", async () => {
    const requestA = deferred<Response>();
    const requestB = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(marketResponse("75000", 140, 1))
      .mockImplementationOnce(() => requestA.promise)
      .mockImplementationOnce(() => requestB.promise));

    await useMarketStore.getState().load("1h");
    useTradingStore.getState().runOnBars(useMarketStore.getState().bars, { interval: "1h", source: "live" });
    expect(useTradingStore.getState().actionDecision).not.toBeNull();

    const loadA = useMarketStore.getState().load("1h");
    const loadB = useMarketStore.getState().load("1h");
    requestB.resolve(marketResponse("81000", 140, 1));
    await loadB;
    useTradingStore.getState().runOnBars(useMarketStore.getState().bars, { interval: "1h", source: "live" });
    const bState = useTradingStore.getState();
    const persistedAfterB = getStorageApi().getItem("quant_paper_engine_state")!;
    expect(bState.actionDecision).not.toBeNull();

    requestA.reject(new Error("stale provider failure"));
    await loadA;

    expect(useMarketStore.getState().lastPrice).toBe(81139);
    expect(useMarketStore.getState().source).toBe("live");
    expect(useMarketStore.getState().error).toBeNull();
    expect(useTradingStore.getState().actionDecision).toEqual(bState.actionDecision);
    expect(useTradingStore.getState().latestDecision).toEqual(bState.latestDecision);
    expect(useTradingStore.getState().lifecycleCheckpoint).toEqual(bState.lifecycleCheckpoint);
    expect(getStorageApi().getItem("quant_paper_engine_state")).toBe(persistedAfterB);
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
    expect(useTradingStore.getState().latestDecision).toBeNull();
    expect(useTradingStore.getState().lifecycleCheckpoint).toBeNull();
    expect(useTradingStore.getState().actionDecision).toBeNull();
  });

  it("does not let stale success resurrect evidence after B fails", async () => {
    const requestA = deferred<Response>();
    const requestB = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(marketResponse("75000", 140, 1))
      .mockImplementationOnce(() => requestA.promise)
      .mockImplementationOnce(() => requestB.promise));

    await useMarketStore.getState().load("1h");
    useTradingStore.getState().runOnBars(useMarketStore.getState().bars, { interval: "1h", source: "live" });
    const seeded = useTradingStore.getState();
    expect(seeded.actionDecision).not.toBeNull();

    const loadA = useMarketStore.getState().load("1h");
    const loadB = useMarketStore.getState().load("1h");
    requestB.reject(new Error("current provider failure"));
    await loadB;
    const preservedAfterFailure = useTradingStore.getState();
    const persistedAfterFailure = getStorageApi().getItem("quant_paper_engine_state")!;
    expect(useTradingStore.getState().actionDecision).toBeNull();
    expect(preservedAfterFailure.latestDecision).toEqual(seeded.latestDecision);
    expect(preservedAfterFailure.lifecycleCheckpoint).toEqual(seeded.lifecycleCheckpoint);

    requestA.resolve(marketResponse("83000", 140, 1));
    await loadA;

    expect(useMarketStore.getState().bars).toEqual([]);
    expect(useMarketStore.getState().lastPrice).toBe(0);
    expect(useMarketStore.getState().source).toBeNull();
    expect(useMarketStore.getState().error).toBe("BTC market feed unavailable.");
    expect(useTradingStore.getState().actionDecision).toBeNull();
    expect(useTradingStore.getState().latestDecision).toEqual(preservedAfterFailure.latestDecision);
    expect(useTradingStore.getState().lifecycleCheckpoint).toEqual(preservedAfterFailure.lifecycleCheckpoint);
    expect(getStorageApi().getItem("quant_paper_engine_state")).toBe(persistedAfterFailure);
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
