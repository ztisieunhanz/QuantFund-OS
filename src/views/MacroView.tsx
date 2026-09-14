import React, { useEffect, useMemo, useState, useRef } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip as RechartsTooltip } from "recharts";
import { BrainCircuit, Loader2, Send, MessageSquareText, Target, TrendingUp, MapPin } from "lucide-react";
import { MacroNewsTable } from "@/components/MacroNewsTable";
import { thirtyDayCorrelation } from "@/lib/correlation";
import { clsx } from "@/lib/clsx";
import { formatNumber, formatPct, formatUsd } from "@/lib/math";
import { useMacroStore } from "@/stores/macroStore";
import { usePortfolioStore } from "@/stores/portfolioStore";
import type { AllocationWeights, AssetKey } from "@/types/market";

const CHAT_EXPIRY_MS = 60 * 60 * 1000;

// Bảng màu Pastel tươi sáng, dùng mã Hex tuyệt đối để không bị lỗi CSS
const PIE_COLORS: Record<keyof AllocationWeights, string> = {
  realEstate: "#38bdf8", gold: "#fbbf24", usdCash: "#34d399", equities: "#a78bfa", crypto: "#fb7185",
};
const PIE_LABELS: Record<keyof AllocationWeights, string> = {
  realEstate: "Bất Động Sản", gold: "Vàng (Gold)", usdCash: "Tiền mặt (Cash)", equities: "Cổ phiếu", crypto: "Crypto",
};
const ASSET_ORDER: AssetKey[] = ["dxy", "us10y", "gold", "btc"];
const ASSET_LABEL: Record<AssetKey, string> = { dxy: "DXY", us10y: "US10Y", gold: "XAU", btc: "BTC" };

function corrColor(v: number): string {
  if (v >= 0.6) return "bg-[#d1fae5] text-[#047857] border border-[#a7f3d0]";
  if (v >= 0.2) return "bg-[#ecfdf5] text-[#059669] border border-[#d1fae5]";
  if (v > -0.2) return "bg-[#f8fafc] text-[#64748b] border border-[#e2e8f0]";
  if (v > -0.6) return "bg-[#fff1f2] text-[#e11d48] border border-[#ffe4e6]";
  return "bg-[#ffe4e6] text-[#be123c] border border-[#fecdd3]";
}

// Format Markdown an toàn cho nền sáng
const FormatMessage = ({ text }: { text: string }) => {
  const lines = text.split('\n');
  return (
    <div className="space-y-1.5 text-[14px] leading-relaxed text-[#334155]">
      {lines.map((line, i) => {
        if (!line.trim()) return <div key={i} className="h-2"></div>;
        let formattedLine = line;
        let isTitle = false, isSubtitle = false, isList = false;

        if (formattedLine.startsWith('### ')) { isSubtitle = true; formattedLine = formattedLine.replace('### ', ''); } 
        else if (formattedLine.startsWith('## ')) { isTitle = true; formattedLine = formattedLine.replace('## ', ''); } 
        else if (formattedLine.startsWith('- ') || formattedLine.startsWith('* ')) { isList = true; formattedLine = formattedLine.substring(2); }

        const formattedHTML = formattedLine
          .replace(/\*\*(.*?)\*\*/g, '<strong class="text-[#0f172a] font-black">$1</strong>')
          .replace(/\*(.*?)\*/g, '<em class="italic text-[#475569]">$1</em>');

        if (isTitle) return <h2 key={i} className="text-[15px] font-bold text-[#4338ca] mt-4 mb-2">{formattedHTML}</h2>;
        if (isSubtitle) return <h3 key={i} className="text-sm font-bold text-[#0284c7] mt-3 mb-1 uppercase tracking-wide" dangerouslySetInnerHTML={{ __html: formattedHTML }} />;
        if (isList) return (
          <div key={i} className="flex items-start gap-2 ml-1">
            <span className="text-[#0ea5e9] mt-0.5">•</span><span dangerouslySetInnerHTML={{ __html: formattedHTML }} />
          </div>
        );
        return <div key={i} dangerouslySetInnerHTML={{ __html: formattedHTML }} />;
      })}
    </div>
  );
};

