// ============================================================================
// FILE: src/lib/quant/__tests__/engineValidation.test.ts
// MODULE: INVARIANT VERIFICATION SUITE
// PURPOSE: Prove Engine Correctness mathematically before Strategy Deployment
// ============================================================================

import { describe, it, expect } from "vitest";
import { runBacktest, type BacktestDataset } from "../backtestEngine";
import { evaluateOmegaAllocation, DEFAULT_OMEGA_CONFIG } from "../omegaAllocator";
import { evaluateEventReaction, DEFAULT_EVENT_REACTION_CONFIG } from "../eventReaction";
import { executeRebalance } from "../executionEngine";
import { PaperEngine, STARTING_EQUITY, mapSourceToDataQuality, buildPaperEngineDataset } from "../../paperEngine";
import { BAR_DURATION_MS, QUANT_BAR_INTERVAL, type QuantReplayMarketContext } from "../timeDomain";
import { useTradingStore } from "../../../stores/tradingStore";
import type {
  BacktestConfig,
  PointInTimeBar,
  PointInTimeEvent,
  PointInTimeMacro,
  RiskOutput,
  SignalOutput,
  PermissionOutput,
  StrategyContext,
  StrategyState,
  TargetPortfolioWeight,
} from "../types";

// ----------------------------------------------------------------------------
// TEST FIXTURES & DETERMINISTIC SYNTHETIC GENERATOR
// ----------------------------------------------------------------------------

function generateSyntheticBars(count: number, basePrice = 50000, seed = 42): PointInTimeBar[] {
  const bars: PointInTimeBar[] = [];
  let current = basePrice;
  let s = seed;

  // Simple pseudo-random LCG for deterministic test data
  const lcg = () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };

  // CORE-08/CORE-01: 1H bar spacing (BAR_DURATION_MS = 3_600_000ms), not 1 day (86400000ms)
  const startMs = 1700000000000;
  for (let i = 0; i < count; i++) {
    const change = (lcg() - 0.49) * 0.04; // -2% to +2% 1H bar swing
    const open = current;
    current = Math.max(100, open * (1 + change));
    const high = Math.max(open, current) * (1 + lcg() * 0.01);
    const low = Math.min(open, current) * (1 - lcg() * 0.01);
    const volume = 1000 + lcg() * 5000;

    bars.push({
      timestamp: startMs + i * BAR_DURATION_MS, // 1H spacing
      open: Math.round(open * 100) / 100,
      high: Math.round(high * 100) / 100,
      low: Math.round(low * 100) / 100,
      close: Math.round(current * 100) / 100,
      volume: Math.round(volume * 10) / 10,
    });
  }

  return bars;
}

function createBaseConfig(): BacktestConfig {
  return {
    runId: "invariant-test-run",
    startDate: 0,
    endDate: 0,
    warmupPeriod: 125,
    initialCapital: 10000,
    commissionRate: 0.001, // 10 bps
    slippageModel: { type: "FIXED_BPS", baseBps: 5 },
    executionRule: "NEXT_BAR_OPEN",
    deterministicSeed: 20260915,
    dataQuality: "LIVE",
  };
}

function createBaseMacro(timestamp: number): PointInTimeMacro {
  return {
    asOfTimestamp: timestamp,
    regime: "Risk-On Expansion",
    regimeScore: 75,
    yield10Y: 4.25,
    yield2Y: 4.50,
    yieldSpreadBps: -25,
    vixLevel: 14.5,
    vixZScore: -0.5,
    marketBreadthRatio: 0.65,
    marketBreadthPctAboveMa20: 70,
    marketLiquidityRatio: 1.1,
    foreignNetFlowBillion: 250,
  };
}

// Simple deterministic hash function for verifying states
function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return hash.toString(16);
}

// Helper: build a minimal stub RiskOutput for Omega direct tests
function stubRisk(targetExposure = 1.0): RiskOutput {
  return {
    scope: "PORTFOLIO_AGGREGATE",
    targetExposure,
    grossExposure: targetExposure,
    targetVolatility: 0.12,
    realizedVol: 0.20,
    forecastVol: 0.20,
    riskFlags: [],
    circuitBreakerStatus: "NORMAL",
    circuitBreakerReason: null,
  };
}

