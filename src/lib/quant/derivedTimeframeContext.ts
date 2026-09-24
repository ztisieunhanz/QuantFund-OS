// ============================================================================
// FILE: src/lib/quant/derivedTimeframeContext.ts
// MODULE: DERIVED 4H / 1D RESEARCH CONTEXT (GATE M13C / C-A)
//
// PointInTimeBar.timestamp is the canonical UTC 1H candle open time. Its final
// OHLCV is eligible at timestamp + BAR_DURATION_MS. Derived candles are
// research-only views and never become executable-price or accounting authority.
// ============================================================================

import { BAR_DURATION_MS } from "./timeDomain";
import type { AssetId, PointInTimeBar } from "./types";

export const FOUR_HOUR_DURATION_MS = 4 * BAR_DURATION_MS;
export const ONE_DAY_DURATION_MS = 24 * BAR_DURATION_MS;

export type DerivedResearchTimeframe = "4H" | "1D";

export interface DerivedResearchBar {
  readonly assetId: AssetId;
  readonly timeframe: DerivedResearchTimeframe;
  /** UTC candle-open timestamp. */
  readonly timestamp: number;
  readonly startTime: number;
  /** Exclusive UTC interval end and earliest PIT eligibility boundary. */
  readonly endTime: number;
  readonly availableAt: number;
  readonly componentCount: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

export interface DerivedTimeframeContext {
  readonly assetId: AssetId;
  readonly decisionTime: number;
  readonly asOf: number;
  readonly completed4hBars: readonly DerivedResearchBar[];
  readonly completed1dBars: readonly DerivedResearchBar[];
  readonly latestCompleted4hBar: DerivedResearchBar | null;
  readonly latestCompleted1dBar: DerivedResearchBar | null;
  readonly intendedUse: "RESEARCH_CONTEXT_ONLY";
  readonly grantsExecutionAuthority: false;
  readonly priceAuthority: "NONE";
}

export interface DeriveHigherTimeframeContextInput {
  readonly assetId: AssetId;
  readonly eligible1hBars: readonly PointInTimeBar[];
  readonly decisionTime: number;
}

export class DerivedTimeframeContextValidationError extends Error {
  constructor(message: string) {
    super(`[DerivedTimeframeContext] ${message}`);
    this.name = "DerivedTimeframeContextValidationError";
  }
}

function fail(message: string): never {
  throw new DerivedTimeframeContextValidationError(message);
}

function isSameBar(left: PointInTimeBar, right: PointInTimeBar): boolean {
  return left.timestamp === right.timestamp
    && left.open === right.open
    && left.high === right.high
    && left.low === right.low
    && left.close === right.close
    && left.volume === right.volume;
}

function validateEligibleBar(bar: PointInTimeBar): void {
  if (!Number.isSafeInteger(bar.timestamp) || bar.timestamp < 0) {
    fail("1H bar timestamp must be a non-negative safe-integer epoch millisecond.");
  }
  if (bar.timestamp % BAR_DURATION_MS !== 0) {
    fail(`1H bar timestamp ${bar.timestamp} is not aligned to the UTC hourly grid.`);
  }
  if (![bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite)) {
    fail(`1H bar at ${bar.timestamp} contains a non-finite OHLCV value.`);
  }
  if (bar.open <= 0 || bar.high <= 0 || bar.low <= 0 || bar.close <= 0 || bar.volume < 0) {
    fail(`1H bar at ${bar.timestamp} contains an invalid OHLCV value.`);
  }
  if (bar.high < Math.max(bar.open, bar.low, bar.close) || bar.low > Math.min(bar.open, bar.high, bar.close)) {
    fail(`1H bar at ${bar.timestamp} has impossible OHLC ordering.`);
  }
}

function selectEligibleBars(
  bars: readonly PointInTimeBar[],
  decisionTime: number
): readonly PointInTimeBar[] {
  const byTimestamp = new Map<number, PointInTimeBar>();

  for (const bar of bars) {
    if (!Number.isSafeInteger(bar.timestamp) || bar.timestamp < 0) {
      fail("1H bar timestamp must be a non-negative safe-integer epoch millisecond.");
    }
    const availableAt = bar.timestamp + BAR_DURATION_MS;
    if (!Number.isSafeInteger(availableAt)) {
      fail(`1H bar at ${bar.timestamp} has an invalid completion boundary.`);
    }
    if (availableAt > decisionTime) continue;

    validateEligibleBar(bar);
    const prior = byTimestamp.get(bar.timestamp);
    if (prior) {
      fail(`${isSameBar(prior, bar) ? "Exact" : "Conflicting"} duplicate 1H bar at ${bar.timestamp}.`);
    }
    byTimestamp.set(bar.timestamp, bar);
  }

  return Object.freeze([...byTimestamp.values()].sort((left, right) => left.timestamp - right.timestamp));
}

function aggregateCompleteBuckets(
  assetId: AssetId,
  eligibleBars: readonly PointInTimeBar[],
  timeframe: DerivedResearchTimeframe,
  bucketDurationMs: number,
  requiredCount: number
): readonly DerivedResearchBar[] {
  const buckets = new Map<number, PointInTimeBar[]>();
  for (const bar of eligibleBars) {
    const bucketStart = Math.floor(bar.timestamp / bucketDurationMs) * bucketDurationMs;
    const bucket = buckets.get(bucketStart);
    if (bucket) bucket.push(bar);
    else buckets.set(bucketStart, [bar]);
  }

  const result: DerivedResearchBar[] = [];
  for (const [startTime, componentBars] of buckets) {
    if (componentBars.length !== requiredCount) continue;
    componentBars.sort((left, right) => left.timestamp - right.timestamp);
    if (componentBars.some((bar, index) => bar.timestamp !== startTime + index * BAR_DURATION_MS)) continue;

    const first = componentBars[0];
    const last = componentBars[requiredCount - 1];
    if (!first || !last) continue;
    const endTime = startTime + bucketDurationMs;
    const volume = componentBars.reduce((sum, bar) => sum + bar.volume, 0);
    if (!Number.isFinite(volume)) fail(`${timeframe} bucket at ${startTime} has non-finite aggregate volume.`);
    result.push(Object.freeze({
      assetId,
      timeframe,
      timestamp: startTime,
      startTime,
      endTime,
      availableAt: endTime,
      componentCount: requiredCount,
      open: first.open,
      high: Math.max(...componentBars.map((bar) => bar.high)),
      low: Math.min(...componentBars.map((bar) => bar.low)),
      close: last.close,
      volume,
    }));
  }

  return Object.freeze(result.sort((left, right) => left.startTime - right.startTime));
}

/**
 * Derives completed UTC-aligned 4H and 1D research candles from canonical 1H
 * candle-open bars. A component is eligible iff timestamp + 1H <= decisionTime.
 */
export function deriveHigherTimeframeContext(
  input: DeriveHigherTimeframeContextInput
): DerivedTimeframeContext {
  if (typeof input.assetId !== "string" || input.assetId.trim().length === 0) {
    fail("assetId must be a non-empty string.");
  }
  if (!Number.isSafeInteger(input.decisionTime) || input.decisionTime < 0) {
    fail("decisionTime must be a non-negative safe-integer epoch millisecond.");
  }

  const eligibleBars = selectEligibleBars(input.eligible1hBars, input.decisionTime);
  const completed4hBars = aggregateCompleteBuckets(
    input.assetId,
    eligibleBars,
    "4H",
    FOUR_HOUR_DURATION_MS,
    4
  );
  const completed1dBars = aggregateCompleteBuckets(
    input.assetId,
    eligibleBars,
    "1D",
    ONE_DAY_DURATION_MS,
    24
  );

  return Object.freeze({
    assetId: input.assetId,
    decisionTime: input.decisionTime,
    asOf: input.decisionTime,
    completed4hBars,
    completed1dBars,
    latestCompleted4hBar: completed4hBars.at(-1) ?? null,
    latestCompleted1dBar: completed1dBars.at(-1) ?? null,
    intendedUse: "RESEARCH_CONTEXT_ONLY",
    grantsExecutionAuthority: false,
    priceAuthority: "NONE",
  });
}
