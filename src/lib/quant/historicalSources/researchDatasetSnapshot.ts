import {
  RESEARCH_DATA_SCHEMA_VERSION,
  RESEARCH_PIT_POLICY_ID,
  RESEARCH_SERIES_SPECS,
  buildResearchSnapshotCanonicalInput,
  validateResearchDatasetManifest,
  type ResearchDatasetManifest,
  type ResearchSeriesId,
} from "../researchDataProtocol";
import {
  normalizeHistoricalDataset,
  validateHistoricalDataset,
  type HistoricalDataset,
} from "../historicalPit";
import {
  RAW_ARTIFACT_IDENTITY_VERSION,
  canonicalJson,
  sha256Hex,
  type VerifiedRawArtifact,
} from "./immutableAcquisition";

export const RESEARCH_DATASET_SNAPSHOT_SCHEMA_VERSION = "M13B2-DATASET-SNAPSHOT-V1";

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const HEX_SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export type ResearchSeriesAcquisitionStatus =
  | "ACQUIRED"
  | "NOT_INCLUDED"
  | "CONDITIONAL"
  | "BLOCKED";

export interface ResearchSeriesSnapshotStatus {
  readonly seriesId: ResearchSeriesId;
  readonly status: ResearchSeriesAcquisitionStatus;
  readonly reason: string;
}

export const CURRENT_UNRESOLVED_RESEARCH_SERIES: Readonly<
  Partial<Record<ResearchSeriesId, Readonly<{ status: "CONDITIONAL" | "BLOCKED"; reason: string }>>>
> = Object.freeze({
  DXY: Object.freeze({
    status: "BLOCKED",
    reason: "Approved ICE source access, publication timing, and licensing semantics remain unresolved.",
  }),
  VIX: Object.freeze({
    status: "BLOCKED",
    reason: "The free Cboe CSV has no proven per-row historical availability timestamp contract.",
  }),
  US_CPI_MOM: Object.freeze({
    status: "CONDITIONAL",
    reason: "Complete release-by-release seasonal-vintage reconstruction remains unproven.",
  }),
  US_UNEMPLOYMENT_RATE: Object.freeze({
    status: "CONDITIONAL",
    reason: "A complete five-year as-published vintage map remains unproven.",
  }),
});

export interface SnapshotRawArtifact extends VerifiedRawArtifact {
  readonly providerChecksumPolicy: "REQUIRED" | "NOT_PUBLISHED";
}

export type ResearchDatasetSnapshotManifestInput = Omit<ResearchDatasetManifest, "snapshotHash">;

export interface ResearchDatasetSnapshotInput {
  readonly dataset: HistoricalDataset;
  readonly manifest: ResearchDatasetSnapshotManifestInput;
  readonly rawArtifacts: readonly VerifiedRawArtifact[];
  readonly claimedSnapshotHash?: string;
}

export interface ResearchDatasetSnapshot {
  readonly snapshotSchemaVersion: typeof RESEARCH_DATASET_SNAPSHOT_SCHEMA_VERSION;
  readonly snapshotHash: string;
  readonly createdAt: string;
  readonly intendedUse: "RESEARCH_ONLY";
  readonly priceAuthority: "RESEARCH_CONTEXT_ONLY";
  readonly readinessAssessment: "NOT_EVALUATED";
  readonly window: {
    readonly semantics: "REQUESTED_WINDOW";
    readonly startTime: number;
    readonly endTime: number;
  };
  readonly manifest: ResearchDatasetManifest;
  readonly dataset: HistoricalDataset;
  readonly rawArtifacts: readonly SnapshotRawArtifact[];
  readonly seriesStatuses: readonly ResearchSeriesSnapshotStatus[];
}

export class ResearchDatasetSnapshotValidationError extends Error {
  constructor(message: string) {
    super(`ResearchDatasetSnapshotValidationError: ${message}`);
    this.name = "ResearchDatasetSnapshotValidationError";
  }
}

function fail(message: string): never {
  throw new ResearchDatasetSnapshotValidationError(message);
}

function deepCopy<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => deepCopy(item)) as T;
  if (value !== null && typeof value === "object") {
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) copy[key] = deepCopy(item);
    return copy as T;
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

function assertSha256(value: string, field: string): void {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail(`${field} must be a lowercase sha256:<64 hex> digest.`);
  }
}

