import type { MacroSeries, TimeSeriesPoint } from "@/types/market";
import { mulberry32, pctChange } from "@/lib/math";

const YAHOO: Record<MacroSeries["id"], { ticker: string; name: string }> = {
  dxy: { ticker: "DX-Y.NYB", name: "US Dollar Index" },
  us10y: { ticker: "^TNX", name: "US 10Y Yield" },
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

async function fetchYahooSeries(id: MacroSeries["id"]): Promise<MacroSeries | null> {
  const meta = YAHOO[id];
  const url = `/api/yahoo/v8/finance/chart/${encodeURIComponent(meta.ticker)}?interval=1d&range=6mo`;
  const res = await fetch(url);
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
  if (points.length < 25) return null;
  return toMacroSeries(id, meta.ticker, meta.name, points, "live");
}

function toMacroSeries(
  id: MacroSeries["id"],
  ticker: string,
  name: string,
  points: TimeSeriesPoint[],
  source: MacroSeries["source"],
): MacroSeries {
  const last = points.at(-1)!.value;
  const prev = points.at(-2)?.value ?? last;
  const ago20 = points.at(-21)?.value ?? points[0].value;
  return {
    id,
    ticker,
    name,
    points,
    last,
    change1d: last - prev,
    changePct1d: pctChange(prev, last),
    changePct20d: pctChange(ago20, last),
    source,
  };
}

function syntheticSeries(id: MacroSeries["id"]): MacroSeries {
  const meta = YAHOO[id];
  const seedMap = { dxy: 11, us10y: 22, gold: 33, btc: 44 };
  const rand = mulberry32(seedMap[id] + 20260914);
  const start: Record<MacroSeries["id"], number> = {
    dxy: 104.2,
    us10y: 4.18,
    gold: 2485,
    btc: 63800,
  };
  const vol: Record<MacroSeries["id"], number> = {
    dxy: 0.0024,
    us10y: 0.012,
    gold: 0.007,
    btc: 0.028,
  };
  const drift: Record<MacroSeries["id"], number> = {
    dxy: 0.00018,
    us10y: 0.0004,
    gold: -0.00005,
    btc: -0.0004,
  };

  const points: TimeSeriesPoint[] = [];
  let px = start[id];
  const now = Date.now();
  const day = 86_400_000;
  for (let i = 120; i >= 0; i -= 1) {
    const shock = (rand() - 0.48) * vol[id];
    px = Math.max(px * (1 + drift[id] + shock), id === "us10y" ? 0.5 : 1);
    points.push({ time: now - i * day, value: px });
  }
  return toMacroSeries(id, meta.ticker, meta.name, points, "synthetic");
}

export async function loadMacroUniverse(): Promise<MacroSeries[]> {
  const ids: MacroSeries["id"][] = ["dxy", "us10y", "gold", "btc"];
  const live = await Promise.all(ids.map((id) => fetchYahooSeries(id).catch(() => null)));
  return ids.map((id, i) => live[i] ?? syntheticSeries(id));
}
