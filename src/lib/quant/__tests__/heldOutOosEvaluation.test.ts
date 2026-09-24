import { describe, expect, it } from "vitest";
import {
  evaluateHeldOutOosEvidence,
  type HeldOutOosEvaluationInput,
} from "../heldOutOosEvaluation";
import {
  createHypothesisRegistry,
  hypothesisRuleReference,
  type HypothesisRegistrySnapshot,
  type ResearchHypothesisDefinition,
  type StatefulOosBoundaryPolicy,
} from "../hypothesisRegistry";
import { buildResearchFeatureVector, type ResearchFeatureDefinition } from "../researchFeatureBuilder";
import {
  createResearchRule,
  type ResearchEvaluationContext,
  type ResearchRule,
  type ResearchRuleStatus,
} from "../researchRules";
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
import type { AssetId, PointInTimeBar } from "../types";

const HOUR = BAR_DURATION_MS;
const START = Date.UTC(2024, 0, 1);
const OOS_START = START + 10 * HOUR;
const OOS_END = START + 20 * HOUR;
const HYPOTHESIS_ID = "H-D-A";
const HYPOTHESIS_VERSION = "1.0.0";

const closeFeature: ResearchFeatureDefinition = {
  featureId: "BTC_1H_CLOSE",
  version: "1.0.0",
  description: "Canonical close evidence",
  dependency: { kind: "TIMEFRAME", timeframe: "1H" },
  transformation: { kind: "BAR_CLOSE", lag: 0 },
};

function bars(decisionTime: number): PointInTimeBar[] {
  return [2, 1].map((hoursAgo, index) => ({
    timestamp: decisionTime - hoursAgo * HOUR,
    open: 100 + index,
    high: 102 + index,
    low: 99 + index,
    close: 101 + index,
    volume: 10 + index,
  }));
}

function context(decisionTime: number, assetId: AssetId = "BTC"): ResearchEvaluationContext {
  return { assetId, decisionTime, asOf: decisionTime, oneHourBars: bars(decisionTime) };
}

function vector(decisionTime: number, assetId: AssetId = "BTC") {
  return buildResearchFeatureVector({
    assetId,
    decisionTime,
    asOf: decisionTime,
    definitions: [closeFeature],
    oneHourBars: bars(decisionTime),
  });
}

function leaf(status: ResearchRuleStatus = "MATCH", threshold = 1, ruleId = "D_A_LEAF"): ResearchRule {
  return createResearchRule({
    ruleId,
    version: "1.0.0",
    description: "Fixed D-A leaf",
    rationale: "Evaluate one preregistered held-out condition.",
    dependencies: [{ kind: "TIMEFRAME", timeframe: "1H" }],
    parameters: { threshold },
    evaluate: () => ({ status, reasons: [{ code: `D_A_${status}`, message: status }] }),
  });
}

function definition(
  rule: Pick<ResearchRule, "ruleId" | "version" | "semanticIdentity" | "dependencies">,
  policy: StatefulOosBoundaryPolicy = "NOT_APPLICABLE",
  overrides: Partial<ResearchHypothesisDefinition> = {}
): ResearchHypothesisDefinition {
  const stateful = policy !== "NOT_APPLICABLE";
  return {
    hypothesisId: HYPOTHESIS_ID,
    version: HYPOTHESIS_VERSION,
    title: "Fixed held-out evaluation",
    description: "One fixed preregistered trial.",
    rationale: "Preserve all held-out evidence without selection.",
    rule: hypothesisRuleReference(rule),
    assetScope: ["BTC", "PAXG"],
    requiredDependencies: rule.dependencies,
    parameterSpace: [{
      name: stateful ? "requiredConsecutive" : "threshold",
      kind: "FIXED",
      value: stateful ? 2 : 1,
    }],
    researchIntent: {
      question: "What evidence does the fixed rule produce OOS?",
      falsificationCriterion: "Retain NO_MATCH and insufficient evidence.",
    },
    trainOosPolicy: {
      policyId: "D-A-FIXED-OOS",
      training: { startTime: START, endTime: OOS_START },
      oos: { startTime: OOS_START, endTime: OOS_END },
      ordering: "TRAIN_BEFORE_OOS",
      oosReuse: "NEVER_TUNE_ON_OOS",
    },
    statefulOosBoundaryPolicy: policy,
    trialAccounting: {
      familyId: "D-A-FAMILY",
      unit: "ONE_TRIAL_PER_RULE_PARAMETER_CONFIGURATION",
      variantHandling: "COUNT_EACH_VARIANT",
      declaredTrialCount: 1,
    },
    lifecycle: "EVALUATION_PENDING",
    preRegistration: {
      declaredBy: "D-A-test",
      sourceReference: "fixed-held-out-plan",
      declarationOrdinal: 1,
    },
    ...overrides,
  };
}

