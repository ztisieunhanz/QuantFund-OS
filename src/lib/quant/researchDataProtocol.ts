import {
  normalizeHistoricalDataset,
  validateHistoricalDataset,
  type HistoricalDataset,
  type HistoricalEventRecord,
  type HistoricalMacroRelease,
  type HistoricalMarketObservation,
} from "./historicalPit";

export const RESEARCH_DATA_SCHEMA_VERSION = "M13B-1.1";
export const RESEARCH_PIT_POLICY_ID = "DEC-015/PIT-AVAILABLE-AT-V1";

export const RESEARCH_MARKET_SERIES = ["BTC", "PAXG", "DXY", "VIX", "US2Y", "US10Y"] as const;
export const RESEARCH_MACRO_SERIES = [
  "US_CPI_YOY",
  "US_CPI_MOM",
  "US_CPI_INDEX",
  "US_NFP_NET_CHANGE",
  "US_UNEMPLOYMENT_RATE",
  "US_FED_FUNDS_TARGET_UPPER",
] as const;
export const RESEARCH_EVENT_SERIES = ["FOMC_RATE_DECISION"] as const;

export type ResearchMarketSeriesId = (typeof RESEARCH_MARKET_SERIES)[number];
export type ResearchMacroSeriesId = (typeof RESEARCH_MACRO_SERIES)[number];
export type ResearchEventSeriesId = (typeof RESEARCH_EVENT_SERIES)[number];
export type ResearchSeriesId = ResearchMarketSeriesId | ResearchMacroSeriesId | ResearchEventSeriesId;
export type ResearchSeriesKind = "MARKET_FACTOR" | "MACRO_RELEASE" | "OFFICIAL_EVENT";
export type ResearchCadence = "1H" | "DAILY" | "MONTHLY" | "EVENT_DRIVEN";
export type RevisionSemantics = "NOT_APPLICABLE" | "INITIAL_ONLY" | "VINTAGE_AWARE";
export type ResearchReadiness = "FIXTURE_ONLY" | "INSUFFICIENT" | "RESEARCH_READY";

export interface CanonicalResearchSeriesSpec {
  readonly kind: ResearchSeriesKind;
  readonly cadence: ResearchCadence;
  readonly revisionSemantics: RevisionSemantics;
}

/** Single source of truth for acquisition-facing series metadata semantics. */
export const RESEARCH_SERIES_SPECS: Readonly<Record<ResearchSeriesId, CanonicalResearchSeriesSpec>> =
  Object.freeze({
    BTC: Object.freeze({ kind: "MARKET_FACTOR", cadence: "1H", revisionSemantics: "NOT_APPLICABLE" }),
    PAXG: Object.freeze({ kind: "MARKET_FACTOR", cadence: "1H", revisionSemantics: "NOT_APPLICABLE" }),
    DXY: Object.freeze({ kind: "MARKET_FACTOR", cadence: "DAILY", revisionSemantics: "NOT_APPLICABLE" }),
    VIX: Object.freeze({ kind: "MARKET_FACTOR", cadence: "DAILY", revisionSemantics: "NOT_APPLICABLE" }),
    US2Y: Object.freeze({ kind: "MARKET_FACTOR", cadence: "DAILY", revisionSemantics: "NOT_APPLICABLE" }),
    US10Y: Object.freeze({ kind: "MARKET_FACTOR", cadence: "DAILY", revisionSemantics: "NOT_APPLICABLE" }),
    US_CPI_YOY: Object.freeze({ kind: "MACRO_RELEASE", cadence: "MONTHLY", revisionSemantics: "VINTAGE_AWARE" }),
    US_CPI_MOM: Object.freeze({ kind: "MACRO_RELEASE", cadence: "MONTHLY", revisionSemantics: "VINTAGE_AWARE" }),
    US_CPI_INDEX: Object.freeze({ kind: "MACRO_RELEASE", cadence: "MONTHLY", revisionSemantics: "VINTAGE_AWARE" }),
    US_NFP_NET_CHANGE: Object.freeze({ kind: "MACRO_RELEASE", cadence: "MONTHLY", revisionSemantics: "VINTAGE_AWARE" }),
    US_UNEMPLOYMENT_RATE: Object.freeze({ kind: "MACRO_RELEASE", cadence: "MONTHLY", revisionSemantics: "VINTAGE_AWARE" }),
    US_FED_FUNDS_TARGET_UPPER: Object.freeze({
      kind: "MACRO_RELEASE",
      cadence: "EVENT_DRIVEN",
      revisionSemantics: "INITIAL_ONLY",
    }),
    FOMC_RATE_DECISION: Object.freeze({
      kind: "OFFICIAL_EVENT",
      cadence: "EVENT_DRIVEN",
      revisionSemantics: "NOT_APPLICABLE",
    }),
  });

