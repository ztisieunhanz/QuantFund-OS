import {
  validateHistoricalMacroRelease,
  type HistoricalMacroRelease,
} from "../historicalPit";
import type { ResearchSeriesManifestEntry } from "../researchDataProtocol";
import {
  HistoricalAcquisitionError,
  canonicalJson,
  fetchBinary,
  sha256Hex,
  verifyRawArtifact,
  type VerifiedRawArtifact,
} from "./immutableAcquisition";
import { marketDateTimeToEpochMs } from "./timezoneUtils";

export const BLS_CPI_PARSER_VERSION = "M13B2-BLS-CPI-ARCHIVE-HTML-V1";
export const BLS_CPI_RELEASE_TIME = "08:30";
export const BLS_CPI_RELEASE_TIME_ZONE = "America/New_York";
export const BLS_CPI_SUPPORTED_REFERENCE_START = "2021-01";
export const BLS_CPI_SUPPORTED_REFERENCE_END = "2026-08";
export const BLS_CPI_ARCHIVE_ROOT = "https://www.bls.gov/news.release/archives";
export const BLS_CPI_MOM_STATUS = "CONDITIONAL" as const;

export const BLS_CPI_SOURCE_CONTRACT_URLS = Object.freeze([
  "https://www.bls.gov/bls/news-release/cpi.htm",
  "https://www.bls.gov/cpi/tables/supplemental-files/",
  "https://www.bls.gov/cpi/tables/seasonal-adjustment/",
  "https://www.bls.gov/cpi/seasonal-adjustment/",
]);

export type BlsCpiImplementedSeriesId = "US_CPI_INDEX" | "US_CPI_YOY";

export interface BlsCpiReleaseArtifactInput {
  readonly sourceUrl: string;
  readonly responseBytes: Uint8Array;
  readonly retrievedAt: string;
}

export interface ProcessBlsCpiHistoryInput {
  readonly artifacts: readonly BlsCpiReleaseArtifactInput[];
  readonly releasedThroughMs: number;
}

export interface AcquireBlsCpiHistoryInput {
  readonly sourceUrls: readonly string[];
  readonly retrievedAt: string;
  readonly releasedThroughMs: number;
}

export interface BlsCpiTransport {
  readonly fetchBinary: (url: string) => Promise<Uint8Array>;
}

export interface BlsCpiReleaseEvidence {
  readonly releaseId: string;
  readonly referencePeriod: string;
  readonly releaseDate: string;
  readonly releaseTime: typeof BLS_CPI_RELEASE_TIME;
  readonly availableAt: number;
  readonly indexValue: number;
  readonly yoyValue: number;
  readonly sourceUrl: string;
  readonly artifactId: string;
  readonly rawSha256: string;
}

export interface BlsCpiVintageEvidence {
  readonly seriesId: BlsCpiImplementedSeriesId;
  readonly observationTime: number;
  readonly revisionIndex: number;
  readonly releaseId: string;
  readonly releaseDate: string;
  readonly availableAt: number;
  readonly artifactId: string;
  readonly rawSha256: string;
  readonly sourceUrl: string;
}

export interface BlsCpiCoverage {
  readonly firstReferencePeriod: string;
  readonly lastReferencePeriod: string;
  readonly firstObservationTime: number;
  readonly lastObservationTime: number;
  readonly firstAvailableAt: number;
  readonly lastAvailableAt: number;
  readonly recordCount: number;
  readonly observationPeriodCount: number;
  readonly missingCount: number;
  readonly missingReferencePeriods: readonly string[];
  readonly method: string;
  readonly supportedRegime: string;
}

export interface BlsCpiSeriesResult {
  readonly seriesId: BlsCpiImplementedSeriesId;
  readonly releases: readonly HistoricalMacroRelease[];
  readonly vintageEvidence: readonly BlsCpiVintageEvidence[];
  readonly normalizedContentHash: string;
  readonly coverage: BlsCpiCoverage;
  readonly manifestEntry: ResearchSeriesManifestEntry;
}

