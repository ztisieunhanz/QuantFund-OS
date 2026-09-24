import {
  DEFAULT_RESEARCH_COVERAGE_POLICY,
  RESEARCH_SERIES_SPECS,
  type ResearchCadence,
  type ResearchSeriesId,
  type ResearchSeriesManifestEntry,
  type RevisionSemantics,
} from "../researchDataProtocol";
import type {
  HistoricalEventRecord,
  HistoricalMacroRelease,
  HistoricalMarketObservation,
} from "../historicalPit";
import {
  validateResearchDatasetSnapshot,
  type ResearchDatasetSnapshot,
  type ResearchSeriesAcquisitionStatus,
} from "./researchDatasetSnapshot";

export const RESEARCH_READINESS_POLICY_FINDING = Object.freeze({
  status: "UNRESOLVED" as const,
  code: "REQUIRED_SERIES_POLICY_UNRESOLVED" as const,
  reason:
    "M13B-1 lists every canonical series as required, while approved M13B-2 source evidence leaves VIX and DXY BLOCKED and CPI MoM and unemployment CONDITIONAL. No approved required-versus-optional policy resolves that conflict, so B2-D cannot claim RESEARCH_READY.",
});

export type CoverageDenominatorStatus = "KNOWN" | "UNKNOWN" | "NOT_APPLICABLE";
export type ObservationCoverageStatus = "COMPLETE" | "INCOMPLETE" | "UNKNOWN" | "NOT_APPLICABLE";
export type RevisionCompletenessStatus = "COMPLETE" | "INCOMPLETE" | "UNKNOWN" | "NOT_APPLICABLE";
export type DatasetReadinessStatus = "RESEARCH_READY" | "NOT_RESEARCH_READY" | "READINESS_POLICY_UNRESOLVED";

export interface MachineReadableReason {
  readonly code: string;
  readonly message: string;
}

export interface CoverageDenominator {
  readonly status: CoverageDenominatorStatus;
  readonly basis:
    | "BINANCE_ELIGIBLE_1H_SLOTS"
    | "H15_PROVIDER_SOURCE_ROWS"
    | "BLS_MONTHLY_REFERENCE_PERIODS"
    | "FOMC_OFFICIAL_EVENT_SET"
    | "UNRESOLVED_PROVIDER_CONTRACT"
    | "NOT_INCLUDED";
  readonly expectedCount: number | null;
}

export interface RevisionCompletenessAssessment {
  readonly semantics: RevisionSemantics;
  readonly status: RevisionCompletenessStatus;
  readonly observedVintageCount: number;
  readonly expectedVintageCount: number | null;
  readonly missingExpectedVintages: readonly string[];
  readonly finalRegularRevisionComplete: boolean | null;
  readonly reason: string;
}

export interface ResearchSeriesReadinessAssessment {
  readonly seriesId: ResearchSeriesId;
  readonly acquisitionStatus: ResearchSeriesAcquisitionStatus;
  readonly cadence: ResearchCadence;
  readonly requestedWindow: Readonly<{ startTime: number; endTime: number }>;
  readonly denominator: CoverageDenominator;
  readonly canonicalRecordCount: number;
  readonly observedObservationCount: number;
  readonly declaredMissingCount: number | null;
  readonly coverageRatio: number | null;
  readonly observationCoverage: ObservationCoverageStatus;
  readonly firstObservationTime: number | null;
  readonly lastObservationTime: number | null;
  readonly firstAvailableAt: number | null;
  readonly lastAvailableAt: number | null;
  readonly pitAvailabilityValid: boolean | null;
  readonly revisionCompleteness: RevisionCompletenessAssessment;
  readonly reasons: readonly MachineReadableReason[];
}

export interface ResearchDatasetReadinessAssessment {
  readonly snapshotHash: string;
  readonly snapshotCryptographicallyValid: true;
  readonly intendedUse: "RESEARCH_ONLY";
  readonly priceAuthority: "RESEARCH_CONTEXT_ONLY";
  readonly readiness: DatasetReadinessStatus;
  readonly policyFinding: typeof RESEARCH_READINESS_POLICY_FINDING;
  readonly series: readonly ResearchSeriesReadinessAssessment[];
  readonly reasons: readonly MachineReadableReason[];
  readonly predictiveValidityAssessed: false;
  readonly grantsExecutionAuthority: false;
}

type ResearchRecord = HistoricalMarketObservation | HistoricalMacroRelease | HistoricalEventRecord;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function recordsForSeries(snapshot: ResearchDatasetSnapshot, seriesId: ResearchSeriesId): readonly ResearchRecord[] {
  if (seriesId === "FOMC_RATE_DECISION") {
    return snapshot.dataset.eventRecords.filter(
      (record) => record.eventType === "FED_RATE_DECISION" || record.eventType === "FOMC_STATEMENT"
    );
  }
  if (RESEARCH_SERIES_SPECS[seriesId].kind === "MARKET_FACTOR") {
    return snapshot.dataset.marketObservations.filter((record) => record.seriesId === seriesId);
  }
  return snapshot.dataset.macroReleases.filter((record) => record.seriesId === seriesId);
}

