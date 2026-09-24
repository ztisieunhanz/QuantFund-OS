import { inflateRawSync } from "node:zlib";
import type { HistoricalMarketObservation } from "../historicalPit";
import { validateHistoricalMarketObservation } from "../historicalPit";
import type { ResearchSeriesManifestEntry } from "../researchDataProtocol";
import {
  HistoricalAcquisitionError,
  canonicalJson,
  fetchBinary,
  fetchText,
  sha256Hex,
  verifyRawArtifact,
  type BinaryFetcher,
  type VerifiedRawArtifact,
} from "./immutableAcquisition";

export const BINANCE_ARCHIVE_PARSER_VERSION = "M13B2-BINANCE-1H-V1";
export const BINANCE_PUBLIC_DATA_ROOT = "https://data.binance.vision/data/spot/monthly/klines";
export const BINANCE_ONE_HOUR_MS = 3_600_000;

export type BinanceResearchSeriesId = "BTC" | "PAXG";
export type BinanceArchiveTimestampUnit = "MILLISECONDS" | "MICROSECONDS";

const BINANCE_INSTRUMENTS: Readonly<Record<BinanceResearchSeriesId, string>> = Object.freeze({
  BTC: "BTCUSDT",
  PAXG: "PAXGUSDT",
});

export interface BinanceMonthlyArchiveIdentity {
  readonly seriesId: BinanceResearchSeriesId;
  readonly instrument: string;
  readonly interval: "1h";
  readonly partition: string;
  readonly fileName: string;
  readonly archiveUrl: string;
  readonly checksumUrl: string;
  readonly timestampUnit: BinanceArchiveTimestampUnit;
  readonly partitionStartMs: number;
  readonly partitionEndMs: number;
}

export interface BinanceArchiveCoverage {
  readonly firstAcceptedObservationTime: number;
  readonly lastAcceptedObservationTime: number;
  readonly finalEligibleObservationTime: number;
  readonly expectedSlotCount: number;
  readonly acceptedSlotCount: number;
  readonly missingCount: number;
  readonly missingObservationTimes: readonly number[];
  readonly method: string;
}

export interface BinanceMonthlyArchiveResult {
  readonly artifact: VerifiedRawArtifact;
  readonly normalizedContentHash: string;
  readonly observations: readonly HistoricalMarketObservation[];
  readonly coverage: BinanceArchiveCoverage;
  readonly manifestEntry: ResearchSeriesManifestEntry;
  readonly intendedUse: "RESEARCH_ONLY";
  readonly priceAuthority: "RESEARCH_CONTEXT_ONLY";
}

export interface ProcessBinanceMonthlyArchiveInput {
  readonly seriesId: BinanceResearchSeriesId;
  readonly partition: string;
  readonly zipBytes: Uint8Array;
  readonly checksumText: string;
  readonly retrievedAt: string;
  readonly closedThroughMs: number;
}

export interface BinanceArchiveTransport {
  readonly fetchBinary: BinaryFetcher;
  readonly fetchText: (url: string) => Promise<string>;
}

function fail(message: string): never {
  throw new HistoricalAcquisitionError(`Binance archive: ${message}`);
}

function readUInt16(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.byteLength) fail("truncated ZIP uint16 field.");
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUInt32(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.byteLength) fail("truncated ZIP uint32 field.");
  return (
    bytes[offset] +
    bytes[offset + 1] * 0x100 +
    bytes[offset + 2] * 0x10000 +
    bytes[offset + 3] * 0x1000000
  ) >>> 0;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail(`${label} is not valid UTF-8.`);
  }
}

