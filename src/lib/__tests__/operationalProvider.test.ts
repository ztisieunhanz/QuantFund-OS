import { describe, expect, it } from "vitest";
import {
  classifyOperationalFailure,
  classifyOperationalFreshness,
  createOperationalProviderFailure,
  createOperationalProviderSuccess,
  createOperationalRequestIdentity,
  isOperationalFailureRetryable,
  isOperationalProviderUnavailable,
  isOperationalRateLimit,
  normalizeRetryAfterMs,
  OperationalProviderContractError,
} from "../operationalProvider";

const RETRIEVED_AT = Date.parse("2026-09-26T12:00:00.000Z");
const ONE_HOUR_MS = 3_600_000;

const identity = createOperationalRequestIdentity({
  providerId: "Binance",
  operationId: "spot-klines",
  publicParameters: {
    interval: "1h",
    limit: 250,
    symbol: "BTCUSDT",
  },
});

describe("M15.1A shared operational provider contract", () => {
  it("constructs deterministic request and success identities", () => {
    const reordered = createOperationalRequestIdentity({
      providerId: "Binance",
      operationId: "spot-klines",
      publicParameters: { symbol: "BTCUSDT", limit: 250, interval: "1h" },
    });
    const first = createOperationalProviderSuccess({
      identity,
      data: { close: 76_800 },
      sourceClassification: "LIVE",
      observedAt: RETRIEVED_AT - ONE_HOUR_MS,
      retrievedAt: RETRIEVED_AT,
      freshnessMaxAgeMs: ONE_HOUR_MS,
    });
    const second = createOperationalProviderSuccess({
      identity: reordered,
      data: { close: 76_800 },
      sourceClassification: "LIVE",
      observedAt: RETRIEVED_AT - ONE_HOUR_MS,
      retrievedAt: RETRIEVED_AT,
      freshnessMaxAgeMs: ONE_HOUR_MS,
    });

    expect(reordered).toEqual(identity);
    expect(second).toEqual(first);
    expect(first.kind).toBe("SUCCESS");
    expect(first.freshness.status).toBe("WITHIN_THRESHOLD");
    expect(first.freshness.ageMs).toBe(ONE_HOUR_MS);
  });

  it("preserves primitive public-parameter types in request identity", () => {
    const requestIdFor = (value: string | number | boolean | null) =>
      createOperationalRequestIdentity({
        providerId: "Provider",
        operationId: "operation",
        publicParameters: { value },
      }).requestId;

    expect(requestIdFor(1)).not.toBe(requestIdFor("1"));
    expect(requestIdFor(true)).not.toBe(requestIdFor("true"));
    expect(requestIdFor(null)).not.toBe(requestIdFor("null"));
  });

  it("rejects public parameter keys that ambiguously normalize", () => {
    expect(() => createOperationalRequestIdentity({
      providerId: "Provider",
      operationId: "operation",
      publicParameters: { " symbol": "BTCUSDT", symbol: "PAXGUSDT" },
    })).toThrow(/ambiguously normalize/);
  });

  it("constructs deterministic failures from public diagnostics without raw transport fields", () => {
    const failure = createOperationalProviderFailure({
      identity,
      evidence: { kind: "NETWORK" },
      occurredAt: RETRIEVED_AT,
      diagnostic: { code: "FETCH_FAILED", message: "Provider transport failed" },
    });

    expect(failure).toEqual(createOperationalProviderFailure({
      identity,
      evidence: { kind: "NETWORK" },
      occurredAt: RETRIEVED_AT,
      diagnostic: { code: "FETCH_FAILED", message: "Provider transport failed" },
    }));
    expect(failure.kind).toBe("FAILURE");
    expect(failure.sourceClassification).toBe("UNAVAILABLE");
    expect(failure.http).toBeNull();
    expect(Object.keys(failure)).not.toContain("url");
    expect(Object.keys(failure)).not.toContain("headers");
    expect(Object.keys(failure)).not.toContain("request");
    expect(Object.keys(failure)).not.toContain("credentials");
    expect(Object.keys(failure)).not.toContain("token");
  });

  it("classifies retryable transport and terminal validation failures", () => {
    expect(classifyOperationalFailure({ kind: "NETWORK" }).retryDisposition).toBe("RETRYABLE");
    expect(classifyOperationalFailure({ kind: "MALFORMED_RESPONSE" }).retryDisposition).toBe("TERMINAL");
    expect(classifyOperationalFailure({ kind: "VALIDATION" }).retryDisposition).toBe("TERMINAL");
    expect(classifyOperationalFailure({ kind: "CONFIGURATION" }).retryDisposition).toBe("TERMINAL");
    expect(classifyOperationalFailure({ kind: "INVALID_REQUEST" }).retryDisposition).toBe("TERMINAL");
  });

  it("classifies HTTP rate limits as retryable throttling", () => {
    const failure = createOperationalProviderFailure({
      identity,
      evidence: { kind: "HTTP", statusCode: 429 },
      occurredAt: RETRIEVED_AT,
      retryAfter: "15",
      diagnostic: { code: "HTTP_429", message: "Provider rate limit" },
    });

    expect(failure.failureClass).toBe("RATE_LIMITED");
    expect(isOperationalRateLimit(failure)).toBe(true);
    expect(isOperationalFailureRetryable(failure)).toBe(true);
    expect(failure.http).toEqual({ statusCode: 429, retryAfterMs: 15_000 });
  });

  it("classifies provider outage status without treating every HTTP rejection as outage", () => {
    const unavailable = createOperationalProviderFailure({
      identity,
      evidence: { kind: "HTTP", statusCode: 503 },
      occurredAt: RETRIEVED_AT,
      diagnostic: { code: "HTTP_503", message: "Provider unavailable" },
    });
    const rejected = createOperationalProviderFailure({
      identity,
      evidence: { kind: "HTTP", statusCode: 401 },
      occurredAt: RETRIEVED_AT,
      diagnostic: { code: "HTTP_401", message: "Provider rejected request" },
    });

    expect(unavailable.failureClass).toBe("PROVIDER_UNAVAILABLE");
    expect(isOperationalProviderUnavailable(unavailable)).toBe(true);
    expect(isOperationalFailureRetryable(unavailable)).toBe(true);
    expect(rejected.failureClass).toBe("HTTP_REJECTION");
    expect(isOperationalProviderUnavailable(rejected)).toBe(false);
    expect(isOperationalFailureRetryable(rejected)).toBe(false);
  });

  it("distinguishes timeout from cancellation", () => {
    const timeout = classifyOperationalFailure({ kind: "TIMEOUT" });
    const cancellation = classifyOperationalFailure({ kind: "CANCELLED" });

    expect(timeout).toMatchObject({
      failureClass: "TIMEOUT",
      retryDisposition: "RETRYABLE",
      isTimeout: true,
      isCancellation: false,
    });
    expect(cancellation).toMatchObject({
      failureClass: "CANCELLED",
      retryDisposition: "TERMINAL",
      isTimeout: false,
      isCancellation: true,
    });
  });

  it("keeps malformed provider responses distinct and terminal", () => {
    expect(classifyOperationalFailure({ kind: "MALFORMED_RESPONSE" })).toEqual({
      failureClass: "MALFORMED_RESPONSE",
      retryDisposition: "TERMINAL",
      isRateLimited: false,
      isProviderUnavailable: false,
      isTimeout: false,
      isCancellation: false,
    });
  });

  it("normalizes valid Retry-After evidence and rejects invalid or past values", () => {
    expect(normalizeRetryAfterMs(3, RETRIEVED_AT)).toBe(3_000);
    expect(normalizeRetryAfterMs("12", RETRIEVED_AT)).toBe(12_000);
    expect(normalizeRetryAfterMs("Sat, 26 Sep 2026 12:01:00 GMT", RETRIEVED_AT)).toBe(60_000);
    expect(normalizeRetryAfterMs("-1", RETRIEVED_AT)).toBeNull();
    expect(normalizeRetryAfterMs("invalid", RETRIEVED_AT)).toBeNull();
    expect(normalizeRetryAfterMs("Sat, 26 Sep 2026 11:59:00 GMT", RETRIEVED_AT)).toBeNull();
  });

  it("matches the existing Macro V2 freshness boundary and fails closed", () => {
    expect(classifyOperationalFreshness({
      observedAt: RETRIEVED_AT - ONE_HOUR_MS,
      evaluatedAt: RETRIEVED_AT,
      maxAgeMs: ONE_HOUR_MS,
    }).status).toBe("WITHIN_THRESHOLD");
    expect(classifyOperationalFreshness({
      observedAt: RETRIEVED_AT - ONE_HOUR_MS - 1,
      evaluatedAt: RETRIEVED_AT,
      maxAgeMs: ONE_HOUR_MS,
    }).status).toBe("STALE");
    expect(classifyOperationalFreshness({
      observedAt: null,
      evaluatedAt: RETRIEVED_AT,
      maxAgeMs: ONE_HOUR_MS,
    }).status).toBe("UNAVAILABLE");
    expect(classifyOperationalFreshness({
      observedAt: RETRIEVED_AT + 1,
      evaluatedAt: RETRIEVED_AT,
      maxAgeMs: ONE_HOUR_MS,
    }).status).toBe("STALE");
  });

  it("preserves synthetic and derived provenance without live promotion", () => {
    const synthetic = createOperationalProviderSuccess({
      identity,
      data: { close: 76_800 },
      sourceClassification: "SYNTHETIC",
      observedAt: RETRIEVED_AT,
      retrievedAt: RETRIEVED_AT,
      freshnessMaxAgeMs: ONE_HOUR_MS,
    });
    const derived = createOperationalProviderSuccess({
      identity,
      data: { spread: 0.28 },
      sourceClassification: "DERIVED",
      observedAt: RETRIEVED_AT,
      retrievedAt: RETRIEVED_AT,
      freshnessMaxAgeMs: ONE_HOUR_MS,
    });

    expect(synthetic.sourceClassification).toBe("SYNTHETIC");
    expect(derived.sourceClassification).toBe("DERIVED");
    expect(synthetic.freshness.status).toBe("WITHIN_THRESHOLD");
    expect(derived.freshness.status).toBe("WITHIN_THRESHOLD");
  });

  it("rejects secret-bearing identity keys instead of embedding or redacting them", () => {
    expect(() => createOperationalRequestIdentity({
      providerId: "Provider",
      operationId: "quotes",
      publicParameters: { apiKey: "must-not-enter-identity" },
    })).toThrow(OperationalProviderContractError);
    expect(() => createOperationalRequestIdentity({
      providerId: "Provider",
      operationId: "quotes",
      publicParameters: { authorizationToken: "must-not-enter-identity" },
    })).toThrow(OperationalProviderContractError);
  });

  it("keeps authority-shaped objects untouched and exposes no authority fields", () => {
    const authorityFixture = Object.freeze({
      targetWeights: Object.freeze({ BTC: 0.5 }),
      fills: Object.freeze([{ quantity: 1 }]),
      cash: 10_000,
      action: "WAIT",
      lifecycleTransition: "NONE",
    });
    const before = JSON.stringify(authorityFixture);

    classifyOperationalFailure({ kind: "NETWORK" });
    classifyOperationalFreshness({
      observedAt: RETRIEVED_AT,
      evaluatedAt: RETRIEVED_AT,
      maxAgeMs: ONE_HOUR_MS,
    });

    expect(JSON.stringify(authorityFixture)).toBe(before);
    expect(Object.keys(createOperationalProviderFailure({
      identity,
      evidence: { kind: "CANCELLED" },
      occurredAt: RETRIEVED_AT,
      diagnostic: { code: "ABORTED", message: "Caller cancelled operation" },
    }))).toEqual([
      "contractVersion",
      "kind",
      "identity",
      "sourceClassification",
      "occurredAt",
      "failureClass",
      "retryDisposition",
      "isRateLimited",
      "isProviderUnavailable",
      "isTimeout",
      "isCancellation",
      "diagnostic",
      "http",
    ]);
  });

  it("rejects malformed HTTP classification inputs deterministically", () => {
    expect(() => classifyOperationalFailure({ kind: "HTTP", statusCode: 99 }))
      .toThrow(OperationalProviderContractError);
    expect(() => classifyOperationalFailure({ kind: "HTTP", statusCode: 600 }))
      .toThrow(OperationalProviderContractError);
  });
});
