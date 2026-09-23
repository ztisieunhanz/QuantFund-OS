import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { runBacktest } from "../backtestEngine";
import type { BacktestConfig, PointInTimeBar } from "../types";
import {
  BINANCE_ONE_HOUR_MS,
  acquireBinanceMonthlyArchive,
  createBinanceMonthlyArchiveIdentity,
  normalizeBinanceArchiveTimestamp,
  processBinanceMonthlyArchive,
  timestampUnitForBinancePartition,
  type BinanceArchiveTimestampUnit,
  type BinanceResearchSeriesId,
} from "../historicalSources/binanceMonthlyArchive";
import {
  canonicalJson,
  parseSha256Checksum,
  sha256Hex,
  verifyRawArtifact,
} from "../historicalSources/immutableAcquisition";

const RETRIEVED_AT = "2026-09-23T00:00:00.000Z";

const PARITY_CONFIG: BacktestConfig = {
  runId: "m13b2-b2b1-parity",
  startDate: 0,
  endDate: 0,
  warmupPeriod: 125,
  initialCapital: 10_000,
  commissionRate: 0.001,
  slippageModel: { type: "FIXED_BPS", baseBps: 5 },
  executionRule: "NEXT_BAR_OPEN",
  deterministicSeed: 13_021,
  dataQuality: "LIVE",
};