const SUPPORTED_SERIES = new Set<string>(Object.keys(RESEARCH_SERIES_SPECS));

export interface ResearchSeriesManifestEntry {
  readonly seriesId: ResearchSeriesId;
  readonly kind: ResearchSeriesKind;
  readonly provider: string;
  readonly providerInstrument: string;
  readonly cadence: ResearchCadence;
  readonly unit: string;
  readonly firstObservationTime: number;
  readonly lastObservationTime: number;
  readonly firstAvailableAt: number;
  readonly lastAvailableAt: number;
  readonly recordCount: number;
  readonly missingness: {
    readonly missingCount: number;
    readonly method: string;
  };
  readonly revisionSemantics: RevisionSemantics;
  readonly timezoneSessionRule: string;
  readonly availabilityRule: string;
  readonly provenance: string;
  readonly contentHash: string;
}

export interface ResearchDatasetManifest {
  readonly datasetId: string;
  readonly schemaVersion: string;
  readonly createdAt: string;
  readonly interval: "1h";
  readonly intendedUse: "RESEARCH_ONLY";
  readonly priceAuthority: "RESEARCH_CONTEXT_ONLY";
  readonly pitPolicy: string;
  readonly snapshotHash: string;
  readonly startTime: number;
  readonly endTime: number;
  readonly totalRecordCount: number;
  readonly sources: readonly ResearchSeriesManifestEntry[];
}

export class ResearchDataProtocolValidationError extends Error {
  constructor(message: string) {
    super(`ResearchDataProtocolValidationError: ${message}`);
    this.name = "ResearchDataProtocolValidationError";
  }
}

function requireText(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ResearchDataProtocolValidationError(`${field} must be a non-empty string.`);
  }
}

function requireTimestamp(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new ResearchDataProtocolValidationError(`${field} must be a non-negative finite timestamp.`);
  }
}

