import { create } from "zustand";
import type { BotMetrics, OhlcvBar } from "@/types/market";
import type { DecisionState } from "@/lib/quant/types";
import { PaperEngine, STARTING_EQUITY } from "@/lib/paperEngine";
import { useMacroStore } from "@/stores/macroStore";

const engine = new PaperEngine();

const emptyBot = (botId: BotMetrics["botId"], name: string): BotMetrics => ({
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
  lastSignal: "INITIALIZING",
  trades: [],
  equityCurve: [],
});

interface TradingState {
  running: boolean;
  trend: BotMetrics;
  mean: BotMetrics;
  dca: BotMetrics;
  omega: BotMetrics;
  latestDecision: DecisionState | null;
  lastRunAt: number | null;
  runOnBars: (bars: OhlcvBar[]) => void;
  ingest: (bar: OhlcvBar, history: OhlcvBar[]) => void;
  reset: () => void;
}

export const useTradingStore = create<TradingState>((set) => ({
  running: true,
  trend: emptyBot("trend", "Bot 1 · Adaptive Trend"),
  mean: emptyBot("meanrev", "Bot 3 · Short Mean Reversion"),
  dca: emptyBot("dca", "Bot 2 · Event Catalyst Driver"),
  omega: emptyBot("dca" as any, "Omega · Quant Meta-Fund"),
  latestDecision: null,
  lastRunAt: null,

  runOnBars: (bars) => {
    if (bars.length < 25) return;
    const regime = useMacroStore.getState().regime;
    const isRiskOff = Boolean(regime && regime.score < 45);
    const { trend, mean, dca, omega, latestDecision } = engine.replay(bars, isRiskOff);
    set({ trend, mean, dca, omega, latestDecision, lastRunAt: Date.now(), running: true });
  },

  ingest: (bar, history) => {
    const regime = useMacroStore.getState().regime;
    const isRiskOff = Boolean(regime && regime.score < 45);
    const { trend, mean, dca, omega, latestDecision } = engine.ingestBar(bar, history, isRiskOff);
    set({ trend, mean, dca, omega, latestDecision, lastRunAt: Date.now() });
  },

  reset: () => {
    engine.reset();
    set({
      trend: emptyBot("trend", "Bot 1 · Adaptive Trend"),
      mean: emptyBot("meanrev", "Bot 3 · Short Mean Reversion"),
      dca: emptyBot("dca", "Bot 2 · Event Catalyst Driver"),
      omega: emptyBot("dca" as any, "Omega · Quant Meta-Fund"),
      latestDecision: null,
      lastRunAt: null,
    });
  },
}));