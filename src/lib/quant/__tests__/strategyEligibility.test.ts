import { describe, expect, it } from "vitest";
import {
  createHypothesisRegistry,
  hypothesisRuleReference,
  type HypothesisRegistrySnapshot,
  type ResearchHypothesisDefinition,
} from "../hypothesisRegistry";
import { evaluateHeldOutOosEvidence } from "../heldOutOosEvaluation";
import { buildResearchFeatureVector, type ResearchFeatureDefinition } from "../researchFeatureBuilder";
import { createResearchRule, type ResearchRuleStatus } from "../researchRules";
import {
  ROBUSTNESS_FAMILY_PREREGISTRATION_SCHEMA_VERSION,
  defineRobustnessFamilyPreregistration,
} from "../robustnessFamilyPreregistration";
import {
  evaluateRobustnessFamily,
  type RobustnessFamilyMemberEvidenceInput,
} from "../robustnessFamilyEvaluation";
import {
  createResearchEvidenceRegistry,
  type ResearchEvidenceInput,
  type ResearchEvidenceRegistrySnapshot,
} from "../researchEvidenceRegistry";
import { runStatelessShadowObservation, type ShadowResearchObservation } from "../shadowResearchHarness";
import {
  CURRENT_STRATEGY_ELIGIBILITY_POLICY,
  createStrategyEligibilityRegistry,
  serializeStrategyEligibilityRegistry,
  validateStrategyEligibilityRegistry,
  type StrategyEligibilityRegistrySnapshot,
} from "../strategyEligibility";
import { BAR_DURATION_MS } from "../timeDomain";
import type { PointInTimeBar } from "../types";

const HOUR = BAR_DURATION_MS;
const TRAIN_START = Date.UTC(2020, 0, 1);
const OOS_START = Date.UTC(2022, 0, 1);
const OOS_END = OOS_START + 10 * HOUR;
const GRID = [OOS_START, OOS_START + HOUR, OOS_START + 2 * HOUR] as const;

