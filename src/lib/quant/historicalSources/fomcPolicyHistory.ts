import {
  validateHistoricalEvent,
  validateHistoricalMacroRelease,
  type HistoricalEventRecord,
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
import { marketDateTimeToEpochMs, sessionDateToUtcMidnightEpochMs } from "./timezoneUtils";

export const FOMC_POLICY_PARSER_VERSION = "M13B2-FOMC-POLICY-HTML-V1";
export const FOMC_POLICY_TIME_ZONE = "America/New_York";
export const FOMC_POLICY_SUPPORTED_START = "2021-01-27";
export const FOMC_POLICY_SUPPORTED_END = "2026-09-16";

export const FOMC_POLICY_SOURCE_CONTRACT_URLS = Object.freeze([
  "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm",
  "https://www.federalreserve.gov/newsevents/pressreleases/2021-press-fomc.htm",
  "https://www.federalreserve.gov/newsevents/pressreleases/2022-press-fomc.htm",
  "https://www.federalreserve.gov/newsevents/pressreleases/2023-press-fomc.htm",
  "https://www.federalreserve.gov/newsevents/pressreleases/2024-press-fomc.htm",
  "https://www.federalreserve.gov/newsevents/pressreleases/2025-press-fomc.htm",
  "https://www.federalreserve.gov/newsevents/pressreleases/2026-press-fomc.htm",
]);

/** Official regular-meeting policy-statement dates in the bounded supported regime. */
export const FOMC_SUPPORTED_EVENT_DATES = Object.freeze([
  "2021-01-27", "2021-03-17", "2021-04-28", "2021-06-16", "2021-07-28", "2021-09-22", "2021-11-03", "2021-12-15",
  "2022-01-26", "2022-03-16", "2022-05-04", "2022-06-15", "2022-07-27", "2022-09-21", "2022-11-02", "2022-12-14",
  "2023-02-01", "2023-03-22", "2023-05-03", "2023-06-14", "2023-07-26", "2023-09-20", "2023-11-01", "2023-12-13",
  "2024-01-31", "2024-03-20", "2024-05-01", "2024-06-12", "2024-07-31", "2024-09-18", "2024-11-07", "2024-12-18",
  "2025-01-29", "2025-03-19", "2025-05-07", "2025-06-18", "2025-07-30", "2025-09-17", "2025-10-29", "2025-12-10",
  "2026-01-28", "2026-03-18", "2026-04-29", "2026-06-17", "2026-07-29", "2026-09-16",
] as const);

export type FomcPolicyAction = "MAINTAIN" | "RAISE" | "LOWER";

export interface FomcPolicyArtifactPairInput {
  readonly statementUrl: string;
  readonly statementBytes: Uint8Array;
  readonly implementationNoteUrl: string;
  readonly implementationNoteBytes: Uint8Array;
  readonly retrievedAt: string;
}

export interface ProcessFomcPolicyHistoryInput {
  readonly artifacts: readonly FomcPolicyArtifactPairInput[];
  readonly releasedThroughMs: number;
  readonly expectedEventDates?: readonly string[];
}

export interface AcquireFomcPolicyHistoryInput {
  readonly eventDates: readonly string[];
  readonly retrievedAt: string;
  readonly releasedThroughMs: number;
}

export interface FomcPolicyTransport {
  readonly fetchBinary: (url: string) => Promise<Uint8Array>;
}

export interface FomcPolicyDecisionEvidence {
  readonly eventId: string;
  readonly eventDate: string;
  readonly releaseDate: string;
  readonly releaseTime: string;
  readonly releaseZone: "EST" | "EDT";
  readonly availableAt: number;
  readonly effectiveDate: string;
  readonly effectiveAt: number;
  readonly effectiveTimeBasis: "START_OF_EFFECTIVE_DATE_AMERICA_NEW_YORK";
  readonly targetLower: number;
  readonly targetUpper: number;
  readonly action: FomcPolicyAction;
  readonly changeAmount: number | null;
  readonly statementUrl: string;
  readonly implementationNoteUrl: string;
  readonly statementArtifactId: string;
  readonly implementationArtifactId: string;
}

export interface FomcPolicyCoverage {
  readonly firstEventDate: string;
  readonly lastEventDate: string;
  readonly firstAvailableAt: number;
  readonly lastAvailableAt: number;
  readonly eventCount: number;
  readonly targetUpperCount: number;
  readonly missingCount: number;
  readonly missingEventDates: readonly string[];
  readonly method: string;
  readonly supportedRegime: string;
  readonly exceptionalEventPolicy: string;
}

export interface FomcPolicyHistoryResult {
  readonly artifacts: readonly VerifiedRawArtifact[];
  readonly eventRecords: readonly HistoricalEventRecord[];
  readonly macroReleases: readonly HistoricalMacroRelease[];
  readonly decisionEvidence: readonly FomcPolicyDecisionEvidence[];
  readonly normalizedContentHash: string;
  readonly coverage: FomcPolicyCoverage;
  readonly manifestEntries: readonly ResearchSeriesManifestEntry[];
  readonly intendedUse: "RESEARCH_ONLY";
  readonly priceAuthority: "RESEARCH_CONTEXT_ONLY";
}

const MONTHS: Readonly<Record<string, number>> = Object.freeze({
  January: 1, February: 2, March: 3, April: 4, May: 5, June: 6,
  July: 7, August: 8, September: 9, October: 10, November: 11, December: 12,
});

function fail(message: string): never {
  throw new HistoricalAcquisitionError(`FOMC policy: ${message}`);
}

function decodeHtml(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function visibleText(html: string): string {
  return html
    .replace(/<!--[^]*?-->/gu, " ")
    .replace(/<script\b[^>]*>[^]*?<\/script>/giu, " ")
    .replace(/<style\b[^>]*>[^]*?<\/style>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&#(\d+);/gu, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/giu, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&nbsp;/giu, " ")
    .replace(/&frac14;/giu, "1/4")
    .replace(/&frac12;/giu, "1/2")
    .replace(/&frac34;/giu, "3/4")
    .replace(/&amp;/giu, "&")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/[‐‑‒–—−]/gu, "-")
    .replace(/\s+/gu, " ")
    .trim();
}

function requireDate(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) fail(`${field} must be YYYY-MM-DD.`);
  const epoch = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString().slice(0, 10) !== value) {
    fail(`${field} is not a valid calendar date.`);
  }
  return value;
}

