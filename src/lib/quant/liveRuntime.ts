// ============================================================================
// FILE: src/lib/quant/liveRuntime.ts
// MODULE: LIVE RUNTIME STREAMING ADAPTER & PARAMETER FREEZE GUARD
// ============================================================================

import type { OhlcvBar } from "@/types/market";
import type { AssetId, DecisionState, PointInTimeBar, StrategyContext } from "./types";
import { evaluateAdaptiveTrend, DEFAULT_ADAPTIVE_TREND_CONFIG } from "./adaptiveTrend";
import { evaluateEventReaction, DEFAULT_EVENT_REACTION_CONFIG } from "./eventReaction";
import { evaluateMeanReversion, DEFAULT_MEAN_REVERSION_CONFIG } from "./meanReversion";
import { evaluatePermission, DEFAULT_PERMISSION_CONFIG } from "./permissionGate";
import { evaluatePortfolioRisk, createInitialRiskState, DEFAULT_RISK_ENGINE_CONFIG, type RiskEngineState } from "./riskEngine";
import { evaluateOmegaAllocation, DEFAULT_OMEGA_CONFIG } from "./omegaAllocator";

export interface ProductionEngineState {
  readonly isFrozen: boolean;
  readonly version: string;
  bufferBars: PointInTimeBar[];
  riskState: RiskEngineState;
  peakNav: number;
  currentCash: number;
  currentPositions: Record<AssetId, number>;
}

export function initializeProductionEngine(initialCapital = 10000): ProductionEngineState {
  return {
    isFrozen: true, // Khóa cứng tham số, không cho phép thay đổi khi đang chạy
    version: "v1.0.0-quant-prod",
    bufferBars: [],
    riskState: createInitialRiskState(),
    peakNav: initialCapital,
    currentCash: initialCapital,
    currentPositions: {},
  };
}

export interface LiveIngestResult {
  readonly success: boolean;
  readonly decisionState: DecisionState | null;
  readonly error?: string;
}

export function ingestLiveBar(
  bar: OhlcvBar,
  engineState: ProductionEngineState,
  maxBufferCapacity = 500
): LiveIngestResult {
  if (!engineState.isFrozen) {
    return { success: false, decisionState: null, error: "PRODUCTION_GUARD_ERROR: Parameters are not frozen." };
  }

  const pitBar: PointInTimeBar = {
    timestamp: bar.time < 1e11 ? bar.time * 1000 : bar.time,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
  };

  engineState.bufferBars.push(pitBar);
  if (engineState.bufferBars.length > maxBufferCapacity) {
    engineState.bufferBars.shift(); // Giữ cố định kích thước buffer bộ nhớ
  }

  // Yêu cầu tối thiểu 125 nến để chạy
  if (engineState.bufferBars.length < 125) {
    return { success: true, decisionState: null, error: "WARMUP_IN_PROGRESS" };
  }

  const timestamp = pitBar.timestamp;
  const benchmarkId = "BTC";
  const benchmarkSlice = engineState.bufferBars;

  try {
    // 1. Đánh giá 3 Alphas độc lập
    const ctx: StrategyContext = {
      strategyId: "ADAPTIVE_TREND",
      assetId: benchmarkId,
      currentBarTimestamp: timestamp,
      decisionTimestamp: timestamp,
      currentPrice: pitBar.close,
      priceHistory: benchmarkSlice,
      macro: null,
      latestEvent: null,
    };

    const trendSignal = evaluateAdaptiveTrend(ctx, { strategyId: "ADAPTIVE_TREND", lastEvaluationTimestamp: timestamp, barsSinceLastSignal: 0, internalValues: {} }, DEFAULT_ADAPTIVE_TREND_CONFIG);
    const eventSignal = evaluateEventReaction({ ...ctx, strategyId: "EVENT_REACTION" }, { strategyId: "EVENT_REACTION", lastEvaluationTimestamp: timestamp, barsSinceLastSignal: 0, internalValues: {} }, DEFAULT_EVENT_REACTION_CONFIG);
    const mrSignal = evaluateMeanReversion({ ...ctx, strategyId: "MEAN_REVERSION" }, { strategyId: "MEAN_REVERSION", lastEvaluationTimestamp: timestamp, barsSinceLastSignal: 0, internalValues: {} }, DEFAULT_MEAN_REVERSION_CONFIG);

    const signals = [trendSignal, eventSignal, mrSignal];

    // 2. Permission Gate
    const permissions = [
      evaluatePermission("ADAPTIVE_TREND", null, DEFAULT_PERMISSION_CONFIG, timestamp),
      evaluatePermission("EVENT_REACTION", null, DEFAULT_PERMISSION_CONFIG, timestamp),
      evaluatePermission("MEAN_REVERSION", null, DEFAULT_PERMISSION_CONFIG, timestamp),
    ];

    // 3. Risk Engine
    let nav = engineState.currentCash;
    for (const [id, qty] of Object.entries(engineState.currentPositions)) {
      if (id === benchmarkId) nav += qty * pitBar.close;
    }
    if (nav > engineState.peakNav) engineState.peakNav = nav;

    const { risk, nextState } = evaluatePortfolioRisk(nav, engineState.peakNav, benchmarkSlice, engineState.riskState, DEFAULT_RISK_ENGINE_CONFIG, timestamp);
    engineState.riskState = nextState;

    // 4. Omega Allocator
    const targetWeights = evaluateOmegaAllocation(signals, permissions, risk, null, timestamp, DEFAULT_OMEGA_CONFIG);

    const decisionState: DecisionState = {
      barIndex: engineState.bufferBars.length - 1,
      timestamp,
      nav: Math.round(nav * 100) / 100,
      cash: Math.round(engineState.currentCash * 100) / 100,
      positions: {
        [benchmarkId]: {
          assetId: benchmarkId,
          side: (engineState.currentPositions[benchmarkId] ?? 0) > 0 ? "LONG" : "FLAT",
          status: "OPEN",
          quantity: engineState.currentPositions[benchmarkId] ?? 0,
          entryPrice: pitBar.close,
          unrealizedPnl: 0,
        },
      },
      signals,
      permissions,
      risk,
      targetWeights,
      executions: [],
      dailyPnl: 0,
      cumulativePnl: Math.round((nav - 10000) * 100) / 100,
      currentDrawdown: engineState.peakNav > 0 ? (engineState.peakNav - nav) / engineState.peakNav : 0,
    };

    return { success: true, decisionState };
  } catch (err) {
    return { success: false, decisionState: null, error: err instanceof Error ? err.message : "Live runtime error" };
  }
}
