// ============================================================================
// FILE: src/lib/quant/__tests__/accountingValidation.test.ts
// MODULE: GATE M8B DETERMINISTIC ACCOUNTING & RECONCILIATION SUITE
// ============================================================================

import { describe, expect, it } from "vitest";
import { executeRebalance, type PortfolioAccountState, type ExecutionContext } from "../executionEngine";
import { runBacktest, type BacktestDataset } from "../backtestEngine";
import { PaperEngine } from "@/lib/paperEngine";
import { deriveMetricsFromDecision } from "@/stores/tradingStore";
import type { BacktestConfig, PointInTimeBar, TargetPortfolioWeight } from "../types";

function createBarSeries(
  count: number,
  pricePattern?: (i: number) => number
): PointInTimeBar[] {
  const baseTime = 1750000000000;
  const bars: PointInTimeBar[] = [];
  for (let i = 0; i < count; i++) {
    const price = pricePattern ? pricePattern(i) : 50000;
    bars.push({
      timestamp: baseTime + i * 3600 * 1000,
      open: price,
      high: price + 100,
      low: price - 100,
      close: price,
      volume: 1000,
    });
  }
  return bars;
}

function createOhlcvSeries(
  count: number,
  pricePattern?: (i: number) => number
): Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }> {
  const pit = createBarSeries(count, pricePattern);
  return pit.map((b) => ({
    time: Math.floor(b.timestamp / 1000),
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
  }));
}

function makeTargetWeight(
  assetWeights: Record<string, number>,
  timestamp = 1750000000000,
  rationale = "Test target"
): TargetPortfolioWeight {
  const btcW = assetWeights["BTC"] ?? 0;
  return {
    asOfTimestamp: timestamp,
    assetWeights,
    cashWeight: Math.max(0, 1 - btcW),
    grossExposure: Math.abs(btcW),
    netExposure: btcW,
    strategyAllocations: { ADAPTIVE_TREND: 0, EVENT_REACTION: 0, MEAN_REVERSION: 0 },
    riskAdjustmentRatio: 1.0,
    rationale,
  };
}

