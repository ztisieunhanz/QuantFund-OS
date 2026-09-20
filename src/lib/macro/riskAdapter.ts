// ============================================================================
// FILE: src/lib/macro/riskAdapter.ts
// MODULE: MACRO V2 RISK LAYER ADAPTER
// PRINCIPLE: Reads Canonical Risk Output Only — Does Not Recompute Risk (DEC-001, Gate M3)
// ============================================================================

import type { RiskOutput } from "@/lib/quant/types";
import type { RiskLayerSummary } from "./types";

/**
 * Translates existing canonical RiskOutput into a clean RiskLayerSummary contract.
 *
 * IMPORTANT INVARIANTS (Gate M3):
 * 1. Reads existing canonical Risk output only — does NOT recompute risk in synthesis.
 * 2. If Risk output is missing/null, returns status "UNAVAILABLE" rather than inventing low-risk defaults.
 */
export function buildRiskLayerSummary(
  risk: RiskOutput | null | undefined,
  drawdown?: number | null
): RiskLayerSummary {
  if (!risk) {
    return {
      status: "UNAVAILABLE",
      riskState: null,
      grossExposure: null,
      allowedExposure: null,
      drawdown: null,
      note: "Risk layer output unavailable",
    };
  }

  const flagsText = risk.riskFlags && risk.riskFlags.length > 0 ? risk.riskFlags.join("; ") : null;

  return {
    status: "AVAILABLE",
    riskState: risk.circuitBreakerStatus,
    grossExposure: risk.grossExposure,
    allowedExposure: risk.targetExposure,
    drawdown: drawdown ?? null,
    note: risk.circuitBreakerReason ?? flagsText ?? null,
  };
}
