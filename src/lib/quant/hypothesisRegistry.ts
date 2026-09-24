// ============================================================================
// FILE: src/lib/quant/hypothesisRegistry.ts
// MODULE: HYPOTHESIS REGISTRY + ANTI-DATA-MINING GOVERNANCE (M13C / C-D)
//
// Declarative research governance only. This module does not evaluate, rank,
// optimize, approve, allocate, execute, or account for any hypothesis.
// ============================================================================

import { RESEARCH_SERIES_SPECS } from "./researchDataProtocol";
import type { ResearchDependency, ResearchRule } from "./researchRules";
import type { StatefulResearchRule, StatefulResearchState } from "./statefulResearchRules";
import type { AssetId } from "./types";

export const HYPOTHESIS_REGISTRY_SCHEMA_VERSION = "M13C-C-D-1";

export type HypothesisLifecycle =
  | "PREREGISTERED"
  | "EVALUATION_PENDING"
  | "REJECTED"
  | "FAILED"
  | "INSUFFICIENT_EVIDENCE";

export type ParameterScalar = string | number | boolean | null;

export type ParameterSpecification =
  | Readonly<{ name: string; kind: "FIXED"; value: ParameterScalar }>
  | Readonly<{ name: string; kind: "CANDIDATES"; values: readonly ParameterScalar[] }>
  | Readonly<{ name: string; kind: "RANGE"; minimum: number; maximum: number; step: number }>;

export interface HypothesisRuleReference {
  readonly ruleId: string;
  readonly version: string;
  readonly semanticIdentity: string;
}

export interface ResearchInterval {
  readonly startTime: number;
  readonly endTime: number;
}

export interface TrainOosPolicy {
  readonly policyId: string;
  readonly training: ResearchInterval;
  readonly oos: ResearchInterval;
  readonly ordering: "TRAIN_BEFORE_OOS";
  readonly oosReuse: "NEVER_TUNE_ON_OOS";
}

export type StatefulOosBoundaryPolicy =
  | "NOT_APPLICABLE"
  | "RESET_AT_OOS_START"
  | "CARRY_PIT_STATE_FROM_PRE_OOS";

export interface TrialAccountingPolicy {
  readonly familyId: string;
  readonly unit: "ONE_TRIAL_PER_RULE_PARAMETER_CONFIGURATION";
  readonly variantHandling: "COUNT_EACH_VARIANT";
  readonly declaredTrialCount: number;
}

export interface HypothesisPreRegistration {
  readonly declaredBy: string;
  readonly sourceReference: string;
  readonly declarationOrdinal: number;
}

export interface HypothesisResearchIntent {
  readonly question: string;
  readonly falsificationCriterion: string;
}

export interface ResearchHypothesisDefinition {
  readonly hypothesisId: string;
  readonly version: string;
  readonly title: string;
  readonly description: string;
  readonly rationale: string;
  readonly rule: HypothesisRuleReference;
  readonly assetScope: readonly AssetId[];
  readonly requiredDependencies: readonly ResearchDependency[];
  readonly parameterSpace: readonly ParameterSpecification[];
  readonly researchIntent: HypothesisResearchIntent;
  readonly trainOosPolicy: TrainOosPolicy;
  readonly statefulOosBoundaryPolicy: StatefulOosBoundaryPolicy;
  readonly trialAccounting: TrialAccountingPolicy;
  readonly lifecycle: HypothesisLifecycle;
  readonly preRegistration: HypothesisPreRegistration;
}

export interface RegisteredResearchHypothesis extends ResearchHypothesisDefinition {
  readonly semanticIdentity: string;
  readonly predictiveValidityEstablished: false;
  readonly approvedForPaperAction: false;
  readonly grantsExecutionAuthority: false;
}

export interface HypothesisRegistrySnapshot {
  readonly schemaVersion: typeof HYPOTHESIS_REGISTRY_SCHEMA_VERSION;
  readonly intendedUse: "RESEARCH_GOVERNANCE_ONLY";
  readonly hypotheses: readonly RegisteredResearchHypothesis[];
  readonly semanticIdentity: string;
  readonly predictiveValidityEstablished: false;
  readonly approvedForPaperAction: false;
  readonly grantsExecutionAuthority: false;
}

