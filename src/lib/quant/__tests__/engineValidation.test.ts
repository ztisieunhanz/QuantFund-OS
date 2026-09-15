// ============================================================================
// FILE: src/lib/quant/__tests__/engineValidation.test.ts
// MODULE: INVARIANT VERIFICATION SUITE
// PURPOSE: Prove Engine Correctness mathematically before Strategy Deployment
// ============================================================================

import { describe, it, expect } from "vitest";
import { runBacktest, type BacktestDataset } from "../backtestEngine";
import type {
  BacktestConfig,
  PointInTimeBar,
  PointInTimeEvent,
  PointInTimeMacro,
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

  const startMs = 1700000000000; // Epoch ms
  for (let i = 0; i < count; i++) {
    const change = (lcg() - 0.49) * 0.04; // -2% to +2% daily swing
    const open = current;
    current = Math.max(100, open * (1 + change));
    const high = Math.max(open, current) * (1 + lcg() * 0.01);
    const low = Math.min(open, current) * (1 - lcg() * 0.01);
    const volume = 1000 + lcg() * 5000;

    bars.push({
      timestamp: startMs + i * 86400000,
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

    // Điểm kiểm tra: Bar thứ 140 (sau warmup 125)
    const targetBarIndex = 140;
    const decisionAtTargetA = resultA.timeline.find((d) => d.barIndex === targetBarIndex);
    expect(decisionAtTargetA).toBeDefined();

    // TẠO ĐỘT BIẾN TƯƠNG LAI: Thay đổi dữ liệu tại Bar 160 (T + 20) thành một cú sập -90%
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

    // Xác minh quyết định tại TargetBar (140) phải giống hệt nhau tuyệt đối
    expect(decisionAtTargetA?.nav).toBe(decisionAtTargetB?.nav);
    expect(decisionAtTargetA?.signals).toEqual(decisionAtTargetB?.signals);
    expect(decisionAtTargetA?.targetWeights).toEqual(decisionAtTargetB?.targetWeights);
    expect(decisionAtTargetA?.risk).toEqual(decisionAtTargetB?.risk);
  });

  it("EVENT INTEGRITY: Events with consensus timestamp in the future must be ignored", () => {
    const bars = generateSyntheticBars(150, 50000, 202);
    const targetTimestamp = bars[130].timestamp;

    // Event có publication hợp lệ nhưng consensus bị rò rỉ từ tương lai (+10 phút)
    const futureConsensusEvent: PointInTimeEvent = {
      eventId: "cpi-leaked",
      eventType: "CPI",
      eventTimestamp: targetTimestamp,
      publicationTimestamp: targetTimestamp,
      consensusSnapshotTimestamp: targetTimestamp + 600000, // Tương lai!
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
    // Engine phải từ chối đọc event này do consensus snapshot chưa có hiệu lực
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
      
      // Cho phép dung sai làm tròn 0.05 USD
      expect(Math.abs(state.nav - expectedNav)).toBeLessThan(0.05);

      // Số dư tiền mặt không bao giờ được phép âm
      expect(state.cash).toBeGreaterThanOrEqual(-1e-6);

      // Không chứa NaN hoặc Infinity
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

    // Mọi quyết định được ghi nhận đều phải có barIndex >= warmupPeriod
    for (const state of result.timeline) {
      expect(state.barIndex).toBeGreaterThanOrEqual(config.warmupPeriod);
    }
    
    // Bar đầu tiên được đánh giá phải bắt đầu với số vốn ban đầu
    const firstDecision = result.timeline[0];
    expect(firstDecision.nav).toBe(config.initialCapital);
  });
});