export interface BlsCpiHistoryResult {
  readonly artifacts: readonly VerifiedRawArtifact[];
  readonly releaseEvidence: readonly BlsCpiReleaseEvidence[];
  readonly series: Readonly<Record<BlsCpiImplementedSeriesId, BlsCpiSeriesResult>>;
  readonly intendedUse: "RESEARCH_ONLY";
  readonly priceAuthority: "RESEARCH_CONTEXT_ONLY";
  readonly cpiMomStatus: typeof BLS_CPI_MOM_STATUS;
}

export interface BlsCpiMomVintageWitness {
  readonly referencePeriod: string;
  readonly releaseId: string;
  readonly releaseDate: string;
  readonly value: number;
  readonly sourceUrl: string;
}

export interface BlsCpiMomVintageProofResult {
  readonly status: typeof BLS_CPI_MOM_STATUS;
  readonly referencePeriod: string;
  readonly initialValue: number;
  readonly revisedValue: number;
  readonly revisionDetected: boolean;
  readonly reason: string;
}

interface ParsedRelease {
  readonly releaseId: string;
  readonly referencePeriod: string;
  readonly releaseDate: string;
  readonly indexValue: number;
  readonly yoyValue: number;
}

const MONTHS: Readonly<Record<string, number>> = Object.freeze({
  JANUARY: 1,
  FEBRUARY: 2,
  MARCH: 3,
  APRIL: 4,
  MAY: 5,
  JUNE: 6,
  JULY: 7,
  AUGUST: 8,
  SEPTEMBER: 9,
  OCTOBER: 10,
  NOVEMBER: 11,
  DECEMBER: 12,
});

function fail(message: string): never {
  throw new HistoricalAcquisitionError(`BLS CPI: ${message}`);
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

function requireDate(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) fail(`${field} must use YYYY-MM-DD.`);
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) {
    fail(`${field} is not a valid calendar date.`);
  }
  return value;
}

function requireReferencePeriod(value: string, field: string): string {
  if (!/^\d{4}-\d{2}$/u.test(value)) fail(`${field} must use YYYY-MM.`);
  const month = Number(value.slice(5, 7));
  if (month < 1 || month > 12) fail(`${field} is not a valid reference period.`);
  if (value < BLS_CPI_SUPPORTED_REFERENCE_START || value > BLS_CPI_SUPPORTED_REFERENCE_END) {
    fail(`${field} ${value} is outside the proven archive regime.`);
  }
  return value;
}

function referencePeriodToObservationTime(referencePeriod: string): number {
  const valid = requireReferencePeriod(referencePeriod, "referencePeriod");
  const year = Number(valid.slice(0, 4));
  const month = Number(valid.slice(5, 7));
  return Date.UTC(year, month, 0, 0, 0, 0, 0);
}

function decodeHtml(bytes: Uint8Array): string {
  let html: string;
  try {
    html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail("release artifact is not valid UTF-8.");
  }
  if (!/<html\b|<!doctype\s+html/iu.test(html)) fail("release artifact is not supported HTML.");
  return html;
}

function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;|&#160;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/\s+/gu, " ")
    .trim();
}

function monthNameDateToIso(monthName: string, dayText: string, yearText: string): string {
  const month = MONTHS[monthName.toUpperCase()];
  if (!month) fail(`unsupported release month "${monthName}".`);
  return requireDate(
    `${yearText}-${String(month).padStart(2, "0")}-${String(Number(dayText)).padStart(2, "0")}`,
    "releaseDate"
  );
}

function validateSourceUrl(sourceUrl: string): string {
  const text = requireText(sourceUrl, "sourceUrl");
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return fail("sourceUrl must be a valid URL.");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "www.bls.gov" ||
    !/^\/news\.release\/archives\/cpi_\d{8}\.htm$/u.test(parsed.pathname) ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    fail("sourceUrl must identify an official archived BLS CPI HTML release.");
  }
  return parsed.toString();
}