export class HypothesisRegistryValidationError extends Error {
  constructor(message: string) {
    super(`[HypothesisRegistry] ${message}`);
    this.name = "HypothesisRegistryValidationError";
  }
}

const FORBIDDEN_RESULT_FIELDS = new Set([
  "performance",
  "sharpe",
  "return",
  "returns",
  "winrate",
  "oosresult",
  "ranking",
  "rank",
  "score",
  "pnl",
  "bestparameter",
  "bestparameters",
  "selectedparameter",
  "selectedparameters",
]);

function fail(message: string): never {
  throw new HypothesisRegistryValidationError(message);
}

function requireText(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) fail(`${field} must be a non-empty string.`);
  return value.trim();
}

function normalizedFieldName(value: string): string {
  return value.replace(/[_\-\s]/g, "").toLowerCase();
}

function rejectResultFields(value: unknown, path = "definition", seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) fail(`${path} must not contain cycles.`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectResultFields(item, `${path}[${index}]`, seen));
  } else {
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_RESULT_FIELDS.has(normalizedFieldName(key))) {
        fail(`${path}.${key} is a result/performance-selection field and is prohibited at registration.`);
      }
      rejectResultFields(child, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
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

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function normalizeScalar(value: ParameterScalar, field: string): ParameterScalar {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  fail(`${field} must be a deterministic scalar with finite numeric values.`);
}

function scalarKey(value: ParameterScalar): string {
  return `${value === null ? "null" : typeof value}:${JSON.stringify(value)}`;
}

function rangeCardinality(specification: Extract<ParameterSpecification, { kind: "RANGE" }>): number {
  const span = specification.maximum - specification.minimum;
  const steps = span / specification.step;
  const rounded = Math.round(steps);
  if (!Number.isFinite(steps) || Math.abs(steps - rounded) > 1e-10) {
    fail(`${specification.name} range must terminate exactly on maximum using step.`);
  }
  const count = rounded + 1;
  if (!Number.isSafeInteger(count) || count <= 0 || count > 10_000) {
    fail(`${specification.name} range must declare between 1 and 10000 finite values.`);
  }
  return count;
}

function normalizeParameterSpace(
  input: readonly ParameterSpecification[]
): { specifications: readonly ParameterSpecification[]; trialCount: number } {
  if (!Array.isArray(input)) fail("parameterSpace must be an explicit array, including [] for no parameters.");
  const names = new Set<string>();
  const specifications = input.map((specification, index): ParameterSpecification => {
    const name = requireText(specification.name, `parameterSpace[${index}].name`);
    if (names.has(name)) fail(`duplicate parameter name ${name}.`);
    names.add(name);
    if (specification.kind === "FIXED") {
      return Object.freeze({ name, kind: "FIXED", value: normalizeScalar(specification.value, name) });
    }
    if (specification.kind === "CANDIDATES") {
      if (!Array.isArray(specification.values) || specification.values.length === 0) {
        fail(`${name} candidates must be non-empty.`);
      }
      const values = specification.values.map((value: ParameterScalar) => normalizeScalar(value, name));
      const keys = values.map(scalarKey);
      if (new Set(keys).size !== keys.length) fail(`${name} candidates must not contain duplicates.`);
      const sorted = [...values].sort((left, right) => scalarKey(left).localeCompare(scalarKey(right)));
      return Object.freeze({ name, kind: "CANDIDATES", values: Object.freeze(sorted) });
    }
    if (specification.kind === "RANGE") {
      if (![specification.minimum, specification.maximum, specification.step].every(Number.isFinite)) {
        fail(`${name} range values must be finite.`);
      }
      if (specification.minimum > specification.maximum) fail(`${name} range minimum cannot exceed maximum.`);
      if (specification.step <= 0) fail(`${name} range step must be positive.`);
      const normalized = Object.freeze({
        name,
        kind: "RANGE" as const,
        minimum: specification.minimum,
        maximum: specification.maximum,
        step: specification.step,
      });
      rangeCardinality(normalized);
      return normalized;
    }
    fail(`${name} has unsupported parameter specification kind.`);
  }).sort((left, right) => left.name.localeCompare(right.name));

  let trialCount = 1;
  for (const specification of specifications) {
    const cardinality = specification.kind === "FIXED"
      ? 1
      : specification.kind === "CANDIDATES"
        ? specification.values.length
        : rangeCardinality(specification);
    trialCount *= cardinality;
    if (!Number.isSafeInteger(trialCount) || trialCount > 1_000_000) {
      fail("parameterSpace exceeds the declarative one-million-trial safety ceiling.");
    }
  }
  return { specifications: Object.freeze(specifications), trialCount };
}

function dependencyKey(dependency: ResearchDependency): string {
  return dependency.kind === "SERIES"
    ? `SERIES:${dependency.seriesId}`
    : `TIMEFRAME:${dependency.timeframe}`;
}

function normalizeDependencies(input: readonly ResearchDependency[]): readonly ResearchDependency[] {
  if (!Array.isArray(input)) fail("requiredDependencies must be an explicit array.");
  const seen = new Set<string>();
  const dependencies = input.map((dependency): ResearchDependency => {
    if (dependency.kind === "SERIES") {
      if (!(dependency.seriesId in RESEARCH_SERIES_SPECS)) fail(`unsupported series ${dependency.seriesId}.`);
    } else if (dependency.kind !== "TIMEFRAME" || !["1H", "4H", "1D"].includes(dependency.timeframe)) {
      fail("unsupported research dependency.");
    }
    const key = dependencyKey(dependency);
    if (seen.has(key)) fail(`duplicate dependency ${key}.`);
    seen.add(key);
    return Object.freeze({ ...dependency });
  });
  return Object.freeze(dependencies.sort((left, right) => dependencyKey(left).localeCompare(dependencyKey(right))));
}

function normalizeAssetScope(input: readonly AssetId[]): readonly AssetId[] {
  if (!Array.isArray(input) || input.length === 0) fail("assetScope must contain at least one asset.");
  const assets = input.map((asset, index) => requireText(asset, `assetScope[${index}]`));
  if (new Set(assets).size !== assets.length) fail("assetScope must not contain duplicates.");
  return Object.freeze([...assets].sort());
}

function normalizeInterval(interval: ResearchInterval, field: string): ResearchInterval {
  if (!Number.isSafeInteger(interval.startTime) || interval.startTime < 0
    || !Number.isSafeInteger(interval.endTime) || interval.endTime < 0) {
    fail(`${field} boundaries must be non-negative safe-integer epoch milliseconds.`);
  }
  if (interval.startTime >= interval.endTime) fail(`${field} startTime must be before endTime.`);
  return Object.freeze({ startTime: interval.startTime, endTime: interval.endTime });
}

function normalizeTrainOosPolicy(policy: TrainOosPolicy): TrainOosPolicy {
  const training = normalizeInterval(policy.training, "training");
  const oos = normalizeInterval(policy.oos, "oos");
  if (policy.ordering !== "TRAIN_BEFORE_OOS" || training.endTime > oos.startTime) {
    fail("training must end at or before the OOS interval starts.");
  }
  if (policy.oosReuse !== "NEVER_TUNE_ON_OOS") fail("OOS data must never be declared reusable for tuning.");
  return Object.freeze({
    policyId: requireText(policy.policyId, "trainOosPolicy.policyId"),
    training,
    oos,
    ordering: "TRAIN_BEFORE_OOS",
    oosReuse: "NEVER_TUNE_ON_OOS",
  });
}

function normalizeStatefulOosBoundaryPolicy(
  policy: StatefulOosBoundaryPolicy
): StatefulOosBoundaryPolicy {
  if (!["NOT_APPLICABLE", "RESET_AT_OOS_START", "CARRY_PIT_STATE_FROM_PRE_OOS"].includes(policy)) {
    fail("statefulOosBoundaryPolicy must be explicitly preregistered.");
  }
  return policy;
}

function normalizeTrialAccounting(
  policy: TrialAccountingPolicy,
  expectedTrialCount: number
): TrialAccountingPolicy {
  if (policy.unit !== "ONE_TRIAL_PER_RULE_PARAMETER_CONFIGURATION"
    || policy.variantHandling !== "COUNT_EACH_VARIANT") {
    fail("trialAccounting must count every distinct rule/parameter configuration as one trial.");
  }
  if (!Number.isSafeInteger(policy.declaredTrialCount) || policy.declaredTrialCount <= 0) {
    fail("declaredTrialCount must be a positive safe integer.");
  }
  if (policy.declaredTrialCount !== expectedTrialCount) {
    fail(`declaredTrialCount ${policy.declaredTrialCount} must equal parameter-space cardinality ${expectedTrialCount}.`);
  }
  return Object.freeze({
    familyId: requireText(policy.familyId, "trialAccounting.familyId"),
    unit: "ONE_TRIAL_PER_RULE_PARAMETER_CONFIGURATION",
    variantHandling: "COUNT_EACH_VARIANT",
    declaredTrialCount: policy.declaredTrialCount,
  });
}

export function hypothesisRuleReference(
  rule: Pick<ResearchRule, "ruleId" | "version" | "semanticIdentity">
    | Pick<StatefulResearchRule<StatefulResearchState>, "ruleId" | "version" | "semanticIdentity">
): HypothesisRuleReference {
  return Object.freeze({
    ruleId: requireText(rule.ruleId, "rule.ruleId"),
    version: requireText(rule.version, "rule.version"),
    semanticIdentity: requireText(rule.semanticIdentity, "rule.semanticIdentity"),
  });
}

function scientificIdentityFor(definition: ResearchHypothesisDefinition): string {
  return canonicalJson({
    hypothesisId: definition.hypothesisId,
    version: definition.version,
    title: definition.title,
    description: definition.description,
    rationale: definition.rationale,
    rule: definition.rule,
    assetScope: definition.assetScope,
    requiredDependencies: definition.requiredDependencies.map(dependencyKey),
    parameterSpace: definition.parameterSpace,
    researchIntent: definition.researchIntent,
    trainOosPolicy: definition.trainOosPolicy,
    statefulOosBoundaryPolicy: definition.statefulOosBoundaryPolicy,
    trialAccounting: definition.trialAccounting,
  });
}

export function defineResearchHypothesis(
  definition: ResearchHypothesisDefinition
): RegisteredResearchHypothesis {
  rejectResultFields(definition);
  const parameterSpace = normalizeParameterSpace(definition.parameterSpace);
  const normalized = {
    hypothesisId: requireText(definition.hypothesisId, "hypothesisId"),
    version: requireText(definition.version, "version"),
    title: requireText(definition.title, "title"),
    description: requireText(definition.description, "description"),
    rationale: requireText(definition.rationale, "rationale"),
    rule: Object.freeze({
      ruleId: requireText(definition.rule.ruleId, "rule.ruleId"),
      version: requireText(definition.rule.version, "rule.version"),
      semanticIdentity: requireText(definition.rule.semanticIdentity, "rule.semanticIdentity"),
    }),
    assetScope: normalizeAssetScope(definition.assetScope),
    requiredDependencies: normalizeDependencies(definition.requiredDependencies),
    parameterSpace: parameterSpace.specifications,
    researchIntent: Object.freeze({
      question: requireText(definition.researchIntent.question, "researchIntent.question"),
      falsificationCriterion: requireText(
        definition.researchIntent.falsificationCriterion,
        "researchIntent.falsificationCriterion"
      ),
    }),
    trainOosPolicy: normalizeTrainOosPolicy(definition.trainOosPolicy),
    statefulOosBoundaryPolicy: normalizeStatefulOosBoundaryPolicy(definition.statefulOosBoundaryPolicy),
    trialAccounting: normalizeTrialAccounting(definition.trialAccounting, parameterSpace.trialCount),
    lifecycle: definition.lifecycle,
    preRegistration: Object.freeze({
      declaredBy: requireText(definition.preRegistration.declaredBy, "preRegistration.declaredBy"),
      sourceReference: requireText(definition.preRegistration.sourceReference, "preRegistration.sourceReference"),
      declarationOrdinal: definition.preRegistration.declarationOrdinal,
    }),
  };
  if (!(["PREREGISTERED", "EVALUATION_PENDING", "REJECTED", "FAILED", "INSUFFICIENT_EVIDENCE"] as const)
    .includes(normalized.lifecycle)) {
    fail("unsupported hypothesis lifecycle.");
  }
  if (!Number.isSafeInteger(normalized.preRegistration.declarationOrdinal)
    || normalized.preRegistration.declarationOrdinal <= 0) {
    fail("preRegistration.declarationOrdinal must be a positive safe integer.");
  }

  const semanticIdentity = scientificIdentityFor(normalized);
  return deepFreeze({
    ...normalized,
    semanticIdentity,
    predictiveValidityEstablished: false as const,
    approvedForPaperAction: false as const,
    grantsExecutionAuthority: false as const,
  });
}

function validateRegisteredHypothesis(
  hypothesis: RegisteredResearchHypothesis
): RegisteredResearchHypothesis {
  if (hypothesis.predictiveValidityEstablished !== false
    || hypothesis.approvedForPaperAction !== false
    || hypothesis.grantsExecutionAuthority !== false) {
    fail(`${hypothesis.hypothesisId}@${hypothesis.version} has forged research or action authority.`);
  }
  const recomputed = defineResearchHypothesis(hypothesis);
  if (recomputed.semanticIdentity !== hypothesis.semanticIdentity) {
    fail(`${hypothesis.hypothesisId}@${hypothesis.version} has a forged or stale scientific identity.`);
  }
  return recomputed;
}

function snapshotFor(hypotheses: readonly RegisteredResearchHypothesis[]): HypothesisRegistrySnapshot {
  const validated = hypotheses.map(validateRegisteredHypothesis);
  const sorted = Object.freeze(validated.sort((left, right) =>
    left.hypothesisId.localeCompare(right.hypothesisId)
      || left.version.localeCompare(right.version)
      || left.semanticIdentity.localeCompare(right.semanticIdentity)
  ));
  const identity = canonicalJson({
    schemaVersion: HYPOTHESIS_REGISTRY_SCHEMA_VERSION,
    hypotheses: sorted.map((hypothesis) => ({
      semanticIdentity: hypothesis.semanticIdentity,
      lifecycle: hypothesis.lifecycle,
      preRegistration: hypothesis.preRegistration,
    })),
  });
  return deepFreeze({
    schemaVersion: HYPOTHESIS_REGISTRY_SCHEMA_VERSION,
    intendedUse: "RESEARCH_GOVERNANCE_ONLY" as const,
    hypotheses: sorted,
    semanticIdentity: identity,
    predictiveValidityEstablished: false as const,
    approvedForPaperAction: false as const,
    grantsExecutionAuthority: false as const,
  });
}

function validateRegistrySnapshotContract(registry: HypothesisRegistrySnapshot): void {
  if (registry.schemaVersion !== HYPOTHESIS_REGISTRY_SCHEMA_VERSION
    || registry.intendedUse !== "RESEARCH_GOVERNANCE_ONLY"
    || registry.predictiveValidityEstablished !== false
    || registry.approvedForPaperAction !== false
    || registry.grantsExecutionAuthority !== false) {
    fail("registry snapshot has an incompatible or authority-bearing contract.");
  }
}

export function createHypothesisRegistry(
  definitions: readonly ResearchHypothesisDefinition[] = []
): HypothesisRegistrySnapshot {
  let registry = snapshotFor([]);
  for (const definition of definitions) registry = registerHypothesis(registry, definition);
  return registry;
}

export function registerHypothesis(
  registry: HypothesisRegistrySnapshot,
  definition: ResearchHypothesisDefinition
): HypothesisRegistrySnapshot {
  validateRegistrySnapshotContract(registry);
  const rebuilt = snapshotFor(registry.hypotheses);
  if (rebuilt.semanticIdentity !== registry.semanticIdentity) {
    fail("registry semantic identity is forged or stale.");
  }
  const hypothesis = defineResearchHypothesis(definition);
  if (registry.hypotheses.some((existing) => existing.semanticIdentity === hypothesis.semanticIdentity)) {
    fail(`duplicate hypothesis identity for ${hypothesis.hypothesisId}@${hypothesis.version}.`);
  }
  const sameVersion = registry.hypotheses.find((existing) =>
    existing.hypothesisId === hypothesis.hypothesisId && existing.version === hypothesis.version
  );
  if (sameVersion) {
    fail(`${hypothesis.hypothesisId}@${hypothesis.version} already exists with an incompatible identity.`);
  }
  return snapshotFor([...registry.hypotheses, hypothesis]);
}

export function serializeHypothesisRegistry(registry: HypothesisRegistrySnapshot): string {
  validateRegistrySnapshotContract(registry);
  const rebuilt = snapshotFor(registry.hypotheses);
  if (rebuilt.semanticIdentity !== registry.semanticIdentity) fail("registry semantic identity is forged or stale.");
  return canonicalJson(rebuilt);
}
