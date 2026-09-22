// ============================================================================
// FILE: src/lib/quant/walkForward.ts
// MODULE: ROLLING FIXED-PARAMETER OUT-OF-SAMPLE EVALUATION ENGINE
// PURPOSE: Rolling non-overlapping OOS windows to evaluate strategy robustness.
// METHODOLOGY: Rolling Fixed-Parameter OOS Evaluation (No hyperparameter tuning).
// ============================================================================

import type { AssetId, BacktestConfig, DecisionState, ExecutionRecord, PointInTimeBar } from "./types";
import {
  runBacktest,
  calculateMetrics,
  type BacktestDataset,
  type BacktestStrategyConfigs,
  type BacktestPerformanceMetrics,
} from "./backtestEngine";

export interface WalkForwardFoldResult {
  readonly foldIndex: number;
  readonly trainStartTimestamp: number;
  readonly trainEndTimestamp: number;
  readonly testStartTimestamp: number;
  readonly testEndTimestamp: number;
  readonly oosMetrics: BacktestPerformanceMetrics;
  readonly oosTimeline: readonly DecisionState[];
}

export interface WalkForwardMatrixReport {
  readonly methodology: string;
  readonly totalFolds: number;
  readonly trainWindowBars: number;
  readonly testWindowBars: number;
  readonly stitchedOosTimeline: readonly DecisionState[];
  readonly aggregateOosMetrics: BacktestPerformanceMetrics;
  readonly foldReports: readonly WalkForwardFoldResult[];
  readonly robustnessScore: number; // Fraction of folds with Sharpe > 0
}

/**
 * Execute Rolling Fixed-Parameter Out-Of-Sample (OOS) Evaluation.
 *
 * METHODOLOGY CONTRACT:
 * - Training/pre-test bars serve strictly as pre-roll indicator warmup context.
 * - No model fitting, parameter tuning, or hyperparameter selection occurs on train data.
 * - Each fold is an independent experiment starting at initial capital.
 * - Aggregate OOS performance is computed from a canonical chained OOS return series
 *   compounding per-bar returns across all completed non-overlapping test folds.
 */
