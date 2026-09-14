import { create } from "zustand";
import type { OhlcvBar } from "@/types/market";
import { fetchBtcKlines, type BinanceInterval } from "@/lib/binance";
import { ema, rsi } from "@/lib/math";

interface MarketState {
  interval: BinanceInterval;
  bars: OhlcvBar[];
  source: "live" | "synthetic";
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

export const useMarketStore = create<MarketState>((set, get) => ({
  interval: "1h",
  bars: [],
  source: "live",
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
    set({ loading: true, error: null, interval: tf });
    try {
      const { bars, source } = await fetchBtcKlines(tf, 500);
      set({
        ...decorate(bars),
        source,
        loading: false,
        refreshedAt: Date.now(),
      });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : "Market feed failed",
      });
    }
  },
}));
