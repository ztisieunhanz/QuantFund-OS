// ============================================================================
// FILE: src/lib/quant/historicalSources/sampleMacroData.ts
// MODULE: CANONICAL DETERMINISTIC MACRO FIXTURES (GATE M12D)
// PRINCIPLE: Truthful Historical Availability Without Lookahead Bias (DEC-001, DEC-005)
// ============================================================================

import type {
  RawBlsCpiObservation,
  RawBlsEmploymentObservation,
  RawFomcStatementObservation,
} from "./types";
import { parseBlsCpiRelease, parseBlsEmploymentRelease } from "./blsReleases";
import { parseFomcEvent } from "./fomcEvents";
import type { HistoricalMacroRelease, HistoricalEventRecord } from "../historicalPit";

// ----------------------------------------------------------------------------
// 1. AUTHORITATIVE REAL HISTORICAL CPI FIXTURES (BLS PRIMARY SOURCE)
// Traceable to official archived BLS news releases:
// - Jan 2024: USDL-24-0265 (Feb 13, 2024 08:30 EST)
// - Feb 2024: USDL-24-0483 (Mar 12, 2024 08:30 EDT - DST transition)
// - Jun 2024: USDL-24-1325 (Jul 11, 2024 08:30 EDT)
// ----------------------------------------------------------------------------

export const REAL_HISTORICAL_FIXTURE_BLS_CPI: readonly RawBlsCpiObservation[] = Object.freeze([
  {
    observationPeriod: "2024-01",
    releaseId: "USDL-24-0265",
    releaseDate: "2024-02-13",
    releaseTime: "08:30",
    cpiYoY: 3.1,
    cpiMoM: 0.3,
    cpiIndex: 308.417,
    underlyingLevelSeriesId: "CUUR0000SA0",
    revisionIndex: 0,
    vintageDate: "2024-02-13",
  },
  {
    observationPeriod: "2024-02",
    releaseId: "USDL-24-0483",
    releaseDate: "2024-03-12",
    releaseTime: "08:30",
    cpiYoY: 3.2,
    cpiMoM: 0.4,
    cpiIndex: 310.326,
    underlyingLevelSeriesId: "CUUR0000SA0",
    revisionIndex: 0,
    vintageDate: "2024-03-12",
  },
  {
    observationPeriod: "2024-06",
    releaseId: "USDL-24-1325",
    releaseDate: "2024-07-11",
    releaseTime: "08:30",
    cpiYoY: 3.0,
    cpiMoM: -0.1,
    cpiIndex: 314.175,
    underlyingLevelSeriesId: "CUUR0000SA0",
    revisionIndex: 0,
    vintageDate: "2024-07-11",
  },
]);

// ----------------------------------------------------------------------------
// 2. AUTHORITATIVE REAL HISTORICAL NFP FIXTURES (BLS PRIMARY SOURCE)
// Traceable to official archived BLS news releases:
// - Jan 2024 Initial: USDL-24-0148 (Feb 02, 2024 08:30 EST, +353k)
// - Jan 2024 Revision 1: USDL-24-0451 (Mar 08, 2024 08:30 EST, revised to +229k)
// - Feb 2024 Initial: USDL-24-0451 (Mar 08, 2024 08:30 EST, +275k)
// - Jun 2024 Initial: USDL-24-1270 (Jul 05, 2024 08:30 EDT, +206k)
// Note: Underlying level series is CES0000000001 (Total Nonfarm Employment LEVEL).
// ----------------------------------------------------------------------------

export const REAL_HISTORICAL_FIXTURE_BLS_NFP: readonly RawBlsEmploymentObservation[] = Object.freeze([
  {
    observationPeriod: "2024-01",
    releaseId: "USDL-24-0148",
    releaseDate: "2024-02-02",
    releaseTime: "08:30",
    nfpNetChangeThousands: 353,
    underlyingLevelSeriesId: "CES0000000001",
    unemploymentRate: 3.7,
    revisionIndex: 0,
    vintageDate: "2024-02-02",
  },
  {
    // First revision for Jan 2024, published alongside Feb 2024 initial release on March 8, 2024
    observationPeriod: "2024-01",
    releaseId: "USDL-24-0451",
    releaseDate: "2024-03-08",
    releaseTime: "08:30",
    nfpNetChangeThousands: 229,
    underlyingLevelSeriesId: "CES0000000001",
    unemploymentRate: 3.7,
    revisionIndex: 1,
    vintageDate: "2024-03-08",
  },
  {
    observationPeriod: "2024-02",
    releaseId: "USDL-24-0451",
    releaseDate: "2024-03-08",
    releaseTime: "08:30",
    nfpNetChangeThousands: 275,
    underlyingLevelSeriesId: "CES0000000001",
    unemploymentRate: 3.9,
    revisionIndex: 0,
    vintageDate: "2024-03-08",
  },
  {
    observationPeriod: "2024-06",
    releaseId: "USDL-24-1270",
    releaseDate: "2024-07-05",
    releaseTime: "08:30",
    nfpNetChangeThousands: 206,
    underlyingLevelSeriesId: "CES0000000001",
    unemploymentRate: 4.1,
    revisionIndex: 0,
    vintageDate: "2024-07-05",
  },
]);