function dateFromUrl(url: string, suffix: "a" | "a1"): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return fail(`invalid official source URL ${url}.`);
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "www.federalreserve.gov") {
    fail(`source URL must use official Federal Reserve HTTPS host: ${url}.`);
  }
  const match = new RegExp(`/newsevents/pressreleases/monetary(\\d{8})${suffix}\\.htm$`, "u").exec(parsed.pathname);
  if (!match) fail(`source URL does not match the approved ${suffix} artifact contract: ${url}.`);
  const raw = match[1];
  return requireDate(`${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`, "source URL date");
}

function assertVisibleReleaseDate(text: string, expectedDate: string): void {
  const [year, month, day] = expectedDate.split("-").map(Number);
  const monthName = Object.keys(MONTHS).find((name) => MONTHS[name] === month);
  if (!monthName || !text.includes(`${monthName} ${day}, ${year}`)) {
    fail(`artifact does not visibly identify release date ${expectedDate}.`);
  }
}

function assertNoUnsupportedCorrection(text: string): void {
  if (/\b(corrected statement|statement corrected|reissued statement|correction notice)\b/iu.test(text)) {
    fail("corrected/reissued statement is outside the approved INITIAL_ONLY source contract.");
  }
}

function easternZoneAt(epochMs: number): "EST" | "EDT" {
  const name = new Intl.DateTimeFormat("en-US", {
    timeZone: FOMC_POLICY_TIME_ZONE,
    timeZoneName: "short",
  }).formatToParts(new Date(epochMs)).find((part) => part.type === "timeZoneName")?.value;
  if (name !== "EST" && name !== "EDT") fail(`unexpected Eastern time-zone label ${name ?? "missing"}.`);
  return name;
}