// Helper: build a SignalOutput with given alphaScore
function stubSignal(strategyId: "ADAPTIVE_TREND" | "EVENT_REACTION" | "MEAN_REVERSION", alphaScore: number): SignalOutput {
  return {
    strategyId,
    assetId: "BTC",
    timestamp: 0,
    alphaScore,
    heuristicExpectedReturn: alphaScore * 0.05,
    confidence: Math.max(0, alphaScore > 0 ? 0.6 : 0.5),
    forecastVol: 0.20,
    holdingPeriod: 5,
    decayRate: null,
    validUntil: null,
    rationale: `STUB_SIGNAL(${alphaScore})`,
    metadata: null,
  };
}

// Helper: build a PermissionOutput (fully permitted)
function stubPermission(strategyId: "ADAPTIVE_TREND" | "EVENT_REACTION" | "MEAN_REVERSION"): PermissionOutput {
  return {
    strategyId,
    permission: 1.0,
    isPermitted: true,
    reason: "STUB",
    regime: "Risk-On Expansion",
    liquidityStatus: "NORMAL",
  };
}

// Helper: build a minimal StrategyContext for evaluateEventReaction tests
function buildEventContext(
  event: PointInTimeEvent | null,
  decisionTimestamp: number,
  priceHistory: PointInTimeBar[]
): StrategyContext {
  return {
    strategyId: "EVENT_REACTION",
    assetId: "BTC",
    decisionTimestamp,
    currentBarTimestamp: decisionTimestamp,
    currentPrice: priceHistory.at(-1)?.close ?? 50000,
    priceHistory,
    macro: null,
    latestEvent: event,
  };
}

// Helper: build a stub StrategyState for direct evaluateEventReaction calls
function emptyEventState(): StrategyState {
  return {
    strategyId: "EVENT_REACTION",
    lastEvaluationTimestamp: 0,
    barsSinceLastSignal: 0,
    internalValues: {},
  };
}

// Helper: create a well-formed published event at a given timestamp
function makeTestEvent(publicationTs: number): PointInTimeEvent {
  return {
    eventId: "test-expiry-event",
    eventType: "FED_RATE_DECISION",
    eventTimestamp: publicationTs,
    publicationTimestamp: publicationTs,
    // consensusSnapshotTimestamp must be <= publicationTs to pass the look-ahead guard
    consensusSnapshotTimestamp: publicationTs - BAR_DURATION_MS,
    actual: 5.50,
    consensus: 5.00,
    previous: 5.00,
    surprise: 0.50,
    sourceQuality: "TIER_1_OFFICIAL",
    noveltyScore: 0.90,
  };
}

// ----------------------------------------------------------------------------
// SUITE 1: POINT-IN-TIME INTEGRITY & LOOK-AHEAD MUTATION
// ----------------------------------------------------------------------------

