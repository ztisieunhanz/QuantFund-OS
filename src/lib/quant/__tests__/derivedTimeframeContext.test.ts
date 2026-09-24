import { describe, expect, it } from "vitest";
import {
  BAR_DURATION_MS,
} from "../timeDomain";
import {
  deriveHigherTimeframeContext,
  FOUR_HOUR_DURATION_MS,
  ONE_DAY_DURATION_MS,
} from "../derivedTimeframeContext";
import type { PointInTimeBar } from "../types";

const HOUR = BAR_DURATION_MS;
const DAY = ONE_DAY_DURATION_MS;
const UTC_DAY = Date.UTC(2024, 0, 1);

function bar(timestamp: number, seed = timestamp / HOUR): PointInTimeBar {
  const open = 100 + seed;
  return { timestamp, open, high: open + 5, low: open - 3, close: open + 2, volume: 10 + seed };
}

function bars(start: number, count: number): PointInTimeBar[] {
  return Array.from({ length: count }, (_, index) => bar(start + index * HOUR, index));
}

function derive(inputBars: readonly PointInTimeBar[], decisionTime: number, assetId = "BTC") {
  return deriveHigherTimeframeContext({ assetId, eligible1hBars: inputBars, decisionTime });
}

describe("M13C C-A derived PIT-safe 4H/1D research context", () => {
  it("derives one 4H candle from four consecutive closed 1H bars", () => {
    const result = derive(bars(UTC_DAY, 4), UTC_DAY + 4 * HOUR);
    expect(result.completed4hBars).toHaveLength(1);
    expect(result.latestCompleted4hBar?.componentCount).toBe(4);
  });

  it("hides the current incomplete 4H bucket", () => {
    const result = derive(bars(UTC_DAY, 7), UTC_DAY + 7 * HOUR);
    expect(result.completed4hBars).toHaveLength(1);
    expect(result.latestCompleted4hBar?.startTime).toBe(UTC_DAY);
  });

  it("exposes a 4H candle exactly when its final component becomes eligible", () => {
    const input = bars(UTC_DAY, 4);
    expect(derive(input, UTC_DAY + 4 * HOUR - 1).completed4hBars).toHaveLength(0);
    expect(derive(input, UTC_DAY + 4 * HOUR).completed4hBars).toHaveLength(1);
  });

  it("does not compress a missing hour into a 4H candle", () => {
    const input = [bar(UTC_DAY), bar(UTC_DAY + HOUR), bar(UTC_DAY + 3 * HOUR), bar(UTC_DAY + 4 * HOUR)];
    expect(derive(input, UTC_DAY + 5 * HOUR).completed4hBars).toHaveLength(0);
  });

  it("rejects conflicting eligible duplicates fail-closed", () => {
    const input = [...bars(UTC_DAY, 4), { ...bar(UTC_DAY, 0), close: 103 }];
    expect(() => derive(input, UTC_DAY + 4 * HOUR)).toThrow(/Conflicting duplicate/);
  });

  it("rejects exact eligible duplicates consistently with canonical replay", () => {
    const duplicate = bar(UTC_DAY);
    expect(() => derive([duplicate, duplicate], UTC_DAY + HOUR)).toThrow(/Exact duplicate/);
  });

  it("is independent of caller input ordering", () => {
    const input = bars(UTC_DAY, 8);
    expect(derive([...input].reverse(), UTC_DAY + 8 * HOUR)).toEqual(derive(input, UTC_DAY + 8 * HOUR));
  });

  it("aggregates 4H OHLC correctly", () => {
    const input: PointInTimeBar[] = [
      { timestamp: UTC_DAY, open: 10, high: 12, low: 8, close: 11, volume: 1 },
      { timestamp: UTC_DAY + HOUR, open: 11, high: 15, low: 10, close: 14, volume: 2 },
      { timestamp: UTC_DAY + 2 * HOUR, open: 14, high: 16, low: 7, close: 8, volume: 3 },
      { timestamp: UTC_DAY + 3 * HOUR, open: 8, high: 13, low: 6, close: 12, volume: 4 },
    ];
    expect(derive(input, UTC_DAY + 4 * HOUR).latestCompleted4hBar).toMatchObject({
      open: 10, high: 16, low: 6, close: 12,
    });
  });

  it("sums component volume", () => {
    expect(derive(bars(UTC_DAY, 4), UTC_DAY + 4 * HOUR).latestCompleted4hBar?.volume).toBe(46);
  });

  it("derives a complete UTC day", () => {
    const result = derive(bars(UTC_DAY, 24), UTC_DAY + DAY);
    expect(result.completed1dBars).toHaveLength(1);
    expect(result.latestCompleted1dBar).toMatchObject({
      startTime: UTC_DAY,
      endTime: UTC_DAY + DAY,
      availableAt: UTC_DAY + DAY,
      componentCount: 24,
    });
  });

  it("hides the partial current UTC day", () => {
    const input = bars(UTC_DAY, 30);
    const result = derive(input, UTC_DAY + 30 * HOUR);
    expect(result.completed1dBars).toHaveLength(1);
    expect(result.latestCompleted1dBar?.startTime).toBe(UTC_DAY);
  });

  it("exposes a daily candle exactly at the UTC close boundary", () => {
    const input = bars(UTC_DAY, 24);
    expect(derive(input, UTC_DAY + DAY - 1).completed1dBars).toHaveLength(0);
    expect(derive(input, UTC_DAY + DAY).completed1dBars).toHaveLength(1);
  });

  it("does not emit a day with a missing component hour", () => {
    const input = bars(UTC_DAY, 24).filter((_, index) => index !== 12);
    expect(derive(input, UTC_DAY + DAY).completed1dBars).toHaveLength(0);
  });

  it("excludes future 1H bars at an earlier decisionTime", () => {
    expect(derive(bars(UTC_DAY, 8), UTC_DAY + 4 * HOUR).completed4hBars).toHaveLength(1);
  });

  it("excludes a component whose availableAt is after decisionTime", () => {
    expect(derive(bars(UTC_DAY, 4), UTC_DAY + 4 * HOUR - 1).latestCompleted4hBar).toBeNull();
  });

  it("includes a component whose availableAt equals decisionTime", () => {
    expect(derive(bars(UTC_DAY, 4), UTC_DAY + 4 * HOUR).latestCompleted4hBar).not.toBeNull();
  });

  it("does not leak future high low or close values", () => {
    const input = bars(UTC_DAY, 5);
    input[4] = { ...input[4], high: 1_000_000, low: 1, close: 999_999 };
    expect(derive(input, UTC_DAY + 4 * HOUR).latestCompleted4hBar).toEqual(
      derive(input.slice(0, 4), UTC_DAY + 4 * HOUR).latestCompleted4hBar
    );
  });

  it("keeps BTC and PAXG derivations asset-isolated", () => {
    const input = bars(UTC_DAY, 4);
    const btc = derive(input, UTC_DAY + 4 * HOUR, "BTC");
    const paxg = derive(input.map((item) => ({
      ...item,
      open: item.open + 100,
      high: item.high + 100,
      low: item.low + 100,
      close: item.close + 100,
    })), UTC_DAY + 4 * HOUR, "PAXG");
    expect(btc.latestCompleted4hBar?.assetId).toBe("BTC");
    expect(paxg.latestCompleted4hBar?.assetId).toBe("PAXG");
    expect(btc.latestCompleted4hBar?.close).not.toBe(paxg.latestCompleted4hBar?.close);
  });

  it("is deterministic across repeated invocation", () => {
    const input = bars(UTC_DAY, 24);
    expect(derive(input, UTC_DAY + DAY)).toEqual(derive(input, UTC_DAY + DAY));
  });

  it("uses UTC epoch boundaries across a daylight-saving transition", () => {
    const dstDay = Date.UTC(2024, 2, 10);
    const result = derive(bars(dstDay, 24), dstDay + DAY);
    expect(new Date(result.latestCompleted1dBar?.startTime ?? 0).toISOString()).toBe("2024-03-10T00:00:00.000Z");
    expect(new Date(result.latestCompleted1dBar?.endTime ?? 0).toISOString()).toBe("2024-03-11T00:00:00.000Z");
  });

  it("does not mutate the caller's 1H input", () => {
    const input = bars(UTC_DAY, 4).reverse();
    const before = structuredClone(input);
    derive(input, UTC_DAY + 4 * HOUR);
    expect(input).toEqual(before);
  });

  it("returns immutable context and derived bars", () => {
    const result = derive(bars(UTC_DAY, 4), UTC_DAY + FOUR_HOUR_DURATION_MS);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.completed4hBars)).toBe(true);
    expect(Object.isFrozen(result.latestCompleted4hBar)).toBe(true);
  });

  it("declares research-only output with no execution or price authority", () => {
    const result = derive(bars(UTC_DAY, 4), UTC_DAY + FOUR_HOUR_DURATION_MS);
    expect(result).toMatchObject({
      intendedUse: "RESEARCH_CONTEXT_ONLY",
      grantsExecutionAuthority: false,
      priceAuthority: "NONE",
    });
    expect(result).not.toHaveProperty("assetBars");
    expect(result).not.toHaveProperty("targetWeights");
    expect(result).not.toHaveProperty("executions");
  });
});
