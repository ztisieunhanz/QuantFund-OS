// ============================================================================
// FILE: src/lib/quant/permissionGate.ts
// MODULE: SIGNAL NORMALIZER & MACRO PERMISSION GATE
// PRINCIPLE: Alpha creates edge -> Permission gate determines if environment allows it
// ============================================================================

import type {
  SignalOutput,
  PermissionOutput,
  StrategyId,
  PointInTimeMacro,
  MacroRegime,
  LiquidityStatus,
} from "@/lib/quant/types";

// ----------------------------------------------------------------------------
// 1. CONFIGURATION INTERFACES & RESEARCH ASSUMPTIONS
// ----------------------------------------------------------------------------

export interface RegimePermissionMatrix {
  readonly [regime: string]: {
    readonly [strategy in StrategyId]: number;
  };
}

export interface LiquidityModifierConfig {
  readonly EXPANDING: number;
  readonly NORMAL: number;
  readonly CONTRACTING: number;
  readonly STRESS_DRAIN: number;
}

export interface PermissionGateConfig {
  readonly regimeMatrix: RegimePermissionMatrix;
  readonly liquidityModifiers: LiquidityModifierConfig;
  readonly minimumAllowedThreshold: number; // Dưới ngưỡng này coi như isPermitted = false (mặc định 0.05)
}

/**
 * Ma trận phân quyền nghiên cứu ban đầu (Research Hypotheses):
 * - Trend: Hoạt động mạnh trong Expansion, Flight to Dollar, Stagflation; suy giảm trong High Stress giật cục.
 * - Event: Duy trì khả năng phản ứng tốt trong mọi môi trường có tin sốc; tối đa hóa trong Stress/Stagflation.
 * - Mean Reversion: Chỉ tối ưu trong thị trường Neutral/Goldilocks ổn định; bị bóp nghẹt triệt để trong Drain/Stress để tránh bẫy thanh khoản.
 */
export const DEFAULT_REGIME_MATRIX: RegimePermissionMatrix = {
  "Risk-On Expansion": {
    ADAPTIVE_TREND: 1.0,
    EVENT_REACTION: 0.8,
    MEAN_REVERSION: 0.5,
  },
  "Goldilocks": {
    ADAPTIVE_TREND: 1.0,
    EVENT_REACTION: 0.8,
    MEAN_REVERSION: 0.7,
  },
  "Transitional Mixed": {
    ADAPTIVE_TREND: 0.8,
    EVENT_REACTION: 0.9,
    MEAN_REVERSION: 0.8,
  },
  "Liquidity Drain": {
    ADAPTIVE_TREND: 0.8,
    EVENT_REACTION: 0.9,
    MEAN_REVERSION: 0.25,
  },
  "Flight to Dollar": {
    ADAPTIVE_TREND: 0.9,
    EVENT_REACTION: 0.9,
    MEAN_REVERSION: 0.2,
  },
  "Stagflation Hedge": {
    ADAPTIVE_TREND: 0.7,
    EVENT_REACTION: 1.0,
    MEAN_REVERSION: 0.2,
  },
};

export const DEFAULT_LIQUIDITY_MODIFIERS: LiquidityModifierConfig = {
  EXPANDING: 1.0,
  NORMAL: 1.0,
  CONTRACTING: 0.8,
  STRESS_DRAIN: 0.35, // Thanh khoản cạn kiệt: hạ mạnh tỷ trọng toàn bộ các alpha
};

export const DEFAULT_PERMISSION_CONFIG: PermissionGateConfig = {
  regimeMatrix: DEFAULT_REGIME_MATRIX,
  liquidityModifiers: DEFAULT_LIQUIDITY_MODIFIERS,
  minimumAllowedThreshold: 0.05,
};

// ----------------------------------------------------------------------------
// 2. SIGNAL NORMALIZATION
// ----------------------------------------------------------------------------

/**
 * Chuẩn hóa và làm sạch tín hiệu đầu ra của Alpha Engine.
 * Đảm bảo các giá trị không bị tràn mốc biên và xử lý trường hợp tín hiệu quá hạn.
 */
