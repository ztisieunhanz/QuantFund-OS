import { create } from "zustand";
import type { BotMetrics, OhlcvBar } from "@/types/market";
import { PaperEngine, STARTING_EQUITY } from "@/lib/paperEngine";
import { useMacroStore } from "@/stores/macroStore";

const engine = new PaperEngine();

const emptyBot = (botId: BotMetrics["botId"], name: string): BotMetrics => ({
  botId, name, cash: STARTING_EQUITY, qty: 0, lastPrice: 0, equity: STARTING_EQUITY,
  pnl: 0, pnlPct: 0, winRate: 0, maxDrawdown: 0, totalTrades: 0, wins: 0, losses: 0,
  position: "FLAT", lastSignal: "—", trades: [], equityCurve: [],
});

interface TradingState {
  running: boolean;
  trend: BotMetrics;
  mean: BotMetrics;
  dca: BotMetrics;
  lastRunAt: number | null;
  runOnBars: (bars: OhlcvBar[]) => void;
  ingest: (bar: OhlcvBar, history: OhlcvBar[]) => void;
  reset: () => void;
}

export const useTradingStore = create<TradingState>((set) => ({
  running: true,
  trend: emptyBot("trend", "Bot A · Trend Follower"),
  mean: emptyBot("meanrev", "Bot B · Mean Reversion"),
  dca: emptyBot("dca", "Bot C · Macro Accumulator"),
  lastRunAt: null,
  
  runOnBars: (bars) => {
    if (bars.length < 55) return;
    const regime = useMacroStore.getState().regime;
    const isRiskOff = Boolean(regime && regime.score < 45);
    const { trend, mean, dca } = engine.replay(bars, isRiskOff);
    set({ trend, mean, dca, lastRunAt: Date.now(), running: true });
  },
  
  ingest: (bar, history) => {
    const regime = useMacroStore.getState().regime;
    const isRiskOff = Boolean(regime && regime.score < 45);
    const { trend, mean, dca } = engine.ingestBar(bar, history, isRiskOff);
    set({ trend, mean, dca, lastRunAt: Date.now() });
  },
  
  reset: () => {
    engine.reset();
    set({
      trend: emptyBot("trend", "Bot A · Trend Follower"),
      mean: emptyBot("meanrev", "Bot B · Mean Reversion"),
      dca: emptyBot("dca", "Bot C · Macro Accumulator"),
      lastRunAt: null,
    });
  },
}));