const closeFeature: ResearchFeatureDefinition = {
  featureId: "BTC_1H_CLOSE",
  version: "1.0.0",
  description: "Canonical close evidence",
  dependency: { kind: "TIMEFRAME", timeframe: "1H" },
  transformation: { kind: "BAR_CLOSE", lag: 0 },
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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

function reidentifyEvidenceRegistry(
  registry: ResearchEvidenceRegistrySnapshot,
  mutate: (entry: Record<string, any>) => void
): ResearchEvidenceRegistrySnapshot {
  const draft = clone(registry) as unknown as Record<string, any>;
  mutate(draft.entries[0]);
  const { semanticIdentity: _entryIdentity, ...entryMaterial } = draft.entries[0];
  draft.entries[0].semanticIdentity = canonicalJson(entryMaterial);
  const { semanticIdentity: _registryIdentity, ...registryMaterial } = draft;
  draft.semanticIdentity = canonicalJson(registryMaterial);
  return draft as unknown as ResearchEvidenceRegistrySnapshot;
}

function reidentifyEligibilityRegistry(
  registry: StrategyEligibilityRegistrySnapshot,
  mutate: (draft: Record<string, any>) => void
): StrategyEligibilityRegistrySnapshot {
  const draft = clone(registry) as unknown as Record<string, any>;
  mutate(draft);
  const { semanticIdentity: _identity, ...material } = draft;
  draft.semanticIdentity = canonicalJson(material);
  return draft as unknown as StrategyEligibilityRegistrySnapshot;
}

function bars(time: number): PointInTimeBar[] {
  return [{ timestamp: time - HOUR, open: 100, high: 102, low: 99, close: 101, volume: 10 }];
}

function rule(hypothesisId: string, threshold: number, status: ResearchRuleStatus = "MATCH") {
  return createResearchRule({
    ruleId: `${hypothesisId}-RULE`,
    version: "1.0.0",
    description: "Exact fixed A-01 trial",
    rationale: "Produce categorical evidence without action authority.",
    dependencies: [{ kind: "TIMEFRAME", timeframe: "1H" }],
    parameters: { threshold },
    evaluate: () => ({ status, reasons: [{ code: `A01_${status}`, message: status }] }),
  });
}

function hypothesis(hypothesisId: string, threshold: number): ResearchHypothesisDefinition {
  const exactRule = rule(hypothesisId, threshold);
  return {
    hypothesisId,
    version: "1.0.0",
    title: `${hypothesisId} paper-evaluation trial`,
    description: "One exact fixed preregistered trial.",
    rationale: "Test governance-only eligibility without claiming alpha.",
    rule: hypothesisRuleReference(exactRule),
    assetScope: ["BTC"],
    requiredDependencies: exactRule.dependencies,
    parameterSpace: [{ name: "threshold", kind: "FIXED", value: threshold }],
    researchIntent: {
      question: "Can exact evidence enter paper-only evaluation?",
      falsificationCriterion: "No action or predictive threshold is declared.",
    },
    trainOosPolicy: {
      policyId: "A01-FIXED-OOS",
      training: { startTime: TRAIN_START, endTime: OOS_START },
      oos: { startTime: OOS_START, endTime: OOS_END },
      ordering: "TRAIN_BEFORE_OOS",
      oosReuse: "NEVER_TUNE_ON_OOS",
    },
    statefulOosBoundaryPolicy: "NOT_APPLICABLE",
    trialAccounting: {
      familyId: "A01-TRIALS",
      unit: "ONE_TRIAL_PER_RULE_PARAMETER_CONFIGURATION",
      variantHandling: "COUNT_EACH_VARIANT",
      declaredTrialCount: 1,
    },
    lifecycle: "EVALUATION_PENDING",
    preRegistration: {
      declaredBy: "A-01-test",
      sourceReference: "A-01-test-plan",
      declarationOrdinal: threshold,
    },
  };
}

function observation(
  registry: HypothesisRegistrySnapshot,
  hypothesisId: "H-BASE" | "H-VAR",
  threshold: number,
  status: ResearchRuleStatus,
  time: number
): ShadowResearchObservation {
  const exactRule = rule(hypothesisId, threshold, status);
  return runStatelessShadowObservation({
    registry,
    hypothesisId,
    hypothesisVersion: "1.0.0",
    parameterConfiguration: { threshold },
    rule: exactRule,
    context: { assetId: "BTC", decisionTime: time, asOf: time, oneHourBars: bars(time) },
    featureVector: buildResearchFeatureVector({
      assetId: "BTC",
      decisionTime: time,
      asOf: time,
      definitions: [closeFeature],
      oneHourBars: bars(time),
    }),
  });
}

function buildSetup(baseStatuses: readonly ResearchRuleStatus[] = ["MATCH", "MATCH", "MATCH"]) {
  const hypothesisRegistry = createHypothesisRegistry([
    hypothesis("H-BASE", 1),
    hypothesis("H-VAR", 2),
  ]);
  const baseObservations = GRID.map((time, index) =>
    observation(hypothesisRegistry, "H-BASE", 1, baseStatuses[index], time)
  );
  const variantObservations = GRID.map((time) =>
    observation(hypothesisRegistry, "H-VAR", 2, "MATCH", time)
  );
  const baseHeldOut = evaluateHeldOutOosEvidence({
    registry: hypothesisRegistry,
    hypothesisId: "H-BASE",
    hypothesisVersion: "1.0.0",
    observations: baseObservations,
  });
  const variantHeldOut = evaluateHeldOutOosEvidence({
    registry: hypothesisRegistry,
    hypothesisId: "H-VAR",
    hypothesisVersion: "1.0.0",
    observations: variantObservations,
  });
  const registered = (id: string) =>
    hypothesisRegistry.hypotheses.find((item) => item.hypothesisId === id)!;
  const family = defineRobustnessFamilyPreregistration(hypothesisRegistry, {
    schemaVersion: ROBUSTNESS_FAMILY_PREREGISTRATION_SCHEMA_VERSION,
    familyId: "RF-A01-BTC",
    version: "1.0.0",
    title: "A-01 BTC sensitivity",
    description: "Two exact fixed trials.",
    scientificRationale: "Require complete descriptive shared-OOS evidence without selection.",
    baselineMemberId: "baseline",
    members: [
      {
        memberId: "baseline",
        hypothesisId: "H-BASE",
        hypothesisVersion: "1.0.0",
        hypothesisSemanticIdentity: registered("H-BASE").semanticIdentity,
        perturbation: { kind: "BASELINE", axisId: "BASELINE", description: "Reference." },
      },
      {
        memberId: "variant",
        hypothesisId: "H-VAR",
        hypothesisVersion: "1.0.0",
        hypothesisSemanticIdentity: registered("H-VAR").semanticIdentity,
        perturbation: { kind: "RULE_PARAMETER", axisId: "threshold", description: "Threshold change." },
      },
    ],
    expectedMemberCount: 2,
    commonAsset: "BTC",
    commonTrainingInterval: { startTime: TRAIN_START, endTime: OOS_START },
    commonOosInterval: { startTime: OOS_START, endTime: OOS_END },
    commonStatefulOosBoundaryPolicy: "NOT_APPLICABLE",
    observationCompletenessPolicy: {
      memberRequirement: "EVERY_DECLARED_MEMBER",
      observationGridRequirement: "EXACT_EXPECTED_DECISION_TIMES",
      expectedDecisionTimes: GRID,
      missingObservationOutcome: "INSUFFICIENT_EVIDENCE",
      insufficientEvidenceTreatment: "RETAIN_AND_REPORT",
      interpretation: "DESCRIPTIVE_ONLY_NO_ROBUSTNESS_THRESHOLD",
    },
    preRegistration: { declaredBy: "A-01-test", sourceReference: "A-01-family", declarationOrdinal: 1 },
    oosReusePolicy: "PREREGISTERED_SHARED_OOS_SENSITIVITY",
    selectionPolicy: "NO_POST_OOS_VARIANT_SELECTION",
    independentConfirmation: false,
    intendedUse: "RESEARCH_ROBUSTNESS_PREREGISTRATION_ONLY",
    predictiveValidityEstablished: false,
    approvedForPaperAction: false,
    grantsExecutionAuthority: false,
    priceAuthority: "NONE",
  });
  const members: RobustnessFamilyMemberEvidenceInput[] = [
    { memberId: "baseline", observations: baseObservations },
    { memberId: "variant", observations: variantObservations },
  ];
  const evaluation = evaluateRobustnessFamily({ registry: hypothesisRegistry, family, members });
  const base: ResearchEvidenceInput = {
    hypothesisId: "H-BASE",
    hypothesisVersion: "1.0.0",
    heldOutEvidence: baseHeldOut,
    robustnessEvidence: { family, evaluation, memberId: "baseline" },
  };
  const variant: ResearchEvidenceInput = {
    hypothesisId: "H-VAR",
    hypothesisVersion: "1.0.0",
    heldOutEvidence: variantHeldOut,
    robustnessEvidence: { family, evaluation, memberId: "variant" },
  };
  const evidenceRegistry = createResearchEvidenceRegistry(hypothesisRegistry, [base, variant]);
  const noRobustnessRegistry = createResearchEvidenceRegistry(hypothesisRegistry, [{
    hypothesisId: "H-BASE",
    hypothesisVersion: "1.0.0",
    heldOutEvidence: baseHeldOut,
  }]);
  return { hypothesisRegistry, evidenceRegistry, noRobustnessRegistry, base, variant };
}

let cachedDefaultSetup: ReturnType<typeof buildSetup> | undefined;

function setup(baseStatuses?: readonly ResearchRuleStatus[]) {
  if (baseStatuses) return buildSetup(baseStatuses);
  cachedDefaultSetup ??= buildSetup();
  return cachedDefaultSetup;
}

let cachedEligibility: StrategyEligibilityRegistrySnapshot | undefined;

function create() {
  const current = setup();
  cachedEligibility ??= createStrategyEligibilityRegistry(
    current.hypothesisRegistry,
    current.evidenceRegistry
  );
  const eligibility = cachedEligibility;
  return { ...current, eligibility };
}

describe("M14 A-01 StrategyEligibility", () => {
  it("creates a deterministic eligibility identity", () => {
    const current = setup();
    const first = createStrategyEligibilityRegistry(current.hypothesisRegistry, current.evidenceRegistry);
    const second = createStrategyEligibilityRegistry(current.hypothesisRegistry, current.evidenceRegistry);
    expect(first.semanticIdentity).toBe(second.semanticIdentity);
  });

  it("serializes deterministically independent of source input order", () => {
    const current = setup();
    const reversed = createResearchEvidenceRegistry(
      current.hypothesisRegistry,
      [current.variant, current.base]
    );
    const first = createStrategyEligibilityRegistry(current.hypothesisRegistry, current.evidenceRegistry);
    const second = createStrategyEligibilityRegistry(current.hypothesisRegistry, reversed);
    expect(serializeStrategyEligibilityRegistry(current.hypothesisRegistry, current.evidenceRegistry, first))
      .toBe(serializeStrategyEligibilityRegistry(current.hypothesisRegistry, reversed, second));
  }, 15_000);

  it("binds the exact source registry and evidence identities", () => {
    const current = create();
    expect(current.eligibility.sourceEvidenceRegistrySemanticIdentity)
      .toBe(current.evidenceRegistry.semanticIdentity);
    expect(current.eligibility.records.map((record) => record.evidenceSemanticIdentity).sort())
      .toEqual(current.evidenceRegistry.entries.map((entry) => entry.semanticIdentity).sort());
  });

  it("binds exact hypothesis, rule, parameter, trial, asset, interval, state, D-A, and D-B evidence", () => {
    const current = create();
    const source = current.evidenceRegistry.entries.find((entry) => entry.hypothesisId === "H-BASE")!;
    const record = current.eligibility.records.find((entry) => entry.hypothesisId === "H-BASE")!;
    expect(record).toMatchObject({
      hypothesisSemanticIdentity: source.hypothesisSemanticIdentity,
      ruleSemanticIdentity: source.ruleSemanticIdentity,
      parameterConfigurationIdentity: source.parameterConfigurationIdentity,
      trialAccountingIdentity: source.trialAccountingIdentity,
      assetId: source.assetId,
      trainingInterval: source.trainingInterval,
      oosInterval: source.oosInterval,
      statefulOosBoundaryPolicy: source.statefulOosBoundaryPolicy,
      heldOutEvidenceSemanticIdentity: source.heldOutEvidenceSemanticIdentity,
      robustnessEvidence: source.robustnessEvidence,
    });
  });

  it("admits a complete CANDIDATE only for paper evaluation", () => {
    const records = create().eligibility.records;
    expect(records.every((record) =>
      record.eligibilityStatus === "ELIGIBLE_FOR_PAPER_EVALUATION"
        && record.eligibleForPaperEvaluation)).toBe(true);
  });

  it("keeps CANDIDATE evidence without required D-B evidence ineligible", () => {
    const current = setup();
    const result = createStrategyEligibilityRegistry(
      current.hypothesisRegistry,
      current.noRobustnessRegistry
    );
    expect(result.records[0]).toMatchObject({
      evidenceStatus: "CANDIDATE",
      eligibilityStatus: "INELIGIBLE_REQUIRED_SHARED_OOS_EVIDENCE_ABSENT",
      eligibleForPaperEvaluation: false,
    });
  });

  it("maps insufficient evidence to fail-closed ineligibility", () => {
    const current = setup(["INSUFFICIENT_EVIDENCE", "MATCH", "MATCH"]);
    const result = createStrategyEligibilityRegistry(current.hypothesisRegistry, current.evidenceRegistry);
    const base = result.records.find((record) => record.hypothesisId === "H-BASE")!;
    expect(base).toMatchObject({
      evidenceStatus: "INSUFFICIENT_EVIDENCE",
      eligibilityStatus: "INELIGIBLE_INSUFFICIENT_EVIDENCE",
      eligibleForPaperEvaluation: false,
    });
  });

  it("rejects an unsupported evidence status", () => {
    const current = setup();
    const forged = reidentifyEvidenceRegistry(current.evidenceRegistry, (entry) => {
      entry.status = "APPROVED_FOR_PAPER";
    });
    expect(() => createStrategyEligibilityRegistry(current.hypothesisRegistry, forged))
      .toThrow(/classification|status/i);
  });

  it("rejects a forged registry identity", () => {
    const current = setup();
    const forged = clone(current.evidenceRegistry) as unknown as Record<string, any>;
    forged.semanticIdentity = "forged";
    expect(() => createStrategyEligibilityRegistry(
      current.hypothesisRegistry,
      forged as unknown as ResearchEvidenceRegistrySnapshot
    )).toThrow(/semantic identity/i);
  });

  it("rejects a forged evidence identity", () => {
    const current = setup();
    const forged = clone(current.evidenceRegistry) as unknown as Record<string, any>;
    forged.entries[0].semanticIdentity = "forged";
    expect(() => createStrategyEligibilityRegistry(
      current.hypothesisRegistry,
      forged as unknown as ResearchEvidenceRegistrySnapshot
    )).toThrow(/semantic identity/i);
  });

  it("rejects a recomputed forged hypothesis binding", () => {
    const current = setup();
    const forged = reidentifyEvidenceRegistry(current.evidenceRegistry, (entry) => {
      entry.hypothesisSemanticIdentity = "forged-hypothesis";
    });
    expect(() => createStrategyEligibilityRegistry(current.hypothesisRegistry, forged))
      .toThrow(/canonical hypothesis|binding/i);
  });

  it("rejects a recomputed forged rule binding", () => {
    const current = setup();
    const forged = reidentifyEvidenceRegistry(current.evidenceRegistry, (entry) => {
      entry.ruleSemanticIdentity = "forged-rule";
    });
    expect(() => createStrategyEligibilityRegistry(current.hypothesisRegistry, forged))
      .toThrow(/canonical hypothesis|rule|binding/i);
  });

  it("rejects a recomputed forged parameter binding", () => {
    const current = setup();
    const hypothesisIdentity = current.hypothesisRegistry.hypotheses
      .find((item) => item.hypothesisId === "H-BASE")!.semanticIdentity;
    const forged = reidentifyEvidenceRegistry(current.evidenceRegistry, (entry) => {
      entry.parameterConfigurationIdentity = canonicalJson({
        hypothesisSemanticIdentity: hypothesisIdentity,
        parameters: { threshold: 999 },
      });
    });
    expect(() => createStrategyEligibilityRegistry(current.hypothesisRegistry, forged))
      .toThrow(/preregistered|parameter/i);
  });

  it("rejects a recomputed forged trial binding", () => {
    const current = setup();
    const forged = reidentifyEvidenceRegistry(current.evidenceRegistry, (entry) => {
      entry.trialAccountingIdentity = "forged-trial";
    });
    expect(() => createStrategyEligibilityRegistry(current.hypothesisRegistry, forged))
      .toThrow(/canonical hypothesis|trial|binding/i);
  });

  it("rejects a recomputed forged asset binding", () => {
    const current = setup();
    const forged = reidentifyEvidenceRegistry(current.evidenceRegistry, (entry) => {
      entry.assetId = "PAXG";
    });
    expect(() => createStrategyEligibilityRegistry(current.hypothesisRegistry, forged))
      .toThrow(/canonical hypothesis|asset|binding/i);
  });

  it("rejects a recomputed forged TRAIN/OOS binding", () => {
    const current = setup();
    const forged = reidentifyEvidenceRegistry(current.evidenceRegistry, (entry) => {
      entry.oosInterval.endTime += HOUR;
    });
    expect(() => createStrategyEligibilityRegistry(current.hypothesisRegistry, forged))
      .toThrow(/interval|binding/i);
  });

  it("rejects a recomputed forged state-policy binding", () => {
    const current = setup();
    const forged = reidentifyEvidenceRegistry(current.evidenceRegistry, (entry) => {
      entry.statefulOosBoundaryPolicy = "RESET_AT_OOS_START";
    });
    expect(() => createStrategyEligibilityRegistry(current.hypothesisRegistry, forged))
      .toThrow(/state-policy|binding/i);
  });

  it("rejects contradictory D-B shared-OOS semantics", () => {
    const current = setup();
    const forged = reidentifyEvidenceRegistry(current.evidenceRegistry, (entry) => {
      entry.robustnessEvidence.independentConfirmation = true;
    });
    expect(() => createStrategyEligibilityRegistry(current.hypothesisRegistry, forged))
      .toThrow(/shared-OOS|descriptive/i);
  });

  it("preserves D-B as non-independent and non-selecting", () => {
    const bindings = create().eligibility.records.map((record) => record.robustnessEvidence!);
    expect(bindings.every((binding) =>
      binding.independentConfirmation === false
        && binding.selectionPolicy === "NO_POST_OOS_VARIANT_SELECTION")).toBe(true);
  });

  it("does not establish predictive validity", () => {
    const registry = create().eligibility;
    expect(registry.predictiveValidityEstablished).toBe(false);
    expect(registry.records.every((record) => record.predictiveValidityEstablished === false)).toBe(true);
  });

  it("does not approve paper action", () => {
    const registry = create().eligibility;
    expect(registry.approvedForPaperAction).toBe(false);
    expect(registry.records.every((record) => record.approvedForPaperAction === false)).toBe(true);
  });

  it("grants no Permission, Risk, allocation, execution, accounting, or price authority", () => {
    const registry = create().eligibility;
    expect(registry).toMatchObject({
      grantsPermissionAuthority: false,
      grantsRiskAuthority: false,
      grantsAllocationAuthority: false,
      grantsExecutionAuthority: false,
      grantsAccountingAuthority: false,
      priceAuthority: "NONE",
    });
  });

  it("contains no target weight, sizing, ranking, score, or winner fields", () => {
    const serialized = JSON.stringify(create().eligibility).toLowerCase();
    for (const forbidden of ["targetweight", "position_size", "sizing", "ranking", "score", "winner"]) {
      expect(serialized).not.toContain(`\"${forbidden}\"`);
    }
  });

  it("does not emit ActionDecision, signals, orders, or execution records", () => {
    const serialized = JSON.stringify(create().eligibility);
    for (const forbidden of ["ActionDecision", "SignalOutput", "OrderIntent", "ExecutionRecord"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("uses a fixed identity-bearing non-performance policy", () => {
    expect(CURRENT_STRATEGY_ELIGIBILITY_POLICY).toMatchObject({
      requiredEvidenceStatus: "CANDIDATE",
      requiresCompleteSharedOosSensitivityEvidence: true,
      performanceThreshold: "NONE",
      predictiveValidityRequired: false,
      selectionPolicy: "NO_POST_OOS_VARIANT_SELECTION",
    });
    expect(CURRENT_STRATEGY_ELIGIBILITY_POLICY.semanticIdentity.length).toBeGreaterThan(0);
  });

  it("retains every source evidence entry instead of selecting or dropping records", () => {
    const current = create();
    expect(current.eligibility.records).toHaveLength(current.evidenceRegistry.entries.length);
  });

  it("does not mutate or freeze caller-owned wrappers", () => {
    const current = setup();
    const wrapper = { registry: current.evidenceRegistry };
    const before = JSON.stringify(wrapper);
    createStrategyEligibilityRegistry(current.hypothesisRegistry, wrapper.registry);
    expect(JSON.stringify(wrapper)).toBe(before);
    expect(Object.isFrozen(wrapper)).toBe(false);
  });

  it("returns a deeply immutable eligibility registry", () => {
    const registry = create().eligibility;
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.records)).toBe(true);
    expect(Object.isFrozen(registry.records[0])).toBe(true);
    expect(Object.isFrozen(registry.records[0].reasons)).toBe(true);
  });

  it("rejects duplicated or conflicting eligibility records", () => {
    const current = create();
    const forged = reidentifyEligibilityRegistry(current.eligibility, (draft) => {
      draft.records.push(clone(draft.records[0]));
    });
    expect(() => validateStrategyEligibilityRegistry(
      current.hypothesisRegistry,
      current.evidenceRegistry,
      forged
    )).toThrow(/forged|duplicated|conflicts/i);
  });

  it("rejects a forged output identity", () => {
    const current = create();
    const forged = clone(current.eligibility) as unknown as Record<string, any>;
    forged.records[0].eligibleForPaperEvaluation = false;
    expect(() => validateStrategyEligibilityRegistry(
      current.hypothesisRegistry,
      current.evidenceRegistry,
      forged as unknown as StrategyEligibilityRegistrySnapshot
    )).toThrow(/forged|stale|conflicts/i);
  });
});
