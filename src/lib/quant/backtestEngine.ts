// ============================================================================
// FILE: src/lib/quant/backtestEngine.ts
// MODULE: DETERMINISTIC REPLAY & INTEGRITY-SECURED BACKTEST ENGINE
//
// M18-B: The financial state transition within the replay loop is delegated
// to the pure single-cycle transition kernel (cycleTransitionKernel.ts).
// This file retains replay orchestration: dataset validation, loop iteration,
// date filtering, PIT context assembly, metrics calculation, and result
// assembly. There is NO duplicated financial transition logic.
// ============================================================================

import type {
  AssetId,
  BacktestConfig,
  DecisionState,
  ExecutionRecord,
  PointInTimeBar,
  PointInTimeEvent,
  PointInTimeMacro,
} from "@/lib/quant/types";

import { createInitialRiskState } from "@/lib/quant/riskEngine";
import { reconstructTradeAttribution } from "@/lib/quant/tradeAttribution";
import { BARS_PER_YEAR, ANNUALIZATION_FACTOR, canonicalBarAvailableAt } from "@/lib/quant/timeDomain";
import {
  validateHistoricalDataset,
  normalizeHistoricalDataset,
  buildHistoricalContextAtTime,
  historicalEventToPointInTimeEvent,
  type HistoricalDataset,
  type HistoricalContextAtTime,
} from "@/lib/quant/historicalPit";
import type { ActiveTargetLifecycle } from "@/lib/quant/targetExecutionLifecycle";
import {
  executeSingleCycleTransition,
  type PriorCycleState,
  type BacktestStrategyConfigs,
  type CycleStrategyConfigs,
} from "@/lib/quant/cycleTransitionKernel";

export interface BacktestDataset {
  readonly assetBars: Readonly<Record<AssetId, readonly PointInTimeBar[]>>;
  readonly macroTimeline?: readonly PointInTimeMacro[];
  readonly eventTimeline?: readonly PointInTimeEvent[];
  readonly benchmarkAssetId?: AssetId;
  readonly historicalDataset?: HistoricalDataset;
}

export type { BacktestStrategyConfigs, CycleStrategyConfigs };

export interface BacktestPerformanceMetrics {
  readonly initialNav: number;
  readonly finalNav: number;
  readonly totalReturnPct: number;
  readonly cagrPct: number;
  readonly annualizedSharpeRatio: number;
  readonly annualizedSortinoRatio: number;
  readonly maxDrawdownPct: number;
  readonly calmarRatio: number;
  readonly totalTrades: number;
  readonly closedTradeCount: number;
  readonly roundTripCount: number;
  readonly wins: number;
  readonly losses: number;
  readonly breakEven: number;
  readonly winRatePct: number | null;
  readonly profitFactor: number;
  readonly totalFeesUsd: number;
  readonly totalSlippageCostUsd: number;
  readonly annualTurnoverRatio: number;
}

export interface BacktestResult {
  readonly runId: string;
  readonly config: BacktestConfig;
  readonly timeline: readonly DecisionState[];
  readonly metrics: BacktestPerformanceMetrics;
  readonly totalBarsEvaluated: number;
  /** Transient audit evidence only; never persisted into DecisionState or consumed as authority. */
  readonly targetLifecycleEvidence: readonly ActiveTargetLifecycle[];
}

function getLatestMacroAsOf(
  macroTimeline: readonly PointInTimeMacro[] | undefined,
  timestamp: number
): PointInTimeMacro | null {
  if (!macroTimeline || macroTimeline.length === 0) return null;
  let latest: PointInTimeMacro | null = null;
  for (const m of macroTimeline) {
    if (m.asOfTimestamp <= timestamp) latest = m;
    else break;
  }
  return latest;
}

