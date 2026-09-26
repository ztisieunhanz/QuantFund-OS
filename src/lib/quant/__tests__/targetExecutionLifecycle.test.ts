import { describe, expect, it } from "vitest";
import { createDeferredActionDecision } from "../actionDecision";
import { runBacktest } from "../backtestEngine";
import { getStorageApi, useTradingStore } from "@/stores/tradingStore";
import {
  CANONICAL_EXECUTION_PLANNER_POLICY,
  DEFAULT_MIN_REBALANCE_THRESHOLD_USD,
  executeRebalance,
  isExecutableRebalanceDelta,
  resolveExecutionPlannerPolicy,
  type PortfolioAccountState,
} from "../executionEngine";
import { createCanonicalPortfolioValuationSnapshot } from "../portfolioValuation";
import { producerIdentity } from "../producerProvenance";
import {
  activeTargetLifecycleSemanticIdentity,
  advanceActiveTargetLifecycle,
  createActiveTargetLifecycleRoot,
  createExecutionBoundTargetAssessment,
  createTargetExecutionAssessment,
  reconcileActiveTargetLifecycleExecution,
  validateActiveTargetLifecycle,
  validateActiveTargetLifecycleAgainstPrior,
  validateExecutionBoundTargetAssessment,
  validateTargetExecutionAssessment,
} from "../targetExecutionLifecycle";
import type { BacktestConfig, PointInTimeBar, ProvenancedTargetPortfolioWeight } from "../types";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 0, 1, 12);

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

function dualAssetAccount(): PortfolioAccountState {
  return {
    cash: 100,
    positions: {
      ETH: { assetId: "ETH", side: "LONG", status: "OPEN", quantity: 1, entryPrice: 100, unrealizedPnl: 0 },
    },
  };
}

function valuation(weight: number, decisionTime = T0) {
  return createCanonicalPortfolioValuationSnapshot({
    decisionTime,
    account: account(weight),
    marks: weight === 0 ? [] : [{ assetId: "BTC", bar: bar(decisionTime) }],
    dataQuality: "LIVE",
  });
}

function target(weight: number, decisionTime = T0, rationale = `target-${weight}`): ProvenancedTargetPortfolioWeight {
  const material = {
    asOfTimestamp: decisionTime,
    assetWeights: { BTC: weight },
    cashWeight: Math.round((1 - weight) * 1000) / 1000,
    grossExposure: weight,
    netExposure: weight,
    strategyAllocations: { ADAPTIVE_TREND: weight, EVENT_REACTION: 0, MEAN_REVERSION: 0 },
    riskAdjustmentRatio: 1,
    rationale,
  } as const;
  const { asOfTimestamp: _ignored, ...content } = material;
  const base = {
    schemaVersion: "M14_A04_TARGET_PROVENANCE_V1" as const,
    targetContentIdentity: producerIdentity(content),
    signalIdentities: ["sha256:signal"],
    permissionIdentities: ["sha256:permission"],
    riskIdentity: "sha256:risk",
    omegaConfigIdentity: "sha256:omega",
    correlationsIdentity: "NONE" as const,
  };
  return {
    ...material,
    provenance: { ...base, targetDecisionIdentity: producerIdentity({ ...base, asOfTimestamp: decisionTime }) },
  };
}

function assessment(currentWeight: number, targetWeight: number, decisionTime = T0, rationale?: string) {
  return createTargetExecutionAssessment({
    valuation: valuation(currentWeight, decisionTime),
    target: target(targetWeight, decisionTime, rationale),
  });
}

