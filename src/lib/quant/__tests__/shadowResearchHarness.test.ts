import { describe, expect, it } from "vitest";
import { deriveHigherTimeframeContext } from "../derivedTimeframeContext";
import type { HistoricalMacroRelease } from "../historicalPit";
import {
  createHypothesisRegistry,
  hypothesisRuleReference,
  type HypothesisRegistrySnapshot,
  type ResearchHypothesisDefinition,
} from "../hypothesisRegistry";
import { buildResearchFeatureVector, type ResearchFeatureDefinition } from "../researchFeatureBuilder";
import {
  createResearchRule,
  type ResearchDependency,
  type ResearchEvaluationContext,
  type ResearchRule,
  type ResearchRuleStatus,
} from "../researchRules";
import {
  runStatefulShadowObservation,
  runStatelessShadowObservation,
} from "../shadowResearchHarness";
import { createPersistenceRule } from "../statefulResearchRules";
import { BAR_DURATION_MS } from "../timeDomain";
import type { PointInTimeBar } from "../types";

const HOUR = BAR_DURATION_MS;
const START = Date.UTC(2024, 0, 1);
const TRAIN_END = START + 48 * HOUR;
const OOS_END = TRAIN_END + 48 * HOUR;
const TRAIN_TIME = START + 24 * HOUR;
const OOS_TIME = TRAIN_END + 12 * HOUR;

function bars(decisionTime: number, count = 24): PointInTimeBar[] {
  const start = decisionTime - count * HOUR;
  return Array.from({ length: count }, (_, index) => ({
    timestamp: start + index * HOUR,
    open: 100 + index,
    high: 102 + index,
    low: 99 + index,
    close: 101 + index,
    volume: 10 + index,
  }));
}

const closeFeature = (timeframe: "1H" | "4H" | "1D" = "1H"): ResearchFeatureDefinition => ({
  featureId: `BTC_${timeframe}_CLOSE`,
  version: "1.0.0",
  description: `${timeframe} close`,
  dependency: { kind: "TIMEFRAME", timeframe },
  transformation: { kind: "BAR_CLOSE", lag: 0 },
});

const seriesFeature = (seriesId: "US_CPI_YOY" | "VIX"): ResearchFeatureDefinition => ({
  featureId: `${seriesId}_LEVEL`,
  version: "1.0.0",
  description: `${seriesId} level`,
  dependency: { kind: "SERIES", seriesId },
  transformation: { kind: "SERIES_LEVEL" },
});

function leaf(
  status: ResearchRuleStatus = "MATCH",
  dependencies: readonly ResearchDependency[] = [{ kind: "TIMEFRAME", timeframe: "1H" }],
  threshold = 1,
  version = "1.0.0"
): ResearchRule<{ threshold: number }> {
  return createResearchRule({
    ruleId: "SHADOW_LEAF",
    version,
    description: "Shadow leaf",
    rationale: "Predeclared test rationale",
    dependencies,
    parameters: { threshold },
    evaluate: () => ({ status, reasons: [{ code: `LEAF_${status}`, message: status }] }),
  });
}

function hypothesis(
  rule: Pick<ResearchRule, "ruleId" | "version" | "semanticIdentity" | "dependencies">,
  overrides: Partial<ResearchHypothesisDefinition> = {}
): ResearchHypothesisDefinition {
  return {
    hypothesisId: "H-SHADOW",
    version: "1.0.0",
    title: "Shadow hypothesis",
    description: "Predeclared shadow evaluation",
    rationale: "Test the hypothesis without trading authority.",
    rule: hypothesisRuleReference(rule),
    assetScope: ["BTC"],
    requiredDependencies: rule.dependencies,
    parameterSpace: [{ name: "threshold", kind: "CANDIDATES", values: [1, 2] }],
    researchIntent: {
      question: "Does the declared condition match?",
      falsificationCriterion: "Preserve NO_MATCH and insufficient observations.",
    },
    trainOosPolicy: {
      policyId: "TRAIN-OOS-1",
      training: { startTime: START, endTime: TRAIN_END },
      oos: { startTime: TRAIN_END, endTime: OOS_END },
      ordering: "TRAIN_BEFORE_OOS",
      oosReuse: "NEVER_TUNE_ON_OOS",
    },
    statefulOosBoundaryPolicy: "NOT_APPLICABLE",
    trialAccounting: {
      familyId: "SHADOW-FAMILY",
      unit: "ONE_TRIAL_PER_RULE_PARAMETER_CONFIGURATION",
      variantHandling: "COUNT_EACH_VARIANT",
      declaredTrialCount: 2,
    },
    lifecycle: "PREREGISTERED",
    preRegistration: {
      declaredBy: "research-governance",
      sourceReference: "C-F-test",
      declarationOrdinal: 1,
    },
    ...overrides,
  };
}

