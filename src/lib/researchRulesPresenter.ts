// ============================================================================
// FILE: src/lib/researchRulesPresenter.ts
// MODULE: READ-ONLY CANONICAL RESEARCH PRESENTATION (P16-C / R1B)
//
// Presentation only. This module does not validate, classify, score, rank,
// derive eligibility, or produce ActionDecision state.
// ============================================================================

import type { CanonicalResearchRuntimeState } from "@/lib/quant/canonicalResearchRuntimeState";
import type { ParameterSpecification } from "@/lib/quant/hypothesisRegistry";
import type { CurrentM13ResearchEvidenceStatus } from "@/lib/quant/researchEvidenceRegistry";

export interface UnavailableResearchRulesPresentation {
  readonly availability: "UNAVAILABLE";
  readonly title: "Research evidence unavailable";
  readonly reasonCode: "NO_CANONICAL_RESEARCH_ARTIFACT";
  readonly reason: string;
  readonly explanation: string;
}

export interface ResearchEligibilityPresentation {
  readonly status: string;
  readonly eligibleForPaperEvaluation: boolean;
  readonly reasons: readonly string[];
  readonly semanticIdentity: string;
}

export interface ResearchEntryPresentation {
  readonly hypothesisId: string;
  readonly hypothesisVersion: string;
  readonly hypothesisTitle: string;
  readonly hypothesisDescription: string;
  readonly hypothesisSemanticIdentity: string;
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly ruleSemanticIdentity: string;
  readonly assetId: string;
  readonly declaredParameters: readonly string[];
  readonly parameterConfigurationIdentity: string;
  readonly trainingInterval: string;
  readonly oosInterval: string;
  readonly statefulOosBoundaryPolicy: string;
  readonly evidenceStatus: CurrentM13ResearchEvidenceStatus;
  readonly evidenceMeaning: string;
  readonly classificationReasons: readonly string[];
  readonly promotionDisposition: string;
  readonly rejectionDisposition: string;
  readonly heldOutEvidenceSemanticIdentity: string;
  readonly robustness: Readonly<{
    familyId: string;
    familyVersion: string;
    familyCompleteness: string;
    memberCompleteness: string;
    interpretation: string;
  }> | null;
  readonly provenance: readonly Readonly<{
    kind: string;
    schemaVersion: string;
    semanticIdentity: string;
  }>[];
  readonly eligibility: ResearchEligibilityPresentation | null;
  readonly evidenceSemanticIdentity: string;
  readonly predictiveValidityEstablished: false;
  readonly approvedForPaperAction: false;
}

export interface AvailableResearchRulesPresentation {
  readonly availability: "AVAILABLE";
  readonly title: "Canonical research evidence";
  readonly entryCount: number;
  readonly hypothesisRegistryIdentity: string;
  readonly evidenceRegistryIdentity: string;
  readonly eligibilityRegistryIdentity: string | null;
  readonly supportedEvidenceStatuses: readonly CurrentM13ResearchEvidenceStatus[];
  readonly unavailableEvidenceStatuses: readonly ("APPROVED_FOR_PAPER" | "REJECTED")[];
  readonly entries: readonly ResearchEntryPresentation[];
}

export type ResearchRulesPresentation =
  | UnavailableResearchRulesPresentation
  | AvailableResearchRulesPresentation;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function scalar(value: string | number | boolean | null): string {
  return value === null ? "null" : String(value);
}

function parameter(specification: ParameterSpecification): string {
  if (specification.kind === "FIXED") {
    return `${specification.name} = ${scalar(specification.value)}`;
  }
  if (specification.kind === "CANDIDATES") {
    return `${specification.name} ∈ [${specification.values.map(scalar).join(", ")}]`;
  }
  return `${specification.name} ∈ [${specification.minimum}, ${specification.maximum}] step ${specification.step}`;
}

function interval(startTime: number, endTime: number): string {
  return `${new Date(startTime).toISOString()} → ${new Date(endTime).toISOString()}`;
}

function evidenceMeaning(status: CurrentM13ResearchEvidenceStatus): string {
  return status === "CANDIDATE"
    ? "Research evidence remains under continued evaluation. This is not predictive validation or paper-action approval."
    : "Required research evidence is incomplete, insufficient, or non-evaluable under the canonical registry. This is not rejection.";
}

