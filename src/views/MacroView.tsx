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

// MÀU SẮC CHUYÊN NGHIỆP DÀNH CHO TERMINAL
const PIE_COLORS: Record<keyof AllocationWeights, string> = {
  realEstate: "#26c6da", gold: "#ffc107", usdCash: "#00e676", equities: "#82b1ff", crypto: "#b388ff",
};
const PIE_LABELS: Record<keyof AllocationWeights, string> = {
  realEstate: "Real Estate (BĐS)", gold: "Gold (Vàng)", usdCash: "USD/VND Cash", equities: "Equities (Cổ phiếu)", crypto: "Crypto",
};
const ASSET_ORDER: AssetKey[] = ["dxy", "us10y", "gold", "btc"];
const ASSET_LABEL: Record<AssetKey, string> = { dxy: "DXY", us10y: "US10Y", gold: "XAU", btc: "BTC" };

function corrColor(v: number): string {
  if (v >= 0.6) return "bg-[#0b3d24] text-[#00e676]";
  if (v >= 0.2) return "bg-[#12301f] text-[#00e676]/80";
  if (v > -0.2) return "bg-[#151b26] text-[#7d8ea3]";
  if (v > -0.6) return "bg-[#3a1218] text-[#ff3d57]/80";
  return "bg-[#4a0d16] text-[#ff3d57]";
}

// FORMAT MARKDOWN CHO CHATBOT (FONT SANS-SERIF DỄ ĐỌC)
const FormatMessage = ({ text }: { text: string }) => {
  const lines = text.split('\n');
  return (
    <div className="space-y-2 text-[14px] leading-relaxed text-slate-200 font-sans tracking-wide">
      {lines.map((line, i) => {
        if (!line.trim()) return <div key={i} className="h-1"></div>;
        let formatted = line
          .replace(/\*\*(.*?)\*\*/g, '<strong class="text-white font-black">$1</strong>')
          .replace(/\*(.*?)\*/g, '<em class="text-[#7d8ea3] italic">$1</em>');

        if (formatted.startsWith('### ')) return <h3 key={i} className="text-[#26c6da] font-bold text-[15px] mt-4 mb-2 uppercase" dangerouslySetInnerHTML={{ __html: formatted.replace('### ', '') }} />;
        if (formatted.startsWith('## ')) return <h2 key={i} className="text-[#82b1ff] font-bold text-[16px] mt-5 mb-2" dangerouslySetInnerHTML={{ __html: formatted.replace('## ', '') }} />;
        if (formatted.startsWith('- ') || formatted.startsWith('* ')) return (
          <div key={i} className="flex gap-2.5 items-start">
            <span className="text-[#26c6da] font-bold mt-0.5">•</span>
            <span dangerouslySetInnerHTML={{ __html: formatted.substring(2) }} />
          </div>
        );
        return <div key={i} dangerouslySetInnerHTML={{ __html: formatted }} />;
      })}
    </div>
  );
};