describe("Invariant Test: Point-in-Time & Look-Ahead Mutation", () => {
  it("MUTATION TEST: Future price shocks at T+10 must NOT alter signals at T", () => {
    const totalBars = 200;
    const baseBars = generateSyntheticBars(totalBars, 50000, 101);
    const macro = [createBaseMacro(baseBars[0].timestamp)];

    const datasetA: BacktestDataset = {
      assetBars: { BTC: baseBars },
      macroTimeline: macro,
      benchmarkAssetId: "BTC",
    };

    const config = createBaseConfig();
    const resultA = runBacktest(config, datasetA);

    // Checkpoint: bar index 140 (after warmup 125)
    const targetBarIndex = 140;
    const decisionAtTargetA = resultA.timeline.find((d) => d.barIndex === targetBarIndex);
    expect(decisionAtTargetA).toBeDefined();

    // FUTURE MUTATION: change bars at 160+ to a -90% crash
    const mutatedBars = baseBars.map((b, idx) => {
      if (idx >= 160) {
        return {
          ...b,
          open: b.open * 0.1,
          high: b.high * 0.1,
          low: b.low * 0.1,
          close: b.close * 0.1,
          volume: b.volume * 10,
        };
      }
      return b;
    });

    const datasetB: BacktestDataset = {
      assetBars: { BTC: mutatedBars },
      macroTimeline: macro,
      benchmarkAssetId: "BTC",
    };

    const resultB = runBacktest(config, datasetB);
    const decisionAtTargetB = resultB.timeline.find((d) => d.barIndex === targetBarIndex);

    // Decision at bar 140 must be identical
    expect(decisionAtTargetA?.nav).toBe(decisionAtTargetB?.nav);
    expect(decisionAtTargetA?.signals).toEqual(decisionAtTargetB?.signals);
    expect(decisionAtTargetA?.targetWeights).toEqual(decisionAtTargetB?.targetWeights);
    expect(decisionAtTargetA?.risk).toEqual(decisionAtTargetB?.risk);
  });

  it("EVENT INTEGRITY: Events with consensus timestamp in the future must be ignored", () => {
    const bars = generateSyntheticBars(150, 50000, 202);
    const targetTimestamp = bars[130].timestamp;

    // Event with future consensus snapshot — must be rejected by look-ahead guard
    const futureConsensusEvent: PointInTimeEvent = {
      eventId: "cpi-leaked",
      eventType: "CPI",
      eventTimestamp: targetTimestamp,
      publicationTimestamp: targetTimestamp,
      consensusSnapshotTimestamp: targetTimestamp + 600000, // Future!
      actual: 3.1,
      consensus: 2.9,
      previous: 3.0,
      surprise: 0.2,
      sourceQuality: "TIER_1_OFFICIAL",
      noveltyScore: 0.8,
    };

    const dataset: BacktestDataset = {
      assetBars: { BTC: bars },
      eventTimeline: [futureConsensusEvent],
      benchmarkAssetId: "BTC",
    };

    const result = runBacktest(createBaseConfig(), dataset);
    const stateAtTarget = result.timeline.find((d) => d.timestamp === targetTimestamp);

    const eventSignal = stateAtTarget?.signals.find((s) => s.strategyId === "EVENT_REACTION");
    expect(eventSignal?.alphaScore).toBe(0);
  });
});

// ----------------------------------------------------------------------------
// SUITE 2: DETERMINISM & STATE REPLAY
// ----------------------------------------------------------------------------

describe("Invariant Test: Deterministic Replay & Hash State", () => {
  it("DETERMINISM TEST: Multiple runs on identical datasets must produce identical state hashes", () => {
    const bars = generateSyntheticBars(180, 45000, 303);
    const dataset: BacktestDataset = {
      assetBars: { BTC: bars },
      macroTimeline: [createBaseMacro(bars[0].timestamp)],
      benchmarkAssetId: "BTC",
    };
    const config = createBaseConfig();

    const run1 = runBacktest(config, dataset);
    const run2 = runBacktest(config, dataset);

    const hash1 = hashString(JSON.stringify(run1.timeline));
    const hash2 = hashString(JSON.stringify(run2.timeline));

    expect(hash1).toBe(hash2);
    expect(run1.metrics).toEqual(run2.metrics);
  });
});

// ----------------------------------------------------------------------------
// SUITE 3: ACCOUNTING CONSERVATION & NUMERICAL SAFETY
// ----------------------------------------------------------------------------

describe("Invariant Test: Accounting Cash Conservation & Mathematical Bounds", () => {
  it("CONSERVATION LAW: NAV must equal Cash + Sum(Positions * ExecutionPrice) on every bar", () => {
    const bars = generateSyntheticBars(220, 60000, 404);
    const dataset: BacktestDataset = {
      assetBars: { BTC: bars },
      macroTimeline: [createBaseMacro(bars[0].timestamp)],
      benchmarkAssetId: "BTC",
    };

    const result = runBacktest(createBaseConfig(), dataset);

    for (const state of result.timeline) {
      const bar = bars[state.barIndex];
      let calculatedHoldingsValue = 0;

      for (const [assetId, pos] of Object.entries(state.positions)) {
        if (assetId === "BTC" && pos.quantity > 0) {
          calculatedHoldingsValue += pos.quantity * bar.close;
        }
      }

      const expectedNav = state.cash + calculatedHoldingsValue;

      // Allow 0.05 USD rounding tolerance
      expect(Math.abs(state.nav - expectedNav)).toBeLessThan(0.05);
      expect(state.cash).toBeGreaterThanOrEqual(-1e-6);
      expect(Number.isFinite(state.nav)).toBe(true);
      expect(Number.isFinite(state.cash)).toBe(true);
      expect(Number.isNaN(state.currentDrawdown)).toBe(false);
    }
  });

  it("WARMUP ISOLATION: No trades or PnL drift can occur before the warmup threshold", () => {
    const bars = generateSyntheticBars(160, 50000, 505);
    const config = createBaseConfig(); // Warmup = 125
    const dataset: BacktestDataset = {
      assetBars: { BTC: bars },
      benchmarkAssetId: "BTC",
    };

    const result = runBacktest(config, dataset);

    for (const state of result.timeline) {
      expect(state.barIndex).toBeGreaterThanOrEqual(config.warmupPeriod);
    }

    const firstDecision = result.timeline[0];
    expect(firstDecision.nav).toBe(config.initialCapital);
  });
});

