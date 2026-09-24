import {
  type HistoricalMarketObservation,
  validateHistoricalMarketObservation,
} from "../historicalPit";
import type { ResearchSeriesManifestEntry } from "../researchDataProtocol";
import {
  HistoricalAcquisitionError,
  canonicalJson,
  sha256Hex,
  verifyRawArtifact,
  type VerifiedRawArtifact,
} from "./immutableAcquisition";
import {
  marketDateTimeToEpochMs,
  sessionDateToUtcMidnightEpochMs,
} from "./timezoneUtils";

export const H15_TREASURY_PARSER_VERSION = "M13B2-H15-FRED-INITIAL-V1";
export const H15_FRED_API_ROOT = "https://api.stlouisfed.org/fred/series/observations";
export const H15_RELEASE_TIME = "16:15";
export const H15_RELEASE_TIME_ZONE = "America/New_York";
export const H15_SUPPORTED_OBSERVATION_START = "2021-01-01";
export const H15_SUPPORTED_OBSERVATION_END = "2026-09-21";
export const H15_SUPPORTED_RELEASE_END = "2026-09-22";

export const H15_SOURCE_CONTRACT_URLS = Object.freeze([
  "https://www.federalreserve.gov/releases/h15/",
  "https://www.federalreserve.gov/newsevents/2021-january.htm",
  "https://www.federalreserve.gov/newsevents/2022-may.htm",
  "https://www.federalreserve.gov/newsevents/2023-april.htm",
  "https://www.federalreserve.gov/newsevents/2024-april.htm",
  "https://www.federalreserve.gov/newsevents/2025-april.htm",
  "https://www.federalreserve.gov/newsevents/2026-september.htm",
  "https://fred.stlouisfed.org/docs/api/fred/series_observations.html",
  "https://fred.stlouisfed.org/docs/api/fred/series_vintagedates.html",
]);

export type H15TreasurySeriesId = "US2Y" | "US10Y";

const H15_INSTRUMENTS: Readonly<Record<H15TreasurySeriesId, "DGS2" | "DGS10">> =
  Object.freeze({ US2Y: "DGS2", US10Y: "DGS10" });

interface FredInitialObservation {
  readonly realtime_start: string;
  readonly realtime_end: string;
  readonly date: string;
  readonly value: string;
}

interface FredInitialReleaseResponse {
  readonly observation_start: string;
  readonly observation_end: string;
  readonly output_type: number;
  readonly file_type: string;
  readonly order_by: string;
  readonly sort_order: string;
  readonly count: number;
  readonly offset: number;
  readonly limit: number;
  readonly observations: readonly FredInitialObservation[];
}

interface H15MissingObservationWitness {
  readonly observationDate: string;
  readonly releaseDate: string;
  readonly availableAt: number;
}

export interface H15TreasuryRequestIdentity {
  readonly seriesId: H15TreasurySeriesId;
  readonly instrument: "DGS2" | "DGS10";
  readonly observationStart: string;
  readonly observationEnd: string;
  readonly sourceUrl: string;
  readonly partition: string;
}

export interface H15TreasuryCoverage {
  readonly firstObservationTime: number;
  readonly lastObservationTime: number;
  readonly firstAvailableAt: number;
  readonly lastAvailableAt: number;
  readonly sourceRowCount: number;
  readonly recordCount: number;
  readonly missingCount: number;
  readonly missingObservationDates: readonly string[];
  readonly method: string;
  readonly supportedPublicationRegime: string;
}

export interface H15TreasuryResult {
  readonly artifact: VerifiedRawArtifact;
  readonly normalizedContentHash: string;
  readonly observations: readonly HistoricalMarketObservation[];
  readonly coverage: H15TreasuryCoverage;
  readonly manifestEntry: ResearchSeriesManifestEntry;
  readonly intendedUse: "RESEARCH_ONLY";
  readonly priceAuthority: "RESEARCH_CONTEXT_ONLY";
}

export interface ProcessH15TreasuryInput {
  readonly seriesId: H15TreasurySeriesId;
  readonly observationStart: string;
  readonly observationEnd: string;
  readonly responseBytes: Uint8Array;
  readonly retrievedAt: string;
  readonly releasedThroughMs: number;
}

export interface AcquireH15TreasuryInput
  extends Omit<ProcessH15TreasuryInput, "responseBytes"> {
  readonly apiKey: string;
}

