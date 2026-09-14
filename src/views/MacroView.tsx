import React, { useEffect, useMemo, useState, useRef } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip as RechartsTooltip } from "recharts";
import { BrainCircuit, Loader2, Send, MessageSquareText, Target, TrendingUp } from "lucide-react";
import { Panel } from "@/components/ui/Panel";
import { MetricCard } from "@/components/ui/MetricCard";
import { MacroNewsTable } from "@/components/MacroNewsTable";
import { thirtyDayCorrelation } from "@/lib/correlation";
import { clsx } from "@/lib/clsx";
import { formatNumber, formatPct, formatUsd } from "@/lib/math";
import { useMacroStore } from "@/stores/macroStore";
import { usePortfolioStore } from "@/stores/portfolioStore";
import type { AllocationWeights, AssetKey } from "@/types/market";

const CHAT_EXPIRY_MS = 60 * 60 * 1000; // Reset sau 1 tiếng

const PIE_COLORS: Record<keyof AllocationWeights, string> = {
  realEstate: "#0ea5e9", gold: "#eab308", usdCash: "#10b981", equities: "#8b5cf6", crypto: "#f43f5e",
};
const PIE_LABELS: Record<keyof AllocationWeights, string> = {
  realEstate: "Real Estate", gold: "Gold", usdCash: "USD Cash", equities: "Equities", crypto: "Crypto",
};
const ASSET_ORDER: AssetKey[] = ["dxy", "us10y", "gold", "btc"];
const ASSET_LABEL: Record<AssetKey, string> = { dxy: "DXY", us10y: "US10Y", gold: "XAU", btc: "BTC" };

function corrColor(v: number): string {
  if (v >= 0.6) return "bg-emerald-900/50 text-emerald-400";
  if (v >= 0.2) return "bg-emerald-900/30 text-emerald-500";
  if (v > -0.2) return "bg-slate-800 text-slate-400";
  if (v > -0.6) return "bg-rose-900/30 text-rose-400";
  return "bg-rose-900/50 text-rose-500";
}

// Bộ parse Markdown tùy chỉnh để tin nhắn hiển thị đẹp, rõ ràng
const FormatMessage = ({ text }: { text: string }) => {
  const lines = text.split('\n');
  return (
    <div className="space-y-1.5 text-[13px] leading-relaxed">
      {lines.map((line, i) => {
        if (!line.trim()) return <div key={i} className="h-1"></div>;
        let formattedLine = line;
        let isTitle = false, isSubtitle = false, isList = false;

        if (formattedLine.startsWith('### ')) { isSubtitle = true; formattedLine = formattedLine.replace('### ', ''); } 
        else if (formattedLine.startsWith('## ')) { isTitle = true; formattedLine = formattedLine.replace('## ', ''); } 
        else if (formattedLine.startsWith('- ') || formattedLine.startsWith('* ')) { isList = true; formattedLine = formattedLine.substring(2); }

        const formattedHTML = formattedLine
          .replace(/\*\*(.*?)\*\*/g, '<strong class="text-white font-bold">$1</strong>')
          .replace(/\*(.*?)\*/g, '<em class="italic text-slate-300">$1</em>');

        if (isTitle) return <h2 key={i} className="text-[14px] font-bold text-white mt-3 mb-1">{formattedHTML}</h2>;
        if (isSubtitle) return <h3 key={i} className="text-sm font-bold text-[#b388ff] mt-2 mb-1 uppercase tracking-wide" dangerouslySetInnerHTML={{ __html: formattedHTML }} />;
        if (isList) return (
          <div key={i} className="flex items-start gap-2 ml-1">
            <span className="text-[#b388ff] mt-0.5">•</span><span dangerouslySetInnerHTML={{ __html: formattedHTML }} />
          </div>
        );
        return <div key={i} dangerouslySetInnerHTML={{ __html: formattedHTML }} />;
      })}
    </div>
  );
};

