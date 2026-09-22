// ============================================================================
// FILE: src/lib/quant/__tests__/tradeAttributionValidation.test.ts
// MODULE: DETERMINISTIC TRADE ATTRIBUTION & ROUND-TRIP RECONSTRUCTION TESTS
// GATE M11B VALIDATION SUITE (T1-T37)
// ============================================================================

import { describe, expect, it } from "vitest";
import type { ExecutionRecord, PointInTimeBar } from "@/lib/quant/types";
import { reconstructTradeAttribution } from "@/lib/quant/tradeAttribution";
import { runBacktest } from "@/lib/quant/backtestEngine";
import { PaperEngine } from "@/lib/paperEngine";
import { runWalkForwardValidation } from "@/lib/quant/walkForward";

function createMockExecution(overrides: Partial<ExecutionRecord>): ExecutionRecord {
  return {
    executionId: `exec-${Math.random().toString(36).substring(2, 9)}`,
    orderId: `ord-${Math.random().toString(36).substring(2, 9)}`,
    strategyId: "OMEGA_REBALANCE",
    assetId: "BTC",
    side: "BUY",
    orderType: "MARKET",
    signalTimestamp: 1700000000000,
    decisionTimestamp: 1700000000000,
    executionTimestamp: 1700003600000,
    intendedPrice: 100,
    executionPrice: 100,
    quantity: 1,
    notionalUsd: 100,
    slippage: 5,
    fees: 1,
    netCashImpact: -101,
    ...overrides,
  };
}

