import { describe, expect, it } from "vitest";
import { createDeferredActionDecision } from "../actionDecision";
import { runBacktest, type BacktestDataset } from "../backtestEngine";
import type { PortfolioAccountState } from "../executionEngine";
import {
  createCanonicalPortfolioValuationSnapshot,
  PORTFOLIO_WEIGHT_RECONCILIATION_TOLERANCE,
  validateCanonicalPortfolioValuationSnapshot,
  type CanonicalValuationMarkInput,
} from "../portfolioValuation";
import {
  createInitialRiskState,
  DEFAULT_RISK_ENGINE_CONFIG,
  evaluatePortfolioRisk,
  validateRiskOutputAgainstCanonicalValuation,
} from "../riskEngine";
import type { BacktestConfig, PointInTimeBar, PositionRecord } from "../types";

const HOUR = 3_600_000;
const decisionTime = Date.UTC(2025, 5, 15, 13);

function bar(close: number, timestamp = decisionTime - HOUR): PointInTimeBar {
  return { timestamp, open: close, high: close + 1, low: close - 1, close, volume: 1_000 };
}

function position(assetId: string, quantity: number, entryPrice = 50): PositionRecord {
  return {
    assetId,
    side: quantity > 0 ? "LONG" : "FLAT",
    status: quantity > 0 ? "OPEN" : "CLOSED",
    quantity,
    entryPrice: quantity > 0 ? entryPrice : 0,
    unrealizedPnl: 0,
  };
}

function account(): PortfolioAccountState {
  return {
    cash: 400,
    positions: {
      BTC: position("BTC", 2),
      ETH: position("ETH", 1),
    },
  };
}

function marks(): CanonicalValuationMarkInput[] {
  return [
    { assetId: "BTC", bar: bar(100) },
    { assetId: "ETH", bar: bar(200) },
  ];
}

function snapshot(overrides: Partial<Parameters<typeof createCanonicalPortfolioValuationSnapshot>[0]> = {}) {
  return createCanonicalPortfolioValuationSnapshot({
    decisionTime,
    account: account(),
    marks: marks(),
    dataQuality: "LIVE",
    ...overrides,
  });
}

function replayBars(count = 132): PointInTimeBar[] {
  return Array.from({ length: count }, (_, index) => ({
    timestamp: 1_700_000_000_000 + index * 3_600_000,
    open: 100 + index,
    high: 101 + index,
    low: 99 + index,
    close: 100.5 + index,
    volume: 10_000,
  }));
}

function replayConfig(dataQuality: BacktestConfig["dataQuality"]): BacktestConfig {
  return {
    runId: `valuation-${dataQuality}`,
    startDate: 0,
    endDate: 0,
    warmupPeriod: 125,
    initialCapital: 10_000,
    commissionRate: 0.001,
    slippageModel: { type: "FIXED_BPS", baseBps: 5 },
    executionRule: "NEXT_BAR_OPEN",
    requirePitExecution: true,
    deterministicSeed: 42,
    dataQuality,
  };
}

