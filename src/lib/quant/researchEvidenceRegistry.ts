// ============================================================================
// FILE: src/lib/quant/researchEvidenceRegistry.ts
// MODULE: RESEARCH EVIDENCE REGISTRY (M13D / D-D)
//
// Classifies already-validated M13 evidence without rerunning research,
// inventing promotion/rejection thresholds, or granting trading authority.
// ============================================================================

import {
  serializeHypothesisRegistry,
  type HypothesisRegistrySnapshot,
  type RegisteredResearchHypothesis,
  type ResearchInterval,
  type StatefulOosBoundaryPolicy,
} from "./hypothesisRegistry";
import {
  validateHeldOutOosEvidenceSummary,
  type HeldOutOosEvidenceSummary,
} from "./heldOutOosEvaluation";
import {
  validateRobustnessFamilyPreregistration,
  type RobustnessFamilyPreregistration,
} from "./robustnessFamilyPreregistration";
import {
  validateRobustnessFamilyEvaluation,
  type RobustnessFamilyEvaluation,
  type RobustnessFamilyMemberEvaluation,
} from "./robustnessFamilyEvaluation";
import type { AssetId } from "./types";

export const RESEARCH_EVIDENCE_REGISTRY_SCHEMA_VERSION = "M13D-D-D-1";

export type ResearchEvidenceStatus =
  | "CANDIDATE"
  | "APPROVED_FOR_PAPER"
  | "REJECTED"
  | "INSUFFICIENT_EVIDENCE";

export type CurrentM13ResearchEvidenceStatus =
  | "CANDIDATE"
  | "INSUFFICIENT_EVIDENCE";

export interface RobustnessEvidenceInput {
  readonly family: RobustnessFamilyPreregistration;
  readonly evaluation: RobustnessFamilyEvaluation;
  readonly memberId: string;
}

export interface ResearchEvidenceInput {
  readonly hypothesisId: string;
  readonly hypothesisVersion: string;
  readonly heldOutEvidence: HeldOutOosEvidenceSummary;
  readonly robustnessEvidence?: RobustnessEvidenceInput;
}

export interface ResearchEvidenceProvenance {
  readonly kind: "HELD_OUT_OOS" | "SHARED_OOS_SENSITIVITY";
  readonly schemaVersion: string;
  readonly semanticIdentity: string;
}

export interface RegisteredRobustnessEvidenceBinding {
  readonly familyId: string;
  readonly familyVersion: string;
  readonly familySemanticIdentity: string;
  readonly evaluationSemanticIdentity: string;
  readonly memberId: string;
  readonly memberTrialIdentity: string;
  readonly familyCompleteness: RobustnessFamilyEvaluation["familyCompleteness"];
  readonly memberCompleteness: RobustnessFamilyMemberEvaluation["completeness"];
  readonly independentConfirmation: false;
  readonly selectionPolicy: "NO_POST_OOS_VARIANT_SELECTION";
  readonly interpretation: "DESCRIPTIVE_ONLY_NO_ROBUSTNESS_THRESHOLD";
}

export interface RegisteredResearchEvidence {
  readonly kind: "REGISTERED_RESEARCH_EVIDENCE";
  readonly hypothesisId: string;
  readonly hypothesisVersion: string;
  readonly hypothesisSemanticIdentity: string;
  readonly hypothesisLifecycle: RegisteredResearchHypothesis["lifecycle"];
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly ruleSemanticIdentity: string;
  readonly parameterConfigurationIdentity: string;
  readonly trialAccountingIdentity: string;
  readonly assetId: AssetId;
  readonly trainingInterval: ResearchInterval;
  readonly oosInterval: ResearchInterval;
  readonly statefulOosBoundaryPolicy: StatefulOosBoundaryPolicy;
  readonly heldOutEvidenceSemanticIdentity: string;
  readonly robustnessEvidence: RegisteredRobustnessEvidenceBinding | null;
  readonly provenance: readonly ResearchEvidenceProvenance[];
  readonly status: CurrentM13ResearchEvidenceStatus;
  readonly classificationReasons: readonly string[];
  readonly promotionDisposition: "UNAVAILABLE_NO_PREREGISTERED_PROMOTION_CONTRACT";
  readonly rejectionDisposition: "UNAVAILABLE_NO_MACHINE_EXECUTABLE_FALSIFICATION_CONTRACT";
  readonly semanticIdentity: string;
  readonly predictiveValidityEstablished: false;
  readonly approvedForPaperAction: false;
  readonly grantsExecutionAuthority: false;
  readonly priceAuthority: "NONE";
}