// ----------------------------------------------------------------------------
// 3. AUTHORITATIVE REAL HISTORICAL FOMC FIXTURES (FEDERAL RESERVE PRIMARY SOURCE)
// Traceable to official Federal Reserve Board announcements:
// - Jan 31, 2024: Scheduled FOMC statement (14:00 EST, maintain 5.25-5.50%)
// - Jun 12, 2024: Scheduled FOMC statement (14:00 EDT, maintain 5.25-5.50% - DST transition)
// - Mar 03, 2020: Emergency rate cut statement (10:00 EST, cut 50 bps to 1.00-1.25%)
// ----------------------------------------------------------------------------

export const REAL_HISTORICAL_FIXTURE_FOMC: readonly RawFomcStatementObservation[] = Object.freeze([
  {
    eventId: "FED-FOMC-20240131",
    meetingDate: "2024-01-31",
    releaseDate: "2024-01-31",
    releaseTime: "14:00",
    eventType: "FED_RATE_DECISION",
    targetRateUpper: 5.50,
    targetRateLower: 5.25,
    previousTargetRateUpper: 5.50,
    statementText: "The Committee decided to maintain the target range for the federal funds rate at 5-1/4 to 5-1/2 percent.",
  },
  {
    eventId: "FED-FOMC-20240612",
    meetingDate: "2024-06-12",
    releaseDate: "2024-06-12",
    releaseTime: "14:00",
    eventType: "FED_RATE_DECISION",
    targetRateUpper: 5.50,
    targetRateLower: 5.25,
    previousTargetRateUpper: 5.50,
    statementText: "The Committee decided to maintain the target range for the federal funds rate at 5-1/4 to 5-1/2 percent.",
  },
  {
    eventId: "FED-FOMC-20200303",
    meetingDate: "2020-03-03",
    releaseDate: "2020-03-03",
    releaseTime: "10:00", // Emergency unscheduled morning release
    eventType: "FED_RATE_DECISION",
    targetRateUpper: 1.25,
    targetRateLower: 1.00,
    previousTargetRateUpper: 1.75,
    statementText: "In light of these risks and in support of achieving its maximum employment and price stability goals, the Federal Open Market Committee decided today to lower the target range for the federal funds rate by 1/2 percentage point.",
  },
]);

// ----------------------------------------------------------------------------
// 4. SYNTHETIC TEST FIXTURES (CLEARLY DEMARCATED FOR EDGE CASES / UNIT TESTING)
// ----------------------------------------------------------------------------

export const SYNTHETIC_TEST_FIXTURE_INVALID_BLS: readonly Record<string, unknown>[] = Object.freeze([
  // Missing releaseDate
  {
    observationPeriod: "2024-01",
    cpiYoY: 3.1,
  },
  // Malformed date
  {
    observationPeriod: "2024-01",
    releaseDate: "not-a-date",
    cpiYoY: 3.1,
  },
  // Missing values
  {
    observationPeriod: "2024-01",
    releaseDate: "2024-02-13",
  },
  // Non-finite value
  {
    observationPeriod: "2024-01",
    releaseDate: "2024-02-13",
    cpiYoY: "NaN",
  },
]);

export const SYNTHETIC_TEST_FIXTURE_INVALID_FOMC: readonly Record<string, unknown>[] = Object.freeze([
  // Missing releaseTime (must fail closed)
  {
    meetingDate: "2024-01-31",
    releaseDate: "2024-01-31",
    targetRateUpper: 5.50,
  },
  // Non-numeric target rate
  {
    meetingDate: "2024-01-31",
    releaseDate: "2024-01-31",
    releaseTime: "14:00",
    targetRateUpper: "invalid",
  },
]);

// ----------------------------------------------------------------------------
// 5. CONVENIENCE BUILDER FUNCTIONS FOR REPLAY BENCHMARKS
// ----------------------------------------------------------------------------

export function buildRealHistoricalMacroReleases(): readonly HistoricalMacroRelease[] {
  const cpiResult = parseBlsCpiRelease(REAL_HISTORICAL_FIXTURE_BLS_CPI);
  const nfpResult = parseBlsEmploymentRelease(REAL_HISTORICAL_FIXTURE_BLS_NFP);
  const fomcResult = parseFomcEvent(REAL_HISTORICAL_FIXTURE_FOMC);

  if (!cpiResult.success) throw new Error(cpiResult.error);
  if (!nfpResult.success) throw new Error(nfpResult.error);
  if (!fomcResult.success) throw new Error(fomcResult.error);

  return Object.freeze([
    ...cpiResult.macroReleases,
    ...nfpResult.macroReleases,
    ...fomcResult.macroReleases,
  ]);
}

export function buildRealHistoricalEventRecords(): readonly HistoricalEventRecord[] {
  const cpiResult = parseBlsCpiRelease(REAL_HISTORICAL_FIXTURE_BLS_CPI);
  const nfpResult = parseBlsEmploymentRelease(REAL_HISTORICAL_FIXTURE_BLS_NFP);
  const fomcResult = parseFomcEvent(REAL_HISTORICAL_FIXTURE_FOMC);

  if (!cpiResult.success) throw new Error(cpiResult.error);
  if (!nfpResult.success) throw new Error(nfpResult.error);
  if (!fomcResult.success) throw new Error(fomcResult.error);

  return Object.freeze([
    ...cpiResult.eventRecords,
    ...nfpResult.eventRecords,
    ...fomcResult.eventRecords,
  ]);
}
