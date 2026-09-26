// ============================================================================
// FILE: src/lib/operationalProvider.ts
// MODULE: SHARED OPERATIONAL PROVIDER CONTRACT (M15.1A)
// PRINCIPLE: Deterministic transport metadata without economic authority
// ============================================================================

import type { MacroProvenanceClassification } from "./macro/types";

export const OPERATIONAL_PROVIDER_CONTRACT_VERSION = "M15.1A-V1" as const;

export type OperationalProviderProvenance = Exclude<
  MacroProvenanceClassification,
  "UNAVAILABLE"
>;

export type OperationalFreshnessStatus =
  | "WITHIN_THRESHOLD"
  | "STALE"
  | "UNAVAILABLE";

export interface OperationalFreshness {
  readonly status: OperationalFreshnessStatus;
  readonly ageMs: number;
  readonly isStale: boolean;
  readonly maxAgeMs: number;
  readonly evaluatedAt: number;
}

export interface OperationalProviderRequestIdentity {
  readonly providerId: string;
  readonly operationId: string;
  /**
   * Deterministic public request identity. This is not authentication,
   * authorization, a signature, or secret-backed integrity evidence.
   */
  readonly requestId: string;
}

export type PublicRequestIdentityValue = string | number | boolean | null;

export type OperationalProviderFailureClass =
  | "NETWORK"
  | "TIMEOUT"
  | "CANCELLED"
  | "HTTP_REJECTION"
  | "RATE_LIMITED"
  | "PROVIDER_UNAVAILABLE"
  | "MALFORMED_RESPONSE"
  | "VALIDATION"
  | "CONFIGURATION"
  | "INVALID_REQUEST";

export type OperationalRetryDisposition = "RETRYABLE" | "TERMINAL";

/**
 * Public, already-sanitized diagnostic metadata supplied by an adapter.
 *
 * Callers must never pass raw requests, URLs containing secrets, headers,
 * credentials, tokens, cookies, authorization values, or raw provider errors.
 * This shared contract does not inspect or sanitize unknown secret values.
 */
export interface PublicOperationalDiagnostic {
  readonly code: string;
  readonly message: string;
}

export type OperationalFailureEvidence =
  | { readonly kind: "NETWORK" }
  | { readonly kind: "TIMEOUT" }
  | { readonly kind: "CANCELLED" }
  | { readonly kind: "HTTP"; readonly statusCode: number }
  | { readonly kind: "PROVIDER_UNAVAILABLE" }
  | { readonly kind: "MALFORMED_RESPONSE" }
  | { readonly kind: "VALIDATION" }
  | { readonly kind: "CONFIGURATION" }
  | { readonly kind: "INVALID_REQUEST" };

export interface OperationalFailurePolicy {
  readonly failureClass: OperationalProviderFailureClass;
  readonly retryDisposition: OperationalRetryDisposition;
  readonly isRateLimited: boolean;
  readonly isProviderUnavailable: boolean;
  readonly isTimeout: boolean;
  readonly isCancellation: boolean;
}

export interface OperationalProviderSuccess<T> {
  readonly contractVersion: typeof OPERATIONAL_PROVIDER_CONTRACT_VERSION;
  readonly kind: "SUCCESS";
  readonly identity: OperationalProviderRequestIdentity;
  readonly data: T;
  readonly sourceClassification: OperationalProviderProvenance;
  readonly observedAt: number | null;
  readonly retrievedAt: number;
  readonly freshness: OperationalFreshness;
}

export interface OperationalProviderFailure {
  readonly contractVersion: typeof OPERATIONAL_PROVIDER_CONTRACT_VERSION;
  readonly kind: "FAILURE";
  readonly identity: OperationalProviderRequestIdentity;
  readonly sourceClassification: "UNAVAILABLE";
  readonly occurredAt: number;
  readonly failureClass: OperationalProviderFailureClass;
  readonly retryDisposition: OperationalRetryDisposition;
  readonly isRateLimited: boolean;
  readonly isProviderUnavailable: boolean;
  readonly isTimeout: boolean;
  readonly isCancellation: boolean;
  readonly diagnostic: PublicOperationalDiagnostic;
  readonly http: Readonly<{
    readonly statusCode: number;
    readonly retryAfterMs: number | null;
  }> | null;
}

