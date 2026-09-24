// ============================================================================
// FILE: src/lib/quant/shadowResearchHarness.ts
// MODULE: PIT-SAFE SHADOW RESEARCH HARNESS (M13C / C-F)
//
// Connects preregistered hypotheses, PIT-safe features, and existing research
// rules. It produces research evidence only and has no trading authority.
// ============================================================================

import {
  serializeHypothesisRegistry,
  type HypothesisRegistrySnapshot,
  type ParameterScalar,
  type ParameterSpecification,
  type RegisteredResearchHypothesis,
  type StatefulOosBoundaryPolicy,
  type TrialAccountingPolicy,
} from "./hypothesisRegistry";
import {
  buildResearchFeatureVector,
  type ResearchFeatureDefinition,
  type ResearchFeatureValue,
  type ResearchFeatureVector,
} from "./researchFeatureBuilder";
import type {
  ResearchDependency,
  ResearchEvaluationContext,
  ResearchRule,
  ResearchRuleResult,
  ResearchRuleStatus,
} from "./researchRules";
import type {
  StatefulResearchRule,
  StatefulResearchState,
  StatefulResearchTransition,
} from "./statefulResearchRules";
import { BAR_DURATION_MS } from "./timeDomain";
import type { AssetId } from "./types";

export const SHADOW_RESEARCH_SCHEMA_VERSION = "M13C-C-F-1";

export type ShadowResearchWindow = "TRAIN" | "OOS" | "OUTSIDE_DECLARED_WINDOW";
export type ParameterConfiguration = Readonly<Record<string, ParameterScalar>>;

export interface ShadowHypothesisBinding {
  readonly hypothesisId: string;
  readonly hypothesisVersion: string;
  readonly hypothesisSemanticIdentity: string;
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly ruleSemanticIdentity: string;
  readonly parameterConfiguration: ParameterConfiguration;
  readonly parameterConfigurationIdentity: string;
  readonly trialAccounting: TrialAccountingPolicy;
  readonly trialAccountingIdentity: string;
  readonly declaredDependencies: readonly ResearchDependency[];
  readonly statefulOosBoundaryPolicy: StatefulOosBoundaryPolicy;
}

export interface ShadowStateBoundaryEvidence {
  readonly policy: Exclude<StatefulOosBoundaryPolicy, "NOT_APPLICABLE">;
  readonly priorStateIdentity: string;
  readonly priorStateLastDecisionTime: number | null;
  readonly canonicalInitialStateIdentity: string;
}

interface ShadowObservationBase {
  readonly kind: "SHADOW_RESEARCH_OBSERVATION";
  readonly schemaVersion: typeof SHADOW_RESEARCH_SCHEMA_VERSION;
  readonly assetId: AssetId;
  readonly decisionTime: number;
  readonly asOf: number;
  readonly window: ShadowResearchWindow;
  readonly binding: ShadowHypothesisBinding;
  readonly featureVectorSemanticIdentity: string;
  readonly featureEvidence: readonly ResearchFeatureValue[];
  readonly stateBoundaryEvidence: ShadowStateBoundaryEvidence | null;
  readonly status: ResearchRuleStatus;
  readonly semanticIdentity: string;
  readonly intendedUse: "SHADOW_RESEARCH_ONLY";
  readonly predictiveValidityEstablished: false;
  readonly approvedForPaperAction: false;
  readonly grantsExecutionAuthority: false;
  readonly priceAuthority: "NONE";
}

export interface StatelessShadowResearchObservation extends ShadowObservationBase {
  readonly evaluationKind: "STATELESS";
  readonly ruleResult: ResearchRuleResult;
  readonly stateTransition: null;
}

export interface StatefulShadowResearchObservation<S extends StatefulResearchState>
  extends ShadowObservationBase {
  readonly evaluationKind: "STATEFUL";
  readonly ruleResult: null;
  readonly stateTransition: StatefulResearchTransition<S>;
}

export type ShadowResearchObservation =
  | StatelessShadowResearchObservation
  | StatefulShadowResearchObservation<StatefulResearchState>;

export interface ShadowResearchRunInput {
  readonly registry: HypothesisRegistrySnapshot;
  readonly hypothesisId: string;
  readonly hypothesisVersion: string;
  readonly parameterConfiguration: ParameterConfiguration;
  readonly featureVector: ResearchFeatureVector;
  readonly context: ResearchEvaluationContext;
}

