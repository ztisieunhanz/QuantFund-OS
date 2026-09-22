// ============================================================================
// FILE: src/stores/__tests__/paperPersistence.test.ts
// MODULE: GATE M7B PAPER PERSISTENCE & HYDRATION SAFETY UNIT TESTS
// ============================================================================

import { describe, it, expect, beforeEach } from "vitest";
import { useTradingStore, isValidDecisionState, getStorageApi } from "../tradingStore";
import type { DecisionState } from "@/lib/quant/types";
import type { OhlcvBar } from "@/types/market";

function makeMockDecision(override?: Partial<DecisionState>): DecisionState {
  const defaultTime = 1758400000000;
  return {
    barIndex: 200,
    timestamp: defaultTime,
    nav: 10500,
    cash: 5250,
    positions: {
      BTC: {
        assetId: "BTC",
        side: "LONG",
        status: "OPEN",
        quantity: 0.08,
        entryPrice: 65000,
        unrealizedPnl: 250,
      },
    },
    signals: [
      {
        strategyId: "ADAPTIVE_TREND",
        assetId: "BTC",
        timestamp: defaultTime,
        alphaScore: 0.8,
        heuristicExpectedReturn: 0.05,
        confidence: 0.9,
        forecastVol: 0.15,
        holdingPeriod: 5,
        rationale: "Trend momentum strong",
      },
      {
        strategyId: "EVENT_REACTION",
        assetId: "BTC",
        timestamp: defaultTime,
        alphaScore: 0,
        heuristicExpectedReturn: 0,
        confidence: 0,
        forecastVol: 0,
        holdingPeriod: 0,
        rationale: "Neutral catalyst",
      },
      {
        strategyId: "MEAN_REVERSION",
        assetId: "BTC",
        timestamp: defaultTime,
        alphaScore: -0.2,
        heuristicExpectedReturn: -0.01,
        confidence: 0.5,
        forecastVol: 0.1,
        holdingPeriod: 2,
        rationale: "Minor overbought Z-score",
      },
    ],
    permissions: [],
    risk: {
      scope: "PORTFOLIO_AGGREGATE",
      targetExposure: 0.5,
      grossExposure: 0.5,
      targetVolatility: 0.12,
      realizedVol: 0.1,
      forecastVol: 0.11,
      riskFlags: [],
      circuitBreakerStatus: "NORMAL",
      circuitBreakerReason: "Within limits",
    },
    targetWeights: {
      asOfTimestamp: defaultTime,
      assetWeights: { BTC: 0.5 },
      cashWeight: 0.5,
      grossExposure: 0.5,
      netExposure: 0.5,
      strategyAllocations: { ADAPTIVE_TREND: 0.5, EVENT_REACTION: 0, MEAN_REVERSION: 0 },
      riskAdjustmentRatio: 1.0,
      rationale: "Target weight 50% BTC",
    },
    executions: [
      {
        executionId: "exec-1",
        orderId: "ord-1",
        strategyId: "OMEGA_REBALANCE",
        assetId: "BTC",
        side: "BUY",
        orderType: "MARKET",
        signalTimestamp: defaultTime - 3600000,
        decisionTimestamp: defaultTime,
        executionTimestamp: defaultTime,
        intendedPrice: 65000,
        executionPrice: 65032.5,
        quantity: 0.08,
        notionalUsd: 5202.6,
        slippage: 32.5,
        fees: 5.2,
        netCashImpact: -5207.8,
      },
    ],
    dailyPnl: 250,
    cumulativePnl: 500,
    currentDrawdown: 0.02,
    ...override,
  };
}

function generateMockBars(count: number): OhlcvBar[] {
  const bars: OhlcvBar[] = [];
  let price = 50000;
  const startTime = 1758000000;
  for (let i = 0; i < count; i++) {
    price += (i % 2 === 0 ? 50 : -30);
    bars.push({
      time: startTime + i * 3600,
      open: price - 10,
      high: price + 20,
      low: price - 20,
      close: price,
      volume: 100,
    });
  }
  return bars;
}

