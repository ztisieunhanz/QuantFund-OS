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
    return [...map.values()].sort((a, b) => a.time - b.time).filter((_, i, arr) => i % Math.max(1, Math.floor(arr.length / 180)) === 0 || i === arr.length - 1);
  }, [trend.equityCurve, mean.equityCurve, dca.equityCurve]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-5 overflow-auto p-5 bg-[#f8fafc] font-sans custom-scrollbar">
      <div className="flex items-center justify-between border border-slate-200 bg-white shadow-sm rounded-2xl px-5 py-3 font-semibold text-[12px]">
        <div className="flex gap-8">
          <span className="text-slate-500">VỐN GIẢ LẬP <span className="text-slate-800 font-bold bg-slate-100 px-2 py-0.5 rounded">{formatUsd(STARTING_EQUITY, 0)}</span> / BOT</span>
          <span className="text-slate-500">PHÍ GIAO DỊCH <span className="text-amber-500 font-bold bg-amber-50 px-2 py-0.5 rounded border border-amber-100">{(FEE_BPS * 100).toFixed(2)}%</span></span>
          <span className="text-slate-500">TRƯỢT GIÁ <span className="text-amber-500 font-bold bg-amber-50 px-2 py-0.5 rounded border border-amber-100">{(SLIPPAGE_BPS * 100).toFixed(2)}%</span></span>
          <span className="text-slate-500">GIÁ THỊ TRƯỜNG <span className="text-sky-600 font-bold bg-sky-50 px-2 py-0.5 rounded border border-sky-100">{formatNumber(lastPrice, 2)}</span></span>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-slate-400">CHẠY LÚC {lastRunAt ? new Date(lastRunAt).toISOString().slice(11, 19) : "—"}</span>
          <button type="button" disabled={replaying} onClick={() => { setReplaying(true); reset(); setTimeout(() => { runOnBars(bars); setReplaying(false); }, 200); }} className="bg-sky-50 border border-sky-200 px-3 py-1.5 rounded-lg text-sky-600 font-bold hover:bg-sky-100 transition-all active:scale-95 disabled:opacity-50">
            {replaying ? "ĐANG CHẠY (2ms)..." : "⚡ CHẠY LẠI (REPLAY)"}
          </button>
        </div>
      </div>

      {isRiskOff && (
        <div className="flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 p-4 text-[13px] font-semibold text-rose-600 shadow-sm">
          <AlertTriangle size={20} />
          <span><strong>CẢNH BÁO VĨ MÔ ĐÃ KÍCH HOẠT:</strong> Điểm rủi ro vĩ mô {regime.score.toFixed(1)}/100. Bot A (Theo Xu Hướng) hiện bị cấm mở lệnh mua mới.</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <BotCard bot={trend} rule="MUA khi Cắt Vàng EMA 20/50 · BÁN khi Cắt Tử Thần" isBlocked={isRiskOff} />
        <BotCard bot={mean} rule="MUA khi RSI < 30 · BÁN khi RSI > 70" />
        <BotCard bot={dca} rule="GOM MUA 10% Vốn khi Giá giảm 1.5% dưới EMA50 & RSI < 35" isDca />
      </div>

      <Panel title="BIỂU ĐỒ TĂNG TRƯỞNG VỐN (EQUITY CURVES)" className="min-h-[280px]">
        <div className="h-[250px] mt-2">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={combined}>
              <CartesianGrid stroke="#f1f5f9" />
              <XAxis dataKey="time" tickFormatter={(t) => new Date(Number(t) * 1000).toISOString().slice(5, 10)} stroke="#64748b" fontSize={11} fontWeight={600} />
              <YAxis stroke="#64748b" fontSize={11} fontWeight={600} domain={["auto", "auto"]} />
              <Tooltip contentStyle={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: "12px", fontSize: 13, fontWeight: "bold", color: "#1e293b", boxShadow: "0 4px 6px -1px rgba(0,0,0,0.1)" }} labelFormatter={(t) => new Date(Number(t) * 1000).toISOString()} formatter={(v, name) => [formatUsd(Number(v)), String(name)]} />
              <Line type="monotone" dataKey="trend" name="Bot Xu Hướng" stroke="#0ea5e9" dot={false} strokeWidth={3} />
              <Line type="monotone" dataKey="mean" name="Bot Hồi Quy" stroke="#8b5cf6" dot={false} strokeWidth={3} />
              <Line type="monotone" dataKey="dca" name="Bot Tích Lũy" stroke="#f59e0b" dot={false} strokeWidth={3} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Panel>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 pb-6">
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
    <Panel title={ <div className="flex items-center gap-2 font-bold text-slate-800">{bot.name} {isBlocked && <span className="rounded-md bg-rose-100 px-2 py-0.5 text-[10px] text-rose-600 border border-rose-200">ĐÃ CHẶN</span>}</div> } right={bot.position}>
      <div className="space-y-4">
        <div className="text-[12px] text-slate-500 font-semibold bg-slate-50 px-3 py-2 rounded-lg border border-slate-100">{rule}</div>
        <div className="flex items-end justify-between bg-white border border-slate-200 p-4 rounded-2xl shadow-sm">
          <div>
            <div className="font-bold text-[10px] text-slate-400 uppercase tracking-widest">TỔNG VỐN HIỆN TẠI</div>
            <div className="font-sans font-black text-2xl text-slate-800">{formatUsd(bot.equity)}</div>
          </div>
          <div className={clsx("text-right font-sans font-bold", up ? "text-emerald-500" : "text-rose-500")}>
            <div className="text-xl">{formatUsd(bot.pnl)}</div>
            <div className="text-sm bg-slate-50 px-2 py-0.5 rounded inline-block mt-1">{formatPct(bot.pnlPct)}</div>
          </div>
        </div>
        <div className="grid grid-cols-4 gap-2 font-sans text-[12px]">
          <Kpi label={isDca ? "GIÁ VÀO TB" : "TỶ LỆ THẮNG"} value={isDca ? (bot.qty > 0 ? formatNumber((bot.equity - bot.cash)/bot.qty, 2) : "0.00") : formatPct(bot.winRate, 1)} />
          <Kpi label="SỤT GIẢM TỐI ĐA" value={formatPct(-bot.maxDrawdown, 1)} down />
          <Kpi label={isDca ? "ĐÃ KHỚP" : "SỐ LỆNH"} value={String(bot.totalTrades)} />
          <Kpi label="TIỀN MẶT" value={formatUsd(bot.cash, 0)} />
        </div>
      </div>
    </Panel>
  );
}

