// ============================================================================
// FILE: src/lib/quant/robustnessFamilyEvaluation.ts
// MODULE: PREREGISTERED SHARED-OOS SENSITIVITY EVALUATION (M13D / D-B)
//
// Revalidates existing C-F evidence through D-A and describes categorical
// evidence stability across one exact D-B-R1 family. It performs no ranking,
// selection, economic evaluation, promotion, or trading action.
// ============================================================================

import {
  evaluateHeldOutOosEvidence,
  type HeldOutOosEvidenceSummary,
} from "./heldOutOosEvaluation";
import type { HypothesisRegistrySnapshot } from "./hypothesisRegistry";
import {
  validateRobustnessFamilyPreregistration,
  type RobustnessFamilyPreregistration,
  type RegisteredRobustnessFamilyMember,
} from "./robustnessFamilyPreregistration";
import type {
  ShadowResearchObservation,
  StatefulShadowResearchObservation,
} from "./shadowResearchHarness";
import type { StatefulResearchState } from "./statefulResearchRules";
import type { AssetId } from "./types";

export const ROBUSTNESS_FAMILY_EVALUATION_SCHEMA_VERSION = "M13D-D-B-1";

export interface RobustnessFamilyMemberEvidenceInput {
  readonly memberId: string;
  readonly observations: readonly ShadowResearchObservation[];
  readonly preOosTransitionWitnesses?: readonly StatefulShadowResearchObservation<StatefulResearchState>[];
}

export interface RobustnessFamilyEvaluationInput {
  readonly registry: HypothesisRegistrySnapshot;
  readonly family: RobustnessFamilyPreregistration;
  readonly members: readonly RobustnessFamilyMemberEvidenceInput[];
}

export interface RobustnessMemberCategoricalCounts {
  readonly totalExpected: number;
  readonly observed: number;
  readonly match: number;
  readonly noMatch: number;
  readonly insufficientEvidenceObserved: number;
  readonly lineageUnprovenObserved: number;
  readonly missingExpected: number;
  readonly insufficientEvidence: number;
  readonly evaluable: number;
}

export interface RobustnessFamilyMemberEvaluation {
  readonly memberId: string;
  readonly hypothesisId: string;
  readonly hypothesisVersion: string;
  readonly hypothesisSemanticIdentity: string;
  readonly trialIdentity: string;
  readonly isBaseline: boolean;
  readonly observedDecisionTimes: readonly number[];
  readonly missingExpectedDecisionTimes: readonly number[];
  readonly lineageUnprovenDecisionTimes: readonly number[];
  readonly completeness: "COMPLETE" | "INCOMPLETE_MISSING_EXPECTED_EVIDENCE";
  readonly heldOutSummarySemanticIdentity: string | null;
  readonly counts: RobustnessMemberCategoricalCounts;
}

export interface RobustnessFamilyEvaluation {
  readonly kind: "ROBUSTNESS_FAMILY_DESCRIPTIVE_EVALUATION";
  readonly schemaVersion: typeof ROBUSTNESS_FAMILY_EVALUATION_SCHEMA_VERSION;
  readonly intendedUse: "PREREGISTERED_SHARED_OOS_DESCRIPTIVE_SENSITIVITY_ONLY";
  readonly familyId: string;
  readonly familyVersion: string;
  readonly familySemanticIdentity: string;
  readonly baselineMemberId: string;
  readonly baselineMemberIdentity: string;
  readonly commonAsset: AssetId;
  readonly commonTrainingInterval: Readonly<{ startTime: number; endTime: number }>;
  readonly commonOosInterval: Readonly<{ startTime: number; endTime: number }>;
  readonly commonStatefulOosBoundaryPolicy: RobustnessFamilyPreregistration["commonStatefulOosBoundaryPolicy"];
  readonly expectedDecisionTimes: readonly number[];
  readonly familyCompleteness: "COMPLETE" | "INCOMPLETE_MISSING_EXPECTED_EVIDENCE";
  readonly members: readonly RobustnessFamilyMemberEvaluation[];
  readonly oosReusePolicy: "PREREGISTERED_SHARED_OOS_SENSITIVITY";
  readonly selectionPolicy: "NO_POST_OOS_VARIANT_SELECTION";
  readonly independentConfirmation: false;
  readonly interpretation: "DESCRIPTIVE_ONLY_NO_ROBUSTNESS_THRESHOLD";
  readonly semanticIdentity: string;
  readonly predictiveValidityEstablished: false;
  readonly approvedForPaperAction: false;
  readonly grantsExecutionAuthority: false;
  readonly priceAuthority: "NONE";
}