function artifactIdentityWithoutRetrieval(artifact: VerifiedRawArtifact): Omit<VerifiedRawArtifact, "artifactId" | "retrievedAt"> {
  return {
    identityVersion: artifact.identityVersion,
    provider: artifact.provider,
    seriesId: artifact.seriesId,
    instrument: artifact.instrument,
    request: artifact.request,
    providerChecksum: artifact.providerChecksum,
    rawSha256: artifact.rawSha256,
    byteLength: artifact.byteLength,
    parserVersion: artifact.parserVersion,
    licensingClassification: artifact.licensingClassification,
  };
}

function validateAndNormalizeArtifacts(
  artifacts: readonly VerifiedRawArtifact[],
  manifest: ResearchDatasetManifest
): readonly SnapshotRawArtifact[] {
  if (!Array.isArray(artifacts) || artifacts.length === 0) fail("rawArtifacts must contain at least one artifact.");
  const byArtifactId = new Map<string, SnapshotRawArtifact>();
  const byRequest = new Map<string, SnapshotRawArtifact>();
  const manifestProvenance = manifest.sources.map((source) => source.provenance);

  for (const sourceArtifact of artifacts) {
    const artifact = deepCopy(sourceArtifact);
    if (artifact.identityVersion !== RAW_ARTIFACT_IDENTITY_VERSION) {
      fail(`artifact ${artifact.artifactId} uses unsupported identityVersion ${artifact.identityVersion}.`);
    }
    assertSha256(artifact.artifactId, "artifactId");
    if (!HEX_SHA256_PATTERN.test(artifact.rawSha256)) {
      fail(`${artifact.artifactId}.rawSha256 must be 64 lowercase hex characters.`);
    }
    if (!Number.isInteger(artifact.byteLength) || artifact.byteLength <= 0) {
      fail(`${artifact.artifactId}.byteLength must be a positive integer.`);
    }
    if (!Number.isFinite(Date.parse(artifact.retrievedAt))) {
      fail(`${artifact.artifactId}.retrievedAt must be a valid ISO date-time string.`);
    }
    if (!Object.prototype.hasOwnProperty.call(RESEARCH_SERIES_SPECS, artifact.seriesId)) {
      fail(`${artifact.artifactId} names unsupported series ${artifact.seriesId}.`);
    }
    for (const [field, value] of [
      ["provider", artifact.provider],
      ["instrument", artifact.instrument],
      ["request.url", artifact.request?.url],
      ["request.partition", artifact.request?.partition],
      ["parserVersion", artifact.parserVersion],
      ["licensingClassification", artifact.licensingClassification],
    ] as const) {
      if (typeof value !== "string" || value.trim().length === 0) fail(`${artifact.artifactId}.${field} is required.`);
    }
    if (artifact.request.method !== "GET") fail(`${artifact.artifactId}.request.method must be GET.`);

    const expectedArtifactId = `sha256:${sha256Hex(canonicalJson(artifactIdentityWithoutRetrieval(artifact)))}`;
    if (artifact.artifactId !== expectedArtifactId) {
      fail(`${artifact.artifactId} does not match its immutable artifact metadata.`);
    }

    let providerChecksumPolicy: SnapshotRawArtifact["providerChecksumPolicy"];
    if (artifact.providerChecksum === null) {
      providerChecksumPolicy = "NOT_PUBLISHED";
      if (artifact.request.checksumUrl !== null) {
        fail(`${artifact.artifactId} has a checksum URL but no provider checksum.`);
      }
    } else {
      providerChecksumPolicy = "REQUIRED";
      if (typeof artifact.request.checksumUrl !== "string" || artifact.request.checksumUrl.trim().length === 0) {
        fail(`${artifact.artifactId} has a provider checksum without a checksum URL.`);
      }
      if (
        artifact.providerChecksum.algorithm !== "SHA256" ||
        !HEX_SHA256_PATTERN.test(artifact.providerChecksum.digest) ||
        artifact.providerChecksum.digest !== artifact.rawSha256 ||
        artifact.providerChecksum.fileName.trim().length === 0
      ) {
        fail(`${artifact.artifactId} has an invalid or conflicting provider checksum.`);
      }
    }
    if (artifact.provider === "BINANCE_PUBLIC_DATA" && providerChecksumPolicy !== "REQUIRED") {
      fail("Binance artifacts require a published provider checksum.");
    }

    const normalized = { ...artifact, providerChecksumPolicy } as SnapshotRawArtifact;
    const duplicate = byArtifactId.get(artifact.artifactId);
    if (duplicate) {
      const existingIdentity = artifactHashIdentity(duplicate);
      const incomingIdentity = artifactHashIdentity(normalized);
      if (canonicalJson(existingIdentity) !== canonicalJson(incomingIdentity)) {
        fail(`duplicate artifact identity ${artifact.artifactId} has conflicting metadata.`);
      }
      if (normalized.retrievedAt < duplicate.retrievedAt) byArtifactId.set(artifact.artifactId, normalized);
    } else {
      byArtifactId.set(artifact.artifactId, normalized);
    }

    const requestKey = canonicalJson({
      provider: artifact.provider,
      seriesId: artifact.seriesId,
      instrument: artifact.instrument,
      request: artifact.request,
      parserVersion: artifact.parserVersion,
    });
    const requestConflict = byRequest.get(requestKey);
    if (requestConflict && requestConflict.rawSha256 !== artifact.rawSha256) {
      fail(`raw artifact hash conflict for ${artifact.provider} ${artifact.request.url}.`);
    }
    byRequest.set(requestKey, normalized);
  }

  const normalized = [...byArtifactId.values()].sort((left, right) => left.artifactId.localeCompare(right.artifactId));
  for (const artifact of normalized) {
    if (!manifestProvenance.some((provenance) => provenance.includes(artifact.artifactId))) {
      fail(`raw artifact ${artifact.artifactId} is not linked by any series manifest provenance.`);
    }
  }
  for (const source of manifest.sources) {
    if (!normalized.some((artifact) => source.provenance.includes(artifact.artifactId))) {
      fail(`${source.seriesId} manifest provenance does not link a raw artifact.`);
    }
  }
  return normalized;
}