// Panel độc lập để ép CSS Light Theme, không dùng Panel mặc định của hệ thống
const LightPanel = ({ title, right, children }: { title: string, right?: React.ReactNode, children: React.ReactNode }) => (
  <div className="bg-[#ffffff] border border-[#e2e8f0] rounded-2xl shadow-sm flex flex-col overflow-hidden">
    <div className="flex items-center justify-between px-5 py-3.5 border-b border-[#f1f5f9] bg-[#f8fafc]">
      <h3 className="font-bold text-[12px] text-[#64748b] uppercase tracking-widest">{title}</h3>
      {right && <div className="text-[10px] font-bold text-[#94a3b8] uppercase">{right}</div>}
    </div>
    <div className="p-5 flex-1">{children}</div>
  </div>
);

export function MacroView() {
  const { loading, error, series, regime, correlation, load } = useMacroStore();
  const portfolio = usePortfolioStore();
  
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

  useEffect(() => {
    const lastReset = localStorage.getItem("quant_chat_last_reset");
    const now = Date.now();
    if (!lastReset || now - parseInt(lastReset) > CHAT_EXPIRY_MS) {
      setMessages([{ sender: "ai", text: "Xin chào! Tôi là **AI Quant Expert**. Dữ liệu Vĩ mô toàn cầu và bối cảnh thị trường Việt Nam đã được đồng bộ.\n\nBạn cần tư vấn cơ cấu lại danh mục tài sản như thế nào?" }]);
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
        Bạn là Chuyên gia Tài chính Định lượng (Quant Expert). Trả lời bằng tiếng Việt, dùng Markdown rõ ràng (Dùng "### [Tiêu đề]", in đậm số liệu quan trọng, gạch đầu dòng rõ ràng).
        
        DỮ LIỆU DANH MỤC THỰC TẾ:
        - Tổng NAV: $${portfolio.getTotalNav()} | Tiền mặt: $${portfolio.cashUsd}
        - Trạng thái Vĩ mô: ${regime?.label} (Điểm rủi ro: ${regime?.score}/100)
        - Tỷ trọng hiện tại: ${JSON.stringify(portfolio.assets.map(a => ({ Tên: a.name, Tỷ_trọng: `${a.allocationPercent}%` })))}

        BỐI CẢNH THỊ TRƯỜNG ĐỊA PHƯƠNG (VIỆT NAM):
        - Bất động sản VN: Giá neo rất cao, thanh khoản tập trung ở chung cư thực, đất nền tỉnh chững lại.
        - Vàng VN (SJC/Nhẫn): Thường có độ lệch (premium) cao hơn giá thế giới, chịu ảnh hưởng từ chính sách NHNN.
        - Tiền mặt (VND): Lãi suất tiết kiệm ngân hàng dao động quanh 4.5% - 5.5%/năm tùy kỳ hạn.
        - Tỷ giá USD/VND: Biến động theo DXY và chính sách điều hành tỷ giá trung tâm.
        
        => Hãy kết hợp dữ liệu toàn cầu với bối cảnh thực tế tại Việt Nam để đưa ra chiến lược phân bổ tối ưu.
      `;

      const apiContents = [
        { role: "user", parts: [{ text: systemPrompt }] },
        { role: "model", parts: [{ text: "Đã nạp dữ liệu danh mục toàn cầu và bối cảnh kinh tế Việt Nam. Tôi sẵn sàng đưa ra tư vấn chi tiết." }] },
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
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(input); }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-5 overflow-y-auto p-5 bg-[#f8fafc] font-sans custom-scrollbar">
      
      {/* 1. THÔNG SỐ TICKERS (Đã fix lỗi số thập phân) */}
      <div className="grid grid-cols-4 gap-4 shrink-0">
        {series.map((s) => {
          const decimals = s.id === "us10y" ? 3 : s.id === "btc" ? 0 : 2;
          const valStr = formatNumber(s.last, decimals);
          const isUp = s.changePct1d >= 0;
          return (
            <div key={s.id} className="bg-[#ffffff] border border-[#e2e8f0] rounded-2xl p-4 shadow-sm flex flex-col justify-between hover:shadow-md transition-shadow">
              <div className="text-[11px] font-bold text-[#64748b] uppercase tracking-widest">{s.name}</div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="text-2xl font-black text-[#1e293b]">
                  {s.id === "btc" ? formatUsd(s.last, 0) : valStr}
                </span>
                <span className={clsx("text-sm font-bold", isUp ? "text-[#10b981]" : "text-[#f43f5e]")}>
                  {formatPct(s.changePct1d)}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* 2. BẢNG TIN TỨC VĨ MÔ */}
      <div className="shrink-0"><MacroNewsTable /></div>

      {/* 3. DỮ LIỆU VĨ MÔ GỐC & PHÂN BỔ DANH MỤC */}
      <div className="grid min-h-[300px] grid-cols-[1fr_1.2fr] gap-5 shrink-0">
        <LightPanel title="ĐIỂM RỦI RO VĨ MÔ TỔNG HỢP" right={loading ? "ĐANG TẢI…" : usingSynthetic ? "DỮ LIỆU MÔ PHỎNG" : "DỮ LIỆU THỰC TẾ"}>
          {error ? <p className="text-sm text-[#f43f5e]">{error}</p> : null}
          {regime ? (
            <div className="flex h-full flex-col gap-5">
              <div className="flex items-end justify-between">
                <div>
                  <div className="font-mono text-[10px] tracking-widest text-[#94a3b8] uppercase">Trạng thái (Status)</div>
                  <div className="mt-1 font-sans text-2xl font-bold text-[#f59e0b]">{regime.label}</div>
                </div>
                <div className="text-right">
                  <div className="font-mono text-[10px] tracking-widest text-[#94a3b8] uppercase">Điểm số (0-100)</div>
                  <div className={clsx("font-sans text-4xl font-black tracking-tight", regime.score >= 55 ? "text-[#10b981]" : regime.score <= 45 ? "text-[#f43f5e]" : "text-[#f59e0b]")}>{formatNumber(regime.score, 1)}</div>
                </div>
              </div>
              <div className="h-3 w-full bg-[#f1f5f9] rounded-full overflow-hidden shadow-inner border border-[#e2e8f0]">
                <div className="h-full bg-gradient-to-r from-[#fb7185] via-[#fbbf24] to-[#34d399]" style={{ width: `${regime.score}%` }} />
              </div>
              <p className="text-[14px] leading-relaxed text-[#475569] bg-[#f8fafc] p-3 rounded-xl border border-[#f1f5f9]">{regime.thesis}</p>
              <div className="grid grid-cols-3 gap-3">
                <Stat label="XU HƯỚNG DXY" value={formatNumber(regime.dxyTrend * 100, 3) + "%/ngày"} />
                <Stat label="LỢI SUẤT 10 NĂM" value={formatNumber(regime.yieldLevel, 3) + "%"} />
                <Stat label="XU HƯỚNG 10Y" value={formatNumber(regime.yieldTrend * 100, 3) + " bps"} />
              </div>
            </div>
          ) : (<div className="text-sm text-[#64748b] flex h-full items-center justify-center">Đang tính toán dữ liệu...</div>)}
        </LightPanel>

        <LightPanel title="PHÂN BỔ DANH MỤC KHUYẾN NGHỊ">
          {regime ? (
            <div className="flex h-full items-center gap-8 px-4">
              <div className="h-[250px] flex-1">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={pieData} dataKey="value" nameKey="name" innerRadius={70} outerRadius={105} stroke="#ffffff" strokeWidth={5} paddingAngle={2}>
                      {pieData.map((d) => (<Cell key={d.key} fill={PIE_COLORS[d.key as keyof AllocationWeights]} />))}
                    </Pie>
                    <RechartsTooltip contentStyle={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: '12px', color: '#1e293b', fontSize: '13px', boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1)' }} formatter={(value) => [`${value}%`, "Tỷ trọng"]} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              {/* CHÚ THÍCH RÕ RÀNG */}
              <ul className="w-[190px] space-y-3 font-sans text-[13px]">
                {pieData.map((d) => (
                  <li key={d.key} className="flex items-center justify-between p-2.5 rounded-xl bg-[#f8fafc] border border-[#f1f5f9] hover:border-[#e2e8f0] transition-colors">
                    <span className="flex items-center gap-2.5 text-[#475569] font-semibold">
                      <span className="h-3.5 w-3.5 rounded-full shadow-sm" style={{ background: PIE_COLORS[d.key as keyof AllocationWeights] }} />
                      {d.name}
                    </span>
                    <span className="text-[#0f172a] font-black">{d.value.toFixed(1)}%</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </LightPanel>
      </div>

      {/* 4. CHỈ SỐ CORRELATION & TAPE */}
      <div className="grid grid-cols-[1fr_1.1fr] gap-5 shrink-0">
        <LightPanel title="MỨC ĐỘ TƯƠNG QUAN TÀI SẢN (30 NGÀY)">
          {corr ? (
            <div className="overflow-hidden rounded-xl border border-[#e2e8f0]">
              <table className="w-full border-collapse font-sans text-[13px]">
                <thead className="bg-[#f8fafc]"><tr><th className="p-3 text-left text-[#64748b] font-semibold" />{ASSET_ORDER.map((k) => (<th key={k} className="p-3 text-center text-[#64748b] font-bold">{ASSET_LABEL[k]}</th>))}</tr></thead>
                <tbody className="bg-[#ffffff]">
                  {ASSET_ORDER.map((row) => (
                    <tr key={row} className="border-t border-[#f1f5f9]">
                      <td className="p-3 text-[#475569] font-bold bg-[#f8fafc]/50">{ASSET_LABEL[row]}</td>
                      {ASSET_ORDER.map((col) => (<td key={col} className="p-2.5"><div className={clsx("px-2 py-2 rounded-lg text-center font-bold", corrColor(corr[row][col]))}>{corr[row][col].toFixed(2)}</div></td>))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (<div className="text-sm text-[#64748b]">Đang chờ dữ liệu…</div>)}
        </LightPanel>

        <LightPanel title="HIỆU SUẤT BIẾN ĐỘNG 20 NGÀY QUA">
          <div className="space-y-3">
            {series.map((s) => (
              <div key={s.id} className="flex items-center gap-4 bg-[#ffffff] border border-[#e2e8f0] px-4 py-3 rounded-xl shadow-sm">
                <div className="w-20 font-bold text-sm text-[#0ea5e9] uppercase">{s.ticker}</div>
                <div className="flex-1"><div className="h-2.5 bg-[#f1f5f9] rounded-full overflow-hidden shadow-inner"><div className={clsx("h-full rounded-full", s.changePct20d >= 0 ? "bg-[#34d399]" : "bg-[#fb7185]")} style={{ width: `${Math.min(100, Math.abs(s.changePct20d) * 400)}%` }} /></div></div>
                <div className={clsx("w-20 text-right text-sm font-bold", s.changePct20d >= 0 ? "text-[#059669]" : "text-[#e11d48]")}>{formatPct(s.changePct20d)}</div>
                <div className="w-16 text-right text-[11px] font-bold text-[#94a3b8] bg-[#f8fafc] px-2 py-1 rounded-md border border-[#f1f5f9]">{s.source === "live" ? "TRỰC TIẾP" : "MÔ PHỎNG"}</div>
              </div>
            ))}
          </div>
        </LightPanel>
      </div>

      {/* 5. KHUNG CHATBOT AI CHUYÊN GIA NẰM Ở ĐÁY DASHBOARD */}
      <div className="mt-2 flex flex-col bg-[#ffffff] border border-[#e2e8f0] rounded-3xl shadow-md h-[550px] shrink-0 mb-6 overflow-hidden">
        {/* Chat Header */}
        <div className="px-6 py-4 bg-[#f8fafc] border-b border-[#e2e8f0] flex items-center gap-3">
          <div className="bg-[#e0f2fe] p-2.5 rounded-xl border border-[#bae6fd] shadow-sm">
            <BrainCircuit size={20} className="text-[#0ea5e9]" />
          </div>
          <div>
            <div className="font-bold text-[16px] text-[#0f172a] tracking-wide flex items-center gap-2">
              AI Quant Expert 
              <span className="bg-[#d1fae5] text-[#047857] text-[10px] px-2.5 py-0.5 rounded-full border border-[#a7f3d0] font-bold uppercase tracking-wider shadow-sm">Đã đồng bộ dữ liệu</span>
            </div>
            <div className="text-xs text-[#64748b] font-medium flex items-center gap-1 mt-1"><MapPin size={12} className="text-[#f43f5e]"/> Context: Global & Vietnam Market</div>
          </div>
        </div>

        {/* Chat Messages */}
        <div className="flex-1 p-6 overflow-y-auto bg-[#f8fafc] space-y-6 custom-scrollbar">
          {messages.map((msg, idx) => (
            <div key={idx} className={clsx("flex flex-col max-w-[85%]", msg.sender === "user" ? "ml-auto items-end" : "mr-auto items-start")}>
              <div className={clsx(
                "p-4 rounded-2xl shadow-sm text-[14px]", 
                msg.sender === "user" ? "bg-[#e0f2fe] border border-[#bae6fd] text-[#0c4a6e] font-semibold rounded-br-sm" : "bg-[#ffffff] border border-[#e2e8f0] text-[#334155] rounded-bl-sm"
              )}>
                {msg.sender === "user" ? <span className="whitespace-pre-wrap">{msg.text}</span> : <FormatMessage text={msg.text} />}
              </div>
            </div>
          ))}
          {isLoading && (
            <div className="flex items-center gap-2 text-[#64748b] text-sm p-2 font-medium">
              <Loader2 size={16} className="animate-spin text-[#0ea5e9]" /> Trợ lý đang tính toán chiến lược...
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Quick Prompts */}
        <div className="px-5 py-3 bg-[#ffffff] flex gap-2.5 overflow-x-auto hide-scrollbar border-t border-[#f1f5f9]">
          <button onClick={() => handleSend("Tóm tắt thị trường hôm nay và khuyên tôi nên làm gì (Lưu ý tôi sống ở Việt Nam).")} className="shrink-0 flex items-center gap-1.5 px-4 py-2 bg-[#f8fafc] hover:bg-[#f1f5f9] text-[#0369a1] rounded-xl text-[12px] font-bold transition-colors border border-[#e2e8f0] shadow-sm">
            <MessageSquareText size={14} /> Thị trường & Hành động
          </button>
          <button onClick={() => handleSend("Trong 3 tháng tới tôi nên tái cơ cấu tỷ trọng BĐS và Vàng ra sao với dòng tiền tại VN?")} className="shrink-0 flex items-center gap-1.5 px-4 py-2 bg-[#f8fafc] hover:bg-[#f1f5f9] text-[#0369a1] rounded-xl text-[12px] font-bold transition-colors border border-[#e2e8f0] shadow-sm">
            <Target size={14} /> Chiến lược 3 tháng
          </button>
          <button onClick={() => handleSend("Đánh giá rủi ro danh mục hiện tại của tôi.")} className="shrink-0 flex items-center gap-1.5 px-4 py-2 bg-[#f8fafc] hover:bg-[#f1f5f9] text-[#0369a1] rounded-xl text-[12px] font-bold transition-colors border border-[#e2e8f0] shadow-sm">
            <TrendingUp size={14} /> Đánh giá rủi ro
          </button>
        </div>

        {/* Chat Input */}
        <form onSubmit={(e) => { e.preventDefault(); handleSend(input); }} className="p-4 bg-[#ffffff] border-t border-[#e2e8f0] flex gap-3">
          <textarea 
            rows={1} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown}
            placeholder="Hỏi AI tư vấn chiến lược... (Shift + Enter để xuống dòng)"
            className="flex-1 bg-[#f8fafc] border border-[#e2e8f0] text-[#1e293b] px-5 py-3.5 rounded-2xl text-[14px] font-medium focus:outline-none focus:border-[#38bdf8] focus:bg-[#ffffff] transition-colors resize-none min-h-[52px] max-h-32 custom-scrollbar shadow-inner"
          />
          <button type="submit" disabled={isLoading || !input.trim()} className="bg-[#0ea5e9] hover:bg-[#0284c7] text-white font-bold w-14 h-14 rounded-2xl flex items-center justify-center transition-all disabled:opacity-50 shadow-md shrink-0">
            <Send size={20} className="ml-1" />
          </button>
        </form>
      </div>

    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-[#e2e8f0] bg-[#ffffff] px-4 py-3 rounded-xl shadow-sm">
      <div className="text-[11px] tracking-widest text-[#64748b] font-bold uppercase">{label}</div>
      <div className="mt-1.5 text-[#0f172a] font-black text-[15px]">{value}</div>
    </div>
  );
}