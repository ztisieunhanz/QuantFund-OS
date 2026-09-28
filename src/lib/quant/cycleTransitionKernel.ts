// ============================================================================
// FILE: src/lib/quant/cycleTransitionKernel.ts
// MODULE: PURE SINGLE-CYCLE TRANSITION KERNEL
// PURPOSE: The canonical deterministic financial state transition for one
//          canonical 1H bar/cycle. Used by historical replay (backtestEngine)
//          and later by operational cycle orchestration (M18-D).
//
// CONTRACT:
//   PriorCycleState + CanonicalBar + explicit context/config/evidence
//   → CycleTransitionResult
//
// PURITY INVARIANTS:
//   - NO network/filesystem I/O
//   - NO localStorage/sessionStorage
//   - NO Zustand/global store mutation
//   - NO React dependency
//   - NO wall-clock Date.now()
//   - NO timers or random nondeterminism
//   - NO hidden mutable singleton state
//   - All required time/config/state/evidence arrives through inputs
//   - Same valid inputs → structurally equivalent financial outputs
//
// AUTHORITY:
//   Signal ≠ Permission ≠ Risk ≠ Allocation ≠ Execution
//   Risk/Omega retain sizing/allocation authority.
//   Execution retains fill authority.
//   Accounting state is financial truth.
//   ActionDecision remains downstream/derived.
// ============================================================================

import type {
  AssetId,
  BacktestConfig,
  DecisionState,
  ExecutionRecord,
  PointInTimeBar,
  PointInTimeEvent,
  PointInTimeMacro,
  PositionRecord,
  SignalOutput,
  StrategyId,
  StrategyState,
  ProvenancedTargetPortfolioWeight,
} from "@/lib/quant/types";

import { evaluateAdaptiveTrend, updateAdaptiveTrendState, type AdaptiveTrendConfig } from "@/lib/quant/adaptiveTrend";
import { evaluateEventReaction, updateEventReactionState, type EventReactionConfig } from "@/lib/quant/eventReaction";
import { evaluateMeanReversion, updateMeanReversionState, type MeanReversionConfig } from "@/lib/quant/meanReversion";
import { evaluatePermission, type PermissionGateConfig } from "@/lib/quant/permissionGate";
import { evaluatePortfolioRisk, type RiskEngineConfig, type RiskEngineState } from "@/lib/quant/riskEngine";
import { evaluateOmegaAllocation, type OmegaAllocatorConfig } from "@/lib/quant/omegaAllocator";
import {
  executeRebalance,
  type ExecutionContext,
  type ExecutionEngineResult,
  type PortfolioAccountState,
} from "@/lib/quant/executionEngine";
import {
  createCanonicalPortfolioValuationSnapshot,
  type CanonicalPortfolioValuationSnapshot,
} from "@/lib/quant/portfolioValuation";
import { BAR_DURATION_MS, canonicalBarAvailableAt } from "@/lib/quant/timeDomain";
import { createCycleKey } from "@/lib/quant/operationalPaperContract";
import type { HistoricalContextAtTime } from "@/lib/quant/historicalPit";
import {
  advanceActiveTargetLifecycle,
  createActiveTargetLifecycleRoot,
  createExecutionBoundTargetAssessment,
  createTargetExecutionAssessment,
  reconcileActiveTargetLifecycleExecution,
  type ActiveTargetLifecycle,
} from "@/lib/quant/targetExecutionLifecycle";
export interface CycleStrategyConfigs {
  readonly trend?: AdaptiveTrendConfig;
  readonly event?: EventReactionConfig;
  readonly meanReversion?: MeanReversionConfig;
  readonly permission?: PermissionGateConfig;
  readonly risk?: RiskEngineConfig;
  readonly omega?: OmegaAllocatorConfig;
}

export type BacktestStrategyConfigs = CycleStrategyConfigs;

// ============================================================================
// STATE BOUNDARY: Minimum explicit state to advance exactly one cycle
// ============================================================================