function eventSeriesId(eventType: string): ResearchSeriesId {
  if (eventType === "FED_RATE_DECISION" || eventType === "FOMC_STATEMENT") return "FOMC_RATE_DECISION";
  return fail(`unsupported eventType ${eventType} cannot be represented by the research protocol.`);
}

function recordSeriesIds(dataset: HistoricalDataset): readonly ResearchSeriesId[] {
  return [
    ...dataset.marketObservations.map((record) => record.seriesId),
    ...dataset.macroReleases.map((record) => record.seriesId),
    ...dataset.eventRecords.map((record) => eventSeriesId(record.eventType)),
  ].map((seriesId) => {
    if (!Object.prototype.hasOwnProperty.call(RESEARCH_SERIES_SPECS, seriesId)) {
      fail(`dataset contains unsupported series ${seriesId}.`);
    }
    return seriesId as ResearchSeriesId;
  });
}

function validateDatasetManifestLinkage(dataset: HistoricalDataset, manifest: ResearchDatasetManifest): void {
  const seriesIds = recordSeriesIds(dataset);
  const manifestIds = new Set(manifest.sources.map((source) => source.seriesId));
  for (const seriesId of seriesIds) {
    if (!manifestIds.has(seriesId)) fail(`dataset series ${seriesId} has no manifest entry.`);
  }
  for (const source of manifest.sources) {
    const records = source.seriesId === "FOMC_RATE_DECISION"
      ? dataset.eventRecords.filter((record) => eventSeriesId(record.eventType) === source.seriesId)
      : RESEARCH_SERIES_SPECS[source.seriesId].kind === "MARKET_FACTOR"
        ? dataset.marketObservations.filter((record) => record.seriesId === source.seriesId)
        : dataset.macroReleases.filter((record) => record.seriesId === source.seriesId);
    if (records.length === 0) fail(`${source.seriesId} is a fake or unresolved zero-content manifest entry.`);
    if (records.length !== source.recordCount) {
      fail(`${source.seriesId} manifest recordCount ${source.recordCount} does not match dataset count ${records.length}.`);
    }
    if (records.some((record) => record.provider !== source.provider)) {
      fail(`${source.seriesId} manifest provider does not match normalized content.`);
    }
    const observationTimes = records.map((record) => record.observationTime);
    const availableTimes = records.map((record) => record.availableAt);
    if (
      source.firstObservationTime !== Math.min(...observationTimes) ||
      source.lastObservationTime !== Math.max(...observationTimes) ||
      source.firstAvailableAt !== Math.min(...availableTimes) ||
      source.lastAvailableAt !== Math.max(...availableTimes)
    ) {
      fail(`${source.seriesId} manifest coverage does not match normalized content.`);
    }
    assertSha256(source.contentHash, `${source.seriesId}.contentHash`);
  }
}