export interface StatelessShadowResearchRunInput extends ShadowResearchRunInput {
  readonly rule: ResearchRule;
}

export interface StatefulShadowResearchRunInput<S extends StatefulResearchState>
  extends ShadowResearchRunInput {
  readonly rule: StatefulResearchRule<S>;
  readonly priorState: S;
}

export class ShadowResearchValidationError extends Error {
  constructor(message: string) {
    super(`[ShadowResearch] ${message}`);
    this.name = "ShadowResearchValidationError";
  }
}

function fail(message: string): never {
  throw new ShadowResearchValidationError(message);
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

function dependencyKey(dependency: ResearchDependency): string {
  return dependency.kind === "SERIES"
    ? `SERIES:${dependency.seriesId}`
    : `TIMEFRAME:${dependency.timeframe}`;
}

function scalarKey(value: ParameterScalar): string {
  return `${value === null ? "null" : typeof value}:${JSON.stringify(value)}`;
}

function validateScalar(value: unknown, field: string): asserts value is ParameterScalar {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  fail(`${field} must be a deterministic scalar with finite numeric values.`);
}

function valueAllowed(specification: ParameterSpecification, value: ParameterScalar): boolean {
  if (specification.kind === "FIXED") return scalarKey(value) === scalarKey(specification.value);
  if (specification.kind === "CANDIDATES") {
    return specification.values.some((candidate) => scalarKey(candidate) === scalarKey(value));
  }
  if (typeof value !== "number") return false;
  if (value < specification.minimum || value > specification.maximum) return false;
  const steps = (value - specification.minimum) / specification.step;
  return Number.isFinite(steps) && Math.abs(steps - Math.round(steps)) <= 1e-10;
}

function ruleIdentityParameters(ruleSemanticIdentity: string): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(ruleSemanticIdentity);
  } catch {
    fail("rule semantic identity is not deterministic JSON and cannot bind parameters.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("rule semantic identity has no parameter contract.");
  }
  const parameters = (parsed as Record<string, unknown>).parameters;
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
    fail("rule semantic identity has no parameter contract.");
  }
  return parameters as Readonly<Record<string, unknown>>;
}

function bindParameters(
  hypothesis: RegisteredResearchHypothesis,
  ruleSemanticIdentity: string,
  configuration: ParameterConfiguration
): Readonly<{
  configuration: ParameterConfiguration;
  configurationIdentity: string;
  trialAccountingIdentity: string;
}> {
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) {
    fail("parameterConfiguration must be a plain object.");
  }
  const expectedNames = hypothesis.parameterSpace.map((specification) => specification.name).sort();
  const actualNames = Object.keys(configuration).sort();
  if (canonicalJson(expectedNames) !== canonicalJson(actualNames)) {
    fail("parameterConfiguration must provide exactly the preregistered parameter names.");
  }
  const normalized: Record<string, ParameterScalar> = {};
  const encodedRuleParameters = ruleIdentityParameters(ruleSemanticIdentity);
  for (const specification of hypothesis.parameterSpace) {
    const value = configuration[specification.name];
    validateScalar(value, `parameterConfiguration.${specification.name}`);
    if (!valueAllowed(specification, value)) {
      fail(`parameterConfiguration.${specification.name} is outside the preregistered finite space.`);
    }
    const encoded = encodedRuleParameters[specification.name];
    validateScalar(encoded, `rule identity parameter ${specification.name}`);
    if (scalarKey(encoded) !== scalarKey(value)) {
      fail(`parameterConfiguration.${specification.name} does not match the supplied rule identity.`);
    }
    normalized[specification.name] = value;
  }
  const frozen = deepFreeze(normalized);
  return deepFreeze({
    configuration: frozen,
    configurationIdentity: canonicalJson({
      hypothesisSemanticIdentity: hypothesis.semanticIdentity,
      parameters: frozen,
    }),
    trialAccountingIdentity: canonicalJson(hypothesis.trialAccounting),
  });
}