/** Mutable state carried between cycles. All fields are explicit. */
export interface PriorCycleState {
  readonly account: PortfolioAccountState;
  readonly riskState: RiskEngineState;
  readonly peakNav: number;
  readonly strategyStates: Readonly<Record<StrategyId, StrategyState>>;
  readonly pendingRebalance: ProvenancedTargetPortfolioWeight | null;
  readonly activeTargetLifecycle: ActiveTargetLifecycle | null;
  /** NAV of the prior decision for per-bar PnL calculation.
   *  For the very first cycle this equals initialCapital. */
  readonly priorDecisionNav: number;
}

// ============================================================================
// CONTEXT: All non-state inputs that the kernel needs for one cycle
// ============================================================================

/** Explicit context for one cycle — no hidden global queries. */
export interface CycleTransitionContext {
  readonly config: BacktestConfig;
  readonly strategyConfigs: BacktestStrategyConfigs;
  /** The bar at index t whose close boundary is the decision point. */
  readonly currentBar: PointInTimeBar;
  /** The bar index in the original dataset (for barIndex in DecisionState). */
  readonly currentBarIndex: number;
  /** Decision time = canonicalBarAvailableAt(currentBar.timestamp). Pre-computed by caller. */
  readonly decisionTime: number;
  /** All asset bars at the current bar index t. */
  readonly currentAssetBars: Readonly<Record<AssetId, PointInTimeBar>>;
  /** Benchmark price history slice [0..t+1) for indicator/risk calculations. */
  readonly benchmarkSlice: readonly PointInTimeBar[];
  /** Benchmark asset identifier. */
  readonly benchmarkId: AssetId;
  /** PIT macro state at decisionTime. */
  readonly macroState: PointInTimeMacro | null;
  /** PIT event state at decisionTime. */
  readonly eventState: PointInTimeEvent | null;
  /** PIT historical context at decisionTime, if available. */
  readonly historicalContext?: HistoricalContextAtTime;
  /**
   * For lifecycle execution marks: the prior bar for each held asset
   * (only the bar at index t-1, needed for post-execution valuation).
   * Maps assetId → bar at t-1 (if available).
   */
  readonly priorAssetBars: Readonly<Record<AssetId, PointInTimeBar>>;
}

// ============================================================================
// RESULT: All outputs from one cycle transition
// ============================================================================

/** Output of a single cycle transition. Immutable. */
export interface CycleTransitionResult {
  /** Updated state to pass to the next cycle. */
  readonly nextState: PriorCycleState;
  /** The DecisionState for this cycle (appended to timeline by orchestrator). */
  readonly decision: DecisionState;
  /** Execution records produced at this bar's open (from prior pending rebalance). */
  readonly barExecutions: readonly ExecutionRecord[];
  /** Lifecycle evidence snapshots produced during this cycle. */
  readonly lifecycleEvidence: readonly ActiveTargetLifecycle[];
}

// ============================================================================
// INTERNAL HELPERS
// ============================================================================

interface PendingCanonicalExecutionEvidence {
  readonly lifecycle: ActiveTargetLifecycle;
  readonly target: ProvenancedTargetPortfolioWeight;
  readonly preExecutionAccount: PortfolioAccountState;
  readonly assetBars: Readonly<Record<AssetId, PointInTimeBar>>;
  readonly context: ExecutionContext;
  readonly executionResult: ExecutionEngineResult;
}

function stripTransientLifecycleBinding(record: ExecutionRecord): ExecutionRecord {
  const { lifecycleBinding: _transientLifecycleBinding, ...durableRecord } = record;
  return durableRecord;
}

export class TemporalAuthorityViolationError extends Error {
  constructor(message: string) {
    super(`Temporal Authority Violation: ${message}`);
    this.name = "TemporalAuthorityViolationError";
  }
}

/**
 * Fail-closed validator for single-cycle context temporal authority.
 * Validates that all evidence consumed for this cycle satisfies canonical point-in-time rules.
 */