function statelessSetup() {
  const registeredRule = leaf();
  const registry = createHypothesisRegistry([definition(registeredRule)]);
  const observation = (
    status: ResearchRuleStatus,
    decisionTime: number,
    assetId: AssetId = "BTC"
  ) => {
    const rule = leaf(status);
    const ctx = context(decisionTime, assetId);
    return runStatelessShadowObservation({
      registry,
      hypothesisId: HYPOTHESIS_ID,
      hypothesisVersion: HYPOTHESIS_VERSION,
      parameterConfiguration: { threshold: 1 },
      rule,
      context: ctx,
      featureVector: vector(decisionTime, assetId),
    });
  };
  return { registry, observation };
}

function statefulRule(status: ResearchRuleStatus = "MATCH"): StatefulResearchRule<PersistenceState> {
  return createPersistenceRule({
    ruleId: "D_A_PERSISTENCE",
    version: "1.0.0",
    description: "Two-observation persistence",
    rationale: "Exercise preregistered state boundaries.",
    condition: leaf(status),
    requiredConsecutive: 2,
  });
}

function statefulSetup(policy: Exclude<StatefulOosBoundaryPolicy, "NOT_APPLICABLE">) {
  const rule = statefulRule();
  const registry = createHypothesisRegistry([definition(rule, policy)]);
  const observe = (
    priorState: PersistenceState,
    decisionTime: number,
    status: ResearchRuleStatus = "MATCH",
    assetId: AssetId = "BTC"
  ): StatefulShadowResearchObservation<PersistenceState> => {
    const activeRule = statefulRule(status);
    const ctx = context(decisionTime, assetId);
    return runStatefulShadowObservation({
      registry,
      hypothesisId: HYPOTHESIS_ID,
      hypothesisVersion: HYPOTHESIS_VERSION,
      parameterConfiguration: { requiredConsecutive: 2 },
      rule: activeRule,
      priorState,
      context: ctx,
      featureVector: vector(decisionTime, assetId),
    });
  };
  return { rule, registry, observe };
}

function evaluate(
  registry: HypothesisRegistrySnapshot,
  observations: readonly ShadowResearchObservation[],
  preOosTransitionWitnesses?: readonly StatefulShadowResearchObservation<PersistenceState>[]
) {
  return evaluateHeldOutOosEvidence({
    registry,
    hypothesisId: HYPOTHESIS_ID,
    hypothesisVersion: HYPOTHESIS_VERSION,
    observations,
    preOosTransitionWitnesses,
  });
}

