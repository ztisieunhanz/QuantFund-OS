import { describe, expect, it } from "vitest";
import {
  createHypothesisRegistry,
  hypothesisRuleReference,
  type ResearchHypothesisDefinition,
  type StatefulOosBoundaryPolicy,
} from "../hypothesisRegistry";
import { buildResearchFeatureVector, type ResearchFeatureDefinition } from "../researchFeatureBuilder";
import { createResearchRule, type ResearchRule, type ResearchRuleStatus } from "../researchRules";
import {
  ROBUSTNESS_FAMILY_PREREGISTRATION_SCHEMA_VERSION,
  defineRobustnessFamilyPreregistration,
  type RobustnessFamilyPreregistration,
} from "../robustnessFamilyPreregistration";
import {
  evaluateRobustnessFamily,
  serializeRobustnessFamilyEvaluation,
  validateRobustnessFamilyEvaluation,
  type RobustnessFamilyEvaluation,
  type RobustnessFamilyEvaluationInput,
  type RobustnessFamilyMemberEvidenceInput,
} from "../robustnessFamilyEvaluation";
import {
  runStatefulShadowObservation,
  runStatelessShadowObservation,
  type ShadowResearchObservation,
  type StatefulShadowResearchObservation,
} from "../shadowResearchHarness";
import {
  createPersistenceRule,
  type PersistenceState,
  type StatefulResearchRule,
} from "../statefulResearchRules";
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

function bars(time: number): PointInTimeBar[] {
  return [{ timestamp: time - HOUR, open: 100, high: 102, low: 99, close: 101, volume: 10 }];
}

function rule(hypothesisId: string, threshold: number, status: ResearchRuleStatus = "MATCH"): ResearchRule {
  return createResearchRule({
    ruleId: `${hypothesisId}-RULE`,
    version: "1.0.0",
    description: "Exact fixed robustness trial",
    rationale: "Exercise descriptive shared-OOS sensitivity.",
    dependencies: [{ kind: "TIMEFRAME", timeframe: "1H" }],
    parameters: { threshold },
    evaluate: () => ({ status, reasons: [{ code: `TEST_${status}`, message: status }] }),
  });
}

function hypothesis(hypothesisId: string, threshold: number): ResearchHypothesisDefinition {
  const exactRule = rule(hypothesisId, threshold);
  return {
    hypothesisId,
    version: "1.0.0",
    title: `${hypothesisId} trial`,
    description: "One exact fixed trial.",
    rationale: "Declared before shared-OOS inspection.",
    rule: hypothesisRuleReference(exactRule),
    assetScope: ["BTC"],
    requiredDependencies: exactRule.dependencies,
    parameterSpace: [{ name: "threshold", kind: "FIXED", value: threshold }],
    researchIntent: {
      question: "Does categorical evidence persist under perturbation?",
      falsificationCriterion: "Retain all negative and insufficient evidence.",
    },
    trainOosPolicy: {
      policyId: "DB-COMMON-OOS",
      training: { startTime: TRAIN_START, endTime: OOS_START },
      oos: { startTime: OOS_START, endTime: OOS_END },
      ordering: "TRAIN_BEFORE_OOS",
      oosReuse: "NEVER_TUNE_ON_OOS",
    },
    statefulOosBoundaryPolicy: "NOT_APPLICABLE",
    trialAccounting: {
      familyId: "DB-EXACT-TRIALS",
      unit: "ONE_TRIAL_PER_RULE_PARAMETER_CONFIGURATION",
      variantHandling: "COUNT_EACH_VARIANT",
      declaredTrialCount: 1,
    },
    lifecycle: "PREREGISTERED",
    preRegistration: {
      declaredBy: "D-B-test",
      sourceReference: "D-B-test-plan",
      declarationOrdinal: threshold,
    },
  };
}

