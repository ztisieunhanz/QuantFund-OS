// ============================================================================
// FILE: src/lib/quant/historicalSources/blsReleases.ts
// MODULE: BLS MACROECONOMIC RELEASES & EVENT PARSER (GATE M12D)
// PRINCIPLE: Truthful Historical Availability Without Lookahead Bias (DEC-001, DEC-005)
// ============================================================================

import {
  type HistoricalMacroRelease,
  type HistoricalEventRecord,
  HistoricalDatasetValidationError,
  validateHistoricalMacroRelease,
  validateHistoricalEvent,
} from "../historicalPit";
import { marketDateTimeToEpochMs } from "./timezoneUtils";
import type {
  RawBlsCpiObservation,
  RawBlsEmploymentObservation,
  MacroReleaseParserResult,
} from "./types";

/**
 * Computes deterministic UTC midnight timestamp for the final calendar day of a reference month.
 * e.g. "2024-01" -> 2024-01-31 00:00:00.000 UTC (1706659200000)
 *      "2024-02" -> 2024-02-29 00:00:00.000 UTC (1709164800000, leap year aware)
 */
export function getReferenceMonthEndEpochMs(observationPeriod: string): number {
  if (typeof observationPeriod !== "string" || !/^\d{4}-\d{2}$/.test(observationPeriod.trim())) {
    throw new HistoricalDatasetValidationError(
      `Invalid observationPeriod: "${observationPeriod}". Expected YYYY-MM format.`
    );
  }
  const [yearStr, monthStr] = observationPeriod.trim().split("-");
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);

  if (year < 1900 || year > 2100 || month < 1 || month > 12) {
    throw new HistoricalDatasetValidationError(
      `Invalid year/month values in observationPeriod: "${observationPeriod}".`
    );
  }

  // Day 0 of month (1-indexed month + 1) produces the last calendar day of `month`
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Date.UTC(year, month - 1, lastDay, 0, 0, 0, 0);
}

// ----------------------------------------------------------------------------
// 0. AUTHORITATIVE BLS SERIES DEFINITIONS & PROVENANCE
// ----------------------------------------------------------------------------

/**
 * Authoritative BLS series definitions distinguishing canonical measures from underlying level series.
 *
 * CRITICAL (Gate M12D-R1):
 * - CES0000000001 is the Total Nonfarm EMPLOYMENT LEVEL series (All Employees, Total Nonfarm, Seasonally Adjusted).
 *   It is an employment level series, NOT a net-monthly-change series.
 * - US_NFP_NET_CHANGE is the canonical measure of over-the-month net change in Total Nonfarm payrolls.
 *   Option A (preferred): directly sourced from the headline over-the-month change published in the official
 *   archived BLS Employment Situation news release summary (e.g. Table B summary text).
 * - CPIAUCSL / CUUR0000SA0 are INDEX LEVEL series.
 * - US_CPI_YOY and US_CPI_MOM are percent changes directly sourced from official BLS CPI release tables (Table A).
 */
