// ============================================================================
// FILE: src/lib/macro/snapshot.ts
// MODULE: CURRENT MARKET SNAPSHOT BUILDER (GATE M3)
// PRINCIPLE: Combines DATA + MACRO + QUANT + RISK + OMEGA + SYNTHESIS (DEC-010)
// ============================================================================

import type { RiskOutput, SignalOutput, TargetPortfolioWeight } from "@/lib/quant/types";
import { buildOmegaLayerSummary } from "./omegaAdapter";
import { buildQuantLayerSummary } from "./quantAdapter";
import { buildRiskLayerSummary } from "./riskAdapter";
import { evaluateCurrentMarketSynthesis } from "./synthesis";
import type { CurrentMarketSnapshot, MacroAssessment, MarketSnapshotData } from "./types";

export interface BuildSnapshotParams {
  readonly timestamp: number;
  readonly data: MarketSnapshotData;
  readonly macro?: MacroAssessment | null;
  readonly signals?: readonly SignalOutput[] | null;
  readonly riskOutput?: RiskOutput | null;
  readonly targetWeights?: TargetPortfolioWeight | null;
  readonly drawdown?: number | null;
}

/**
 * Builds a complete CurrentMarketSnapshot instance containing all 6 core layers:
 * DATA + MACRO + QUANT + RISK + OMEGA + SYNTHESIS (DEC-010).
 */
export function buildCurrentMarketSnapshot(
  params: BuildSnapshotParams
): CurrentMarketSnapshot {
  const quant = buildQuantLayerSummary(params.signals, params.timestamp);
  const risk = buildRiskLayerSummary(params.riskOutput, params.drawdown);
  const omega = buildOmegaLayerSummary(params.targetWeights);

  const macro: MacroAssessment = params.macro ?? {
    status: "INSUFFICIENT_DATA",
    regime: null,
    evidence: [],
    conflicts: [],
    usableMetrics: [],
    unavailableMetrics: [],
    staleMetrics: [],
    excludedMetrics: [],
    coverage: { usable: 0, required: 4, totalCore: 6, ratio: 0 },
    confidence: null,
    model: { name: "MacroRegimeHeuristicV2", version: "2.0.0", classification: "HEURISTIC" },
    reason: "No macro assessment provided",
  };

  const synthesis = evaluateCurrentMarketSynthesis({
    snapshotData: params.data,
    macroAssessment: macro,
    quantSummary: quant,
    riskSummary: risk,
    omegaSummary: omega,
    referenceTimeMs: params.timestamp,
  });

  return {
    timestamp: params.timestamp,
    data: params.data,
    macro,
    quant,
    risk,
    omega,
    synthesis,
  };
}
