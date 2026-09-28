// ============================================================================
// FILE: src/lib/macro/__tests__/paperSnapshotHydration.test.ts
// MODULE: GATE M7B SNAPSHOT HYDRATION & GROUNDING INTEGRATION TESTS
// ============================================================================

import { describe, it, expect, beforeEach } from "vitest";
import { useTradingStore, getStorageApi } from "@/stores/tradingStore";
import { useSnapshotStore } from "@/stores/snapshotStore";
import { loadRuntimeMarketSnapshot } from "../runtimeSnapshot";
import type { DecisionState } from "@/lib/quant/types";
import { createCycleKey, createOperationalTruthState } from "@/lib/quant/operationalPaperContract";

function makeMockDecision(override?: Partial<DecisionState>): DecisionState {
  const defaultTime = 1758400000000;
  return {
    barIndex: 300,
    timestamp: defaultTime,
    nav: 12000,
    cash: 6000,
    positions: {
      BTC: {
        assetId: "BTC",
        side: "LONG",
        status: "OPEN",
        quantity: 0.1,
        entryPrice: 60000,
        unrealizedPnl: 0,
      },
    },
    signals: [
      {
        strategyId: "ADAPTIVE_TREND",
        assetId: "BTC",
        timestamp: defaultTime,
        alphaScore: 0.9,
        heuristicExpectedReturn: 0.06,
        confidence: 0.95,
        forecastVol: 0.12,
        holdingPeriod: 5,
        rationale: "Strong upward momentum",
      },
      {
        strategyId: "EVENT_REACTION",
        assetId: "BTC",
        timestamp: defaultTime,
        alphaScore: 0.4,
        heuristicExpectedReturn: 0.02,
        confidence: 0.7,
        forecastVol: 0.1,
        holdingPeriod: 3,
        rationale: "Bullish surprise reaction",
      },
      {
        strategyId: "MEAN_REVERSION",
        assetId: "BTC",
        timestamp: defaultTime,
        alphaScore: 0.1,
        heuristicExpectedReturn: 0.005,
        confidence: 0.6,
        forecastVol: 0.08,
        holdingPeriod: 1,
        rationale: "Slight mean reversion pull",
      },
    ],
    permissions: [],
    risk: {
      scope: "PORTFOLIO_AGGREGATE",
      targetExposure: 0.6,
      grossExposure: 0.5,
      targetVolatility: 0.12,
      realizedVol: 0.11,
      forecastVol: 0.11,
      riskFlags: [],
      circuitBreakerStatus: "NORMAL",
      circuitBreakerReason: "Normal operations",
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
    executions: [],
    dailyPnl: 100,
    cumulativePnl: 2000,
    currentDrawdown: 0.01,
    ...override,
  };
}

describe("Gate M7B Snapshot Hydration & Grounding Integration", () => {
  const storage = getStorageApi();

  beforeEach(() => {
    storage.clear();
    useTradingStore.getState().reset();
    useSnapshotStore.setState({ snapshot: null, loading: false, error: null });
  });

  it("11 & 12. loadRuntimeMarketSnapshot consumes hydrated canonical decision through useTradingStore", async () => {
    const mockDec = makeMockDecision();
    useTradingStore.setState({
      latestDecision: mockDec,
      lastRunAt: 1758400000999,
      isRestored: true,
      restoredAt: Date.now(),
      operationalState: createOperationalTruthState({
        status: "RESTORED_HISTORICAL",
        cycleKey: createCycleKey(mockDec.timestamp),
        source: "LIVE",
      }),
    });

    const snapshot = await loadRuntimeMarketSnapshot();
    expect(snapshot).not.toBeNull();
    expect(snapshot.operationalState?.status).toBe("RESTORED_HISTORICAL");
    expect(snapshot.quant?.status).toBe("UNAVAILABLE");
    expect(snapshot.risk?.status).toBe("UNAVAILABLE");
    expect(snapshot.omega?.status).toBe("UNAVAILABLE");
    expect(snapshot.synthesis?.status).toBe("INSUFFICIENT_DATA");
  });

  it("13 & 14. Shared snapshot store is populated correctly for UI consumers", async () => {
    const mockDec = makeMockDecision();
    useTradingStore.setState({
      latestDecision: mockDec,
      lastRunAt: 1758400000999,
      isRestored: true,
      restoredAt: Date.now(),
      operationalState: createOperationalTruthState({
        status: "RESTORED_HISTORICAL",
        cycleKey: createCycleKey(mockDec.timestamp),
        source: "LIVE",
      }),
    });

    const snap = await useSnapshotStore.getState().refreshSnapshot();
    expect(snap).not.toBeNull();
    expect(useSnapshotStore.getState().snapshot).toEqual(snap);

    // Restored state is retained as evidence but cannot populate current projections.
    const currentSnap = useSnapshotStore.getState().snapshot!;
    expect(currentSnap.operationalState?.historicalOnly).toBe(true);
    expect(currentSnap.quant?.status).toBe("UNAVAILABLE");
    expect(currentSnap.risk?.status).toBe("UNAVAILABLE");
    expect(currentSnap.omega?.targetWeights).toBeNull();
  });

  it("keeps current Quant/Risk/Omega projections available for a fresh boundary", async () => {
    const mockDec = makeMockDecision({ timestamp: 1758398400000 });
    useTradingStore.setState({
      latestDecision: mockDec,
      operationalState: createOperationalTruthState({
        status: "FRESH_CURRENT",
        cycleKey: createCycleKey(mockDec.timestamp),
        observationTime: mockDec.timestamp,
        source: "LIVE",
      }),
    });

    const snapshot = await loadRuntimeMarketSnapshot();
    expect(snapshot.quant?.status).toBe("AVAILABLE");
    expect(snapshot.risk?.status).toBe("AVAILABLE");
    expect(snapshot.omega?.targetWeights).toEqual({ BTC: 0.5 });
  });
});