function getLatestEventAsOf(
  eventTimeline: readonly PointInTimeEvent[] | undefined,
  timestamp: number
): PointInTimeEvent | null {
  if (!eventTimeline || eventTimeline.length === 0) return null;
  let latest: PointInTimeEvent | null = null;
  for (const e of eventTimeline) {
    // Ngăn chặn rò rỉ: cả thời điểm công bố và chốt consensus đều phải <= timestamp hiện tại
    if (e.publicationTimestamp <= timestamp && e.consensusSnapshotTimestamp <= timestamp) {
      latest = e;
    } else {
      break;
    }
  }
  return latest;
}

export function runBacktest(
  config: BacktestConfig,
  dataset: BacktestDataset,
  strategyConfigs: BacktestStrategyConfigs = {}
): BacktestResult {
  if (config.requirePitExecution && config.executionRule === "SAME_BAR_CLOSE") {
    throw new Error(
      "BacktestEngine Error: SAME_BAR_CLOSE is a theoretical benchmark mode and is NOT PIT-safe executable logic. Use NEXT_BAR_OPEN for PIT-safe execution."
    );
  }

  // Fail-closed validation and deterministic normalization of HistoricalDataset (Gate M12E)
  let normalizedHistorical: HistoricalDataset | undefined;
  if (dataset.historicalDataset) {
    validateHistoricalDataset(dataset.historicalDataset);
    normalizedHistorical = normalizeHistoricalDataset(dataset.historicalDataset);
  }

  const assetIds = Object.keys(dataset.assetBars) as AssetId[];
  if (assetIds.length === 0) {
    throw new Error("BacktestEngine Error: Dataset contains no asset bars.");
  }

  for (const id of assetIds) {
    const bars = dataset.assetBars[id];
    if (!bars) continue;
    for (let i = 0; i < bars.length; i++) {
      const ts = bars[i].timestamp;
      if (!Number.isFinite(ts)) {
        throw new Error(`BacktestEngine Error: Non-finite timestamp found for asset "${id}" at index ${i}.`);
      }
      if (i > 0) {
        const prevTs = bars[i - 1].timestamp;
        if (ts <= prevTs) {
          if (ts === prevTs) {
            throw new Error(`BacktestEngine Error: Duplicate timestamp ${ts} found for asset "${id}" at index ${i}.`);
          } else {
            throw new Error(`BacktestEngine Error: Unsorted/descending timestamp (${prevTs} -> ${ts}) found for asset "${id}" at index ${i}.`);
          }
        }
      }
    }
  }

  const benchmarkId = dataset.benchmarkAssetId ?? assetIds[0];
  const primaryBars = dataset.assetBars[benchmarkId];

  // KHÓA CỨNG: Bắt buộc warmupPeriod tối thiểu 125 nến để nuôi đủ chỉ báo cấu trúc dài
  const minRequiredWarmup = 125;
  const effectiveWarmup = Math.max(config.warmupPeriod, minRequiredWarmup);

  if (!primaryBars || primaryBars.length <= effectiveWarmup) {
    throw new Error(
      `BacktestEngine Error: Total bars (${primaryBars?.length ?? 0}) <= Required Warmup (${effectiveWarmup}).`
    );
  }

  // ========================================================================
  // INITIAL STATE — passed to the first cycle transition
  // ========================================================================
  let cycleState: PriorCycleState = {
    account: {
      cash: config.initialCapital,
      positions: {},
    },
    riskState: createInitialRiskState(),
    peakNav: config.initialCapital,
    strategyStates: {
      ADAPTIVE_TREND: { strategyId: "ADAPTIVE_TREND", lastEvaluationTimestamp: 0, barsSinceLastSignal: 0, internalValues: {} },
      EVENT_REACTION: { strategyId: "EVENT_REACTION", lastEvaluationTimestamp: 0, barsSinceLastSignal: 0, internalValues: {} },
      MEAN_REVERSION: { strategyId: "MEAN_REVERSION", lastEvaluationTimestamp: 0, barsSinceLastSignal: 0, internalValues: {} },
    },
    pendingRebalance: null,
    activeTargetLifecycle: null,
    priorDecisionNav: config.initialCapital,
  };

  const decisionHistory: DecisionState[] = [];
  const allExecutions: ExecutionRecord[] = [];
  const targetLifecycleEvidence: ActiveTargetLifecycle[] = [];

  // ========================================================================
  // REPLAY LOOP — composes the single-cycle transition kernel
  // ========================================================================
  for (let t = effectiveWarmup; t < primaryBars.length; t++) {
    const currentBar = primaryBars[t];
    const barOpenTime = currentBar.timestamp;
    const decisionTime = canonicalBarAvailableAt(barOpenTime);

    if (config.startDate > 0 && decisionTime < config.startDate) continue;
    if (config.endDate > 0 && decisionTime > config.endDate) break;

    // Build per-cycle context from dataset (orchestration-level)
    const currentAssetBars: Record<AssetId, PointInTimeBar> = {};
    for (const id of assetIds) {
      const bList = dataset.assetBars[id];
      if (bList && bList.length > t) currentAssetBars[id] = bList[t];
      else if (bList && bList.length > 0) currentAssetBars[id] = bList[bList.length - 1];
    }

    // Prior bar for lifecycle execution marks
    const priorAssetBars: Record<AssetId, PointInTimeBar> = {};
    for (const id of assetIds) {
      const bList = dataset.assetBars[id];
      if (bList && t > 0 && bList.length > t - 1) priorAssetBars[id] = bList[t - 1];
    }

    // PIT context
    let historicalContext: HistoricalContextAtTime | undefined;
    if (normalizedHistorical) {
      historicalContext = buildHistoricalContextAtTime(normalizedHistorical, decisionTime);
    }

    const macroState = getLatestMacroAsOf(dataset.macroTimeline, decisionTime);
    let eventState = getLatestEventAsOf(dataset.eventTimeline, decisionTime);
    if (!eventState && historicalContext?.latestEvent) {
      eventState = historicalEventToPointInTimeEvent(historicalContext.latestEvent);
    }

    const benchmarkSlice = primaryBars.slice(0, t + 1);

    // ====================================================================
    // DELEGATE TO THE PURE SINGLE-CYCLE TRANSITION KERNEL
    // ====================================================================
    const cycleResult = executeSingleCycleTransition(cycleState, {
      config,
      strategyConfigs,
      currentBar,
      currentBarIndex: t,
      decisionTime,
      currentAssetBars,
      benchmarkSlice,
      benchmarkId,
      macroState,
      eventState,
      historicalContext,
      priorAssetBars,
    });

    // Collect outputs
    decisionHistory.push(cycleResult.decision);
    allExecutions.push(...cycleResult.barExecutions);
    targetLifecycleEvidence.push(...cycleResult.lifecycleEvidence);

    // Advance state for next cycle
    cycleState = cycleResult.nextState;
  }

  const metrics = calculateMetrics(decisionHistory, config.initialCapital, allExecutions);

  return {
    runId: config.runId,
    config,
    timeline: decisionHistory,
    metrics,
    totalBarsEvaluated: decisionHistory.length,
    targetLifecycleEvidence,
  };
}

