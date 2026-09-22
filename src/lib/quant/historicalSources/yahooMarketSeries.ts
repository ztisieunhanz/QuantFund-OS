// ============================================================================
// FILE: src/lib/quant/historicalSources/yahooMarketSeries.ts
// MODULE: YAHOO HISTORICAL MARKET SERIES PARSER WITH DST-AWARE BOUNDARIES (GATE M12C-R)
// PRINCIPLE: Session-Close Availability Boundaries for Daily DXY & VIX
// ============================================================================

import {
  type HistoricalMarketObservation,
  validateHistoricalMarketObservation,
} from "../historicalPit";
import {
  MARKET_AVAILABILITY_POLICIES,
  type DailySessionPolicy,
  type MarketSeriesParserResult,
} from "./types";
import {
  extractSessionDateStr,
  marketDateTimeToEpochMs,
} from "./timezoneUtils";

export interface YahooChartResponse {
  readonly chart?: {
    readonly result?: Array<{
      readonly timestamp?: number[];
      readonly indicators?: {
        readonly quote?: Array<{
          readonly close?: Array<number | null>;
        }>;
      };
      readonly meta?: {
        readonly symbol?: string;
        readonly gmtoffset?: number;
      };
    }>;
    readonly error?: unknown;
  };
}

export interface YahooMarketParserOptions {
  readonly seriesId: "DXY" | "VIX";
}

/**
 * Parses raw Yahoo v8 chart daily payload into normalized HistoricalMarketObservation[].
 *
 * AVAILABILITY INVARIANT (Gate M12C-R):
 * - Yahoo chart daily timestamp represents either a date-level anchor (00:00 UTC) or session open.
 * - Under NO circumstances is a daily close exposed intraday before session close.
 * - VIX (CBOE regular trading): Closes at 16:15 America/New_York
 *   -> 21:15 UTC in winter EST, 20:15 UTC in summer EDT.
 * - DXY (ICE Dollar Index via Yahoo): Conservative post-session availability boundary at 18:00 America/New_York
 *   -> 23:00 UTC in winter EST, 22:00 UTC in summer EDT.
 * - Converted dynamically via IANA America/New_York timezone semantics without fixed UTC offsets.
 */
export function parseYahooDailyMarketSeries(
  rawPayload: unknown,
  options: YahooMarketParserOptions
): MarketSeriesParserResult {
  const { seriesId } = options;

  if (typeof rawPayload !== "object" || rawPayload === null) {
    return {
      success: false,
      seriesId,
      error: `Yahoo ${seriesId} payload is not an object.`,
    };
  }

  const chartRes = rawPayload as YahooChartResponse;
  if (chartRes.chart?.error) {
    return {
      success: false,
      seriesId,
      error: `Yahoo chart response reported an error: ${JSON.stringify(chartRes.chart.error)}`,
    };
  }

  const result = chartRes.chart?.result?.[0];
  if (!result) {
    return {
      success: false,
      seriesId,
      error: `Yahoo chart response for ${seriesId} missing result[0] array.`,
    };
  }

  const timestamps = result.timestamp ?? [];
  const closes = result.indicators?.quote?.[0]?.close ?? [];

  if (!Array.isArray(timestamps) || !Array.isArray(closes)) {
    return {
      success: false,
      seriesId,
      error: `Yahoo chart response for ${seriesId} missing timestamp or close arrays.`,
    };
  }

  if (timestamps.length === 0) {
    return {
      success: true,
      seriesId,
      observations: [],
      metadata: {
        count: 0,
        firstAvailableAt: null,
        lastAvailableAt: null,
        provider: "YAHOO",
        unit: "INDEX_POINTS",
      },
    };
  }

  if (timestamps.length !== closes.length) {
    return {
      success: false,
      seriesId,
      error: `Timestamp length (${timestamps.length}) does not match close length (${closes.length}).`,
    };
  }

  const policy = MARKET_AVAILABILITY_POLICIES[seriesId] as DailySessionPolicy;
  const observations: HistoricalMarketObservation[] = [];

  for (let i = 0; i < timestamps.length; i++) {
    const rawStampSec = timestamps[i];
    const close = closes[i];

    // Skip null/market holiday rows
    if (close === null || close === undefined) {
      continue;
    }

    if (!Number.isFinite(rawStampSec) || rawStampSec <= 0) {
      return {
        success: false,
        seriesId,
        error: `Malformed timestamp at index ${i}: ${rawStampSec}.`,
      };
    }

    if (!Number.isFinite(close) || close <= 0) {
      return {
        success: false,
        seriesId,
        error: `Invalid close value at index ${i}: ${close}. Must be a positive finite number.`,
      };
    }

    const observationTimeMs = rawStampSec * 1000;
    let availableAt: number;

    try {
      const sessionDateStr = extractSessionDateStr(observationTimeMs, policy.timeZone);
      // Compute DST-aware availability boundary in America/New_York
      availableAt = marketDateTimeToEpochMs(sessionDateStr, policy.localTime, policy.timeZone);
    } catch (err) {
      return {
        success: false,
        seriesId,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const obs: HistoricalMarketObservation = {
      seriesId,
      value: close,
      observationTime: observationTimeMs,
      availableAt,
      providerTimestamp: observationTimeMs,
      provider: "YAHOO",
      unit: "INDEX_POINTS",
    };

    try {
      validateHistoricalMarketObservation(obs);
    } catch (err) {
      return {
        success: false,
        seriesId,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    observations.push(obs);
  }

  // Sort ascending by observationTime
  observations.sort((a, b) => a.observationTime - b.observationTime);

  return {
    success: true,
    seriesId,
    observations,
    metadata: {
      count: observations.length,
      firstAvailableAt: observations[0]?.availableAt ?? null,
      lastAvailableAt: observations[observations.length - 1]?.availableAt ?? null,
      provider: "YAHOO",
      unit: "INDEX_POINTS",
    },
  };
}