function findHypothesis(
  registry: HypothesisRegistrySnapshot,
  hypothesisId: string,
  hypothesisVersion: string
): RegisteredResearchHypothesis {
  serializeHypothesisRegistry(registry);
  const matches = registry.hypotheses.filter(
    (hypothesis) => hypothesis.hypothesisId === hypothesisId && hypothesis.version === hypothesisVersion
  );
  if (matches.length !== 1) fail(`registry must contain exactly one ${hypothesisId}@${hypothesisVersion}.`);
  return matches[0];
}

function validateRuleBinding(
  hypothesis: RegisteredResearchHypothesis,
  rule: Pick<ResearchRule, "ruleId" | "version" | "semanticIdentity" | "dependencies">
    | Pick<StatefulResearchRule<StatefulResearchState>, "ruleId" | "version" | "semanticIdentity" | "dependencies">
): void {
  if (hypothesis.rule.ruleId !== rule.ruleId
    || hypothesis.rule.version !== rule.version
    || hypothesis.rule.semanticIdentity !== rule.semanticIdentity) {
    fail("supplied rule identity does not match the preregistered hypothesis rule reference.");
  }
  const declared = hypothesis.requiredDependencies.map(dependencyKey).sort();
  const actual = rule.dependencies.map(dependencyKey).sort();
  if (canonicalJson(declared) !== canonicalJson(actual)) {
    fail("supplied rule dependencies do not exactly match the preregistered hypothesis dependencies.");
  }
}

function classifyWindow(hypothesis: RegisteredResearchHypothesis, decisionTime: number): ShadowResearchWindow {
  const { training, oos } = hypothesis.trainOosPolicy;
  if (decisionTime >= training.startTime && decisionTime < training.endTime) return "TRAIN";
  if (decisionTime >= oos.startTime && decisionTime < oos.endTime) return "OOS";
  return "OUTSIDE_DECLARED_WINDOW";
}

function featureDefinitionFromValue(feature: ResearchFeatureValue): ResearchFeatureDefinition {
  return {
    featureId: feature.featureId,
    version: feature.version,
    description: "Revalidated shadow feature",
    dependency: feature.dependency,
    transformation: feature.transformation,
  };
}

function validateRawContext(context: ResearchEvaluationContext): void {
  if (!Number.isSafeInteger(context.decisionTime) || context.decisionTime < 0
    || context.asOf !== context.decisionTime || typeof context.assetId !== "string"
    || context.assetId.trim().length === 0) {
    fail("research context has an invalid asset or decisionTime/asOf boundary.");
  }
  for (const bar of context.oneHourBars ?? []) {
    if (!Number.isSafeInteger(bar.timestamp) || bar.timestamp + BAR_DURATION_MS > context.decisionTime) {
      fail("research context contains future or invalid 1H evidence.");
    }
  }
  for (const evidence of Object.values(context.series ?? {})) {
    if (evidence && evidence.availableAt > context.decisionTime) {
      fail("research context contains future series evidence.");
    }
  }

  const validationDefinitions: ResearchFeatureDefinition[] = [];
  if ((context.oneHourBars?.length ?? 0) > 0) {
    validationDefinitions.push({
      featureId: "__VALIDATE_1H__",
      version: "1",
      description: "Context validation only",
      dependency: { kind: "TIMEFRAME", timeframe: "1H" },
      transformation: { kind: "BAR_CLOSE", lag: 0 },
    });
  }
  if (context.derivedTimeframes) {
    for (const timeframe of ["4H", "1D"] as const) {
      validationDefinitions.push({
        featureId: `__VALIDATE_${timeframe}__`,
        version: "1",
        description: "Context validation only",
        dependency: { kind: "TIMEFRAME", timeframe },
        transformation: { kind: "BAR_CLOSE", lag: 0 },
      });
    }
  }
  for (const seriesId of Object.keys(context.series ?? {}).sort()) {
    validationDefinitions.push({
      featureId: `__VALIDATE_${seriesId}__`,
      version: "1",
      description: "Context validation only",
      dependency: { kind: "SERIES", seriesId: seriesId as never },
      transformation: { kind: "SERIES_LEVEL" },
    });
  }
  buildResearchFeatureVector({
    assetId: context.assetId,
    decisionTime: context.decisionTime,
    asOf: context.asOf,
    definitions: validationDefinitions,
    oneHourBars: context.oneHourBars,
    derivedTimeframes: context.derivedTimeframes,
    series: context.series,
  });
}