export function calculateMetrics(
  history: readonly DecisionState[],
  initialCapital: number,
  allExecutions: readonly ExecutionRecord[]
): BacktestPerformanceMetrics {
  if (history.length === 0) {
    return {
      initialNav: initialCapital,
      finalNav: initialCapital,
      totalReturnPct: 0,
      cagrPct: 0,
      annualizedSharpeRatio: 0,
      annualizedSortinoRatio: 0,
      maxDrawdownPct: 0,
      calmarRatio: 0,
      totalTrades: 0,
      closedTradeCount: 0,
      roundTripCount: 0,
      wins: 0,
      losses: 0,
      breakEven: 0,
      winRatePct: null,
      profitFactor: 0,
      totalFeesUsd: 0,
      totalSlippageCostUsd: 0,
      annualTurnoverRatio: 0,
    };
  }

  const finalNav = history[history.length - 1].nav;
  const totalReturnPct = (finalNav - initialCapital) / initialCapital;
  // CORE-01: years uses BARS_PER_YEAR (8760 bars/year for 1H engine), not 252 trading days
  const years = Math.max(1, history.length) / BARS_PER_YEAR;
  const cagrPct = years > 0 && finalNav > 0 ? Math.pow(finalNav / initialCapital, 1 / years) - 1 : 0;

  // barReturns: per-bar (1H) returns used for Sharpe/Sortino annualization
  const barReturns: number[] = [];
  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1].nav;
    if (prev > 0) barReturns.push((history[i].nav - prev) / prev);
  }

  let mean = 0;
  let variance = 0;
  let downsideVariance = 0;
  if (barReturns.length > 1) {
    mean = barReturns.reduce((a, b) => a + b, 0) / barReturns.length;
    for (const r of barReturns) {
      variance += (r - mean) ** 2;
      if (r < 0) downsideVariance += r ** 2;
    }
    variance /= barReturns.length - 1;
    downsideVariance /= Math.max(1, barReturns.filter((r) => r < 0).length);
  }

  const std = Math.sqrt(variance);
  const downsideStd = Math.sqrt(downsideVariance);
  // CORE-01: annualize using ANNUALIZATION_FACTOR = sqrt(BARS_PER_YEAR) = sqrt(8760)
  const annualizedSharpeRatio = std > 0 ? (mean / std) * ANNUALIZATION_FACTOR : 0;
  const annualizedSortinoRatio = downsideStd > 0 ? (mean / downsideStd) * ANNUALIZATION_FACTOR : 0;

  let maxDrawdownPct = 0;
  for (const s of history) {
    if (s.currentDrawdown > maxDrawdownPct) maxDrawdownPct = s.currentDrawdown;
  }
  const calmarRatio = maxDrawdownPct > 0 ? cagrPct / maxDrawdownPct : 0;

  let totalFeesUsd = 0;
  let totalSlippageCostUsd = 0;
  let grossTradedVolumeUsd = 0;
  for (const e of allExecutions) {
    totalFeesUsd += e.fees;
    totalSlippageCostUsd += (e.slippage / 10000) * e.notionalUsd;
    grossTradedVolumeUsd += e.notionalUsd;
  }

  const annualTurnoverRatio = years > 0 && initialCapital > 0 ? grossTradedVolumeUsd / initialCapital / years : 0;
  const winBars = barReturns.filter((r) => r > 0);
  const loseBars = barReturns.filter((r) => r < 0);
  const sumGains = winBars.reduce((a, b) => a + b, 0);
  const sumLosses = Math.abs(loseBars.reduce((a, b) => a + b, 0));
  const profitFactor = sumLosses > 0 ? sumGains / sumLosses : 1.0;

  // Reconstruct canonical trade attribution from execution fills
  const attribution = reconstructTradeAttribution(allExecutions, initialCapital);
  const { summary } = attribution;

  return {
    initialNav: Math.round(initialCapital * 100) / 100,
    finalNav: Math.round(finalNav * 100) / 100,
    totalReturnPct: Math.round(totalReturnPct * 10000) / 10000,
    cagrPct: Math.round(cagrPct * 10000) / 10000,
    annualizedSharpeRatio: Math.round(annualizedSharpeRatio * 100) / 100,
    annualizedSortinoRatio: Math.round(annualizedSortinoRatio * 100) / 100,
    maxDrawdownPct: Math.round(maxDrawdownPct * 10000) / 10000,
    calmarRatio: Math.round(calmarRatio * 100) / 100,
    totalTrades: summary.totalExecutions,
    closedTradeCount: summary.closedTradeCount,
    roundTripCount: summary.roundTripCount,
    wins: summary.wins,
    losses: summary.losses,
    breakEven: summary.breakEven,
    winRatePct: summary.winRatePct,
    profitFactor: Math.round(profitFactor * 100) / 100,
    totalFeesUsd: Math.round(totalFeesUsd * 100) / 100,
    totalSlippageCostUsd: Math.round(totalSlippageCostUsd * 100) / 100,
    annualTurnoverRatio: Math.round(annualTurnoverRatio * 100) / 100,
  };
}
