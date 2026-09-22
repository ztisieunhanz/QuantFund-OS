// ============================================================================
// FILE: src/lib/quant/types.ts
// MODULE: MODULAR INSTITUTIONAL QUANT ENGINE TYPE CONTRACT
// CORE PRINCIPLE: SIGNAL â‰  PERMISSION â‰  RISK â‰  ALLOCATION â‰  EXECUTION
// ============================================================================

import type {
  HistoricalMarketObservation,
  HistoricalMacroRelease,
  HistoricalEventRecord,
  HistoricalDataset,
  HistoricalDatasetMetadata,
  HistoricalContextAtTime,
} from "./historicalPit";

// ----------------------------------------------------------------------------
// 0. FUNDAMENTAL DOMAIN LITERALS & ENUMS
// ----------------------------------------------------------------------------

export type StrategyId =
  | "ADAPTIVE_TREND"
  | "EVENT_REACTION"
  | "MEAN_REVERSION";

// TÃ¡ch biá»‡t hoÃ n toÃ n Benchmark kiá»ƒm chá»©ng khá»i danh sÃ¡ch Alpha Engine
export type BenchmarkId = "BUY_AND_HOLD" | "DCA_SCHEDULE";

export type AssetId = string;

export type OrderSide = "BUY" | "SELL";

// Há»‡ thá»‘ng vá»‹ tháº¿ hai chiá»u há»— trá»£ Long / Short / Flat
export type PositionSide = "LONG" | "SHORT" | "FLAT";

export type PositionStatus = "OPEN" | "CLOSED" | "PENDING";

export type OrderType = "MARKET" | "LIMIT";

/**
 * ExecutionRule defines when target rebalances are filled:
 * - "NEXT_BAR_OPEN": Signal at bar t close, executed at bar t+1 open. CANONICAL PIT-SAFE EXECUTABLE TIMING.
 * - "SAME_BAR_CLOSE": Theoretical benchmark mode only. NOT PIT-SAFE EXECUTABLE TIMING.
 */
export type ExecutionRule = "NEXT_BAR_OPEN" | "SAME_BAR_CLOSE";

export type CircuitBreakerStatus = "NORMAL" | "WARNING" | "TRIPPED";

export type DataQualityStatus = "LIVE" | "SYNTHETIC" | "DELAYED" | "DEGRADED";

export type LiquidityStatus =
  | "EXPANDING"
  | "CONTRACTING"
  | "NORMAL"
  | "STRESS_DRAIN";

export type MacroRegime =
  | "Risk-On Expansion"
  | "Liquidity Drain"
  | "Flight to Dollar"
  | "Stagflation Hedge"
  | "Goldilocks"
  | "Transitional Mixed";

// ----------------------------------------------------------------------------
// 1. POINT-IN-TIME MARKET DATA & CONTEXT (INPUT LAYER)
// ----------------------------------------------------------------------------

export interface PointInTimeBar {
  readonly timestamp: number; // Unix epoch ms
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

export interface PointInTimeEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly eventTimestamp: number;            // Thá»i Ä‘iá»ƒm sá»± kiá»‡n thá»±c táº¿ diá»…n ra
  readonly publicationTimestamp: number;      // Thá»i Ä‘iá»ƒm sá»‘ liá»‡u cÃ´ng bá»‘ ra thá»‹ trÆ°á»ng
  readonly consensusSnapshotTimestamp: number;// Má»‘c chá»‘t sá»‘ liá»‡u dá»± bÃ¡o trÆ°á»›c giá» ra tin (ngÄƒn Look-Ahead)
  readonly actual: number | null;
  readonly consensus: number | null;
  readonly previous: number | null;
  readonly surprise: number | null;           // actual - consensus
  readonly sourceQuality: "TIER_1_OFFICIAL" | "TIER_2_BROKER" | "UNVERIFIED";
  readonly noveltyScore: number | null;       // [0.0 .. 1.0]
}

export interface PointInTimeMacro {
  readonly asOfTimestamp: number;
  readonly regime: MacroRegime;
  readonly regimeScore: number | null;
  readonly yield10Y: number | null;
  readonly yield2Y: number | null;
  readonly yieldSpreadBps: number | null;
  readonly vixLevel: number | null;
  readonly vixZScore: number | null;
  readonly marketBreadthRatio: number | null;
  readonly marketBreadthPctAboveMa20: number | null;
  readonly marketLiquidityRatio: number | null;
  readonly foreignNetFlowBillion: number | null;
}

export interface StrategyContext {
  readonly strategyId: StrategyId;
  readonly assetId: AssetId;
  readonly currentBarTimestamp: number;
  readonly decisionTimestamp: number;
  readonly currentPrice: number;
  readonly priceHistory: readonly PointInTimeBar[];
  readonly macro: PointInTimeMacro | null;
  readonly latestEvent: PointInTimeEvent | null;
}

