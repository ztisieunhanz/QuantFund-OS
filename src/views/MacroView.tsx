import React, { useEffect, useMemo, useState, useRef } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip as RechartsTooltip } from "recharts";
import { BrainCircuit, Loader2, Send, MessageSquareText, Target, TrendingUp, AlertTriangle } from "lucide-react";
import { Panel } from "@/components/ui/Panel";
import { MetricCard } from "@/components/ui/MetricCard";
import { MacroNewsTable } from "@/components/MacroNewsTable";
import { thirtyDayCorrelation } from "@/lib/correlation";
import { clsx } from "@/lib/clsx";
import { formatNumber, formatPct, formatUsd } from "@/lib/math";
import { useMacroStore } from "@/stores/macroStore";
import { usePortfolioStore } from "@/stores/portfolioStore";
import { useTradingStore } from "@/stores/tradingStore";
import type { AllocationWeights, AssetKey } from "@/types/market";

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

const FormatMessage = ({ text }: { text: string }) => {
  const lines = text.split('\n');
  return (
    <div className="space-y-2 text-[14px] leading-relaxed text-ink font-sans tracking-wide">
      {lines.map((line, i) => {
        if (!line.trim()) return <div key={i} className="h-1.5"></div>;
        
        let formatted = line
          .replace(/\*\*(.*?)\*\*/g, '<strong class="text-white font-bold">$1</strong>')
          .replace(/\*(.*?)\*/g, '<em class="text-muted italic">$1</em>');

        if (formatted.startsWith('### ')) return <h3 key={i} className="text-cyan font-bold text-[15px] mt-4 mb-2 uppercase" dangerouslySetInnerHTML={{ __html: formatted.replace('### ', '') }} />;
        if (formatted.startsWith('## ')) return <h2 key={i} className="text-[#82b1ff] font-bold text-[16px] mt-5 mb-2" dangerouslySetInnerHTML={{ __html: formatted.replace('## ', '') }} />;
        if (formatted.startsWith('- ') || formatted.startsWith('* ')) return (
          <div key={i} className="flex gap-2.5 items-start">
            <span className="text-cyan font-bold mt-0.5">•</span>
            <span dangerouslySetInnerHTML={{ __html: formatted.substring(2) }} />
          </div>
        );
        return <div key={i} dangerouslySetInnerHTML={{ __html: formatted }} />;
      })}
    </div>
  );
};

// ============================================================================
// FEATURE ENGINE HELPER
// ============================================================================
function calculateAssetFeatures(history?: number[]) {
  const defaultFeatures = {
    return1D: null as number | null, return5D: null as number | null, return20D: null as number | null,
    ma20: null as number | null, ma50: null as number | null, ma200: null as number | null,
    distMa20: null as number | null, distMa50: null as number | null, distMa200: null as number | null,
    volatility20D: null as number | null,
  };

  if (!history || !Array.isArray(history) || history.length === 0) return defaultFeatures;

  const len = history.length;
  const lastPrice = history[len - 1];

  const getReturn = (days: number) => {
    if (len <= days) return null;
    return history[len - 1 - days] ? (lastPrice - history[len - 1 - days]!) / history[len - 1 - days]! : null;
  };
  const getMA = (days: number) => {
    if (len < days) return null;
    return history.slice(len - days).reduce((a, b) => a + b, 0) / days;
  };
  const getDist = (price: number, ma: number | null) => (ma ? (price - ma) / ma : null);
  const getVol = (days: number) => {
    if (len < days + 1) return null;
    const returns = [];
    for (let i = len - days; i < len; i++) {
      const prev = history[i - 1];
      returns.push(prev ? (history[i] - prev) / prev : 0);
    }
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const varTotal = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / returns.length;
    return Math.sqrt(varTotal) * Math.sqrt(252);
  };

  const ma20 = getMA(20), ma50 = getMA(50), ma200 = getMA(200);

  return {
    return1D: getReturn(1), return5D: getReturn(5), return20D: getReturn(20),
    ma20, ma50, ma200, distMa20: getDist(lastPrice, ma20), distMa50: getDist(lastPrice, ma50), distMa200: getDist(lastPrice, ma200),
    volatility20D: getVol(20),
  };
}

