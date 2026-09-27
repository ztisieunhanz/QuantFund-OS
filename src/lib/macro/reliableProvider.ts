import {
  classifyOperationalFailure,
  createOperationalProviderFailure,
  createOperationalProviderSuccess,
  createOperationalRequestIdentity,
  type OperationalFailureEvidence,
  type OperationalProviderRequestIdentity,
} from "../operationalProvider";
import {
  BoundedOperationalProviderCache,
  executeWithBoundedOperationalRetry,
  type OperationalWait,
} from "../operationalReliability";
import { BoundedOperationalDurableStore } from "../operationalPersistence";
import type { FetchFn, FetchResponse } from "./adapters";
import type { AvailableMacroDatum, MacroDatum, UnavailableMacroDatum } from "./types";

export const MACRO_PROVIDER_RETRY_MAX_ATTEMPTS = 2;
export const MACRO_PROVIDER_RETRY_DELAY_MS = 250;
export const MACRO_PROVIDER_CACHE_MAX_ENTRIES = 32;
export const MACRO_PROVIDER_DURABLE_STORAGE_KEY = "quant_macro_operational_cache_v1";

export interface ReliableMacroDatumOptions<T> {
  readonly metricId: string;
  readonly freshnessMaxAgeMs: number;
  readonly referenceTimeMs: number;
  readonly acquire: (attemptNumber: number) => Promise<MacroAcquisitionAttempt<T>>;
  readonly cache: BoundedOperationalProviderCache<AvailableMacroDatum<T>>;
  readonly durableStore?: BoundedOperationalDurableStore<AvailableMacroDatum<T>>;
  readonly wait?: OperationalWait;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isFiniteNumberOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function parseMacroValue(id: string, value: unknown): unknown | null {
  if (["dxy", "us2y", "us10y", "vix", "gold", "btc", "vnindex"].includes(id)) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }
  if (!isPlainRecord(value)) return null;
  if (id === "breadth" && hasExactKeys(value, [
    "advancing", "declining", "unchanged", "adRatio", "pctAboveMA20", "pctAboveMA50", "pctAboveMA200",
  ])) {
    if (
      typeof value.advancing === "number" && Number.isFinite(value.advancing) &&
      typeof value.declining === "number" && Number.isFinite(value.declining) &&
      typeof value.unchanged === "number" && Number.isFinite(value.unchanged) &&
      isFiniteNumberOrNull(value.adRatio) && isFiniteNumberOrNull(value.pctAboveMA20) &&
      isFiniteNumberOrNull(value.pctAboveMA50) && isFiniteNumberOrNull(value.pctAboveMA200)
    ) return Object.freeze({ ...value });
  }
  if (id === "liquidity" && hasExactKeys(value, [
    "matchingValueBillion", "ma20ValueBillion", "ratioToMa20", "status",
  ])) {
    if (
      typeof value.matchingValueBillion === "number" && Number.isFinite(value.matchingValueBillion) &&
      typeof value.ma20ValueBillion === "number" && Number.isFinite(value.ma20ValueBillion) &&
      typeof value.ratioToMa20 === "number" && Number.isFinite(value.ratioToMa20) &&
      (value.status === null || value.status === "EXPANDING" || value.status === "CONTRACTING" || value.status === "NORMAL")
    ) return Object.freeze({ ...value });
  }
  if (id === "foreignFlow" && hasExactKeys(value, ["net1dBillion", "net5dBillion", "status"])) {
    if (
      typeof value.net1dBillion === "number" && Number.isFinite(value.net1dBillion) &&
      typeof value.net5dBillion === "number" && Number.isFinite(value.net5dBillion) &&
      (value.status === null || value.status === "NET_BUYING" || value.status === "NET_SELLING" || value.status === "NEUTRAL")
    ) return Object.freeze({ ...value });
  }
  return null;
}