export const BLS_SERIES_DEFINITIONS = Object.freeze({
  US_NFP_NET_CHANGE: Object.freeze({
    canonicalMeasure: "US_NFP_NET_CHANGE",
    description: "Net over-the-month change in Total Nonfarm Payroll Employment, Seasonally Adjusted",
    underlyingLevelSeriesId: "CES0000000001",
    underlyingLevelDescription: "All Employees, Total Nonfarm, Seasonally Adjusted (Thousands of Persons) — Employment LEVEL",
    measureDerivation: "DIRECT_PUBLISHED_CHANGE" as const,
    unit: "THOUSANDS_OF_PERSONS",
    provider: "BLS",
  }),
  US_UNEMPLOYMENT_RATE: Object.freeze({
    canonicalMeasure: "US_UNEMPLOYMENT_RATE",
    description: "Civilian Unemployment Rate, Seasonally Adjusted (Household Survey)",
    underlyingLevelSeriesId: "LNS14000000",
    underlyingLevelDescription: "Unemployment Rate, Seasonally Adjusted (Percent)",
    measureDerivation: "DIRECT_PUBLISHED_RATE" as const,
    unit: "PERCENT",
    provider: "BLS",
  }),
  US_CPI_YOY: Object.freeze({
    canonicalMeasure: "US_CPI_YOY",
    description: "CPI for All Urban Consumers (CPI-U), All Items, 12-Month Percent Change, Not Seasonally Adjusted",
    underlyingLevelSeriesId: "CUUR0000SA0",
    underlyingLevelDescription: "CPI-U All Items, Not Seasonally Adjusted Index Level (1982-84=100)",
    measureDerivation: "DIRECT_PUBLISHED_PERCENT_CHANGE" as const,
    unit: "PERCENT",
    provider: "BLS",
  }),
  US_CPI_MOM: Object.freeze({
    canonicalMeasure: "US_CPI_MOM",
    description: "CPI for All Urban Consumers (CPI-U), All Items, 1-Month Percent Change, Seasonally Adjusted",
    underlyingLevelSeriesId: "CUSR0000SA0",
    underlyingLevelDescription: "CPI-U All Items, Seasonally Adjusted Index Level (1982-84=100)",
    measureDerivation: "DIRECT_PUBLISHED_PERCENT_CHANGE" as const,
    unit: "PERCENT",
    provider: "BLS",
  }),
  US_CPI_INDEX: Object.freeze({
    canonicalMeasure: "US_CPI_INDEX",
    description: "CPI for All Urban Consumers (CPI-U), All Items Index Level",
    underlyingLevelSeriesId: "CUUR0000SA0",
    underlyingLevelDescription: "CPI-U All Items Index Level (1982-84=100)",
    measureDerivation: "INDEX_LEVEL" as const,
    unit: "INDEX_POINTS",
    provider: "BLS",
  }),
});

/**
 * Validates and calculates over-the-month change from two employment level observations.
 *
 * CRITICAL PIT INVARIANT (Option B validation / Rule N15):
 * Both level observations MUST belong to the EXACT same publication vintage/release state.
 * Never subtracts a revised current level from an older first-release level.
 */
export function deriveVintageConsistentChange(
  currentObservation: { value: number; vintageDate?: string | null; releaseDate?: string | null; releaseId?: string | null },
  priorObservation: { value: number; vintageDate?: string | null; releaseDate?: string | null; releaseId?: string | null }
): number {
  const currentKey = currentObservation.releaseId || currentObservation.releaseDate || currentObservation.vintageDate;
  const priorKey = priorObservation.releaseId || priorObservation.releaseDate || priorObservation.vintageDate;

  if (currentKey && priorKey && currentKey !== priorKey) {
    throw new HistoricalDatasetValidationError(
      `Cannot derive change across conflicting vintages: current release (${currentKey}) vs prior release (${priorKey}). Vintage mixing violation.`
    );
  }

  return currentObservation.value - priorObservation.value;
}

// ----------------------------------------------------------------------------
// 1. BLS CPI RELEASE PARSER
// ----------------------------------------------------------------------------

/**
 * Parses raw BLS Consumer Price Index releases into point-in-time HistoricalMacroRelease
 * and HistoricalEventRecord items.
 *
 * CANONICAL BEHAVIOR:
 * 1. Requires explicit verified releaseDate (e.g. "2024-02-13"). Never guesses release date.
 * 2. Official release time is 08:30 America/New_York unless explicit override is provided.
 * 3. Converts release date + 08:30 Eastern to numeric UTC epoch ms using historical DST awareness.
 *    (Winter EST -> 13:30 UTC, Summer EDT -> 12:30 UTC).
 * 4. ALFRED vintageDate (e.g. "2024-02-13") is stored as date metadata; NEVER treated as 00:00 UTC availableAt.
 * 5. Official BLS releases do not contain pre-release market consensus:
 *    consensus = null, consensusFrozenAt = null, surprise = null.
 * 6. Fails closed on missing release date, malformed dates, non-finite values, or lookahead contradictions.
 */
