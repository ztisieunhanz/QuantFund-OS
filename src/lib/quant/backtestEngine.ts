// ============================================================================
// FILE: src/lib/quant/backtestEngine.ts
// MODULE: DETERMINISTIC REPLAY & AUDIT TRAIL ENGINE
// ARCHITECTURE:
//   Point-in-Time Timeline (Warmup -> Evaluation)
//     -> 3 Alpha Engines -> Permission Gate -> Risk Engine -> Omega Allocator
//     -> Execution Simulator (Next Open / Same Close) -> DecisionState Audit
// ============================================================================

import type {
  AssetId,
  BacktestConfig,
  DecisionState,
  ExecutionRecord,
  PointInTimeBar,
  PointInTimeEvent,
  PointInTimeMacro,
  SignalOutput,
  StrategyContext,
  StrategyId,
  StrategyState,
  TargetPortfolioWeight,
} from "@/lib/quant/types";

import {
  evaluateAdaptiveTrend,
  updateAdaptiveTrendState,
  type AdaptiveTrendConfig,
} from "@/lib/quant/adaptiveTrend";

import {
  evaluateEventReaction,
  updateEventReactionState,
  type EventReactionConfig,
} from "@/lib/quant/eventReaction";

import {
  evaluateMeanReversion,
  updateMeanReversionState,
  type MeanReversionConfig,
} from "@/lib/quant/meanReversion";

import {
  evaluatePermission,
  type PermissionGateConfig,
} from "@/lib/quant/permissionGate";

import {
  evaluatePortfolioRisk,
  type RiskEngineConfig,
} from "@/lib/quant/riskEngine";

import {
  evaluateOmegaAllocation,
  type OmegaAllocatorConfig,
} from "@/lib/quant/omegaAllocator";

import {
  executeRebalance,
  type PortfolioAccountState,
} from "@/lib/quant/executionEngine";

// ----------------------------------------------------------------------------
// 1. BACKTEST INPUTS & METRICS CONTRACTS
// ----------------------------------------------------------------------------

