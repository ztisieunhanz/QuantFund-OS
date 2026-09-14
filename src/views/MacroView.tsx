import React, { useEffect, useMemo, useState, useRef } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip as RechartsTooltip } from "recharts";
import { BrainCircuit, Loader2, Send, MessageSquareText, Target, TrendingUp } from "lucide-react";
import { Panel } from "@/components/ui/Panel";
import { MetricCard } from "@/components/ui/MetricCard";
import { MacroNewsTable } from "@/components/MacroNewsTable";
import { thirtyDayCorrelation } from "@/lib/correlation";
import { clsx } from "@/lib/clsx";
import { formatNumber, formatPct } from "@/lib/math";
import { useMacroStore } from "@/stores/macroStore";
import { usePortfolioStore } from "@/stores/portfolioStore";
import type { AllocationWeights, AssetKey } from "@/types/market";

const CHAT_EXPIRY_MS = 60 * 60 * 1000; // Reset sau 1 tiếng

// Bảng màu Neon chuẩn của App
const PIE_COLORS: Record<keyof AllocationWeights, string> = {
  realEstate: "#26c6da", gold: "#ffc107", usdCash: "#00e676", equities: "#82b1ff", crypto: "#b388ff",
};
const PIE_LABELS: Record<keyof AllocationWeights, string> = {
  realEstate: "Bất Động Sản", gold: "Vàng (Gold)", usdCash: "Tiền mặt", equities: "Cổ phiếu", crypto: "Crypto",
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

// Xử lý Markdown hiển thị Chatbot đẹp, gọn gàng, có màu sắc
const FormatMessage = ({ text }: { text: string }) => {
  const lines = text.split('\n');
  return (
    <div className="space-y-1.5 font-mono text-[11px] leading-relaxed text-ink/90">
      {lines.map((line, i) => {
        if (!line.trim()) return <div key={i} className="h-1"></div>;
        
        let formatted = line
          .replace(/\*\*(.*?)\*\*/g, '<strong class="text-ink font-bold">$1</strong>')
          .replace(/\*(.*?)\*/g, '<em class="text-muted italic">$1</em>');

        if (formatted.startsWith('### ')) return <h3 key={i} className="text-cyan font-bold mt-2 mb-1" dangerouslySetInnerHTML={{ __html: formatted.replace('### ', '') }} />;
        if (formatted.startsWith('- ') || formatted.startsWith('* ')) return (
          <div key={i} className="flex gap-2">
            <span className="text-cyan">•</span>
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
  
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Array<{ sender: "user" | "ai"; text: string }>>([]);
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Dữ liệu bối cảnh Việt Nam
  const vietnamMarketData = {
    vnindex: { value: "1,280.5", change: "+0.8%", status: "BULLISH" },
    usdvnd: { value: "25,450", change: "-0.2%", status: "Ổn định" },
    sjcGold: { value: "82.5M", premium: "+4M vs TG", status: "Chênh lệch cao" },
    realEstate: { status: "THANH KHOẢN KÉM", rate: "Lãi suất vay 6-7%" }
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
      setMessages([{ sender: "ai", text: "Hệ thống AI Risk Manager đã khởi động.\n- Dữ liệu Danh mục: Đã nạp\n- Dữ liệu Vĩ mô Toàn cầu: Đã nạp\n- Bối cảnh thị trường Việt Nam: Sẵn sàng\n\nBạn cần tôi phân tích chiến lược nào hôm nay?" }]);
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
        Đóng vai trò là Giám đốc Quản trị Rủi ro (Quant Expert). Trình bày bằng Markdown. Tiếng Việt thực chiến.
        
        DỮ LIỆU HIỆN TẠI:
        - Tổng NAV: $${portfolio.getTotalNav()} | Tiền mặt: $${portfolio.cashUsd}
        - Trạng thái Vĩ mô Toàn cầu: ${regime?.label} (Điểm rủi ro: ${regime?.score}/100)
        
        BỐI CẢNH ĐỊA PHƯƠNG (VIỆT NAM):
        - VN-Index: ${vietnamMarketData.vnindex.value} (${vietnamMarketData.vnindex.change})
        - Tỷ giá USD/VND: ${vietnamMarketData.usdvnd.value}
        - Vàng SJC: ${vietnamMarketData.sjcGold.value}/lượng (${vietnamMarketData.sjcGold.premium})
        - Bất động sản VN: ${vietnamMarketData.realEstate.status}, ${vietnamMarketData.realEstate.rate}.
        
        Trả lời phân tích chi tiết, liên kết dữ liệu toàn cầu với điều kiện tại Việt Nam để đưa ra chiến lược tối ưu nhất.
      `;

      const apiContents = [
        { role: "user", parts: [{ text: systemPrompt }] },
        { role: "model", parts: [{ text: "Đã tiếp nhận đầy đủ bối cảnh, tôi đã sẵn sàng đưa ra tư vấn chi tiết." }] },
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
      setMessages((prev) => [...prev, { sender: "ai", text: "⚠️ **Lỗi kết nối API.** Kiểm tra lại khóa VITE_GEMINI_API_KEY." }]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(input); }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-auto p-3">
      
      {/* 1. TICKERS GỐC (Dùng MetricCard để fix lỗi số thập phân tuyệt đối) */}
      <div className="grid grid-cols-4 gap-3">
        {series.map((s) => (
          <MetricCard key={s.id} label={s.name} ticker={s.ticker} value={s.last} changePct={s.changePct1d} digits={s.id === "us10y" ? 3 : s.id === "btc" ? 0 : 2} suffix={s.id === "us10y" ? "%" : undefined} />
        ))}
      </div>

      {/* 2. DỮ LIỆU VIỆT NAM (Dùng Panel chuẩn của hệ thống) */}
      <Panel title="LOCAL CONTEXT · VIETNAM MARKET" right="LIVE SYNTHESIS">
        <div className="grid grid-cols-4 gap-3">
          <Stat label="VN-INDEX" value={vietnamMarketData.vnindex.value} desc={`${vietnamMarketData.vnindex.change} (BULLISH)`} />
          <Stat label="TỶ GIÁ USD/VND" value={vietnamMarketData.usdvnd.value} desc={vietnamMarketData.usdvnd.status} />
          <Stat label="VÀNG SJC (BÁN)" value={vietnamMarketData.sjcGold.value} desc={vietnamMarketData.sjcGold.premium} />
          <Stat label="BẤT ĐỘNG SẢN" value={vietnamMarketData.realEstate.status} desc={vietnamMarketData.realEstate.rate} />
        </div>
      </Panel>

      {/* 3. BẢNG TIN TỨC VĨ MÔ */}
      <MacroNewsTable />

      {/* 4. DỮ LIỆU VĨ MÔ GỐC & BIỂU ĐỒ TRÒN */}
      <div className="grid min-h-[280px] grid-cols-[1.2fr_1fr] gap-3">
        <Panel title="Global Risk / Regime Score" right={loading ? "SYNC…" : usingSynthetic ? "YAHOO FALLBACK · SYNTHETIC MIX" : "YAHOO VIA PROXY · LIVE"}>
          {error ? <p className="text-sm text-down">{error}</p> : null}
          {regime ? (
            <div className="flex h-full flex-col gap-4">
              <div className="flex items-end justify-between gap-4">
                <div>
                  <div className="font-mono text-[10px] tracking-[0.2em] text-muted">STATUS</div>
                  <div className="mt-1 font-mono text-2xl font-semibold text-amber">{regime.label}</div>
                </div>
                <div className="text-right">
                  <div className="font-mono text-[10px] tracking-[0.2em] text-muted">SCORE 0–100</div>
                  <div className={clsx("font-mono text-4xl font-semibold", regime.score >= 55 ? "text-up" : regime.score <= 45 ? "text-down" : "text-amber")}>{formatNumber(regime.score, 1)}</div>
                </div>
              </div>
              <div className="h-2 w-full bg-[#151b26]"><div className="h-2 bg-gradient-to-r from-down via-amber to-up" style={{ width: `${regime.score}%` }} /></div>
              <p className="text-sm leading-relaxed text-ink/90">{regime.thesis}</p>
              <div className="grid grid-cols-3 gap-3 font-mono text-[11px]">
                <Stat label="DXY TREND" value={formatNumber(regime.dxyTrend * 100, 3) + "%/d"} />
                <Stat label="10Y LEVEL" value={formatNumber(regime.yieldLevel, 3) + "%"} />
                <Stat label="10Y TREND" value={formatNumber(regime.yieldTrend * 100, 3) + " bps/d"} />
              </div>
            </div>
          ) : (<div className="text-sm text-muted">Computing regime…</div>)}
        </Panel>

        <Panel title="Model Portfolio Allocation">
          {regime ? (
            <div className="flex h-full gap-2">
              <div className="h-[220px] flex-1">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={pieData} dataKey="value" nameKey="name" innerRadius={52} outerRadius={84} stroke="#07090d" strokeWidth={2}>
                      {pieData.map((d) => (<Cell key={d.key} fill={PIE_COLORS[d.key as keyof AllocationWeights]} />))}
                    </Pie>
                    <RechartsTooltip contentStyle={{ background: "#0c1017", border: "1px solid #1c2736", fontSize: 12 }} formatter={(value) => [`${value}%`, "Weight"]} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              {/* CHÚ THÍCH CỦA PIE CHART */}
              <ul className="w-[150px] space-y-2 font-mono text-[11px]">
                {pieData.map((d) => (
                  <li key={d.key} className="flex items-center justify-between gap-2 border-b border-line pb-1.5 last:border-0">
                    <span className="flex items-center gap-2 text-muted">
                      <span className="h-2 w-2 rounded-sm" style={{ background: PIE_COLORS[d.key as keyof AllocationWeights] }} />{d.name}
                    </span>
                    <span className="text-ink font-bold">{d.value.toFixed(1)}%</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Panel>
      </div>

      {/* 5. TƯƠNG QUAN LỢI NHUẬN & HIỆU SUẤT */}
      <div className="grid grid-cols-[1fr_1.1fr] gap-3">
        <Panel title="30-Day Return Correlation">
          {corr ? (
            <table className="w-full border-collapse font-mono text-[11px]">
              <thead><tr><th className="p-1 text-left text-muted" />{ASSET_ORDER.map((k) => (<th key={k} className="p-1 text-center text-muted">{ASSET_LABEL[k]}</th>))}</tr></thead>
              <tbody>
                {ASSET_ORDER.map((row) => (
                  <tr key={row}>
                    <td className="p-1 text-muted">{ASSET_LABEL[row]}</td>
                    {ASSET_ORDER.map((col) => (<td key={col} className="p-1"><div className={clsx("px-1 py-1 text-center", corrColor(corr[row][col]))}>{corr[row][col].toFixed(2)}</div></td>))}
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

      {/* 6. KHUNG CHATBOT NẰM RIÊNG BIỆT Ở ĐÁY, HOÀN HẢO THEO GIAO DIỆN HỆ THỐNG */}
      <Panel title="AI QUANT EXPERT · ASSET ALLOCATION ADVISOR" right="CONNECTED" className="h-[500px] shrink-0 mb-6 flex flex-col">
        {/* Chat Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar">
          {messages.map((msg, idx) => (
            <div key={idx} className={clsx("flex flex-col max-w-[85%]", msg.sender === "user" ? "ml-auto items-end" : "mr-auto items-start")}>
              <div className={clsx(
                "p-3 rounded-lg shadow-md", 
                msg.sender === "user" ? "bg-cyan/10 border border-cyan/20 text-cyan font-semibold rounded-br-none" : "bg-panel-2 border border-line text-ink rounded-bl-none"
              )}>
                {msg.sender === "user" ? <span className="whitespace-pre-wrap font-mono text-[11px]">{msg.text}</span> : <FormatMessage text={msg.text} />}
              </div>
            </div>
          ))}
          {isLoading && (
            <div className="flex items-center gap-2 text-cyan font-mono text-[11px] p-2">
              <Loader2 size={14} className="animate-spin" /> Đang tính toán dữ liệu rủi ro...
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Quick Prompts */}
        <div className="px-3 py-2 flex gap-2 overflow-x-auto hide-scrollbar border-t border-line">
          <button onClick={() => handleSend("Tóm tắt thị trường hôm nay và khuyên tôi nên làm gì (Lưu ý tôi sống ở Việt Nam).")} className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 bg-panel-2 hover:bg-cyan/10 text-cyan rounded text-[10px] font-mono transition-colors border border-line">
            <MessageSquareText size={12} /> Thị trường & Hành động
          </button>
          <button onClick={() => handleSend("Trong 3 tháng tới tôi nên tái cơ cấu tỷ trọng BĐS và Vàng ra sao với dòng tiền tại VN?")} className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 bg-panel-2 hover:bg-cyan/10 text-cyan rounded text-[10px] font-mono transition-colors border border-line">
            <Target size={12} /> Chiến lược 3 tháng
          </button>
          <button onClick={() => handleSend("Đánh giá rủi ro danh mục hiện tại của tôi.")} className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 bg-panel-2 hover:bg-cyan/10 text-cyan rounded text-[10px] font-mono transition-colors border border-line">
            <TrendingUp size={12} /> Đánh giá rủi ro
          </button>
        </div>

        {/* Chat Input */}
        <form onSubmit={(e) => { e.preventDefault(); handleSend(input); }} className="p-3 border-t border-line flex gap-3">
          <textarea 
            rows={1} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown}
            placeholder="Hỏi AI tư vấn chiến lược... (Shift + Enter để xuống dòng)"
            className="flex-1 bg-panel-2 border border-line text-ink px-4 py-2.5 rounded text-[11px] font-mono focus:outline-none focus:border-cyan resize-none min-h-[44px] max-h-32 custom-scrollbar"
          />
          <button type="submit" disabled={isLoading || !input.trim()} className="bg-panel-2 border border-line hover:bg-cyan/20 text-cyan font-bold w-11 h-11 rounded flex items-center justify-center transition-all disabled:opacity-50 shrink-0">
            <Send size={16} className="ml-1" />
          </button>
        </form>
      </Panel>

    </div>
  );
}

// Bổ sung thêm biến desc cho Component Stat để hiển thị dữ liệu VN mượt mà
function Stat({ label, value, desc }: { label: string; value: string; desc?: string }) {
  return (
    <div className="border border-line bg-panel-2 px-2 py-2">
      <div className="text-[10px] tracking-[0.14em] text-muted">{label}</div>
      <div className="mt-1 text-ink">{value}</div>
      {desc && <div className="mt-1 text-[10px] text-cyan leading-tight">{desc}</div>}
    </div>
  );
}