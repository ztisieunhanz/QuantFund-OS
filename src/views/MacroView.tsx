import { useEffect, useMemo } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip as RechartsTooltip } from "recharts";
import { Panel } from "@/components/ui/Panel";
import { MetricCard } from "@/components/ui/MetricCard";
import { MacroNewsTable } from "@/components/MacroNewsTable";
import { thirtyDayCorrelation } from "@/lib/correlation";
import { clsx } from "@/lib/clsx";
import { formatNumber, formatPct } from "@/lib/math";
import { useMacroStore } from "@/stores/macroStore";
import type { AllocationWeights, AssetKey } from "@/types/market";

const PIE_COLORS: Record<keyof AllocationWeights, string> = {
  realEstate: "#0ea5e9", // Mượt hơn
  gold: "#eab308",
  usdCash: "#10b981",
  equities: "#8b5cf6",
  crypto: "#f43f5e",
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

export function MacroView() {
  const { loading, error, series, regime, correlation, load } = useMacroStore();
  
  useEffect(() => { 
    if (series.length === 0) void load(); 
  }, [load, series.length]);

  const pieData = useMemo(() => {
    if (!regime) return [];
    return (Object.keys(regime.allocation) as Array<keyof AllocationWeights>).map((key) => ({
      key, name: PIE_LABELS[key], value: Math.round(regime.allocation[key] * 1000) / 10,
    }));
  }, [regime]);

  const corr = correlation ?? (series.length ? thirtyDayCorrelation(series) : null);
  const usingSynthetic = series.some((s) => s.source === "synthetic");

  return (
    <div className="flex h-full min-h-0 flex-col gap-5 overflow-y-auto p-5 bg-[#0b1120] font-sans custom-scrollbar">
      
      <div className="grid grid-cols-4 gap-4 shrink-0">
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

      <div className="shrink-0">
        <MacroNewsTable />
      </div>

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
                  <div className={clsx("font-sans text-4xl font-bold tracking-tight", regime.score >= 55 ? "text-emerald-400" : regime.score <= 45 ? "text-rose-400" : "text-amber-400")}>
                    {formatNumber(regime.score, 1)}
                  </div>
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
                    <Pie 
                      data={pieData} dataKey="value" nameKey="name" 
                      innerRadius={65} outerRadius={95} 
                      stroke="#0b1120" strokeWidth={4}
                      paddingAngle={2}
                    >
                      {pieData.map((d) => (<Cell key={d.key} fill={PIE_COLORS[d.key as keyof AllocationWeights]} />))}
                    </Pie>
                    <RechartsTooltip 
                      contentStyle={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: '8px', color: '#fff', fontSize: '13px', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)' }} 
                      formatter={(value) => [`${value}%`, "Allocation"]} 
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <ul className="w-[160px] space-y-3 font-sans text-sm">
                {pieData.map((d) => (
                  <li key={d.key} className="flex items-center justify-between gap-3 p-2 rounded-lg bg-slate-800/30 border border-slate-700/50">
                    <span className="flex items-center gap-2.5 text-slate-300 font-medium text-[12px]">
                      <span className="h-3 w-3 rounded-sm shadow-sm" style={{ background: PIE_COLORS[d.key as keyof AllocationWeights] }} />
                      {d.name}
                    </span>
                    <span className="text-white font-bold">{d.value.toFixed(1)}%</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Panel>
      </div>

      <div className="grid grid-cols-[1fr_1.1fr] gap-4 pb-10 shrink-0">
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
                <div className="flex-1"><div className="h-2 bg-slate-900 rounded-full overflow-hidden shadow-inner"><div className={clsx("h-full rounded-full", s.changePct20d >= 0 ? "bg-emerald-400" : "bg-rose-400")} style={{ width: `${Math.min(100, Math.abs(s.changePct20d) * 400)}%` }} /></div></div>
                <div className={clsx("w-20 text-right font-mono text-xs font-bold", s.changePct20d >= 0 ? "text-emerald-400" : "text-rose-400")}>{formatPct(s.changePct20d)}</div>
                <div className="w-12 text-right font-mono text-[10px] text-slate-500">{s.source === "live" ? "LIVE" : "SYN"}</div>
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
    <div className="border border-slate-700/50 bg-slate-800/40 px-3 py-3 rounded-xl">
      <div className="text-[10px] tracking-widest text-slate-400 font-semibold uppercase">{label}</div>
      <div className="mt-1 text-slate-100 font-bold font-mono text-sm">{value}</div>
    </div>
  );
}