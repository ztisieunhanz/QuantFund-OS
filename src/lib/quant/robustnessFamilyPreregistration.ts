// ============================================================================
// FILE: src/lib/quant/robustnessFamilyPreregistration.ts
// MODULE: ROBUSTNESS FAMILY PREREGISTRATION (M13D / D-B-R1)
//
// Declares a finite relationship among existing exact fixed C-D trials before
// shared-OOS sensitivity inspection. It performs no robustness evaluation,
// ranking, selection, promotion, or trading action.
// ============================================================================

import {
  serializeHypothesisRegistry,
  type HypothesisRegistrySnapshot,
  type RegisteredResearchHypothesis,
  type ResearchInterval,
  type StatefulOosBoundaryPolicy,
} from "./hypothesisRegistry";
import type { AssetId } from "./types";

export const ROBUSTNESS_FAMILY_PREREGISTRATION_SCHEMA_VERSION = "M13D-D-B-R1-1";

export type RobustnessPerturbationKind =
  | "BASELINE"
  | "RULE_PARAMETER"
  | "RULE_INTERNAL_TIMING_WINDOW"
  | "FEATURE_TRANSFORMATION"
  | "FEATURE_LOOKBACK";

export interface RobustnessPerturbationDefinition {
  readonly kind: RobustnessPerturbationKind;
  readonly axisId: string;
  readonly description: string;
}

export interface RobustnessFamilyMemberDefinition {
  readonly memberId: string;
  readonly hypothesisId: string;
  readonly hypothesisVersion: string;
  readonly hypothesisSemanticIdentity: string;
  readonly perturbation: RobustnessPerturbationDefinition;
}

export interface RobustnessObservationCompletenessPolicy {
  readonly memberRequirement: "EVERY_DECLARED_MEMBER";
  readonly observationGridRequirement: "EXACT_EXPECTED_DECISION_TIMES";
  readonly expectedDecisionTimes: readonly number[];
  readonly missingObservationOutcome: "INSUFFICIENT_EVIDENCE";
  readonly insufficientEvidenceTreatment: "RETAIN_AND_REPORT";
  readonly interpretation: "DESCRIPTIVE_ONLY_NO_ROBUSTNESS_THRESHOLD";
}

export interface RobustnessFamilyPreRegistration {
  readonly declaredBy: string;
  readonly sourceReference: string;
  readonly declarationOrdinal: number;
}

export interface RobustnessFamilyPreregistrationDefinition {
  readonly schemaVersion: typeof ROBUSTNESS_FAMILY_PREREGISTRATION_SCHEMA_VERSION;
  readonly familyId: string;
  readonly version: string;
  readonly title: string;
  readonly description: string;
  readonly scientificRationale: string;
  readonly baselineMemberId: string;
  readonly members: readonly RobustnessFamilyMemberDefinition[];
  readonly expectedMemberCount: number;
  readonly commonAsset: AssetId;
  readonly commonTrainingInterval: ResearchInterval;
  readonly commonOosInterval: ResearchInterval;
  readonly commonStatefulOosBoundaryPolicy: StatefulOosBoundaryPolicy;
  readonly observationCompletenessPolicy: RobustnessObservationCompletenessPolicy;
  readonly preRegistration: RobustnessFamilyPreRegistration;
  readonly oosReusePolicy: "PREREGISTERED_SHARED_OOS_SENSITIVITY";
  readonly selectionPolicy: "NO_POST_OOS_VARIANT_SELECTION";
  readonly independentConfirmation: false;
  readonly intendedUse: "RESEARCH_ROBUSTNESS_PREREGISTRATION_ONLY";
  readonly predictiveValidityEstablished: false;
  readonly approvedForPaperAction: false;
  readonly grantsExecutionAuthority: false;
  readonly priceAuthority: "NONE";
}

export interface RegisteredRobustnessFamilyMember extends RobustnessFamilyMemberDefinition {
  readonly trialIdentity: string;
}

export interface RobustnessFamilyPreregistration
  extends Omit<RobustnessFamilyPreregistrationDefinition, "members"> {
  readonly members: readonly RegisteredRobustnessFamilyMember[];
  readonly baselineMemberIdentity: string;
  readonly semanticIdentity: string;
}

export class RobustnessFamilyPreregistrationValidationError extends Error {
  constructor(message: string) {
    super(`[RobustnessFamilyPreregistration] ${message}`);
    this.name = "RobustnessFamilyPreregistrationValidationError";
  }
}