export function MacroView() {
  const { loading, error, series, regime, correlation, load } = useMacroStore();
  const portfolio = usePortfolioStore();
  const { trend, mean, dca } = useTradingStore();
  
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Array<{ sender: "user" | "ai"; text: string }>>([]);
  const [isLoading, setIsLoading] = useState(false);
  const chatScrollRef = useRef<HTMLDivElement>(null);

  // ---------------------------------------------------------
  // MOCKUP FEATURE ENGINE (NÂNG CẤP DỮ LIỆU ĐỂ AI SUY LUẬN TỐT HƠN)
  // ---------------------------------------------------------
  const enhancedData = {
    macroSurprise: {
      cpi: { actual: "3.1%", expected: "2.9%", prev: "3.0%", impact: "INFLATION SURPRISE: +0.2%" },
      fedNextMeet: "35% hike, 65% hold (FOMC 15-16/9)",
    },
    yieldCurve: {
      us2y: "4.85%", us10y: "4.58%", spread: "-27 bps (Inverted)"
    },
    vietnamMarket: {
      vnindex: { 
        price: 1280.5, ret1d: "+0.8%", ret20d: "+5.7%", 
        distMA20: "+2.4%", distMA50: "+4.8%", distMA200: "-1.2%",
        breadth: "A/D = 145/320", pctAboveMA20: "38%", pctAboveMA50: "31%" // Breadth yếu dù Index tăng
      },
      foreignFlow: { d1: "-500B", d5: "-1,200B", d20: "+300B" },
      liquidity: { turnoverRatio20d: 1.32 },
      usdvnd: "25,450 (Ổn định)",
      sjcGold: { price: "82.5M", premium: "+4M", premiumPercentile: "96%" } // Premium cực cao
    },
    signalConfluence: {
      score: 71, confidence: 68,
      factors: [
        { name: "Inflation", val: "+++", status: "High" },
        { name: "Liquidity", val: "++", status: "Neutral" },
        { name: "USD", val: "+++", status: "High" },
        { name: "Breadth", val: "-", status: "Weak" },
        { name: "Foreign", val: "--", status: "Outflow" }
      ]
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
      setMessages([{ sender: "ai", text: "Hệ thống **AI Quant Risk Manager** đã khởi động.\n\nĐã nạp Data Pipeline:\n- Market Regime Engine\n- Signal Confluence\n- Vietnam Feature Engine (Breadth, Foreign Flow, Gold Premium)\n- Portfolio & Bot Performance\n\nBạn cần phân tích chiến lược nào?" }]);
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
      
      // BÊ NGUYÊN SYSTEM PROMPT THẦN THÁNH CỦA BẠN VÀO ĐÂY
      const systemPrompt = `
        Bạn là AI QUANT EXPERT, hoạt động như một Senior Portfolio Manager + Quant Risk Analyst tại một quỹ đầu tư định lượng.
        MỤC TIÊU: Xác định regime, phân biệt SIGNAL với NOISE, đánh giá risk/reward và đưa ra ACTION cụ thể. KHÔNG bịa data.

        [1. PORTFOLIO & BOTS]
        - NAV: $${portfolio.getTotalNav()} | CASH: $${portfolio.cashUsd}
        - Allocation: ${JSON.stringify(portfolio.assets.map(a => ({ asset: a.name, allocation: `${a.allocationPercent}%` })))}
        - Bot Trend: Thắng ${formatPct(trend.winRate, 1)} | PnL: ${formatUsd(trend.pnl)}
        - Bot MeanRev: Thắng ${formatPct(mean.winRate, 1)} | PnL: ${formatUsd(mean.pnl)}

        [2. GLOBAL MACRO (FEATURE ENGINE)]
        - Regime: ${regime?.label} (Score: ${regime?.score}/100)
        - DXY Trend: ${formatNumber((regime?.dxyTrend || 0) * 100, 3)}%/d
        - US Yield Curve: 2Y=${enhancedData.yieldCurve.us2y}, 10Y=${enhancedData.yieldCurve.us10y} (Spread: ${enhancedData.yieldCurve.spread})
        - Inflation Surprise: CPI Actual ${enhancedData.macroSurprise.cpi.actual} vs Expected ${enhancedData.macroSurprise.cpi.expected}
        - Event Risk: FOMC Meeting (15-16/9) - ${enhancedData.macroSurprise.fedNextMeet}

        [3. VIETNAM MARKET (FEATURE ENGINE)]
        - VNINDEX: Giá ${enhancedData.vietnamMarket.vnindex.price} | 1D: ${enhancedData.vietnamMarket.vnindex.ret1d} | 20D: ${enhancedData.vietnamMarket.vnindex.ret20d}
        - DIVERGENCE CẢNH BÁO: Index tăng nhẹ nhưng Breadth rất yếu (A/D = ${enhancedData.vietnamMarket.vnindex.breadth}), chỉ ${enhancedData.vietnamMarket.vnindex.pctAboveMA20} cổ phiếu > MA20.
        - Foreign Flow: 1D: ${enhancedData.vietnamMarket.foreignFlow.d1} | 5D: ${enhancedData.vietnamMarket.foreignFlow.d5} (Bán ròng liên tục).
        - Vàng SJC: Premium Percentile ${enhancedData.vietnamMarket.sjcGold.premiumPercentile} (Lệch cực cao so với TG).

        [4. MARKET SIGNAL CONFLUENCE]
        - Score: ${enhancedData.signalConfluence.score}/100 | Confidence: ${enhancedData.signalConfluence.confidence}%
        - Yếu: Breadth (-), Foreign Flow (--)

        TRẢ LỜI THEO FORMAT BẮT BUỘC SAU KHI USER HỎI:
        ### VERDICT: (BUY / HOLD / REDUCE / HEDGE / WAIT)
        ### WHY: (3-5 lý do mạnh nhất từ data)
        ### CONFIDENCE: (0-100%)
        ### ACTION: (Tỷ trọng, hành động cụ thể)
        ### TRIGGER: (Chờ điều kiện gì để hành động tiếp theo)
        ### INVALIDATION: (Khi nào luận điểm này sai)
      `;

      const apiContents = [
        { role: "user", parts: [{ text: systemPrompt }] },
        { role: "model", parts: [{ text: "System Pipeline loaded. AI Quant Decision Engine is ready." }] },
        ...messages.slice(1).map(m => ({ role: m.sender === "user" ? "user" : "model", parts: [{ text: m.text }] })),
        { role: "user", parts: [{ text: userText }] }
      ];

      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: apiContents, generationConfig: { temperature: 0.1 } }) // Temperature cực thấp để tư duy logic
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
      
      {/* 0. TICKER TIN TỨC BREAKING NEWS */}
      <style dangerouslySetInnerHTML={{__html: `
        @keyframes ticker { 0% { transform: translateX(100vw); } 100% { transform: translateX(-100%); } }
        .animate-ticker { display: inline-block; white-space: nowrap; animation: ticker 40s linear infinite; will-change: transform; }
        .ticker-container:hover .animate-ticker { animation-play-state: paused; }
      `}} />
      <div className="ticker-container flex items-center bg-[#151b26] border border-[#1c2736] p-1.5 overflow-hidden shrink-0 rounded-sm">
        <div className="font-mono text-[11px] font-bold tracking-[0.15em] text-[#07090d] bg-[#ffc107] px-2 py-0.5 rounded-sm mr-3 shrink-0 flex items-center gap-1.5 z-10 relative">
          <span className="w-1.5 h-1.5 bg-[#07090d] rounded-full animate-pulse"></span>
          MARKET FEED
        </div>
        <div className="flex-1 overflow-hidden relative h-5 flex items-center">
          <div className="animate-ticker font-mono text-[12px] text-[#d7e2ee] flex gap-16 absolute">
            <span>🔴 <strong className="text-[#ff3d57]">MACRO RISK:</strong> Ngày 15-16/9 FED họp FOMC. Expectation hiện tại: 35% khả năng rate hike, 65% hold.</span>
            <span>⚠️ <strong className="text-[#ffc107]">INFLATION SURPRISE:</strong> US Core CPI (3.1%) nóng hơn dự kiến (2.9%), áp lực lạm phát cứng đầu cản trở chu kỳ nới lỏng.</span>
            <span>📉 <strong className="text-[#ff3d57]">VN MARKET DIVERGENCE:</strong> VNINDEX xanh (+0.8%) nhưng Breadth cực yếu (A/D = 145/320), khối ngoại tiếp tục bán ròng 5D (-1,200B).</span>
            <span>🟡 <strong className="text-[#ffc107]">GOLD ALERT:</strong> SJC Premium đạt Percentile 96% (+4M vs Thế giới). Rủi ro thanh khoản nội địa cực cao.</span>
          </div>
        </div>
      </div>

      {/* 1. TICKERS GỐC */}
      <div className="grid grid-cols-4 gap-3 shrink-0">
        {series.map((s) => (
          <MetricCard key={s.id} label={s.name} ticker={s.ticker} value={s.last} changePct={s.changePct1d} digits={s.id === "us10y" ? 3 : s.id === "btc" ? 0 : 2} suffix={s.id === "us10y" ? "%" : undefined} />
        ))}
      </div>

      {/* 2. DỮ LIỆU VIỆT NAM (SỬA LỖI OVERLAP, DÙNG DIV THUẦN TRÊN NỀN BẢNG) */}
      <div className="border border-[#1c2736] bg-[#10151e] flex flex-col shrink-0 shadow-sm">
        <div className="px-4 py-2 border-b border-[#1c2736] flex justify-between items-center bg-[#0c1017]">
          <span className="font-mono text-[10px] font-bold tracking-[0.2em] text-[#26c6da]">FEATURE ENGINE · VIETNAM MARKET</span>
          <span className="font-mono text-[10px] text-[#7d8ea3] border border-[#1c2736] px-2 py-0.5 rounded">DATA SYNCED</span>
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

      {/* 3. BẢNG TIN TỨC VĨ MÔ */}
      <MacroNewsTable />

      {/* 4. DỮ LIỆU VĨ MÔ GỐC & BIỂU ĐỒ TRÒN FIX LỖI KHOẢNG TRẮNG */}
      <div className="grid min-h-[340px] grid-cols-[1.2fr_1fr] gap-3 shrink-0 mt-3">
        <Panel title="Market Regime Engine" right={loading ? "SYNC…" : usingSynthetic ? "SYNTHETIC MIX" : "LIVE FEED"}>
          {error ? <p className="text-sm text-[#ff3d57]">{error}</p> : null}
          {regime ? (
            <div className="flex h-full flex-col gap-4">
              <div className="flex items-end justify-between gap-4">
                <div>
                  <div className="font-mono text-[10px] tracking-[0.2em] text-[#7d8ea3]">REGIME LABEL</div>
                  <div className="mt-1 font-mono text-2xl font-bold text-[#ffc107]">{regime.label}</div>
                </div>
                <div className="text-right">
                  <div className="font-mono text-[10px] tracking-[0.2em] text-[#7d8ea3]">RISK SCORE 0–100</div>
                  <div className={clsx("font-mono text-4xl font-bold", regime.score >= 55 ? "text-[#00e676]" : regime.score <= 45 ? "text-[#ff3d57]" : "text-[#ffc107]")}>{formatNumber(regime.score, 1)}</div>
                </div>
              </div>
              
              <div className="h-2 w-full bg-[#151b26]"><div className="h-2 bg-gradient-to-r from-[#ff3d57] via-[#ffc107] to-[#00e676]" style={{ width: `${regime.score}%` }} /></div>
              
              {/* PHẦN DỊCH & ACTIONABLE INSIGHT THEO YÊU CẦU */}
              <div className="bg-[#10151e] border border-[#1c2736] p-4 rounded flex flex-col gap-3">
                <div className="flex items-start gap-2">
                  <AlertTriangle size={16} className="text-[#ffc107] shrink-0 mt-0.5" />
                  <p className="text-[13px] leading-relaxed text-[#d7e2ee] font-sans">
                    Lợi suất duy trì ở mức thắt chặt nhưng sức mạnh đồng USD không đồng pha. Các tài sản thực (Vàng, BĐS chọn lọc) đang phòng vệ rủi ro lạm phát/tài khóa tốt hơn so với trái phiếu dài hạn.
                  </p>
                </div>
                <div className="bg-[#151b26] p-3 border-l-2 border-[#26c6da]">
                  <span className="font-bold text-[#26c6da] text-[12px] font-mono">⚡ ACTIONABLE DIRECTIVE:</span>
                  <p className="text-[12px] text-white mt-1 font-sans">Duy trì tỷ trọng Vàng (Gold) để Hedge rủi ro lạm phát. Nắm giữ Tiền mặt (Dry Powder) chờ cơ hội. <strong className="text-[#ff3d57]">KHÔNG bắt đáy</strong> cổ phiếu tăng trưởng (Growth Equities) do thanh khoản hụt hơi.</p>
                </div>
              </div>

            </div>
          ) : (<div className="text-sm text-muted">Computing regime…</div>)}
        </Panel>

        <Panel title="Model Portfolio Target Allocation" className="flex flex-col">
          {regime ? (
            <div className="flex flex-row h-full items-center justify-between">
              {/* Phóng to và chỉnh lệch tâm Biểu đồ tròn để lấp khoảng trắng */}
              <div className="h-[260px] w-[55%]">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie 
                      data={pieData} dataKey="value" nameKey="name" 
                      cx="50%" cy="50%" innerRadius={65} outerRadius={105} 
                      stroke="#07090d" strokeWidth={3} paddingAngle={2}
                    >
                      {pieData.map((d) => (<Cell key={d.key} fill={PIE_COLORS[d.key as keyof AllocationWeights]} />))}
                    </Pie>
                    <RechartsTooltip contentStyle={{ background: "#0c1017", border: "1px solid #1c2736", fontSize: 13, color: '#fff' }} formatter={(value) => [`${value}%`, "Allocation"]} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="w-[45%] flex flex-col justify-center border-l border-[#1c2736] pl-5 h-full">
                <ul className="space-y-4 font-sans text-[13px]">
                  {pieData.map((d) => (
                    <li key={d.key} className="flex flex-col gap-1 border-b border-[#1c2736] pb-2 last:border-0">
                      <span className="flex items-center gap-2.5 text-[#7d8ea3] font-bold">
                        <span className="h-3 w-3 rounded-sm shadow-md" style={{ background: PIE_COLORS[d.key as keyof AllocationWeights] }} />
                        {d.name}
                      </span>
                      <span className="text-white font-black text-[16px] pl-5">{d.value.toFixed(1)}%</span>
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
              <div key={s.id} className="flex items-center gap-3 border border-[#1c2736] bg-[#10151e] px-3 py-2 rounded">
                <div className="w-24 font-mono text-[11px] font-bold text-[#26c6da]">{s.ticker}</div>
                <div className="flex-1"><div className="h-1.5 bg-[#0c1017]"><div className={s.changePct20d >= 0 ? "h-1.5 bg-[#00e676]" : "h-1.5 bg-[#ff3d57]"} style={{ width: `${Math.min(100, Math.abs(s.changePct20d) * 400)}%` }} /></div></div>
                <div className={clsx("w-20 text-right font-mono text-[11px] font-bold", s.changePct20d >= 0 ? "text-[#00e676]" : "text-[#ff3d57]")}>{formatPct(s.changePct20d)}</div>
                <div className="w-16 text-right font-mono text-[10px] text-[#7d8ea3]">{s.source === "live" ? "LIVE" : "SYN"}</div>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      {/* 6. KHUNG CHATBOT AI DECISION ENGINE */}
      <Panel title="AI QUANT EXPERT · DECISION ENGINE" right="DATA PIPELINE SYNCED" className="shrink-0 mt-3 mb-6 flex flex-col h-[600px] border-[#82b1ff]/30 shadow-[0_0_15px_rgba(130,177,255,0.05)]">
        
        {/* Chat Messages */}
        <div ref={chatScrollRef} className="flex-1 overflow-y-auto p-6 space-y-6 custom-scrollbar bg-[#0c1017]">
          {messages.map((msg, idx) => (
            <div key={idx} className={clsx("flex flex-col max-w-[85%]", msg.sender === "user" ? "ml-auto items-end" : "mr-auto items-start")}>
              <div className={clsx(
                "p-4 rounded-xl shadow-md", 
                msg.sender === "user" ? "bg-[#82b1ff]/15 border border-[#82b1ff]/30 text-[#82b1ff] rounded-br-none" : "bg-[#10151e] border border-[#1c2736] text-white rounded-bl-none"
              )}>
                {msg.sender === "user" ? <span className="whitespace-pre-wrap font-sans font-bold text-[15px]">{msg.text}</span> : <FormatMessage text={msg.text} />}
              </div>
            </div>
          ))}
          {isLoading && (
            <div className="flex items-center gap-3 text-[#26c6da] font-sans font-bold text-[14px] p-2">
              <Loader2 size={18} className="animate-spin" /> Engine đang xử lý Signal Confluence & Market Framework...
            </div>
          )}
        </div>

        {/* Quick Prompts */}
        <div className="px-5 py-3.5 flex gap-3 overflow-x-auto hide-scrollbar border-t border-[#1c2736] bg-[#10151e]">
          <button onClick={() => handleSend("Phân tích tín hiệu thị trường hôm nay và đưa ra ACTION (Tôi đang đầu tư tại VN).")} className="shrink-0 flex items-center gap-2 px-4 py-2 bg-[#0c1017] hover:bg-[#82b1ff]/10 text-[#82b1ff] rounded font-sans font-bold text-[13px] transition-colors border border-[#1c2736]">
            <MessageSquareText size={16} /> Market Action
          </button>
          <button onClick={() => handleSend("Dựa vào dữ liệu Breadth yếu và khối ngoại bán ròng hiện tại, đánh giá hiệu suất 3 Bot (Trend, Mean, DCA). Tôi nên tắt Bot nào?")} className="shrink-0 flex items-center gap-2 px-4 py-2 bg-[#0c1017] hover:bg-[#82b1ff]/10 text-[#82b1ff] rounded font-sans font-bold text-[13px] transition-colors border border-[#1c2736]">
            <Target size={16} /> Bot Performance Audit
          </button>
          <button onClick={() => handleSend("Với sự kiện FED họp 15/9 và SJC Premium đang ở ngưỡng 96%, tôi nên HEDGE danh mục thế nào?")} className="shrink-0 flex items-center gap-2 px-4 py-2 bg-[#0c1017] hover:bg-[#82b1ff]/10 text-[#82b1ff] rounded font-sans font-bold text-[13px] transition-colors border border-[#1c2736]">
            <TrendingUp size={16} /> Portfolio Hedging
          </button>
        </div>

        {/* Chat Input */}
        <form onSubmit={(e) => { e.preventDefault(); handleSend(input); }} className="p-4 border-t border-[#1c2736] flex gap-4 bg-[#10151e]">
          <textarea 
            rows={1} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown}
            placeholder="Yêu cầu AI phân tích dữ liệu rủi ro định lượng... (Shift + Enter để xuống dòng)"
            className="flex-1 bg-[#0c1017] border border-[#1c2736] text-white px-5 py-4 rounded-xl text-[15px] font-sans focus:outline-none focus:border-[#82b1ff] resize-none min-h-[56px] max-h-32 custom-scrollbar shadow-inner" 
          />
          <button type="submit" disabled={isLoading || !input.trim()} className="bg-[#82b1ff] hover:bg-[#a6c8ff] text-[#0c1017] font-black w-14 h-14 rounded-xl flex items-center justify-center transition-all disabled:opacity-50 shrink-0">
            <Send size={20} className="ml-1" />
          </button>
        </form>
      </Panel>

    </div>
  );
}