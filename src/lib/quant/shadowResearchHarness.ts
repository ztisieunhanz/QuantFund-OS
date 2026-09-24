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
  readonly evaluation: ResearchRuleResult | StatefulResearchTransition<StatefulResearchState>;
}): string {
  return canonicalJson({
    schemaVersion: SHADOW_RESEARCH_SCHEMA_VERSION,
    ...input,
  });
}

export function runStatelessShadowObservation(
  input: StatelessShadowResearchRunInput
): StatelessShadowResearchObservation {
  const prepared = prepareBinding(input, input.rule);
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