// ----------------------------------------------------------------------------
// SUITE 4: GATE 2A TARGETED INVARIANTS
// ----------------------------------------------------------------------------

// --- A. 1H EVENT EXPIRY (BLOCKER 3: non-vacuous, direct evaluateEventReaction test) ---
describe("Gate 2A Invariant A: 1H Event Expiry (non-vacuous)", () => {
  it("EVENT EXPIRY (1H): At +4 bars event is alive with elapsedBars=4; at +5 bars it is expired", () => {
    // BLOCKER 3: Test evaluateEventReaction directly for precise, deterministic control.
    // No conditional assertions — both states are explicitly constructed.
    //
    // maxHoldingPeriodBars = 5 (DEFAULT_EVENT_REACTION_CONFIG).
    // elapsedBars = Math.floor(elapsedMs / BAR_DURATION_MS)
    //
    // At decisionTimestamp = pubTs + 4 * BAR_DURATION_MS:
    //   elapsedBars = 4 < 5 → NOT expired
    //
    // At decisionTimestamp = pubTs + 5 * BAR_DURATION_MS:
    //   elapsedBars = 5 >= 5 → EXPIRED
    //
    // Critically: if expiry used calendar days (86_400_000 ms), 5 bars = 5 hours
    // would produce elapsedDays = 0 and the event would NOT expire here.
    // This test proves bar-based expiry is active.

    const pubTs = 1700000000000;
    const mockBar: PointInTimeBar = {
      timestamp: pubTs,
      open: 50000,
      high: 51000,
      low: 49000,
      close: 50500,
      volume: 3000,
    };

    // Build a price history with enough bars for volatility calculation
    const priceHistory: PointInTimeBar[] = Array.from({ length: 25 }, (_, i) => ({
      timestamp: pubTs - (24 - i) * BAR_DURATION_MS,
      open: 50000,
      high: 51000,
      low: 49000,
      close: 50000 + i * 10,
      volume: 3000,
    }));
    priceHistory.push(mockBar);

    const event = makeTestEvent(pubTs);

    // === AT +4 BARS: event must NOT be expired ===
    const decisionAt4 = pubTs + 4 * BAR_DURATION_MS;
    const ctxAt4 = buildEventContext(event, decisionAt4, priceHistory);
    const sigAt4 = evaluateEventReaction(ctxAt4, emptyEventState(), DEFAULT_EVENT_REACTION_CONFIG);

    // Must NOT contain EVENT_EXPIRED
    expect(sigAt4.rationale).not.toContain("EVENT_EXPIRED");
    // metadata.elapsedBars must be exactly 4
    expect(sigAt4.metadata?.elapsedBars).toBe(4);

    // === AT +5 BARS: event must be expired ===
    const decisionAt5 = pubTs + 5 * BAR_DURATION_MS;
    const ctxAt5 = buildEventContext(event, decisionAt5, priceHistory);
    const sigAt5 = evaluateEventReaction(ctxAt5, emptyEventState(), DEFAULT_EVENT_REACTION_CONFIG);

    // MANDATORY assertions — no conditional skip possible
    expect(sigAt5.alphaScore).toBe(0);
    expect(sigAt5.rationale).toContain("EVENT_EXPIRED");
    expect(sigAt5.metadata?.elapsedBars).toBe(5);

    // Proof that bar-based expiry is active:
    // If expiry used 86_400_000ms (1 day), 5 * BAR_DURATION_MS = 5 hours.
    // elapsedDays = Math.floor(5 * 3_600_000 / 86_400_000) = Math.floor(0.208) = 0.
    // With day-based expiry the event would NOT be expired at +5 bars.
    // The assertion sigAt5.alphaScore === 0 would then fail — proving bar-based expiry.
  });
});