function revalidateFeatureVector(
  vector: ResearchFeatureVector,
  context: ResearchEvaluationContext
): ResearchFeatureVector {
  if (vector.schemaVersion !== "M13C-C-E-1" || vector.intendedUse !== "RESEARCH_ONLY"
    || vector.predictiveValidityEstablished !== false || vector.approvedForPaperAction !== false
    || vector.grantsExecutionAuthority !== false || vector.priceAuthority !== "NONE") {
    fail("feature vector has an incompatible or authority-bearing contract.");
  }
  if (vector.assetId !== context.assetId || vector.decisionTime !== context.decisionTime || vector.asOf !== context.asOf) {
    fail("feature vector does not share the research context asset and PIT boundary.");
  }
  validateRawContext(context);
  const rebuilt = buildResearchFeatureVector({
    assetId: context.assetId,
    decisionTime: context.decisionTime,
    asOf: context.asOf,
    definitions: vector.features.map(featureDefinitionFromValue),
    oneHourBars: context.oneHourBars,
    derivedTimeframes: context.derivedTimeframes,
    series: context.series,
  });
  if (rebuilt.specificationIdentity !== vector.specificationIdentity
    || rebuilt.semanticIdentity !== vector.semanticIdentity) {
    fail("feature vector semantic identity is forged or stale for the supplied PIT context.");
  }
  return rebuilt;
}

function scopedContext(
  hypothesis: RegisteredResearchHypothesis,
  features: readonly ResearchFeatureValue[],
  context: ResearchEvaluationContext
): ResearchEvaluationContext {
  const availableKeys = new Set(
    features.filter((feature) => feature.status === "AVAILABLE").map((feature) => dependencyKey(feature.dependency))
  );
  const declaredKeys = new Set(hypothesis.requiredDependencies.map(dependencyKey));
  const seriesEntries = hypothesis.requiredDependencies
    .filter((dependency) => dependency.kind === "SERIES")
    .flatMap((dependency) => {
      const key = dependencyKey(dependency);
      const evidence = context.series?.[dependency.seriesId];
      return availableKeys.has(key) && evidence ? [[dependency.seriesId, evidence] as const] : [];
    });
  const has = (timeframe: "1H" | "4H" | "1D") =>
    declaredKeys.has(`TIMEFRAME:${timeframe}`) && availableKeys.has(`TIMEFRAME:${timeframe}`);
  const use4h = has("4H");
  const use1d = has("1D");
  const derived = context.derivedTimeframes && (use4h || use1d)
    ? Object.freeze({
        ...context.derivedTimeframes,
        completed4hBars: use4h ? context.derivedTimeframes.completed4hBars : Object.freeze([]),
        completed1dBars: use1d ? context.derivedTimeframes.completed1dBars : Object.freeze([]),
        latestCompleted4hBar: use4h ? context.derivedTimeframes.latestCompleted4hBar : null,
        latestCompleted1dBar: use1d ? context.derivedTimeframes.latestCompleted1dBar : null,
      })
    : undefined;
  return Object.freeze({
    assetId: context.assetId,
    decisionTime: context.decisionTime,
    asOf: context.asOf,
    series: Object.freeze(Object.fromEntries(seriesEntries)),
    oneHourBars: has("1H") ? context.oneHourBars : undefined,
    derivedTimeframes: derived,
  });
}