export function validateResearchDatasetManifest(manifest: ResearchDatasetManifest): void {
  requireText(manifest.datasetId, "datasetId");
  requireText(manifest.schemaVersion, "schemaVersion");
  requireText(manifest.createdAt, "createdAt");
  if (!Number.isFinite(Date.parse(manifest.createdAt))) {
    throw new ResearchDataProtocolValidationError("createdAt must be a valid ISO date-time string.");
  }
  if (manifest.interval !== "1h") {
    throw new ResearchDataProtocolValidationError("interval must remain the canonical 1h domain.");
  }
  if (manifest.intendedUse !== "RESEARCH_ONLY") {
    throw new ResearchDataProtocolValidationError("intendedUse must be RESEARCH_ONLY.");
  }
  if (manifest.priceAuthority !== "RESEARCH_CONTEXT_ONLY") {
    throw new ResearchDataProtocolValidationError(
      "research snapshots cannot claim canonical executable-price authority."
    );
  }
  requireText(manifest.pitPolicy, "pitPolicy");
  requireText(manifest.snapshotHash, "snapshotHash");
  requireTimestamp(manifest.startTime, "startTime");
  requireTimestamp(manifest.endTime, "endTime");
  if (manifest.startTime > manifest.endTime) {
    throw new ResearchDataProtocolValidationError("startTime cannot exceed endTime.");
  }
  if (!Number.isInteger(manifest.totalRecordCount) || manifest.totalRecordCount <= 0) {
    throw new ResearchDataProtocolValidationError("totalRecordCount must be a positive integer.");
  }
  if (!Array.isArray(manifest.sources) || manifest.sources.length === 0) {
    throw new ResearchDataProtocolValidationError("sources must contain at least one populated series.");
  }

  const seen = new Set<string>();
  let sourceTotal = 0;
  for (const source of manifest.sources) {
    if (!SUPPORTED_SERIES.has(source.seriesId)) {
      throw new ResearchDataProtocolValidationError(`unsupported research series "${source.seriesId}".`);
    }
    if (seen.has(source.seriesId)) {
      throw new ResearchDataProtocolValidationError(`duplicate series manifest entry "${source.seriesId}".`);
    }
    seen.add(source.seriesId);
    requireText(source.provider, `${source.seriesId}.provider`);
    requireText(source.providerInstrument, `${source.seriesId}.providerInstrument`);
    requireText(source.unit, `${source.seriesId}.unit`);
    requireText(source.timezoneSessionRule, `${source.seriesId}.timezoneSessionRule`);
    requireText(source.availabilityRule, `${source.seriesId}.availabilityRule`);
    requireText(source.provenance, `${source.seriesId}.provenance`);
    requireText(source.contentHash, `${source.seriesId}.contentHash`);
    requireText(source.missingness.method, `${source.seriesId}.missingness.method`);
    const seriesId: ResearchSeriesId = source.seriesId;
    const expectedSpec = RESEARCH_SERIES_SPECS[seriesId];
    if (source.kind !== expectedSpec.kind) {
      throw new ResearchDataProtocolValidationError(
        `${source.seriesId}.kind must be ${expectedSpec.kind}, received ${source.kind}.`
      );
    }
    if (source.cadence !== expectedSpec.cadence) {
      throw new ResearchDataProtocolValidationError(
        `${source.seriesId}.cadence must be ${expectedSpec.cadence}, received ${source.cadence}.`
      );
    }
    requireTimestamp(source.firstObservationTime, `${source.seriesId}.firstObservationTime`);
    requireTimestamp(source.lastObservationTime, `${source.seriesId}.lastObservationTime`);
    requireTimestamp(source.firstAvailableAt, `${source.seriesId}.firstAvailableAt`);
    requireTimestamp(source.lastAvailableAt, `${source.seriesId}.lastAvailableAt`);
    if (source.firstObservationTime > source.lastObservationTime || source.firstAvailableAt > source.lastAvailableAt) {
      throw new ResearchDataProtocolValidationError(`${source.seriesId} has an impossible coverage window.`);
    }
    if (
      source.firstObservationTime < manifest.startTime ||
      source.lastObservationTime > manifest.endTime ||
      source.firstAvailableAt < manifest.startTime ||
      source.lastAvailableAt > manifest.endTime
    ) {
      throw new ResearchDataProtocolValidationError(`${source.seriesId} coverage lies outside the dataset window.`);
    }
    if (!Number.isInteger(source.recordCount) || source.recordCount <= 0) {
      throw new ResearchDataProtocolValidationError(`${source.seriesId}.recordCount must be a positive integer.`);
    }
    if (!Number.isInteger(source.missingness.missingCount) || source.missingness.missingCount < 0) {
      throw new ResearchDataProtocolValidationError(`${source.seriesId}.missingCount must be an integer >= 0.`);
    }
    if (source.revisionSemantics !== expectedSpec.revisionSemantics) {
      throw new ResearchDataProtocolValidationError(
        `${source.seriesId}.revisionSemantics must be ${expectedSpec.revisionSemantics}, received ${source.revisionSemantics}.`
      );
    }
    sourceTotal += source.recordCount;
  }
  if (sourceTotal !== manifest.totalRecordCount) {
    throw new ResearchDataProtocolValidationError(
      `totalRecordCount (${manifest.totalRecordCount}) does not equal per-series total (${sourceTotal}).`
    );
  }
}