describe("M13D D-A fixed-rule held-out OOS evidence evaluation", () => {
  it("evaluates one valid fixed preregistered trial", () => {
    const { registry, observation } = statelessSetup();
    const summary = evaluate(registry, [observation("MATCH", OOS_START)]);
    expect(summary).toMatchObject({
      intendedUse: "HELD_OUT_OOS_RESEARCH_ONLY",
      counts: { total: 1, match: 1, evaluable: 1 },
      predictiveValidityEstablished: false,
      approvedForPaperAction: false,
      grantsExecutionAuthority: false,
      priceAuthority: "NONE",
    });
  });

  it("rejects a forged observation semantic identity", () => {
    const { registry, observation } = statelessSetup();
    const forged = { ...observation("MATCH", OOS_START), status: "NO_MATCH" as const };
    expect(() => evaluate(registry, [forged])).toThrow(/incompatible|forged or stale/);
  });

  it.each([
    ["hypothesis", (item: ShadowResearchObservation) => ({ ...item, binding: { ...item.binding, hypothesisId: "OTHER" } })],
    ["rule", (item: ShadowResearchObservation) => ({ ...item, binding: { ...item.binding, ruleId: "OTHER" } })],
    ["configuration", (item: ShadowResearchObservation) => ({ ...item, binding: { ...item.binding, parameterConfigurationIdentity: "OTHER" } })],
    ["trial", (item: ShadowResearchObservation) => ({ ...item, binding: { ...item.binding, trialAccountingIdentity: "OTHER" } })],
    ["asset", (item: ShadowResearchObservation) => ({ ...item, assetId: "PAXG" as const })],
    ["policy", (item: ShadowResearchObservation) => ({ ...item, binding: { ...item.binding, statefulOosBoundaryPolicy: "RESET_AT_OOS_START" as const } })],
  ] as const)("rejects mixed or forged %s identity evidence", (_label, forge) => {
    const { registry, observation } = statelessSetup();
    const first = observation("MATCH", OOS_START);
    const forged = forge(observation("NO_MATCH", OOS_START + HOUR)) as ShadowResearchObservation;
    expect(() => evaluate(registry, [first, forged])).toThrow();
  });

  it("rejects valid mixed-asset observation sets", () => {
    const { registry, observation } = statelessSetup();
    expect(() => evaluate(registry, [
      observation("MATCH", OOS_START, "BTC"),
      observation("NO_MATCH", OOS_START + HOUR, "PAXG"),
    ])).toThrow(/mixed hypothesis, rule, configuration, trial, asset, or policy/);
  });

  it("accepts OOS start and rejects TRAIN or OUTSIDE contamination", () => {
    const { registry, observation } = statelessSetup();
    expect(() => evaluate(registry, [observation("MATCH", OOS_START)])).not.toThrow();
    expect(() => evaluate(registry, [observation("MATCH", OOS_START - HOUR)])).toThrow(/classified OOS/);
    expect(() => evaluate(registry, [observation("MATCH", OOS_END)])).toThrow(/classified OOS/);
  });

  it("enforces the exact half-open OOS end boundary", () => {
    const { registry, observation } = statelessSetup();
    expect(() => evaluate(registry, [observation("MATCH", OOS_END - HOUR)])).not.toThrow();
    expect(() => evaluate(registry, [observation("MATCH", OOS_END)])).toThrow();
  });

  it("rejects duplicate decisionTime without silently sorting", () => {
    const { registry, observation } = statelessSetup();
    expect(() => evaluate(registry, [
      observation("MATCH", OOS_START),
      observation("NO_MATCH", OOS_START),
    ])).toThrow(/duplicate OOS decisionTime/);
  });

  it("rejects decreasing decisionTime without silently sorting", () => {
    const { registry, observation } = statelessSetup();
    expect(() => evaluate(registry, [
      observation("MATCH", OOS_START + HOUR),
      observation("NO_MATCH", OOS_START),
    ])).toThrow(/strict chronological order/);
  });

  it("rejects duplicate observation identity", () => {
    const { registry, observation } = statelessSetup();
    const duplicate = observation("MATCH", OOS_START);
    expect(() => evaluate(registry, [duplicate, duplicate])).toThrow(/duplicate observation semantic identity/);
  });

  it("requires stateless NOT_APPLICABLE with null state evidence", () => {
    const { registry, observation } = statelessSetup();
    const valid = observation("MATCH", OOS_START);
    expect(valid.stateBoundaryEvidence).toBeNull();
    expect(() => evaluate(registry, [valid])).not.toThrow();
    const forged = { ...valid, stateBoundaryEvidence: { policy: "RESET_AT_OOS_START" } } as unknown as ShadowResearchObservation;
    expect(() => evaluate(registry, [forged])).toThrow();
  });

  it("accepts RESET only when the first OOS prior state is canonical initial state", () => {
    const setup = statefulSetup("RESET_AT_OOS_START");
    const first = setup.observe(setup.rule.createInitialState("BTC"), OOS_START);
    expect(() => evaluate(setup.registry, [first])).not.toThrow();
  });

  it("rejects RESET when first OOS state is not canonical initial state", () => {
    const setup = statefulSetup("RESET_AT_OOS_START");
    const train = setup.observe(setup.rule.createInitialState("BTC"), OOS_START - HOUR);
    const first = setup.observe(train.stateTransition.nextState, OOS_START);
    expect(() => evaluate(setup.registry, [first])).toThrow(/did not start from the canonical initial state/);
  });

  it("accepts a continuous RESET OOS state chain", () => {
    const setup = statefulSetup("RESET_AT_OOS_START");
    const first = setup.observe(setup.rule.createInitialState("BTC"), OOS_START);
    const second = setup.observe(first.stateTransition.nextState, OOS_START + HOUR);
    expect(evaluate(setup.registry, [first, second]).counts.total).toBe(2);
  });

  it("rejects a broken subsequent RESET state chain", () => {
    const setup = statefulSetup("RESET_AT_OOS_START");
    const first = setup.observe(setup.rule.createInitialState("BTC"), OOS_START);
    const broken = setup.observe(setup.rule.createInitialState("BTC"), OOS_START + HOUR);
    expect(() => evaluate(setup.registry, [first, broken])).toThrow(/continuous transition chain/);
  });

  it("accepts CARRY with a canonically anchored pre-OOS transition chain", () => {
    const setup = statefulSetup("CARRY_PIT_STATE_FROM_PRE_OOS");
    const anchor = setup.observe(setup.rule.createInitialState("BTC"), OOS_START - 2 * HOUR);
    const finalWitness = setup.observe(anchor.stateTransition.nextState, OOS_START - HOUR);
    const first = setup.observe(finalWitness.stateTransition.nextState, OOS_START);
    const summary = evaluate(setup.registry, [first], [anchor, finalWitness]);
    expect(summary.orderedPreOosTransitionWitnessSemanticIdentities)
      .toEqual([anchor.semanticIdentity, finalWitness.semanticIdentity]);
  });

  it("rejects an isolated carry witness whose prior-state lineage is not supplied", () => {
    const setup = statefulSetup("CARRY_PIT_STATE_FROM_PRE_OOS");
    const omittedAnchor = setup.observe(setup.rule.createInitialState("BTC"), OOS_START - 2 * HOUR);
    const isolated = setup.observe(omittedAnchor.stateTransition.nextState, OOS_START - HOUR);
    const first = setup.observe(isolated.stateTransition.nextState, OOS_START);
    expect(() => evaluate(setup.registry, [first], [isolated])).toThrow(/not anchored at the canonical initial state/);
  });

  it("rejects a broken intermediate carry state identity", () => {
    const setup = statefulSetup("CARRY_PIT_STATE_FROM_PRE_OOS");
    const anchor = setup.observe(setup.rule.createInitialState("BTC"), OOS_START - 2 * HOUR);
    const broken = setup.observe(setup.rule.createInitialState("BTC"), OOS_START - HOUR);
    const first = setup.observe(broken.stateTransition.nextState, OOS_START);
    expect(() => evaluate(setup.registry, [first], [anchor, broken]))
      .toThrow(/broken intermediate state transition/);
  });

  it("rejects broken carry priorStateLastDecisionTime evidence", () => {
    const setup = statefulSetup("CARRY_PIT_STATE_FROM_PRE_OOS");
    const anchor = setup.observe(setup.rule.createInitialState("BTC"), OOS_START - 2 * HOUR);
    const next = setup.observe(anchor.stateTransition.nextState, OOS_START - HOUR);
    const first = setup.observe(next.stateTransition.nextState, OOS_START);
    const forged = {
      ...next,
      stateBoundaryEvidence: {
        ...next.stateBoundaryEvidence!,
        priorStateLastDecisionTime: OOS_START - 3 * HOUR,
      },
    } as StatefulShadowResearchObservation<PersistenceState>;
    expect(() => evaluate(setup.registry, [first], [anchor, forged])).toThrow();
  });

  it("rejects duplicate or decreasing carry witness chronology", () => {
    const setup = statefulSetup("CARRY_PIT_STATE_FROM_PRE_OOS");
    const early = setup.observe(setup.rule.createInitialState("BTC"), OOS_START - 3 * HOUR);
    const duplicateTime = setup.observe(setup.rule.createInitialState("BTC"), OOS_START - 3 * HOUR, "NO_MATCH");
    const late = setup.observe(early.stateTransition.nextState, OOS_START - 2 * HOUR);
    const first = setup.observe(late.stateTransition.nextState, OOS_START);
    expect(() => evaluate(setup.registry, [first], [early, duplicateTime]))
      .toThrow(/duplicate carry witness decisionTime/);
    expect(() => evaluate(setup.registry, [first], [late, early]))
      .toThrow(/strict chronological order/);
  });

  it("rejects a witness at or after OOS start", () => {
    const setup = statefulSetup("CARRY_PIT_STATE_FROM_PRE_OOS");
    const witness = setup.observe(setup.rule.createInitialState("BTC"), OOS_START);
    const first = setup.observe(witness.stateTransition.nextState, OOS_START + HOUR);
    expect(() => evaluate(setup.registry, [first], [witness])).toThrow(/strictly before the OOS interval/);
  });

  it.each([
    ["hypothesis", "hypothesisId"],
    ["rule", "ruleId"],
    ["configuration", "parameterConfigurationIdentity"],
    ["trial", "trialAccountingIdentity"],
  ] as const)("rejects a wrong-%s carry witness", (_label, field) => {
    const setup = statefulSetup("CARRY_PIT_STATE_FROM_PRE_OOS");
    const witness = setup.observe(setup.rule.createInitialState("BTC"), OOS_START - HOUR);
    const first = setup.observe(witness.stateTransition.nextState, OOS_START);
    const forged = {
      ...witness,
      binding: { ...witness.binding, [field]: "WRONG" },
    } as StatefulShadowResearchObservation<PersistenceState>;
    expect(() => evaluate(setup.registry, [first], [forged])).toThrow();
  });

  it("rejects a wrong-asset carry witness", () => {
    const setup = statefulSetup("CARRY_PIT_STATE_FROM_PRE_OOS");
    const witness = setup.observe(setup.rule.createInitialState("BTC"), OOS_START - HOUR);
    const first = setup.observe(witness.stateTransition.nextState, OOS_START);
    const forged = { ...witness, assetId: "PAXG" as const };
    expect(() => evaluate(setup.registry, [first], [forged])).toThrow();
  });

  it("rejects CARRY without an explicit witness", () => {
    const setup = statefulSetup("CARRY_PIT_STATE_FROM_PRE_OOS");
    const witness = setup.observe(setup.rule.createInitialState("BTC"), OOS_START - HOUR);
    const first = setup.observe(witness.stateTransition.nextState, OOS_START);
    expect(() => evaluate(setup.registry, [first])).toThrow(/requires a canonically anchored/);
  });

  it("requires final carry witness continuity into first OOS state", () => {
    const setup = statefulSetup("CARRY_PIT_STATE_FROM_PRE_OOS");
    const anchor = setup.observe(setup.rule.createInitialState("BTC"), OOS_START - 2 * HOUR);
    const finalWitness = setup.observe(anchor.stateTransition.nextState, OOS_START - HOUR);
    const firstFromStaleState = setup.observe(anchor.stateTransition.nextState, OOS_START);
    expect(() => evaluate(setup.registry, [firstFromStaleState], [anchor, finalWitness]))
      .toThrow(/final carry witness next state does not equal/);
  });

  it("validates every subsequent CARRY OOS state link", () => {
    const setup = statefulSetup("CARRY_PIT_STATE_FROM_PRE_OOS");
    const witness = setup.observe(setup.rule.createInitialState("BTC"), OOS_START - HOUR);
    const first = setup.observe(witness.stateTransition.nextState, OOS_START);
    const second = setup.observe(first.stateTransition.nextState, OOS_START + HOUR);
    expect(() => evaluate(setup.registry, [first, second], [witness])).not.toThrow();
    const broken = setup.observe(witness.stateTransition.nextState, OOS_START + HOUR);
    expect(() => evaluate(setup.registry, [first, broken], [witness])).toThrow(/continuous transition chain/);
  });

  it("does not count a pre-OOS carry witness in OOS totals", () => {
    const setup = statefulSetup("CARRY_PIT_STATE_FROM_PRE_OOS");
    const witness = setup.observe(setup.rule.createInitialState("BTC"), OOS_START - HOUR);
    const first = setup.observe(witness.stateTransition.nextState, OOS_START);
    expect(evaluate(setup.registry, [first], [witness]).counts.total).toBe(1);
  });

  it("makes ordered carry provenance part of summary identity", () => {
    const setup = statefulSetup("CARRY_PIT_STATE_FROM_PRE_OOS");
    const noMatchWitness = setup.observe(
      setup.rule.createInitialState("BTC"),
      OOS_START - HOUR,
      "NO_MATCH"
    );
    const insufficientWitness = setup.observe(
      setup.rule.createInitialState("BTC"),
      OOS_START - HOUR,
      "INSUFFICIENT_EVIDENCE"
    );
    const firstAfterNoMatch = setup.observe(noMatchWitness.stateTransition.nextState, OOS_START);
    const firstAfterInsufficient = setup.observe(insufficientWitness.stateTransition.nextState, OOS_START);
    expect(firstAfterNoMatch.semanticIdentity).toBe(firstAfterInsufficient.semanticIdentity);
    const left = evaluate(setup.registry, [firstAfterNoMatch], [noMatchWitness]);
    const right = evaluate(setup.registry, [firstAfterInsufficient], [insufficientWitness]);
    expect(left.orderedPreOosTransitionWitnessSemanticIdentities)
      .not.toEqual(right.orderedPreOosTransitionWitnessSemanticIdentities);
    expect(left.semanticIdentity).not.toBe(right.semanticIdentity);
  });

  it("does not mutate caller-owned carry witness chains or OOS observations", () => {
    const setup = statefulSetup("CARRY_PIT_STATE_FROM_PRE_OOS");
    const anchor = setup.observe(setup.rule.createInitialState("BTC"), OOS_START - 2 * HOUR);
    const finalWitness = setup.observe(anchor.stateTransition.nextState, OOS_START - HOUR);
    const first = setup.observe(finalWitness.stateTransition.nextState, OOS_START);
    const witnesses = [anchor, finalWitness];
    const observations = [first];
    const before = JSON.stringify({ witnesses, observations });
    evaluate(setup.registry, observations, witnesses);
    expect(JSON.stringify({ witnesses, observations })).toBe(before);
  });

  it("counts MATCH, NO_MATCH, and INSUFFICIENT_EVIDENCE separately and exactly", () => {
    const { registry, observation } = statelessSetup();
    const summary = evaluate(registry, [
      observation("MATCH", OOS_START),
      observation("NO_MATCH", OOS_START + HOUR),
      observation("INSUFFICIENT_EVIDENCE", OOS_START + 2 * HOUR),
    ]);
    expect(summary.counts).toEqual({
      total: 3,
      match: 1,
      noMatch: 1,
      insufficientEvidence: 1,
      evaluable: 2,
      insufficientEvidenceRate: 1 / 3,
    });
  });

  it("fails closed on an empty OOS observation set", () => {
    const { registry } = statelessSetup();
    expect(() => evaluate(registry, [])).toThrow(/at least one OOS observation/);
  });

  it("is deterministic, leaves caller input unchanged, and returns deep immutable output", () => {
    const { registry, observation } = statelessSetup();
    const observations = [observation("MATCH", OOS_START), observation("NO_MATCH", OOS_START + HOUR)];
    const before = JSON.stringify({ registry, observations });
    const left = evaluate(registry, observations);
    const right = evaluate(registry, observations);
    expect(left.semanticIdentity).toBe(right.semanticIdentity);
    expect(JSON.stringify({ registry, observations })).toBe(before);
    expect(Object.isFrozen(left)).toBe(true);
    expect(Object.isFrozen(left.binding)).toBe(true);
    expect(Object.isFrozen(left.binding.oosInterval)).toBe(true);
    expect(Object.isFrozen(left.counts)).toBe(true);
    expect(Object.isFrozen(left.orderedObservationSemanticIdentities)).toBe(true);
  });

  it("retains poor and insufficient evidence without economic, ranking, or trading fields", () => {
    const { registry, observation } = statelessSetup();
    const summary = evaluate(registry, [
      observation("NO_MATCH", OOS_START),
      observation("INSUFFICIENT_EVIDENCE", OOS_START + HOUR),
    ]);
    const serialized = JSON.stringify(summary);
    expect(summary.counts).toMatchObject({ total: 2, noMatch: 1, insufficientEvidence: 1 });
    expect(serialized).not.toMatch(/"(forwardReturn|winRate|sharpe|pnl|drawdown|profitability|directionAccuracy|ranking|selectedParameters|targetWeight|ActionDecision)"\s*:/i);
    expect(summary).toMatchObject({
      predictiveValidityEstablished: false,
      approvedForPaperAction: false,
      grantsExecutionAuthority: false,
      priceAuthority: "NONE",
    });
  });

  it("rejects a forged registry before trusting observations", () => {
    const { registry, observation } = statelessSetup();
    const forged = { ...registry, semanticIdentity: "forged" } as HypothesisRegistrySnapshot;
    const input: HeldOutOosEvaluationInput = {
      registry: forged,
      hypothesisId: HYPOTHESIS_ID,
      hypothesisVersion: HYPOTHESIS_VERSION,
      observations: [observation("MATCH", OOS_START)],
    };
    expect(() => evaluateHeldOutOosEvidence(input)).toThrow(/forged or stale/);
  });
});
