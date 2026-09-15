// ============================================================================
// FILE: src/components/MacroNewsTable.tsx
// MODULE: QUANT MACRO SIGNAL AUDIT TABLE
// ============================================================================

import React, { useMemo } from 'react';
import { ShieldAlert, ShieldCheck, Activity, Terminal } from 'lucide-react';
import { clsx } from "@/lib/clsx";
import { useMacroStore } from "@/stores/macroStore";

export interface SignalAuditItem {
  id: string;
  metric: string;
  observedValue: string;
  thresholdState: string;
  severity: 'CRITICAL' | 'WARNING' | 'STABLE';
  regimeImplication: string;
  dataSource: string;
}

export const MacroNewsTable: React.FC = () => {
  const { series, regime, refreshedAt } = useMacroStore();

  const auditRecords = useMemo<SignalAuditItem[]>(() => {
    const records: SignalAuditItem[] = [];

    const yld10 = series.find((s) => s.id === "us10y");
    const yld2 = series.find((s) => s.id === "us2y");
    const vix = series.find((s) => s.id === "vix");
    const dxy = series.find((s) => s.id === "dxy");
    const btc = series.find((s) => s.id === "btc");

    // 1. Kiểm toán Đường cong Lợi suất US10Y - US2Y
    if (yld10 && yld2 && Number.isFinite(yld10.last) && Number.isFinite(yld2.last)) {
      const spreadBps = Math.round((yld10.last - yld2.last) * 100);
      const isInverted = spreadBps < 0;
      records.push({
        id: "audit-yield-spread",
        metric: "Yield Spread (10Y - 2Y)",
        observedValue: `${spreadBps} bps`,
        thresholdState: isInverted ? "INVERSION (< 0 bps)" : "NORMAL (> 0 bps)",
        severity: isInverted ? "CRITICAL" : "STABLE",
        regimeImplication: isInverted
          ? "Rủi ro chu kỳ thắt chặt thanh khoản ngắn hạn; Permission Gate hạ tỷ trọng Risk-On"
          : "Đường cong dốc dương chuẩn, tạo nền thanh khoản ổn định cho tài sản rủi ro",
        dataSource: `${yld10.source.toUpperCase()} · ${yld10.ticker}`,
      });
    }

    // 2. Kiểm toán Độ biến động VIX
    if (vix && Number.isFinite(vix.last)) {
      const isPanic = vix.last >= 25;
      const isElevated = vix.last >= 20;
      records.push({
        id: "audit-vix-volatility",
        metric: "CBOE Volatility (VIX)",
        observedValue: `${vix.last.toFixed(2)} pts`,
        thresholdState: isPanic ? "EXTREME (> 25)" : isElevated ? "ELEVATED (20-25)" : "COMPLACENT (< 20)",
        severity: isPanic ? "CRITICAL" : isElevated ? "WARNING" : "STABLE",
        regimeImplication: isPanic
          ? "Biến động cực đoan: Kích hoạt Volatility Scaling giảm đòn bẩy danh mục"
          : isElevated
          ? "Rủi ro gia tăng: Thắt chặt dải Trailing Stop đối với các vị thế Momentum"
          : "Môi trường biến động thấp: Cho phép phân bổ tỷ trọng theo mô hình cơ sở",
        dataSource: `${vix.source.toUpperCase()} · ${vix.ticker}`,
      });
    }

    // 3. Kiểm toán Áp lực USD (DXY 20D Return)
    if (dxy && Number.isFinite(dxy.last)) {
      const dxySurge = dxy.changePct20d > 0.02;
      records.push({
        id: "audit-dxy-pressure",
        metric: "US Dollar Index Momentum",
        observedValue: `${dxy.last.toFixed(2)} (${(dxy.changePct20d * 100).toFixed(2)}%/20d)`,
        thresholdState: dxySurge ? "DOLLAR RALLY (> +2%)" : "NEUTRAL / WEAKENING",
        severity: dxySurge ? "WARNING" : "STABLE",
        regimeImplication: dxySurge
          ? "Dòng vốn rút ròng khỏi Emerging Markets; gia tăng chi phí phòng hộ tỷ giá"
          : "Áp lực tỷ giá dịu bớt, dòng tiền phân bổ cân bằng hơn sang chứng khoán và vàng",
        dataSource: `${dxy.source.toUpperCase()} · ${dxy.ticker}`,
      });
    }

    // 4. Kiểm toán Trạng thái Bitcoin Benchmark
    if (btc && Number.isFinite(btc.last)) {
      records.push({
        id: "audit-btc-benchmark",
        metric: "BTC Benchmark Mark Price",
        observedValue: `$${btc.last.toLocaleString("en-US", { maximumFractionDigits: 2 })}`,
        thresholdState: btc.changePct1d >= 0 ? "BULLISH DELTA" : "BEARISH DELTA",
        severity: "STABLE",
        regimeImplication: `Hiệu suất 24h: ${(btc.changePct1d * 100).toFixed(2)}%. Định giá tài sản số neo theo luồng nến đồng bộ Paper Lab`,
        dataSource: `${btc.source.toUpperCase()} · Binance Engine`,
      });
    }

    return records;
  }, [series]);

  return (
    <div className="border border-line bg-panel p-3.5 mt-3 shrink-0 block w-full rounded-sm shadow-sm">
      <div className="flex items-center justify-between mb-3 border-b border-line/50 pb-2">
        <div className="flex items-center gap-2">
          <Terminal size={14} className="text-cyan" />
          <span className="font-mono text-[11px] tracking-[0.18em] text-cyan font-bold">
            QUANT SIGNAL & MACRO RISK AUDIT
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="font-mono text-[10px] text-muted">
            SYNC: {refreshedAt ? new Date(refreshedAt).toISOString().slice(11, 19) : "—"} UTC
          </span>
          <span className="font-mono text-[9px] text-[#00e676] border border-[#00e676]/30 bg-[#00e676]/10 px-2 py-0.5 rounded">
            REGIME: {regime?.label ?? "CALCULATING"}
          </span>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse font-mono text-[11px]">
          <thead className="text-muted border-b border-line bg-panel-2">
            <tr>
              <th className="py-2 px-3">CHỈ SỐ KIỂM TOÁN</th>
              <th className="py-2 px-3">GIÁ TRỊ QUAN SÁT</th>
              <th className="py-2 px-3 text-center">TRẠNG THÁI NGƯỠNG</th>
              <th className="py-2 px-3 text-center">MỨC RỦI RO</th>
              <th className="py-2 px-3">TÁC ĐỘNG ĐIỀU TIẾT QUẢN TRỊ (REGIME IMPLICATION)</th>
              <th className="py-2 px-3 text-right">NGUỒN DỮ LIỆU</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {auditRecords.map((row) => (
              <tr key={row.id} className="hover:bg-panel-2/70 transition-colors">
                <td className="py-2.5 px-3 font-bold text-white">{row.metric}</td>
                <td className="py-2.5 px-3 font-mono font-bold text-ink">{row.observedValue}</td>
                <td className="py-2.5 px-3 text-center text-muted">{row.thresholdState}</td>
                <td className="py-2.5 px-3 text-center">
                  <span
                    className={clsx(
                      "px-2 py-0.5 rounded text-[9px] font-bold tracking-wider uppercase inline-flex items-center gap-1",
                      row.severity === "CRITICAL"
                        ? "bg-down/20 text-down border border-down/30"
                        : row.severity === "WARNING"
                        ? "bg-amber/20 text-amber border border-amber/30"
                        : "bg-up/20 text-up border border-up/30"
                    )}
                  >
                    {row.severity === "CRITICAL" && <ShieldAlert size={10} />}
                    {row.severity === "STABLE" && <ShieldCheck size={10} />}
                    {row.severity === "WARNING" && <Activity size={10} />}
                    {row.severity}
                  </span>
                </td>
                <td className="py-2.5 px-3 text-muted leading-relaxed whitespace-normal">
                  {row.regimeImplication}
                </td>
                <td className="py-2.5 px-3 text-right font-mono text-[10px] text-cyan">
                  {row.dataSource}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};