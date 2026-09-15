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

export type AssetId = string;

export type Side = "BUY" | "SELL" | "HOLD";

export type OrderType = "MARKET" | "LIMIT";

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
  readonly eventTimestamp: number;       // Thời điểm sự kiện diễn ra thực tế
  readonly publicationTimestamp: number; // Thời điểm số liệu được công bố rộng rãi
  readonly actual: number | null;
  readonly consensus: number | null;
  readonly previous: number | null;
  readonly surprise: number | null;      // actual - consensus
  readonly sourceQuality: "TIER_1_OFFICIAL" | "TIER_2_BROKER" | "UNVERIFIED";
  readonly noveltyScore: number | null;  // Normalized 0.0 .. 1.0
}

export interface PointInTimeMacro {
  readonly asOfTimestamp: number;
  readonly regime: MacroRegime;
  readonly regimeScore: number | null;
  readonly yield10Y: number | null;
  readonly yield2Y: number | null;
  readonly yieldSpreadBps: number | null; // 10Y - 2Y (bps)
  readonly vixLevel: number | null;
  readonly vixZScore: number | null;
  readonly marketBreadthRatio: number | null;
  readonly marketBreadthPctAboveMa20: number | null;
  readonly marketLiquidityRatio: number | null; // Khớp lệnh / MA20 thanh khoản
  readonly foreignNetFlowBillion: number | null;
}

/**
 * StrategyContext: Dữ liệu duy nhất Alpha Engine được phép đọc tại bar T.
 * Toàn bộ mảng dữ liệu là point-in-time, bất biến, tuyệt đối không chứa dữ liệu T+1.
 */
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

/**
 * SignalOutput: Đầu ra tinh khiết của Alpha Engine.
 * Không chứa position size, không chứa lệnh, không chứa portfolio weights.
 */
export interface SignalOutput {
  readonly strategyId: StrategyId;
  readonly assetId: AssetId;
  readonly timestamp: number;
  readonly alphaScore: number;          // [-1.0 .. +1.0] Chiều hướng & cường độ toán học
  readonly expectedReturn: number;      // Tỷ suất sinh lời kỳ vọng (annualized hoặc theo holding period)
  readonly confidence: number;          // [0.0 .. 1.0] Độ tin cậy thống kê của signal
  readonly forecastVol: number;         // Biến động năm hóa dự báo của Alpha
  readonly holdingPeriod: number;       // Thời gian nắm giữ kỳ vọng (số phiên)
  readonly decayRate?: number | null;   // Tỷ lệ suy giảm tín hiệu mỗi bar (đặc biệt cho Event)
  readonly validUntil?: number | null;  // Thời điểm tín hiệu hết hạn nếu không kích hoạt
  readonly metadata?: Readonly<Record<string, number | string | boolean>> | null;
}

// ----------------------------------------------------------------------------
// 3. STRATEGY STATE & CONFIGURATION
// ----------------------------------------------------------------------------

export interface StrategyState {
  readonly strategyId: StrategyId;
  readonly lastEvaluationTimestamp: number;
  readonly barsSinceLastSignal: number;
  readonly internalValues: Readonly<Record<string, number | string | boolean | null>>;
}

export interface StrategyConfig {
  readonly strategyId: StrategyId;
  readonly enabled: boolean;
  readonly parameters: Readonly<Record<string, number | string | boolean>>;
}

// ----------------------------------------------------------------------------
// 4. PERMISSION GATE (MACRO/LIQUIDITY FILTER LAYER)
// ----------------------------------------------------------------------------

export interface PermissionOutput {
  readonly strategyId: StrategyId;
  readonly permission: number; // [0.0 .. 1.0] Hệ số điều tiết quyền hoạt động
  readonly isPermitted: boolean;
  readonly reason: string;
  readonly regime: MacroRegime;
  readonly liquidityStatus: LiquidityStatus;
}

// ----------------------------------------------------------------------------
// 5. RISK ENGINE OUTPUT (PORTFOLIO RISK LAYER)
// ----------------------------------------------------------------------------

/**
 * RiskOutput: Quản trị biến động và drawdown.
 * Phân biệt rạch ròi giữa realizedVol, forecastVol và targetVolatility.
 */
