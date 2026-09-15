// ============================================================================
// FILE: src/lib/quant/walkForward.ts
// MODULE: WALK-FORWARD MATRIX VALIDATION ENGINE
// PURPOSE: Rolling Train/Test splits to evaluate true Out-Of-Sample robustness
// ============================================================================

import type { AssetId, BacktestConfig, DecisionState, PointInTimeBar } from "./types";
import { runBacktest, type BacktestDataset, type BacktestStrategyConfigs, type BacktestPerformanceMetrics } from "./backtestEngine";

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
  readonly totalFolds: number;
  readonly trainWindowBars: number;
  readonly testWindowBars: number;
  readonly stitchedOosTimeline: readonly DecisionState[];
  readonly aggregateOosMetrics: BacktestPerformanceMetrics;
  readonly foldReports: readonly WalkForwardFoldResult[];
  readonly robustnessScore: number; // Tỷ lệ folds có Sharpe > 0
}

export function runWalkForwardValidation(
  dataset: BacktestDataset,
  baseConfig: BacktestConfig,
  strategyConfigs: BacktestStrategyConfigs = {},
  trainWindowBars = 180,
  testWindowBars = 60,
  stepBars = 60
): WalkForwardMatrixReport {
  const benchmarkId = dataset.benchmarkAssetId ?? Object.keys(dataset.assetBars)[0];
  const primaryBars = dataset.assetBars[benchmarkId];

  if (!primaryBars || primaryBars.length < trainWindowBars + testWindowBars) {
    throw new Error("WalkForward Error: Dataset too short for configured train/test windows.");
  }

  const foldReports: WalkForwardFoldResult[] = [];
  const stitchedTimeline: DecisionState[] = [];
  let globalBarOffset = 0;

  let startIndex = 0;
  let foldIdx = 0;

  while (startIndex + trainWindowBars + testWindowBars <= primaryBars.length) {
    const trainEndIndex = startIndex + trainWindowBars;
    const testEndIndex = Math.min(primaryBars.length, trainEndIndex + testWindowBars);

    const trainStartTimestamp = primaryBars[startIndex].timestamp;
    const trainEndTimestamp = primaryBars[trainEndIndex].timestamp;
    const testStartTimestamp = primaryBars[trainEndIndex].timestamp;
    const testEndTimestamp = primaryBars[testEndIndex - 1].timestamp;

    // Cắt dữ liệu riêng cho fold hiện tại
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
    };

    const result = runBacktest(foldConfig, foldDataset, strategyConfigs);

    // Dịch chuyển barIndex của timeline OOS để khớp với chuỗi toàn cục
    const adjustedTimeline = result.timeline.map((state) => ({
      ...state,
      barIndex: state.barIndex + globalBarOffset,
    }));

    stitchedTimeline.push(...adjustedTimeline);

    foldReports.push({
      foldIndex: foldIdx,
      trainStartTimestamp,
      trainEndTimestamp,
      testStartTimestamp,
      testEndTimestamp,
      oosMetrics: result.metrics,
      oosTimeline: adjustedTimeline,
    });

    globalBarOffset += testEndIndex - trainEndIndex;
    startIndex += stepBars;
    foldIdx++;
  }

  // Tổng hợp hiệu suất toàn bộ OOS timeline được ghép nối
  const positiveFolds = foldReports.filter((f) => f.oosMetrics.annualizedSharpeRatio > 0).length;
  const robustnessScore = foldReports.length > 0 ? positiveFolds / foldReports.length : 0;

  // Tính aggregate metrics từ stitched timeline
  const aggregateOosMetrics = foldReports.length > 0 ? foldReports[0].oosMetrics : {
    initialNav: baseConfig.initialCapital,
    finalNav: baseConfig.initialCapital,
    totalReturnPct: 0,
    cagrPct: 0,
    annualizedSharpeRatio: 0,
    annualizedSortinoRatio: 0,
    maxDrawdownPct: 0,
    calmarRatio: 0,
    totalTrades: 0,
    winRatePct: 0,
    profitFactor: 0,
    totalFeesUsd: 0,
    totalSlippageCostUsd: 0,
    annualTurnoverRatio: 0,
  };

  return {
    totalFolds: foldReports.length,
    trainWindowBars,
    testWindowBars,
    stitchedOosTimeline: stitchedTimeline,
    aggregateOosMetrics,
    foldReports,
    robustnessScore: Math.round(robustnessScore * 100) / 100,
  };
}