describe("M14 A-04 Step 2 canonical portfolio valuation", () => {
  it("derives deterministic NAV and current weights from exact cash, units, and close marks", () => {
    const first = snapshot();
    const reordered = snapshot({
      account: { cash: 400, positions: { ETH: position("ETH", 1), BTC: position("BTC", 2) } },
      marks: [...marks()].reverse(),
    });
    expect(first.nav).toBe(800);
    expect(first.cashWeight).toBe(0.5);
    expect(first.assetWeights).toEqual({ BTC: 0.25, ETH: 0.25 });
    expect(first.valuationMarks.every((mark) => mark.availableAt === decisionTime)).toBe(true);
    expect(first.semanticIdentity).toBe(reordered.semanticIdentity);
    expect(first.accountStateIdentity).toBe(reordered.accountStateIdentity);
    validateCanonicalPortfolioValuationSnapshot(first);
  });

  it("is deeply immutable and binds exact account and price evidence", () => {
    const value = snapshot();
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.accountState)).toBe(true);
    expect(Object.isFrozen(value.accountState.positions)).toBe(true);
    expect(Object.isFrozen(value.valuationMarks)).toBe(true);
    expect(Object.isFrozen(value.valuationMarks[0].bar)).toBe(true);
    expect(value.valuationMarks[0].priceEvidenceIdentity).toMatch(/^sha256:/);
  });

  it("supports a cash-only canonical account without fabricated marks", () => {
    const value = snapshot({ account: { cash: 1_000, positions: {} }, marks: [] });
    expect(value.nav).toBe(1_000);
    expect(value.assetWeights).toEqual({});
    expect(value.cashWeight).toBe(1);
  });

  it("supports multiple held assets and includes each exact market value", () => {
    const value = snapshot();
    expect(value.marketValues).toEqual([
      { assetId: "BTC", units: 2, price: 100, marketValue: 200 },
      { assetId: "ETH", units: 1, price: 200, marketValue: 200 },
    ]);
  });

  it("ignores caller-authored current weights and derives them mechanically", () => {
    const input = { decisionTime, account: account(), marks: marks(), dataQuality: "LIVE", currentWeights: { BTC: 0.99 } };
    const value = createCanonicalPortfolioValuationSnapshot(input as Parameters<typeof createCanonicalPortfolioValuationSnapshot>[0]);
    expect(value.assetWeights).toEqual({ BTC: 0.25, ETH: 0.25 });
  });

  it.each([
    ["missing mark", [{ assetId: "BTC", bar: bar(100) }]],
    ["wrong asset", [{ assetId: "BTC", bar: bar(100) }, { assetId: "PAXG", bar: bar(200) }]],
    ["duplicate mark", [{ assetId: "BTC", bar: bar(100) }, { assetId: "BTC", bar: bar(101) }, { assetId: "ETH", bar: bar(200) }]],
  ])("rejects %s", (_label, invalidMarks) => {
    expect(() => snapshot({ marks: invalidMarks })).toThrow();
  });

  it("accepts the exact eligible completed close on realistic consecutive 1H boundaries", () => {
    const firstOpen = decisionTime - 2 * HOUR;
    const secondOpen = decisionTime - HOUR;
    const value = snapshot({
      marks: [
        { assetId: "BTC", bar: bar(100, secondOpen) },
        { assetId: "ETH", bar: bar(200, secondOpen) },
      ],
    });
    expect(secondOpen - firstOpen).toBe(HOUR);
    expect(value.valuationMarks.map((mark) => mark.bar.timestamp)).toEqual([secondOpen, secondOpen]);
    expect(value.valuationMarks.map((mark) => mark.availableAt)).toEqual([decisionTime, decisionTime]);
  });

  it("rejects the same candle before its close is available", () => {
    const candleOpen = decisionTime - HOUR;
    expect(() => snapshot({
      decisionTime: decisionTime - 1,
      marks: [
        { assetId: "BTC", bar: bar(100, candleOpen) },
        { assetId: "ETH", bar: bar(200, candleOpen) },
      ],
    })).toThrow(/exact completed 1H close/);
  });

  it("rejects future and stale closes instead of looking ahead or forward-filling", () => {
    expect(() => snapshot({ marks: [{ assetId: "BTC", bar: bar(100, decisionTime) }, { assetId: "ETH", bar: bar(200) }] })).toThrow(/exact completed 1H close/);
    expect(() => snapshot({ marks: [{ assetId: "BTC", bar: bar(100, decisionTime - 2 * HOUR) }, { assetId: "ETH", bar: bar(200) }] })).toThrow(/exact completed 1H close/);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -1])("rejects invalid valuation close %s", (close) => {
    expect(() => snapshot({ marks: [{ assetId: "BTC", bar: bar(close) }, { assetId: "ETH", bar: bar(200) }] })).toThrow();
  });

  it("rejects invalid account cash, holdings, and asset identity", () => {
    expect(() => snapshot({ account: { ...account(), cash: Number.NaN } })).toThrow(/cash/);
    expect(() => snapshot({ account: { cash: 400, positions: { BTC: position("BTC", -1), ETH: position("ETH", 1) } } })).toThrow(/long-only/);
    expect(() => snapshot({ account: { cash: 400, positions: { BTC: position("ETH", 2), ETH: position("ETH", 1) } } })).toThrow(/asset mismatch/);
  });

  it("rejects synthetic evidence rather than labeling it canonical", () => {
    expect(() => createCanonicalPortfolioValuationSnapshot({ decisionTime, account: account(), marks: marks(), dataQuality: "SYNTHETIC" })).toThrow(/synthetic\/degraded/);
  });

  it("rejects forged valuation content or identity", () => {
    const value = snapshot();
    expect(() => validateCanonicalPortfolioValuationSnapshot({ ...value, nav: 801 })).toThrow(/mismatch/);
    expect(() => validateCanonicalPortfolioValuationSnapshot({ ...value, semanticIdentity: "sha256:forged" })).toThrow(/mismatch/);
  });

  it("changes identity when cash, units, marks, or decision time changes", () => {
    const base = snapshot();
    const changedCash = snapshot({ account: { ...account(), cash: 401 } });
    const changedUnits = snapshot({ account: { cash: 400, positions: { BTC: position("BTC", 3), ETH: position("ETH", 1) } } });
    const changedMark = snapshot({ marks: [{ assetId: "BTC", bar: bar(101) }, { assetId: "ETH", bar: bar(200) }] });
    const laterTime = decisionTime + 3_600_000;
    const changedTime = snapshot({ decisionTime: laterTime, marks: [{ assetId: "BTC", bar: bar(100, laterTime - HOUR) }, { assetId: "ETH", bar: bar(200, laterTime - HOUR) }] });
    for (const changed of [changedCash, changedUnits, changedMark, changedTime]) expect(changed.semanticIdentity).not.toBe(base.semanticIdentity);
  });

  it("binds Risk to the exact canonical valuation and rejects NAV/time/valuation mismatch", () => {
    const value = snapshot();
    const benchmark = Array.from({ length: 30 }, (_, index) => bar(100 + index, decisionTime - (30 - index) * HOUR));
    const prior = createInitialRiskState();
    const result = evaluatePortfolioRisk(value.nav, 900, benchmark, prior, DEFAULT_RISK_ENGINE_CONFIG, decisionTime, value);
    expect(result.risk.provenance.valuationBindingStatus).toBe("BOUND_CANONICAL_VALUATION");
    expect(result.risk.provenance.valuationIdentity).toBe(value.semanticIdentity);
    validateRiskOutputAgainstCanonicalValuation(result.risk, value, 900, benchmark, prior, result.nextState, DEFAULT_RISK_ENGINE_CONFIG);
    expect(() => evaluatePortfolioRisk(value.nav + 1, 900, benchmark, prior, DEFAULT_RISK_ENGINE_CONFIG, decisionTime, value)).toThrow(/currentNav/);
    expect(() => evaluatePortfolioRisk(value.nav, 900, benchmark, prior, DEFAULT_RISK_ENGINE_CONFIG, decisionTime + 1, value)).toThrow(/decisionTime/);
    const other = snapshot({ account: { ...account(), cash: 401 } });
    expect(() => validateRiskOutputAgainstCanonicalValuation(result.risk, other, 900, benchmark, prior, result.nextState, DEFAULT_RISK_ENGINE_CONFIG)).toThrow();
  });

  it("binds LIVE canonical replay deterministically while leaving synthetic replay explicitly unbound", () => {
    const dataset: BacktestDataset = { assetBars: { BTC: replayBars() } };
    const liveA = runBacktest(replayConfig("LIVE"), dataset);
    const liveB = runBacktest(replayConfig("LIVE"), dataset);
    const synthetic = runBacktest(replayConfig("SYNTHETIC"), dataset);
    expect(liveA.timeline.map((state) => state.risk.provenance?.valuationIdentity)).toEqual(liveB.timeline.map((state) => state.risk.provenance?.valuationIdentity));
    expect(liveA.timeline.every((state) => state.risk.provenance?.valuationBindingStatus === "BOUND_CANONICAL_VALUATION")).toBe(true);
    expect(synthetic.timeline.every((state) => state.risk.provenance?.valuationBindingStatus === "UNBOUND_NONCANONICAL_COMPATIBILITY" && state.risk.provenance.valuationIdentity === null)).toBe(true);
  });

  it("does not use the current still-forming candle close in replay valuation", () => {
    const baseBars = replayBars(140);
    const changedIndex = 132;
    const changedBars = baseBars.map((value, index) => index === changedIndex
      ? { ...value, close: value.close + 10_000, high: value.high + 10_000 }
      : value);
    const base = runBacktest(replayConfig("LIVE"), { assetBars: { BTC: baseBars } });
    const changed = runBacktest(replayConfig("LIVE"), { assetBars: { BTC: changedBars } });
    const baseStep = base.timeline.find((state) => state.barIndex === changedIndex)!;
    const changedStep = changed.timeline.find((state) => state.barIndex === changedIndex)!;
    expect(baseStep.risk.provenance?.valuationIdentity).toBe(changedStep.risk.provenance?.valuationIdentity);
    expect(baseStep.risk.provenance?.navInputIdentity).toBe(changedStep.risk.provenance?.navInputIdentity);
  });

  it("uses 1e-12 only for numerical reconciliation and cannot derive a lifecycle action", () => {
    expect(PORTFOLIO_WEIGHT_RECONCILIATION_TOLERANCE).toBe(1e-12);
    const value = snapshot();
    expect(value.cashWeight + Object.values(value.assetWeights).reduce((sum, weight) => sum + weight, 0)).toBe(1);
    const decision = createDeferredActionDecision({ assetId: "BTC", decisionTime, asOf: decisionTime });
    expect(decision.action).toBe("WAIT");
    expect(decision.actionDerivationStatus).toBe("WAIT_FAIL_CLOSED");
    expect(decision.currentPortfolioState.currentWeight).toBeNull();
    expect(decision.deltaWeight).toBeNull();
  });
});