export function extractSingleZipEntry(zipBytes: Uint8Array, expectedFileName: string): Uint8Array {
  if (!(zipBytes instanceof Uint8Array) || zipBytes.byteLength < 22) fail("ZIP artifact is empty or truncated.");
  const minimumEocdOffset = Math.max(0, zipBytes.byteLength - 65_557);
  let eocdOffset = -1;
  for (let offset = zipBytes.byteLength - 22; offset >= minimumEocdOffset; offset--) {
    if (readUInt32(zipBytes, offset) === 0x06054b50) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) fail("ZIP end-of-central-directory record is missing.");

  const diskNumber = readUInt16(zipBytes, eocdOffset + 4);
  const centralDirectoryDisk = readUInt16(zipBytes, eocdOffset + 6);
  const entriesOnDisk = readUInt16(zipBytes, eocdOffset + 8);
  const totalEntries = readUInt16(zipBytes, eocdOffset + 10);
  const centralDirectorySize = readUInt32(zipBytes, eocdOffset + 12);
  const centralDirectoryOffset = readUInt32(zipBytes, eocdOffset + 16);
  if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== 1 || totalEntries !== 1) {
    fail("ZIP must be a single-disk archive containing exactly one file.");
  }
  if (centralDirectoryOffset + centralDirectorySize > eocdOffset) {
    fail("ZIP central directory bounds are invalid.");
  }
  if (readUInt32(zipBytes, centralDirectoryOffset) !== 0x02014b50) {
    fail("ZIP central-directory file header is missing.");
  }

  const flags = readUInt16(zipBytes, centralDirectoryOffset + 8);
  const method = readUInt16(zipBytes, centralDirectoryOffset + 10);
  const expectedCrc = readUInt32(zipBytes, centralDirectoryOffset + 16);
  const compressedSize = readUInt32(zipBytes, centralDirectoryOffset + 20);
  const uncompressedSize = readUInt32(zipBytes, centralDirectoryOffset + 24);
  const fileNameLength = readUInt16(zipBytes, centralDirectoryOffset + 28);
  const extraLength = readUInt16(zipBytes, centralDirectoryOffset + 30);
  const commentLength = readUInt16(zipBytes, centralDirectoryOffset + 32);
  const localHeaderOffset = readUInt32(zipBytes, centralDirectoryOffset + 42);
  if ((flags & 0x1) !== 0) fail("encrypted ZIP entries are unsupported.");
  if (method !== 0 && method !== 8) fail(`ZIP compression method ${method} is unsupported.`);
  const centralEntryEnd = centralDirectoryOffset + 46 + fileNameLength + extraLength + commentLength;
  if (centralEntryEnd > centralDirectoryOffset + centralDirectorySize) fail("ZIP central entry is truncated.");
  const fileName = decodeUtf8(
    zipBytes.subarray(centralDirectoryOffset + 46, centralDirectoryOffset + 46 + fileNameLength),
    "ZIP filename"
  );
  if (fileName !== expectedFileName) {
    fail(`ZIP contains "${fileName}", expected "${expectedFileName}".`);
  }

  if (readUInt32(zipBytes, localHeaderOffset) !== 0x04034b50) fail("ZIP local file header is missing.");
  if (readUInt16(zipBytes, localHeaderOffset + 8) !== method) fail("ZIP method differs between headers.");
  const localFileNameLength = readUInt16(zipBytes, localHeaderOffset + 26);
  const localExtraLength = readUInt16(zipBytes, localHeaderOffset + 28);
  const localFileName = decodeUtf8(
    zipBytes.subarray(localHeaderOffset + 30, localHeaderOffset + 30 + localFileNameLength),
    "ZIP local filename"
  );
  if (localFileName !== expectedFileName) fail("ZIP local and central filenames disagree.");
  const dataStart = localHeaderOffset + 30 + localFileNameLength + localExtraLength;
  const dataEnd = dataStart + compressedSize;
  if (dataEnd > zipBytes.byteLength) fail("ZIP compressed data is truncated.");
  const compressed = zipBytes.subarray(dataStart, dataEnd);
  let uncompressed: Uint8Array;
  try {
    uncompressed = method === 0 ? new Uint8Array(compressed) : new Uint8Array(inflateRawSync(compressed));
  } catch {
    return fail("ZIP deflate stream is invalid.");
  }
  if (uncompressed.byteLength !== uncompressedSize) fail("ZIP uncompressed size does not match metadata.");
  if (crc32(uncompressed) !== expectedCrc) fail("ZIP CRC-32 verification failed.");
  return uncompressed;
}