export interface RiskOutput {
  readonly scope: StrategyId | "PORTFOLIO_AGGREGATE";
  readonly targetExposure: number;         // Exposure được phép tối đa theo Risk Engine
  readonly grossExposure: number;          // Đòn bẩy gộp hiện hữu
  readonly targetVolatility: number;       // Volatility mục tiêu (ví dụ 12% = 0.12)
  readonly realizedVol: number;            // Volatility thực tế đo lường trong quá khứ
  readonly forecastVol: number;            // Volatility dự báo toàn danh mục
  readonly riskFlags: readonly string[];
  readonly circuitBreakerStatus: CircuitBreakerStatus;
  readonly circuitBreakerReason?: string | null;
}

// ----------------------------------------------------------------------------
// 6. TARGET POSITIONS & OMEGA ALLOCATOR
// ----------------------------------------------------------------------------

/**
 * TargetPosition: Ý định vị thế của một strategy đơn lẻ sau khi qua Risk.
 */
export interface TargetPosition {
  readonly strategyId: StrategyId;
  readonly assetId: AssetId;
  readonly targetUnits: number;
  readonly targetNotionalUsd: number;
  readonly targetExposureFraction: number; // [-1.0 .. +1.0]
  readonly timestamp: number;
}

/**
 * TargetPortfolioWeight: Phân bổ tài sản cuối cùng do Omega Allocator thiết lập.
 */
export interface TargetPortfolioWeight {
  readonly asOfTimestamp: number;
  readonly assetWeights: Readonly<Record<AssetId, number>>;
  readonly cashWeight: number;
  readonly grossExposure: number;
  readonly netExposure: number;
  readonly strategyAllocations: Readonly<Record<StrategyId, number>>;
  readonly riskAdjustmentRatio: number;
  readonly rationale: string;
}

// ----------------------------------------------------------------------------
// 7. EXECUTION RECORD (TRANSACTION LOG LAYER)
// ----------------------------------------------------------------------------

export interface ExecutionRecord {
  readonly executionId: string;
  readonly orderId: string;
  readonly strategyId: StrategyId | "OMEGA_REBALANCE";
  readonly assetId: AssetId;
  readonly side: Side;
  readonly orderType: OrderType;
  readonly signalTimestamp: number;
  readonly decisionTimestamp: number;
  readonly executionTimestamp: number;
  readonly intendedPrice: number;
  readonly executionPrice: number;
  readonly quantity: number;
  readonly notionalUsd: number;
  readonly slippage: number; // Đơn vị tiền tệ tuyệt đối hoặc bps
  readonly fees: number;     // Phí giao dịch sàn
  readonly netCashImpact: number;
}

// ----------------------------------------------------------------------------
// 8. COMPLETE DECISION STATE (AUDIT & REPLAY SNAPSHOT)
// ----------------------------------------------------------------------------

/**
 * DecisionState: Bản chụp đóng băng trạng thái của toàn hệ thống tại mỗi bar.
 * Cung cấp đầy đủ dấu vết (Audit Trail) để tái lập 100% quyết định.
 */
export interface DecisionState {
  readonly barIndex: number;
  readonly timestamp: number;
  readonly nav: number;
  readonly cash: number;
  readonly holdings: Readonly<Record<AssetId, number>>;
  
  // Dòng chảy dữ liệu từng tầng
  readonly signals: readonly SignalOutput[];
  readonly permissions: readonly PermissionOutput[];
  readonly risk: RiskOutput;
  readonly targetWeights: TargetPortfolioWeight;
  readonly executions: readonly ExecutionRecord[];
  
  // Chỉ số hiệu suất luỹ kế
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
  readonly startDate: number; // Unix epoch ms
  readonly endDate: number;   // Unix epoch ms
  readonly warmupPeriod: number; // Số phiên nạp dữ liệu trước ngày bắt đầu replay
  readonly initialCapital: number;
  readonly commissionRate: number; // Ví dụ 0.001 = 0.1%
  readonly slippageModel: SlippageModelConfig;
  readonly executionRule: ExecutionRule;
  readonly deterministicSeed: number;
  readonly dataQuality: DataQualityStatus;
}