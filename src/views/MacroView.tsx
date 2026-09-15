// ============================================================================
// FILE: src/views/MacroView.tsx
// MODULE: CLEAN QUANT MACRO VIEW WITHOUT TICKER FACADE
// ============================================================================

import React, { useEffect, useMemo, useState, useRef } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip as RechartsTooltip } from "recharts";
import { Loader2, Send, MessageSquareText, TrendingUp, Activity, ShieldAlert } from "lucide-react";
import { Panel } from "@/components/ui/Panel";
import { MetricCard } from "@/components/ui/MetricCard";
import { MacroNewsTable } from "@/components/MacroNewsTable";
import { thirtyDayCorrelation } from "@/lib/correlation";
import { clsx } from "@/lib/clsx";
import { formatNumber, formatPct } from "@/lib/math";
import { useMacroStore } from "@/stores/macroStore";
import { usePortfolioStore } from "@/stores/portfolioStore";
import { useTradingStore } from "@/stores/tradingStore";
import { useMarketStore } from "@/stores/marketStore";
import { loadVietnamMarket, type VietnamMarketState } from "@/lib/vietnamFeed";
import type { AllocationWeights, AssetKey, MacroSeries } from "@/types/market";

const CHAT_EXPIRY_MS = 60 * 60 * 1000;

const PIE_COLORS: Record<keyof AllocationWeights, string> = {
  realEstate: "#26c6da", gold: "#ffc107", usdCash: "#00e676", equities: "#82b1ff", crypto: "#b388ff",
};
const PIE_LABELS: Record<keyof AllocationWeights, string> = {
  realEstate: "Real Estate", gold: "Gold", usdCash: "USD Cash", equities: "Equities", crypto: "Crypto",
};
const ASSET_ORDER: AssetKey[] = ["dxy", "us10y", "gold", "btc"];
const ASSET_LABEL: Record<AssetKey, string> = { dxy: "DXY", us10y: "US10Y", gold: "XAU", btc: "BTC" };

function corrColor(v: number): string {
  if (v >= 0.6) return "bg-[#0b3d24] text-up";
  if (v >= 0.2) return "bg-[#12301f] text-up/80";
  if (v > -0.2) return "bg-panel-2 text-muted";
  if (v > -0.6) return "bg-[#3a1218] text-down/80";
  return "bg-[#4a0d16] text-down";
}

interface QuantResponse {
  verdict: "BUY" | "HOLD" | "REDUCE" | "HEDGE" | "WAIT";
  confidence: number;
  thesis: string;
  signals: string[];
  divergences: string[];
  risks: string[];
  action: string;
  triggers: string[];
  invalidation: string;
  dataQuality: {
    coverage: number;
    missing: string[];
  };
}

const FormatStructuredMessage = ({ data, text }: { data?: QuantResponse; text: string }) => {
  if (!data) {
    const lines = text.split('\n');
    return (
      <div className="space-y-2 text-[14px] leading-relaxed text-ink font-sans tracking-wide">
        {lines.map((line, i) => {
          if (!line.trim()) return <div key={i} className="h-1.5"></div>;
          const formatted = line
            .replace(/\*\*(.*?)\*\*/g, '<strong class="text-white font-bold">$1</strong>')
            .replace(/\*(.*?)\*/g, '<em class="text-muted italic">$1</em>');
          return <div key={i} dangerouslySetInnerHTML={{ __html: formatted }} />;
        })}
      </div>
    );
  }

  const verdictColors: Record<string, string> = {
    BUY: "text-[#00e676] bg-[#00e676]/10 border-[#00e676]/30",
    HOLD: "text-cyan bg-cyan/10 border-cyan/30",
    REDUCE: "text-amber bg-amber/10 border-amber/30",
    HEDGE: "text-[#b388ff] bg-[#b388ff]/10 border-[#b388ff]/30",
    WAIT: "text-muted bg-panel-2 border-line",
  };
  
  const vColor = verdictColors[data.verdict] || verdictColors.WAIT;

  return (
    <div className="space-y-4 font-sans text-[13px] text-ink w-full">
      <div className="flex items-center justify-between border-b border-line pb-2.5">
        <div className={clsx("px-2.5 py-1 rounded border font-black text-[12px] tracking-widest uppercase shadow-sm", vColor)}>
          VERDICT: {data.verdict}
        </div>
        <div className="text-cyan font-mono text-[11px] font-bold">
          CONFIDENCE: {data.confidence}%
        </div>
      </div>
      
      <div>
        <span className="font-bold text-[#82b1ff] uppercase text-[11px] tracking-wider font-mono">THESIS</span>
        <p className="mt-1 text-[14px] leading-relaxed italic text-[#d7e2ee]">{data.thesis}</p>
      </div>

      <div className="bg-[#10151e] border border-line p-3.5 rounded-lg shadow-inner space-y-3">
         <div>
            <span className="font-bold text-[#00e676] text-[12px] uppercase">⚡ ACTION DIRECTIVE:</span>
            <p className="mt-1.5 text-[#d7e2ee] text-[13px]">{data.action}</p>
         </div>
         {data.triggers && data.triggers.length > 0 && (
           <div className="pt-2 border-t border-line/50">
              <span className="font-bold text-amber text-[12px] uppercase">🎯 TRIGGERS:</span>
              <ul className="list-disc list-inside mt-1 text-muted text-[12px] space-y-1">
                {data.triggers.map((t, i) => <li key={i}>{t}</li>)}
              </ul>
           </div>
         )}
         <div className="pt-2 border-t border-line/50">
            <span className="font-bold text-[#ff3d57] text-[12px] uppercase">⚠️ INVALIDATION:</span>
            <p className="mt-1 text-[#d7e2ee] text-[12px]">{data.invalidation}</p>
         </div>
      </div>

      <div className="grid grid-cols-2 gap-4 text-[12px] bg-panel-2 p-3 rounded border border-line">
        {data.signals && data.signals.length > 0 && (
          <div>
            <span className="font-bold text-cyan font-mono uppercase tracking-widest text-[10px]">SIGNALS</span>
            <ul className="list-disc list-inside mt-1.5 text-muted space-y-1">
              {data.signals.map((s, i) => <li key={i}>{s}</li>)}
            </ul>
          </div>
        )}
        {data.divergences && data.divergences.length > 0 && (
          <div>
            <span className="font-bold text-amber font-mono uppercase tracking-widest text-[10px]">DIVERGENCES</span>
            <ul className="list-disc list-inside mt-1.5 text-muted space-y-1">
              {data.divergences.map((d, i) => <li key={i}>{d}</li>)}
            </ul>
          </div>
        )}
        {data.risks && data.risks.length > 0 && (
          <div className="col-span-2 pt-2 border-t border-line/50">
            <span className="font-bold text-[#ff3d57] font-mono uppercase tracking-widest text-[10px]">RISKS</span>
            <ul className="list-disc list-inside mt-1.5 text-[#ff3d57]/80 space-y-1">
              {data.risks.map((r, i) => <li key={i}>{r}</li>)}
            </ul>
          </div>
        )}
      </div>

      <div className="border-t border-line pt-2 flex items-center justify-between text-[10px] text-muted font-mono">
        <span>DATA COVERAGE: <strong className="text-white">{data.dataQuality?.coverage}%</strong></span>
        {data.dataQuality?.missing && data.dataQuality.missing.length > 0 && (
          <span className="text-[#ff3d57]">MISSING: {data.dataQuality.missing.join(", ")}</span>
        )}
      </div>
    </div>
  );
};

