import React, { useEffect, useMemo, useState, useRef } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip as RechartsTooltip } from "recharts";
import { BrainCircuit, Loader2, Send, MessageSquareText, Target, TrendingUp, MapPin, Info } from "lucide-react";
import { MacroNewsTable } from "@/components/MacroNewsTable";
import { thirtyDayCorrelation } from "@/lib/correlation";
import { clsx } from "@/lib/clsx";
import { formatNumber, formatPct, formatUsd } from "@/lib/math";
import { useMacroStore } from "@/stores/macroStore";
import { usePortfolioStore } from "@/stores/portfolioStore";
import type { AllocationWeights, AssetKey } from "@/types/market";

const CHAT_EXPIRY_MS = 60 * 60 * 1000;

// Bảng màu Neon/Vibrant trên nền Dark Theme
const PIE_COLORS: Record<keyof AllocationWeights, string> = {
  realEstate: "#26c6da", gold: "#ffc107", usdCash: "#00e676", equities: "#82b1ff", crypto: "#b388ff",
};
const PIE_LABELS: Record<keyof AllocationWeights, string> = {
  realEstate: "Bất Động Sản", gold: "Vàng (Gold)", usdCash: "Tiền mặt (Cash)", equities: "Cổ phiếu", crypto: "Crypto",
};
const ASSET_ORDER: AssetKey[] = ["dxy", "us10y", "gold", "btc"];
const ASSET_LABEL: Record<AssetKey, string> = { dxy: "DXY (Sức mạnh USD)", us10y: "US10Y (Lãi suất 10 năm)", gold: "XAU (Vàng)", btc: "BTC (Tiền số)" };

function corrColor(v: number): string {
  if (v >= 0.6) return "bg-[#00e676]/20 text-[#00e676] border border-[#00e676]/30";
  if (v >= 0.2) return "bg-[#00e676]/10 text-[#00e676] border border-[#00e676]/20";
  if (v > -0.2) return "bg-[#1c2736] text-[#7d8ea3] border border-[#1c2736]";
  if (v > -0.6) return "bg-[#ff3d57]/10 text-[#ff3d57] border border-[#ff3d57]/20";
  return "bg-[#ff3d57]/20 text-[#ff3d57] border border-[#ff3d57]/30";
}

