import {
  Activity,
  CandlestickChart,
  Cpu,
  FlaskConical,
  Globe2,
  Radio,
} from "lucide-react";
import { clsx } from "@/lib/clsx";
import { useUiStore } from "@/stores/uiStore";
import type { ViewId } from "@/types/market";

const NAV: Array<{ id: ViewId; label: string; blurb: string; icon: typeof Globe2 }> = [
  { id: "lab", label: "PAPER ACTION", blurb: "Canonical decision", icon: Cpu },
  { id: "research", label: "RESEARCH / RULES", blurb: "Read-only evidence", icon: FlaskConical },
  { id: "macro", label: "MACRO", blurb: "Regime & Allocation", icon: Globe2 },
  { id: "charts", label: "CHARTS", blurb: "BTCUSDT · Indicators", icon: CandlestickChart },
];

export function Sidebar() {
  const view = useUiStore((s) => s.view);
  const setView = useUiStore((s) => s.setView);

  return (
    <aside className="flex w-full shrink-0 flex-col border-b border-line bg-[#080b11] md:h-full md:w-[220px] md:border-b-0 md:border-r">
      <div className="hidden border-b border-line px-4 py-4 md:block">
        <div className="flex items-center gap-2 text-up">
          <Activity size={16} />
          <span className="font-mono text-[11px] font-semibold tracking-[0.28em]">
            QUANTFUND
          </span>
        </div>
        <div className="mt-1 font-mono text-[10px] tracking-[0.42em] text-muted">OS TERMINAL</div>
      </div>

      <nav aria-label="Primary product navigation" className="flex min-w-0 flex-row gap-1 overflow-x-auto p-2 md:flex-1 md:flex-col md:overflow-x-visible">
        {NAV.map((item) => {
          const Icon = item.icon;
          const active = view === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setView(item.id)}
              className={clsx(
                "flex shrink-0 items-start gap-2 border px-3 py-2 text-left transition-colors md:w-full md:gap-3 md:py-2.5",
                active
                  ? "border-up/40 bg-up/10 text-up"
                  : "border-transparent text-muted hover:border-line hover:bg-panel-2 hover:text-ink",
              )}
            >
              <Icon size={15} className="mt-0.5 shrink-0" />
              <span className="min-w-0">
                <span className="block font-mono text-[11px] font-semibold tracking-[0.16em]">
                  {item.label}
                </span>
                <span className="mt-0.5 hidden text-[10px] text-muted sm:block">{item.blurb}</span>
              </span>
            </button>
          );
        })}
      </nav>

      <div className="hidden border-t border-line px-4 py-3 font-mono text-[10px] text-muted md:block">
        <div className="flex items-center gap-2 text-up">
          <Radio size={12} />
          <span>PAPER · LOCAL</span>
        </div>
        <div className="mt-1">v1.0.0 · NO LIVE ORDERS</div>
      </div>
    </aside>
  );
}
