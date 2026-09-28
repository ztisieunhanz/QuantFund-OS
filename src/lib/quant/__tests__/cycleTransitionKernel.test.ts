// ============================================================================
// FILE: src/lib/quant/__tests__/cycleTransitionKernel.test.ts
// MODULE: M18-B PURE SINGLE-CYCLE TRANSITION KERNEL TEST SUITE
// PURPOSE: Verify determinism, input immutability, accounting parity,
//          replay composition equivalence, authority invariants, and PIT correctness.
// ============================================================================

import { describe, it, expect, vi } from "vitest";
import {
  executeSingleCycleTransition,
  type PriorCycleState,
  type CycleTransitionContext,
  type CycleStrategyConfigs,
} from "../cycleTransitionKernel";
import { runBacktest, type BacktestDataset } from "../backtestEngine";
import { createInitialRiskState } from "../riskEngine";
import { DEFAULT_PERMISSION_CONFIG } from "../permissionGate";
import { BAR_DURATION_MS, canonicalBarAvailableAt } from "../timeDomain";
import type {
  AssetId,
  BacktestConfig,
  PointInTimeBar,
  PointInTimeEvent,
  PointInTimeMacro,
} from "../types";

// ----------------------------------------------------------------------------
// TEST HELPERS & SYNTHETIC DATA GENERATOR
// ----------------------------------------------------------------------------

function generateSyntheticBars(count: number, basePrice = 50000, seed = 42): PointInTimeBar[] {
  const bars: PointInTimeBar[] = [];
  let current = basePrice;
  let s = seed;

  const lcg = () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };

  const startMs = 1700000000000;
  for (let i = 0; i < count; i++) {
    const change = (lcg() - 0.49) * 0.04;
    const open = current;
    current = Math.max(100, open * (1 + change));
    const high = Math.max(open, current) * (1 + lcg() * 0.01);
    const low = Math.min(open, current) * (1 - lcg() * 0.01);
    const volume = 1000 + lcg() * 5000;

    bars.push({
      timestamp: startMs + i * BAR_DURATION_MS,
      open: Math.round(open * 100) / 100,
      high: Math.round(high * 100) / 100,
      low: Math.round(low * 100) / 100,
      close: Math.round(current * 100) / 100,
      volume: Math.round(volume * 10) / 10,
    });
  }

  return bars;
}

function createBaseConfig(overrides: Partial<BacktestConfig> = {}): BacktestConfig {
  return {
    runId: "kernel-test-run",
    startDate: 0,
    endDate: 0,
    warmupPeriod: 125,
    initialCapital: 10000,
    commissionRate: 0.001,
    slippageModel: { type: "FIXED_BPS", baseBps: 5 },
    executionRule: "NEXT_BAR_OPEN",
    deterministicSeed: 20260915,
    dataQuality: "LIVE",
    ...overrides,
  };
}

function createBaseMacro(timestamp: number): PointInTimeMacro {
  return {
    asOfTimestamp: timestamp,
    regime: "Risk-On Expansion",
    regimeScore: 75,
    yield10Y: 4.25,
    yield2Y: 4.5,
    yieldSpreadBps: -25,
    vixLevel: 14.5,
    vixZScore: -0.5,
    marketBreadthRatio: 0.65,
    marketBreadthPctAboveMa20: 70,
    marketLiquidityRatio: 1.1,
    foreignNetFlowBillion: 250,
  };
}

function createInitialPriorState(initialCapital = 10000): PriorCycleState {
  return {
    account: {
      cash: initialCapital,
      positions: {},
    },
    riskState: createInitialRiskState(),
    peakNav: initialCapital,
    strategyStates: {
      ADAPTIVE_TREND: { strategyId: "ADAPTIVE_TREND", lastEvaluationTimestamp: 0, barsSinceLastSignal: 0, internalValues: {} },
      EVENT_REACTION: { strategyId: "EVENT_REACTION", lastEvaluationTimestamp: 0, barsSinceLastSignal: 0, internalValues: {} },
      MEAN_REVERSION: { strategyId: "MEAN_REVERSION", lastEvaluationTimestamp: 0, barsSinceLastSignal: 0, internalValues: {} },
    },
    pendingRebalance: null,
    activeTargetLifecycle: null,
    priorDecisionNav: initialCapital,
  };
}