function parseArchivedRelease(html: string, sourceUrl: string): ParsedRelease {
  const text = htmlToText(html);
  if (/news release was reissued|corrected news release|errata/iu.test(text)) {
    fail("release contains a reissue or errata notice and requires a separately approved correction contract.");
  }
  const header = /Transmission of material in this release is embargoed until\s+(\d{1,2}):(\d{2})\s+(a\.m\.|p\.m\.)\s+\(ET\)\s+(?:[A-Za-z]+,\s+)?([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})\s+(USDL-\d{2}-\d+)/iu.exec(text);
  if (!header) fail("release header/schema is unsupported or missing its embargo witness.");
  const hour = Number(header[1]);
  const minute = Number(header[2]);
  const meridiem = header[3].toLowerCase();
  if (hour !== 8 || minute !== 30 || meridiem !== "a.m.") {
    fail(`release time ${header[1]}:${header[2]} ${header[3]} is outside the proven 08:30 ET regime.`);
  }
  const releaseDate = monthNameDateToIso(header[4], header[5], header[6]);
  const releaseId = header[7].toUpperCase();

  const title = /CONSUMER PRICE INDEX\s*[-–—�]\s*([A-Za-z]+)\s+(\d{4})/iu.exec(text);
  if (!title) fail("release title does not expose a reference month.");
  const referenceMonth = MONTHS[title[1].toUpperCase()];
  if (!referenceMonth) fail(`unsupported reference month "${title[1]}".`);
  const referencePeriod = requireReferencePeriod(
    `${title[2]}-${String(referenceMonth).padStart(2, "0")}`,
    "referencePeriod"
  );

  const published = /The Consumer Price Index for All Urban Consumers\s*\(CPI-U\)\s+(increased|decreased|rose|fell)\s+(\d+(?:\.\d+)?)\s+percent\s+over the last 12 months\s+to an index level of\s+(\d+(?:\.\d+)?)/iu.exec(text);
  if (!published) fail("release does not expose the as-published all-items index and 12-month change.");
  const direction = published[1].toLowerCase();
  const magnitude = Number(published[2]);
  const yoyValue = direction === "decreased" || direction === "fell" ? -magnitude : magnitude;
  const indexValue = Number(published[3]);
  if (!Number.isFinite(yoyValue) || !Number.isFinite(indexValue)) {
    fail("release contains a non-finite CPI value.");
  }

  const urlDate = /cpi_(\d{2})(\d{2})(\d{4})\.htm$/u.exec(new URL(sourceUrl).pathname);
  if (!urlDate) fail("source URL release date is malformed.");
  const urlReleaseDate = requireDate(`${urlDate[3]}-${urlDate[1]}-${urlDate[2]}`, "sourceUrl date");
  if (urlReleaseDate !== releaseDate) fail("source URL date conflicts with the release header.");
  if (Date.parse(`${releaseDate}T00:00:00.000Z`) <= referencePeriodToObservationTime(referencePeriod)) {
    fail("release date must follow the reference period boundary.");
  }

  return Object.freeze({ releaseId, referencePeriod, releaseDate, indexValue, yoyValue });
}

function addMonth(period: string): string {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  const next = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
  return `${next.year}-${String(next.month).padStart(2, "0")}`;
}

function expectedPeriods(first: string, last: string): readonly string[] {
  const periods: string[] = [];
  for (let cursor = first; cursor <= last; cursor = addMonth(cursor)) periods.push(cursor);
  return Object.freeze(periods);
}

