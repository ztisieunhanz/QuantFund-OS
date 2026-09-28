import { create } from "zustand";
import type { OhlcvBar } from "@/types/market";
import { fetchBtcKlines, type BinanceInterval } from "@/lib/binance";
import { ema, rsi } from "@/lib/math";
import { useTradingStore } from "@/stores/tradingStore";

export type MarketSource = "live" | "synthetic";

export function getMarketSourceLabel(source: MarketSource | null): string {
  return source === "live"
    ? "FEED: LIVE BINANCE"
    : source === "synthetic"
      ? "FEED: SYNTHETIC"
      : "FEED: UNAVAILABLE";
}

interface MarketState {
  interval: BinanceInterval;
  bars: OhlcvBar[];
  source: MarketSource | null;
  loading: boolean;
  error: string | null;
  ema20: Array<number | null>;
  ema50: Array<number | null>;
  rsi14: Array<number | null>;
  lastPrice: number;
  refreshedAt: number | null;
  setIntervalTf: (interval: BinanceInterval) => void;
  load: (interval?: BinanceInterval) => Promise<void>;
}

function decorate(bars: OhlcvBar[]) {
  const closes = bars.map((b) => b.close);
  return {
    bars,
    ema20: ema(closes, 20),
    ema50: ema(closes, 50),
    rsi14: rsi(closes, 14),
    lastPrice: bars.at(-1)?.close ?? 0,
  };
}

export const useMarketStore = create<MarketState>((set, get) => {
  let latestLoadGeneration = 0;

  return {
  interval: "1h",
  bars: [],
  source: null,
  loading: false,
  error: null,
  ema20: [],
  ema50: [],
  rsi14: [],
  lastPrice: 0,
  refreshedAt: null,
  setIntervalTf: (interval) => {
    set({ interval });
    void get().load(interval);
  },
  load: async (interval) => {
    const tf = interval ?? get().interval;
    const requestGeneration = ++latestLoadGeneration;
    set({ loading: true, error: null, interval: tf });
    try {
      const { bars, source } = await fetchBtcKlines(tf, 500);
      if (requestGeneration !== latestLoadGeneration) return;
      set({
        ...decorate(bars),
        source,
        loading: false,
        refreshedAt: Date.now(),
      });
    } catch (err) {
      if (requestGeneration !== latestLoadGeneration) return;
      useTradingStore.getState().reset();
      set({
        ...decorate([]),
        source: null,
        loading: false,
        error: err instanceof Error ? err.message : "Market feed failed",
      });
    }
  },
  };
});