export class RobustnessFamilyEvaluationValidationError extends Error {
  constructor(message: string) {
    super(`[RobustnessFamilyEvaluation] ${message}`);
    this.name = "RobustnessFamilyEvaluationValidationError";
  }
}

function fail(message: string): never {
  throw new RobustnessFamilyEvaluationValidationError(message);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) normalized[key] = canonicalize(child);
    }
    return normalized;
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function sameInterval(
  left: Readonly<{ startTime: number; endTime: number }>,
  right: Readonly<{ startTime: number; endTime: number }>
): boolean {
  return left.startTime === right.startTime && left.endTime === right.endTime;
}

function validateSummaryBinding(
  summary: HeldOutOosEvidenceSummary,
  family: RobustnessFamilyPreregistration,
  member: RegisteredRobustnessFamilyMember
): void {
  if (summary.binding.hypothesisId !== member.hypothesisId
    || summary.binding.hypothesisVersion !== member.hypothesisVersion
    || summary.binding.hypothesisSemanticIdentity !== member.hypothesisSemanticIdentity
    || summary.binding.assetId !== family.commonAsset
    || summary.binding.statefulOosBoundaryPolicy !== family.commonStatefulOosBoundaryPolicy
    || !sameInterval(summary.binding.oosInterval, family.commonOosInterval)
    || summary.predictiveValidityEstablished !== false
    || summary.approvedForPaperAction !== false
    || summary.grantsExecutionAuthority !== false
    || summary.priceAuthority !== "NONE") {
    fail(`${member.memberId} D-A summary does not match the exact family member contract.`);
  }
}

