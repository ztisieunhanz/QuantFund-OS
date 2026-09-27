import { useEffect } from "react";
import { useUiStore } from "@/stores/uiStore";

const VIEW_TITLE = {
  macro: "MACRO REGIME / ASSET ALLOCATION",
  charts: "TECHNICAL CHARTING / BTCUSDT",
  lab: "CANONICAL PAPER ACTION / PORTFOLIO STATE",
  research: "CANONICAL RESEARCH EVIDENCE / RULES",
} as const;

export function Header() {
  const view = useUiStore((s) => s.view);
  const clock = useUiStore((s) => s.clock);
  const tickClock = useUiStore((s) => s.tickClock);

  useEffect(() => {
    const id = window.setInterval(tickClock, 1000);
    return () => window.clearInterval(id);
  }, [tickClock]);

  const stamp = new Date(clock).toISOString().replace("T", " ").slice(0, 19) + " UTC";

  return (
    <header className="flex min-h-11 shrink-0 items-center justify-between gap-3 border-b border-line bg-[#080b11] px-3 py-2 sm:px-4">
      <div className="min-w-0">
        <div className="font-mono text-[10px] tracking-[0.22em] text-cyan">FUNCTION</div>
        <div className="truncate font-mono text-[11px] font-semibold tracking-wide text-ink sm:text-[12px]">
          {VIEW_TITLE[view]}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-3 font-mono text-[10px] sm:gap-6 sm:text-[11px]">
        <span className="hidden text-muted sm:inline">
          SESSION <span className="text-up">ACTIVE</span>
        </span>
        <span className="text-ink"><span className="hidden sm:inline">{stamp}</span><span className="sm:hidden">{stamp.slice(11)}</span></span>
      </div>
    </header>
  );
}
