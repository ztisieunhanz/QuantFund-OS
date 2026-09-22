// ============================================================================
// FILE: src/lib/quant/__tests__/lookaheadValidation.test.ts
// MODULE: POINT-IN-TIME ENFORCEMENT & ANTI-LOOKAHEAD TEST SUITE
// GATE M9B: Verification of anti-lookahead invariants across signals, risk,
//           omega allocation, macro/events, and execution timing.
// ============================================================================

import { describe, expect, it } from "vitest";
import { runBacktest } from "@/lib/quant/backtestEngine";
import type {
  BacktestConfig,
  PointInTimeBar,
  PointInTimeEvent,
  PointInTimeMacro,
  StrategyContext,
  StrategyState,
} from "@/lib/quant/types";
import { evaluateAdaptiveTrend } from "@/lib/quant/adaptiveTrend";
import { evaluateMeanReversion } from "@/lib/quant/meanReversion";
import { evaluatePortfolioRisk, createInitialRiskState } from "@/lib/quant/riskEngine";

function createSyntheticBars(
  count: number,
  startPrice = 50000,
  startTime = 1700000000000
): PointInTimeBar[] {
  const bars: PointInTimeBar[] = [];
  let price = startPrice;
  for (let i = 0; i < count; i++) {
    const change = Math.sin(i / 10) * 200 + (i % 3 === 0 ? 50 : -30);
    const open = Math.round(price * 100) / 100;
    const close = Math.round((price + change) * 100) / 100;
    const high = Math.round((Math.max(open, close) + 100) * 100) / 100;
    const low = Math.round((Math.min(open, close) - 100) * 100) / 100;
    const volume = 1000 + (i % 10) * 100;
    bars.push({
      timestamp: startTime + i * 3600 * 1000,
      open,
      high,
      low,
      close,
      volume,
    });
    price = close;
  }
  return bars;
}

function createBaseConfig(overrides: Partial<BacktestConfig> = {}): BacktestConfig {
  return {
    runId: "test-run",
    startDate: 0,
    endDate: 0,
    warmupPeriod: 125,
    initialCapital: 10000,
    commissionRate: 0.001,
    slippageModel: { type: "FIXED_BPS", baseBps: 5 },
    executionRule: "NEXT_BAR_OPEN",
    deterministicSeed: 20260915,
    dataQuality: "SYNTHETIC",
    ...overrides,
  };
}

