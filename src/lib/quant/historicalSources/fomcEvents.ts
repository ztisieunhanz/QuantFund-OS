// ============================================================================
// FILE: src/lib/quant/historicalSources/fomcEvents.ts
// MODULE: FEDERAL RESERVE FOMC EVENTS & STATEMENT PARSER (GATE M12D)
// PRINCIPLE: Truthful Historical Availability Without Lookahead Bias (DEC-001, DEC-005)
// ============================================================================

import {
  type HistoricalMacroRelease,
  type HistoricalEventRecord,
  HistoricalDatasetValidationError,
  validateHistoricalMacroRelease,
  validateHistoricalEvent,
} from "../historicalPit";
import {
  marketDateTimeToEpochMs,
  sessionDateToUtcMidnightEpochMs,
} from "./timezoneUtils";
import type {
  RawFomcStatementObservation,
  MacroReleaseParserResult,
} from "./types";

/**
 * Parses raw Federal Reserve FOMC meeting statement / rate decision records
 * into point-in-time HistoricalEventRecord and optional HistoricalMacroRelease items.
 *
 * CANONICAL BEHAVIOR:
 * 1. Requires explicit verified releaseDate AND releaseTime.
 *    FAIL CLOSED: If releaseTime is missing or unverified, throws error (never assumes 14:00 without witness).
 * 2. Converts release date + local time in America/New_York to deterministic UTC epoch ms
 *    with date-aware DST handling (Winter 14:00 EST -> 19:00 UTC, Summer 14:00 EDT -> 18:00 UTC).
 * 3. Qualitative statements set actual = null (no fake zeros or fabricated metrics).
 * 4. Rate decisions set actual to federal funds target range upper limit (e.g. 5.50 for 5.25-5.50%).
 * 5. Federal Reserve does not publish pre-release market consensus:
 *    consensus = null, consensusFrozenAt = null, surprise = null.
 * 6. Provider is strictly "FEDERAL_RESERVE" with sourceQuality "TIER_1_OFFICIAL".
 */
export function parseFomcEvent(
  rawInput: RawFomcStatementObservation | readonly RawFomcStatementObservation[]
): MacroReleaseParserResult {
  try {
    const records = Array.isArray(rawInput) ? rawInput : [rawInput];
    if (records.length === 0) {
      return {
        success: false,
        error: "FOMC raw input array is empty.",
      };
    }

    const macroReleases: HistoricalMacroRelease[] = [];
    const eventRecords: HistoricalEventRecord[] = [];
    const seenSeriesIds = new Set<string>();

    for (let i = 0; i < records.length; i++) {
      const row = records[i];

      // 1. Validate meetingDate
      if (!row.meetingDate || typeof row.meetingDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.meetingDate.trim())) {
        throw new HistoricalDatasetValidationError(
          `Record ${i}: Missing or malformed meetingDate: "${row.meetingDate}". Expected YYYY-MM-DD.`
        );
      }
      const meetingMidnightUtc = sessionDateToUtcMidnightEpochMs(row.meetingDate.trim());

      // 2. Validate explicit releaseDate
      if (!row.releaseDate || typeof row.releaseDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.releaseDate.trim())) {
        throw new HistoricalDatasetValidationError(
          `Record ${i} (${row.meetingDate}): Missing or malformed releaseDate: "${row.releaseDate}". Expected YYYY-MM-DD.`
        );
      }

      // 3. Validate explicit releaseTime (CRITICAL REQUIREMENT F5: FAIL CLOSED IF MISSING)
      if (!row.releaseTime || typeof row.releaseTime !== "string" || !/^\d{2}:\d{2}(:\d{2})?$/.test(row.releaseTime.trim())) {
        throw new HistoricalDatasetValidationError(
          `Record ${i} (${row.meetingDate}): Missing or invalid explicit releaseTime: "${row.releaseTime}". Fail-closed on missing exact release witness.`
        );
      }

      // 4. Compute exact publishedAt via DST-aware Eastern Time conversion
      const publishedAt = marketDateTimeToEpochMs(row.releaseDate.trim(), row.releaseTime.trim(), "America/New_York");
      const availableAt = publishedAt;
      const observationTime = meetingMidnightUtc;

      if (publishedAt < observationTime) {
        throw new HistoricalDatasetValidationError(
          `Record ${i} (${row.meetingDate}): publishedAt (${publishedAt}) cannot precede meeting observationTime (${observationTime}).`
        );
      }

      // 5. Determine numeric vs qualitative event representation
      const isQualitative = row.isQualitativeOnly === true || row.targetRateUpper === null || row.targetRateUpper === undefined;

      let actualVal: number | null = null;
      let prevVal: number | null = null;

      if (!isQualitative && row.targetRateUpper !== null && row.targetRateUpper !== undefined) {
        actualVal = typeof row.targetRateUpper === "string" ? parseFloat(row.targetRateUpper) : row.targetRateUpper;
        if (!Number.isFinite(actualVal)) {
          throw new HistoricalDatasetValidationError(
            `Record ${i} (${row.meetingDate}): Non-finite targetRateUpper value (${row.targetRateUpper}).`
          );
        }

        if (row.previousTargetRateUpper !== null && row.previousTargetRateUpper !== undefined) {
          prevVal = typeof row.previousTargetRateUpper === "string"
            ? parseFloat(row.previousTargetRateUpper)
            : row.previousTargetRateUpper;
          if (!Number.isFinite(prevVal)) {
            throw new HistoricalDatasetValidationError(
              `Record ${i} (${row.meetingDate}): Non-finite previousTargetRateUpper value (${row.previousTargetRateUpper}).`
            );
          }
        }
      }

      const eventType = row.eventType ?? (actualVal !== null ? "FED_RATE_DECISION" : "FOMC_STATEMENT");
      const eventId = row.eventId?.trim() || `FED-FOMC-${row.releaseDate.trim()}`;

      // Canonical Event Record
      const eventRecord: HistoricalEventRecord = {
        eventId,
        eventType,
        observationTime,
        publishedAt,
        availableAt,
        actual: actualVal, // null for qualitative statements, finite number for rate decisions
        consensus: null,   // CRITICAL: Federal Reserve does not publish pre-meeting market consensus
        consensusFrozenAt: null,
        previous: prevVal,
        surprise: null,
        provider: "FEDERAL_RESERVE",
        sourceQuality: "TIER_1_OFFICIAL",
      };
      validateHistoricalEvent(eventRecord);
      eventRecords.push(eventRecord);

      // 6. If numeric rate decision, also generate HistoricalMacroRelease
      if (actualVal !== null) {
        const macroRelease: HistoricalMacroRelease = {
          seriesId: "US_FED_FUNDS_TARGET_UPPER",
          observationTime,
          publishedAt,
          availableAt,
          revisionIndex: 0,
          value: actualVal,
          provider: "FEDERAL_RESERVE",
          unit: "PERCENT",
        };
        validateHistoricalMacroRelease(macroRelease);
        macroReleases.push(macroRelease);
        seenSeriesIds.add("US_FED_FUNDS_TARGET_UPPER");
      }
    }

    return {
      success: true,
      macroReleases,
      eventRecords,
      metadata: {
        count: eventRecords.length,
        seriesIds: Array.from(seenSeriesIds),
        provider: "FEDERAL_RESERVE",
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
