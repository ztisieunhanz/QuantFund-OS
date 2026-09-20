// ============================================================================
// FILE: src/lib/macro/__tests__/macroSynthesis.test.ts
// MODULE: GATE M3 SYNTHESIS LAYER UNIT TESTS
// PRINCIPLE: Pure Deterministic Verification of M3 Synthesis & Adapters (18 Test Requirements)
// ============================================================================

import { describe, expect, it } from "vitest";
import { createLiveDatum } from "../helpers";
import { buildOmegaLayerSummary } from "../omegaAdapter";
import { buildQuantLayerSummary } from "../quantAdapter";
import { buildRiskLayerSummary } from "../riskAdapter";
import { buildCurrentMarketSnapshot } from "../snapshot";
import { evaluateCurrentMarketSynthesis } from "../synthesis";
import type {
  MacroAssessment,
  MarketSnapshotData,
} from "../types";
import type { RiskOutput, SignalOutput, TargetPortfolioWeight } from "@/lib/quant/types";

const REF_TIME = 1700000000000; // Fixed epoch timestamp for deterministic tests

function createMockSnapshotData(): MarketSnapshotData {
  return {
    dxy: createLiveDatum({ id: "dxy", value: 98.0, provider: "Test", instrument: "DXY", asOf: REF_TIME, fetchedAt: REF_TIME }),
    us2y: createLiveDatum({ id: "us2y", value: 3.5, provider: "Test", instrument: "US2Y", asOf: REF_TIME, fetchedAt: REF_TIME }),
    us10y: createLiveDatum({ id: "us10y", value: 4.0, provider: "Test", instrument: "US10Y", asOf: REF_TIME, fetchedAt: REF_TIME }),
    vix: createLiveDatum({ id: "vix", value: 14.0, provider: "Test", instrument: "VIX", asOf: REF_TIME, fetchedAt: REF_TIME }),
    gold: createLiveDatum({ id: "gold", value: 2000.0, provider: "Test", instrument: "GOLD", asOf: REF_TIME, fetchedAt: REF_TIME }),
    btc: createLiveDatum({ id: "btc", value: 65000.0, provider: "Test", instrument: "BTC", asOf: REF_TIME, fetchedAt: REF_TIME }),
    vnindex: createLiveDatum({ id: "vnindex", value: 1250.0, provider: "Test", instrument: "VNINDEX", asOf: REF_TIME, fetchedAt: REF_TIME }),
    breadth: createLiveDatum({ id: "breadth", value: { advancing: 200, declining: 100, unchanged: 50, adRatio: 2.0, pctAboveMA20: 70, pctAboveMA50: 60, pctAboveMA200: 55 }, provider: "Test", instrument: "VN_BREADTH", asOf: REF_TIME, fetchedAt: REF_TIME }),
    liquidity: createLiveDatum({ id: "liquidity", value: { matchingValueBillion: 15000, ma20ValueBillion: 12000, ratioToMa20: 1.25, status: "EXPANDING" }, provider: "Test", instrument: "VN_LIQ", asOf: REF_TIME, fetchedAt: REF_TIME }),
    foreignFlow: createLiveDatum({ id: "foreignFlow", value: { net1dBillion: 200, net5dBillion: 500, status: "NET_BUYING" }, provider: "Test", instrument: "VN_FF", asOf: REF_TIME, fetchedAt: REF_TIME }),
  };
}

