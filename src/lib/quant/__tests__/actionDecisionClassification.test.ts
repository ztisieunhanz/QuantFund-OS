import { describe, expect, it } from "vitest";
import {
  ACTION_DECISION_ACTION_VOCABULARY,
  createCanonicalActionDecision,
  createDeferredActionDecision,
  validateActionDecision,
  type ActionDecision,
} from "../actionDecision";
import {
  executeRebalance,
  resolveExecutionPlannerPolicy,
  type PortfolioAccountState,
} from "../executionEngine";
import { createCanonicalPortfolioValuationSnapshot } from "../portfolioValuation";
import { producerIdentity } from "../producerProvenance";
import {
  advanceActiveTargetLifecycle,
  createActiveTargetLifecycleRoot,
  createExecutionBoundTargetAssessment,
  createTargetExecutionAssessment,
  reconcileActiveTargetLifecycleExecution,
  type ActiveTargetLifecycle,
} from "../targetExecutionLifecycle";
import type { PointInTimeBar, ProvenancedTargetPortfolioWeight, TargetPortfolioWeight } from "../types";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 0, 1, 12);

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function bar(decisionTime: number, price = 100): PointInTimeBar {
  return { timestamp: decisionTime - HOUR, open: price, high: price + 1, low: price - 1, close: price, volume: 10_000 };
}

function account(weight: number, nav = 1_000): PortfolioAccountState {
  const quantity = weight * nav / 100;
  return {
    cash: nav - quantity * 100,
    positions: quantity === 0 ? {} : {
      BTC: { assetId: "BTC", side: "LONG", status: "OPEN", quantity, entryPrice: 100, unrealizedPnl: 0 },
    },
  };
}

function valuation(weight: number, decisionTime = T0, nav = 1_000) {
  return createCanonicalPortfolioValuationSnapshot({
    decisionTime,
    account: account(weight, nav),
    marks: weight === 0 ? [] : [{ assetId: "BTC", bar: bar(decisionTime) }],
    dataQuality: "LIVE",
  });
}

function target(weight: number, decisionTime = T0, rationale = `target-${weight}`): ProvenancedTargetPortfolioWeight {
  const assetWeights: Readonly<Record<string, number>> = weight === 0 ? {} : { BTC: weight };
  const material = {
    asOfTimestamp: decisionTime,
    assetWeights,
    cashWeight: Math.max(0, Math.round((1 - weight) * 1000) / 1000),
    grossExposure: weight,
    netExposure: weight,
    strategyAllocations: { ADAPTIVE_TREND: weight, EVENT_REACTION: 0, MEAN_REVERSION: 0 },
    riskAdjustmentRatio: 1,
    rationale,
  } as const;
  const { asOfTimestamp: _ignored, ...content } = material;
  const provenance = {
    schemaVersion: "M14_A04_TARGET_PROVENANCE_V1" as const,
    targetContentIdentity: producerIdentity(content),
    signalIdentities: ["sha256:signal"],
    permissionIdentities: ["sha256:permission"],
    riskIdentity: "sha256:risk",
    omegaConfigIdentity: "sha256:omega",
    correlationsIdentity: "NONE" as const,
  };
  return { ...material, provenance: { ...provenance, targetDecisionIdentity: producerIdentity({ ...provenance, asOfTimestamp: decisionTime }) } };
}

function assessment(currentWeight: number, targetWeight: number, options?: {
  decisionTime?: number;
  threshold?: number;
  rationale?: string;
  nav?: number;
}) {
  const decisionTime = options?.decisionTime ?? T0;
  return createTargetExecutionAssessment({
    valuation: valuation(currentWeight, decisionTime, options?.nav),
    target: target(targetWeight, decisionTime, options?.rationale),
    plannerPolicy: options?.threshold === undefined ? undefined : resolveExecutionPlannerPolicy(options.threshold),
  });
}

function root(currentWeight: number, targetWeight: number, options?: Parameters<typeof assessment>[2]) {
  return createActiveTargetLifecycleRoot(assessment(currentWeight, targetWeight, options));
}

function classify(lifecycle: ActiveTargetLifecycle | null, decisionTime = lifecycle?.latestDecisionTime ?? T0): ActionDecision {
  const sourceTime = lifecycle?.transition.startsWith("EXECUTION_")
    ? lifecycle.latestExecutionAssessment?.executionTime ?? decisionTime
    : decisionTime;
  return createCanonicalActionDecision({ assetId: "BTC", decisionTime: sourceTime, asOf: sourceTime, lifecycle });
}