export function validateCycleTransitionContext(ctx: CycleTransitionContext): void {
  const { currentBar, decisionTime, benchmarkSlice,
          currentAssetBars, priorAssetBars, macroState, eventState,
          historicalContext } = ctx;

  // A. Current Bar and Decision Boundary
  if (!currentBar || !Number.isFinite(currentBar.timestamp)) {
    throw new TemporalAuthorityViolationError("currentBar is missing or has non-finite timestamp.");
  }
  const expectedDecisionTime = canonicalBarAvailableAt(currentBar.timestamp);
  if (decisionTime !== expectedDecisionTime) {
    throw new TemporalAuthorityViolationError(
      `decisionTime (${decisionTime}) must equal canonicalBarAvailableAt(currentBar.timestamp) (${expectedDecisionTime}) for bar at ${currentBar.timestamp}.`
    );
  }

  // B. Benchmark Slice
  if (!benchmarkSlice || benchmarkSlice.length === 0) {
    throw new TemporalAuthorityViolationError("benchmarkSlice must be a non-empty array of historical bars.");
  }
  const terminalBenchmarkBar = benchmarkSlice[benchmarkSlice.length - 1];
  if (terminalBenchmarkBar.timestamp !== currentBar.timestamp) {
    throw new TemporalAuthorityViolationError(
      `Terminal benchmark bar timestamp (${terminalBenchmarkBar.timestamp}) does not match currentBar timestamp (${currentBar.timestamp}).`
    );
  }
  for (let i = 0; i < benchmarkSlice.length; i++) {
    const bar = benchmarkSlice[i];
    if (!Number.isFinite(bar.timestamp)) {
      throw new TemporalAuthorityViolationError(`Benchmark bar at index ${i} has non-finite timestamp.`);
    }
    if (bar.timestamp > currentBar.timestamp) {
      throw new TemporalAuthorityViolationError(
        `Benchmark bar at index ${i} has future timestamp (${bar.timestamp}) exceeding currentBar (${currentBar.timestamp}).`
      );
    }
    if (canonicalBarAvailableAt(bar.timestamp) > decisionTime) {
      throw new TemporalAuthorityViolationError(
        `Benchmark bar at index ${i} (open=${bar.timestamp}) is unavailable at decisionTime (${decisionTime}).`
      );
    }
    if (i > 0 && bar.timestamp <= benchmarkSlice[i - 1].timestamp) {
      throw new TemporalAuthorityViolationError(
        `Benchmark slice is not strictly ascending at index ${i} (${benchmarkSlice[i - 1].timestamp} -> ${bar.timestamp}).`
      );
    }
  }

  // C. Current Asset Bars
  if (!currentAssetBars || typeof currentAssetBars !== "object") {
    throw new TemporalAuthorityViolationError("currentAssetBars must be a valid mapping of asset bars.");
  }
  for (const [assetId, bar] of Object.entries(currentAssetBars)) {
    if (!bar || !Number.isFinite(bar.timestamp)) {
      throw new TemporalAuthorityViolationError(`Current asset bar for "${assetId}" is invalid or non-finite.`);
    }
    if (bar.timestamp !== currentBar.timestamp) {
      throw new TemporalAuthorityViolationError(
        `Current asset bar for "${assetId}" timestamp (${bar.timestamp}) does not match current cycle bar (${currentBar.timestamp}).`
      );
    }
    if (canonicalBarAvailableAt(bar.timestamp) > decisionTime) {
      throw new TemporalAuthorityViolationError(
        `Current asset bar for "${assetId}" is unavailable at decisionTime (${decisionTime}).`
      );
    }
  }

  // D. Prior Asset Bars
  if (priorAssetBars && typeof priorAssetBars === "object") {
    for (const [assetId, bar] of Object.entries(priorAssetBars)) {
      if (!bar || !Number.isFinite(bar.timestamp)) {
        throw new TemporalAuthorityViolationError(`Prior asset bar for "${assetId}" is invalid or non-finite.`);
      }
      if (bar.timestamp >= currentBar.timestamp) {
        throw new TemporalAuthorityViolationError(
          `Prior asset bar for "${assetId}" timestamp (${bar.timestamp}) must strictly precede currentBar (${currentBar.timestamp}).`
        );
      }
      if (canonicalBarAvailableAt(bar.timestamp) > currentBar.timestamp) {
        throw new TemporalAuthorityViolationError(
          `Prior asset bar for "${assetId}" was not closed and available before currentBar open (${currentBar.timestamp}).`
        );
      }
    }
  }

  // E. Macro State
  if (macroState) {
    if (!Number.isFinite(macroState.asOfTimestamp)) {
      throw new TemporalAuthorityViolationError("macroState has non-finite asOfTimestamp.");
    }
    if (macroState.asOfTimestamp > decisionTime) {
      throw new TemporalAuthorityViolationError(
        `macroState asOfTimestamp (${macroState.asOfTimestamp}) is in the future relative to decisionTime (${decisionTime}).`
      );
    }
  }

  // F. Event State
  if (eventState) {
    if (!Number.isFinite(eventState.publicationTimestamp) || !Number.isFinite(eventState.consensusSnapshotTimestamp)) {
      throw new TemporalAuthorityViolationError("eventState has non-finite publication or consensus timestamps.");
    }
    if (eventState.publicationTimestamp > decisionTime) {
      throw new TemporalAuthorityViolationError(
        `eventState publicationTimestamp (${eventState.publicationTimestamp}) exceeds decisionTime (${decisionTime}).`
      );
    }
    if (eventState.consensusSnapshotTimestamp > decisionTime) {
      throw new TemporalAuthorityViolationError(
        `eventState consensusSnapshotTimestamp (${eventState.consensusSnapshotTimestamp}) exceeds decisionTime (${decisionTime}).`
      );
    }
  }

  // G. Historical Context
  if (historicalContext) {
    if (historicalContext.decisionTime !== decisionTime) {
      throw new TemporalAuthorityViolationError(
        `historicalContext.decisionTime (${historicalContext.decisionTime}) does not match cycle decisionTime (${decisionTime}).`
      );
    }
    if (historicalContext.market) {
      for (const [seriesId, obs] of Object.entries(historicalContext.market)) {
        if (obs && obs.availableAt > decisionTime) {
          throw new TemporalAuthorityViolationError(
            `historicalContext market observation "${seriesId}" availableAt (${obs.availableAt}) exceeds decisionTime (${decisionTime}).`
          );
        }
      }
    }
    if (historicalContext.macro) {
      for (const [seriesId, rel] of Object.entries(historicalContext.macro)) {
        if (rel && rel.availableAt > decisionTime) {
          throw new TemporalAuthorityViolationError(
            `historicalContext macro release "${seriesId}" availableAt (${rel.availableAt}) exceeds decisionTime (${decisionTime}).`
          );
        }
      }
    }
    if (historicalContext.latestEvent) {
      if (historicalContext.latestEvent.availableAt > decisionTime) {
        throw new TemporalAuthorityViolationError(
          `historicalContext latestEvent availableAt (${historicalContext.latestEvent.availableAt}) exceeds decisionTime (${decisionTime}).`
        );
      }
      if (
        historicalContext.latestEvent.consensusFrozenAt !== null &&
        historicalContext.latestEvent.consensusFrozenAt > decisionTime
      ) {
        throw new TemporalAuthorityViolationError(
          `historicalContext latestEvent consensusFrozenAt (${historicalContext.latestEvent.consensusFrozenAt}) exceeds decisionTime (${decisionTime}).`
        );
      }
    }
  }
}