export interface ResearchEvidenceRegistrySnapshot {
  readonly schemaVersion: typeof RESEARCH_EVIDENCE_REGISTRY_SCHEMA_VERSION;
  readonly intendedUse: "RESEARCH_EVIDENCE_CLASSIFICATION_ONLY";
  readonly entries: readonly RegisteredResearchEvidence[];
  readonly supportedStatuses: readonly CurrentM13ResearchEvidenceStatus[];
  readonly unavailableStatuses: readonly ("APPROVED_FOR_PAPER" | "REJECTED")[];
  readonly semanticIdentity: string;
  readonly predictiveValidityEstablished: false;
  readonly approvedForPaperAction: false;
  readonly grantsExecutionAuthority: false;
  readonly priceAuthority: "NONE";
}

export class ResearchEvidenceRegistryValidationError extends Error {
  constructor(message: string) {
    super(`[ResearchEvidenceRegistry] ${message}`);
    this.name = "ResearchEvidenceRegistryValidationError";
  }
}

function fail(message: string): never {
  throw new ResearchEvidenceRegistryValidationError(message);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) result[key] = canonicalize(child);
    }
    return result;
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalClone<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    if (!Object.isFrozen(value)) Object.freeze(value);
  }
  return value;
}

function requireText(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) fail(`${field} must be a non-empty string.`);
  return value.trim();
}

function sameInterval(left: ResearchInterval, right: ResearchInterval): boolean {
  return left.startTime === right.startTime && left.endTime === right.endTime;
}

function exactHypothesis(
  registry: HypothesisRegistrySnapshot,
  hypothesisId: string,
  hypothesisVersion: string
): RegisteredResearchHypothesis {
  serializeHypothesisRegistry(registry);
  const matches = registry.hypotheses.filter((hypothesis) =>
    hypothesis.hypothesisId === hypothesisId && hypothesis.version === hypothesisVersion
  );
  if (matches.length !== 1) fail(`registry must contain exactly one ${hypothesisId}@${hypothesisVersion}.`);
  return matches[0];
}

function validateHeldOutBinding(
  hypothesis: RegisteredResearchHypothesis,
  heldOut: HeldOutOosEvidenceSummary
): void {
  const binding = heldOut.binding;
  if (binding.hypothesisId !== hypothesis.hypothesisId
    || binding.hypothesisVersion !== hypothesis.version
    || binding.hypothesisSemanticIdentity !== hypothesis.semanticIdentity
    || binding.ruleId !== hypothesis.rule.ruleId
    || binding.ruleVersion !== hypothesis.rule.version
    || binding.ruleSemanticIdentity !== hypothesis.rule.semanticIdentity
    || binding.statefulOosBoundaryPolicy !== hypothesis.statefulOosBoundaryPolicy
    || !hypothesis.assetScope.includes(binding.assetId)
    || !sameInterval(binding.oosInterval, hypothesis.trainOosPolicy.oos)) {
    fail("D-A evidence contradicts the exact hypothesis, rule, asset, OOS, or state-policy binding.");
  }
}

