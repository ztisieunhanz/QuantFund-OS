// ============================================================================
// FILE: src/lib/macro/synthesis.ts
// MODULE: MACRO V2 CURRENT MARKET SYNTHESIS ENGINE (GATE M3)
// PRINCIPLE: Pure Synthesis Layer — Does Not Invent Alpha, Risk, or Allocation (DEC-008, DEC-010)
// ============================================================================

import type {
  MacroAssessment,
  MarketSnapshotData,
  MarketStance,
  OmegaLayerSummary,
  QuantLayerSummary,
  RiskLayerSummary,
  SynthesisAssessment,
  SynthesisEvidence,
  SynthesisStatus,
} from "./types";

export interface CurrentMarketSynthesisInput {
  readonly snapshotData?: MarketSnapshotData | null;
  readonly macroAssessment: MacroAssessment;
  readonly quantSummary: QuantLayerSummary;
  readonly riskSummary: RiskLayerSummary;
  readonly omegaSummary: OmegaLayerSummary;
  readonly referenceTimeMs?: number;
}

/**
 * Pure synthesis engine that combines observed MarketSnapshotData, MacroAssessment (Gate M2),
 * Quant strategy signals, Risk state, and Omega paper allocation into a single SynthesisAssessment.
 *
 * CONTRADICTION PRIORITY HIERARCHY:
 * 1. DATA QUALITY
 * 2. RISK
 * 3. MACRO
 * 4. QUANT
 * 5. OMEGA
 *
 * CORE INVARIANTS:
 * - SYNTHESIS IS NOT ANOTHER TRADING MODEL.
 * - Does NOT invent Alpha, position sizing, risk limits, trade PnLs, or forecast probabilities.
 * - Deterministic: identical inputs produce identical output.
 */