// ============================================================================
// SIGNAL CONFLUENCE ENGINE 
// ============================================================================
function calculateSignalConfluence(macroRegime: any, assets: any, vietnam: any) {
  const WEIGHTS = { macro: 0.25, liquidity: 0.15, trend: 0.20, breadth: 0.15, flow: 0.15, crossAsset: 0.10 };
  let totalWeight = 0, earnedScore = 0, dataCoverage = 0;
  const factors = [], divergences = [];
  const totalDataFields = 6;

  if (macroRegime && typeof macroRegime.score === 'number') {
    totalWeight += WEIGHTS.macro; earnedScore += (macroRegime.score / 100) * WEIGHTS.macro;
    factors.push({ name: "Macro", score: macroRegime.score, status: macroRegime.score >= 55 ? "BULLISH" : macroRegime.score <= 45 ? "BEARISH" : "NEUTRAL" });
    dataCoverage++;
  } else factors.push({ name: "Macro", score: null, status: "UNAVAILABLE" });

  if (vietnam && vietnam.liquidity && vietnam.liquidity !== "UNAVAILABLE") {
    let score = 50;
    if (vietnam.liquidity.volumeTrend === "RISING") score += 20; else if (vietnam.liquidity.volumeTrend === "FALLING") score -= 20;
    if (vietnam.liquidity.turnoverVs20D > 1) score += 15; else if (vietnam.liquidity.turnoverVs20D < 1) score -= 15;
    totalWeight += WEIGHTS.liquidity; earnedScore += (score / 100) * WEIGHTS.liquidity;
    factors.push({ name: "Liquidity", score, status: score > 50 ? "BULLISH" : "BEARISH" });
    dataCoverage++;
  } else factors.push({ name: "Liquidity", score: null, status: "UNAVAILABLE" });

  let trendScore = null, isPriceUp = false;
  if (vietnam && vietnam.index && vietnam.index !== "UNAVAILABLE") {
    trendScore = 50;
    if (vietnam.index.ret20d > 0) { trendScore += 25; isPriceUp = true; } else trendScore -= 25;
    if (vietnam.index.distMa50 > 0) trendScore += 25; else trendScore -= 25;
  } else {
    const btc = assets !== "UNAVAILABLE" ? assets.find((a: any) => a.id === "btc") : null;
    if (btc && btc.features && btc.features.return20D !== null) {
      trendScore = 50;
      if (btc.features.return20D > 0) { trendScore += 25; isPriceUp = true; } else trendScore -= 25;
      if (btc.features.distMa50 !== null && btc.features.distMa50 > 0) trendScore += 25; else trendScore -= 25;
    }
  }

  if (trendScore !== null) {
    totalWeight += WEIGHTS.trend; earnedScore += (trendScore / 100) * WEIGHTS.trend;
    factors.push({ name: "Price/Trend", score: Math.max(0, Math.min(100, trendScore)), status: trendScore >= 55 ? "BULLISH" : trendScore <= 45 ? "BEARISH" : "NEUTRAL" });
    dataCoverage++;
  } else factors.push({ name: "Price/Trend", score: null, status: "UNAVAILABLE" });

  let isBreadthWeak = false;
  if (vietnam && vietnam.breadth && vietnam.breadth !== "UNAVAILABLE") {
    let score = 50;
    if (vietnam.breadth.pctAboveMA20 > 50) score += 25; else { score -= 25; isBreadthWeak = true; }
    if (vietnam.breadth.adRatio > 1) score += 25; else score -= 25;
    totalWeight += WEIGHTS.breadth; earnedScore += (score / 100) * WEIGHTS.breadth;
    factors.push({ name: "Breadth", score: Math.max(0, Math.min(100, score)), status: score >= 55 ? "BULLISH" : score <= 45 ? "BEARISH" : "NEUTRAL" });
    dataCoverage++;
  } else factors.push({ name: "Breadth", score: null, status: "UNAVAILABLE" });

  let isForeignOutflow = false;
  if (vietnam && vietnam.foreignFlow && vietnam.foreignFlow !== "UNAVAILABLE") {
    let score = 50;
    if (vietnam.foreignFlow.cumulative5D > 0) score += 25; else { score -= 25; isForeignOutflow = true; }
    if (vietnam.foreignFlow.net1D > 0) score += 25; else score -= 25;
    totalWeight += WEIGHTS.flow; earnedScore += (score / 100) * WEIGHTS.flow;
    factors.push({ name: "Foreign Flow", score: Math.max(0, Math.min(100, score)), status: score >= 55 ? "BULLISH" : score <= 45 ? "BEARISH" : "NEUTRAL" });
    dataCoverage++;
  } else factors.push({ name: "Foreign Flow", score: null, status: "UNAVAILABLE" });

  const dxy = assets !== "UNAVAILABLE" ? assets.find((a: any) => a.id === "dxy") : null;
  const us10y = assets !== "UNAVAILABLE" ? assets.find((a: any) => a.id === "us10y") : null;
  if (dxy && dxy.features && us10y && us10y.features) {
    let score = 50;
    if (dxy.features.return20D !== null && dxy.features.return20D < 0) score += 25; else score -= 25;
    if (us10y.features.return20D !== null && us10y.features.return20D < 0) score += 25; else score -= 25;
    totalWeight += WEIGHTS.crossAsset; earnedScore += (score / 100) * WEIGHTS.crossAsset;
    factors.push({ name: "Cross-Asset", score: Math.max(0, Math.min(100, score)), status: score >= 55 ? "BULLISH" : score <= 45 ? "BEARISH" : "NEUTRAL" });
    dataCoverage++;
  } else factors.push({ name: "Cross-Asset", score: null, status: "UNAVAILABLE" });

  if (isPriceUp && isBreadthWeak) divergences.push("Index Up + Breadth Weak");
  if (isPriceUp && vietnam?.liquidity?.volumeTrend === "FALLING") divergences.push("Price Up + Volume Weak");
  if (isPriceUp && isForeignOutflow) divergences.push("Index Up + Foreign Outflow");

  return {
    score: totalWeight > 0 ? Math.round((earnedScore / totalWeight) * 100) : null,
    confidence: Math.round((dataCoverage / totalDataFields) * 100),
    factors, divergences, dataCoverage: `${dataCoverage}/${totalDataFields}`
  };
}