const FORBIDDEN_RESULT_FIELDS = new Set([
  "performance",
  "return",
  "returns",
  "sharpe",
  "winrate",
  "ranking",
  "rank",
  "score",
  "best",
  "winner",
  "selectedconfiguration",
  "selectedparameter",
  "selectedparameters",
  "promotion",
  "pnl",
]);

function fail(message: string): never {
  throw new RobustnessFamilyPreregistrationValidationError(message);
}

function requireText(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

function normalizedFieldName(value: string): string {
  return value.replace(/[_\-\s]/g, "").toLowerCase();
}

function rejectForbiddenFields(value: unknown, path = "definition", seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) fail(`${path} must not contain cycles.`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectForbiddenFields(item, `${path}[${index}]`, seen));
  } else {
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_RESULT_FIELDS.has(normalizedFieldName(key))) {
        fail(`${path}.${key} is a performance, selection, ranking, or promotion field and is prohibited.`);
      }
      rejectForbiddenFields(child, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function requireOnlyKeys(value: unknown, allowed: readonly string[], path: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${path} must be a plain object.`);
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) fail(`${path}.${key} is not part of the preregistration contract.`);
  }
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

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function normalizeInterval(interval: ResearchInterval, field: string): ResearchInterval {
  requireOnlyKeys(interval, ["startTime", "endTime"], field);
  if (!interval
    || !Number.isSafeInteger(interval.startTime) || interval.startTime < 0
    || !Number.isSafeInteger(interval.endTime) || interval.endTime < 0
    || interval.startTime >= interval.endTime) {
    fail(`${field} must be a valid half-open epoch-millisecond interval.`);
  }
  return Object.freeze({ startTime: interval.startTime, endTime: interval.endTime });
}

function sameInterval(left: ResearchInterval, right: ResearchInterval): boolean {
  return left.startTime === right.startTime && left.endTime === right.endTime;
}

function normalizeCompletenessPolicy(
  policy: RobustnessObservationCompletenessPolicy,
  oosInterval: ResearchInterval
): RobustnessObservationCompletenessPolicy {
  requireOnlyKeys(policy, [
    "memberRequirement",
    "observationGridRequirement",
    "expectedDecisionTimes",
    "missingObservationOutcome",
    "insufficientEvidenceTreatment",
    "interpretation",
  ], "observationCompletenessPolicy");
  if (!policy
    || policy.memberRequirement !== "EVERY_DECLARED_MEMBER"
    || policy.observationGridRequirement !== "EXACT_EXPECTED_DECISION_TIMES"
    || policy.missingObservationOutcome !== "INSUFFICIENT_EVIDENCE"
    || policy.insufficientEvidenceTreatment !== "RETAIN_AND_REPORT"
    || policy.interpretation !== "DESCRIPTIVE_ONLY_NO_ROBUSTNESS_THRESHOLD") {
    fail("observationCompletenessPolicy must preserve exact-grid, fail-closed, descriptive-only semantics.");
  }
  if (!Array.isArray(policy.expectedDecisionTimes) || policy.expectedDecisionTimes.length === 0) {
    fail("observationCompletenessPolicy.expectedDecisionTimes must be a finite non-empty grid.");
  }
  const expectedDecisionTimes = policy.expectedDecisionTimes.map((time, index) => {
    if (!Number.isSafeInteger(time) || time < oosInterval.startTime || time >= oosInterval.endTime) {
      fail(`expectedDecisionTimes[${index}] must fall inside the common half-open OOS interval.`);
    }
    if (index > 0 && time <= policy.expectedDecisionTimes[index - 1]) {
      fail("expectedDecisionTimes must be strictly increasing and duplicate-free.");
    }
    return time;
  });
  return deepFreeze({
    memberRequirement: "EVERY_DECLARED_MEMBER" as const,
    observationGridRequirement: "EXACT_EXPECTED_DECISION_TIMES" as const,
    expectedDecisionTimes,
    missingObservationOutcome: "INSUFFICIENT_EVIDENCE" as const,
    insufficientEvidenceTreatment: "RETAIN_AND_REPORT" as const,
    interpretation: "DESCRIPTIVE_ONLY_NO_ROBUSTNESS_THRESHOLD" as const,
  });
}

function exactHypothesis(
  registry: HypothesisRegistrySnapshot,
  member: RobustnessFamilyMemberDefinition
): RegisteredResearchHypothesis {
  const matches = registry.hypotheses.filter((hypothesis) =>
    hypothesis.hypothesisId === member.hypothesisId
      && hypothesis.version === member.hypothesisVersion
      && hypothesis.semanticIdentity === member.hypothesisSemanticIdentity
  );
  if (matches.length !== 1) {
    fail(`${member.memberId} must resolve to exactly one registered hypothesis semantic identity.`);
  }
  return matches[0];
}

function fixedParameterConfiguration(hypothesis: RegisteredResearchHypothesis): Readonly<Record<string, unknown>> {
  if (hypothesis.parameterSpace.some((specification) => specification.kind !== "FIXED")
    || hypothesis.trialAccounting.declaredTrialCount !== 1) {
    fail(`${hypothesis.hypothesisId}@${hypothesis.version} is not an exact fixed one-trial hypothesis.`);
  }
  const configuration: Record<string, unknown> = {};
  for (const specification of hypothesis.parameterSpace) {
    if (specification.kind !== "FIXED") fail("fixed-trial parameter normalization failed closed.");
    configuration[specification.name] = specification.value;
  }
  return deepFreeze(configuration);
}

function normalizePerturbation(
  perturbation: RobustnessPerturbationDefinition,
  isBaseline: boolean,
  field: string
): RobustnessPerturbationDefinition {
  requireOnlyKeys(perturbation, ["kind", "axisId", "description"], field);
  const allowed: readonly RobustnessPerturbationKind[] = [
    "BASELINE",
    "RULE_PARAMETER",
    "RULE_INTERNAL_TIMING_WINDOW",
    "FEATURE_TRANSFORMATION",
    "FEATURE_LOOKBACK",
  ];
  if (!perturbation || !allowed.includes(perturbation.kind)) {
    fail(`${field}.kind is unsupported.`);
  }
  if (isBaseline !== (perturbation.kind === "BASELINE")) {
    fail("exactly the declared baseline member must use perturbation kind BASELINE.");
  }
  return Object.freeze({
    kind: perturbation.kind,
    axisId: requireText(perturbation.axisId, `${field}.axisId`),
    description: requireText(perturbation.description, `${field}.description`),
  });
}

function validateFixedFamilyContract(definition: RobustnessFamilyPreregistrationDefinition): void {
  if (definition.schemaVersion !== ROBUSTNESS_FAMILY_PREREGISTRATION_SCHEMA_VERSION
    || definition.oosReusePolicy !== "PREREGISTERED_SHARED_OOS_SENSITIVITY"
    || definition.selectionPolicy !== "NO_POST_OOS_VARIANT_SELECTION"
    || definition.independentConfirmation !== false
    || definition.intendedUse !== "RESEARCH_ROBUSTNESS_PREREGISTRATION_ONLY"
    || definition.predictiveValidityEstablished !== false
    || definition.approvedForPaperAction !== false
    || definition.grantsExecutionAuthority !== false
    || definition.priceAuthority !== "NONE") {
    fail("family has incompatible methodology, confirmation, intended-use, or authority semantics.");
  }
}

function definitionFromRegistered(
  family: RobustnessFamilyPreregistration
): RobustnessFamilyPreregistrationDefinition {
  return {
    schemaVersion: family.schemaVersion,
    familyId: family.familyId,
    version: family.version,
    title: family.title,
    description: family.description,
    scientificRationale: family.scientificRationale,
    baselineMemberId: family.baselineMemberId,
    members: family.members.map((member) => ({
      memberId: member.memberId,
      hypothesisId: member.hypothesisId,
      hypothesisVersion: member.hypothesisVersion,
      hypothesisSemanticIdentity: member.hypothesisSemanticIdentity,
      perturbation: member.perturbation,
    })),
    expectedMemberCount: family.expectedMemberCount,
    commonAsset: family.commonAsset,
    commonTrainingInterval: family.commonTrainingInterval,
    commonOosInterval: family.commonOosInterval,
    commonStatefulOosBoundaryPolicy: family.commonStatefulOosBoundaryPolicy,
    observationCompletenessPolicy: family.observationCompletenessPolicy,
    preRegistration: family.preRegistration,
    oosReusePolicy: family.oosReusePolicy,
    selectionPolicy: family.selectionPolicy,
    independentConfirmation: family.independentConfirmation,
    intendedUse: family.intendedUse,
    predictiveValidityEstablished: family.predictiveValidityEstablished,
    approvedForPaperAction: family.approvedForPaperAction,
    grantsExecutionAuthority: family.grantsExecutionAuthority,
    priceAuthority: family.priceAuthority,
  };
}

export function defineRobustnessFamilyPreregistration(
  registry: HypothesisRegistrySnapshot,
  definition: RobustnessFamilyPreregistrationDefinition
): RobustnessFamilyPreregistration {
  serializeHypothesisRegistry(registry);
  rejectForbiddenFields(definition);
  requireOnlyKeys(definition, [
    "schemaVersion",
    "familyId",
    "version",
    "title",
    "description",
    "scientificRationale",
    "baselineMemberId",
    "members",
    "expectedMemberCount",
    "commonAsset",
    "commonTrainingInterval",
    "commonOosInterval",
    "commonStatefulOosBoundaryPolicy",
    "observationCompletenessPolicy",
    "preRegistration",
    "oosReusePolicy",
    "selectionPolicy",
    "independentConfirmation",
    "intendedUse",
    "predictiveValidityEstablished",
    "approvedForPaperAction",
    "grantsExecutionAuthority",
    "priceAuthority",
  ], "definition");
  validateFixedFamilyContract(definition);

  const familyId = requireText(definition.familyId, "familyId");
  const version = requireText(definition.version, "version");
  const title = requireText(definition.title, "title");
  const description = requireText(definition.description, "description");
  const scientificRationale = requireText(definition.scientificRationale, "scientificRationale");
  const baselineMemberId = requireText(definition.baselineMemberId, "baselineMemberId");
  const commonAsset = requireText(definition.commonAsset, "commonAsset");
  const commonTrainingInterval = normalizeInterval(definition.commonTrainingInterval, "commonTrainingInterval");
  const commonOosInterval = normalizeInterval(definition.commonOosInterval, "commonOosInterval");
  if (commonTrainingInterval.endTime > commonOosInterval.startTime) {
    fail("common TRAIN interval must end at or before the common OOS interval starts.");
  }
  if (!(["NOT_APPLICABLE", "RESET_AT_OOS_START", "CARRY_PIT_STATE_FROM_PRE_OOS"] as const)
    .includes(definition.commonStatefulOosBoundaryPolicy)) {
    fail("commonStatefulOosBoundaryPolicy is unsupported.");
  }
  if (!Array.isArray(definition.members) || definition.members.length === 0) {
    fail("members must be a finite non-empty set.");
  }
  if (!Number.isSafeInteger(definition.expectedMemberCount)
    || definition.expectedMemberCount !== definition.members.length) {
    fail("expectedMemberCount must exactly equal the declared finite member count.");
  }

  const memberIds = new Set<string>();
  const hypothesisIdentities = new Set<string>();
  const members = definition.members.map((member, index): RegisteredRobustnessFamilyMember => {
    requireOnlyKeys(member, [
      "memberId",
      "hypothesisId",
      "hypothesisVersion",
      "hypothesisSemanticIdentity",
      "perturbation",
    ], `members[${index}]`);
    const memberId = requireText(member.memberId, `members[${index}].memberId`);
    if (memberIds.has(memberId)) fail(`duplicate family memberId ${memberId}.`);
    memberIds.add(memberId);
    const hypothesis = exactHypothesis(registry, member);
    if (hypothesisIdentities.has(hypothesis.semanticIdentity)) {
      fail(`duplicate family hypothesis/trial ${hypothesis.hypothesisId}@${hypothesis.version}.`);
    }
    hypothesisIdentities.add(hypothesis.semanticIdentity);
    const configuration = fixedParameterConfiguration(hypothesis);
    if (hypothesis.assetScope.length !== 1 || hypothesis.assetScope[0] !== commonAsset) {
      fail(`${memberId} must be an exact single-asset trial for commonAsset ${commonAsset}.`);
    }
    if (!sameInterval(hypothesis.trainOosPolicy.training, commonTrainingInterval)
      || !sameInterval(hypothesis.trainOosPolicy.oos, commonOosInterval)) {
      fail(`${memberId} does not share the common TRAIN/OOS intervals.`);
    }
    if (hypothesis.statefulOosBoundaryPolicy !== definition.commonStatefulOosBoundaryPolicy) {
      fail(`${memberId} does not share the common stateful OOS boundary policy.`);
    }
    const perturbation = normalizePerturbation(
      member.perturbation,
      memberId === baselineMemberId,
      `members[${index}].perturbation`
    );
    const trialIdentity = canonicalJson({
      hypothesisId: hypothesis.hypothesisId,
      hypothesisVersion: hypothesis.version,
      hypothesisSemanticIdentity: hypothesis.semanticIdentity,
      rule: hypothesis.rule,
      parameterConfiguration: configuration,
      trialAccounting: hypothesis.trialAccounting,
      assetId: commonAsset,
      statefulOosBoundaryPolicy: hypothesis.statefulOosBoundaryPolicy,
    });
    return deepFreeze({
      memberId,
      hypothesisId: hypothesis.hypothesisId,
      hypothesisVersion: hypothesis.version,
      hypothesisSemanticIdentity: hypothesis.semanticIdentity,
      perturbation,
      trialIdentity,
    });
  });
  if (!memberIds.has(baselineMemberId)) fail("baselineMemberId must identify exactly one declared family member.");
  const sortedMembers = Object.freeze([...members].sort((left, right) =>
    left.memberId.localeCompare(right.memberId)
      || left.hypothesisSemanticIdentity.localeCompare(right.hypothesisSemanticIdentity)
  ));
  const baseline = sortedMembers.find((member) => member.memberId === baselineMemberId);
  if (!baseline) fail("baseline member resolution failed closed.");
  const observationCompletenessPolicy = normalizeCompletenessPolicy(
    definition.observationCompletenessPolicy,
    commonOosInterval
  );
  requireOnlyKeys(definition.preRegistration, [
    "declaredBy",
    "sourceReference",
    "declarationOrdinal",
  ], "preRegistration");
  const preRegistration = Object.freeze({
    declaredBy: requireText(definition.preRegistration.declaredBy, "preRegistration.declaredBy"),
    sourceReference: requireText(
      definition.preRegistration.sourceReference,
      "preRegistration.sourceReference"
    ),
    declarationOrdinal: definition.preRegistration.declarationOrdinal,
  });
  if (!Number.isSafeInteger(preRegistration.declarationOrdinal)
    || preRegistration.declarationOrdinal <= 0) {
    fail("preRegistration.declarationOrdinal must be a positive safe integer.");
  }

  const identityMaterial = {
    schemaVersion: ROBUSTNESS_FAMILY_PREREGISTRATION_SCHEMA_VERSION,
    familyId,
    version,
    title,
    description,
    scientificRationale,
    baselineMemberId,
    baselineMemberIdentity: baseline.trialIdentity,
    members: sortedMembers,
    expectedMemberCount: definition.expectedMemberCount,
    commonAsset,
    commonTrainingInterval,
    commonOosInterval,
    commonStatefulOosBoundaryPolicy: definition.commonStatefulOosBoundaryPolicy,
    observationCompletenessPolicy,
    preRegistration,
    oosReusePolicy: "PREREGISTERED_SHARED_OOS_SENSITIVITY" as const,
    selectionPolicy: "NO_POST_OOS_VARIANT_SELECTION" as const,
    independentConfirmation: false as const,
    intendedUse: "RESEARCH_ROBUSTNESS_PREREGISTRATION_ONLY" as const,
    predictiveValidityEstablished: false as const,
    approvedForPaperAction: false as const,
    grantsExecutionAuthority: false as const,
    priceAuthority: "NONE" as const,
  } as const;
  return deepFreeze({
    ...identityMaterial,
    semanticIdentity: canonicalJson(identityMaterial),
  });
}

export function validateRobustnessFamilyPreregistration(
  registry: HypothesisRegistrySnapshot,
  family: RobustnessFamilyPreregistration
): RobustnessFamilyPreregistration {
  rejectForbiddenFields(family, "family");
  const rebuilt = defineRobustnessFamilyPreregistration(registry, definitionFromRegistered(family));
  if (rebuilt.semanticIdentity !== family.semanticIdentity || canonicalJson(rebuilt) !== canonicalJson(family)) {
    fail("family semantic identity or resolved trial evidence is forged or stale.");
  }
  return rebuilt;
}

export function serializeRobustnessFamilyPreregistration(
  registry: HypothesisRegistrySnapshot,
  family: RobustnessFamilyPreregistration
): string {
  return canonicalJson(validateRobustnessFamilyPreregistration(registry, family));
}