// --- B. NEXT_BAR_OPEN TIMING (BLOCKER 4: direct executeRebalance test, no vacuous loop) ---
describe("Gate 2A Invariant B: NEXT_BAR_OPEN Execution Timing", () => {
  it("NEXT_BAR_OPEN: Execution uses T+1 OPEN price, not T close; timestamps are correctly separated", () => {
    // BLOCKER 4: Use executeRebalance directly for a deterministic, non-vacuous test.
    // We construct:
    //   - a known account with 100% cash
    //   - a target weight requiring a BUY (so an order MUST be produced)
    //   - bar T with close=99999 (very high — must NOT be used as execution price)
    //   - bar T+1 with open=50000 (the correct execution price)
    // Zero slippage + zero commission → execution price === bar open exactly.

    const T = 1700000000000;
    const T1 = T + BAR_DURATION_MS;

    const currentAccount = {
      cash: 10000,
      positions: {},
    };

    const targetWeights: TargetPortfolioWeight = {
      asOfTimestamp: T,
      assetWeights: { BTC: 0.5 },   // 50% BTC → must produce a BUY
      cashWeight: 0.5,
      grossExposure: 0.5,
      netExposure: 0.5,
      strategyAllocations: { ADAPTIVE_TREND: 0.5, EVENT_REACTION: 0.25, MEAN_REVERSION: 0.25 },
      riskAdjustmentRatio: 1.0,
      rationale: "STUB_TARGET",
    };

    // Bar at T+1: open=50000, close=99999.
    // NEXT_BAR_OPEN must use open, NOT close.
    const barAtT1: PointInTimeBar = {
      timestamp: T1,
      open: 50000,
      high: 100000,
      low: 49000,
      close: 99999, // Deliberately very different from open
      volume: 5000,
    };

    const result = executeRebalance(
      currentAccount,
      targetWeights,
      { BTC: barAtT1 },
      {
        decisionTimestamp: T,
        executionTimestamp: T1,
        executionRule: "NEXT_BAR_OPEN",
        commissionRate: 0,      // zero commission for exact price assertion
        slippageConfig: { type: "FIXED_BPS", baseBps: 0 }, // zero slippage
      }
    );

    // Must produce at least one execution record
    expect(result.records.length).toBeGreaterThanOrEqual(1);

    const exec = result.records[0];

    // decisionTimestamp must be T (time the signal was generated)
    expect(exec.decisionTimestamp).toBe(T);

    // executionTimestamp must be T+1 (time of next-bar open execution)
    expect(exec.executionTimestamp).toBe(T1);

    // Time gap must be exactly one 1H bar
    expect(exec.executionTimestamp - exec.decisionTimestamp).toBe(BAR_DURATION_MS);

    // intendedPrice must be the open of bar T+1 (= 50000)
    expect(exec.intendedPrice).toBe(50000);

    // With zero slippage, executionPrice must also equal open (= 50000)
    expect(exec.executionPrice).toBe(50000);

    // Execution price must NOT equal the close of bar T+1 (= 99999)
    expect(exec.executionPrice).not.toBe(99999);
  });
});