function executableBars(count: number): PointInTimeBar[] {
  return Array.from({ length: count }, (_, index) => {
    const price = 50_000 + index * 5;
    return {
      timestamp: Date.UTC(2024, 0, 1) + index * BINANCE_ONE_HOUR_MS,
      open: price,
      high: price + 10,
      low: price - 10,
      close: price + 2,
      volume: 1_000 + index,
    };
  });
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeUInt16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

function writeUInt32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function buildZip(fileName: string, content: string, method: 0 | 8 = 8): Uint8Array {
  const encoder = new TextEncoder();
  const name = encoder.encode(fileName);
  const data = encoder.encode(content);
  const compressed = method === 0 ? data : new Uint8Array(deflateRawSync(data));
  const checksum = crc32(data);

  const local = new Uint8Array(30 + name.byteLength);
  writeUInt32(local, 0, 0x04034b50);
  writeUInt16(local, 4, 20);
  writeUInt16(local, 8, method);
  writeUInt32(local, 14, checksum);
  writeUInt32(local, 18, compressed.byteLength);
  writeUInt32(local, 22, data.byteLength);
  writeUInt16(local, 26, name.byteLength);
  local.set(name, 30);

  const centralOffset = local.byteLength + compressed.byteLength;
  const central = new Uint8Array(46 + name.byteLength);
  writeUInt32(central, 0, 0x02014b50);
  writeUInt16(central, 4, 20);
  writeUInt16(central, 6, 20);
  writeUInt16(central, 10, method);
  writeUInt32(central, 16, checksum);
  writeUInt32(central, 20, compressed.byteLength);
  writeUInt32(central, 24, data.byteLength);
  writeUInt16(central, 28, name.byteLength);
  writeUInt32(central, 42, 0);
  central.set(name, 46);

  const eocd = new Uint8Array(22);
  writeUInt32(eocd, 0, 0x06054b50);
  writeUInt16(eocd, 8, 1);
  writeUInt16(eocd, 10, 1);
  writeUInt32(eocd, 12, central.byteLength);
  writeUInt32(eocd, 16, centralOffset);
  return concatBytes(local, compressed, central, eocd);
}

function rawTimestamp(ms: number, unit: BinanceArchiveTimestampUnit): string {
  return (BigInt(ms) * (unit === "MICROSECONDS" ? 1000n : 1n)).toString();
}

function row(
  openMs: number,
  unit: BinanceArchiveTimestampUnit,
  overrides: Readonly<Partial<Record<number, string>>> = {}
): string {
  const scale = unit === "MICROSECONDS" ? 1000n : 1n;
  const fields = [
    rawTimestamp(openMs, unit),
    "100",
    "110",
    "90",
    "105",
    "12.5",
    (BigInt(openMs) * scale + BigInt(BINANCE_ONE_HOUR_MS) * scale - 1n).toString(),
    "1312.5",
    "25",
    "6",
    "630",
    "0",
  ];
  for (const [index, value] of Object.entries(overrides)) {
    if (value !== undefined) fields[Number(index)] = value;
  }
  return fields.join(",");
}

function fixture(
  options: {
    readonly seriesId?: BinanceResearchSeriesId;
    readonly partition?: string;
    readonly csv?: string;
    readonly closedThroughMs?: number;
    readonly method?: 0 | 8;
  } = {}
) {
  const seriesId = options.seriesId ?? "BTC";
  const partition = options.partition ?? "2024-01";
  const identity = createBinanceMonthlyArchiveIdentity(seriesId, partition);
  const firstOpen = identity.partitionStartMs;
  const csv = options.csv ?? [
    row(firstOpen, identity.timestampUnit),
    row(firstOpen + BINANCE_ONE_HOUR_MS, identity.timestampUnit),
  ].join("\n");
  const zipBytes = buildZip(identity.fileName.replace(/\.zip$/u, ".csv"), csv, options.method ?? 8);
  return {
    identity,
    zipBytes,
    checksumText: `${sha256Hex(zipBytes)}  ${identity.fileName}`,
    retrievedAt: RETRIEVED_AT,
    closedThroughMs: options.closedThroughMs ?? firstOpen + 2 * BINANCE_ONE_HOUR_MS,
    seriesId,
    partition,
  };
}

describe("Gate M13B-2/B2-B1 — immutable Binance monthly archive acquisition", () => {
  it("uses a real SHA-256 implementation", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("canonicalizes object keys deterministically", () => {
    expect(canonicalJson({ z: 1, a: { y: 2, b: 3 } })).toBe('{"a":{"b":3,"y":2},"z":1}');
  });

  it("parses Binance SHA-256 checksum syntax", () => {
    const digest = "a".repeat(64);
    expect(parseSha256Checksum(`${digest}  BTCUSDT-1h-2024-01.zip\n`, "BTCUSDT-1h-2024-01.zip"))
      .toEqual({ algorithm: "SHA256", digest, fileName: "BTCUSDT-1h-2024-01.zip" });
  });

  it("rejects malformed or multi-entry checksum text", () => {
    expect(() => parseSha256Checksum("not-a-checksum", "x.zip")).toThrow(/malformed/i);
    expect(() => parseSha256Checksum(`${"a".repeat(64)}  x.zip\n${"b".repeat(64)}  x.zip`, "x.zip"))
      .toThrow(/exactly one/i);
  });

  it("rejects a checksum naming a different artifact", () => {
    expect(() => parseSha256Checksum(`${"a".repeat(64)}  other.zip`, "expected.zip")).toThrow(/expected/i);
  });

  it("keeps artifact identity stable across retrieval timestamps", () => {
    const base = fixture();
    const common = {
      provider: "BINANCE_PUBLIC_DATA",
      seriesId: "BTC",
      instrument: "BTCUSDT",
      archiveUrl: base.identity.archiveUrl,
      providerChecksumPolicy: "REQUIRED",
      checksumUrl: base.identity.checksumUrl,
      partition: base.partition,
      expectedFileName: base.identity.fileName,
      checksumText: base.checksumText,
      rawBytes: base.zipBytes,
      parserVersion: "test-v1",
      licensingClassification: "PUBLIC_TERMS_APPLY",
    } as const;
    const first = verifyRawArtifact({ ...common, retrievedAt: "2026-01-01T00:00:00Z" });
    const second = verifyRawArtifact({ ...common, retrievedAt: "2026-02-01T00:00:00Z" });
    expect(first.artifactId).toBe(second.artifactId);
    expect(first.retrievedAt).not.toBe(second.retrievedAt);
  });

  it("represents an unpublished provider checksum truthfully as null", () => {
    const rawBytes = new TextEncoder().encode("provider artifact without a published checksum");
    const artifact = verifyRawArtifact({
      provider: "TEST_PROVIDER",
      seriesId: "TEST_SERIES",
      instrument: "TEST_INSTRUMENT",
      archiveUrl: "https://example.test/history.csv",
      providerChecksumPolicy: "NOT_PUBLISHED",
      checksumUrl: null,
      partition: "FULL_HISTORY",
      retrievedAt: RETRIEVED_AT,
      rawBytes,
      parserVersion: "test-v1",
      licensingClassification: "TEST_TERMS_APPLY",
    });

    expect(artifact.providerChecksum).toBeNull();
    expect(artifact.request.checksumUrl).toBeNull();
    expect(artifact.rawSha256).toBe(sha256Hex(rawBytes));
  });

  it("assigns a new artifact identity when raw bytes change", () => {
    const first = fixture({ csv: row(Date.UTC(2024, 0, 1), "MILLISECONDS") });
    const second = fixture({ csv: row(Date.UTC(2024, 0, 1), "MILLISECONDS", { 4: "106" }) });
    const result1 = processBinanceMonthlyArchive(first);
    const result2 = processBinanceMonthlyArchive(second);
    expect(result1.artifact.artifactId).not.toBe(result2.artifact.artifactId);
    expect(result1.artifact.rawSha256).not.toBe(result2.artifact.rawSha256);
    expect(result1.normalizedContentHash).not.toBe(result2.normalizedContentHash);
  });

  it("builds exact approved BTC and PAXG monthly archive identities", () => {
    expect(createBinanceMonthlyArchiveIdentity("BTC", "2024-01").archiveUrl)
      .toBe("https://data.binance.vision/data/spot/monthly/klines/BTCUSDT/1h/BTCUSDT-1h-2024-01.zip");
    expect(createBinanceMonthlyArchiveIdentity("PAXG", "2025-02").instrument).toBe("PAXGUSDT");
  });

  it("rejects unsupported symbols and intervals fail-closed", () => {
    expect(() => createBinanceMonthlyArchiveIdentity("ETH" as BinanceResearchSeriesId, "2024-01"))
      .toThrow(/unsupported research series/i);
    expect(() => createBinanceMonthlyArchiveIdentity("BTC", "2024-01", "4h")).toThrow(/unsupported interval/i);
  });

  it("predeclares milliseconds before 2025 and microseconds from 2025-01", () => {
    expect(timestampUnitForBinancePartition("2024-12")).toBe("MILLISECONDS");
    expect(timestampUnitForBinancePartition("2025-01")).toBe("MICROSECONDS");
  });

  it("normalizes millisecond and microsecond representations of the same instant identically", () => {
    expect(normalizeBinanceArchiveTimestamp("1735689600000", "MILLISECONDS", "time"))
      .toBe(normalizeBinanceArchiveTimestamp("1735689600000000", "MICROSECONDS", "time"));
  });

  it("accepts a valid pre-2025 millisecond archive", () => {
    const result = processBinanceMonthlyArchive(fixture());
    expect(result.observations).toHaveLength(2);
    expect(result.observations[0].observationTime).toBe(Date.UTC(2024, 0, 1));
  });

  it("accepts a valid post-2025 microsecond archive and emits milliseconds", () => {
    const input = fixture({ partition: "2025-01" });
    const result = processBinanceMonthlyArchive(input);
    expect(result.observations[0].observationTime).toBe(Date.UTC(2025, 0, 1));
    expect(result.observations[0].providerTimestamp).toBe(Date.UTC(2025, 0, 1) + BINANCE_ONE_HOUR_MS - 1);
  });

  it("uses open time as observationTime and candle completion as availableAt", () => {
    const result = processBinanceMonthlyArchive(fixture());
    const observation = result.observations[0];
    expect(observation.availableAt).toBe(observation.observationTime + BINANCE_ONE_HOUR_MS);
    expect(observation.providerTimestamp).toBe(observation.availableAt - 1);
  });

  it("rejects malformed, ambiguous, and wrong-unit timestamps", () => {
    const start = Date.UTC(2024, 0, 1);
    expect(() => processBinanceMonthlyArchive(fixture({ csv: row(start, "MILLISECONDS", { 0: "abc" }) })))
      .toThrow(/unsigned decimal integer/i);
    expect(() => processBinanceMonthlyArchive(fixture({ csv: row(start, "MILLISECONDS", { 0: "17040672000000" }) })))
      .toThrow(/incompatible.*partition contract/i);
    const postStart = Date.UTC(2025, 0, 1);
    expect(() => processBinanceMonthlyArchive(fixture({ partition: "2025-01", csv: row(postStart, "MILLISECONDS") })))
      .toThrow(/incompatible.*partition contract/i);
  });

  it("rejects microsecond open times that cannot normalize exactly to milliseconds", () => {
    const start = Date.UTC(2025, 0, 1);
    const valid = row(start, "MICROSECONDS").split(",");
    valid[0] = (BigInt(valid[0]) + 1n).toString();
    expect(() => processBinanceMonthlyArchive(fixture({ partition: "2025-01", csv: valid.join(",") })))
      .toThrow(/loses sub-millisecond precision/i);
  });

  it("rejects non-grid open times and invalid close boundaries", () => {
    const start = Date.UTC(2024, 0, 1);
    expect(() => processBinanceMonthlyArchive(fixture({ csv: row(start + 1, "MILLISECONDS") })))
      .toThrow(/UTC 1H grid/i);
    expect(() => processBinanceMonthlyArchive(fixture({ csv: row(start, "MILLISECONDS", { 6: String(start + 1) }) })))
      .toThrow(/closeTime.*1H interval/i);
  });

  it("rejects incomplete/open candles at the explicit acquisition boundary", () => {
    const start = Date.UTC(2024, 0, 1);
    expect(() => processBinanceMonthlyArchive(fixture({
      csv: row(start, "MILLISECONDS"),
      closedThroughMs: start + BINANCE_ONE_HOUR_MS - 1,
    }))).toThrow(/incomplete\/open candle/i);
  });

  it("rejects malformed CSV rows", () => {
    expect(() => processBinanceMonthlyArchive(fixture({ csv: "1,2,3" }))).toThrow(/expected 12/i);
  });

  it.each([1, 2, 3, 4, 5, 7, 9, 10])(
    "rejects a non-finite numeric value in Binance field %i",
    (field) => {
      const start = Date.UTC(2024, 0, 1);
      expect(() => processBinanceMonthlyArchive(fixture({ csv: row(start, "MILLISECONDS", { [field]: "NaN" }) })))
        .toThrow(/non-finite/i);
    }
  );

  it("rejects impossible OHLC ordering and invalid trade counts", () => {
    const start = Date.UTC(2024, 0, 1);
    expect(() => processBinanceMonthlyArchive(fixture({ csv: row(start, "MILLISECONDS", { 2: "99" }) })))
      .toThrow(/impossible OHLC/i);
    expect(() => processBinanceMonthlyArchive(fixture({ csv: row(start, "MILLISECONDS", { 8: "1.5" }) })))
      .toThrow(/tradeCount/i);
  });

  it("rejects identical and conflicting duplicate hourly slots", () => {
    const start = Date.UTC(2024, 0, 1);
    const original = row(start, "MILLISECONDS");
    expect(() => processBinanceMonthlyArchive(fixture({ csv: `${original}\n${original}` }))).toThrow(/duplicate UTC 1H slot/i);
    expect(() => processBinanceMonthlyArchive(fixture({
      csv: `${original}\n${row(start, "MILLISECONDS", { 4: "106" })}`,
    }))).toThrow(/conflicting duplicate/i);
  });

  it("verifies provider checksums before parsing", () => {
    const input = fixture();
    expect(() => processBinanceMonthlyArchive({ ...input, checksumText: `${"0".repeat(64)}  ${input.identity.fileName}` }))
      .toThrow(/does not match provider checksum/i);
  });

  it("rejects corrupt ZIP bytes and unexpected ZIP entry names", () => {
    const input = fixture({ method: 0 });
    const corrupt = new Uint8Array(input.zipBytes);
    const csvFileNameLength = new TextEncoder().encode(
      input.identity.fileName.replace(/\.zip$/u, ".csv")
    ).byteLength;
    corrupt[30 + csvFileNameLength] ^= 1;
    expect(() => processBinanceMonthlyArchive({
      ...input,
      zipBytes: corrupt,
      checksumText: `${sha256Hex(corrupt)}  ${input.identity.fileName}`,
    })).toThrow(/CRC-32/i);
    const wrongEntry = buildZip("other.csv", row(Date.UTC(2024, 0, 1), "MILLISECONDS"));
    expect(() => processBinanceMonthlyArchive({
      ...input,
      zipBytes: wrongEntry,
      checksumText: `${sha256Hex(wrongEntry)}  ${input.identity.fileName}`,
    })).toThrow(/expected.*csv/i);
  });

  it("counts interior and trailing missing slots without counting pre-listing time", () => {
    const start = Date.UTC(2024, 0, 1);
    const csv = [row(start, "MILLISECONDS"), row(start + 2 * BINANCE_ONE_HOUR_MS, "MILLISECONDS")].join("\n");
    const result = processBinanceMonthlyArchive(fixture({
      csv,
      closedThroughMs: start + 4 * BINANCE_ONE_HOUR_MS,
    }));
    expect(result.coverage.expectedSlotCount).toBe(4);
    expect(result.coverage.acceptedSlotCount).toBe(2);
    expect(result.coverage.missingObservationTimes).toEqual([
      start + BINANCE_ONE_HOUR_MS,
      start + 3 * BINANCE_ONE_HOUR_MS,
    ]);
    expect(result.coverage.method).toMatch(/pre-listing time excluded/i);
  });

  it("normalizes row order deterministically while preserving distinct raw identity", () => {
    const start = Date.UTC(2024, 0, 1);
    const rows = [row(start, "MILLISECONDS"), row(start + BINANCE_ONE_HOUR_MS, "MILLISECONDS")];
    const forward = processBinanceMonthlyArchive(fixture({ csv: rows.join("\n") }));
    const reverse = processBinanceMonthlyArchive(fixture({ csv: rows.reverse().join("\n") }));
    expect(reverse.observations).toEqual(forward.observations);
    expect(reverse.normalizedContentHash).toBe(forward.normalizedContentHash);
    expect(reverse.artifact.artifactId).not.toBe(forward.artifact.artifactId);
  });

  it("emits a truthful BTC/PAXG research manifest entry without executable-price authority", () => {
    const result = processBinanceMonthlyArchive(fixture({ seriesId: "PAXG" }));
    expect(result.manifestEntry).toMatchObject({
      seriesId: "PAXG",
      providerInstrument: "PAXGUSDT",
      cadence: "1H",
      revisionSemantics: "NOT_APPLICABLE",
      contentHash: result.normalizedContentHash,
    });
    expect(result.intendedUse).toBe("RESEARCH_ONLY");
    expect(result.priceAuthority).toBe("RESEARCH_CONTEXT_ONLY");
    expect((result as unknown as Record<string, unknown>).assetBars).toBeUndefined();
    expect((result as unknown as Record<string, unknown>).readiness).toBeUndefined();
  });

  it("keeps the network boundary thin and requests only one checksum and one archive", async () => {
    const input = fixture();
    const requested: string[] = [];
    const result = await acquireBinanceMonthlyArchive(
      {
        seriesId: input.seriesId,
        partition: input.partition,
        retrievedAt: input.retrievedAt,
        closedThroughMs: input.closedThroughMs,
      },
      {
        fetchText: async (url) => {
          requested.push(url);
          return input.checksumText;
        },
        fetchBinary: async (url) => {
          requested.push(url);
          return input.zipBytes;
        },
      }
    );
    expect(requested).toEqual([input.identity.checksumUrl, input.identity.archiveUrl]);
    expect(result.observations).toHaveLength(2);
  });

  it("does not mutate caller-owned ZIP bytes", () => {
    const input = fixture();
    const before = createHash("sha256").update(input.zipBytes).digest("hex");
    processBinanceMonthlyArchive(input);
    expect(createHash("sha256").update(input.zipBytes).digest("hex")).toBe(before);
  });

  it("does not alter canonical backtest, execution, or accounting output", () => {
    const assetBars = executableBars(145);
    const baseline = runBacktest(PARITY_CONFIG, { assetBars: { BTC: assetBars } });
    processBinanceMonthlyArchive(fixture());
    const afterAcquisition = runBacktest(PARITY_CONFIG, { assetBars: { BTC: assetBars } });
    expect(afterAcquisition).toEqual(baseline);
  });
});