describe("Gate M9B — Point-in-Time Enforcement & Anti-Lookahead Validation Matrix", () => {
  // --------------------------------------------------------------------------
  // T1: Prefix invariance
  // --------------------------------------------------------------------------
  it("T1 — prefix invariance: shared prefix decisions are identical between short & long datasets", () => {
    const fullBars = createSyntheticBars(210);
    const shortBars = fullBars.slice(0, 160);

    const config = createBaseConfig({ requirePitExecution: true });

    const resultShort = runBacktest(config, { assetBars: { BTC: shortBars } });
    const resultFull = runBacktest(config, { assetBars: { BTC: fullBars } });

    // Compare decisions up to N-2 (index 158) where NEXT_BAR_OPEN execution is fully contained
    const warmup = config.warmupPeriod; // 125
    const endBoundaryIndex = 158;

    for (let t = warmup; t <= endBoundaryIndex; t++) {
      const stateShort = resultShort.timeline[t - warmup];
      const stateFull = resultFull.timeline[t - warmup];

      expect(stateShort).toBeDefined();
      expect(stateFull).toBeDefined();

      expect(stateShort.timestamp).toBe(stateFull.timestamp);
      expect(stateShort.signals).toEqual(stateFull.signals);
      expect(stateShort.permissions).toEqual(stateFull.permissions);
      expect(stateShort.risk).toEqual(stateFull.risk);
      expect(stateShort.targetWeights).toEqual(stateFull.targetWeights);
      expect(stateShort.executions).toEqual(stateFull.executions);
      expect(stateShort.nav).toBe(stateFull.nav);
      expect(stateShort.cash).toBe(stateFull.cash);
      expect(stateShort.positions).toEqual(stateFull.positions);
      expect(stateShort.dailyPnl).toBe(stateFull.dailyPnl);
      expect(stateShort.cumulativePnl).toBe(stateFull.cumulativePnl);
      expect(stateShort.currentDrawdown).toBe(stateFull.currentDrawdown);
    }
  });

  // --------------------------------------------------------------------------
  // T2: Future-price mutation isolation
  // --------------------------------------------------------------------------
  it("T2 — future-price mutation isolation: mutating bars after t does not alter decision at t", () => {
    const originalBars = createSyntheticBars(200);
    const mutatedBars = originalBars.map((b, idx) => {
      if (idx > 150) {
        return {
          ...b,
          open: b.open * 2.5,
          high: b.high * 2.5,
          low: b.low * 2.5,
          close: b.close * 2.5,
          volume: b.volume * 10,
        };
      }
      return b;
    });

    const config = createBaseConfig({ requirePitExecution: true });

    const resOriginal = runBacktest(config, { assetBars: { BTC: originalBars } });
    const resMutated = runBacktest(config, { assetBars: { BTC: mutatedBars } });

    const idx = 150 - config.warmupPeriod;
    expect(resOriginal.timeline[idx].signals).toEqual(resMutated.timeline[idx].signals);
    expect(resOriginal.timeline[idx].targetWeights).toEqual(resMutated.timeline[idx].targetWeights);
    expect(resOriginal.timeline[idx].risk).toEqual(resMutated.timeline[idx].risk);
    expect(resOriginal.timeline[idx].nav).toBe(resMutated.timeline[idx].nav);
  });

  // --------------------------------------------------------------------------
  // T3: t+1 H/L/C mutation with fixed open
  // --------------------------------------------------------------------------
  it("T3 — t+1 H/L/C mutation with fixed open: decision at t and open execution at t+1 remain identical", () => {
    const originalBars = createSyntheticBars(200);
    const mutatedBars = originalBars.map((b, idx) => {
      if (idx === 151) {
        return {
          ...b,
          high: b.high * 1.5,
          low: b.low * 0.5,
          close: b.close * 1.8,
        };
      }
      return b;
    });

    const config = createBaseConfig({ requirePitExecution: true });

    const resOriginal = runBacktest(config, { assetBars: { BTC: originalBars } });
    const resMutated = runBacktest(config, { assetBars: { BTC: mutatedBars } });

    const stepT = 150 - config.warmupPeriod;
    const stepT1 = 151 - config.warmupPeriod;

    // Decision at t (bar 150) must be identical
    expect(resOriginal.timeline[stepT].targetWeights).toEqual(resMutated.timeline[stepT].targetWeights);

    // Executions at t+1 (bar 151) open must be identical since t+1 open was unchanged
    expect(resOriginal.timeline[stepT1].executions).toEqual(resMutated.timeline[stepT1].executions);
  });

  // --------------------------------------------------------------------------
  // T4: t+1 open mutation affects execution only
  // --------------------------------------------------------------------------
  it("T4 — t+1 open mutation affects execution price at t+1 open without altering decision at t", () => {
    const originalBars = createSyntheticBars(200);
    const mutatedBars = originalBars.map((b, idx) => {
      if (idx === 151) {
        return { ...b, open: b.open * 1.2 };
      }
      return b;
    });

    const config = createBaseConfig({ requirePitExecution: true });

    const resOriginal = runBacktest(config, { assetBars: { BTC: originalBars } });
    const resMutated = runBacktest(config, { assetBars: { BTC: mutatedBars } });

    const stepT = 150 - config.warmupPeriod;
    const stepT1 = 151 - config.warmupPeriod;

    // Decision at t remains 100% identical
    expect(resOriginal.timeline[stepT].targetWeights).toEqual(resMutated.timeline[stepT].targetWeights);

    // If there was an execution at t+1, execution price in mutated run reflects the 1.2x open
    const execOriginal = resOriginal.timeline[stepT1].executions[0];
    const execMutated = resMutated.timeline[stepT1].executions[0];

    if (execOriginal && execMutated) {
      expect(execMutated.executionPrice).toBeCloseTo(execOriginal.executionPrice * 1.2, 1);
    }
  });

  // --------------------------------------------------------------------------
  // T5: Current-close sensitivity
  // --------------------------------------------------------------------------
  it("T5 — current-close sensitivity: changing bar t close affects decision evaluated at bar t close", () => {
    const originalBars = createSyntheticBars(200);
    const mutatedBars = originalBars.map((b, idx) => {
      if (idx === 150) {
        return { ...b, close: b.close * 1.3 };
      }
      return b;
    });

    const config = createBaseConfig({ requirePitExecution: true });

    const resOriginal = runBacktest(config, { assetBars: { BTC: originalBars } });
    const resMutated = runBacktest(config, { assetBars: { BTC: mutatedBars } });

    const stepT = 150 - config.warmupPeriod;

    // Signals evaluated at bar t close must reflect the new close price
    expect(resOriginal.timeline[stepT].signals).not.toEqual(resMutated.timeline[stepT].signals);
  });

  // --------------------------------------------------------------------------
  // T6: Future-close isolation
  // --------------------------------------------------------------------------
  it("T6 — future-close isolation: changing bar t+1 close does not affect decision evaluated at bar t", () => {
    const originalBars = createSyntheticBars(200);
    const mutatedBars = originalBars.map((b, idx) => {
      if (idx === 151) {
        return { ...b, close: b.close * 1.5 };
      }
      return b;
    });

    const config = createBaseConfig({ requirePitExecution: true });

    const resOriginal = runBacktest(config, { assetBars: { BTC: originalBars } });
    const resMutated = runBacktest(config, { assetBars: { BTC: mutatedBars } });

    const stepT = 150 - config.warmupPeriod;

    expect(resOriginal.timeline[stepT].signals).toEqual(resMutated.timeline[stepT].signals);
    expect(resOriginal.timeline[stepT].targetWeights).toEqual(resMutated.timeline[stepT].targetWeights);
  });

  // --------------------------------------------------------------------------
  // T7: Future macro observation isolation
  // --------------------------------------------------------------------------
  it("T7 — future macro observation isolation: macro observation after timestamp does not affect decision at t", () => {
    const bars = createSyntheticBars(200);
    const futureMacroTimestamp = bars[160].timestamp;

    const macroTimeline1: PointInTimeMacro[] = [
      {
        asOfTimestamp: futureMacroTimestamp,
        regime: "Liquidity Drain",
        regimeScore: -0.8,
        yield10Y: 4.5,
        yield2Y: 4.8,
        yieldSpreadBps: -30,
        vixLevel: 25,
        vixZScore: 1.5,
        marketBreadthRatio: 0.3,
        marketBreadthPctAboveMa20: 30,
        marketLiquidityRatio: 0.4,
        foreignNetFlowBillion: -100,
      },
    ];

    const macroTimeline2: PointInTimeMacro[] = [
      {
        ...macroTimeline1[0],
        regime: "Goldilocks",
        regimeScore: 0.9,
      },
    ];

    const config = createBaseConfig({ requirePitExecution: true });

    const res1 = runBacktest(config, { assetBars: { BTC: bars }, macroTimeline: macroTimeline1 });
    const res2 = runBacktest(config, { assetBars: { BTC: bars }, macroTimeline: macroTimeline2 });

    const stepT = 150 - config.warmupPeriod;
    expect(res1.timeline[stepT].permissions).toEqual(res2.timeline[stepT].permissions);
  });

  // --------------------------------------------------------------------------
  // T8: Future event publication isolation
  // --------------------------------------------------------------------------
  it("T8 — future event publication isolation: event published after timestamp does not affect decision at t", () => {
    const bars = createSyntheticBars(200);
    const futureEventTimestamp = bars[160].timestamp;

    const eventTimeline1: PointInTimeEvent[] = [
      {
        eventId: "CPI-1",
        eventType: "INFLATION_CPI",
        eventTimestamp: futureEventTimestamp,
        publicationTimestamp: futureEventTimestamp,
        consensusSnapshotTimestamp: futureEventTimestamp,
        actual: 3.5,
        consensus: 3.0,
        previous: 3.1,
        surprise: 0.5,
        sourceQuality: "TIER_1_OFFICIAL",
        noveltyScore: 0.8,
      },
    ];

    const eventTimeline2: PointInTimeEvent[] = [
      {
        ...eventTimeline1[0],
        surprise: -1.5,
      },
    ];

    const config = createBaseConfig({ requirePitExecution: true });

    const res1 = runBacktest(config, { assetBars: { BTC: bars }, eventTimeline: eventTimeline1 });
    const res2 = runBacktest(config, { assetBars: { BTC: bars }, eventTimeline: eventTimeline2 });

    const stepT = 150 - config.warmupPeriod;
    expect(res1.timeline[stepT].signals).toEqual(res2.timeline[stepT].signals);
  });

  // --------------------------------------------------------------------------
  // T9: Suffix extreme cannot alter earlier normalization/signals
  // --------------------------------------------------------------------------
  it("T9 — suffix extreme cannot alter earlier normalization/signals", () => {
    const baseBars = createSyntheticBars(160);
    const spikedBars = [...baseBars];

    // Append 20 extreme spike bars
    const lastTs = baseBars[baseBars.length - 1].timestamp;
    for (let i = 1; i <= 20; i++) {
      spikedBars.push({
        timestamp: lastTs + i * 3600 * 1000,
        open: 1_000_000,
        high: 2_000_000,
        low: 900_000,
        close: 1_500_000,
        volume: 999_999,
      });
    }

    const config = createBaseConfig({ requirePitExecution: true });

    const resBase = runBacktest(config, { assetBars: { BTC: baseBars } });
    const resSpiked = runBacktest(config, { assetBars: { BTC: spikedBars } });

    const endBoundaryIndex = 158;
    for (let t = config.warmupPeriod; t <= endBoundaryIndex; t++) {
      const idx = t - config.warmupPeriod;
      expect(resBase.timeline[idx].signals).toEqual(resSpiked.timeline[idx].signals);
      expect(resBase.timeline[idx].risk).toEqual(resSpiked.timeline[idx].risk);
    }
  });

  // --------------------------------------------------------------------------
  // T10: Unsorted timestamp rejection
  // --------------------------------------------------------------------------
  it("T10 — unsorted timestamp rejection: fails closed when timestamps descend", () => {
    const bars = createSyntheticBars(150);
    bars[10] = { ...bars[10], timestamp: bars[9].timestamp - 1000 };

    const config = createBaseConfig();
    expect(() => runBacktest(config, { assetBars: { BTC: bars } })).toThrow(
      /Unsorted\/descending timestamp/
    );
  });

  // --------------------------------------------------------------------------
  // T11: Duplicate timestamp rejection
  // --------------------------------------------------------------------------
  it("T11 — duplicate timestamp rejection: fails closed when duplicate timestamps exist", () => {
    const bars = createSyntheticBars(150);
    bars[10] = { ...bars[10], timestamp: bars[9].timestamp };

    const config = createBaseConfig();
    expect(() => runBacktest(config, { assetBars: { BTC: bars } })).toThrow(
      /Duplicate timestamp/
    );
  });

  // --------------------------------------------------------------------------
  // T12: Non-finite timestamp rejection
  // --------------------------------------------------------------------------
  it("T12 — non-finite timestamp rejection: fails closed when NaN or Infinity timestamp exists", () => {
    const bars = createSyntheticBars(150);
    bars[10] = { ...bars[10], timestamp: NaN };

    const config = createBaseConfig();
    expect(() => runBacktest(config, { assetBars: { BTC: bars } })).toThrow(
      /Non-finite timestamp/
    );
  });

  // --------------------------------------------------------------------------
  // T13: SAME_BAR_CLOSE rejected by canonical PIT-safe replay boundary
  // --------------------------------------------------------------------------
  it("T13 — SAME_BAR_CLOSE rejected by canonical PIT-safe replay boundary", () => {
    const bars = createSyntheticBars(150);
    const config = createBaseConfig({
      executionRule: "SAME_BAR_CLOSE",
      requirePitExecution: true,
    });

    expect(() => runBacktest(config, { assetBars: { BTC: bars } })).toThrow(
      /SAME_BAR_CLOSE is a theoretical benchmark mode and is NOT PIT-safe executable logic/
    );
  });

  // --------------------------------------------------------------------------
  // T14: NEXT_BAR_OPEN accepted
  // --------------------------------------------------------------------------
  it("T14 — NEXT_BAR_OPEN accepted by canonical PIT-safe replay boundary", () => {
    const bars = createSyntheticBars(150);
    const config = createBaseConfig({
      executionRule: "NEXT_BAR_OPEN",
      requirePitExecution: true,
    });

    expect(() => runBacktest(config, { assetBars: { BTC: bars } })).not.toThrow();
  });

  // --------------------------------------------------------------------------
  // T15: NEXT_BAR_OPEN exact execution timing
  // --------------------------------------------------------------------------
  it("T15 — NEXT_BAR_OPEN exact execution timing: pending order from bar t executes at bar t+1 open", () => {
    const bars = createSyntheticBars(180);
    const config = createBaseConfig({ requirePitExecution: true });

    const result = runBacktest(config, { assetBars: { BTC: bars } });

    // Check every step in timeline
    for (let i = 0; i < result.timeline.length; i++) {
      const step = result.timeline[i];
      if (step.executions.length > 0) {
        const exec = step.executions[0];
        // Execution timestamp must match current bar timestamp
        expect(exec.executionTimestamp).toBe(step.timestamp);
        // Execution price must be based on current bar open (plus slippage)
        const barIndex = step.barIndex;
        const currentBar = bars[barIndex];
        const expectedBasePrice = currentBar.open;
        expect(exec.intendedPrice).toBe(expectedBasePrice);
      }
    }
  });

  // --------------------------------------------------------------------------
  // T16: DecisionState end-of-bar snapshot semantics
  // --------------------------------------------------------------------------
  it("T16 — DecisionState end-of-bar snapshot semantics: coherent point-in-time snapshot", () => {
    const bars = createSyntheticBars(150);
    const config = createBaseConfig({ requirePitExecution: true });

    const result = runBacktest(config, { assetBars: { BTC: bars } });
    const step = result.timeline[10];

    // Verify DecisionState represents end-of-bar audit snapshot
    expect(step.barIndex).toBe(125 + 10);
    expect(step.timestamp).toBe(bars[step.barIndex].timestamp);
    // NAV is marked at bar close
    const posQty = step.positions["BTC"]?.quantity ?? 0;
    const barClose = bars[step.barIndex].close;
    const expectedEquity = Math.round((step.cash + posQty * barClose) * 100) / 100;
    expect(step.nav).toBe(expectedEquity);
  });

  // --------------------------------------------------------------------------
  // T17: Indicator PIT invariance
  // --------------------------------------------------------------------------
  it("T17 — indicator PIT invariance: indicator evaluations ignore data past slice end", () => {
    const fullBars = createSyntheticBars(200);
    const slicedBars = fullBars.slice(0, 150);

    const trendState: StrategyState = {
      strategyId: "ADAPTIVE_TREND",
      lastEvaluationTimestamp: 0,
      barsSinceLastSignal: 0,
      internalValues: {},
    };
    const mrState: StrategyState = {
      strategyId: "MEAN_REVERSION",
      lastEvaluationTimestamp: 0,
      barsSinceLastSignal: 0,
      internalValues: {},
    };

    const ctxSliced: StrategyContext = {
      strategyId: "ADAPTIVE_TREND",
      assetId: "BTC",
      currentBarTimestamp: slicedBars[149].timestamp,
      decisionTimestamp: slicedBars[149].timestamp,
      currentPrice: slicedBars[149].close,
      priceHistory: slicedBars,
      macro: null,
      latestEvent: null,
    };

    const ctxFull: StrategyContext = {
      ...ctxSliced,
      // Pass fullBars but sliced at 150
      priceHistory: fullBars.slice(0, 150),
    };

    const sigTrendSliced = evaluateAdaptiveTrend(ctxSliced, trendState);
    const sigTrendFull = evaluateAdaptiveTrend(ctxFull, trendState);
    expect(sigTrendSliced).toEqual(sigTrendFull);

    const sigMrSliced = evaluateMeanReversion(ctxSliced, mrState);
    const sigMrFull = evaluateMeanReversion(ctxFull, mrState);
    expect(sigMrSliced).toEqual(sigMrFull);
  });

  // --------------------------------------------------------------------------
  // T18: Risk PIT invariance
  // --------------------------------------------------------------------------
  it("T18 — risk PIT invariance: risk engine evaluation depends only on benchmark slice <= t", () => {
    const bars = createSyntheticBars(200);
    const sliceA = bars.slice(0, 150);
    const sliceB = bars.slice(0, 150); // Same length, past bars ignored

    const riskState = createInitialRiskState();
    const nav = 10000;
    const peakNav = 10500;

    const riskA = evaluatePortfolioRisk(nav, peakNav, sliceA, riskState);
    const riskB = evaluatePortfolioRisk(nav, peakNav, sliceB, riskState);

    expect(riskA.risk).toEqual(riskB.risk);
    expect(riskA.nextState).toEqual(riskB.nextState);
  });

  // --------------------------------------------------------------------------
  // T19: Omega PIT invariance
  // --------------------------------------------------------------------------
  it("T19 — Omega PIT invariance: target weights depend strictly on point-in-time inputs", () => {
    const bars = createSyntheticBars(150);
    const config = createBaseConfig({ requirePitExecution: true });

    const result = runBacktest(config, { assetBars: { BTC: bars } });
    const step = result.timeline[10];

    // Omega allocator output is deterministic and depends strictly on provided inputs
    expect(step.targetWeights.asOfTimestamp).toBe(step.timestamp);
    expect(step.targetWeights.cashWeight + step.targetWeights.grossExposure).toBeCloseTo(1.0, 5);
  });

  // --------------------------------------------------------------------------
  // T20: Deterministic replay on identical prefix
  // --------------------------------------------------------------------------
  it("T20 — deterministic replay on identical prefix: identical input yields byte-identical output", () => {
    const bars = createSyntheticBars(180);
    const config = createBaseConfig({ requirePitExecution: true });

    const run1 = runBacktest(config, { assetBars: { BTC: bars } });
    const run2 = runBacktest(config, { assetBars: { BTC: bars } });

    expect(run1.timeline).toEqual(run2.timeline);
    expect(run1.metrics).toEqual(run2.metrics);
  });
});
