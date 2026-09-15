// ============================================================================
// FILE: src/views/TradingLabView.tsx
// MODULE: QUANT LAB VIEW (5-LAYER ARCHITECTURE DASHBOARD)
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
import { clsx } from "@/lib/clsx";
import { FEE_BPS, SLIPPAGE_BPS, STARTING_EQUITY } from "@/lib/paperEngine";
import { formatNumber, formatPct, formatUsd } from "@/lib/math";
import { useMarketStore } from "@/stores/marketStore";
import { useTradingStore } from "@/stores/tradingStore";
import { useMacroStore } from "@/stores/macroStore";
import type { BotMetrics } from "@/types/market";

export function TradingLabView() {
  // 1. SELECTORS RIÊNG BIỆT (TRÁNH OBJECT RE-CREATION GÂY RE-RENDER VÔ TẬN)
  const bars = useMarketStore((s) => s.bars);
  const loadMarket = useMarketStore((s) => s.load);
  const lastPrice = useMarketStore((s) => s.lastPrice);

  const trend = useTradingStore((s) => s.trend);
  const mean = useTradingStore((s) => s.mean);
  const dca = useTradingStore((s) => s.dca);
  const omega = useTradingStore((s) => s.omega);
  const latestDecision = useTradingStore((s) => s.latestDecision);
  const runOnBars = useTradingStore((s) => s.runOnBars);
  const resetTrading = useTradingStore((s) => s.reset);
  const lastRunAt = useTradingStore((s) => s.lastRunAt);

  const regime = useMacroStore((s) => s.regime);
  const isRiskOff = Boolean(regime && regime.score < 45);

  const [replaying, setReplaying] = useState(false);

  // 2. KHỞI TẠO NẠP DỮ LIỆU NẾN
  useEffect(() => {
    if (bars.length === 0) {
      void loadMarket();
    }
  }, [bars.length, loadMarket]);

  // 3. TỰ ĐỘNG CHẠY BACKTEST KHI CÓ ĐỦ DỮ LIỆU
  useEffect(() => {
    if (bars.length >= 25) {
      runOnBars(bars);
    }
  }, [bars, runOnBars]);

  // 4. XỬ LÝ REPLAY THỦ CÔNG
  const handleReplay = useCallback(() => {
    if (replaying || bars.length < 25) return;
    setReplaying(true);
    resetTrading();
    setTimeout(() => {
      runOnBars(bars);
      setReplaying(false);
    }, 150);
  }, [replaying, bars, resetTrading, runOnBars]);

  // 5. KẾT HỢP ĐƯỜNG CONG VỐN (EQUITY CURVES) THEO TRỤC THỜI GIAN GIÂY
  const combinedEquitySeries = useMemo(() => {
    const timeMap = new Map<
      number,
      { time: number; trend: number; mean: number; event: number; omega: number }
    >();

    for (const p of trend.equityCurve) {
      timeMap.set(p.time, {
        time: p.time,
        trend: p.equity,
        mean: STARTING_EQUITY,
        event: STARTING_EQUITY,
        omega: STARTING_EQUITY,
      });
    }

    for (const p of mean.equityCurve) {
      const row = timeMap.get(p.time);
      if (row) {
        row.mean = p.equity;
      } else {
        timeMap.set(p.time, {
          time: p.time,
          trend: STARTING_EQUITY,
          mean: p.equity,
          event: STARTING_EQUITY,
          omega: STARTING_EQUITY,
        });
      }
    }

    for (const p of dca.equityCurve) {
      const row = timeMap.get(p.time);
      if (row) {
        row.event = p.equity;
      } else {
        timeMap.set(p.time, {
          time: p.time,
          trend: STARTING_EQUITY,
          mean: STARTING_EQUITY,
          event: p.equity,
          omega: STARTING_EQUITY,
        });
      }
    }

    for (const p of omega.equityCurve) {
      const row = timeMap.get(p.time);
      if (row) {
        row.omega = p.equity;
      }
    }

    const sorted = [...timeMap.values()].sort((a, b) => a.time - b.time);
    
    // Downsampling nhẹ nếu lịch sử quá dài để tối ưu hiệu năng Recharts
    const stepSize = Math.max(1, Math.floor(sorted.length / 200));
    return sorted.filter((_, idx, arr) => idx % stepSize === 0 || idx === arr.length - 1);
  }, [trend.equityCurve, mean.equityCurve, dca.equityCurve, omega.equityCurve]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-auto p-3 bg-[#07090d]">
      {/* 1. THANH TRẠNG THÁI HỆ THỐNG */}
      <div className="flex items-center justify-between border border-line bg-panel px-3 py-2 font-mono text-[11px] rounded-sm">
        <div className="flex flex-wrap items-center gap-6">
          <span className="text-muted">
            ARCHITECTURE <span className="text-cyan font-bold">5-LAYER MODULAR QUANT</span>
          </span>
          <span className="text-muted">
            COMMISSION <span className="text-amber">{(FEE_BPS * 100).toFixed(2)}%</span>
          </span>
          <span className="text-muted">
            SLIPPAGE <span className="text-amber">{(SLIPPAGE_BPS * 100).toFixed(2)}%</span>
          </span>
          <span className="text-muted">
            MARK (BTC) <span className="text-up font-bold">{formatNumber(lastPrice, 2)}</span>
          </span>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-muted">
            LAST SYNC {lastRunAt ? new Date(lastRunAt).toISOString().slice(11, 19) : "—"}
          </span>
          <button
            type="button"
            disabled={replaying}
            onClick={handleReplay}
            className="flex items-center gap-1.5 border border-line px-3 py-1 text-cyan hover:bg-panel-2 transition-all active:scale-95 disabled:opacity-50 font-bold"
          >
            <RotateCcw size={12} className={clsx(replaying && "animate-spin")} />
            {replaying ? "REPLAYING..." : "REPLAY 100D"}
          </button>
        </div>
      </div>

      {/* 2. OMEGA META-FUND & RISK ENGINE MONITOR */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3 border border-[#1c2736] bg-[#10151e] p-3 rounded-sm shadow-sm">
        <div className="flex flex-col justify-between border-r border-line/40 pr-3">
          <div className="flex items-center gap-1.5 text-muted text-[10px] font-bold tracking-wider">
            <Cpu size={14} className="text-cyan" /> OMEGA PORTFOLIO NAV
          </div>
          <div className="text-2xl font-mono font-bold text-white mt-1">
            {formatUsd(omega.equity)}
          </div>
          <div className={clsx("text-[11px] font-mono font-bold", omega.pnl >= 0 ? "text-up" : "text-down")}>
            PnL: {formatUsd(omega.pnl)} ({formatPct(omega.pnlPct)})
          </div>
        </div>

        <div className="flex flex-col justify-between border-r border-line/40 pr-3">
          <div className="flex items-center gap-1.5 text-muted text-[10px] font-bold tracking-wider">
            <Activity size={14} className="text-amber" /> VOLATILITY TARGETING
          </div>
          <div className="text-base font-mono font-bold text-ink mt-1">
            {latestDecision
              ? `${(latestDecision.risk.targetVolatility * 100).toFixed(1)}% / ${(latestDecision.risk.realizedVol * 100).toFixed(1)}%`
              : "12.0% / 20.0%"}
          </div>
          <div className="text-[10px] text-muted font-mono">
            Target Vol / Realized Vol
          </div>
        </div>

        <div className="flex flex-col justify-between border-r border-line/40 pr-3">
          <div className="flex items-center gap-1.5 text-muted text-[10px] font-bold tracking-wider">
            <ShieldCheck size={14} className="text-[#00e676]" /> RISK & CIRCUIT BREAKER
          </div>
          <div className="text-base font-mono font-bold mt-1">
            <span
              className={clsx(
                "px-1.5 py-0.5 rounded text-[10px] font-bold uppercase",
                latestDecision?.risk.circuitBreakerStatus === "TRIPPED"
                  ? "bg-down/20 text-down border border-down/30"
                  : "bg-up/20 text-up border border-up/30"
              )}
            >
              {latestDecision?.risk.circuitBreakerStatus ?? "NORMAL"}
            </span>
            <span className="text-muted text-[11px] ml-2 font-normal">
              Max DD: {formatPct(-omega.maxDrawdown, 1)}
            </span>
          </div>
          <div className="text-[10px] text-muted truncate font-mono">
            Exposure Cap: {latestDecision ? `${(latestDecision.risk.targetExposure * 100).toFixed(0)}%` : "100%"}
          </div>
        </div>

        <div className="flex flex-col justify-between">
          <div className="flex items-center gap-1.5 text-muted text-[10px] font-bold tracking-wider">
            <Layers size={14} className="text-[#b388ff]" /> ALLOCATION BREAKDOWN
          </div>
          <div className="text-[11px] font-mono font-bold text-white mt-1">
            BTC: {latestDecision ? `${((latestDecision.targetWeights.assetWeights["BTC"] ?? 0) * 100).toFixed(1)}%` : "0.0%"} | Cash: {latestDecision ? `${(latestDecision.targetWeights.cashWeight * 100).toFixed(1)}%` : "100.0%"}
          </div>
          <div className="text-[10px] text-cyan font-mono truncate">
            {latestDecision?.targetWeights.rationale.slice(0, 40) ?? "Awaiting allocation..."}
          </div>
        </div>
      </div>

      {/* CẢNH BÁO PERMISSION GATE KHI VĨ MÔ SUY YẾU */}
      {isRiskOff && (
        <div className="flex items-center gap-2 rounded border border-amber/50 bg-amber/10 p-2.5 text-[11px] font-medium text-amber shadow-sm">
          <AlertTriangle size={16} />
          <span>
            <strong>MACRO PERMISSION MODULATION:</strong> Chế độ vĩ mô Risk-Off (Score: {regime?.score.toFixed(1)}/100).
            Permission Gate đã chủ động giảm hệ số cấp phép mở vị thế mới để bảo toàn ngân sách rủi ro.
          </span>
        </div>
      )}

      {/* 3. THẺ THÔNG TIN 3 BOT ALPHA ĐỘC LẬP */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <BotCard
          bot={trend}
          rule="Alpha 1: Multi-Horizon Momentum · Trend Persistence & Chandelier Stop"
        />
        <BotCard
          bot={dca}
          rule="Alpha 2: Economic Surprise · Market Confirmation & Half-Life Decay"
        />
        <BotCard
          bot={mean}
          rule="Alpha 3: Short Mean Reversion · Deviation Z-Score & Volume Exhaustion"
        />
      </div>

      {/* 4. BIỂU ĐỒ ĐƯỜNG CONG VỐN (EQUITY CURVES) */}
      <Panel title="Multi-Strategy Concurrent Fleet & Omega Meta-Fund" className="min-h-[290px]">
        <div className="h-[250px]">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={combinedEquitySeries}>
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
                domain={["auto", "auto"]}
                tickFormatter={(val) => `$${Number(val).toLocaleString()}`}
              />
              <Tooltip
                contentStyle={{ background: "#0c1017", border: "1px solid #1c2736", fontSize: 12 }}
                labelFormatter={(t) => new Date(Number(t) * 1000).toISOString().slice(0, 19).replace("T", " ")}
                formatter={(v, name) => [formatUsd(Number(v)), String(name)]}
              />
              <Line type="monotone" dataKey="trend" name="Bot 1 (Trend)" stroke="#26c6da" dot={false} strokeWidth={1.5} />
              <Line type="monotone" dataKey="event" name="Bot 2 (Event)" stroke="#ffc107" dot={false} strokeWidth={1.5} />
              <Line type="monotone" dataKey="mean" name="Bot 3 (MeanRev)" stroke="#b388ff" dot={false} strokeWidth={1.5} />
              <Line type="monotone" dataKey="omega" name="Omega Meta-Fund" stroke="#00e676" dot={false} strokeWidth={2.5} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Panel>

      {/* 5. AUDIT BLOTTERS (NHẬT KÝ KHỚP LỆNH THEO TỪNG STRATEGY) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <Blotter bot={trend} />
        <Blotter bot={dca} />
        <Blotter bot={mean} />
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// PHẦN BỔ TRỢ: THẺ BOT (BOTCARD)
// ----------------------------------------------------------------------------

function BotCard({ bot, rule }: { bot: BotMetrics; rule: string }) {
  const up = bot.pnl >= 0;
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
                : "bg-panel-2 text-muted border-line"
            )}
          >
            {bot.position}
          </span>
        </div>
      }
      right={<span className="text-[10px] text-muted font-mono">{bot.trades.length} fills</span>}
    >
      <div className="space-y-3">
        <div className="text-[11px] text-muted font-mono leading-relaxed">{rule}</div>
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
          <Kpi label="MAX DD" value={formatPct(-bot.maxDrawdown, 1)} down />
          <Kpi label="TRADES" value={String(bot.totalTrades)} />
          <Kpi label="CASH" value={formatUsd(bot.cash, 0)} />
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

// ----------------------------------------------------------------------------
// PHẦN BỔ TRỢ: BẢNG SỔ LỆNH KIỂM TOÁN (BLOTTER)
// ----------------------------------------------------------------------------

function Blotter({ bot }: { bot: BotMetrics }) {
  const rows = useMemo(() => [...bot.trades].reverse().slice(0, 8), [bot.trades]);

  return (
    <Panel title={`${bot.name} · Audit Log`}>
      <table className="w-full border-collapse font-mono text-[10px]">
        <thead className="text-muted border-b border-line bg-panel-2">
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
                Awaiting quant execution...
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </Panel>
  );
}