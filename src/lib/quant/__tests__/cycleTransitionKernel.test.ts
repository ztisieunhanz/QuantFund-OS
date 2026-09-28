// ============================================================================
// FILE: src/lib/quant/__tests__/cycleTransitionKernel.test.ts
// MODULE: M18-B PURE SINGLE-CYCLE TRANSITION KERNEL TEST SUITE
// PURPOSE: Verify determinism, input immutability, accounting parity,
//          replay composition equivalence, authority invariants, PIT correctness,
//          and fail-closed temporal boundary validation.
// ============================================================================

import { describe, it, expect, vi } from "vitest";
import {
  executeSingleCycleTransition,
  validateCycleTransitionContext,
  TemporalAuthorityViolationError,
  type PriorCycleState,
  type CycleTransitionContext,
  type CycleStrategyConfigs,
} from "../cycleTransitionKernel";
import { runBacktest, type BacktestDataset } from "../backtestEngine";
import { createInitialRiskState, DEFAULT_RISK_ENGINE_CONFIG } from "../riskEngine";
import { DEFAULT_PERMISSION_CONFIG } from "../permissionGate";
import { BAR_DURATION_MS, canonicalBarAvailableAt } from "../timeDomain";
import type {
  AssetId,
  BacktestConfig,
  PointInTimeBar,
  PointInTimeEvent,
  PointInTimeMacro,
} from "../types";
import type { HistoricalContextAtTime } from "../historicalPit";

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

  // 6. NEXT_BAR_OPEN ORDERING & SAME-EPOCH LINEAGE
  it("SAME-EPOCH LINEAGE: Target created at cycle N decision fills at cycle N+1 open before N+1 decision", () => {
    let cycleState = createInitialPriorState(10000);

    // Cycle N: Bar 125 (generates target TN at decisionTime = 125 open + 1h)
    const ctxN = buildContextForBar(bars, 125, config);
    const resultN = executeSingleCycleTransition(cycleState, ctxN);

    expect(resultN.barExecutions.length).toBe(0); // No execution on bar 125 since no prior pending
    const targetN = resultN.nextState.pendingRebalance;
    expect(targetN).not.toBeNull();
    const targetDecisionIdN = targetN?.provenance?.targetDecisionIdentity;
    expect(targetDecisionIdN).toBeDefined();

    // Cycle N+1: Bar 126
    const ctxNPlus1 = buildContextForBar(bars, 126, config);
    const resultNPlus1 = executeSingleCycleTransition(resultN.nextState, ctxNPlus1);

    if (targetN && (targetN.assetWeights.BTC ?? 0) > 0) {
      expect(resultNPlus1.barExecutions.length).toBeGreaterThan(0);
      // Fills at bar 126 open timestamp
      expect(resultNPlus1.barExecutions[0].executionTimestamp).toBe(bars[126].timestamp);
      expect(resultNPlus1.barExecutions[0].intendedPrice).toBe(bars[126].open);
      expect(resultNPlus1.barExecutions[0].executionPrice).toBeGreaterThanOrEqual(bars[126].open);
    }

    // Cycle N+1 decision produces target TN+1 with a distinct decision timestamp and identity
    const targetNPlus1 = resultNPlus1.nextState.pendingRebalance;
    expect(targetNPlus1).not.toBeNull();
    expect(targetNPlus1?.asOfTimestamp).toBe(ctxNPlus1.decisionTime);
    expect(targetNPlus1?.provenance?.targetDecisionIdentity).not.toBe(targetDecisionIdN);

    // Ensure TN+1 was NOT executed in cycle N+1
    for (const exec of resultNPlus1.barExecutions) {
      expect(exec.decisionTimestamp).toBe(ctxN.decisionTime); // Executed order was from cycle N decision
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

  // 11. RISK & OMEGA ALLOCATION AUTHORITY (STRENGTHENED)
  it("RISK & OMEGA PIPELINE: Risk scaling directly bounds and modulates final target weights", () => {
    const priorState = createInitialPriorState(10000);
    const ctxNormal = buildContextForBar(bars, 130, config);

    // Constrained risk configuration with tight maxGrossExposureCap
    const ctxConstrained = buildContextForBar(bars, 130, config, {
      risk: {
        ...DEFAULT_RISK_ENGINE_CONFIG,
        maxGrossExposureCap: 0.20, // Strict cap
      },
    });

    const resultNormal = executeSingleCycleTransition(priorState, ctxNormal);
    const resultConstrained = executeSingleCycleTransition(priorState, ctxConstrained);

    expect(resultNormal.decision.risk).toBeDefined();
    expect(resultConstrained.decision.risk).toBeDefined();

    // The constrained risk engine limits gross exposure to <= 0.20
    expect(resultConstrained.decision.risk.targetExposure).toBeLessThanOrEqual(0.20);
    expect(resultConstrained.decision.targetWeights.grossExposure).toBeLessThanOrEqual(0.2001);

    // Normal allocation vs constrained allocation demonstrates Risk engine authority
    if (resultNormal.decision.targetWeights.assetWeights.BTC > 0.20) {
      expect(resultConstrained.decision.targetWeights.assetWeights.BTC).toBeLessThanOrEqual(0.2001);
      expect(resultConstrained.decision.targetWeights.assetWeights.BTC).toBeLessThan(
        resultNormal.decision.targetWeights.assetWeights.BTC
      );
    }
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

  // ==========================================================================
  // 15-24: ADVERSARIAL TEMPORAL AUTHORITY REJECTION TESTS (FAIL-CLOSED)
  // ==========================================================================

  it("ADVERSARIAL REJECTION: Rejects decisionTime == currentBar.timestamp (premature close boundary)", () => {
    const priorState = createInitialPriorState(10000);
    const validCtx = buildContextForBar(bars, 130, config);
    const invalidCtx: CycleTransitionContext = {
      ...validCtx,
      decisionTime: validCtx.currentBar.timestamp, // Premature!
    };

    expect(() => executeSingleCycleTransition(priorState, invalidCtx)).toThrow(
      TemporalAuthorityViolationError
    );
    expect(() => validateCycleTransitionContext(invalidCtx)).toThrow(
      TemporalAuthorityViolationError
    );
  });

  it("ADVERSARIAL REJECTION: Rejects arbitrary decisionTime not matching canonicalBarAvailableAt", () => {
    const priorState = createInitialPriorState(10000);
    const validCtx = buildContextForBar(bars, 130, config);
    const invalidCtx: CycleTransitionContext = {
      ...validCtx,
      decisionTime: validCtx.decisionTime + 1000, // Delayed / non-canonical!
    };

    expect(() => executeSingleCycleTransition(priorState, invalidCtx)).toThrow(
      TemporalAuthorityViolationError
    );
  });

  it("ADVERSARIAL REJECTION: Rejects benchmarkSlice containing future bar beyond currentBar", () => {
    const priorState = createInitialPriorState(10000);
    const validCtx = buildContextForBar(bars, 130, config);
    const futureBar: PointInTimeBar = {
      timestamp: validCtx.currentBar.timestamp + BAR_DURATION_MS,
      open: 60000,
      high: 61000,
      low: 59000,
      close: 60500,
      volume: 1000,
    };
    const invalidCtx: CycleTransitionContext = {
      ...validCtx,
      benchmarkSlice: [...validCtx.benchmarkSlice, futureBar], // Future bar appended!
    };

    expect(() => executeSingleCycleTransition(priorState, invalidCtx)).toThrow(
      TemporalAuthorityViolationError
    );
  });

  it("ADVERSARIAL REJECTION: Rejects benchmarkSlice where terminal bar does not match currentBar", () => {
    const priorState = createInitialPriorState(10000);
    const validCtx = buildContextForBar(bars, 130, config);
    const invalidCtx: CycleTransitionContext = {
      ...validCtx,
      benchmarkSlice: validCtx.benchmarkSlice.slice(0, validCtx.benchmarkSlice.length - 1), // Truncated!
    };

    expect(() => executeSingleCycleTransition(priorState, invalidCtx)).toThrow(
      TemporalAuthorityViolationError
    );
  });

  it("ADVERSARIAL REJECTION: Rejects currentAssetBars with timestamps not matching currentBar", () => {
    const priorState = createInitialPriorState(10000);
    const validCtx = buildContextForBar(bars, 130, config);
    const invalidCtx: CycleTransitionContext = {
      ...validCtx,
      currentAssetBars: {
        BTC: {
          ...validCtx.currentBar,
          timestamp: validCtx.currentBar.timestamp - BAR_DURATION_MS, // Stale!
        },
      },
    };

    expect(() => executeSingleCycleTransition(priorState, invalidCtx)).toThrow(
      TemporalAuthorityViolationError
    );
  });

  it("ADVERSARIAL REJECTION: Rejects priorAssetBars with future or non-prior timestamps", () => {
    const priorState = createInitialPriorState(10000);
    const validCtx = buildContextForBar(bars, 130, config);
    const invalidCtx: CycleTransitionContext = {
      ...validCtx,
      priorAssetBars: {
        BTC: {
          ...validCtx.currentBar,
          timestamp: validCtx.currentBar.timestamp, // Same as current, not prior!
        },
      },
    };

    expect(() => executeSingleCycleTransition(priorState, invalidCtx)).toThrow(
      TemporalAuthorityViolationError
    );
  });

  it("ADVERSARIAL REJECTION: Rejects macroState with asOfTimestamp in the future (> decisionTime)", () => {
    const priorState = createInitialPriorState(10000);
    const validCtx = buildContextForBar(bars, 130, config);
    const futureMacro: PointInTimeMacro = {
      ...createBaseMacro(validCtx.decisionTime + 24 * BAR_DURATION_MS), // 24h into the future!
    };
    const invalidCtx: CycleTransitionContext = {
      ...validCtx,
      macroState: futureMacro,
    };

    expect(() => executeSingleCycleTransition(priorState, invalidCtx)).toThrow(
      TemporalAuthorityViolationError
    );
  });

  it("ADVERSARIAL REJECTION: Rejects eventState with future publication or consensus timestamps", () => {
    const priorState = createInitialPriorState(10000);
    const validCtx = buildContextForBar(bars, 130, config);
    const futureEvent: PointInTimeEvent = {
      eventId: "FUTURE-EVENT-1",
      eventType: "FED_RATE_DECISION",
      eventTimestamp: validCtx.decisionTime + 3600000,
      publicationTimestamp: validCtx.decisionTime + 3600000, // Future publication!
      consensusSnapshotTimestamp: validCtx.decisionTime,
      actual: 5.25,
      consensus: 5.25,
      previous: 5.0,
      surprise: 0.0,
      sourceQuality: "TIER_1_OFFICIAL",
      noveltyScore: 0.5,
    };
    const invalidCtx: CycleTransitionContext = {
      ...validCtx,
      eventState: futureEvent,
    };

    expect(() => executeSingleCycleTransition(priorState, invalidCtx)).toThrow(
      TemporalAuthorityViolationError
    );
  });

  it("ADVERSARIAL REJECTION: Rejects historicalContext with mismatched decisionTime", () => {
    const priorState = createInitialPriorState(10000);
    const validCtx = buildContextForBar(bars, 130, config);
    const mismatchedHistoricalContext: HistoricalContextAtTime = {
      decisionTime: validCtx.decisionTime - BAR_DURATION_MS, // Mismatched!
      market: {},
      macro: {},
      latestEvent: null,
    };
    const invalidCtx: CycleTransitionContext = {
      ...validCtx,
      historicalContext: mismatchedHistoricalContext,
    };

    expect(() => executeSingleCycleTransition(priorState, invalidCtx)).toThrow(
      TemporalAuthorityViolationError
    );
  });

  it("ADVERSARIAL REJECTION: Rejects historicalContext containing future market observation", () => {
    const priorState = createInitialPriorState(10000);
    const validCtx = buildContextForBar(bars, 130, config);
    const futureMarketHistContext: HistoricalContextAtTime = {
      decisionTime: validCtx.decisionTime,
      market: {
        DXY: {
          seriesId: "DXY",
          value: 104.5,
          observationTime: validCtx.decisionTime,
          availableAt: validCtx.decisionTime + BAR_DURATION_MS, // Future availability!
          provider: "YAHOO",
        },
      },
      macro: {},
      latestEvent: null,
    };
    const invalidCtx: CycleTransitionContext = {
      ...validCtx,
      historicalContext: futureMarketHistContext,
    };

    expect(() => executeSingleCycleTransition(priorState, invalidCtx)).toThrow(
      TemporalAuthorityViolationError
    );
  });
});
