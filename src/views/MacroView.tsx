import { useEffect, useState, useMemo } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip as RechartsTooltip } from "recharts";
import { BrainCircuit, Loader2, ArrowRight, MessageSquare, Send, X, Edit3, Check } from "lucide-react";
import { Panel } from "@/components/ui/Panel";
import { MetricCard } from "@/components/ui/MetricCard";
import { MacroNewsTable } from "@/components/MacroNewsTable";
import { thirtyDayCorrelation } from "@/lib/correlation";
import { clsx } from "@/lib/clsx";
import { formatNumber, formatPct, formatUsd } from "@/lib/math";
import { useMacroStore } from "@/stores/macroStore";
import { usePortfolioStore } from "@/stores/portfolioStore";
import type { AllocationWeights, AssetKey } from "@/types/market";

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

export function MacroView() {
  const { loading, error, series, regime, correlation, load } = useMacroStore();
  const portfolio = usePortfolioStore();
  
  // State quản lý Modal Chatbot Pop-up
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<Array<{ sender: 'user' | 'ai'; text: string }>>([
    { sender: 'ai', text: 'Xin chào! Tôi là Trợ lý Quản trị Rủi ro Quant. Bạn cần tôi phân tích biến động vĩ mô hay danh mục nào?' }
  ]);
  const [isChatLoading, setIsChatLoading] = useState(false);

  // States chỉnh sửa Cash & NAV
  const [isEditingNav, setIsEditingNav] = useState(false);
  const [tempCash, setTempCash] = useState(portfolio.cashUsd.toString());
  const [tempNav, setTempNav] = useState(portfolio.getTotalNav().toString());

  useEffect(() => { if (series.length === 0) void load(); }, [load, series.length]);

  const pieData = useMemo(() => {
    if (!regime) return [];
    return (Object.keys(regime.allocation) as Array<keyof AllocationWeights>).map((key) => ({
      key, name: PIE_LABELS[key], value: Math.round(regime.allocation[key] * 1000) / 10,
    }));
  }, [regime]);

  const corr = correlation ?? (series.length ? thirtyDayCorrelation(series) : null);
  const usingSynthetic = series.some((s) => s.source === "synthetic");

  const handleSaveNav = () => {
    portfolio.setCash(Number(tempCash) || 0);
    portfolio.setTotalNav(Number(tempNav) || 0);
    setIsEditingNav(false);
  };

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim() || isChatLoading) return;

    const userText = chatInput.trim();
    setChatInput("");
    setChatMessages(prev => [...prev, { sender: 'user', text: userText }]);
    setIsChatLoading(true);

    try {
      const apiKey = (import.meta.env.VITE_GEMINI_API_KEY || "").trim();
      const prompt = `
        Đóng vai trò là Trợ lý AI Quản trị Rủi ro Quant Fund.
        Dữ liệu hiện tại:
        - Tổng NAV: $${portfolio.getTotalNav()}
        - Tiền mặt: $${portfolio.cashUsd}
        - Trạng thái Vĩ mô: ${regime?.label} (Điểm: ${regime?.score}/100)
        - Luận điểm: ${regime?.thesis}
        - Danh mục tài sản: ${JSON.stringify(portfolio.assets)}

        Câu hỏi từ nhà đầu tư: "${userText}"
        Hãy trả lời chuyên nghiệp, súc tích bằng tiếng Việt, dựa trực tiếp vào số liệu trên.
      `;

      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      });

      const data = await response.json();
      const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || "Không thể phản hồi lúc này.";
      setChatMessages(prev => [...prev, { sender: 'ai', text: reply }]);
    } catch (err) {
      setChatMessages(prev => [...prev, { sender: 'ai', text: 'Lỗi kết nối tới Gemini AI.' }]);
    } finally {
      setIsChatLoading(false);
    }
  };

  return (
    <div className="relative flex flex-col gap-3 p-4 overflow-y-auto h-full w-full bg-[#07090d] text-[#d7e2ee]">
      
      {/* HEADER: THANH CÔNG CỤ VÀ NÚT BẬT CHATBOT POP-UP */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-[#0c1017] border border-[#1c2736] p-4 rounded-xl shadow-md">
        <div>
          <h2 className="text-sm font-bold text-white uppercase tracking-wider">QuantFund OS Macro & Risk Terminal</h2>
          <p className="text-[11px] text-[#7d8ea3]">Real-time regime monitoring & AI quantitative asset allocation</p>
        </div>

        <div className="flex items-center gap-3">
          {/* Khu vực hiển thị & chỉnh sửa Cash/NAV */}
          <div className="flex items-center gap-3 bg-black/50 px-3 py-1.5 rounded-lg border border-white/5 font-mono text-xs">
            <div>
              <span className="text-[10px] text-[#7d8ea3] block">CASH:</span>
              {isEditingNav ? (
                <input type="number" value={tempCash} onChange={(e) => setTempCash(e.target.value)} className="bg-black border border-cyan-500 text-emerald-400 px-1 py-0.5 rounded w-20" />
              ) : (
                <span className="text-emerald-400 font-bold">{formatUsd(portfolio.cashUsd, 0)}</span>
              )}
            </div>
            <div className="border-l border-white/10 pl-3">
              <span className="text-[10px] text-[#7d8ea3] block">NAV:</span>
              {isEditingNav ? (
                <input type="number" value={tempNav} onChange={(e) => setTempNav(e.target.value)} className="bg-black border border-cyan-500 text-white px-1 py-0.5 rounded w-24" />
              ) : (
                <span className="text-white font-bold">{formatUsd(portfolio.getTotalNav(), 0)}</span>
              )}
            </div>
            <div className="pl-2">
              {isEditingNav ? (
                <button onClick={handleSaveNav} className="bg-emerald-500 text-black px-2 py-1 rounded font-bold hover:bg-emerald-400 flex items-center gap-1">
                  <Check size={12} /> Lưu
                </button>
              ) : (
                <button onClick={() => { setTempCash(portfolio.cashUsd.toString()); setTempNav(portfolio.getTotalNav().toString()); setIsEditingNav(true); }} className="bg-[#1c2736] text-[#26c6da] px-2 py-1 rounded hover:bg-[#26c6da]/20 flex items-center gap-1">
                  <Edit3 size={12} /> Sửa
                </button>
              )}
            </div>
          </div>

          {/* NÚT BẬT CHATBOT POP-UP (THAY THẾ NÚT CŨ) */}
          <button 
            onClick={() => setIsChatOpen(true)}
            className="flex items-center gap-2 text-xs font-bold text-white bg-gradient-to-r from-[#b388ff] to-[#7c4dff] hover:opacity-90 px-4 py-2.5 rounded-xl shadow-[0_0_20px_rgba(179,136,255,0.4)] transition-all cursor-pointer"
          >
            <BrainCircuit size={16} /> HỎI AI RISK ASSISTANT
          </button>
        </div>
      </div>

      {/* BẢNG TIN TỨC VĨ MÔ & LỊCH SỰ KIỆN */}
      <MacroNewsTable />

      {/* 2. DỮ LIỆU GỐC (Metric Cards) */}
      <div className="grid grid-cols-4 gap-3">
        {series.map((s) => (
          <MetricCard
            key={s.id}
            label={s.name}
            ticker={s.ticker}
            value={s.last}
            changePct={s.changePct1d}
            digits={s.id === "us10y" ? 3 : s.id === "btc" ? 0 : 2}
            suffix={s.id === "us10y" ? "%" : undefined}
          />
        ))}
      </div>

      {/* 3. DỮ LIỆU VĨ MÔ GỐC */}
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
                  <div className={clsx("font-mono text-4xl font-semibold", regime.score >= 55 ? "text-up" : regime.score <= 45 ? "text-down" : "text-amber")}>
                    {formatNumber(regime.score, 1)}
                  </div>
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
              <ul className="w-[150px] space-y-2 font-mono text-[11px]">
                {pieData.map((d) => (
                  <li key={d.key} className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2 text-muted">
                      <span className="h-2 w-2" style={{ background: PIE_COLORS[d.key as keyof AllocationWeights] }} />{d.name}
                    </span>
                    <span className="text-ink">{d.value.toFixed(1)}%</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Panel>
      </div>

      <div className="grid grid-cols-[1fr_1.1fr] gap-3 pb-6">
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

      {/* CHATBOT POP-UP MODAL */}
      {isChatOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="bg-[#0c1017] border border-[#b388ff]/50 w-full max-w-xl rounded-2xl shadow-2xl flex flex-col h-[550px] overflow-hidden">
            
            {/* Modal Header */}
            <div className="flex items-center justify-between px-5 py-3.5 bg-[#121824] border-b border-[#1c2736]">
              <div className="flex items-center gap-2.5">
                <div className="bg-[#b388ff]/20 p-1.5 rounded-lg border border-[#b388ff]/40">
                  <BrainCircuit size={18} className="text-[#b388ff]" />
                </div>
                <div>
                  <h3 className="font-bold text-sm text-white">Quant Risk Assistant AI</h3>
                  <p className="text-[10px] text-[#7d8ea3]">Trực tiếp liên kết với dữ liệu Macro & Danh mục</p>
                </div>
              </div>
              <button onClick={() => setIsChatOpen(false)} className="text-[#7d8ea3] hover:text-white p-1 rounded-lg hover:bg-white/5 transition-colors">
                <X size={18} />
              </button>
            </div>

            {/* Chat Messages Body */}
            <div className="flex-1 p-4 overflow-y-auto space-y-3 font-mono text-xs">
              {chatMessages.map((msg, index) => (
                <div key={index} className={clsx("flex flex-col max-w-[85%]", msg.sender === 'user' ? "ml-auto items-end" : "mr-auto items-start")}>
                  <div className={clsx("p-3 rounded-xl leading-relaxed", msg.sender === 'user' ? "bg-[#b388ff] text-black font-semibold rounded-br-none" : "bg-[#151b26] border border-[#2d213f] text-[#d7e2ee] rounded-bl-none")}>
                    {msg.text}
                  </div>
                </div>
              ))}
              {isChatLoading && (
                <div className="flex items-center gap-2 text-[#7d8ea3] text-[11px] p-2">
                  <Loader2 size={14} className="animate-spin text-[#b388ff]" /> Đang tổng hợp dữ liệu vĩ mô...
                </div>
              )}
            </div>

            {/* Chat Input Footer */}
            <form onSubmit={handleSendMessage} className="p-3 bg-[#121824] border-t border-[#1c2736] flex gap-2">
              <input 
                type="text" 
                value={chatInput} 
                onChange={(e) => setChatInput(e.target.value)}
                placeholder="Nhập câu hỏi (VD: Danh mục nên phân bổ lại thế nào khi DXY tăng?)..."
                className="flex-1 bg-[#07090d] border border-[#1c2736] text-white px-3.5 py-2.5 rounded-xl text-xs focus:outline-none focus:border-[#b388ff]"
              />
              <button type="submit" disabled={isChatLoading} className="bg-[#b388ff] hover:bg-[#9c66ff] text-black font-bold px-4 py-2.5 rounded-xl flex items-center justify-center transition-colors disabled:opacity-50">
                <Send size={15} />
              </button>
            </form>

          </div>
        </div>
      )}

    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-line bg-panel-2 px-2 py-2">
      <div className="text-[10px] tracking-[0.14em] text-muted">{label}</div>
      <div className="mt-1 text-ink">{value}</div>
    </div>
  );
}