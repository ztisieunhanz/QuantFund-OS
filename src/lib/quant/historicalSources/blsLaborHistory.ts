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

export const BLS_LABOR_PARSER_VERSION = "M13B2-BLS-LABOR-ARCHIVE-HTML-V1";
export const BLS_LABOR_RELEASE_TIME = "08:30";
export const BLS_LABOR_RELEASE_TIME_ZONE = "America/New_York";
export const BLS_LABOR_SUPPORTED_REFERENCE_START = "2021-01";
export const BLS_LABOR_SUPPORTED_REFERENCE_END = "2026-08";
export const BLS_LABOR_ARCHIVE_ROOT = "https://www.bls.gov/news.release/archives";
export const BLS_UNEMPLOYMENT_STATUS = "CONDITIONAL" as const;

export const BLS_LABOR_SOURCE_CONTRACT_URLS = Object.freeze([
  "https://www.bls.gov/bls/news-release/empsit.htm",
  "https://www.bls.gov/schedule/news_release/empsit.htm",
  "https://www.bls.gov/web/empsit/cesvininfo.htm",
  "https://www.bls.gov/web/empsit/cesnaicsrev.htm",
  "https://www.bls.gov/cps/seasonal-adjustment-methodology.htm",
]);

export interface BlsLaborReleaseArtifactInput {
  readonly sourceUrl: string;
  readonly responseBytes: Uint8Array;
  readonly retrievedAt: string;
}

export interface ProcessBlsLaborHistoryInput {
  readonly artifacts: readonly BlsLaborReleaseArtifactInput[];
  readonly releasedThroughMs: number;
}

export interface AcquireBlsLaborHistoryInput {
  readonly sourceUrls: readonly string[];
  readonly retrievedAt: string;
  readonly releasedThroughMs: number;
}

export interface BlsLaborTransport {
  readonly fetchBinary: (url: string) => Promise<Uint8Array>;
}

export interface BlsLaborReleaseEvidence {
  readonly releaseId: string;
  readonly releaseReferencePeriod: string;
  readonly releaseDate: string;
  readonly releaseTime: typeof BLS_LABOR_RELEASE_TIME;
  readonly availableAt: number;
  readonly sourceUrl: string;
  readonly artifactId: string;
  readonly rawSha256: string;
}

export interface BlsNfpVintageEvidence {
  readonly seriesId: "US_NFP_NET_CHANGE";
  readonly referencePeriod: string;
  readonly observationTime: number;
  readonly revisionIndex: 0 | 1 | 2;
  readonly revisionLabel: "INITIAL" | "FIRST_REVISION" | "SECOND_FINAL_REGULAR_REVISION";
  readonly value: number;
  readonly previousPublishedValue: number | null;
  readonly releaseId: string;
  readonly releaseDate: string;
  readonly availableAt: number;
  readonly sourceUrl: string;
  readonly artifactId: string;
  readonly rawSha256: string;
}

export interface BlsLaborCoverage {
  readonly firstReferencePeriod: string;
  readonly lastReferencePeriod: string;
  readonly firstObservationTime: number;
  readonly lastObservationTime: number;
  readonly firstAvailableAt: number;
  readonly lastAvailableAt: number;
  readonly recordCount: number;
  readonly releaseCount: number;
  readonly observationPeriodCount: number;
  readonly missingCount: number;
  readonly missingReferencePeriods: readonly string[];
  readonly missingVintageCount: number;
  readonly missingVintages: readonly string[];
  readonly method: string;
  readonly missingVintagePolicy: string;
  readonly supportedRegime: string;
  readonly benchmarkPolicy: string;
}

export interface BlsLaborHistoryResult {
  readonly artifacts: readonly VerifiedRawArtifact[];
  readonly releaseEvidence: readonly BlsLaborReleaseEvidence[];
  readonly macroReleases: readonly HistoricalMacroRelease[];
  readonly vintageEvidence: readonly BlsNfpVintageEvidence[];
  readonly normalizedContentHash: string;
  readonly coverage: BlsLaborCoverage;
  readonly manifestEntry: ResearchSeriesManifestEntry;
  readonly unemploymentStatus: typeof BLS_UNEMPLOYMENT_STATUS;
  readonly intendedUse: "RESEARCH_ONLY";
  readonly priceAuthority: "RESEARCH_CONTEXT_ONLY";
}