function executionEvidence(root: ReturnType<typeof createActiveTargetLifecycleRoot>, options?: {
  commissionRate?: number;
  slippageBps?: number;
  slippageType?: "FIXED_BPS" | "VOLUME_SHARE_IMPACT";
  threshold?: number;
  omitPrice?: boolean;
}) {
  const targetValue = root.currentAssessment.target;
  const preExecutionAccount = root.currentAssessment.valuation.accountState;
  const executionTime = targetValue.asOfTimestamp + HOUR;
  const assetBars: Readonly<Record<string, PointInTimeBar>> = options?.omitPrice ? {} : {
    BTC: { timestamp: executionTime, open: 100, high: 101, low: 99, close: 100, volume: 10_000 },
  };
  const context = {
    decisionTimestamp: targetValue.asOfTimestamp,
    executionTimestamp: executionTime,
    executionRule: "NEXT_BAR_OPEN" as const,
    commissionRate: options?.commissionRate ?? 0,
    slippageConfig: { type: options?.slippageType ?? "FIXED_BPS", baseBps: options?.slippageBps ?? 0, impactFactor: 0.1 },
    minRebalanceThresholdUsd: options?.threshold,
    lifecycleBinding: {
      targetDecisionIdentity: targetValue.provenance.targetDecisionIdentity,
      activeTargetRootIdentity: root.activeTargetRootIdentity,
    },
  };
  const executionResult = executeRebalance(preExecutionAccount, targetValue, assetBars, context);
  const marks = Object.entries(executionResult.updatedAccount.positions)
    .filter(([, position]) => position.quantity > 0)
    .map(([assetId]) => ({ assetId, bar: bar(executionTime) }));
  const postExecutionValuation = createCanonicalPortfolioValuationSnapshot({
    decisionTime: executionTime,
    account: executionResult.updatedAccount,
    marks,
    dataQuality: "LIVE",
  });
  const evidence = createExecutionBoundTargetAssessment({
    activeTargetRootIdentity: root.activeTargetRootIdentity,
    target: targetValue,
    preExecutionAccount,
    assetBars,
    context,
    executionResult,
    postExecutionValuation,
  });
  return { evidence, executionResult, context, assetBars, preExecutionAccount, postExecutionValuation };
}

function withLatestExecutionAssessment(
  lifecycle: ReturnType<typeof createActiveTargetLifecycleRoot>,
  latestExecutionAssessment: NonNullable<typeof lifecycle.latestExecutionAssessment>,
) {
  const { semanticIdentity: _identity, ...material } = lifecycle;
  const changed = { ...material, latestExecutionAssessment };
  return { ...changed, semanticIdentity: activeTargetLifecycleSemanticIdentity(changed) };
}

function replayBars(count = 132): PointInTimeBar[] {
  return Array.from({ length: count }, (_, index) => ({
    timestamp: 1_700_000_000_000 + index * HOUR,
    open: 100 + index,
    high: 101 + index,
    low: 99 + index,
    close: 100.5 + index,
    volume: 10_000,
  }));
}

function replayConfig(runId: string): BacktestConfig {
  return {
    runId,
    startDate: 0,
    endDate: 0,
    warmupPeriod: 125,
    initialCapital: 10_000,
    commissionRate: 0.001,
    slippageModel: { type: "FIXED_BPS", baseBps: 5 },
    executionRule: "NEXT_BAR_OPEN",
    requirePitExecution: true,
    deterministicSeed: 42,
    dataQuality: "LIVE",
  };
}

