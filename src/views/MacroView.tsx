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
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-4 bg-[#07090d] custom-scrollbar">
      
      {/* 1. THÔNG SỐ TICKERS (Metric Cards) */}
      <div className="grid grid-cols-4 gap-3 shrink-0">
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

      {/* 2. BẢNG TIN TỨC VĨ MÔ & LỊCH SỰ KIỆN */}
      <div className="shrink-0">
        <MacroNewsTable />
      </div>

      {/* 3. DỮ LIỆU VĨ MÔ GỐC & PHÂN BỔ DANH MỤC */}
      <div className="grid min-h-[280px] grid-cols-[1.2fr_1fr] gap-3 shrink-0">
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
              <div className="h-2 w-full bg-[#151b26] rounded-full overflow-hidden">
                <div className="h-2 bg-gradient-to-r from-down via-amber to-up" style={{ width: `${regime.score}%` }} />
              </div>
              <p className="text-sm leading-relaxed text-[#d7e2ee]/90">{regime.thesis}</p>
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
            <div className="flex h-full items-center gap-4">
              <div className="h-[220px] flex-1">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={pieData} dataKey="value" nameKey="name" innerRadius={55} outerRadius={85} stroke="#07090d" strokeWidth={3}>
                      {pieData.map((d) => (<Cell key={d.key} fill={PIE_COLORS[d.key as keyof AllocationWeights]} />))}
                    </Pie>
                    <RechartsTooltip contentStyle={{ background: "#0c1017", border: "1px solid #1c2736", fontSize: 12, borderRadius: '8px' }} formatter={(value) => [`${value}%`, "Weight"]} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <ul className="w-[150px] space-y-3 font-mono text-[11px]">
                {pieData.map((d) => (
                  <li key={d.key} className="flex items-center justify-between gap-2 border-b border-[#1c2736] pb-2 last:border-0">
                    <span className="flex items-center gap-2 text-muted">
                      <span className="h-2.5 w-2.5 rounded-full" style={{ background: PIE_COLORS[d.key as keyof AllocationWeights] }} />{d.name}
                    </span>
                    <span className="text-[#d7e2ee] font-bold">{d.value.toFixed(1)}%</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Panel>
      </div>

      {/* 4. CHỈ SỐ CORRELATION & BIỂU ĐỒ HIỆU SUẤT */}
      <div className="grid grid-cols-[1fr_1.1fr] gap-3 pb-8 shrink-0">
        <Panel title="30-Day Return Correlation">
          {corr ? (
            <table className="w-full border-collapse font-mono text-[11px]">
              <thead><tr><th className="p-1 text-left text-muted" />{ASSET_ORDER.map((k) => (<th key={k} className="p-1 text-center text-muted">{ASSET_LABEL[k]}</th>))}</tr></thead>
              <tbody>
                {ASSET_ORDER.map((row) => (
                  <tr key={row}>
                    <td className="p-1 text-muted">{ASSET_LABEL[row]}</td>
                    {ASSET_ORDER.map((col) => (<td key={col} className="p-1"><div className={clsx("px-1.5 py-1.5 rounded text-center font-semibold", corrColor(corr[row][col]))}>{corr[row][col].toFixed(2)}</div></td>))}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (<div className="text-sm text-muted">Awaiting series…</div>)}
        </Panel>

        <Panel title="20-Day Performance Tape">
          <div className="space-y-2.5">
            {series.map((s) => (
              <div key={s.id} className="flex items-center gap-3 border border-[#1c2736] bg-[#121824] px-3 py-2 rounded-lg">
                <div className="w-24 font-mono text-[11px] font-bold text-[#26c6da]">{s.ticker}</div>
                <div className="flex-1"><div className="h-1.5 bg-[#151b26] rounded-full overflow-hidden"><div className={clsx("h-1.5 rounded-full", s.changePct20d >= 0 ? "bg-up" : "bg-down")} style={{ width: `${Math.min(100, Math.abs(s.changePct20d) * 400)}%` }} /></div></div>
                <div className={clsx("w-20 text-right font-mono text-[11px] font-bold", s.changePct20d >= 0 ? "text-up" : "text-down")}>{formatPct(s.changePct20d)}</div>
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
    <div className="border border-[#1c2736] bg-[#121824] px-3 py-2.5 rounded-lg">
      <div className="text-[10px] tracking-[0.14em] text-muted font-semibold">{label}</div>
      <div className="mt-1.5 text-[#d7e2ee] font-bold">{value}</div>
    </div>
  );
}