export interface BlsUnemploymentVintageWitness {
  readonly referencePeriod: string;
  readonly releaseId: string;
  readonly releaseDate: string;
  readonly value: number;
  readonly sourceUrl: string;
}

export interface BlsUnemploymentVintageProofResult {
  readonly status: typeof BLS_UNEMPLOYMENT_STATUS;
  readonly referencePeriod: string;
  readonly initialValue: number;
  readonly revisedValue: number;
  readonly revisionDetected: boolean;
  readonly reason: string;
}

interface ParsedVintage {
  readonly referencePeriod: string;
  readonly revisionIndex: 0 | 1 | 2;
  readonly value: number;
  readonly previousPublishedValue: number | null;
}

interface ParsedRelease {
  readonly releaseId: string;
  readonly releaseReferencePeriod: string;
  readonly releaseDate: string;
  readonly vintages: readonly ParsedVintage[];
}

const MONTHS: Readonly<Record<string, number>> = Object.freeze({
  JANUARY: 1, FEBRUARY: 2, MARCH: 3, APRIL: 4, MAY: 5, JUNE: 6,
  JULY: 7, AUGUST: 8, SEPTEMBER: 9, OCTOBER: 10, NOVEMBER: 11, DECEMBER: 12,
});

function fail(message: string): never {
  throw new HistoricalAcquisitionError(`BLS labor: ${message}`);
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) fail(`${field} must be a non-empty string.`);
  return value.trim();
}

function requireDate(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) fail(`${field} must use YYYY-MM-DD.`);
  const epoch = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString().slice(0, 10) !== value) {
    fail(`${field} is not a valid calendar date.`);
  }
  return value;
}

