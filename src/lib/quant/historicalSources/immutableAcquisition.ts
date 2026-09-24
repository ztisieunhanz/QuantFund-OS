import { createHash } from "node:crypto";
import type { ResearchSeriesId } from "../researchDataProtocol";

export const RAW_ARTIFACT_IDENTITY_VERSION = "M13B2-RAW-ARTIFACT-V2";

export type ResearchSourceArtifactType =
  | "BINANCE_SPOT_MONTHLY_KLINES_1H"
  | "FRED_ALFRED_H15_INITIAL_RELEASE_OBSERVATIONS"
  | "BLS_CPI_ARCHIVED_NEWS_RELEASE"
  | "BLS_EMPLOYMENT_SITUATION_ARCHIVED_NEWS_RELEASE"
  | "FOMC_POLICY_STATEMENT"
  | "FOMC_IMPLEMENTATION_NOTE";

export const APPROVED_RESEARCH_SOURCE_ARTIFACT_TYPES: Readonly<
  Record<string, readonly ResearchSourceArtifactType[]>
> = Object.freeze({
  BINANCE_PUBLIC_DATA: Object.freeze(
    ["BINANCE_SPOT_MONTHLY_KLINES_1H"] as readonly ResearchSourceArtifactType[]
  ),
  FEDERAL_RESERVE_FRED_ALFRED: Object.freeze(
    ["FRED_ALFRED_H15_INITIAL_RELEASE_OBSERVATIONS"] as readonly ResearchSourceArtifactType[]
  ),
  US_BUREAU_OF_LABOR_STATISTICS: Object.freeze([
    "BLS_CPI_ARCHIVED_NEWS_RELEASE",
    "BLS_EMPLOYMENT_SITUATION_ARCHIVED_NEWS_RELEASE",
  ] as readonly ResearchSourceArtifactType[]),
  FEDERAL_RESERVE_BOARD: Object.freeze(
    ["FOMC_POLICY_STATEMENT", "FOMC_IMPLEMENTATION_NOTE"] as readonly ResearchSourceArtifactType[]
  ),
});

export const APPROVED_RESEARCH_SOURCE_ARTIFACT_SERIES = Object.freeze({
  BINANCE_SPOT_MONTHLY_KLINES_1H: Object.freeze(["BTC", "PAXG"] as const),
  FRED_ALFRED_H15_INITIAL_RELEASE_OBSERVATIONS: Object.freeze(["US10Y", "US2Y"] as const),
  BLS_CPI_ARCHIVED_NEWS_RELEASE: Object.freeze(["US_CPI_INDEX", "US_CPI_YOY"] as const),
  BLS_EMPLOYMENT_SITUATION_ARCHIVED_NEWS_RELEASE: Object.freeze(["US_NFP_NET_CHANGE"] as const),
  FOMC_POLICY_STATEMENT: Object.freeze([
    "FOMC_RATE_DECISION",
    "US_FED_FUNDS_TARGET_UPPER",
  ] as const),
  FOMC_IMPLEMENTATION_NOTE: Object.freeze([
    "FOMC_RATE_DECISION",
    "US_FED_FUNDS_TARGET_UPPER",
  ] as const),
}) satisfies Readonly<Record<ResearchSourceArtifactType, readonly ResearchSeriesId[]>>;

export class HistoricalAcquisitionError extends Error {
  constructor(message: string) {
    super(`HistoricalAcquisitionError: ${message}`);
    this.name = "HistoricalAcquisitionError";
  }
}

export interface RawArtifactRequestIdentity {
  readonly method: "GET";
  readonly url: string;
  readonly checksumUrl: string | null;
  readonly partition: string;
}

export interface ProviderChecksum {
  readonly algorithm: "SHA256";
  readonly digest: string;
  readonly fileName: string;
}

export interface VerifiedRawArtifact {
  readonly identityVersion: typeof RAW_ARTIFACT_IDENTITY_VERSION;
  readonly artifactId: string;
  readonly provider: string;
  readonly sourceArtifactType: ResearchSourceArtifactType;
  readonly instrument: string;
  readonly request: RawArtifactRequestIdentity;
  readonly retrievedAt: string;
  readonly providerChecksum: ProviderChecksum | null;
  readonly rawSha256: string;
  readonly byteLength: number;
  readonly parserVersion: string;
  readonly licensingClassification: string;
}

