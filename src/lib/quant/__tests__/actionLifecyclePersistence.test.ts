import { beforeEach, describe, expect, it } from "vitest";
import {
  createDurableTargetLifecycleCheckpoint,
  createDurableTargetLifecycleCheckpointFromReplay,
  parseAndRestoreDurableTargetLifecycleCheckpoint,
  reconstructActionDecisionFromCheckpoint,
  serializeDurableTargetLifecycleCheckpoint,
  validateDurableTargetLifecycleCheckpoint,
  type DurableTargetLifecycleCheckpoint,
} from "../actionLifecyclePersistence";
import { runBacktest, type BacktestResult } from "../backtestEngine";
import { executeRebalance, type PortfolioAccountState } from "../executionEngine";
import { createCanonicalPortfolioValuationSnapshot } from "../portfolioValuation";
import { createRiskOutput, producerIdentity } from "../producerProvenance";
import {
  activeTargetLifecycleSemanticIdentity,
  advanceActiveTargetLifecycle,
  createActiveTargetLifecycleRoot,
  createExecutionBoundTargetAssessment,
  createTargetExecutionAssessment,
  reconcileActiveTargetLifecycleExecution,
  type ActiveTargetLifecycle,
} from "../targetExecutionLifecycle";
import type {
  BacktestConfig,
  DecisionState,
  PointInTimeBar,
  ProvenancedTargetPortfolioWeight,
} from "../types";
import { getStorageApi, useTradingStore } from "@/stores/tradingStore";

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
    cashWeight: Math.max(0, 1 - weight),
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

function assessment(currentWeight: number, targetWeight: number, decisionTime = T0) {
  return createTargetExecutionAssessment({
    valuation: valuation(currentWeight, decisionTime),
    target: target(targetWeight, decisionTime),
  });
}

function root(currentWeight: number, targetWeight: number): ActiveTargetLifecycle {
  return createActiveTargetLifecycleRoot(assessment(currentWeight, targetWeight));
}

