// ============================================================================
// FILE: src/stores/tradingStore.ts
// MODULE: QUANT TRADING & BENCHMARK STATE STORE
// ============================================================================

import { create } from "zustand";
import type { BotMetrics, OhlcvBar, QuantBotId } from "@/types/market";
import type { DecisionState } from "@/lib/quant/types";
import { PaperEngine, STARTING_EQUITY } from "@/lib/paperEngine";

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
  runOnBars: (bars: OhlcvBar[]) => void;
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

  runOnBars: (bars) => {
    // Bắt buộc tối thiểu 130 nến để vượt qua 125 nến warmup của Adaptive Trend
    if (!bars || bars.length < 130) return;
    const { trend, event, mean, omega, benchmarkDca, latestDecision } = engine.replay(bars);
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