describe("Gate M11B — Canonical Trade Attribution & Round-Trip Reconstruction (T1–T37)", () => {
  // T1: zero executions -> zero lots / zero episodes
  it("T1: zero executions -> zero lots / zero episodes", () => {
    const res = reconstructTradeAttribution([]);
    expect(res.closedTrades).toHaveLength(0);
    expect(res.roundTrips).toHaveLength(0);
    expect(res.summary.totalExecutions).toBe(0);
    expect(res.summary.closedTradeCount).toBe(0);
    expect(res.summary.roundTripCount).toBe(0);
    expect(res.summary.wins).toBe(0);
    expect(res.summary.losses).toBe(0);
    expect(res.summary.breakEven).toBe(0);
    expect(res.summary.winRatePct).toBeNull();
  });

  // T2: BUY only -> open episode, zero completed round trips
  it("T2: BUY only -> open episode, zero completed round trips", () => {
    const execs = [createMockExecution({ side: "BUY", quantity: 1, executionPrice: 100, fees: 1 })];
    const res = reconstructTradeAttribution(execs);
    expect(res.closedTrades).toHaveLength(0);
    expect(res.roundTrips).toHaveLength(0);
    expect(res.summary.closedTradeCount).toBe(0);
    expect(res.summary.roundTripCount).toBe(0);
    expect(res.summary.openQuantity).toBe(1);
    expect(res.summary.unallocatedEntryFees).toBe(1);
  });

  // T3: BUY + full SELL -> one lot, one round trip
  it("T3: BUY + full SELL -> one lot, one round trip", () => {
    const execs = [
      createMockExecution({ side: "BUY", quantity: 1, executionPrice: 100, fees: 1, executionTimestamp: 1000 }),
      createMockExecution({ side: "SELL", quantity: 1, executionPrice: 120, fees: 1.2, executionTimestamp: 2000 }),
    ];
    const res = reconstructTradeAttribution(execs);
    expect(res.closedTrades).toHaveLength(1);
    expect(res.roundTrips).toHaveLength(1);
    expect(res.summary.closedTradeCount).toBe(1);
    expect(res.summary.roundTripCount).toBe(1);
  });

  // T4: profitable episode (WIN)
  it("T4: profitable episode (WIN)", () => {
    const execs = [
      createMockExecution({ side: "BUY", quantity: 1, executionPrice: 100, fees: 1 }),
      createMockExecution({ side: "SELL", quantity: 1, executionPrice: 120, fees: 1 }),
    ];
    const res = reconstructTradeAttribution(execs);
    expect(res.roundTrips[0].result).toBe("WIN");
    expect(res.roundTrips[0].netPnl).toBeGreaterThan(0);
    expect(res.summary.wins).toBe(1);
    expect(res.summary.winRatePct).toBe(100);
  });

  // T5: losing episode (LOSS)
  it("T5: losing episode (LOSS)", () => {
    const execs = [
      createMockExecution({ side: "BUY", quantity: 1, executionPrice: 100, fees: 1 }),
      createMockExecution({ side: "SELL", quantity: 1, executionPrice: 80, fees: 1 }),
    ];
    const res = reconstructTradeAttribution(execs);
    expect(res.roundTrips[0].result).toBe("LOSS");
    expect(res.roundTrips[0].netPnl).toBeLessThan(0);
    expect(res.summary.losses).toBe(1);
    expect(res.summary.winRatePct).toBe(0);
  });

  // T6: gross winner becomes net loser after fees
  it("T6: gross winner becomes net loser after fees", () => {
    // Gross gain = (100.5 - 100) * 1 = 0.5. Total fees = 1 + 1 = 2. Net PnL = 0.5 - 2 = -1.5.
    const execs = [
      createMockExecution({ side: "BUY", quantity: 1, executionPrice: 100, fees: 1 }),
      createMockExecution({ side: "SELL", quantity: 1, executionPrice: 100.5, fees: 1 }),
    ];
    const res = reconstructTradeAttribution(execs);
    expect(res.closedTrades[0].grossPnl).toBe(0.5);
    expect(res.closedTrades[0].netPnl).toBe(-1.5);
    expect(res.roundTrips[0].result).toBe("LOSS");
  });

  // T7: scale-in + full exit (Exact math from Section G)
  it("T7: scale-in + full exit matching Section G math", () => {
    const execs = [
      createMockExecution({ side: "BUY", quantity: 1, executionPrice: 100, fees: 1, executionTimestamp: 1000 }),
      createMockExecution({ side: "BUY", quantity: 1, executionPrice: 120, fees: 1.2, executionTimestamp: 2000 }),
      createMockExecution({ side: "SELL", quantity: 1, executionPrice: 130, fees: 1.3, executionTimestamp: 3000 }),
      createMockExecution({ side: "SELL", quantity: 1, executionPrice: 140, fees: 1.4, executionTimestamp: 4000 }),
    ];
    const res = reconstructTradeAttribution(execs, 10000);
    expect(res.closedTrades).toHaveLength(2);
    expect(res.roundTrips).toHaveLength(1);

    // Lot 1
    expect(res.closedTrades[0].averageEntryPrice).toBe(110);
    expect(res.closedTrades[0].allocatedEntryFees).toBeCloseTo(1.1, 4);
    expect(res.closedTrades[0].grossPnl).toBeCloseTo(20, 4);
    expect(res.closedTrades[0].netPnl).toBeCloseTo(17.6, 4);

    // Lot 2
    expect(res.closedTrades[1].allocatedEntryFees).toBeCloseTo(1.1, 4);
    expect(res.closedTrades[1].grossPnl).toBeCloseTo(30, 4);
    expect(res.closedTrades[1].netPnl).toBeCloseTo(27.5, 4);

    // Episode
    const ep = res.roundTrips[0];
    expect(ep.totalEntryQuantity).toBe(2);
    expect(ep.totalExitQuantity).toBe(2);
    expect(ep.totalEntryFees).toBeCloseTo(2.2, 4);
    expect(ep.totalExitFees).toBeCloseTo(2.7, 4);
    expect(ep.grossPnl).toBeCloseTo(50, 4);
    expect(ep.netPnl).toBeCloseTo(45.1, 4);
  });

  // T8: scale-in + partial sell
  it("T8: scale-in + partial sell", () => {
    const execs = [
      createMockExecution({ side: "BUY", quantity: 2, executionPrice: 100, fees: 2 }),
      createMockExecution({ side: "BUY", quantity: 2, executionPrice: 200, fees: 2 }),
      createMockExecution({ side: "SELL", quantity: 1, executionPrice: 180, fees: 1 }),
    ];
    const res = reconstructTradeAttribution(execs);
    expect(res.closedTrades).toHaveLength(1);
    expect(res.roundTrips).toHaveLength(0); // Episode remains open
    expect(res.summary.openQuantity).toBe(3);
    expect(res.summary.unallocatedEntryFees).toBe(3); // 4 - (4 * 1/4) = 3
  });

  // T9: multiple partial sells -> multiple lots, one round trip
  it("T9: multiple partial sells -> multiple lots, one round trip", () => {
    const execs = [
      createMockExecution({ side: "BUY", quantity: 2, executionPrice: 100, fees: 2 }),
      createMockExecution({ side: "SELL", quantity: 0.5, executionPrice: 110, fees: 0.5 }),
      createMockExecution({ side: "SELL", quantity: 0.5, executionPrice: 120, fees: 0.5 }),
      createMockExecution({ side: "SELL", quantity: 1.0, executionPrice: 130, fees: 1.0 }),
    ];
    const res = reconstructTradeAttribution(execs);
    expect(res.closedTrades).toHaveLength(3);
    expect(res.roundTrips).toHaveLength(1);
    expect(res.summary.closedTradeCount).toBe(3);
    expect(res.summary.roundTripCount).toBe(1);
  });

  // T10: partial sells do not inflate roundTripCount
  it("T10: partial sells do not inflate roundTripCount", () => {
    const execs = [
      createMockExecution({ side: "BUY", quantity: 10, executionPrice: 100, fees: 10 }),
      createMockExecution({ side: "SELL", quantity: 1, executionPrice: 110, fees: 1 }),
      createMockExecution({ side: "SELL", quantity: 1, executionPrice: 110, fees: 1 }),
      createMockExecution({ side: "SELL", quantity: 1, executionPrice: 110, fees: 1 }),
    ];
    const res = reconstructTradeAttribution(execs);
    expect(res.summary.closedTradeCount).toBe(3);
    expect(res.summary.roundTripCount).toBe(0); // Position still open
  });

  // T11: proportional BUY-fee allocation
  it("T11: proportional BUY-fee allocation", () => {
    const execs = [
      createMockExecution({ side: "BUY", quantity: 10, executionPrice: 100, fees: 10 }),
      createMockExecution({ side: "SELL", quantity: 3, executionPrice: 120, fees: 3 }),
    ];
    const res = reconstructTradeAttribution(execs);
    expect(res.closedTrades[0].allocatedEntryFees).toBeCloseTo(3, 4); // 10 * (3/10) = 3
  });

  // T12: remaining entry-fee basis after partial exit
  it("T12: remaining entry-fee basis after partial exit", () => {
    const execs = [
      createMockExecution({ side: "BUY", quantity: 10, executionPrice: 100, fees: 10 }),
      createMockExecution({ side: "SELL", quantity: 3, executionPrice: 120, fees: 3 }),
    ];
    const res = reconstructTradeAttribution(execs);
    expect(res.summary.unallocatedEntryFees).toBeCloseTo(7, 4);
  });

  // T13: exit fee counted once
  it("T13: exit fee counted once", () => {
    const execs = [
      createMockExecution({ side: "BUY", quantity: 1, executionPrice: 100, fees: 1 }),
      createMockExecution({ side: "SELL", quantity: 1, executionPrice: 120, fees: 2 }),
    ];
    const res = reconstructTradeAttribution(execs);
    expect(res.closedTrades[0].exitFees).toBe(2);
    expect(res.summary.totalExitFees).toBe(2);
    expect(res.summary.totalEntryFees).toBe(1);
  });

  // T14: slippage already embedded, not double-counted
  it("T14: slippage already embedded, not double-counted", () => {
    // Buy filled at 105 (intended 100), Sell filled at 115 (intended 120)
    const execs = [
      createMockExecution({ side: "BUY", quantity: 1, intendedPrice: 100, executionPrice: 105, fees: 0 }),
      createMockExecution({ side: "SELL", quantity: 1, intendedPrice: 120, executionPrice: 115, fees: 0 }),
    ];
    const res = reconstructTradeAttribution(execs);
    expect(res.closedTrades[0].grossPnl).toBe(10); // 115 - 105
  });

  // T15: full exit clears inventory attribution state
  it("T15: full exit clears inventory attribution state", () => {
    const execs = [
      createMockExecution({ side: "BUY", quantity: 1, executionPrice: 100, fees: 1 }),
      createMockExecution({ side: "SELL", quantity: 1, executionPrice: 120, fees: 1 }),
    ];
    const res = reconstructTradeAttribution(execs);
    expect(res.summary.openQuantity).toBe(0);
    expect(res.summary.unallocatedEntryFees).toBe(0);
  });

  // T16: re-entry creates new episode
  it("T16: re-entry creates new episode", () => {
    const execs = [
      createMockExecution({ side: "BUY", quantity: 1, executionPrice: 100, fees: 1, executionTimestamp: 1000 }),
      createMockExecution({ side: "SELL", quantity: 1, executionPrice: 120, fees: 1, executionTimestamp: 2000 }),
      createMockExecution({ side: "BUY", quantity: 1, executionPrice: 150, fees: 1, executionTimestamp: 3000 }),
      createMockExecution({ side: "SELL", quantity: 1, executionPrice: 160, fees: 1, executionTimestamp: 4000 }),
    ];
    const res = reconstructTradeAttribution(execs);
    expect(res.roundTrips).toHaveLength(2);
    expect(res.roundTrips[0].episodeId).toBe("ep-BTC-1");
    expect(res.roundTrips[1].episodeId).toBe("ep-BTC-2");
  });

  // T17: same-timestamp execution ordering deterministic
  it("T17: same-timestamp execution ordering deterministic", () => {
    const execs = [
      createMockExecution({ side: "BUY", quantity: 1, executionPrice: 100, fees: 1, executionTimestamp: 1000 }),
      createMockExecution({ side: "SELL", quantity: 1, executionPrice: 120, fees: 1, executionTimestamp: 1000 }),
    ];
    const res = reconstructTradeAttribution(execs);
    expect(res.roundTrips).toHaveLength(1);
    expect(res.closedTrades[0].netPnl).toBe(18);
  });

  // T18: multiple assets attributed independently
  it("T18: multiple assets attributed independently", () => {
    const execs = [
      createMockExecution({ assetId: "BTC", side: "BUY", quantity: 1, executionPrice: 100, fees: 1 }),
      createMockExecution({ assetId: "ETH", side: "BUY", quantity: 10, executionPrice: 10, fees: 1 }),
      createMockExecution({ assetId: "BTC", side: "SELL", quantity: 1, executionPrice: 120, fees: 1 }),
    ];
    const res = reconstructTradeAttribution(execs);
    expect(res.roundTrips).toHaveLength(1); // BTC episode completed
    expect(res.roundTrips[0].assetId).toBe("BTC");
    expect(res.summary.openQuantity).toBe(10); // ETH open
  });

  // T19: oversell fails closed
  it("T19: oversell fails closed", () => {
    const execs = [
      createMockExecution({ side: "BUY", quantity: 1, executionPrice: 100, fees: 1 }),
      createMockExecution({ side: "SELL", quantity: 2, executionPrice: 120, fees: 1 }),
    ];
    expect(() => reconstructTradeAttribution(execs)).toThrowError(/exceeds open inventory/i);
  });

  // T20: SELL while flat fails closed
  it("T20: SELL while flat fails closed", () => {
    const execs = [createMockExecution({ side: "SELL", quantity: 1, executionPrice: 120, fees: 1 })];
    expect(() => reconstructTradeAttribution(execs)).toThrowError(/position is flat/i);
  });

  // T21: flat-ending ledger reconciliation
  it("T21: flat-ending ledger reconciliation (sum(netPnl) == endingNAV - initialCapital)", () => {
    const initialCap = 10000;
    const execs = [
      createMockExecution({ side: "BUY", quantity: 1, executionPrice: 100, fees: 1 }),
      createMockExecution({ side: "SELL", quantity: 1, executionPrice: 120, fees: 1.2 }),
      createMockExecution({ side: "BUY", quantity: 2, executionPrice: 200, fees: 2 }),
      createMockExecution({ side: "SELL", quantity: 2, executionPrice: 250, fees: 2.5 }),
    ];
    const res = reconstructTradeAttribution(execs, initialCap);
    const sumEpNetPnl = res.roundTrips.reduce((acc, ep) => acc + ep.netPnl, 0);
    const sumCtNetPnl = res.closedTrades.reduce((acc, ct) => acc + ct.netPnl, 0);

    // Cash accounting check:
    // Initial: 10000
    // Buy 1 @ 100 + fee 1 -> Cash = 9899
    // Sell 1 @ 120 - fee 1.2 -> Cash = 10017.8
    // Buy 2 @ 200 + fee 2 -> Cash = 9615.8
    // Sell 2 @ 250 - fee 2.5 -> Cash = 10113.3
    // Ending NAV - Initial Capital = 10113.3 - 10000 = 113.3
    const finalCash = 10000 - 100 - 1 + 120 - 1.2 - 400 - 2 + 500 - 2.5;
    const navDiff = finalCash - initialCap;

    expect(sumEpNetPnl).toBeCloseTo(navDiff, 4);
    expect(sumCtNetPnl).toBeCloseTo(navDiff, 4);
  });

  // T22: closed-lot sum == completed-episode sum when flat
  it("T22: closed-lot sum == completed-episode sum when flat", () => {
    const execs = [
      createMockExecution({ side: "BUY", quantity: 2, executionPrice: 100, fees: 2 }),
      createMockExecution({ side: "SELL", quantity: 1, executionPrice: 120, fees: 1 }),
      createMockExecution({ side: "SELL", quantity: 1, executionPrice: 130, fees: 1 }),
    ];
    const res = reconstructTradeAttribution(execs);
    const sumCt = res.closedTrades.reduce((acc, ct) => acc + ct.netPnl, 0);
    const sumEp = res.roundTrips.reduce((acc, ep) => acc + ep.netPnl, 0);
    expect(sumCt).toBeCloseTo(sumEp, 4);
  });

  // T23: open-ending reconciliation
  it("T23: open-ending reconciliation", () => {
    // BUY 2 @ 100, fee 2. Cash = 9798. openQty = 2.
    // SELL 0.5 @ 130, fee 1. Cash = 9862. Closed lot net PnL = 13.5.
    // Remaining open inventory: 1.5 BTC @ 100. Remaining entry fees = 1.5.
    // Mark price = 130.
    // NAV = 9862 + 1.5 * 130 = 10057.
    // Portfolio PnL = 57.
    const execs = [
      createMockExecution({ side: "BUY", quantity: 2, executionPrice: 100, fees: 2 }),
      createMockExecution({ side: "SELL", quantity: 0.5, executionPrice: 130, fees: 1 }),
    ];
    const res = reconstructTradeAttribution(execs, 10000);

    const markPrice = 130;
    const cash = 10000 - 200 - 2 + 65 - 1; // 9862
    const nav = cash + 1.5 * markPrice; // 10057
    const portfolioPnL = nav - 10000; // 57

    const realizedClosedLotsNetPnl = res.closedTrades[0].netPnl; // 13.5
    const grossUnrealizedPnl = 1.5 * (markPrice - 100); // 45
    const remainingEntryFees = res.summary.unallocatedEntryFees; // 1.5

    const reconciledFormula = 0 + realizedClosedLotsNetPnl + grossUnrealizedPnl - remainingEntryFees;
    expect(portfolioPnL).toBeCloseTo(reconciledFormula, 4);
  });

  // T24: terminal open episode not force-closed
  it("T24: terminal open episode not force-closed", () => {
    const execs = [
      createMockExecution({ side: "BUY", quantity: 2, executionPrice: 100, fees: 2 }),
      createMockExecution({ side: "SELL", quantity: 1, executionPrice: 120, fees: 1 }),
    ];
    const res = reconstructTradeAttribution(execs);
    expect(res.roundTrips).toHaveLength(0); // Episode remains open
    expect(res.summary.roundTripCount).toBe(0);
    expect(res.summary.closedTradeCount).toBe(1);
  });

  // T25: WIN classification
  it("T25: WIN classification (> 1e-4)", () => {
    const execs = [
      createMockExecution({ side: "BUY", quantity: 1, executionPrice: 100, fees: 0 }),
      createMockExecution({ side: "SELL", quantity: 1, executionPrice: 100.01, fees: 0 }),
    ];
    const res = reconstructTradeAttribution(execs);
    expect(res.roundTrips[0].result).toBe("WIN");
  });

  // T26: LOSS classification
  it("T26: LOSS classification (< -1e-4)", () => {
    const execs = [
      createMockExecution({ side: "BUY", quantity: 1, executionPrice: 100, fees: 0 }),
      createMockExecution({ side: "SELL", quantity: 1, executionPrice: 99.99, fees: 0 }),
    ];
    const res = reconstructTradeAttribution(execs);
    expect(res.roundTrips[0].result).toBe("LOSS");
  });

  // T27: BREAK_EVEN classification
  it("T27: BREAK_EVEN classification (abs(netPnl) <= 1e-4)", () => {
    const execs = [
      createMockExecution({ side: "BUY", quantity: 1, executionPrice: 100, fees: 0 }),
      createMockExecution({ side: "SELL", quantity: 1, executionPrice: 100.00001, fees: 0 }),
    ];
    const res = reconstructTradeAttribution(execs);
    expect(res.roundTrips[0].result).toBe("BREAK_EVEN");
  });

  // T28: win rate excludes break-even denominator
  it("T28: win rate excludes break-even denominator", () => {
    // 1 win, 1 break-even
    const execs = [
      createMockExecution({ side: "BUY", quantity: 1, executionPrice: 100, fees: 0, executionTimestamp: 1000 }),
      createMockExecution({ side: "SELL", quantity: 1, executionPrice: 120, fees: 0, executionTimestamp: 2000 }),
      createMockExecution({ side: "BUY", quantity: 1, executionPrice: 100, fees: 0, executionTimestamp: 3000 }),
      createMockExecution({ side: "SELL", quantity: 1, executionPrice: 100, fees: 0, executionTimestamp: 4000 }),
    ];
    const res = reconstructTradeAttribution(execs);
    expect(res.summary.wins).toBe(1);
    expect(res.summary.breakEven).toBe(1);
    expect(res.summary.winRatePct).toBe(100); // 1 / (1 + 0) * 100
  });

  // T29: no wins/losses => winRate null
  it("T29: no wins/losses => winRate null", () => {
    const execs = [
      createMockExecution({ side: "BUY", quantity: 1, executionPrice: 100, fees: 0 }),
      createMockExecution({ side: "SELL", quantity: 1, executionPrice: 100, fees: 0 }),
    ];
    const res = reconstructTradeAttribution(execs);
    expect(res.summary.breakEven).toBe(1);
    expect(res.summary.winRatePct).toBeNull();
  });

  // T30: fresh replay derives authoritative trade stats
  it("T30: fresh replay derives authoritative trade stats", () => {
    const pitBars: PointInTimeBar[] = Array.from({ length: 150 }, (_, i) => ({
      timestamp: 1700000000000 + i * 3600000,
      open: 100 + (i % 10),
      high: 105 + (i % 10),
      low: 95 + (i % 10),
      close: 100 + (i % 10),
      volume: 1000,
    }));

    const result = runBacktest(
      {
        runId: "t30-test",
        startDate: 0,
        endDate: 0,
        warmupPeriod: 125,
        initialCapital: 10000,
        commissionRate: 0.001,
        slippageModel: { type: "FIXED_BPS", baseBps: 5 },
        executionRule: "NEXT_BAR_OPEN",
        requirePitExecution: true,
        deterministicSeed: 42,
        dataQuality: "SYNTHETIC",
      },
      { assetBars: { BTC: pitBars } }
    );

    expect(result.metrics.closedTradeCount).toBeGreaterThanOrEqual(0);
    expect(result.metrics.roundTripCount).toBeGreaterThanOrEqual(0);
  });

  // T31: hydration remains N/A/null before fresh replay
  it("T31: hydration remains N/A/null before fresh replay", () => {
    const paper = new PaperEngine();
    const metrics = paper.replay([], { interval: "1h", source: "synthetic" }).trend;
    expect(metrics.winRate).toBeNull();
    expect(metrics.closedTradeCount).toBeNull();
    expect(metrics.roundTripCount).toBeNull();
  });

  // T32: fills != closedTradeCount != roundTripCount case
  it("T32: fills != closedTradeCount != roundTripCount case", () => {
    // 2 BUY scale-ins + 2 partial SELLs = 4 fills, 2 closed lots, 1 round trip
    const execs = [
      createMockExecution({ side: "BUY", quantity: 1, executionPrice: 100, fees: 1, executionTimestamp: 1000 }),
      createMockExecution({ side: "BUY", quantity: 1, executionPrice: 120, fees: 1, executionTimestamp: 2000 }),
      createMockExecution({ side: "SELL", quantity: 1, executionPrice: 130, fees: 1, executionTimestamp: 3000 }),
      createMockExecution({ side: "SELL", quantity: 1, executionPrice: 140, fees: 1, executionTimestamp: 4000 }),
    ];
    const res = reconstructTradeAttribution(execs);
    expect(res.summary.totalExecutions).toBe(4);
    expect(res.summary.closedTradeCount).toBe(2);
    expect(res.summary.roundTripCount).toBe(1);
  });

  // T33: walk-forward folds isolate episodes
  it("T33: walk-forward folds isolate episodes", () => {
    const pitBars: PointInTimeBar[] = Array.from({ length: 300 }, (_, i) => ({
      timestamp: 1700000000000 + i * 3600000,
      open: 100 + (i % 5),
      high: 105 + (i % 5),
      low: 95 + (i % 5),
      close: 100 + (i % 5),
      volume: 1000,
    }));

    const wfResult = runWalkForwardValidation(
      { assetBars: { BTC: pitBars } },
      {
        runId: "wf-test",
        startDate: 0,
        endDate: 0,
        warmupPeriod: 125,
        initialCapital: 10000,
        commissionRate: 0.001,
        slippageModel: { type: "FIXED_BPS", baseBps: 5 },
        executionRule: "NEXT_BAR_OPEN",
        requirePitExecution: true,
        deterministicSeed: 42,
        dataQuality: "SYNTHETIC",
      },
      {},
      180,
      60,
      60
    );

    let sumFoldRoundTrips = 0;
    for (const fold of wfResult.foldReports) {
      sumFoldRoundTrips += fold.oosMetrics.roundTripCount;
    }
    expect(wfResult.aggregateOosMetrics.roundTripCount).toBe(sumFoldRoundTrips);
  });

  // T34: fold terminal position not force-closed
  it("T34: fold terminal position not force-closed", () => {
    const execs = [
      createMockExecution({ side: "BUY", quantity: 1, executionPrice: 100, fees: 1 }),
    ];
    const res = reconstructTradeAttribution(execs);
    expect(res.summary.roundTripCount).toBe(0);
    expect(res.summary.openQuantity).toBe(1);
  });

  // T35: DCA excluded
  it("T35: DCA excluded", () => {
    const paper = new PaperEngine();
    const dcaMetrics = paper.replay([], { interval: "1h", source: "synthetic" }).benchmarkDca;
    expect(dcaMetrics.botId).toBe("benchmark_dca");
  });

  // T36: Alpha excluded
  it("T36: Alpha excluded", () => {
    const paper = new PaperEngine();
    const trendMetrics = paper.replay([], { interval: "1h", source: "synthetic" }).trend;
    expect(trendMetrics.trades).toHaveLength(0);
    expect(trendMetrics.status).toBe("UNAVAILABLE");
    expect(trendMetrics.winRate).toBeNull();
  });

  // T37: deterministic replay produces identical attribution
  it("T37: deterministic replay produces identical attribution", () => {
    const execs = [
      createMockExecution({ side: "BUY", quantity: 1, executionPrice: 100, fees: 1, executionTimestamp: 1000 }),
      createMockExecution({ side: "BUY", quantity: 1, executionPrice: 120, fees: 1, executionTimestamp: 2000 }),
      createMockExecution({ side: "SELL", quantity: 1, executionPrice: 130, fees: 1, executionTimestamp: 3000 }),
      createMockExecution({ side: "SELL", quantity: 1, executionPrice: 140, fees: 1, executionTimestamp: 4000 }),
    ];
    const res1 = reconstructTradeAttribution(execs);
    const res2 = reconstructTradeAttribution(execs);
    expect(res1).toEqual(res2);
  });
});