export function presentCanonicalResearchRuntimeState(
  state: CanonicalResearchRuntimeState
): ResearchRulesPresentation {
  if (state.availability === "UNAVAILABLE") {
    return deepFreeze({
      availability: "UNAVAILABLE" as const,
      title: "Research evidence unavailable" as const,
      reasonCode: state.reason.code,
      reason: state.reason.message,
      explanation: "No canonical runtime research artifact has been published to this read-only presentation source.",
    });
  }

  const hypotheses = new Map(
    state.hypothesisRegistry.hypotheses.map((hypothesis) => [hypothesis.semanticIdentity, hypothesis])
  );
  const eligibility = new Map(
    (state.strategyEligibilityRegistry?.records ?? []).map((record) => [record.evidenceSemanticIdentity, record])
  );

  const entries = state.evidenceRegistry.entries.map((entry): ResearchEntryPresentation => {
    const hypothesis = hypotheses.get(entry.hypothesisSemanticIdentity);
    if (!hypothesis) {
      throw new Error("Validated canonical research state has no linked hypothesis presentation record.");
    }
    const linkedEligibility = eligibility.get(entry.semanticIdentity) ?? null;
    return deepFreeze({
      hypothesisId: entry.hypothesisId,
      hypothesisVersion: entry.hypothesisVersion,
      hypothesisTitle: hypothesis.title,
      hypothesisDescription: hypothesis.description,
      hypothesisSemanticIdentity: entry.hypothesisSemanticIdentity,
      ruleId: entry.ruleId,
      ruleVersion: entry.ruleVersion,
      ruleSemanticIdentity: entry.ruleSemanticIdentity,
      assetId: entry.assetId,
      declaredParameters: hypothesis.parameterSpace.map(parameter),
      parameterConfigurationIdentity: entry.parameterConfigurationIdentity,
      trainingInterval: interval(entry.trainingInterval.startTime, entry.trainingInterval.endTime),
      oosInterval: interval(entry.oosInterval.startTime, entry.oosInterval.endTime),
      statefulOosBoundaryPolicy: entry.statefulOosBoundaryPolicy,
      evidenceStatus: entry.status,
      evidenceMeaning: evidenceMeaning(entry.status),
      classificationReasons: [...entry.classificationReasons],
      promotionDisposition: entry.promotionDisposition,
      rejectionDisposition: entry.rejectionDisposition,
      heldOutEvidenceSemanticIdentity: entry.heldOutEvidenceSemanticIdentity,
      robustness: entry.robustnessEvidence === null ? null : {
        familyId: entry.robustnessEvidence.familyId,
        familyVersion: entry.robustnessEvidence.familyVersion,
        familyCompleteness: entry.robustnessEvidence.familyCompleteness,
        memberCompleteness: entry.robustnessEvidence.memberCompleteness,
        interpretation: entry.robustnessEvidence.interpretation,
      },
      provenance: entry.provenance.map((item) => ({ ...item })),
      eligibility: linkedEligibility === null ? null : {
        status: linkedEligibility.eligibilityStatus,
        eligibleForPaperEvaluation: linkedEligibility.eligibleForPaperEvaluation,
        reasons: [...linkedEligibility.reasons],
        semanticIdentity: linkedEligibility.semanticIdentity,
      },
      evidenceSemanticIdentity: entry.semanticIdentity,
      predictiveValidityEstablished: false as const,
      approvedForPaperAction: false as const,
    });
  });

  return deepFreeze({
    availability: "AVAILABLE" as const,
    title: "Canonical research evidence" as const,
    entryCount: entries.length,
    hypothesisRegistryIdentity: state.hypothesisRegistry.semanticIdentity,
    evidenceRegistryIdentity: state.evidenceRegistry.semanticIdentity,
    eligibilityRegistryIdentity: state.strategyEligibilityRegistry?.semanticIdentity ?? null,
    supportedEvidenceStatuses: [...state.evidenceRegistry.supportedStatuses],
    unavailableEvidenceStatuses: [...state.evidenceRegistry.unavailableStatuses],
    entries,
  });
}