export type OperationalProviderResult<T> =
  | OperationalProviderSuccess<T>
  | OperationalProviderFailure;

export class OperationalProviderContractError extends Error {
  constructor(message: string) {
    super(`[OperationalProvider] ${message}`);
    this.name = "OperationalProviderContractError";
  }
}

const SECRET_BEARING_PARAMETER_KEY =
  /(api.?key|authorization|cookie|credential|password|secret|signature|token)/i;

function requireText(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new OperationalProviderContractError(`${field} must be non-empty.`);
  }
  return normalized;
}

function requireFiniteTimestamp(value: number, field: string): number {
  if (!Number.isFinite(value)) {
    throw new OperationalProviderContractError(`${field} must be finite.`);
  }
  return value;
}

function normalizePublicIdentityValue(
  value: PublicRequestIdentityValue,
  field: string
): string {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new OperationalProviderContractError(`${field} must be finite.`);
  }
  if (value === null) return "null:";
  if (typeof value === "string") return `string:${value}`;
  if (typeof value === "boolean") return `boolean:${value ? "true" : "false"}`;
  return `number:${Object.is(value, -0) ? "-0" : String(value)}`;
}

/**
 * Builds a deterministic identity only from explicitly public parameters.
 * Secret-like parameter names are rejected rather than redacted after use.
 */
export function createOperationalRequestIdentity(input: {
  readonly providerId: string;
  readonly operationId: string;
  readonly publicParameters?: Readonly<Record<string, PublicRequestIdentityValue>>;
}): OperationalProviderRequestIdentity {
  const providerId = requireText(input.providerId, "providerId");
  const operationId = requireText(input.operationId, "operationId");
  const normalizedEntries = Object.entries(input.publicParameters ?? {}).map(([rawKey, value]) => {
    const key = requireText(rawKey, "public parameter key");
    if (SECRET_BEARING_PARAMETER_KEY.test(key)) {
      throw new OperationalProviderContractError(
        `public parameter key "${key}" may contain secret-bearing material.`
      );
    }
    return [key, value] as const;
  });
  const observedKeys = new Set<string>();
  for (const [key] of normalizedEntries) {
    if (observedKeys.has(key)) {
      throw new OperationalProviderContractError(
        `public parameter keys ambiguously normalize to "${key}".`
      );
    }
    observedKeys.add(key);
  }
  normalizedEntries.sort(([left], [right]) => left.localeCompare(right));

  const canonicalParameters = normalizedEntries.map(([key, value]) => {
    const normalizedValue = normalizePublicIdentityValue(value, `publicParameters.${key}`);
    return `${encodeURIComponent(key)}=${encodeURIComponent(normalizedValue)}`;
  });

  const suffix = canonicalParameters.length > 0 ? `?${canonicalParameters.join("&")}` : "";
  return Object.freeze({
    providerId,
    operationId,
    requestId: `${encodeURIComponent(providerId)}/${encodeURIComponent(operationId)}${suffix}`,
  });
}

/**
 * Mirrors Macro V2's freshness boundary semantics without changing its
 * dataset-specific thresholds: age <= maxAgeMs is within threshold, missing
 * evidence is unavailable, and future/invalid source time fails closed.
 * "WITHIN_THRESHOLD" deliberately does not imply LIVE provider provenance.
 */
