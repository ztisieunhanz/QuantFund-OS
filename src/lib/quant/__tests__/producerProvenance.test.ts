import { describe, expect, it } from "vitest";
import { evaluateAdaptiveTrend, DEFAULT_ADAPTIVE_TREND_CONFIG } from "../adaptiveTrend";
import { evaluateEventReaction, DEFAULT_EVENT_REACTION_CONFIG } from "../eventReaction";
import { evaluateMeanReversion, DEFAULT_MEAN_REVERSION_CONFIG } from "../meanReversion";
import { evaluatePermission, DEFAULT_PERMISSION_CONFIG } from "../permissionGate";
import { createInitialRiskState, evaluatePortfolioRisk, DEFAULT_RISK_ENGINE_CONFIG } from "../riskEngine";
import { evaluateOmegaAllocation, DEFAULT_OMEGA_CONFIG, validateTargetPortfolioWeight } from "../omegaAllocator";
import {
  canonicalProducerJson,
  createSignalOutput,
  producerIdentity,
  validatePermissionOutput,
  validateRiskOutput,
  validateRiskOutputAgainstInputs,
  validateSignalOutput,
} from "../producerProvenance";
import type { PointInTimeBar, SignalOutput, StrategyContext, StrategyId, StrategyState } from "../types";

const decisionTime = 1_700_500_000_000;

function bars(count = 130): PointInTimeBar[] {
  return Array.from({ length: count }, (_, index) => ({
    assetId: "BTC",
    timestamp: decisionTime - (count - index) * 3_600_000,
    open: 100 + index,
    high: 101 + index,
    low: 99 + index,
    close: 100.5 + index,
    volume: 1_000 + index,
    source: "TEST",
    availableAt: decisionTime - (count - index) * 3_600_000,
  }));
}

function context(strategyId: StrategyId): StrategyContext {
  const priceHistory = bars();
  return {
    strategyId,
    assetId: "BTC",
    currentBarTimestamp: decisionTime,
    decisionTimestamp: decisionTime,
    currentPrice: priceHistory.at(-1)!.close,
    priceHistory,
    macro: null,
    latestEvent: null,
  };
}

function state(strategyId: StrategyId): StrategyState {
  return { strategyId, lastEvaluationTimestamp: decisionTime - 3_600_000, barsSinceLastSignal: 1, internalValues: {} };
}

function fixtureSignal(strategyId: StrategyId, inputTag = "A"): SignalOutput {
  return createSignalOutput({
    strategyId,
    assetId: "BTC",
    timestamp: decisionTime,
    alphaScore: 0.5,
    heuristicExpectedReturn: 0.01,
    confidence: 0.8,
    forecastVol: 0.2,
    holdingPeriod: 5,
    decayRate: null,
    validUntil: decisionTime + 18_000_000,
    rationale: "FIXTURE",
    metadata: null,
  }, { inputTag }, { version: 1 });
}