function executionLifecycle(lifecycle: ActiveTargetLifecycle, options?: {
  threshold?: number;
  commissionRate?: number;
  slippageBps?: number;
  omitPrice?: boolean;
}) {
  const targetValue = lifecycle.currentAssessment.target;
  const preExecutionAccount = lifecycle.currentAssessment.valuation.accountState;
  const executionTime = targetValue.asOfTimestamp + HOUR;
  const assetBars: Readonly<Record<string, PointInTimeBar>> = options?.omitPrice ? {} : {
    BTC: { timestamp: executionTime, open: 100, high: 101, low: 99, close: 100, volume: 10_000 },
  };
  const context = {
    decisionTimestamp: targetValue.asOfTimestamp,
    executionTimestamp: executionTime,
    executionRule: "NEXT_BAR_OPEN" as const,
    commissionRate: options?.commissionRate ?? 0,
    slippageConfig: { type: "FIXED_BPS" as const, baseBps: options?.slippageBps ?? 0 },
    minRebalanceThresholdUsd: options?.threshold,
    lifecycleBinding: {
      targetDecisionIdentity: targetValue.provenance.targetDecisionIdentity,
      activeTargetRootIdentity: lifecycle.activeTargetRootIdentity,
    },
  };
  const executionResult = executeRebalance(preExecutionAccount, targetValue, assetBars, context);
  const postExecutionValuation = createCanonicalPortfolioValuationSnapshot({
    decisionTime: executionTime,
    account: executionResult.updatedAccount,
    marks: Object.entries(executionResult.updatedAccount.positions)
      .filter(([, position]) => position.quantity > 0)
      .map(([assetId]) => ({ assetId, bar: bar(executionTime) })),
    dataQuality: "LIVE",
  });
  const evidence = createExecutionBoundTargetAssessment({
    activeTargetRootIdentity: lifecycle.activeTargetRootIdentity,
    target: targetValue,
    preExecutionAccount,
    assetBars,
    context,
    executionResult,
    postExecutionValuation,
  });
  return reconcileActiveTargetLifecycleExecution(lifecycle, evidence);
}

function forgedDecision(decision: ActionDecision, mutator: (draft: Record<string, any>) => void): ActionDecision {
  const draft = clone(decision) as unknown as Record<string, any>;
  mutator(draft);
  const { semanticIdentity: _identity, ...material } = draft;
  draft.semanticIdentity = producerIdentity(material);
  return draft as unknown as ActionDecision;
}