export function classifyOperationalFreshness(input: {
  readonly observedAt: number | null;
  readonly evaluatedAt: number;
  readonly maxAgeMs: number;
}): OperationalFreshness {
  const { observedAt, evaluatedAt, maxAgeMs } = input;

  if (
    !Number.isFinite(evaluatedAt) ||
    !Number.isFinite(maxAgeMs) ||
    maxAgeMs < 0 ||
    observedAt === null ||
    !Number.isFinite(observedAt)
  ) {
    return Object.freeze({
      status: "UNAVAILABLE",
      ageMs: Number.POSITIVE_INFINITY,
      isStale: true,
      maxAgeMs,
      evaluatedAt,
    });
  }

  const ageMs = evaluatedAt - observedAt;
  if (ageMs < 0) {
    return Object.freeze({
      status: "STALE",
      ageMs,
      isStale: true,
      maxAgeMs,
      evaluatedAt,
    });
  }

  const isStale = ageMs > maxAgeMs;
  return Object.freeze({
    status: isStale ? "STALE" : "WITHIN_THRESHOLD",
    ageMs,
    isStale,
    maxAgeMs,
    evaluatedAt,
  });
}

/**
 * Parses the HTTP Retry-After form deterministically from either delta seconds
 * or an absolute HTTP date. Wall-clock time is never read internally.
 */
export function normalizeRetryAfterMs(
  value: string | number | null | undefined,
  referenceTimeMs: number
): number | null {
  if (!Number.isFinite(referenceTimeMs) || value === null || value === undefined) {
    return null;
  }

  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? value * 1_000 : null;
  }

  const normalized = value.trim();
  if (/^\d+$/.test(normalized)) {
    const seconds = Number(normalized);
    return Number.isSafeInteger(seconds) ? seconds * 1_000 : null;
  }

  const absoluteTimeMs = Date.parse(normalized);
  if (!Number.isFinite(absoluteTimeMs) || absoluteTimeMs < referenceTimeMs) {
    return null;
  }
  return absoluteTimeMs - referenceTimeMs;
}

export function classifyOperationalFailure(
  evidence: OperationalFailureEvidence
): OperationalFailurePolicy {
  if (evidence.kind === "NETWORK") {
    return Object.freeze({
      failureClass: "NETWORK",
      retryDisposition: "RETRYABLE",
      isRateLimited: false,
      isProviderUnavailable: false,
      isTimeout: false,
      isCancellation: false,
    });
  }

  if (evidence.kind === "TIMEOUT") {
    return Object.freeze({
      failureClass: "TIMEOUT",
      retryDisposition: "RETRYABLE",
      isRateLimited: false,
      isProviderUnavailable: false,
      isTimeout: true,
      isCancellation: false,
    });
  }

  if (evidence.kind === "CANCELLED") {
    return Object.freeze({
      failureClass: "CANCELLED",
      retryDisposition: "TERMINAL",
      isRateLimited: false,
      isProviderUnavailable: false,
      isTimeout: false,
      isCancellation: true,
    });
  }

  if (evidence.kind === "PROVIDER_UNAVAILABLE") {
    return Object.freeze({
      failureClass: "PROVIDER_UNAVAILABLE",
      retryDisposition: "RETRYABLE",
      isRateLimited: false,
      isProviderUnavailable: true,
      isTimeout: false,
      isCancellation: false,
    });
  }

  if (evidence.kind === "HTTP") {
    if (!Number.isInteger(evidence.statusCode) || evidence.statusCode < 100 || evidence.statusCode > 599) {
      throw new OperationalProviderContractError("HTTP statusCode must be an integer from 100 through 599.");
    }
    const isRateLimited = evidence.statusCode === 429;
    const isProviderUnavailable = [502, 503, 504].includes(evidence.statusCode);
    const isTimeout = evidence.statusCode === 408;
    const retryable = isRateLimited || isProviderUnavailable || isTimeout || evidence.statusCode >= 500;
    return Object.freeze({
      failureClass: isRateLimited
        ? "RATE_LIMITED"
        : isProviderUnavailable
          ? "PROVIDER_UNAVAILABLE"
          : isTimeout
            ? "TIMEOUT"
            : "HTTP_REJECTION",
      retryDisposition: retryable ? "RETRYABLE" : "TERMINAL",
      isRateLimited,
      isProviderUnavailable,
      isTimeout,
      isCancellation: false,
    });
  }

  return Object.freeze({
    failureClass: evidence.kind,
    retryDisposition: "TERMINAL",
    isRateLimited: false,
    isProviderUnavailable: false,
    isTimeout: false,
    isCancellation: false,
  });
}

