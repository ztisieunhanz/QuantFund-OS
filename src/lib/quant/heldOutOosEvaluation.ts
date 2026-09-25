// ============================================================================
// FILE: src/lib/quant/heldOutOosEvaluation.ts
// MODULE: FIXED-RULE HELD-OUT OOS EVIDENCE (M13D / D-A)
//
// Aggregates already-produced C-F observations for one fixed preregistered
// trial. It does not evaluate rules, rebuild features, or calculate returns.
// ============================================================================

import {
  serializeHypothesisRegistry,
  type HypothesisRegistrySnapshot,
  type RegisteredResearchHypothesis,
  type StatefulOosBoundaryPolicy,
} from "./hypothesisRegistry";
import {
  shadowResearchStateIdentity,
  validateParameterConfigurationIdentity,
  validateShadowResearchObservation,
  type ShadowHypothesisBinding,
  type ShadowResearchObservation,
  type StatefulShadowResearchObservation,
} from "./shadowResearchHarness";
import type { ResearchRuleStatus } from "./researchRules";
import type { StatefulResearchState } from "./statefulResearchRules";
import type { AssetId } from "./types";

export const HELD_OUT_OOS_EVALUATION_SCHEMA_VERSION = "M13D-D-A-1";

export interface HeldOutOosEvaluationInput {
  readonly registry: HypothesisRegistrySnapshot;
  readonly hypothesisId: string;
  readonly hypothesisVersion: string;
  readonly observations: readonly ShadowResearchObservation[];
  readonly preOosTransitionWitnesses?: readonly StatefulShadowResearchObservation<StatefulResearchState>[];
}

export interface HeldOutOosBinding {
  readonly hypothesisId: string;
  readonly hypothesisVersion: string;
  readonly hypothesisSemanticIdentity: string;
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly ruleSemanticIdentity: string;
  readonly parameterConfigurationIdentity: string;
  readonly trialAccountingIdentity: string;
  readonly assetId: AssetId;
  readonly statefulOosBoundaryPolicy: StatefulOosBoundaryPolicy;
  readonly oosInterval: Readonly<{ startTime: number; endTime: number }>;
}

export interface HeldOutOosEvidenceCounts {
  readonly total: number;
  readonly match: number;
  readonly noMatch: number;
  readonly insufficientEvidence: number;
  readonly evaluable: number;
  readonly insufficientEvidenceRate: number;
}

export interface HeldOutOosEvidenceSummary {
  readonly kind: "HELD_OUT_OOS_EVIDENCE_SUMMARY";
  readonly schemaVersion: typeof HELD_OUT_OOS_EVALUATION_SCHEMA_VERSION;
  readonly intendedUse: "HELD_OUT_OOS_RESEARCH_ONLY";
  readonly binding: HeldOutOosBinding;
  readonly counts: HeldOutOosEvidenceCounts;
  readonly orderedObservationSemanticIdentities: readonly string[];
  readonly orderedPreOosTransitionWitnessSemanticIdentities: readonly string[];
  readonly semanticIdentity: string;
  readonly predictiveValidityEstablished: false;
  readonly approvedForPaperAction: false;
  readonly grantsExecutionAuthority: false;
  readonly priceAuthority: "NONE";
}

export class HeldOutOosEvaluationValidationError extends Error {
  constructor(message: string) {
    super(`[HeldOutOosEvaluation] ${message}`);
    this.name = "HeldOutOosEvaluationValidationError";
  }
}