describe("M14 A-04 Step 3 execution assessment and target lineage", () => {
  it("creates deterministic, deeply immutable execution assessment identity", () => {
    const first = assessment(0.2, 0.4);
    const second = assessment(0.2, 0.4);
    expect(first).toEqual(second);
    expect(first.semanticIdentity).toMatch(/^sha256:/);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.assetAssessments)).toBe(true);
    validateTargetExecutionAssessment(first);
  });

  it("rejects forged assessment output and embedded canonical evidence", () => {
    const value = assessment(0.2, 0.4);
    expect(() => validateTargetExecutionAssessment({ ...value, status: "ALREADY_SATISFIED" })).toThrow(/mismatch/);
    expect(() => validateTargetExecutionAssessment({ ...value, semanticIdentity: "sha256:forged" })).toThrow(/mismatch/);
    expect(() => validateTargetExecutionAssessment({ ...value, valuation: { ...value.valuation, nav: 999 } })).toThrow();
  });

  it("classifies target already satisfied under canonical minimum-rebalance semantics", () => {
    const value = assessment(0.2, 0.24);
    expect(value.status).toBe("ALREADY_SATISFIED");
    expect(value.assetAssessments[0]).toMatchObject({ relation: "SATISFIED_UNDER_EXECUTION_POLICY", executableUnderPolicy: false, deltaNotionalUsd: 40 });
  });

  it("distinguishes executable entry and increase", () => {
    expect(assessment(0, 0.2).assetAssessments[0].relation).toBe("INCREASE_FROM_ZERO");
    expect(assessment(0.2, 0.4).assetAssessments[0].relation).toBe("INCREASE_FROM_POSITIVE");
    expect(assessment(0.2, 0.4).status).toBe("REQUIRES_EXECUTABLE_INCREASE");
  });

  it("distinguishes executable decrease and exit to zero", () => {
    expect(assessment(0.4, 0.2).status).toBe("REQUIRES_EXECUTABLE_DECREASE");
    expect(assessment(0.4, 0.2).assetAssessments[0].relation).toBe("DECREASE_TO_POSITIVE");
    expect(assessment(0.4, 0).status).toBe("REQUIRES_EXIT_TO_ZERO");
    expect(assessment(0.4, 0).assetAssessments[0].relation).toBe("EXIT_TO_ZERO");
  });

  it("reuses the exact execution planner threshold including its equality boundary", () => {
    expect(CANONICAL_EXECUTION_PLANNER_POLICY.minimumRebalanceThresholdUsd).toBe(DEFAULT_MIN_REBALANCE_THRESHOLD_USD);
    expect(isExecutableRebalanceDelta(49.999, CANONICAL_EXECUTION_PLANNER_POLICY)).toBe(false);
    expect(isExecutableRebalanceDelta(50, CANONICAL_EXECUTION_PLANNER_POLICY)).toBe(true);
    expect(isExecutableRebalanceDelta(0, resolveExecutionPlannerPolicy(0))).toBe(false);
    expect(isExecutableRebalanceDelta(0.001, resolveExecutionPlannerPolicy(0))).toBe(true);
    expect(isExecutableRebalanceDelta(74.999, resolveExecutionPlannerPolicy(75))).toBe(false);
    expect(isExecutableRebalanceDelta(75, resolveExecutionPlannerPolicy(75))).toBe(true);
    expect(assessment(0.2, 0.249).status).toBe("ALREADY_SATISFIED");
    expect(assessment(0.2, 0.25).status).toBe("REQUIRES_EXECUTABLE_INCREASE");
    const executionBar = { BTC: { timestamp: T0 + HOUR, open: 100, high: 101, low: 99, close: 100, volume: 10_000 } };
    const baseContext = {
      decisionTimestamp: T0,
      executionTimestamp: T0 + HOUR,
      executionRule: "NEXT_BAR_OPEN" as const,
      commissionRate: 0,
      slippageConfig: { type: "FIXED_BPS" as const, baseBps: 0 },
    };
    expect(executeRebalance(account(0), target(0.05), executionBar, baseContext).records).toHaveLength(1);
    expect(executeRebalance(account(0), target(0.05), executionBar, { ...baseContext, minRebalanceThresholdUsd: 75 }).records).toHaveLength(0);
    expect(executeRebalance(account(0), target(0), executionBar, { ...baseContext, minRebalanceThresholdUsd: 0 }).records).toHaveLength(0);
    expect(executeRebalance(account(0), target(0.001), executionBar, { ...baseContext, minRebalanceThresholdUsd: 0 }).records).toHaveLength(1);
  });

  it("preserves baseline fills when an unrelated held asset lacks an execution price", () => {
    const preExecutionAccount = dualAssetAccount();
    const executionTime = T0 + HOUR;
    const targetValue = target(0.8, T0);
    const preValuation = createCanonicalPortfolioValuationSnapshot({
      decisionTime: T0,
      account: preExecutionAccount,
      marks: [{ assetId: "ETH", bar: bar(T0) }],
      dataQuality: "LIVE",
    });
    const root = createActiveTargetLifecycleRoot(createTargetExecutionAssessment({ valuation: preValuation, target: targetValue }));
    const context = {
      decisionTimestamp: T0,
      executionTimestamp: executionTime,
      executionRule: "NEXT_BAR_OPEN" as const,
      commissionRate: 0,
      slippageConfig: { type: "FIXED_BPS" as const, baseBps: 0 },
      lifecycleBinding: {
        targetDecisionIdentity: targetValue.provenance.targetDecisionIdentity,
        activeTargetRootIdentity: root.activeTargetRootIdentity,
      },
    };
    const result = executeRebalance(preExecutionAccount, targetValue, {
      BTC: { timestamp: executionTime, open: 100, high: 100, low: 100, close: 100, volume: 10_000 },
    }, context);

    expect(result.records.map((record) => record.assetId)).toEqual(["BTC"]);
    expect(result.updatedAccount.cash).toBe(20);
    expect(result.updatedAccount.positions.BTC?.quantity).toBe(0.8);
    expect(result.updatedAccount.positions.ETH?.quantity).toBe(1);
    expect(result.records[0].notionalUsd).toBe(80);

    const postValuation = createCanonicalPortfolioValuationSnapshot({
      decisionTime: executionTime,
      account: result.updatedAccount,
      marks: [
        { assetId: "BTC", bar: bar(executionTime) },
        { assetId: "ETH", bar: bar(executionTime) },
      ],
      dataQuality: "LIVE",
    });
    const evidence = createExecutionBoundTargetAssessment({
      activeTargetRootIdentity: root.activeTargetRootIdentity,
      target: targetValue,
      preExecutionAccount,
      assetBars: { BTC: { timestamp: executionTime, open: 100, high: 100, low: 100, close: 100, volume: 10_000 } },
      context,
      executionResult: result,
      postExecutionValuation: postValuation,
    });
    expect(evidence.status).toBe("INVALID_UNPROVABLE");
  });

  it("does not repurpose Step-2 1e-12 reconciliation as lifecycle tolerance", () => {
    const belowPlanner = assessment(0.2, 0.200000000001);
    expect(belowPlanner.status).toBe("ALREADY_SATISFIED");
    expect(belowPlanner.plannerPolicy.minimumRebalanceThresholdUsd).toBe(50);
  });

  it("creates a new active root with exact target and valuation lineage", () => {
    const value = assessment(0, 0.4);
    const root = createActiveTargetLifecycleRoot(value);
    expect(root).toMatchObject({ transition: "ROOT_CREATED", lifecycleStatus: "ACTIVE", rootEconomicTargetContentIdentity: value.economicTargetContentIdentity });
    expect(root.rootAssessment.assetAssessments[0].relation).toBe("INCREASE_FROM_ZERO");
    validateActiveTargetLifecycle(root);
  });

  it("does not infer completion from decision-bound close evidence alone", () => {
    const root = createActiveTargetLifecycleRoot(assessment(0.4, 0.4, T0));
    expect(root.currentAssessment.status).toBe("ALREADY_SATISFIED");
    expect(root.lifecycleStatus).toBe("ACTIVE");
    expect(root.latestExecutionAssessment).toBeNull();
    const execution = executionEvidence(root);
    expect(execution.evidence.executionRecords).toHaveLength(0);
    expect(reconcileActiveTargetLifecycleExecution(root, execution.evidence).lifecycleStatus).toBe("COMPLETED");
  });

  it("preserves root lineage when the identical unresolved target is reissued later", () => {
    const root = createActiveTargetLifecycleRoot(assessment(0, 0.4, T0));
    const repeated = advanceActiveTargetLifecycle(root, assessment(0, 0.4, T0 + HOUR));
    expect(repeated.transition).toBe("ROOT_REAFFIRMED_UNRESOLVED");
    expect(repeated.rootTargetDecisionIdentity).toBe(root.rootTargetDecisionIdentity);
    expect(repeated.latestTargetDecisionIdentity).not.toBe(root.latestTargetDecisionIdentity);
    validateActiveTargetLifecycleAgainstPrior(repeated, root);
  });

  it("preserves an entry root across partial execution of the same target", () => {
    const root = createActiveTargetLifecycleRoot(assessment(0, 0.5, T0));
    const { evidence } = executionEvidence(root, { commissionRate: 0.001, slippageBps: 5, threshold: 0 });
    expect(evidence.status).toBe("PARTIALLY_SATISFIED_EXECUTABLE_RESIDUAL");
    const partial = reconcileActiveTargetLifecycleExecution(root, evidence);
    expect(partial.transition).toBe("EXECUTION_PARTIALLY_SATISFIED");
    expect(partial.lifecycleStatus).toBe("ACTIVE");
    expect(partial.rootAssessment.assetAssessments[0].relation).toBe("INCREASE_FROM_ZERO");
    expect(partial.activeTargetRootIdentity).toBe(root.activeTargetRootIdentity);
    validateActiveTargetLifecycleAgainstPrior(partial, root);
  });

  it("supersedes a changed target and roots it in the current post-fill state", () => {
    const root = createActiveTargetLifecycleRoot(assessment(0, 0.4, T0));
    const completedExecution = executionEvidence(root);
    const completed = reconcileActiveTargetLifecycleExecution(root, completedExecution.evidence);
    const changedAssessment = createTargetExecutionAssessment({
      valuation: completedExecution.postExecutionValuation,
      target: target(0.1, T0 + HOUR),
    });
    const changed = advanceActiveTargetLifecycle(completed, changedAssessment);
    expect(changed.transition).toBe("ROOT_SUPERSEDED_BY_CHANGED_TARGET");
    expect(changed.supersededRootLifecycleIdentity).toBe(completed.semanticIdentity);
    expect(changed.rootAssessment.assetAssessments[0]).toMatchObject({ targetWeight: 0.1, relation: "DECREASE_TO_POSITIVE" });
    expect(changed.rootEconomicTargetContentIdentity).not.toBe(root.rootEconomicTargetContentIdentity);
  });

  it("binds actual fills and deterministic pre/post accounts, then proves completion", () => {
    const root = createActiveTargetLifecycleRoot(assessment(0, 0.4, T0));
    const { evidence } = executionEvidence(root);
    expect(evidence.status).toBe("SATISFIED_AFTER_CANONICAL_EXECUTION");
    expect(evidence.executionRecords).toHaveLength(1);
    expect(evidence.executionRecords[0].lifecycleBinding).toMatchObject({
      targetDecisionIdentity: root.latestTargetDecisionIdentity,
      activeTargetRootIdentity: root.activeTargetRootIdentity,
      preExecutionAccountIdentity: evidence.preExecutionAccountIdentity,
      executionPlanIdentity: evidence.preExecutionPlan.semanticIdentity,
    });
    expect(evidence.postExecutionAccountIdentity).not.toBe(evidence.preExecutionAccountIdentity);
    validateExecutionBoundTargetAssessment(evidence);
    const completed = reconcileActiveTargetLifecycleExecution(root, evidence);
    expect(completed).toMatchObject({ transition: "EXECUTION_SATISFIED", lifecycleStatus: "COMPLETED" });
    expect(completed.rootTargetDecisionIdentity).toBe(root.rootTargetDecisionIdentity);
  });

  it("reaffirms a completed root without manufacturing a new transition", () => {
    const root = createActiveTargetLifecycleRoot(assessment(0, 0.4, T0));
    const execution = executionEvidence(root);
    const completed = reconcileActiveTargetLifecycleExecution(root, execution.evidence);
    const reaffirmedAssessment = createTargetExecutionAssessment({
      valuation: execution.postExecutionValuation,
      target: target(0.4, T0 + HOUR, "changed explanation"),
    });
    const reaffirmed = advanceActiveTargetLifecycle(completed, reaffirmedAssessment);
    expect(reaffirmed.transition).toBe("COMPLETED_ROOT_REAFFIRMED");
    expect(reaffirmed.rootTargetDecisionIdentity).toBe(root.rootTargetDecisionIdentity);
    expect(reaffirmed.activeTargetRootIdentity).toBe(root.activeTargetRootIdentity);
  });

  it("creates a new root if a completed target later becomes unsatisfied", () => {
    const root = createActiveTargetLifecycleRoot(assessment(0, 0.4, T0));
    const execution = executionEvidence(root);
    const completed = reconcileActiveTargetLifecycleExecution(root, execution.evidence);
    const drifted = advanceActiveTargetLifecycle(completed, assessment(0.2, 0.4, T0 + 2 * HOUR));
    expect(drifted.transition).toBe("ROOT_CREATED_AFTER_COMPLETION");
    expect(drifted.rootAssessment.assetAssessments[0].relation).toBe("INCREASE_FROM_POSITIVE");
    expect(drifted.rootTargetDecisionIdentity).toBe(drifted.currentAssessment.targetDecisionIdentity);
    expect(drifted.predecessorLifecycleIdentity).toBe(completed.semanticIdentity);
    validateActiveTargetLifecycleAgainstPrior(drifted, completed);
  });

  it("preserves a partial root when economic weights match despite changed rationale", () => {
    const root = createActiveTargetLifecycleRoot(assessment(0, 0.5, T0, "first rationale"));
    const execution = executionEvidence(root, { commissionRate: 0.001, slippageBps: 5, threshold: 0 });
    const partial = reconcileActiveTargetLifecycleExecution(root, execution.evidence);
    const repeatedAssessment = createTargetExecutionAssessment({
      valuation: execution.postExecutionValuation,
      target: target(0.5, T0 + HOUR, "different rationale and upstream explanation"),
      plannerPolicy: resolveExecutionPlannerPolicy(0),
    });
    expect(repeatedAssessment.targetContentIdentity).not.toBe(root.rootAssessment.targetContentIdentity);
    expect(repeatedAssessment.economicTargetContentIdentity).toBe(root.rootAssessment.economicTargetContentIdentity);
    const repeated = advanceActiveTargetLifecycle(partial, repeatedAssessment);
    expect(repeated.transition).toBe("ROOT_REAFFIRMED_UNRESOLVED");
    expect(repeated.activeTargetRootIdentity).toBe(root.activeTargetRootIdentity);
    expect(repeated.latestExecutionAssessment?.targetDecisionIdentity).toBe(root.latestTargetDecisionIdentity);
    expect(repeated.latestExecutionAssessment?.targetDecisionIdentity).not.toBe(repeated.latestTargetDecisionIdentity);
    validateActiveTargetLifecycle(repeated);
  });

  it("validates retained execution evidence on every non-execution lifecycle transition", () => {
    const root = createActiveTargetLifecycleRoot(assessment(0, 0.5, T0));
    const partialEvidence = executionEvidence(root, { commissionRate: 0.001, slippageBps: 5, threshold: 0 }).evidence;
    const partial = reconcileActiveTargetLifecycleExecution(root, partialEvidence);
    const reaffirmed = advanceActiveTargetLifecycle(partial, createTargetExecutionAssessment({
      valuation: partialEvidence.postExecutionValuation,
      target: target(0.5, T0 + HOUR, "reaffirmed target"),
      plannerPolicy: resolveExecutionPlannerPolicy(0),
    }));

    const forgedNested = { ...partialEvidence, semanticIdentity: "sha256:forged" };
    expect(() => validateActiveTargetLifecycle(withLatestExecutionAssessment(
      reaffirmed,
      forgedNested as typeof partialEvidence,
    ))).toThrow();

    const sameEconomicOtherRoot = createActiveTargetLifecycleRoot(assessment(0, 0.5, T0 + 4 * HOUR));
    const wrongRoot = executionEvidence(sameEconomicOtherRoot, { commissionRate: 0.001, slippageBps: 5, threshold: 0 }).evidence;
    expect(() => validateActiveTargetLifecycle(withLatestExecutionAssessment(reaffirmed, wrongRoot))).toThrow(/root binding/);

    const changedEconomicRoot = createActiveTargetLifecycleRoot(assessment(0, 0.3, T0 + 4 * HOUR));
    const wrongEconomic = executionEvidence(changedEconomicRoot).evidence;
    expect(() => validateActiveTargetLifecycle(withLatestExecutionAssessment(reaffirmed, wrongEconomic))).toThrow(/root binding/);

    const laterDecision = advanceActiveTargetLifecycle(root, assessment(0, 0.5, T0 + HOUR));
    const futureExecution = executionEvidence(laterDecision).evidence;
    expect(() => validateActiveTargetLifecycle(withLatestExecutionAssessment(laterDecision, futureExecution))).toThrow(/cannot postdate/);
  });

  it("wires canonical replay fills to the active target root and reconciles transient lifecycle evidence", () => {
    const bars = replayBars();
    const first = runBacktest(replayConfig("lifecycle-replay-a"), { assetBars: { BTC: bars } });
    const second = runBacktest(replayConfig("lifecycle-replay-b"), { assetBars: { BTC: bars } });
    const boundRecords = first.targetLifecycleEvidence
      .flatMap((lifecycle) => lifecycle.latestExecutionAssessment?.executionRecords ?? [])
      .filter((record) => record.lifecycleBinding);
    const executionLifecycles = first.targetLifecycleEvidence.filter((item) => item.transition.startsWith("EXECUTION_"));

    expect(boundRecords.length).toBeGreaterThan(0);
    expect(executionLifecycles.length).toBeGreaterThan(0);
    for (const record of boundRecords) {
      expect(record.lifecycleBinding?.targetDecisionIdentity).toMatch(/^sha256:/);
      expect(record.lifecycleBinding?.activeTargetRootIdentity).toMatch(/^sha256:/);
    }
    for (const lifecycle of executionLifecycles) validateActiveTargetLifecycle(lifecycle);
    const actualAssessment = executionLifecycles[0].latestExecutionAssessment!;
    const { lifecycleBinding: _binding, ...unboundContext } = actualAssessment.executionContext;
    const unboundBars = Object.fromEntries(actualAssessment.executionPriceEvidence.map((item) => [item.assetId, {
      timestamp: item.timestamp,
      open: item.price,
      high: item.price,
      low: item.price,
      close: item.price,
      volume: item.volume ?? 0,
    }]));
    const unboundResult = executeRebalance(
      actualAssessment.preExecutionAccount,
      actualAssessment.target,
      unboundBars,
      unboundContext,
    );
    const economicRecords = (records: typeof actualAssessment.executionRecords) => records.map(({ lifecycleBinding: _lineage, ...record }) => record);
    expect(actualAssessment.executionResult.updatedAccount).toEqual(unboundResult.updatedAccount);
    expect(economicRecords(actualAssessment.executionResult.records)).toEqual(economicRecords(unboundResult.records));
    expect(first.timeline.every((state) => !("targetLifecycleEvidence" in state))).toBe(true);
    expect(first.timeline.flatMap((state) => state.executions).every((record) => !("lifecycleBinding" in record))).toBe(true);
    expect(first.timeline.map(({ executions: _executions, ...state }) => state))
      .toEqual(second.timeline.map(({ executions: _executions, ...state }) => state));
    expect(first.metrics).toEqual(second.metrics);
  });

  it("keeps Step-3 lifecycle metadata out of PaperEngine and tradingStore persistence", async () => {
    const bars = replayBars().map((item) => ({
      time: item.timestamp,
      open: item.open,
      high: item.high,
      low: item.low,
      close: item.close,
      volume: item.volume,
    }));
    const store = useTradingStore.getState();
    store.runOnBars(bars, { interval: "1h", source: "live" });
    const latestDecision = useTradingStore.getState().latestDecision;
    expect(latestDecision).not.toBeNull();
    expect(latestDecision?.executions.some((record) => "lifecycleBinding" in record)).toBe(false);

    const storage = getStorageApi();
    const raw = storage.getItem("quant_paper_engine_state");
    expect(raw).not.toBeNull();
    const persisted = JSON.parse(raw!) as { state: { latestDecision: Record<string, unknown> } };
    expect(persisted.state.latestDecision).not.toHaveProperty("targetLifecycleEvidence");
    expect((persisted.state.latestDecision.executions as Array<Record<string, unknown>>).some((record) => "lifecycleBinding" in record)).toBe(false);

    const forged = structuredClone(persisted);
    forged.state.latestDecision.executions = [
      ...(forged.state.latestDecision.executions as Array<Record<string, unknown>>),
      { lifecycleBinding: { forged: true } },
    ];
    storage.setItem("quant_paper_engine_state", JSON.stringify(forged));
    await useTradingStore.persist.rehydrate();
    expect(useTradingStore.getState().latestDecision).toBeNull();
    useTradingStore.getState().reset();
  });

  it("marks missing execution price evidence invalid instead of satisfied", () => {
    const root = createActiveTargetLifecycleRoot(assessment(0, 0.4, T0));
    const execution = executionEvidence(root, { omitPrice: true });
    expect(execution.evidence.status).toBe("INVALID_UNPROVABLE");
    expect(execution.evidence.executionRecords).toHaveLength(0);
    const invalid = reconcileActiveTargetLifecycleExecution(root, execution.evidence);
    expect(invalid).toMatchObject({ transition: "EXECUTION_INVALID", lifecycleStatus: "INVALID" });
  });

  it("does not prove lifecycle completion from current-candle volume-dependent execution", () => {
    const root = createActiveTargetLifecycleRoot(assessment(0, 0.4, T0));
    const execution = executionEvidence(root, { slippageType: "VOLUME_SHARE_IMPACT" });
    expect(execution.evidence.status).toBe("INVALID_UNPROVABLE");
  });

  it("rejects forged fill, account, target, and root bindings even with a recomputed outer identity", () => {
    const root = createActiveTargetLifecycleRoot(assessment(0, 0.4, T0));
    const { evidence } = executionEvidence(root);
    const forgedRecord = {
      ...evidence.executionRecords[0],
      lifecycleBinding: { ...evidence.executionRecords[0].lifecycleBinding!, fillIdentity: "sha256:forged" },
    };
    const forgedExecutionResult = { ...evidence.executionResult, records: [forgedRecord] };
    const { semanticIdentity: _fillIdentity, ...fillMaterial } = {
      ...evidence,
      executionResult: forgedExecutionResult,
      executionRecords: forgedExecutionResult.records,
    };
    expect(() => validateExecutionBoundTargetAssessment({
      ...fillMaterial,
      semanticIdentity: producerIdentity(fillMaterial),
    })).toThrow();

    const { semanticIdentity: _accountIdentity, ...accountMaterial } = evidence;
    const forgedAccountMaterial = { ...accountMaterial, preExecutionAccount: { ...accountMaterial.preExecutionAccount, cash: 999 } };
    expect(() => validateExecutionBoundTargetAssessment({
      ...forgedAccountMaterial,
      semanticIdentity: producerIdentity(forgedAccountMaterial),
    })).toThrow();

    const otherRoot = createActiveTargetLifecycleRoot(assessment(0, 0.3, T0));
    expect(() => reconcileActiveTargetLifecycleExecution(otherRoot, evidence)).toThrow(/active target root/);
  });

  it("represents an executable residual with no fill as outstanding", () => {
    const root = createActiveTargetLifecycleRoot(assessment(0.2, 0.2000000005, T0));
    const execution = executionEvidence(root, { threshold: 0 });
    expect(execution.evidence.executionRecords).toHaveLength(0);
    expect(execution.evidence.status).toBe("OUTSTANDING_UNEXECUTED");
  });

  it("fails closed on absent, forged, or non-monotonic prior lineage", () => {
    const root = createActiveTargetLifecycleRoot(assessment(0, 0.4, T0));
    expect(() => advanceActiveTargetLifecycle(null as unknown as typeof root, assessment(0.2, 0.4, T0 + HOUR))).toThrow();
    expect(() => advanceActiveTargetLifecycle({ ...root, semanticIdentity: "sha256:forged" }, assessment(0.2, 0.4, T0 + HOUR))).toThrow();
    expect(() => advanceActiveTargetLifecycle(root, assessment(0.2, 0.4, T0))).toThrow(/increase strictly/);
  });

  it("rejects forged lifecycle authority and transition even with recomputed identity", () => {
    const root = createActiveTargetLifecycleRoot(assessment(0, 0.4, T0));
    const { semanticIdentity: _authorityIdentity, ...authorityMaterial } = root;
    const forgedAuthorityMaterial = { ...authorityMaterial, grantsExecutionAuthority: true };
    expect(() => validateActiveTargetLifecycle({
      ...forgedAuthorityMaterial,
      semanticIdentity: producerIdentity(forgedAuthorityMaterial),
    } as unknown as typeof root)).toThrow(/cannot grant authority/);

    const { semanticIdentity: _transitionIdentity, ...transitionMaterial } = root;
    const forgedTransitionMaterial = { ...transitionMaterial, transition: "FORGED_TRANSITION" };
    expect(() => validateActiveTargetLifecycle({
      ...forgedTransitionMaterial,
      semanticIdentity: producerIdentity(forgedTransitionMaterial),
    } as unknown as typeof root)).toThrow(/Invalid active target lifecycle transition/);
  });

  it("rejects mismatched target/valuation time and forged target provenance", () => {
    expect(() => createTargetExecutionAssessment({ valuation: valuation(0.2, T0), target: target(0.4, T0 + HOUR) })).toThrow(/decisionTime mismatch/);
    const forged = target(0.4, T0);
    expect(() => createTargetExecutionAssessment({
      valuation: valuation(0.2, T0),
      target: {
        ...forged,
        provenance: { ...forged.provenance, targetContentIdentity: "sha256:forged" },
      },
    })).toThrow(/identity mismatch/);
  });

  it("rejects synthetic or unbound valuation evidence as canonical", () => {
    expect(() => createCanonicalPortfolioValuationSnapshot({ decisionTime: T0, account: account(0.2), marks: [{ assetId: "BTC", bar: bar(T0) }], dataQuality: "SYNTHETIC" })).toThrow(/requires LIVE/);
  });

  it("keeps ActionDecision WAIT-only after Step 3", () => {
    const action = createDeferredActionDecision({ assetId: "BTC", decisionTime: T0, asOf: T0 });
    expect(action.action).toBe("WAIT");
    expect(action.currentlyDerivableActions).toEqual(["WAIT"]);
    expect(action.grantsExecutionAuthority).toBe(false);
  });

  it("does not mutate target, valuation, account, or authority flags", () => {
    const v = valuation(0.2);
    const t = target(0.4);
    const beforeV = JSON.stringify(v);
    const beforeT = JSON.stringify(t);
    const value = createTargetExecutionAssessment({ valuation: v, target: t });
    expect(JSON.stringify(v)).toBe(beforeV);
    expect(JSON.stringify(t)).toBe(beforeT);
    expect(value).toMatchObject({ modifiesTargetWeight: false, grantsExecutionAuthority: false, grantsAccountingAuthority: false });
  });

  it("assessment is observational and leaves canonical execution/fills/accounting unchanged", () => {
    const v = valuation(0.2);
    const t = target(0.4);
    const executionBar = { BTC: { ...bar(T0 + HOUR), open: 100 } };
    const context = {
      decisionTimestamp: T0,
      executionTimestamp: T0 + HOUR,
      executionRule: "NEXT_BAR_OPEN" as const,
      commissionRate: 0.001,
      slippageConfig: { type: "FIXED_BPS" as const, baseBps: 5 },
    };
    const withoutAssessment = executeRebalance(v.accountState, t, executionBar, context);
    createTargetExecutionAssessment({ valuation: v, target: t });
    const withAssessment = executeRebalance(v.accountState, t, executionBar, context);
    expect(withAssessment).toEqual(withoutAssessment);
  });

  it("produces deterministic lifecycle identity stability", () => {
    const a = createActiveTargetLifecycleRoot(assessment(0, 0.4));
    const b = createActiveTargetLifecycleRoot(assessment(0, 0.4));
    expect(a.semanticIdentity).toBe(b.semanticIdentity);
    expect(a).toEqual(b);
  });
});