interface VerifyRawArtifactBaseInput {
  readonly provider: string;
  readonly sourceArtifactType: ResearchSourceArtifactType;
  readonly instrument: string;
  readonly archiveUrl: string;
  readonly partition: string;
  readonly retrievedAt: string;
  readonly rawBytes: Uint8Array;
  readonly parserVersion: string;
  readonly licensingClassification: string;
}

export type VerifyRawArtifactInput = VerifyRawArtifactBaseInput & (
  | {
      readonly providerChecksumPolicy: "REQUIRED";
      readonly checksumUrl: string;
      readonly expectedFileName: string;
      readonly checksumText: string;
    }
  | {
      readonly providerChecksumPolicy: "NOT_PUBLISHED";
      readonly checksumUrl: null;
    }
);

export type BinaryFetcher = (url: string) => Promise<Uint8Array>;

function requireText(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HistoricalAcquisitionError(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const canonical: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (record[key] !== undefined) canonical[key] = canonicalize(record[key]);
    }
    return canonical;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function parseSha256Checksum(text: string, expectedFileName: string): ProviderChecksum {
  const fileName = requireText(expectedFileName, "expectedFileName");
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1) {
    throw new HistoricalAcquisitionError("provider checksum must contain exactly one non-empty SHA-256 entry.");
  }
  const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/u.exec(lines[0]);
  if (!match) {
    throw new HistoricalAcquisitionError("provider checksum entry is malformed or is not SHA-256.");
  }
  if (match[2] !== fileName) {
    throw new HistoricalAcquisitionError(
      `provider checksum names "${match[2]}", expected "${fileName}".`
    );
  }
  return Object.freeze({ algorithm: "SHA256", digest: match[1].toLowerCase(), fileName });
}

export function verifyRawArtifact(input: VerifyRawArtifactInput): VerifiedRawArtifact {
  const provider = requireText(input.provider, "provider");
  const sourceArtifactType = requireText(input.sourceArtifactType, "sourceArtifactType") as ResearchSourceArtifactType;
  const approvedTypes = APPROVED_RESEARCH_SOURCE_ARTIFACT_TYPES[provider];
  if (!approvedTypes?.includes(sourceArtifactType)) {
    throw new HistoricalAcquisitionError(
      `sourceArtifactType "${sourceArtifactType}" is not approved for provider "${provider}".`
    );
  }
  const instrument = requireText(input.instrument, "instrument");
  const archiveUrl = requireText(input.archiveUrl, "archiveUrl");
  const partition = requireText(input.partition, "partition");
  const parserVersion = requireText(input.parserVersion, "parserVersion");
  const licensingClassification = requireText(
    input.licensingClassification,
    "licensingClassification"
  );
  const retrievedAt = requireText(input.retrievedAt, "retrievedAt");
  if (!Number.isFinite(Date.parse(retrievedAt))) {
    throw new HistoricalAcquisitionError("retrievedAt must be a valid ISO date-time string.");
  }
  if (!(input.rawBytes instanceof Uint8Array) || input.rawBytes.byteLength === 0) {
    throw new HistoricalAcquisitionError("rawBytes must contain a non-empty provider artifact.");
  }

  const rawSha256 = sha256Hex(input.rawBytes);
  let checksumUrl: string | null = null;
  let providerChecksum: ProviderChecksum | null = null;
  if (input.providerChecksumPolicy === "REQUIRED") {
    checksumUrl = requireText(input.checksumUrl, "checksumUrl");
    providerChecksum = parseSha256Checksum(input.checksumText, input.expectedFileName);
    if (rawSha256 !== providerChecksum.digest) {
      throw new HistoricalAcquisitionError(
        `raw SHA-256 ${rawSha256} does not match provider checksum ${providerChecksum.digest}.`
      );
    }
  }

  const request = Object.freeze({
    method: "GET" as const,
    url: archiveUrl,
    checksumUrl,
    partition,
  });
  const stableIdentity = {
    identityVersion: RAW_ARTIFACT_IDENTITY_VERSION,
    provider,
    sourceArtifactType,
    instrument,
    request,
    providerChecksum,
    rawSha256,
    byteLength: input.rawBytes.byteLength,
    parserVersion,
    licensingClassification,
  } as const;

  return Object.freeze({
    ...stableIdentity,
    artifactId: `sha256:${sha256Hex(canonicalJson(stableIdentity))}`,
    retrievedAt,
  });
}

export async function fetchBinary(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new HistoricalAcquisitionError(`GET ${url} failed with HTTP ${response.status}.`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

export async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new HistoricalAcquisitionError(`GET ${url} failed with HTTP ${response.status}.`);
  }
  return response.text();
}
