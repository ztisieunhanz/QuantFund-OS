import type { OhlcvBar } from "@/types/market";
import { mulberry32 } from "@/lib/math";

export type BinanceInterval = "15m" | "1h" | "4h" | "1d";

type KlineTuple = [
  number,
  string,
  string,
  string,
  string,
  string,
  number,
  string,
  number,
  string,
  string,
  string,
];

function parseKlines(raw: KlineTuple[]): OhlcvBar[] {
  return raw.map((k) => ({
    time: Math.floor(k[0] / 1000),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
  }));
}

export async function fetchBtcKlines(
  interval: BinanceInterval = "1h",
  limit = 500,
): Promise<{ bars: OhlcvBar[]; source: "live" | "synthetic" }> {
  try {
    const url = `/api/binance/api/v3/klines?symbol=BTCUSDT&interval=${interval}&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`binance ${res.status}`);
    const json = (await res.json()) as KlineTuple[];
    const bars = parseKlines(json);
    if (bars.length < 60) throw new Error("insufficient bars");
    return { bars, source: "live" };
  } catch {
    return { bars: syntheticBtc(interval, limit), source: "synthetic" };
  }
}

function intervalMs(interval: BinanceInterval): number {
  switch (interval) {
    case "15m":
      return 15 * 60 * 1000;
    case "1h":
      return 60 * 60 * 1000;
    case "4h":
      return 4 * 60 * 60 * 1000;
    case "1d":
      return 24 * 60 * 60 * 1000;
  }
}

function syntheticBtc(interval: BinanceInterval, limit: number): OhlcvBar[] {
  const rand = mulberry32(777 + interval.length * 13);
  const step = intervalMs(interval);
  let close = 64150;
  const now = Date.now();
  const bars: OhlcvBar[] = [];
  for (let i = limit; i >= 1; i -= 1) {
    const t = Math.floor((now - i * step) / 1000);
    const drift = 0.00015;
    const shock = (rand() - 0.5) * 0.016;
    const open = close;
    close = Math.max(1000, open * (1 + drift + shock));
    const wick = Math.abs(shock) * open * 0.55;
    const high = Math.max(open, close) + wick * rand();
    const low = Math.min(open, close) - wick * rand();
    const volume = 120 + rand() * 1800;
    bars.push({ time: t, open, high, low, close, volume });
  }
  return bars;
}
