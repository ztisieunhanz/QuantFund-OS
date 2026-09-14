import { useEffect, useState, useMemo } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip as RechartsTooltip } from "recharts";
import { ShieldAlert, HelpCircle, CheckCircle2, BrainCircuit, Loader2, ArrowRight } from "lucide-react";
import { Panel } from "@/components/ui/Panel";
import { MetricCard } from "@/components/ui/MetricCard";
import { thirtyDayCorrelation } from "@/lib/correlation";
import { clsx } from "@/lib/clsx";
import { formatNumber, formatPct, formatUsd } from "@/lib/math";
import { useMacroStore } from "@/stores/macroStore";
import { usePortfolioStore } from "@/stores/portfolioStore";
import { generatePortfolioAction, type AiRecommendation } from "@/lib/aiAdvisor";
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
  const { loading, error, series, regime, correlation, refreshedAt, load } = useMacroStore();
  const portfolio = usePortfolioStore();
  
  const [showExplanation, setShowExplanation] = useState(false);
  const [isCallingAi, setIsCallingAi] = useState(false);
  const [aiAdvice, setAiAdvice] = useState<AiRecommendation | null>(null);

  useEffect(() => { if (series.length === 0) void load(); }, [load, series.length]);

  const pieData = useMemo(() => {
    if (!regime) return [];
    return (Object.keys(regime.allocation) as Array<keyof AllocationWeights>).map((key) => ({
      key, name: PIE_LABELS[key], value: Math.round(regime.allocation[key] * 1000) / 10,
    }));
  }, [regime]);

  const corr = correlation ?? (series.length ? thirtyDayCorrelation(series) : null);
  const usingSynthetic = series.some((s) => s.source === "synthetic");

  const handleCallAi = async () => {
    setIsCallingAi(true);
    try {
      const advice = await generatePortfolioAction();
      setAiAdvice(advice);
    } catch (err) {
      alert("Lỗi kết nối AI: Hãy chắc chắn bạn đã cấu hình đúng VITE_GEMINI_API_KEY trong file .env");
      console.error(err);
    } finally {
      setIsCallingAi(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-auto p-3">
      
      {/* KHỐI 1: GIÁM ĐỐC RỦI RO AI */}
      <div className="shrink-0 rounded-xl border border-[#b388ff]/40 bg-gradient-to-br from-[#0d1219] to-[#1a1025] p-4 shadow-lg relative overflow-hidden">
        {/* Họa tiết nền */}
        <div className="absolute -top-12 -right-12 w-32 h-32 bg-[#b388ff]/10 rounded-full blur-2xl"></div>

        <div className="flex items-center justify-between pb-3 border-b border-[#2d213f] relative z-10">
          <div className="flex items-center space-x-3">
            <div className="bg-[#b388ff]/20 p-1.5 rounded-lg border border-[#b388ff]/30">
              <BrainCircuit size={18} className="text-[#b388ff]" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white tracking-wide uppercase">AI Risk Manager</h2>
              <p className="text-[10px] text-muted tracking-widest mt-0.5">GEMINI 2.0 FLASH ENGINE</p>
            </div>
          </div>
          <button 
            onClick={handleCallAi}
            disabled={isCallingAi || !regime}
            className="flex items-center gap-2 text-xs font-bold text-white bg-[#b388ff] hover:bg-[#9c66ff] px-4 py-2 rounded-lg transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed shadow-[0_0_15px_rgba(179,136,255,0.4)]"
          >
            {isCallingAi ? (
              <><Loader2 size={14} className="animate-spin" /> ĐANG PHÂN TÍCH VÍ...</>
            ) : (
              <><BrainCircuit size={14} /> XIN CHỈ THỊ HÀNH ĐỘNG</>
            )}
          </button>
        </div>

        {/* Khung hiển thị Tình hình Ví của bạn */}
        <div className="mt-4 flex gap-4 text-[11px] font-mono">
          <div className="bg-black/40 px-3 py-2 rounded border border-white/5">
            <span className="text-muted block mb-1">CASH TỒN TRỮ</span>
            <span className="text-emerald-400 text-sm font-bold">{formatUsd(portfolio.cashUsd, 0)}</span>
          </div>
          <div className="bg-black/40 px-3 py-2 rounded border border-white/5">
            <span className="text-muted block mb-1">TỔNG TÀI SẢN (NAV)</span>
            <span className="text-white text-sm font-bold">{formatUsd(portfolio.getTotalNav(), 0)}</span>
          </div>
        </div>

        {/* Khung hiển thị kết quả từ AI */}
        {aiAdvice && (
          <div className="mt-4 animate-in fade-in slide-in-from-bottom-2 duration-500">
            <div className="bg-[#151b26] p-3 rounded-t-lg border border-[#2d213f] border-b-0">
              <div className="flex justify-between items-center mb-2">
                <span className="text-[10px] text-muted uppercase tracking-wider font-semibold">Tầm nhìn thị trường</span>
                <span className={clsx("text-[10px] font-bold px-2 py-0.5 rounded border uppercase", 
                  aiAdvice.riskStatus === "DEFENSIVE" ? "bg-amber-500/20 text-amber-400 border-amber-500/50" : 
                  aiAdvice.riskStatus === "AGGRESSIVE" ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/50" : 
                  "bg-blue-500/20 text-blue-400 border-blue-500/50"
                )}>
                  Khẩu vị: {aiAdvice.riskStatus}
                </span>
              </div>
              <p className="text-[12px] text-ink/90 leading-relaxed italic border-l-2 border-[#b388ff] pl-3">
                "{aiAdvice.marketView}"
              </p>
            </div>
            
            <div className="bg-black/60 p-3 rounded-b-lg border border-[#2d213f]">
              <span className="text-[10px] text-muted uppercase tracking-wider font-semibold block mb-3">Lệnh Thực Thi Trực Tiếp</span>
              <div className="space-y-2">
                {aiAdvice.actions.map((act, idx) => (
                  <div key={idx} className="flex flex-col md:flex-row md:items-center gap-3 bg-[#151b26] p-2.5 rounded border border-white/5">
                    <div className={clsx("shrink-0 flex items-center justify-center w-14 h-8 rounded font-black text-[11px] tracking-wider", 
                      act.action === "SELL" ? "bg-rose-500/20 text-rose-400" : 
                      act.action === "BUY" ? "bg-emerald-500/20 text-emerald-400" : 
                      "bg-gray-500/20 text-gray-400"
                    )}>
                      {act.action}
                    </div>
                    <div className="flex-1 text-[11px]">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-bold text-white uppercase">{act.assetId}</span>
                        <ArrowRight size={12} className="text-muted" />
                        <span className="text-[#b388ff] font-mono">{act.percentageToMove}% tỷ trọng</span>
                      </div>
                      <span className="text-muted leading-snug">{act.reasoning}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

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