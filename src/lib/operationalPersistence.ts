import {
  classifyOperationalFreshness,
  createOperationalProviderSuccess,
  OPERATIONAL_PROVIDER_CONTRACT_VERSION,
  type OperationalProviderProvenance,
  type OperationalProviderRequestIdentity,
  type OperationalProviderResult,
  type OperationalProviderSuccess,
} from "./operationalProvider";

export const OPERATIONAL_DURABLE_SCHEMA_VERSION = "P15-C-V1" as const;

export interface OperationalDurableStorage {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
}

export interface OperationalDurableCodec<T> {
  readonly parse: (value: unknown) => T | null;
  readonly identityFor: (data: T) => OperationalProviderRequestIdentity;
  readonly provenanceFor: (data: T) => OperationalProviderProvenance;
  readonly observedAtFor: (data: T) => number;
  readonly retrievedAtFor: (data: T) => number;
}

interface DurableEntry<T> {
  readonly contractVersion: typeof OPERATIONAL_PROVIDER_CONTRACT_VERSION;
  readonly kind: "SUCCESS";
  readonly identity: OperationalProviderRequestIdentity;
  readonly sourceClassification: OperationalProviderProvenance;
  readonly observedAt: number;
  readonly retrievedAt: number;
  readonly data: T;
}

interface DurableDocument<T> {
  readonly schemaVersion: typeof OPERATIONAL_DURABLE_SCHEMA_VERSION;
  readonly entries: readonly DurableEntry<T>[];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isProvenance(value: unknown): value is OperationalProviderProvenance {
  return value === "LIVE" || value === "DERIVED" || value === "SYNTHETIC" || value === "HARDCODED";
}

function sameIdentity(
  left: OperationalProviderRequestIdentity,
  right: OperationalProviderRequestIdentity
): boolean {
  return left.providerId === right.providerId &&
    left.operationId === right.operationId &&
    left.requestId === right.requestId;
}

export class BoundedOperationalDurableStore<T> {
  readonly storageKey: string;
  readonly maxEntries: number;
  private readonly storage: OperationalDurableStorage;
  private readonly codec: OperationalDurableCodec<T>;

  constructor(input: {
    readonly storage: OperationalDurableStorage;
    readonly storageKey: string;
    readonly maxEntries: number;
    readonly codec: OperationalDurableCodec<T>;
  }) {
    if (input.storageKey.trim().length === 0) {
      throw new Error("Operational durable storageKey must be non-empty.");
    }
    if (!Number.isInteger(input.maxEntries) || input.maxEntries < 1) {
      throw new Error("Operational durable maxEntries must be a positive integer.");
    }
    this.storage = input.storage;
    this.storageKey = input.storageKey;
    this.maxEntries = input.maxEntries;
    this.codec = input.codec;
  }

  private parseEntry(value: unknown): DurableEntry<T> | null {
    if (!isPlainRecord(value) || !hasExactKeys(value, [
      "contractVersion",
      "kind",
      "identity",
      "sourceClassification",
      "observedAt",
      "retrievedAt",
      "data",
    ])) return null;
    if (value.contractVersion !== OPERATIONAL_PROVIDER_CONTRACT_VERSION || value.kind !== "SUCCESS") {
      return null;
    }
    if (!isPlainRecord(value.identity) || !hasExactKeys(value.identity, [
      "providerId",
      "operationId",
      "requestId",
    ])) return null;
    const { providerId, operationId, requestId } = value.identity;
    if (
      typeof providerId !== "string" || providerId.trim().length === 0 ||
      typeof operationId !== "string" || operationId.trim().length === 0 ||
      typeof requestId !== "string" || requestId.trim().length === 0
    ) return null;
    if (!isProvenance(value.sourceClassification)) return null;
    if (
      typeof value.observedAt !== "number" || !Number.isFinite(value.observedAt) || value.observedAt <= 0 ||
      typeof value.retrievedAt !== "number" || !Number.isFinite(value.retrievedAt) || value.retrievedAt <= 0 ||
      value.observedAt > value.retrievedAt
    ) return null;
    const data = this.codec.parse(value.data);
    if (data === null) return null;
    const identity = Object.freeze({ providerId, operationId, requestId });
    if (
      !sameIdentity(this.codec.identityFor(data), identity) ||
      this.codec.provenanceFor(data) !== value.sourceClassification ||
      this.codec.observedAtFor(data) !== value.observedAt ||
      this.codec.retrievedAtFor(data) !== value.retrievedAt
    ) return null;

    return Object.freeze({
      contractVersion: OPERATIONAL_PROVIDER_CONTRACT_VERSION,
      kind: "SUCCESS",
      identity,
      sourceClassification: value.sourceClassification,
      observedAt: value.observedAt,
      retrievedAt: value.retrievedAt,
      data,
    });
  }

