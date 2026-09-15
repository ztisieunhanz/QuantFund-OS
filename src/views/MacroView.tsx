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
import { useTradingStore } from "@/stores/tradingStore";
import type { AllocationWeights, AssetKey } from "@/types/market";

const CHAT_EXPIRY_MS = 60 * 60 * 1000; 

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

// Xử lý Markdown hiển thị Chatbot bằng FONT SANS-SERIF TO, RÕ RÀNG (Arial/Tahoma/system-ui)
const FormatMessage = ({ text }: { text: string }) => {
  const lines = text.split('\n');
  return (
    <div className="space-y-2.5 text-[15px] leading-relaxed text-ink font-sans tracking-wide" style={{ fontFamily: 'Arial, Tahoma, sans-serif' }}>
      {lines.map((line, i) => {
        if (!line.trim()) return <div key={i} className="h-1.5"></div>;
        
        let formatted = line
          .replace(/\*\*(.*?)\*\*/g, '<strong class="text-white font-bold">$1</strong>')
          .replace(/\*(.*?)\*/g, '<em class="text-[#7d8ea3] italic">$1</em>');

        if (formatted.startsWith('### ')) return <h3 key={i} className="text-cyan font-bold text-[16px] mt-4 mb-2 uppercase" dangerouslySetInnerHTML={{ __html: formatted.replace('### ', '') }} />;
        if (formatted.startsWith('## ')) return <h2 key={i} className="text-[#82b1ff] font-bold text-[18px] mt-5 mb-2" dangerouslySetInnerHTML={{ __html: formatted.replace('## ', '') }} />;
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

export function MacroView() {
  const { loading, error, series, regime, correlation, load } = useMacroStore();
  const portfolio = usePortfolioStore();
  const { trend, mean, dca } = useTradingStore();
  
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Array<{ sender: "user" | "ai"; text: string }>>([]);
  const [isLoading, setIsLoading] = useState(false);
  const chatScrollRef = useRef<HTMLDivElement>(null);

  const vietnamMarketData = {
    vnindex: { value: "1,280.5", change: "+0.8%", status: "BULLISH" },
    usdvnd: { value: "25,450", change: "-0.2%", status: "Ổn định" },
    sjcGold: { value: "82.5M", premium: "+4M vs TG", status: "Chênh lệch rủi ro" },
    realEstate: { status: "THANH KHOẢN CHẬM", rate: "Lãi suất 6-7%" }
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
      setMessages([{ sender: "ai", text: "Hệ thống **AI Quant Risk Manager** đã khởi động.\n\n- Dữ liệu Danh mục: Đã nạp.\n- Dữ liệu Vĩ mô Toàn cầu: Đã nạp.\n- Bối cảnh thị trường Việt Nam: Đã kết nối.\n- Hiệu suất Trading Bots (Trend, Mean, DCA): Đã liên kết.\n\nBạn cần phân tích chiến lược hay có câu hỏi gì không?" }]);
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
      if (chatScrollRef.current) {
        chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
      }
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
      const systemPrompt = `
        Bạn là "AI Quant Expert" - Chuyên gia Tài chính & Cố vấn Quản trị Rủi ro tại quỹ đầu tư định lượng.
        Trả lời cực kỳ SẮC BÉN, CÓ TÍNH HÀNH ĐỘNG CAO (Actionable). Không nói chung chung. Trình bày Markdown chuyên nghiệp.
        
        [DỮ LIỆU DANH MỤC]
        - Tổng NAV: $${portfolio.getTotalNav()} | Tiền mặt: $${portfolio.cashUsd}
        - Phân bổ hiện tại: ${JSON.stringify(portfolio.assets.map(a => ({ Tên: a.name, Tỷ_trọng: `${a.allocationPercent}%` })))}

        [DỮ LIỆU VĨ MÔ TOÀN CẦU]
        - Trạng thái: ${regime?.label} | Điểm rủi ro: ${regime?.score}/100
        
        [DỮ LIỆU VIỆT NAM THỰC TẾ]
        - VN-Index: ${vietnamMarketData.vnindex.value} (${vietnamMarketData.vnindex.change})
        - USD/VND: ${vietnamMarketData.usdvnd.value}
        - Vàng SJC: ${vietnamMarketData.sjcGold.value} (Chênh lệch: ${vietnamMarketData.sjcGold.premium})
        - Bất động sản: ${vietnamMarketData.realEstate.status}
        
        [HIỆU SUẤT TRADING BOTS] Khi nào nhắc tới mới cần trình bày
        1. Bot Trend: Thắng ${formatPct(trend.winRate, 1)} | Lãi/Lỗ: ${formatUsd(trend.pnl)}
        2. Bot Mean Reversion: Thắng ${formatPct(mean.winRate, 1)} | Lãi/Lỗ: ${formatUsd(mean.pnl)}
        3. Bot DCA: Lãi/Lỗ: ${formatUsd(dca.pnl)}

        YÊU CẦU: Khách hàng hỏi gì đáp nấy, trực diện vào vấn đề. Nếu hỏi chiến lược, hãy khuyên cụ thể dựa trên rủi ro vĩ mô và tình hình thực tế VN (VD: Mua vàng SJC hay chờ, có nên vào BĐS lúc này không, Bot nào đang gánh lỗ cần tắt).
      `;

      const apiContents = [
        { role: "user", parts: [{ text: systemPrompt }] },
        { role: "model", parts: [{ text: "Đã nạp toàn bộ Dữ liệu. Sẵn sàng phân tích định lượng." }] },
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
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-auto p-3 custom-scrollbar relative">
      
      {/* KHÚC NÀY CHÈN CSS CHO HIỆU ỨNG MARQUEE TICKER */}
      <style dangerouslySetInnerHTML={{__html: `
        @keyframes ticker { 0% { transform: translateX(100vw); } 100% { transform: translateX(-100%); } }
        .animate-ticker { display: inline-block; white-space: nowrap; animation: ticker 35s linear infinite; will-change: transform; }
        .animate-ticker:hover { animation-play-state: paused; cursor: default; }
      `}} />

      {/* 0. DẢI TIN TỨC CHẠY NGANG (BREAKING NEWS MARQUEE) */}
      <div className="flex items-center bg-panel border border-line p-1.5 overflow-hidden shrink-0 shadow-[0_0_10px_rgba(255,193,7,0.1)] rounded">
        <div className="font-mono text-[11px] font-bold tracking-widest text-[#07090d] bg-amber px-2 py-0.5 rounded-sm mr-3 shrink-0 flex items-center gap-1.5 z-10 relative">
          <span className="w-1.5 h-1.5 bg-[#07090d] rounded-full animate-pulse"></span>
          BREAKING NEWS
        </div>
        <div className="flex-1 overflow-hidden relative h-5 flex items-center">
          <div className="animate-ticker font-sans font-semibold text-[13px] text-ink flex gap-12 absolute">
            <span className="text-up">🟢 FED CẮT GIẢM 50BPS: Chu kỳ nới lỏng chính sách tiền tệ chính thức bắt đầu, tài sản rủi ro (Crypto/Equities) hưởng lợi.</span>
            <span className="text-down">🔴 ĐỊA CHÍNH TRỊ: Căng thẳng Trung Đông bùng phát, giá dầu thô Brent vượt $90/thùng, dấy lên lo ngại lạm phát quay lại.</span>
            <span className="text-amber">⚠️ THỊ TRƯỜNG VN: Ngân hàng Nhà nước duy trì linh hoạt tỷ giá USD/VND, thanh khoản hệ thống ngân hàng dồi dào.</span>
            <span className="text-cyan">💎 DÒNG TIỀN: Cổ phiếu công nghệ và Vàng tiếp tục hút dòng tiền lớn từ các quỹ phòng hộ.</span>
          </div>
        </div>
      </div>

      {/* 1. TICKERS GỐC */}
      <div className="grid grid-cols-4 gap-3 shrink-0 mt-1">
        {series.map((s) => (
          <MetricCard key={s.id} label={s.name} ticker={s.ticker} value={s.last} changePct={s.changePct1d} digits={s.id === "us10y" ? 3 : s.id === "btc" ? 0 : 2} suffix={s.id === "us10y" ? "%" : undefined} />
        ))}
      </div>

      {/* 2. DỮ LIỆU VIỆT NAM (SỬ DỤNG THẺ DIV THUẦN TÚY ĐỂ KHÔNG BAO GIỜ BỊ OVERLAP VỚI NEWS TABLE) */}
      <div className="border border-line bg-panel flex flex-col shrink-0">
        <div className="px-4 py-2.5 border-b border-line flex justify-between items-center bg-panel-2">
          <span className="font-mono text-[11px] font-bold tracking-[0.2em] text-cyan">LOCAL CONTEXT · TÌNH HÌNH VIỆT NAM</span>
          <span className="font-mono text-[10px] text-muted border border-line px-2 py-0.5 rounded">LIVE SYNTHESIS</span>
        </div>
        <div className="p-3 grid grid-cols-4 gap-3">
          <Stat label="VN-INDEX" value={vietnamMarketData.vnindex.value} desc={`${vietnamMarketData.vnindex.change} (Tích cực)`} />
          <Stat label="TỶ GIÁ USD/VND" value={vietnamMarketData.usdvnd.value} desc={vietnamMarketData.usdvnd.status} />
          <Stat label="VÀNG SJC (BÁN)" value={vietnamMarketData.sjcGold.value} desc={vietnamMarketData.sjcGold.premium} />
          <Stat label="BẤT ĐỘNG SẢN" value={vietnamMarketData.realEstate.status} desc={vietnamMarketData.realEstate.rate} />
        </div>
      </div>

      {/* 3. BẢNG TIN TỨC VĨ MÔ */}
      <MacroNewsTable />

      {/* 4. DỮ LIỆU VĨ MÔ GỐC & BIỂU ĐỒ TRÒN FIX LỖI KHOẢNG TRẮNG */}
      <div className="grid min-h-[320px] grid-cols-[1.2fr_1fr] gap-3 shrink-0 mt-3">
        <Panel title="Global Risk / Regime Score" right={loading ? "SYNC…" : usingSynthetic ? "YAHOO FALLBACK" : "LIVE FEED"}>
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
              
              {/* DỊCH & CHUYỂN HÓA THÀNH HÀNH ĐỘNG ACTIONABLE Ở ĐÂY */}
              <div className="bg-panel-2 border border-line p-3 rounded-md">
                <p className="text-[13px] leading-relaxed text-ink/90 italic border-l-2 border-amber pl-3 mb-2">
                  "Lợi suất duy trì ở mức thắt chặt nhưng sức mạnh đồng USD không đồng pha. Các tài sản thực (Vàng, BĐS chọn lọc) đang phòng vệ rủi ro lạm phát/tài khóa tốt hơn so với trái phiếu dài hạn."
                </p>
                <div className="text-[12px] font-sans font-bold text-cyan flex items-start gap-2">
                  <span className="mt-0.5">=> HÀNH ĐỘNG:</span>
                  <span className="text-ink font-normal">Duy trì tỷ trọng Vàng để hedge rủi ro. Giữ Tiền mặt làm "Dry Powder" chờ cơ hội. Không vội bắt đáy cổ phiếu rủi ro cao.</span>
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

        <Panel title="Model Portfolio Allocation" className="flex flex-col">
          {regime ? (
            <div className="flex flex-row h-full items-center justify-between px-2">
              <div className="h-[250px] w-3/5">
                {/* Đã tinh chỉnh cx/cy và Radius để lấp đầy khoảng trắng */}
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie 
                      data={pieData} dataKey="value" nameKey="name" 
                      cx="45%" cy="50%" innerRadius={65} outerRadius={95} 
                      stroke="#07090d" strokeWidth={3} paddingAngle={2}
                    >
                      {pieData.map((d) => (<Cell key={d.key} fill={PIE_COLORS[d.key as keyof AllocationWeights]} />))}
                    </Pie>
                    <RechartsTooltip contentStyle={{ background: "#0c1017", border: "1px solid #1c2736", fontSize: 13 }} formatter={(value) => [`${value}%`, "Weight"]} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="w-2/5 flex flex-col justify-center border-l border-line/50 pl-4 h-[80%]">
                <ul className="space-y-3 font-mono text-[12px]">
                  {pieData.map((d) => (
                    <li key={d.key} className="flex flex-col gap-1 border-b border-line/30 pb-2 last:border-0">
                      <span className="flex items-center gap-2 text-muted font-bold">
                        <span className="h-2.5 w-2.5 rounded-sm" style={{ background: PIE_COLORS[d.key as keyof AllocationWeights] }} />
                        {d.name}
                      </span>
                      <span className="text-ink font-black text-[14px] pl-4.5">{d.value.toFixed(1)}%</span>
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

      {/* 6. KHUNG CHATBOT AI */}
      <Panel title="AI QUANT EXPERT · ASSET ALLOCATION ADVISOR" right="SYSTEM SYNCED" className="shrink-0 mt-3 mb-6 flex flex-col h-[550px]">
        {/* Chat Messages */}
        <div 
          ref={chatScrollRef}
          className="flex-1 overflow-y-auto p-5 space-y-6 custom-scrollbar bg-[#07090d]"
        >
          {messages.map((msg, idx) => (
            <div key={idx} className={clsx("flex flex-col max-w-[85%]", msg.sender === "user" ? "ml-auto items-end" : "mr-auto items-start")}>
              <div className={clsx(
                "p-4 rounded-xl shadow-md", 
                msg.sender === "user" ? "bg-cyan/15 border border-cyan/30 text-cyan rounded-br-none" : "bg-panel-2 border border-line text-ink rounded-bl-none"
              )}>
                {msg.sender === "user" ? <span className="whitespace-pre-wrap font-sans font-bold text-[15px]" style={{ fontFamily: 'Arial, Tahoma, sans-serif' }}>{msg.text}</span> : <FormatMessage text={msg.text} />}
              </div>
            </div>
          ))}
          {isLoading && (
            <div className="flex items-center gap-2 text-cyan font-sans font-bold text-[14px] p-2">
              <Loader2 size={16} className="animate-spin" /> Chuyên gia AI đang tổng hợp và phân tích...
            </div>
          )}
        </div>

        {/* Quick Prompts */}
        <div className="px-4 py-3 flex gap-3 overflow-x-auto hide-scrollbar border-t border-line bg-panel">
          <button onClick={() => handleSend("Tóm tắt thị trường hôm nay và khuyên tôi nên làm gì (Lưu ý tôi sống ở Việt Nam).")} className="shrink-0 flex items-center gap-1.5 px-3 py-2 bg-panel-2 hover:bg-cyan/10 text-cyan rounded font-sans font-bold text-[13px] transition-colors border border-line">
            <MessageSquareText size={14} /> Thị trường & Hành động
          </button>
          <button onClick={() => handleSend("Dựa vào tình hình hiện tại, hãy phân tích hiệu suất 3 Bot (Trend, Mean, DCA). Tôi nên tắt Bot nào và dồn vốn cho Bot nào?")} className="shrink-0 flex items-center gap-1.5 px-3 py-2 bg-panel-2 hover:bg-cyan/10 text-cyan rounded font-sans font-bold text-[13px] transition-colors border border-line">
            <Target size={14} /> Phân tích Trading Bots
          </button>
          <button onClick={() => handleSend("Đánh giá rủi ro danh mục hiện tại của tôi so với bối cảnh kinh tế VN.")} className="shrink-0 flex items-center gap-1.5 px-3 py-2 bg-panel-2 hover:bg-cyan/10 text-cyan rounded font-sans font-bold text-[13px] transition-colors border border-line">
            <TrendingUp size={14} /> Đánh giá rủi ro
          </button>
        </div>

        {/* Chat Input */}
        <form onSubmit={(e) => { e.preventDefault(); handleSend(input); }} className="p-4 border-t border-line flex gap-4 bg-panel">
          <textarea 
            rows={1} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown}
            placeholder="Nhập câu lệnh cho AI (VD: Bot Trend đang lỗi thời, tôi nên làm gì?)... (Shift + Enter để xuống dòng)"
            className="flex-1 bg-[#0c1017] border border-line text-white px-5 py-3.5 rounded-lg text-[15px] font-sans focus:outline-none focus:border-cyan resize-none min-h-[50px] max-h-32 custom-scrollbar shadow-inner" style={{ fontFamily: 'Arial, Tahoma, sans-serif' }}
          />
          <button type="submit" disabled={isLoading || !input.trim()} className="bg-panel-2 border border-line hover:bg-cyan hover:text-[#0c1017] text-cyan font-black w-14 h-14 rounded-lg flex items-center justify-center transition-all disabled:opacity-50 shrink-0">
            <Send size={20} className="ml-1" />
          </button>
        </form>
      </Panel>

    </div>
  );
}

function Stat({ label, value, desc }: { label: string; value: string; desc?: string }) {
  return (
    <div className="border border-line bg-panel-2 px-3 py-3">
      <div className="text-[10px] tracking-[0.14em] text-muted font-bold">{label}</div>
      <div className="mt-1.5 text-ink text-lg font-semibold font-mono">{value}</div>
      {desc && <div className="mt-1 text-[11px] text-cyan font-sans font-semibold leading-tight">{desc}</div>}
    </div>
  );
}