function createMockMacroAssessment(
  regime: MacroAssessment["regime"] = "RISK_ON",
  status: MacroAssessment["status"] = "AVAILABLE"
): MacroAssessment {
  if (status === "INSUFFICIENT_DATA") {
    return {
      status: "INSUFFICIENT_DATA",
      regime: null,
      evidence: [],
      conflicts: [],
      usableMetrics: [],
      unavailableMetrics: ["vix", "us2y"],
      staleMetrics: [],
      excludedMetrics: [],
      coverage: { usable: 2, required: 4, totalCore: 6, ratio: 0.33 },
      confidence: null,
      model: { name: "MacroRegimeHeuristicV2", version: "2.0.0", classification: "HEURISTIC" },
      reason: "Insufficient core metrics",
    };
  }

  return {
    status: "AVAILABLE",
    regime,
    evidence: [
      {
        id: "ev-vix-calm",
        direction: regime === "RISK_ON" ? "RISK_ON" : "RISK_OFF",
        strength: 0.8,
        observedValue: 14.0,
        description: regime === "RISK_ON" ? "Subdued VIX volatility" : "High market volatility",
        sourceIds: ["vix"],
      },
    ],
    conflicts: [],
    usableMetrics: ["dxy", "us2y", "us10y", "vix", "btc", "gold"],
    unavailableMetrics: [],
    staleMetrics: [],
    excludedMetrics: [],
    coverage: { usable: 6, required: 4, totalCore: 6, ratio: 1.0 },
    confidence: 80,
    model: { name: "MacroRegimeHeuristicV2", version: "2.0.0", classification: "HEURISTIC" },
  };
}

function createMockSignals(overrideAlphaScores?: { trend?: number; event?: number; mean?: number; validUntil?: number }): SignalOutput[] {
  return [
    {
      strategyId: "ADAPTIVE_TREND",
      assetId: "BTC",
      timestamp: REF_TIME,
      alphaScore: overrideAlphaScores?.trend ?? 0.6,
      heuristicExpectedReturn: 0.05,
      confidence: 0.8,
      forecastVol: 0.4,
      holdingPeriod: 5,
      validUntil: overrideAlphaScores?.validUntil ?? REF_TIME + 3600000,
      rationale: "Bullish trend momentum",
    },
    {
      strategyId: "EVENT_REACTION",
      assetId: "BTC",
      timestamp: REF_TIME,
      alphaScore: overrideAlphaScores?.event ?? 0.3,
      heuristicExpectedReturn: 0.02,
      confidence: 0.7,
      forecastVol: 0.3,
      holdingPeriod: 3,
      validUntil: overrideAlphaScores?.validUntil ?? REF_TIME + 3600000,
      rationale: "Positive catalyst surprise",
    },
    {
      strategyId: "MEAN_REVERSION",
      assetId: "BTC",
      timestamp: REF_TIME,
      alphaScore: overrideAlphaScores?.mean ?? 0.1,
      heuristicExpectedReturn: 0.01,
      confidence: 0.6,
      forecastVol: 0.25,
      holdingPeriod: 2,
      validUntil: overrideAlphaScores?.validUntil ?? REF_TIME + 3600000,
      rationale: "Slight oversold bounce",
    },
  ];
}

function createMockRiskOutput(circuitBreakerStatus: RiskOutput["circuitBreakerStatus"] = "NORMAL"): RiskOutput {
  return {
    scope: "PORTFOLIO_AGGREGATE",
    targetExposure: 1.0,
    grossExposure: 0.8,
    targetVolatility: 0.15,
    realizedVol: 0.12,
    forecastVol: 0.14,
    riskFlags: circuitBreakerStatus === "TRIPPED" ? ["CIRCUIT_BREAKER_TRIPPED"] : [],
    circuitBreakerStatus,
    circuitBreakerReason: circuitBreakerStatus === "TRIPPED" ? "Max portfolio drawdown threshold exceeded" : null,
  };
}

function createMockTargetWeights(weights: Record<string, number> = { BTC: 0.75 }): TargetPortfolioWeight {
  return {
    asOfTimestamp: REF_TIME,
    assetWeights: weights,
    cashWeight: 0.25,
    grossExposure: 0.75,
    netExposure: 0.75,
    strategyAllocations: { ADAPTIVE_TREND: 0.5, EVENT_REACTION: 0.25, MEAN_REVERSION: 0.0 },
    riskAdjustmentRatio: 1.0,
    rationale: "Long-only allocation to BTC with 25% cash buffer",
  };
}