function denominatorFor(
  seriesId: ResearchSeriesId,
  entry: ResearchSeriesManifestEntry | undefined,
  observationCount: number,
  acquisitionStatus: ResearchSeriesAcquisitionStatus
): CoverageDenominator {
  if (acquisitionStatus !== "ACQUIRED" || !entry) {
    return { status: "NOT_APPLICABLE", basis: "NOT_INCLUDED", expectedCount: null };
  }
  const expectedCount = observationCount + entry.missingness.missingCount;
  if (entry.provider === "BINANCE_PUBLIC_DATA" && entry.cadence === "1H") {
    return { status: "KNOWN", basis: "BINANCE_ELIGIBLE_1H_SLOTS", expectedCount };
  }
  if (entry.provider === "FEDERAL_RESERVE_H15_VIA_FRED_ALFRED" && entry.cadence === "DAILY") {
    return { status: "KNOWN", basis: "H15_PROVIDER_SOURCE_ROWS", expectedCount };
  }
  if (
    (entry.provider === "BLS_ARCHIVED_CPI_RELEASE" ||
      entry.provider === "BLS_ARCHIVED_EMPLOYMENT_SITUATION") &&
    entry.cadence === "MONTHLY"
  ) {
    return { status: "KNOWN", basis: "BLS_MONTHLY_REFERENCE_PERIODS", expectedCount };
  }
  if (seriesId === "FOMC_RATE_DECISION" && entry.cadence === "EVENT_DRIVEN") {
    return { status: "KNOWN", basis: "FOMC_OFFICIAL_EVENT_SET", expectedCount };
  }
  return { status: "UNKNOWN", basis: "UNRESOLVED_PROVIDER_CONTRACT", expectedCount: null };
}

function monthIndex(timestamp: number): number {
  const date = new Date(timestamp);
  return date.getUTCFullYear() * 12 + date.getUTCMonth();
}

function revisionAssessment(
  seriesId: ResearchSeriesId,
  records: readonly ResearchRecord[],
  semantics: RevisionSemantics
): RevisionCompletenessAssessment {
  const macro = records.filter((record): record is HistoricalMacroRelease => "revisionIndex" in record);
  if (semantics === "NOT_APPLICABLE") {
    return {
      semantics,
      status: "NOT_APPLICABLE",
      observedVintageCount: 0,
      expectedVintageCount: null,
      missingExpectedVintages: [],
      finalRegularRevisionComplete: null,
      reason: "The approved provider contract defines no revision sequence for this series.",
    };
  }
  if (semantics === "INITIAL_ONLY") {
    const missing = macro.filter((record) => record.revisionIndex !== 0);
    return {
      semantics,
      status: missing.length === 0 ? "COMPLETE" : "INCOMPLETE",
      observedVintageCount: macro.length,
      expectedVintageCount: macro.length,
      missingExpectedVintages: [],
      finalRegularRevisionComplete: missing.length === 0,
      reason: "The approved contract permits only revisionIndex 0 target states.",
    };
  }
  if (seriesId === "US_NFP_NET_CHANGE") {
    const observationTimes = [...new Set(macro.map((record) => record.observationTime))].sort((a, b) => a - b);
    const latestInitial = Math.max(
      ...macro.filter((record) => record.revisionIndex === 0).map((record) => monthIndex(record.observationTime)),
      -1
    );
    const observed = new Set(macro.map((record) => `${record.observationTime}#${record.revisionIndex}`));
    const missing: string[] = [];
    let expected = 0;
    for (const observationTime of observationTimes) {
      const highestExpected = Math.min(2, Math.max(0, latestInitial - monthIndex(observationTime)));
      for (let revisionIndex = 0; revisionIndex <= highestExpected; revisionIndex += 1) {
        expected += 1;
        const key = `${observationTime}#${revisionIndex}`;
        if (!observed.has(key)) missing.push(key);
      }
    }
    return {
      semantics,
      status: missing.length === 0 ? "COMPLETE" : "INCOMPLETE",
      observedVintageCount: macro.length,
      expectedVintageCount: expected,
      missingExpectedVintages: missing,
      finalRegularRevisionComplete: missing.length === 0,
      reason:
        "NFP expects initial, first, and second/final regular vintages only when each later release opportunity is public.",
    };
  }
  const observations = new Set(macro.map((record) => record.observationTime));
  const initialObservations = new Set(
    macro.filter((record) => record.revisionIndex === 0).map((record) => record.observationTime)
  );
  const missingInitials = [...observations].filter((time) => !initialObservations.has(time)).map((time) => `${time}#0`);
  return {
    semantics,
    status: missingInitials.length > 0 ? "INCOMPLETE" : "UNKNOWN",
    observedVintageCount: macro.length,
    expectedVintageCount: null,
    missingExpectedVintages: missingInitials,
    finalRegularRevisionComplete: null,
    reason:
      missingInitials.length > 0
        ? "One or more CPI observations lack an initial publication vintage."
        : "Initial CPI vintages are present, but the approved contract does not define a universal final-vintage opportunity count.",
  };
}