describe("M14 A-04 Step 4 canonical ActionDecision classification", () => {
  it("proves the complete six-action matrix", () => {
    expect(classify(null).action).toBe("WAIT");
    expect(classify(root(0, 0.2)).action).toBe("ENTER");
    expect(classify(root(0.2, 0.4)).action).toBe("ADD");
    expect(classify(root(0.2, 0.2)).action).toBe("HOLD");
    expect(classify(root(0.4, 0.2)).action).toBe("REDUCE");
    expect(classify(root(0.4, 0)).action).toBe("EXIT");
    expect(ACTION_DECISION_ACTION_VOCABULARY).toEqual(["WAIT", "ENTER", "ADD", "HOLD", "REDUCE", "EXIT"]);
  });

  it("keeps WAIT distinct from positively proven HOLD", () => {
    const zeroZero = classify(root(0, 0));
    const positiveEqual = classify(root(0.2, 0.2));
    expect(zeroZero.action).toBe("WAIT");
    expect(zeroZero.holdConditions.status).toBe("NOT_APPLICABLE");
    expect(positiveEqual.action).toBe("HOLD");
    expect(positiveEqual.holdConditions.status).toBe("PROVEN");
  });

  it("reuses exact planner boundaries without a weight epsilon", () => {
    expect(classify(root(0.2, 0.249999)).action).toBe("HOLD");
    expect(classify(root(0.2, 0.25)).action).toBe("ADD");
    expect(classify(root(0.3, 0.250001)).action).toBe("HOLD");
    expect(classify(root(0.3, 0.25)).action).toBe("REDUCE");
    expect(classify(root(0.2, 0.274999, { threshold: 75 })).action).toBe("HOLD");
    expect(classify(root(0.2, 0.275, { threshold: 75 })).action).toBe("ADD");
    expect(classify(root(0, 0, { threshold: 0 })).action).toBe("WAIT");
    expect(classify(root(0, 0.000001, { threshold: 0 })).action).toBe("ENTER");
  });

  it("normalizes signed zero only through canonical producer semantics", () => {
    expect(Object.is(classify(root(-0, 0)).currentPortfolioState.currentWeight, -0)).toBe(false);
    expect(classify(root(-0, 0.1)).action).toBe("ENTER");
  });

  it("accepts an above-one target only when the upstream Omega artifact accepts it", () => {
    const decision = classify(root(0, 1.2));
    expect(decision.action).toBe("ENTER");
    expect(decision.canonicalTargetState.targetWeight).toBe(1.2);
  });

  it("fails closed for missing, forged, or temporally incompatible evidence", () => {
    const valid = root(0, 0.2);
    expect(classify(null).action).toBe("WAIT");
    expect(createCanonicalActionDecision({ assetId: "BTC", decisionTime: T0 + HOUR, asOf: T0 + HOUR, lifecycle: valid }).action).toBe("WAIT");
    expect(createCanonicalActionDecision({ assetId: "BTC", decisionTime: T0, asOf: T0, lifecycle: { ...valid, semanticIdentity: "sha256:forged" } }).action).toBe("WAIT");
    expect(createCanonicalActionDecision({ assetId: "PAXG", decisionTime: T0, asOf: T0, lifecycle: valid }).action).toBe("WAIT");
  });

  it("treats absent current and target asset keys according to the reviewed union/default-zero contract", () => {
    expect(classify(root(0, 0.2)).action).toBe("ENTER");
    expect(classify(root(0.2, 0)).action).toBe("EXIT");
  });

  it("fails closed on invalid execution lifecycle evidence", () => {
    const invalid = executionLifecycle(root(0, 0.4), { omitPrice: true });
    expect(invalid.lifecycleStatus).toBe("INVALID");
    expect(classify(invalid).action).toBe("WAIT");
    expect(classify(invalid).contradictions).toContain("ACTIVE_TARGET_LIFECYCLE_INVALID");
  });

  it("classifies newly authorized, partial, completed, and outstanding lifecycle states", () => {
    const newlyAuthorized = root(0, 0.5, { threshold: 0 });
    expect(classify(newlyAuthorized).action).toBe("ENTER");

    const partial = executionLifecycle(newlyAuthorized, { threshold: 0, commissionRate: 0.001, slippageBps: 5 });
    expect(partial.lifecycleStatus).toBe("ACTIVE");
    expect(classify(partial).action).toBe("REDUCE");

    const completed = executionLifecycle(root(0, 0.4));
    expect(completed.lifecycleStatus).toBe("COMPLETED");
    expect(classify(completed).action).toBe("HOLD");

    const outstandingRoot = root(0.2, 0.2000000005, { threshold: 0 });
    const outstanding = executionLifecycle(outstandingRoot, { threshold: 0 });
    expect(outstanding.transition).toBe("EXECUTION_OUTSTANDING");
    expect(classify(outstanding).action).toBe("ADD");
  });

  it("preserves same-economic reaffirmation and changed-target root semantics", () => {
    const initial = root(0, 0.4);
    const reaffirmedAssessment = assessment(0, 0.4, { decisionTime: T0 + HOUR, rationale: "explanation only changed" });
    const reaffirmed = advanceActiveTargetLifecycle(initial, reaffirmedAssessment);
    const reaffirmedDecision = classify(reaffirmed, T0 + HOUR);
    expect(reaffirmed.activeTargetRootIdentity).toBe(initial.activeTargetRootIdentity);
    expect(reaffirmedDecision.action).toBe("ENTER");
    expect(reaffirmedDecision.canonicalSourceIdentities.targetDecisionIdentity).toBe(reaffirmed.latestTargetDecisionIdentity);

    const changed = advanceActiveTargetLifecycle(reaffirmed, assessment(0, 0.2, { decisionTime: T0 + 2 * HOUR }));
    expect(changed.transition).toBe("ROOT_SUPERSEDED_BY_CHANGED_TARGET");
    expect(classify(changed, T0 + 2 * HOUR).action).toBe("ENTER");
  });

  it("starts a new classification root when a completed target later becomes unsatisfied", () => {
    const completed = executionLifecycle(root(0, 0.4));
    const drifted = advanceActiveTargetLifecycle(completed, assessment(0.2, 0.4, { decisionTime: T0 + 2 * HOUR }));
    expect(drifted.transition).toBe("ROOT_CREATED_AFTER_COMPLETION");
    expect(classify(drifted, T0 + 2 * HOUR).action).toBe("ADD");
  });

  it("does not manufacture a new economic action from explanatory target metadata", () => {
    const first = classify(root(0.2, 0.2, { rationale: "first" }));
    const second = classify(root(0.2, 0.2, { rationale: "changed explanation" }));
    expect(first.action).toBe("HOLD");
    expect(second.action).toBe("HOLD");
    expect(first.canonicalTargetState.economicTargetContentIdentity)
      .toBe(second.canonicalTargetState.economicTargetContentIdentity);
  });

  it("binds canonical valuation, Omega, Permission, Risk, planner, and lifecycle identities", () => {
    const lifecycle = root(0.2, 0.4);
    const decision = classify(lifecycle);
    expect(decision.currentPortfolioState.sourceSemanticIdentity).toBe(lifecycle.currentAssessment.valuationIdentity);
    expect(decision.canonicalTargetState.sourceSemanticIdentity).toBe(lifecycle.latestTargetDecisionIdentity);
    expect(decision.permissionStatus.sourceSemanticIdentities).toEqual(["sha256:permission"]);
    expect(decision.riskStatus.sourceSemanticIdentity).toBe("sha256:risk");
    expect(decision.lifecycleState.sourceSemanticIdentity).toBe(lifecycle.semanticIdentity);
    expect(decision.materialComparison.plannerPolicyIdentity).toMatch(/^sha256:/);
  });

  it("produces deterministic immutable identities without mutating canonical inputs", () => {
    const lifecycle = root(0.2, 0.4);
    const before = JSON.stringify(lifecycle);
    const first = classify(lifecycle);
    const second = classify(lifecycle);
    expect(first).toEqual(second);
    expect(first.semanticIdentity).toBe(second.semanticIdentity);
    expect(first.semanticIdentity).toMatch(/^sha256:/);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.canonicalEvidence)).toBe(true);
    expect(JSON.stringify(lifecycle)).toBe(before);
  });

  it("rejects forged action, weights, delta, source identities, and authority even with recomputed outer identity", () => {
    const decision = classify(root(0.2, 0.4));
    const mutations: Array<(draft: Record<string, any>) => void> = [
      (draft) => { draft.action = "EXIT"; },
      (draft) => { draft.currentPortfolioState.currentWeight = 0; },
      (draft) => { draft.canonicalTargetState.targetWeight = 0; },
      (draft) => { draft.deltaWeight = 999; },
      (draft) => { draft.canonicalSourceIdentities.valuationIdentity = "sha256:forged"; },
      (draft) => { draft.grantsExecutionAuthority = true; },
    ];
    for (const mutate of mutations) expect(() => validateActionDecision(forgedDecision(decision, mutate))).toThrow(/forged/);
  });

  it("rejects forged embedded lifecycle content even with recomputed ActionDecision identity", () => {
    const decision = classify(root(0.2, 0.4));
    const forged = forgedDecision(decision, (draft) => {
      draft.canonicalEvidence.currentAssessment.assetAssessments[0].currentWeight = 0;
    });
    expect(() => validateActionDecision(forged)).toThrow(/forged/);
  });

  it("cannot be consumed by ExecutionEngine as target authority", () => {
    const decision = classify(root(0, 0.2));
    expect(decision.consumableByExecutionAsTargetAuthority).toBe(false);
    expect(decision).not.toHaveProperty("assetWeights");
    expect(() => executeRebalance(account(0), decision as unknown as TargetPortfolioWeight, {
      BTC: { timestamp: T0 + HOUR, open: 100, high: 101, low: 99, close: 100, volume: 10_000 },
    }, {
      decisionTimestamp: T0,
      executionTimestamp: T0 + HOUR,
      executionRule: "NEXT_BAR_OPEN",
      commissionRate: 0,
      slippageConfig: { type: "FIXED_BPS", baseBps: 0 },
    })).toThrow();
  });

  it("is observational and leaves execution economics unchanged", () => {
    const lifecycle = root(0.2, 0.4);
    const targetValue = lifecycle.currentAssessment.target;
    const bars = { BTC: { timestamp: T0 + HOUR, open: 100, high: 101, low: 99, close: 100, volume: 10_000 } };
    const context = {
      decisionTimestamp: T0,
      executionTimestamp: T0 + HOUR,
      executionRule: "NEXT_BAR_OPEN" as const,
      commissionRate: 0.001,
      slippageConfig: { type: "FIXED_BPS" as const, baseBps: 5 },
    };
    const before = executeRebalance(lifecycle.currentAssessment.valuation.accountState, targetValue, bars, context);
    classify(lifecycle);
    const after = executeRebalance(lifecycle.currentAssessment.valuation.accountState, targetValue, bars, context);
    expect(after).toEqual(before);
  });

  it("retains deferred WAIT compatibility without starting persistence integration", () => {
    const deferred = createDeferredActionDecision({ assetId: "BTC", decisionTime: T0, asOf: T0 });
    expect(deferred.action).toBe("WAIT");
    expect(deferred.canonicalEvidence).toBeNull();
    expect(validateActionDecision(deferred)).toEqual(deferred);
    expect(deferred).not.toHaveProperty("persistence");
  });

  it("fails closed for non-finite and negative caller-authored boundaries", () => {
    expect(() => createCanonicalActionDecision({ assetId: "BTC", decisionTime: Number.NaN, asOf: T0, lifecycle: null })).toThrow();
    expect(() => createCanonicalActionDecision({ assetId: "BTC", decisionTime: T0, asOf: -1, lifecycle: null })).toThrow();
  });

  it("fails closed when unrelated multi-asset execution evidence makes lifecycle proof invalid", () => {
    const preExecutionAccount: PortfolioAccountState = {
      cash: 100,
      positions: {
        ETH: { assetId: "ETH", side: "LONG", status: "OPEN", quantity: 1, entryPrice: 100, unrealizedPnl: 0 },
      },
    };
    const preValuation = createCanonicalPortfolioValuationSnapshot({
      decisionTime: T0,
      account: preExecutionAccount,
      marks: [{ assetId: "ETH", bar: bar(T0) }],
      dataQuality: "LIVE",
    });
    const targetValue = target(0.8);
    const lifecycle = createActiveTargetLifecycleRoot(createTargetExecutionAssessment({ valuation: preValuation, target: targetValue }));
    const executionTime = T0 + HOUR;
    const assetBars = { BTC: { timestamp: executionTime, open: 100, high: 101, low: 99, close: 100, volume: 10_000 } };
    const context = {
      decisionTimestamp: T0,
      executionTimestamp: executionTime,
      executionRule: "NEXT_BAR_OPEN" as const,
      commissionRate: 0,
      slippageConfig: { type: "FIXED_BPS" as const, baseBps: 0 },
      lifecycleBinding: {
        targetDecisionIdentity: targetValue.provenance.targetDecisionIdentity,
        activeTargetRootIdentity: lifecycle.activeTargetRootIdentity,
      },
    };
    const executionResult = executeRebalance(preExecutionAccount, targetValue, assetBars, context);
    expect(executionResult.records.map((record) => record.assetId)).toEqual(["BTC"]);
    const postValuation = createCanonicalPortfolioValuationSnapshot({
      decisionTime: executionTime,
      account: executionResult.updatedAccount,
      marks: [
        { assetId: "BTC", bar: bar(executionTime) },
        { assetId: "ETH", bar: bar(executionTime) },
      ],
      dataQuality: "LIVE",
    });
    const executionEvidence = createExecutionBoundTargetAssessment({
      activeTargetRootIdentity: lifecycle.activeTargetRootIdentity,
      target: targetValue,
      preExecutionAccount,
      assetBars,
      context,
      executionResult,
      postExecutionValuation: postValuation,
    });
    expect(executionEvidence.status).toBe("INVALID_UNPROVABLE");
    const invalidLifecycle = reconcileActiveTargetLifecycleExecution(lifecycle, executionEvidence);
    expect(classify(invalidLifecycle).action).toBe("WAIT");
  });
});