function deriveSeriesStatuses(manifest: ResearchDatasetManifest): readonly ResearchSeriesSnapshotStatus[] {
  const acquired = new Set(manifest.sources.map((source) => source.seriesId));
  return (Object.keys(RESEARCH_SERIES_SPECS) as ResearchSeriesId[])
    .map((seriesId): ResearchSeriesSnapshotStatus => {
      if (acquired.has(seriesId)) {
        if (CURRENT_UNRESOLVED_RESEARCH_SERIES[seriesId]) {
          fail(`${seriesId} is unresolved and cannot be represented as acquired.`);
        }
        return { seriesId, status: "ACQUIRED", reason: "Validated manifest and normalized content are present." };
      }
      const unresolved = CURRENT_UNRESOLVED_RESEARCH_SERIES[seriesId];
      if (unresolved) return { seriesId, status: unresolved.status, reason: unresolved.reason };
      return { seriesId, status: "NOT_INCLUDED", reason: "No manifest or normalized content is included in this snapshot." };
    })
    .sort((left, right) => left.seriesId.localeCompare(right.seriesId));
}

function validateBaseInput(input: ResearchDatasetSnapshotInput): {
  readonly manifest: ResearchDatasetManifest;
  readonly dataset: HistoricalDataset;
  readonly rawArtifacts: readonly SnapshotRawArtifact[];
  readonly seriesStatuses: readonly ResearchSeriesSnapshotStatus[];
} {
  validateHistoricalDataset(input.dataset);
  const recordCount =
    input.dataset.marketObservations.length + input.dataset.macroReleases.length + input.dataset.eventRecords.length;
  if (recordCount === 0) fail("snapshot dataset must not be empty.");
  if (input.manifest.schemaVersion !== RESEARCH_DATA_SCHEMA_VERSION) {
    fail(`unsupported protocol schemaVersion ${input.manifest.schemaVersion}.`);
  }
  if (input.manifest.pitPolicy !== RESEARCH_PIT_POLICY_ID) {
    fail(`pitPolicy must be ${RESEARCH_PIT_POLICY_ID}.`);
  }
  const placeholderHash = `sha256:${"0".repeat(64)}`;
  const manifest: ResearchDatasetManifest = { ...deepCopy(input.manifest), snapshotHash: placeholderHash };
  validateResearchDatasetManifest(manifest);
  validateDatasetManifestLinkage(input.dataset, manifest);
  const rawArtifacts = validateAndNormalizeArtifacts(input.rawArtifacts, manifest);
  const seriesStatuses = deriveSeriesStatuses(manifest);
  return {
    manifest,
    dataset: normalizeHistoricalDataset(deepCopy(input.dataset)),
    rawArtifacts,
    seriesStatuses,
  };
}

function artifactHashIdentity(artifact: SnapshotRawArtifact): unknown {
  return {
    ...artifactIdentityWithoutRetrieval(artifact),
    artifactId: artifact.artifactId,
    providerChecksumPolicy: artifact.providerChecksumPolicy,
  };
}

function buildCanonicalInputFromValidated(validated: ReturnType<typeof validateBaseInput>): string {
  const protocolIdentity = JSON.parse(
    buildResearchSnapshotCanonicalInput(validated.dataset, validated.manifest)
  ) as unknown;
  return canonicalJson({
    snapshotSchemaVersion: RESEARCH_DATASET_SNAPSHOT_SCHEMA_VERSION,
    protocolIdentity,
    rawArtifacts: validated.rawArtifacts.map(artifactHashIdentity),
    seriesStatuses: validated.seriesStatuses,
    readinessAssessment: "NOT_EVALUATED",
    windowSemantics: "REQUESTED_WINDOW",
  });
}

export function buildResearchDatasetSnapshotCanonicalInput(input: ResearchDatasetSnapshotInput): string {
  return buildCanonicalInputFromValidated(validateBaseInput(input));
}

export function computeResearchDatasetSnapshotHash(input: ResearchDatasetSnapshotInput): string {
  return `sha256:${sha256Hex(buildResearchDatasetSnapshotCanonicalInput(input))}`;
}

export function createResearchDatasetSnapshot(input: ResearchDatasetSnapshotInput): ResearchDatasetSnapshot {
  const validated = validateBaseInput(input);
  const snapshotHash = `sha256:${sha256Hex(buildCanonicalInputFromValidated(validated))}`;
  if (input.claimedSnapshotHash !== undefined && input.claimedSnapshotHash !== snapshotHash) {
    fail(`claimed snapshot hash ${input.claimedSnapshotHash} does not match computed ${snapshotHash}.`);
  }
  const manifest = { ...validated.manifest, snapshotHash };
  const snapshot: ResearchDatasetSnapshot = {
    snapshotSchemaVersion: RESEARCH_DATASET_SNAPSHOT_SCHEMA_VERSION,
    snapshotHash,
    createdAt: manifest.createdAt,
    intendedUse: manifest.intendedUse,
    priceAuthority: manifest.priceAuthority,
    readinessAssessment: "NOT_EVALUATED",
    window: {
      semantics: "REQUESTED_WINDOW",
      startTime: manifest.startTime,
      endTime: manifest.endTime,
    },
    manifest,
    dataset: validated.dataset,
    rawArtifacts: validated.rawArtifacts,
    seriesStatuses: validated.seriesStatuses,
  };
  const immutable = deepFreeze(deepCopy(snapshot));
  validateResearchDatasetSnapshot(immutable);
  return immutable;
}

