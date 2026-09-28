// ============================================================================
// FILE: src/views/TradingLabView.tsx
// MODULE: QUANT LAB VIEW (SYNCHRONIZED WITH REAL BINANCE CANDLES)
// ============================================================================

import { useEffect, useMemo, useState, useCallback } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  AlertTriangle,
  ShieldCheck,
  Activity,
  Cpu,
  Layers,
  RotateCcw,
} from "lucide-react";
import { Panel } from "@/components/ui/Panel";
import { ActionDecisionCard } from "@/components/ActionDecisionCard";
import { clsx } from "@/lib/clsx";
import { FEE_BPS, STARTING_EQUITY } from "@/lib/paperEngine";
import { QUANT_BAR_INTERVAL } from "@/lib/quant/timeDomain";
import { formatNumber, formatPct, formatUsd } from "@/lib/math";
import { getMarketSourceLabel, useMarketStore } from "@/stores/marketStore";
import { useTradingStore } from "@/stores/tradingStore";
import { useSnapshotStore } from "@/stores/snapshotStore";
import type { BotMetrics } from "@/types/market";
import type { DecisionState } from "@/lib/quant/types";

export function deriveTradingDecisionPresentation(latestDecision: DecisionState | null) {
  if (!latestDecision) {
    return Object.freeze({
      riskAvailable: false,
      riskStatus: "UNAVAILABLE",
      riskReason: "Canonical risk state unavailable.",
      allocationSummary: "UNAVAILABLE",
      allocationRationale: "Canonical allocation unavailable.",
    });
  }

  const btcWeight = latestDecision.targetWeights.assetWeights["BTC"];
  const allocationSummary = typeof btcWeight === "number"
    ? `BTC: ${(btcWeight * 100).toFixed(1)}% | Cash: ${(latestDecision.targetWeights.cashWeight * 100).toFixed(1)}%`
    : "UNAVAILABLE";

  return Object.freeze({
    riskAvailable: true,
    riskStatus: latestDecision.risk.circuitBreakerStatus,
    riskReason: latestDecision.risk.circuitBreakerReason ?? "Canonical risk rationale unavailable.",
    allocationSummary,
    allocationRationale: allocationSummary === "UNAVAILABLE"
      ? "Canonical allocation unavailable."
      : latestDecision.targetWeights.rationale,
  });
}

function maskNonCurrentBot(bot: BotMetrics, status: string): BotMetrics {
  return {
    ...bot,
    cash: null,
    qty: null,
    lastPrice: null,
    equity: null,
    pnl: null,
    pnlPct: null,
    winRate: null,
    maxDrawdown: null,
    totalTrades: null,
    closedTradeCount: null,
    roundTripCount: null,
    wins: null,
    losses: null,
    breakEven: null,
    position: "FLAT",
    lastSignal: `${status} · NOT CURRENT`,
    trades: [],
    equityCurve: [],
    status: "UNAVAILABLE",
  };
}

