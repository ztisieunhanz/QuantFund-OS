import type { TimeSeriesPoint } from "@/types/market";
import { pctChange } from "@/lib/math";

export interface VietnamBreadth {
  advancing: number;
  declining: number;
  unchanged: number;
  adRatio: number; // advancing / declining
  pctAboveMA20: number; // % cổ phiếu > MA20
  pctAboveMA50: number; // % cổ phiếu > MA50
  pctAboveMA200: number; // % cổ phiếu > MA200
}

export interface VietnamIndexData {
  price: number;
  change1d: number;
  changePct1d: number;
  changePct20d: number;
  distMa20: number | null;
  distMa50: number | null;
  distMa200: number | null;
  points: TimeSeriesPoint[];
  source: "live" | "synthetic";
  timestamp: number;
}

export interface VietnamMarketState {
  index: VietnamIndexData;
  breadth: VietnamBreadth;
}

// 50 phiên giá đóng cửa cơ sở (Fallback phòng khi mất mạng)
const VNINDEX_SERIES_BASE = [
  1218, 1222, 1225, 1230, 1235, 1228, 1220, 1224, 1232, 1238,
  1240, 1245, 1242, 1239, 1248, 1252, 1255, 1250, 1246, 1253,
  1258, 1262, 1260, 1265, 1268, 1264, 1259, 1263, 1267, 1270,
  1268, 1272, 1275, 1271, 1269, 1274, 1278, 1282, 1279, 1276,
  1280, 1285, 1282, 1278, 1284, 1288, 1283, 1279, 1281, 1280.5
];

export function calculateVietnamFeatures(prices: number[]) {
  const len = prices.length;
  if (len === 0) return { distMa20: null, distMa50: null, distMa200: null, changePct20d: 0 };

  const last = prices[len - 1];
  
  const getMA = (days: number) => {
    if (len < days) return null;
    const slice = prices.slice(len - days);
    return slice.reduce((a, b) => a + b, 0) / days;
  };

  const ma20 = getMA(20);
  const ma50 = getMA(50);
  const ma200 = getMA(200);

  const past20 = len > 20 ? prices[len - 21] : prices[0];
  const changePct20d = past20 ? (last - past20) / past20 : 0;

  return {
    distMa20: ma20 ? (last - ma20) / ma20 : null,
    distMa50: ma50 ? (last - ma50) / ma50 : null,
    distMa200: ma200 ? (last - ma200) / ma200 : null,
    changePct20d
  };
}

interface YahooChartResponse {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      indicators?: { quote?: Array<{ close?: Array<number | null> }> };
    }>;
  };
}

// KÉO DỮ LIỆU VN-INDEX THẬT TỪ YAHOO FINANCE (^VNINDEX) QUA PROXY
async function fetchLiveVietnamIndex(): Promise<{ points: TimeSeriesPoint[]; source: "live" } | null> {
  const ticker = "^VNINDEX";
  const targetUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=6mo`;
  const proxies = [
    `/api/yahoo/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=6mo`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`
  ];

  for (const url of proxies) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
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

      if (points.length >= 25) {
        return { points, source: "live" };
      }
    } catch (e) {
      // Thử proxy kế tiếp
    }
  }
  return null;
}

export async function loadVietnamMarket(): Promise<VietnamMarketState> {
  const now = Date.now();
  const DAY_MS = 86400000;

  // Thử gọi API lấy dữ liệu thật VN-Index
  const liveResult = await fetchLiveVietnamIndex();
  
  let prices: number[];
  let points: TimeSeriesPoint[];
  let source: "live" | "synthetic";

  if (liveResult) {
    points = liveResult.points;
    prices = points.map(p => p.value);
    source = "live";
  } else {
    points = VNINDEX_SERIES_BASE.map((val, idx) => ({
      time: now - (VNINDEX_SERIES_BASE.length - 1 - idx) * DAY_MS,
      value: val
    }));
    prices = VNINDEX_SERIES_BASE;
    source = "synthetic";
  }

  const len = prices.length;
  const lastPrice = prices[len - 1];
  const prevPrice = prices[len - 2] ?? lastPrice;
  const change1d = lastPrice - prevPrice;
  const changePct1d = pctChange(prevPrice, lastPrice);

  const features = calculateVietnamFeatures(prices);

  // Snapshot Market Breadth phản ánh cấu trúc phân kỳ
  const breadth: VietnamBreadth = {
    advancing: 145,
    declining: 320,
    unchanged: 65,
    adRatio: Math.round((145 / 320) * 100) / 100,
    pctAboveMA20: 38.0,
    pctAboveMA50: 31.0,
    pctAboveMA200: 45.0
  };

  return {
    index: {
      price: lastPrice,
      change1d,
      changePct1d,
      changePct20d: features.changePct20d,
      distMa20: features.distMa20,
      distMa50: features.distMa50,
      distMa200: features.distMa200,
      points,
      source,
      timestamp: now
    },
    breadth
  };
}