export function validateResearchDatasetSnapshot(snapshot: ResearchDatasetSnapshot): void {
  if (snapshot.snapshotSchemaVersion !== RESEARCH_DATASET_SNAPSHOT_SCHEMA_VERSION) {
    fail(`unsupported snapshot schemaVersion ${snapshot.snapshotSchemaVersion}.`);
  }
  if (snapshot.intendedUse !== "RESEARCH_ONLY") fail("intendedUse must be RESEARCH_ONLY.");
  if (snapshot.priceAuthority !== "RESEARCH_CONTEXT_ONLY") {
    fail("priceAuthority must be RESEARCH_CONTEXT_ONLY.");
  }
  if (snapshot.readinessAssessment !== "NOT_EVALUATED") {
    fail("snapshot assembly cannot claim research readiness.");
  }
  if (
    snapshot.window.semantics !== "REQUESTED_WINDOW" ||
    snapshot.window.startTime !== snapshot.manifest.startTime ||
    snapshot.window.endTime !== snapshot.manifest.endTime
  ) {
    fail("snapshot window must exactly preserve the manifest requested window.");
  }
  if (
    snapshot.createdAt !== snapshot.manifest.createdAt ||
    snapshot.snapshotHash !== snapshot.manifest.snapshotHash ||
    snapshot.intendedUse !== snapshot.manifest.intendedUse ||
    snapshot.priceAuthority !== snapshot.manifest.priceAuthority
  ) {
    fail("snapshot envelope conflicts with its manifest.");
  }
  assertSha256(snapshot.snapshotHash, "snapshotHash");

  const manifestRecord = deepCopy(snapshot.manifest) as unknown as Record<string, unknown>;
  delete manifestRecord.snapshotHash;
  const input: ResearchDatasetSnapshotInput = {
    dataset: snapshot.dataset,
    manifest: manifestRecord as unknown as ResearchDatasetSnapshotManifestInput,
    rawArtifacts: snapshot.rawArtifacts,
  };
  const validated = validateBaseInput(input);
  const expectedStatuses = canonicalJson(validated.seriesStatuses);
  if (canonicalJson(snapshot.seriesStatuses) !== expectedStatuses) {
    fail("seriesStatuses do not match acquired and unresolved series truth.");
  }
  const expectedHash = `sha256:${sha256Hex(buildCanonicalInputFromValidated(validated))}`;
  if (snapshot.snapshotHash !== expectedHash) {
    fail(`snapshotHash mismatch: expected ${expectedHash}, received ${snapshot.snapshotHash}.`);
  }
}

export class ResearchDatasetSnapshotRegistry {
  readonly #snapshots = new Map<string, { snapshot: ResearchDatasetSnapshot; canonicalInput: string }>();

  register(snapshot: ResearchDatasetSnapshot): ResearchDatasetSnapshot {
    validateResearchDatasetSnapshot(snapshot);
    const manifest = deepCopy(snapshot.manifest) as unknown as Record<string, unknown>;
    delete manifest.snapshotHash;
    const canonicalInput = buildResearchDatasetSnapshotCanonicalInput({
      dataset: snapshot.dataset,
      manifest: manifest as ResearchDatasetSnapshotManifestInput,
      rawArtifacts: snapshot.rawArtifacts,
    });
    const existing = this.#snapshots.get(snapshot.snapshotHash);
    if (existing) {
      if (existing.canonicalInput !== canonicalInput) {
        fail(`snapshot hash ${snapshot.snapshotHash} is already registered with different content.`);
      }
      return existing.snapshot;
    }
    const immutable = deepFreeze(deepCopy(snapshot));
    this.#snapshots.set(snapshot.snapshotHash, { snapshot: immutable, canonicalInput });
    return immutable;
  }

  get(snapshotHash: string): ResearchDatasetSnapshot | undefined {
    return this.#snapshots.get(snapshotHash)?.snapshot;
  }

  get size(): number {
    return this.#snapshots.size;
  }
}
