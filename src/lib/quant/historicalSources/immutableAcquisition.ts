import { createHash } from "node:crypto";

export const RAW_ARTIFACT_IDENTITY_VERSION = "M13B2-RAW-ARTIFACT-V1";

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
  readonly seriesId: string;
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
  readonly seriesId: string;
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
  const seriesId = requireText(input.seriesId, "seriesId");
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
    seriesId,
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