function requireReferencePeriod(value: string, field: string): string {
  if (!/^\d{4}-\d{2}$/u.test(value)) fail(`${field} must use YYYY-MM.`);
  const month = Number(value.slice(5, 7));
  if (month < 1 || month > 12) fail(`${field} is not a valid reference period.`);
  if (value < BLS_LABOR_SUPPORTED_REFERENCE_START || value > BLS_LABOR_SUPPORTED_REFERENCE_END) {
    fail(`${field} ${value} is outside the proven archive regime.`);
  }
  return value;
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

function visibleText(html: string): string {
  return html
    .replace(/<!--[^]*?-->/gu, " ")
    .replace(/<script\b[^>]*>[^]*?<\/script>/giu, " ")
    .replace(/<style\b[^>]*>[^]*?<\/style>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&#(\d+);/gu, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/giu, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&nbsp;|&#160;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/[‐‑‒–—−]/gu, "-")
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

function periodFromMonth(monthName: string, year: number): string {
  const month = MONTHS[monthName.toUpperCase()];
  if (!month) fail(`unsupported reference month "${monthName}".`);
  return requireReferencePeriod(`${year}-${String(month).padStart(2, "0")}`, "referencePeriod");
}

function addMonths(period: string, amount: number): string {
  const date = new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)) - 1 + amount, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function observationTime(referencePeriod: string): number {
  const valid = requireReferencePeriod(referencePeriod, "referencePeriod");
  return Date.UTC(Number(valid.slice(0, 4)), Number(valid.slice(5, 7)), 0);
}

function parseSignedThousands(token: string, field: string): number {
  if (!/^[+-]?\d{1,3}(?:,\d{3})*$/u.test(token)) fail(`${field} contains malformed thousands value "${token}".`);
  const value = Number(token.replaceAll(",", ""));
  if (!Number.isFinite(value)) fail(`${field} must be finite.`);
  return value / 1_000;
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
    parsed.protocol !== "https:" || parsed.hostname !== "www.bls.gov" ||
    !/^\/news\.release\/archives\/empsit_\d{8}\.htm$/u.test(parsed.pathname) ||
    parsed.search.length > 0 || parsed.hash.length > 0
  ) {
    fail("sourceUrl must identify an official archived BLS Employment Situation HTML release.");
  }
  return parsed.toString();
}

function parseInitialValue(text: string, titleMonth: string): number {
  const candidates: number[] = [];
  const directional = /(?:Total )?nonfarm payroll employment\s+(rose|increased|declined|decreased|fell)\s+by\s+(\d{1,3}(?:,\d{3})*)\s+in\s+([A-Za-z]+)/giu;
  for (const match of text.matchAll(directional)) {
    if (match[3].toUpperCase() !== titleMonth.toUpperCase()) continue;
    const magnitude = parseSignedThousands(match[2], "initial NFP value");
    candidates.push(/declined|decreased|fell/iu.test(match[1]) ? -magnitude : magnitude);
  }
  const changedLittle = /(?:Total )?nonfarm payroll employment\s+changed little(?:\s+in\s+([A-Za-z]+))?\s+\(([+-]\d{1,3}(?:,\d{3})*)\)/giu;
  for (const match of text.matchAll(changedLittle)) {
    if (match[1] && match[1].toUpperCase() !== titleMonth.toUpperCase()) continue;
    candidates.push(parseSignedThousands(match[2], "initial NFP value"));
  }
  const unique = [...new Set(candidates)];
  if (unique.length !== 1) fail("release has missing or conflicting explicit initial total-nonfarm change values.");
  return unique[0];
}

function parseRevisionPair(text: string): readonly [{ month: string; previous: number; value: number }, { month: string; previous: number; value: number }] {
  const token = "([+-]\\d{1,3}(?:,\\d{3})*)";
  const pattern = new RegExp(
    `The change in total nonfarm payroll employment for\\s+([A-Za-z]+)\\s+was revised` +
    `(?:\\s+(?:up|down) by\\s+\\d{1,3}(?:,\\d{3})*,)?\\s+from\\s+${token}\\s+to\\s+${token},\\s+` +
    `and the change for\\s+([A-Za-z]+)\\s+was revised` +
    `(?:\\s+(?:up|down) by\\s+\\d{1,3}(?:,\\d{3})*,)?\\s+from\\s+${token}\\s+to\\s+${token}`,
    "giu"
  );
  const matches = [...text.matchAll(pattern)];
  if (matches.length !== 1) fail("release has missing or conflicting first/second payroll revision prose.");
  const match = matches[0];
  return Object.freeze([
    Object.freeze({
      month: match[1],
      previous: parseSignedThousands(match[2], "older prior-published NFP value"),
      value: parseSignedThousands(match[3], "older revised NFP value"),
    }),
    Object.freeze({
      month: match[4],
      previous: parseSignedThousands(match[5], "newer prior-published NFP value"),
      value: parseSignedThousands(match[6], "newer revised NFP value"),
    }),
  ] as const);
}

function parseArchivedRelease(html: string, sourceUrl: string): ParsedRelease {
  const text = visibleText(html);
  if (/news release was reissued|corrected news release|correction to this (?:news )?release/iu.test(text)) {
    fail("release contains a correction/reissue notice outside the approved contract.");
  }
  const releaseIds = [...new Set(text.match(/USDL-\d{2}-\d+/giu)?.map((value) => value.toUpperCase()) ?? [])];
  if (releaseIds.length !== 1) fail("release has missing or conflicting USDL identity.");
  const header = /Transmission of material in this news release is embargoed until(?:\s+USDL-\d{2}-\d+)?\s+8:30\s+a\.m\.\s+\(ET\)\s+(?:[A-Za-z]+,\s+)?([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/iu.exec(text);
  if (!header) fail("release header/schema is unsupported or missing its explicit 08:30 ET embargo witness.");
  const releaseDate = monthNameDateToIso(header[1], header[2], header[3]);
  const title = /THE EMPLOYMENT SITUATION\s*-{1,2}\s*([A-Za-z]+)\s+(\d{4})/iu.exec(text);
  if (!title) fail("release title does not expose a reference month.");
  const releaseReferencePeriod = periodFromMonth(title[1], Number(title[2]));
  const olderPeriod = addMonths(releaseReferencePeriod, -2);
  const newerPeriod = addMonths(releaseReferencePeriod, -1);
  const revisions = parseRevisionPair(text);
  if (revisions[0].month.toUpperCase() !== Object.keys(MONTHS)[Number(olderPeriod.slice(5, 7)) - 1] ||
      revisions[1].month.toUpperCase() !== Object.keys(MONTHS)[Number(newerPeriod.slice(5, 7)) - 1]) {
    fail("revision months do not match the release's two preceding reference periods.");
  }
  const initialValue = parseInitialValue(text, title[1]);
  const urlDate = /empsit_(\d{2})(\d{2})(\d{4})\.htm$/u.exec(new URL(sourceUrl).pathname);
  if (!urlDate) fail("source URL release date is malformed.");
  const urlReleaseDate = requireDate(`${urlDate[3]}-${urlDate[1]}-${urlDate[2]}`, "sourceUrl date");
  if (urlReleaseDate !== releaseDate) fail("source URL date conflicts with the release header.");
  if (Date.parse(`${releaseDate}T00:00:00.000Z`) <= observationTime(releaseReferencePeriod)) {
    fail("release date must follow the reference-period boundary.");
  }
  return Object.freeze({
    releaseId: releaseIds[0],
    releaseReferencePeriod,
    releaseDate,
    vintages: Object.freeze([
      Object.freeze({ referencePeriod: olderPeriod, revisionIndex: 2, value: revisions[0].value, previousPublishedValue: revisions[0].previous }),
      Object.freeze({ referencePeriod: newerPeriod, revisionIndex: 1, value: revisions[1].value, previousPublishedValue: revisions[1].previous }),
      Object.freeze({ referencePeriod: releaseReferencePeriod, revisionIndex: 0, value: initialValue, previousPublishedValue: null }),
    ]),
  });
}

function expectedPeriods(first: string, last: string): readonly string[] {
  const result: string[] = [];
  for (let cursor = first; cursor <= last; cursor = addMonths(cursor, 1)) result.push(cursor);
  return Object.freeze(result);
}

function revisionLabel(index: 0 | 1 | 2): BlsNfpVintageEvidence["revisionLabel"] {
  return index === 0 ? "INITIAL" : index === 1 ? "FIRST_REVISION" : "SECOND_FINAL_REGULAR_REVISION";
}

export function processBlsLaborHistory(input: ProcessBlsLaborHistoryInput): BlsLaborHistoryResult {
  if (!Array.isArray(input.artifacts) || input.artifacts.length === 0) fail("artifacts must contain at least one archived release.");
  if (!Number.isFinite(input.releasedThroughMs) || input.releasedThroughMs < 0) {
    fail("releasedThroughMs must be a non-negative finite timestamp.");
  }
  const parsedRows: Array<{ parsed: ParsedRelease; artifact: VerifiedRawArtifact; sourceUrl: string; availableAt: number }> = [];
  const releaseIds = new Set<string>();
  const sourceUrls = new Set<string>();
  for (const [index, source] of input.artifacts.entries()) {
    const sourceUrl = validateSourceUrl(source.sourceUrl);
    if (sourceUrls.has(sourceUrl)) fail(`duplicate source artifact ${sourceUrl}.`);
    sourceUrls.add(sourceUrl);
    const artifact = verifyRawArtifact({
      provider: "US_BUREAU_OF_LABOR_STATISTICS",
      sourceArtifactType: "BLS_EMPLOYMENT_SITUATION_ARCHIVED_NEWS_RELEASE",
      instrument: "CES_TOTAL_NONFARM_DIRECT_PUBLISHED_CHANGE",
      archiveUrl: sourceUrl,
      providerChecksumPolicy: "NOT_PUBLISHED",
      checksumUrl: null,
      partition: new URL(sourceUrl).pathname.split("/").at(-1) ?? `release-${index + 1}`,
      retrievedAt: source.retrievedAt,
      rawBytes: source.responseBytes,
      parserVersion: BLS_LABOR_PARSER_VERSION,
      licensingClassification: "BLS_PUBLIC_ARCHIVED_NEWS_RELEASE",
    });
    const parsed = parseArchivedRelease(decodeHtml(source.responseBytes), sourceUrl);
    if (releaseIds.has(parsed.releaseId)) fail(`duplicate or conflicting release ID ${parsed.releaseId}.`);
    releaseIds.add(parsed.releaseId);
    const availableAt = marketDateTimeToEpochMs(parsed.releaseDate, BLS_LABOR_RELEASE_TIME, BLS_LABOR_RELEASE_TIME_ZONE);
    parsedRows.push({ parsed, artifact, sourceUrl, availableAt });
  }
  parsedRows.sort((left, right) => left.availableAt - right.availableAt || left.parsed.releaseId.localeCompare(right.parsed.releaseId));
  const publicRows = parsedRows.filter((item) => item.availableAt <= input.releasedThroughMs);
  if (publicRows.length === 0) fail("no archived Employment Situation release was public by releasedThroughMs.");

  const artifacts = Object.freeze(publicRows.map((item) => item.artifact).sort((left, right) => left.request.url.localeCompare(right.request.url)));
  const releaseEvidence = Object.freeze(publicRows.map((item) => Object.freeze({
    releaseId: item.parsed.releaseId,
    releaseReferencePeriod: item.parsed.releaseReferencePeriod,
    releaseDate: item.parsed.releaseDate,
    releaseTime: BLS_LABOR_RELEASE_TIME,
    availableAt: item.availableAt,
    sourceUrl: item.sourceUrl,
    artifactId: item.artifact.artifactId,
    rawSha256: item.artifact.rawSha256,
  })));
  const vintages: BlsNfpVintageEvidence[] = [];
  const vintageKeys = new Set<string>();
  for (const item of publicRows) {
    for (const vintage of item.parsed.vintages) {
      if (
        vintage.referencePeriod < BLS_LABOR_SUPPORTED_REFERENCE_START ||
        vintage.referencePeriod > BLS_LABOR_SUPPORTED_REFERENCE_END
      ) continue;
      const key = `${vintage.referencePeriod}#${vintage.revisionIndex}`;
      if (vintageKeys.has(key)) fail(`duplicate or conflicting vintage identity ${key}.`);
      vintageKeys.add(key);
      vintages.push(Object.freeze({
        seriesId: "US_NFP_NET_CHANGE",
        referencePeriod: vintage.referencePeriod,
        observationTime: observationTime(vintage.referencePeriod),
        revisionIndex: vintage.revisionIndex,
        revisionLabel: revisionLabel(vintage.revisionIndex),
        value: vintage.value,
        previousPublishedValue: vintage.previousPublishedValue,
        releaseId: item.parsed.releaseId,
        releaseDate: item.parsed.releaseDate,
        availableAt: item.availableAt,
        sourceUrl: item.sourceUrl,
        artifactId: item.artifact.artifactId,
        rawSha256: item.artifact.rawSha256,
      }));
    }
  }
  vintages.sort((left, right) =>
    left.referencePeriod.localeCompare(right.referencePeriod) ||
    left.revisionIndex - right.revisionIndex || left.availableAt - right.availableAt
  );
  const byVintage = new Map(vintages.map((item) => [`${item.referencePeriod}#${item.revisionIndex}`, item]));
  for (const item of vintages) {
    if (item.revisionIndex === 0) continue;
    const prior = byVintage.get(`${item.referencePeriod}#${item.revisionIndex - 1}`);
    if (prior && item.previousPublishedValue !== prior.value) {
      fail(`revision chain conflict for ${item.referencePeriod} revision ${item.revisionIndex}.`);
    }
  }

  const macroReleases = Object.freeze(vintages.map((item) => {
    const release: HistoricalMacroRelease = Object.freeze({
      seriesId: item.seriesId,
      observationTime: item.observationTime,
      publishedAt: item.availableAt,
      availableAt: item.availableAt,
      vintageDate: item.releaseDate,
      revisionIndex: item.revisionIndex,
      value: item.value,
      provider: "BLS_ARCHIVED_EMPLOYMENT_SITUATION",
      unit: "THOUSANDS_OF_PERSONS",
    });
    validateHistoricalMacroRelease(release);
    return release;
  }));
  const periods = [...new Set(vintages.map((item) => item.referencePeriod))].sort();
  const firstReferencePeriod = periods[0];
  const lastReferencePeriod = periods.at(-1);
  if (!firstReferencePeriod || !lastReferencePeriod) fail("no public NFP vintages were produced.");
  const expected = expectedPeriods(firstReferencePeriod, lastReferencePeriod);
  const missingReferencePeriods = expected.filter((period) => !periods.includes(period));
  const latestInitialPeriod = [...publicRows].sort((a, b) => a.parsed.releaseReferencePeriod.localeCompare(b.parsed.releaseReferencePeriod)).at(-1)?.parsed.releaseReferencePeriod;
  if (!latestInitialPeriod) fail("no initial release period is available.");
  const missingVintages: string[] = [];
  for (const period of expected) {
    const distance = (Number(latestInitialPeriod.slice(0, 4)) - Number(period.slice(0, 4))) * 12 +
      Number(latestInitialPeriod.slice(5, 7)) - Number(period.slice(5, 7));
    const highestExpected = Math.min(2, Math.max(0, distance));
    for (let index = 0; index <= highestExpected; index += 1) {
      if (!vintageKeys.has(`${period}#${index}`)) missingVintages.push(`${period}#${index}`);
    }
  }
  const coverageMethod =
    "Expected monthly reference periods between the first and last accepted NFP vintage; revisions are additional vintages, not periods; no interpolation, forward fill, or trailing future-period inference";
  const missingVintagePolicy =
    "revisionIndex 0 is the direct initial headline value, 1 is the next release's explicit first revision, and 2 is the following release's explicit second/final regular revision; only revisions whose release opportunity is public by the latest accepted initial period are expected";
  const coverage: BlsLaborCoverage = Object.freeze({
    firstReferencePeriod,
    lastReferencePeriod,
    firstObservationTime: Math.min(...macroReleases.map((item) => item.observationTime)),
    lastObservationTime: Math.max(...macroReleases.map((item) => item.observationTime)),
    firstAvailableAt: Math.min(...macroReleases.map((item) => item.availableAt)),
    lastAvailableAt: Math.max(...macroReleases.map((item) => item.availableAt)),
    recordCount: macroReleases.length,
    releaseCount: publicRows.length,
    observationPeriodCount: periods.length,
    missingCount: missingReferencePeriods.length,
    missingReferencePeriods: Object.freeze(missingReferencePeriods),
    missingVintageCount: missingVintages.length,
    missingVintages: Object.freeze(missingVintages),
    method: coverageMethod,
    missingVintagePolicy,
    supportedRegime:
      `Official archived Employment Situation HTML releases for reference periods ${BLS_LABOR_SUPPORTED_REFERENCE_START} through ${BLS_LABOR_SUPPORTED_REFERENCE_END}, with explicit 08:30 ET embargo and direct published NFP change/revision prose`,
    benchmarkPolicy:
      "The adapter preserves the regular initial/first/second publication sequence, including benchmark effects explicitly present in those two revision sentences; it does not ingest later benchmark-restated history from annual tables as additional vintages",
  });
  const normalizedContentHash = `sha256:${sha256Hex(canonicalJson({
    contract: BLS_LABOR_PARSER_VERSION,
    seriesId: "US_NFP_NET_CHANGE",
    rows: vintages.map((item) => ({
      referencePeriod: item.referencePeriod,
      revisionIndex: item.revisionIndex,
      revisionLabel: item.revisionLabel,
      value: item.value,
      previousPublishedValue: item.previousPublishedValue,
      releaseId: item.releaseId,
      releaseDate: item.releaseDate,
      releaseTime: BLS_LABOR_RELEASE_TIME,
      availableAt: item.availableAt,
      sourceUrl: item.sourceUrl,
    })),
  }))}`;
  const provenance = canonicalJson({
    parserVersion: BLS_LABOR_PARSER_VERSION,
    sourceContractUrls: BLS_LABOR_SOURCE_CONTRACT_URLS,
    providerChecksumPolicy: "NOT_PUBLISHED",
    artifacts: artifacts.map((artifact) => ({
      artifactId: artifact.artifactId,
      sourceUrl: artifact.request.url,
      rawSha256: artifact.rawSha256,
      providerChecksum: artifact.providerChecksum,
    })).sort((left, right) => left.sourceUrl.localeCompare(right.sourceUrl)),
    revisionRule: missingVintagePolicy,
    benchmarkPolicy: coverage.benchmarkPolicy,
  });
  const manifestEntry: ResearchSeriesManifestEntry = Object.freeze({
    seriesId: "US_NFP_NET_CHANGE",
    kind: "MACRO_RELEASE",
    provider: "BLS_ARCHIVED_EMPLOYMENT_SITUATION",
    providerInstrument: "CES_TOTAL_NONFARM_DIRECT_PUBLISHED_OVER_MONTH_CHANGE",
    cadence: "MONTHLY",
    unit: "THOUSANDS_OF_PERSONS",
    firstObservationTime: coverage.firstObservationTime,
    lastObservationTime: coverage.lastObservationTime,
    firstAvailableAt: coverage.firstAvailableAt,
    lastAvailableAt: coverage.lastAvailableAt,
    recordCount: coverage.recordCount,
    missingness: Object.freeze({ missingCount: coverage.missingCount, method: coverage.method }),
    revisionSemantics: "VINTAGE_AWARE",
    timezoneSessionRule:
      "Reference month normalized to UTC month-end; each release boundary converted from witnessed 08:30 America/New_York using historical DST rules",
    availabilityRule:
      "publishedAt and availableAt equal the archived release header's explicit 08:30 ET embargo boundary for that initial or revised value; retrieval time and reference month are never availability evidence",
    provenance,
    contentHash: normalizedContentHash,
  });
  return Object.freeze({
    artifacts,
    releaseEvidence,
    macroReleases,
    vintageEvidence: Object.freeze(vintages),
    normalizedContentHash,
    coverage,
    manifestEntry,
    unemploymentStatus: BLS_UNEMPLOYMENT_STATUS,
    intendedUse: "RESEARCH_ONLY",
    priceAuthority: "RESEARCH_CONTEXT_ONLY",
  });
}

export async function acquireBlsLaborHistory(
  input: AcquireBlsLaborHistoryInput,
  transport: BlsLaborTransport = { fetchBinary }
): Promise<BlsLaborHistoryResult> {
  if (!Array.isArray(input.sourceUrls) || input.sourceUrls.length === 0) {
    fail("sourceUrls must contain at least one official archived release URL.");
  }
  const artifacts = await Promise.all(input.sourceUrls.map(async (sourceUrl) => ({
    sourceUrl: validateSourceUrl(sourceUrl),
    responseBytes: await transport.fetchBinary(sourceUrl),
    retrievedAt: input.retrievedAt,
  })));
  return processBlsLaborHistory({ artifacts, releasedThroughMs: input.releasedThroughMs });
}

export function evaluateBlsUnemploymentVintagePair(
  initial: BlsUnemploymentVintageWitness,
  annualRevision: BlsUnemploymentVintageWitness
): BlsUnemploymentVintageProofResult {
  const initialPeriod = requireReferencePeriod(initial?.referencePeriod, "initial.referencePeriod");
  const revisedPeriod = requireReferencePeriod(annualRevision?.referencePeriod, "annualRevision.referencePeriod");
  if (initialPeriod !== revisedPeriod) fail("unemployment proof witnesses must describe the same reference period.");
  const initialDate = requireDate(requireText(initial.releaseDate, "initial.releaseDate"), "initial.releaseDate");
  const revisedDate = requireDate(requireText(annualRevision.releaseDate, "annualRevision.releaseDate"), "annualRevision.releaseDate");
  if (revisedDate <= initialDate) fail("unemployment revision witness must follow the initial release.");
  validateSourceUrl(initial.sourceUrl);
  validateSourceUrl(annualRevision.sourceUrl);
  requireText(initial.releaseId, "initial.releaseId");
  requireText(annualRevision.releaseId, "annualRevision.releaseId");
  if (!Number.isFinite(initial.value) || !Number.isFinite(annualRevision.value)) fail("unemployment proof values must be finite.");
  return Object.freeze({
    status: BLS_UNEMPLOYMENT_STATUS,
    referencePeriod: initialPeriod,
    initialValue: initial.value,
    revisedValue: annualRevision.value,
    revisionDetected: initial.value !== annualRevision.value,
    reason:
      "Archived releases prove individual as-published and annual revised unemployment values, but the official source contract has not yet proven a complete deterministic five-year mapping across annual seasonal revisions, population-control changes, errata, and non-reissued releases. Broad US_UNEMPLOYMENT_RATE acquisition remains unavailable.",
  });
}