export function evaluateCurrentMarketSynthesis(
  input: CurrentMarketSynthesisInput
): SynthesisAssessment {
  const { macroAssessment, quantSummary, riskSummary, omegaSummary } = input;

  // 1. EVALUATE SYNTHESIS STATUS
  const macroAvailable = macroAssessment.status === "AVAILABLE";
  const riskAvailable = riskSummary.status === "AVAILABLE";
  const quantAvailable = quantSummary.status === "AVAILABLE" || quantSummary.status === "PARTIAL";

  let status: SynthesisStatus = "INSUFFICIENT_DATA";

  if (macroAvailable && riskAvailable && quantAvailable) {
    status = "AVAILABLE";
  } else if (
    (macroAvailable && (riskAvailable || quantAvailable)) ||
    (quantAvailable && riskAvailable)
  ) {
    status = "PARTIAL";
  } else {
    status = "INSUFFICIENT_DATA";
  }

  // 2. DETERMINE MARKET STANCE BASED ON PRIORITY HIERARCHY
  let stance: MarketStance = "UNDETERMINED";
  const isRiskRestrictive =
    riskAvailable &&
    (riskSummary.riskState === "TRIPPED" || riskSummary.riskState === "WARNING");

  const macroRegime = macroAssessment.regime;

  // Collect valid quant signals info
  const validQuantStrategies = quantSummary.strategies.filter((s) => s.signal != null);
  const positiveQuantSignals = validQuantStrategies.filter((s) => (s.signal ?? 0) > 0);
  const negativeQuantSignals = validQuantStrategies.filter((s) => (s.signal ?? 0) < 0);
  const hasPositiveQuant = positiveQuantSignals.length > 0;
  const hasNegativeQuant = negativeQuantSignals.length > 0;

  if (status === "INSUFFICIENT_DATA") {
    stance = "UNDETERMINED";
  } else if (isRiskRestrictive) {
    // Risk restrictive overrides optimistic synthesis into DEFENSIVE/MIXED semantics, never RISK_ON
    stance = riskSummary.riskState === "TRIPPED" ? "DEFENSIVE" : "MIXED";
  } else if (macroRegime === "LIQUIDITY_STRESS") {
    stance = "DEFENSIVE";
  } else if (macroRegime === "RISK_OFF") {
    if (hasPositiveQuant) {
      // Conflict: Macro is RISK_OFF but Quant has positive signals -> MIXED
      stance = "MIXED";
    } else {
      stance = "RISK_OFF";
    }
  } else if (macroRegime === "RISK_ON") {
    if (hasNegativeQuant && !hasPositiveQuant) {
      stance = "MIXED";
    } else {
      stance = "RISK_ON";
    }
  } else if (macroRegime === "MIXED" || macroRegime === "INFLATIONARY" || macroRegime === "DISINFLATIONARY") {
    if (hasPositiveQuant && !hasNegativeQuant) {
      stance = "RISK_ON";
    } else if (hasNegativeQuant && !hasPositiveQuant) {
      stance = "RISK_OFF";
    } else {
      stance = "MIXED";
    }
  } else {
    if (hasPositiveQuant && !hasNegativeQuant) {
      stance = "RISK_ON";
    } else if (hasNegativeQuant && !hasPositiveQuant) {
      stance = "RISK_OFF";
    } else {
      stance = "NEUTRAL";
    }
  }

  // 3. BUILD SUPPORTING & CONFLICTING EVIDENCE WITH PRESERVED LAYER CATEGORIES
  const supportingEvidence: SynthesisEvidence[] = [];
  const conflictingEvidence: SynthesisEvidence[] = [];

  // A. MACRO EVIDENCE
  if (macroAvailable) {
    for (const me of macroAssessment.evidence) {
      const se: SynthesisEvidence = {
        id: `macro-${me.id}`,
        layer: "MACRO",
        description: me.description,
        sourceIds: [...me.sourceIds],
      };
      if (
        (me.direction === "RISK_ON" && (stance === "RISK_ON" || stance === "MIXED")) ||
        (me.direction === "RISK_OFF" && (stance === "RISK_OFF" || stance === "DEFENSIVE" || stance === "MIXED"))
      ) {
        supportingEvidence.push(se);
      } else {
        conflictingEvidence.push(se);
      }
    }

    for (const mc of macroAssessment.conflicts) {
      conflictingEvidence.push({
        id: `macro-conflict-${mc.id}`,
        layer: "MACRO",
        description: mc.description,
        sourceIds: [...mc.sourceIds],
      });
    }
  }

  // B. RISK EVIDENCE
  if (riskAvailable) {
    if (isRiskRestrictive) {
      const riskEv: SynthesisEvidence = {
        id: "risk-circuit-breaker-restrictive",
        layer: "RISK",
        description: `Risk layer is constraining exposure (State: ${riskSummary.riskState}${riskSummary.note ? ` - ${riskSummary.note}` : ""}).`,
        sourceIds: ["risk_engine"],
      };
      if (stance === "DEFENSIVE" || stance === "MIXED") {
        supportingEvidence.push(riskEv);
      } else {
        conflictingEvidence.push(riskEv);
      }
    } else if (riskSummary.riskState === "NORMAL") {
      supportingEvidence.push({
        id: "risk-normal-exposure",
        layer: "RISK",
        description: "Risk engine operating within normal exposure limits.",
        sourceIds: ["risk_engine"],
      });
    }
  } else {
    conflictingEvidence.push({
      id: "risk-unavailable-warning",
      layer: "RISK",
      description: "Risk layer output is unavailable; synthesis operating without canonical risk bounds.",
      sourceIds: ["risk_engine"],
    });
  }

  // C. QUANT EVIDENCE
  if (quantAvailable) {
    for (const q of validQuantStrategies) {
      if (q.signal != null) {
        const signStr = q.signal > 0 ? "positive" : q.signal < 0 ? "negative" : "neutral";
        const qEv: SynthesisEvidence = {
          id: `quant-signal-${q.id}`,
          layer: "QUANT",
          description: `${q.name} active with ${signStr} signal (${q.signal > 0 ? "+" : ""}${q.signal.toFixed(2)}): ${q.state}`,
          sourceIds: [q.id],
        };

        let isSupporting = false;
        if (macroRegime === "RISK_OFF" || macroRegime === "LIQUIDITY_STRESS") {
          isSupporting = q.signal < 0; // Negative quant supports risk-off; positive quant conflicts
        } else if (macroRegime === "RISK_ON") {
          isSupporting = q.signal > 0; // Positive quant supports risk-on; negative quant conflicts
        } else {
          isSupporting =
            (q.signal > 0 && stance === "RISK_ON") ||
            (q.signal < 0 && (stance === "RISK_OFF" || stance === "DEFENSIVE"));
        }

        if (isSupporting) {
          supportingEvidence.push(qEv);
        } else {
          conflictingEvidence.push(qEv);
        }
      }
    }
  }

  // D. OMEGA EVIDENCE
  if (omegaSummary.status === "AVAILABLE" && omegaSummary.targetWeights) {
    const weightsStr = Object.entries(omegaSummary.targetWeights)
      .map(([k, v]) => `${k}: ${Math.round(v * 100)}%`)
      .join(", ");
    supportingEvidence.push({
      id: "omega-target-weights",
      layer: "OMEGA",
      description: `Omega paper research target allocation: ${weightsStr || "100% Cash"}.`,
      sourceIds: ["omega_allocator"],
    });
  }

  // 4. CONFIDENCE ARITHMETIC
  let confidence: number | null = null;

  if (status === "INSUFFICIENT_DATA") {
    confidence = null;
  } else {
    const baseMacroConf = macroAssessment.confidence ?? 60;
    let rawConf = baseMacroConf;

    // Layer completeness bonus/penalty
    if (!riskAvailable) rawConf -= 20;
    if (quantSummary.status === "UNAVAILABLE") rawConf -= 15;

    // Conflict penalty
    if (conflictingEvidence.length > 0) {
      rawConf -= conflictingEvidence.length * 5;
    }

    // Clamp
    rawConf = Math.max(10, Math.min(100, Math.round(rawConf)));

    if (status === "PARTIAL") {
      // PARTIAL confidence is strictly capped below full AVAILABLE case (cap at 60)
      confidence = Math.min(60, rawConf);
    } else {
      confidence = rawConf;
    }
  }

  // 5. DATA COVERAGE
  const dataCoverage = macroAssessment.coverage ? macroAssessment.coverage.ratio : 0;

  // 6. HEADLINE & RATIONALE GENERATION
  let headline = "";
  const rationale: string[] = [];

  if (status === "INSUFFICIENT_DATA") {
    headline = "Insufficient macro and quantitative data for authoritative synthesis.";
    rationale.push(
      macroAssessment.reason ?? "Required macro or risk data metrics are unavailable."
    );
  } else if (isRiskRestrictive) {
    headline = `Risk layer is constraining portfolio exposure (${riskSummary.riskState}).`;
    rationale.push(`Circuit breaker status is ${riskSummary.riskState}. Executive risk controls override optimistic signals.`);
    if (macroRegime) rationale.push(`Macro assessment regime is currently ${macroRegime}.`);
  } else if (macroRegime === "RISK_OFF" && hasPositiveQuant) {
    headline = "Macro conditions are risk-off while quantitative alpha signals remain mixed.";
    rationale.push("Macro V2 evidence indicates global risk-off stress.");
    rationale.push("Quantitative alpha strategies exhibit positive localized signals, creating cross-layer divergence.");
  } else if (stance === "RISK_ON") {
    headline = "Macro risk-on regime supported by quantitative alpha signals and normal risk bounds.";
    rationale.push("Macro V2 regime scoring indicates accommodative or calm market conditions.");
    rationale.push("Risk engine limits are normal and quantitative signals remain supportive.");
  } else if (stance === "RISK_OFF") {
    headline = "Macro and quantitative indicators aligned in risk-off stance.";
    rationale.push("Global macro indicators display defensive or liquidity stress characteristics.");
    rationale.push("Quantitative alpha engine signals are defensive or neutral.");
  } else {
    headline = "Mixed market conditions across macro and quantitative layers.";
    rationale.push(`Macro regime is assessed as ${macroRegime ?? "MIXED"}.`);
    rationale.push("Cross-layer evidence exhibits neutral or conflicting indicators.");
  }

  if (omegaSummary.status === "AVAILABLE" && omegaSummary.targetWeights) {
    const btcWeight = omegaSummary.targetWeights["BTC"] ?? 0;
    rationale.push(`Omega paper model target weight: ${Math.round(btcWeight * 100)}% BTC.`);
  }

  // 7. RISKS & INVALIDATION TRIGGERS
  const risks: string[] = [];
  const invalidation: string[] = [];

  if (macroRegime === "LIQUIDITY_STRESS" || macroRegime === "RISK_OFF") {
    risks.push("Elevated macroeconomic risk-off or liquidity stress.");
  }
  if (isRiskRestrictive) {
    risks.push(`Risk engine circuit breaker is ${riskSummary.riskState}.`);
  }
  if (!riskAvailable) {
    risks.push("Risk layer output unavailable — portfolio operating without live risk envelope.");
  }
  if (conflictingEvidence.length > 0) {
    risks.push(`${conflictingEvidence.length} cross-layer evidence conflict(s) detected.`);
  }

  invalidation.push(`Macro regime shifts from ${macroRegime ?? "current stance"}.`);
  invalidation.push("Risk engine circuit breaker status changes.");
  if (quantSummary.strongestStrategyId) {
    invalidation.push(`Current strongest strategy signal (${quantSummary.strongestStrategyId}) expires or changes sign.`);
  }
  invalidation.push("Omega paper allocation target changes materially.");

  return {
    status,
    stance,
    headline,
    rationale,
    supportingEvidence,
    conflictingEvidence,
    risks,
    invalidation,
    dataCoverage,
    confidence,
    model: {
      name: "CurrentMarketSynthesisV2",
      version: "2.0.0",
      classification: "SYNTHESIS",
    },
  };
}
