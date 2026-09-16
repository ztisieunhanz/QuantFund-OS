// ============================================================================
// FILE: src/lib/quant/alphaValidation.ts
// MODULE: STATISTICAL ALPHA VALIDATION & ABLATION ENGINE
// PURPOSE: Verify that AlphaScores have predictive power and filters add real value
// ============================================================================

import type { PointInTimeBar, StrategyContext, StrategyState, SignalOutput } from "./types";
import { evaluateAdaptiveTrend, type AdaptiveTrendConfig, DEFAULT_ADAPTIVE_TREND_CONFIG } from "./adaptiveTrend";


// ----------------------------------------------------------------------------
// 1. CONTRACTS & INTERFACES
// ----------------------------------------------------------------------------

export interface AlphaBucketMetric {
  readonly bucketLabel: string;
  readonly minScore: number;
  readonly maxScore: number;
  readonly sampleCount: number;
  readonly meanForwardReturnPct: number;
  readonly winRatePct: number;
  readonly sharpeRatio: number;
}

export interface MonotonicityReport {
  readonly strategyId: string;
  readonly forwardHorizonBars: number;
  readonly rankInformationCoefficient: number; // Spearman Rank IC
  readonly pValueEstimate: number;
  readonly isMonotonic: boolean;
  readonly buckets: readonly AlphaBucketMetric[];
}

export interface AblationVariantResult {
  readonly variantName: string;
  readonly totalTrades: number;
  readonly annualReturnPct: number;
  readonly annualizedSharpe: number;
  readonly maxDrawdownPct: number;
  readonly annualTurnover: number;
  readonly incrementalSharpeDelta: number;
}

export interface AblationStudyReport {
  readonly strategyId: string;
  readonly baselineVariant: string;
  readonly variants: readonly AblationVariantResult[];
  readonly recommendation: string;
}

// ----------------------------------------------------------------------------
// 2. MATHEMATICAL HELPERS (RANK CORRELATION & SPEARMAN IC)
// ----------------------------------------------------------------------------

function calculateRanks(values: readonly number[]): number[] {
  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);
  const ranks = new Array(values.length);
  for (let r = 0; r < indexed.length; r++) {
    ranks[indexed[r].i] = r + 1;
  }
  return ranks;
}

function calculateSpearmanRankIC(x: readonly number[], y: readonly number[]): number {
  if (x.length !== y.length || x.length < 5) return 0;
  const rankX = calculateRanks(x);
  const rankY = calculateRanks(y);
  const n = x.length;

  let dSquaredSum = 0;
  for (let i = 0; i < n; i++) {
    dSquaredSum += (rankX[i] - rankY[i]) ** 2;
  }
  return 1 - (6 * dSquaredSum) / (n * (n ** 2 - 1));
}

// ----------------------------------------------------------------------------
// 3. ALPHA MONOTONICITY & INFORMATION COEFFICIENT (IC) TEST
// ----------------------------------------------------------------------------