describe("GATE M3 — CURRENT MARKET SYNTHESIS LAYER TESTS", () => {
  // 1. Macro AVAILABLE + Risk AVAILABLE + aligned positive Quant -> AVAILABLE synthesis
  it("1. Macro AVAILABLE + Risk AVAILABLE + aligned positive Quant produces AVAILABLE synthesis", () => {
    const data = createMockSnapshotData();
    const macro = createMockMacroAssessment("RISK_ON", "AVAILABLE");
    const signals = createMockSignals();
    const risk = createMockRiskOutput("NORMAL");
    const weights = createMockTargetWeights();

    const snapshot = buildCurrentMarketSnapshot({
      timestamp: REF_TIME,
      data,
      macro,
      signals,
      riskOutput: risk,
      targetWeights: weights,
    });

    expect(snapshot.synthesis).not.toBeNull();
    expect(snapshot.synthesis?.status).toBe("AVAILABLE");
    expect(snapshot.synthesis?.stance).toBe("RISK_ON");
    expect(snapshot.synthesis?.confidence).toBeGreaterThan(0);
  });

  // 2. Macro RISK_OFF + positive Quant -> conflict explicitly surfaced
  it("2. Macro RISK_OFF + positive Quant surfaces conflict explicitly", () => {
    const data = createMockSnapshotData();
    const macro = createMockMacroAssessment("RISK_OFF", "AVAILABLE");
    const signals = createMockSignals({ trend: 0.8 }); // Positive quant
    const risk = createMockRiskOutput("NORMAL");

    const snapshot = buildCurrentMarketSnapshot({
      timestamp: REF_TIME,
      data,
      macro,
      signals,
      riskOutput: risk,
    });

    const synth = snapshot.synthesis!;
    expect(synth.stance).toBe("MIXED");
    const quantConflict = synth.conflictingEvidence.find((e) => e.layer === "QUANT");
    expect(quantConflict).toBeDefined();
    expect(quantConflict?.sourceIds).toContain("ADAPTIVE_TREND");
  });

  // 3. Risk restrictive overrides optimistic synthesis into DEFENSIVE/MIXED semantics, not RISK_ON
  it("3. Restrictive Risk (TRIPPED) overrides optimistic synthesis into DEFENSIVE stance", () => {
    const data = createMockSnapshotData();
    const macro = createMockMacroAssessment("RISK_ON", "AVAILABLE");
    const signals = createMockSignals({ trend: 0.9 });
    const risk = createMockRiskOutput("TRIPPED"); // Circuit breaker tripped!

    const snapshot = buildCurrentMarketSnapshot({
      timestamp: REF_TIME,
      data,
      macro,
      signals,
      riskOutput: risk,
    });

    const synth = snapshot.synthesis!;
    expect(synth.stance).toBe("DEFENSIVE");
    expect(synth.stance).not.toBe("RISK_ON");
    expect(synth.headline).toMatch(/Risk layer is constraining portfolio exposure/);
  });

  // 4. Macro INSUFFICIENT_DATA + partial Quant -> PARTIAL or INSUFFICIENT_DATA, never falsely AVAILABLE
  it("4. Macro INSUFFICIENT_DATA + partial Quant yields PARTIAL or INSUFFICIENT_DATA, never AVAILABLE", () => {
    const data = createMockSnapshotData();
    const macro = createMockMacroAssessment("RISK_ON", "INSUFFICIENT_DATA");
    const signals = createMockSignals(); // Quant is available
    const risk = createMockRiskOutput("NORMAL");

    const snapshot = buildCurrentMarketSnapshot({
      timestamp: REF_TIME,
      data,
      macro,
      signals: signals.slice(0, 1), // Partial quant
      riskOutput: risk,
    });

    const synth = snapshot.synthesis!;
    expect(synth.status).not.toBe("AVAILABLE");
    expect(synth.status === "PARTIAL" || synth.status === "INSUFFICIENT_DATA").toBe(true);
  });

  // 5. Risk UNAVAILABLE reduces status/confidence
  it("5. Risk UNAVAILABLE reduces synthesis status and confidence", () => {
    const data = createMockSnapshotData();
    const macro = createMockMacroAssessment("RISK_ON", "AVAILABLE");
    const signals = createMockSignals();

    const fullSnapshot = buildCurrentMarketSnapshot({
      timestamp: REF_TIME,
      data,
      macro,
      signals,
      riskOutput: createMockRiskOutput("NORMAL"),
    });

    const noRiskSnapshot = buildCurrentMarketSnapshot({
      timestamp: REF_TIME,
      data,
      macro,
      signals,
      riskOutput: null, // Risk UNAVAILABLE
    });

    expect(noRiskSnapshot.synthesis?.status).toBe("PARTIAL");
    expect(noRiskSnapshot.synthesis?.confidence!).toBeLessThan(
      fullSnapshot.synthesis?.confidence!
    );
  });

  // 6. Omega unavailable does not fabricate allocation
  it("6. Omega unavailable returns status UNAVAILABLE without fabricating target weights", () => {
    const omegaSummary = buildOmegaLayerSummary(null);
    expect(omegaSummary.status).toBe("UNAVAILABLE");
    expect(omegaSummary.targetWeights).toBeNull();
    expect(omegaSummary.source).toBe("OMEGA_PAPER");
  });

  // 7. DCA benchmark never appears as Omega fallback
  it("7. DCA benchmark never appears in Omega layer summary", () => {
    const targetWeights = createMockTargetWeights({ BTC: 0.8 });
    const omegaSummary = buildOmegaLayerSummary(targetWeights);
    expect(omegaSummary.targetWeights).not.toHaveProperty("DCA");
    expect(omegaSummary.targetWeights).not.toHaveProperty("BENCHMARK_DCA");
    expect(omegaSummary.note).not.toMatch(/DCA/i);
  });

  // 8. Omega Validation Fail-Closed Tests
  it("8A. Valid non-negative Omega weights are preserved EXACTLY without mutation", () => {
    const validWeights = createMockTargetWeights({ BTC: 0.75, ETH: 0.25 });
    const omegaSummary = buildOmegaLayerSummary(validWeights);
    expect(omegaSummary.status).toBe("AVAILABLE");
    expect(omegaSummary.targetWeights).toEqual({ BTC: 0.75, ETH: 0.25 });
  });

  it("8B. Negative Omega weight causes Omega status UNAVAILABLE (fail closed)", () => {
    const invalidShortWeights = {
      asOfTimestamp: REF_TIME,
      assetWeights: { BTC: -0.5, ETH: 0.3 },
      cashWeight: 1.2,
      grossExposure: 0.8,
      netExposure: -0.2,
      strategyAllocations: { ADAPTIVE_TREND: -0.5, EVENT_REACTION: 0.3, MEAN_REVERSION: 0.0 },
      riskAdjustmentRatio: 1.0,
      rationale: "Test short weight handling",
    };

    const omegaSummary = buildOmegaLayerSummary(invalidShortWeights);
    expect(omegaSummary.status).toBe("UNAVAILABLE");
    expect(omegaSummary.targetWeights).toBeNull();
    expect(omegaSummary.note).toMatch(/failed long-only/i);
  });

  it("8C. NaN or Infinity Omega weight causes Omega status UNAVAILABLE (fail closed)", () => {
    const nanWeights = {
      asOfTimestamp: REF_TIME,
      assetWeights: { BTC: Number.NaN, ETH: 0.5 },
      cashWeight: 0.5,
      grossExposure: 0.5,
      netExposure: 0.5,
      strategyAllocations: { ADAPTIVE_TREND: 0.5, EVENT_REACTION: 0.0, MEAN_REVERSION: 0.0 },
      riskAdjustmentRatio: 1.0,
      rationale: "Test NaN weight",
    };

    const infWeights = {
      asOfTimestamp: REF_TIME,
      assetWeights: { BTC: Number.POSITIVE_INFINITY },
      cashWeight: 0.0,
      grossExposure: 1.0,
      netExposure: 1.0,
      strategyAllocations: { ADAPTIVE_TREND: 1.0, EVENT_REACTION: 0.0, MEAN_REVERSION: 0.0 },
      riskAdjustmentRatio: 1.0,
      rationale: "Test Infinity weight",
    };

    const nanSummary = buildOmegaLayerSummary(nanWeights);
    expect(nanSummary.status).toBe("UNAVAILABLE");
    expect(nanSummary.targetWeights).toBeNull();

    const infSummary = buildOmegaLayerSummary(infWeights);
    expect(infSummary.status).toBe("UNAVAILABLE");
    expect(infSummary.targetWeights).toBeNull();
  });

  it("8D. Invalid Omega produces no fabricated/repaired targetWeights in synthesis", () => {
    const invalidShortWeights = {
      asOfTimestamp: REF_TIME,
      assetWeights: { BTC: -0.5 },
      cashWeight: 1.5,
      grossExposure: 0.5,
      netExposure: -0.5,
      strategyAllocations: { ADAPTIVE_TREND: -0.5, EVENT_REACTION: 0.0, MEAN_REVERSION: 0.0 },
      riskAdjustmentRatio: 1.0,
      rationale: "Invalid negative weight",
    };

    const snapshot = buildCurrentMarketSnapshot({
      timestamp: REF_TIME,
      data: createMockSnapshotData(),
      macro: createMockMacroAssessment("RISK_ON", "AVAILABLE"),
      signals: createMockSignals(),
      riskOutput: createMockRiskOutput("NORMAL"),
      targetWeights: invalidShortWeights,
    });

    expect(snapshot.omega?.status).toBe("UNAVAILABLE");
    expect(snapshot.omega?.targetWeights).toBeNull();
    const omegaEvidence = snapshot.synthesis?.supportingEvidence.find((e) => e.layer === "OMEGA");
    expect(omegaEvidence).toBeUndefined();
  });

  // 9. strongestStrategyId means largest absolute valid current signal, not profitability
  it("9. strongestStrategyId means largest absolute currently valid signal", () => {
    const signals = createMockSignals({ trend: 0.2, event: -0.9, mean: 0.5 });
    const quantSummary = buildQuantLayerSummary(signals, REF_TIME);
    expect(quantSummary.strongestStrategyId).toBe("EVENT_REACTION"); // Math.abs(-0.9) = 0.9 is max
  });

  // 10. Expired/invalid quant signals are excluded from strongest strategy
  it("10. Expired quant signals are excluded from strongestStrategyId", () => {
    const expiredSignals: SignalOutput[] = [
      {
        strategyId: "ADAPTIVE_TREND",
        assetId: "BTC",
        timestamp: REF_TIME,
        alphaScore: 0.95, // Largest signal, but EXPIRED!
        heuristicExpectedReturn: 0.1,
        confidence: 0.9,
        forecastVol: 0.3,
        holdingPeriod: 5,
        validUntil: REF_TIME - 1000, // Expired 1 second ago
        rationale: "Expired strong signal",
      },
      {
        strategyId: "EVENT_REACTION",
        assetId: "BTC",
        timestamp: REF_TIME,
        alphaScore: 0.4,
        heuristicExpectedReturn: 0.02,
        confidence: 0.7,
        forecastVol: 0.3,
        holdingPeriod: 3,
        validUntil: REF_TIME + 3600000, // Valid
        rationale: "Valid smaller signal",
      },
    ];

    const summary = buildQuantLayerSummary(expiredSignals, REF_TIME);
    expect(summary.strongestStrategyId).toBe("EVENT_REACTION"); // Excludes expired 0.95 signal
    const trendStrat = summary.strategies.find((s) => s.id === "ADAPTIVE_TREND");
    expect(trendStrat?.signal).toBeNull();
    expect(trendStrat?.state).toBe("EXPIRED");
  });

  // 11. No per-strategy fabricated PnL field exists
  it("11. No per-strategy fabricated PnL field exists in QuantLayerSummary", () => {
    const signals = createMockSignals();
    const summary = buildQuantLayerSummary(signals, REF_TIME);
    for (const s of summary.strategies) {
      expect(s).not.toHaveProperty("pnl");
      expect(s).not.toHaveProperty("realizedPnl");
      expect(s).not.toHaveProperty("unrealizedPnl");
    }
  });

  // 12. No fake win rate/trade count field exists
  it("12. No fake win rate or trade count fields exist in QuantLayerSummary", () => {
    const signals = createMockSignals();
    const summary = buildQuantLayerSummary(signals, REF_TIME);
    for (const s of summary.strategies) {
      expect(s).not.toHaveProperty("winRate");
      expect(s).not.toHaveProperty("tradeCount");
      expect(s).not.toHaveProperty("totalTrades");
      expect(s).not.toHaveProperty("wins");
    }
  });

  // 13. Synthesis confidence is null for INSUFFICIENT_DATA
  it("13. Synthesis confidence is null when status is INSUFFICIENT_DATA", () => {
    const data = createMockSnapshotData();
    const macro = createMockMacroAssessment("RISK_ON", "INSUFFICIENT_DATA");
    const quant = buildQuantLayerSummary([], REF_TIME); // UNAVAILABLE
    const risk = buildRiskLayerSummary(null); // UNAVAILABLE
    const omega = buildOmegaLayerSummary(null);

    const synth = evaluateCurrentMarketSynthesis({
      snapshotData: data,
      macroAssessment: macro,
      quantSummary: quant,
      riskSummary: risk,
      omegaSummary: omega,
      referenceTimeMs: REF_TIME,
    });

    expect(synth.status).toBe("INSUFFICIENT_DATA");
    expect(synth.confidence).toBeNull();
  });

  // 14. PARTIAL confidence is capped below equivalent AVAILABLE case
  it("14. PARTIAL synthesis confidence is capped below equivalent AVAILABLE case", () => {
    const data = createMockSnapshotData();
    const macro = createMockMacroAssessment("RISK_ON", "AVAILABLE"); // High macro confidence
    const signals = createMockSignals();

    const fullSynth = evaluateCurrentMarketSynthesis({
      snapshotData: data,
      macroAssessment: macro,
      quantSummary: buildQuantLayerSummary(signals, REF_TIME),
      riskSummary: buildRiskLayerSummary(createMockRiskOutput("NORMAL")),
      omegaSummary: buildOmegaLayerSummary(createMockTargetWeights()),
      referenceTimeMs: REF_TIME,
    });

    const partialSynth = evaluateCurrentMarketSynthesis({
      snapshotData: data,
      macroAssessment: macro,
      quantSummary: buildQuantLayerSummary(signals, REF_TIME),
      riskSummary: buildRiskLayerSummary(null), // Missing risk makes it PARTIAL
      omegaSummary: buildOmegaLayerSummary(createMockTargetWeights()),
      referenceTimeMs: REF_TIME,
    });

    expect(fullSynth.status).toBe("AVAILABLE");
    expect(partialSynth.status).toBe("PARTIAL");
    expect(partialSynth.confidence).not.toBeNull();
    expect(partialSynth.confidence!).toBeLessThanOrEqual(60);
    expect(partialSynth.confidence!).toBeLessThan(fullSynth.confidence!);
  });

  // 15. Identical inputs produce identical output (pure determinism)
  it("15. Identical inputs produce strictly identical output across multiple runs", () => {
    const params = {
      timestamp: REF_TIME,
      data: createMockSnapshotData(),
      macro: createMockMacroAssessment("RISK_ON", "AVAILABLE"),
      signals: createMockSignals(),
      riskOutput: createMockRiskOutput("NORMAL"),
      targetWeights: createMockTargetWeights(),
    };

    const run1 = buildCurrentMarketSnapshot(params);
    const run2 = buildCurrentMarketSnapshot(params);

    expect(JSON.stringify(run1)).toBe(JSON.stringify(run2));
  });

  // 16. supportingEvidence/conflictingEvidence preserve source layer
  it("16. supportingEvidence and conflictingEvidence preserve source layer tags", () => {
    const snapshot = buildCurrentMarketSnapshot({
      timestamp: REF_TIME,
      data: createMockSnapshotData(),
      macro: createMockMacroAssessment("RISK_OFF", "AVAILABLE"),
      signals: createMockSignals({ trend: 0.7 }), // Conflicting positive quant
      riskOutput: createMockRiskOutput("TRIPPED"), // Supporting risk
      targetWeights: createMockTargetWeights(),
    });

    const synth = snapshot.synthesis!;
    const validLayers = new Set(["DATA", "MACRO", "QUANT", "RISK", "OMEGA"]);

    for (const e of [...synth.supportingEvidence, ...synth.conflictingEvidence]) {
      expect(validLayers.has(e.layer)).toBe(true);
      expect(e.id).toBeDefined();
      expect(e.description).toBeDefined();
      expect(Array.isArray(e.sourceIds)).toBe(true);
    }
  });

  // 17. CurrentMarketSnapshot contains DATA + MACRO + QUANT + RISK + OMEGA + SYNTHESIS
  it("17. CurrentMarketSnapshot contains all 6 core layer fields", () => {
    const snapshot = buildCurrentMarketSnapshot({
      timestamp: REF_TIME,
      data: createMockSnapshotData(),
      macro: createMockMacroAssessment("RISK_ON", "AVAILABLE"),
      signals: createMockSignals(),
      riskOutput: createMockRiskOutput("NORMAL"),
      targetWeights: createMockTargetWeights(),
    });

    expect(snapshot).toHaveProperty("timestamp");
    expect(snapshot).toHaveProperty("data");
    expect(snapshot).toHaveProperty("macro");
    expect(snapshot).toHaveProperty("quant");
    expect(snapshot).toHaveProperty("risk");
    expect(snapshot).toHaveProperty("omega");
    expect(snapshot).toHaveProperty("synthesis");

    expect(snapshot.data).toBeDefined();
    expect(snapshot.macro?.status).toBe("AVAILABLE");
    expect(snapshot.quant?.status).toBe("AVAILABLE");
    expect(snapshot.risk?.status).toBe("AVAILABLE");
    expect(snapshot.omega?.status).toBe("AVAILABLE");
    expect(snapshot.synthesis?.status).toBe("AVAILABLE");
  });

  // 18. No investment recommendation field such as buy/sell/recommendation/targetPrice exists
  it("18. No investment recommendation fields exist in synthesis contract", () => {
    const snapshot = buildCurrentMarketSnapshot({
      timestamp: REF_TIME,
      data: createMockSnapshotData(),
      macro: createMockMacroAssessment("RISK_ON", "AVAILABLE"),
      signals: createMockSignals(),
      riskOutput: createMockRiskOutput("NORMAL"),
      targetWeights: createMockTargetWeights(),
    });

    const synth = snapshot.synthesis!;
    expect(synth).not.toHaveProperty("recommendation");
    expect(synth).not.toHaveProperty("buySignal");
    expect(synth).not.toHaveProperty("sellSignal");
    expect(synth).not.toHaveProperty("targetPrice");
    expect(synth).not.toHaveProperty("actionableTrade");
  });
});