export function createOperationalProviderSuccess<T>(input: {
  readonly identity: OperationalProviderRequestIdentity;
  readonly data: T;
  readonly sourceClassification: OperationalProviderProvenance;
  readonly observedAt: number | null;
  readonly retrievedAt: number;
  readonly freshnessMaxAgeMs: number;
}): OperationalProviderSuccess<T> {
  const retrievedAt = requireFiniteTimestamp(input.retrievedAt, "retrievedAt");
  const identity = Object.freeze({
    providerId: requireText(input.identity.providerId, "identity.providerId"),
    operationId: requireText(input.identity.operationId, "identity.operationId"),
    requestId: requireText(input.identity.requestId, "identity.requestId"),
  });
  const freshness = classifyOperationalFreshness({
    observedAt: input.observedAt,
    evaluatedAt: retrievedAt,
    maxAgeMs: input.freshnessMaxAgeMs,
  });

  return Object.freeze({
    contractVersion: OPERATIONAL_PROVIDER_CONTRACT_VERSION,
    kind: "SUCCESS",
    identity,
    data: input.data,
    sourceClassification: input.sourceClassification,
    observedAt: input.observedAt,
    retrievedAt,
    freshness,
  });
}

export function createOperationalProviderFailure(input: {
  readonly identity: OperationalProviderRequestIdentity;
  readonly evidence: OperationalFailureEvidence;
  readonly occurredAt: number;
  readonly diagnostic: PublicOperationalDiagnostic;
  readonly retryAfter?: string | number | null;
}): OperationalProviderFailure {
  const occurredAt = requireFiniteTimestamp(input.occurredAt, "occurredAt");
  const policy = classifyOperationalFailure(input.evidence);
  const identity = Object.freeze({
    providerId: requireText(input.identity.providerId, "identity.providerId"),
    operationId: requireText(input.identity.operationId, "identity.operationId"),
    requestId: requireText(input.identity.requestId, "identity.requestId"),
  });
  const diagnostic = Object.freeze({
    code: requireText(input.diagnostic.code, "diagnostic.code"),
    message: requireText(input.diagnostic.message, "diagnostic.message"),
  });
  const http = input.evidence.kind === "HTTP"
    ? Object.freeze({
        statusCode: input.evidence.statusCode,
        retryAfterMs: normalizeRetryAfterMs(input.retryAfter, occurredAt),
      })
    : null;

  return Object.freeze({
    contractVersion: OPERATIONAL_PROVIDER_CONTRACT_VERSION,
    kind: "FAILURE",
    identity,
    sourceClassification: "UNAVAILABLE",
    occurredAt,
    failureClass: policy.failureClass,
    retryDisposition: policy.retryDisposition,
    isRateLimited: policy.isRateLimited,
    isProviderUnavailable: policy.isProviderUnavailable,
    isTimeout: policy.isTimeout,
    isCancellation: policy.isCancellation,
    diagnostic,
    http,
  });
}

export function isOperationalFailureRetryable(
  failure: OperationalProviderFailure
): boolean {
  return failure.retryDisposition === "RETRYABLE";
}

export function isOperationalRateLimit(
  failure: OperationalProviderFailure
): boolean {
  return failure.isRateLimited;
}

export function isOperationalProviderUnavailable(
  failure: OperationalProviderFailure
): boolean {
  return failure.isProviderUnavailable;
}