export function testAlphaMonotonicity(
  bars: readonly PointInTimeBar[],
  evaluateFn: (ctx: StrategyContext) => SignalOutput,
  forwardHorizonBars = 5,
  warmupBars = 125
): MonotonicityReport {
  const scores: number[] = [];
  const forwardReturns: number[] = [];


  // 1. Quét từng nến và đo lường return tương lai thực tế
  for (let t = warmupBars; t < bars.length - forwardHorizonBars; t++) {
    const currentBar = bars[t];
    const forwardBar = bars[t + forwardHorizonBars];
    const slice = bars.slice(0, t + 1);

    const ctx: StrategyContext = {
      strategyId: "ADAPTIVE_TREND",
      assetId: "ASSET",
      currentBarTimestamp: currentBar.timestamp,
      decisionTimestamp: currentBar.timestamp,
      currentPrice: currentBar.close,
      priceHistory: slice,
      macro: null,
      latestEvent: null,
    };

    const signal = evaluateFn(ctx);
    const forwardReturn = (forwardBar.close - currentBar.close) / currentBar.close;

    scores.push(signal.alphaScore);
    forwardReturns.push(forwardReturn);
  }

  // 2. Tính toán Spearman Rank IC
  const rankIC = calculateSpearmanRankIC(scores, forwardReturns);

  // 3. Phân chia 5 Buckets
  const bucketDefs = [
    { label: "Q1 [-1.0 .. -0.6]", min: -1.0, max: -0.6 },
    { label: "Q2 [-0.6 .. -0.2]", min: -0.6, max: -0.2 },
    { label: "Q3 [-0.2 .. +0.2]", min: -0.2, max: +0.2 },
    { label: "Q4 [+0.2 .. +0.6]", min: +0.2, max: +0.6 },
    { label: "Q5 [+0.6 .. +1.0]", min: +0.6, max: +1.0 },
  ];

  const bucketMetrics: AlphaBucketMetric[] = bucketDefs.map((b) => {
    const matchingReturns: number[] = [];
    for (let i = 0; i < scores.length; i++) {
      if (scores[i] >= b.min && (scores[i] < b.max || (b.max === 1.0 && scores[i] <= 1.0))) {
        matchingReturns.push(forwardReturns[i]);
      }
    }

    if (matchingReturns.length === 0) {
      return {
        bucketLabel: b.label,
        minScore: b.min,
        maxScore: b.max,
        sampleCount: 0,
        meanForwardReturnPct: 0,
        winRatePct: 0,
        sharpeRatio: 0,
      };
    }

    const meanRet = matchingReturns.reduce((a, b) => a + b, 0) / matchingReturns.length;
    const wins = matchingReturns.filter((r) => r > 0).length;
    const winRate = (wins / matchingReturns.length) * 100;

    let variance = 0;
    for (const r of matchingReturns) variance += (r - meanRet) ** 2;
    variance /= Math.max(1, matchingReturns.length - 1);
    const std = Math.sqrt(variance);
    const annualizedSharpe = std > 0 ? (meanRet / std) * Math.sqrt(252 / forwardHorizonBars) : 0;

    return {
      bucketLabel: b.label,
      minScore: b.min,
      maxScore: b.max,
      sampleCount: matchingReturns.length,
      meanForwardReturnPct: Math.round(meanRet * 10000) / 100,
      winRatePct: Math.round(winRate * 10) / 10,
      sharpeRatio: Math.round(annualizedSharpe * 100) / 100,
    };
  });

  // 4. Kiểm định tính đơn điệu: Bucket sau phải có mean return cao hơn hoặc bằng bucket trước
  let isMonotonic = true;
  for (let i = 1; i < bucketMetrics.length; i++) {
    if (bucketMetrics[i].sampleCount > 5 && bucketMetrics[i - 1].sampleCount > 5) {
      if (bucketMetrics[i].meanForwardReturnPct < bucketMetrics[i - 1].meanForwardReturnPct) {
        isMonotonic = false;
        break;
      }
    }
  }

  return {
    strategyId: "EVALUATED_ALPHA",
    forwardHorizonBars,
    rankInformationCoefficient: Math.round(rankIC * 1000) / 1000,
    pValueEstimate: Math.round((1 / Math.sqrt(scores.length || 1)) * 1000) / 1000,
    isMonotonic,
    buckets: bucketMetrics,
  };
}

// ----------------------------------------------------------------------------
// 4. ABLATION STUDY: BÓC TÁCH TỪNG LỚP LỌC (ADAPTIVE TREND)
// ----------------------------------------------------------------------------

