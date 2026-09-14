import { clsx } from "@/lib/clsx";
import { formatNumber, formatPct } from "@/lib/math";

export function MetricCard({
  label,
  ticker,
  value,
  changePct,
  suffix,
  digits = 2,
}: {
  label: string;
  ticker: string;
  value: number;
  changePct: number;
  suffix?: string;
  digits?: number;
}) {
  const up = changePct >= 0;
  return (
    <div className="border border-line bg-panel-2 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] tracking-[0.16em] text-muted uppercase">
          {label}
        </span>
        <span className="font-mono text-[10px] text-cyan">{ticker}</span>
      </div>
      <div className="mt-1 flex items-end justify-between">
        <div className="font-mono text-xl font-semibold text-ink">
          {formatNumber(value, digits)}
          {suffix ? <span className="ml-1 text-xs text-muted">{suffix}</span> : null}
        </div>
        <div className={clsx("font-mono text-sm font-medium", up ? "text-up" : "text-down")}>
          {formatPct(changePct)}
        </div>
      </div>
    </div>
  );
}
