import { describe, expect, it, vi } from "vitest";
import {
  createOperationalProviderFailure,
  createOperationalProviderSuccess,
  createOperationalRequestIdentity,
} from "../operationalProvider";
import {
  BoundedOperationalDurableStore,
  OPERATIONAL_DURABLE_SCHEMA_VERSION,
  type OperationalDurableStorage,
} from "../operationalPersistence";
import { BoundedOperationalProviderCache } from "../operationalReliability";
import { createLiveDatum, createUnavailableDatum } from "../macro/helpers";
import { loadMacroUniverseV2 } from "../macro/loader";
import {
  loadReliableMacroDatum,
  MACRO_PROVIDER_DURABLE_STORAGE_KEY,
  macroIdentity,
  parsePersistedMacroDatum,
  type MacroAcquisitionAttempt,
} from "../macro/reliableProvider";
import type { AvailableMacroDatum, MacroDatum } from "../macro/types";

const NOW = Date.parse("2026-09-27T04:00:00.000Z");
const HOUR = 3_600_000;

class MemoryStorage implements OperationalDurableStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const identity = createOperationalRequestIdentity({
  providerId: "MacroV2Adapter",
  operationId: "current-observation",
  publicParameters: { metricId: "btc" },
});

function live(asOf = NOW, fetchedAt = NOW) {
  return createLiveDatum({
    id: "btc",
    value: 76_800,
    provider: "Binance",
    instrument: "BTCUSDT",
    asOf,
    fetchedAt,
    basis: "SPOT",
  });
}

function success(datum = live()) {
  return createOperationalProviderSuccess({
    identity,
    data: datum,
    sourceClassification: datum.sourceClassification,
    observedAt: datum.asOf,
    retrievedAt: datum.fetchedAt,
    freshnessMaxAgeMs: HOUR,
  });
}

function storeFor(storage: OperationalDurableStorage) {
  return new BoundedOperationalDurableStore<AvailableMacroDatum<number>>({
    storage,
    storageKey: MACRO_PROVIDER_DURABLE_STORAGE_KEY,
    maxEntries: 32,
    codec: {
      parse: (value) => parsePersistedMacroDatum(value) as AvailableMacroDatum<number> | null,
      identityFor: (datum) => macroIdentity(datum.id),
      provenanceFor: (datum) => datum.sourceClassification,
      observedAtFor: (datum) => datum.asOf,
      retrievedAtFor: (datum) => datum.fetchedAt,
    },
  });
}

function acquisition<T>(
  datum: MacroDatum<T>,
  failureKind: "PROVIDER_UNAVAILABLE" | "MALFORMED_RESPONSE" = "PROVIDER_UNAVAILABLE"
): MacroAcquisitionAttempt<T> {
  if (datum.status === "AVAILABLE") return { datum, failure: null };
  return {
    datum,
    failure: {
      evidence: { kind: failureKind },
      diagnosticCode: `MACRO_${failureKind}`,
      diagnosticMessage: "Current macro provider acquisition failed.",
    },
  };
}