export function runTrendAblationStudy(
  bars: readonly PointInTimeBar[],
  warmupBars = 125
): AblationStudyReport {
  const dummyState: StrategyState = {
    strategyId: "ADAPTIVE_TREND",
    lastEvaluationTimestamp: 0,
    barsSinceLastSignal: 0,
    internalValues: {},
  };

  // Biến thể 1: Thuần túy Momentum đa khung (Không Persistence, Không Chandelier)
  const v1Config: AdaptiveTrendConfig = {
    ...DEFAULT_ADAPTIVE_TREND_CONFIG,
    trendPersistenceThreshold: 0.0, // Tắt kiểm tra persistence
    chandelierAtrMultiplier: 999.0, // Vô hiệu hóa Chandelier Stop
  };

  // Biến thể 2: Momentum + Trend Persistence
  const v2Config: AdaptiveTrendConfig = {
    ...DEFAULT_ADAPTIVE_TREND_CONFIG,
    trendPersistenceThreshold: 0.55,
    chandelierAtrMultiplier: 999.0, // Vô hiệu hóa Chandelier Stop
  };

  // Biến thể 3: Momentum + Chandelier Stop (Không Persistence)
  const v3Config: AdaptiveTrendConfig = {
    ...DEFAULT_ADAPTIVE_TREND_CONFIG,
    trendPersistenceThreshold: 0.0,
    chandelierAtrMultiplier: 3.0,
  };

  // Biến thể 4: Full Architecture (Momentum + Persistence + Chandelier)
  const v4Config: AdaptiveTrendConfig = {
    ...DEFAULT_ADAPTIVE_TREND_CONFIG,
    trendPersistenceThreshold: 0.55,
    chandelierAtrMultiplier: 3.0,
  };

  const variants = [
    { name: "1. Raw Multi-Horizon Momentum", cfg: v1Config },
    { name: "2. Momentum + Trend Persistence", cfg: v2Config },
    { name: "3. Momentum + Chandelier Stop", cfg: v3Config },
    { name: "4. Full (Persistence + Chandelier)", cfg: v4Config },
  ];

  let baseSharpe = 0;
  const results: AblationVariantResult[] = [];

  for (let idx = 0; idx < variants.length; idx++) {
    const v = variants[idx];
    const dailyReturns: number[] = [];
    let position = 0;
    let tradesCount = 0;
    let tradedVolume = 0;

    for (let t = warmupBars; t < bars.length - 1; t++) {
      const slice = bars.slice(0, t + 1);
      const ctx: StrategyContext = {
        strategyId: "ADAPTIVE_TREND",
        assetId: "BTC",
        currentBarTimestamp: bars[t].timestamp,
        decisionTimestamp: bars[t].timestamp,
        currentPrice: bars[t].close,
        priceHistory: slice,
        macro: null,
        latestEvent: null,
      };

      const sig = evaluateAdaptiveTrend(ctx, dummyState, v.cfg);
      const nextBarReturn = (bars[t + 1].close - bars[t].close) / bars[t].close;

      const targetPos = sig.alphaScore > 0.2 ? 1.0 : sig.alphaScore < -0.2 ? 0.0 : position;
      if (targetPos !== position) {
        tradesCount++;
        tradedVolume += Math.abs(targetPos - position);
        position = targetPos;
      }

      dailyReturns.push(position * nextBarReturn);
    }

    const mean = dailyReturns.reduce((a, b) => a + b, 0) / (dailyReturns.length || 1);
    let variance = 0;
    for (const r of dailyReturns) variance += (r - mean) ** 2;
    variance /= Math.max(1, dailyReturns.length - 1);
    const sharpe = Math.sqrt(variance) > 0 ? (mean / Math.sqrt(variance)) * Math.sqrt(252) : 0;
    const annReturn = mean * 252 * 100;
    const turnover = tradedVolume / (dailyReturns.length / 252 || 1);

    if (idx === 0) baseSharpe = sharpe;

    results.push({
      variantName: v.name,
      totalTrades: tradesCount,
      annualReturnPct: Math.round(annReturn * 10) / 10,
      annualizedSharpe: Math.round(sharpe * 100) / 100,
      maxDrawdownPct: 0, // Simplified for ablation
      annualTurnover: Math.round(turnover * 10) / 10,
      incrementalSharpeDelta: Math.round((sharpe - baseSharpe) * 100) / 100,
    });
  }

  // Khuyến nghị tự động dựa trên delta Sharpe thực nghiệm
  const fullVariant = results[3];
  let recommendation = "Retain full stack: Filters provide genuine incremental Sharpe.";
  if (fullVariant.incrementalSharpeDelta <= 0) {
    recommendation = "WARNING: Filters degrade baseline Sharpe. Consider pruning Chandelier or Persistence.";
  }

  return {
    strategyId: "ADAPTIVE_TREND",
    baselineVariant: "1. Raw Multi-Horizon Momentum",
    variants: results,
    recommendation,
  };
}