export function normalizeSignal(
  rawSignal: SignalOutput,
  currentTimestamp: number
): SignalOutput {
  // 1. Kiểm tra thời hạn hiệu lực của tín hiệu
  if (rawSignal.validUntil !== null && rawSignal.validUntil !== undefined && currentTimestamp > rawSignal.validUntil) {
    return {
      ...rawSignal,
      alphaScore: 0,
      expectedReturn: 0,
      confidence: 0,
      rationale: `SIGNAL_EXPIRED: CurrentTime (${currentTimestamp}) > ValidUntil (${rawSignal.validUntil})`,
    };
  }

  // 2. Chặn giá trị toán học biên
  const alphaScore = Math.max(-1.0, Math.min(1.0, Number.isFinite(rawSignal.alphaScore) ? rawSignal.alphaScore : 0));
  const confidence = Math.max(0.0, Math.min(1.0, Number.isFinite(rawSignal.confidence) ? rawSignal.confidence : 0));
  const forecastVol = Math.max(0.01, Number.isFinite(rawSignal.forecastVol) ? rawSignal.forecastVol : 0.2);
  const expectedReturn = Number.isFinite(rawSignal.expectedReturn) ? rawSignal.expectedReturn : 0;
  const holdingPeriod = Math.max(1, Math.round(rawSignal.holdingPeriod || 1));

  return {
    ...rawSignal,
    alphaScore,
    expectedReturn,
    confidence,
    forecastVol,
    holdingPeriod,
  };
}

// ----------------------------------------------------------------------------
// 3. PERMISSION GATE EVALUATION
// ----------------------------------------------------------------------------

export function evaluatePermission(
  strategyId: StrategyId,
  macro: PointInTimeMacro | null,
  config: PermissionGateConfig = DEFAULT_PERMISSION_CONFIG
): PermissionOutput {
  // Trường hợp không có dữ liệu vĩ mô: cấp phép tối thiểu mang tính phòng vệ
  if (!macro) {
    return {
      strategyId,
      permission: 0.5,
      isPermitted: true,
      regime: "Transitional Mixed",
      liquidityStatus: "NORMAL",
      reason: "DEFAULT_FALLBACK: Macro point-in-time state is unavailable",
    };
  }

  const regime: MacroRegime = macro.regime;
  
  // Xác định trạng thái thanh khoản từ tỷ lệ khớp lệnh thực tế
  let liquidityStatus: LiquidityStatus = "NORMAL";
  if (macro.marketLiquidityRatio !== null) {
    if (macro.marketLiquidityRatio >= 1.15) liquidityStatus = "EXPANDING";
    else if (macro.marketLiquidityRatio <= 0.60) liquidityStatus = "STRESS_DRAIN";
    else if (macro.marketLiquidityRatio <= 0.85) liquidityStatus = "CONTRACTING";
  }

  // 1. Trích xuất quyền hạn theo Regime
  const regimeRow = config.regimeMatrix[regime] ?? config.regimeMatrix["Transitional Mixed"];
  const baseRegimePermission = regimeRow[strategyId] ?? 0.5;

  // 2. Trích xuất hệ số điều chỉnh theo Thanh khoản
  const liquidityMultiplier = config.liquidityModifiers[liquidityStatus] ?? 1.0;

  // 3. Tính toán hệ số phân quyền tổng hợp
  let finalPermission = baseRegimePermission * liquidityMultiplier;

  // Xử lý đặc thù cho Mean Reversion: Cấm tuyệt đối nếu thanh khoản rơi vào STRESS_DRAIN
  if (strategyId === "MEAN_REVERSION" && liquidityStatus === "STRESS_DRAIN") {
    finalPermission = 0.0;
  }

  finalPermission = Math.max(0.0, Math.min(1.0, Math.round(finalPermission * 1000) / 1000));
  const isPermitted = finalPermission >= config.minimumAllowedThreshold;

  return {
    strategyId,
    permission: finalPermission,
    isPermitted,
    regime,
    liquidityStatus,
    reason: isPermitted
      ? `PERMITTED[${regime}][${liquidityStatus}]: Multiplier=${finalPermission.toFixed(2)}`
      : `BLOCKED[${regime}][${liquidityStatus}]: Permission below threshold (${finalPermission.toFixed(2)} < ${config.minimumAllowedThreshold})`,
  };
}

/**
 * Kết hợp Tín hiệu chuẩn hóa với Cổng phân quyền để tạo Effective Alpha Vector
 */
export function applyPermissionToSignal(
  normalizedSignal: SignalOutput,
  permission: PermissionOutput
): SignalOutput {
  const effectiveAlphaScore = normalizedSignal.alphaScore * permission.permission;
  const effectiveExpectedReturn = normalizedSignal.expectedReturn * permission.permission;
  const effectiveConfidence = normalizedSignal.confidence * permission.permission;

  return {
    ...normalizedSignal,
    alphaScore: Math.round(effectiveAlphaScore * 1000) / 1000,
    expectedReturn: Math.round(effectiveExpectedReturn * 10000) / 10000,
    confidence: Math.round(effectiveConfidence * 100) / 100,
    rationale: `${normalizedSignal.rationale} | PermGate=${permission.permission.toFixed(2)} (${permission.isPermitted ? "PASS" : "BLOCK"})`,
  };
}