// ============================================================================
// BƯỚC 11: PORTFOLIO RISK ENGINE
// ============================================================================
function calculatePortfolioRisk(portfolio: any, regime: any, corr: any) {
  const nav = portfolio.getTotalNav();
  const cashPct = nav > 0 ? (portfolio.cashUsd / nav) * 100 : 0;

  let largestPosition = { name: "Cash", pct: cashPct };
  
  const exposures = {
    equity: 0,
    gold: 0,
    realEstate: 0,
    crypto: 0,
    cash: cashPct
  };

  const allocation = portfolio.assets.map((a: any) => {
    if (a.allocationPercent > largestPosition.pct) {
      largestPosition = { name: a.name, pct: a.allocationPercent };
    }
    
    const nameLower = a.name.toLowerCase();
    if (nameLower.includes("equit") || nameLower.includes("cổ phiếu") || nameLower.includes("stock")) exposures.equity += a.allocationPercent;
    else if (nameLower.includes("gold") || nameLower.includes("vàng")) exposures.gold += a.allocationPercent;
    else if (nameLower.includes("estate") || nameLower.includes("bđs") || nameLower.includes("bất động sản")) exposures.realEstate += a.allocationPercent;
    else if (nameLower.includes("crypto") || nameLower.includes("btc") || nameLower.includes("bitcoin")) exposures.crypto += a.allocationPercent;
    
    return { asset: a.name, weight: a.allocationPercent };
  });

  allocation.push({ asset: "USD Cash", weight: cashPct });

  const riskFlags: string[] = [];

  // 1. Concentration Risk
  if (largestPosition.pct > 40) {
    riskFlags.push(`Concentration Risk: ${largestPosition.name} chiếm tỷ trọng quá lớn (${largestPosition.pct.toFixed(1)}%)`);
  }

  // 2. Regime Mismatch Risk
  if (regime) {
    if (regime.score <= 45 && exposures.equity > 40) {
      riskFlags.push(`Regime Mismatch: Tỷ trọng Cổ phiếu cao (${exposures.equity.toFixed(1)}%) trong môi trường Risk-Off (Score: ${regime.score})`);
    }
    if (regime.score >= 55 && exposures.cash > 40) {
      riskFlags.push(`Regime Mismatch: Tiền mặt quá cao (${exposures.cash.toFixed(1)}%) trong môi trường Risk-On (Score: ${regime.score}) -> Cash Drag Risk`);
    }
  }

  // 3. Correlated Exposure (Using Correlation Matrix)
  if (corr && corr["btc"] && corr["gold"]) {
    const btcGoldCorr = corr["btc"]["gold"];
    if (btcGoldCorr > 0.6 && (exposures.crypto + exposures.gold > 50)) {
      riskFlags.push(`Correlated Exposure: Vàng và Crypto đang đồng pha mạnh (Corr: ${btcGoldCorr.toFixed(2)}) và chiếm >50% danh mục`);
    }
  }

  return {
    allocation,
    concentration: largestPosition,
    exposure: exposures,
    riskFlags
  };
}
// ============================================================================