function setup() {
  const registry = createHypothesisRegistry([hypothesis("H-BASE", 1), hypothesis("H-VAR", 2)]);
  const registered = (id: string) => registry.hypotheses.find((item) => item.hypothesisId === id)!;
  const family = defineRobustnessFamilyPreregistration(registry, {
    schemaVersion: ROBUSTNESS_FAMILY_PREREGISTRATION_SCHEMA_VERSION,
    familyId: "RF-BTC",
    version: "1.0.0",
    title: "BTC sensitivity",
    description: "Two exact fixed trials.",
    scientificRationale: "Describe categorical sensitivity without selection.",
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
    preRegistration: { declaredBy: "D-B-test", sourceReference: "D-B-plan", declarationOrdinal: 1 },
    oosReusePolicy: "PREREGISTERED_SHARED_OOS_SENSITIVITY",
    selectionPolicy: "NO_POST_OOS_VARIANT_SELECTION",
    independentConfirmation: false,
    intendedUse: "RESEARCH_ROBUSTNESS_PREREGISTRATION_ONLY",
    predictiveValidityEstablished: false,
    approvedForPaperAction: false,
    grantsExecutionAuthority: false,
    priceAuthority: "NONE",
  });
  const observation = (id: "H-BASE" | "H-VAR", threshold: number, status: ResearchRuleStatus, time: number) =>
    runStatelessShadowObservation({
      registry,
      hypothesisId: id,
      hypothesisVersion: "1.0.0",
      parameterConfiguration: { threshold },
      rule: rule(id, threshold, status),
      context: { assetId: "BTC", decisionTime: time, asOf: time, oneHourBars: bars(time) },
      featureVector: buildResearchFeatureVector({
        assetId: "BTC", decisionTime: time, asOf: time, definitions: [closeFeature], oneHourBars: bars(time),
      }),
    });
  const inputs = (): RobustnessFamilyMemberEvidenceInput[] => ([
    { memberId: "baseline", observations: [observation("H-BASE", 1, "MATCH", GRID[0]), observation("H-BASE", 1, "NO_MATCH", GRID[1]), observation("H-BASE", 1, "MATCH", GRID[2])] },
    { memberId: "variant", observations: [observation("H-VAR", 2, "MATCH", GRID[0]), observation("H-VAR", 2, "INSUFFICIENT_EVIDENCE", GRID[1]), observation("H-VAR", 2, "NO_MATCH", GRID[2])] },
  ]);
  return { registry, family, observation, inputs };
}

function evaluate(overrides: Partial<RobustnessFamilyEvaluationInput> = {}) {
  const base = setup();
  return evaluateRobustnessFamily({ registry: base.registry, family: base.family, members: base.inputs(), ...overrides });
}

function persistenceRule(
  hypothesisId: string,
  threshold: number,
  status: ResearchRuleStatus = "MATCH"
): StatefulResearchRule<PersistenceState> {
  return createPersistenceRule({
    ruleId: `${hypothesisId}-PERSISTENCE`,
    version: "1.0.0",
    description: "Stateful D-B lineage trial",
    rationale: "Exercise exact preregistered state transitions.",
    condition: rule(hypothesisId, threshold, status),
    requiredConsecutive: 2,
  });
}

function statefulHypothesis(
  hypothesisId: string,
  threshold: number,
  policy: Exclude<StatefulOosBoundaryPolicy, "NOT_APPLICABLE">
): ResearchHypothesisDefinition {
  const exactRule = persistenceRule(hypothesisId, threshold);
  return {
    ...hypothesis(hypothesisId, threshold),
    rule: hypothesisRuleReference(exactRule),
    requiredDependencies: exactRule.dependencies,
    parameterSpace: [{ name: "requiredConsecutive", kind: "FIXED", value: 2 }],
    statefulOosBoundaryPolicy: policy,
  };
}