function createSeriesResult(
  seriesId: BlsCpiImplementedSeriesId,
  evidence: readonly BlsCpiReleaseEvidence[],
  artifacts: readonly VerifiedRawArtifact[]
): BlsCpiSeriesResult {
  const valueOf = (item: BlsCpiReleaseEvidence): number =>
    seriesId === "US_CPI_INDEX" ? item.indexValue : item.yoyValue;
  const unit = seriesId === "US_CPI_INDEX" ? "INDEX_1982_84_100" : "PERCENT_12_MONTH_NSA";
  const instrument = seriesId === "US_CPI_INDEX"
    ? "CUUR0000SA0"
    : "CUUR0000SA0/EXPLICIT_12_MONTH_NSA";
  const sorted = [...evidence].sort((left, right) =>
    left.referencePeriod.localeCompare(right.referencePeriod) ||
    left.availableAt - right.availableAt ||
    left.releaseId.localeCompare(right.releaseId)
  );
  const releases: HistoricalMacroRelease[] = [];
  const vintageEvidence: BlsCpiVintageEvidence[] = [];
  const lastValue = new Map<string, number>();
  const revisionCount = new Map<string, number>();
  for (const item of sorted) {
    const value = valueOf(item);
    if (lastValue.get(item.referencePeriod) === value) continue;
    const revisionIndex = revisionCount.get(item.referencePeriod) ?? 0;
    const observationTime = referencePeriodToObservationTime(item.referencePeriod);
    const release: HistoricalMacroRelease = Object.freeze({
      seriesId,
      observationTime,
      publishedAt: item.availableAt,
      availableAt: item.availableAt,
      vintageDate: item.releaseDate,
      revisionIndex,
      value,
      provider: "BLS_ARCHIVED_CPI_RELEASE",
      unit,
    });
    validateHistoricalMacroRelease(release);
    releases.push(release);
    vintageEvidence.push(Object.freeze({
      seriesId,
      observationTime,
      revisionIndex,
      releaseId: item.releaseId,
      releaseDate: item.releaseDate,
      availableAt: item.availableAt,
      artifactId: item.artifactId,
      rawSha256: item.rawSha256,
      sourceUrl: item.sourceUrl,
    }));
    lastValue.set(item.referencePeriod, value);
    revisionCount.set(item.referencePeriod, revisionIndex + 1);
  }
  if (releases.length === 0) fail(`${seriesId} produced no releases.`);

  const periods = [...new Set(sorted.map((item) => item.referencePeriod))].sort();
  const firstReferencePeriod = periods[0];
  const lastReferencePeriod = periods.at(-1);
  if (!firstReferencePeriod || !lastReferencePeriod) fail(`${seriesId} produced no reference periods.`);
  const missingReferencePeriods = expectedPeriods(firstReferencePeriod, lastReferencePeriod)
    .filter((period) => !periods.includes(period));
  const availableTimes = releases.map((release) => release.availableAt);
  const observationTimes = releases.map((release) => release.observationTime);
  const normalizedRows = releases.map((release, index) => ({
    release,
    releaseId: vintageEvidence[index].releaseId,
  }));
  const normalizedContentHash = `sha256:${sha256Hex(canonicalJson({
    contract: BLS_CPI_PARSER_VERSION,
    seriesId,
    instrument,
    rows: normalizedRows,
  }))}`;
  const coverage: BlsCpiCoverage = Object.freeze({
    firstReferencePeriod,
    lastReferencePeriod,
    firstObservationTime: Math.min(...observationTimes),
    lastObservationTime: Math.max(...observationTimes),
    firstAvailableAt: Math.min(...availableTimes),
    lastAvailableAt: Math.max(...availableTimes),
    recordCount: releases.length,
    observationPeriodCount: periods.length,
    missingCount: missingReferencePeriods.length,
    missingReferencePeriods: Object.freeze(missingReferencePeriods),
    method:
      "Expected monthly reference periods between the first and last accepted archived releases; " +
      "revisions add vintages, not observation periods; no interpolation or trailing future-period inference",
    supportedRegime:
      `Archived BLS CPI HTML releases for reference periods ${BLS_CPI_SUPPORTED_REFERENCE_START} through ` +
      `${BLS_CPI_SUPPORTED_REFERENCE_END}, each with an explicit 08:30 ET embargo witness`,
  });
  const artifactById = new Map(artifacts.map((artifact) => [artifact.artifactId, artifact]));
  const provenance = canonicalJson({
    parserVersion: BLS_CPI_PARSER_VERSION,
    sourceContractUrls: BLS_CPI_SOURCE_CONTRACT_URLS,
    artifacts: vintageEvidence.map((item) => {
      const artifact = artifactById.get(item.artifactId);
      return {
        artifactId: item.artifactId,
        rawSha256: item.rawSha256,
        sourceUrl: item.sourceUrl,
        providerChecksum: artifact?.providerChecksum ?? null,
        releaseId: item.releaseId,
        releaseDate: item.releaseDate,
      };
    }),
  });
  const manifestEntry: ResearchSeriesManifestEntry = Object.freeze({
    seriesId,
    kind: "MACRO_RELEASE",
    provider: "BLS_ARCHIVED_CPI_RELEASE",
    providerInstrument: instrument,
    cadence: "MONTHLY",
    unit,
    firstObservationTime: coverage.firstObservationTime,
    lastObservationTime: coverage.lastObservationTime,
    firstAvailableAt: coverage.firstAvailableAt,
    lastAvailableAt: coverage.lastAvailableAt,
    recordCount: coverage.recordCount,
    missingness: Object.freeze({ missingCount: coverage.missingCount, method: coverage.method }),
    revisionSemantics: "VINTAGE_AWARE",
    timezoneSessionRule:
      "Reference month normalized to UTC month-end; release boundary converted from 08:30 America/New_York with historical DST rules",
    availabilityRule:
      "availableAt equals the archived BLS release header's date at its explicit 08:30 ET embargo boundary; acquisition time and reference month are never availability evidence",
    provenance,
    contentHash: normalizedContentHash,
  });
  return Object.freeze({
    seriesId,
    releases: Object.freeze(releases),
    vintageEvidence: Object.freeze(vintageEvidence),
    normalizedContentHash,
    coverage,
    manifestEntry,
  });
}

