import { describe, expect, it, vi } from "vitest";
import {
  createOperationalProviderFailure,
  createOperationalProviderSuccess,
  createOperationalRequestIdentity,
} from "../operationalProvider";
import {
  BoundedOperationalProviderCache,
  executeWithBoundedOperationalRetry,
} from "../operationalReliability";
import { createDerivedDatum, createLiveDatum, createUnavailableDatum } from "../macro/helpers";
import { fetchDxyDatumV2, type FetchFn } from "../macro/adapters";
import {
  acquireMacroDatumWithEvidence,
  loadReliableMacroDatum,
  type MacroAcquisitionAttempt,
} from "../macro/reliableProvider";
import type { AvailableMacroDatum, MacroDatum } from "../macro/types";

const NOW = Date.parse("2026-09-26T12:00:00.000Z");
const HOUR = 3_600_000;
const identity = createOperationalRequestIdentity({
  providerId: "Provider",
  operationId: "observation",
  publicParameters: { symbol: "BTCUSDT" },
});

function success<T>(data: T, sourceClassification: "LIVE" | "DERIVED" | "SYNTHETIC" = "LIVE") {
  return createOperationalProviderSuccess({
    identity,
    data,
    sourceClassification,
    observedAt: NOW - HOUR,
    retrievedAt: NOW,
    freshnessMaxAgeMs: HOUR,
  });
}

