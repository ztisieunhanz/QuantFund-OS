// ============================================================================
// FILE: src/stores/tradingStore.ts
// MODULE: QUANT TRADING & BENCHMARK STATE STORE
//
// GATE M7B: Persists canonical Paper Engine decision state (latestDecision)
// with truthful restored provenance and fail-closed validation.
// Single Canonical Ledger invariant preserved: latestDecision is the sole
// persisted decision artifact. Derived UI metrics are recomputed on hydration.
// ============================================================================

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { BotMetrics, OhlcvBar, QuantBotId, TradeFill } from "@/types/market";
import type { DecisionState, PositionRecord, SignalOutput } from "@/lib/quant/types";
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

/**
 * M7B Fail-Closed Validation: Checks structure and critical numeric fields of persisted decision.
 */
export function isValidDecisionState(dec: unknown): dec is DecisionState {
  if (!dec || typeof dec !== "object") return false;
  const d = dec as Record<string, unknown>;
  if (!Number.isFinite(d.barIndex) || !Number.isFinite(d.timestamp)) return false;
  if (!Number.isFinite(d.nav) || !Number.isFinite(d.cash) || !Number.isFinite(d.currentDrawdown)) return false;
  if (!Array.isArray(d.signals)) return false;
  if (!d.risk || typeof d.risk !== "object") return false;
  if (!d.targetWeights || typeof d.targetWeights !== "object") return false;
  if (!d.positions || typeof d.positions !== "object") return false;
  return true;
}

/**
 * Derives UI telemetry metrics from canonical DecisionState without creating duplicate accounting state.
 */
export function deriveMetricsFromDecision(dec: DecisionState | null): {
  trend: BotMetrics;
  event: BotMetrics;
  mean: BotMetrics;
  omega: BotMetrics;
  benchmarkDca: BotMetrics;
} {
  if (!dec || !isValidDecisionState(dec)) {
    return {
      trend: emptyBot("trend", "Alpha 1 · Adaptive Trend"),
      event: emptyBot("event", "Alpha 2 · Event Catalyst"),
      mean: emptyBot("meanrev", "Alpha 3 · Mean Reversion"),
      omega: emptyBot("omega", "Omega · Quant Meta-Fund"),
      benchmarkDca: emptyBot("benchmark_dca", "Control · Passive DCA 10%"),
    };
  }

  const btcPos = dec.positions["BTC"] as PositionRecord | undefined;
  const qty = btcPos?.quantity ?? 0;
  const entryPrice = btcPos?.entryPrice ?? 0;
  const pnl = Math.round((dec.nav - STARTING_EQUITY) * 100) / 100;
  const pnlPct = (dec.nav - STARTING_EQUITY) / STARTING_EQUITY;

  const trades: TradeFill[] = (dec.executions ?? []).map((e) => ({
    id: e.executionId,
    botId: "omega",
    time: Math.floor(e.executionTimestamp / 1000),
    side: e.side,
    price: e.executionPrice,
    qty: e.quantity,
    fee: e.fees,
    slippage: e.slippage,
    notional: e.notionalUsd,
  }));

  const omega: BotMetrics = {
    botId: "omega",
    name: "Omega · Quant Meta-Fund",
    cash: Math.round(dec.cash * 100) / 100,
    qty: Math.round(qty * 100000) / 100000,
    lastPrice: entryPrice,
    equity: Math.round(dec.nav * 100) / 100,
    pnl,
    pnlPct,
    winRate: null, // Closed round-trip win rate not stored in DecisionState
    maxDrawdown: dec.currentDrawdown,
    totalTrades: trades.length,
    wins: null,
    losses: null,
    position: qty > 0.00001 ? "LONG" : "FLAT",
    lastSignal: dec.targetWeights?.rationale?.slice(0, 48) || "RESTORED STATE",
    trades,
    equityCurve: [{ time: Math.floor(dec.timestamp / 1000), equity: dec.nav }],
    status: "PARTIAL",
  };

  const getRestoredAlphaBot = (id: QuantBotId, strategyId: string, name: string): BotMetrics => {
    const sig = (dec.signals as SignalOutput[]).find((s) => s.strategyId === strategyId);
    return {
      botId: id,
      name,
      cash: null,
      qty: null,
      lastPrice: null,
      equity: null,
      pnl: null,
      pnlPct: null,
      winRate: null,
      maxDrawdown: null,
      totalTrades: null,
      wins: null,
      losses: null,
      position: "FLAT",
      lastSignal: sig?.rationale?.slice(0, 42) || "RESTORED TELEMETRY",
      trades: [],
      equityCurve: [],
      status: "UNAVAILABLE",
    };
  };

  const restoredBenchmarkDca: BotMetrics = {
    botId: "benchmark_dca",
    name: "Control · Passive DCA 10%",
    cash: null,
    qty: null,
    lastPrice: null,
    equity: null,
    pnl: null,
    pnlPct: null,
    winRate: null,
    maxDrawdown: null,
    totalTrades: null,
    wins: null,
    losses: null,
    position: "FLAT",
    lastSignal: "UNAVAILABLE (REPLAY REQUIRED)",
    trades: [],
    equityCurve: [],
    status: "UNAVAILABLE",
  };

  return {
    trend: getRestoredAlphaBot("trend", "ADAPTIVE_TREND", "Alpha 1 · Adaptive Trend"),
    event: getRestoredAlphaBot("event", "EVENT_REACTION", "Alpha 2 · Event Catalyst"),
    mean: getRestoredAlphaBot("meanrev", "MEAN_REVERSION", "Alpha 3 · Mean Reversion"),
    omega,
    benchmarkDca: restoredBenchmarkDca,
  };
}