export interface H15TreasuryTransport {
  readonly fetchBinary: (authenticatedUrl: string) => Promise<Uint8Array>;
}

function fail(message: string): never {
  throw new HistoricalAcquisitionError(`H.15 Treasury: ${message}`);
}

function requireDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    fail(`${field} must use YYYY-MM-DD.`);
  }
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) {
    fail(`${field} is not a valid calendar date.`);
  }
  return value;
}

function requireSupportedObservationDate(value: unknown, field: string): string {
  const date = requireDate(value, field);
  if (date < H15_SUPPORTED_OBSERVATION_START || date > H15_SUPPORTED_OBSERVATION_END) {
    fail(
      `${field} ${date} is outside the proven publication regime ` +
      `${H15_SUPPORTED_OBSERVATION_START} through ${H15_SUPPORTED_OBSERVATION_END}.`
    );
  }
  return date;
}

function requireSeries(seriesId: H15TreasurySeriesId): "DGS2" | "DGS10" {
  const instrument = H15_INSTRUMENTS[seriesId];
  if (!instrument) fail(`unsupported research series "${String(seriesId)}".`);
  return instrument;
}

export function createH15TreasuryRequestIdentity(
  seriesId: H15TreasurySeriesId,
  observationStart: string,
  observationEnd: string
): H15TreasuryRequestIdentity {
  const instrument = requireSeries(seriesId);
  const start = requireSupportedObservationDate(observationStart, "observationStart");
  const end = requireSupportedObservationDate(observationEnd, "observationEnd");
  if (start > end) fail("observationStart cannot exceed observationEnd.");
  const query = new URLSearchParams({
    series_id: instrument,
    file_type: "json",
    output_type: "4",
    observation_start: start,
    observation_end: end,
    order_by: "observation_date",
    sort_order: "asc",
    limit: "100000",
  });
  return Object.freeze({
    seriesId,
    instrument,
    observationStart: start,
    observationEnd: end,
    sourceUrl: `${H15_FRED_API_ROOT}?${query.toString()}`,
    partition: `${start}/${end}`,
  });
}

function decodeJson(bytes: Uint8Array): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail("response is not valid UTF-8.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return fail("response is not valid JSON.");
  }
}

function parseResponse(
  value: unknown,
  identity: H15TreasuryRequestIdentity
): FredInitialReleaseResponse {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("response root must be an object.");
  }
  const response = value as Record<string, unknown>;
  if (response.output_type !== 4) fail("response output_type must be 4 (initial release only).");
  if (response.file_type !== "json") fail("response file_type must be json.");
  if (response.order_by !== "observation_date" || response.sort_order !== "asc") {
    fail("response ordering metadata is incompatible with the request contract.");
  }
  if (response.observation_start !== identity.observationStart || response.observation_end !== identity.observationEnd) {
    fail("response observation range does not match the request identity.");
  }
  if (!Number.isInteger(response.count) || !Number.isInteger(response.offset) || !Number.isInteger(response.limit)) {
    fail("response pagination metadata must contain integers.");
  }
  if (response.offset !== 0 || (response.limit as number) < (response.count as number)) {
    fail("response is paginated or incomplete.");
  }
  if (!Array.isArray(response.observations)) fail("response observations must be an array.");
  if (response.observations.length === 0) fail("response contains no source rows.");
  if (response.count !== response.observations.length) {
    fail("response count does not match the number of returned observations.");
  }
  return response as unknown as FredInitialReleaseResponse;
}