export function processBlsCpiHistory(input: ProcessBlsCpiHistoryInput): BlsCpiHistoryResult {
  if (!Array.isArray(input.artifacts) || input.artifacts.length === 0) {
    fail("artifacts must contain at least one archived release.");
  }
  if (!Number.isFinite(input.releasedThroughMs) || input.releasedThroughMs < 0) {
    fail("releasedThroughMs must be a non-negative finite timestamp.");
  }
  const artifacts: VerifiedRawArtifact[] = [];
  const evidence: BlsCpiReleaseEvidence[] = [];
  const releaseIds = new Set<string>();
  const sourceUrls = new Set<string>();
  for (const [index, source] of input.artifacts.entries()) {
    const sourceUrl = validateSourceUrl(source.sourceUrl);
    if (sourceUrls.has(sourceUrl)) fail(`duplicate source artifact ${sourceUrl}.`);
    sourceUrls.add(sourceUrl);
    const artifact = verifyRawArtifact({
      provider: "US_BUREAU_OF_LABOR_STATISTICS",
      seriesId: "BLS_CPI_RELEASE",
      instrument: "CUUR0000SA0",
      archiveUrl: sourceUrl,
      providerChecksumPolicy: "NOT_PUBLISHED",
      checksumUrl: null,
      partition: new URL(sourceUrl).pathname.split("/").at(-1) ?? `release-${index + 1}`,
      retrievedAt: source.retrievedAt,
      rawBytes: source.responseBytes,
      parserVersion: BLS_CPI_PARSER_VERSION,
      licensingClassification: "BLS_PUBLIC_ARCHIVED_NEWS_RELEASE",
    });
    const parsed = parseArchivedRelease(decodeHtml(source.responseBytes), sourceUrl);
    if (releaseIds.has(parsed.releaseId)) fail(`duplicate or conflicting release ID ${parsed.releaseId}.`);
    releaseIds.add(parsed.releaseId);
    const availableAt = marketDateTimeToEpochMs(
      parsed.releaseDate,
      BLS_CPI_RELEASE_TIME,
      BLS_CPI_RELEASE_TIME_ZONE
    );
    if (availableAt > input.releasedThroughMs) {
      fail(`release ${parsed.releaseId} is incomplete or unreleased at the acquisition boundary.`);
    }
    artifacts.push(artifact);
    evidence.push(Object.freeze({
      ...parsed,
      releaseTime: BLS_CPI_RELEASE_TIME,
      availableAt,
      sourceUrl,
      artifactId: artifact.artifactId,
      rawSha256: artifact.rawSha256,
    }));
  }
  evidence.sort((left, right) =>
    left.referencePeriod.localeCompare(right.referencePeriod) ||
    left.availableAt - right.availableAt ||
    left.releaseId.localeCompare(right.releaseId)
  );
  artifacts.sort((left, right) => left.request.url.localeCompare(right.request.url));
  return Object.freeze({
    artifacts: Object.freeze(artifacts),
    releaseEvidence: Object.freeze(evidence),
    series: Object.freeze({
      US_CPI_INDEX: createSeriesResult("US_CPI_INDEX", evidence, artifacts),
      US_CPI_YOY: createSeriesResult("US_CPI_YOY", evidence, artifacts),
    }),
    intendedUse: "RESEARCH_ONLY",
    priceAuthority: "RESEARCH_CONTEXT_ONLY",
    cpiMomStatus: BLS_CPI_MOM_STATUS,
  });
}