export interface ResearchCoveragePolicy {
  readonly policyId: string;
  readonly requiredSeries: readonly ResearchSeriesId[];
  readonly minimumCoverageDays: number;
  readonly minimumMonthlyObservationPeriods: number;
  readonly maximumMissingRatio: number;
  readonly elevatedVixThreshold: number;
  readonly fixtureRecordCeilingPerSeries: number;
  readonly requireElevatedVixObservation: boolean;
  readonly requireUpwardRateTransition: boolean;
  readonly requireDownwardRateTransition: boolean;
  readonly requirePitAvailability: boolean;
  readonly requireRevisionAwareMacroStorage: boolean;
}

/** Administrative data-readiness requirements; they make no claim of predictive significance. */
export const DEFAULT_RESEARCH_COVERAGE_POLICY: ResearchCoveragePolicy = Object.freeze({
  policyId: "M13B-1-COVERAGE-V1",
  requiredSeries: Object.freeze([
    ...RESEARCH_MARKET_SERIES,
    ...RESEARCH_MACRO_SERIES,
    ...RESEARCH_EVENT_SERIES,
  ]),
  minimumCoverageDays: 365 * 5,
  minimumMonthlyObservationPeriods: 60,
  maximumMissingRatio: 0.05,
  elevatedVixThreshold: 30,
  fixtureRecordCeilingPerSeries: 500,
  requireElevatedVixObservation: true,
  requireUpwardRateTransition: true,
  requireDownwardRateTransition: true,
  requirePitAvailability: true,
  requireRevisionAwareMacroStorage: true,
});

export interface ResearchSeriesCoverageResult {
  readonly seriesId: ResearchSeriesId;
  readonly ready: boolean;
  readonly recordCount: number;
  readonly uniqueObservationCount: number;
  readonly missingCount: number | null;
  readonly spanDays: number;
  readonly revisionSemantics: RevisionSemantics | null;
  readonly hasMultipleVintages: boolean;
  readonly blockers: readonly string[];
}

export interface ResearchCoverageReport {
  readonly policyId: string;
  readonly datasetId: string;
  readonly readiness: ResearchReadiness;
  readonly spanDays: number;
  readonly totalRecordCount: number;
  readonly hasElevatedVixObservation: boolean;
  readonly hasUpwardRateTransition: boolean;
  readonly hasDownwardRateTransition: boolean;
  readonly perSeries: readonly ResearchSeriesCoverageResult[];
  readonly blockers: readonly string[];
}

type ResearchRecord = HistoricalMarketObservation | HistoricalMacroRelease | HistoricalEventRecord;

function recordsForSeries(dataset: HistoricalDataset, seriesId: ResearchSeriesId): readonly ResearchRecord[] {
  if (seriesId === "FOMC_RATE_DECISION") {
    return dataset.eventRecords.filter(
      (event) => event.eventType === "FED_RATE_DECISION" || event.eventType === "FOMC_STATEMENT"
    );
  }
  if (RESEARCH_SERIES_SPECS[seriesId].kind === "MARKET_FACTOR") {
    return dataset.marketObservations.filter((record) => record.seriesId === seriesId);
  }
  return dataset.macroReleases.filter((record) => record.seriesId === seriesId);
}

function detectRateTransitions(dataset: HistoricalDataset): { upward: boolean; downward: boolean } {
  const releases = dataset.macroReleases
    .filter((record) => record.seriesId === "US_FED_FUNDS_TARGET_UPPER")
    .sort((a, b) => a.observationTime - b.observationTime || a.revisionIndex - b.revisionIndex);
  let upward = false;
  let downward = false;
  for (let index = 1; index < releases.length; index++) {
    if (releases[index].value > releases[index - 1].value) upward = true;
    if (releases[index].value < releases[index - 1].value) downward = true;
  }
  return { upward, downward };
}