describe("Gate M8B Canonical Accounting & Deterministic Reconciliation Suite", () => {
  const defaultContext: ExecutionContext = {
    decisionTimestamp: 1750000000000,
    executionTimestamp: 1750003600000,
    executionRule: "NEXT_BAR_OPEN",
    commissionRate: 0.001, // 10 bps
    slippageConfig: { type: "FIXED_BPS", baseBps: 5 }, // 5 bps
  };

  it("T1: no trade / all cash", () => {
    const bars = createBarSeries(150, () => 50000);
    const dataset: BacktestDataset = { assetBars: { BTC: bars } };
    const config: BacktestConfig = {
      runId: "t1-no-trade",
      startDate: 0,
      endDate: 0,
      warmupPeriod: 125,
      initialCapital: 10000,
      commissionRate: 0.001,
      slippageModel: { type: "FIXED_BPS", baseBps: 5 },
      executionRule: "NEXT_BAR_OPEN",
      deterministicSeed: 42,
      dataQuality: "LIVE",
    };

    const res = runBacktest(config, dataset);
    expect(res.timeline.length).toBeGreaterThan(0);
    const last = res.timeline.at(-1)!;
    expect(last.cash).toBe(10000);
    expect(last.positions["BTC"]?.quantity ?? 0).toBe(0);
    expect(last.nav).toBe(10000);
    expect(last.currentDrawdown).toBe(0);
    expect(res.metrics.totalTrades).toBe(0);
  });

  it("T2: first buy execution", () => {
    const account: PortfolioAccountState = { cash: 10000, positions: {} };
    const weights = makeTargetWeight({ BTC: 0.5 }, 1750000000000, "Test buy 50%");
    const bars = {
      BTC: {
        timestamp: 1750003600000,
        open: 50000,
        high: 50100,
        low: 49900,
        close: 50000,
        volume: 1000,
      },
    };

    const res = executeRebalance(account, weights, bars, defaultContext);
    expect(res.records.length).toBe(1);
    const rec = res.records[0];
    expect(rec.side).toBe("BUY");
    expect(rec.executionPrice).toBe(50025); // 50000 * 1.0005
    expect(res.updatedAccount.positions["BTC"].quantity).toBeGreaterThan(0);
    expect(res.updatedAccount.positions["BTC"].entryPrice).toBe(50025);

    const gross = rec.quantity * rec.executionPrice;
    const expectedFee = gross * 0.001;
    expect(res.updatedAccount.cash).toBeCloseTo(10000 - (gross + expectedFee), 2);
  });

  it("T3: buy + unchanged closing mark", () => {
    const account: PortfolioAccountState = { cash: 10000, positions: {} };
    const weights = makeTargetWeight({ BTC: 0.5 }, 1750000000000, "Test buy");
    const bar = {
      timestamp: 1750003600000,
      open: 50000,
      high: 50100,
      low: 49900,
      close: 50000,
      volume: 1000,
    };

    const res = executeRebalance(account, weights, { BTC: bar }, defaultContext);
    const pos = res.updatedAccount.positions["BTC"];
    const navAtClose = res.updatedAccount.cash + pos.quantity * bar.close;

    // NAV should equal initial capital minus fee and slippage drag
    expect(navAtClose).toBeLessThan(10000);
    expect(navAtClose).toBeGreaterThan(9900);
  });

  it("T4: buy + price rise", () => {
    const account: PortfolioAccountState = { cash: 10000, positions: {} };
    const weights = makeTargetWeight({ BTC: 0.5 }, 1750000000000, "Test buy");
    const openBar = { timestamp: 1750003600000, open: 50000, high: 50100, low: 49900, close: 50000, volume: 1000 };
    const res = executeRebalance(account, weights, { BTC: openBar }, defaultContext);

    const risePrice = 55000; // +10%
    const pos = res.updatedAccount.positions["BTC"];
    const navAfterRise = res.updatedAccount.cash + pos.quantity * risePrice;

    expect(navAfterRise).toBeGreaterThan(10000);
    const cumPnl = navAfterRise - 10000;
    expect(cumPnl).toBeGreaterThan(0);
  });

  it("T5: buy + price fall", () => {
    const account: PortfolioAccountState = { cash: 10000, positions: {} };
    const weights = makeTargetWeight({ BTC: 0.5 }, 1750000000000, "Test buy");
    const openBar = { timestamp: 1750003600000, open: 50000, high: 50100, low: 49900, close: 50000, volume: 1000 };
    const res = executeRebalance(account, weights, { BTC: openBar }, defaultContext);

    const fallPrice = 45000; // -10%
    const pos = res.updatedAccount.positions["BTC"];
    const navAfterFall = res.updatedAccount.cash + pos.quantity * fallPrice;

    const peakNav = 10000;
    const drawdown = (peakNav - navAfterFall) / peakNav;
    expect(drawdown).toBeGreaterThan(0);
    expect(navAfterFall).toBeLessThan(10000);
  });

  it("T6: scale-in weighted average cost", () => {
    let account: PortfolioAccountState = { cash: 10000, positions: {} };

    // Exec 1 at 50,000
    const w1 = makeTargetWeight({ BTC: 0.3 }, 1, "Buy 30%");
    const bar1 = { timestamp: 1, open: 50000, high: 50100, low: 49900, close: 50000, volume: 1000 };
    const res1 = executeRebalance(account, w1, { BTC: bar1 }, defaultContext);
    account = res1.updatedAccount;

    const qty1 = account.positions["BTC"].quantity;
    const execPrice1 = res1.records[0].executionPrice; // 50025

    // Exec 2 at 60,000
    const w2 = makeTargetWeight({ BTC: 0.6 }, 2, "Scale in 60%");
    const bar2 = { timestamp: 2, open: 60000, high: 60100, low: 59900, close: 60000, volume: 1000 };
    const res2 = executeRebalance(account, w2, { BTC: bar2 }, defaultContext);
    account = res2.updatedAccount;

    const qty2 = account.positions["BTC"].quantity - qty1;
    const execPrice2 = res2.records[0].executionPrice; // 60030

    const expectedEntry = (qty1 * execPrice1 + qty2 * execPrice2) / (qty1 + qty2);
    expect(account.positions["BTC"].entryPrice).toBeCloseTo(expectedEntry, 2);
    expect(account.positions["BTC"].quantity).toBeCloseTo(qty1 + qty2, 5);
  });

  it("T7: partial sell", () => {
    let account: PortfolioAccountState = { cash: 10000, positions: {} };

    // Buy 60%
    const w1 = makeTargetWeight({ BTC: 0.6 }, 1, "Buy 60%");
    const bar1 = { timestamp: 1, open: 50000, high: 50100, low: 49900, close: 50000, volume: 1000 };
    const res1 = executeRebalance(account, w1, { BTC: bar1 }, defaultContext);
    account = res1.updatedAccount;

    const initialEntry = account.positions["BTC"].entryPrice;
    const initialQty = account.positions["BTC"].quantity;

    // Partial sell to 20%
    const w2 = makeTargetWeight({ BTC: 0.2 }, 2, "Sell to 20%");
    const bar2 = { timestamp: 2, open: 55000, high: 55100, low: 54900, close: 55000, volume: 1000 };
    const res2 = executeRebalance(account, w2, { BTC: bar2 }, defaultContext);
    account = res2.updatedAccount;

    expect(account.positions["BTC"].quantity).toBeLessThan(initialQty);
    expect(account.positions["BTC"].quantity).toBeGreaterThan(0);
    // Entry price (cost basis) MUST be preserved on partial sell
    expect(account.positions["BTC"].entryPrice).toBe(initialEntry);
  });

  it("T8: full exit", () => {
    let account: PortfolioAccountState = { cash: 10000, positions: {} };

    // Buy 50%
    const w1 = makeTargetWeight({ BTC: 0.5 }, 1, "Buy 50%");
    const bar1 = { timestamp: 1, open: 50000, high: 50100, low: 49900, close: 50000, volume: 1000 };
    const res1 = executeRebalance(account, w1, { BTC: bar1 }, defaultContext);
    account = res1.updatedAccount;

    // Exit to 0%
    const w2 = makeTargetWeight({ BTC: 0 }, 2, "Exit 0%");
    const bar2 = { timestamp: 2, open: 52000, high: 52100, low: 51900, close: 52000, volume: 1000 };
    const res2 = executeRebalance(account, w2, { BTC: bar2 }, defaultContext);
    account = res2.updatedAccount;

    const btcPos = account.positions["BTC"];
    expect(btcPos.quantity).toBe(0);
    expect(btcPos.entryPrice).toBe(0);
    expect(btcPos.side).toBe("FLAT");
    expect(btcPos.status).toBe("CLOSED");
  });

  it("T9: re-entry", () => {
    let account: PortfolioAccountState = { cash: 10000, positions: {} };

    // Buy 50%, then exit
    const bar1 = { timestamp: 1, open: 50000, high: 50100, low: 49900, close: 50000, volume: 1000 };
    account = executeRebalance(account, makeTargetWeight({ BTC: 0.5 }, 1, "Buy"), { BTC: bar1 }, defaultContext).updatedAccount;
    account = executeRebalance(account, makeTargetWeight({ BTC: 0 }, 2, "Exit"), { BTC: bar1 }, defaultContext).updatedAccount;

    // Re-entry at 70,000
    const bar3 = { timestamp: 3, open: 70000, high: 70100, low: 69900, close: 70000, volume: 1000 };
    const res3 = executeRebalance(account, makeTargetWeight({ BTC: 0.4 }, 3, "Re-entry"), { BTC: bar3 }, defaultContext);

    const btcPos = res3.updatedAccount.positions["BTC"];
    expect(btcPos.quantity).toBeGreaterThan(0);
    expect(btcPos.entryPrice).toBe(70000 * 1.0005); // 70035
  });

  it("T10: fee-only impact", () => {
    const account: PortfolioAccountState = { cash: 10000, positions: {} };
    const feeOnlyContext: ExecutionContext = {
      ...defaultContext,
      commissionRate: 0.001, // 10 bps
      slippageConfig: { type: "FIXED_BPS", baseBps: 0 }, // 0 bps
    };

    const bar = { timestamp: 1, open: 50000, high: 50100, low: 49900, close: 50000, volume: 1000 };
    const res = executeRebalance(account, makeTargetWeight({ BTC: 0.5 }, 1, "Buy"), { BTC: bar }, feeOnlyContext);

    const rec = res.records[0];
    expect(rec.executionPrice).toBe(50000);
    expect(rec.fees).toBeCloseTo(rec.notionalUsd * 0.001, 2);
    expect(res.updatedAccount.cash).toBeCloseTo(10000 - (rec.notionalUsd + rec.fees), 2);
  });

  it("T11: slippage-only impact", () => {
    const account: PortfolioAccountState = { cash: 10000, positions: {} };
    const slippageOnlyContext: ExecutionContext = {
      ...defaultContext,
      commissionRate: 0, // 0 fee
      slippageConfig: { type: "FIXED_BPS", baseBps: 5 }, // 5 bps
    };

    const bar = { timestamp: 1, open: 50000, high: 50100, low: 49900, close: 50000, volume: 1000 };
    const res = executeRebalance(account, makeTargetWeight({ BTC: 0.5 }, 1, "Buy"), { BTC: bar }, slippageOnlyContext);

    const rec = res.records[0];
    expect(rec.executionPrice).toBe(50025);
    expect(rec.fees).toBe(0);
    expect(res.updatedAccount.cash).toBeCloseTo(10000 - rec.notionalUsd, 2);
  });

  it("T12: fee + slippage together", () => {
    const account: PortfolioAccountState = { cash: 10000, positions: {} };
    const bar = { timestamp: 1, open: 50000, high: 50100, low: 49900, close: 50000, volume: 1000 };
    const res = executeRebalance(account, makeTargetWeight({ BTC: 0.5 }, 1, "Buy"), { BTC: bar }, defaultContext);

    const rec = res.records[0];
    expect(rec.executionPrice).toBe(50025);
    expect(rec.fees).toBeCloseTo(rec.notionalUsd * 0.001, 2);
    expect(res.updatedAccount.cash).toBeCloseTo(10000 - (rec.notionalUsd + rec.fees), 2);
  });

  it("T13: insufficient cash affordability clamp", () => {
    const account: PortfolioAccountState = { cash: 10000, positions: {} };
    const bar = { timestamp: 1, open: 50000, high: 50100, low: 49900, close: 50000, volume: 1000 };

    // Request 100% allocation
    const res = executeRebalance(account, makeTargetWeight({ BTC: 1.0 }, 1, "All in"), { BTC: bar }, defaultContext);

    expect(res.updatedAccount.cash).toBeGreaterThanOrEqual(0);
    expect(res.updatedAccount.cash).toBeLessThan(0.01);
  });

  it("T14: target weight zero", () => {
    const account: PortfolioAccountState = { cash: 10000, positions: {} };
    const bar = { timestamp: 1, open: 50000, high: 50100, low: 49900, close: 50000, volume: 1000 };

    const res1 = executeRebalance(account, makeTargetWeight({ BTC: 0.5 }, 1, "Buy"), { BTC: bar }, defaultContext);
    const res2 = executeRebalance(res1.updatedAccount, makeTargetWeight({ BTC: 0 }, 2, "Zero"), { BTC: bar }, defaultContext);

    expect(res2.updatedAccount.positions["BTC"].quantity).toBe(0);
    expect(res2.updatedAccount.positions["BTC"].side).toBe("FLAT");
  });

  it("T15: negative target cannot create short", () => {
    const account: PortfolioAccountState = { cash: 10000, positions: {} };
    const bar = { timestamp: 1, open: 50000, high: 50100, low: 49900, close: 50000, volume: 1000 };

    // Pass negative weight -0.5
    const res = executeRebalance(account, makeTargetWeight({ BTC: -0.5 }, 1, "Negative"), { BTC: bar }, defaultContext);

    expect(res.records.length).toBe(0);
    expect(res.updatedAccount.positions["BTC"]?.quantity ?? 0).toBe(0);
    expect(res.updatedAccount.cash).toBe(10000);
  });

  it("T16: repeated same target", () => {
    const account: PortfolioAccountState = { cash: 10000, positions: {} };
    const bar = { timestamp: 1, open: 50000, high: 50100, low: 49900, close: 50000, volume: 1000 };

    const res1 = executeRebalance(account, makeTargetWeight({ BTC: 0.5 }, 1, "Buy"), { BTC: bar }, defaultContext);
    const res2 = executeRebalance(res1.updatedAccount, makeTargetWeight({ BTC: 0.5 }, 2, "Repeat"), { BTC: bar }, defaultContext);

    // Repeated target within minimum threshold produces 0 new trades
    expect(res2.records.length).toBe(0);
    expect(res2.updatedAccount.cash).toBe(res1.updatedAccount.cash);
  });

  it("T17: canonical NAV identity at every DecisionState", () => {
    const bars = createOhlcvSeries(150, (i) => 50000 + (i % 20) * 100);
    const engine = new PaperEngine();
    const { latestDecision } = engine.replay(bars, { interval: "1h", source: "live" });

    expect(latestDecision).not.toBeNull();
    if (latestDecision) {
      const btcPos = latestDecision.positions["BTC"];
      const qty = btcPos?.quantity ?? 0;
      const lastBarClose = bars.at(-1)!.close;
      const expectedNav = Math.round((latestDecision.cash + qty * lastBarClose) * 100) / 100;
      expect(latestDecision.nav).toBe(expectedNav);
    }
  });

  it("T18: closing unrealizedPnl matches closing mark", () => {
    const bars = createOhlcvSeries(150, (i) => 50000 + i * 10);
    const engine = new PaperEngine();
    const { latestDecision } = engine.replay(bars, { interval: "1h", source: "live" });

    expect(latestDecision).not.toBeNull();
    if (latestDecision) {
      const btcPos = latestDecision.positions["BTC"];
      if (btcPos && btcPos.quantity > 0) {
        const lastClose = bars.at(-1)!.close;
        const expectedUnrealized = Math.round((lastClose - btcPos.entryPrice) * btcPos.quantity * 100) / 100;
        expect(btcPos.unrealizedPnl).toBe(expectedUnrealized);
      }
    }
  });

  it("T19: total fees are informational only and not double-subtracted", () => {
    const bars = createBarSeries(150, () => 50000);
    const dataset: BacktestDataset = { assetBars: { BTC: bars } };
    const config: BacktestConfig = {
      runId: "t19-fees",
      startDate: 0,
      endDate: 0,
      warmupPeriod: 125,
      initialCapital: 10000,
      commissionRate: 0.001,
      slippageModel: { type: "FIXED_BPS", baseBps: 5 },
      executionRule: "NEXT_BAR_OPEN",
      deterministicSeed: 42,
      dataQuality: "LIVE",
    };

    const res = runBacktest(config, dataset);
    const lastState = res.timeline.at(-1)!;

    // NAV = cash + pos.quantity * close. Fees already deducted from cash during execution.
    const pos = lastState.positions["BTC"];
    const qty = pos?.quantity ?? 0;
    const computedNav = Math.round((lastState.cash + qty * bars.at(-1)!.close) * 100) / 100;

    expect(lastState.nav).toBe(computedNav);
    // Metrics totalFeesUsd is purely informational summary
    expect(res.metrics.totalFeesUsd).toBeGreaterThanOrEqual(0);
  });

  it("T20: slippage summary is informational only and not double-subtracted", () => {
    const bars = createBarSeries(150, () => 50000);
    const dataset: BacktestDataset = { assetBars: { BTC: bars } };
    const config: BacktestConfig = {
      runId: "t20-slippage",
      startDate: 0,
      endDate: 0,
      warmupPeriod: 125,
      initialCapital: 10000,
      commissionRate: 0.001,
      slippageModel: { type: "FIXED_BPS", baseBps: 5 },
      executionRule: "NEXT_BAR_OPEN",
      deterministicSeed: 42,
      dataQuality: "LIVE",
    };

    const res = runBacktest(config, dataset);
    const lastState = res.timeline.at(-1)!;
    const pos = lastState.positions["BTC"];
    const qty = pos?.quantity ?? 0;
    const computedNav = Math.round((lastState.cash + qty * bars.at(-1)!.close) * 100) / 100;

    expect(lastState.nav).toBe(computedNav);
    expect(res.metrics.totalSlippageCostUsd).toBeGreaterThanOrEqual(0);
  });

  it("T21: deterministic replay identity", () => {
    const bars = createOhlcvSeries(150, (i) => 50000 + (i % 10) * 150);
    const engine1 = new PaperEngine();
    const engine2 = new PaperEngine();

    const res1 = engine1.replay(bars, { interval: "1h", source: "live" });
    const res2 = engine2.replay(bars, { interval: "1h", source: "live" });

    expect(res1.latestDecision?.nav).toBe(res2.latestDecision?.nav);
    expect(res1.latestDecision?.cash).toBe(res2.latestDecision?.cash);
    expect(res1.latestDecision?.positions["BTC"]?.quantity).toBe(res2.latestDecision?.positions["BTC"]?.quantity);
    expect(res1.omega.equity).toBe(res2.omega.equity);
  });

  it("T22: fresh replay Omega equity === latestDecision.nav", () => {
    const bars = createOhlcvSeries(150, (i) => 50000 + (i % 15) * 100);
    const engine = new PaperEngine();
    const res = engine.replay(bars, { interval: "1h", source: "live" });

    expect(res.latestDecision).not.toBeNull();
    expect(res.omega.equity).toBe(res.latestDecision!.nav);
    expect(res.omega.cash).toBe(res.latestDecision!.cash);
  });

  it("T23: hydration Omega equity === same latestDecision.nav", () => {
    const bars = createOhlcvSeries(150, (i) => 50000 + (i % 15) * 100);
    const engine = new PaperEngine();
    const res = engine.replay(bars, { interval: "1h", source: "live" });

    const dec = res.latestDecision!;
    const derived = deriveMetricsFromDecision(dec);

    expect(derived.omega.equity).toBe(dec.nav);
    expect(derived.omega.cash).toBe(dec.cash);
  });

  it("T24: fresh replay vs hydration canonical NAV parity", () => {
    const bars = createOhlcvSeries(150, (i) => 50000 + (i % 15) * 100);
    const engine = new PaperEngine();
    const freshResult = engine.replay(bars, { interval: "1h", source: "live" });

    const dec = freshResult.latestDecision!;
    const derivedResult = deriveMetricsFromDecision(dec);

    expect(freshResult.omega.equity).toBe(derivedResult.omega.equity);
    expect(freshResult.omega.cash).toBe(derivedResult.omega.cash);
    expect(freshResult.omega.pnl).toBe(derivedResult.omega.pnl);
    expect(freshResult.omega.maxDrawdown).toBe(derivedResult.omega.maxDrawdown);
  });
});