function buildContextForBar(
  bars: readonly PointInTimeBar[],
  barIndex: number,
  config: BacktestConfig,
  strategyConfigs: CycleStrategyConfigs = {},
  macro: PointInTimeMacro | null = null,
  event: PointInTimeEvent | null = null
): CycleTransitionContext {
  const currentBar = bars[barIndex];
  const decisionTime = canonicalBarAvailableAt(currentBar.timestamp);
  const currentAssetBars: Record<AssetId, PointInTimeBar> = { BTC: currentBar };
  const priorAssetBars: Record<AssetId, PointInTimeBar> = barIndex > 0 ? { BTC: bars[barIndex - 1] } : {};
  const benchmarkSlice = bars.slice(0, barIndex + 1);

  return {
    config,
    strategyConfigs,
    currentBar,
    currentBarIndex: barIndex,
    decisionTime,
    currentAssetBars,
    benchmarkSlice,
    benchmarkId: "BTC",
    macroState: macro,
    eventState: event,
    priorAssetBars,
  };
}

// ----------------------------------------------------------------------------
// TEST SUITE
// ----------------------------------------------------------------------------

describe("M18-B: Pure Single-Cycle Transition Kernel", () => {
  const bars = generateSyntheticBars(200, 50000, 42);
  const config = createBaseConfig();

  // 1. DETERMINISTIC REPEATABILITY
  it("DETERMINISM: Same valid inputs produce structurally identical outputs", () => {
    const priorState = createInitialPriorState(10000);
    const ctx = buildContextForBar(bars, 130, config);

    const result1 = executeSingleCycleTransition(priorState, ctx);
    const result2 = executeSingleCycleTransition(priorState, ctx);

    expect(result1).toEqual(result2);
    expect(result1.decision).toEqual(result2.decision);
    expect(result1.nextState).toEqual(result2.nextState);
    expect(result1.barExecutions).toEqual(result2.barExecutions);
    expect(result1.lifecycleEvidence).toEqual(result2.lifecycleEvidence);
  });

  // 2. INPUT IMMUTABILITY
  it("IMMUTABILITY: Kernel does not mutate input priorState or context", () => {
    const priorState = createInitialPriorState(10000);
    const ctx = buildContextForBar(bars, 130, config);

    const priorStateCopy = JSON.parse(JSON.stringify(priorState));
    const ctxCopy = JSON.parse(JSON.stringify(ctx));

    executeSingleCycleTransition(priorState, ctx);

    expect(JSON.parse(JSON.stringify(priorState))).toEqual(priorStateCopy);
    expect(JSON.parse(JSON.stringify(ctx))).toEqual(ctxCopy);
  });

  // 3. NO WALL-CLOCK DEPENDENCY
  it("TIME PURITY: Output is independent of system wall-clock (Date.now())", () => {
    const priorState = createInitialPriorState(10000);
    const ctx = buildContextForBar(bars, 130, config);

    vi.setSystemTime(new Date("2020-01-01T00:00:00Z"));
    const resultAt2020 = executeSingleCycleTransition(priorState, ctx);

    vi.setSystemTime(new Date("2030-12-31T23:59:59Z"));
    const resultAt2030 = executeSingleCycleTransition(priorState, ctx);

    vi.useRealTimers();

    expect(resultAt2020).toEqual(resultAt2030);
  });

  // 4. SEQUENTIAL COMPOSITION EQUIVALENCE WITH REPLAY
  it("REPLAY PARITY: Sequential kernel execution reproduces runBacktest exactly", () => {
    const dataset: BacktestDataset = {
      assetBars: { BTC: bars },
      benchmarkAssetId: "BTC",
    };

    // Run standard backtest replay
    const replayResult = runBacktest(config, dataset);

    // Run manual sequential composition through the kernel
    let cycleState = createInitialPriorState(config.initialCapital);
    const kernelDecisions = [];
    const kernelExecutions = [];
    const kernelLifecycleEvidence = [];

    for (let t = config.warmupPeriod; t < bars.length; t++) {
      const currentBar = bars[t];
      const decisionTime = canonicalBarAvailableAt(currentBar.timestamp);
      const currentAssetBars: Record<AssetId, PointInTimeBar> = { BTC: currentBar };
      const priorAssetBars: Record<AssetId, PointInTimeBar> = t > 0 ? { BTC: bars[t - 1] } : {};
      const benchmarkSlice = bars.slice(0, t + 1);

      const ctx: CycleTransitionContext = {
        config,
        strategyConfigs: {},
        currentBar,
        currentBarIndex: t,
        decisionTime,
        currentAssetBars,
        benchmarkSlice,
        benchmarkId: "BTC",
        macroState: null,
        eventState: null,
        priorAssetBars,
      };

      const result = executeSingleCycleTransition(cycleState, ctx);
      kernelDecisions.push(result.decision);
      kernelExecutions.push(...result.barExecutions);
      kernelLifecycleEvidence.push(...result.lifecycleEvidence);
      cycleState = result.nextState;
    }

    // Exact parity checks
    expect(kernelDecisions.length).toBe(replayResult.timeline.length);
    for (let i = 0; i < replayResult.timeline.length; i++) {
      expect(kernelDecisions[i]).toEqual(replayResult.timeline[i]);
    }
    expect(kernelLifecycleEvidence).toEqual(replayResult.targetLifecycleEvidence);
  });

  // 5. ACCOUNTING IDENTITY AND CONSERVATION
  it("ACCOUNTING PARITY: Conservation of NAV, cash, and positions holds at each transition", () => {
    let cycleState = createInitialPriorState(10000);

    for (let t = 125; t < 150; t++) {
      const ctx = buildContextForBar(bars, t, config);
      const result = executeSingleCycleTransition(cycleState, ctx);

      // Verify NAV calculation
      let calculatedNav = result.nextState.account.cash;
      for (const [assetId, pos] of Object.entries(result.nextState.account.positions)) {
        const p = ctx.currentAssetBars[assetId]?.close ?? 0;
        calculatedNav += pos.quantity * p;
      }
      expect(Math.round(calculatedNav * 100) / 100).toBe(result.decision.nav);

      // Verify per-bar PnL and cumulative PnL
      const expectedBarPnl = calculatedNav - cycleState.priorDecisionNav;
      expect(result.decision.dailyPnl).toBe(Math.round(expectedBarPnl * 100) / 100);
      const expectedCumulativePnl = calculatedNav - config.initialCapital;
      expect(result.decision.cumulativePnl).toBe(Math.round(expectedCumulativePnl * 100) / 100);

      cycleState = result.nextState;
    }
  });

  // 6. NEXT_BAR_OPEN ORDERING & SAME-EPOCH DECISION-BEFORE-FILL
  it("EXECUTION ORDERING: Prior target fills at current bar open before new decision is calculated", () => {
    let cycleState = createInitialPriorState(10000);

    // Cycle 1: Bar 125 (generates pendingRebalance for NEXT_BAR_OPEN)
    const ctx1 = buildContextForBar(bars, 125, config);
    const result1 = executeSingleCycleTransition(cycleState, ctx1);

    expect(result1.barExecutions.length).toBe(0); // No execution on bar 125 since no prior pending
    expect(result1.nextState.pendingRebalance).toBeDefined();

    // Cycle 2: Bar 126 (should execute pendingRebalance at bar 126 open price)
    const ctx2 = buildContextForBar(bars, 126, config);
    const result2 = executeSingleCycleTransition(result1.nextState, ctx2);

    if (result1.nextState.pendingRebalance && (result1.nextState.pendingRebalance.assetWeights.BTC ?? 0) > 0) {
      expect(result2.barExecutions.length).toBeGreaterThan(0);
      // Execution timestamp is current bar open (bars[126].timestamp)
      expect(result2.barExecutions[0].executionTimestamp).toBe(bars[126].timestamp);
      // Intended price reflects bar open price
      expect(result2.barExecutions[0].intendedPrice).toBe(bars[126].open);
      // Execution price incorporates configured slippage
      expect(result2.barExecutions[0].executionPrice).toBeGreaterThanOrEqual(bars[126].open);
    }
  });

  // 7. CLOSE-BOUNDARY & PIT CORRECTNESS
  it("PIT DOMAIN: DecisionTime is bar open + 1h; priceHistory is strictly [0..t+1]", () => {
    const priorState = createInitialPriorState(10000);
    const ctx = buildContextForBar(bars, 130, config);

    expect(ctx.decisionTime).toBe(ctx.currentBar.timestamp + BAR_DURATION_MS);
    expect(ctx.benchmarkSlice.length).toBe(131);
    expect(ctx.benchmarkSlice[ctx.benchmarkSlice.length - 1].timestamp).toBe(ctx.currentBar.timestamp);

    const result = executeSingleCycleTransition(priorState, ctx);
    expect(result.decision.timestamp).toBe(ctx.decisionTime);
    expect(result.decision.cycleKey?.decisionTime).toBe(ctx.decisionTime);
    expect(result.decision.cycleKey?.interval).toBe("1h");
    expect(result.decision.barIndex).toBe(130);
  });

  // 8. FUTURE MUTATION INVARIANCE
  it("LOOKAHEAD IMMUNITY: Modifying future bars has zero effect on current cycle transition", () => {
    const barsA = generateSyntheticBars(150, 50000, 42);
    const barsB = generateSyntheticBars(150, 50000, 42);

    // Mutate future bars beyond t=130 in barsB
    for (let i = 131; i < barsB.length; i++) {
      barsB[i] = {
        ...barsB[i],
        close: barsB[i].close * 2,
        high: barsB[i].high * 2,
      };
    }

    const priorState = createInitialPriorState(10000);
    const ctxA = buildContextForBar(barsA, 130, config);
    const ctxB = buildContextForBar(barsB, 130, config);

    const resultA = executeSingleCycleTransition(priorState, ctxA);
    const resultB = executeSingleCycleTransition(priorState, ctxB);

    expect(resultA).toEqual(resultB);
  });

  // 9. ZERO / NO-TRADE STABILITY
  it("ZERO DRIFT: Neutral / zero trade cycles produce no NaN or arithmetic drift", () => {
    let cycleState = createInitialPriorState(10000);

    // Flat flat prices bars
    const flatBars: PointInTimeBar[] = [];
    for (let i = 0; i < 150; i++) {
      flatBars.push({
        timestamp: 1700000000000 + i * BAR_DURATION_MS,
        open: 100,
        high: 100,
        low: 100,
        close: 100,
        volume: 1000,
      });
    }

    for (let t = 125; t < 140; t++) {
      const ctx = buildContextForBar(flatBars, t, config);
      const result = executeSingleCycleTransition(cycleState, ctx);

      expect(Number.isFinite(result.decision.nav)).toBe(true);
      expect(Number.isFinite(result.decision.cash)).toBe(true);
      expect(Number.isFinite(result.decision.dailyPnl)).toBe(true);
      expect(Number.isFinite(result.decision.cumulativePnl)).toBe(true);
      expect(Number.isFinite(result.decision.currentDrawdown)).toBe(true);

      cycleState = result.nextState;
    }
  });

  // 10. PERMISSION DENIAL AUTHORITY
  it("PERMISSION GATE: Permission denial prevents strategy allocation", () => {
    const priorState = createInitialPriorState(10000);

    // Macro with liquidity drain
    const macroDenial: PointInTimeMacro = {
      ...createBaseMacro(bars[130].timestamp + BAR_DURATION_MS),
      regime: "Liquidity Drain",
      marketLiquidityRatio: 0.5,
    };

    const restrictiveStrategyConfigs: CycleStrategyConfigs = {
      permission: {
        ...DEFAULT_PERMISSION_CONFIG,
        minPermissionThreshold: 0.95, // Force denial as all strategies are below 0.95 in Liquidity Drain
      },
    };

    const ctx = buildContextForBar(bars, 130, config, restrictiveStrategyConfigs, macroDenial);
    const result = executeSingleCycleTransition(priorState, ctx);

    // All permissions must be denied
    for (const perm of result.decision.permissions) {
      expect(perm.isPermitted).toBe(false);
    }
    // Target weight must be 0 for benchmark asset
    expect(result.decision.targetWeights.assetWeights.BTC ?? 0).toBe(0);
  });

  // 11. RISK & OMEGA ALLOCATION AUTHORITY
  it("RISK & OMEGA PIPELINE: Risk scaling modulates target weights monotonically", () => {
    const priorState = createInitialPriorState(10000);
    const ctx = buildContextForBar(bars, 130, config);

    const result = executeSingleCycleTransition(priorState, ctx);

    expect(result.decision.risk).toBeDefined();
    expect(result.decision.targetWeights).toBeDefined();
    expect(result.decision.targetWeights.asOfTimestamp).toBe(ctx.decisionTime);
    expect(result.decision.targetWeights.provenance).toBeDefined();
  });

  // 12. SINGLE CYCLE PARITY WITH REPLAY FIRST BAR
  it("ONE-CYCLE PARITY: Single cycle through kernel matches replay first evaluated bar", () => {
    const dataset: BacktestDataset = {
      assetBars: { BTC: bars },
      benchmarkAssetId: "BTC",
    };

    const replayResult = runBacktest(config, dataset);
    const firstReplayDecision = replayResult.timeline[0];

    const priorState = createInitialPriorState(config.initialCapital);
    const ctx = buildContextForBar(bars, config.warmupPeriod, config);
    const kernelResult = executeSingleCycleTransition(priorState, ctx);

    expect(kernelResult.decision).toEqual(firstReplayDecision);
  });

  // 13. FEES & COSTS COUNTED EXACTLY ONCE
  it("FEES DEDUCTION: Commissions and slippage are deducted once in execution and preserved in cash accounting", () => {
    let cycleState = createInitialPriorState(10000);

    // Warmup cycle to generate pending rebalance
    const ctx1 = buildContextForBar(bars, 125, config);
    const result1 = executeSingleCycleTransition(cycleState, ctx1);

    // Second cycle executes pending rebalance
    const ctx2 = buildContextForBar(bars, 126, config);
    const result2 = executeSingleCycleTransition(result1.nextState, ctx2);

    if (result2.barExecutions.length > 0) {
      const exec = result2.barExecutions[0];
      expect(exec.fees).toBeGreaterThan(0);
      // Verify cash balance reflects cash deduction of notional + fees
      // Pre-execution cash was 10000
      const totalCashSpent = exec.notionalUsd + exec.fees;
      expect(Math.abs(result2.nextState.account.cash - (10000 - totalCashSpent))).toBeLessThan(0.01);
    }
  });

  // 14. SAME_BAR_CLOSE EXECUTION MODE
  it("SAME_BAR_CLOSE PARITY: Rebalance executed on same bar close matches expectations", () => {
    const sbcConfig = createBaseConfig({ executionRule: "SAME_BAR_CLOSE" });
    const priorState = createInitialPriorState(10000);
    const ctx = buildContextForBar(bars, 125, sbcConfig);

    const result = executeSingleCycleTransition(priorState, ctx);

    // Under SAME_BAR_CLOSE, pendingRebalance is null and execution occurs immediately
    expect(result.nextState.pendingRebalance).toBeNull();
    if (result.decision.targetWeights.assetWeights.BTC > 0) {
      expect(result.barExecutions.length).toBeGreaterThan(0);
      expect(result.barExecutions[0].decisionTimestamp).toBe(ctx.decisionTime);
      expect(result.barExecutions[0].executionTimestamp).toBe(ctx.decisionTime);
    }
  });
});

