import type {
  OperationalFreshnessStatus,
  OperationalProviderFailureClass,
  OperationalRetryDisposition,
} from "./operationalProvider";

export const OPERATIONAL_TELEMETRY_CONTRACT_VERSION = "P15-D-V1" as const;

export const OPERATIONAL_TELEMETRY_DEPENDENCIES = Object.freeze([
  "dxy",
  "us2y",
  "us10y",
  "vix",
  "gold",
  "btc",
  "vnindex",
  "breadth",
  "liquidity",
  "foreignFlow",
] as const);

export type OperationalTelemetryDependency =
  typeof OPERATIONAL_TELEMETRY_DEPENDENCIES[number];

export type OperationalCacheTelemetryOutcome =
  | "MISS"
  | "FRESH_HIT"
  | "STALE_HIT"
  | "RECOVERED_FRESH"
  | "RECOVERED_STALE";

export type OperationalPersistenceTelemetryOutcome =
  | "RECOVERED"
  | "WRITTEN"
  | "UNCHANGED"
  | "MISS"
  | "REJECTED"
  | "FAILED";

interface OperationalTelemetryBase {
  readonly contractVersion: typeof OPERATIONAL_TELEMETRY_CONTRACT_VERSION;
  readonly provider: "MACRO_V2";
  readonly dependency: OperationalTelemetryDependency;
  readonly recordedAt: number;
}

export interface OperationalProviderAttemptTelemetry extends OperationalTelemetryBase {
  readonly eventType: "PROVIDER_ATTEMPT";
  readonly attempt: number;
  readonly durationMs: number;
  readonly outcome: "SUCCESS" | "FAILURE";
  readonly freshness: OperationalFreshnessStatus | null;
  readonly failureClass: OperationalProviderFailureClass | null;
  readonly retryDisposition: OperationalRetryDisposition | null;
  readonly isRateLimited: boolean;
}

export interface OperationalCacheTelemetry extends OperationalTelemetryBase {
  readonly eventType: "CACHE_ACCESS";
  readonly outcome: OperationalCacheTelemetryOutcome;
}

export interface OperationalPersistenceTelemetry extends OperationalTelemetryBase {
  readonly eventType: "PERSISTENCE";
  readonly operation: "RECOVER" | "WRITE";
  readonly outcome: OperationalPersistenceTelemetryOutcome;
  readonly freshness: OperationalFreshnessStatus | null;
}

export interface OperationalResultTelemetry extends OperationalTelemetryBase {
  readonly eventType: "RESULT";
  readonly outcome: "STALE_FALLBACK" | "UNAVAILABLE";
}

export type OperationalTelemetryEvent =
  | OperationalProviderAttemptTelemetry
  | OperationalCacheTelemetry
  | OperationalPersistenceTelemetry
  | OperationalResultTelemetry;

export interface OperationalTelemetrySink {
  readonly emit: (event: OperationalTelemetryEvent) => void;
}

export interface OperationalTelemetryClock {
  readonly now: () => number;
}