function failure(kind: "NETWORK" | "VALIDATION" | "PROVIDER_UNAVAILABLE" = "NETWORK") {
  return createOperationalProviderFailure({
    identity,
    evidence: { kind },
    occurredAt: NOW,
    diagnostic: { code: "SAFE_FAILURE", message: "Public provider failure" },
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

describe("P15-B operational cache and retry reliability", () => {
  it("preserves identity, provenance, observation time, retrieval time, and data on a fresh cache hit", () => {
    const cache = new BoundedOperationalProviderCache<{ close: number }>(2);
    const original = success({ close: 76_800 });
    cache.write(original);

    const hit = cache.read({ identity, cacheReadAt: NOW, freshnessMaxAgeMs: HOUR });

    expect(hit?.result.identity).toEqual(identity);
    expect(hit?.result.sourceClassification).toBe("LIVE");
    expect(hit?.result.observedAt).toBe(original.observedAt);
    expect(hit?.result.retrievedAt).toBe(original.retrievedAt);
    expect(hit?.result.data).toBe(original.data);
    expect(hit?.cacheReadAt).toBe(NOW);
  });

  it("re-evaluates age at cache-read time so old evidence cannot become fresh", () => {
    const cache = new BoundedOperationalProviderCache<{ close: number }>(1);
    cache.write(success({ close: 76_800 }));

    const hit = cache.read({ identity, cacheReadAt: NOW + 1, freshnessMaxAgeMs: HOUR });

    expect(hit?.result.freshness.status).toBe("STALE");
    expect(hit?.result.freshness.ageMs).toBe(HOUR + 1);
    expect(hit?.result.observedAt).toBe(NOW - HOUR);
  });

  it("never promotes derived or synthetic cached evidence to LIVE", () => {
    const cache = new BoundedOperationalProviderCache<{ value: number }>(2);
    cache.write(success({ value: 1 }, "DERIVED"));
    expect(cache.read({ identity, cacheReadAt: NOW, freshnessMaxAgeMs: HOUR })?.result.sourceClassification)
      .toBe("DERIVED");

    cache.write(success({ value: 2 }, "SYNTHETIC"));
    expect(cache.read({ identity, cacheReadAt: NOW, freshnessMaxAgeMs: HOUR })?.result.sourceClassification)
      .toBe("SYNTHETIC");
  });

  it("is bounded and never caches failure as invented success", () => {
    const cache = new BoundedOperationalProviderCache<number>(1);
    cache.write(success(1));
    cache.write(failure());
    expect(cache.size).toBe(1);

    const secondIdentity = createOperationalRequestIdentity({
      providerId: "Provider",
      operationId: "observation",
      publicParameters: { symbol: "PAXGUSDT" },
    });
    cache.write(createOperationalProviderSuccess({
      identity: secondIdentity,
      data: 2,
      sourceClassification: "LIVE",
      observedAt: NOW,
      retrievedAt: NOW,
      freshnessMaxAgeMs: HOUR,
    }));

    expect(cache.size).toBe(1);
    expect(cache.read({ identity, cacheReadAt: NOW, freshnessMaxAgeMs: HOUR })).toBeNull();
  });

  it("does not retry a terminal failure", async () => {
    const attempt = vi.fn().mockResolvedValue(failure("VALIDATION"));
    const wait = vi.fn().mockResolvedValue(undefined);

    const execution = await executeWithBoundedOperationalRetry({
      attempt,
      policy: { maxAttempts: 3, retryDelayMs: 10 },
      wait,
    });

    expect(execution.attempts).toBe(1);
    expect(execution.result.kind).toBe("FAILURE");
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it("retries retryable failures only to the finite attempt bound", async () => {
    const attempt = vi.fn().mockResolvedValue(failure());
    const wait = vi.fn().mockResolvedValue(undefined);

    const execution = await executeWithBoundedOperationalRetry({
      attempt,
      policy: { maxAttempts: 3, retryDelayMs: 10 },
      wait,
    });

    expect(execution.attempts).toBe(3);
    expect(execution.result.kind).toBe("FAILURE");
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it("returns eventual retry success without changing its provider evidence", async () => {
    const finalSuccess = success({ close: 77_000 });
    const attempt = vi.fn()
      .mockResolvedValueOnce(failure())
      .mockResolvedValueOnce(finalSuccess);

    const execution = await executeWithBoundedOperationalRetry({
      attempt,
      policy: { maxAttempts: 3, retryDelayMs: 0 },
      wait: vi.fn().mockResolvedValue(undefined),
    });

    expect(execution).toEqual({ attempts: 2, result: finalSuccess });
    expect(execution.result.sourceClassification).toBe("LIVE");
  });

  it("respects represented Retry-After without making the test wait", async () => {
    const throttled = createOperationalProviderFailure({
      identity,
      evidence: { kind: "HTTP", statusCode: 429 },
      occurredAt: NOW,
      retryAfter: "7",
      diagnostic: { code: "RATE_LIMITED", message: "Provider throttled request" },
    });
    const wait = vi.fn().mockResolvedValue(undefined);

    await executeWithBoundedOperationalRetry({
      attempt: vi.fn().mockResolvedValueOnce(throttled).mockResolvedValueOnce(success({ close: 1 })),
      policy: { maxAttempts: 2, retryDelayMs: 10 },
      wait,
    });

    expect(wait).toHaveBeenCalledExactlyOnceWith(7_000);
  });

  it("returns secret-safe exhausted failure with no economic-authority capability", async () => {
    const execution = await executeWithBoundedOperationalRetry({
      attempt: async () => failure("PROVIDER_UNAVAILABLE"),
      policy: { maxAttempts: 2, retryDelayMs: 0 },
      wait: async () => undefined,
    });
    const serialized = JSON.stringify(execution);

    expect(execution.result.kind).toBe("FAILURE");
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("Authorization");
    expect(Object.keys(execution.result)).not.toEqual(expect.arrayContaining([
      "permission", "risk", "targetWeights", "fills", "ledger", "actionDecision",
    ]));
  });
});

describe("P15-B active Macro V2 reliability boundary", () => {
  function live(asOf: number, fetchedAt: number) {
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

  it("serves a fresh cache hit without resetting timestamps or calling the provider", async () => {
    const cache = new BoundedOperationalProviderCache<AvailableMacroDatum<number>>(2);
    const acquire = vi.fn().mockResolvedValue(acquisition(live(NOW, NOW)));

    const first = await loadReliableMacroDatum({
      metricId: "btc", freshnessMaxAgeMs: HOUR, referenceTimeMs: NOW, acquire, cache,
      wait: async () => undefined,
    });
    const second = await loadReliableMacroDatum({
      metricId: "btc", freshnessMaxAgeMs: HOUR, referenceTimeMs: NOW + HOUR, acquire, cache,
      wait: async () => undefined,
    });

    expect(acquire).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(second.asOf).toBe(NOW);
    expect(second.fetchedAt).toBe(NOW);
  });

  it("returns visibly stale cached evidence after a bounded provider outage", async () => {
    const cache = new BoundedOperationalProviderCache<AvailableMacroDatum<number>>(2);
    const acquire = vi.fn()
      .mockResolvedValueOnce(acquisition(live(NOW, NOW)))
      .mockResolvedValue(acquisition(createUnavailableDatum("btc", {
        provider: "Binance/Yahoo", instrument: "BTCUSDT/BTC-USD", fetchedAt: NOW + HOUR + 1,
      })));

    await loadReliableMacroDatum({
      metricId: "btc", freshnessMaxAgeMs: HOUR, referenceTimeMs: NOW, acquire, cache,
      wait: async () => undefined,
    });
    const degraded = await loadReliableMacroDatum({
      metricId: "btc", freshnessMaxAgeMs: HOUR, referenceTimeMs: NOW + HOUR + 1, acquire, cache,
      wait: async () => undefined,
    });

    expect(acquire).toHaveBeenCalledTimes(3);
    expect(degraded.status).toBe("AVAILABLE");
    expect(degraded.sourceClassification).toBe("LIVE");
    expect(degraded.quality).toBe("STALE");
    expect(degraded.asOf).toBe(NOW);
    expect(degraded.fetchedAt).toBe(NOW);
  });

  it("returns UNAVAILABLE rather than fabricated data when outage has no cache", async () => {
    const cache = new BoundedOperationalProviderCache<AvailableMacroDatum<number>>(1);
    const unavailable = createUnavailableDatum("btc", {
      provider: "Binance/Yahoo", instrument: "BTCUSDT/BTC-USD", fetchedAt: NOW,
    });
    const acquire = vi.fn().mockResolvedValue(acquisition(unavailable));

    const result = await loadReliableMacroDatum({
      metricId: "btc", freshnessMaxAgeMs: HOUR, referenceTimeMs: NOW, acquire, cache,
      wait: async () => undefined,
    });

    expect(acquire).toHaveBeenCalledTimes(2);
    expect(result).toBe(unavailable);
    expect(result.status).toBe("UNAVAILABLE");
  });

  it("preserves DERIVED provenance through acquisition and cache", async () => {
    const cache = new BoundedOperationalProviderCache<AvailableMacroDatum<number>>(1);
    const derived = createDerivedDatum({
      id: "spread", value: 0.25, provider: "LocalFormula", instrument: "US10Y-US2Y",
      asOf: NOW, fetchedAt: NOW, derivation: { method: "difference", parentIds: ["us10y", "us2y"] },
    });
    const acquire = vi.fn().mockResolvedValue(acquisition(derived));

    await loadReliableMacroDatum({
      metricId: "spread", freshnessMaxAgeMs: HOUR, referenceTimeMs: NOW, acquire, cache,
      wait: async () => undefined,
    });
    const cached = await loadReliableMacroDatum({
      metricId: "spread", freshnessMaxAgeMs: HOUR, referenceTimeMs: NOW + 1, acquire, cache,
      wait: async () => undefined,
    });

    expect(cached.sourceClassification).toBe("DERIVED");
    expect(acquire).toHaveBeenCalledTimes(1);
  });

  it("does not blanket-retry a malformed active Macro acquisition", async () => {
    const cache = new BoundedOperationalProviderCache<AvailableMacroDatum<number>>(1);
    const transport: FetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ chart: { result: [] } }),
    });
    const acquire = vi.fn(async () => acquireMacroDatumWithEvidence({
      acquire: (fetchFn) => fetchDxyDatumV2({ fetchFn, fetchedAt: NOW }),
      transport,
    }));

    const result = await loadReliableMacroDatum({
      metricId: "dxy", freshnessMaxAgeMs: HOUR, referenceTimeMs: NOW, acquire, cache,
      wait: async () => undefined,
    });

    expect(result.status).toBe("UNAVAILABLE");
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("does not retry an active terminal HTTP rejection", async () => {
    const cache = new BoundedOperationalProviderCache<AvailableMacroDatum<number>>(1);
    const transport: FetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    });
    const acquire = vi.fn(async () => acquireMacroDatumWithEvidence({
      acquire: (fetchFn) => fetchDxyDatumV2({ fetchFn, fetchedAt: NOW }),
      transport,
    }));

    await loadReliableMacroDatum({
      metricId: "dxy", freshnessMaxAgeMs: HOUR, referenceTimeMs: NOW, acquire, cache,
      wait: async () => undefined,
    });

    expect(acquire).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([429, 503])("retries active retryable HTTP %i only to the Macro bound", async (status) => {
    const cache = new BoundedOperationalProviderCache<AvailableMacroDatum<number>>(1);
    const transport: FetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status,
      json: async () => ({}),
    });
    const acquire = vi.fn(async () => acquireMacroDatumWithEvidence({
      acquire: (fetchFn) => fetchDxyDatumV2({ fetchFn, fetchedAt: NOW }),
      transport,
    }));
    const wait = vi.fn().mockResolvedValue(undefined);

    const result = await loadReliableMacroDatum({
      metricId: "dxy", freshnessMaxAgeMs: HOUR, referenceTimeMs: NOW, acquire, cache, wait,
    });

    expect(result.status).toBe("UNAVAILABLE");
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledTimes(1);
  });

  it("classifies the final failed page rather than an earlier successful page", async () => {
    const cache = new BoundedOperationalProviderCache<AvailableMacroDatum<number>>(1);
    const transport: FetchFn = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: [] }) })
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: [] }) })
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });
    const acquire = vi.fn(async () => acquireMacroDatumWithEvidence({
      acquire: async (fetchFn) => {
        await fetchFn("/page/1");
        await fetchFn("/page/2");
        return createUnavailableDatum("breadth", {
          provider: "VNDirect",
          instrument: "HOSE_BREADTH",
          fetchedAt: NOW,
        });
      },
      transport,
    }));

    await loadReliableMacroDatum({
      metricId: "breadth", freshnessMaxAgeMs: HOUR, referenceTimeMs: NOW, acquire, cache,
      wait: async () => undefined,
    });

    expect(acquire).toHaveBeenCalledTimes(2);
    expect(transport).toHaveBeenCalledTimes(4);
  });
});