function parseReleaseBoundary(text: string, releaseDate: string): {
  releaseTime: string;
  releaseZone: "EST" | "EDT";
  availableAt: number;
} {
  const matches = [...text.matchAll(/For release at\s+(\d{1,2}):(\d{2})\s+p\.m\.\s+(EST|EDT)/giu)];
  const unique = new Set(matches.map((match) => `${match[1]}:${match[2]}|${match[3].toUpperCase()}`));
  if (unique.size !== 1) fail("missing or conflicting explicit 'For release at' witness.");
  const witness = [...unique][0];
  const [clock, releaseZoneRaw] = witness.split("|");
  const [hour, minute] = clock.split(":").map(Number);
  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) fail("malformed release time witness.");
  const releaseTime = `${String((hour % 12) + 12).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  const availableAt = marketDateTimeToEpochMs(releaseDate, releaseTime, FOMC_POLICY_TIME_ZONE);
  const releaseZone = releaseZoneRaw as "EST" | "EDT";
  if (easternZoneAt(availableAt) !== releaseZone) fail(`release zone ${releaseZone} conflicts with historical DST.`);
  return { releaseTime, releaseZone, availableAt };
}

function parseRateToken(token: string): number {
  const normalized = token.replace(/[‐‑‒–—−]/gu, "-");
  const mixed = /^(\d+)-(\d+)\/(\d+)$/u.exec(normalized);
  const fraction = /^(\d+)\/(\d+)$/u.exec(normalized);
  let value: number;
  if (mixed) {
    const denominator = Number(mixed[3]);
    if (denominator === 0) fail(`invalid rate fraction ${token}.`);
    value = Number(mixed[1]) + Number(mixed[2]) / denominator;
  } else if (fraction) {
    const denominator = Number(fraction[2]);
    if (denominator === 0) fail(`invalid rate fraction ${token}.`);
    value = Number(fraction[1]) / denominator;
  } else if (/^\d+(?:\.\d+)?$/u.test(normalized)) {
    value = Number(normalized);
  } else {
    return fail(`malformed target-rate token ${token}.`);
  }
  if (!Number.isFinite(value) || value < 0 || value > 100) fail(`impossible target-rate value ${token}.`);
  return value;
}

const RATE_TOKEN = "(\\d+(?:\\.\\d+)?(?:-\\d+\\/\\d+)?|\\d+\\/\\d+)";

function parseStatementDecision(text: string): {
  action: FomcPolicyAction;
  targetLower: number;
  targetUpper: number;
} {
  const sentences = text.match(/The Committee decided to [^.]*target range for the federal funds rate[^.]*\./giu) ?? [];
  if (sentences.length !== 1) fail("statement must contain exactly one unambiguous Committee target-range decision.");
  const sentence = sentences[0];
  const actionMatch = /The Committee decided to\s+(keep|maintain|raise|lower)\b/iu.exec(sentence);
  if (!actionMatch) fail("unsupported or ambiguous target-range action.");
  const actionWord = actionMatch[1].toLowerCase();
  const action: FomcPolicyAction = actionWord === "raise" ? "RAISE" : actionWord === "lower" ? "LOWER" : "MAINTAIN";
  const rangeMatch = new RegExp(`(?:at|to)\\s+${RATE_TOKEN}\\s+to\\s+${RATE_TOKEN}\\s+percent`, "iu").exec(sentence);
  if (!rangeMatch) fail("statement target range is missing or malformed.");
  const targetLower = parseRateToken(rangeMatch[1]);
  const targetUpper = parseRateToken(rangeMatch[2]);
  if (targetLower > targetUpper) fail("target lower bound exceeds target upper bound.");
  return { action, targetLower, targetUpper };
}

function parseImplementation(text: string): { effectiveDate: string; targetLower: number; targetUpper: number } {
  const effectiveMatches = [...text.matchAll(/Effective\s+([A-Z][a-z]+)\s+(\d{1,2}),\s+(\d{4}),\s+the Federal Open Market Committee directs/gu)];
  const effectiveDates = new Set(effectiveMatches.map((match) => {
    const month = MONTHS[match[1]];
    if (!month) fail(`unsupported effective-date month ${match[1]}.`);
    return `${match[3]}-${String(month).padStart(2, "0")}-${String(Number(match[2])).padStart(2, "0")}`;
  }));
  if (effectiveDates.size !== 1) fail("implementation note has missing or conflicting effective dates.");
  const effectiveDate = requireDate([...effectiveDates][0], "effectiveDate");
  const rangePattern = new RegExp(`maintain the federal funds rate in a target range of\\s+${RATE_TOKEN}\\s+to\\s+${RATE_TOKEN}\\s+percent`, "giu");
  const ranges = [...text.matchAll(rangePattern)].map((match) => `${match[1]}|${match[2]}`);
  if (new Set(ranges).size !== 1) fail("implementation note has missing or conflicting target ranges.");
  const [lowerToken, upperToken] = ranges[0].split("|");
  const targetLower = parseRateToken(lowerToken);
  const targetUpper = parseRateToken(upperToken);
  if (targetLower > targetUpper) fail("implementation target lower bound exceeds target upper bound.");
  return { effectiveDate, targetLower, targetUpper };
}

function makeArtifact(
  sourceUrl: string,
  bytes: Uint8Array,
  retrievedAt: string,
  eventDate: string,
  kind: "STATEMENT" | "IMPLEMENTATION_NOTE"
): VerifiedRawArtifact {
  return verifyRawArtifact({
    provider: "FEDERAL_RESERVE_BOARD",
    seriesId: kind === "STATEMENT" ? "FOMC_RATE_DECISION" : "US_FED_FUNDS_TARGET_UPPER",
    instrument: kind,
    archiveUrl: sourceUrl,
    providerChecksumPolicy: "NOT_PUBLISHED",
    checksumUrl: null,
    partition: `${eventDate}-${kind.toLowerCase()}`,
    retrievedAt,
    rawBytes: bytes,
    parserVersion: FOMC_POLICY_PARSER_VERSION,
    licensingClassification: "FEDERAL_RESERVE_PUBLIC_OFFICIAL_RELEASE",
  });
}

function validateExpectedDates(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values) || values.length === 0) fail("expectedEventDates must contain at least one event date.");
  const normalized = values.map((value) => requireDate(value, "expectedEventDate"));
  if (new Set(normalized).size !== normalized.length) fail("expectedEventDates contains a duplicate.");
  for (const date of normalized) {
    if (!FOMC_SUPPORTED_EVENT_DATES.includes(date as typeof FOMC_SUPPORTED_EVENT_DATES[number])) {
      fail(`unsupported or non-calendar event date ${date}; exceptional/intermeeting events require a new explicit regime.`);
    }
  }
  return Object.freeze([...normalized].sort());
}

function endOfLocalCalendarDate(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
  return marketDateTimeToEpochMs(next, "00:00", FOMC_POLICY_TIME_ZONE) - 1;
}

function makeManifest(
  seriesId: "FOMC_RATE_DECISION" | "US_FED_FUNDS_TARGET_UPPER",
  records: readonly (HistoricalEventRecord | HistoricalMacroRelease)[],
  missingCount: number,
  coverageMethod: string,
  provenance: string,
  normalizedContentHash: string
): ResearchSeriesManifestEntry {
  if (records.length === 0) fail(`${seriesId} produced no eligible records.`);
  const observationTimes = records.map((record) => record.observationTime);
  const availableTimes = records.map((record) => record.availableAt);
  const isEvent = seriesId === "FOMC_RATE_DECISION";
  return Object.freeze({
    seriesId,
    kind: isEvent ? "OFFICIAL_EVENT" : "MACRO_RELEASE",
    provider: "FEDERAL_RESERVE_BOARD",
    providerInstrument: isEvent ? "OFFICIAL_FOMC_POLICY_STATEMENT" : "OFFICIAL_FOMC_IMPLEMENTATION_DIRECTIVE_TARGET_UPPER",
    cadence: "EVENT_DRIVEN",
    unit: "PERCENT",
    firstObservationTime: Math.min(...observationTimes),
    lastObservationTime: Math.max(...observationTimes),
    firstAvailableAt: Math.min(...availableTimes),
    lastAvailableAt: Math.max(...availableTimes),
    recordCount: records.length,
    missingness: Object.freeze({ missingCount, method: coverageMethod }),
    revisionSemantics: isEvent ? "NOT_APPLICABLE" : "INITIAL_ONLY",
    timezoneSessionRule:
      "Official statement release wall-clock converted in America/New_York with historical EST/EDT; effective date represented at local date start",
    availabilityRule: isEvent
      ? "availableAt equals the statement's explicit public 'For release at' boundary"
      : "availableAt is max(public statement release, local start of the implementation note's effective date), preventing announced future policy state from becoming operational early",
    provenance,
    contentHash: normalizedContentHash,
  });
}

export function processFomcPolicyHistory(input: ProcessFomcPolicyHistoryInput): FomcPolicyHistoryResult {
  if (!Array.isArray(input.artifacts) || input.artifacts.length === 0) fail("artifacts must contain at least one statement/note pair.");
  if (!Number.isFinite(input.releasedThroughMs) || input.releasedThroughMs < 0) {
    fail("releasedThroughMs must be a non-negative finite timestamp.");
  }
  const expectedDates = validateExpectedDates(input.expectedEventDates ?? FOMC_SUPPORTED_EVENT_DATES);
  const sortedInputs = [...input.artifacts].sort((left, right) => left.statementUrl.localeCompare(right.statementUrl));
  const artifacts: VerifiedRawArtifact[] = [];
  const parsed: Array<Omit<FomcPolicyDecisionEvidence, "changeAmount">> = [];
  const seenEventDates = new Set<string>();
  const seenUrls = new Set<string>();

  for (const source of sortedInputs) {
    const statementDate = dateFromUrl(source.statementUrl, "a");
    const noteDate = dateFromUrl(source.implementationNoteUrl, "a1");
    if (statementDate !== noteDate) fail(`statement/note date conflict: ${statementDate} versus ${noteDate}.`);
    if (!expectedDates.includes(statementDate)) fail(`event ${statementDate} is outside the declared expected-event contract.`);
    if (seenEventDates.has(statementDate)) fail(`duplicate official event identity ${statementDate}.`);
    if (seenUrls.has(source.statementUrl) || seenUrls.has(source.implementationNoteUrl)) fail("duplicate source artifact URL.");
    seenEventDates.add(statementDate);
    seenUrls.add(source.statementUrl);
    seenUrls.add(source.implementationNoteUrl);

    const statementText = visibleText(decodeHtml(source.statementBytes));
    const noteText = visibleText(decodeHtml(source.implementationNoteBytes));
    assertNoUnsupportedCorrection(statementText);
    assertNoUnsupportedCorrection(noteText);
    assertVisibleReleaseDate(statementText, statementDate);
    assertVisibleReleaseDate(noteText, noteDate);
    const release = parseReleaseBoundary(statementText, statementDate);
    const decision = parseStatementDecision(statementText);
    const implementation = parseImplementation(noteText);
    if (decision.targetLower !== implementation.targetLower || decision.targetUpper !== implementation.targetUpper) {
      fail(`statement/implementation target-range conflict for ${statementDate}.`);
    }
    const effectiveAt = marketDateTimeToEpochMs(implementation.effectiveDate, "00:00", FOMC_POLICY_TIME_ZONE);
    const statementArtifact = makeArtifact(source.statementUrl, source.statementBytes, source.retrievedAt, statementDate, "STATEMENT");
    const implementationArtifact = makeArtifact(
      source.implementationNoteUrl,
      source.implementationNoteBytes,
      source.retrievedAt,
      statementDate,
      "IMPLEMENTATION_NOTE"
    );
    artifacts.push(statementArtifact, implementationArtifact);
    parsed.push(Object.freeze({
      eventId: `FED-FOMC-${statementDate.replaceAll("-", "")}`,
      eventDate: statementDate,
      releaseDate: statementDate,
      releaseTime: release.releaseTime,
      releaseZone: release.releaseZone,
      availableAt: release.availableAt,
      effectiveDate: implementation.effectiveDate,
      effectiveAt,
      effectiveTimeBasis: "START_OF_EFFECTIVE_DATE_AMERICA_NEW_YORK",
      targetLower: decision.targetLower,
      targetUpper: decision.targetUpper,
      action: decision.action,
      statementUrl: source.statementUrl,
      implementationNoteUrl: source.implementationNoteUrl,
      statementArtifactId: statementArtifact.artifactId,
      implementationArtifactId: implementationArtifact.artifactId,
    }));
  }

  parsed.sort((left, right) => left.availableAt - right.availableAt || left.eventId.localeCompare(right.eventId));
  const evidence: FomcPolicyDecisionEvidence[] = [];
  let previousUpper: number | null = null;
  let previousEventDate: string | null = null;
  for (const item of parsed) {
    const previousIndex = previousEventDate === null
      ? -1
      : FOMC_SUPPORTED_EVENT_DATES.indexOf(previousEventDate as typeof FOMC_SUPPORTED_EVENT_DATES[number]);
    const currentIndex = FOMC_SUPPORTED_EVENT_DATES.indexOf(item.eventDate as typeof FOMC_SUPPORTED_EVENT_DATES[number]);
    const hasConsecutivePredecessor = previousUpper !== null && previousIndex >= 0 && currentIndex === previousIndex + 1;
    if (hasConsecutivePredecessor) {
      const priorUpper = previousUpper as number;
      if (item.action === "MAINTAIN" && item.targetUpper !== priorUpper) fail(`${item.eventId} says maintain but changes target upper.`);
      if (item.action === "RAISE" && item.targetUpper <= priorUpper) fail(`${item.eventId} says raise without an upward target transition.`);
      if (item.action === "LOWER" && item.targetUpper >= priorUpper) fail(`${item.eventId} says lower without a downward target transition.`);
    }
    evidence.push(Object.freeze({
      ...item,
      changeAmount: hasConsecutivePredecessor ? Math.abs(item.targetUpper - (previousUpper as number)) : null,
    }));
    previousUpper = item.targetUpper;
    previousEventDate = item.eventDate;
  }

  const publicEvidence = Object.freeze(
    evidence.filter((item) => item.availableAt <= input.releasedThroughMs)
  );
  const publicArtifactIds = new Set(
    publicEvidence.flatMap((item) => [item.statementArtifactId, item.implementationArtifactId])
  );
  const publicArtifacts = Object.freeze(
    artifacts.filter((artifact) => publicArtifactIds.has(artifact.artifactId))
  );

  const eventRecords: HistoricalEventRecord[] = [];
  const macroReleases: HistoricalMacroRelease[] = [];
  let previousEligibleUpper: number | null = null;
  for (const item of publicEvidence) {
    const observationTime = sessionDateToUtcMidnightEpochMs(item.eventDate);
    const event: HistoricalEventRecord = Object.freeze({
      eventId: item.eventId,
      eventType: "FED_RATE_DECISION",
      observationTime,
      publishedAt: item.availableAt,
      availableAt: item.availableAt,
      actual: item.targetUpper,
      consensus: null,
      consensusFrozenAt: null,
      previous: item.changeAmount === null ? null : previousEligibleUpper,
      surprise: null,
      provider: "FEDERAL_RESERVE",
      sourceQuality: "TIER_1_OFFICIAL",
    });
    validateHistoricalEvent(event);
    eventRecords.push(event);
    previousEligibleUpper = item.targetUpper;

    const targetStateAvailableAt = Math.max(item.availableAt, item.effectiveAt);
    if (targetStateAvailableAt > input.releasedThroughMs) continue;
    const macro: HistoricalMacroRelease = Object.freeze({
      seriesId: "US_FED_FUNDS_TARGET_UPPER",
      observationTime,
      publishedAt: item.availableAt,
      availableAt: targetStateAvailableAt,
      vintageDate: item.releaseDate,
      revisionIndex: 0,
      value: item.targetUpper,
      provider: "FEDERAL_RESERVE",
      unit: "PERCENT",
    });
    validateHistoricalMacroRelease(macro);
    macroReleases.push(macro);
  }
  if (eventRecords.length === 0) fail("no statements were public by releasedThroughMs.");

  const acceptedDates = new Set(eventRecords.map((record) => new Date(record.observationTime).toISOString().slice(0, 10)));
  const eligibleExpectedDates = expectedDates.filter(
    (date) => endOfLocalCalendarDate(date) <= input.releasedThroughMs
  );
  const missingEventDates = eligibleExpectedDates.filter((date) => !acceptedDates.has(date));
  const normalizedRows = publicEvidence.map((item) => ({
      eventId: item.eventId,
      eventDate: item.eventDate,
      releaseDate: item.releaseDate,
      releaseTime: item.releaseTime,
      releaseZone: item.releaseZone,
      availableAt: item.availableAt,
      effectiveDate: item.effectiveDate,
      effectiveAt: item.effectiveAt,
      targetLower: item.targetLower,
      targetUpper: item.targetUpper,
      action: item.action,
      changeAmount: item.changeAmount,
      statementUrl: item.statementUrl,
      implementationNoteUrl: item.implementationNoteUrl,
      targetStateIncluded: Math.max(item.availableAt, item.effectiveAt) <= input.releasedThroughMs,
    }));
  const normalizedContentHash = `sha256:${sha256Hex(canonicalJson({
    contract: FOMC_POLICY_PARSER_VERSION,
    rows: normalizedRows,
  }))}`;
  const coverageMethod =
    "Expected event denominator is the explicit official FOMC calendar/annual-policy-statement date set within the declared bounded regime; weekends, days, and months are not denominators; any exceptional/intermeeting event requires an explicit added source regime";
  const coverage: FomcPolicyCoverage = Object.freeze({
    firstEventDate: publicEvidence[0].eventDate,
    lastEventDate: publicEvidence.at(-1)?.eventDate ?? publicEvidence[0].eventDate,
    firstAvailableAt: Math.min(...eventRecords.map((record) => record.availableAt)),
    lastAvailableAt: Math.max(...eventRecords.map((record) => record.availableAt)),
    eventCount: eventRecords.length,
    targetUpperCount: macroReleases.length,
    missingCount: missingEventDates.length,
    missingEventDates: Object.freeze(missingEventDates),
    method: coverageMethod,
    supportedRegime: `${FOMC_POLICY_SUPPORTED_START} through ${FOMC_POLICY_SUPPORTED_END}; regular official policy statements paired with same-date implementation notes`,
    exceptionalEventPolicy:
      "Official annual FOMC release indexes show no emergency/intermeeting target decision in the supported window; an unexpected identity fails closed and cannot be silently omitted",
  });
  const provenance = canonicalJson({
    parserVersion: FOMC_POLICY_PARSER_VERSION,
    sourceContractUrls: FOMC_POLICY_SOURCE_CONTRACT_URLS,
    providerChecksumPolicy: "NOT_PUBLISHED",
    artifacts: publicArtifacts.map((artifact) => ({
      artifactId: artifact.artifactId,
      sourceUrl: artifact.request.url,
      rawSha256: artifact.rawSha256,
      providerChecksum: artifact.providerChecksum,
    })).sort((left, right) => left.sourceUrl.localeCompare(right.sourceUrl)),
    releaseTimeRule: "Explicit statement 'For release at' EST/EDT witness only",
    effectiveTimeRule:
      "Implementation directive effective date represented at 00:00 America/New_York as the start of the named effective date; no provider clock-time claim",
  });
  const manifests: ResearchSeriesManifestEntry[] = [
    makeManifest("FOMC_RATE_DECISION", eventRecords, missingEventDates.length, coverageMethod, provenance, normalizedContentHash),
  ];
  if (macroReleases.length > 0) {
    manifests.push(
      makeManifest("US_FED_FUNDS_TARGET_UPPER", macroReleases, missingEventDates.length, coverageMethod, provenance, normalizedContentHash)
    );
  }
  return Object.freeze({
    artifacts: publicArtifacts,
    eventRecords: Object.freeze(eventRecords),
    macroReleases: Object.freeze(macroReleases),
    decisionEvidence: publicEvidence,
    normalizedContentHash,
    coverage,
    manifestEntries: Object.freeze(manifests),
    intendedUse: "RESEARCH_ONLY",
    priceAuthority: "RESEARCH_CONTEXT_ONLY",
  });
}

export function createFomcPolicyUrls(eventDate: string): { statementUrl: string; implementationNoteUrl: string } {
  const date = requireDate(eventDate, "eventDate");
  if (!FOMC_SUPPORTED_EVENT_DATES.includes(date as typeof FOMC_SUPPORTED_EVENT_DATES[number])) {
    fail(`unsupported or non-calendar event date ${date}.`);
  }
  const compact = date.replaceAll("-", "");
  const root = "https://www.federalreserve.gov/newsevents/pressreleases";
  return Object.freeze({
    statementUrl: `${root}/monetary${compact}a.htm`,
    implementationNoteUrl: `${root}/monetary${compact}a1.htm`,
  });
}

export async function acquireFomcPolicyHistory(
  input: AcquireFomcPolicyHistoryInput,
  transport: FomcPolicyTransport = { fetchBinary }
): Promise<FomcPolicyHistoryResult> {
  const eventDates = validateExpectedDates(input.eventDates);
  const artifacts = await Promise.all(eventDates.map(async (eventDate) => {
    const urls = createFomcPolicyUrls(eventDate);
    const [statementBytes, implementationNoteBytes] = await Promise.all([
      transport.fetchBinary(urls.statementUrl),
      transport.fetchBinary(urls.implementationNoteUrl),
    ]);
    return {
      ...urls,
      statementBytes,
      implementationNoteBytes,
      retrievedAt: input.retrievedAt,
    };
  }));
  return processFomcPolicyHistory({
    artifacts,
    releasedThroughMs: input.releasedThroughMs,
    expectedEventDates: eventDates,
  });
}
