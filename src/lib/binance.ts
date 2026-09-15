// ============================================================================
// FILE: src/lib/binance.ts
// MODULE: REAL-TIME BTC KLINES FETCHER WITH MULTI-PROXY FALLBACK
// ============================================================================

import type { OhlcvBar } from "@/types/market";
import { mulberry32 } from "@/lib/math";

export type BinanceInterval = "15m" | "1h" | "4h" | "1d";

type KlineTuple = [
  number, // Open time
  string, // Open
  string, // High
  string, // Low
  string, // Close
  string, // Volume
  number, // Close time
  string, // Quote asset volume
  number, // Number of trades
  string,
  string,
  string
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
  // Ưu tiên gọi trực tiếp Binance Vision (CORS Open) để không bao giờ bị dính 502
  const endpoints = [
    `https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=${interval}&limit=${limit}`,
    `/api/binance/api/v3/klines?symbol=BTCUSDT&interval=${interval}&limit=${limit}`,
  ];

  for (const url of endpoints) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const json = (await res.json()) as KlineTuple[];
      if (!Array.isArray(json) || json.length < 60) continue;
      
      const bars = parseKlines(json);
      return { bars, source: "live" };
    } catch {
      // Thử endpoint tiếp theo
    }
  }

  return { bars: syntheticBtc(interval, limit, 77000), source: "synthetic" };
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

function syntheticBtc(interval: BinanceInterval, limit: number, basePrice = 77000): OhlcvBar[] {
  const rand = mulberry32(777 + interval.length * 13);
  const step = intervalMs(interval);
  let close = basePrice;
  const now = Date.now();
  const bars: OhlcvBar[] = [];

  for (let i = limit; i >= 1; i -= 1) {
    const t = Math.floor((now - i * step) / 1000);
    const drift = 0.0001;
    const shock = (rand() - 0.495) * 0.015;
    const open = close;
    close = Math.max(1000, open * (1 + drift + shock));
    const wick = Math.abs(shock) * open * 0.5;
    const high = Math.max(open, close) + wick * rand();
    const low = Math.min(open, close) - wick * rand();
    const volume = 200 + rand() * 1500;
    bars.push({ time: t, open, high, low, close, volume });
  }
  return bars;
}