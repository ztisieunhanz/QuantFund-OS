import { useEffect, useMemo, useState } from "react";

import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { AlertTriangle } from "lucide-react";

import { Panel } from "@/components/ui/Panel";

import { clsx } from "@/lib/clsx";

import { FEE_BPS, SLIPPAGE_BPS, STARTING_EQUITY } from "@/lib/paperEngine";

import { formatNumber, formatPct, formatUsd } from "@/lib/math";

import { useMarketStore } from "@/stores/marketStore";

import { useTradingStore } from "@/stores/tradingStore";

import { useMacroStore } from "@/stores/macroStore";

import type { BotMetrics } from "@/types/market";



export function TradingLabView() {

  const bars = useMarketStore((s) => s.bars);

  const load = useMarketStore((s) => s.load);

  const lastPrice = useMarketStore((s) => s.lastPrice);

  

  const { trend, mean, dca, runOnBars, reset, lastRunAt } = useTradingStore();

  const regime = useMacroStore((s) => s.regime);

  const isRiskOff = regime && regime.score < 45;

  const [replaying, setReplaying] = useState(false);



  useEffect(() => { if (bars.length === 0) void load(); }, [bars.length, load]);

  useEffect(() => { if (bars.length >= 55) runOnBars(bars); }, [bars, runOnBars]);



  const combined = useMemo(() => {

    const map = new Map<number, { time: number; trend: number; mean: number; dca: number }>();

    for (const p of trend.equityCurve) map.set(p.time, { time: p.time, trend: p.equity, mean: STARTING_EQUITY, dca: STARTING_EQUITY });

    for (const p of mean.equityCurve) {

      const row = map.get(p.time);

      if (row) row.mean = p.equity; else map.set(p.time, { time: p.time, trend: STARTING_EQUITY, mean: p.equity, dca: STARTING_EQUITY });

    }

    for (const p of dca.equityCurve) {

      const row = map.get(p.time);

      if (row) row.dca = p.equity; else map.set(p.time, { time: p.time, trend: STARTING_EQUITY, mean: STARTING_EQUITY, dca: p.equity });

    }

    return [...map.values()]

      .sort((a, b) => a.time - b.time)

      .filter((_, i, arr) => i % Math.max(1, Math.floor(arr.length / 180)) === 0 || i === arr.length - 1);

  }, [trend.equityCurve, mean.equityCurve, dca.equityCurve]);



  return (

    <div className="flex h-full min-h-0 flex-col gap-3 overflow-auto p-3">

      <div className="flex items-center justify-between border border-line bg-panel px-3 py-2 font-mono text-[11px]">

        <div className="flex gap-6">

          <span className="text-muted">VIRTUAL NAV <span className="text-ink">{formatUsd(STARTING_EQUITY, 0)}</span> / BOT</span>

          <span className="text-muted">FEE <span className="text-amber">{(FEE_BPS * 100).toFixed(2)}%</span></span>

          <span className="text-muted">SLIPPAGE <span className="text-amber">{(SLIPPAGE_BPS * 100).toFixed(2)}%</span></span>

          <span className="text-muted">MARK <span className="text-up">{formatNumber(lastPrice, 2)}</span></span>

        </div>

        <div className="flex items-center gap-3">

          <span className="text-muted">LAST RUN {lastRunAt ? new Date(lastRunAt).toISOString().slice(11, 19) : "—"}</span>

          <button

            type="button"

            disabled={replaying}

            onClick={() => {

              setReplaying(true); reset();

              setTimeout(() => { runOnBars(bars); setReplaying(false); }, 200);

            }}

            className="border border-line px-2.5 py-1 text-cyan hover:bg-panel-2 transition-all active:scale-95 disabled:opacity-50"

          >

            {replaying ? "RUNNING (2ms)..." : "⚡ REPLAY"}

          </button>

        </div>

      </div>



      {isRiskOff && (

        <div className="flex items-center gap-2 rounded border border-amber/50 bg-amber/10 p-2.5 text-[11px] font-medium text-amber shadow-sm">

          <AlertTriangle size={16} />

          <span><strong>MACRO CIRCUIT BREAKER ĐÃ KÍCH HOẠT:</strong> Điểm rủi ro vĩ mô {regime.score.toFixed(1)}/100. Bot A (Trend Follower) hiện bị cấm mở lệnh mua.</span>

        </div>

      )}



      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">

        <BotCard bot={trend} rule="BUY on EMA 20/50 Golden Cross · SELL on Death Cross" isBlocked={isRiskOff} />

        <BotCard bot={mean} rule="BUY when RSI < 30 · SELL when RSI > 70" />

        <BotCard bot={dca} rule="DCA 10% Cash when Price drops 1.5% below EMA50 & RSI < 35" isDca />

      </div>



      <Panel title="Equity Curves · Concurrent Fleet" className="min-h-[260px]">

        <div className="h-[240px]">

          <ResponsiveContainer width="100%" height="100%">

            <LineChart data={combined}>

              <CartesianGrid stroke="#151b26" />

              <XAxis dataKey="time" tickFormatter={(t) => new Date(Number(t) * 1000).toISOString().slice(5, 10)} stroke="#7d8ea3" fontSize={10} />

              <YAxis stroke="#7d8ea3" fontSize={10} domain={["auto", "auto"]} />

              <Tooltip contentStyle={{ background: "#0c1017", border: "1px solid #1c2736", fontSize: 12 }} labelFormatter={(t) => new Date(Number(t) * 1000).toISOString()} formatter={(v, name) => [formatUsd(Number(v)), String(name)]} />

              <Line type="monotone" dataKey="trend" name="Trend" stroke="#26c6da" dot={false} strokeWidth={2} />

              <Line type="monotone" dataKey="mean" name="MeanRev" stroke="#b388ff" dot={false} strokeWidth={2} />

              <Line type="monotone" dataKey="dca" name="Accumulator" stroke="#ffc107" dot={false} strokeWidth={2} />

            </LineChart>

          </ResponsiveContainer>

        </div>

      </Panel>



      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">

        <Blotter bot={trend} />

        <Blotter bot={mean} />

        <Blotter bot={dca} />

      </div>

    </div>

  );

}