function executeLifecycle(lifecycle: ActiveTargetLifecycle, omitPrice = false): ActiveTargetLifecycle {
  const targetValue = lifecycle.currentAssessment.target;
  const preExecutionAccount = lifecycle.currentAssessment.valuation.accountState;
  const executionTime = targetValue.asOfTimestamp + HOUR;
  const assetBars: Readonly<Record<string, PointInTimeBar>> = omitPrice ? {} : {
    BTC: { timestamp: executionTime, open: 100, high: 101, low: 99, close: 100, volume: 10_000 },
  };
  const context = {
    decisionTimestamp: targetValue.asOfTimestamp,
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
  const postExecutionValuation = createCanonicalPortfolioValuationSnapshot({
    decisionTime: executionTime,
    account: executionResult.updatedAccount,
    marks: Object.entries(executionResult.updatedAccount.positions)
      .filter(([, position]) => position.quantity > 0)
      .map(([assetId]) => ({ assetId, bar: bar(executionTime) })),
    dataQuality: "LIVE",
  });
  return reconcileActiveTargetLifecycleExecution(lifecycle, createExecutionBoundTargetAssessment({
    activeTargetRootIdentity: lifecycle.activeTargetRootIdentity,
    target: targetValue,
    preExecutionAccount,
    assetBars,
    context,
    executionResult,
    postExecutionValuation,
  }));
}

function terminalAfterExecution(executed: ActiveTargetLifecycle): ActiveTargetLifecycle {
  const postWeight = executed.latestExecutionAssessment?.postExecutionValuation.assetWeights.BTC ?? 0;
  const targetWeight = executed.currentAssessment.target.assetWeights.BTC ?? 0;
  return advanceActiveTargetLifecycle(executed, assessment(postWeight, targetWeight, T0 + HOUR));
}

function decisionFor(lifecycle: ActiveTargetLifecycle): DecisionState {
  const current = lifecycle.currentAssessment;
  const riskMaterial = {
    scope: "PORTFOLIO_AGGREGATE" as const,
    targetExposure: 0,
    grossExposure: 0,
    targetVolatility: 0,
    realizedVol: 0,
    forecastVol: 0,
    riskFlags: [] as const,
    circuitBreakerStatus: "NORMAL" as const,
    circuitBreakerReason: "fixture",
  };
  return {
    barIndex: 126,
    timestamp: current.decisionTime,
    nav: current.valuation.nav,
    cash: current.valuation.cash,
    positions: current.valuation.accountState.positions,
    signals: [],
    permissions: [],
    risk: createRiskOutput(riskMaterial, current.decisionTime, current.valuation.nav, current.valuation.nav, [], {}, {}, {}, current.valuationIdentity),
    targetWeights: current.target,
    executions: [],
    dailyPnl: 0,
    cumulativePnl: 0,
    currentDrawdown: 0,
  };
}

function checkpointFor(
  lifecycle: ActiveTargetLifecycle,
  lineageWitness: readonly ActiveTargetLifecycle[] = [],
): DurableTargetLifecycleCheckpoint {
  return createDurableTargetLifecycleCheckpoint({
    actionAssetId: "BTC",
    lifecycleEvidence: [...lineageWitness, lifecycle],
    decisionState: decisionFor(lifecycle),
  });
}

function refreshCheckpointIdentity(
  checkpoint: DurableTargetLifecycleCheckpoint,
  decisionState?: DecisionState,
): DurableTargetLifecycleCheckpoint {
  const draft = clone(checkpoint) as any;
  if (decisionState) draft.decisionStateIdentity = producerIdentity(decisionState);
  const { semanticIdentity: _ignored, ...material } = draft;
  draft.semanticIdentity = producerIdentity(material);
  return draft;
}

function refreshTerminalLifecycleIdentity(checkpoint: DurableTargetLifecycleCheckpoint): DurableTargetLifecycleCheckpoint {
  const draft = clone(checkpoint) as any;
  const { semanticIdentity: _ignoredLifecycle, ...lifecycleMaterial } = draft.lifecycle;
  draft.lifecycle.semanticIdentity = activeTargetLifecycleSemanticIdentity(lifecycleMaterial);
  draft.lifecycleIdentity = draft.lifecycle.semanticIdentity;
  return refreshCheckpointIdentity(draft);
}

function productionBars(count = 145) {
  return Array.from({ length: count }, (_, index) => {
    const price = 100 + index * 0.8;
    return { timestamp: T0 + index * HOUR, open: price, high: price + 2, low: price - 2, close: price + 1, volume: 10_000 };
  });
}

function productionReplay(): BacktestResult {
  const config: BacktestConfig = {
    runId: "step5-production-replay",
    startDate: 0,
    endDate: 0,
    warmupPeriod: 125,
    initialCapital: 10_000,
    commissionRate: 0.001,
    slippageModel: { type: "FIXED_BPS", baseBps: 5 },
    executionRule: "NEXT_BAR_OPEN",
    requirePitExecution: true,
    deterministicSeed: 20260926,
    dataQuality: "LIVE",
  };
  return runBacktest(config, { assetBars: { BTC: productionBars() }, benchmarkAssetId: "BTC" });
}

describe("M14 A-04 Step 5 durable lifecycle persistence", () => {
  beforeEach(() => {
    getStorageApi().clear();
    useTradingStore.getState().reset();
  });

  it("round-trips cold JSON and reconstructs an identical immutable ActionDecision", () => {
    const lifecycle = root(0, 0.2);
    const decision = decisionFor(lifecycle);
    const checkpoint = checkpointFor(lifecycle);
    const before = reconstructActionDecisionFromCheckpoint(checkpoint, decision).actionDecision;
    const restored = parseAndRestoreDurableTargetLifecycleCheckpoint(
      serializeDurableTargetLifecycleCheckpoint(checkpoint, decision),
      clone(decision),
    );
    expect(restored.actionDecision.semanticIdentity).toBe(before.semanticIdentity);
    expect(restored.actionDecision.action).toBe("ENTER");
    expect(Object.isFrozen(restored.checkpoint)).toBe(true);
    expect(Object.isFrozen(restored.checkpoint.lifecycle)).toBe(true);
  });

  it("round-trips reviewed root, reaffirmed, partial, outstanding, completed, superseded, and post-completion-root states", () => {
    const initial = root(0, 0.5);
    const reaffirmedAssessment = createTargetExecutionAssessment({
      valuation: valuation(0, T0 + HOUR),
      target: target(0.5, T0 + HOUR, "explanation-only-change"),
    });
    const reaffirmed = advanceActiveTargetLifecycle(initial, reaffirmedAssessment);
    const partialRoot = root(0, 1.2);
    const partialExecution = executeLifecycle(partialRoot);
    const partial = terminalAfterExecution(partialExecution);
    const outstandingRoot = root(1, 1.2);
    const outstandingExecution = executeLifecycle(outstandingRoot);
    const outstanding = terminalAfterExecution(outstandingExecution);
    const completedRoot = root(0, 0.5);
    const completedExecution = executeLifecycle(completedRoot);
    const completed = terminalAfterExecution(completedExecution);
    const completedReaffirmed = advanceActiveTargetLifecycle(completed, assessment(0.5, 0.5, T0 + 2 * HOUR));
    const superseded = advanceActiveTargetLifecycle(initial, assessment(0, 0.7, T0 + HOUR));
    const postCompletionRoot = advanceActiveTargetLifecycle(completed, assessment(0.2, 0.5, T0 + 2 * HOUR));

    expect(partial.latestExecutionAssessment?.status).toBe("PARTIALLY_SATISFIED_EXECUTABLE_RESIDUAL");
    expect(outstanding.latestExecutionAssessment?.status).toBe("OUTSTANDING_UNEXECUTED");
    expect(completed.lifecycleStatus).toBe("COMPLETED");
    expect(reaffirmed.activeTargetRootIdentity).toBe(initial.activeTargetRootIdentity);
    expect(reaffirmed.rootTargetDecisionIdentity).toBe(initial.rootTargetDecisionIdentity);
    expect(reaffirmed.latestTargetDecisionIdentity).not.toBe(initial.latestTargetDecisionIdentity);
    expect(superseded.transition).toBe("ROOT_SUPERSEDED_BY_CHANGED_TARGET");
    expect(postCompletionRoot.transition).toBe("ROOT_CREATED_AFTER_COMPLETION");

    const cases = [
      { lifecycle: initial, lineageWitness: [] },
      { lifecycle: reaffirmed, lineageWitness: [initial] },
      { lifecycle: partial, lineageWitness: [partialRoot, partialExecution] },
      { lifecycle: outstanding, lineageWitness: [outstandingRoot, outstandingExecution] },
      { lifecycle: completed, lineageWitness: [completedRoot, completedExecution] },
      { lifecycle: completedReaffirmed, lineageWitness: [completedRoot, completedExecution, completed] },
      { lifecycle: superseded, lineageWitness: [initial] },
      { lifecycle: postCompletionRoot, lineageWitness: [completedRoot, completedExecution, completed] },
    ];
    for (const { lifecycle, lineageWitness } of cases) {
      const decision = decisionFor(lifecycle);
      const checkpoint = checkpointFor(lifecycle, lineageWitness);
      const restored = parseAndRestoreDurableTargetLifecycleCheckpoint(JSON.stringify(checkpoint), clone(decision));
      expect(restored.checkpoint.lifecycle.semanticIdentity).toBe(lifecycle.semanticIdentity);
      expect(restored.checkpoint.lifecycle.activeTargetRootIdentity).toBe(lifecycle.activeTargetRootIdentity);
      expect(restored.checkpoint.lifecycle.lifecycleStatus).toBe(lifecycle.lifecycleStatus);
      expect(restored.checkpoint.lifecycle.transition).toBe(lifecycle.transition);
    }
  });

  it("preserves a canonically invalid lifecycle only as fail-closed WAIT evidence", () => {
    const initial = root(0, 0.2);
    const invalid = executeLifecycle(initial, true);
    const checkpoint = checkpointFor(invalid, [initial]);
    const restored = parseAndRestoreDurableTargetLifecycleCheckpoint(JSON.stringify(checkpoint), decisionFor(invalid));
    expect(restored.checkpoint.lifecycle.lifecycleStatus).toBe("INVALID");
    expect(restored.actionDecision.action).toBe("WAIT");
  });

  it("rejects unsupported versions, malformed shape, deleted fields, and extra authority fields", () => {
    const lifecycle = root(0, 0.2);
    const decision = decisionFor(lifecycle);
    const checkpoint = checkpointFor(lifecycle);
    const mutations: Array<(draft: any) => void> = [
      (draft) => { draft.schemaVersion = "M14_A04_DURABLE_TARGET_LIFECYCLE_CHECKPOINT_V999"; },
      (draft) => { delete draft.lifecycle; },
      (draft) => { draft.grantsExecutionAuthority = true; },
      (draft) => { draft.authoritativeTargetWeight = 0.9; },
    ];
    for (const mutate of mutations) {
      const forged = clone(checkpoint) as any;
      mutate(forged);
      expect(() => validateDurableTargetLifecycleCheckpoint(forged, decision)).toThrow();
    }
  });

  it("rejects forged serialized nested lifecycle, root, target, valuation, weight, status, transition, and time evidence", () => {
    const initial = root(0, 0.5);
    const executed = executeLifecycle(initial);
    const lifecycle = terminalAfterExecution(executed);
    const decision = decisionFor(lifecycle);
    const checkpoint = checkpointFor(lifecycle, [initial, executed]);
    const mutations: Array<(draft: any) => void> = [
      (draft) => { draft.lifecycle.semanticIdentity = "sha256:forged"; },
      (draft) => { draft.lifecycle.activeTargetRootIdentity = "sha256:forged"; },
      (draft) => { draft.lifecycle.currentAssessment.targetDecisionIdentity = "sha256:forged"; },
      (draft) => { draft.lifecycle.currentAssessment.economicTargetContentIdentity = "sha256:forged"; },
      (draft) => { draft.lifecycle.currentAssessment.target.provenance.riskIdentity = "sha256:forged"; },
      (draft) => { draft.lifecycle.currentAssessment.valuation.semanticIdentity = "sha256:forged"; },
      (draft) => { draft.lifecycle.currentAssessment.assetAssessments[0].currentWeight += 0.1; },
      (draft) => { draft.lifecycle.currentAssessment.target.assetWeights.BTC += 0.1; },
      (draft) => { draft.lifecycle.latestExecutionAssessment.semanticIdentity = "sha256:forged"; },
      (draft) => { draft.lifecycle.latestExecutionAssessment.preExecutionPlan.semanticIdentity = "sha256:forged"; },
      (draft) => { draft.lifecycle.latestExecutionAssessment.preExecutionPlan.plannerPolicy.policyIdentity = "sha256:forged"; },
      (draft) => { draft.lifecycle.latestExecutionAssessment.preExecutionAccount.cash += 1; },
      (draft) => { draft.lifecycle.latestExecutionAssessment.postExecutionAccountIdentity = "sha256:forged"; },
      (draft) => { draft.lifecycle.latestExecutionAssessment.executionRecords[0].lifecycleBinding.fillIdentity = "sha256:forged"; },
      (draft) => { draft.lifecycle.lifecycleStatus = "ACTIVE"; },
      (draft) => { draft.lifecycle.transition = "ROOT_CREATED"; },
      (draft) => { draft.lifecycle.latestDecisionTime += HOUR; },
    ];
    for (const mutate of mutations) {
      const forged = clone(checkpoint) as any;
      mutate(forged);
      expect(() => reconstructActionDecisionFromCheckpoint(forged, clone(decision))).toThrow();
    }
  });

  it("rejects nested forgery even when attacker recomputes lifecycle and checkpoint outer identities", () => {
    const lifecycle = root(0, 0.2);
    const decision = decisionFor(lifecycle);
    const forged = clone(checkpointFor(lifecycle)) as any;
    forged.lifecycle.currentAssessment.valuation.nav += 1;
    const { semanticIdentity: _lifecycleIdentity, ...lifecycleMaterial } = forged.lifecycle;
    forged.lifecycle.semanticIdentity = activeTargetLifecycleSemanticIdentity(lifecycleMaterial);
    forged.lifecycleIdentity = forged.lifecycle.semanticIdentity;
    const { semanticIdentity: _checkpointIdentity, ...checkpointMaterial } = forged;
    forged.semanticIdentity = producerIdentity(checkpointMaterial);
    expect(() => reconstructActionDecisionFromCheckpoint(forged, decision)).toThrow();
  });

  it("binds the checkpoint to the exact DecisionState and rejects stale or contradictory pairing", () => {
    const lifecycle = root(0, 0.2);
    const decision = decisionFor(lifecycle);
    const checkpoint = checkpointFor(lifecycle);
    expect(() => validateDurableTargetLifecycleCheckpoint(checkpoint, { ...decision, timestamp: decision.timestamp + HOUR })).toThrow();
    expect(() => validateDurableTargetLifecycleCheckpoint(checkpoint, { ...decision, nav: decision.nav + 1 })).toThrow();
    expect(() => validateDurableTargetLifecycleCheckpoint(checkpoint, { ...decision, targetWeights: target(0.3, decision.timestamp) })).toThrow();
  });

  it("binds Risk valuation provenance while allowing the authorized PIT/accounting mark difference", () => {
    const replay = productionReplay();
    const decision = replay.timeline.at(-1)!;
    const lifecycle = replay.targetLifecycleEvidence.at(-1)!;
    expect(decision.nav).not.toBe(lifecycle.currentAssessment.valuation.nav);
    expect(decision.positions.BTC?.unrealizedPnl).not.toBe(
      lifecycle.currentAssessment.valuation.accountState.positions.BTC?.unrealizedPnl,
    );
    expect(decision.risk.provenance?.valuationIdentity).toBe(lifecycle.currentAssessment.valuationIdentity);
    const checkpoint = createDurableTargetLifecycleCheckpointFromReplay({
      actionAssetId: "BTC",
      lifecycleEvidence: replay.targetLifecycleEvidence,
      decisionState: decision,
    });
    expect(() => reconstructActionDecisionFromCheckpoint(checkpoint, clone(decision))).not.toThrow();
  });

  it("rejects a semantically valid Risk artifact bound to another valuation identity", () => {
    const lifecycle = root(0, 0.2);
    const decision = decisionFor(lifecycle);
    const { provenance: _provenance, ...riskMaterial } = decision.risk;
    const forgedDecision = {
      ...decision,
      risk: createRiskOutput(riskMaterial, decision.timestamp, 1_000, 1_000, [], {}, {}, {}, "sha256:other-valuation"),
    };
    const checkpoint = refreshCheckpointIdentity(checkpointFor(lifecycle), forgedDecision);
    expect(() => reconstructActionDecisionFromCheckpoint(checkpoint, forgedDecision)).toThrow(/Risk valuation binding/);
  });

  it("rejects a different valid lifecycle valuation when Risk remains bound to the original", () => {
    const baseAccount = account(0.2, 1_000);
    const firstValuation = createCanonicalPortfolioValuationSnapshot({
      decisionTime: T0,
      account: baseAccount,
      marks: [{ assetId: "BTC", bar: bar(T0, 100) }],
      dataQuality: "LIVE",
    });
    const otherValuation = createCanonicalPortfolioValuationSnapshot({
      decisionTime: T0,
      account: baseAccount,
      marks: [{ assetId: "BTC", bar: bar(T0, 101) }],
      dataQuality: "LIVE",
    });
    const currentTarget = target(0.2);
    const first = createActiveTargetLifecycleRoot(createTargetExecutionAssessment({ valuation: firstValuation, target: currentTarget }));
    const other = createActiveTargetLifecycleRoot(createTargetExecutionAssessment({ valuation: otherValuation, target: currentTarget }));
    const decision = decisionFor(first);
    const checkpoint = refreshCheckpointIdentity(checkpointFor(other), decision);
    expect(() => reconstructActionDecisionFromCheckpoint(checkpoint, decision)).toThrow(/Risk valuation binding/);
  });

  it("rejects mark-invariant cash and inventory mismatches even with refreshed outer checkpoint identity", () => {
    const lifecycle = root(0.2, 0.3);
    const decision = decisionFor(lifecycle);
    const checkpoint = checkpointFor(lifecycle);
    const cashMismatch = { ...decision, cash: decision.cash + 1 };
    const quantityMismatch = {
      ...decision,
      positions: { ...decision.positions, BTC: { ...decision.positions.BTC, quantity: decision.positions.BTC.quantity + 0.01 } },
    };
    expect(() => reconstructActionDecisionFromCheckpoint(refreshCheckpointIdentity(checkpoint, cashMismatch), cashMismatch)).toThrow(/ledger-inventory/);
    expect(() => reconstructActionDecisionFromCheckpoint(refreshCheckpointIdentity(checkpoint, quantityMismatch), quantityMismatch)).toThrow(/ledger-inventory/);
  });

  it("cold-validates every predecessor and rejects missing, wrong, reordered, or duplicate lineage", () => {
    const initial = root(0, 0.5);
    const executed = executeLifecycle(initial);
    const completed = terminalAfterExecution(executed);
    const checkpoint = checkpointFor(completed, [initial, executed]);
    const decision = decisionFor(completed);
    const unrelated = root(0, 0.7);
    const mutations: Array<(draft: any) => void> = [
      (draft) => { draft.lineageWitness = []; },
      (draft) => { draft.lineageWitness[0] = unrelated; },
      (draft) => { draft.lineageWitness.reverse(); },
      (draft) => { draft.lineageWitness.splice(1, 0, clone(draft.lineageWitness[0])); },
      (draft) => { draft.lineageWitness.push(clone(draft.lifecycle)); },
      (draft) => { draft.lineageWitness[1].latestExecutionAssessment.semanticIdentity = "sha256:forged"; },
      (draft) => { draft.lineageWitness[0].schemaVersion = "M14_A04_ACTIVE_TARGET_LIFECYCLE_V999"; },
    ];
    for (const mutate of mutations) {
      const forged = clone(checkpoint) as any;
      mutate(forged);
      const { semanticIdentity: _ignored, ...material } = forged;
      forged.semanticIdentity = producerIdentity(material);
      expect(() => reconstructActionDecisionFromCheckpoint(forged, decision)).toThrow();
    }
  });

  it("rejects recomputed predecessor and supersession forgeries against the persisted canonical witness", () => {
    const initial = root(0, 0.5);
    const reaffirmed = advanceActiveTargetLifecycle(initial, assessment(0, 0.5, T0 + HOUR));
    const superseded = advanceActiveTargetLifecycle(initial, assessment(0, 0.7, T0 + HOUR));
    const completedRoot = root(0, 0.5);
    const completedExecution = executeLifecycle(completedRoot);
    const completed = terminalAfterExecution(completedExecution);
    const postCompletion = advanceActiveTargetLifecycle(completed, assessment(0.2, 0.5, T0 + 2 * HOUR));
    const cases = [
      { checkpoint: checkpointFor(reaffirmed, [initial]), decision: decisionFor(reaffirmed), mutate: (draft: any) => { draft.lifecycle.predecessorLifecycleIdentity = "sha256:wrong-predecessor"; } },
      { checkpoint: checkpointFor(superseded, [initial]), decision: decisionFor(superseded), mutate: (draft: any) => { draft.lifecycle.supersededRootLifecycleIdentity = "sha256:wrong-superseded-root"; } },
      { checkpoint: checkpointFor(postCompletion, [completedRoot, completedExecution, completed]), decision: decisionFor(postCompletion), mutate: (draft: any) => { draft.lifecycle.predecessorLifecycleIdentity = "sha256:wrong-completed-predecessor"; } },
    ];
    for (const item of cases) {
      const forged = clone(item.checkpoint) as any;
      item.mutate(forged);
      const refreshed = refreshTerminalLifecycleIdentity(forged);
      expect(() => reconstructActionDecisionFromCheckpoint(refreshed, item.decision)).toThrow(/prior-lineage mismatch/);
    }
  });

  it("closes the real runBacktest production path and preserves classification identity after cold restore", () => {
    const replay = productionReplay();
    const decision = replay.timeline.at(-1)!;
    expect(replay.targetLifecycleEvidence.length).toBeGreaterThan(0);
    const checkpoint = createDurableTargetLifecycleCheckpointFromReplay({
      actionAssetId: "BTC",
      lifecycleEvidence: replay.targetLifecycleEvidence,
      decisionState: decision,
    });
    const before = reconstructActionDecisionFromCheckpoint(checkpoint, decision).actionDecision;
    const restored = parseAndRestoreDurableTargetLifecycleCheckpoint(JSON.stringify(checkpoint), clone(decision));
    expect(restored.actionDecision.semanticIdentity).toBe(before.semanticIdentity);
    expect(restored.actionDecision.action).toBe(before.action);
    expect(restored.checkpoint.lifecycle.semanticIdentity).toBe(replay.targetLifecycleEvidence.at(-1)?.semanticIdentity);
  });

  it("does not alter canonical replay economics", () => {
    const before = productionReplay();
    const after = productionReplay();
    const decision = after.timeline.at(-1)!;
    const checkpoint = createDurableTargetLifecycleCheckpointFromReplay({ actionAssetId: "BTC", lifecycleEvidence: after.targetLifecycleEvidence, decisionState: decision });
    reconstructActionDecisionFromCheckpoint(checkpoint, decision);
    expect(after.timeline).toEqual(before.timeline);
    expect(after.metrics).toEqual(before.metrics);
    expect(after.targetLifecycleEvidence).toEqual(before.targetLifecycleEvidence);
  });

  it("persists one checkpoint, reconstructs ActionDecision, and never persists ActionDecision as a second source", () => {
    const bars = productionBars().map((item) => ({ time: item.timestamp, open: item.open, high: item.high, low: item.low, close: item.close, volume: item.volume }));
    useTradingStore.getState().runOnBars(bars, { interval: "1h", source: "live" });
    const before = useTradingStore.getState();
    expect(before.lifecycleCheckpoint).not.toBeNull();
    expect(before.actionDecision).not.toBeNull();
    const raw = getStorageApi().getItem("quant_paper_engine_state")!;
    const payload = JSON.parse(raw);
    expect(payload.version).toBe(2);
    expect(payload.state.lifecycleCheckpoint).not.toBeNull();
    expect(payload.state.actionDecision).toBeUndefined();
    expect(payload.state.omega).toBeUndefined();

    const expectedIdentity = before.actionDecision!.semanticIdentity;
    useTradingStore.getState().reset();
    getStorageApi().setItem("quant_paper_engine_state", raw);
    useTradingStore.persist.rehydrate();
    const restored = useTradingStore.getState();
    expect(restored.actionDecision?.semanticIdentity).toBe(expectedIdentity);
    expect(restored.lifecycleCheckpoint?.semanticIdentity).toBe(before.lifecycleCheckpoint?.semanticIdentity);
    expect(restored.isRestored).toBe(true);
  });

  it("keeps synthetic replay explicitly unbound from durable canonical lifecycle/action evidence", () => {
    const bars = productionBars().map((item) => ({ time: item.timestamp, open: item.open, high: item.high, low: item.low, close: item.close, volume: item.volume }));
    useTradingStore.getState().runOnBars(bars, { interval: "1h", source: "synthetic" });
    const state = useTradingStore.getState();
    expect(state.latestDecision).not.toBeNull();
    expect(state.lifecycleCheckpoint).toBeNull();
    expect(state.actionDecision).toBeNull();
  });

  it("fails closed only the forged lifecycle sidecar while retaining an independently valid DecisionState", () => {
    const bars = productionBars().map((item) => ({ time: item.timestamp, open: item.open, high: item.high, low: item.low, close: item.close, volume: item.volume }));
    useTradingStore.getState().runOnBars(bars, { interval: "1h", source: "live" });
    const payload = JSON.parse(getStorageApi().getItem("quant_paper_engine_state")!);
    payload.state.lifecycleCheckpoint.lifecycle.semanticIdentity = "sha256:forged";
    useTradingStore.getState().reset();
    getStorageApi().setItem("quant_paper_engine_state", JSON.stringify(payload));
    useTradingStore.persist.rehydrate();
    const restored = useTradingStore.getState();
    expect(restored.latestDecision).not.toBeNull();
    expect(restored.lifecycleCheckpoint).toBeNull();
    expect(restored.actionDecision).toBeNull();
    expect(restored.isRestored).toBe(true);
  });

  it("migrates legacy v1 DecisionState without fabricating lifecycle or ActionDecision", () => {
    const lifecycle = root(0, 0.2);
    const decision = decisionFor(lifecycle);
    getStorageApi().setItem("quant_paper_engine_state", JSON.stringify({ state: { latestDecision: decision, lastRunAt: T0 }, version: 1 }));
    useTradingStore.persist.rehydrate();
    const restored = useTradingStore.getState();
    expect(restored.latestDecision).toEqual(decision);
    expect(restored.lifecycleCheckpoint).toBeNull();
    expect(restored.actionDecision).toBeNull();
  });

  it("rejects unknown future store versions and reset clears all durable and derived lifecycle state", () => {
    const bars = productionBars().map((item) => ({ time: item.timestamp, open: item.open, high: item.high, low: item.low, close: item.close, volume: item.volume }));
    useTradingStore.getState().runOnBars(bars, { interval: "1h", source: "live" });
    expect(useTradingStore.getState().lifecycleCheckpoint).not.toBeNull();
    useTradingStore.getState().reset();
    expect(useTradingStore.getState().latestDecision).toBeNull();
    expect(useTradingStore.getState().lifecycleCheckpoint).toBeNull();
    expect(useTradingStore.getState().actionDecision).toBeNull();

    const decision = decisionFor(root(0, 0.2));
    getStorageApi().setItem("quant_paper_engine_state", JSON.stringify({ state: { latestDecision: decision, lastRunAt: T0 }, version: 999 }));
    useTradingStore.persist.rehydrate();
    expect(useTradingStore.getState().latestDecision).toBeNull();
    expect(useTradingStore.getState().lifecycleCheckpoint).toBeNull();
    expect(useTradingStore.getState().actionDecision).toBeNull();
  });
});
