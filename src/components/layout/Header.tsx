import { useEffect } from "react";
import { useUiStore } from "@/stores/uiStore";

const VIEW_TITLE = {
  macro: "MACRO REGIME / ASSET ALLOCATION",
  charts: "TECHNICAL CHARTING / BTCUSDT",
  lab: "MICRO BOT PAPER TRADING LAB",
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
    <header className="flex h-11 shrink-0 items-center justify-between border-b border-line bg-[#080b11] px-4">
      <div>
        <div className="font-mono text-[10px] tracking-[0.22em] text-cyan">FUNCTION</div>
        <div className="font-mono text-[12px] font-semibold tracking-wide text-ink">
          {VIEW_TITLE[view]}
        </div>
      </div>
      <div className="flex items-center gap-6 font-mono text-[11px]">
        <span className="text-muted">
          SESSION <span className="text-up">ACTIVE</span>
        </span>
        <span className="text-ink">{stamp}</span>
      </div>
    </header>
  );
}