function validateRobustnessBinding(
  registry: HypothesisRegistrySnapshot,
  hypothesis: RegisteredResearchHypothesis,
  heldOut: HeldOutOosEvidenceSummary,
  robustness: RobustnessEvidenceInput
): { binding: RegisteredRobustnessEvidenceBinding; member: RobustnessFamilyMemberEvaluation } {
  const family = validateRobustnessFamilyPreregistration(registry, robustness.family);
  const evaluation = validateRobustnessFamilyEvaluation(registry, family, robustness.evaluation);
  const declaredMembers = family.members.filter((member) => member.memberId === robustness.memberId);
  const evaluatedMembers = evaluation.members.filter((member) => member.memberId === robustness.memberId);
  if (declaredMembers.length !== 1 || evaluatedMembers.length !== 1) {
    fail("D-B memberId must resolve exactly once in the family and evaluation.");
  }
  const declared = declaredMembers[0];
  const member = evaluatedMembers[0];
  if (declared.hypothesisId !== hypothesis.hypothesisId
    || declared.hypothesisVersion !== hypothesis.version
    || declared.hypothesisSemanticIdentity !== hypothesis.semanticIdentity
    || member.hypothesisId !== hypothesis.hypothesisId
    || member.hypothesisVersion !== hypothesis.version
    || member.hypothesisSemanticIdentity !== hypothesis.semanticIdentity
    || member.trialIdentity !== declared.trialIdentity
    || member.heldOutSummarySemanticIdentity !== heldOut.semanticIdentity
    || family.commonAsset !== heldOut.binding.assetId
    || !sameInterval(family.commonTrainingInterval, hypothesis.trainOosPolicy.training)
    || !sameInterval(family.commonOosInterval, hypothesis.trainOosPolicy.oos)
    || family.commonStatefulOosBoundaryPolicy !== hypothesis.statefulOosBoundaryPolicy
    || evaluation.independentConfirmation !== false
    || evaluation.selectionPolicy !== "NO_POST_OOS_VARIANT_SELECTION"
    || evaluation.interpretation !== "DESCRIPTIVE_ONLY_NO_ROBUSTNESS_THRESHOLD") {
    fail("D-B evidence contradicts the exact hypothesis, trial, D-A, asset, interval, or state-policy binding.");
  }
  return {
    member,
    binding: deepFreeze({
      familyId: family.familyId,
      familyVersion: family.version,
      familySemanticIdentity: family.semanticIdentity,
      evaluationSemanticIdentity: evaluation.semanticIdentity,
      memberId: member.memberId,
      memberTrialIdentity: member.trialIdentity,
      familyCompleteness: evaluation.familyCompleteness,
      memberCompleteness: member.completeness,
      independentConfirmation: false as const,
      selectionPolicy: "NO_POST_OOS_VARIANT_SELECTION" as const,
      interpretation: "DESCRIPTIVE_ONLY_NO_ROBUSTNESS_THRESHOLD" as const,
    }),
  };
}

function classify(
  hypothesis: RegisteredResearchHypothesis,
  heldOut: HeldOutOosEvidenceSummary,
  robustness: { binding: RegisteredRobustnessEvidenceBinding; member: RobustnessFamilyMemberEvaluation } | null
): { status: CurrentM13ResearchEvidenceStatus; reasons: readonly string[] } {
  const reasons: string[] = [];
  if (!["PREREGISTERED", "EVALUATION_PENDING"].includes(hypothesis.lifecycle)) {
    reasons.push("HYPOTHESIS_LIFECYCLE_NOT_CURRENTLY_EVALUABLE");
  }
  if (heldOut.counts.evaluable === 0) reasons.push("NO_EVALUABLE_HELD_OUT_OBSERVATIONS");
  if (heldOut.counts.insufficientEvidence > 0) reasons.push("HELD_OUT_EVIDENCE_CONTAINS_INSUFFICIENT_OBSERVATIONS");
  if (robustness) {
    if (robustness.binding.familyCompleteness !== "COMPLETE"
      || robustness.binding.memberCompleteness !== "COMPLETE") {
      reasons.push("SHARED_OOS_SENSITIVITY_EVIDENCE_INCOMPLETE");
    }
    if (robustness.member.counts.insufficientEvidence > 0) {
      reasons.push("SHARED_OOS_MEMBER_CONTAINS_INSUFFICIENT_EVIDENCE");
    }
    if (robustness.member.counts.evaluable === 0) {
      reasons.push("NO_EVALUABLE_SHARED_OOS_MEMBER_OBSERVATIONS");
    }
  }
  if (reasons.length > 0) {
    return { status: "INSUFFICIENT_EVIDENCE", reasons: Object.freeze(reasons) };
  }
  return {
    status: "CANDIDATE",
    reasons: Object.freeze([
      "VALID_COMPLETE_CURRENT_M13_EVIDENCE",
      "PROMOTION_AND_REJECTION_METHODOLOGY_UNAVAILABLE",
    ]),
  };
}

