import {
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

export type ResearchSeriesReadinessRole = "REQUIRED" | "OPTIONAL";

export interface ResearchSeriesReadinessPolicyEntry {
  readonly role: ResearchSeriesReadinessRole;
  readonly rationale: string;
}

export const M13B_REQUIRED_RESEARCH_SERIES = Object.freeze([
  "BTC",
  "PAXG",
  "US2Y",
  "US10Y",
  "US_CPI_INDEX",
  "US_CPI_YOY",
  "US_NFP_NET_CHANGE",
  "US_FED_FUNDS_TARGET_UPPER",
  "FOMC_RATE_DECISION",
] as const satisfies readonly ResearchSeriesId[]);

export const M13B_OPTIONAL_RESEARCH_SERIES = Object.freeze([
  "DXY",
  "VIX",
  "US_CPI_MOM",
  "US_UNEMPLOYMENT_RATE",
] as const satisfies readonly ResearchSeriesId[]);

export const M13B_RESEARCH_DATASET_READINESS_POLICY = deepFreeze({
  policyId: "M13B-2-B2E-MINIMUM-V1",
  supersedesForDatasetReadiness: "M13B-1-COVERAGE-V1",
  minimumCoverageDays: 365 * 5,
  minimumMonthlyObservationPeriods: 60,
  maximumMissingRatio: 0.05,
  requireUpwardRateTransition: true,
  requireDownwardRateTransition: true,
  requiredSeries: M13B_REQUIRED_RESEARCH_SERIES,
  optionalSeries: M13B_OPTIONAL_RESEARCH_SERIES,
  series: {
    BTC: { role: "REQUIRED", rationale: "Canonical 1H crypto market research input." },
    PAXG: { role: "REQUIRED", rationale: "Canonical 1H gold-proxy market research input." },
    US2Y: { role: "REQUIRED", rationale: "Approved short-rate market-factor context." },
    US10Y: { role: "REQUIRED", rationale: "Approved long-rate market-factor context." },
    US_CPI_INDEX: { role: "REQUIRED", rationale: "Approved as-published inflation-level history." },
    US_CPI_YOY: { role: "REQUIRED", rationale: "Approved as-published inflation-rate history." },
    US_NFP_NET_CHANGE: { role: "REQUIRED", rationale: "Approved revision-aware labor-growth history." },
    US_FED_FUNDS_TARGET_UPPER: {
      role: "REQUIRED",
      rationale: "Approved effective policy-state history paired with official FOMC decisions.",
    },
    FOMC_RATE_DECISION: { role: "REQUIRED", rationale: "Approved bounded official policy-event history." },
    DXY: {
      role: "OPTIONAL",
      rationale: "Source access, publication timing, and licensing remain blocked; no architecture source requires DXY for every hypothesis.",
    },
    VIX: {
      role: "OPTIONAL",
      rationale: "Per-row historical PIT availability remains blocked; no architecture source requires VIX for every hypothesis.",
    },
    US_CPI_MOM: {
      role: "OPTIONAL",
      rationale: "Complete seasonal-vintage reconstruction remains conditional; CPI Index and YoY provide the approved minimum inflation history.",
    },
    US_UNEMPLOYMENT_RATE: {
      role: "OPTIONAL",
      rationale: "Complete as-published vintage mapping remains conditional; NFP provides the approved minimum labor history.",
    },
  } satisfies Readonly<Record<ResearchSeriesId, ResearchSeriesReadinessPolicyEntry>>,
  unknownMetricRules: {
    US_FED_FUNDS_TARGET_UPPER:
      "An UNKNOWN standalone denominator is acceptable only when target states are acquired, INITIAL_ONLY-complete, and paired FOMC official-event coverage is complete.",
    CPI_FINAL_VINTAGE:
      "UNKNOWN final-vintage completeness is acceptable for CPI Index/YoY only when every observed period has its initial as-published vintage and no expected initial vintage is missing.",
  },
  optionalDependencyRule:
    "OPTIONAL does not permit substitution or assumed presence. A future rule that declares an optional-series dependency must be unavailable or INSUFFICIENT_EVIDENCE while that dependency is unavailable.",
});

export const RESEARCH_READINESS_POLICY_FINDING = Object.freeze({
  status: "RESOLVED" as const,
  code: "REQUIRED_SERIES_POLICY_RESOLVED" as const,
  reason:
    "B2-E defines an explicit minimum required dataset and preserves unresolved series as optional, unavailable dependencies for future hypothesis-level enforcement.",
});

export type CoverageDenominatorStatus = "KNOWN" | "UNKNOWN" | "NOT_APPLICABLE";
export type ObservationCoverageStatus = "COMPLETE" | "INCOMPLETE" | "UNKNOWN" | "NOT_APPLICABLE";
export type RevisionCompletenessStatus = "COMPLETE" | "INCOMPLETE" | "UNKNOWN" | "NOT_APPLICABLE";
export type DatasetReadinessStatus = "RESEARCH_READY" | "NOT_RESEARCH_READY";

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
  readonly snapshotCryptographicallyValid: boolean;
  readonly intendedUse: "RESEARCH_ONLY";
  readonly priceAuthority: "RESEARCH_CONTEXT_ONLY";
  readonly readiness: DatasetReadinessStatus;
  readonly policy: typeof M13B_RESEARCH_DATASET_READINESS_POLICY;
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
  try {
    validateResearchDatasetSnapshot(snapshot);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Snapshot validation failed.";
    const pitFailure = /availableAt|publishedAt|timestamp/iu.test(message);
    return deepFreeze({
      snapshotHash: snapshot?.snapshotHash ?? "INVALID",
      snapshotCryptographicallyValid: false,
      intendedUse: "RESEARCH_ONLY",
      priceAuthority: "RESEARCH_CONTEXT_ONLY",
      readiness: "NOT_RESEARCH_READY",
      policy: M13B_RESEARCH_DATASET_READINESS_POLICY,
      policyFinding: RESEARCH_READINESS_POLICY_FINDING,
      series: [],
      reasons: [{
        code: pitFailure ? "PIT_AVAILABILITY_INVALID" : "SNAPSHOT_VALIDATION_FAILED",
        message,
      }],
      predictiveValidityAssessed: false,
      grantsExecutionAuthority: false,
    });
  }
  const canonicalSeries = Object.keys(RESEARCH_SERIES_SPECS) as ResearchSeriesId[];
  const series = canonicalSeries.sort().map((seriesId) => assessSeries(snapshot, seriesId));
  const bySeries = new Map(series.map((item) => [item.seriesId, item]));
  const reasons: MachineReadableReason[] = [];
  const policy = M13B_RESEARCH_DATASET_READINESS_POLICY;

  for (const seriesId of policy.requiredSeries) {
    const item = bySeries.get(seriesId);
    if (!item || item.acquisitionStatus !== "ACQUIRED") {
      reasons.push({
        code: "REQUIRED_SERIES_NOT_ACQUIRED",
        message: `${seriesId} is required but is ${item?.acquisitionStatus ?? "ABSENT"}.`,
      });
      continue;
    }
    if (item.pitAvailabilityValid !== true) {
      reasons.push({
        code: "REQUIRED_SERIES_PIT_INVALID",
        message: `${seriesId} does not have valid point-in-time availability.`,
      });
    }
    if (
      item.firstObservationTime === null ||
      item.lastObservationTime === null ||
      (item.lastObservationTime - item.firstObservationTime) / 86_400_000 < policy.minimumCoverageDays
    ) {
      reasons.push({
        code: "REQUIRED_SERIES_COVERAGE_SPAN_INSUFFICIENT",
        message: `${seriesId} does not span the required ${policy.minimumCoverageDays} days.`,
      });
    }
    if (
      item.cadence === "MONTHLY" &&
      item.observedObservationCount < policy.minimumMonthlyObservationPeriods
    ) {
      reasons.push({
        code: "REQUIRED_MONTHLY_PERIODS_INSUFFICIENT",
        message: `${seriesId} has ${item.observedObservationCount} monthly periods; ${policy.minimumMonthlyObservationPeriods} are required.`,
      });
    }
    if (item.denominator.status === "KNOWN") {
      const missingRatio = item.coverageRatio === null ? 1 : 1 - item.coverageRatio;
      if (missingRatio > policy.maximumMissingRatio) {
        reasons.push({
          code: "REQUIRED_SERIES_MISSINGNESS_EXCEEDS_POLICY",
          message: `${seriesId} missing ratio ${missingRatio.toFixed(4)} exceeds ${policy.maximumMissingRatio.toFixed(4)}.`,
        });
      }
    } else if (seriesId !== "US_FED_FUNDS_TARGET_UPPER") {
      reasons.push({
        code: "REQUIRED_SERIES_DENOMINATOR_UNKNOWN",
        message: `${seriesId} has no approved coverage denominator exception.`,
      });
    }

    const revision = item.revisionCompleteness;
    const cpiUnknownAccepted =
      (seriesId === "US_CPI_INDEX" || seriesId === "US_CPI_YOY") &&
      revision.status === "UNKNOWN" &&
      revision.missingExpectedVintages.length === 0;
    if (revision.status === "INCOMPLETE" || (revision.status === "UNKNOWN" && !cpiUnknownAccepted)) {
      reasons.push({
        code: "REQUIRED_SERIES_REVISION_INCOMPLETE",
        message: `${seriesId}: ${revision.reason}`,
      });
    }
  }

  const fomc = bySeries.get("FOMC_RATE_DECISION");
  const target = bySeries.get("US_FED_FUNDS_TARGET_UPPER");
  if (
    target?.acquisitionStatus === "ACQUIRED" &&
    target.denominator.status === "UNKNOWN" &&
    !(
      target.canonicalRecordCount > 0 &&
      target.revisionCompleteness.status === "COMPLETE" &&
      fomc?.acquisitionStatus === "ACQUIRED" &&
      fomc.observationCoverage === "COMPLETE" &&
      fomc.pitAvailabilityValid === true
    )
  ) {
    reasons.push({
      code: "FED_FUNDS_UNKNOWN_DENOMINATOR_EVIDENCE_INSUFFICIENT",
      message: "Fed Funds target-upper UNKNOWN denominator lacks complete paired FOMC event and initial-only target-state evidence.",
    });
  }

  const rateRecords = snapshot.dataset.macroReleases
    .filter((record) => record.seriesId === "US_FED_FUNDS_TARGET_UPPER")
    .sort((left, right) => left.observationTime - right.observationTime);
  let upward = false;
  let downward = false;
  for (let index = 1; index < rateRecords.length; index += 1) {
    if (rateRecords[index].value > rateRecords[index - 1].value) upward = true;
    if (rateRecords[index].value < rateRecords[index - 1].value) downward = true;
  }
  if (policy.requireUpwardRateTransition && !upward) {
    reasons.push({ code: "UPWARD_RATE_TRANSITION_MISSING", message: "No observed upward Fed Funds target transition is present." });
  }
  if (policy.requireDownwardRateTransition && !downward) {
    reasons.push({ code: "DOWNWARD_RATE_TRANSITION_MISSING", message: "No observed downward Fed Funds target transition is present." });
  }

  return deepFreeze({
    snapshotHash: snapshot.snapshotHash,
    snapshotCryptographicallyValid: true,
    intendedUse: "RESEARCH_ONLY",
    priceAuthority: "RESEARCH_CONTEXT_ONLY",
    readiness: reasons.length === 0 ? "RESEARCH_READY" : "NOT_RESEARCH_READY",
    policy,
    policyFinding: RESEARCH_READINESS_POLICY_FINDING,
    series,
    reasons,
    predictiveValidityAssessed: false,
    grantsExecutionAuthority: false,
  });
}