// ============================================================================
// THE PURE SINGLE-CYCLE TRANSITION
// ============================================================================

/**
 * Execute exactly ONE canonical 1H cycle transition.
 *
 * This is the only financial state transition function. Historical replay
 * and (later) operational orchestration both compose this kernel.
 *
 * PURITY: This function is deterministic and side-effect free.
 * Same valid inputs → structurally equivalent financial outputs.
 */
export function executeSingleCycleTransition(
  priorState: PriorCycleState,
  ctx: CycleTransitionContext,
): CycleTransitionResult {
  // Fail-closed temporal boundary validation
  validateCycleTransitionContext(ctx);

  const { config, strategyConfigs, currentBar, currentBarIndex, decisionTime,
          currentAssetBars, benchmarkSlice, benchmarkId, macroState, eventState,
          historicalContext, priorAssetBars } = ctx;

  // Working copies of mutable state
  let account = priorState.account;
  let peakNav = priorState.peakNav;
  let activeTargetLifecycle = priorState.activeTargetLifecycle;
  const strategyStates: Record<StrategyId, StrategyState> = { ...priorState.strategyStates };
  const lifecycleEvidence: ActiveTargetLifecycle[] = [];

  // ========================================================================
  // A. EXECUTE PENDING REBALANCE AT NEXT_BAR_OPEN
  // ========================================================================
  let barExecutions: ExecutionRecord[] = [];
  let pendingCanonicalExecutionEvidence: PendingCanonicalExecutionEvidence | null = null;

  if (config.executionRule === "NEXT_BAR_OPEN" && priorState.pendingRebalance) {
    const preExecutionAccount = account;
    const executionContext: ExecutionContext = {
      decisionTimestamp: priorState.pendingRebalance.asOfTimestamp,
      executionTimestamp: currentBar.timestamp,
      executionRule: "NEXT_BAR_OPEN",
      commissionRate: config.commissionRate,
      slippageConfig: config.slippageModel,
      ...(activeTargetLifecycle ? {
        lifecycleBinding: {
          targetDecisionIdentity: priorState.pendingRebalance.provenance.targetDecisionIdentity,
          activeTargetRootIdentity: activeTargetLifecycle.activeTargetRootIdentity,
        },
      } : {}),
    };
    const execResult = executeRebalance(
      account,
      priorState.pendingRebalance,
      currentAssetBars,
      executionContext,
    );
    if (activeTargetLifecycle) {
      pendingCanonicalExecutionEvidence = {
        lifecycle: activeTargetLifecycle,
        target: priorState.pendingRebalance,
        preExecutionAccount,
        assetBars: currentAssetBars,
        context: executionContext,
        executionResult: execResult,
      };
    }
    account = execResult.updatedAccount;
    barExecutions = execResult.records.map(stripTransientLifecycleBinding);

    if (config.dataQuality === "LIVE" && activeTargetLifecycle) {
      const executionMarks = Object.entries(account.positions)
        .filter(([, position]) => position.quantity > 0)
        .flatMap(([assetId]) => {
          const priorBar = priorAssetBars[assetId];
          const completedBar = priorBar && priorBar.timestamp + BAR_DURATION_MS === currentBar.timestamp ? priorBar : undefined;
          return completedBar ? [{ assetId, bar: completedBar }] : [];
        });
      const postExecutionValuation = createCanonicalPortfolioValuationSnapshot({
        decisionTime: currentBar.timestamp,
        account,
        marks: executionMarks,
        dataQuality: config.dataQuality,
      });
      const executionAssessment = createExecutionBoundTargetAssessment({
        activeTargetRootIdentity: pendingCanonicalExecutionEvidence!.lifecycle.activeTargetRootIdentity,
        target: pendingCanonicalExecutionEvidence!.target,
        preExecutionAccount: pendingCanonicalExecutionEvidence!.preExecutionAccount,
        assetBars: pendingCanonicalExecutionEvidence!.assetBars,
        context: pendingCanonicalExecutionEvidence!.context,
        executionResult: pendingCanonicalExecutionEvidence!.executionResult,
        postExecutionValuation,
      });
      activeTargetLifecycle = reconcileActiveTargetLifecycleExecution(
        pendingCanonicalExecutionEvidence!.lifecycle,
        executionAssessment,
      );
      lifecycleEvidence.push(activeTargetLifecycle);
    }
  }

  // ========================================================================
  // B-C. EVALUATE 3 STRATEGIES USING PIT CONTEXT
  // ========================================================================
  const trendCtx = {
    strategyId: "ADAPTIVE_TREND" as StrategyId,
    assetId: benchmarkId,
    currentBarTimestamp: decisionTime,
    decisionTimestamp: decisionTime,
    currentPrice: currentBar.close,
    priceHistory: benchmarkSlice,
    macro: macroState,
    latestEvent: eventState,
  };
  const trendSignal = evaluateAdaptiveTrend(trendCtx, strategyStates.ADAPTIVE_TREND, strategyConfigs.trend);
  strategyStates.ADAPTIVE_TREND = updateAdaptiveTrendState(trendCtx, strategyStates.ADAPTIVE_TREND, trendSignal);

  const eventCtx = {
    strategyId: "EVENT_REACTION" as StrategyId,
    assetId: benchmarkId,
    currentBarTimestamp: decisionTime,
    decisionTimestamp: decisionTime,
    currentPrice: currentBar.close,
    priceHistory: benchmarkSlice,
    macro: macroState,
    latestEvent: eventState,
  };
  const eventSignal = evaluateEventReaction(eventCtx, strategyStates.EVENT_REACTION, strategyConfigs.event);
  strategyStates.EVENT_REACTION = updateEventReactionState(eventCtx, strategyStates.EVENT_REACTION, eventSignal);

  const mrCtx = {
    strategyId: "MEAN_REVERSION" as StrategyId,
    assetId: benchmarkId,
    currentBarTimestamp: decisionTime,
    decisionTimestamp: decisionTime,
    currentPrice: currentBar.close,
    priceHistory: benchmarkSlice,
    macro: macroState,
    latestEvent: eventState,
  };
  const mrSignal = evaluateMeanReversion(mrCtx, strategyStates.MEAN_REVERSION, strategyConfigs.meanReversion);
  strategyStates.MEAN_REVERSION = updateMeanReversionState(mrCtx, strategyStates.MEAN_REVERSION, mrSignal);

  const signals: readonly SignalOutput[] = [trendSignal, eventSignal, mrSignal];

  // ========================================================================
  // D. PERMISSION GATE
  // ========================================================================
  const permissions = [
    evaluatePermission("ADAPTIVE_TREND", macroState, strategyConfigs.permission, decisionTime),
    evaluatePermission("EVENT_REACTION", macroState, strategyConfigs.permission, decisionTime),
    evaluatePermission("MEAN_REVERSION", macroState, strategyConfigs.permission, decisionTime),
  ];

  // ========================================================================
  // E. RISK ENGINE (HYSTERESIS & VOL FLOOR)
  // ========================================================================
  let valuationSnapshot: CanonicalPortfolioValuationSnapshot | null = null;
  let preAllocNav = account.cash;
  if (config.dataQuality === "LIVE") {
    const marks = Object.entries(account.positions)
      .filter(([, position]) => position.quantity > 0)
      .flatMap(([assetId]) => {
        const completedBar = currentAssetBars[assetId];
        if (!completedBar || completedBar.timestamp + BAR_DURATION_MS !== decisionTime) return [];
        return completedBar ? [{ assetId, bar: completedBar }] : [];
      });
    valuationSnapshot = createCanonicalPortfolioValuationSnapshot({
      decisionTime,
      account,
      marks,
      dataQuality: config.dataQuality,
    });
    preAllocNav = valuationSnapshot.nav;
  } else {
    for (const [id, pos] of Object.entries(account.positions)) {
      const p = currentAssetBars[id]?.close ?? 0;
      preAllocNav += pos.quantity * p;
    }
  }
  if (preAllocNav > peakNav) peakNav = preAllocNav;

  const { risk: riskOutput, nextState: updatedRiskState } = evaluatePortfolioRisk(
    preAllocNav,
    peakNav,
    benchmarkSlice,
    priorState.riskState,
    strategyConfigs.risk,
    decisionTime,
    valuationSnapshot
  );

  // ========================================================================
  // F. OMEGA ALLOCATOR
  // ========================================================================
  const targetWeights = evaluateOmegaAllocation(
    signals,
    permissions,
    riskOutput,
    null,
    decisionTime,
    strategyConfigs.omega
  );

  // ========================================================================
  // G. TARGET LIFECYCLE + EXECUTION MODE
  // ========================================================================
  let pendingRebalance: ProvenancedTargetPortfolioWeight | null = null;

  if (valuationSnapshot && config.executionRule === "NEXT_BAR_OPEN") {
    const targetAssessment = createTargetExecutionAssessment({
      valuation: valuationSnapshot,
      target: targetWeights,
    });
    activeTargetLifecycle = activeTargetLifecycle
      ? advanceActiveTargetLifecycle(activeTargetLifecycle, targetAssessment)
      : createActiveTargetLifecycleRoot(targetAssessment);
    lifecycleEvidence.push(activeTargetLifecycle);
  } else {
    activeTargetLifecycle = null;
  }

  if (config.executionRule === "SAME_BAR_CLOSE") {
    const execResult = executeRebalance(
      account,
      targetWeights,
      currentAssetBars,
      {
        decisionTimestamp: decisionTime,
        executionTimestamp: decisionTime,
        executionRule: "SAME_BAR_CLOSE",
        commissionRate: config.commissionRate,
        slippageConfig: config.slippageModel,
      }
    );
    account = execResult.updatedAccount;
    barExecutions = [...execResult.records];
  } else {
    pendingRebalance = targetWeights;
  }

  // ========================================================================
  // H. CLOSE-OF-BAR ACCOUNTING
  // ========================================================================
  let closingNav = account.cash;
  const closingPositions: Record<AssetId, PositionRecord> = {};
  for (const [id, pos] of Object.entries(account.positions)) {
    const p = currentAssetBars[id]?.close ?? 0;
    closingNav += pos.quantity * p;
    if (pos.quantity > 1e-8 && pos.side !== "FLAT") {
      closingPositions[id] = {
        ...pos,
        unrealizedPnl: Math.round((p - pos.entryPrice) * pos.quantity * 100) / 100,
      };
    } else {
      closingPositions[id] = {
        ...pos,
        quantity: 0,
        entryPrice: 0,
        unrealizedPnl: 0,
        side: "FLAT",
        status: "CLOSED",
      };
    }
  }
  account = {
    ...account,
    positions: closingPositions,
  };
  if (closingNav > peakNav) peakNav = closingNav;

  const barPnl = closingNav - priorState.priorDecisionNav;
  const cumulativePnl = closingNav - config.initialCapital;
  const currentDrawdown = peakNav > 0 ? (peakNav - closingNav) / peakNav : 0;

  const decision: DecisionState = {
    barIndex: currentBarIndex,
    timestamp: decisionTime,
    cycleKey: createCycleKey(decisionTime),
    nav: Math.round(closingNav * 100) / 100,
    cash: Math.round(account.cash * 100) / 100,
    positions: { ...account.positions },
    signals,
    permissions,
    risk: riskOutput,
    targetWeights,
    executions: barExecutions,
    dailyPnl: Math.round(barPnl * 100) / 100,
    cumulativePnl: Math.round(cumulativePnl * 100) / 100,
    currentDrawdown: Math.round(currentDrawdown * 10000) / 10000,
    historicalContext,
  };

  const nextState: PriorCycleState = {
    account,
    riskState: updatedRiskState,
    peakNav,
    strategyStates,
    pendingRebalance,
    activeTargetLifecycle,
    priorDecisionNav: decision.nav,
  };

  return {
    nextState,
    decision,
    barExecutions,
    lifecycleEvidence,
  };
}