function context(
  decisionTime = TRAIN_TIME,
  overrides: Partial<ResearchEvaluationContext> = {}
): ResearchEvaluationContext {
  const oneHourBars = bars(decisionTime);
  return {
    assetId: "BTC",
    decisionTime,
    asOf: decisionTime,
    oneHourBars,
    derivedTimeframes: deriveHigherTimeframeContext({
      assetId: "BTC",
      eligible1hBars: oneHourBars,
      decisionTime,
    }),
    series: {},
    ...overrides,
  };
}

function vectorFor(
  ctx: ResearchEvaluationContext,
  definitions: readonly ResearchFeatureDefinition[] = [closeFeature()]
) {
  return buildResearchFeatureVector({
    assetId: ctx.assetId,
    decisionTime: ctx.decisionTime,
    asOf: ctx.asOf,
    definitions,
    oneHourBars: ctx.oneHourBars,
    derivedTimeframes: ctx.derivedTimeframes,
    series: ctx.series,
  });
}

function run(
  rule = leaf(),
  decisionTime = TRAIN_TIME,
  overrides: Partial<Parameters<typeof runStatelessShadowObservation>[0]> = {}
) {
  const ctx = context(decisionTime);
  const registry = createHypothesisRegistry([hypothesis(rule)]);
  return runStatelessShadowObservation({
    registry,
    hypothesisId: "H-SHADOW",
    hypothesisVersion: "1.0.0",
    parameterConfiguration: { threshold: 1 },
    rule,
    context: ctx,
    featureVector: vectorFor(ctx),
    ...overrides,
  });
}

function cpi(availableAt: number): HistoricalMacroRelease {
  return {
    seriesId: "US_CPI_YOY",
    observationTime: START,
    publishedAt: availableAt,
    availableAt,
    revisionIndex: 0,
    value: 3.2,
    provider: "BLS",
    unit: "PERCENT",
  };
}

