import { beforeEach, describe, expect, it } from "vitest";
import {
  createCanonicalActionDecision,
  validateActionDecision,
} from "../actionDecision";
import {
  createDurableTargetLifecycleCheckpoint,
  createDurableTargetLifecycleCheckpointFromReplay,
  reconstructActionDecisionFromCheckpoint,
  validateDurableTargetLifecycleCheckpoint,
} from "../actionLifecyclePersistence";
import { runBacktest, type BacktestDataset } from "../backtestEngine";
import { evaluateAdaptiveTrend, DEFAULT_ADAPTIVE_TREND_CONFIG } from "../adaptiveTrend";
import { evaluateEventReaction, DEFAULT_EVENT_REACTION_CONFIG } from "../eventReaction";
import { evaluateMeanReversion, DEFAULT_MEAN_REVERSION_CONFIG } from "../meanReversion";
import { evaluatePermission, DEFAULT_PERMISSION_CONFIG } from "../permissionGate";
import { createInitialRiskState, evaluatePortfolioRisk, DEFAULT_RISK_ENGINE_CONFIG } from "../riskEngine";
import { evaluateOmegaAllocation, DEFAULT_OMEGA_CONFIG } from "../omegaAllocator";
import type { PortfolioAccountState } from "../executionEngine";
import {
  createCanonicalPortfolioValuationSnapshot,
  validateCanonicalPortfolioValuationSnapshot,
} from "../portfolioValuation";
import {
  producerIdentity,
} from "../producerProvenance";
import {
  createActiveTargetLifecycleRoot,
  createTargetExecutionAssessment,
  type ActiveTargetLifecycle,
} from "../targetExecutionLifecycle";
import type {
  BacktestConfig,
  DecisionState,
  PointInTimeBar,
  ProvenancedTargetPortfolioWeight,
  StrategyContext,
  StrategyState,
} from "../types";
import { getStorageApi, useTradingStore } from "@/stores/tradingStore";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 0, 1, 12);

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function bar(decisionTime: number, price = 100): PointInTimeBar {
  return {
    timestamp: decisionTime - HOUR,
    open: price,
    high: price + 1,
    low: price - 1,
    close: price,
    volume: 10_000,
  };
}

function makeAccount(weight: number, nav = 1_000): PortfolioAccountState {
  const quantity = (weight * nav) / 100;
  return {
    cash: nav - quantity * 100,
    positions:
      quantity === 0
        ? {}
        : {
            BTC: {
              assetId: "BTC",
              side: "LONG",
              status: "OPEN",
              quantity,
              entryPrice: 100,
              unrealizedPnl: 0,
            },
          },
  };
}

function makeValuation(weight: number, decisionTime = T0, nav = 1_000) {
  return createCanonicalPortfolioValuationSnapshot({
    decisionTime,
    account: makeAccount(weight, nav),
    marks: weight === 0 ? [] : [{ assetId: "BTC", bar: bar(decisionTime) }],
    dataQuality: "LIVE",
  });
}

