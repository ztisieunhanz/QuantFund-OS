import { describe, expect, it, vi } from "vitest";
import {
  createOperationalProviderSuccess,
  createOperationalRequestIdentity,
} from "../operationalProvider";
import {
  BoundedOperationalDurableStore,
  type OperationalDurableStorage,
} from "../operationalPersistence";
import { BoundedOperationalProviderCache } from "../operationalReliability";
import {
  createCacheTelemetry,
  createPersistenceTelemetry,
  createProviderAttemptTelemetry,
  createResultTelemetry,
  deriveOperationalReadiness,
  InMemoryOperationalTelemetrySink,
  OPERATIONAL_TELEMETRY_DEPENDENCIES,
  type OperationalTelemetryEvent,
  type OperationalTelemetrySink,
} from "../operationalTelemetry";
import { createLiveDatum, createUnavailableDatum } from "../macro/helpers";
import {
  loadReliableMacroDatum,
  MACRO_PROVIDER_DURABLE_STORAGE_KEY,
  macroIdentity,
  parsePersistedMacroDatum,
  type MacroAcquisitionAttempt,
} from "../macro/reliableProvider";
import type { AvailableMacroDatum, UnavailableMacroDatum } from "../macro/types";

const NOW = Date.parse("2026-09-27T08:00:00.000Z");
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