function evaluateMember(
  registry: HypothesisRegistrySnapshot,
  family: RobustnessFamilyPreregistration,
  member: RegisteredRobustnessFamilyMember,
  evidence: RobustnessFamilyMemberEvidenceInput
): RobustnessFamilyMemberEvaluation {
  if (!Array.isArray(evidence.observations)) fail(`${member.memberId} observations must be an array.`);
  const expected = family.observationCompletenessPolicy.expectedDecisionTimes;
  const expectedSet = new Set(expected);
  const seen = new Set<number>();
  for (const observation of evidence.observations) {
    if (!Number.isSafeInteger(observation.decisionTime)) fail(`${member.memberId} has malformed decisionTime.`);
    if (seen.has(observation.decisionTime)) fail(`${member.memberId} has duplicate decisionTime.`);
    if (!expectedSet.has(observation.decisionTime)) fail(`${member.memberId} has unexpected or outside-OOS decisionTime.`);
    seen.add(observation.decisionTime);
  }
  if ((evidence.preOosTransitionWitnesses?.length ?? 0) > 0 && evidence.observations.length === 0) {
    fail(`${member.memberId} cannot supply carry witnesses without OOS observations.`);
  }

  let summary: HeldOutOosEvidenceSummary | null = null;
  if (evidence.observations.length > 0) {
    summary = evaluateHeldOutOosEvidence({
      registry,
      hypothesisId: member.hypothesisId,
      hypothesisVersion: member.hypothesisVersion,
      observations: evidence.observations,
      preOosTransitionWitnesses: evidence.preOosTransitionWitnesses,
    });
    validateSummaryBinding(summary, family, member);
  }

  const observedDecisionTimes = Object.freeze(evidence.observations.map((item) => item.decisionTime));
  const missingExpectedDecisionTimes = Object.freeze(expected.filter((time) => !seen.has(time)));
  const firstMissingIndex = expected.findIndex((time) => !seen.has(time));
  const lineageUnprovenDecisionTimes = Object.freeze(
    family.commonStatefulOosBoundaryPolicy === "NOT_APPLICABLE" || firstMissingIndex < 0
      ? []
      : observedDecisionTimes.filter((time) => expected.indexOf(time) > firstMissingIndex)
  );
  const lineageUnproven = new Set(lineageUnprovenDecisionTimes);
  const lineageValidObservations = evidence.observations.filter(
    (observation) => !lineageUnproven.has(observation.decisionTime)
  );
  const match = lineageValidObservations.filter((item) => item.status === "MATCH").length;
  const noMatch = lineageValidObservations.filter((item) => item.status === "NO_MATCH").length;
  const insufficientEvidenceObserved = lineageValidObservations.filter(
    (item) => item.status === "INSUFFICIENT_EVIDENCE"
  ).length;
  const lineageUnprovenObserved = lineageUnprovenDecisionTimes.length;
  const missingExpected = missingExpectedDecisionTimes.length;
  const counts = deepFreeze({
    totalExpected: expected.length,
    observed: evidence.observations.length,
    match,
    noMatch,
    insufficientEvidenceObserved,
    lineageUnprovenObserved,
    missingExpected,
    insufficientEvidence: insufficientEvidenceObserved + lineageUnprovenObserved + missingExpected,
    evaluable: match + noMatch,
  });
  if (counts.totalExpected !== counts.evaluable + counts.insufficientEvidence) {
    fail(`${member.memberId} categorical counts do not reconcile to the preregistered grid.`);
  }
  return deepFreeze({
    memberId: member.memberId,
    hypothesisId: member.hypothesisId,
    hypothesisVersion: member.hypothesisVersion,
    hypothesisSemanticIdentity: member.hypothesisSemanticIdentity,
    trialIdentity: member.trialIdentity,
    isBaseline: member.memberId === family.baselineMemberId,
    observedDecisionTimes,
    missingExpectedDecisionTimes,
    lineageUnprovenDecisionTimes,
    completeness: missingExpected === 0 ? "COMPLETE" as const : "INCOMPLETE_MISSING_EXPECTED_EVIDENCE" as const,
    heldOutSummarySemanticIdentity: summary?.semanticIdentity ?? null,
    counts,
  });
}

function identityMaterial(evaluation: Omit<RobustnessFamilyEvaluation, "semanticIdentity">) {
  return evaluation;
}