function prepareBinding(
  input: ShadowResearchRunInput,
  rule: Pick<ResearchRule, "ruleId" | "version" | "semanticIdentity" | "dependencies">
    | Pick<StatefulResearchRule<StatefulResearchState>, "ruleId" | "version" | "semanticIdentity" | "dependencies">
): Readonly<{
  hypothesis: RegisteredResearchHypothesis;
  vector: ResearchFeatureVector;
  binding: ShadowHypothesisBinding;
  window: ShadowResearchWindow;
  context: ResearchEvaluationContext;
  featureEvidence: readonly ResearchFeatureValue[];
}> {
  const hypothesis = findHypothesis(input.registry, input.hypothesisId, input.hypothesisVersion);
  validateRuleBinding(hypothesis, rule);
  if (!hypothesis.assetScope.includes(input.context.assetId)) fail("observation asset is outside hypothesis assetScope.");
  const parameterBinding = bindParameters(hypothesis, rule.semanticIdentity, input.parameterConfiguration);
  const vector = revalidateFeatureVector(input.featureVector, input.context);
  const declaredKeys = new Set(hypothesis.requiredDependencies.map(dependencyKey));
  const featureEvidence = Object.freeze(
    vector.features.filter((feature) => declaredKeys.has(dependencyKey(feature.dependency)))
  );
  const binding = deepFreeze({
    hypothesisId: hypothesis.hypothesisId,
    hypothesisVersion: hypothesis.version,
    hypothesisSemanticIdentity: hypothesis.semanticIdentity,
    ruleId: rule.ruleId,
    ruleVersion: rule.version,
    ruleSemanticIdentity: rule.semanticIdentity,
    parameterConfiguration: parameterBinding.configuration,
    parameterConfigurationIdentity: parameterBinding.configurationIdentity,
    trialAccounting: hypothesis.trialAccounting,
    trialAccountingIdentity: parameterBinding.trialAccountingIdentity,
    declaredDependencies: hypothesis.requiredDependencies,
    statefulOosBoundaryPolicy: hypothesis.statefulOosBoundaryPolicy,
  });
  return deepFreeze({
    hypothesis,
    vector,
    binding,
    window: classifyWindow(hypothesis, input.context.decisionTime),
    context: scopedContext(hypothesis, featureEvidence, input.context),
    featureEvidence,
  });
}

function observationIdentity(input: {
  readonly evaluationKind: "STATELESS" | "STATEFUL";
  readonly binding: ShadowHypothesisBinding;
  readonly assetId: AssetId;
  readonly decisionTime: number;
  readonly asOf: number;
  readonly window: ShadowResearchWindow;
  readonly featureVectorSemanticIdentity: string;
  readonly featureEvidence: readonly ResearchFeatureValue[];
  readonly stateBoundaryEvidence: ShadowStateBoundaryEvidence | null;
  readonly evaluation: ResearchRuleResult | StatefulResearchTransition<StatefulResearchState>;
}): string {
  return canonicalJson({
    schemaVersion: SHADOW_RESEARCH_SCHEMA_VERSION,
    ...input,
  });
}

export function shadowResearchStateIdentity(state: StatefulResearchState): string {
  return canonicalJson(state);
}

function validateObservationContract(observation: ShadowResearchObservation): void {
  if (observation.kind !== "SHADOW_RESEARCH_OBSERVATION"
    || observation.schemaVersion !== SHADOW_RESEARCH_SCHEMA_VERSION
    || observation.intendedUse !== "SHADOW_RESEARCH_ONLY"
    || observation.predictiveValidityEstablished !== false
    || observation.approvedForPaperAction !== false
    || observation.grantsExecutionAuthority !== false
    || observation.priceAuthority !== "NONE") {
    fail("observation has an incompatible or authority-bearing contract.");
  }
  if (!Number.isSafeInteger(observation.decisionTime) || observation.decisionTime < 0
    || observation.asOf !== observation.decisionTime
    || typeof observation.assetId !== "string" || observation.assetId.trim().length === 0) {
    fail("observation has an invalid asset or decisionTime/asOf boundary.");
  }
  if (!["STATELESS", "STATEFUL"].includes(observation.evaluationKind)
    || !["TRAIN", "OOS", "OUTSIDE_DECLARED_WINDOW"].includes(observation.window)
    || !["MATCH", "NO_MATCH", "INSUFFICIENT_EVIDENCE"].includes(observation.status)) {
    fail("observation has an unsupported evaluation kind, window, or status.");
  }
  const binding = observation.binding;
  for (const [field, value] of Object.entries({
    hypothesisId: binding.hypothesisId,
    hypothesisVersion: binding.hypothesisVersion,
    hypothesisSemanticIdentity: binding.hypothesisSemanticIdentity,
    ruleId: binding.ruleId,
    ruleVersion: binding.ruleVersion,
    ruleSemanticIdentity: binding.ruleSemanticIdentity,
    parameterConfigurationIdentity: binding.parameterConfigurationIdentity,
    trialAccountingIdentity: binding.trialAccountingIdentity,
    featureVectorSemanticIdentity: observation.featureVectorSemanticIdentity,
  })) {
    if (typeof value !== "string" || value.length === 0) fail(`observation ${field} must be non-empty.`);
  }
  const expectedParameterIdentity = canonicalJson({
    hypothesisSemanticIdentity: binding.hypothesisSemanticIdentity,
    parameters: binding.parameterConfiguration,
  });
  if (binding.parameterConfigurationIdentity !== expectedParameterIdentity
    || binding.trialAccountingIdentity !== canonicalJson(binding.trialAccounting)) {
    fail("observation binding has a forged parameter or trial identity.");
  }
  for (const [name, value] of Object.entries(binding.parameterConfiguration)) {
    if (!(value === null || typeof value === "string" || typeof value === "boolean"
      || (typeof value === "number" && Number.isFinite(value)))) {
      fail(`observation parameterConfiguration.${name} is not a deterministic scalar.`);
    }
  }
}