export function assessResearchCoverage(
  dataset: HistoricalDataset,
  manifest: ResearchDatasetManifest,
  policy: ResearchCoveragePolicy = DEFAULT_RESEARCH_COVERAGE_POLICY
): ResearchCoverageReport {
  validateHistoricalDataset(dataset);
  validateResearchDatasetManifest(manifest);
  if (
    dataset.marketObservations.length + dataset.macroReleases.length + dataset.eventRecords.length ===
    0
  ) {
    throw new ResearchDataProtocolValidationError("historical dataset is empty.");
  }
  requireText(policy.policyId, "coverage policyId");
  if (policy.minimumCoverageDays <= 0 || policy.minimumMonthlyObservationPeriods <= 0) {
    throw new ResearchDataProtocolValidationError("coverage minimums must be positive.");
  }
  if (policy.maximumMissingRatio < 0 || policy.maximumMissingRatio > 1) {
    throw new ResearchDataProtocolValidationError("maximumMissingRatio must be between 0 and 1.");
  }
  if (!Number.isFinite(policy.elevatedVixThreshold) || policy.elevatedVixThreshold < 0) {
    throw new ResearchDataProtocolValidationError("elevatedVixThreshold must be a non-negative finite number.");
  }

  const manifestBySeries = new Map(manifest.sources.map((entry) => [entry.seriesId, entry]));
  const perSeries: ResearchSeriesCoverageResult[] = [];
  const blockers: string[] = [];
  let allFixtureSized = true;
  const actualTotal =
    dataset.marketObservations.length + dataset.macroReleases.length + dataset.eventRecords.length;
  if (manifest.totalRecordCount !== actualTotal) {
    blockers.push(`manifest total ${manifest.totalRecordCount} != dataset total ${actualTotal}`);
  }

  for (const seriesId of policy.requiredSeries) {
    const records = recordsForSeries(dataset, seriesId);
    const entry = manifestBySeries.get(seriesId);
    const seriesBlockers: string[] = [];
    const observationTimes = [...new Set(records.map((record) => record.observationTime))].sort((a, b) => a - b);
    const first = observationTimes[0] ?? 0;
    const last = observationTimes[observationTimes.length - 1] ?? first;
    const spanDays = observationTimes.length > 0 ? (last - first) / 86_400_000 : 0;
    const macroRecords = records.filter((record): record is HistoricalMacroRelease => "revisionIndex" in record);
    const hasMultipleVintages = new Set(
      macroRecords.map((record) => `${record.observationTime}|${record.revisionIndex}`)
    ).size > new Set(macroRecords.map((record) => record.observationTime)).size;

    if (records.length === 0) seriesBlockers.push("no records present");
    if (!entry) {
      seriesBlockers.push("manifest entry missing");
    } else {
      if (entry.recordCount !== records.length) {
        seriesBlockers.push(`manifest count ${entry.recordCount} != dataset count ${records.length}`);
      }
      if (records.some((record) => record.provider !== entry.provider)) {
        seriesBlockers.push("manifest provider does not match one or more dataset records");
      }
      if (records.length > 0) {
        const availableTimes = records.map((record) => record.availableAt);
        if (
          entry.firstObservationTime !== first ||
          entry.lastObservationTime !== last ||
          entry.firstAvailableAt !== Math.min(...availableTimes) ||
          entry.lastAvailableAt !== Math.max(...availableTimes)
        ) {
          seriesBlockers.push("manifest coverage timestamps do not match dataset content");
        }
      }
      const missingRatio = entry.missingness.missingCount / (entry.recordCount + entry.missingness.missingCount);
      if (missingRatio > policy.maximumMissingRatio) {
        seriesBlockers.push(`missing ratio ${missingRatio.toFixed(4)} exceeds policy`);
      }
      if (
        policy.requireRevisionAwareMacroStorage &&
        RESEARCH_SERIES_SPECS[seriesId].revisionSemantics === "VINTAGE_AWARE" &&
        entry.revisionSemantics !== "VINTAGE_AWARE"
      ) {
        seriesBlockers.push("macro series is not declared VINTAGE_AWARE");
      }
    }
    if (spanDays < policy.minimumCoverageDays) {
      seriesBlockers.push(`coverage ${spanDays.toFixed(1)} days is below ${policy.minimumCoverageDays}`);
    }
    if (
      RESEARCH_SERIES_SPECS[seriesId].cadence === "MONTHLY" &&
      observationTimes.length < policy.minimumMonthlyObservationPeriods
    ) {
      seriesBlockers.push(
        `${observationTimes.length} unique periods is below ${policy.minimumMonthlyObservationPeriods}`
      );
    }
    if (policy.requirePitAvailability && records.some((record) => !Number.isFinite(record.availableAt))) {
      seriesBlockers.push("one or more records lack finite PIT availability");
    }
    if (records.length > policy.fixtureRecordCeilingPerSeries) allFixtureSized = false;
    for (const reason of seriesBlockers) blockers.push(`${seriesId}: ${reason}`);
    perSeries.push({
      seriesId,
      ready: seriesBlockers.length === 0,
      recordCount: records.length,
      uniqueObservationCount: observationTimes.length,
      missingCount: entry?.missingness.missingCount ?? null,
      spanDays,
      revisionSemantics: entry?.revisionSemantics ?? null,
      hasMultipleVintages,
      blockers: Object.freeze(seriesBlockers),
    });
  }

  const vix = dataset.marketObservations.filter((record) => record.seriesId === "VIX");
  const hasElevatedVixObservation = vix.some((record) => record.value >= policy.elevatedVixThreshold);
  const rateTransitions = detectRateTransitions(dataset);
  if (policy.requireElevatedVixObservation && !hasElevatedVixObservation) {
    blockers.push(`dataset has no VIX observation at or above ${policy.elevatedVixThreshold}`);
  }
  if (policy.requireUpwardRateTransition && !rateTransitions.upward) {
    blockers.push("dataset has no observed upward Fed Funds target transition");
  }
  if (policy.requireDownwardRateTransition && !rateTransitions.downward) {
    blockers.push("dataset has no observed downward Fed Funds target transition");
  }

  const spanDays = (manifest.endTime - manifest.startTime) / 86_400_000;
  const readiness: ResearchReadiness =
    blockers.length === 0 ? "RESEARCH_READY" : allFixtureSized ? "FIXTURE_ONLY" : "INSUFFICIENT";

  return Object.freeze({
    policyId: policy.policyId,
    datasetId: manifest.datasetId,
    readiness,
    spanDays,
    totalRecordCount: actualTotal,
    hasElevatedVixObservation,
    hasUpwardRateTransition: rateTransitions.upward,
    hasDownwardRateTransition: rateTransitions.downward,
    perSeries: Object.freeze(perSeries),
    blockers: Object.freeze(blockers),
  });
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (record[key] !== undefined) result[key] = canonicalize(record[key]);
    }
    return result;
  }
  return value;
}