export function MacroView() {
  const { loading, error, series, regime, correlation, load } = useMacroStore();
  const portfolio = usePortfolioStore();
  
  // Chat States
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Array<{ sender: "user" | "ai"; text: string }>>([]);
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => { if (series.length === 0) void load(); }, [load, series.length]);

  const pieData = useMemo(() => {
    if (!regime) return [];
    return (Object.keys(regime.allocation) as Array<keyof AllocationWeights>).map((key) => ({
      key, name: PIE_LABELS[key], value: Math.round(regime.allocation[key] * 1000) / 10,
    }));
  }, [regime]);

  const corr = correlation ?? (series.length ? thirtyDayCorrelation(series) : null);
  const usingSynthetic = series.some((s) => s.source === "synthetic");

  // Load & Reset Chat History
  useEffect(() => {
    const lastReset = localStorage.getItem("quant_chat_last_reset");
    const now = Date.now();
    if (!lastReset || now - parseInt(lastReset) > CHAT_EXPIRY_MS) {
      setMessages([{ sender: "ai", text: "Xin chào! Tôi là **Trợ lý AI Quản trị Rủi ro (Quant Expert)**.\n\nDữ liệu Vĩ mô và Danh mục của bạn đã được đồng bộ hóa thành công. Bạn cần tôi phân tích chiến lược gì hôm nay?" }]);
      localStorage.setItem("quant_chat_last_reset", now.toString());
      localStorage.removeItem("quant_chat_history");
    } else {
      const savedHistory = localStorage.getItem("quant_chat_history");
      if (savedHistory) setMessages(JSON.parse(savedHistory));
    }
  }, []);

  useEffect(() => {
    if (messages.length > 1) localStorage.setItem("quant_chat_history", JSON.stringify(messages));
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = async (text: string) => {
    if (!text.trim() || isLoading) return;
    const userText = text.trim();
    setInput("");
    setMessages((prev) => [...prev, { sender: "user", text: userText }]);
    setIsLoading(true);

    try {
      const apiKey = (import.meta.env.VITE_GEMINI_API_KEY || "").trim();
      const systemPrompt = `
        Đóng vai trò là một Chuyên gia Tài chính Định lượng (Quant Expert). Trả lời bằng tiếng Việt, trình bày BẮT BUỘC sử dụng Markdown:
        - Dùng "### [Tiêu đề]" cho các luận điểm chính.
        - Dùng "**[Chữ]**" để in đậm con số hoặc từ khóa.
        - Dùng "- " để gạch đầu dòng. XUỐNG DÒNG rõ ràng, KHÔNG viết thành một khối chữ dài.
        
        DỮ LIỆU THỰC TẾ (Sử dụng để phân tích):
        - Tổng NAV: $${portfolio.getTotalNav()} | Tiền mặt: $${portfolio.cashUsd}
        - Trạng thái Vĩ mô: ${regime?.label} (Điểm rủi ro: ${regime?.score}/100)
        - Phân bổ tài sản: ${JSON.stringify(portfolio.assets.map(a => ({ Tên: a.name, Giá_trị: `$${a.currentValue}`, Tỷ_trọng: `${a.allocationPercent}%` })))}
      `;

      const apiContents = [
        { role: "user", parts: [{ text: systemPrompt }] },
        { role: "model", parts: [{ text: "Đã hiểu, tôi sẽ phân tích dữ liệu trên và trình bày Markdown rõ ràng." }] },
        ...messages.slice(1).map(m => ({ role: m.sender === "user" ? "user" : "model", parts: [{ text: m.text }] })),
        { role: "user", parts: [{ text: userText }] }
      ];

      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: apiContents, generationConfig: { temperature: 0.2 } })
      });

      const data = await response.json();
      if (!response.ok) throw new Error("Lỗi API");
      setMessages((prev) => [...prev, { sender: "ai", text: data.candidates?.[0]?.content?.parts?.[0]?.text || "Lỗi phản hồi." }]);
    } catch (err) {
      setMessages((prev) => [...prev, { sender: "ai", text: "⚠️ **Lỗi kết nối AI.** Vui lòng kiểm tra lại API Key." }]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend(input);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-5 overflow-y-auto p-5 bg-[#0b1120] font-sans custom-scrollbar">
      
      {/* 1. THÔNG SỐ TICKERS */}
      <div className="grid grid-cols-4 gap-4 shrink-0">
        {series.map((s) => (
          <MetricCard key={s.id} label={s.name} ticker={s.ticker} value={s.last} changePct={s.changePct1d} digits={s.id === "us10y" ? 3 : s.id === "btc" ? 0 : 2} suffix={s.id === "us10y" ? "%" : undefined} />
        ))}
      </div>

      {/* 2. BẢNG TIN TỨC VĨ MÔ & LỊCH SỰ KIỆN */}
      <div className="shrink-0"><MacroNewsTable /></div>

      {/* 3. DỮ LIỆU VĨ MÔ GỐC & PHÂN BỔ DANH MỤC */}
      <div className="grid min-h-[300px] grid-cols-[1.2fr_1fr] gap-4 shrink-0">
        <Panel title="Global Risk / Regime Score" right={loading ? "SYNC…" : usingSynthetic ? "SYNTHETIC MIX" : "LIVE DATA"}>
          {error ? <p className="text-sm text-rose-500">{error}</p> : null}
          {regime ? (
            <div className="flex h-full flex-col gap-5">
              <div className="flex items-end justify-between">
                <div>
                  <div className="font-mono text-[11px] tracking-widest text-slate-400 uppercase">Status</div>
                  <div className="mt-1 font-sans text-2xl font-bold text-amber-400">{regime.label}</div>
                </div>
                <div className="text-right">
                  <div className="font-mono text-[11px] tracking-widest text-slate-400 uppercase">Score 0–100</div>
                  <div className={clsx("font-sans text-4xl font-bold tracking-tight", regime.score >= 55 ? "text-emerald-400" : regime.score <= 45 ? "text-rose-400" : "text-amber-400")}>{formatNumber(regime.score, 1)}</div>
                </div>
              </div>
              <div className="h-2.5 w-full bg-slate-800 rounded-full overflow-hidden shadow-inner">
                <div className="h-full bg-gradient-to-r from-rose-500 via-amber-400 to-emerald-500" style={{ width: `${regime.score}%` }} />
              </div>
              <p className="text-[13px] leading-relaxed text-slate-300">{regime.thesis}</p>
              <div className="grid grid-cols-3 gap-3">
                <Stat label="DXY TREND" value={formatNumber(regime.dxyTrend * 100, 3) + "%/d"} />
                <Stat label="10Y LEVEL" value={formatNumber(regime.yieldLevel, 3) + "%"} />
                <Stat label="10Y TREND" value={formatNumber(regime.yieldTrend * 100, 3) + " bps/d"} />
              </div>
            </div>
          ) : (<div className="text-sm text-slate-500 flex h-full items-center justify-center">Computing regime data...</div>)}
        </Panel>

        <Panel title="Model Portfolio Allocation">
          {regime ? (
            <div className="flex h-full items-center gap-6 px-4">
              <div className="h-[240px] flex-1">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={pieData} dataKey="value" nameKey="name" innerRadius={65} outerRadius={95} stroke="#0b1120" strokeWidth={4} paddingAngle={2}>
                      {pieData.map((d) => (<Cell key={d.key} fill={PIE_COLORS[d.key as keyof AllocationWeights]} />))}
                    </Pie>
                    <RechartsTooltip contentStyle={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: '8px', color: '#fff', fontSize: '13px' }} formatter={(value) => [`${value}%`, "Allocation"]} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <ul className="w-[160px] space-y-3 font-sans text-sm">
                {pieData.map((d) => (
                  <li key={d.key} className="flex items-center justify-between gap-3 p-2 rounded-lg bg-slate-800/30 border border-slate-700/50">
                    <span className="flex items-center gap-2.5 text-slate-300 font-medium text-[12px]">
                      <span className="h-3 w-3 rounded-sm shadow-sm" style={{ background: PIE_COLORS[d.key as keyof AllocationWeights] }} />{d.name}
                    </span>
                    <span className="text-white font-bold">{d.value.toFixed(1)}%</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Panel>
      </div>

      <div className="grid grid-cols-[1fr_1.1fr] gap-4 shrink-0">
        <Panel title="30-Day Return Correlation">
          {corr ? (
            <table className="w-full border-collapse font-mono text-[12px]">
              <thead><tr><th className="p-2 text-left text-slate-400" />{ASSET_ORDER.map((k) => (<th key={k} className="p-2 text-center text-slate-400 font-semibold">{ASSET_LABEL[k]}</th>))}</tr></thead>
              <tbody>
                {ASSET_ORDER.map((row) => (
                  <tr key={row} className="border-t border-slate-800/50">
                    <td className="p-2 text-slate-400 font-semibold">{ASSET_LABEL[row]}</td>
                    {ASSET_ORDER.map((col) => (<td key={col} className="p-1.5"><div className={clsx("px-2 py-1.5 rounded-md text-center font-bold", corrColor(corr[row][col]))}>{corr[row][col].toFixed(2)}</div></td>))}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (<div className="text-sm text-slate-500">Awaiting series…</div>)}
        </Panel>

        <Panel title="20-Day Performance Tape">
          <div className="space-y-2">
            {series.map((s) => (
              <div key={s.id} className="flex items-center gap-4 bg-slate-800/40 border border-slate-700/50 px-4 py-2.5 rounded-xl hover:bg-slate-800/60 transition-colors">
                <div className="w-24 font-mono text-xs font-bold text-sky-400">{s.ticker}</div>
                <div className="flex-1"><div className="h-2 bg-slate-900 rounded-full overflow-hidden"><div className={clsx("h-full rounded-full", s.changePct20d >= 0 ? "bg-emerald-400" : "bg-rose-400")} style={{ width: `${Math.min(100, Math.abs(s.changePct20d) * 400)}%` }} /></div></div>
                <div className={clsx("w-20 text-right font-mono text-xs font-bold", s.changePct20d >= 0 ? "text-emerald-400" : "text-rose-400")}>{formatPct(s.changePct20d)}</div>
                <div className="w-12 text-right font-mono text-[10px] text-slate-500">{s.source === "live" ? "LIVE" : "SYN"}</div>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      {/* 5. KHUNG CHATBOT AI CHUYÊN GIA NẰM Ở ĐÁY DASHBOARD */}
      <div className="mt-2 flex flex-col bg-[#0f172a] border border-[#1e293b] rounded-2xl shadow-lg h-[500px] shrink-0 mb-6 overflow-hidden">
        {/* Chat Header */}
        <div className="px-5 py-3.5 bg-[#1e293b]/50 border-b border-[#334155] flex items-center gap-3">
          <div className="bg-[#b388ff]/20 p-2 rounded-xl border border-[#b388ff]/30 shadow-inner">
            <BrainCircuit size={18} className="text-[#b388ff]" />
          </div>
          <span className="font-bold text-[15px] text-slate-100 tracking-wide">AI Quant Expert</span>
          <span className="text-[11px] text-emerald-400 flex items-center gap-1.5 ml-auto">
            <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-pulse"></span> Data Synced
          </span>
        </div>

        {/* Chat Messages */}
        <div className="flex-1 p-5 overflow-y-auto bg-[#0b1120] space-y-5 custom-scrollbar">
          {messages.map((msg, idx) => (
            <div key={idx} className={clsx("flex flex-col max-w-[90%]", msg.sender === "user" ? "ml-auto items-end" : "mr-auto items-start")}>
              <div className={clsx(
                "p-4 rounded-2xl shadow-md", 
                msg.sender === "user" ? "bg-gradient-to-br from-[#b388ff] to-[#9c66ff] text-black font-medium rounded-br-sm" : "bg-[#1e293b] border border-[#334155] text-slate-300 rounded-bl-sm"
              )}>
                {msg.sender === "user" ? <span className="whitespace-pre-wrap text-[13px]">{msg.text}</span> : <FormatMessage text={msg.text} />}
              </div>
            </div>
          ))}
          {isLoading && (
            <div className="flex items-center gap-2 text-slate-400 text-xs p-2">
              <Loader2 size={16} className="animate-spin text-[#b388ff]" /> Trợ lý đang tính toán dữ liệu...
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Quick Prompts */}
        <div className="px-4 py-2.5 bg-[#0f172a] flex gap-2 overflow-x-auto hide-scrollbar border-t border-[#1e293b]">
          <button onClick={() => handleSend("Tóm tắt thị trường hôm nay và tôi nên hành động thế nào?")} className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 bg-[#1e293b] hover:bg-[#b388ff]/20 text-[#b388ff] rounded-lg text-[11px] font-medium transition-colors border border-[#334155]">
            <MessageSquareText size={14} /> Tóm tắt & Hành động
          </button>
          <button onClick={() => handleSend("Trong 3 tháng tới tôi nên tái cơ cấu tỷ trọng tài sản ra sao?")} className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 bg-[#1e293b] hover:bg-[#b388ff]/20 text-[#b388ff] rounded-lg text-[11px] font-medium transition-colors border border-[#334155]">
            <Target size={14} /> Chiến lược 3 tháng
          </button>
          <button onClick={() => handleSend("Đánh giá rủi ro danh mục hiện tại của tôi.")} className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 bg-[#1e293b] hover:bg-[#b388ff]/20 text-[#b388ff] rounded-lg text-[11px] font-medium transition-colors border border-[#334155]">
            <TrendingUp size={14} /> Đánh giá rủi ro
          </button>
        </div>

        {/* Chat Input */}
        <form onSubmit={(e) => { e.preventDefault(); handleSend(input); }} className="p-3 bg-[#0f172a] flex gap-3">
          <textarea 
            rows={1} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown}
            placeholder="Hỏi AI... (Shift + Enter để xuống dòng)"
            className="flex-1 bg-[#1e293b] border border-[#334155] text-slate-100 px-4 py-3 rounded-xl text-[13px] focus:outline-none focus:border-[#b388ff] resize-none min-h-[44px] max-h-32 custom-scrollbar"
          />
          <button type="submit" disabled={isLoading || !input.trim()} className="bg-gradient-to-br from-[#b388ff] to-[#9c66ff] hover:opacity-90 text-black font-bold w-12 h-12 rounded-xl flex items-center justify-center transition-all disabled:opacity-50 shrink-0">
            <Send size={18} className="ml-0.5" />
          </button>
        </form>
      </div>

    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-slate-700/50 bg-slate-800/40 px-3 py-3 rounded-xl">
      <div className="text-[10px] tracking-widest text-slate-400 font-semibold uppercase">{label}</div>
      <div className="mt-1 text-slate-100 font-bold font-mono text-sm">{value}</div>
    </div>
  );
}