function validateRuleResult(
  result: ResearchRuleResult,
  observation: StatelessShadowResearchObservation
): void {
  if (result.kind !== "RESEARCH_EVIDENCE"
    || result.ruleId !== observation.binding.ruleId
    || result.version !== observation.binding.ruleVersion
    || result.semanticIdentity !== observation.binding.ruleSemanticIdentity
    || result.status !== observation.status
    || result.decisionTime !== observation.decisionTime
    || result.evaluatedAt !== observation.decisionTime
    || result.asOf !== observation.asOf
    || result.assetId !== observation.assetId
    || result.predictiveValidityAssessed !== false
    || result.grantsExecutionAuthority !== false) {
    fail("stateless observation result is incompatible with its binding or PIT boundary.");
  }
  validateNestedRuleEvidence(result, observation.decisionTime, observation.asOf, observation.assetId);
}

function validateNestedRuleEvidence(
  result: ResearchRuleResult,
  decisionTime: number,
  asOf: number,
  assetId: AssetId
): void {
  if (result.kind !== "RESEARCH_EVIDENCE"
    || !["MATCH", "NO_MATCH", "INSUFFICIENT_EVIDENCE"].includes(result.status)
    || result.decisionTime !== decisionTime
    || result.evaluatedAt !== decisionTime
    || result.asOf !== asOf
    || result.assetId !== assetId
    || result.predictiveValidityAssessed !== false
    || result.grantsExecutionAuthority !== false) {
    fail("observation contains incompatible, non-PIT, or authority-bearing rule evidence.");
  }
  for (const child of result.childResults) {
    validateNestedRuleEvidence(child, decisionTime, asOf, assetId);
  }
}

function validateFeatureEvidence(observation: ShadowResearchObservation): void {
  const declared = new Set(observation.binding.declaredDependencies.map(dependencyKey));
  const seen = new Set<string>();
  for (const feature of observation.featureEvidence) {
    const key = `${feature.featureId}@${feature.version}`;
    if (seen.has(key)) fail(`observation contains duplicate feature evidence ${key}.`);
    seen.add(key);
    if (typeof feature.featureId !== "string" || feature.featureId.length === 0
      || typeof feature.version !== "string" || feature.version.length === 0
      || typeof feature.semanticIdentity !== "string" || feature.semanticIdentity.length === 0
      || !["AVAILABLE", "UNAVAILABLE"].includes(feature.status)
      || !declared.has(dependencyKey(feature.dependency))
      || feature.decisionTime !== observation.decisionTime
      || feature.asOf !== observation.asOf
      || feature.assetId !== observation.assetId
      || feature.predictiveValidityEstablished !== false
      || feature.approvedForPaperAction !== false
      || feature.grantsExecutionAuthority !== false) {
      fail("observation contains undeclared, cross-boundary, or authority-bearing feature evidence.");
    }
    if (feature.status === "AVAILABLE") {
      if (feature.reasonCode !== "AVAILABLE"
        || !Number.isFinite(feature.value) || feature.provenance === null) {
        fail("available feature evidence must contain a finite value and provenance.");
      }
      const availableAt = feature.provenance.kind === "TECHNICAL_BARS"
        ? feature.provenance.latestAvailableAt
        : feature.provenance.availableAt;
      if (!Number.isSafeInteger(availableAt) || availableAt > observation.decisionTime) {
        fail("feature evidence is not PIT-eligible at observation decisionTime.");
      }
      if (feature.provenance.kind === "TECHNICAL_BARS"
        && feature.provenance.records.some((record) => record.availableAt > observation.decisionTime)) {
        fail("technical feature provenance contains future evidence.");
      }
      if (feature.provenance.kind === "RESEARCH_SERIES"
        && (feature.provenance.record.availableAt > observation.decisionTime
          || feature.provenance.record.availableAt !== feature.provenance.availableAt)) {
        fail("research-series feature provenance contains future or inconsistent evidence.");
      }
    } else if (feature.reasonCode === "AVAILABLE"
      || feature.value !== null || feature.provenance !== null) {
      fail("unavailable feature evidence must not fabricate a value or provenance.");
    }
  }
}