export interface BacktestDataset {
  readonly assetBars: Readonly<Record<AssetId, readonly PointInTimeBar[]>>;
  readonly macroTimeline?: readonly PointInTimeMacro[];
  readonly eventTimeline?: readonly PointInTimeEvent[];
  readonly benchmarkAssetId?: AssetId; // Mặc định là asset đầu tiên
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

// ----------------------------------------------------------------------------
// 2. TIMELINE SYNCHRONIZATION & WARMUP HELPERS
// ----------------------------------------------------------------------------

function getLatestMacroAsOf(
  macroTimeline: readonly PointInTimeMacro[] | undefined,
  timestamp: number
): PointInTimeMacro | null {
  if (!macroTimeline || macroTimeline.length === 0) return null;
  let latest: PointInTimeMacro | null = null;
  for (const m of macroTimeline) {
    if (m.asOfTimestamp <= timestamp) {
      latest = m;
    } else {
      break;
    }
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
    // Chỉ đọc sự kiện khi đã tới giờ công bố chính thức tại bar T
    if (e.publicationTimestamp <= timestamp) {
      latest = e;
    } else {
      break;
    }
  }
  return latest;
}

function calculatePerformanceMetrics(
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

  // 1. CAGR & Daily Returns
  const totalDays = Math.max(1, history.length);
  const years = totalDays / 252;
  const cagrPct = years > 0 && finalNav > 0 ? Math.pow(finalNav / initialCapital, 1 / years) - 1 : 0;

  const dailyReturns: number[] = [];
  for (let i = 1; i < history.length; i++) {
    const prevNav = history[i - 1].nav;
    if (prevNav > 0) {
      dailyReturns.push((history[i].nav - prevNav) / prevNav);
    }
  }

  // 2. Sharpe & Sortino Ratios (Giả định Risk-Free Rate = 0% trên daily delta)
  let meanReturn = 0;
  let variance = 0;
  let downsideVariance = 0;

  if (dailyReturns.length > 1) {
    meanReturn = dailyReturns.reduce((acc, r) => acc + r, 0) / dailyReturns.length;
    for (const r of dailyReturns) {
      variance += (r - meanReturn) ** 2;
      if (r < 0) {
        downsideVariance += r ** 2;
      }
    }
    variance /= dailyReturns.length - 1;
    downsideVariance /= Math.max(1, dailyReturns.filter((r) => r < 0).length);
  }

  const dailyStd = Math.sqrt(variance);
  const downsideStd = Math.sqrt(downsideVariance);
  const annualizedSharpeRatio = dailyStd > 0 ? (meanReturn / dailyStd) * Math.sqrt(252) : 0;
  const annualizedSortinoRatio = downsideStd > 0 ? (meanReturn / downsideStd) * Math.sqrt(252) : 0;

  // 3. Max Drawdown & Calmar
  let maxDrawdownPct = 0;
  for (const bar of history) {
    if (bar.currentDrawdown > maxDrawdownPct) {
      maxDrawdownPct = bar.currentDrawdown;
    }
  }
  const calmarRatio = maxDrawdownPct > 0 ? cagrPct / maxDrawdownPct : 0;

  // 4. Trade Execution Stats & Costs
  let totalFeesUsd = 0;
  let totalSlippageCostUsd = 0;
  let grossTradedVolumeUsd = 0;

  for (const exec of allExecutions) {
    totalFeesUsd += exec.fees;
    totalSlippageCostUsd += (exec.slippage / 10000) * exec.notionalUsd;
    grossTradedVolumeUsd += exec.notionalUsd;
  }

  const annualTurnoverRatio = years > 0 && initialCapital > 0
    ? grossTradedVolumeUsd / initialCapital / years
    : 0;

  // 5. Win Rate & Profit Factor từ các chu kỳ PnL ngày
  const winningDays = dailyReturns.filter((r) => r > 0);
  const losingDays = dailyReturns.filter((r) => r < 0);
  const winRatePct = dailyReturns.length > 0 ? (winningDays.length / dailyReturns.length) * 100 : 0;

  const grossGains = winningDays.reduce((sum, r) => sum + r, 0);
  const grossLosses = Math.abs(losingDays.reduce((sum, r) => sum + r, 0));
  const profitFactor = grossLosses > 0 ? grossGains / grossLosses : grossGains > 0 ? 99.0 : 1.0;

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

// ----------------------------------------------------------------------------
// 3. CORE DETERMINISTIC BACKTEST ENGINE
// ----------------------------------------------------------------------------

export function runBacktest(
  config: BacktestConfig,
  dataset: BacktestDataset,
  strategyConfigs: BacktestStrategyConfigs = {}
): BacktestResult {
  const assetIds = Object.keys(dataset.assetBars) as AssetId[];
  if (assetIds.length === 0) {
    throw new Error("BacktestEngine Error: Dataset does not contain any asset bars.");
  }

  const benchmarkId = dataset.benchmarkAssetId ?? assetIds[0];
  const primaryBars = dataset.assetBars[benchmarkId];

  if (!primaryBars || primaryBars.length <= config.warmupPeriod) {
    throw new Error(
      `BacktestEngine Error: Total bars (${primaryBars?.length ?? 0}) <= Warmup period (${config.warmupPeriod}).`
    );
  }

  // 1. KHỞI TẠO TÀI KHOẢN VÀ BỘ NHỚ NỘI BỘ CHIẾN LƯỢC
  let account: PortfolioAccountState = {
    cash: config.initialCapital,
    holdings: {},
  };

  let peakNav = config.initialCapital;
  let cumulativePnl = 0;

  const strategyStates: Record<StrategyId, StrategyState> = {
    ADAPTIVE_TREND: {
      strategyId: "ADAPTIVE_TREND",
      lastEvaluationTimestamp: 0,
      barsSinceLastSignal: 0,
      internalValues: {},
    },
    EVENT_REACTION: {
      strategyId: "EVENT_REACTION",
      lastEvaluationTimestamp: 0,
      barsSinceLastSignal: 0,
      internalValues: {},
    },
    MEAN_REVERSION: {
      strategyId: "MEAN_REVERSION",
      lastEvaluationTimestamp: 0,
      barsSinceLastSignal: 0,
      internalValues: {},
    },
  };

  const decisionHistory: DecisionState[] = [];
  const allExecutions: ExecutionRecord[] = [];
  let pendingRebalance: TargetPortfolioWeight | null = null;

  // 2. VÒNG LẶP DETERMINISTIC REPLAY (BẮT ĐẦU TỪ SAU WARMUP PERIOD)
  for (let t = config.warmupPeriod; t < primaryBars.length; t++) {
    const currentBar = primaryBars[t];
    const timestamp = currentBar.timestamp;

    // Lọc theo khoảng ngày backtest
    if (config.startDate > 0 && timestamp < config.startDate) continue;
    if (config.endDate > 0 && timestamp > config.endDate) break;

    // Snapshot giá các tài sản tại Bar T
    const currentAssetBars: Record<AssetId, PointInTimeBar> = {};
    for (const id of assetIds) {
      const bars = dataset.assetBars[id];
      if (bars && bars.length > t) {
        currentAssetBars[id] = bars[t];
      } else if (bars && bars.length > 0) {
        currentAssetBars[id] = bars[bars.length - 1];
      }
    }

    // A. XỬ LÝ KHỚP LỆNH CHỜ (NẾU DÙNG NEXT_BAR_OPEN)
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

    // B. CHUẨN BỊ POINT-IN-TIME CONTEXT CHO 3 ALPHAS (T-History only, strictly no lookahead)
    const macroState = getLatestMacroAsOf(dataset.macroTimeline, timestamp);
    const eventState = getLatestEventAsOf(dataset.eventTimeline, timestamp);
    const benchmarkSlice = primaryBars.slice(0, t + 1);

    // C. ĐÁNH GIÁ 3 CHIẾN LƯỢC ĐỘC LẬP
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

    // D. ĐIỀU TIẾT QUYỀN HẠN TẠI PERMISSION GATE
    const permissions = [
      evaluatePermission("ADAPTIVE_TREND", macroState, strategyConfigs.permission),
      evaluatePermission("EVENT_REACTION", macroState, strategyConfigs.permission),
      evaluatePermission("MEAN_REVERSION", macroState, strategyConfigs.permission),
    ];

    // E. ĐO LƯỜNG RỦI RO DANH MỤC & ĐỊNH CỠ BIẾN ĐỘNG (RISK ENGINE)
    let preAllocNav = account.cash;
    for (const [id, units] of Object.entries(account.holdings)) {
      const p = currentAssetBars[id]?.close ?? 0;
      preAllocNav += units * p;
    }
    if (preAllocNav > peakNav) peakNav = preAllocNav;

    const riskOutput = evaluatePortfolioRisk(
      preAllocNav,
      peakNav,
      benchmarkSlice,
      strategyConfigs.risk
    );

    // F. OMEGA ALLOCATOR: PHÂN BỔ TỶ TRỌNG MỤC TIÊU CUỐI CÙNG
    const targetWeights = evaluateOmegaAllocation(
      signals,
      permissions,
      riskOutput,
      null, // Tương quan PnL ban đầu (chưa đủ mẫu)
      timestamp,
      strategyConfigs.omega
    );

    // G. KHỚP LỆNH TỨC THỜI (NẾU DÙNG SAME_BAR_CLOSE)
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
      // Đưa target weights vào hàng đợi cho open nến sau
      pendingRebalance = targetWeights;
    }

    // H. TÍNH TOÁN NAV ĐÓNG CỬA VÀ ĐÓNG BĂNG AUDIT TRAIL TẠI BAR T
    let closingNav = account.cash;
    for (const [id, units] of Object.entries(account.holdings)) {
      const p = currentAssetBars[id]?.close ?? 0;
      closingNav += units * p;
    }
    if (closingNav > peakNav) peakNav = closingNav;

    const previousNav = decisionHistory.length > 0
      ? decisionHistory[decisionHistory.length - 1].nav
      : config.initialCapital;

    const dailyPnl = closingNav - previousNav;
    cumulativePnl += dailyPnl;
    const currentDrawdown = peakNav > 0 ? (peakNav - closingNav) / peakNav : 0;

    const auditState: DecisionState = {
      barIndex: t,
      timestamp,
      nav: Math.round(closingNav * 100) / 100,
      cash: Math.round(account.cash * 100) / 100,
      holdings: { ...account.holdings },
      signals,
      permissions,
      risk: riskOutput,
      targetWeights,
      executions: barExecutions,
      dailyPnl: Math.round(dailyPnl * 100) / 100,
      cumulativePnl: Math.round(cumulativePnl * 100) / 100,
      currentDrawdown: Math.round(currentDrawdown * 10000) / 10000,
    };

    decisionHistory.push(auditState);
  }

  // 3. TÍNH TOÁN TOÀN BỘ CHỈ SỐ METRICS THỐNG KÊ
  const metrics = calculatePerformanceMetrics(decisionHistory, config.initialCapital, allExecutions);

  return {
    runId: config.runId,
    config,
    timeline: decisionHistory,
    metrics,
    totalBarsEvaluated: decisionHistory.length,
  };
}