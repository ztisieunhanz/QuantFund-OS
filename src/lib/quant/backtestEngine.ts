// ============================================================================
// FILE: src/lib/quant/backtestEngine.ts
// MODULE: DETERMINISTIC REPLAY & INTEGRITY-SECURED BACKTEST ENGINE
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
  StrategyContext,
  StrategyId,
  StrategyState,
  TargetPortfolioWeight,
} from "@/lib/quant/types";

import { evaluateAdaptiveTrend, updateAdaptiveTrendState, type AdaptiveTrendConfig } from "@/lib/quant/adaptiveTrend";
import { evaluateEventReaction, updateEventReactionState, type EventReactionConfig } from "@/lib/quant/eventReaction";
import { evaluateMeanReversion, updateMeanReversionState, type MeanReversionConfig } from "@/lib/quant/meanReversion";
import { evaluatePermission, type PermissionGateConfig } from "@/lib/quant/permissionGate";
import { evaluatePortfolioRisk, createInitialRiskState, type RiskEngineConfig, type RiskEngineState } from "@/lib/quant/riskEngine";
import { evaluateOmegaAllocation, type OmegaAllocatorConfig } from "@/lib/quant/omegaAllocator";
import { executeRebalance, type PortfolioAccountState } from "@/lib/quant/executionEngine";
import { BARS_PER_YEAR, ANNUALIZATION_FACTOR } from "@/lib/quant/timeDomain";

export interface BacktestDataset {
  readonly assetBars: Readonly<Record<AssetId, readonly PointInTimeBar[]>>;
  readonly macroTimeline?: readonly PointInTimeMacro[];
  readonly eventTimeline?: readonly PointInTimeEvent[];
  readonly benchmarkAssetId?: AssetId;
}