describe("M13C C-F PIT-safe shadow research harness", () => {
  it("binds a valid preregistered hypothesis, rule, and explicit configuration", () => {
    const observation = run();
    expect(observation).toMatchObject({ evaluationKind: "STATELESS", status: "MATCH", window: "TRAIN" });
    expect(observation.binding).toMatchObject({
      hypothesisId: "H-SHADOW",
      ruleId: "SHADOW_LEAF",
      parameterConfiguration: { threshold: 1 },
      trialAccounting: { declaredTrialCount: 2 },
      statefulOosBoundaryPolicy: "NOT_APPLICABLE",
    });
    expect(observation.stateBoundaryEvidence).toBeNull();
  });

  it("rejects a stateful boundary policy on a stateless rule", () => {
    const rule = leaf();
    const ctx = context();
    expect(() => runStatelessShadowObservation({
      registry: createHypothesisRegistry([hypothesis(rule, {
        statefulOosBoundaryPolicy: "RESET_AT_OOS_START",
      })]),
      hypothesisId: "H-SHADOW",
      hypothesisVersion: "1.0.0",
      parameterConfiguration: { threshold: 1 },
      rule,
      context: ctx,
      featureVector: vectorFor(ctx),
    })).toThrow(/stateless rules require.*NOT_APPLICABLE/);
  });

  it("rejects a mismatched rule identity", () => {
    const registeredRule = leaf();
    const suppliedRule = leaf("MATCH", undefined, 1, "2.0.0");
    const ctx = context();
    expect(() => runStatelessShadowObservation({
      registry: createHypothesisRegistry([hypothesis(registeredRule)]),
      hypothesisId: "H-SHADOW",
      hypothesisVersion: "1.0.0",
      parameterConfiguration: { threshold: 1 },
      rule: suppliedRule,
      context: ctx,
      featureVector: vectorFor(ctx),
    })).toThrow(/rule identity does not match/);
  });

  it("rejects a configuration outside the preregistered finite space", () => {
    expect(() => run(leaf(undefined, undefined, 3), TRAIN_TIME, {
      parameterConfiguration: { threshold: 3 },
    })).toThrow(/outside the preregistered finite space/);
  });

  it("rejects a configuration that does not match the supplied rule identity", () => {
    expect(() => run(undefined, TRAIN_TIME, {
      parameterConfiguration: { threshold: 2 },
    })).toThrow(/does not match the supplied rule identity/);
  });

  it("rejects material hypothesis tampering with a stale identity", () => {
    const rule = leaf();
    const valid = createHypothesisRegistry([hypothesis(rule)]);
    const forged = {
      ...valid,
      hypotheses: [{ ...valid.hypotheses[0], rationale: "forged" }],
    } as HypothesisRegistrySnapshot;
    const ctx = context();
    expect(() => runStatelessShadowObservation({
      registry: forged,
      hypothesisId: "H-SHADOW",
      hypothesisVersion: "1.0.0",
      parameterConfiguration: { threshold: 1 },
      rule,
      context: ctx,
      featureVector: vectorFor(ctx),
    })).toThrow(/forged or stale scientific identity/);
  });

  it("classifies observations inside TRAIN", () => {
    expect(run(undefined, TRAIN_TIME).window).toBe("TRAIN");
  });

  it("classifies observations inside OOS", () => {
    expect(run(undefined, OOS_TIME).window).toBe("OOS");
  });

  it("classifies observations outside declared intervals", () => {
    expect(run(undefined, OOS_END).window).toBe("OUTSIDE_DECLARED_WINDOW");
  });

  it("uses half-open intervals so the exact train end is OOS start", () => {
    expect(run(undefined, TRAIN_END).window).toBe("OOS");
  });

  it("does not alter parameter identity between TRAIN and OOS", () => {
    expect(run(undefined, TRAIN_TIME).binding.parameterConfigurationIdentity)
      .toBe(run(undefined, OOS_TIME).binding.parameterConfigurationIdentity);
  });

  it("accepts the exact eligible 1H decision boundary", () => {
    const observation = run();
    expect(observation.ruleResult.dependencyAvailability[0].status).toBe("AVAILABLE");
  });

  it("rejects future 1H evidence instead of trimming it", () => {
    const rule = leaf();
    const ctx = context();
    const future = { ...bars(ctx.decisionTime + HOUR, 1)[0] };
    const forgedContext = { ...ctx, oneHourBars: [...ctx.oneHourBars!, future] };
    expect(() => run(rule, TRAIN_TIME, { context: forgedContext })).toThrow(/future or invalid 1H evidence/);
  });

  it("rejects incomplete forged derived context", () => {
    const rule = leaf("MATCH", [{ kind: "TIMEFRAME", timeframe: "4H" }]);
    const ctx = context();
    const forgedDerived = {
      ...ctx.derivedTimeframes!,
      completed4hBars: [{ ...ctx.derivedTimeframes!.completed4hBars[0], componentCount: 3 }],
    };
    const forgedContext = { ...ctx, derivedTimeframes: forgedDerived };
    const registry = createHypothesisRegistry([hypothesis(rule)]);
    const validVector = vectorFor(ctx, [closeFeature("4H")]);
    expect(() => runStatelessShadowObservation({
      registry,
      hypothesisId: "H-SHADOW",
      hypothesisVersion: "1.0.0",
      parameterConfiguration: { threshold: 1 },
      rule,
      context: forgedContext,
      featureVector: validVector,
    })).toThrow(/mislabeled or non-PIT evidence/);
  });

  it("rejects a future macro release or revision", () => {
    const rule = leaf("MATCH", [{ kind: "SERIES", seriesId: "US_CPI_YOY" }]);
    const ctx = context(TRAIN_TIME, { series: { US_CPI_YOY: cpi(TRAIN_TIME + HOUR) } });
    const featureVector = vectorFor(ctx, [seriesFeature("US_CPI_YOY")]);
    expect(() => runStatelessShadowObservation({
      registry: createHypothesisRegistry([hypothesis(rule)]),
      hypothesisId: "H-SHADOW",
      hypothesisVersion: "1.0.0",
      parameterConfiguration: { threshold: 1 },
      rule,
      context: ctx,
      featureVector,
    })).toThrow(/future series evidence/);
  });

  it("turns a missing required dependency into INSUFFICIENT_EVIDENCE", () => {
    const rule = leaf();
    const ctx = context(TRAIN_TIME, { oneHourBars: [], derivedTimeframes: undefined });
    const observation = runStatelessShadowObservation({
      registry: createHypothesisRegistry([hypothesis(rule)]),
      hypothesisId: "H-SHADOW",
      hypothesisVersion: "1.0.0",
      parameterConfiguration: { threshold: 1 },
      rule,
      context: ctx,
      featureVector: vectorFor(ctx),
    });
    expect(observation.status).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("ignores an unrelated unavailable optional feature without fabricating it", () => {
    const rule = leaf();
    const ctx = context();
    const featureVector = vectorFor(ctx, [closeFeature(), seriesFeature("VIX")]);
    const observation = run(rule, TRAIN_TIME, { context: ctx, featureVector });
    expect(observation.status).toBe("MATCH");
    expect(observation.featureEvidence).toHaveLength(1);
    expect(
      observation.featureEvidence.some(
        (feature) => feature.featureId === "VIX_LEVEL",
      ),
    ).toBe(false);
  });

  it("preserves deterministic stateful prior-state to next-state transitions", () => {
    const condition = leaf();
    const stateful = createPersistenceRule({
      ruleId: "PERSISTENCE",
      version: "1.0.0",
      description: "Two observations",
      rationale: "Stateful shadow test",
      condition,
      requiredConsecutive: 2,
    });
    const definition = hypothesis(stateful, {
      rule: hypothesisRuleReference(stateful),
      requiredDependencies: stateful.dependencies,
      parameterSpace: [{ name: "requiredConsecutive", kind: "FIXED", value: 2 }],
      trialAccounting: { ...hypothesis(condition).trialAccounting, declaredTrialCount: 1 },
      statefulOosBoundaryPolicy: "RESET_AT_OOS_START",
    });
    const registry = createHypothesisRegistry([definition]);
    const firstContext = context(TRAIN_END);
    const initial = stateful.createInitialState("BTC");
    const original = JSON.stringify(initial);
    const first = runStatefulShadowObservation({
      registry,
      hypothesisId: "H-SHADOW",
      hypothesisVersion: "1.0.0",
      parameterConfiguration: { requiredConsecutive: 2 },
      rule: stateful,
      priorState: initial,
      context: firstContext,
      featureVector: vectorFor(firstContext),
    });
    const secondContext = context(TRAIN_END + HOUR);
    const second = runStatefulShadowObservation({
      registry,
      hypothesisId: "H-SHADOW",
      hypothesisVersion: "1.0.0",
      parameterConfiguration: { requiredConsecutive: 2 },
      rule: stateful,
      priorState: first.stateTransition.nextState,
      context: secondContext,
      featureVector: vectorFor(secondContext),
    });
    expect(JSON.stringify(initial)).toBe(original);
    expect(first.stateTransition.event).toBe("STREAK_ADVANCED");
    expect(second.stateTransition.event).toBe("COMPLETED");
    expect(first.binding.statefulOosBoundaryPolicy).toBe("RESET_AT_OOS_START");
    expect(first.stateBoundaryEvidence).toMatchObject({
      policy: "RESET_AT_OOS_START",
      priorStateLastDecisionTime: null,
    });
    expect(first.stateBoundaryEvidence?.priorStateIdentity)
      .toBe(first.stateBoundaryEvidence?.canonicalInitialStateIdentity);
  });

  it("preserves CARRY policy and prior-state proof material in observation identity", () => {
    const condition = leaf();
    const stateful = createPersistenceRule({
      ruleId: "PERSISTENCE",
      version: "1.0.0",
      description: "Two observations",
      rationale: "Stateful shadow test",
      condition,
      requiredConsecutive: 2,
    });
    const base = hypothesis(stateful, {
      rule: hypothesisRuleReference(stateful),
      requiredDependencies: stateful.dependencies,
      parameterSpace: [{ name: "requiredConsecutive", kind: "FIXED", value: 2 }],
      trialAccounting: { ...hypothesis(condition).trialAccounting, declaredTrialCount: 1 },
      statefulOosBoundaryPolicy: "CARRY_PIT_STATE_FROM_PRE_OOS",
    });
    const originalDefinition = JSON.stringify(base);
    const trainContext = context(TRAIN_END - HOUR);
    const trainObservation = runStatefulShadowObservation({
      registry: createHypothesisRegistry([base]),
      hypothesisId: "H-SHADOW",
      hypothesisVersion: "1.0.0",
      parameterConfiguration: { requiredConsecutive: 2 },
      rule: stateful,
      priorState: stateful.createInitialState("BTC"),
      context: trainContext,
      featureVector: vectorFor(trainContext),
    });
    const oosContext = context(TRAIN_END);
    const carried = runStatefulShadowObservation({
      registry: createHypothesisRegistry([base]),
      hypothesisId: "H-SHADOW",
      hypothesisVersion: "1.0.0",
      parameterConfiguration: { requiredConsecutive: 2 },
      rule: stateful,
      priorState: trainObservation.stateTransition.nextState,
      context: oosContext,
      featureVector: vectorFor(oosContext),
    });
    const resetDefinition = { ...base, statefulOosBoundaryPolicy: "RESET_AT_OOS_START" as const };
    const reset = runStatefulShadowObservation({
      registry: createHypothesisRegistry([resetDefinition]),
      hypothesisId: "H-SHADOW",
      hypothesisVersion: "1.0.0",
      parameterConfiguration: { requiredConsecutive: 2 },
      rule: stateful,
      priorState: trainObservation.stateTransition.nextState,
      context: oosContext,
      featureVector: vectorFor(oosContext),
    });
    expect(carried.binding.statefulOosBoundaryPolicy).toBe("CARRY_PIT_STATE_FROM_PRE_OOS");
    expect(carried.stateBoundaryEvidence).toMatchObject({
      policy: "CARRY_PIT_STATE_FROM_PRE_OOS",
      priorStateLastDecisionTime: TRAIN_END - HOUR,
    });
    expect(carried.semanticIdentity).not.toBe(reset.semanticIdentity);
    expect(Object.isFrozen(carried.stateBoundaryEvidence)).toBe(true);
    expect(JSON.stringify(base)).toBe(originalDefinition);
    expect(carried).toMatchObject({
      predictiveValidityEstablished: false,
      approvedForPaperAction: false,
      grantsExecutionAuthority: false,
      priceAuthority: "NONE",
    });
  });

  it("rejects NOT_APPLICABLE for a stateful rule", () => {
    const condition = leaf();
    const stateful = createPersistenceRule({
      ruleId: "PERSISTENCE",
      version: "1.0.0",
      description: "Two observations",
      rationale: "Stateful shadow test",
      condition,
      requiredConsecutive: 2,
    });
    const definition = hypothesis(stateful, {
      rule: hypothesisRuleReference(stateful),
      requiredDependencies: stateful.dependencies,
      parameterSpace: [{ name: "requiredConsecutive", kind: "FIXED", value: 2 }],
      trialAccounting: { ...hypothesis(condition).trialAccounting, declaredTrialCount: 1 },
    });
    const ctx = context();
    expect(() => runStatefulShadowObservation({
      registry: createHypothesisRegistry([definition]),
      hypothesisId: "H-SHADOW",
      hypothesisVersion: "1.0.0",
      parameterConfiguration: { requiredConsecutive: 2 },
      rule: stateful,
      priorState: stateful.createInitialState("BTC"),
      context: ctx,
      featureVector: vectorFor(ctx),
    })).toThrow(/stateful rules require an explicit RESET or CARRY/);
  });

  it("rejects invalid stateful time ordering through C-C semantics", () => {
    const condition = leaf();
    const stateful = createPersistenceRule({
      ruleId: "PERSISTENCE",
      version: "1.0.0",
      description: "Two observations",
      rationale: "Stateful shadow test",
      condition,
      requiredConsecutive: 2,
    });
    const definition = hypothesis(stateful, {
      rule: hypothesisRuleReference(stateful),
      requiredDependencies: stateful.dependencies,
      parameterSpace: [{ name: "requiredConsecutive", kind: "FIXED", value: 2 }],
      trialAccounting: { ...hypothesis(condition).trialAccounting, declaredTrialCount: 1 },
      statefulOosBoundaryPolicy: "RESET_AT_OOS_START",
    });
    const registry = createHypothesisRegistry([definition]);
    const ctx = context();
    const first = runStatefulShadowObservation({
      registry,
      hypothesisId: "H-SHADOW",
      hypothesisVersion: "1.0.0",
      parameterConfiguration: { requiredConsecutive: 2 },
      rule: stateful,
      priorState: stateful.createInitialState("BTC"),
      context: ctx,
      featureVector: vectorFor(ctx),
    });
    expect(() => runStatefulShadowObservation({
      registry,
      hypothesisId: "H-SHADOW",
      hypothesisVersion: "1.0.0",
      parameterConfiguration: { requiredConsecutive: 2 },
      rule: stateful,
      priorState: first.stateTransition.nextState,
      context: ctx,
      featureVector: vectorFor(ctx),
    })).toThrow(/strictly greater/);
  });

  it("produces identical immutable output for identical inputs", () => {
    const left = run();
    const right = run();
    expect(left).toEqual(right);
    expect(left.semanticIdentity).toBe(right.semanticIdentity);
    expect(Object.isFrozen(left)).toBe(true);
    expect(Object.isFrozen(left.binding)).toBe(true);
    expect(Object.isFrozen(left.featureEvidence)).toBe(true);
  });

  it.each(["NO_MATCH", "INSUFFICIENT_EVIDENCE"] as const)("preserves %s observations", (status) => {
    expect(run(leaf(status)).status).toBe(status);
  });

  it("does not mutate caller-owned registry, vector, context, or configuration", () => {
    const rule = leaf();
    const registry = createHypothesisRegistry([hypothesis(rule)]);
    const ctx = context();
    const featureVector = vectorFor(ctx);
    const configuration = { threshold: 1 } as const;
    const before = JSON.stringify({ registry, ctx, featureVector, configuration });
    runStatelessShadowObservation({
      registry,
      hypothesisId: "H-SHADOW",
      hypothesisVersion: "1.0.0",
      parameterConfiguration: configuration,
      rule,
      context: ctx,
      featureVector,
    });
    expect(JSON.stringify({ registry, ctx, featureVector, configuration })).toBe(before);
  });

  it("grants no predictive, paper-action, execution, price, or accounting authority", () => {
    const observation = run();
    expect(observation).toMatchObject({
      predictiveValidityEstablished: false,
      approvedForPaperAction: false,
      grantsExecutionAuthority: false,
      priceAuthority: "NONE",
    });
    expect(JSON.stringify(observation)).not.toMatch(/targetWeight|orderId|ActionDecision|pnl|winner|bestParameter/i);
  });
});