function statefulSetup(policy: Exclude<StatefulOosBoundaryPolicy, "NOT_APPLICABLE">) {
  const registry = createHypothesisRegistry([
    statefulHypothesis("H-S-BASE", 1, policy),
    statefulHypothesis("H-S-VAR", 2, policy),
  ]);
  const registered = (id: string) => registry.hypotheses.find((item) => item.hypothesisId === id)!;
  const family = defineRobustnessFamilyPreregistration(registry, {
    schemaVersion: ROBUSTNESS_FAMILY_PREREGISTRATION_SCHEMA_VERSION,
    familyId: `RF-STATEFUL-${policy}`,
    version: "1.0.0",
    title: "Stateful lineage sensitivity",
    description: "Stateful exact fixed trials.",
    scientificRationale: "Require every preregistered transition for lineage.",
    baselineMemberId: "baseline",
    members: [
      {
        memberId: "baseline", hypothesisId: "H-S-BASE", hypothesisVersion: "1.0.0",
        hypothesisSemanticIdentity: registered("H-S-BASE").semanticIdentity,
        perturbation: { kind: "BASELINE", axisId: "BASELINE", description: "Reference." },
      },
      {
        memberId: "variant", hypothesisId: "H-S-VAR", hypothesisVersion: "1.0.0",
        hypothesisSemanticIdentity: registered("H-S-VAR").semanticIdentity,
        perturbation: { kind: "RULE_PARAMETER", axisId: "threshold", description: "Threshold change." },
      },
    ],
    expectedMemberCount: 2,
    commonAsset: "BTC",
    commonTrainingInterval: { startTime: TRAIN_START, endTime: OOS_START },
    commonOosInterval: { startTime: OOS_START, endTime: OOS_END },
    commonStatefulOosBoundaryPolicy: policy,
    observationCompletenessPolicy: {
      memberRequirement: "EVERY_DECLARED_MEMBER",
      observationGridRequirement: "EXACT_EXPECTED_DECISION_TIMES",
      expectedDecisionTimes: GRID,
      missingObservationOutcome: "INSUFFICIENT_EVIDENCE",
      insufficientEvidenceTreatment: "RETAIN_AND_REPORT",
      interpretation: "DESCRIPTIVE_ONLY_NO_ROBUSTNESS_THRESHOLD",
    },
    preRegistration: { declaredBy: "D-B-R2-test", sourceReference: "stateful-grid-plan", declarationOrdinal: 1 },
    oosReusePolicy: "PREREGISTERED_SHARED_OOS_SENSITIVITY",
    selectionPolicy: "NO_POST_OOS_VARIANT_SELECTION",
    independentConfirmation: false,
    intendedUse: "RESEARCH_ROBUSTNESS_PREREGISTRATION_ONLY",
    predictiveValidityEstablished: false,
    approvedForPaperAction: false,
    grantsExecutionAuthority: false,
    priceAuthority: "NONE",
  });

  const evidence = (
    hypothesisId: "H-S-BASE" | "H-S-VAR",
    threshold: number,
    times: readonly number[]
  ): RobustnessFamilyMemberEvidenceInput => {
    const activeRule = persistenceRule(hypothesisId, threshold);
    let prior = activeRule.createInitialState("BTC");
    const witnesses: StatefulShadowResearchObservation<PersistenceState>[] = [];
    if (policy === "CARRY_PIT_STATE_FROM_PRE_OOS") {
      const witnessTime = OOS_START - HOUR;
      const witness = runStatefulShadowObservation({
        registry,
        hypothesisId,
        hypothesisVersion: "1.0.0",
        parameterConfiguration: { requiredConsecutive: 2 },
        rule: activeRule,
        priorState: prior,
        context: { assetId: "BTC", decisionTime: witnessTime, asOf: witnessTime, oneHourBars: bars(witnessTime) },
        featureVector: buildResearchFeatureVector({
          assetId: "BTC", decisionTime: witnessTime, asOf: witnessTime,
          definitions: [closeFeature], oneHourBars: bars(witnessTime),
        }),
      });
      witnesses.push(witness);
      prior = witness.stateTransition.nextState;
    }
    const observations: StatefulShadowResearchObservation<PersistenceState>[] = [];
    for (const time of times) {
      const observation = runStatefulShadowObservation({
        registry,
        hypothesisId,
        hypothesisVersion: "1.0.0",
        parameterConfiguration: { requiredConsecutive: 2 },
        rule: activeRule,
        priorState: prior,
        context: { assetId: "BTC", decisionTime: time, asOf: time, oneHourBars: bars(time) },
        featureVector: buildResearchFeatureVector({
          assetId: "BTC", decisionTime: time, asOf: time, definitions: [closeFeature], oneHourBars: bars(time),
        }),
      });
      observations.push(observation);
      prior = observation.stateTransition.nextState;
    }
    return {
      memberId: hypothesisId === "H-S-BASE" ? "baseline" : "variant",
      observations,
      preOosTransitionWitnesses: witnesses,
    };
  };
  const members = (times: readonly number[]) => [
    evidence("H-S-BASE", 1, times),
    evidence("H-S-VAR", 2, times),
  ];
  return { registry, family, members };
}