function assessSeries(snapshot: ResearchDatasetSnapshot, seriesId: ResearchSeriesId): ResearchSeriesReadinessAssessment {
  const status = snapshot.seriesStatuses.find((item) => item.seriesId === seriesId);
  if (!status) throw new Error(`ResearchDatasetReadinessError: missing series status for ${seriesId}.`);
  const records = recordsForSeries(snapshot, seriesId);
  const entry = snapshot.manifest.sources.find((source) => source.seriesId === seriesId);
  const observationTimes = [...new Set(records.map((record) => record.observationTime))].sort((a, b) => a - b);
  const availableTimes = records.map((record) => record.availableAt);
  const denominator = denominatorFor(seriesId, entry, observationTimes.length, status.status);
  const missingCount = entry?.missingness.missingCount ?? null;
  const coverageRatio = denominator.status === "KNOWN" && denominator.expectedCount !== null && denominator.expectedCount > 0
    ? observationTimes.length / denominator.expectedCount
    : null;
  const pitAvailabilityValid = status.status === "ACQUIRED"
    ? records.every((record) => Number.isFinite(record.availableAt) && record.availableAt >= record.observationTime)
    : null;
  const reasons: MachineReadableReason[] = [];
  if (status.status !== "ACQUIRED") reasons.push({ code: `SERIES_${status.status}`, message: status.reason });
  if (denominator.status === "UNKNOWN") {
    reasons.push({
      code: "COVERAGE_DENOMINATOR_UNKNOWN",
      message: "The approved manifest does not expose a truthful expected-observation denominator for this series.",
    });
  }
  if (missingCount !== null && missingCount > 0) {
    reasons.push({ code: "DECLARED_MISSING_OBSERVATIONS", message: `${missingCount} expected observations are declared missing.` });
  }
  if (pitAvailabilityValid === false) {
    reasons.push({ code: "PIT_AVAILABILITY_INVALID", message: "One or more records fail explicit PIT availability ordering." });
  }
  const revisions = revisionAssessment(seriesId, records, RESEARCH_SERIES_SPECS[seriesId].revisionSemantics);
  if (revisions.status === "INCOMPLETE") {
    reasons.push({ code: "MISSING_EXPECTED_VINTAGES", message: revisions.reason });
  }
  const observationCoverage: ObservationCoverageStatus = status.status !== "ACQUIRED"
    ? "NOT_APPLICABLE"
    : denominator.status === "UNKNOWN"
      ? "UNKNOWN"
      : missingCount === 0
        ? "COMPLETE"
        : "INCOMPLETE";
  return {
    seriesId,
    acquisitionStatus: status.status,
    cadence: RESEARCH_SERIES_SPECS[seriesId].cadence,
    requestedWindow: { startTime: snapshot.window.startTime, endTime: snapshot.window.endTime },
    denominator,
    canonicalRecordCount: records.length,
    observedObservationCount: observationTimes.length,
    declaredMissingCount: missingCount,
    coverageRatio,
    observationCoverage,
    firstObservationTime: observationTimes[0] ?? null,
    lastObservationTime: observationTimes.at(-1) ?? null,
    firstAvailableAt: availableTimes.length > 0 ? Math.min(...availableTimes) : null,
    lastAvailableAt: availableTimes.length > 0 ? Math.max(...availableTimes) : null,
    pitAvailabilityValid,
    revisionCompleteness: revisions,
    reasons,
  };
}

export function assessResearchDatasetReadiness(
  snapshot: ResearchDatasetSnapshot
): ResearchDatasetReadinessAssessment {
  validateResearchDatasetSnapshot(snapshot);
  const canonicalSeries = Object.keys(RESEARCH_SERIES_SPECS) as ResearchSeriesId[];
  const series = canonicalSeries.sort().map((seriesId) => assessSeries(snapshot, seriesId));
  const reasons: MachineReadableReason[] = [{
    code: RESEARCH_READINESS_POLICY_FINDING.code,
    message: RESEARCH_READINESS_POLICY_FINDING.reason,
  }];
  for (const item of series) {
    for (const reason of item.reasons) {
      if (item.acquisitionStatus === "ACQUIRED") {
        reasons.push({ code: reason.code, message: `${item.seriesId}: ${reason.message}` });
      }
    }
  }
  // Keep the existing all-series policy visible as evidence; do not silently reinterpret it.
  if (DEFAULT_RESEARCH_COVERAGE_POLICY.requiredSeries.length !== canonicalSeries.length) {
    reasons.push({
      code: "LEGACY_POLICY_SCOPE_MISMATCH",
      message: "The legacy M13B-1 required-series list no longer matches the canonical series universe.",
    });
  }
  return deepFreeze({
    snapshotHash: snapshot.snapshotHash,
    snapshotCryptographicallyValid: true,
    intendedUse: "RESEARCH_ONLY",
    priceAuthority: "RESEARCH_CONTEXT_ONLY",
    readiness: "READINESS_POLICY_UNRESOLVED",
    policyFinding: RESEARCH_READINESS_POLICY_FINDING,
    series,
    reasons,
    predictiveValidityAssessed: false,
    grantsExecutionAuthority: false,
  });
}