function BotCard({ bot, rule, isBlocked, isDca }: { bot: BotMetrics; rule: string; isBlocked?: boolean; isDca?: boolean }) {

  const up = bot.pnl >= 0;

  return (

    <Panel 

      title={

        <div className="flex items-center gap-2">

          {bot.name}

          {isBlocked && <span className="rounded bg-amber/20 px-1.5 py-0.5 text-[9px] text-amber border border-amber/30">BLOCKED</span>}

        </div>

      } 

      right={bot.position}

    >

      <div className="space-y-3">

        <div className="text-[11px] text-muted">{rule}</div>

        <div className="flex items-end justify-between">

          <div>

            <div className="font-mono text-[10px] text-muted">EQUITY</div>

            <div className="font-mono text-2xl">{formatUsd(bot.equity)}</div>

          </div>

          <div className={clsx("text-right font-mono", up ? "text-up" : "text-down")}>

            <div className="text-lg">{formatUsd(bot.pnl)}</div>

            <div className="text-sm">{formatPct(bot.pnlPct)}</div>

          </div>

        </div>

        <div className="grid grid-cols-4 gap-2 font-mono text-[11px]">

          <Kpi label={isDca ? "AVG ENTRY" : "WIN RATE"} value={isDca ? (bot.qty > 0 ? formatNumber((bot.equity - bot.cash)/bot.qty, 2) : "0.00") : formatPct(bot.winRate, 1)} />

          <Kpi label="MAX DD" value={formatPct(-bot.maxDrawdown, 1)} down />

          <Kpi label={isDca ? "FILLED" : "TRADES"} value={String(bot.totalTrades)} />

          <Kpi label="REMAINING" value={formatUsd(bot.cash, 0)} />

        </div>

      </div>

    </Panel>

  );

}



function Kpi({ label, value, down }: { label: string; value: string; down?: boolean }) {

  return (

    <div className="border border-line bg-panel-2 px-2 py-2">

      <div className="text-[10px] tracking-[0.12em] text-muted">{label}</div>

      <div className={clsx("mt-1", down ? "text-down" : "text-ink")}>{value}</div>

    </div>

  );

}



function Blotter({ bot }: { bot: BotMetrics }) {

  const rows = [...bot.trades].reverse().slice(0, 12);

  return (

    <Panel title={`${bot.name} · Blotter`}>

      <table className="w-full border-collapse font-mono text-[10px]">

        <thead className="text-muted">

          <tr>

            <th className="pb-1 text-left">TIME</th>

            <th className="pb-1 text-left">SIDE</th>

            <th className="pb-1 text-right">PX</th>

            <th className="pb-1 text-right">QTY</th>

            <th className="pb-1 text-right">FEE</th>

          </tr>

        </thead>

        <tbody>

          {rows.map((t) => (

            <tr key={t.id} className="border-t border-line">

              <td className="py-1 text-muted">{new Date(t.time * 1000).toISOString().slice(5, 16)}</td>

              <td className={t.side === "BUY" ? "text-up" : "text-down"}>{t.side}</td>

              <td className="text-right">{formatNumber(t.price, 2)}</td>

              <td className="text-right">{t.qty.toFixed(5)}</td>

              <td className="text-right text-amber">{formatUsd(t.fee, 2)}</td>

            </tr>

          ))}

          {rows.length === 0 ? (<tr><td colSpan={5} className="py-3 text-muted text-center">No fills yet.</td></tr>) : null}

        </tbody>

      </table>

    </Panel>

  );

}