describe("M14 A-04 Step 1 producer provenance", () => {
  it("canonicalizes object order and signed zero deterministically", () => {
    expect(producerIdentity({ b: -0, a: 1 })).toBe(producerIdentity({ a: 1, b: 0 }));
    expect(canonicalProducerJson({ b: -0, a: 1 })).toBe('{"a":1,"b":0}');
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("rejects non-finite numeric identity material: %s", (value) => {
    expect(() => producerIdentity({ value })).toThrow(/non-finite/);
  });

  it("emits reconstructable provenance from all three alpha producers", () => {
    const trendContext = context("ADAPTIVE_TREND");
    const trendState = state("ADAPTIVE_TREND");
    const trend = evaluateAdaptiveTrend(trendContext, trendState, DEFAULT_ADAPTIVE_TREND_CONFIG);
    validateSignalOutput(trend, { context: trendContext, state: trendState }, DEFAULT_ADAPTIVE_TREND_CONFIG);

    const eventContext = context("EVENT_REACTION");
    const eventState = state("EVENT_REACTION");
    const event = evaluateEventReaction(eventContext, eventState, DEFAULT_EVENT_REACTION_CONFIG);
    validateSignalOutput(event, { context: eventContext, state: eventState }, DEFAULT_EVENT_REACTION_CONFIG);

    const meanContext = context("MEAN_REVERSION");
    const meanState = state("MEAN_REVERSION");
    const mean = evaluateMeanReversion(meanContext, meanState, DEFAULT_MEAN_REVERSION_CONFIG);
    validateSignalOutput(mean, { context: meanContext, state: meanState }, DEFAULT_MEAN_REVERSION_CONFIG);
  });

  it("makes signal identity deterministic, input/config/time sensitive, and deeply immutable", () => {
    const ctx = context("ADAPTIVE_TREND");
    const prior = state("ADAPTIVE_TREND");
    const first = evaluateAdaptiveTrend(ctx, prior, DEFAULT_ADAPTIVE_TREND_CONFIG);
    const repeat = evaluateAdaptiveTrend({ ...ctx }, { ...prior }, { ...DEFAULT_ADAPTIVE_TREND_CONFIG });
    const changedTime = evaluateAdaptiveTrend({ ...ctx, currentBarTimestamp: decisionTime + 1, decisionTimestamp: decisionTime + 1 }, prior, DEFAULT_ADAPTIVE_TREND_CONFIG);
    const changedConfig = evaluateAdaptiveTrend(ctx, prior, { ...DEFAULT_ADAPTIVE_TREND_CONFIG, assumedInformationRatio: 0.41 });
    expect(first.provenance.semanticIdentity).toBe(repeat.provenance.semanticIdentity);
    expect(first.provenance.semanticIdentity).not.toBe(changedTime.provenance.semanticIdentity);
    expect(first.provenance.semanticIdentity).not.toBe(changedConfig.provenance.semanticIdentity);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.provenance)).toBe(true);
    expect(Object.isFrozen(first.metadata)).toBe(true);
  });

  it("fails closed for forged signal output or producer input", () => {
    const signal = fixtureSignal("ADAPTIVE_TREND");
    expect(() => validateSignalOutput({ ...signal, alphaScore: 0.9 })).toThrow(/semantic identity/);
    expect(() => validateSignalOutput(signal, { inputTag: "B" }, { version: 1 })).toThrow(/input identity/);
  });

  it("binds permission result to decision time, macro and config", () => {
    const permission = evaluatePermission("ADAPTIVE_TREND", null, DEFAULT_PERMISSION_CONFIG, decisionTime);
    validatePermissionOutput(permission, null, DEFAULT_PERMISSION_CONFIG);
    expect(permission.provenance?.decisionTime).toBe(decisionTime);
    expect(permission.provenance?.macroInputIdentity).toBe("NONE");
    expect(() => validatePermissionOutput({ ...permission, permission: 0.2 })).toThrow(/semantic identity/);
    expect(evaluatePermission("ADAPTIVE_TREND", null, DEFAULT_PERMISSION_CONFIG, decisionTime + 1).provenance.semanticIdentity).not.toBe(permission.provenance.semanticIdentity);
    expect(evaluatePermission("ADAPTIVE_TREND", null, { ...DEFAULT_PERMISSION_CONFIG, minPermissionThreshold: 0.9 }, decisionTime).provenance.semanticIdentity).not.toBe(permission.provenance.semanticIdentity);
    expect(Object.keys(permission.provenance).some((key) => key.toLowerCase().includes("signal"))).toBe(false);
  });

  it("binds risk to its current inputs and explicitly defers canonical valuation identity", () => {
    const benchmark = bars(30);
    const prior = createInitialRiskState();
    const result = evaluatePortfolioRisk(100, 110, benchmark, prior, DEFAULT_RISK_ENGINE_CONFIG, decisionTime);
    validateRiskOutput(result.risk);
    validateRiskOutputAgainstInputs(result.risk, 100, 110, benchmark, prior, result.nextState, DEFAULT_RISK_ENGINE_CONFIG);
    expect(result.risk.provenance?.valuationIdentity).toBeNull();
    expect(result.risk.provenance?.valuationBindingStatus).toBe("DEFERRED_TO_A04_STEP_2");
    expect(() => validateRiskOutput({ ...result.risk, targetExposure: 0.123 })).toThrow(/semantic identity/);
    const changedTime = evaluatePortfolioRisk(100, 110, benchmark, prior, DEFAULT_RISK_ENGINE_CONFIG, decisionTime + 1).risk;
    const changedState = evaluatePortfolioRisk(100, 110, benchmark, { ...prior, cooldownRemainingBars: 1 }, DEFAULT_RISK_ENGINE_CONFIG, decisionTime).risk;
    expect(changedTime.provenance.semanticIdentity).not.toBe(result.risk.provenance.semanticIdentity);
    expect(changedState.provenance.semanticIdentity).not.toBe(result.risk.provenance.semanticIdentity);
  });

  it("separates target content identity from decision-time and upstream lineage identity", () => {
    const signals = [fixtureSignal("ADAPTIVE_TREND")];
    const permissions = [evaluatePermission("ADAPTIVE_TREND", null, DEFAULT_PERMISSION_CONFIG, decisionTime)];
    const riskResult = evaluatePortfolioRisk(100, 100, bars(30), createInitialRiskState(), DEFAULT_RISK_ENGINE_CONFIG, decisionTime);
    const first = evaluateOmegaAllocation(signals, permissions, riskResult.risk, null, decisionTime, DEFAULT_OMEGA_CONFIG);
    const later = evaluateOmegaAllocation(signals, permissions, riskResult.risk, null, decisionTime + 1, DEFAULT_OMEGA_CONFIG);
    const differentLineage = evaluateOmegaAllocation([fixtureSignal("ADAPTIVE_TREND", "B")], permissions, riskResult.risk, null, decisionTime, DEFAULT_OMEGA_CONFIG);

    expect(first.provenance?.targetContentIdentity).toBe(later.provenance?.targetContentIdentity);
    expect(first.provenance?.targetDecisionIdentity).not.toBe(later.provenance?.targetDecisionIdentity);
    expect(first.provenance?.targetContentIdentity).toBe(differentLineage.provenance?.targetContentIdentity);
    expect(first.provenance?.targetDecisionIdentity).not.toBe(differentLineage.provenance?.targetDecisionIdentity);
    validateTargetPortfolioWeight(first, signals, permissions, riskResult.risk, null, DEFAULT_OMEGA_CONFIG);
  });

  it("normalizes upstream array order in target decision identity", () => {
    const signals = [fixtureSignal("ADAPTIVE_TREND"), fixtureSignal("MEAN_REVERSION")];
    const permissions = [
      evaluatePermission("ADAPTIVE_TREND", null, DEFAULT_PERMISSION_CONFIG, decisionTime),
      evaluatePermission("MEAN_REVERSION", null, DEFAULT_PERMISSION_CONFIG, decisionTime),
    ];
    const risk = evaluatePortfolioRisk(100, 100, bars(30), createInitialRiskState(), DEFAULT_RISK_ENGINE_CONFIG, decisionTime).risk;
    const a = evaluateOmegaAllocation(signals, permissions, risk, null, decisionTime, DEFAULT_OMEGA_CONFIG);
    const b = evaluateOmegaAllocation([...signals].reverse(), [...permissions].reverse(), risk, null, decisionTime, DEFAULT_OMEGA_CONFIG);
    expect(a.provenance).toEqual(b.provenance);
  });

  it("rejects stale target content and upstream lineage", () => {
    const signals = [fixtureSignal("ADAPTIVE_TREND")];
    const permissions = [evaluatePermission("ADAPTIVE_TREND", null, DEFAULT_PERMISSION_CONFIG, decisionTime)];
    const risk = evaluatePortfolioRisk(100, 100, bars(30), createInitialRiskState(), DEFAULT_RISK_ENGINE_CONFIG, decisionTime).risk;
    const target = evaluateOmegaAllocation(signals, permissions, risk, null, decisionTime, DEFAULT_OMEGA_CONFIG);
    expect(() => validateTargetPortfolioWeight({ ...target, cashWeight: target.cashWeight - 0.1 }, signals, permissions, risk, null, DEFAULT_OMEGA_CONFIG)).toThrow(/inconsistent|mismatch/);
    expect(() => validateTargetPortfolioWeight({ ...target, asOfTimestamp: decisionTime + 1 }, signals, permissions, risk, null, DEFAULT_OMEGA_CONFIG)).toThrow(/mismatch/);
    expect(() => validateTargetPortfolioWeight(target, [fixtureSignal("ADAPTIVE_TREND", "forged-lineage")], permissions, risk, null, DEFAULT_OMEGA_CONFIG)).toThrow(/mismatch/);
  });

  it("changes both target identities when target content changes", () => {
    const permissions = [evaluatePermission("ADAPTIVE_TREND", null, DEFAULT_PERMISSION_CONFIG, decisionTime)];
    const risk = evaluatePortfolioRisk(100, 100, bars(30), createInitialRiskState(), DEFAULT_RISK_ENGINE_CONFIG, decisionTime).risk;
    const low = evaluateOmegaAllocation([fixtureSignal("ADAPTIVE_TREND")], permissions, risk, null, decisionTime, DEFAULT_OMEGA_CONFIG);
    const { provenance: _signalProvenance, ...signalMaterial } = fixtureSignal("ADAPTIVE_TREND");
    const highSignal = createSignalOutput({ ...signalMaterial, alphaScore: 0.9 }, { inputTag: "high" }, { version: 1 });
    const high = evaluateOmegaAllocation([highSignal], permissions, risk, null, decisionTime, DEFAULT_OMEGA_CONFIG);
    expect(high.assetWeights).not.toEqual(low.assetWeights);
    expect(high.provenance.targetContentIdentity).not.toBe(low.provenance.targetContentIdentity);
    expect(high.provenance.targetDecisionIdentity).not.toBe(low.provenance.targetDecisionIdentity);
  });

  it("rejects negative, non-finite and unsupported target content", () => {
    const signals = [fixtureSignal("ADAPTIVE_TREND")];
    const permissions = [evaluatePermission("ADAPTIVE_TREND", null, DEFAULT_PERMISSION_CONFIG, decisionTime)];
    const risk = evaluatePortfolioRisk(100, 100, bars(30), createInitialRiskState(), DEFAULT_RISK_ENGINE_CONFIG, decisionTime).risk;
    const target = evaluateOmegaAllocation(signals, permissions, risk, null, decisionTime, DEFAULT_OMEGA_CONFIG);
    expect(() => validateTargetPortfolioWeight({ ...target, assetWeights: { BTC: -0.1 } }, signals, permissions, risk, null, DEFAULT_OMEGA_CONFIG)).toThrow(/long-only/);
    expect(() => validateTargetPortfolioWeight({ ...target, cashWeight: Number.NaN }, signals, permissions, risk, null, DEFAULT_OMEGA_CONFIG)).toThrow(/finite/);
    expect(() => validateTargetPortfolioWeight({ ...target, unsupported: true } as typeof target, signals, permissions, risk, null, DEFAULT_OMEGA_CONFIG)).toThrow(/Unsupported/);
  });
});
