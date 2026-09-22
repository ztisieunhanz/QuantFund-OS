// ============================================================================
// FILE: src/lib/quant/types.ts
// MODULE: MODULAR INSTITUTIONAL QUANT ENGINE TYPE CONTRACT
// CORE PRINCIPLE: SIGNAL ≠ PERMISSION ≠ RISK ≠ ALLOCATION ≠ EXECUTION
// ============================================================================

// ----------------------------------------------------------------------------
// 0. FUNDAMENTAL DOMAIN LITERALS & ENUMS
// ----------------------------------------------------------------------------

export type StrategyId = 
  | "ADAPTIVE_TREND" 
  | "EVENT_REACTION" 
  | "MEAN_REVERSION";

// Tách biệt hoàn toàn Benchmark kiểm chứng khỏi danh sách Alpha Engine
export type BenchmarkId = "BUY_AND_HOLD" | "DCA_SCHEDULE";

export type AssetId = string;

export type OrderSide = "BUY" | "SELL";

// Hệ thống vị thế hai chiều hỗ trợ Long / Short / Flat
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
  readonly eventTimestamp: number;            // Thời điểm sự kiện thực tế diễn ra
  readonly publicationTimestamp: number;      // Thời điểm số liệu công bố ra thị trường
  readonly consensusSnapshotTimestamp: number;// Mốc chốt số liệu dự báo trước giờ ra tin (ngăn Look-Ahead)
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
  readonly forecastVol: number;                // Biến động năm hóa dự báo của riêng Alpha
  readonly holdingPeriod: number;              // Số phiên kỳ vọng
  readonly decayRate?: number | null;          // Tỷ lệ suy giảm tín hiệu
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
  readonly targetExposure: number;          // Hạn mức phơi nhiễm gộp tối đa
  readonly grossExposure: number;           // Đòn bẩy gộp hiện tại
  readonly targetVolatility: number;        // Target Vol policy assumption (ví dụ 0.12)
  readonly realizedVol: number;             // Biến động thực tế đo lường
  readonly forecastVol: number;             // Biến động dự báo toàn danh mục
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
  readonly targetExposureFraction: number;  // [-1.0 .. +1.0], âm biểu thị Short
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
  readonly cashWeight: number;                             // Tiền mặt phòng vệ
  readonly grossExposure: number;                          // Tổng tuyệt đối |Weights|
  readonly netExposure: number;                            // Tổng đại số Weights
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
  readonly warmupPeriod: number; // Phải >= 125 để đáp ứng lookback của Adaptive Trend
  readonly initialCapital: number;
  readonly commissionRate: number;
  readonly slippageModel: SlippageModelConfig;
  readonly executionRule: ExecutionRule;
  readonly requirePitExecution?: boolean;
  readonly deterministicSeed: number;
  readonly dataQuality: DataQualityStatus;
}