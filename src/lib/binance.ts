import type { OhlcvBar } from "@/types/market";
import { BAR_DURATION_MS, isBarCloseAvailableAt } from "@/lib/quant/timeDomain";

export type BinanceInterval = "15m" | "1h" | "4h" | "1d";

type KlineTuple = [
  number, string, string, string, string, string, number, string, number, string, string, string
];

const BINANCE_INTERVAL_DURATION_MS: Record<BinanceInterval, number> = {
  "15m": BAR_DURATION_MS / 4,
  "1h": BAR_DURATION_MS,
  "4h": BAR_DURATION_MS * 4,
  "1d": BAR_DURATION_MS * 24,
};

function isFiniteNumeric(value: unknown): value is number | string {
  return (typeof value === "number" || typeof value === "string") && Number.isFinite(Number(value));
}

function parseKlines(
  raw: unknown[],
  interval: BinanceInterval,
  observationTimeMs: number,
): OhlcvBar[] {
  const intervalDurationMs = BINANCE_INTERVAL_DURATION_MS[interval];
  let previousOpenTime = -1;
  const bars: OhlcvBar[] = [];

  for (const value of raw) {
    if (!Array.isArray(value) || value.length < 12) {
      throw new Error("Malformed BTC market feed.");
    }

    const k = value as KlineTuple;
    const openTime = k[0];
    const closeTime = k[6];
    const prices = [k[1], k[2], k[3], k[4], k[5]];
    if (!Number.isSafeInteger(openTime) || openTime < 0 || openTime <= previousOpenTime
      || !Number.isSafeInteger(closeTime) || closeTime < 0
      || prices.some((price) => !isFiniteNumeric(price))) {
      throw new Error("Malformed BTC market feed.");
    }

    const expectedCloseTime = openTime + intervalDurationMs - 1;
    if (closeTime !== expectedCloseTime) {
      throw new Error("Malformed BTC market feed.");
    }

    const open = Number(k[1]);
    const high = Number(k[2]);
    const low = Number(k[3]);
    const close = Number(k[4]);
    const volume = Number(k[5]);
    if (open <= 0 || high <= 0 || low <= 0 || close <= 0 || volume < 0
      || high < Math.max(open, close) || low > Math.min(open, close)) {
      throw new Error("Malformed BTC market feed.");
    }

    previousOpenTime = openTime;
    if (!isBarCloseAvailableAt(openTime, observationTimeMs, intervalDurationMs)) continue;

    bars.push({
      time: Math.floor(openTime / 1000),
      open,
      high,
      low,
      close,
      volume,
    });
  }

  return bars;
}

export async function fetchBtcKlines(
  interval: BinanceInterval = "1h",
  limit = 500,
  observationTimeMs?: number,
): Promise<{ bars: OhlcvBar[]; source: "live"; observationTime: number }> {
  const url = `/api/binance/api/v3/klines?symbol=BTCUSDT&interval=${interval}&limit=${limit}`;

  try {
    const res = await fetch(url);
    if (res.ok) {
      const json = (await res.json()) as unknown;
      if (Array.isArray(json) && json.length >= 60) {
        // The observation clock is sampled after the provider response arrives.
        // Tests may inject it explicitly for deterministic boundary checks.
        const observedAt = observationTimeMs ?? Date.now();
        const bars = parseKlines(json, interval, observedAt);
        if (bars.length > 0) return { bars, source: "live", observationTime: observedAt };
      }
    }
  } catch {
    // Preserve the fail-closed market-store boundary below.
  }

  throw new Error("BTC market feed unavailable.");
}