// ----------------------------------------------------------------------------
// 2. SIGNAL OUTPUT (ALPHA ENGINE LAYER)
// ----------------------------------------------------------------------------

export interface SignalOutput {
  readonly strategyId: StrategyId;
  readonly assetId: AssetId;
  readonly timestamp: number;
  readonly alphaScore: number;                 // [-1.0 .. +1.0]
  readonly heuristicExpectedReturn: number;    // Heuristic Forecast (Linear mapping: Alpha * Vol * Scaling)
  readonly confidence: number;                 // [0.0 .. 1.0]
  readonly forecastVol: number;                // Biáº¿n Ä‘á»™ng nÄƒm hÃ³a dá»± bÃ¡o cá»§a riÃªng Alpha
  readonly holdingPeriod: number;              // Sá»‘ phiÃªn ká»³ vá»ng
  readonly decayRate?: number | null;          // Tá»· lá»‡ suy giáº£m tÃ­n hiá»‡u
  readonly validUntil?: number | null;
  readonly rationale: string;
  readonly metadata?: Readonly<Record<string, number | string | boolean | null>> | null;
}

// ----------------------------------------------------------------------------
// 3. STRATEGY STATE
// ----------------------------------------------------------------------------

export interface StrategyState {
  readonly strategyId: StrategyId;
  readonly lastEvaluationTimestamp: number;
  readonly barsSinceLastSignal: number;
  readonly internalValues: Readonly<Record<string, number | string | boolean | null>>;
}

// ----------------------------------------------------------------------------
// 4. PERMISSION GATE
// ----------------------------------------------------------------------------

export interface PermissionOutput {
  readonly strategyId: StrategyId;
  readonly permission: number; // [0.0 .. 1.0]
  readonly isPermitted: boolean;
  readonly reason: string;
  readonly regime: MacroRegime;
  readonly liquidityStatus: LiquidityStatus;
}

// ----------------------------------------------------------------------------
// 5. RISK ENGINE OUTPUT
// ----------------------------------------------------------------------------

export interface RiskOutput {
  readonly scope: StrategyId | "PORTFOLIO_AGGREGATE";
  readonly targetExposure: number;          // Háº¡n má»©c phÆ¡i nhiá»…m gá»™p tá»‘i Ä‘a
  readonly grossExposure: number;           // ÄÃ²n báº©y gá»™p hiá»‡n táº¡i
  readonly targetVolatility: number;        // Target Vol policy assumption (vÃ­ dá»¥ 0.12)
  readonly realizedVol: number;             // Biáº¿n Ä‘á»™ng thá»±c táº¿ Ä‘o lÆ°á»ng
  readonly forecastVol: number;             // Biáº¿n Ä‘á»™ng dá»± bÃ¡o toÃ n danh má»¥c
  readonly riskFlags: readonly string[];
  readonly circuitBreakerStatus: CircuitBreakerStatus;
  readonly circuitBreakerReason?: string | null;
}

// ----------------------------------------------------------------------------
// 6. TARGET POSITIONS & OMEGA ALLOCATOR
// ----------------------------------------------------------------------------

export interface TargetPosition {
  readonly strategyId: StrategyId;
  readonly assetId: AssetId;
  readonly targetUnits: number;
  readonly targetNotionalUsd: number;
  readonly targetExposureFraction: number;  // [-1.0 .. +1.0], Ã¢m biá»ƒu thá»‹ Short
  readonly timestamp: number;
}

export interface TargetPortfolioWeight {
  readonly asOfTimestamp: number;
  // CORE-07: Current executable portfolio is LONG-ONLY.
  // assetWeights values are clamped to >= 0 before this struct is returned from OmegaAllocator.
  // Negative alpha signal information is valid upstream but must not produce negative
  // executable weights in the current long-only engine.
  // (Type kept as number for future compatibility if short-selling is ever implemented.)
  readonly assetWeights: Readonly<Record<AssetId, number>>;
  readonly cashWeight: number;                             // Tiá»n máº·t phÃ²ng vá»‡
  readonly grossExposure: number;                          // Tá»•ng tuyá»‡t Ä‘á»‘i |Weights|
  readonly netExposure: number;                            // Tá»•ng Ä‘áº¡i sá»‘ Weights
  readonly strategyAllocations: Readonly<Record<StrategyId, number>>;
  readonly riskAdjustmentRatio: number;
  readonly rationale: string;
}

// ----------------------------------------------------------------------------
// 7. EXECUTION RECORD
// ----------------------------------------------------------------------------