function fail(message: string): never {
  throw new HeldOutOosEvaluationValidationError(message);
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

function exactHypothesis(input: HeldOutOosEvaluationInput): RegisteredResearchHypothesis {
  serializeHypothesisRegistry(input.registry);
  const matches = input.registry.hypotheses.filter((hypothesis) =>
    hypothesis.hypothesisId === input.hypothesisId && hypothesis.version === input.hypothesisVersion
  );
  if (matches.length !== 1) {
    fail(`registry must contain exactly one ${input.hypothesisId}@${input.hypothesisVersion}.`);
  }
  return matches[0];
}

function bindingIdentity(binding: ShadowHypothesisBinding, assetId: AssetId): string {
  return canonicalJson({
    hypothesisId: binding.hypothesisId,
    hypothesisVersion: binding.hypothesisVersion,
    hypothesisSemanticIdentity: binding.hypothesisSemanticIdentity,
    ruleId: binding.ruleId,
    ruleVersion: binding.ruleVersion,
    ruleSemanticIdentity: binding.ruleSemanticIdentity,
    parameterConfigurationIdentity: binding.parameterConfigurationIdentity,
    trialAccountingIdentity: binding.trialAccountingIdentity,
    assetId,
    statefulOosBoundaryPolicy: binding.statefulOosBoundaryPolicy,
  });
}

function validateAgainstHypothesis(
  observation: ShadowResearchObservation,
  hypothesis: RegisteredResearchHypothesis
): void {
  const binding = observation.binding;
  if (binding.hypothesisId !== hypothesis.hypothesisId
    || binding.hypothesisVersion !== hypothesis.version
    || binding.hypothesisSemanticIdentity !== hypothesis.semanticIdentity) {
    fail("observation hypothesis identity does not match the requested preregistration.");
  }
  if (binding.ruleId !== hypothesis.rule.ruleId
    || binding.ruleVersion !== hypothesis.rule.version
    || binding.ruleSemanticIdentity !== hypothesis.rule.semanticIdentity) {
    fail("observation rule identity does not match the preregistered rule reference.");
  }
  if (binding.trialAccountingIdentity !== canonicalJson(hypothesis.trialAccounting)
    || canonicalJson(binding.declaredDependencies) !== canonicalJson(hypothesis.requiredDependencies)) {
    fail("observation trial or dependency identity does not match the preregistration.");
  }
  if (binding.statefulOosBoundaryPolicy !== hypothesis.statefulOosBoundaryPolicy) {
    fail("observation stateful OOS boundary policy does not match the preregistration.");
  }
  if (!hypothesis.assetScope.includes(observation.assetId)) {
    fail("observation asset is outside the preregistered asset scope.");
  }
}

function validateOosSequence(
  observations: readonly ShadowResearchObservation[],
  hypothesis: RegisteredResearchHypothesis
): void {
  const identities = new Set<string>();
  let previousTime: number | null = null;
  for (const observation of observations) {
    validateShadowResearchObservation(observation);
    validateAgainstHypothesis(observation, hypothesis);
    if (observation.window !== "OOS") fail("all counted observations must be classified OOS.");
    if (observation.decisionTime < hypothesis.trainOosPolicy.oos.startTime
      || observation.decisionTime >= hypothesis.trainOosPolicy.oos.endTime) {
      fail("observation is outside the preregistered half-open OOS interval.");
    }
    if (identities.has(observation.semanticIdentity)) fail("duplicate observation semantic identity.");
    identities.add(observation.semanticIdentity);
    if (previousTime !== null && observation.decisionTime === previousTime) {
      fail("duplicate OOS decisionTime.");
    }
    if (previousTime !== null && observation.decisionTime < previousTime) {
      fail("OOS observations must be supplied in strict chronological order.");
    }
    previousTime = observation.decisionTime;
  }
}

function requireSameBinding(
  observation: ShadowResearchObservation,
  expectedIdentity: string
): void {
  if (bindingIdentity(observation.binding, observation.assetId) !== expectedIdentity) {
    fail("mixed hypothesis, rule, configuration, trial, asset, or policy identities are prohibited.");
  }
}

function asStateful(
  observation: ShadowResearchObservation
): StatefulShadowResearchObservation<StatefulResearchState> {
  if (observation.evaluationKind !== "STATEFUL") fail("stateful boundary policy requires stateful observations.");
  return observation;
}

function validateStatefulChain(
  observations: readonly ShadowResearchObservation[],
  hypothesis: RegisteredResearchHypothesis,
  witnessInput: readonly StatefulShadowResearchObservation<StatefulResearchState>[] | undefined,
  expectedBindingIdentity: string
): readonly string[] {
  const stateful = observations.map(asStateful);
  const first = stateful[0];
  const firstBoundary = first.stateBoundaryEvidence;
  if (!firstBoundary) fail("stateful OOS observation is missing state-boundary evidence.");
  if (stateful.some((observation) =>
    observation.stateBoundaryEvidence?.canonicalInitialStateIdentity
      !== firstBoundary.canonicalInitialStateIdentity)) {
    fail("stateful OOS observations disagree on canonical initial-state identity.");
  }
  const witnesses = [...(witnessInput ?? [])];

  if (hypothesis.statefulOosBoundaryPolicy === "RESET_AT_OOS_START") {
    if (witnesses.length > 0) fail("RESET_AT_OOS_START must not supply a pre-OOS carry witness chain.");
    if (firstBoundary.priorStateIdentity !== firstBoundary.canonicalInitialStateIdentity) {
      fail("first RESET OOS observation did not start from the canonical initial state.");
    }
  } else if (hypothesis.statefulOosBoundaryPolicy === "CARRY_PIT_STATE_FROM_PRE_OOS") {
    if (witnesses.length === 0) {
      fail("CARRY_PIT_STATE_FROM_PRE_OOS requires a canonically anchored pre-OOS transition witness chain.");
    }
    const witnessIdentities = new Set<string>();
    let previousWitnessTime: number | null = null;
    for (const witness of witnesses) {
      validateShadowResearchObservation(witness);
      if (witness.evaluationKind !== "STATEFUL") {
        fail("carry witness chain must contain only stateful C-F transition observations.");
      }
      validateAgainstHypothesis(witness, hypothesis);
      requireSameBinding(witness, expectedBindingIdentity);
      if (witness.window === "OOS"
        || witness.decisionTime >= hypothesis.trainOosPolicy.oos.startTime
        || witness.decisionTime >= first.decisionTime) {
        fail("every carry witness must be strictly before the OOS interval and first OOS observation.");
      }
      if (witnessIdentities.has(witness.semanticIdentity)) {
        fail("duplicate carry witness semantic identity.");
      }
      witnessIdentities.add(witness.semanticIdentity);
      if (previousWitnessTime !== null && witness.decisionTime === previousWitnessTime) {
        fail("duplicate carry witness decisionTime.");
      }
      if (previousWitnessTime !== null && witness.decisionTime < previousWitnessTime) {
        fail("carry witness chain must be supplied in strict chronological order.");
      }
      previousWitnessTime = witness.decisionTime;
    }
    for (let index = 0; index < witnesses.length; index += 1) {
      const witness = witnesses[index];
      const boundary = witness.stateBoundaryEvidence;
      if (!boundary || boundary.canonicalInitialStateIdentity !== firstBoundary.canonicalInitialStateIdentity) {
        fail("carry witness chain disagrees on canonical initial-state identity.");
      }
      if (index === 0) {
        if (boundary.priorStateIdentity !== boundary.canonicalInitialStateIdentity
          || boundary.priorStateLastDecisionTime !== null) {
          fail("first carry witness is not anchored at the canonical initial state.");
        }
      } else {
        const previousWitness = witnesses[index - 1];
        if (boundary.priorStateLastDecisionTime !== previousWitness.decisionTime
          || boundary.priorStateIdentity
            !== shadowResearchStateIdentity(previousWitness.stateTransition.nextState)) {
          fail("carry witness chain contains a broken intermediate state transition.");
        }
      }
    }
    const finalWitness = witnesses[witnesses.length - 1];
    if (firstBoundary.priorStateLastDecisionTime !== finalWitness.decisionTime
      || shadowResearchStateIdentity(finalWitness.stateTransition.nextState)
        !== firstBoundary.priorStateIdentity) {
      fail("final carry witness next state does not equal the first OOS prior state.");
    }
  } else {
    fail("stateful observations cannot use NOT_APPLICABLE boundary policy.");
  }

  for (let index = 1; index < stateful.length; index += 1) {
    const previous = stateful[index - 1];
    const current = stateful[index];
    const currentBoundary = current.stateBoundaryEvidence;
    if (!currentBoundary
      || currentBoundary.priorStateLastDecisionTime !== previous.decisionTime
      || currentBoundary.priorStateIdentity !== shadowResearchStateIdentity(previous.stateTransition.nextState)) {
      fail("stateful OOS observations do not form a continuous transition chain.");
    }
  }
  return Object.freeze(witnesses.map((witness) => witness.semanticIdentity));
}

function countStatuses(observations: readonly ShadowResearchObservation[]): HeldOutOosEvidenceCounts {
  const count = (status: ResearchRuleStatus) => observations.filter((item) => item.status === status).length;
  const match = count("MATCH");
  const noMatch = count("NO_MATCH");
  const insufficientEvidence = count("INSUFFICIENT_EVIDENCE");
  const total = observations.length;
  const evaluable = match + noMatch;
  if (total !== match + noMatch + insufficientEvidence) fail("OOS status counts do not reconcile.");
  return deepFreeze({
    total,
    match,
    noMatch,
    insufficientEvidence,
    evaluable,
    insufficientEvidenceRate: insufficientEvidence / total,
  });
}

export function evaluateHeldOutOosEvidence(
  input: HeldOutOosEvaluationInput
): HeldOutOosEvidenceSummary {
  const hypothesis = exactHypothesis(input);
  if (!Array.isArray(input.observations) || input.observations.length === 0) {
    fail("at least one OOS observation is required; empty input cannot establish evidence.");
  }
  const observations = [...input.observations];
  validateOosSequence(observations, hypothesis);
  const expectedBindingIdentity = bindingIdentity(observations[0].binding, observations[0].assetId);
  for (const observation of observations) requireSameBinding(observation, expectedBindingIdentity);

  const first = observations[0];
  let witnessIdentities: readonly string[] = Object.freeze([]);
  if (first.evaluationKind === "STATELESS") {
    if (hypothesis.statefulOosBoundaryPolicy !== "NOT_APPLICABLE"
      || (input.preOosTransitionWitnesses?.length ?? 0) > 0
      || observations.some((observation) => observation.evaluationKind !== "STATELESS"
        || observation.stateBoundaryEvidence !== null)) {
      fail("stateless OOS evidence requires NOT_APPLICABLE and no state-boundary evidence.");
    }
  } else {
    if (observations.some((observation) => observation.evaluationKind !== "STATEFUL")) {
      fail("stateless and stateful observations cannot be mixed.");
    }
    witnessIdentities = validateStatefulChain(
      observations,
      hypothesis,
      input.preOosTransitionWitnesses,
      expectedBindingIdentity
    );
  }

  const binding = deepFreeze({
    hypothesisId: hypothesis.hypothesisId,
    hypothesisVersion: hypothesis.version,
    hypothesisSemanticIdentity: hypothesis.semanticIdentity,
    ruleId: first.binding.ruleId,
    ruleVersion: first.binding.ruleVersion,
    ruleSemanticIdentity: first.binding.ruleSemanticIdentity,
    parameterConfigurationIdentity: first.binding.parameterConfigurationIdentity,
    trialAccountingIdentity: first.binding.trialAccountingIdentity,
    assetId: first.assetId,
    statefulOosBoundaryPolicy: hypothesis.statefulOosBoundaryPolicy,
    oosInterval: { ...hypothesis.trainOosPolicy.oos },
  });
  const counts = countStatuses(observations);
  const orderedObservationSemanticIdentities = Object.freeze(
    observations.map((observation) => observation.semanticIdentity)
  );
  const identityMaterial = {
    schemaVersion: HELD_OUT_OOS_EVALUATION_SCHEMA_VERSION,
    intendedUse: "HELD_OUT_OOS_RESEARCH_ONLY" as const,
    binding,
    counts,
    orderedObservationSemanticIdentities,
    orderedPreOosTransitionWitnessSemanticIdentities: witnessIdentities,
    predictiveValidityEstablished: false as const,
    approvedForPaperAction: false as const,
    grantsExecutionAuthority: false as const,
    priceAuthority: "NONE" as const,
  } as const;
  return deepFreeze({
    kind: "HELD_OUT_OOS_EVIDENCE_SUMMARY" as const,
    ...identityMaterial,
    semanticIdentity: canonicalJson(identityMaterial),
  });
}

export function validateHeldOutOosEvidenceSummary(
  registry: HypothesisRegistrySnapshot,
  summary: HeldOutOosEvidenceSummary
): HeldOutOosEvidenceSummary {
  serializeHypothesisRegistry(registry);
  const hypotheses = registry.hypotheses.filter((hypothesis) =>
    hypothesis.hypothesisId === summary.binding.hypothesisId
      && hypothesis.version === summary.binding.hypothesisVersion
  );
  if (hypotheses.length !== 1) fail("summary must bind exactly one registered hypothesis.");
  const hypothesis = hypotheses[0];
  const binding = summary.binding;
  if (summary.kind !== "HELD_OUT_OOS_EVIDENCE_SUMMARY"
    || summary.schemaVersion !== HELD_OUT_OOS_EVALUATION_SCHEMA_VERSION
    || summary.intendedUse !== "HELD_OUT_OOS_RESEARCH_ONLY"
    || summary.predictiveValidityEstablished !== false
    || summary.approvedForPaperAction !== false
    || summary.grantsExecutionAuthority !== false
    || summary.priceAuthority !== "NONE") {
    fail("summary has incompatible schema, intended-use, or authority semantics.");
  }
  if (binding.hypothesisSemanticIdentity !== hypothesis.semanticIdentity
    || binding.ruleId !== hypothesis.rule.ruleId
    || binding.ruleVersion !== hypothesis.rule.version
    || binding.ruleSemanticIdentity !== hypothesis.rule.semanticIdentity
    || binding.trialAccountingIdentity !== canonicalJson(hypothesis.trialAccounting)
    || binding.statefulOosBoundaryPolicy !== hypothesis.statefulOosBoundaryPolicy
    || !hypothesis.assetScope.includes(binding.assetId)
    || binding.oosInterval.startTime !== hypothesis.trainOosPolicy.oos.startTime
    || binding.oosInterval.endTime !== hypothesis.trainOosPolicy.oos.endTime) {
    fail("summary binding does not match the registered hypothesis and trial contract.");
  }
  const parameterBinding = validateParameterConfigurationIdentity(
    hypothesis,
    binding.parameterConfigurationIdentity
  );
  if (parameterBinding.trialAccountingIdentity !== binding.trialAccountingIdentity) {
    fail("summary parameter configuration contradicts its trial-accounting identity.");
  }
  const counts = summary.counts;
  if (![counts.total, counts.match, counts.noMatch, counts.insufficientEvidence, counts.evaluable]
    .every((value) => Number.isSafeInteger(value) && value >= 0)
    || counts.total <= 0
    || counts.total !== counts.match + counts.noMatch + counts.insufficientEvidence
    || counts.evaluable !== counts.match + counts.noMatch
    || counts.insufficientEvidenceRate !== counts.insufficientEvidence / counts.total) {
    fail("summary categorical counts are malformed or do not reconcile.");
  }
  if (!Array.isArray(summary.orderedObservationSemanticIdentities)
    || summary.orderedObservationSemanticIdentities.length !== counts.total
    || summary.orderedObservationSemanticIdentities.some((identity) =>
      typeof identity !== "string" || identity.length === 0)
    || new Set(summary.orderedObservationSemanticIdentities).size
      !== summary.orderedObservationSemanticIdentities.length
    || !Array.isArray(summary.orderedPreOosTransitionWitnessSemanticIdentities)
    || summary.orderedPreOosTransitionWitnessSemanticIdentities.some((identity) =>
      typeof identity !== "string" || identity.length === 0)
    || new Set(summary.orderedPreOosTransitionWitnessSemanticIdentities).size
      !== summary.orderedPreOosTransitionWitnessSemanticIdentities.length) {
    fail("summary ordered evidence identities are malformed or duplicated.");
  }
  if (binding.statefulOosBoundaryPolicy === "CARRY_PIT_STATE_FROM_PRE_OOS") {
    if (summary.orderedPreOosTransitionWitnessSemanticIdentities.length === 0) {
      fail("CARRY summary requires its ordered pre-OOS witness identities.");
    }
  } else if (summary.orderedPreOosTransitionWitnessSemanticIdentities.length !== 0) {
    fail("non-CARRY summary must not contain pre-OOS witness identities.");
  }
  const identityMaterial = {
    schemaVersion: summary.schemaVersion,
    intendedUse: summary.intendedUse,
    binding: summary.binding,
    counts: summary.counts,
    orderedObservationSemanticIdentities: summary.orderedObservationSemanticIdentities,
    orderedPreOosTransitionWitnessSemanticIdentities:
      summary.orderedPreOosTransitionWitnessSemanticIdentities,
    predictiveValidityEstablished: summary.predictiveValidityEstablished,
    approvedForPaperAction: summary.approvedForPaperAction,
    grantsExecutionAuthority: summary.grantsExecutionAuthority,
    priceAuthority: summary.priceAuthority,
  };
  if (summary.semanticIdentity !== canonicalJson(identityMaterial)) {
    fail("summary semantic identity is forged or stale.");
  }
  return summary;
}
