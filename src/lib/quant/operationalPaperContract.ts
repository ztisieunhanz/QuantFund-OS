import { QUANT_BAR_INTERVAL } from "./timeDomain";

export const OPERATIONAL_CYCLE_KEY_SCHEMA_VERSION = "M18_CYCLE_KEY_V1" as const;
export const OPERATIONAL_CYCLE_KEY_PREFIX = "cycle:v1:1h:" as const;

export interface CycleKey {
  readonly schemaVersion: typeof OPERATIONAL_CYCLE_KEY_SCHEMA_VERSION;
  readonly interval: typeof QUANT_BAR_INTERVAL;
  readonly decisionTime: number;
}

export type OperationalTruthStatus =
  | "UNAVAILABLE"
  | "FRESH_CURRENT"
  | "RESTORED_HISTORICAL"
  | "DEGRADED_PROVIDER_UNAVAILABLE";

export interface OperationalTruthState {
  readonly schemaVersion: "M18_OPERATIONAL_TRUTH_V1";
  readonly status: OperationalTruthStatus;
  readonly cycleKey: CycleKey | null;
  readonly cycleKeySerialized: string | null;
  readonly decisionTime: number | null;
  readonly observationTime: number | null;
  readonly source: "LIVE" | "SYNTHETIC" | "NONE";
  readonly historicalOnly: boolean;
  readonly reason: string | null;
}

function validateDecisionTime(decisionTime: number): void {
  if (!Number.isSafeInteger(decisionTime) || decisionTime < 0) {
    throw new Error("CycleKey decisionTime must be a non-negative safe-integer epoch millisecond.");
  }
}

export function createCycleKey(decisionTime: number): CycleKey {
  validateDecisionTime(decisionTime);
  return Object.freeze({
    schemaVersion: OPERATIONAL_CYCLE_KEY_SCHEMA_VERSION,
    interval: QUANT_BAR_INTERVAL,
    decisionTime,
  });
}

export const createOperationalCycleKey = createCycleKey;

export function validateCycleKey(key: CycleKey): CycleKey {
  if (!key || typeof key !== "object" || Array.isArray(key)) {
    throw new Error("CycleKey must be an object.");
  }
  const keys = Object.keys(key).sort();
  if (keys.join("|") !== "decisionTime|interval|schemaVersion") {
    throw new Error("CycleKey contains unsupported fields.");
  }
  if (key.schemaVersion !== OPERATIONAL_CYCLE_KEY_SCHEMA_VERSION || key.interval !== QUANT_BAR_INTERVAL) {
    throw new Error("CycleKey schema or interval is unsupported.");
  }
  validateDecisionTime(key.decisionTime);
  return key;
}

export function serializeCycleKey(key: CycleKey): string {
  const validated = validateCycleKey(key);
  return `${OPERATIONAL_CYCLE_KEY_PREFIX}${validated.decisionTime}`;
}

export const serializeOperationalCycleKey = serializeCycleKey;

export function parseCycleKey(serialized: string): CycleKey {
  if (typeof serialized !== "string" || !/^cycle:v1:1h:[0-9]+$/.test(serialized)) {
    throw new Error("CycleKey serialization is invalid.");
  }
  const decisionTime = Number(serialized.slice(OPERATIONAL_CYCLE_KEY_PREFIX.length));
  const key = createCycleKey(decisionTime);
  if (serializeCycleKey(key) !== serialized) throw new Error("CycleKey serialization is non-canonical.");
  return key;
}

export const parseOperationalCycleKey = parseCycleKey;

export function cycleKeysEqual(left: CycleKey | null, right: CycleKey | null): boolean {
  if (left === null || right === null) return left === right;
  return serializeCycleKey(left) === serializeCycleKey(right);
}

export function createOperationalTruthState(input: {
  readonly status: OperationalTruthStatus;
  readonly cycleKey?: CycleKey | null;
  readonly observationTime?: number | null;
  readonly source?: OperationalTruthState["source"];
  readonly reason?: string | null;
}): OperationalTruthState {
  const cycleKey = input.cycleKey ? validateCycleKey(input.cycleKey) : null;
  const observationTime = input.observationTime ?? null;
  if (observationTime !== null && (!Number.isSafeInteger(observationTime) || observationTime < 0)) {
    throw new Error("Operational observationTime must be a non-negative safe-integer epoch millisecond.");
  }
  const historicalOnly = input.status === "RESTORED_HISTORICAL" || input.status === "DEGRADED_PROVIDER_UNAVAILABLE";
  return Object.freeze({
    schemaVersion: "M18_OPERATIONAL_TRUTH_V1" as const,
    status: input.status,
    cycleKey,
    cycleKeySerialized: cycleKey ? serializeCycleKey(cycleKey) : null,
    decisionTime: cycleKey?.decisionTime ?? null,
    observationTime,
    source: input.source ?? "NONE",
    historicalOnly,
    reason: input.reason ?? null,
  });
}