function validateStateTransition(
  observation: StatefulShadowResearchObservation<StatefulResearchState>
): void {
  const transition = observation.stateTransition;
  const boundary = observation.stateBoundaryEvidence;
  if (!boundary || transition.kind !== "RESEARCH_STATE_TRANSITION"
    || transition.ruleId !== observation.binding.ruleId
    || transition.version !== observation.binding.ruleVersion
    || transition.semanticIdentity !== observation.binding.ruleSemanticIdentity
    || transition.status !== observation.status
    || transition.decisionTime !== observation.decisionTime
    || transition.asOf !== observation.asOf
    || transition.assetId !== observation.assetId
    || transition.predictiveValidityAssessed !== false
    || transition.grantsExecutionAuthority !== false) {
    fail("stateful observation transition is incompatible with its binding or PIT boundary.");
  }
  for (const child of transition.childResults) {
    validateNestedRuleEvidence(child, observation.decisionTime, observation.asOf, observation.assetId);
  }
  if (observation.binding.statefulOosBoundaryPolicy === "NOT_APPLICABLE"
    || boundary.policy !== observation.binding.statefulOosBoundaryPolicy) {
    fail("stateful observation boundary policy is incompatible with its binding.");
  }
  if (transition.previousState.assetId !== observation.assetId
    || transition.nextState.assetId !== observation.assetId
    || transition.previousState.ruleSemanticIdentity !== observation.binding.ruleSemanticIdentity
    || transition.nextState.ruleSemanticIdentity !== observation.binding.ruleSemanticIdentity
    || transition.previousState.lastDecisionTime !== boundary.priorStateLastDecisionTime
    || transition.nextState.lastDecisionTime !== observation.decisionTime
    || boundary.priorStateIdentity !== shadowResearchStateIdentity(transition.previousState)
    || typeof boundary.canonicalInitialStateIdentity !== "string"
    || boundary.canonicalInitialStateIdentity.length === 0
    || (boundary.priorStateLastDecisionTime !== null
      && (!Number.isSafeInteger(boundary.priorStateLastDecisionTime)
        || boundary.priorStateLastDecisionTime >= observation.decisionTime))) {
    fail("stateful observation has invalid or inconsistent state-boundary evidence.");
  }
}

export function validateShadowResearchObservation(
  observation: ShadowResearchObservation
): ShadowResearchObservation {
  validateObservationContract(observation);
  validateFeatureEvidence(observation);
  if (observation.evaluationKind === "STATELESS") {
    if (observation.binding.statefulOosBoundaryPolicy !== "NOT_APPLICABLE"
      || observation.stateBoundaryEvidence !== null
      || observation.stateTransition !== null
      || observation.ruleResult === null) {
      fail("stateless observation has incompatible state-boundary evidence.");
    }
    validateRuleResult(observation.ruleResult, observation);
  } else {
    if (observation.ruleResult !== null || observation.stateTransition === null) {
      fail("stateful observation must contain exactly one state transition.");
    }
    validateStateTransition(observation);
  }
  const recomputed = observationIdentity({
    evaluationKind: observation.evaluationKind,
    binding: observation.binding,
    assetId: observation.assetId,
    decisionTime: observation.decisionTime,
    asOf: observation.asOf,
    window: observation.window,
    featureVectorSemanticIdentity: observation.featureVectorSemanticIdentity,
    featureEvidence: observation.featureEvidence,
    stateBoundaryEvidence: observation.stateBoundaryEvidence,
    evaluation: observation.evaluationKind === "STATELESS"
      ? observation.ruleResult
      : observation.stateTransition,
  });
  if (recomputed !== observation.semanticIdentity) {
    fail("observation semantic identity is forged or stale.");
  }
  return observation;
}