export function parsePersistedMacroDatum(value: unknown): AvailableMacroDatum<unknown> | null {
  if (!isPlainRecord(value) || !hasExactKeys(value, [
    "status", "id", "value", "sourceClassification", "provider", "instrument",
    "asOf", "fetchedAt", "quality", "basis", "derivation",
  ])) return null;
  if (value.status !== "AVAILABLE" || typeof value.id !== "string") return null;
  const parsedValue = parseMacroValue(value.id, value.value);
  if (parsedValue === null) return null;
  if (
    typeof value.provider !== "string" || value.provider.trim().length === 0 ||
    typeof value.instrument !== "string" || value.instrument.trim().length === 0 ||
    typeof value.asOf !== "number" || !Number.isFinite(value.asOf) || value.asOf <= 0 ||
    typeof value.fetchedAt !== "number" || !Number.isFinite(value.fetchedAt) || value.fetchedAt <= 0 ||
    value.asOf > value.fetchedAt ||
    !["USABLE", "DEGRADED", "STALE"].includes(String(value.quality)) ||
    !(value.basis === null || typeof value.basis === "string")
  ) return null;
  if (!["LIVE", "DERIVED", "SYNTHETIC", "HARDCODED"].includes(String(value.sourceClassification))) {
    return null;
  }

  if (value.sourceClassification === "DERIVED") {
    if (!isPlainRecord(value.derivation)) return null;
    const derivationKeys = Object.keys(value.derivation);
    if (!derivationKeys.every((key) => ["method", "parentIds", "parameters"].includes(key))) return null;
    if (
      typeof value.derivation.method !== "string" || value.derivation.method.trim().length === 0 ||
      !Array.isArray(value.derivation.parentIds) ||
      !value.derivation.parentIds.every((item) => typeof item === "string" && item.trim().length > 0)
    ) return null;
    const parameters = value.derivation.parameters;
    if (parameters !== undefined && parameters !== null) {
      if (!isPlainRecord(parameters)) return null;
      for (const [key, parameter] of Object.entries(parameters)) {
        if (
          key.trim().length === 0 ||
          /(api.?key|authorization|cookie|credential|password|secret|signature|token)/i.test(key) ||
          !(
            typeof parameter === "string" || typeof parameter === "boolean" ||
            (typeof parameter === "number" && Number.isFinite(parameter))
          )
        ) return null;
      }
    }
  } else if (value.derivation !== null) {
    return null;
  }

  return Object.freeze({ ...value, value: parsedValue }) as AvailableMacroDatum<unknown>;
}

export type MacroAcquisitionAttempt<T> =
  | Readonly<{
      readonly datum: AvailableMacroDatum<T>;
      readonly failure: null;
    }>
  | Readonly<{
      readonly datum: UnavailableMacroDatum;
      readonly failure: Readonly<{
        readonly evidence: OperationalFailureEvidence;
        readonly diagnosticCode: string;
        readonly diagnosticMessage: string;
      }>;
    }>;

interface MacroTransportTrace {
  lastOutcome: OperationalFailureEvidence | "SUCCESSFUL_HTTP" | null;
}

const defaultMacroFetch: FetchFn = async (url: string): Promise<FetchResponse> => {
  const response = await globalThis.fetch(url);
  return {
    ok: response.ok,
    status: response.status,
    json: () => response.json(),
  };
};

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : typeof error === "object" && error !== null &&
      "name" in error && (error as { readonly name?: unknown }).name === "AbortError";
}

function createTrackedFetch(
  trace: MacroTransportTrace,
  transport: FetchFn
): FetchFn {
  return async (url) => {
    let response: FetchResponse;
    try {
      response = await transport(url);
    } catch (error) {
      trace.lastOutcome = { kind: isAbortError(error) ? "CANCELLED" : "NETWORK" };
      throw error;
    }

    if (response.ok) {
      trace.lastOutcome = "SUCCESSFUL_HTTP";
    } else {
      trace.lastOutcome = { kind: "HTTP", statusCode: response.status };
    }

    return {
      ok: response.ok,
      status: response.status,
      json: async () => {
        try {
          return await response.json();
        } catch (error) {
          trace.lastOutcome = { kind: "MALFORMED_RESPONSE" };
          throw error;
        }
      },
    };
  };
}

function selectFailureEvidence(trace: MacroTransportTrace): OperationalFailureEvidence {
  if (trace.lastOutcome === "SUCCESSFUL_HTTP") return { kind: "MALFORMED_RESPONSE" };
  return trace.lastOutcome ?? { kind: "VALIDATION" };
}

function diagnosticFor(evidence: OperationalFailureEvidence): {
  readonly diagnosticCode: string;
  readonly diagnosticMessage: string;
} {
  const failureClass = classifyOperationalFailure(evidence).failureClass;
  return Object.freeze({
    diagnosticCode: `MACRO_${failureClass}`,
    diagnosticMessage: "Current macro provider acquisition failed.",
  });
}