function Kpi({ label, value, down }: { label: string; value: string; down?: boolean }) {
  return (
    <div className="border border-slate-200 bg-white px-2.5 py-2.5 rounded-xl text-center shadow-sm">
      <div className="text-[9px] tracking-widest text-slate-400 font-bold uppercase">{label}</div>
      <div className={clsx("mt-1 font-bold", down ? "text-rose-500" : "text-slate-800")}>{value}</div>
    </div>
  );
}

function Blotter({ bot }: { bot: BotMetrics }) {
  const rows = [...bot.trades].reverse().slice(0, 12);
  return (
    <Panel title={`${bot.name} · Sổ Lệnh (Blotter)`}>
      <table className="w-full border-collapse font-sans text-[12px]">
        <thead className="bg-slate-50 border-b border-slate-200">
          <tr>
            <th className="p-2 text-left text-slate-500 font-semibold">THỜI GIAN</th>
            <th className="p-2 text-left text-slate-500 font-semibold">PHE</th>
            <th className="p-2 text-right text-slate-500 font-semibold">GIÁ</th>
            <th className="p-2 text-right text-slate-500 font-semibold">SỐ LƯỢNG</th>
            <th className="p-2 text-right text-slate-500 font-semibold">PHÍ</th>
          </tr>
        </thead>
        <tbody className="bg-white">
          {rows.map((t) => (
            <tr key={t.id} className="border-b border-slate-100 hover:bg-slate-50 transition-colors">
              <td className="p-2 text-slate-500 font-mono text-[11px]">{new Date(t.time * 1000).toISOString().slice(5, 16)}</td>
              <td className={clsx("p-2 font-bold text-[11px]", t.side === "BUY" ? "text-emerald-500" : "text-rose-500")}>{t.side}</td>
              <td className="p-2 text-right font-bold text-slate-700">{formatNumber(t.price, 2)}</td>
              <td className="p-2 text-right text-slate-600 font-medium">{t.qty.toFixed(5)}</td>
              <td className="p-2 text-right text-amber-500 font-bold">{formatUsd(t.fee, 2)}</td>
            </tr>
          ))}
          {rows.length === 0 ? (<tr><td colSpan={5} className="py-4 text-slate-400 text-center font-medium bg-slate-50/50">Chưa có lệnh nào được khớp.</td></tr>) : null}
        </tbody>
      </table>
    </Panel>
  );
}