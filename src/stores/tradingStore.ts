// ============================================================================
// FILE: src/stores/tradingStore.ts
// MODULE: QUANT TRADING & BENCHMARK STATE STORE
//
// BLOCKER 1: runOnBars() takes QuantReplayMarketContext explicitly.
// The store does NOT read interval indirectly from useMarketStore.getState().
// The caller (View) must pass interval + source together.
// QUANT_BAR_INTERVAL from timeDomain.ts is used for the boundary check.
// ============================================================================

import { create } from "zustand";
import type { BotMetrics, OhlcvBar, QuantBotId } from "@/types/market";
import type { DecisionState } from "@/lib/quant/types";
import { PaperEngine, STARTING_EQUITY } from "@/lib/paperEngine";
import { QUANT_BAR_INTERVAL, type QuantReplayMarketContext } from "@/lib/quant/timeDomain";

const engine = new PaperEngine();

const emptyBot = (botId: QuantBotId, name: string): BotMetrics => ({
  botId,
  name,
  cash: STARTING_EQUITY,
  qty: 0,
  lastPrice: 0,
  equity: STARTING_EQUITY,
  pnl: 0,
  pnlPct: 0,
  winRate: 0,
  maxDrawdown: 0,
  totalTrades: 0,
  wins: 0,
  losses: 0,
  position: "FLAT",
  lastSignal: "AWAITING_WARMUP",
  trades: [],
  equityCurve: [],
});

interface TradingState {
  running: boolean;
  trend: BotMetrics;
  event: BotMetrics;
  mean: BotMetrics;
  omega: BotMetrics;
  benchmarkDca: BotMetrics;
  latestDecision: DecisionState | null;
  lastRunAt: number | null;
  // BLOCKER 1: QuantReplayMarketContext is passed explicitly by the View.
  // The store does NOT read interval from a hidden store dependency.
  runOnBars: (bars: OhlcvBar[], ctx: QuantReplayMarketContext) => void;
  reset: () => void;
}

export const useTradingStore = create<TradingState>((set) => ({
  running: true,
  trend: emptyBot("trend", "Alpha 1 · Adaptive Trend"),
  event: emptyBot("event", "Alpha 2 · Event Catalyst"),
  mean: emptyBot("meanrev", "Alpha 3 · Mean Reversion"),
  omega: emptyBot("omega", "Omega · Quant Meta-Fund"),
  benchmarkDca: emptyBot("benchmark_dca", "Control · Passive DCA 10%"),
  latestDecision: null,
  lastRunAt: null,

  runOnBars: (bars, ctx) => {
    // BLOCKER 1 / CORE-01 interval guard:
    // The canonical quant engine is a 1H bar engine.
    // If the caller passes an interval other than QUANT_BAR_INTERVAL ("1h"),
    // do not run the quant replay and reset to a clearly neutral state.
    // Stale prior 1H results must not remain visible.
    // QUANT_BAR_INTERVAL is the single literal source; "1h" is not repeated here.
    if (ctx.interval !== QUANT_BAR_INTERVAL) {
      engine.reset();
      set({
        running: false,
        trend: emptyBot("trend", "Alpha 1 · Adaptive Trend"),
        event: emptyBot("event", "Alpha 2 · Event Catalyst"),
        mean: emptyBot("meanrev", "Alpha 3 · Mean Reversion"),
        omega: emptyBot("omega", "Omega · Quant Meta-Fund"),
        benchmarkDca: emptyBot("benchmark_dca", "Control · Passive DCA 10%"),
        latestDecision: null,
        lastRunAt: null,
      });
      return;
    }

    // Minimum 130 bars required to clear the 125-bar warmup of Adaptive Trend.
    if (!bars || bars.length < 130) return;

    // ctx carries both interval (already validated above) and source.
    // PaperEngine will independently reject non-1H intervals as a safety net.
    const { trend, event, mean, omega, benchmarkDca, latestDecision } = engine.replay(bars, ctx);
    set({
      trend,
      event,
      mean,
      omega,
      benchmarkDca,
      latestDecision,
      lastRunAt: Date.now(),
      running: true,
    });
  },

  reset: () => {
    engine.reset();
    set({
      trend: emptyBot("trend", "Alpha 1 · Adaptive Trend"),
      event: emptyBot("event", "Alpha 2 · Event Catalyst"),
      mean: emptyBot("meanrev", "Alpha 3 · Mean Reversion"),
      omega: emptyBot("omega", "Omega · Quant Meta-Fund"),
      benchmarkDca: emptyBot("benchmark_dca", "Control · Passive DCA 10%"),
      latestDecision: null,
      lastRunAt: null,
    });
  },
}));