export interface BacktestStrategyConfigs {
  readonly trend?: AdaptiveTrendConfig;
  readonly event?: EventReactionConfig;
  readonly meanReversion?: MeanReversionConfig;
  readonly permission?: PermissionGateConfig;
  readonly risk?: RiskEngineConfig;
  readonly omega?: OmegaAllocatorConfig;
}

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
  readonly winRatePct: number;
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

  let account: PortfolioAccountState = {
    cash: config.initialCapital,
    positions: {},
  };

  let riskState: RiskEngineState = createInitialRiskState();
  let peakNav = config.initialCapital;

  const strategyStates: Record<StrategyId, StrategyState> = {
    ADAPTIVE_TREND: { strategyId: "ADAPTIVE_TREND", lastEvaluationTimestamp: 0, barsSinceLastSignal: 0, internalValues: {} },
    EVENT_REACTION: { strategyId: "EVENT_REACTION", lastEvaluationTimestamp: 0, barsSinceLastSignal: 0, internalValues: {} },
    MEAN_REVERSION: { strategyId: "MEAN_REVERSION", lastEvaluationTimestamp: 0, barsSinceLastSignal: 0, internalValues: {} },
  };

  // CORE-06: strategyPnlHistory fabrication removed.
  // Previously this accumulated alphaScore × barPnl proxies and fed them to
  // calculateCorrelationMatrix() → Omega, creating fabricated attribution.
  // Until genuine per-strategy PnL attribution exists, pass null to Omega.

  const decisionHistory: DecisionState[] = [];
  const allExecutions: ExecutionRecord[] = [];
  let pendingRebalance: TargetPortfolioWeight | null = null;

  for (let t = effectiveWarmup; t < primaryBars.length; t++) {
    const currentBar = primaryBars[t];
    const timestamp = currentBar.timestamp;

    if (config.startDate > 0 && timestamp < config.startDate) continue;
    if (config.endDate > 0 && timestamp > config.endDate) break;

    const currentAssetBars: Record<AssetId, PointInTimeBar> = {};
    for (const id of assetIds) {
      const bList = dataset.assetBars[id];
      if (bList && bList.length > t) currentAssetBars[id] = bList[t];
      else if (bList && bList.length > 0) currentAssetBars[id] = bList[bList.length - 1];
    }

    // A. XỬ LÝ KHỚP LỆNH CHỜ TẠI NEXT_BAR_OPEN
    let barExecutions: ExecutionRecord[] = [];
    if (config.executionRule === "NEXT_BAR_OPEN" && pendingRebalance) {
      const execResult = executeRebalance(
        account,
        pendingRebalance,
        currentAssetBars,
        {
          decisionTimestamp: pendingRebalance.asOfTimestamp,
          executionTimestamp: timestamp,
          executionRule: "NEXT_BAR_OPEN",
          commissionRate: config.commissionRate,
          slippageConfig: config.slippageModel,
        }
      );
      account = execResult.updatedAccount;
      barExecutions = [...execResult.records];
      allExecutions.push(...execResult.records);
      pendingRebalance = null;
    }

    // B. POINT-IN-TIME SLICE (Tuyệt đối không chứa dữ liệu > t)
    const macroState = getLatestMacroAsOf(dataset.macroTimeline, timestamp);
    const eventState = getLatestEventAsOf(dataset.eventTimeline, timestamp);
    const benchmarkSlice = primaryBars.slice(0, t + 1);

    // C. ĐÁNH GIÁ 3 CHIẾN LƯỢC
    const trendCtx: StrategyContext = {
      strategyId: "ADAPTIVE_TREND",
      assetId: benchmarkId,
      currentBarTimestamp: timestamp,
      decisionTimestamp: timestamp,
      currentPrice: currentBar.close,
      priceHistory: benchmarkSlice,
      macro: macroState,
      latestEvent: eventState,
    };
    const trendSignal = evaluateAdaptiveTrend(trendCtx, strategyStates.ADAPTIVE_TREND, strategyConfigs.trend);
    strategyStates.ADAPTIVE_TREND = updateAdaptiveTrendState(trendCtx, strategyStates.ADAPTIVE_TREND, trendSignal);

    const eventCtx: StrategyContext = {
      strategyId: "EVENT_REACTION",
      assetId: benchmarkId,
      currentBarTimestamp: timestamp,
      decisionTimestamp: timestamp,
      currentPrice: currentBar.close,
      priceHistory: benchmarkSlice,
      macro: macroState,
      latestEvent: eventState,
    };
    const eventSignal = evaluateEventReaction(eventCtx, strategyStates.EVENT_REACTION, strategyConfigs.event);
    strategyStates.EVENT_REACTION = updateEventReactionState(eventCtx, strategyStates.EVENT_REACTION, eventSignal);

    const mrCtx: StrategyContext = {
      strategyId: "MEAN_REVERSION",
      assetId: benchmarkId,
      currentBarTimestamp: timestamp,
      decisionTimestamp: timestamp,
      currentPrice: currentBar.close,
      priceHistory: benchmarkSlice,
      macro: macroState,
      latestEvent: eventState,
    };
    const mrSignal = evaluateMeanReversion(mrCtx, strategyStates.MEAN_REVERSION, strategyConfigs.meanReversion);
    strategyStates.MEAN_REVERSION = updateMeanReversionState(mrCtx, strategyStates.MEAN_REVERSION, mrSignal);

    const signals: readonly SignalOutput[] = [trendSignal, eventSignal, mrSignal];

    // D. PERMISSION GATE
    const permissions = [
      evaluatePermission("ADAPTIVE_TREND", macroState, strategyConfigs.permission),
      evaluatePermission("EVENT_REACTION", macroState, strategyConfigs.permission),
      evaluatePermission("MEAN_REVERSION", macroState, strategyConfigs.permission),
    ];

    // E. RISK ENGINE (HYSTERESIS & VOL FLOOR)
    let preAllocNav = account.cash;
    for (const [id, pos] of Object.entries(account.positions)) {
      const p = currentAssetBars[id]?.close ?? 0;
      preAllocNav += pos.quantity * p;
    }
    if (preAllocNav > peakNav) peakNav = preAllocNav;

    const { risk: riskOutput, nextState: updatedRiskState } = evaluatePortfolioRisk(
      preAllocNav,
      peakNav,
      benchmarkSlice,
      riskState,
      strategyConfigs.risk
    );
    riskState = updatedRiskState;

    // F. OMEGA ALLOCATOR
    // CORE-06: strategyCorrelations = null — no fabricated attribution fed to Omega.
    // The previous code manufactured strategy PnL proxies from alphaScore × barPnl
    // and passed them as real correlation data. That was invalid. When genuine
    // per-strategy PnL attribution exists, a real matrix may be passed here.
    const targetWeights = evaluateOmegaAllocation(
      signals,
      permissions,
      riskOutput,
      null,
      timestamp,
      strategyConfigs.omega
    );

    // G. KHỚP LỆNH MẶC ĐỊNH THEO NEXT_BAR_OPEN (HOẶC SAME_BAR_CLOSE NẾU CHỈ ĐỊNH)
    if (config.executionRule === "SAME_BAR_CLOSE") {
      const execResult = executeRebalance(
        account,
        targetWeights,
        currentAssetBars,
        {
          decisionTimestamp: timestamp,
          executionTimestamp: timestamp,
          executionRule: "SAME_BAR_CLOSE",
          commissionRate: config.commissionRate,
          slippageConfig: config.slippageModel,
        }
      );
      account = execResult.updatedAccount;
      barExecutions = [...execResult.records];
      allExecutions.push(...execResult.records);
    } else {
      pendingRebalance = targetWeights;
    }

    // H. ĐÓNG BĂNG AUDIT TRAIL VÀ TRÁNH TRÔI SỐ THỰC PNL
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

    const previousNav = decisionHistory.length > 0 ? decisionHistory[decisionHistory.length - 1].nav : config.initialCapital;
    // barPnl: PnL for this 1H bar (field DecisionState.dailyPnl kept for API compatibility; semantics = per-bar)
    const barPnl = closingNav - previousNav;
    const cumulativePnl = closingNav - config.initialCapital; // Tránh floating-point accumulation drift
    const currentDrawdown = peakNav > 0 ? (peakNav - closingNav) / peakNav : 0;

    decisionHistory.push({
      barIndex: t,
      timestamp,
      nav: Math.round(closingNav * 100) / 100,
      cash: Math.round(account.cash * 100) / 100,
      positions: { ...account.positions },
      signals,
      permissions,
      risk: riskOutput,
      targetWeights,
      executions: barExecutions,
      // dailyPnl field name kept for public API compatibility; value is per-bar (1H) PnL
      dailyPnl: Math.round(barPnl * 100) / 100,
      cumulativePnl: Math.round(cumulativePnl * 100) / 100,
      currentDrawdown: Math.round(currentDrawdown * 10000) / 10000,
    });
  }

  const metrics = calculateMetrics(decisionHistory, config.initialCapital, allExecutions);

  return {
    runId: config.runId,
    config,
    timeline: decisionHistory,
    metrics,
    totalBarsEvaluated: decisionHistory.length,
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
      winRatePct: 0,
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
  const winRatePct = barReturns.length > 0 ? (winBars.length / barReturns.length) * 100 : 0;
  const sumGains = winBars.reduce((a, b) => a + b, 0);
  const sumLosses = Math.abs(loseBars.reduce((a, b) => a + b, 0));
  const profitFactor = sumLosses > 0 ? sumGains / sumLosses : 1.0;

  return {
    initialNav: Math.round(initialCapital * 100) / 100,
    finalNav: Math.round(finalNav * 100) / 100,
    totalReturnPct: Math.round(totalReturnPct * 10000) / 10000,
    cagrPct: Math.round(cagrPct * 10000) / 10000,
    annualizedSharpeRatio: Math.round(annualizedSharpeRatio * 100) / 100,
    annualizedSortinoRatio: Math.round(annualizedSortinoRatio * 100) / 100,
    maxDrawdownPct: Math.round(maxDrawdownPct * 10000) / 10000,
    calmarRatio: Math.round(calmarRatio * 100) / 100,
    totalTrades: allExecutions.length,
    winRatePct: Math.round(winRatePct * 100) / 100,
    profitFactor: Math.round(profitFactor * 100) / 100,
    totalFeesUsd: Math.round(totalFeesUsd * 100) / 100,
    totalSlippageCostUsd: Math.round(totalSlippageCostUsd * 100) / 100,
    annualTurnoverRatio: Math.round(annualTurnoverRatio * 100) / 100,
  };
}