export function runStatelessShadowObservation(
  input: StatelessShadowResearchRunInput
): StatelessShadowResearchObservation {
  const prepared = prepareBinding(input, input.rule);
  if (prepared.hypothesis.statefulOosBoundaryPolicy !== "NOT_APPLICABLE") {
    fail("stateless rules require statefulOosBoundaryPolicy NOT_APPLICABLE.");
  }
  const ruleResult = input.rule.evaluate(prepared.context);
  const semanticIdentity = observationIdentity({
    evaluationKind: "STATELESS",
    binding: prepared.binding,
    assetId: input.context.assetId,
    decisionTime: input.context.decisionTime,
    asOf: input.context.asOf,
    window: prepared.window,
    featureVectorSemanticIdentity: prepared.vector.semanticIdentity,
    featureEvidence: prepared.featureEvidence,
    stateBoundaryEvidence: null,
    evaluation: ruleResult,
  });
  return deepFreeze({
    kind: "SHADOW_RESEARCH_OBSERVATION" as const,
    schemaVersion: SHADOW_RESEARCH_SCHEMA_VERSION,
    evaluationKind: "STATELESS" as const,
    assetId: input.context.assetId,
    decisionTime: input.context.decisionTime,
    asOf: input.context.asOf,
    window: prepared.window,
    binding: prepared.binding,
    featureVectorSemanticIdentity: prepared.vector.semanticIdentity,
    featureEvidence: prepared.featureEvidence,
    stateBoundaryEvidence: null,
    status: ruleResult.status,
    ruleResult,
    stateTransition: null,
    semanticIdentity,
    intendedUse: "SHADOW_RESEARCH_ONLY" as const,
    predictiveValidityEstablished: false as const,
    approvedForPaperAction: false as const,
    grantsExecutionAuthority: false as const,
    priceAuthority: "NONE" as const,
  });
}

export function runStatefulShadowObservation<S extends StatefulResearchState>(
  input: StatefulShadowResearchRunInput<S>
): StatefulShadowResearchObservation<S> {
  const prepared = prepareBinding(input, input.rule);
  if (prepared.hypothesis.statefulOosBoundaryPolicy === "NOT_APPLICABLE") {
    fail("stateful rules require an explicit RESET or CARRY statefulOosBoundaryPolicy.");
  }
  const canonicalInitialState = input.rule.createInitialState(input.context.assetId);
  const stateBoundaryEvidence = deepFreeze({
    policy: prepared.hypothesis.statefulOosBoundaryPolicy,
    priorStateIdentity: shadowResearchStateIdentity(input.priorState),
    priorStateLastDecisionTime: input.priorState.lastDecisionTime,
    canonicalInitialStateIdentity: shadowResearchStateIdentity(canonicalInitialState),
  });
  const stateTransition = input.rule.transition(input.priorState, prepared.context);
  const semanticIdentity = observationIdentity({
    evaluationKind: "STATEFUL",
    binding: prepared.binding,
    assetId: input.context.assetId,
    decisionTime: input.context.decisionTime,
    asOf: input.context.asOf,
    window: prepared.window,
    featureVectorSemanticIdentity: prepared.vector.semanticIdentity,
    featureEvidence: prepared.featureEvidence,
    stateBoundaryEvidence,
    evaluation: stateTransition,
  });
  return deepFreeze({
    kind: "SHADOW_RESEARCH_OBSERVATION" as const,
    schemaVersion: SHADOW_RESEARCH_SCHEMA_VERSION,
    evaluationKind: "STATEFUL" as const,
    assetId: input.context.assetId,
    decisionTime: input.context.decisionTime,
    asOf: input.context.asOf,
    window: prepared.window,
    binding: prepared.binding,
    featureVectorSemanticIdentity: prepared.vector.semanticIdentity,
    featureEvidence: prepared.featureEvidence,
    stateBoundaryEvidence,
    status: stateTransition.status,
    ruleResult: null,
    stateTransition,
    semanticIdentity,
    intendedUse: "SHADOW_RESEARCH_ONLY" as const,
    predictiveValidityEstablished: false as const,
    approvedForPaperAction: false as const,
    grantsExecutionAuthority: false as const,
    priceAuthority: "NONE" as const,
  });
}