describe("P15-C bounded operational durable store", () => {
  it("persists and recovers successful evidence through a new store instance", () => {
    const storage = new MemoryStorage();
    const processA = storeFor(storage);
    expect(processA.persist(success())).toBe(true);

    const processB = storeFor(storage);
    const recovered = processB.recover({ identity, recoveredAt: NOW + 1, freshnessMaxAgeMs: HOUR });

    expect(recovered).not.toBeNull();
    expect(recovered?.identity).toEqual(identity);
    expect(recovered?.data).toEqual(live());
    expect(recovered?.sourceClassification).toBe("LIVE");
    expect(recovered?.observedAt).toBe(NOW);
    expect(recovered?.retrievedAt).toBe(NOW);
  });

  it("evaluates recovered freshness at the new read time without rewriting timestamps", () => {
    const storage = new MemoryStorage();
    storeFor(storage).persist(success(live(NOW - HOUR, NOW)));

    const recovered = storeFor(storage).recover({
      identity,
      recoveredAt: NOW + 1,
      freshnessMaxAgeMs: HOUR,
    });

    expect(recovered?.freshness.status).toBe("STALE");
    expect(recovered?.freshness.ageMs).toBe(HOUR + 1);
    expect(recovered?.observedAt).toBe(NOW - HOUR);
    expect(recovered?.retrievedAt).toBe(NOW);
  });

  it.each([
    "{broken-json",
    JSON.stringify({ schemaVersion: "UNKNOWN", entries: [] }),
    JSON.stringify({ schemaVersion: OPERATIONAL_DURABLE_SCHEMA_VERSION, entries: [{ invalid: true }] }),
  ])("fails closed for corrupt or incompatible state", (serialized) => {
    const storage = new MemoryStorage();
    storage.setItem(MACRO_PROVIDER_DURABLE_STORAGE_KEY, serialized);

    expect(storeFor(storage).recover({ identity, recoveredAt: NOW, freshnessMaxAgeMs: HOUR })).toBeNull();
  });

  it("fails closed for invalid timestamps, identity, and provenance", () => {
    const base = {
      contractVersion: "M15.1A-V1",
      kind: "SUCCESS",
      identity,
      sourceClassification: "LIVE",
      observedAt: NOW,
      retrievedAt: NOW,
      data: live(),
    };
    const invalidEntries = [
      { ...base, observedAt: Number.NaN },
      { ...base, observedAt: NOW + 1 },
      { ...base, identity: { ...identity, requestId: "forged" } },
      { ...base, sourceClassification: "UNAVAILABLE" },
      { ...base, sourceClassification: "DERIVED" },
      { ...base, observedAt: NOW - 1 },
      { ...base, retrievedAt: NOW + 1 },
    ];

    for (const entry of invalidEntries) {
      const storage = new MemoryStorage();
      storage.setItem(MACRO_PROVIDER_DURABLE_STORAGE_KEY, JSON.stringify({
        schemaVersion: OPERATIONAL_DURABLE_SCHEMA_VERSION,
        entries: [entry],
      }));
      expect(storeFor(storage).recover({ identity, recoveredAt: NOW, freshnessMaxAgeMs: HOUR })).toBeNull();
    }
  });

  it("never persists a failure as invented success", () => {
    const storage = new MemoryStorage();
    const failure = createOperationalProviderFailure({
      identity,
      evidence: { kind: "PROVIDER_UNAVAILABLE" },
      occurredAt: NOW,
      diagnostic: { code: "UNAVAILABLE", message: "Provider unavailable" },
    });

    expect(storeFor(storage).persist(failure)).toBe(false);
    expect(storage.getItem(MACRO_PROVIDER_DURABLE_STORAGE_KEY)).toBeNull();
  });

  it("keeps newer durable evidence when an older success arrives", () => {
    const storage = new MemoryStorage();
    const store = storeFor(storage);
    expect(store.persist(success(live(NOW, NOW)))).toBe(true);
    expect(store.persist(success(live(NOW - HOUR, NOW - HOUR)))).toBe(true);

    const recovered = storeFor(storage).recover({ identity, recoveredAt: NOW + 1, freshnessMaxAgeMs: HOUR });
    expect(recovered?.observedAt).toBe(NOW);
    expect(recovered?.retrievedAt).toBe(NOW);
  });
});