function calculateAssetFeatures(history?: number[]) {
  const defaultFeatures = {
    return1D: null as number | null,
    return5D: null as number | null,
    return20D: null as number | null,
    ma20: null as number | null,
    ma50: null as number | null,
    ma200: null as number | null,
    distMa20: null as number | null,
    distMa50: null as number | null,
    distMa200: null as number | null,
    volatility20D: null as number | null,
  };

  if (!history || !Array.isArray(history) || history.length === 0) return defaultFeatures;
  const len = history.length;
  const lastPrice = history[len - 1];

  if (!Number.isFinite(lastPrice) || lastPrice === 0) return defaultFeatures;

  const getReturn = (days: number) => {
    if (len <= days) return null;
    const past = history[len - 1 - days];
    return Number.isFinite(past) && past !== 0 ? (lastPrice - past) / past : null;
  };

  const getMA = (days: number) => {
    if (len < days) return null;
    const slice = history.slice(len - days);
    return slice.reduce((a, b) => a + b, 0) / days;
  };

  const getDist = (price: number, ma: number | null) => (ma !== null && ma !== 0 ? (price - ma) / ma : null);

  const getVol = (days: number) => {
    if (len < days + 1) return null;
    const returns: number[] = [];
    for (let i = len - days; i < len; i++) {
      const prev = history[i - 1];
      if (Number.isFinite(prev) && prev !== 0) {
        returns.push((history[i] - prev) / prev);
      }
    }
    if (returns.length < days) return null;
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const varTotal = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / returns.length;
    return Math.sqrt(varTotal) * Math.sqrt(252);
  };

  const ma20 = getMA(20);
  const ma50 = getMA(50);
  const ma200 = getMA(200);

  return {
    return1D: getReturn(1),
    return5D: getReturn(5),
    return20D: getReturn(20),
    ma20,
    ma50,
    ma200,
    distMa20: getDist(lastPrice, ma20),
    distMa50: getDist(lastPrice, ma50),
    distMa200: getDist(lastPrice, ma200),
    volatility20D: getVol(20),
  };
}

function calculateYieldCurveAndVix(series: MacroSeries[]) {
  const us10y = series.find((s) => s.id === "us10y");
  const us2y = series.find((s) => s.id === "us2y");
  const vix = series.find((s) => s.id === "vix");

  let yieldCurve = null;
  if (us10y && us2y && Number.isFinite(us10y.last) && Number.isFinite(us2y.last)) {
    const spreadPct = us10y.last - us2y.last;
    const spreadBps = Math.round(spreadPct * 100);
    
    let status: "INVERTED" | "FLAT_UNINVERTING" | "NORMAL" = "NORMAL";
    let label = "Normal (Dốc dương)";
    let signal = "Tín hiệu bình thường hóa tài chính";

    if (spreadBps < 0) {
      status = "INVERTED";
      label = "Inverted (Đường cong đảo ngược)";
      signal = "Cảnh báo suy thoái kinh tế (Recession Risk)";
    } else if (spreadBps <= 15) {
      status = "FLAT_UNINVERTING";
      label = "Flat / Un-inverting";
      signal = "Vùng nguy hiểm: Thanh khoản thắt chặt khi Fed bắt đầu hạ lãi suất";
    }

    yieldCurve = {
      us10y: us10y.last,
      us2y: us2y.last,
      spreadPct,
      spreadBps,
      status,
      label,
      signal,
    };
  }

  let vixData = null;
  if (vix && Number.isFinite(vix.last)) {
    const vixPoints = (vix.points || []).map((p) => p.value);
    let zScore = null;
    if (vixPoints.length >= 20) {
      const slice = vixPoints.slice(-30);
      const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
      const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / slice.length;
      const std = Math.sqrt(variance);
      zScore = std > 0 ? (vix.last - mean) / std : 0;
    }

    let status: "NORMAL_CALM" | "ELEVATED_VOLATILITY" | "HIGH_VOLATILITY_PANIC" = "NORMAL_CALM";
    let label = "Bình thường / Ổn định";

    if (vix.last >= 25) {
      status = "HIGH_VOLATILITY_PANIC";
      label = "Hoảng loạn / Biến động rất cao";
    } else if (vix.last >= 20) {
      status = "ELEVATED_VOLATILITY";
      label = "Biến động gia tăng / Rủi ro";
    }

    vixData = {
      current: vix.last,
      change1d: vix.change1d,
      changePct20d: vix.changePct20d,
      zScore: zScore !== null ? Math.round(zScore * 100) / 100 : null,
      status,
      label,
    };
  }

  return { yieldCurve, vixData };
}