export function TradingLabView() {
  const bars = useMarketStore((s) => s.bars);
  const loadMarket = useMarketStore((s) => s.load);
  const lastPrice = useMarketStore((s) => s.lastPrice);
  const source = useMarketStore((s) => s.source);
  const interval = useMarketStore((s) => s.interval);
  const refreshedAt = useMarketStore((s) => s.refreshedAt);

  const trend = useTradingStore((s) => s.trend);
  const event = useTradingStore((s) => s.event);
  const mean = useTradingStore((s) => s.mean);
  const omega = useTradingStore((s) => s.omega);
  const benchmarkDca = useTradingStore((s) => s.benchmarkDca);
  const latestDecision = useTradingStore((s) => s.latestDecision);
  const actionDecision = useTradingStore((s) => s.actionDecision);
  const runOnBars = useTradingStore((s) => s.runOnBars);
  const resetTrading = useTradingStore((s) => s.reset);
  const lastRunAt = useTradingStore((s) => s.lastRunAt);
  const operationalState = useTradingStore((s) => s.operationalState);
  const isCurrent = operationalState.status === "FRESH_CURRENT";
  const visibleTrend = isCurrent ? trend : maskNonCurrentBot(trend, operationalState.status);
  const visibleEvent = isCurrent ? event : maskNonCurrentBot(event, operationalState.status);
  const visibleMean = isCurrent ? mean : maskNonCurrentBot(mean, operationalState.status);
  const visibleOmega = isCurrent ? omega : maskNonCurrentBot(omega, operationalState.status);
  const visibleBenchmarkDca = isCurrent ? benchmarkDca : maskNonCurrentBot(benchmarkDca, operationalState.status);
  const visibleDecision = isCurrent ? latestDecision : null;

  const snapshot = useSnapshotStore((s) => s.snapshot);
  const macroRegime = snapshot?.macro?.regime ?? null;
  const macroStatus = snapshot?.macro?.status ?? "INSUFFICIENT_DATA";
  const isRiskOffV2 = macroRegime === "RISK_OFF" || macroRegime === "LIQUIDITY_STRESS";

  const [replaying, setReplaying] = useState(false);

  useEffect(() => {
    if (bars.length === 0) void loadMarket();
  }, [bars.length, loadMarket]);

  useEffect(() => {
    // BLOCKER 1: pass QuantReplayMarketContext explicitly — interval + source together.
    // Trigger runOnBars if interval !== QUANT_BAR_INTERVAL (to trigger store reset guard even if bars < 130)
    // or when bars.length >= 130 for 1H replay.
    if (source !== null && (interval !== QUANT_BAR_INTERVAL || bars.length >= 130)) {
      runOnBars(bars, { interval, source, observationTime: refreshedAt ?? undefined });
    }
  }, [bars, runOnBars, interval, source, refreshedAt]);

  const handleReplay = useCallback(() => {
    if (replaying || bars.length < 130 || source === null) return;
    setReplaying(true);
    resetTrading();
    setTimeout(() => {
      const currentMarket = useMarketStore.getState();
      if (currentMarket.source !== null) {
        runOnBars(currentMarket.bars, {
          interval: currentMarket.interval,
          source: currentMarket.source,
          observationTime: currentMarket.refreshedAt ?? undefined,
        });
      }
      setReplaying(false);
    }, 120);
  }, [replaying, bars, interval, source, resetTrading, runOnBars]);

  const combinedEquitySeries = useMemo(() => {
    const timeMap = new Map<
      number,
      { time: number; trend: number; mean: number; event: number; omega: number; benchmark: number }
    >();

    for (const p of visibleTrend.equityCurve) {
      timeMap.set(p.time, {
        time: p.time,
        trend: p.equity,
        mean: STARTING_EQUITY,
        event: STARTING_EQUITY,
        omega: STARTING_EQUITY,
        benchmark: STARTING_EQUITY,
      });
    }

    for (const p of visibleMean.equityCurve) {
      const row = timeMap.get(p.time);
      if (row) row.mean = p.equity;
      else timeMap.set(p.time, { time: p.time, trend: STARTING_EQUITY, mean: p.equity, event: STARTING_EQUITY, omega: STARTING_EQUITY, benchmark: STARTING_EQUITY });
    }

    for (const p of visibleEvent.equityCurve) {
      const row = timeMap.get(p.time);
      if (row) row.event = p.equity;
      else timeMap.set(p.time, { time: p.time, trend: STARTING_EQUITY, mean: STARTING_EQUITY, event: p.equity, omega: STARTING_EQUITY, benchmark: STARTING_EQUITY });
    }

    for (const p of visibleOmega.equityCurve) {
      const row = timeMap.get(p.time);
      if (row) row.omega = p.equity;
    }

    for (const p of visibleBenchmarkDca.equityCurve) {
      const row = timeMap.get(p.time);
      if (row) row.benchmark = p.equity;
    }

    const sorted = [...timeMap.values()].sort((a, b) => a.time - b.time);
    const stepSize = Math.max(1, Math.floor(sorted.length / 150));
    return sorted.filter((_, idx, arr) => idx % stepSize === 0 || idx === arr.length - 1);
  }, [visibleTrend.equityCurve, visibleMean.equityCurve, visibleEvent.equityCurve, visibleOmega.equityCurve, visibleBenchmarkDca.equityCurve]);

  const decisionPresentation = deriveTradingDecisionPresentation(visibleDecision);
  const cbStatus = decisionPresentation.riskStatus;
  const cbReason = decisionPresentation.riskReason;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col gap-3 overflow-y-auto bg-[#07090d] p-3">
      <ActionDecisionCard decision={actionDecision} operationalState={operationalState} />

      {/* 1. THANH TELEMETRY HUD CHUẨN ĐỒNG BỘ */}
      <div className="flex flex-wrap items-center justify-between border border-line bg-panel px-3 py-2 font-mono text-[11px] rounded-sm gap-2">
        <div className="flex flex-wrap items-center gap-4 sm:gap-6">
          <span className="text-muted">
            ARCHITECTURE <span className="text-cyan font-bold">5-LAYER MODULAR QUANT</span>
          </span>
          <span className="text-muted">
            WARMUP <span className="text-white font-bold">125 BARS</span>
          </span>
          <span className="text-muted">
            FEE <span className="text-amber">{(FEE_BPS * 100).toFixed(2)}%</span>
          </span>
          <span className="text-muted">
            MARK (BTC){" "}
            <span className="text-up font-bold">
              {lastPrice > 0 ? formatNumber(lastPrice, 2) : "SYNCING..."}
            </span>
          </span>
          <span
            className={clsx(
              "px-1.5 py-0.2 rounded text-[9px] font-bold border uppercase",
              source === "live"
                ? "bg-up/15 text-up border-up/30"
                : source === "synthetic"
                  ? "bg-amber/15 text-amber border-amber/30"
                  : "bg-down/15 text-down border-down/30"
            )}
          >
            {getMarketSourceLabel(source)}
          </span>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-muted">
            SYNC: {lastRunAt ? new Date(lastRunAt).toISOString().slice(11, 19) : "—"} UTC
          </span>
          <span className={clsx(
            "font-bold",
            operationalState.status === "FRESH_CURRENT" ? "text-up" : "text-amber",
          )}>
            STATE: {operationalState.status}
          </span>
          <button
            type="button"
            disabled={replaying || bars.length < 130}
            onClick={handleReplay}
            className="flex items-center gap-1.5 border border-line px-3 py-1 text-cyan hover:bg-panel-2 transition-all active:scale-95 disabled:opacity-50 font-bold"
          >
            <RotateCcw size={12} className={clsx(replaying && "animate-spin")} />
            {replaying ? "REPLAYING..." : "REPLAY DETERMINISTIC"}
          </button>
        </div>
      </div>

      {/* 2. OMEGA META-FUND & HYSTERESIS RISK MONITOR */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 border border-[#1c2736] bg-[#10151e] p-3 rounded-sm shadow-sm w-full">
        <div className="flex flex-col justify-between border-b sm:border-b-0 sm:border-r border-line/40 pb-2 sm:pb-0 sm:pr-3">
          <div className="flex items-center gap-1.5 text-muted text-[10px] font-bold tracking-wider">
            <Cpu size={14} className="text-cyan" /> OMEGA PORTFOLIO NAV
          </div>
          <div className="text-2xl font-mono font-bold text-white mt-1">
            {formatUsd(visibleOmega.equity)}
          </div>
          <div className={clsx("text-[11px] font-mono font-bold", visibleOmega.pnl != null && visibleOmega.pnl >= 0 ? "text-up" : visibleOmega.pnl != null ? "text-down" : "text-muted")}>
            PnL: {formatUsd(visibleOmega.pnl)} ({formatPct(visibleOmega.pnlPct)})
          </div>
        </div>

        <div className="flex flex-col justify-between border-b sm:border-b-0 lg:border-r border-line/40 pb-2 sm:pb-0 sm:pr-3">
          <div className="flex items-center gap-1.5 text-muted text-[10px] font-bold tracking-wider">
            <Activity size={14} className="text-amber" /> VOLATILITY TARGETING
          </div>
          <div className="text-base font-mono font-bold text-ink mt-1">
            {visibleDecision
              ? `${(visibleDecision.risk.targetVolatility * 100).toFixed(1)}% / ${(visibleDecision.risk.realizedVol * 100).toFixed(1)}%`
              : "UNAVAILABLE"}
          </div>
          <div className="text-[10px] text-muted font-mono">
            Target Vol / Realized (VolFloor: 5.0%)
          </div>
        </div>

        <div className="flex flex-col justify-between border-b sm:border-b-0 sm:border-r border-line/40 pb-2 sm:pb-0 sm:pr-3">
          <div className="flex items-center gap-1.5 text-muted text-[10px] font-bold tracking-wider">
            <ShieldCheck size={14} className={decisionPresentation.riskAvailable ? "text-[#00e676]" : "text-muted"} /> HYSTERESIS RISK STATUS
          </div>
          <div className="text-base font-mono font-bold mt-1">
            <span
              className={clsx(
                "px-1.5 py-0.5 rounded text-[10px] font-bold uppercase",
                cbStatus === "TRIPPED"
                  ? "bg-down/20 text-down border border-down/30"
                  : cbStatus === "WARNING"
                  ? "bg-amber/20 text-amber border border-amber/30"
                  : cbStatus === "NORMAL"
                  ? "bg-up/20 text-up border border-up/30"
                  : "bg-panel-2 text-muted border border-line"
              )}
            >
              {cbStatus}
            </span>
            <span className="text-muted text-[11px] ml-2 font-normal">
              Max DD: {visibleDecision && visibleOmega.maxDrawdown != null ? formatPct(-visibleOmega.maxDrawdown, 1) : "N/A"}
            </span>
          </div>
          <div className="break-words font-mono text-[10px] text-muted" title={cbReason}>
            {cbReason}
          </div>
        </div>

        <div className="flex flex-col justify-between">
          <div className="flex items-center gap-1.5 text-muted text-[10px] font-bold tracking-wider">
            <Layers size={14} className="text-[#b388ff]" /> ALLOCATION BREAKDOWN
          </div>
          <div className="text-[11px] font-mono font-bold text-white mt-1">
            {decisionPresentation.allocationSummary}
          </div>
          <div className="break-words font-mono text-[10px] text-cyan" title={decisionPresentation.allocationRationale}>
            {decisionPresentation.allocationRationale.slice(0, 42)}
          </div>
        </div>
      </div>

      {macroStatus === "AVAILABLE" && macroRegime ? (
        <div
          className={clsx(
            "flex items-center gap-2 rounded border p-2.5 text-[11px] font-medium shadow-sm",
            isRiskOffV2
              ? "border-amber/50 bg-amber/10 text-amber"
              : "border-cyan/40 bg-cyan/10 text-cyan"
          )}
        >
          <AlertTriangle size={16} />
          <span>
            <strong>MACRO CONTEXT (V2):</strong> Môi trường vĩ mô: <strong>{macroRegime}</strong>. Hệ thống đang giám sát dữ liệu Layer 2 từ CurrentMarketSnapshot.
          </span>
        </div>
      ) : (
        <div className="flex items-center gap-2 rounded border border-line/40 bg-panel-2 p-2.5 text-[11px] font-medium text-muted shadow-sm">
          <AlertTriangle size={16} />
          <span>
            <strong>MACRO CONTEXT (V2):</strong> Dữ liệu vĩ mô chưa sẵn sàng (Status: {macroStatus}). Mở màn hình Macro V2 để cập nhật snapshot.
          </span>
        </div>
      )}

      {/* 3. 3 ALPHA ENGINE & 1 CONTROL BENCHMARK */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 w-full">
        <BotCard bot={visibleTrend} rule="Alpha 1: Multi-Horizon Momentum · Persistence & Chandelier Stop" />
        <BotCard bot={visibleEvent} rule="Alpha 2: Economic Catalyst · Surprise Reaction & Exponential Decay" />
        <BotCard bot={visibleMean} rule="Alpha 3: Short Mean Reversion · Deviation Z-Score & Trend Filter" />
        <BotCard bot={visibleBenchmarkDca} rule="Control: Passive Accumulate 5% Cash every 7 bars (Non-Alpha Benchmark)" isBenchmark />
      </div>

      {/* 4. ĐƯỜNG CONG VỐN ĐỐI CHUẨN (EQUITY CURVES) */}
      <div className="border border-line bg-panel p-3 rounded-sm w-full">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="text-[11px] font-mono font-bold text-muted uppercase tracking-wider">
            Multi-Strategy Concurrent Fleet vs. Control Benchmark (Post-Warmup 125 Bars)
          </div>
          <div className="flex flex-wrap items-center gap-3 font-mono text-[10px] sm:gap-4">
            <span className="flex items-center gap-1 text-[#00e676] font-bold"><span className="w-2.5 h-0.5 bg-[#00e676]"></span> Omega Fund</span>
            <span className="flex items-center gap-1 text-[#26c6da]"><span className="w-2.5 h-0.5 bg-[#26c6da]"></span> Alpha 1 (Trend)</span>
            <span className="flex items-center gap-1 text-[#ffc107]"><span className="w-2.5 h-0.5 bg-[#ffc107]"></span> Alpha 2 (Event)</span>
            <span className="flex items-center gap-1 text-[#b388ff]"><span className="w-2.5 h-0.5 bg-[#b388ff]"></span> Alpha 3 (MeanRev)</span>
            <span className="flex items-center gap-1 text-[#78909c]"><span className="w-2.5 h-0.5 bg-[#78909c] stroke-dasharray"></span> Control DCA</span>
          </div>
        </div>

        <div className="h-[240px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={combinedEquitySeries} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
              <CartesianGrid stroke="#151b26" strokeDasharray="3 3" />
              <XAxis
                dataKey="time"
                tickFormatter={(t) => new Date(Number(t) * 1000).toISOString().slice(5, 10)}
                stroke="#7d8ea3"
                fontSize={10}
              />
              <YAxis
                stroke="#7d8ea3"
                fontSize={10}
                domain={["dataMin - 100", "dataMax + 100"]}
                tickFormatter={(val) => `$${Number(val).toLocaleString()}`}
              />
              <Tooltip
                contentStyle={{ background: "#0c1017", border: "1px solid #1c2736", fontSize: 12 }}
                labelFormatter={(t) => new Date(Number(t) * 1000).toISOString().slice(0, 19).replace("T", " ")}
                formatter={(v, name) => [formatUsd(Number(v)), String(name)]}
              />
              <Line type="monotone" dataKey="trend" name="Alpha 1 (Trend)" stroke="#26c6da" dot={false} strokeWidth={1.5} />
              <Line type="monotone" dataKey="event" name="Alpha 2 (Event)" stroke="#ffc107" dot={false} strokeWidth={1.5} />
              <Line type="monotone" dataKey="mean" name="Alpha 3 (MeanRev)" stroke="#b388ff" dot={false} strokeWidth={1.5} />
              <Line type="monotone" dataKey="benchmark" name="Control DCA" stroke="#78909c" dot={false} strokeWidth={1.5} strokeDasharray="3 3" />
              <Line type="monotone" dataKey="omega" name="Omega Fund" stroke="#00e676" dot={false} strokeWidth={2.5} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* 5. AUDIT BLOTTERS */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 w-full pb-4">
        <Blotter bot={visibleTrend} />
        <Blotter bot={visibleEvent} />
        <Blotter bot={visibleMean} />
      </div>
    </div>
  );
}

function BotCard({ bot, rule, isBenchmark }: { bot: BotMetrics; rule: string; isBenchmark?: boolean }) {
  const up = bot.pnl != null ? bot.pnl >= 0 : true;
  return (
    <Panel
      title={
        <div className="flex items-center gap-2">
          {bot.name}
          <span
            className={clsx(
              "rounded px-1.5 py-0.2 text-[9px] font-bold border uppercase",
              bot.position === "LONG"
                ? "bg-up/20 text-up border-up/30"
                : isBenchmark
                ? "bg-panel-2 text-ink border-line"
                : "bg-panel-2 text-muted border-line"
            )}
          >
            {bot.position}
          </span>
        </div>
      }
      right={<span className="text-[10px] text-muted font-mono">{bot.totalTrades != null ? `${bot.totalTrades} fills` : "N/A"}</span>}
    >
      <div className="space-y-3">
        <div className="text-[11px] text-muted font-mono leading-relaxed min-h-[32px]">{rule}</div>
        <div className="flex items-end justify-between">
          <div>
            <div className="font-mono text-[10px] text-muted">EQUITY</div>
            <div className="font-mono text-2xl font-bold text-white">{formatUsd(bot.equity)}</div>
          </div>
          <div className={clsx("text-right font-mono font-bold", up ? "text-up" : "text-down")}>
            <div className="text-lg">{formatUsd(bot.pnl)}</div>
            <div className="text-sm">{formatPct(bot.pnlPct)}</div>
          </div>
        </div>
        <div className="grid grid-cols-4 gap-2 font-mono text-[11px]">
          <Kpi label="WIN RATE" value={formatPct(bot.winRate, 1)} />
          <Kpi label="MAX DD" value={bot.maxDrawdown != null ? formatPct(-bot.maxDrawdown, 1) : "N/A"} down={Boolean(bot.maxDrawdown && bot.maxDrawdown > 0)} />
          <Kpi label="ROUND TRIPS" value={bot.roundTripCount != null ? String(bot.roundTripCount) : "N/A"} />
          <Kpi label="FILLS" value={bot.totalTrades != null ? String(bot.totalTrades) : "N/A"} />
        </div>
        <div className="text-[10px] text-muted font-mono truncate border-t border-line/40 pt-1.5">
          Signal: <strong className="text-white">{bot.lastSignal}</strong>
        </div>
      </div>
    </Panel>
  );
}

function Kpi({ label, value, down }: { label: string; value: string; down?: boolean }) {
  return (
    <div className="border border-line bg-panel-2 px-2 py-1.5 rounded-xs">
      <div className="text-[9px] tracking-[0.12em] text-muted font-bold">{label}</div>
      <div className={clsx("mt-0.5 font-bold", down ? "text-down" : "text-ink")}>{value}</div>
    </div>
  );
}

function Blotter({ bot }: { bot: BotMetrics }) {
  const rows = useMemo(() => [...bot.trades].reverse().slice(0, 10), [bot.trades]);

  return (
    <Panel title={`${bot.name} · Audit Log`}>
      <div className="max-h-[190px] overflow-auto">
        <table className="w-full min-w-[360px] border-collapse font-mono text-[10px]">
          <thead className="text-muted border-b border-line bg-panel-2 sticky top-0">
            <tr>
              <th className="py-1 px-1.5 text-left">TIME</th>
              <th className="py-1 px-1 text-center">SIDE</th>
              <th className="py-1 px-1 text-right">PX</th>
              <th className="py-1 px-1 text-right">QTY</th>
              <th className="py-1 px-1 text-right">FEE</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((t) => (
              <tr key={t.id} className="hover:bg-panel-2 transition-colors">
                <td className="py-1 px-1.5 text-muted">
                  {new Date(t.time * 1000).toISOString().slice(5, 16).replace("T", " ")}
                </td>
                <td
                  className={clsx(
                    "py-1 px-1 text-center font-bold",
                    t.side === "BUY" ? "text-up" : "text-down"
                  )}
                >
                  {t.side}
                </td>
                <td className="py-1 px-1 text-right text-white">{formatNumber(t.price, 2)}</td>
                <td className="py-1 px-1 text-right text-muted">{t.qty.toFixed(4)}</td>
                <td className="py-1 px-1 text-right text-amber">{formatUsd(t.fee, 2)}</td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-3 text-muted text-center">
                  Awaiting execution...
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
