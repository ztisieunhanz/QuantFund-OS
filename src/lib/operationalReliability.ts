import {
  classifyOperationalFreshness,
  type OperationalProviderFailure,
  type OperationalProviderRequestIdentity,
  type OperationalProviderResult,
  type OperationalProviderSuccess,
} from "./operationalProvider";

export interface OperationalCacheRead<T> {
  readonly cacheReadAt: number;
  readonly result: OperationalProviderSuccess<T>;
}

function sameIdentity(
  left: OperationalProviderRequestIdentity,
  right: OperationalProviderRequestIdentity
): boolean {
  return left.providerId === right.providerId &&
    left.operationId === right.operationId &&
    left.requestId === right.requestId;
}

/**
 * Bounded process-local cache for successful operational-provider evidence.
 * Entries retain their original observation and retrieval timestamps. Reads
 * only re-evaluate freshness at the caller-supplied cache-read time.
 */
export class BoundedOperationalProviderCache<T> {
  readonly maxEntries: number;
  private readonly entries = new Map<string, OperationalProviderSuccess<T>>();

  constructor(maxEntries: number) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error("Operational cache maxEntries must be a positive integer.");
    }
    this.maxEntries = maxEntries;
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  write(result: OperationalProviderResult<T>): void {
    if (result.kind !== "SUCCESS") return;

    const key = result.identity.requestId;
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, result);

    if (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (oldestKey !== undefined) this.entries.delete(oldestKey);
    }
  }

  read(input: {
    readonly identity: OperationalProviderRequestIdentity;
    readonly cacheReadAt: number;
    readonly freshnessMaxAgeMs: number;
  }): OperationalCacheRead<T> | null {
    const cached = this.entries.get(input.identity.requestId);
    if (!cached || !sameIdentity(cached.identity, input.identity)) return null;

    const refreshed = Object.freeze({
      ...cached,
      freshness: classifyOperationalFreshness({
        observedAt: cached.observedAt,
        evaluatedAt: input.cacheReadAt,
        maxAgeMs: input.freshnessMaxAgeMs,
      }),
    });

    return Object.freeze({ cacheReadAt: input.cacheReadAt, result: refreshed });
  }
}

export interface OperationalRetryPolicy {
  readonly maxAttempts: number;
  readonly retryDelayMs: number;
}

export interface OperationalRetryExecution<T> {
  readonly attempts: number;
  readonly result: OperationalProviderResult<T>;
}

export type OperationalWait = (delayMs: number) => Promise<void>;

/** Executes an operational read with a deterministic finite retry policy. */
export async function executeWithBoundedOperationalRetry<T>(input: {
  readonly attempt: (attemptNumber: number) => Promise<OperationalProviderResult<T>>;
  readonly policy: OperationalRetryPolicy;
  readonly wait?: OperationalWait;
}): Promise<OperationalRetryExecution<T>> {
  if (!Number.isInteger(input.policy.maxAttempts) || input.policy.maxAttempts < 1) {
    throw new Error("Operational retry maxAttempts must be a positive integer.");
  }
  if (!Number.isFinite(input.policy.retryDelayMs) || input.policy.retryDelayMs < 0) {
    throw new Error("Operational retry delay must be finite and non-negative.");
  }

  const wait: OperationalWait = input.wait ?? (async (delayMs) => {
    if (delayMs > 0) {
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, delayMs));
    }
  });

  let lastFailure: OperationalProviderFailure | null = null;
  for (let attemptNumber = 1; attemptNumber <= input.policy.maxAttempts; attemptNumber += 1) {
    const result = await input.attempt(attemptNumber);
    if (result.kind === "SUCCESS") {
      return Object.freeze({ attempts: attemptNumber, result });
    }

    lastFailure = result;
    const exhausted = attemptNumber === input.policy.maxAttempts;
    if (result.retryDisposition !== "RETRYABLE" || exhausted) {
      return Object.freeze({ attempts: attemptNumber, result });
    }

    const delayMs = result.http?.retryAfterMs ?? input.policy.retryDelayMs;
    await wait(delayMs);
  }

  if (lastFailure === null) {
    throw new Error("Operational retry terminated without an attempt result.");
  }
  return Object.freeze({ attempts: input.policy.maxAttempts, result: lastFailure });
}