function entryFromInput(
  registry: HypothesisRegistrySnapshot,
  input: ResearchEvidenceInput
): RegisteredResearchEvidence {
  const hypothesisId = requireText(input.hypothesisId, "hypothesisId");
  const hypothesisVersion = requireText(input.hypothesisVersion, "hypothesisVersion");
  const hypothesis = exactHypothesis(registry, hypothesisId, hypothesisVersion);
  const heldOut = validateHeldOutOosEvidenceSummary(registry, input.heldOutEvidence);
  validateHeldOutBinding(hypothesis, heldOut);
  const robustness = input.robustnessEvidence
    ? validateRobustnessBinding(registry, hypothesis, heldOut, input.robustnessEvidence)
    : null;
  const classification = classify(hypothesis, heldOut, robustness);
  const provenance: ResearchEvidenceProvenance[] = [{
    kind: "HELD_OUT_OOS",
    schemaVersion: heldOut.schemaVersion,
    semanticIdentity: heldOut.semanticIdentity,
  }];
  if (robustness) {
    provenance.push({
      kind: "SHARED_OOS_SENSITIVITY",
      schemaVersion: input.robustnessEvidence!.evaluation.schemaVersion,
      semanticIdentity: robustness.binding.evaluationSemanticIdentity,
    });
  }
  const material = {
    kind: "REGISTERED_RESEARCH_EVIDENCE" as const,
    hypothesisId: hypothesis.hypothesisId,
    hypothesisVersion: hypothesis.version,
    hypothesisSemanticIdentity: hypothesis.semanticIdentity,
    hypothesisLifecycle: hypothesis.lifecycle,
    ruleId: hypothesis.rule.ruleId,
    ruleVersion: hypothesis.rule.version,
    ruleSemanticIdentity: hypothesis.rule.semanticIdentity,
    parameterConfigurationIdentity: heldOut.binding.parameterConfigurationIdentity,
    trialAccountingIdentity: heldOut.binding.trialAccountingIdentity,
    assetId: heldOut.binding.assetId,
    trainingInterval: { ...hypothesis.trainOosPolicy.training },
    oosInterval: { ...hypothesis.trainOosPolicy.oos },
    statefulOosBoundaryPolicy: hypothesis.statefulOosBoundaryPolicy,
    heldOutEvidenceSemanticIdentity: heldOut.semanticIdentity,
    robustnessEvidence: robustness?.binding ?? null,
    provenance: Object.freeze(provenance.map((item) => Object.freeze({ ...item }))),
    status: classification.status,
    classificationReasons: classification.reasons,
    promotionDisposition: "UNAVAILABLE_NO_PREREGISTERED_PROMOTION_CONTRACT" as const,
    rejectionDisposition: "UNAVAILABLE_NO_MACHINE_EXECUTABLE_FALSIFICATION_CONTRACT" as const,
    predictiveValidityEstablished: false as const,
    approvedForPaperAction: false as const,
    grantsExecutionAuthority: false as const,
    priceAuthority: "NONE" as const,
  };
  return deepFreeze({ ...material, semanticIdentity: canonicalJson(material) });
}

function validateEntry(entry: RegisteredResearchEvidence): void {
  if (entry.kind !== "REGISTERED_RESEARCH_EVIDENCE"
    || !["CANDIDATE", "INSUFFICIENT_EVIDENCE"].includes(entry.status)
    || entry.promotionDisposition !== "UNAVAILABLE_NO_PREREGISTERED_PROMOTION_CONTRACT"
    || entry.rejectionDisposition !== "UNAVAILABLE_NO_MACHINE_EXECUTABLE_FALSIFICATION_CONTRACT"
    || entry.predictiveValidityEstablished !== false
    || entry.approvedForPaperAction !== false
    || entry.grantsExecutionAuthority !== false
    || entry.priceAuthority !== "NONE") {
    fail("entry has incompatible classification or authority semantics.");
  }
  const { semanticIdentity, ...material } = entry;
  if (semanticIdentity !== canonicalJson(material)) fail("entry semantic identity is forged or stale.");
}

