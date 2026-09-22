// ============================================================================
// FILE: src/lib/quant/historicalSources/treasuryYields.ts
// MODULE: FEDERAL RESERVE H.15 TREASURY PAR YIELD CURVE PARSER (GATE M12C-R2)
// PRINCIPLE: Truthful Public Availability Witness via Explicit H.15 Release Date
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
  marketDateTimeToEpochMs,
  sessionDateToUtcMidnightEpochMs,
} from "./timezoneUtils";

/**
 * Standard Daily Treasury / H.15 Record format accepted by parser.
 * Requires explicit releaseDate witness establishing when the Federal Reserve
 * publicly released the H.15 bulletin.
 */
export interface RawTreasuryYieldRow {
  readonly observationDate?: string;
  readonly record_date?: string;
  readonly date?: string;
  readonly releaseDate?: string;
  readonly bc_2year?: string | number | null;
  readonly bc_10year?: string | number | null;
  readonly yield2Y?: number | null;
  readonly yield10Y?: number | null;
}

export interface TreasuryParserOptions {
  readonly seriesId: "US2Y" | "US10Y";
}

/**
 * Parses raw Federal Reserve H.15 Treasury Yield Curve data into normalized HistoricalMarketObservation[].
 *
 * AVAILABILITY INVARIANT (Gate M12C-R2):
 * - NY Fed indicative market quote cutoff is approximately 3:30 PM ET (15:30 ET).
 *   This is an internal input quote cutoff, NOT a public publication timestamp.
 * - The Federal Reserve publishes the H.15 Selected Interest Rates bulletin at 4:15 PM ET
 *   (16:15 America/New_York) on business days (Monday-Friday).
 * - Observation date and release date may differ (e.g. Friday observation released on Monday).
 * - A Treasury observation date alone CANNOT derive canonical availableAt.
 * - An explicit releaseDate is mandatory. If releaseDate is missing, the parser FAILS CLOSED.
 * - availableAt is strictly computed as: releaseDate + 16:15 America/New_York.
 *
 * SEMANTIC CONSISTENCY:
 * - Both US2Y and US10Y are Constant Maturity Treasury (CMT) par yields from Federal Reserve H.15.
 * - Provider identity is truthfully recorded as "FEDERAL_RESERVE_H15".
 * - Both use unit = "PERCENT" (e.g. 4.25 represents 4.25%).
 * - No Yahoo futures (2YY=F) substitution and no unverified / 10 transforms.
 */
export function parseTreasuryYieldSeries(
  rawData: unknown,
  options: TreasuryParserOptions
): MarketSeriesParserResult {
  const { seriesId } = options;

  if (!Array.isArray(rawData)) {
    return {
      success: false,
      seriesId,
      error: `Federal Reserve H.15 ${seriesId} payload is not an array.`,
    };
  }

  if (rawData.length === 0) {
    return {
      success: true,
      seriesId,
      observations: [],
      metadata: {
        count: 0,
        firstAvailableAt: null,
        lastAvailableAt: null,
        provider: "FEDERAL_RESERVE_H15",
        unit: "PERCENT",
      },
    };
  }

  const policy = MARKET_AVAILABILITY_POLICIES[seriesId] as DailySessionPolicy;
  const observations: HistoricalMarketObservation[] = [];

  for (let i = 0; i < rawData.length; i++) {
    const row = rawData[i] as RawTreasuryYieldRow | undefined;
    if (!row || typeof row !== "object") {
      return {
        success: false,
        seriesId,
        error: `Malformed Treasury row at index ${i}: expected object.`,
      };
    }

    const obsDateStr = (row.observationDate || row.record_date || row.date || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(obsDateStr)) {
      return {
        success: false,
        seriesId,
        error: `Invalid observation date format at index ${i}: "${obsDateStr}". Expected YYYY-MM-DD.`,
      };
    }

    // Explicit releaseDate requirement (Gate M12C-R2 Contract Requirement):
    // Observation date alone CANNOT establish public availability.
    const releaseDateStr = (row.releaseDate || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(releaseDateStr)) {
      return {
        success: false,
        seriesId,
        error: `Missing or invalid releaseDate for ${seriesId} on observation date "${obsDateStr}" at index ${i}. H.15 requires explicit releaseDate.`,
      };
    }

    if (releaseDateStr < obsDateStr) {
      return {
        success: false,
        seriesId,
        error: `Invalid releaseDate "${releaseDateStr}" precedes observationDate "${obsDateStr}" at index ${i}.`,
      };
    }

    // Extract yield based on target series
    let rawYieldValue: unknown;
    if (seriesId === "US2Y") {
      rawYieldValue = row.bc_2year ?? row.yield2Y;
    } else {
      rawYieldValue = row.bc_10year ?? row.yield10Y;
    }

    if (rawYieldValue == null) {
      return {
        success: false,
        seriesId,
        error: `Missing yield value for ${seriesId} on date ${obsDateStr} at index ${i}.`,
      };
    }

    const yieldNum =
      typeof rawYieldValue === "number" ? rawYieldValue : parseFloat(String(rawYieldValue).trim());
    if (!Number.isFinite(yieldNum) || yieldNum < 0) {
      return {
        success: false,
        seriesId,
        error: `Invalid yield value for ${seriesId} on date ${obsDateStr}: "${String(rawYieldValue)}". Must be a non-negative finite number.`,
      };
    }

    let observationTime: number;
    let availableAt: number;

    try {
      // Parse UTC midnight for the observation calendar date
      observationTime = sessionDateToUtcMidnightEpochMs(obsDateStr);
      // Canonical H.15 public availability: releaseDate + 16:15 America/New_York
      availableAt = marketDateTimeToEpochMs(releaseDateStr, policy.localTime, policy.timeZone);
    } catch (err) {
      return {
        success: false,
        seriesId,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const obs: HistoricalMarketObservation = {
      seriesId,
      value: yieldNum,
      observationTime,
      availableAt,
      providerTimestamp: null,
      provider: "FEDERAL_RESERVE_H15",
      unit: "PERCENT",
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
      provider: "FEDERAL_RESERVE_H15",
      unit: "PERCENT",
    },
  };
}