/**
 * Runs an active Macro adapter through a sanitized transport trace. The trace
 * records only canonical failure evidence: never URLs, headers, credentials,
 * raw payloads, or raw exceptions.
 */
export async function acquireMacroDatumWithEvidence<T>(input: {
  readonly acquire: (fetchFn: FetchFn) => Promise<MacroDatum<T>>;
  readonly transport?: FetchFn;
}): Promise<MacroAcquisitionAttempt<T>> {
  const trace: MacroTransportTrace = { lastOutcome: null };
  const datum = await input.acquire(createTrackedFetch(trace, input.transport ?? defaultMacroFetch));
  if (datum.status === "AVAILABLE") {
    return Object.freeze({ datum, failure: null });
  }

  const evidence = selectFailureEvidence(trace);
  return Object.freeze({
    datum,
    failure: Object.freeze({ evidence, ...diagnosticFor(evidence) }),
  });
}

export function macroIdentity(metricId: string): OperationalProviderRequestIdentity {
  return createOperationalRequestIdentity({
    providerId: "MacroV2Adapter",
    operationId: "current-observation",
    publicParameters: { metricId },
  });
}

function markCachedDatumStale<T>(datum: AvailableMacroDatum<T>): AvailableMacroDatum<T> {
  return Object.freeze({ ...datum, quality: "STALE" });
}

/**
 * Reliability wrapper for active Macro V2 reads. Fresh cache hits avoid a
 * provider call. Stale cache evidence triggers bounded acquisition; it is used
 * only as visibly STALE evidence if all retryable attempts fail.
 */
export async function loadReliableMacroDatum<T>(
  options: ReliableMacroDatumOptions<T>
): Promise<MacroDatum<T>> {
  const identity = macroIdentity(options.metricId);
  let cached = options.cache.read({
    identity,
    cacheReadAt: options.referenceTimeMs,
    freshnessMaxAgeMs: options.freshnessMaxAgeMs,
  });

  if (cached === null && options.durableStore !== undefined) {
    const recovered = options.durableStore.recover({
      identity,
      recoveredAt: options.referenceTimeMs,
      freshnessMaxAgeMs: options.freshnessMaxAgeMs,
    });
    if (recovered !== null) {
      options.cache.write(recovered);
      cached = options.cache.read({
        identity,
        cacheReadAt: options.referenceTimeMs,
        freshnessMaxAgeMs: options.freshnessMaxAgeMs,
      });
    }
  }

  if (cached?.result.freshness.status === "WITHIN_THRESHOLD") {
    return cached.result.data;
  }

  let finalUnavailable: MacroDatum<T> | null = null;
  const execution = await executeWithBoundedOperationalRetry({
    policy: {
      maxAttempts: MACRO_PROVIDER_RETRY_MAX_ATTEMPTS,
      retryDelayMs: MACRO_PROVIDER_RETRY_DELAY_MS,
    },
    wait: options.wait,
    attempt: async (attemptNumber) => {
      const acquisition = await options.acquire(attemptNumber);
      if (acquisition.failure === null) {
        const datum = acquisition.datum;
        return createOperationalProviderSuccess({
          identity,
          data: datum,
          sourceClassification: datum.sourceClassification,
          observedAt: datum.asOf,
          retrievedAt: datum.fetchedAt,
          freshnessMaxAgeMs: options.freshnessMaxAgeMs,
        });
      }

      const datum = acquisition.datum;
      finalUnavailable = datum;
      return createOperationalProviderFailure({
        identity,
        evidence: acquisition.failure.evidence,
        occurredAt: options.referenceTimeMs,
        diagnostic: {
          code: acquisition.failure.diagnosticCode,
          message: acquisition.failure.diagnosticMessage,
        },
      });
    },
  });

  if (execution.result.kind === "SUCCESS") {
    options.cache.write(execution.result);
    options.durableStore?.persist(execution.result);
    return execution.result.data;
  }

  if (cached !== null) {
    return markCachedDatumStale(cached.result.data);
  }

  if (finalUnavailable === null) {
    throw new Error("Macro provider reliability execution produced no datum.");
  }
  return finalUnavailable;
}
