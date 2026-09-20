// ============================================================================
// FILE: src/lib/macro/omegaAdapter.ts
// MODULE: MACRO V2 OMEGA LAYER ADAPTER
// PRINCIPLE: Reads Canonical Omega Paper Allocations — Long-Only & No DCA Fallbacks (DEC-004, Gate M3)
// ============================================================================

import type { TargetPortfolioWeight } from "@/lib/quant/types";
import type { OmegaLayerSummary } from "./types";

/**
 * Translates existing canonical TargetPortfolioWeight into an OmegaLayerSummary contract.
 *
 * IMPORTANT INVARIANTS (DEC-004, Gate M3):
 * 1. Long-only executable target semantics remain intact — weights must be non-negative (>= 0).
 * 2. DCA benchmark is NOT Omega and must NEVER appear as fallback allocation.
 * 3. Returns UNAVAILABLE if Omega output cannot be retrieved cleanly.
 * 4. Explicitly labels output source as "OMEGA_PAPER" (research / paper simulation only).
 */
export function buildOmegaLayerSummary(
  targetWeights: TargetPortfolioWeight | null | undefined
): OmegaLayerSummary {
  if (!targetWeights || !targetWeights.assetWeights) {
    return {
      status: "UNAVAILABLE",
      targetWeights: null,
      source: "OMEGA_PAPER",
      note: "Omega paper allocation output unavailable",
    };
  }

  const entries = Object.entries(targetWeights.assetWeights);
  if (entries.length === 0) {
    return {
      status: "UNAVAILABLE",
      targetWeights: null,
      source: "OMEGA_PAPER",
      note: "Omega paper allocation target weights are empty",
    };
  }

  // Strict Fail-Closed Validation (DEC-004, Gate M3):
  // Do NOT repair, clamp, or modify invalid upstream Omega outputs.
  // If any weight is negative or non-finite (NaN / Infinity), fail closed with status UNAVAILABLE.
  for (const [asset, weight] of entries) {
    if (!Number.isFinite(weight) || weight < 0) {
      return {
        status: "UNAVAILABLE",
        targetWeights: null,
        source: "OMEGA_PAPER",
        note: `Upstream Omega target weight for "${asset}" failed long-only/finite validation (weight: ${weight})`,
      };
    }
  }

  // Preserve exact upstream weights without rescaling, renormalization, or DCA substitution
  return {
    status: "AVAILABLE",
    targetWeights: { ...targetWeights.assetWeights },
    source: "OMEGA_PAPER",
    note: targetWeights.rationale || null,
  };
}