export function evaluateRobustnessFamily(
  input: RobustnessFamilyEvaluationInput
): RobustnessFamilyEvaluation {
  const family = validateRobustnessFamilyPreregistration(input.registry, input.family);
  if (!Array.isArray(input.members)) fail("members must be an array.");
  const byId = new Map<string, RobustnessFamilyMemberEvidenceInput>();
  for (const evidence of input.members) {
    if (!evidence || typeof evidence.memberId !== "string" || evidence.memberId.length === 0) {
      fail("every evidence entry requires a memberId.");
    }
    if (byId.has(evidence.memberId)) fail(`duplicate evidence for member ${evidence.memberId}.`);
    if (!family.members.some((member) => member.memberId === evidence.memberId)) {
      fail(`undeclared family member ${evidence.memberId}.`);
    }
    byId.set(evidence.memberId, evidence);
  }
  if (byId.size !== family.members.length) fail("every declared family member must be supplied exactly once.");

  const members = Object.freeze(family.members.map((member) => {
    const evidence = byId.get(member.memberId);
    if (!evidence) fail(`missing declared family member ${member.memberId}.`);
    return evaluateMember(input.registry, family, member, evidence);
  }));
  const core = deepFreeze({
    kind: "ROBUSTNESS_FAMILY_DESCRIPTIVE_EVALUATION" as const,
    schemaVersion: ROBUSTNESS_FAMILY_EVALUATION_SCHEMA_VERSION as typeof ROBUSTNESS_FAMILY_EVALUATION_SCHEMA_VERSION,
    intendedUse: "PREREGISTERED_SHARED_OOS_DESCRIPTIVE_SENSITIVITY_ONLY" as const,
    familyId: family.familyId,
    familyVersion: family.version,
    familySemanticIdentity: family.semanticIdentity,
    baselineMemberId: family.baselineMemberId,
    baselineMemberIdentity: family.baselineMemberIdentity,
    commonAsset: family.commonAsset,
    commonTrainingInterval: family.commonTrainingInterval,
    commonOosInterval: family.commonOosInterval,
    commonStatefulOosBoundaryPolicy: family.commonStatefulOosBoundaryPolicy,
    expectedDecisionTimes: family.observationCompletenessPolicy.expectedDecisionTimes,
    familyCompleteness: members.every((member) => member.completeness === "COMPLETE")
      ? "COMPLETE" as const
      : "INCOMPLETE_MISSING_EXPECTED_EVIDENCE" as const,
    members,
    oosReusePolicy: "PREREGISTERED_SHARED_OOS_SENSITIVITY" as const,
    selectionPolicy: "NO_POST_OOS_VARIANT_SELECTION" as const,
    independentConfirmation: false as const,
    interpretation: "DESCRIPTIVE_ONLY_NO_ROBUSTNESS_THRESHOLD" as const,
    predictiveValidityEstablished: false as const,
    approvedForPaperAction: false as const,
    grantsExecutionAuthority: false as const,
    priceAuthority: "NONE" as const,
  });
  return deepFreeze({ ...core, semanticIdentity: canonicalJson(identityMaterial(core)) });
}

export function validateRobustnessFamilyEvaluation(
  registry: HypothesisRegistrySnapshot,
  familyInput: RobustnessFamilyPreregistration,
  evaluation: RobustnessFamilyEvaluation
): RobustnessFamilyEvaluation {
  const family = validateRobustnessFamilyPreregistration(registry, familyInput);
  if (evaluation.familySemanticIdentity !== family.semanticIdentity
    || evaluation.familyId !== family.familyId
    || evaluation.familyVersion !== family.version
    || evaluation.baselineMemberId !== family.baselineMemberId
    || evaluation.baselineMemberIdentity !== family.baselineMemberIdentity
    || evaluation.oosReusePolicy !== "PREREGISTERED_SHARED_OOS_SENSITIVITY"
    || evaluation.selectionPolicy !== "NO_POST_OOS_VARIANT_SELECTION"
    || evaluation.independentConfirmation !== false
    || evaluation.interpretation !== "DESCRIPTIVE_ONLY_NO_ROBUSTNESS_THRESHOLD"
    || evaluation.predictiveValidityEstablished !== false
    || evaluation.approvedForPaperAction !== false
    || evaluation.grantsExecutionAuthority !== false
    || evaluation.priceAuthority !== "NONE") {
    fail("evaluation has incompatible family, methodology, or authority semantics.");
  }
  const { semanticIdentity, ...material } = evaluation;
  if (semanticIdentity !== canonicalJson(identityMaterial(material))) {
    fail("evaluation semantic identity is forged or stale.");
  }
  return evaluation;
}

export function serializeRobustnessFamilyEvaluation(
  registry: HypothesisRegistrySnapshot,
  family: RobustnessFamilyPreregistration,
  evaluation: RobustnessFamilyEvaluation
): string {
  return canonicalJson(validateRobustnessFamilyEvaluation(registry, family, evaluation));
}