export function MacroView() {
  const { loading, error, series, regime, correlation, load } = useMacroStore();
  const portfolio = usePortfolioStore();
  const { trend, mean, dca } = useTradingStore();
  
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Array<{ sender: "user" | "ai"; text: string }>>([]);
  const [isLoading, setIsLoading] = useState(false);
  const chatScrollRef = useRef<HTMLDivElement>(null);

  const enhancedData = {
    macroSurprise: { cpi: { actual: "3.1%", expected: "2.9%", prev: "3.0%", impact: "INFLATION SURPRISE: +0.2%" }, fedNextMeet: "35% hike, 65% hold (FOMC 15-16/9)" },
    yieldCurve: { us2y: "4.85%", us10y: "4.58%", spread: "-27 bps (Inverted)" },
    vietnamMarket: {
      vnindex: { price: 1280.5, ret1d: "+0.8%", ret20d: "+5.7%", distMA20: "+2.4%", distMA50: "+4.8%", distMA200: "-1.2%", breadth: "A/D = 145/320", pctAboveMA20: "38%", pctAboveMA50: "31%" },
      foreignFlow: { d1: "-500B", d5: "-1,200B", d20: "+300B" },
      liquidity: { turnoverRatio20d: 1.32 },
      usdvnd: "25,450 (Ổn định)",
      sjcGold: { price: "82.5M", premium: "+4M", premiumPercentile: "96%" }
    },
    signalConfluence: {
      score: 71, confidence: 68,
      factors: [ { name: "Inflation", val: "+++", status: "High" }, { name: "Liquidity", val: "++", status: "Neutral" }, { name: "USD", val: "+++", status: "High" }, { name: "Breadth", val: "-", status: "Weak" }, { name: "Foreign", val: "--", status: "Outflow" } ]
    }
  };

  useEffect(() => { if (series.length === 0) void load(); }, [load, series.length]);

  const pieData = useMemo(() => {
    if (!regime) return [];
    return (Object.keys(regime.allocation) as Array<keyof AllocationWeights>).map((key) => ({
      key, name: PIE_LABELS[key], value: Math.round(regime.allocation[key] * 1000) / 10,
    }));
  }, [regime]);

  const corr = correlation ?? (series.length ? thirtyDayCorrelation(series) : null);
  const usingSynthetic = series.some((s) => s.source === "synthetic");

  useEffect(() => {
    const lastReset = localStorage.getItem("quant_chat_last_reset");
    const now = Date.now();
    if (!lastReset || now - parseInt(lastReset) > CHAT_EXPIRY_MS) {
      setMessages([{ sender: "ai", text: "Hệ thống **AI Quant Risk Manager** đã khởi động.\n\nĐã khởi tạo MarketSnapshot:\n- Asset Feature Engine: Nạp thành công\n- Signal Confluence Engine: Nạp thành công\n- Portfolio Risk Engine: Nạp thành công\n\nBạn cần phân tích chiến lược nào?" }]);
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
      
      const snapshotMacro = regime ? { label: regime.label, score: regime.score, thesis: regime.thesis, dxyTrend: regime.dxyTrend, yieldLevel: regime.yieldLevel, yieldTrend: regime.yieldTrend } : "UNAVAILABLE";
      
      const snapshotAssets = series.length > 0 ? series.map(s => {
        const features = calculateAssetFeatures((s as any).history);
        return {
          id: s.id, name: s.name, ticker: s.ticker, lastPrice: s.last, source: s.source,
          features: { ...features, return1D: features.return1D ?? s.changePct1d, return20D: features.return20D ?? s.changePct20d }
        };
      }) : "UNAVAILABLE";

      const snapshotVietnam = "UNAVAILABLE"; 

      // XÂY DỰNG MARKET SNAPSHOT (DATA CONTRACT)
      const marketSnapshot = {
        timestamp: new Date().toISOString(),
        dataQuality: { status: loading ? "UNAVAILABLE" : usingSynthetic ? "SYNTHETIC" : "LIVE" },
        portfolio: {
          nav: portfolio.getTotalNav(), cash: portfolio.cashUsd,
          assets: portfolio.assets.map(a => ({ name: a.name, allocationPercent: a.allocationPercent, currentValue: a.currentValue }))
        },
        macro: snapshotMacro,
        assets: snapshotAssets,
        vietnam: snapshotVietnam,
        
        signalConfluence: calculateSignalConfluence(snapshotMacro, snapshotAssets, snapshotVietnam),
        
        // BƯỚC 11: TÍCH HỢP PORTFOLIO RISK SNAPSHOT
        portfolioRisk: calculatePortfolioRisk(portfolio, regime, corr),

        bots: {
          trend: { winRate: trend.winRate, pnl: trend.pnl, totalTrades: trend.totalTrades },
          meanReversion: { winRate: mean.winRate, pnl: mean.pnl, totalTrades: mean.totalTrades },
          dca: { pnl: dca.pnl, totalTrades: dca.totalTrades }
        }
      };

      // GIỮ NGUYÊN SYSTEM PROMPT
      const systemPrompt = `
        Bạn là AI QUANT EXPERT, hoạt động như một Senior Portfolio Manager + Quant Risk Analyst tại một quỹ đầu tư định lượng.
        MỤC TIÊU:
        1. Xác định market regime.
        2. Phân biệt SIGNAL với NOISE.
        3. Đánh giá risk/reward.
        4. Đưa ra ACTION cụ thể.

        DƯỚI ĐÂY LÀ MARKET SNAPSHOT (DỮ LIỆU THỰC TẾ TRÍCH XUẤT TỪ HỆ THỐNG):
        \`\`\`json
        ${JSON.stringify(marketSnapshot, null, 2)}
        \`\`\`

        LUẬT LỆ TỐI THƯỢNG:
        - CHỈ SỬ DỤNG dữ liệu có trong MARKET SNAPSHOT JSON ở trên. 
        - Hãy xem kỹ trường "signalConfluence". Nếu "confidence" thấp do thiếu data ("UNAVAILABLE"), bạn phải cảnh báo rủi ro thiếu dữ liệu.
        - Đừng tự tính lại Score, Code Engine đã tính rồi, bạn chỉ việc diễn giải ý nghĩa của các Divergences (nếu có) và Factors trong Signal Confluence.

        TRẢ LỜI THEO FORMAT BẮT BUỘC SAU KHI USER HỎI:
        ### VERDICT
        BUY / HOLD / REDUCE / HEDGE / WAIT

        ### WHY
        (3-5 lý do mạnh nhất trích xuất từ json)

        ### CONFIDENCE
        (0-100%)

        ### ACTION
        (Tỷ trọng, hành động cụ thể cho danh mục hoặc bot)

        ### TRIGGER
        (Chờ điều kiện gì để hành động tiếp theo)

        ### INVALIDATION
        (Khi nào luận điểm này sai)
      `;

      const apiContents = [
        ...messages.slice(1).map(m => ({ role: m.sender === "user" ? "user" : "model", parts: [{ text: m.text }] })),
        { role: "user", parts: [{ text: userText }] }
      ];

      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: apiContents, 
          generationConfig: { temperature: 0.1 } 
        })
      });

      const data = await response.json();
      if (!response.ok) throw new Error("Lỗi API");
      setMessages((prev) => [...prev, { sender: "ai", text: data.candidates?.[0]?.content?.parts?.[0]?.text || "Lỗi phản hồi." }]);
    } catch (err) {
      setMessages((prev) => [...prev, { sender: "ai", text: "⚠️ **Lỗi kết nối API.** Kiểm tra lại khóa VITE_GEMINI_API_KEY." }]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(input); }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-auto p-3 custom-scrollbar relative bg-[#07090d]">
      
      {/* 0. DẢI TIN TỨC CHẠY NGANG (MOCK DATA - UI ONLY) */}
      <style dangerouslySetInnerHTML={{__html: `
        @keyframes ticker { 0% { transform: translateX(100vw); } 100% { transform: translateX(-100%); } }
        .animate-ticker { display: inline-block; white-space: nowrap; animation: ticker 40s linear infinite; will-change: transform; }
        .ticker-container:hover .animate-ticker { animation-play-state: paused; cursor: default; }
      `}} />
      <div className="ticker-container flex items-center bg-panel border border-line p-1.5 overflow-hidden shrink-0 rounded-sm">
        <div className="font-mono text-[11px] font-bold tracking-[0.15em] text-[#07090d] bg-amber px-2 py-0.5 rounded-sm mr-3 shrink-0 flex items-center gap-1.5 z-10 relative">
          <span className="w-1.5 h-1.5 bg-[#07090d] rounded-full animate-pulse"></span>
          MARKET FEED (MOCK)
        </div>
        <div className="flex-1 overflow-hidden relative h-5 flex items-center">
          <div className="animate-ticker font-mono text-[12px] text-[#d7e2ee] flex gap-12 absolute">
            <span className="text-up">🟢 FED CẮT GIẢM 50BPS: Chu kỳ nới lỏng chính sách tiền tệ bắt đầu.</span>
            <span className="text-down">🔴 ĐỊA CHÍNH TRỊ: Căng thẳng Trung Đông bùng phát, giá dầu thô Brent vượt $90/thùng.</span>
            <span className="text-amber">⚠️ THỊ TRƯỜNG VN: Ngân hàng Nhà nước duy trì linh hoạt tỷ giá USD/VND.</span>
            <span className="text-cyan">💎 DÒNG TIỀN: Cổ phiếu công nghệ tiếp tục hút vốn.</span>
          </div>
        </div>
      </div>

      {/* 1. TICKERS GỐC */}
      <div className="grid grid-cols-4 gap-3 shrink-0 mt-1">
        {series.map((s) => (
          <MetricCard key={s.id} label={s.name} ticker={s.ticker} value={s.last} changePct={s.changePct1d} digits={s.id === "us10y" ? 3 : s.id === "btc" ? 0 : 2} suffix={s.id === "us10y" ? "%" : undefined} />
        ))}
      </div>

      {/* 2. DỮ LIỆU VIỆT NAM (MOCK DATA UI) */}
      <div className="border border-[#1c2736] bg-[#10151e] flex flex-col shrink-0 shadow-sm">
        <div className="px-4 py-2 border-b border-[#1c2736] flex justify-between items-center bg-[#0c1017]">
          <span className="font-mono text-[10px] font-bold tracking-[0.2em] text-[#26c6da]">FEATURE ENGINE · VIETNAM MARKET</span>
          <span className="font-mono text-[10px] text-amber border border-amber px-2 py-0.5 rounded">MOCK DATA UI</span>
        </div>
        <div className="p-3 grid grid-cols-4 gap-3">
          <div className="bg-[#151b26] border border-[#1c2736] p-2.5 flex flex-col justify-between">
            <span className="text-[10px] text-[#7d8ea3] font-bold tracking-widest mb-1">VN-INDEX DIVERGENCE</span>
            <span className="text-[#00e676] font-bold text-lg">{enhancedData.vietnamMarket.vnindex.price} <span className="text-xs">({enhancedData.vietnamMarket.vnindex.ret1d})</span></span>
            <span className="text-[#ff3d57] text-[10px] font-mono mt-1">Breadth yếu: {enhancedData.vietnamMarket.vnindex.breadth}</span>
          </div>
          <div className="bg-[#151b26] border border-[#1c2736] p-2.5 flex flex-col justify-between">
            <span className="text-[10px] text-[#7d8ea3] font-bold tracking-widest mb-1">FOREIGN FLOW</span>
            <span className="text-[#ff3d57] font-bold text-lg">{enhancedData.vietnamMarket.foreignFlow.d1}</span>
            <span className="text-[#ff3d57] text-[10px] font-mono mt-1">5D Cumulative: {enhancedData.vietnamMarket.foreignFlow.d5}</span>
          </div>
          <div className="bg-[#151b26] border border-[#1c2736] p-2.5 flex flex-col justify-between">
            <span className="text-[10px] text-[#7d8ea3] font-bold tracking-widest mb-1">VÀNG SJC (PREMIUM)</span>
            <span className="text-[#ffc107] font-bold text-lg">{enhancedData.vietnamMarket.sjcGold.price}</span>
            <span className="text-[#ffc107] text-[10px] font-mono mt-1">Lệch TG: {enhancedData.vietnamMarket.sjcGold.premium} (Percentile {enhancedData.vietnamMarket.sjcGold.premiumPercentile})</span>
          </div>
          <div className="bg-[#151b26] border border-[#1c2736] p-2.5 flex flex-col justify-between">
            <span className="text-[10px] text-[#7d8ea3] font-bold tracking-widest mb-1">SIGNAL CONFLUENCE</span>
            <span className="text-[#00e676] font-bold text-lg">{enhancedData.signalConfluence.score}/100</span>
            <span className="text-white text-[10px] font-mono mt-1">Confidence: {enhancedData.signalConfluence.confidence}%</span>
          </div>
        </div>
      </div>

      {/* 3. BẢNG TIN TỨC VĨ MÔ (MOCK DATA) */}
      <MacroNewsTable />

      {/* 4. DỮ LIỆU VĨ MÔ GỐC & BIỂU ĐỒ TRÒN */}
      <div className="grid min-h-[320px] grid-cols-[1.2fr_1fr] gap-3 shrink-0 mt-3">
        <Panel title="Market Regime Engine" right={loading ? "SYNC…" : usingSynthetic ? "YAHOO FALLBACK" : "LIVE FEED"}>
          {error ? <p className="text-sm text-down">{error}</p> : null}
          {regime ? (
            <div className="flex h-full flex-col gap-4">
              <div className="flex items-end justify-between gap-4">
                <div>
                  <div className="font-mono text-[10px] tracking-[0.2em] text-muted">REGIME LABEL</div>
                  <div className="mt-1 font-mono text-2xl font-semibold text-amber">{regime.label}</div>
                </div>
                <div className="text-right">
                  <div className="font-mono text-[10px] tracking-[0.2em] text-muted">RISK SCORE 0–100</div>
                  <div className={clsx("font-mono text-4xl font-semibold", regime.score >= 55 ? "text-up" : regime.score <= 45 ? "text-down" : "text-amber")}>{formatNumber(regime.score, 1)}</div>
                </div>
              </div>
              <div className="h-2 w-full bg-[#151b26]"><div className="h-2 bg-gradient-to-r from-down via-amber to-up" style={{ width: `${regime.score}%` }} /></div>
              
              <div className="bg-panel-2 border border-line p-3 rounded-md">
                <div className="flex items-start gap-2">
                  <AlertTriangle size={14} className="text-amber mt-0.5 shrink-0"/>
                  <p className="text-[12px] leading-relaxed text-ink/90 italic">
                    Lợi suất duy trì ở mức thắt chặt nhưng sức mạnh đồng USD không đồng pha. Các tài sản thực đang phòng vệ rủi ro tốt hơn trái phiếu dài hạn.
                  </p>
                </div>
                <div className="text-[12px] font-sans font-bold text-cyan flex items-start gap-2 mt-2 border-t border-line/50 pt-2">
                  <span className="shrink-0">⚡ ACTIONABLE DIRECTIVE:</span>
                  <span className="text-ink font-normal">Duy trì tỷ trọng Vàng. Giữ Tiền mặt làm Dry Powder. <strong className="text-down">KHÔNG bắt đáy</strong> cổ phiếu tăng trưởng lúc này.</span>
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

      {/* 6. KHUNG CHATBOT AI */}
      <Panel title="AI QUANT EXPERT · DECISION ENGINE" right="DATA PIPELINE SYNCED" className="shrink-0 mt-3 mb-6 flex flex-col h-[550px]">
        <div ref={chatScrollRef} className="flex-1 overflow-y-auto p-5 space-y-6 custom-scrollbar bg-[#07090d]">
          {messages.map((msg, idx) => (
            <div key={idx} className={clsx("flex flex-col max-w-[85%]", msg.sender === "user" ? "ml-auto items-end" : "mr-auto items-start")}>
              <div className={clsx(
                "p-4 rounded-xl shadow-md", 
                msg.sender === "user" ? "bg-cyan/15 border border-cyan/30 text-cyan rounded-br-none" : "bg-panel-2 border border-line text-ink rounded-bl-none"
              )}>
                {msg.sender === "user" ? <span className="whitespace-pre-wrap font-sans font-bold text-[14px]">{msg.text}</span> : <FormatMessage text={msg.text} />}
              </div>
            </div>
          ))}
          {isLoading && (
            <div className="flex items-center gap-2 text-cyan font-sans font-medium text-[13px] p-2">
              <Loader2 size={16} className="animate-spin" /> Đang đánh giá rủi ro danh mục qua Portfolio Risk Engine...
            </div>
          )}
        </div>

        <div className="px-4 py-3 flex gap-3 overflow-x-auto hide-scrollbar border-t border-line bg-panel">
          <button onClick={() => handleSend("Phân tích rủi ro danh mục hiện tại của tôi qua con mắt Portfolio Risk Engine.")} className="shrink-0 flex items-center gap-1.5 px-3 py-2 bg-panel-2 hover:bg-cyan/10 text-cyan rounded font-sans font-bold text-[12px] transition-colors border border-line">
            <MessageSquareText size={14} /> Quét rủi ro danh mục
          </button>
          <button onClick={() => handleSend("Đánh giá sự lệch pha (Regime Mismatch) giữa danh mục của tôi và điểm Vĩ mô toàn cầu hiện tại.")} className="shrink-0 flex items-center gap-1.5 px-3 py-2 bg-panel-2 hover:bg-cyan/10 text-cyan rounded font-sans font-bold text-[12px] transition-colors border border-line">
            <Target size={14} /> Kiểm tra Regime Mismatch
          </button>
          <button onClick={() => handleSend("Tìm các rủi ro tương quan (Correlated Exposure) nguy hiểm nhất đang tồn tại.")} className="shrink-0 flex items-center gap-1.5 px-3 py-2 bg-panel-2 hover:bg-cyan/10 text-cyan rounded font-sans font-bold text-[12px] transition-colors border border-line">
            <TrendingUp size={14} /> Correlation Audit
          </button>
        </div>

        <form onSubmit={(e) => { e.preventDefault(); handleSend(input); }} className="p-4 border-t border-line flex gap-4 bg-panel">
          <textarea 
            rows={1} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown}
            placeholder="Yêu cầu AI phân tích dữ liệu định lượng... (Shift + Enter để xuống dòng)"
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