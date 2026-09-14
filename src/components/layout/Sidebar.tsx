import {
  Activity,
  CandlestickChart,
  Cpu,
  Globe2,
  Radio,
} from "lucide-react";
import { clsx } from "@/lib/clsx";
import { useUiStore } from "@/stores/uiStore";
import type { ViewId } from "@/types/market";

const NAV: Array<{ id: ViewId; label: string; blurb: string; icon: typeof Globe2 }> = [
  { id: "macro", label: "MACRO", blurb: "Regime & Allocation", icon: Globe2 },
  { id: "charts", label: "CHARTS", blurb: "BTCUSDT · Indicators", icon: CandlestickChart },
  { id: "lab", label: "PAPER LAB", blurb: "Multi-bot sandbox", icon: Cpu },
];

export function Sidebar() {
  const view = useUiStore((s) => s.view);
  const setView = useUiStore((s) => s.setView);

  return (
    <aside className="flex h-full w-[220px] shrink-0 flex-col border-r border-line bg-[#080b11]">
      <div className="border-b border-line px-4 py-4">
        <div className="flex items-center gap-2 text-up">
          <Activity size={16} />
          <span className="font-mono text-[11px] font-semibold tracking-[0.28em]">
            QUANTFUND
          </span>
        </div>
        <div className="mt-1 font-mono text-[10px] tracking-[0.42em] text-muted">OS TERMINAL</div>
      </div>

      <nav className="flex flex-1 flex-col gap-1 p-2">
        {NAV.map((item) => {
          const Icon = item.icon;
          const active = view === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setView(item.id)}
              className={clsx(
                "flex items-start gap-3 border px-3 py-2.5 text-left transition-colors",
                active
                  ? "border-up/40 bg-up/10 text-up"
                  : "border-transparent text-muted hover:border-line hover:bg-panel-2 hover:text-ink",
              )}
            >
              <Icon size={15} className="mt-0.5 shrink-0" />
              <span>
                <span className="block font-mono text-[11px] font-semibold tracking-[0.16em]">
                  {item.label}
                </span>
                <span className="mt-0.5 block text-[10px] text-muted">{item.blurb}</span>
              </span>
            </button>
          );
        })}
      </nav>

      <div className="border-t border-line px-4 py-3 font-mono text-[10px] text-muted">
        <div className="flex items-center gap-2 text-up">
          <Radio size={12} />
          <span>PAPER · LOCAL</span>
        </div>
        <div className="mt-1">v1.0.0 · NO LIVE ORDERS</div>
      </div>
    </aside>
  );
}