function parsePartition(partition: string): { startMs: number; endMs: number } {
  const match = /^(\d{4})-(\d{2})$/u.exec(partition);
  if (!match) fail(`partition "${partition}" must use YYYY-MM.`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (year < 2010 || month < 1 || month > 12) fail(`partition "${partition}" is out of range.`);
  return {
    startMs: Date.UTC(year, month - 1, 1),
    endMs: Date.UTC(year, month, 1),
  };
}

export function timestampUnitForBinancePartition(partition: string): BinanceArchiveTimestampUnit {
  parsePartition(partition);
  return partition >= "2025-01" ? "MICROSECONDS" : "MILLISECONDS";
}

export function createBinanceMonthlyArchiveIdentity(
  seriesId: BinanceResearchSeriesId,
  partition: string,
  interval: string = "1h"
): BinanceMonthlyArchiveIdentity {
  if (interval !== "1h") fail(`unsupported interval "${interval}"; only 1h is approved.`);
  const instrument = BINANCE_INSTRUMENTS[seriesId];
  if (!instrument) fail(`unsupported research series "${String(seriesId)}".`);
  const { startMs, endMs } = parsePartition(partition);
  const fileName = `${instrument}-1h-${partition}.zip`;
  const archiveUrl = `${BINANCE_PUBLIC_DATA_ROOT}/${instrument}/1h/${fileName}`;
  return Object.freeze({
    seriesId,
    instrument,
    interval: "1h",
    partition,
    fileName,
    archiveUrl,
    checksumUrl: `${archiveUrl}.CHECKSUM`,
    timestampUnit: timestampUnitForBinancePartition(partition),
    partitionStartMs: startMs,
    partitionEndMs: endMs,
  });
}

function parseRawTimestamp(value: string, field: string): bigint {
  if (!/^(0|[1-9]\d*)$/u.test(value)) fail(`${field} must be an unsigned decimal integer.`);
  try {
    return BigInt(value);
  } catch {
    return fail(`${field} cannot be represented as an integer.`);
  }
}

export function normalizeBinanceArchiveTimestamp(
  rawValue: string,
  unit: BinanceArchiveTimestampUnit,
  field: string
): number {
  const raw = parseRawTimestamp(rawValue, field);
  const divisor = unit === "MICROSECONDS" ? 1000n : 1n;
  const normalized = raw / divisor;
  if (normalized > BigInt(Number.MAX_SAFE_INTEGER)) fail(`${field} is outside the supported epoch range.`);
  const result = Number(normalized);
  if (!Number.isSafeInteger(result) || result < 0) fail(`${field} is outside the supported epoch range.`);
  return result;
}

function parseFiniteDecimal(value: string, field: string): number {
  if (value.trim().length === 0) fail(`${field} is empty.`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) fail(`${field} is non-finite.`);
  return parsed;
}

function parseCsvRows(csvText: string): readonly string[][] {
  if (csvText.includes("\u0000")) fail("CSV contains a NUL byte.");
  const rows = csvText.split(/\r?\n/u).filter((line) => line.length > 0).map((line, index) => {
    if (line.includes('"')) fail(`CSV row ${index + 1} contains unsupported quoting.`);
    const fields = line.split(",");
    if (fields.length !== 12) fail(`CSV row ${index + 1} has ${fields.length} fields; expected 12.`);
    return fields;
  });
  if (rows.length === 0) fail("CSV contains no kline rows.");
  return rows;
}

function parseBinanceCsv(
  csvText: string,
  identity: BinanceMonthlyArchiveIdentity,
  closedThroughMs: number
): readonly HistoricalMarketObservation[] {
  if (!Number.isSafeInteger(closedThroughMs) || closedThroughMs < 0) {
    fail("closedThroughMs must be a non-negative safe-integer epoch millisecond.");
  }
  const scale = identity.timestampUnit === "MICROSECONDS" ? 1000n : 1n;
  const seen = new Map<number, HistoricalMarketObservation>();
  const observations: HistoricalMarketObservation[] = [];

  for (const [index, fields] of parseCsvRows(csvText).entries()) {
    const rowNumber = index + 1;
    const rawOpen = parseRawTimestamp(fields[0], `row ${rowNumber} openTime`);
    const rawClose = parseRawTimestamp(fields[6], `row ${rowNumber} closeTime`);
    if (rawOpen % scale !== 0n) {
      fail(`row ${rowNumber} openTime loses sub-millisecond precision during normalization.`);
    }
    const openTime = normalizeBinanceArchiveTimestamp(fields[0], identity.timestampUnit, `row ${rowNumber} openTime`);
    const closeTime = normalizeBinanceArchiveTimestamp(fields[6], identity.timestampUnit, `row ${rowNumber} closeTime`);
    if (openTime < identity.partitionStartMs || openTime >= identity.partitionEndMs) {
      fail(`row ${rowNumber} openTime is incompatible with the predeclared ${identity.timestampUnit} partition contract.`);
    }
    if (openTime % BINANCE_ONE_HOUR_MS !== 0) fail(`row ${rowNumber} openTime is not on the UTC 1H grid.`);
    const expectedRawClose = rawOpen + BigInt(BINANCE_ONE_HOUR_MS) * scale - 1n;
    if (rawClose !== expectedRawClose) fail(`row ${rowNumber} closeTime does not match the 1H interval boundary.`);
    if (closeTime !== openTime + BINANCE_ONE_HOUR_MS - 1) {
      fail(`row ${rowNumber} normalized closeTime is inconsistent with openTime.`);
    }

    const open = parseFiniteDecimal(fields[1], `row ${rowNumber} open`);
    const high = parseFiniteDecimal(fields[2], `row ${rowNumber} high`);
    const low = parseFiniteDecimal(fields[3], `row ${rowNumber} low`);
    const close = parseFiniteDecimal(fields[4], `row ${rowNumber} close`);
    const volume = parseFiniteDecimal(fields[5], `row ${rowNumber} volume`);
    const quoteVolume = parseFiniteDecimal(fields[7], `row ${rowNumber} quoteVolume`);
    const tradeCount = parseFiniteDecimal(fields[8], `row ${rowNumber} tradeCount`);
    const takerBaseVolume = parseFiniteDecimal(fields[9], `row ${rowNumber} takerBaseVolume`);
    const takerQuoteVolume = parseFiniteDecimal(fields[10], `row ${rowNumber} takerQuoteVolume`);
    if (open <= 0 || high <= 0 || low <= 0 || close <= 0) fail(`row ${rowNumber} OHLC prices must be positive.`);
    if (volume < 0 || quoteVolume < 0 || takerBaseVolume < 0 || takerQuoteVolume < 0) {
      fail(`row ${rowNumber} volumes must be non-negative.`);
    }
    if (!Number.isInteger(tradeCount) || tradeCount < 0) fail(`row ${rowNumber} tradeCount must be a non-negative integer.`);
    if (high < Math.max(open, low, close) || low > Math.min(open, high, close)) {
      fail(`row ${rowNumber} has impossible OHLC ordering.`);
    }
    const availableAt = openTime + BINANCE_ONE_HOUR_MS;
    if (availableAt > closedThroughMs) fail(`row ${rowNumber} is an incomplete/open candle at the acquisition boundary.`);

    const observation: HistoricalMarketObservation = Object.freeze({
      seriesId: identity.seriesId,
      value: close,
      observationTime: openTime,
      availableAt,
      providerTimestamp: closeTime,
      provider: "BINANCE_PUBLIC_DATA",
      unit: "USDT",
    });
    validateHistoricalMarketObservation(observation);
    const prior = seen.get(openTime);
    if (prior) {
      const duplicateKind = canonicalJson(prior) === canonicalJson(observation) ? "duplicate" : "conflicting duplicate";
      fail(`${duplicateKind} UTC 1H slot ${openTime}.`);
    }
    seen.set(openTime, observation);
    observations.push(observation);
  }
  return Object.freeze(observations.sort((left, right) => left.observationTime - right.observationTime));
}

function buildCoverage(
  observations: readonly HistoricalMarketObservation[],
  identity: BinanceMonthlyArchiveIdentity,
  closedThroughMs: number
): BinanceArchiveCoverage {
  const first = observations[0]?.observationTime;
  const last = observations.at(-1)?.observationTime;
  if (first === undefined || last === undefined) fail("no accepted observations remain after validation.");
  const latestClosedOpen = Math.floor((closedThroughMs - BINANCE_ONE_HOUR_MS) / BINANCE_ONE_HOUR_MS) * BINANCE_ONE_HOUR_MS;
  const finalEligible = Math.min(identity.partitionEndMs - BINANCE_ONE_HOUR_MS, latestClosedOpen);
  if (finalEligible < first) fail("acquisition boundary precedes the first accepted closed candle.");
  const accepted = new Set(observations.map((observation) => observation.observationTime));
  const missing: number[] = [];
  for (let timestamp = first; timestamp <= finalEligible; timestamp += BINANCE_ONE_HOUR_MS) {
    if (!accepted.has(timestamp)) missing.push(timestamp);
  }
  return Object.freeze({
    firstAcceptedObservationTime: first,
    lastAcceptedObservationTime: last,
    finalEligibleObservationTime: finalEligible,
    expectedSlotCount: (finalEligible - first) / BINANCE_ONE_HOUR_MS + 1,
    acceptedSlotCount: observations.length,
    missingCount: missing.length,
    missingObservationTimes: Object.freeze(missing),
    method: "24/7 UTC hourly slots from first accepted record through final closed eligible partition slot; pre-listing time excluded",
  });
}

export function processBinanceMonthlyArchive(
  input: ProcessBinanceMonthlyArchiveInput
): BinanceMonthlyArchiveResult {
  const identity = createBinanceMonthlyArchiveIdentity(input.seriesId, input.partition);
  const artifact = verifyRawArtifact({
    provider: "BINANCE_PUBLIC_DATA",
    sourceArtifactType: "BINANCE_SPOT_MONTHLY_KLINES_1H",
    instrument: identity.instrument,
    archiveUrl: identity.archiveUrl,
    providerChecksumPolicy: "REQUIRED",
    checksumUrl: identity.checksumUrl,
    partition: identity.partition,
    retrievedAt: input.retrievedAt,
    expectedFileName: identity.fileName,
    checksumText: input.checksumText,
    rawBytes: input.zipBytes,
    parserVersion: BINANCE_ARCHIVE_PARSER_VERSION,
    licensingClassification: "BINANCE_PUBLIC_DATA_TERMS_APPLY",
  });
  const csvBytes = extractSingleZipEntry(input.zipBytes, identity.fileName.replace(/\.zip$/u, ".csv"));
  const observations = parseBinanceCsv(decodeUtf8(csvBytes, "Binance CSV"), identity, input.closedThroughMs);
  const coverage = buildCoverage(observations, identity, input.closedThroughMs);
  const normalizedContentHash = `sha256:${sha256Hex(canonicalJson({
    contract: BINANCE_ARCHIVE_PARSER_VERSION,
    seriesId: identity.seriesId,
    instrument: identity.instrument,
    interval: identity.interval,
    observations,
  }))}`;
  const first = observations[0];
  const last = observations.at(-1);
  if (!first || !last) fail("archive produced no observations.");
  const manifestEntry: ResearchSeriesManifestEntry = Object.freeze({
    seriesId: identity.seriesId,
    kind: "MARKET_FACTOR",
    provider: "BINANCE_PUBLIC_DATA",
    providerInstrument: identity.instrument,
    cadence: "1H",
    unit: "USDT",
    firstObservationTime: first.observationTime,
    lastObservationTime: last.observationTime,
    firstAvailableAt: first.availableAt,
    lastAvailableAt: last.availableAt,
    recordCount: observations.length,
    missingness: Object.freeze({ missingCount: coverage.missingCount, method: coverage.method }),
    revisionSemantics: "NOT_APPLICABLE",
    timezoneSessionRule: "24/7 UTC; candle opens must align to the exact hourly grid",
    availabilityRule: "final close becomes eligible only at openTime + 3,600,000 ms",
    provenance: canonicalJson({
      artifactId: artifact.artifactId,
      archiveUrl: identity.archiveUrl,
      checksumUrl: identity.checksumUrl,
      providerChecksum: artifact.providerChecksum,
      parserVersion: artifact.parserVersion,
    }),
    contentHash: normalizedContentHash,
  });
  return Object.freeze({
    artifact,
    normalizedContentHash,
    observations,
    coverage,
    manifestEntry,
    intendedUse: "RESEARCH_ONLY",
    priceAuthority: "RESEARCH_CONTEXT_ONLY",
  });
}

export async function acquireBinanceMonthlyArchive(
  input: Omit<ProcessBinanceMonthlyArchiveInput, "zipBytes" | "checksumText">,
  transport: BinanceArchiveTransport = { fetchBinary, fetchText }
): Promise<BinanceMonthlyArchiveResult> {
  const identity = createBinanceMonthlyArchiveIdentity(input.seriesId, input.partition);
  const checksumText = await transport.fetchText(identity.checksumUrl);
  const zipBytes = await transport.fetchBinary(identity.archiveUrl);
  return processBinanceMonthlyArchive({ ...input, checksumText, zipBytes });
}