function parseObservationRows(
  response: FredInitialReleaseResponse,
  identity: H15TreasuryRequestIdentity,
  releasedThroughMs: number
): {
  readonly observations: readonly HistoricalMarketObservation[];
  readonly missingObservationDates: readonly string[];
  readonly missingObservationWitnesses: readonly H15MissingObservationWitness[];
} {
  if (!Number.isFinite(releasedThroughMs) || releasedThroughMs < 0) {
    fail("releasedThroughMs must be a non-negative finite timestamp.");
  }
  const observations: HistoricalMarketObservation[] = [];
  const missingObservationWitnesses: H15MissingObservationWitness[] = [];
  const seen = new Map<string, { releaseDate: string; value: string }>();

  for (const [index, raw] of response.observations.entries()) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      fail(`row ${index + 1} must be an object.`);
    }
    const row = raw as unknown as Record<string, unknown>;
    const observationDate = requireSupportedObservationDate(row.date, `row ${index + 1} date`);
    if (observationDate < identity.observationStart || observationDate > identity.observationEnd) {
      fail(`row ${index + 1} date lies outside the requested observation range.`);
    }
    const releaseDate = requireDate(row.realtime_start, `row ${index + 1} realtime_start`);
    requireDate(row.realtime_end, `row ${index + 1} realtime_end`);
    if (releaseDate <= observationDate) {
      fail(`row ${index + 1} release witness must be later than its observation date.`);
    }
    if (releaseDate > H15_SUPPORTED_RELEASE_END) {
      fail(`row ${index + 1} release date ${releaseDate} is outside the proven publication regime.`);
    }
    if (typeof row.value !== "string" || row.value.length === 0) {
      fail(`row ${index + 1} value must be a non-empty source string.`);
    }
    const prior = seen.get(observationDate);
    if (prior) {
      const kind = prior.releaseDate === releaseDate && prior.value === row.value
        ? "duplicate"
        : "conflicting duplicate";
      fail(`${kind} observation date ${observationDate}.`);
    }
    seen.set(observationDate, { releaseDate, value: row.value });

    const observationTime = sessionDateToUtcMidnightEpochMs(observationDate);
    const availableAt = marketDateTimeToEpochMs(
      releaseDate,
      H15_RELEASE_TIME,
      H15_RELEASE_TIME_ZONE
    );
    if (availableAt <= observationTime) {
      fail(`row ${index + 1} availableAt must be later than observationTime.`);
    }
    if (availableAt > releasedThroughMs) {
      fail(`row ${index + 1} is incomplete or unreleased at the acquisition boundary.`);
    }
    if (row.value === ".") {
      missingObservationWitnesses.push(Object.freeze({
        observationDate,
        releaseDate,
        availableAt,
      }));
      continue;
    }
    if (row.value.trim().length === 0) fail(`row ${index + 1} value is blank.`);
    const numericValue = Number(row.value);
    if (!Number.isFinite(numericValue)) fail(`row ${index + 1} value is not finite.`);

    const observation: HistoricalMarketObservation = Object.freeze({
      seriesId: identity.seriesId,
      value: numericValue,
      observationTime,
      availableAt,
      providerTimestamp: null,
      provider: "FEDERAL_RESERVE_H15_VIA_FRED_ALFRED",
      unit: "PERCENT_PER_ANNUM",
    });
    validateHistoricalMarketObservation(observation);
    observations.push(observation);
  }

  observations.sort((left, right) => left.observationTime - right.observationTime);
  missingObservationWitnesses.sort((left, right) =>
    left.observationDate.localeCompare(right.observationDate)
  );
  const missingObservationDates = Object.freeze(
    missingObservationWitnesses.map((witness) => witness.observationDate)
  );
  if (observations.length === 0) fail("no published yield observations remain after validation.");
  return {
    observations: Object.freeze(observations),
    missingObservationDates,
    missingObservationWitnesses: Object.freeze(missingObservationWitnesses),
  };
}