interface TradingState {
  running: boolean;
  trend: BotMetrics;
  event: BotMetrics;
  mean: BotMetrics;
  omega: BotMetrics;
  benchmarkDca: BotMetrics;
  latestDecision: DecisionState | null;
  lastRunAt: number | null;
  isRestored: boolean;
  restoredAt: number | null;
  runOnBars: (bars: OhlcvBar[], ctx: QuantReplayMarketContext) => void;
  reset: () => void;
}

const dummyStorage = (() => {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
  };
})();

export function getStorageApi(): Storage {
  if (typeof window !== "undefined" && window.localStorage) {
    return window.localStorage;
  }
  if (typeof globalThis !== "undefined" && (globalThis as Record<string, unknown>).localStorage) {
    return (globalThis as Record<string, unknown>).localStorage as Storage;
  }
  return dummyStorage as Storage;
}

export const useTradingStore = create<TradingState>()(
  persist(
    (set) => ({
      running: true,
      trend: emptyBot("trend", "Alpha 1 · Adaptive Trend"),
      event: emptyBot("event", "Alpha 2 · Event Catalyst"),
      mean: emptyBot("meanrev", "Alpha 3 · Mean Reversion"),
      omega: emptyBot("omega", "Omega · Quant Meta-Fund"),
      benchmarkDca: emptyBot("benchmark_dca", "Control · Passive DCA 10%"),
      latestDecision: null,
      lastRunAt: null,
      isRestored: false,
      restoredAt: null,

      runOnBars: (bars, ctx) => {
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
            isRestored: false,
            restoredAt: null,
          });
          return;
        }

        if (!bars || bars.length < 130) return;

        const { trend, event, mean, omega, benchmarkDca, latestDecision } = engine.replay(bars, ctx);
        set({
          trend,
          event,
          mean,
          omega,
          benchmarkDca,
          latestDecision,
          lastRunAt: Date.now(),
          isRestored: false,
          restoredAt: null,
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
          isRestored: false,
          restoredAt: null,
        });
      },
    }),
    {
      name: "quant_paper_engine_state",
      version: 1,
      storage: createJSONStorage(() => getStorageApi()),
      partialize: (state) => ({
        latestDecision: state.latestDecision,
        lastRunAt: state.lastRunAt,
      }),
      onRehydrateStorage: () => (hydratedState, error) => {
        if (error || !hydratedState) return;
        if (
          hydratedState.latestDecision &&
          isValidDecisionState(hydratedState.latestDecision) &&
          Number.isFinite(hydratedState.lastRunAt)
        ) {
          const derived = deriveMetricsFromDecision(hydratedState.latestDecision);
          useTradingStore.setState({
            isRestored: true,
            restoredAt: Date.now(),
            ...derived,
          });
        } else {
          const empty = deriveMetricsFromDecision(null);
          useTradingStore.setState({
            latestDecision: null,
            lastRunAt: null,
            isRestored: false,
            restoredAt: null,
            ...empty,
          });
        }
      },
      migrate: (persistedState: unknown, version: number) => {
        if (version !== 1 || !persistedState || typeof persistedState !== "object") {
          return { latestDecision: null, lastRunAt: null };
        }
        const p = persistedState as Record<string, unknown>;
        if (!isValidDecisionState(p.latestDecision)) {
          return { latestDecision: null, lastRunAt: null };
        }
        return p as Partial<TradingState>;
      },
    }
  )
);