// --- C. LONG-ONLY OMEGA TARGET (BLOCKER 5) ---
describe("Gate 2A Invariant C: Long-Only Omega Target Weights", () => {
  it("LONG-ONLY CLAMP: Negative alpha signals must never produce negative assetWeights in target", () => {
    const risk = stubRisk(1.0);
    const now = 1700000000000;

    // All strategies with strongly negative alpha
    const signals: SignalOutput[] = [
      stubSignal("ADAPTIVE_TREND", -0.8),
      stubSignal("EVENT_REACTION", -0.7),
      stubSignal("MEAN_REVERSION", -0.6),
    ];
    const permissions: PermissionOutput[] = [
      stubPermission("ADAPTIVE_TREND"),
      stubPermission("EVENT_REACTION"),
      stubPermission("MEAN_REVERSION"),
    ];

    const target = evaluateOmegaAllocation(signals, permissions, risk, null, now, DEFAULT_OMEGA_CONFIG);

    // All final asset weights must be >= 0 (long-only)
    for (const [asset, weight] of Object.entries(target.assetWeights)) {
      expect(weight).toBeGreaterThanOrEqual(0);
      expect(typeof asset).toBe("string");
    }

    // Cash weight must be >= 0
    expect(target.cashWeight).toBeGreaterThanOrEqual(0);

    // Gross+cash should be <= 1.0 (allow rounding)
    const totalAlloc = target.grossExposure + target.cashWeight;
    expect(totalAlloc).toBeLessThanOrEqual(1.001);
  });

  it("BLOCKER 5: With all-negative permitted signals, BTC weight=0, gross=0, net=0, cash=1", () => {
    // BLOCKER 5: Assert explicit final long-only semantics, not just isFinite().
    // With strongly negative alpha on BTC from all strategies:
    //   assetWeights["BTC"] must be 0 (clamped)
    //   grossExposure must be 0
    //   netExposure must be 0
    //   cashWeight must be 1.0

    const risk = stubRisk(1.0);
    const now = 1700000000000;

    const signals: SignalOutput[] = [
      stubSignal("ADAPTIVE_TREND", -0.8),
      stubSignal("EVENT_REACTION", -0.7),
      stubSignal("MEAN_REVERSION", -0.6),
    ];
    const permissions: PermissionOutput[] = [
      stubPermission("ADAPTIVE_TREND"),
      stubPermission("EVENT_REACTION"),
      stubPermission("MEAN_REVERSION"),
    ];

    const target = evaluateOmegaAllocation(signals, permissions, risk, null, now, DEFAULT_OMEGA_CONFIG);

    // When all signals are negative, all raw accumulator weights are negative.
    // After long-only clamp → all become 0.
    // After normalization: no risky asset weight, all cash.
    expect(target.assetWeights["BTC"] ?? 0).toBe(0);
    expect(target.grossExposure).toBe(0);
    expect(target.netExposure).toBe(0);
    // cashWeight should be 1.0 (±rounding tolerance for floating point)
    expect(Math.abs(target.cashWeight - 1.0)).toBeLessThan(0.001);
  });

  it("BLOCKER 5: Negative signal information is preserved in strategyAllocations (at least one < 0)", () => {
    // BLOCKER 5: Proves negative signal information is preserved in strategyAllocations.
    // strategyAllocations represent strategy budget fractions and may be negative
    // when alphaScore is negative — this is the preserved signal information.
    // The test explicitly proves at least one strategyAllocation is negative.

    const risk = stubRisk(1.0);
    const now = 1700000000000;

    const signals: SignalOutput[] = [
      stubSignal("ADAPTIVE_TREND", -0.8),
      stubSignal("EVENT_REACTION", -0.7),
      stubSignal("MEAN_REVERSION", -0.6),
    ];
    const permissions: PermissionOutput[] = [
      stubPermission("ADAPTIVE_TREND"),
      stubPermission("EVENT_REACTION"),
      stubPermission("MEAN_REVERSION"),
    ];

    const target = evaluateOmegaAllocation(signals, permissions, risk, null, now, DEFAULT_OMEGA_CONFIG);

    // At least one strategyAllocation must be < 0 (signal information preserved)
    const allocValues = Object.values(target.strategyAllocations);
    const hasNegativeAlloc = allocValues.some((v) => v < 0);
    expect(hasNegativeAlloc).toBe(true);

    // All allocations must be finite numbers
    for (const alloc of allocValues) {
      expect(Number.isFinite(alloc)).toBe(true);
    }
  });
});