export function parseBlsCpiRelease(
  rawInput: RawBlsCpiObservation | readonly RawBlsCpiObservation[]
): MacroReleaseParserResult {
  try {
    const records = Array.isArray(rawInput) ? rawInput : [rawInput];
    if (records.length === 0) {
      return {
        success: false,
        error: "BLS CPI raw input array is empty.",
      };
    }

    const macroReleases: HistoricalMacroRelease[] = [];
    const eventRecords: HistoricalEventRecord[] = [];
    const seenSeriesIds = new Set<string>();

    for (let i = 0; i < records.length; i++) {
      const row = records[i];

      // 1. Validate observation period
      const observationTime = getReferenceMonthEndEpochMs(row.observationPeriod);

      // 2. Validate explicit release date witness
      if (!row.releaseDate || typeof row.releaseDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.releaseDate.trim())) {
        throw new HistoricalDatasetValidationError(
          `Record ${i} (${row.observationPeriod}): Missing or malformed releaseDate: "${row.releaseDate}". Explicit witness required.`
        );
      }

      // 3. Release time (defaults to official BLS 08:30 Eastern Time)
      const releaseTime = (row.releaseTime || "08:30").trim();
      if (!/^\d{2}:\d{2}(:\d{2})?$/.test(releaseTime)) {
        throw new HistoricalDatasetValidationError(
          `Record ${i} (${row.observationPeriod}): Invalid releaseTime format: "${row.releaseTime}". Expected HH:mm.`
        );
      }

      // 4. Compute exact publishedAt via DST-aware Eastern Time conversion
      const publishedAt = marketDateTimeToEpochMs(row.releaseDate.trim(), releaseTime, "America/New_York");
      const availableAt = publishedAt;

      // Invariant check: publishedAt must be >= observationTime
      if (publishedAt < observationTime) {
        throw new HistoricalDatasetValidationError(
          `Record ${i} (${row.observationPeriod}): publishedAt (${publishedAt}) cannot precede observationTime (${observationTime}). Lookahead bias violation.`
        );
      }

      // Revision index
      const revisionIndex = row.revisionIndex ?? 0;
      if (!Number.isInteger(revisionIndex) || revisionIndex < 0) {
        throw new HistoricalDatasetValidationError(
          `Record ${i} (${row.observationPeriod}): Invalid revisionIndex: ${row.revisionIndex}. Must be integer >= 0.`
        );
      }

      // Parse series values
      let hasAnyValue = false;

      // Series 1: US_CPI_YOY (Headline 12-Month Percent Change, Unadjusted)
      if (row.cpiYoY !== undefined && row.cpiYoY !== null) {
        const val = typeof row.cpiYoY === "string" ? parseFloat(row.cpiYoY) : row.cpiYoY;
        if (!Number.isFinite(val)) {
          throw new HistoricalDatasetValidationError(
            `Record ${i} (${row.observationPeriod}): Non-finite cpiYoY value (${row.cpiYoY}).`
          );
        }
        hasAnyValue = true;
        const rel: HistoricalMacroRelease = {
          seriesId: "US_CPI_YOY",
          observationTime,
          publishedAt,
          availableAt,
          vintageDate: row.vintageDate?.trim() ?? null,
          revisionIndex,
          value: val,
          provider: "BLS",
          unit: "PERCENT",
        };
        validateHistoricalMacroRelease(rel);
        macroReleases.push(rel);
        seenSeriesIds.add("US_CPI_YOY");

        // Associated Event Record: US_CPI_REPORT
        // Unique canonical event ID: includes observation period and revision if > 0
        const eventId = revisionIndex === 0
          ? `BLS-CPI-${row.observationPeriod.trim()}`
          : `BLS-CPI-${row.observationPeriod.trim()}-REV${revisionIndex}`;

        const ev: HistoricalEventRecord = {
          eventId,
          eventType: "US_CPI_REPORT",
          observationTime,
          publishedAt,
          availableAt,
          actual: val,
          // CRITICAL: Official BLS source does NOT provide market consensus
          consensus: null,
          consensusFrozenAt: null,
          previous: null,
          surprise: null,
          provider: "BLS",
          sourceQuality: "TIER_1_OFFICIAL",
        };
        validateHistoricalEvent(ev);
        eventRecords.push(ev);
      }

      // Series 2: US_CPI_MOM (1-Month Percent Change, Seasonally Adjusted)
      if (row.cpiMoM !== undefined && row.cpiMoM !== null) {
        const val = typeof row.cpiMoM === "string" ? parseFloat(row.cpiMoM) : row.cpiMoM;
        if (!Number.isFinite(val)) {
          throw new HistoricalDatasetValidationError(
            `Record ${i} (${row.observationPeriod}): Non-finite cpiMoM value (${row.cpiMoM}).`
          );
        }
        hasAnyValue = true;
        const rel: HistoricalMacroRelease = {
          seriesId: "US_CPI_MOM",
          observationTime,
          publishedAt,
          availableAt,
          vintageDate: row.vintageDate?.trim() ?? null,
          revisionIndex,
          value: val,
          provider: "BLS",
          unit: "PERCENT",
        };
        validateHistoricalMacroRelease(rel);
        macroReleases.push(rel);
        seenSeriesIds.add("US_CPI_MOM");
      }

      // Series 3: US_CPI_INDEX (Index level)
      if (row.cpiIndex !== undefined && row.cpiIndex !== null) {
        const val = typeof row.cpiIndex === "string" ? parseFloat(row.cpiIndex) : row.cpiIndex;
        if (!Number.isFinite(val)) {
          throw new HistoricalDatasetValidationError(
            `Record ${i} (${row.observationPeriod}): Non-finite cpiIndex value (${row.cpiIndex}).`
          );
        }
        hasAnyValue = true;
        const rel: HistoricalMacroRelease = {
          seriesId: "US_CPI_INDEX",
          observationTime,
          publishedAt,
          availableAt,
          vintageDate: row.vintageDate?.trim() ?? null,
          revisionIndex,
          value: val,
          provider: "BLS",
          unit: "INDEX_POINTS",
        };
        validateHistoricalMacroRelease(rel);
        macroReleases.push(rel);
        seenSeriesIds.add("US_CPI_INDEX");
      }

      if (!hasAnyValue) {
        throw new HistoricalDatasetValidationError(
          `Record ${i} (${row.observationPeriod}): At least one CPI series (cpiYoY, cpiMoM, or cpiIndex) must be provided.`
        );
      }
    }

    return {
      success: true,
      macroReleases,
      eventRecords,
      metadata: {
        count: macroReleases.length,
        seriesIds: Array.from(seenSeriesIds),
        provider: "BLS",
      },
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: message,
    };
  }
}