describe("P15-C restart-safe Macro reliability integration", () => {
  it("uses fresh recovered evidence without provider acquisition after a genuine restart", async () => {
    const storage = new MemoryStorage();
    const cacheA = new BoundedOperationalProviderCache<AvailableMacroDatum<number>>(32);
    const acquireA = vi.fn().mockResolvedValue(acquisition(live()));
    await loadReliableMacroDatum({
      metricId: "btc", freshnessMaxAgeMs: HOUR, referenceTimeMs: NOW,
      acquire: acquireA, cache: cacheA, durableStore: storeFor(storage), wait: async () => undefined,
    });

    const cacheB = new BoundedOperationalProviderCache<AvailableMacroDatum<number>>(32);
    const storeB = storeFor(storage);
    const acquireB = vi.fn().mockResolvedValue(acquisition(createUnavailableDatum("btc")));
    const recovered = await loadReliableMacroDatum({
      metricId: "btc", freshnessMaxAgeMs: HOUR, referenceTimeMs: NOW + HOUR,
      acquire: acquireB, cache: cacheB, durableStore: storeB, wait: async () => undefined,
    });

    expect(cacheB).not.toBe(cacheA);
    expect(storeB).not.toBe(storeFor(storage));
    expect(acquireB).not.toHaveBeenCalled();
    expect(recovered).toEqual(live());
  });

  it("reacquires stale recovered evidence and returns it only as STALE after outage exhaustion", async () => {
    const storage = new MemoryStorage();
    storeFor(storage).persist(success(live(NOW - HOUR, NOW)));
    const cacheAfterRestart = new BoundedOperationalProviderCache<AvailableMacroDatum<number>>(32);
    const unavailable = createUnavailableDatum("btc", {
      provider: "Binance/Yahoo",
      instrument: "BTCUSDT/BTC-USD",
      fetchedAt: NOW + 1,
    });
    const acquire = vi.fn().mockResolvedValue(acquisition(unavailable));

    const result = await loadReliableMacroDatum({
      metricId: "btc", freshnessMaxAgeMs: HOUR, referenceTimeMs: NOW + 1,
      acquire, cache: cacheAfterRestart, durableStore: storeFor(storage), wait: async () => undefined,
    });

    expect(acquire).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("AVAILABLE");
    expect(result.sourceClassification).toBe("LIVE");
    expect(result.quality).toBe("STALE");
    expect(result.asOf).toBe(NOW - HOUR);
    expect(result.fetchedAt).toBe(NOW);
  });

  it("ignores corrupt durable state and follows normal acquisition", async () => {
    const storage = new MemoryStorage();
    storage.setItem(MACRO_PROVIDER_DURABLE_STORAGE_KEY, "not-json");
    const acquire = vi.fn().mockResolvedValue(acquisition(live()));

    const result = await loadReliableMacroDatum({
      metricId: "btc", freshnessMaxAgeMs: HOUR, referenceTimeMs: NOW,
      acquire,
      cache: new BoundedOperationalProviderCache<AvailableMacroDatum<number>>(32),
      durableStore: storeFor(storage),
      wait: async () => undefined,
    });

    expect(acquire).toHaveBeenCalledTimes(1);
    expect(result).toEqual(live());
  });

  it("does not let older durable evidence overwrite newer in-memory evidence", async () => {
    const storage = new MemoryStorage();
    storeFor(storage).persist(success(live(NOW - HOUR, NOW - HOUR)));
    const cache = new BoundedOperationalProviderCache<AvailableMacroDatum<number>>(32);
    const newer = success(live(NOW, NOW));
    cache.write(newer);
    const acquire = vi.fn();

    const result = await loadReliableMacroDatum({
      metricId: "btc", freshnessMaxAgeMs: HOUR, referenceTimeMs: NOW,
      acquire, cache, durableStore: storeFor(storage), wait: async () => undefined,
    });

    expect(acquire).not.toHaveBeenCalled();
    expect(result.asOf).toBe(NOW);
    expect(result.fetchedAt).toBe(NOW);
  });

  it("keeps explicitly injected adapter loads independent of durable runtime storage", async () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    let storageReads = 0;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get: () => {
        storageReads += 1;
        throw new Error("Injected adapter path must not resolve durable storage.");
      },
    });

    try {
      const data = await loadMacroUniverseV2({
        fetchedAt: NOW,
        fetchFn: async () => ({ ok: false, status: 503, json: async () => ({}) }),
      });
      expect(data.btc.status).toBe("UNAVAILABLE");
      expect(storageReads).toBe(0);
    } finally {
      if (originalDescriptor === undefined) {
        Reflect.deleteProperty(globalThis, "localStorage");
      } else {
        Object.defineProperty(globalThis, "localStorage", originalDescriptor);
      }
    }
  });
});
