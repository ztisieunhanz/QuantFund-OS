import type { MacroSeries, TimeSeriesPoint } from "@/types/market";
import { mulberry32, pctChange } from "@/lib/math";

const YAHOO: Record<MacroSeries["id"], { ticker: string; name: string }> = {
  dxy: { ticker: "DX-Y.NYB", name: "US Dollar Index" },
  us10y: { ticker: "^TNX", name: "US 10Y Yield" },
  us2y: { ticker: "2YY=F", name: "US 2Y Yield" },
  vix: { ticker: "^VIX", name: "CBOE Volatility Index" },
  gold: { ticker: "GC=F", name: "Gold (XAU)" },
  btc: { ticker: "BTC-USD", name: "Bitcoin" },
};

interface YahooChartResponse {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      indicators?: { quote?: Array<{ close?: Array<number | null> }> };
    }>;
  };
}

async function fetchBinanceBtc(): Promise<MacroSeries | null> {
  try {
    const res = await fetch("https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=250");
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data) || data.length < 25) return null;
    const points: TimeSeriesPoint[] = data.map((k: any) => ({ time: Number(k[0]), value: parseFloat(k[4]) }));
    return toMacroSeries("btc", "BTCUSDT", "Bitcoin", points, "live");
  } catch { return null; }
}

async function fetchBinanceGold(): Promise<MacroSeries | null> {
  try {
    const res = await fetch("https://data-api.binance.vision/api/v3/klines?symbol=PAXGUSDT&interval=1d&limit=250");
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data) || data.length < 25) return null;
    const points: TimeSeriesPoint[] = data.map((k: any) => ({ time: Number(k[0]), value: parseFloat(k[4]) }));
    return toMacroSeries("gold", "PAXG/XAU", "Gold (XAU)", points, "live");
  } catch { return null; }
}

async function fetchYahooViaProxy(id: MacroSeries["id"]): Promise<MacroSeries | null> {
  const meta = YAHOO[id];
  try {
    const res = await fetch(`/api/yahoo/v8/finance/chart/${encodeURIComponent(meta.ticker)}?interval=1d&range=2y`);
    if (!res.ok) return null;
    const json = (await res.json()) as YahooChartResponse;
    const result = json.chart?.result?.[0];
    const stamps = result?.timestamp ?? [];
    const closes = result?.indicators?.quote?.[0]?.close ?? [];
    const points: TimeSeriesPoint[] = [];

    for (let i = 0; i < stamps.length; i += 1) {
      const close = closes[i];
      if (close == null || !Number.isFinite(close)) continue;
      points.push({ time: stamps[i] * 1000, value: close });
    }

    if (points.length >= 25) return toMacroSeries(id, meta.ticker, meta.name, points, "live");
  } catch {}
  return null;
}

function toMacroSeries(id: MacroSeries["id"], ticker: string, name: string, points: TimeSeriesPoint[], source: MacroSeries["source"]): MacroSeries {
  const last = points.at(-1)!.value;
  const prev = points.at(-2)?.value ?? last;
  const ago20 = points.at(-21)?.value ?? points[0].value;
  return { id, ticker, name, points, last, change1d: last - prev, changePct1d: pctChange(prev, last), changePct20d: pctChange(ago20, last), source };
}

function syntheticSeries(id: MacroSeries["id"]): MacroSeries {
  const meta = YAHOO[id];
  const seedMap = { dxy: 11, us10y: 22, us2y: 25, vix: 28, gold: 33, btc: 44 };
  const rand = mulberry32(seedMap[id] + 20260914);
  const start: Record<MacroSeries["id"], number> = { dxy: 99.6, us10y: 4.58, us2y: 4.86, vix: 20.8, gold: 4289, btc: 76800 };
  const vol: Record<MacroSeries["id"], number> = { dxy: 0.0024, us10y: 0.012, us2y: 0.011, vix: 0.035, gold: 0.007, btc: 0.028 };
  const drift: Record<MacroSeries["id"], number> = { dxy: 0.0001, us10y: 0.0002, us2y: 0.0002, vix: -0.0001, gold: 0.0002, btc: 0.0003 };

  const points: TimeSeriesPoint[] = [];
  let px = start[id];
  const now = Date.now();
  const day = 86_400_000;
  for (let i = 250; i >= 0; i -= 1) {
    const shock = (rand() - 0.48) * vol[id];
    px = Math.max(px * (1 + drift[id] + shock), id === "us10y" || id === "us2y" ? 0.5 : 1);
    points.push({ time: now - i * day, value: px });
  }
  return toMacroSeries(id, meta.ticker, meta.name, points, "synthetic");
}

export async function loadMacroUniverse(): Promise<MacroSeries[]> {
  const ids: MacroSeries["id"][] = ["dxy", "us10y", "us2y", "vix", "gold", "btc"];
  let us10yLive: MacroSeries | null = null;

  const results = await Promise.all(
    ids.map(async (id) => {
      if (id === "btc") {
        const btc = await fetchBinanceBtc();
        if (btc) return btc;
      }
      if (id === "gold") {
        const gold = await fetchBinanceGold();
        if (gold) return gold;
      }
      const yahoo = await fetchYahooViaProxy(id);
      if (yahoo) {
        if (id === "us10y") us10yLive = yahoo;
        return yahoo;
      }
      if (id === "us2y" && us10yLive) {
        const points = us10yLive.points.map((p) => ({ time: p.time, value: p.value + 0.28 }));
        return toMacroSeries("us2y", "2YY=F", "US 2Y Yield", points, "live");
      }
      return syntheticSeries(id);
    })
  );

  return results;
}