// --- D. ROGUE ALPHA LEDGER REMOVED ---
describe("Gate 2A Invariant D: Alpha Bots Have No Fabricated Fills or Accounting", () => {
  it("ALPHA SIGNAL-ONLY: Alpha bots must have zero trades, zero qty, and fixed cash after replay", () => {
    const barCount = 140;
    const bars = generateSyntheticBars(barCount, 50000, 808);

    const ohlcvBars = bars.map((b) => ({
      time: Math.floor(b.timestamp / 1000),
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
    }));

    const engine = new PaperEngine();
    const ctx: QuantReplayMarketContext = { interval: QUANT_BAR_INTERVAL, source: "synthetic" };
    const result = engine.replay(ohlcvBars, ctx);

    // Alpha bots must have NO fills
    expect(result.trend.totalTrades).toBe(0);
    expect(result.event.totalTrades).toBe(0);
    expect(result.mean.totalTrades).toBe(0);
    expect(result.trend.trades.length).toBe(0);
    expect(result.event.trades.length).toBe(0);
    expect(result.mean.trades.length).toBe(0);

    // Alpha bots must have qty = 0
    expect(result.trend.qty).toBe(0);
    expect(result.event.qty).toBe(0);
    expect(result.mean.qty).toBe(0);

    // Alpha bots must have cash = STARTING_EQUITY (not changed by fake trades)
    expect(result.trend.cash).toBe(STARTING_EQUITY);
    expect(result.event.cash).toBe(STARTING_EQUITY);
    expect(result.mean.cash).toBe(STARTING_EQUITY);

    // Alpha bots equity = cash + qty*price = STARTING_EQUITY (flat line)
    expect(result.trend.equity).toBe(STARTING_EQUITY);
    expect(result.event.equity).toBe(STARTING_EQUITY);
    expect(result.mean.equity).toBe(STARTING_EQUITY);

    // Alpha bots must have no wins or losses
    expect(result.trend.wins).toBe(0);
    expect(result.event.wins).toBe(0);
    expect(result.mean.wins).toBe(0);
    expect(result.trend.losses).toBe(0);
    expect(result.event.losses).toBe(0);
    expect(result.mean.losses).toBe(0);
  });
});

// --- E. FABRICATED CORRELATION REMOVED ---
describe("Gate 2A Invariant E: No Fabricated Strategy-PnL Correlation in Omega", () => {
  it("NULL CORRELATION: riskAdjustmentRatio must be 1.0 when strategyCorrelations=null", () => {
    const risk = stubRisk(1.0);
    const now = 1700000000000;

    const signals: SignalOutput[] = [
      stubSignal("ADAPTIVE_TREND", 0.8),
      stubSignal("EVENT_REACTION", 0.7),
      stubSignal("MEAN_REVERSION", 0.3),
    ];
    const permissions: PermissionOutput[] = [
      stubPermission("ADAPTIVE_TREND"),
      stubPermission("EVENT_REACTION"),
      stubPermission("MEAN_REVERSION"),
    ];

    const target = evaluateOmegaAllocation(signals, permissions, risk, null, now, DEFAULT_OMEGA_CONFIG);

    // With null correlation, no correlation penalty can be applied
    expect(target.riskAdjustmentRatio).toBe(1.0);
  });

  it("BACKTEST PASSES NULL CORRELATION: runBacktest must not pass fabricated correlation to Omega", () => {
    const bars = generateSyntheticBars(200, 50000, 909);
    const dataset: BacktestDataset = {
      assetBars: { BTC: bars },
      macroTimeline: [createBaseMacro(bars[0].timestamp)],
      benchmarkAssetId: "BTC",
    };

    const result = runBacktest(createBaseConfig(), dataset);

    // Every bar's targetWeights must have riskAdjustmentRatio = 1.0
    for (const state of result.timeline) {
      expect(state.targetWeights.riskAdjustmentRatio).toBe(1.0);
    }
  });
});

// --- F. DETERMINISM ---
describe("Gate 2A Invariant F: Previously Unseeded Fixtures Are Now Deterministic", () => {
  it("DETERMINISM: Backtest engine produces identical results on repeated runs (no Math.random)", () => {
    const bars = generateSyntheticBars(180, 45000, 1001);
    const dataset: BacktestDataset = {
      assetBars: { BTC: bars },
      macroTimeline: [createBaseMacro(bars[0].timestamp)],
      benchmarkAssetId: "BTC",
    };
    const config = createBaseConfig();

    const run1 = runBacktest(config, dataset);
    const run2 = runBacktest(config, dataset);
    const run3 = runBacktest(config, dataset);

    const h1 = hashString(JSON.stringify(run1.timeline));
    const h2 = hashString(JSON.stringify(run2.timeline));
    const h3 = hashString(JSON.stringify(run3.timeline));

    expect(h1).toBe(h2);
    expect(h2).toBe(h3);
    expect(run1.metrics).toEqual(run2.metrics);
    expect(run2.metrics).toEqual(run3.metrics);
  });
});