export function runWalkForwardValidation(
  dataset: BacktestDataset,
  baseConfig: BacktestConfig,
  strategyConfigs: BacktestStrategyConfigs = {},
  trainWindowBars = 180,
  testWindowBars = 60,
  stepBars = 60
): WalkForwardMatrixReport {
  if (stepBars !== testWindowBars) {
    throw new Error(
      `WalkForward Error: stepBars (${stepBars}) must equal testWindowBars (${testWindowBars}) for non-overlapping contiguous OOS evaluation.`
    );
  }

  const benchmarkId = dataset.benchmarkAssetId ?? Object.keys(dataset.assetBars)[0];
  const primaryBars = dataset.assetBars[benchmarkId];

  if (!primaryBars || primaryBars.length < trainWindowBars + testWindowBars) {
    throw new Error("WalkForward Error: Dataset too short for configured train/test windows.");
  }

  const foldReports: WalkForwardFoldResult[] = [];
  const stitchedTimeline: DecisionState[] = [];
  const allOosExecutions: ExecutionRecord[] = [];
  let globalBarOffset = 0;

  let currentChainedNav = baseConfig.initialCapital;
  let peakChainedNav = baseConfig.initialCapital;

  let startIndex = 0;
  let foldIdx = 0;

  while (startIndex + trainWindowBars + testWindowBars <= primaryBars.length) {
    const trainEndIndex = startIndex + trainWindowBars;
    const testEndIndex = trainEndIndex + testWindowBars;

    const trainStartTimestamp = primaryBars[startIndex].timestamp;
    const trainEndTimestamp = primaryBars[trainEndIndex - 1].timestamp;
    const testStartTimestamp = primaryBars[trainEndIndex].timestamp;
    const testEndTimestamp = primaryBars[testEndIndex - 1].timestamp;

    // Cut dataset for current fold (train pre-roll + test window)
    const foldAssetBars: Record<AssetId, PointInTimeBar[]> = {};
    for (const [assetId, bars] of Object.entries(dataset.assetBars)) {
      foldAssetBars[assetId] = bars.slice(startIndex, testEndIndex);
    }

    const foldDataset: BacktestDataset = {
      assetBars: foldAssetBars,
      macroTimeline: dataset.macroTimeline,
      eventTimeline: dataset.eventTimeline,
      benchmarkAssetId: benchmarkId,
    };

    const foldConfig: BacktestConfig = {
      ...baseConfig,
      runId: `${baseConfig.runId}-fold-${foldIdx}`,
      warmupPeriod: Math.min(125, Math.floor(trainWindowBars * 0.6)),
      startDate: testStartTimestamp,
      endDate: testEndTimestamp,
      requirePitExecution: true,
    };

    const result = runBacktest(foldConfig, foldDataset, strategyConfigs);
    const foldTimeline = result.timeline;
    const foldInitialNav = baseConfig.initialCapital;

    // Chain OOS returns for aggregate equity curve
    const adjustedTimeline: DecisionState[] = [];
    for (let t = 0; t < foldTimeline.length; t++) {
      const state = foldTimeline[t];
      let barReturn = 0;
      if (t === 0) {
        barReturn = foldInitialNav > 0 ? (state.nav - foldInitialNav) / foldInitialNav : 0;
      } else {
        const prevNav = foldTimeline[t - 1].nav;
        barReturn = prevNav > 0 ? (state.nav - prevNav) / prevNav : 0;
      }

      currentChainedNav = currentChainedNav * (1 + barReturn);
      if (currentChainedNav > peakChainedNav) peakChainedNav = currentChainedNav;
      const currentDrawdown = peakChainedNav > 0 ? (peakChainedNav - currentChainedNav) / peakChainedNav : 0;

      const chainedState: DecisionState = {
        ...state,
        barIndex: state.barIndex + globalBarOffset,
        nav: Math.round(currentChainedNav * 100) / 100,
        currentDrawdown: Math.round(currentDrawdown * 10000) / 10000,
      };

      adjustedTimeline.push(chainedState);
      allOosExecutions.push(...state.executions);
    }

    stitchedTimeline.push(...adjustedTimeline);

    foldReports.push({
      foldIndex: foldIdx,
      trainStartTimestamp,
      trainEndTimestamp,
      testStartTimestamp,
      testEndTimestamp,
      oosMetrics: result.metrics,
      oosTimeline: foldTimeline,
    });

    globalBarOffset += testWindowBars;
    startIndex += stepBars;
    foldIdx++;
  }

  // Fraction of folds with positive Sharpe Ratio
  const positiveFolds = foldReports.filter((f) => f.oosMetrics.annualizedSharpeRatio > 0).length;
  const robustnessScore = foldReports.length > 0 ? positiveFolds / foldReports.length : 0;

  // Recompute aggregate metrics from the canonical chained OOS return series
  const rawAggregateMetrics = calculateMetrics(
    stitchedTimeline,
    baseConfig.initialCapital,
    allOosExecutions
  );

  // Aggregate trade statistics must sum fold-local trade stats to preserve fold isolation
  let aggTotalTrades = 0;
  let aggClosedTradeCount = 0;
  let aggRoundTripCount = 0;
  let aggWins = 0;
  let aggLosses = 0;
  let aggBreakEven = 0;

  for (const f of foldReports) {
    aggTotalTrades += f.oosMetrics.totalTrades;
    aggClosedTradeCount += f.oosMetrics.closedTradeCount;
    aggRoundTripCount += f.oosMetrics.roundTripCount;
    aggWins += f.oosMetrics.wins;
    aggLosses += f.oosMetrics.losses;
    aggBreakEven += f.oosMetrics.breakEven;
  }

  const aggWinRatePct = aggWins + aggLosses > 0 ? Math.round(((aggWins / (aggWins + aggLosses)) * 100) * 100) / 100 : null;

  const aggregateOosMetrics: BacktestPerformanceMetrics = {
    ...rawAggregateMetrics,
    totalTrades: aggTotalTrades,
    closedTradeCount: aggClosedTradeCount,
    roundTripCount: aggRoundTripCount,
    wins: aggWins,
    losses: aggLosses,
    breakEven: aggBreakEven,
    winRatePct: aggWinRatePct,
  };

  return {
    methodology: "Rolling Fixed-Parameter OOS Evaluation",
    totalFolds: foldReports.length,
    trainWindowBars,
    testWindowBars,
    stitchedOosTimeline: stitchedTimeline,
    aggregateOosMetrics,
    foldReports,
    robustnessScore: Math.round(robustnessScore * 100) / 100,
  };
}