describe("M13D D-B preregistered shared-OOS descriptive evaluation", () => {
  it("evaluates a valid complete family with categorical member counts", () => {
    const result = evaluate();
    expect(result.familyCompleteness).toBe("COMPLETE");
    expect(result.members.map((item) => item.counts)).toEqual([
      expect.objectContaining({ totalExpected: 3, match: 2, noMatch: 1, insufficientEvidence: 0, evaluable: 3 }),
      expect.objectContaining({ totalExpected: 3, match: 1, noMatch: 1, insufficientEvidence: 1, evaluable: 2 }),
    ]);
  });

  it("has deterministic identity and serialization", () => {
    const { registry, family } = setup();
    const left = evaluateRobustnessFamily({ registry, family, members: setup().inputs() });
    const right = evaluateRobustnessFamily({ registry, family, members: setup().inputs() });
    expect(right.semanticIdentity).toBe(left.semanticIdentity);
    expect(serializeRobustnessFamilyEvaluation(registry, family, right))
      .toBe(serializeRobustnessFamilyEvaluation(registry, family, left));
  });

  it("is independent of supplied member order", () => {
    const base = setup();
    const left = evaluateRobustnessFamily({ registry: base.registry, family: base.family, members: base.inputs() });
    const right = evaluateRobustnessFamily({ registry: base.registry, family: base.family, members: base.inputs().reverse() });
    expect(right.semanticIdentity).toBe(left.semanticIdentity);
  });

  it("binds exactly one declared baseline and every exact trial", () => {
    const result = evaluate();
    expect(result.baselineMemberId).toBe("baseline");
    expect(result.members.filter((item) => item.isBaseline)).toHaveLength(1);
    expect(result.members[0].trialIdentity).toBe(result.baselineMemberIdentity);
  });

  it("rejects a missing declared member", () => {
    const base = setup();
    expect(() => evaluateRobustnessFamily({ registry: base.registry, family: base.family, members: [base.inputs()[0]] }))
      .toThrow(/every declared family member/);
  });

  it("rejects an extra undeclared or duplicate member", () => {
    const base = setup();
    expect(() => evaluateRobustnessFamily({ registry: base.registry, family: base.family, members: [...base.inputs(), { memberId: "extra", observations: [] }] }))
      .toThrow(/undeclared/);
    expect(() => evaluateRobustnessFamily({ registry: base.registry, family: base.family, members: [...base.inputs(), base.inputs()[0]] }))
      .toThrow(/duplicate/);
  });

  it("rejects a stale trial or family identity", () => {
    const base = setup();
    const forged = { ...base.family, members: [{ ...base.family.members[0], trialIdentity: "stale" }, base.family.members[1]] } as RobustnessFamilyPreregistration;
    expect(() => evaluateRobustnessFamily({ registry: base.registry, family: forged, members: base.inputs() })).toThrow(/forged or stale/);
  });

  it.each([
    ["asset", (family: RobustnessFamilyPreregistration) => ({ ...family, commonAsset: "PAXG" })],
    ["TRAIN", (family: RobustnessFamilyPreregistration) => ({ ...family, commonTrainingInterval: { ...family.commonTrainingInterval, startTime: TRAIN_START + HOUR } })],
    ["OOS", (family: RobustnessFamilyPreregistration) => ({ ...family, commonOosInterval: { ...family.commonOosInterval, endTime: OOS_END - HOUR } })],
    ["policy", (family: RobustnessFamilyPreregistration) => ({ ...family, commonStatefulOosBoundaryPolicy: "RESET_AT_OOS_START" })],
  ] as const)("rejects forged mixed %s family evidence", (_label, forge) => {
    const base = setup();
    expect(() => evaluateRobustnessFamily({ registry: base.registry, family: forge(base.family) as RobustnessFamilyPreregistration, members: base.inputs() })).toThrow();
  });

  it("enforces the exact expected grid", () => {
    const result = evaluate();
    expect(result.expectedDecisionTimes).toEqual(GRID);
    expect(result.members.every((item) => item.observedDecisionTimes.join() === GRID.join())).toBe(true);
  });

  it("turns missing expected evidence into explicit insufficient evidence without fabrication", () => {
    const base = setup();
    const members = base.inputs();
    members[1] = { ...members[1], observations: members[1].observations.slice(0, 2) };
    const result = evaluateRobustnessFamily({ registry: base.registry, family: base.family, members });
    expect(result.familyCompleteness).toBe("INCOMPLETE_MISSING_EXPECTED_EVIDENCE");
    expect(result.members[1]).toMatchObject({
      missingExpectedDecisionTimes: [GRID[2]],
      counts: { observed: 2, missingExpected: 1, insufficientEvidence: 2, totalExpected: 3 },
    });
  });

  it("supports a member with an entirely missing grid as explicit insufficient evidence", () => {
    const base = setup();
    const members = base.inputs();
    members[1] = { memberId: "variant", observations: [] };
    const result = evaluateRobustnessFamily({ registry: base.registry, family: base.family, members });
    expect(result.members[1].counts).toMatchObject({ observed: 0, missingExpected: 3, insufficientEvidence: 3, evaluable: 0 });
    expect(result.members[1].heldOutSummarySemanticIdentity).toBeNull();
  });

  it.each(["RESET_AT_OOS_START", "CARRY_PIT_STATE_FROM_PRE_OOS"] as const)(
    "accepts a complete stateful %s grid with proven lineage",
    (policy) => {
      const base = statefulSetup(policy);
      const result = evaluateRobustnessFamily({
        registry: base.registry, family: base.family, members: base.members(GRID),
      });
      expect(result.familyCompleteness).toBe("COMPLETE");
      expect(result.members.every((member) =>
        member.lineageUnprovenDecisionTimes.length === 0
          && member.counts.evaluable === GRID.length
          && member.counts.insufficientEvidence === 0)).toBe(true);
    }
  );

  it.each(["RESET_AT_OOS_START", "CARRY_PIT_STATE_FROM_PRE_OOS"] as const)(
    "marks later %s evidence lineage-unproven when the first expected point is missing",
    (policy) => {
      const base = statefulSetup(policy);
      const result = evaluateRobustnessFamily({
        registry: base.registry, family: base.family, members: base.members([GRID[1], GRID[2]]),
      });
      expect(result.members[0]).toMatchObject({
        missingExpectedDecisionTimes: [GRID[0]],
        lineageUnprovenDecisionTimes: [GRID[1], GRID[2]],
        counts: { evaluable: 0, missingExpected: 1, lineageUnprovenObserved: 2, insufficientEvidence: 3 },
      });
    }
  );

  it("does not silently bridge state across a missing internal expected transition", () => {
    const base = statefulSetup("RESET_AT_OOS_START");
    const result = evaluateRobustnessFamily({
      registry: base.registry, family: base.family, members: base.members([GRID[0], GRID[2]]),
    });
    expect(result.members[0]).toMatchObject({
      observedDecisionTimes: [GRID[0], GRID[2]],
      missingExpectedDecisionTimes: [GRID[1]],
      lineageUnprovenDecisionTimes: [GRID[2]],
      counts: { observed: 2, evaluable: 1, missingExpected: 1, lineageUnprovenObserved: 1, insufficientEvidence: 2 },
    });
  });

  it("preserves the proven stateful prefix when only the final point is missing", () => {
    const base = statefulSetup("CARRY_PIT_STATE_FROM_PRE_OOS");
    const result = evaluateRobustnessFamily({
      registry: base.registry, family: base.family, members: base.members([GRID[0], GRID[1]]),
    });
    expect(result.members[0]).toMatchObject({
      missingExpectedDecisionTimes: [GRID[2]],
      lineageUnprovenDecisionTimes: [],
      counts: { evaluable: 2, missingExpected: 1, lineageUnprovenObserved: 0, insufficientEvidence: 1 },
    });
  });

  it("keeps later stateless observations independently evaluable across a missing internal point", () => {
    const base = setup();
    const members = base.inputs();
    members[0] = { ...members[0], observations: [members[0].observations[0], members[0].observations[2]] };
    const result = evaluateRobustnessFamily({ registry: base.registry, family: base.family, members });
    expect(result.members[0]).toMatchObject({
      missingExpectedDecisionTimes: [GRID[1]],
      lineageUnprovenDecisionTimes: [],
      counts: { evaluable: 2, missingExpected: 1, lineageUnprovenObserved: 0, insufficientEvidence: 1 },
    });
  });

  it("rejects duplicate timestamps", () => {
    const base = setup();
    const members = base.inputs();
    members[0] = { ...members[0], observations: [members[0].observations[0], members[0].observations[0]] };
    expect(() => evaluateRobustnessFamily({ registry: base.registry, family: base.family, members })).toThrow(/duplicate decisionTime/);
  });

  it.each([OOS_START + 3 * HOUR, OOS_END])("rejects unexpected or outside-OOS timestamp %s", (time) => {
    const base = setup();
    const members = base.inputs();
    members[0] = { ...members[0], observations: [base.observation("H-BASE", 1, "MATCH", time)] };
    expect(() => evaluateRobustnessFamily({ registry: base.registry, family: base.family, members })).toThrow(/unexpected or outside-OOS/);
  });

  it("rejects contaminated or mixed observation identity", () => {
    const base = setup();
    const members = base.inputs();
    const forged = { ...members[0].observations[0], binding: { ...members[0].observations[0].binding, trialAccountingIdentity: "forged" } } as ShadowResearchObservation;
    members[0] = { ...members[0], observations: [forged, members[0].observations[1]] };
    expect(() => evaluateRobustnessFamily({ registry: base.registry, family: base.family, members })).toThrow();
  });

  it("retains observed insufficient evidence", () => {
    expect(evaluate().members[1].counts).toMatchObject({ insufficientEvidenceObserved: 1, insufficientEvidence: 1 });
  });

  it("preserves shared-OOS, no-selection, and non-confirmation semantics", () => {
    expect(evaluate()).toMatchObject({
      oosReusePolicy: "PREREGISTERED_SHARED_OOS_SENSITIVITY",
      selectionPolicy: "NO_POST_OOS_VARIANT_SELECTION",
      independentConfirmation: false,
    });
  });

  it("contains no threshold, robustness conclusion, ranking, selection result, or economic metric", () => {
    const text = JSON.stringify(evaluate()).toLowerCase();
    for (const prohibited of ["robust\"", "not_robust", "winner", "loser", "selectedparameter", "return\"", "pnl", "sharpe", "drawdown", "winrate", "profitability", "targetweight", "buy", "sell"]) {
      expect(text).not.toContain(prohibited);
    }
    expect(evaluate().interpretation).toBe("DESCRIPTIVE_ONLY_NO_ROBUSTNESS_THRESHOLD");
  });

  it("cannot escalate predictive, paper-action, execution, or price authority", () => {
    expect(evaluate()).toMatchObject({
      predictiveValidityEstablished: false,
      approvedForPaperAction: false,
      grantsExecutionAuthority: false,
      priceAuthority: "NONE",
    });
  });

  it("does not mutate inputs and deep-freezes output", () => {
    const base = setup();
    const members = base.inputs();
    const before = JSON.stringify({ family: base.family, members });
    const result = evaluateRobustnessFamily({ registry: base.registry, family: base.family, members });
    expect(JSON.stringify({ family: base.family, members })).toBe(before);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.members[0].counts)).toBe(true);
  });

  it.each([
    ["identity", (item: RobustnessFamilyEvaluation) => ({ ...item, semanticIdentity: "forged" })],
    ["authority", (item: RobustnessFamilyEvaluation) => ({ ...item, grantsExecutionAuthority: true })],
    ["selection", (item: RobustnessFamilyEvaluation) => ({ ...item, selectionPolicy: "SELECT_WINNER" })],
    ["member result", (item: RobustnessFamilyEvaluation) => ({ ...item, members: [{ ...item.members[0], counts: { ...item.members[0].counts, match: 99 } }, ...item.members.slice(1)] })],
  ] as const)("rejects forged or stale %s output", (_label, forge) => {
    const base = setup();
    const result = evaluateRobustnessFamily({ registry: base.registry, family: base.family, members: base.inputs() });
    expect(() => validateRobustnessFamilyEvaluation(base.registry, base.family, forge(result) as RobustnessFamilyEvaluation)).toThrow();
  });
});