describe("Gate M7B Paper Engine Persistence & Hydration Safety", () => {
  const storage = getStorageApi();

  beforeEach(() => {
    storage.clear();
    useTradingStore.getState().reset();
  });

  it("1. valid latestDecision persists to storage under key quant_paper_engine_state", () => {
    const mockDec = makeMockDecision();
    useTradingStore.setState({
      latestDecision: mockDec,
      lastRunAt: 1758400000999,
      isRestored: false,
      restoredAt: null,
    });

    const storedRaw = storage.getItem("quant_paper_engine_state");
    expect(storedRaw).not.toBeNull();
    const parsed = JSON.parse(storedRaw!);
    expect(parsed.state.latestDecision).toEqual(mockDec);
    expect(parsed.state.lastRunAt).toBe(1758400000999);
    expect(parsed.version).toBe(1);

    // Single Canonical Ledger Invariant: Duplicate accounting state must NOT be persisted in storage
    expect(parsed.state.omega).toBeUndefined();
    expect(parsed.state.trend).toBeUndefined();
    expect(parsed.state.event).toBeUndefined();
    expect(parsed.state.mean).toBeUndefined();
  });

  it("2 & 3 & 4. valid persisted latestDecision hydrates with exact timestamp & restored provenance", () => {
    const mockDec = makeMockDecision({ timestamp: 1758400000123 });
    const payload = {
      state: {
        latestDecision: mockDec,
        lastRunAt: 1758400000999,
      },
      version: 1,
    };
    storage.setItem("quant_paper_engine_state", JSON.stringify(payload));

    // Simulate store rehydration
    const rehydrate = useTradingStore.persist.rehydrate;
    rehydrate();

    const state = useTradingStore.getState();
    expect(state.latestDecision).toEqual(mockDec);
    expect(state.latestDecision?.timestamp).toBe(1758400000123); // Original timestamp preserved
    expect(state.lastRunAt).toBe(1758400000999);
    expect(state.isRestored).toBe(true);
    expect(state.restoredAt).not.toBeNull();
    expect(state.omega.equity).toBe(10500);
    expect(state.omega.cash).toBe(5250);
  });

  it("5. fresh runOnBars clears restored provenance", () => {
    // Start from restored state
    const mockDec = makeMockDecision();
    useTradingStore.setState({
      latestDecision: mockDec,
      lastRunAt: 1758400000999,
      isRestored: true,
      restoredAt: Date.now(),
    });

    expect(useTradingStore.getState().isRestored).toBe(true);

    // Run fresh bars replay
    const bars = generateMockBars(140);
    useTradingStore.getState().runOnBars(bars, { interval: "1h", source: "live" });

    const stateAfterRun = useTradingStore.getState();
    expect(stateAfterRun.isRestored).toBe(false);
    expect(stateAfterRun.restoredAt).toBeNull();
    expect(stateAfterRun.latestDecision).not.toBeNull();
  });

  it("6 & 7. hydration alone does NOT execute PaperEngine or append duplicate fills", () => {
    const mockDec = makeMockDecision();
    const payload = {
      state: {
        latestDecision: mockDec,
        lastRunAt: 1758400000999,
      },
      version: 1,
    };
    storage.setItem("quant_paper_engine_state", JSON.stringify(payload));

    const initialExecutionLength = mockDec.executions.length;

    // Trigger rehydration
    useTradingStore.persist.rehydrate();

    const state = useTradingStore.getState();
    expect(state.latestDecision?.executions.length).toBe(initialExecutionLength);
    expect(state.omega.trades.length).toBe(initialExecutionLength);
  });

  it("8. corrupt persisted JSON fails closed to clean initial state", () => {
    storage.setItem("quant_paper_engine_state", "{invalid_json_payload:");

    // Rehydrate
    useTradingStore.persist.rehydrate();

    const state = useTradingStore.getState();
    expect(state.latestDecision).toBeNull();
    expect(state.isRestored).toBe(false);
    expect(state.omega.equity).toBe(10000);
  });

  it("9. unsupported schema version fails closed", () => {
    const mockDec = makeMockDecision();
    const payload = {
      state: {
        latestDecision: mockDec,
        lastRunAt: 1758400000999,
      },
      version: 999, // Unsupported future version
    };
    storage.setItem("quant_paper_engine_state", JSON.stringify(payload));

    useTradingStore.persist.rehydrate();

    const state = useTradingStore.getState();
    expect(state.latestDecision).toBeNull();
    expect(state.isRestored).toBe(false);
  });

  it("10. invalid persisted decision (e.g. non-finite NAV) fails closed", () => {
    const corruptDec = makeMockDecision({ nav: NaN });
    expect(isValidDecisionState(corruptDec)).toBe(false);

    const payload = {
      state: {
        latestDecision: corruptDec,
        lastRunAt: 1758400000999,
      },
      version: 1,
    };
    storage.setItem("quant_paper_engine_state", JSON.stringify(payload));

    const state = useTradingStore.getState();
    expect(state.latestDecision).toBeNull();
    expect(state.isRestored).toBe(false);
  });

  it("11. hydration returns null (N/A) for un-evidenced performance metrics, NOT numeric 0", () => {
    const mockDec = makeMockDecision();
    const payload = {
      state: {
        latestDecision: mockDec,
        lastRunAt: 1758400000999,
      },
      version: 1,
    };
    storage.setItem("quant_paper_engine_state", JSON.stringify(payload));

    useTradingStore.persist.rehydrate();

    const state = useTradingStore.getState();

    // 1 & 2. Restored Alpha sub-bots: PnL, win rate, trade counts are null (N/A)
    for (const bot of [state.trend, state.event, state.mean]) {
      expect(bot.equity).toBeNull();
      expect(bot.pnl).toBeNull();
      expect(bot.pnlPct).toBeNull();
      expect(bot.winRate).toBeNull();
      expect(bot.totalTrades).toBeNull();
      expect(bot.wins).toBeNull();
      expect(bot.losses).toBeNull();
      expect(bot.cash).toBeNull();
      expect(bot.status).toBe("UNAVAILABLE");
    }

    // 6. Current Alpha signal rationale survives hydration from latestDecision
    expect(state.trend.lastSignal).toBe("Trend momentum strong");

    // 3. Restored DCA Benchmark: ALL metrics null (UNAVAILABLE)
    expect(state.benchmarkDca.equity).toBeNull();
    expect(state.benchmarkDca.pnl).toBeNull();
    expect(state.benchmarkDca.pnlPct).toBeNull();
    expect(state.benchmarkDca.totalTrades).toBeNull();
    expect(state.benchmarkDca.lastSignal).toBe("UNAVAILABLE (REPLAY REQUIRED)");
    expect(state.benchmarkDca.status).toBe("UNAVAILABLE");

    // 4 & 5. Restored Omega Meta-Fund: NAV/cash/drawdown/trades grounded; winRate/wins/losses null
    expect(state.omega.equity).toBe(10500);
    expect(state.omega.cash).toBe(5250);
    expect(state.omega.qty).toBe(0.08);
    expect(state.omega.pnl).toBe(500);
    expect(state.omega.maxDrawdown).toBe(0.02);
    expect(state.omega.totalTrades).toBe(1);
    expect(state.omega.winRate).toBeNull();
    expect(state.omega.wins).toBeNull();
    expect(state.omega.losses).toBeNull();
    expect(state.omega.status).toBe("PARTIAL");
  });

  it("12. fresh replay still produces full numeric telemetry", () => {
    const bars = generateMockBars(140);
    useTradingStore.getState().runOnBars(bars, { interval: "1h", source: "live" });

    const state = useTradingStore.getState();
    expect(typeof state.omega.equity).toBe("number");
    expect(typeof state.omega.cash).toBe("number");
    expect(typeof state.omega.pnl).toBe("number");
    expect(state.omega.winRate).toBeNull();
    expect(typeof state.trend.equity).toBe("number");
    expect(typeof state.benchmarkDca.equity).toBe("number");
    expect(state.isRestored).toBe(false);
  });
});