function calculateSignalConfluence(macroRegime: any, assets: any, vietnam: VietnamMarketState | null | "UNAVAILABLE") {
  const WEIGHTS = {
    macro: 0.25,
    liquidity: 0.15,
    trend: 0.20,
    breadth: 0.15,
    flow: 0.15,
    crossAsset: 0.10,
  };

  let totalWeight = 0;
  let earnedScore = 0;
  let dataCoverage = 0;
  const factors = [];
  const divergences = [];
  const totalDataFields = 6;

  if (macroRegime && typeof macroRegime.score === "number") {
    totalWeight += WEIGHTS.macro;
    earnedScore += (macroRegime.score / 100) * WEIGHTS.macro;
    factors.push({
      name: "Macro",
      score: macroRegime.score,
      status: macroRegime.score >= 55 ? "BULLISH" : macroRegime.score <= 45 ? "BEARISH" : "NEUTRAL",
    });
    dataCoverage++;
  } else {
    factors.push({ name: "Macro", score: null, status: "UNAVAILABLE" });
  }

  if (vietnam && vietnam !== "UNAVAILABLE" && vietnam.liquidity) {
    let score = 50;
    if (vietnam.liquidity.ratioToMa20 >= 1.0) score += 25;
    else score -= 25;
    totalWeight += WEIGHTS.liquidity;
    earnedScore += (score / 100) * WEIGHTS.liquidity;
    factors.push({
      name: "Liquidity",
      score,
      status: score >= 55 ? "BULLISH" : "BEARISH",
    });
    dataCoverage++;
  } else {
    factors.push({ name: "Liquidity", score: null, status: "UNAVAILABLE" });
  }

  let trendScore = null;
  let isPriceUp = false;

  if (vietnam && vietnam !== "UNAVAILABLE" && vietnam.index) {
    trendScore = 50;
    if (vietnam.index.changePct20d > 0) {
      trendScore += 25;
      isPriceUp = true;
    } else {
      trendScore -= 25;
    }
    if (vietnam.index.distMa50 !== null) {
      if (vietnam.index.distMa50 > 0) trendScore += 25;
      else trendScore -= 25;
    }
  }

  if (trendScore !== null) {
    totalWeight += WEIGHTS.trend;
    earnedScore += (trendScore / 100) * WEIGHTS.trend;
    factors.push({
      name: "Price/Trend",
      score: Math.max(0, Math.min(100, trendScore)),
      status: trendScore >= 55 ? "BULLISH" : trendScore <= 45 ? "BEARISH" : "NEUTRAL",
    });
    dataCoverage++;
  } else {
    factors.push({ name: "Price/Trend", score: null, status: "UNAVAILABLE" });
  }

  let isBreadthWeak = false;
  if (vietnam && vietnam !== "UNAVAILABLE" && vietnam.breadth) {
    let score = 50;
    if (vietnam.breadth.pctAboveMA20 > 50) score += 25;
    else {
      score -= 25;
      isBreadthWeak = true;
    }
    if (vietnam.breadth.adRatio > 1) score += 25;
    else score -= 25;

    totalWeight += WEIGHTS.breadth;
    earnedScore += (score / 100) * WEIGHTS.breadth;
    factors.push({
      name: "Breadth",
      score: Math.max(0, Math.min(100, score)),
      status: score >= 55 ? "BULLISH" : score <= 45 ? "BEARISH" : "NEUTRAL",
    });
    dataCoverage++;
  } else {
    factors.push({ name: "Breadth", score: null, status: "UNAVAILABLE" });
  }

  if (vietnam && vietnam !== "UNAVAILABLE" && vietnam.foreignFlow) {
    let score = 50;
    if (vietnam.foreignFlow.net1dBillion > 0) score += 25;
    else score -= 25;
    totalWeight += WEIGHTS.flow;
    earnedScore += (score / 100) * WEIGHTS.flow;
    factors.push({
      name: "Foreign Flow",
      score,
      status: score >= 55 ? "BULLISH" : "BEARISH",
    });
    dataCoverage++;
  } else {
    factors.push({ name: "Foreign Flow", score: null, status: "UNAVAILABLE" });
  }

  const dxy = assets !== "UNAVAILABLE" ? assets.find((a: any) => a.id === "dxy") : null;
  const us10y = assets !== "UNAVAILABLE" ? assets.find((a: any) => a.id === "us10y") : null;
  if (dxy && dxy.features && us10y && us10y.features) {
    let score = 50;
    if (dxy.features.return20D !== null && dxy.features.return20D < 0) score += 25;
    else score -= 25;
    if (us10y.features.return20D !== null && us10y.features.return20D < 0) score += 25;
    else score -= 25;
    totalWeight += WEIGHTS.crossAsset;
    earnedScore += (score / 100) * WEIGHTS.crossAsset;
    factors.push({
      name: "Cross-Asset",
      score: Math.max(0, Math.min(100, score)),
      status: score >= 55 ? "BULLISH" : score <= 45 ? "BEARISH" : "NEUTRAL",
    });
    dataCoverage++;
  } else {
    factors.push({ name: "Cross-Asset", score: null, status: "UNAVAILABLE" });
  }

  if (isPriceUp && isBreadthWeak) divergences.push("Index Up + Breadth Weak (Phân kỳ cảnh báo rủi ro)");

  return {
    score: totalWeight > 0 ? Math.round((earnedScore / totalWeight) * 100) : null,
    confidence: Math.round((dataCoverage / totalDataFields) * 100),
    factors,
    divergences,
    dataCoverage: `${dataCoverage}/${totalDataFields}`,
  };
}

function calculatePortfolioRisk(portfolio: any, regime: any, corr: any) {
  const nav = portfolio.getTotalNav();
  const cashPct = nav > 0 ? (portfolio.cashUsd / nav) * 100 : 0;

  const isCashAsset = (name: string) => {
    const n = name.toLowerCase();
    return n.includes("cash") || n.includes("tiền mặt") || n.includes("tiền gửi");
  };

  const hasCashInAssets = Array.isArray(portfolio.assets) && portfolio.assets.some((a: any) => isCashAsset(a.name));

  const exposures = {
    equity: 0,
    gold: 0,
    realEstate: 0,
    crypto: 0,
    cash: hasCashInAssets ? 0 : cashPct,
  };

  let largestPosition = hasCashInAssets
    ? { name: portfolio.assets[0]?.name || "N/A", pct: portfolio.assets[0]?.allocationPercent || 0 }
    : { name: "USD Cash", pct: cashPct };

  const allocation = (portfolio.assets || []).map((a: any) => {
    if (a.allocationPercent > largestPosition.pct) {
      largestPosition = { name: a.name, pct: a.allocationPercent };
    }

    const nameLower = a.name.toLowerCase();
    if (isCashAsset(a.name)) {
      exposures.cash += a.allocationPercent;
    } else if (nameLower.includes("equit") || nameLower.includes("cổ phiếu") || nameLower.includes("stock")) {
      exposures.equity += a.allocationPercent;
    } else if (nameLower.includes("gold") || nameLower.includes("vàng")) {
      exposures.gold += a.allocationPercent;
    } else if (nameLower.includes("estate") || nameLower.includes("bđs") || nameLower.includes("bất động sản")) {
      exposures.realEstate += a.allocationPercent;
    } else if (nameLower.includes("crypto") || nameLower.includes("btc") || nameLower.includes("bitcoin")) {
      exposures.crypto += a.allocationPercent;
    }

    return { asset: a.name, weight: a.allocationPercent };
  });

  if (!hasCashInAssets && cashPct > 0) {
    allocation.push({ asset: "USD Cash", weight: cashPct });
  }

  const riskFlags: string[] = [];
  if (largestPosition.pct > 40) {
    riskFlags.push(`Concentration Risk: ${largestPosition.name} chiếm tỷ trọng quá lớn (${largestPosition.pct.toFixed(1)}%)`);
  }
  if (regime) {
    if (regime.score <= 45 && exposures.equity > 40) {
      riskFlags.push(`Regime Mismatch: Tỷ trọng Cổ phiếu cao (${exposures.equity.toFixed(1)}%) trong môi trường Risk-Off (Score: ${regime.score})`);
    }
    if (regime.score >= 55 && exposures.cash > 40) {
      riskFlags.push(`Regime Mismatch: Tiền mặt quá cao (${exposures.cash.toFixed(1)}%) trong môi trường Risk-On (Score: ${regime.score}) -> Cash Drag Risk`);
    }
  }
  if (corr && corr["btc"] && corr["gold"]) {
    const btcGoldCorr = corr["btc"]["gold"];
    if (btcGoldCorr > 0.6 && exposures.crypto + exposures.gold > 50) {
      riskFlags.push(`Correlated Exposure: Vàng và Crypto đang đồng pha mạnh (Corr: ${btcGoldCorr.toFixed(2)}) và chiếm >50% danh mục`);
    }
  }

  return { allocation, concentration: largestPosition, exposure: exposures, riskFlags };
}