/**
 * Canonical hash input. createdAt and snapshotHash are excluded because snapshot identity
 * must depend on content, not wall-clock creation metadata or its own digest.
 */
export function buildResearchSnapshotCanonicalInput(
  dataset: HistoricalDataset,
  manifest: ResearchDatasetManifest
): string {
  validateHistoricalDataset(dataset);
  validateResearchDatasetManifest(manifest);
  const normalized = normalizeHistoricalDataset(dataset);
  const manifestIdentity = {
    datasetId: manifest.datasetId,
    schemaVersion: manifest.schemaVersion,
    interval: manifest.interval,
    intendedUse: manifest.intendedUse,
    priceAuthority: manifest.priceAuthority,
    pitPolicy: manifest.pitPolicy,
    startTime: manifest.startTime,
    endTime: manifest.endTime,
    totalRecordCount: manifest.totalRecordCount,
    sources: [...manifest.sources].sort((left, right) => left.seriesId.localeCompare(right.seriesId)),
  };
  return JSON.stringify(canonicalize({ manifest: manifestIdentity, dataset: normalized }));
}

export type ResearchSnapshotHasher = (canonicalInput: string) => string;

/** Injectable cryptographic boundary (for example SHA-256 in a Node or Web Crypto adapter). */
export function calculateResearchSnapshotHash(
  dataset: HistoricalDataset,
  manifest: ResearchDatasetManifest,
  hasher: ResearchSnapshotHasher
): string {
  const digest = hasher(buildResearchSnapshotCanonicalInput(dataset, manifest));
  requireText(digest, "snapshot digest");
  return digest;
}