function requireFiniteNonNegative(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Operational telemetry ${field} must be finite and non-negative.`);
  }
  return value;
}

function requireDependency(value: string): OperationalTelemetryDependency {
  if (!(OPERATIONAL_TELEMETRY_DEPENDENCIES as readonly string[]).includes(value)) {
    throw new Error("Operational telemetry dependency is outside the bounded vocabulary.");
  }
  return value as OperationalTelemetryDependency;
}

function base(input: {
  readonly dependency: string;
  readonly recordedAt: number;
}): OperationalTelemetryBase {
  return {
    contractVersion: OPERATIONAL_TELEMETRY_CONTRACT_VERSION,
    provider: "MACRO_V2",
    dependency: requireDependency(input.dependency),
    recordedAt: requireFiniteNonNegative(input.recordedAt, "recordedAt"),
  };
}

export function createProviderAttemptTelemetry(input: {
  readonly dependency: string;
  readonly recordedAt: number;
  readonly attempt: number;
  readonly durationMs: number;
  readonly outcome: "SUCCESS" | "FAILURE";
  readonly freshness: OperationalFreshnessStatus | null;
  readonly failureClass: OperationalProviderFailureClass | null;
  readonly retryDisposition: OperationalRetryDisposition | null;
  readonly isRateLimited: boolean;
}): OperationalProviderAttemptTelemetry {
  if (!Number.isInteger(input.attempt) || input.attempt < 1) {
    throw new Error("Operational telemetry attempt must be a positive integer.");
  }
  const success = input.outcome === "SUCCESS";
  if (
    (success && (input.freshness === null || input.failureClass !== null || input.retryDisposition !== null || input.isRateLimited)) ||
    (!success && (input.freshness !== null || input.failureClass === null || input.retryDisposition === null))
  ) {
    throw new Error("Operational telemetry provider outcome fields are inconsistent.");
  }
  return Object.freeze({
    ...base(input),
    eventType: "PROVIDER_ATTEMPT",
    attempt: input.attempt,
    durationMs: requireFiniteNonNegative(input.durationMs, "durationMs"),
    outcome: input.outcome,
    freshness: input.freshness,
    failureClass: input.failureClass,
    retryDisposition: input.retryDisposition,
    isRateLimited: input.isRateLimited,
  });
}

export function createCacheTelemetry(input: {
  readonly dependency: string;
  readonly recordedAt: number;
  readonly outcome: OperationalCacheTelemetryOutcome;
}): OperationalCacheTelemetry {
  return Object.freeze({ ...base(input), eventType: "CACHE_ACCESS", outcome: input.outcome });
}

export function createPersistenceTelemetry(input: {
  readonly dependency: string;
  readonly recordedAt: number;
  readonly operation: "RECOVER" | "WRITE";
  readonly outcome: OperationalPersistenceTelemetryOutcome;
  readonly freshness: OperationalFreshnessStatus | null;
}): OperationalPersistenceTelemetry {
  return Object.freeze({
    ...base(input),
    eventType: "PERSISTENCE",
    operation: input.operation,
    outcome: input.outcome,
    freshness: input.freshness,
  });
}

export function createResultTelemetry(input: {
  readonly dependency: string;
  readonly recordedAt: number;
  readonly outcome: "STALE_FALLBACK" | "UNAVAILABLE";
}): OperationalResultTelemetry {
  return Object.freeze({ ...base(input), eventType: "RESULT", outcome: input.outcome });
}

/** Telemetry transport is deliberately failure-isolated from operational semantics. */
export function emitOperationalTelemetry(
  sink: OperationalTelemetrySink | undefined,
  createEvent: () => OperationalTelemetryEvent
): void {
  if (sink === undefined) return;
  try {
    sink.emit(createEvent());
  } catch {
    // An observational destination must never become an availability dependency.
  }
}

export class InMemoryOperationalTelemetrySink implements OperationalTelemetrySink {
  readonly maxEvents: number;
  private readonly retained: OperationalTelemetryEvent[] = [];

  constructor(maxEvents = 256) {
    if (!Number.isInteger(maxEvents) || maxEvents < 1) {
      throw new Error("Operational telemetry maxEvents must be a positive integer.");
    }
    this.maxEvents = maxEvents;
  }

  emit(event: OperationalTelemetryEvent): void {
    this.retained.push(event);
    if (this.retained.length > this.maxEvents) this.retained.shift();
  }

  events(): readonly OperationalTelemetryEvent[] {
    return Object.freeze([...this.retained]);
  }
}

export type OperationalDependencyReadiness = "USABLE" | "DEGRADED" | "UNAVAILABLE";
export type OperationalReadinessStatus = "READY" | "DEGRADED" | "UNAVAILABLE" | "UNKNOWN";

export interface OperationalReadinessSnapshot {
  readonly status: OperationalReadinessStatus;
  readonly persistence: "HEALTHY" | "DEGRADED" | "UNKNOWN";
  readonly dependencies: readonly Readonly<{
    dependency: OperationalTelemetryDependency;
    status: OperationalDependencyReadiness;
  }>[];
}

/** Derives readiness only from supplied observations; it performs no acquisition or probing. */
export function deriveOperationalReadiness(
  events: readonly OperationalTelemetryEvent[]
): OperationalReadinessSnapshot {
  const dependencies = new Map<OperationalTelemetryDependency, OperationalDependencyReadiness>();
  let persistence: OperationalReadinessSnapshot["persistence"] = "UNKNOWN";

  for (const event of events) {
    if (event.eventType === "PROVIDER_ATTEMPT") {
      if (event.outcome === "SUCCESS") {
        dependencies.set(
          event.dependency,
          event.freshness === "WITHIN_THRESHOLD" ? "USABLE" : "DEGRADED"
        );
      }
    } else if (event.eventType === "CACHE_ACCESS") {
      if (event.outcome === "FRESH_HIT" || event.outcome === "RECOVERED_FRESH") {
        dependencies.set(event.dependency, "USABLE");
      } else if (event.outcome === "STALE_HIT" || event.outcome === "RECOVERED_STALE") {
        dependencies.set(event.dependency, "DEGRADED");
      }
    } else if (event.eventType === "RESULT") {
      dependencies.set(
        event.dependency,
        event.outcome === "STALE_FALLBACK" ? "DEGRADED" : "UNAVAILABLE"
      );
    } else if (event.outcome === "RECOVERED" || event.outcome === "WRITTEN" || event.outcome === "UNCHANGED") {
      persistence = "HEALTHY";
    } else if (event.outcome === "REJECTED" || event.outcome === "FAILED") {
      persistence = "DEGRADED";
    }
  }

  const ordered = [...dependencies.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([dependency, status]) => Object.freeze({ dependency, status }));
  const states = ordered.map((item) => item.status);
  const status: OperationalReadinessStatus = states.length === 0
    ? "UNKNOWN"
    : states.includes("UNAVAILABLE")
      ? "UNAVAILABLE"
      : states.includes("DEGRADED") || persistence === "DEGRADED"
        ? "DEGRADED"
        : "READY";

  return Object.freeze({ status, persistence, dependencies: Object.freeze(ordered) });
}