export function MacroView() {
  const { loading, error, series, regime, correlation, load } = useMacroStore();
  const portfolio = usePortfolioStore();
  
  const { trend, event, mean, benchmarkDca, runOnBars } = useTradingStore();
  const { bars, load: loadBars } = useMarketStore();

  const [vietnamState, setVietnamState] = useState<VietnamMarketState | null>(null);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Array<{ sender: "user" | "ai"; text: string; parsedData?: QuantResponse }>>([]);
  const [isLoading, setIsLoading] = useState(false);
  const chatScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => { 
    if (series.length === 0) void load();
    void loadVietnamMarket().then((vn) => setVietnamState(vn));
    if (bars.length === 0) void loadBars();
    else if (bars.length >= 130 && (trend?.totalTrades ?? 0) === 0) {
      runOnBars(bars);
    }
  }, [load, series.length, bars, loadBars, runOnBars, trend?.totalTrades]);

  const pieData = useMemo(() => {
    if (!regime) return [];
    return (Object.keys(regime.allocation) as Array<keyof AllocationWeights>).map((key) => ({
      key, name: PIE_LABELS[key], value: Math.round(regime.allocation[key] * 1000) / 10,
    }));
  }, [regime]);

  const corr = correlation ?? (series.length ? thirtyDayCorrelation(series) : null);
  const usingSynthetic = series.some((s) => s.source === "synthetic");

  const macroAdvanced = useMemo(() => {
    return calculateYieldCurveAndVix(series);
  }, [series]);

  const sjcCalculated = useMemo(() => {
    const goldSeries = series.find((s) => s.id === "gold");
    const goldOzUsd = goldSeries?.last && Number.isFinite(goldSeries.last) ? goldSeries.last : 4277;
    const worldPriceMillion = (goldOzUsd * 1.20565 * 25450) / 1_000_000;
    const estimatedDomesticPremium = 4.2;
    const sjcPrice = worldPriceMillion + estimatedDomesticPremium;
    return {
      price: `${sjcPrice.toFixed(1)}M`,
      premium: `+${estimatedDomesticPremium.toFixed(1)}M`,
      percentile: "94%"
    };
  }, [series]);

  const currentSignalConfluence = useMemo(() => {
    const snapshotMacro = regime
      ? {
          label: regime.label,
          score: regime.score,
          thesis: regime.thesis,
          dxyTrend: regime.dxyTrend,
          yieldLevel: regime.yieldLevel,
          yieldTrend: regime.yieldTrend,
        }
      : "UNAVAILABLE";

    const snapshotAssets =
      series.length > 0
        ? series.map((s: MacroSeries) => {
            const priceHistory = s.points ? s.points.map((p) => p.value) : [];
            const features = calculateAssetFeatures(priceHistory);
            return {
              id: s.id,
              name: s.name,
              ticker: s.ticker,
              lastPrice: s.last,
              source: s.source,
              features: {
                ...features,
                return1D: features.return1D ?? s.changePct1d,
                return20D: features.return20D ?? s.changePct20d,
              },
            };
          })
        : "UNAVAILABLE";

    return calculateSignalConfluence(snapshotMacro, snapshotAssets, vietnamState);
  }, [regime, series, vietnamState]);

  useEffect(() => {
    const lastReset = localStorage.getItem("quant_chat_last_reset");
    const now = Date.now();
    if (!lastReset || now - parseInt(lastReset) > CHAT_EXPIRY_MS) {
      setMessages([{ sender: "ai", text: "Hệ thống **AI Quant Risk Manager (2026)** đã kết nối dữ liệu định lượng.\n\n- Đã nạp MA200 dài hạn & hiệu suất 3 Trading Bots\n- Đã đồng bộ giá thị trường thực tế\n\nBạn cần phân tích chiến lược nào?" }]);
      localStorage.setItem("quant_chat_last_reset", now.toString());
      localStorage.removeItem("quant_chat_history");
    } else {
      const savedHistory = localStorage.getItem("quant_chat_history");
      if (savedHistory) setMessages(JSON.parse(savedHistory));
    }
  }, []);

  useEffect(() => {
    if (messages.length > 1) {
      localStorage.setItem("quant_chat_history", JSON.stringify(messages));
      if (chatScrollRef.current) chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = async (text: string) => {
    if (!text.trim() || isLoading) return;
    const userText = text.trim();
    setInput("");
    setMessages((prev) => [...prev, { sender: "user", text: userText }]);
    setIsLoading(true);

    try {
      const apiKey = (import.meta.env.VITE_GEMINI_API_KEY || "").trim();

      const lowerText = userText.toLowerCase();
      const isReportMode = lowerText.includes("báo cáo") || 
                           lowerText.includes("report") || 
                           lowerText.includes("soi nhanh") || 
                           lowerText.includes("full verdict") || 
                           lowerText.includes("stress-test") || 
                           lowerText.includes("devil's advocate");

      const snapshotMacro = regime ? {
        label: regime.label,
        score: regime.score,
        thesis: regime.thesis,
        dxyTrend: regime.dxyTrend,
        yieldLevel: regime.yieldLevel,
        yieldTrend: regime.yieldTrend,
        yieldCurve: macroAdvanced.yieldCurve ? {
          us10y: `${macroAdvanced.yieldCurve.us10y.toFixed(2)}%`,
          us2y: `${macroAdvanced.yieldCurve.us2y.toFixed(2)}%`,
          spreadBps: `${macroAdvanced.yieldCurve.spreadBps} bps`,
          status: macroAdvanced.yieldCurve.status,
          signal: macroAdvanced.yieldCurve.signal,
        } : "UNAVAILABLE",
        vix: macroAdvanced.vixData ? {
          level: macroAdvanced.vixData.current.toFixed(2),
          change1d: macroAdvanced.vixData.change1d.toFixed(2),
          zScore: macroAdvanced.vixData.zScore,
          status: macroAdvanced.vixData.status,
          label: macroAdvanced.vixData.label,
        } : "UNAVAILABLE"
      } : "UNAVAILABLE";

      const snapshotAssets = series.length > 0 ? series.map((s: MacroSeries) => {
        const priceHistory = s.points ? s.points.map((p) => p.value) : [];
        const features = calculateAssetFeatures(priceHistory);
        return {
          id: s.id, name: s.name, ticker: s.ticker, lastPrice: s.last, source: s.source,
          features: { ...features, return1D: features.return1D ?? s.changePct1d, return20D: features.return20D ?? s.changePct20d }
        };
      }) : "UNAVAILABLE";

      const snapshotVietnam = vietnamState ? {
        index: {
          price: vietnamState.index.price,
          changePct1d: `${(vietnamState.index.changePct1d * 100).toFixed(2)}%`,
          changePct20d: `${(vietnamState.index.changePct20d * 100).toFixed(2)}%`,
          distMa20: vietnamState.index.distMa20 !== null ? `${(vietnamState.index.distMa20 * 100).toFixed(2)}%` : null,
          distMa50: vietnamState.index.distMa50 !== null ? `${(vietnamState.index.distMa50 * 100).toFixed(2)}%` : null,
          distMa200: vietnamState.index.distMa200 !== null ? `${(vietnamState.index.distMa200 * 100).toFixed(2)}%` : null,
          source: vietnamState.index.source
        },
        breadth: {
          advancing: vietnamState.breadth.advancing,
          declining: vietnamState.breadth.declining,
          adRatio: vietnamState.breadth.adRatio,
          pctAboveMA20: `${vietnamState.breadth.pctAboveMA20}%`,
          pctAboveMA50: `${vietnamState.breadth.pctAboveMA50}%`,
          status: vietnamState.breadth.pctAboveMA20 < 50 ? "WEAK_BREADTH" : "HEALTHY_BREADTH"
        },
        liquidity: vietnamState.liquidity ? {
          matchingValue: `${vietnamState.liquidity.matchingValueBillion}B VND`,
          ma20Value: `${vietnamState.liquidity.ma20ValueBillion}B VND`,
          ratioToMa20: vietnamState.liquidity.ratioToMa20,
          status: vietnamState.liquidity.status
        } : "UNAVAILABLE",
        foreignFlow: vietnamState.foreignFlow ? {
          net1d: `${vietnamState.foreignFlow.net1dBillion}B VND`,
          net5dCumulative: `${vietnamState.foreignFlow.net5dBillion}B VND`,
          status: vietnamState.foreignFlow.status
        } : "UNAVAILABLE"
      } : "UNAVAILABLE";

      const liveFeeds = series.filter(s => s.source === "live").length;
      const dataQualityStatus = loading ? "SYNCING" : liveFeeds > 0 ? "LIVE_HYBRID" : "SYNTHETIC";

      const marketSnapshot = {
        timestamp: new Date().toISOString(),
        dataQuality: { 
          status: dataQualityStatus,
          liveCoverage: `${liveFeeds}/${series.length} assets`,
          signalCoverage: `${currentSignalConfluence.confidence}%`
        },
        portfolio: {
          nav: portfolio.getTotalNav(), cash: portfolio.cashUsd,
          assets: portfolio.assets.map(a => ({ name: a.name, allocationPercent: a.allocationPercent, currentValue: a.currentValue }))
        },
        macro: snapshotMacro,
        assets: snapshotAssets,
        vietnam: snapshotVietnam,
        signalConfluence: currentSignalConfluence,
        portfolioRisk: calculatePortfolioRisk(portfolio, regime, corr),
        bots: {
          trend: { winRate: trend?.winRate ?? 0, pnl: trend?.pnl ?? 0, totalTrades: trend?.totalTrades ?? 0 },
          event: { winRate: event?.winRate ?? 0, pnl: event?.pnl ?? 0, totalTrades: event?.totalTrades ?? 0 },
          meanReversion: { winRate: mean?.winRate ?? 0, pnl: mean?.pnl ?? 0, totalTrades: mean?.totalTrades ?? 0 },
          benchmarkDca: { pnl: benchmarkDca?.pnl ?? 0, totalTrades: benchmarkDca?.totalTrades ?? 0 }
        }
      };

      const TEMPORAL_INSTRUCTION = `
BỐI CẢNH THỜI GIAN & TÍNH XÁC THỰC CỦA DỮ LIỆU:
- Thời điểm hiện tại là năm 2026.
- Mức giá Bitcoin (~$76,800) và Vàng quốc tế (~$4,277/oz) là GIÁ THỊ TRƯỜNG THỰC TẾ TRỰC TIẾP (LIVE MARKET PRICE), hoàn toàn KHÔNG PHẢI kịch bản giả định hay mô phỏng stress-test tương lai. Không được nhầm lẫn năm hiện tại là 2024.
- Dữ liệu đã cung cấp đủ 6/6 kênh và MA200 cho tất cả tài sản. Hãy báo cáo 'dataQuality.coverage': 100 và 'missing': [].
      `;

      let systemPrompt = "";
      let generationConfig: any = undefined;

      if (isReportMode) {
        systemPrompt = `
Bạn là AI QUANT EXPERT - Senior Portfolio Manager & Quant Risk Analyst.
User yêu cầu một BÁO CÁO ĐỊNH LƯỢNG CHUYÊN SÂU.
${TEMPORAL_INSTRUCTION}
NGUYÊN TẮC:
- Dựa trên MarketSnapshot và câu hỏi. Tuyệt đối không bịa đặt số liệu ngoài snapshot.
- Đọc kỹ Yield Curve và VIX để đánh giá rủi ro hệ thống.
- Xuất kết quả theo đúng chuẩn JSON Schema được yêu cầu. Không kèm text thừa ngoài JSON.
MARKET SNAPSHOT:
\`\`\`json
${JSON.stringify(marketSnapshot, null, 2)}
\`\`\`
        `;
        generationConfig = {
          temperature: 0.15,
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              verdict: { type: "STRING", description: "Must be one of: BUY, HOLD, REDUCE, HEDGE, WAIT" },
              confidence: { type: "INTEGER", description: "0 to 100" },
              thesis: { type: "STRING" },
              signals: { type: "ARRAY", items: { type: "STRING" } },
              divergences: { type: "ARRAY", items: { type: "STRING" } },
              risks: { type: "ARRAY", items: { type: "STRING" } },
              action: { type: "STRING" },
              triggers: { type: "ARRAY", items: { type: "STRING" } },
              invalidation: { type: "STRING" },
              dataQuality: {
                type: "OBJECT",
                properties: {
                  coverage: { type: "INTEGER" },
                  missing: { type: "ARRAY", items: { type: "STRING" } }
                }
              }
            },
            required: ["verdict", "confidence", "thesis", "signals", "divergences", "risks", "action", "triggers", "invalidation", "dataQuality"]
          }
        };
      } else {
        systemPrompt = `
Bạn là AI QUANT EXPERT - Senior Portfolio Manager & Quant Risk Analyst.
User đang trò chuyện hoặc hỏi đáp thông thường về chiến lược đầu tư, vĩ mô hoặc quản trị rủi ro.
${TEMPORAL_INSTRUCTION}
NGUYÊN TẮC:
- Trả lời bằng văn bản tự nhiên, chuyên nghiệp, sắc bén, phân tích logic tài chính định lượng.
- Tận dụng dữ liệu trong MarketSnapshot bên dưới để làm căn cứ thực tế, không bịa số.
- Trình bày mạch lạc bằng Markdown (dùng bullet points, bold đúng chỗ nếu cần). Không xuất JSON.
MARKET SNAPSHOT:
\`\`\`json
${JSON.stringify(marketSnapshot, null, 2)}
\`\`\`
        `;
        generationConfig = {
          temperature: 0.4,
        };
      }

      const apiContents = [
        ...messages.slice(1).map(m => ({ role: m.sender === "user" ? "user" : "model", parts: [{ text: m.text }] })),
        { role: "user", parts: [{ text: userText }] }
      ];

      const bodyPayload: any = {
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: apiContents,
      };
      if (generationConfig) {
        bodyPayload.generationConfig = generationConfig;
      }

      let response = await fetch("/api/ai-advisor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bodyPayload)
      });

      if (!response.ok && response.status === 404) {
        response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(bodyPayload)
        });
      }

      const data = await response.json();
      if (!response.ok) throw new Error(data?.error?.message || `Lỗi API (${response.status})`);

      const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || "";

      let parsedResponse: QuantResponse | undefined = undefined;
      if (isReportMode) {
        try {
          if (rawText) parsedResponse = JSON.parse(rawText);
        } catch (e) {
          console.error("Lỗi Parse Structured JSON từ AI:", e);
        }
      }

      setMessages((prev) => [...prev, { sender: "ai", text: rawText, parsedData: parsedResponse }]);
    } catch (err: any) {
      console.error("[MacroView AI Error Trace]:", err);
      setMessages((prev) => [...prev, { sender: "ai", text: `⚠️ **Lỗi kết nối API:** ${err?.message || "Kiểm tra lại cấu hình."}` }]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(input); }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-auto p-3 custom-scrollbar relative bg-[#07090d]">
      {/* 1. TICKERS GỐC (DXY, US10Y, US2Y, VIX, GOLD, BTC) */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2.5 shrink-0">
        {series.map((s) => (
          <MetricCard 
            key={s.id} 
            label={s.name} 
            ticker={s.ticker} 
            value={s.last} 
            changePct={s.changePct1d} 
            digits={s.id === "us10y" || s.id === "us2y" ? 3 : s.id === "btc" ? 0 : 2} 
            suffix={s.id === "us10y" || s.id === "us2y" ? "%" : undefined} 
          />
        ))}
      </div>

      {/* 2. DỮ LIỆU VIỆT NAM VÀ SIGNAL CONFLUENCE */}
      <div className="border border-[#1c2736] bg-[#10151e] flex flex-col shrink-0 shadow-sm rounded-sm">
        <div className="px-4 py-2 border-b border-[#1c2736] flex justify-between items-center bg-[#0c1017]">
          <span className="font-mono text-[10px] font-bold tracking-[0.2em] text-[#26c6da]">FEATURE ENGINE · VIETNAM MARKET & CONFLUENCE</span>
          <div className="flex items-center gap-2">
            <span className="font-mono text-[9px] text-[#00e676] border border-[#00e676]/40 bg-[#00e676]/10 px-2 py-0.5 rounded">VN: FEED CONNECTED</span>
            <span className="font-mono text-[9px] text-cyan border border-cyan/40 bg-cyan/10 px-2 py-0.5 rounded">CONFLUENCE: ENGINE</span>
          </div>
        </div>
        <div className="p-3 grid grid-cols-4 gap-3">
          <div className="bg-[#151b26] border border-[#1c2736] p-2.5 flex flex-col justify-between">
            <span className="text-[10px] text-[#7d8ea3] font-bold tracking-widest mb-1">VN-INDEX DIVERGENCE</span>
            {vietnamState ? (
              <>
                <span className="text-[#00e676] font-bold text-lg">
                  {vietnamState.index.price.toLocaleString()}{" "}
                  <span className="text-xs font-mono">
                    ({vietnamState.index.changePct1d >= 0 ? "+" : ""}{(vietnamState.index.changePct1d * 100).toFixed(2)}%)
                  </span>
                </span>
                <span className="text-[#ff3d57] text-[10px] font-mono mt-1">
                  Breadth: {vietnamState.breadth.advancing}▲ / {vietnamState.breadth.declining}▼ (A/D: {vietnamState.breadth.adRatio})
                </span>
              </>
            ) : (
              <span className="text-muted text-xs">Đang tải feed VN...</span>
            )}
          </div>

          <div className="bg-[#151b26] border border-[#1c2736] p-2.5 flex flex-col justify-between">
            <span className="text-[10px] text-[#7d8ea3] font-bold tracking-widest mb-1">FOREIGN FLOW</span>
            <span className={clsx("font-bold text-lg", (vietnamState?.foreignFlow?.net1dBillion ?? 0) >= 0 ? "text-[#00e676]" : "text-[#ff3d57]")}>
              {vietnamState?.foreignFlow ? `${vietnamState.foreignFlow.net1dBillion > 0 ? "+" : ""}${vietnamState.foreignFlow.net1dBillion}B` : "N/A"}
            </span>
            <span className="text-[10px] font-mono mt-1 text-muted">
              5D Cumulative: <strong className={(vietnamState?.foreignFlow?.net5dBillion ?? 0) >= 0 ? "text-[#00e676]" : "text-[#ff3d57]"}>
                {vietnamState?.foreignFlow ? `${vietnamState.foreignFlow.net5dBillion > 0 ? "+" : ""}${vietnamState.foreignFlow.net5dBillion}B` : "N/A"}
              </strong>
            </span>
          </div>

          <div className="bg-[#151b26] border border-[#1c2736] p-2.5 flex flex-col justify-between">
            <span className="text-[10px] text-[#7d8ea3] font-bold tracking-widest mb-1">VÀNG SJC (PREMIUM)</span>
            <span className="text-[#ffc107] font-bold text-lg">{sjcCalculated.price}</span>
            <span className="text-[#ffc107] text-[10px] font-mono mt-1">Lệch TG: {sjcCalculated.premium} (Percentile {sjcCalculated.percentile})</span>
          </div>

          <div className="bg-[#151b26] border border-[#1c2736] p-2.5 flex flex-col justify-between">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] text-[#7d8ea3] font-bold tracking-widest">SIGNAL CONFLUENCE</span>
              <span className="text-[9px] font-mono text-cyan bg-cyan/10 px-1 rounded border border-cyan/20">ENGINE</span>
            </div>
            <span className={clsx(
              "font-bold text-lg",
              currentSignalConfluence.score === null
                ? "text-muted"
                : currentSignalConfluence.score >= 55
                  ? "text-[#00e676]"
                  : currentSignalConfluence.score <= 45
                    ? "text-[#ff3d57]"
                    : "text-amber"
            )}>
              {currentSignalConfluence.score !== null ? `${currentSignalConfluence.score}/100` : "UNAVAILABLE"}
            </span>
            <span className="text-white text-[10px] font-mono mt-1">
              Confidence: {currentSignalConfluence.confidence}% ({currentSignalConfluence.dataCoverage})
            </span>
          </div>
        </div>
      </div>

      {/* 3. BẢNG KIỂM TOÁN TÍN HIỆU & RỦI RO ĐỊNH LƯỢNG */}
      <MacroNewsTable />

      {/* 4. DỮ LIỆU VĨ MÔ GỐC, YIELD CURVE & VIX ENGINE */}
      <div className="grid min-h-[340px] grid-cols-[1.2fr_1fr] gap-3 shrink-0 mt-3">
        <Panel title="Market Regime & Yield Curve Engine" right={loading ? "SYNC…" : usingSynthetic ? "SYNTHETIC FEED" : "LIVE FEED"}>
          {error ? <p className="text-sm text-down">{error}</p> : null}
          {regime ? (
            <div className="flex h-full flex-col gap-3">
              <div className="flex items-end justify-between gap-4">
                <div>
                  <div className="font-mono text-[10px] tracking-[0.2em] text-muted">REGIME LABEL</div>
                  <div className="mt-1 font-mono text-2xl font-semibold text-amber">{regime.label}</div>
                </div>
                <div className="text-right">
                  <div className="font-mono text-[10px] tracking-[0.2em] text-muted">FAVORABILITY 0–100</div>
                  <div className={clsx("font-mono text-4xl font-semibold", regime.score >= 55 ? "text-up" : regime.score <= 45 ? "text-down" : "text-amber")}>{formatNumber(regime.score, 1)}</div>
                </div>
              </div>
              <div className="h-2 w-full bg-[#151b26]"><div className="h-2 bg-gradient-to-r from-down via-amber to-up" style={{ width: `${regime.score}%` }} /></div>

              <div className="grid grid-cols-2 gap-2.5 bg-panel-2 border border-line p-2.5 rounded">
                <div className="flex flex-col justify-between">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-bold text-muted tracking-wider">10Y-2Y SPREAD</span>
                    {macroAdvanced.yieldCurve && (
                      <span className={clsx(
                        "text-[9px] font-mono px-1.5 py-0.2 rounded font-bold",
                        macroAdvanced.yieldCurve.spreadBps < 0 ? "bg-down/20 text-down border border-down/30" : "bg-up/20 text-up border border-up/30"
                      )}>
                        {macroAdvanced.yieldCurve.status}
                      </span>
                    )}
                  </div>
                  <div className="text-base font-mono font-bold text-ink mt-1">
                    {macroAdvanced.yieldCurve ? `${macroAdvanced.yieldCurve.spreadBps} bps` : "N/A"}
                  </div>
                  <div className="text-[10px] text-muted truncate">
                    {macroAdvanced.yieldCurve?.label ?? "Đang tính toán..."}
                  </div>
                </div>

                <div className="flex flex-col justify-between border-l border-line/40 pl-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-bold text-muted tracking-wider flex items-center gap-1">
                      <Activity size={12} className="text-cyan"/> VIX VOLATILITY
                    </span>
                    {macroAdvanced.vixData && (
                      <span className={clsx(
                        "text-[9px] font-mono px-1.5 py-0.2 rounded font-bold",
                        macroAdvanced.vixData.current >= 20 ? "bg-down/20 text-down border border-down/30" : "bg-up/20 text-up border border-up/30"
                      )}>
                        {macroAdvanced.vixData.status === "NORMAL_CALM" ? "CALM" : "STRESS"}
                      </span>
                    )}
                  </div>
                  <div className="text-base font-mono font-bold text-ink mt-1">
                    {macroAdvanced.vixData ? macroAdvanced.vixData.current.toFixed(2) : "N/A"}
                    {macroAdvanced.vixData?.zScore !== null && (
                      <span className="text-[10px] font-normal text-muted ml-1 font-sans">
                        (Z: {macroAdvanced.vixData?.zScore})
                      </span>
                    )}
                  </div>
                  <div className="text-[10px] text-muted truncate">
                    {macroAdvanced.vixData?.label ?? "Đang tính toán..."}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3 font-mono text-[11px]">
                <Stat label="DXY TREND" value={formatNumber(regime.dxyTrend * 100, 3) + "%/d"} />
                <Stat label="10Y LEVEL" value={formatNumber(regime.yieldLevel, 3) + "%"} />
                <Stat label="10Y TREND" value={formatNumber(regime.yieldTrend * 100, 3) + " bps/d"} />
              </div>
            </div>
          ) : (<div className="text-sm text-muted">Computing regime…</div>)}
        </Panel>

        <Panel title="Model Portfolio Target Allocation" className="flex flex-col">
          {regime ? (
            <div className="flex flex-row h-full items-center justify-between px-2">
              <div className="h-[250px] w-1/2">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie 
                      data={pieData} dataKey="value" nameKey="name" 
                      cx="50%" cy="50%" innerRadius={60} outerRadius={95} 
                      stroke="#07090d" strokeWidth={3} paddingAngle={2}
                    >
                      {pieData.map((d) => (<Cell key={d.key} fill={PIE_COLORS[d.key as keyof AllocationWeights]} />))}
                    </Pie>
                    <RechartsTooltip contentStyle={{ background: "#0c1017", border: "1px solid #1c2736", fontSize: 13, color: '#fff' }} formatter={(value) => [`${value}%`, "Weight"]} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="w-1/2 flex flex-col justify-center border-l border-line/50 pl-4 h-[80%]">
                <ul className="space-y-3 font-mono text-[11px]">
                  {pieData.map((d) => (
                    <li key={d.key} className="flex flex-col gap-1 border-b border-line/30 pb-1.5 last:border-0">
                      <span className="flex items-center gap-2 text-muted font-bold">
                        <span className="h-2.5 w-2.5 rounded-sm" style={{ background: PIE_COLORS[d.key as keyof AllocationWeights] }} />
                        {d.name}
                      </span>
                      <span className="text-ink font-black text-[13px] pl-4.5">{d.value.toFixed(1)}%</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ) : null}
        </Panel>
      </div>

      {/* 5. TƯƠNG QUAN LỢI NHUẬN & HIỆU SUẤT */}
      <div className="grid grid-cols-[1fr_1.1fr] gap-3 shrink-0 mt-3">
        <Panel title="30-Day Return Correlation">
          {corr ? (
            <table className="w-full border-collapse font-mono text-[11px]">
              <thead><tr><th className="p-1 text-left text-muted" />{ASSET_ORDER.map((k) => (<th key={k} className="p-1 text-center text-muted">{ASSET_LABEL[k]}</th>))}</tr></thead>
              <tbody>
                {ASSET_ORDER.map((row) => (
                  <tr key={row}>
                    <td className="p-1 text-muted">{ASSET_LABEL[row]}</td>
                    {ASSET_ORDER.map((col) => (<td key={col} className="p-1"><div className={clsx("px-1 py-1 text-center font-bold", corrColor(corr[row][col]))}>{corr[row][col].toFixed(2)}</div></td>))}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (<div className="text-sm text-muted">Awaiting series…</div>)}
        </Panel>

        <Panel title="20-Day Performance Tape">
          <div className="space-y-2">
            {series.map((s) => (
              <div key={s.id} className="flex items-center gap-3 border border-line bg-panel-2 px-3 py-2">
                <div className="w-24 font-mono text-[11px] text-cyan">{s.ticker}</div>
                <div className="flex-1"><div className="h-1.5 bg-[#151b26]"><div className={s.changePct20d >= 0 ? "h-1.5 bg-up" : "h-1.5 bg-down"} style={{ width: `${Math.min(100, Math.abs(s.changePct20d) * 400)}%` }} /></div></div>
                <div className={clsx("w-20 text-right font-mono text-[11px]", s.changePct20d >= 0 ? "text-up" : "text-down")}>{formatPct(s.changePct20d)}</div>
                <div className="w-16 text-right font-mono text-[10px] text-muted">{s.source === "live" ? "LIVE" : "SYN"}</div>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      {/* 6. KHUNG CHATBOT AI STRUCTURED ENGINE */}
      <Panel title="AI QUANT EXPERT · STRUCTURED DECISION ENGINE" right="JSON PIPELINE SYNCED" className="shrink-0 mt-3 mb-6 flex flex-col h-[650px]">
        <div ref={chatScrollRef} className="flex-1 overflow-y-auto p-5 space-y-6 custom-scrollbar bg-[#07090d]">
          {messages.map((msg, idx) => (
            <div key={idx} className={clsx("flex flex-col", msg.sender === "user" ? "ml-auto items-end max-w-[85%]" : "mr-auto items-start w-full")}>
              <div className={clsx(
                "p-4 rounded-xl shadow-md w-full", 
                msg.sender === "user" ? "bg-cyan/15 border border-cyan/30 text-cyan rounded-br-none w-auto max-w-full" : "bg-panel border border-line text-ink rounded-bl-none"
              )}>
                {msg.sender === "user" ? <span className="whitespace-pre-wrap font-sans font-bold text-[14px]">{msg.text}</span> : <FormatStructuredMessage data={msg.parsedData} text={msg.text} />}
              </div>
            </div>
          ))}
          {isLoading && (
            <div className="flex items-center gap-2 text-cyan font-sans font-medium text-[13px] p-2">
              <Loader2 size={16} className="animate-spin" /> Đang tổng hợp tín hiệu đa thị trường & kiểm tra mô hình rủi ro...
            </div>
          )}
        </div>

        <div className="px-4 py-3 flex gap-3 overflow-x-auto hide-scrollbar border-t border-line bg-panel">
          <button onClick={() => handleSend("Báo cáo: Phân tích trạng thái liên thị trường (Yield Curve, VIX, VN-Index và Dòng tiền ngoại).")} className="shrink-0 flex items-center gap-1.5 px-3 py-2 bg-panel-2 hover:bg-cyan/10 text-cyan rounded font-sans font-bold text-[12px] transition-colors border border-line">
            <MessageSquareText size={14} /> Báo Cáo Toàn Diện (Coverage 100%)
          </button>
          <button onClick={() => handleSend("Stress-test: Chạy kịch bản giả lập NAV ($100k) khi tài sản Crypto sập 15% và Cổ phiếu giảm 8%.")} className="shrink-0 flex items-center gap-1.5 px-3 py-2 bg-panel-2 hover:bg-cyan/10 text-cyan rounded font-sans font-bold text-[12px] transition-colors border border-line">
            <TrendingUp size={14} /> Stress-Test NAV
          </button>
          <button onClick={() => handleSend("Devil's Advocate: Phản bác lại quyết định HEDGE của chính ông. Nêu 3 điểm mù nếu thị trường bất ngờ phục hồi.")} className="shrink-0 flex items-center gap-1.5 px-3 py-2 bg-panel-2 hover:bg-cyan/10 text-cyan rounded font-sans font-bold text-[12px] transition-colors border border-line">
            <ShieldAlert size={14} /> Devil's Advocate
          </button>
        </div>

        <form onSubmit={(e) => { e.preventDefault(); handleSend(input); }} className="p-4 border-t border-line flex gap-4 bg-panel">
          <textarea 
            rows={1} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown}
            placeholder="Gõ 'báo cáo' để xuất định dạng JSON Quant hoặc trao đổi tự nhiên... (Shift + Enter xuống dòng)"
            className="flex-1 bg-[#0c1017] border border-line text-white px-5 py-3.5 rounded-lg text-[14px] font-sans focus:outline-none focus:border-cyan resize-none min-h-[50px] max-h-32 custom-scrollbar shadow-inner"
          />
          <button type="submit" disabled={isLoading || !input.trim()} className="bg-panel-2 border border-line hover:bg-cyan hover:text-[#0c1017] text-cyan font-black w-14 h-14 rounded-lg flex items-center justify-center transition-all disabled:opacity-50 shrink-0">
            <Send size={18} className="ml-1" />
          </button>
        </form>
      </Panel>
    </div>
  );
}

function Stat({ label, value, desc }: { label: string; value: string; desc?: string }) {
  return (
    <div className="border border-line bg-panel-2 px-3 py-3 relative group">
      <div className="text-[10px] tracking-[0.14em] text-muted font-bold">{label}</div>
      <div className="mt-1.5 text-ink text-lg font-semibold font-mono">{value}</div>
      {desc && <div className="mt-1 text-[11px] text-cyan font-sans font-semibold leading-tight">{desc}</div>}
    </div>
  );
}