function acquisition<T>(
  datum: AvailableMacroDatum<T> | UnavailableMacroDatum,
  failureKind: "PROVIDER_UNAVAILABLE" | "MALFORMED_RESPONSE" = "PROVIDER_UNAVAILABLE"
): MacroAcquisitionAttempt<T> {
  return datum.status === "AVAILABLE"
    ? { datum, failure: null }
    : {
        datum,
        failure: {
          evidence: { kind: failureKind },
          diagnosticCode: `MACRO_${failureKind}`,
          diagnosticMessage: "Safe canonical diagnostic.",
        },
      };
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

function successfulEvidence(datum = live()) {
  return createOperationalProviderSuccess({
    identity: createOperationalRequestIdentity({
      providerId: "MacroV2Adapter",
      operationId: "current-observation",
      publicParameters: { metricId: "btc" },
    }),
    data: datum,
    sourceClassification: "LIVE",
    observedAt: datum.asOf,
    retrievedAt: datum.fetchedAt,
    freshnessMaxAgeMs: HOUR,
  });
}

async function load(input: {
  readonly acquire: (attempt: number) => Promise<MacroAcquisitionAttempt<number>>;
  readonly sink: OperationalTelemetrySink;
  readonly cache?: BoundedOperationalProviderCache<AvailableMacroDatum<number>>;
  readonly store?: BoundedOperationalDurableStore<AvailableMacroDatum<number>>;
  readonly referenceTimeMs?: number;
}) {
  return loadReliableMacroDatum({
    metricId: "btc",
    freshnessMaxAgeMs: HOUR,
    referenceTimeMs: input.referenceTimeMs ?? NOW,
    acquire: input.acquire,
    cache: input.cache ?? new BoundedOperationalProviderCache<AvailableMacroDatum<number>>(4),
    durableStore: input.store,
    telemetry: input.sink,
    telemetryClock: { now: () => NOW },
    wait: async () => undefined,
  });
}

describe("P15-D bounded operational telemetry", () => {
  it("emits a bounded provider success with finite non-negative duration", async () => {
    const sink = new InMemoryOperationalTelemetrySink();
    await load({ acquire: async () => acquisition(live()), sink });

    const event = sink.events().find((item) => item.eventType === "PROVIDER_ATTEMPT");
    expect(event).toEqual(expect.objectContaining({
      provider: "MACRO_V2",
      dependency: "btc",
      outcome: "SUCCESS",
      freshness: "WITHIN_THRESHOLD",
      durationMs: 0,
    }));
  });

  it("emits canonical failure and retry evidence without secret material", async () => {
    const sink = new InMemoryOperationalTelemetrySink();
    const unavailable = createUnavailableDatum("btc", { fetchedAt: NOW });
    await load({ acquire: async () => acquisition<number>(unavailable), sink });

    const attempts = sink.events().filter((event) => event.eventType === "PROVIDER_ATTEMPT");
    expect(attempts).toHaveLength(2);
    expect(attempts.map((event) => event.attempt)).toEqual([1, 2]);
    expect(attempts.every((event) =>
      event.outcome === "FAILURE" &&
      event.failureClass === "PROVIDER_UNAVAILABLE" &&
      event.retryDisposition === "RETRYABLE"
    )).toBe(true);
    const serialized = JSON.stringify(sink.events());
    for (const forbidden of ["AIza-secret", "Authorization", "Cookie", "https://provider.test?key=secret", "raw payload"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("represents retry success without changing the two-attempt result", async () => {
    const sink = new InMemoryOperationalTelemetrySink();
    const acquire = vi.fn()
      .mockResolvedValueOnce(acquisition<number>(createUnavailableDatum("btc", { fetchedAt: NOW })))
      .mockResolvedValueOnce(acquisition(live()));

    const result = await load({ acquire, sink });
    const attempts = sink.events().filter((event) => event.eventType === "PROVIDER_ATTEMPT");
    expect(result).toEqual(live());
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(attempts.map((event) => event.outcome)).toEqual(["FAILURE", "SUCCESS"]);
  });

  it("distinguishes a fresh cache hit from provider acquisition", async () => {
    const sink = new InMemoryOperationalTelemetrySink();
    const cache = new BoundedOperationalProviderCache<AvailableMacroDatum<number>>(4);
    cache.write(successfulEvidence());
    const acquire = vi.fn();

    expect(await load({ acquire, sink, cache })).toEqual(live());
    expect(acquire).not.toHaveBeenCalled();
    expect(sink.events()).toContainEqual(expect.objectContaining({
      eventType: "CACHE_ACCESS",
      outcome: "FRESH_HIT",
    }));
    expect(sink.events().some((event) => event.eventType === "PROVIDER_ATTEMPT")).toBe(false);
  });

  it("keeps stale fallback visibly distinct from fresh evidence", async () => {
    const sink = new InMemoryOperationalTelemetrySink();
    const cache = new BoundedOperationalProviderCache<AvailableMacroDatum<number>>(4);
    cache.write(successfulEvidence(live(NOW - HOUR, NOW - HOUR)));
    const unavailable = createUnavailableDatum("btc", { fetchedAt: NOW + 1 });

    const result = await load({
      acquire: async () => acquisition<number>(unavailable),
      sink,
      cache,
      referenceTimeMs: NOW + 1,
    });
    expect(result.status).toBe("AVAILABLE");
    expect(result.quality).toBe("STALE");
    expect(sink.events()).toContainEqual(expect.objectContaining({
      eventType: "RESULT",
      outcome: "STALE_FALLBACK",
    }));
  });

  it("observes persistence write and recovery without datum payload", async () => {
    const storage = new MemoryStorage();
    const writeSink = new InMemoryOperationalTelemetrySink();
    await load({ acquire: async () => acquisition(live()), sink: writeSink, store: storeFor(storage) });

    const recoverySink = new InMemoryOperationalTelemetrySink();
    const acquire = vi.fn();
    await load({ acquire, sink: recoverySink, store: storeFor(storage) });
    expect(acquire).not.toHaveBeenCalled();
    expect(writeSink.events()).toContainEqual(expect.objectContaining({
      eventType: "PERSISTENCE", operation: "WRITE", outcome: "WRITTEN",
    }));
    expect(recoverySink.events()).toContainEqual(expect.objectContaining({
      eventType: "PERSISTENCE", operation: "RECOVER", outcome: "RECOVERED",
    }));
    expect(JSON.stringify([...writeSink.events(), ...recoverySink.events()])).not.toContain("76800");
  });

  it("represents corrupt persistence rejection and continues normal acquisition", async () => {
    const storage = new MemoryStorage();
    storage.setItem(MACRO_PROVIDER_DURABLE_STORAGE_KEY, "{broken-json");
    const sink = new InMemoryOperationalTelemetrySink();
    const result = await load({ acquire: async () => acquisition(live()), sink, store: storeFor(storage) });

    expect(result).toEqual(live());
    expect(sink.events()).toContainEqual(expect.objectContaining({
      eventType: "PERSISTENCE", operation: "RECOVER", outcome: "REJECTED",
    }));
  });

  it("derives ready, degraded, and unavailable states without probing", () => {
    const acquire = vi.fn();
    const fresh = createCacheTelemetry({ dependency: "btc", recordedAt: NOW, outcome: "FRESH_HIT" });
    const stale = createResultTelemetry({ dependency: "btc", recordedAt: NOW, outcome: "STALE_FALLBACK" });
    const unavailable = createResultTelemetry({ dependency: "btc", recordedAt: NOW, outcome: "UNAVAILABLE" });
    const healthyPersistence = createPersistenceTelemetry({
      dependency: "btc", recordedAt: NOW, operation: "WRITE", outcome: "WRITTEN", freshness: "WITHIN_THRESHOLD",
    });

    expect(deriveOperationalReadiness([fresh, healthyPersistence]).status).toBe("READY");
    expect(deriveOperationalReadiness([fresh, stale]).status).toBe("DEGRADED");
    expect(deriveOperationalReadiness([fresh, unavailable]).status).toBe("UNAVAILABLE");
    expect(deriveOperationalReadiness([]).status).toBe("UNKNOWN");
    expect(acquire).not.toHaveBeenCalled();
  });

  it("does not claim terminal unavailability from a retryable failed attempt alone", () => {
    const failedAttempt = createProviderAttemptTelemetry({
      dependency: "btc",
      recordedAt: NOW,
      attempt: 1,
      durationMs: 4,
      outcome: "FAILURE",
      freshness: null,
      failureClass: "NETWORK",
      retryDisposition: "RETRYABLE",
      isRateLimited: false,
    });

    expect(deriveOperationalReadiness([failedAttempt])).toEqual({
      status: "UNKNOWN",
      persistence: "UNKNOWN",
      dependencies: [],
    });
  });

  it("derives usable evidence from a successful retry after a failed attempt", () => {
    const failedAttempt = createProviderAttemptTelemetry({
      dependency: "btc", recordedAt: NOW, attempt: 1, durationMs: 4,
      outcome: "FAILURE", freshness: null, failureClass: "NETWORK",
      retryDisposition: "RETRYABLE", isRateLimited: false,
    });
    const successfulRetry = createProviderAttemptTelemetry({
      dependency: "btc", recordedAt: NOW + 5, attempt: 2, durationMs: 3,
      outcome: "SUCCESS", freshness: "WITHIN_THRESHOLD", failureClass: null,
      retryDisposition: null, isRateLimited: false,
    });

    expect(deriveOperationalReadiness([failedAttempt, successfulRetry])).toEqual({
      status: "READY",
      persistence: "UNKNOWN",
      dependencies: [{ dependency: "btc", status: "USABLE" }],
    });
  });

  it("requires terminal unavailable result evidence to derive unavailability", () => {
    const failedAttempts = [1, 2].map((attempt) => createProviderAttemptTelemetry({
      dependency: "btc", recordedAt: NOW + attempt, attempt, durationMs: 1,
      outcome: "FAILURE", freshness: null, failureClass: "PROVIDER_UNAVAILABLE",
      retryDisposition: "RETRYABLE", isRateLimited: false,
    }));
    const terminal = createResultTelemetry({
      dependency: "btc", recordedAt: NOW + 3, outcome: "UNAVAILABLE",
    });

    expect(deriveOperationalReadiness([...failedAttempts, terminal])).toEqual({
      status: "UNAVAILABLE",
      persistence: "UNKNOWN",
      dependencies: [{ dependency: "btc", status: "UNAVAILABLE" }],
    });
  });

  it("derives degraded state from terminal stale fallback after failed attempts", () => {
    const failedAttempt = createProviderAttemptTelemetry({
      dependency: "btc", recordedAt: NOW, attempt: 1, durationMs: 1,
      outcome: "FAILURE", freshness: null, failureClass: "TIMEOUT",
      retryDisposition: "RETRYABLE", isRateLimited: false,
    });
    const terminal = createResultTelemetry({
      dependency: "btc", recordedAt: NOW + 2, outcome: "STALE_FALLBACK",
    });

    expect(deriveOperationalReadiness([failedAttempt, terminal])).toEqual({
      status: "DEGRADED",
      persistence: "UNKNOWN",
      dependencies: [{ dependency: "btc", status: "DEGRADED" }],
    });
  });

  it("keeps terminal result evidence authoritative over earlier attempt evidence", () => {
    const earlierSuccess = createProviderAttemptTelemetry({
      dependency: "btc", recordedAt: NOW, attempt: 1, durationMs: 1,
      outcome: "SUCCESS", freshness: "WITHIN_THRESHOLD", failureClass: null,
      retryDisposition: null, isRateLimited: false,
    });
    const irrelevantFailure = createProviderAttemptTelemetry({
      dependency: "btc", recordedAt: NOW + 2, attempt: 2, durationMs: 1,
      outcome: "FAILURE", freshness: null, failureClass: "NETWORK",
      retryDisposition: "RETRYABLE", isRateLimited: false,
    });
    const terminal = createResultTelemetry({
      dependency: "btc", recordedAt: NOW + 4, outcome: "UNAVAILABLE",
    });

    expect(deriveOperationalReadiness([earlierSuccess, irrelevantFailure, terminal]).status)
      .toBe("UNAVAILABLE");
  });

  it("degrades readiness on persistence rejection without claiming provider outage", () => {
    const snapshot = deriveOperationalReadiness([
      createCacheTelemetry({ dependency: "btc", recordedAt: NOW, outcome: "FRESH_HIT" }),
      createPersistenceTelemetry({
        dependency: "btc", recordedAt: NOW, operation: "RECOVER", outcome: "REJECTED", freshness: null,
      }),
    ]);
    expect(snapshot.status).toBe("DEGRADED");
    expect(snapshot.persistence).toBe("DEGRADED");
    expect(snapshot.dependencies).toEqual([{ dependency: "btc", status: "USABLE" }]);
  });

  it("enforces a finite dependency vocabulary and finite event shapes", () => {
    expect(OPERATIONAL_TELEMETRY_DEPENDENCIES).toHaveLength(10);
    expect(() => createCacheTelemetry({
      dependency: "user-controlled-cardinality",
      recordedAt: NOW,
      outcome: "MISS",
    })).toThrow(/bounded vocabulary/);
    expect(() => createProviderAttemptTelemetry({
      dependency: "btc",
      recordedAt: NOW,
      attempt: 1,
      durationMs: Number.NaN,
      outcome: "SUCCESS",
      freshness: "WITHIN_THRESHOLD",
      failureClass: null,
      retryDisposition: null,
      isRateLimited: false,
    })).toThrow(/durationMs/);
  });

  it("contains no economic-authority or generic metadata fields", () => {
    const event: OperationalTelemetryEvent = createResultTelemetry({
      dependency: "btc", recordedAt: NOW, outcome: "UNAVAILABLE",
    });
    const keys = Object.keys(event);
    for (const forbidden of [
      "permission", "risk", "targetWeights", "fills", "ledger", "executablePrice",
      "actionDecision", "metadata", "url", "body", "error",
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("isolates a throwing sink from provider, retry, and freshness semantics", async () => {
    const throwingSink: OperationalTelemetrySink = { emit: () => { throw new Error("sink unavailable"); } };
    const acquire = vi.fn()
      .mockResolvedValueOnce(acquisition(createUnavailableDatum("btc", { fetchedAt: NOW })))
      .mockResolvedValueOnce(acquisition(live()));

    const result = await load({ acquire, sink: throwingSink });
    expect(result).toEqual(live());
    expect(acquire).toHaveBeenCalledTimes(2);
  });

  it("keeps independently injected sinks bounded and free of global side effects", async () => {
    const left = new InMemoryOperationalTelemetrySink(2);
    const right = new InMemoryOperationalTelemetrySink(2);
    await load({ acquire: async () => acquisition(live()), sink: left });

    expect(left.events().length).toBeGreaterThan(0);
    expect(left.events()).toHaveLength(2);
    expect(right.events()).toEqual([]);
  });
});
