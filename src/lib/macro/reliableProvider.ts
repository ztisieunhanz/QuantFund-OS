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
import type { FetchFn, FetchResponse } from "./adapters";
import type { AvailableMacroDatum, MacroDatum, UnavailableMacroDatum } from "./types";

export const MACRO_PROVIDER_RETRY_MAX_ATTEMPTS = 2;
export const MACRO_PROVIDER_RETRY_DELAY_MS = 250;
export const MACRO_PROVIDER_CACHE_MAX_ENTRIES = 32;

export interface ReliableMacroDatumOptions<T> {
  readonly metricId: string;
  readonly freshnessMaxAgeMs: number;
  readonly referenceTimeMs: number;
  readonly acquire: (attemptNumber: number) => Promise<MacroAcquisitionAttempt<T>>;
  readonly cache: BoundedOperationalProviderCache<AvailableMacroDatum<T>>;
  readonly wait?: OperationalWait;
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

function macroIdentity(metricId: string): OperationalProviderRequestIdentity {
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
  const cached = options.cache.read({
    identity,
    cacheReadAt: options.referenceTimeMs,
    freshnessMaxAgeMs: options.freshnessMaxAgeMs,
  });

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