function makeTarget(
  weight: number,
  decisionTime = T0,
  rationale = `target-${weight}`,
): ProvenancedTargetPortfolioWeight {
  const assetWeights: Readonly<Record<string, number>> =
    weight === 0 ? {} : { BTC: weight };
  const material = {
    asOfTimestamp: decisionTime,
    assetWeights,
    cashWeight: Math.max(0, 1 - weight),
    grossExposure: weight,
    netExposure: weight,
    strategyAllocations: {
      ADAPTIVE_TREND: weight,
      EVENT_REACTION: 0,
      MEAN_REVERSION: 0,
    },
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
  return {
    ...material,
    provenance: {
      ...provenance,
      targetDecisionIdentity: producerIdentity({
        ...provenance,
        asOfTimestamp: decisionTime,
      }),
    },
  };
}

function makeAssessment(
  currentWeight: number,
  targetWeight: number,
  decisionTime = T0,
) {
  return createTargetExecutionAssessment({
    valuation: makeValuation(currentWeight, decisionTime),
    target: makeTarget(targetWeight, decisionTime),
  });
}

function makeRoot(currentWeight: number, targetWeight: number): ActiveTargetLifecycle {
  return createActiveTargetLifecycleRoot(makeAssessment(currentWeight, targetWeight));
}

function generateBars(count: number, startPrice = 100, seed = 42): PointInTimeBar[] {
  const bars: PointInTimeBar[] = [];
  let price = startPrice;
  let t = Date.UTC(2026, 0, 1, 0);
  let state = seed;
  const lcg = () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
  for (let i = 0; i < count; i++) {
    const change = (lcg() - 0.48) * 2;
    price = Math.max(10, price + change);
    bars.push({
      timestamp: t,
      open: price,
      high: price + 0.5,
      low: price - 0.5,
      close: price,
      volume: 1000 + lcg() * 500,
    });
    t += HOUR;
  }
  return bars;
}

describe("M14 / A-04 Step 6 — Closure Audit and Invariant Verification", () => {
  beforeEach(() => {
    getStorageApi().clear();
    useTradingStore.getState().reset();
  });

  it("1. audits the complete end-to-end A-04 chain across Steps 1–5", () => {
    const priceHistory = generateBars(150);
    const lastBar = priceHistory[priceHistory.length - 1];
    const decisionTime = lastBar.timestamp + HOUR;

    // Step 1: Producer Provenance
    const ctx: StrategyContext = {
      strategyId: "ADAPTIVE_TREND",
      assetId: "BTC",
      currentBarTimestamp: lastBar.timestamp,
      decisionTimestamp: decisionTime,
      currentPrice: lastBar.close,
      priceHistory,
      macro: null,
      latestEvent: null,
    };
    const stratState: StrategyState = {
      strategyId: "ADAPTIVE_TREND",
      lastEvaluationTimestamp: 0,
      barsSinceLastSignal: 0,
      internalValues: {},
    };

    const trendSignal = evaluateAdaptiveTrend(ctx, stratState, DEFAULT_ADAPTIVE_TREND_CONFIG);
    expect(trendSignal.provenance.schemaVersion).toBe("M14_A04_SIGNAL_PROVENANCE_V1");
    expect(trendSignal.provenance.semanticIdentity).toMatch(/^sha256:[0-9a-f]{64}$/);

    const eventSignal = evaluateEventReaction({ ...ctx, strategyId: "EVENT_REACTION" }, { ...stratState, strategyId: "EVENT_REACTION" }, DEFAULT_EVENT_REACTION_CONFIG);
    const meanSignal = evaluateMeanReversion({ ...ctx, strategyId: "MEAN_REVERSION" }, { ...stratState, strategyId: "MEAN_REVERSION" }, DEFAULT_MEAN_REVERSION_CONFIG);
    const signals = [trendSignal, eventSignal, meanSignal];

    const permissions = [
      evaluatePermission("ADAPTIVE_TREND", null, DEFAULT_PERMISSION_CONFIG, decisionTime),
      evaluatePermission("EVENT_REACTION", null, DEFAULT_PERMISSION_CONFIG, decisionTime),
      evaluatePermission("MEAN_REVERSION", null, DEFAULT_PERMISSION_CONFIG, decisionTime),
    ];
    expect(permissions[0].provenance.schemaVersion).toBe("M14_A04_PERMISSION_PROVENANCE_V1");

    // Step 2: Canonical Portfolio Valuation Witness
    const valuationSnap = createCanonicalPortfolioValuationSnapshot({
      decisionTime,
      account: makeAccount(0, 10_000),
      marks: [],
      dataQuality: "LIVE",
    });
    expect(valuationSnap.schemaVersion).toBe("M14_A04_PORTFOLIO_VALUATION_V1");
    validateCanonicalPortfolioValuationSnapshot(valuationSnap);

    const { risk: riskOutput } = evaluatePortfolioRisk(
      10_000,
      10_000,
      priceHistory,
      createInitialRiskState(),
      DEFAULT_RISK_ENGINE_CONFIG,
      decisionTime,
      valuationSnap,
    );
    expect(riskOutput.provenance.valuationBindingStatus).toBe("BOUND_CANONICAL_VALUATION");
    expect(riskOutput.provenance.valuationIdentity).toBe(valuationSnap.semanticIdentity);

    const omegaTargets = evaluateOmegaAllocation(
      signals,
      permissions,
      riskOutput,
      null,
      decisionTime,
      DEFAULT_OMEGA_CONFIG,
    );
    expect(omegaTargets.provenance.schemaVersion).toBe("M14_A04_TARGET_PROVENANCE_V1");
    expect(omegaTargets.provenance.riskIdentity).toBe(riskOutput.provenance.semanticIdentity);

    // Step 3: Target Execution Lifecycle & Assessment
    const targetVal = omegaTargets;
    const targetAssessment = createTargetExecutionAssessment({
      valuation: valuationSnap,
      target: targetVal,
    });
    expect(targetAssessment.kind).toBe("TARGET_EXECUTION_ASSESSMENT");

    const activeLifecycle = createActiveTargetLifecycleRoot(targetAssessment);
    expect(activeLifecycle.kind).toBe("ACTIVE_TARGET_LIFECYCLE");
    expect(activeLifecycle.transition).toBe("ROOT_CREATED");

    // Step 4: Canonical ActionDecision Classification
    const actionDecision = createCanonicalActionDecision({
      assetId: "BTC",
      decisionTime,
      asOf: decisionTime,
      lifecycle: activeLifecycle,
    });
    expect(actionDecision.kind).toBe("ACTION_DECISION");
    expect(actionDecision.canonicalSourceIdentities.targetDecisionIdentity).toBe(targetVal.provenance.targetDecisionIdentity);
    validateActionDecision(actionDecision);

    // Step 5: Durable Lifecycle Recovery Checkpoint
    const decisionState: DecisionState = {
      barIndex: 149,
      timestamp: decisionTime,
      nav: 10_000,
      cash: 10_000,
      positions: {},
      signals,
      permissions,
      risk: riskOutput,
      targetWeights: omegaTargets,
      executions: [],
      dailyPnl: 0,
      cumulativePnl: 0,
      currentDrawdown: 0,
    };

    const durableCheckpoint = createDurableTargetLifecycleCheckpoint({
      actionAssetId: "BTC",
      lifecycleEvidence: [activeLifecycle],
      decisionState,
    });
    expect(durableCheckpoint.kind).toBe("DURABLE_TARGET_LIFECYCLE_CHECKPOINT");
    expect(durableCheckpoint.schemaVersion).toBe("M14_A04_DURABLE_TARGET_LIFECYCLE_CHECKPOINT_V2");
  });

  it("2. verifies exactly one authority path for target weights, fills, accounting, and price", () => {
    const valuationSnap = makeValuation(0);
    const assessmentVal = makeAssessment(0, 0.3);
    const lifecycleRoot = makeRoot(0, 0.3);
    const actionDecision = createCanonicalActionDecision({
      assetId: "BTC",
      decisionTime: T0,
      asOf: T0,
      lifecycle: lifecycleRoot,
    });

    // Valuation snapshot price authority points to BacktestDataset.assetBars
    expect(valuationSnap.priceAuthority).toBe("BACKTEST_DATASET_ASSET_BARS");

    // Target assessment has zero authority flags
    expect(assessmentVal.modifiesTargetWeight).toBe(false);
    expect(assessmentVal.grantsExecutionAuthority).toBe(false);
    expect(assessmentVal.grantsAccountingAuthority).toBe(false);
    expect(assessmentVal.priceAuthority).toBe("NONE_DERIVED_FROM_CANONICAL_VALUATION");

    // Active lifecycle has zero authority flags
    expect(lifecycleRoot.grantsExecutionAuthority).toBe(false);
    expect(lifecycleRoot.grantsAccountingAuthority).toBe(false);
    expect(lifecycleRoot.grantsActionDecisionAuthority).toBe(false);

    // ActionDecision has zero authority flags
    expect(actionDecision.grantsPermissionAuthority).toBe(false);
    expect(actionDecision.grantsRiskAuthority).toBe(false);
    expect(actionDecision.grantsAllocationAuthority).toBe(false);
    expect(actionDecision.grantsTargetWeightAuthority).toBe(false);
    expect(actionDecision.grantsExecutionAuthority).toBe(false);
    expect(actionDecision.grantsAccountingAuthority).toBe(false);
    expect(actionDecision.priceAuthority).toBe("NONE");
  });

  it("3. verifies creating and validating ActionDecision is observational and does not mutate source evidence", () => {
    const rootLife = makeRoot(0, 0.3);
    const preLifecycleSnapshot = clone(rootLife);
    const preAssessmentSnapshot = clone(rootLife.currentAssessment);
    const preTargetSnapshot = clone(rootLife.currentAssessment.target);
    const preValuationSnapshot = clone(rootLife.currentAssessment.valuation);

    const actionDecision = createCanonicalActionDecision({
      assetId: "BTC",
      decisionTime: T0,
      asOf: T0,
      lifecycle: rootLife,
    });
    validateActionDecision(actionDecision);

    // Mechanically verify that creating and validating ActionDecision did not mutate source evidence
    expect(rootLife).toEqual(preLifecycleSnapshot);
    expect(rootLife.currentAssessment).toEqual(preAssessmentSnapshot);
    expect(rootLife.currentAssessment.target).toEqual(preTargetSnapshot);
    expect(rootLife.currentAssessment.valuation).toEqual(preValuationSnapshot);

    // Mechanically verify ActionDecision grants no operational/economic authority
    expect(actionDecision.grantsPermissionAuthority).toBe(false);
    expect(actionDecision.grantsRiskAuthority).toBe(false);
    expect(actionDecision.grantsAllocationAuthority).toBe(false);
    expect(actionDecision.grantsTargetWeightAuthority).toBe(false);
    expect(actionDecision.grantsExecutionAuthority).toBe(false);
    expect(actionDecision.grantsAccountingAuthority).toBe(false);
    expect(actionDecision.priceAuthority).toBe("NONE");
  });

  it("4. verifies synthetic data cannot create canonical valuation and null valuation leaves Risk binding unbound", () => {
    // Attempting to create a canonical valuation snapshot with synthetic quality fails
    expect(() =>
      createCanonicalPortfolioValuationSnapshot({
        decisionTime: T0,
        account: makeAccount(0),
        marks: [],
        dataQuality: "SYNTHETIC",
      }),
    ).toThrow("Canonical valuation requires LIVE canonical price evidence");

    // Risk evaluation with null valuation snapshot produces UNBOUND_NONCANONICAL_COMPATIBILITY
    const bars = generateBars(130);
    const { risk: unboundRisk } = evaluatePortfolioRisk(
      10_000,
      10_000,
      bars,
      createInitialRiskState(),
      DEFAULT_RISK_ENGINE_CONFIG,
      T0,
      null, // unbound
    );
    expect(unboundRisk.provenance.valuationBindingStatus).toBe("UNBOUND_NONCANONICAL_COMPATIBILITY");
    expect(unboundRisk.provenance.valuationIdentity).toBeNull();
  });

  it("5. verifies cold persistence/rehydration fails closed on malformed or missing evidence", () => {
    const rootLife = makeRoot(0, 0.4);
    const decisionTime = T0;
    const valuationSnap = makeValuation(0, decisionTime);
    const bars = generateBars(130);
    const ctx: StrategyContext = {
      strategyId: "ADAPTIVE_TREND",
      assetId: "BTC",
      currentBarTimestamp: bars[bars.length - 1].timestamp,
      decisionTimestamp: decisionTime,
      currentPrice: bars[bars.length - 1].close,
      priceHistory: bars,
      macro: null,
      latestEvent: null,
    };
    const stratState: StrategyState = {
      strategyId: "ADAPTIVE_TREND",
      lastEvaluationTimestamp: 0,
      barsSinceLastSignal: 0,
      internalValues: {},
    };
    const signals = [evaluateAdaptiveTrend(ctx, stratState, DEFAULT_ADAPTIVE_TREND_CONFIG)];
    const permissions = [evaluatePermission("ADAPTIVE_TREND", null, DEFAULT_PERMISSION_CONFIG, decisionTime)];
    const { risk: riskOutput } = evaluatePortfolioRisk(
      1000,
      1000,
      bars,
      createInitialRiskState(),
      DEFAULT_RISK_ENGINE_CONFIG,
      decisionTime,
      valuationSnap,
    );

    const decisionState: DecisionState = {
      barIndex: 125,
      timestamp: decisionTime,
      nav: 1000,
      cash: 1000,
      positions: {},
      signals,
      permissions,
      risk: riskOutput,
      targetWeights: rootLife.currentAssessment.target,
      executions: [],
      dailyPnl: 0,
      cumulativePnl: 0,
      currentDrawdown: 0,
    };

    const validCheckpoint = createDurableTargetLifecycleCheckpoint({
      actionAssetId: "BTC",
      lifecycleEvidence: [rootLife],
      decisionState,
    });

    // Tampering with action asset fails closed
    const tampered = clone(validCheckpoint) as any;
    tampered.actionAssetId = "ETH";
    expect(() => validateDurableTargetLifecycleCheckpoint(tampered, decisionState)).toThrow();

    // Time mismatch fails closed
    const timeMismatch = clone(validCheckpoint) as any;
    timeMismatch.decisionTime = decisionTime + HOUR;
    expect(() => validateDurableTargetLifecycleCheckpoint(timeMismatch, decisionState)).toThrow();
  });

  it("6. verifies legacy v1 migration preserves independently valid DecisionState without fabricating lifecycle", () => {
    const decisionTime = T0;
    const bars = generateBars(130);
    const ctx: StrategyContext = {
      strategyId: "ADAPTIVE_TREND",
      assetId: "BTC",
      currentBarTimestamp: bars[bars.length - 1].timestamp,
      decisionTimestamp: decisionTime,
      currentPrice: bars[bars.length - 1].close,
      priceHistory: bars,
      macro: null,
      latestEvent: null,
    };
    const stratState: StrategyState = {
      strategyId: "ADAPTIVE_TREND",
      lastEvaluationTimestamp: 0,
      barsSinceLastSignal: 0,
      internalValues: {},
    };
    const signals = [evaluateAdaptiveTrend(ctx, stratState, DEFAULT_ADAPTIVE_TREND_CONFIG)];
    const permissions = [evaluatePermission("ADAPTIVE_TREND", null, DEFAULT_PERMISSION_CONFIG, decisionTime)];
    const { risk } = evaluatePortfolioRisk(
      10_000,
      10_000,
      bars,
      createInitialRiskState(),
      DEFAULT_RISK_ENGINE_CONFIG,
      decisionTime,
      null,
    );
    const targetWeights = makeTarget(0.3, decisionTime);
    const decisionState: DecisionState = {
      barIndex: 125,
      timestamp: decisionTime,
      nav: 10_000,
      cash: 7_000,
      positions: {
        BTC: {
          assetId: "BTC",
          side: "LONG",
          status: "OPEN",
          quantity: 30,
          entryPrice: 100,
          unrealizedPnl: 0,
        },
      },
      signals,
      permissions,
      risk,
      targetWeights,
      executions: [],
      dailyPnl: 0,
      cumulativePnl: 0,
      currentDrawdown: 0,
    };

    // Store v1 legacy payload (no lifecycle checkpoint)
    const v1Payload = {
      state: {
        latestDecision: decisionState,
        lastRunAt: decisionTime,
      },
      version: 1,
    };
    getStorageApi().setItem("quant_paper_engine_state", JSON.stringify(v1Payload));

    // Rehydrate
    useTradingStore.persist.rehydrate();
    const state = useTradingStore.getState();

    expect(state.latestDecision).not.toBeNull();
    expect(state.latestDecision?.timestamp).toBe(decisionTime);
    expect(state.lifecycleCheckpoint).toBeNull();
    expect(state.actionDecision).toBeNull();
  });

  it("7. verifies store reset clears lifecycle and derived action state", () => {
    const rootLife = makeRoot(0, 0.4);
    const decisionTime = T0;
    const valuationSnap = makeValuation(0, decisionTime);
    const bars = generateBars(130);
    const ctx: StrategyContext = {
      strategyId: "ADAPTIVE_TREND",
      assetId: "BTC",
      currentBarTimestamp: bars[bars.length - 1].timestamp,
      decisionTimestamp: decisionTime,
      currentPrice: bars[bars.length - 1].close,
      priceHistory: bars,
      macro: null,
      latestEvent: null,
    };
    const stratState: StrategyState = {
      strategyId: "ADAPTIVE_TREND",
      lastEvaluationTimestamp: 0,
      barsSinceLastSignal: 0,
      internalValues: {},
    };
    const signals = [evaluateAdaptiveTrend(ctx, stratState, DEFAULT_ADAPTIVE_TREND_CONFIG)];
    const permissions = [evaluatePermission("ADAPTIVE_TREND", null, DEFAULT_PERMISSION_CONFIG, decisionTime)];
    const { risk: riskOutput } = evaluatePortfolioRisk(
      1000,
      1000,
      bars,
      createInitialRiskState(),
      DEFAULT_RISK_ENGINE_CONFIG,
      decisionTime,
      valuationSnap,
    );

    const decisionState: DecisionState = {
      barIndex: 125,
      timestamp: decisionTime,
      nav: 1000,
      cash: 1000,
      positions: {},
      signals,
      permissions,
      risk: riskOutput,
      targetWeights: rootLife.currentAssessment.target,
      executions: [],
      dailyPnl: 0,
      cumulativePnl: 0,
      currentDrawdown: 0,
    };

    const durableCheckpoint = createDurableTargetLifecycleCheckpoint({
      actionAssetId: "BTC",
      lifecycleEvidence: [rootLife],
      decisionState,
    });

    const v2Payload = {
      state: {
        latestDecision: decisionState,
        lifecycleCheckpoint: durableCheckpoint,
        lastRunAt: decisionTime,
      },
      version: 2,
    };
    getStorageApi().setItem("quant_paper_engine_state", JSON.stringify(v2Payload));

    useTradingStore.persist.rehydrate();
    expect(useTradingStore.getState().lifecycleCheckpoint).not.toBeNull();
    expect(useTradingStore.getState().actionDecision).not.toBeNull();

    useTradingStore.getState().reset();
    expect(useTradingStore.getState().latestDecision).toBeNull();
    expect(useTradingStore.getState().lifecycleCheckpoint).toBeNull();
    expect(useTradingStore.getState().actionDecision).toBeNull();
  });

  it("8. verifies Step 5 lifecycle recovery does not alter canonical replay economics or replay state", () => {
    const rawBars = generateBars(135, 100, 999);
    const dataset: BacktestDataset = {
      assetBars: { BTC: rawBars },
    };
    const config: BacktestConfig = {
      runId: "economics-check",
      startDate: 0,
      endDate: 0,
      warmupPeriod: 125,
      initialCapital: 10_000,
      commissionRate: 0.001,
      slippageModel: { type: "FIXED_BPS", baseBps: 5 },
      executionRule: "NEXT_BAR_OPEN",
      requirePitExecution: true,
      deterministicSeed: 20260915,
      dataQuality: "LIVE",
    };

    const backtestResult = runBacktest(config, dataset);
    expect(backtestResult.timeline.length).toBeGreaterThan(0);
    expect(backtestResult.targetLifecycleEvidence.length).toBeGreaterThan(0);

    // Deep snapshot of replay artifacts before checkpoint creation & recovery
    const preRecoveryMetricsSnapshot = clone(backtestResult.metrics);
    const preRecoveryTimelineSnapshot = clone(backtestResult.timeline);
    const preRecoveryLifecycleEvidenceSnapshot = clone(backtestResult.targetLifecycleEvidence);

    const latestDecision = backtestResult.timeline.at(-1)!;
    const checkpoint = createDurableTargetLifecycleCheckpointFromReplay({
      actionAssetId: "BTC",
      lifecycleEvidence: backtestResult.targetLifecycleEvidence,
      decisionState: latestDecision,
    });
    const restored = reconstructActionDecisionFromCheckpoint(checkpoint, latestDecision);

    // Mechanically verify that checkpoint creation and action reconstruction did not mutate replay outputs
    expect(backtestResult.metrics).toEqual(preRecoveryMetricsSnapshot);
    expect(backtestResult.timeline).toEqual(preRecoveryTimelineSnapshot);
    expect(backtestResult.targetLifecycleEvidence).toEqual(preRecoveryLifecycleEvidenceSnapshot);

    // Verify recovery bindings and observational reconstruction
    expect(restored.actionDecision).not.toBeNull();
    expect(restored.checkpoint.lifecycleIdentity).toBe(
      backtestResult.targetLifecycleEvidence.at(-1)!.semanticIdentity,
    );
    // Secondary replay consistency check
    expect(latestDecision.nav).toBe(backtestResult.metrics.finalNav);
  });
});