// ----------------------------------------------------------------------------
// 2. BLS EMPLOYMENT SITUATION / NON-FARM PAYROLLS PARSER
// ----------------------------------------------------------------------------

/**
 * Parses raw BLS Employment Situation releases into point-in-time HistoricalMacroRelease
 * and HistoricalEventRecord items.
 *
 * CANONICAL BEHAVIOR:
 * 1. Requires explicit verified releaseDate (e.g. "2024-02-02"). Never infers first Friday.
 * 2. Official release time is 08:30 America/New_York.
 * 3. Explicit series:
 *    - US_NFP_NET_CHANGE: Net change in Total Nonfarm Payrolls (unit: "THOUSANDS_OF_PERSONS").
 *    - US_UNEMPLOYMENT_RATE: Civilian Unemployment Rate (unit: "PERCENT") from separate Household Survey.
 * 4. Never mixes or substitutes Unemployment Rate for Payroll Change under NON_FARM_PAYROLLS_REPORT.
 * 5. Preserves revisionIndex (0 for initial release, 1 for subsequent revisions).
 * 6. consensus = null, consensusFrozenAt = null, surprise = null (no consensus fabrication).
 */
export function parseBlsEmploymentRelease(
  rawInput: RawBlsEmploymentObservation | readonly RawBlsEmploymentObservation[]
): MacroReleaseParserResult {
  try {
    const records = Array.isArray(rawInput) ? rawInput : [rawInput];
    if (records.length === 0) {
      return {
        success: false,
        error: "BLS Employment raw input array is empty.",
      };
    }

    const macroReleases: HistoricalMacroRelease[] = [];
    const eventRecords: HistoricalEventRecord[] = [];
    const seenSeriesIds = new Set<string>();

    for (let i = 0; i < records.length; i++) {
      const row = records[i];

      // 1. Validate observation period
      const observationTime = getReferenceMonthEndEpochMs(row.observationPeriod);

      // 2. Validate explicit release date witness
      if (!row.releaseDate || typeof row.releaseDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.releaseDate.trim())) {
        throw new HistoricalDatasetValidationError(
          `Record ${i} (${row.observationPeriod}): Missing or malformed releaseDate: "${row.releaseDate}". Explicit witness required.`
        );
      }

      // 3. Release time (defaults to official BLS 08:30 Eastern Time)
      const releaseTime = (row.releaseTime || "08:30").trim();
      if (!/^\d{2}:\d{2}(:\d{2})?$/.test(releaseTime)) {
        throw new HistoricalDatasetValidationError(
          `Record ${i} (${row.observationPeriod}): Invalid releaseTime format: "${row.releaseTime}". Expected HH:mm.`
        );
      }

      // 4. Compute exact publishedAt via DST-aware Eastern Time conversion
      const publishedAt = marketDateTimeToEpochMs(row.releaseDate.trim(), releaseTime, "America/New_York");
      const availableAt = publishedAt;

      if (publishedAt < observationTime) {
        throw new HistoricalDatasetValidationError(
          `Record ${i} (${row.observationPeriod}): publishedAt (${publishedAt}) cannot precede observationTime (${observationTime}). Lookahead bias violation.`
        );
      }

      const revisionIndex = row.revisionIndex ?? 0;
      if (!Number.isInteger(revisionIndex) || revisionIndex < 0) {
        throw new HistoricalDatasetValidationError(
          `Record ${i} (${row.observationPeriod}): Invalid revisionIndex: ${row.revisionIndex}. Must be integer >= 0.`
        );
      }

      // 5. NFP Net Change (Establishment Survey summary Table B; underlying level series is CES0000000001)
      if (row.nfpNetChangeThousands === undefined || row.nfpNetChangeThousands === null) {
        throw new HistoricalDatasetValidationError(
          `Record ${i} (${row.observationPeriod}): nfpNetChangeThousands is required.`
        );
      }

      const nfpVal = typeof row.nfpNetChangeThousands === "string"
        ? parseFloat(row.nfpNetChangeThousands)
        : row.nfpNetChangeThousands;

      if (!Number.isFinite(nfpVal)) {
        throw new HistoricalDatasetValidationError(
          `Record ${i} (${row.observationPeriod}): Non-finite nfpNetChangeThousands value (${row.nfpNetChangeThousands}).`
        );
      }

      const nfpRelease: HistoricalMacroRelease = {
        seriesId: "US_NFP_NET_CHANGE",
        observationTime,
        publishedAt,
        availableAt,
        vintageDate: row.vintageDate?.trim() ?? null,
        revisionIndex,
        value: nfpVal,
        provider: "BLS",
        unit: "THOUSANDS_OF_PERSONS",
      };
      validateHistoricalMacroRelease(nfpRelease);
      macroReleases.push(nfpRelease);
      seenSeriesIds.add("US_NFP_NET_CHANGE");

      // Canonical Event Record: NON_FARM_PAYROLLS_REPORT
      const nfpEventId = revisionIndex === 0
        ? `BLS-NFP-${row.observationPeriod.trim()}`
        : `BLS-NFP-${row.observationPeriod.trim()}-REV${revisionIndex}`;

      const nfpEvent: HistoricalEventRecord = {
        eventId: nfpEventId,
        eventType: "NON_FARM_PAYROLLS_REPORT",
        observationTime,
        publishedAt,
        availableAt,
        actual: nfpVal, // CRITICAL: actual is strictly the payroll net change figure
        consensus: null,
        consensusFrozenAt: null,
        previous: null,
        surprise: null,
        provider: "BLS",
        sourceQuality: "TIER_1_OFFICIAL",
      };
      validateHistoricalEvent(nfpEvent);
      eventRecords.push(nfpEvent);

      // 6. Optional: Unemployment Rate (Household Survey LNS14000000)
      if (row.unemploymentRate !== undefined && row.unemploymentRate !== null) {
        const urVal = typeof row.unemploymentRate === "string"
          ? parseFloat(row.unemploymentRate)
          : row.unemploymentRate;

        if (!Number.isFinite(urVal)) {
          throw new HistoricalDatasetValidationError(
            `Record ${i} (${row.observationPeriod}): Non-finite unemploymentRate value (${row.unemploymentRate}).`
          );
        }

        const urRelease: HistoricalMacroRelease = {
          seriesId: "US_UNEMPLOYMENT_RATE",
          observationTime,
          publishedAt,
          availableAt,
          vintageDate: row.vintageDate?.trim() ?? null,
          revisionIndex,
          value: urVal,
          provider: "BLS",
          unit: "PERCENT",
        };
        validateHistoricalMacroRelease(urRelease);
        macroReleases.push(urRelease);
        seenSeriesIds.add("US_UNEMPLOYMENT_RATE");
      }
    }

    return {
      success: true,
      macroReleases,
      eventRecords,
      metadata: {
        count: macroReleases.length,
        seriesIds: Array.from(seenSeriesIds),
        provider: "BLS",
      },
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: message,
    };
  }
}
