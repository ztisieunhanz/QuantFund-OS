// ============================================================================
// FILE: src/lib/quant/permissionGate.ts
// MODULE: PERMISSION GATE (REGIME-TO-STRATEGY COMPATIBILITY ONLY)
// ============================================================================

import type {
  StrategyId,
  MacroRegime,
  LiquidityStatus,
  PointInTimeMacro,
  PermissionOutput,
} from "@/lib/quant/types";

export interface PermissionGateConfig {
  readonly regimeMatrix: Readonly<Record<MacroRegime, Readonly<Record<StrategyId, number>>>>;
  readonly minPermissionThreshold: number;
}

export const DEFAULT_PERMISSION_CONFIG: PermissionGateConfig = {
  regimeMatrix: {
    "Risk-On Expansion": {
      ADAPTIVE_TREND: 1.0,
      EVENT_REACTION: 0.8,
      MEAN_REVERSION: 0.6,
    },
    "Goldilocks": {
      ADAPTIVE_TREND: 0.9,
      EVENT_REACTION: 0.8,
      MEAN_REVERSION: 0.8,
    },
    "Transitional Mixed": {
      ADAPTIVE_TREND: 0.7,
      EVENT_REACTION: 0.9,
      MEAN_REVERSION: 0.9,
    },
    "Flight to Dollar": {
      ADAPTIVE_TREND: 0.7,
      EVENT_REACTION: 0.9,
      MEAN_REVERSION: 0.4,
    },
    "Liquidity Drain": {
      ADAPTIVE_TREND: 0.5,
      EVENT_REACTION: 0.8,
      MEAN_REVERSION: 0.2,
    },
    "Stagflation Hedge": {
      ADAPTIVE_TREND: 0.6,
      EVENT_REACTION: 0.8,
      MEAN_REVERSION: 0.3,
    },
  },
  minPermissionThreshold: 0.05,
};

export function evaluatePermission(
  strategyId: StrategyId,
  macro: PointInTimeMacro | null,
  config: PermissionGateConfig = DEFAULT_PERMISSION_CONFIG
): PermissionOutput {
  const regime: MacroRegime = macro?.regime ?? "Transitional Mixed";

  let liquidityStatus: LiquidityStatus = "NORMAL";
  if (macro?.marketLiquidityRatio !== null && macro?.marketLiquidityRatio !== undefined) {
    if (macro.marketLiquidityRatio >= 1.20) liquidityStatus = "EXPANDING";
    else if (macro.marketLiquidityRatio <= 0.70) liquidityStatus = "STRESS_DRAIN";
    else if (macro.marketLiquidityRatio <= 0.90) liquidityStatus = "CONTRACTING";
  }

  const basePermission = config.regimeMatrix[regime]?.[strategyId] ?? 0.5;

  let liquidityMultiplier = 1.0;
  if (liquidityStatus === "STRESS_DRAIN") {
    if (strategyId === "MEAN_REVERSION") liquidityMultiplier = 0.4;
    else if (strategyId === "ADAPTIVE_TREND") liquidityMultiplier = 0.8;
  } else if (liquidityStatus === "CONTRACTING" && strategyId === "MEAN_REVERSION") {
    liquidityMultiplier = 0.7;
  }

  const finalPermission = Math.max(0.0, Math.min(1.0, basePermission * liquidityMultiplier));
  const isPermitted = finalPermission >= config.minPermissionThreshold;

  return {
    strategyId,
    permission: Math.round(finalPermission * 100) / 100,
    isPermitted,
    reason: `Regime[${regime}]=${basePermission.toFixed(2)}, Liq[${liquidityStatus}]=${liquidityMultiplier.toFixed(2)}`,
    regime,
    liquidityStatus,
  };
}