// --- BLOCKER 6: ADAPTER VALIDITY ---
describe("Gate 2A Invariant G: Adapter Validity (Blocker 6)", () => {
  it("BLOCKER 6A — UNSUPPORTED INTERVAL: PaperEngine throws for non-1H interval", () => {
    // Proves an unsupported interval (e.g., "4h") cannot be replayed through
    // PaperEngine as if it were 1H. The engine independently enforces the contract.
    const bars = generateSyntheticBars(140, 50000, 1111).map((b) => ({
      time: Math.floor(b.timestamp / 1000),
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
    }));

    const engine = new PaperEngine();

    // Passing interval: "4h" must throw immediately
    expect(() => {
      engine.replay(bars, { interval: "4h", source: "live" });
    }).toThrow("[PaperEngine] Unsupported interval");
  });

  it("BLOCKER 6B — NO FABRICATED EVENT: PaperEngine adapter dataset contains empty eventTimeline", () => {
    // Tests the production buildPaperEngineDataset helper used by PaperEngine.replay().
    // Directly proves the dataset assembled by PaperEngine before canonical runBacktest
    // execution has no fabricated historical event or macro input.
    const bars = generateSyntheticBars(140, 50000, 2222).map((b) => ({
      time: Math.floor(b.timestamp / 1000),
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
    }));

    // 1. Direct assertion on the production dataset assembled by PaperEngine
    const dataset = buildPaperEngineDataset(bars);
    expect(dataset.eventTimeline).toBeDefined();
    expect(dataset.eventTimeline!.length).toBe(0);
    expect(dataset.macroTimeline).toBeDefined();
    expect(dataset.macroTimeline!.length).toBe(0);

    // 2. Replay execution proof (supplementary)
    const engine = new PaperEngine();
    const ctx: QuantReplayMarketContext = { interval: QUANT_BAR_INTERVAL, source: "live" };
    const result = engine.replay(bars, ctx);

    // Require the expected decision state to exist and be non-null
    expect(result.latestDecision).not.toBeNull();
    const eventSig = result.latestDecision!.signals.find((s) => s.strategyId === "EVENT_REACTION");

    // Mandatory assertion that Event Reaction signal exists (no conditional if skip)
    expect(eventSig).toBeDefined();
    expect(eventSig!.alphaScore).toBe(0);
    expect(eventSig!.rationale).toContain("NO_EVENT_PRESENT");
  });

  it("BLOCKER 6C — PROVENANCE MAPPING: synthetic→SYNTHETIC, live→LIVE (no default-to-LIVE path)", () => {
    // Tests the actual production source→dataQuality mapping exported from paperEngine.ts
    // No test-local duplicate mapper functions are used.
    expect(mapSourceToDataQuality("live")).toBe("LIVE");
    expect(mapSourceToDataQuality("synthetic")).toBe("SYNTHETIC");

    // Verify PaperEngine.replay() executes successfully with both live and synthetic contexts
    const bars = generateSyntheticBars(140, 50000, 3333).map((b) => ({
      time: Math.floor(b.timestamp / 1000),
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
    }));

    const engine = new PaperEngine();

    const liveCtx: QuantReplayMarketContext = { interval: QUANT_BAR_INTERVAL, source: "live" };
    expect(() => engine.replay(bars, liveCtx)).not.toThrow();

    const synthCtx: QuantReplayMarketContext = { interval: QUANT_BAR_INTERVAL, source: "synthetic" };
    expect(() => engine.replay(bars, synthCtx)).not.toThrow();
  });

  it("STALE-STATE BOUNDARY: Switching to unsupported interval with <130 or empty bars clears latestDecision and quant state", () => {
    // Proves that when valid 1H state exists first, switching to an unsupported interval
    // (e.g., "4h") even with empty or <130 bars immediately triggers the store guard
    // and clears latestDecision and stale quant state.
    const bars = generateSyntheticBars(140, 50000, 4444).map((b) => ({
      time: Math.floor(b.timestamp / 1000),
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
    }));

    // 1. Valid 1H replay produces active quant state
    useTradingStore.getState().runOnBars(bars, { interval: QUANT_BAR_INTERVAL, source: "live" });
    expect(useTradingStore.getState().latestDecision).not.toBeNull();
    expect(useTradingStore.getState().running).toBe(true);

    // 2. Switching to unsupported interval "4h" with empty bars clears latestDecision and state
    useTradingStore.getState().runOnBars([], { interval: "4h", source: "live" });
    expect(useTradingStore.getState().latestDecision).toBeNull();
    expect(useTradingStore.getState().running).toBe(false);
    expect(useTradingStore.getState().trend.lastSignal).toBe("AWAITING_WARMUP");
  });
});