// Xử lý Markdown cho Chatbot nền tối
const FormatMessage = ({ text }: { text: string }) => {
  const lines = text.split('\n');
  return (
    <div className="space-y-1.5 text-[14px] leading-relaxed text-[#d7e2ee]">
      {lines.map((line, i) => {
        if (!line.trim()) return <div key={i} className="h-2"></div>;
        let formattedLine = line;
        let isTitle = false, isSubtitle = false, isList = false;

        if (formattedLine.startsWith('### ')) { isSubtitle = true; formattedLine = formattedLine.replace('### ', ''); } 
        else if (formattedLine.startsWith('## ')) { isTitle = true; formattedLine = formattedLine.replace('## ', ''); } 
        else if (formattedLine.startsWith('- ') || formattedLine.startsWith('* ')) { isList = true; formattedLine = formattedLine.substring(2); }

        const formattedHTML = formattedLine
          .replace(/\*\*(.*?)\*\*/g, '<strong class="text-white font-black">$1</strong>')
          .replace(/\*(.*?)\*/g, '<em class="italic text-[#7d8ea3]">$1</em>');

        if (isTitle) return <h2 key={i} className="text-[15px] font-bold text-[#82b1ff] mt-4 mb-2">{formattedHTML}</h2>;
        if (isSubtitle) return <h3 key={i} className="text-sm font-bold text-[#26c6da] mt-3 mb-1 uppercase tracking-wide" dangerouslySetInnerHTML={{ __html: formattedHTML }} />;
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

// Khung Panel nền tối tùy chỉnh với màu HEX cố định
const DarkPanel = ({ title, right, subtitle, children }: { title: string, right?: React.ReactNode, subtitle?: string, children: React.ReactNode }) => (
  <div className="bg-[#10151e] border border-[#1c2736] rounded-2xl shadow-lg flex flex-col overflow-hidden">
    <div className="flex flex-col px-5 py-3.5 border-b border-[#1c2736] bg-[#0c1017]">
      <div className="flex items-center justify-between">
        <h3 className="font-bold text-[12px] text-[#7d8ea3] uppercase tracking-widest">{title}</h3>
        {right && <div className="text-[10px] font-bold text-[#b388ff] uppercase bg-[#b388ff]/10 px-2 py-0.5 rounded">{right}</div>}
      </div>
      {subtitle && <p className="text-[10px] text-[#4b5563] mt-1 flex items-center gap-1"><Info size={10}/> {subtitle}</p>}
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

  // Mock Data: Bối cảnh Việt Nam
  const vietnamMarketData = {
    vnindex: { value: "1,280.5", change: "+0.8%", status: "BULLISH" },
    usdvnd: { value: "25,450", change: "-0.2%", status: "Ổn định" },
    sjcGold: { value: "82.5M", premium: "+4M vs Thế giới", status: "Chênh lệch cao" },
    realEstate: { status: "Thanh khoản thấp", rate: "Lãi suất vay 6-7%" }
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
        Bạn là Chuyên gia Tài chính Định lượng (Quant Expert). Trả lời bằng tiếng Việt, dùng Markdown (Dùng "### [Tiêu đề]", in đậm số liệu, gạch đầu dòng).
        
        DỮ LIỆU DANH MỤC HIỆN TẠI CỦA KHÁCH:
        - Tổng NAV: $${portfolio.getTotalNav()} | Tiền mặt: $${portfolio.cashUsd}
        - Tỷ trọng hiện tại: ${JSON.stringify(portfolio.assets.map(a => ({ Tên: a.name, Tỷ_trọng: `${a.allocationPercent}%` })))}

        VĨ MÔ TOÀN CẦU (GLOBAL REGIME):
        - Trạng thái: ${regime?.label} (Điểm rủi ro: ${regime?.score}/100)
        
        BỐI CẢNH ĐỊA PHƯƠNG (VIỆT NAM):
        - VN-Index: ${vietnamMarketData.vnindex.value} (${vietnamMarketData.vnindex.change})
        - Tỷ giá USD/VND: ${vietnamMarketData.usdvnd.value} (Biến động theo DXY)
        - Vàng SJC: ${vietnamMarketData.sjcGold.value}/lượng (${vietnamMarketData.sjcGold.premium})
        - Bất động sản VN: ${vietnamMarketData.realEstate.status}, ${vietnamMarketData.realEstate.rate}.
        
        => Khi đưa ra lời khuyên, HÃY KẾT HỢP Vĩ mô toàn cầu và Thực tế tại Việt Nam để phân bổ vốn sao cho tối ưu, an toàn và thực tế nhất.
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
    <div className="flex h-full min-h-0 flex-col gap-5 overflow-y-auto p-5 bg-[#07090d] font-sans custom-scrollbar">
      
      {/* 1. THÔNG SỐ TICKERS (Global) */}
      <div className="grid grid-cols-4 gap-4 shrink-0">
        {series.map((s) => {
          const decimals = s.id === "us10y" ? 3 : s.id === "btc" ? 0 : 2;
          const valStr = formatNumber(s.last, decimals);
          const isUp = s.changePct1d >= 0;
          return (
            <div key={s.id} className="bg-[#10151e] border border-[#1c2736] rounded-2xl p-4 shadow-sm flex flex-col justify-between">
              <div className="text-[11px] font-bold text-[#7d8ea3] uppercase tracking-widest">{s.name}</div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="text-2xl font-black text-white">
                  {s.id === "btc" ? formatUsd(s.last, 0) : valStr}
                </span>
                <span className={clsx("text-sm font-bold", isUp ? "text-[#00e676]" : "text-[#ff3d57]")}>
                  {isUp ? "+" : ""}{formatPct(s.changePct1d)}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* 2. KHUNG TÌNH HÌNH VIỆT NAM (LOCAL CONTEXT) - MỚI! */}
      <div className="shrink-0">
        <DarkPanel title="TÌNH HÌNH THỊ TRƯỜNG VIỆT NAM (LOCAL CONTEXT)" subtitle="Cơ sở dữ liệu hỗ trợ Bot đưa ra quyết định thực tế cho nhà đầu tư trong nước" right="CẬP NHẬT LIVE">
          <div className="grid grid-cols-4 gap-4">
            <div className="bg-black/30 border border-[#1c2736] p-3 rounded-xl">
              <div className="text-[10px] text-[#7d8ea3] uppercase font-bold tracking-wider mb-1">VN-Index</div>
              <div className="text-lg font-bold text-white">{vietnamMarketData.vnindex.value} <span className="text-sm text-[#00e676]">{vietnamMarketData.vnindex.change}</span></div>
            </div>
            <div className="bg-black/30 border border-[#1c2736] p-3 rounded-xl">
              <div className="text-[10px] text-[#7d8ea3] uppercase font-bold tracking-wider mb-1">Tỷ giá USD/VND</div>
              <div className="text-lg font-bold text-white">{vietnamMarketData.usdvnd.value} <span className="text-sm text-[#7d8ea3]">({vietnamMarketData.usdvnd.status})</span></div>
            </div>
            <div className="bg-black/30 border border-[#1c2736] p-3 rounded-xl">
              <div className="text-[10px] text-[#ffc107] uppercase font-bold tracking-wider mb-1">Vàng SJC (Bán)</div>
              <div className="text-lg font-bold text-[#ffc107]">{vietnamMarketData.sjcGold.value} <span className="text-xs text-[#ff3d57] block">{vietnamMarketData.sjcGold.premium}</span></div>
            </div>
            <div className="bg-black/30 border border-[#1c2736] p-3 rounded-xl">
              <div className="text-[10px] text-[#26c6da] uppercase font-bold tracking-wider mb-1">Bất Động Sản (Thực)</div>
              <div className="text-sm font-bold text-white leading-tight">{vietnamMarketData.realEstate.status}<br/><span className="text-[#26c6da] text-xs">{vietnamMarketData.realEstate.rate}</span></div>
            </div>
          </div>
        </DarkPanel>
      </div>

      {/* 3. BẢNG TIN TỨC VĨ MÔ */}
      <div className="shrink-0"><MacroNewsTable /></div>

      {/* 4. DỮ LIỆU VĨ MÔ GỐC & PHÂN BỔ DANH MỤC */}
      <div className="grid min-h-[300px] grid-cols-[1fr_1.2fr] gap-5 shrink-0">
        <DarkPanel title="RỦI RO VĨ MÔ TOÀN CẦU (REGIME SCORE)" subtitle="Thước đo rủi ro tổng hợp (0: Khủng hoảng, 100: Hưng phấn)" right={loading ? "ĐANG TẢI…" : usingSynthetic ? "DỮ LIỆU MÔ PHỎNG" : "DỮ LIỆU THỰC TẾ"}>
          {error ? <p className="text-sm text-[#ff3d57]">{error}</p> : null}
          {regime ? (
            <div className="flex h-full flex-col gap-5">
              <div className="flex items-end justify-between">
                <div>
                  <div className="font-mono text-[10px] tracking-widest text-[#7d8ea3] uppercase">Trạng thái (Status)</div>
                  <div className="mt-1 font-sans text-2xl font-bold text-[#ffc107]">{regime.label}</div>
                </div>
                <div className="text-right">
                  <div className="font-mono text-[10px] tracking-widest text-[#7d8ea3] uppercase">Điểm số (0-100)</div>
                  <div className={clsx("font-sans text-4xl font-black tracking-tight", regime.score >= 55 ? "text-[#00e676]" : regime.score <= 45 ? "text-[#ff3d57]" : "text-[#ffc107]")}>{formatNumber(regime.score, 1)}</div>
                </div>
              </div>
              <div className="h-3 w-full bg-[#1c2736] rounded-full overflow-hidden shadow-inner border border-black">
                <div className="h-full bg-gradient-to-r from-[#ff3d57] via-[#ffc107] to-[#00e676]" style={{ width: `${regime.score}%` }} />
              </div>
              <p className="text-[13px] leading-relaxed text-[#d7e2ee] bg-black/40 p-3 rounded-xl border border-[#1c2736]">{regime.thesis}</p>
              <div className="grid grid-cols-3 gap-3">
                <Stat label="XU HƯỚNG DXY" value={formatNumber(regime.dxyTrend * 100, 3) + "%/ngày"} desc="Đo sức mạnh của đồng Đô la Mỹ" />
                <Stat label="LỢI SUẤT US10Y" value={formatNumber(regime.yieldLevel, 3) + "%"} desc="Lợi suất Trái phiếu Chính phủ Mỹ" />
                <Stat label="XU HƯỚNG 10Y" value={formatNumber(regime.yieldTrend * 100, 3) + " bps"} desc="Gia tốc thay đổi của lợi suất" />
              </div>
            </div>
          ) : (<div className="text-sm text-[#7d8ea3] flex h-full items-center justify-center">Đang tính toán dữ liệu...</div>)}
        </DarkPanel>

        <DarkPanel title="PHÂN BỔ DANH MỤC MẪU BỞI AI" subtitle="Mô hình Markowitz tối ưu hóa tỷ trọng theo điểm số vĩ mô hiện tại">
          {regime ? (
            <div className="flex h-full items-center gap-8 px-4">
              <div className="h-[250px] flex-1">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={pieData} dataKey="value" nameKey="name" innerRadius={70} outerRadius={105} stroke="#10151e" strokeWidth={5} paddingAngle={2}>
                      {pieData.map((d) => (<Cell key={d.key} fill={PIE_COLORS[d.key as keyof AllocationWeights]} />))}
                    </Pie>
                    <RechartsTooltip contentStyle={{ background: "#0c1017", border: "1px solid #1c2736", borderRadius: '12px', color: '#fff', fontSize: '13px' }} formatter={(value) => [`${value}%`, "Tỷ trọng"]} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              {/* CHÚ THÍCH RÕ RÀNG */}
              <ul className="w-[190px] space-y-3 font-sans text-[13px]">
                {pieData.map((d) => (
                  <li key={d.key} className="flex items-center justify-between p-2.5 rounded-xl bg-black/40 border border-[#1c2736] hover:border-[#26c6da]/50 transition-colors">
                    <span className="flex items-center gap-2.5 text-[#d7e2ee] font-semibold">
                      <span className="h-3.5 w-3.5 rounded-full shadow-sm" style={{ background: PIE_COLORS[d.key as keyof AllocationWeights] }} />
                      {d.name}
                    </span>
                    <span className="text-white font-black">{d.value.toFixed(1)}%</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </DarkPanel>
      </div>

      {/* 5. CHỈ SỐ CORRELATION & TAPE */}
      <div className="grid grid-cols-[1fr_1.1fr] gap-5 shrink-0">
        <DarkPanel title="TƯƠNG QUAN LỢI NHUẬN (30 NGÀY)" subtitle="Đo lường mức độ các tài sản di chuyển cùng chiều (1.0) hoặc ngược chiều (-1.0)">
          {corr ? (
            <div className="overflow-hidden rounded-xl border border-[#1c2736]">
              <table className="w-full border-collapse font-sans text-[13px]">
                <thead className="bg-[#0c1017]"><tr><th className="p-3 text-left text-[#7d8ea3] font-semibold" />{ASSET_ORDER.map((k) => (<th key={k} className="p-3 text-center text-[#7d8ea3] font-bold">{ASSET_LABEL[k]}</th>))}</tr></thead>
                <tbody className="bg-[#10151e]">
                  {ASSET_ORDER.map((row) => (
                    <tr key={row} className="border-t border-[#1c2736]">
                      <td className="p-3 text-[#7d8ea3] font-bold bg-[#0c1017]/50">{ASSET_LABEL[row]}</td>
                      {ASSET_ORDER.map((col) => (<td key={col} className="p-2.5"><div className={clsx("px-2 py-2 rounded-lg text-center font-bold", corrColor(corr[row][col]))}>{corr[row][col].toFixed(2)}</div></td>))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (<div className="text-sm text-[#7d8ea3]">Đang chờ dữ liệu…</div>)}
        </DarkPanel>

        <DarkPanel title="HIỆU SUẤT TÀI SẢN (20 NGÀY)" subtitle="Biến động giá trị của các chỉ số chính trong 20 phiên gần nhất">
          <div className="space-y-3">
            {series.map((s) => (
              <div key={s.id} className="flex items-center gap-4 bg-black/40 border border-[#1c2736] px-4 py-3 rounded-xl">
                <div className="w-20 font-bold text-sm text-[#26c6da] uppercase">{s.ticker}</div>
                <div className="flex-1"><div className="h-2.5 bg-[#0c1017] rounded-full overflow-hidden shadow-inner"><div className={clsx("h-full rounded-full", s.changePct20d >= 0 ? "bg-[#00e676]" : "bg-[#ff3d57]")} style={{ width: `${Math.min(100, Math.abs(s.changePct20d) * 400)}%` }} /></div></div>
                <div className={clsx("w-20 text-right text-sm font-bold", s.changePct20d >= 0 ? "text-[#00e676]" : "text-[#ff3d57]")}>{formatPct(s.changePct20d)}</div>
                <div className="w-16 text-right text-[11px] font-bold text-[#7d8ea3] bg-[#1c2736] px-2 py-1 rounded-md">{s.source === "live" ? "TRỰC TIẾP" : "MÔ PHỎNG"}</div>
              </div>
            ))}
          </div>
        </DarkPanel>
      </div>

      {/* 6. KHUNG CHATBOT AI CHUYÊN GIA NẰM Ở ĐÁY DASHBOARD (DARK THEME) */}
      <div className="mt-2 flex flex-col bg-[#0c1017] border border-[#b388ff]/30 rounded-3xl shadow-[0_0_15px_rgba(179,136,255,0.1)] h-[550px] shrink-0 mb-6 overflow-hidden relative">
        {/* Họa tiết nền Chatbot */}
        <div className="absolute -top-20 -right-20 w-48 h-48 bg-[#b388ff]/10 rounded-full blur-3xl pointer-events-none"></div>

        {/* Chat Header */}
        <div className="px-6 py-4 bg-[#10151e] border-b border-[#1c2736] flex items-center gap-3 relative z-10">
          <div className="bg-[#b388ff]/20 p-2.5 rounded-xl border border-[#b388ff]/40 shadow-sm">
            <BrainCircuit size={20} className="text-[#b388ff]" />
          </div>
          <div>
            <div className="font-bold text-[16px] text-white tracking-wide flex items-center gap-2">
              AI Quant Expert 
              <span className="bg-[#00e676]/20 text-[#00e676] text-[10px] px-2.5 py-0.5 rounded-full border border-[#00e676]/30 font-bold uppercase tracking-wider">Đã đồng bộ dữ liệu</span>
            </div>
            <div className="text-xs text-[#7d8ea3] font-medium flex items-center gap-1 mt-1"><MapPin size={12} className="text-[#ff3d57]"/> Context: Global & Vietnam Market Active</div>
          </div>
        </div>

        {/* Chat Messages */}
        <div className="flex-1 p-6 overflow-y-auto bg-[#0c1017] space-y-6 custom-scrollbar relative z-10">
          {messages.map((msg, idx) => (
            <div key={idx} className={clsx("flex flex-col max-w-[85%]", msg.sender === "user" ? "ml-auto items-end" : "mr-auto items-start")}>
              <div className={clsx(
                "p-4 rounded-2xl shadow-sm text-[14px]", 
                msg.sender === "user" ? "bg-gradient-to-br from-[#b388ff] to-[#7c4dff] text-white font-bold rounded-br-sm" : "bg-[#10151e] border border-[#1c2736] text-[#d7e2ee] rounded-bl-sm"
              )}>
                {msg.sender === "user" ? <span className="whitespace-pre-wrap">{msg.text}</span> : <FormatMessage text={msg.text} />}
              </div>
            </div>
          ))}
          {isLoading && (
            <div className="flex items-center gap-2 text-[#7d8ea3] text-sm p-2 font-medium">
              <Loader2 size={16} className="animate-spin text-[#b388ff]" /> Trợ lý đang tính toán chiến lược...
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Quick Prompts */}
        <div className="px-5 py-3 bg-[#10151e] flex gap-2.5 overflow-x-auto hide-scrollbar border-t border-[#1c2736] relative z-10">
          <button onClick={() => handleSend("Tóm tắt thị trường hôm nay và khuyên tôi nên làm gì (Lưu ý tôi sống ở Việt Nam).")} className="shrink-0 flex items-center gap-1.5 px-4 py-2 bg-[#0c1017] hover:bg-[#b388ff]/10 text-[#b388ff] rounded-xl text-[12px] font-bold transition-colors border border-[#1c2736] hover:border-[#b388ff]/50">
            <MessageSquareText size={14} /> Thị trường & Hành động
          </button>
          <button onClick={() => handleSend("Trong 3 tháng tới tôi nên tái cơ cấu tỷ trọng BĐS và Vàng ra sao với dòng tiền tại VN?")} className="shrink-0 flex items-center gap-1.5 px-4 py-2 bg-[#0c1017] hover:bg-[#b388ff]/10 text-[#b388ff] rounded-xl text-[12px] font-bold transition-colors border border-[#1c2736] hover:border-[#b388ff]/50">
            <Target size={14} /> Chiến lược 3 tháng
          </button>
          <button onClick={() => handleSend("Đánh giá rủi ro danh mục hiện tại của tôi.")} className="shrink-0 flex items-center gap-1.5 px-4 py-2 bg-[#0c1017] hover:bg-[#b388ff]/10 text-[#b388ff] rounded-xl text-[12px] font-bold transition-colors border border-[#1c2736] hover:border-[#b388ff]/50">
            <TrendingUp size={14} /> Đánh giá rủi ro
          </button>
        </div>

        {/* Chat Input */}
        <form onSubmit={(e) => { e.preventDefault(); handleSend(input); }} className="p-4 bg-[#10151e] border-t border-[#1c2736] flex gap-3 relative z-10">
          <textarea 
            rows={1} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown}
            placeholder="Hỏi AI tư vấn chiến lược... (Shift + Enter để xuống dòng)"
            className="flex-1 bg-[#0c1017] border border-[#1c2736] text-white px-5 py-3.5 rounded-2xl text-[14px] font-medium focus:outline-none focus:border-[#b388ff] transition-colors resize-none min-h-[52px] max-h-32 custom-scrollbar shadow-inner"
          />
          <button type="submit" disabled={isLoading || !input.trim()} className="bg-gradient-to-br from-[#b388ff] to-[#7c4dff] hover:opacity-90 text-white font-bold w-14 h-14 rounded-2xl flex items-center justify-center transition-all disabled:opacity-50 shadow-md shrink-0">
            <Send size={20} className="ml-1" />
          </button>
        </form>
      </div>

    </div>
  );
}

function Stat({ label, value, desc }: { label: string; value: string; desc?: string }) {
  return (
    <div className="border border-[#1c2736] bg-black/40 px-4 py-3 rounded-xl shadow-sm relative group cursor-help">
      <div className="text-[11px] tracking-widest text-[#7d8ea3] font-bold uppercase">{label}</div>
      <div className="mt-1.5 text-white font-black text-[15px]">{value}</div>
      {desc && (
        <div className="absolute bottom-full left-0 mb-2 w-max max-w-[200px] bg-[#26c6da] text-black text-[10px] font-bold px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50 shadow-lg">
          {desc}
        </div>
      )}
    </div>
  );
}