export function processH15TreasuryInitialRelease(
  input: ProcessH15TreasuryInput
): H15TreasuryResult {
  const identity = createH15TreasuryRequestIdentity(
    input.seriesId,
    input.observationStart,
    input.observationEnd
  );
  const artifact = verifyRawArtifact({
    provider: "FEDERAL_RESERVE_FRED_ALFRED",
    sourceArtifactType: "FRED_ALFRED_H15_INITIAL_RELEASE_OBSERVATIONS",
    instrument: identity.instrument,
    archiveUrl: identity.sourceUrl,
    providerChecksumPolicy: "NOT_PUBLISHED",
    checksumUrl: null,
    partition: identity.partition,
    retrievedAt: input.retrievedAt,
    rawBytes: input.responseBytes,
    parserVersion: H15_TREASURY_PARSER_VERSION,
    licensingClassification: "FEDERAL_RESERVE_PUBLIC_DATA_CITATION_REQUESTED",
  });
  const response = parseResponse(decodeJson(input.responseBytes), identity);
  const parsed = parseObservationRows(response, identity, input.releasedThroughMs);
  const first = parsed.observations[0];
  const last = parsed.observations.at(-1);
  if (!first || !last) fail("response produced no observations.");
  const availableTimes = parsed.observations.map((observation) => observation.availableAt);
  const normalizedContentHash = `sha256:${sha256Hex(canonicalJson({
    contract: H15_TREASURY_PARSER_VERSION,
    seriesId: identity.seriesId,
    instrument: identity.instrument,
    observations: parsed.observations,
    missingObservationWitnesses: parsed.missingObservationWitnesses,
  }))}`;
  const coverage: H15TreasuryCoverage = Object.freeze({
    firstObservationTime: first.observationTime,
    lastObservationTime: last.observationTime,
    firstAvailableAt: Math.min(...availableTimes),
    lastAvailableAt: Math.max(...availableTimes),
    sourceRowCount: response.observations.length,
    recordCount: parsed.observations.length,
    missingCount: parsed.missingObservationDates.length,
    missingObservationDates: parsed.missingObservationDates,
    method:
      "FRED/ALFRED output_type=4 source rows; '.' is counted as an explicit non-observation; " +
      "no generic weekday denominator, interpolation, forward fill, or backfill",
    supportedPublicationRegime:
      `H.15 16:15 America/New_York release calendar, observation dates ` +
      `${H15_SUPPORTED_OBSERVATION_START} through ${H15_SUPPORTED_OBSERVATION_END}`,
  });
  const manifestEntry: ResearchSeriesManifestEntry = Object.freeze({
    seriesId: identity.seriesId,
    kind: "MARKET_FACTOR",
    provider: "FEDERAL_RESERVE_H15_VIA_FRED_ALFRED",
    providerInstrument: identity.instrument,
    cadence: "DAILY",
    unit: "PERCENT_PER_ANNUM",
    firstObservationTime: coverage.firstObservationTime,
    lastObservationTime: coverage.lastObservationTime,
    firstAvailableAt: coverage.firstAvailableAt,
    lastAvailableAt: coverage.lastAvailableAt,
    recordCount: coverage.recordCount,
    missingness: Object.freeze({
      missingCount: coverage.missingCount,
      method: coverage.method,
    }),
    revisionSemantics: "NOT_APPLICABLE",
    timezoneSessionRule:
      "Observation date normalized to UTC midnight; release time converted from 16:15 America/New_York with historical DST rules",
    availabilityRule:
      "availableAt is the ALFRED output_type=4 initial-release realtime_start date at the official H.15 16:15 America/New_York boundary; observation date alone is never sufficient",
    provenance: canonicalJson({
      artifactId: artifact.artifactId,
      sourceUrl: identity.sourceUrl,
      providerChecksum: artifact.providerChecksum,
      rawSha256: artifact.rawSha256,
      parserVersion: artifact.parserVersion,
      outputType: 4,
      sourceContractUrls: H15_SOURCE_CONTRACT_URLS,
      supportedObservationStart: H15_SUPPORTED_OBSERVATION_START,
      supportedObservationEnd: H15_SUPPORTED_OBSERVATION_END,
      supportedReleaseEnd: H15_SUPPORTED_RELEASE_END,
    }),
    contentHash: normalizedContentHash,
  });
  return Object.freeze({
    artifact,
    normalizedContentHash,
    observations: parsed.observations,
    coverage,
    manifestEntry,
    intendedUse: "RESEARCH_ONLY",
    priceAuthority: "RESEARCH_CONTEXT_ONLY",
  });
}

async function fetchFredBinary(authenticatedUrl: string): Promise<Uint8Array> {
  const response = await fetch(authenticatedUrl);
  if (!response.ok) {
    throw new HistoricalAcquisitionError(
      `H.15 Treasury: FRED API request failed with HTTP ${response.status}.`
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

export async function acquireH15TreasuryInitialRelease(
  input: AcquireH15TreasuryInput,
  transport: H15TreasuryTransport = { fetchBinary: fetchFredBinary }
): Promise<H15TreasuryResult> {
  if (typeof input.apiKey !== "string" || input.apiKey.trim().length === 0) {
    fail("apiKey must be supplied at runtime.");
  }
  const identity = createH15TreasuryRequestIdentity(
    input.seriesId,
    input.observationStart,
    input.observationEnd
  );
  const authenticatedUrl = `${identity.sourceUrl}&api_key=${encodeURIComponent(input.apiKey.trim())}`;
  const responseBytes = await transport.fetchBinary(authenticatedUrl);
  return processH15TreasuryInitialRelease({
    seriesId: input.seriesId,
    observationStart: input.observationStart,
    observationEnd: input.observationEnd,
    retrievedAt: input.retrievedAt,
    releasedThroughMs: input.releasedThroughMs,
    responseBytes,
  });
}