export async function acquireBlsCpiHistory(
  input: AcquireBlsCpiHistoryInput,
  transport: BlsCpiTransport = { fetchBinary }
): Promise<BlsCpiHistoryResult> {
  if (!Array.isArray(input.sourceUrls) || input.sourceUrls.length === 0) {
    fail("sourceUrls must contain at least one official archived release URL.");
  }
  const artifacts = await Promise.all(input.sourceUrls.map(async (sourceUrl) => ({
    sourceUrl: validateSourceUrl(sourceUrl),
    responseBytes: await transport.fetchBinary(sourceUrl),
    retrievedAt: input.retrievedAt,
  })));
  return processBlsCpiHistory({ artifacts, releasedThroughMs: input.releasedThroughMs });
}

export function evaluateBlsCpiMomSeasonalVintagePair(
  initial: BlsCpiMomVintageWitness,
  annualRevision: BlsCpiMomVintageWitness
): BlsCpiMomVintageProofResult {
  const initialPeriod = requireReferencePeriod(initial?.referencePeriod, "initial.referencePeriod");
  const revisedPeriod = requireReferencePeriod(annualRevision?.referencePeriod, "annualRevision.referencePeriod");
  if (initialPeriod !== revisedPeriod) fail("CPI MoM proof witnesses must describe the same reference period.");
  const initialReleaseDate = requireDate(requireText(initial.releaseDate, "initial.releaseDate"), "initial.releaseDate");
  const revisedReleaseDate = requireDate(
    requireText(annualRevision.releaseDate, "annualRevision.releaseDate"),
    "annualRevision.releaseDate"
  );
  if (revisedReleaseDate <= initialReleaseDate) {
    fail("CPI MoM annual-revision witness must be released after the initial witness.");
  }
  validateSourceUrl(initial.sourceUrl);
  validateSourceUrl(annualRevision.sourceUrl);
  requireText(initial.releaseId, "initial.releaseId");
  requireText(annualRevision.releaseId, "annualRevision.releaseId");
  if (!Number.isFinite(initial.value) || !Number.isFinite(annualRevision.value)) {
    fail("CPI MoM proof values must be finite.");
  }
  const revisionDetected = initial.value !== annualRevision.value;
  return Object.freeze({
    status: BLS_CPI_MOM_STATUS,
    referencePeriod: initialPeriod,
    initialValue: initial.value,
    revisedValue: annualRevision.value,
    revisionDetected,
    reason:
      "A representative archived release pair proves that annual seasonal adjustment can change an " +
      "as-published monthly value, but does not prove complete release-by-release vintage reconstruction " +
      "for the required history. Broad US_CPI_MOM acquisition remains unavailable.",
  });
}