export interface ExecutionRecord {
  readonly executionId: string;
  readonly orderId: string;
  readonly strategyId: StrategyId | "OMEGA_REBALANCE";
  readonly assetId: AssetId;
  readonly side: OrderSide;
  readonly orderType: OrderType;
  readonly signalTimestamp: number;
  readonly decisionTimestamp: number;
  readonly executionTimestamp: number;
  readonly intendedPrice: number;
  readonly executionPrice: number;
  readonly quantity: number;
  readonly notionalUsd: number;
  readonly slippage: number;
  readonly fees: number;
  readonly netCashImpact: number;
}

// ----------------------------------------------------------------------------
// ----------------------------------------------------------------------------
// 8. DECISION STATE AUDIT SNAPSHOT
// ----------------------------------------------------------------------------

export interface PositionRecord {
  readonly assetId: AssetId;
  readonly side: PositionSide;
  readonly status: PositionStatus;
  readonly quantity: number;
  readonly entryPrice: number;
  readonly unrealizedPnl: number;
}

export interface DecisionState {
  readonly barIndex: number;
  readonly timestamp: number;
  readonly nav: number;
  readonly cash: number;
  readonly positions: Readonly<Record<AssetId, PositionRecord>>;
  readonly signals: readonly SignalOutput[];
  readonly permissions: readonly PermissionOutput[];
  readonly risk: RiskOutput;
  readonly targetWeights: TargetPortfolioWeight;
  readonly executions: readonly ExecutionRecord[];
  readonly dailyPnl: number;
  readonly cumulativePnl: number;
  readonly currentDrawdown: number;
  readonly historicalContext?: HistoricalContextAtTime;
}

// ----------------------------------------------------------------------------
// 9. BACKTEST ENGINE CONFIGURATION
// ----------------------------------------------------------------------------

export interface SlippageModelConfig {
  readonly type: "FIXED_BPS" | "VOLUME_SHARE_IMPACT" | "LINEAR_SLIPPAGE";
  readonly baseBps: number;
  readonly impactFactor?: number | null;
}

export interface BacktestConfig {
  readonly runId: string;
  readonly startDate: number;
  readonly endDate: number;
  readonly warmupPeriod: number; // Pháº£i >= 125 Ä‘á»ƒ Ä‘Ã¡p á»©ng lookback cá»§a Adaptive Trend
  readonly initialCapital: number;
  readonly commissionRate: number;
  readonly slippageModel: SlippageModelConfig;
  readonly executionRule: ExecutionRule;
  readonly requirePitExecution?: boolean;
  readonly deterministicSeed: number;
  readonly dataQuality: DataQualityStatus;
}

// ----------------------------------------------------------------------------
// 10. CLOSED TRADE & ROUND-TRIP ATTRIBUTION CONTRACT
// ----------------------------------------------------------------------------

export interface ClosedTradeRecord {
  readonly tradeId: string;
  readonly episodeId: string;
  readonly assetId: AssetId;
  readonly exitTimestamp: number;
  readonly quantity: number;
  readonly averageEntryPrice: number;
  readonly exitPrice: number;
  readonly allocatedEntryCost: number;
  readonly allocatedEntryFees: number;
  readonly exitFees: number;
  readonly grossPnl: number;
  readonly netPnl: number;
}

export interface RoundTripEpisode {
  readonly episodeId: string;
  readonly assetId: AssetId;
  readonly entryTimestamp: number;
  readonly exitTimestamp: number;
  readonly totalEntryQuantity: number;
  readonly totalExitQuantity: number;
  readonly closedLotCount: number;
  readonly totalEntryFees: number;
  readonly totalExitFees: number;
  readonly grossPnl: number;
  readonly netPnl: number;
  readonly result: "WIN" | "LOSS" | "BREAK_EVEN";
}

export interface TradeAttributionSummary {
  readonly totalExecutions: number;
  readonly closedTradeCount: number;
  readonly roundTripCount: number;
  readonly wins: number;
  readonly losses: number;
  readonly breakEven: number;
  readonly winRatePct: number | null;
  readonly totalGrossPnl: number;
  readonly totalNetPnl: number;
  readonly totalEntryFees: number;
  readonly totalExitFees: number;
  readonly unallocatedEntryFees: number;
  readonly openQuantity: number;
}

// ----------------------------------------------------------------------------
// 11. HISTORICAL POINT-IN-TIME CONTRACTS (GATE M12B)
// ----------------------------------------------------------------------------

export type {
  HistoricalMarketObservation,
  HistoricalMacroRelease,
  HistoricalEventRecord,
  HistoricalDataset,
  HistoricalDatasetMetadata,
  HistoricalContextAtTime,
};