  private parseDocument(raw: string | null): DurableDocument<T> | null {
    if (raw === null) {
      return Object.freeze({ schemaVersion: OPERATIONAL_DURABLE_SCHEMA_VERSION, entries: Object.freeze([]) });
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!isPlainRecord(value) || !hasExactKeys(value, ["schemaVersion", "entries"])) return null;
    if (value.schemaVersion !== OPERATIONAL_DURABLE_SCHEMA_VERSION || !Array.isArray(value.entries)) return null;
    if (value.entries.length > this.maxEntries) return null;

    const entries: DurableEntry<T>[] = [];
    const requestIds = new Set<string>();
    for (const candidate of value.entries) {
      const entry = this.parseEntry(candidate);
      if (entry === null || requestIds.has(entry.identity.requestId)) return null;
      requestIds.add(entry.identity.requestId);
      entries.push(entry);
    }
    return Object.freeze({
      schemaVersion: OPERATIONAL_DURABLE_SCHEMA_VERSION,
      entries: Object.freeze(entries),
    });
  }

  private readDocument(): DurableDocument<T> | null {
    try {
      return this.parseDocument(this.storage.getItem(this.storageKey));
    } catch {
      return null;
    }
  }

  recover(input: {
    readonly identity: OperationalProviderRequestIdentity;
    readonly recoveredAt: number;
    readonly freshnessMaxAgeMs: number;
  }): OperationalProviderSuccess<T> | null {
    if (!Number.isFinite(input.recoveredAt) || input.recoveredAt <= 0) return null;
    const document = this.readDocument();
    if (document === null) return null;
    const entry = document.entries.find((candidate) => sameIdentity(candidate.identity, input.identity));
    if (entry === undefined || entry.observedAt > input.recoveredAt) return null;

    const recovered = createOperationalProviderSuccess({
      identity: entry.identity,
      data: entry.data,
      sourceClassification: entry.sourceClassification,
      observedAt: entry.observedAt,
      retrievedAt: entry.retrievedAt,
      freshnessMaxAgeMs: input.freshnessMaxAgeMs,
    });
    return Object.freeze({
      ...recovered,
      freshness: classifyOperationalFreshness({
        observedAt: entry.observedAt,
        evaluatedAt: input.recoveredAt,
        maxAgeMs: input.freshnessMaxAgeMs,
      }),
    });
  }

  persist(result: OperationalProviderResult<T>): boolean {
    if (result.kind !== "SUCCESS" || result.observedAt === null) return false;
    const parsedData = this.codec.parse(result.data);
    if (
      parsedData === null ||
      !Number.isFinite(result.observedAt) || result.observedAt <= 0 ||
      !Number.isFinite(result.retrievedAt) || result.retrievedAt <= 0 ||
      result.observedAt > result.retrievedAt
    ) return false;
    if (
      !sameIdentity(this.codec.identityFor(parsedData), result.identity) ||
      this.codec.provenanceFor(parsedData) !== result.sourceClassification ||
      this.codec.observedAtFor(parsedData) !== result.observedAt ||
      this.codec.retrievedAtFor(parsedData) !== result.retrievedAt
    ) return false;

    const current = this.readDocument();
    const entries = current?.entries ? [...current.entries] : [];
    const existingIndex = entries.findIndex((entry) => sameIdentity(entry.identity, result.identity));
    const nextEntry: DurableEntry<T> = Object.freeze({
      contractVersion: OPERATIONAL_PROVIDER_CONTRACT_VERSION,
      kind: "SUCCESS",
      identity: result.identity,
      sourceClassification: result.sourceClassification,
      observedAt: result.observedAt,
      retrievedAt: result.retrievedAt,
      data: parsedData,
    });

    if (existingIndex >= 0) {
      const existing = entries[existingIndex];
      if (
        existing.retrievedAt > nextEntry.retrievedAt ||
        (existing.retrievedAt === nextEntry.retrievedAt && existing.observedAt > nextEntry.observedAt)
      ) return true;
      entries.splice(existingIndex, 1);
    }
    entries.push(nextEntry);
    entries.sort((left, right) =>
      left.retrievedAt - right.retrievedAt || left.identity.requestId.localeCompare(right.identity.requestId)
    );
    const bounded = entries.slice(-this.maxEntries);
    const document: DurableDocument<T> = Object.freeze({
      schemaVersion: OPERATIONAL_DURABLE_SCHEMA_VERSION,
      entries: Object.freeze(bounded),
    });

    try {
      this.storage.setItem(this.storageKey, JSON.stringify(document));
      return true;
    } catch {
      return false;
    }
  }
}