function snapshotFor(entries: readonly RegisteredResearchEvidence[]): ResearchEvidenceRegistrySnapshot {
  const ownedEntries = entries.map((entry) => canonicalClone(entry));
  ownedEntries.forEach(validateEntry);
  const sorted = Object.freeze(ownedEntries.sort((left, right) =>
    left.hypothesisId.localeCompare(right.hypothesisId)
      || left.hypothesisVersion.localeCompare(right.hypothesisVersion)
      || left.assetId.localeCompare(right.assetId)
      || left.parameterConfigurationIdentity.localeCompare(right.parameterConfigurationIdentity)
      || left.semanticIdentity.localeCompare(right.semanticIdentity)
  ));
  const keys = sorted.map((entry) => canonicalJson({
    hypothesisSemanticIdentity: entry.hypothesisSemanticIdentity,
    parameterConfigurationIdentity: entry.parameterConfigurationIdentity,
    trialAccountingIdentity: entry.trialAccountingIdentity,
    assetId: entry.assetId,
  }));
  if (new Set(keys).size !== keys.length) fail("duplicate evidence entry for the same exact trial and asset.");
  const material = {
    schemaVersion: RESEARCH_EVIDENCE_REGISTRY_SCHEMA_VERSION as typeof RESEARCH_EVIDENCE_REGISTRY_SCHEMA_VERSION,
    intendedUse: "RESEARCH_EVIDENCE_CLASSIFICATION_ONLY" as const,
    entries: sorted,
    supportedStatuses: Object.freeze(["CANDIDATE", "INSUFFICIENT_EVIDENCE"] as const),
    unavailableStatuses: Object.freeze(["APPROVED_FOR_PAPER", "REJECTED"] as const),
    predictiveValidityEstablished: false as const,
    approvedForPaperAction: false as const,
    grantsExecutionAuthority: false as const,
    priceAuthority: "NONE" as const,
  };
  return deepFreeze({ ...material, semanticIdentity: canonicalJson(material) });
}

export function createResearchEvidenceRegistry(
  hypothesisRegistry: HypothesisRegistrySnapshot,
  evidence: readonly ResearchEvidenceInput[]
): ResearchEvidenceRegistrySnapshot {
  serializeHypothesisRegistry(hypothesisRegistry);
  if (!Array.isArray(evidence)) fail("evidence must be an explicit array.");
  return snapshotFor(evidence.map((input) => entryFromInput(hypothesisRegistry, input)));
}

export function validateResearchEvidenceRegistry(
  registry: ResearchEvidenceRegistrySnapshot
): ResearchEvidenceRegistrySnapshot {
  if (registry.schemaVersion !== RESEARCH_EVIDENCE_REGISTRY_SCHEMA_VERSION
    || registry.intendedUse !== "RESEARCH_EVIDENCE_CLASSIFICATION_ONLY"
    || canonicalJson(registry.supportedStatuses) !== canonicalJson(["CANDIDATE", "INSUFFICIENT_EVIDENCE"])
    || canonicalJson(registry.unavailableStatuses) !== canonicalJson(["APPROVED_FOR_PAPER", "REJECTED"])
    || registry.predictiveValidityEstablished !== false
    || registry.approvedForPaperAction !== false
    || registry.grantsExecutionAuthority !== false
    || registry.priceAuthority !== "NONE") {
    fail("registry has incompatible schema, status, intended-use, or authority semantics.");
  }
  const rebuilt = snapshotFor(registry.entries);
  if (rebuilt.semanticIdentity !== registry.semanticIdentity
    || canonicalJson(rebuilt) !== canonicalJson(registry)) {
    fail("registry semantic identity or entry content is forged or stale.");
  }
  return registry;
}

export function serializeResearchEvidenceRegistry(
  registry: ResearchEvidenceRegistrySnapshot
): string {
  return canonicalJson(validateResearchEvidenceRegistry(registry));
}
