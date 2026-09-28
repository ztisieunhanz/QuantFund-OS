import { describe, expect, it } from "vitest";
import {
  createCycleKey,
  cycleKeysEqual,
  parseCycleKey,
  serializeCycleKey,
  validateCycleKey,
} from "../operationalPaperContract";

const DECISION_TIME = Date.UTC(2026, 0, 1, 12);

describe("M18-A operational paper contract", () => {
  it("constructs and serializes a deterministic portfolio-wide CycleKey", () => {
    const first = createCycleKey(DECISION_TIME);
    const second = createCycleKey(DECISION_TIME);

    expect(first).toEqual({
      schemaVersion: "M18_CYCLE_KEY_V1",
      interval: "1h",
      decisionTime: DECISION_TIME,
    });
    expect(serializeCycleKey(first)).toBe(`cycle:v1:1h:${DECISION_TIME}`);
    expect(parseCycleKey(serializeCycleKey(first))).toEqual(second);
    expect(cycleKeysEqual(first, second)).toBe(true);
    expect(cycleKeysEqual(first, createCycleKey(DECISION_TIME + 3_600_000))).toBe(false);
  });

  it("rejects unsupported or non-canonical CycleKey material", () => {
    expect(() => validateCycleKey({
      schemaVersion: "M18_CYCLE_KEY_V1",
      interval: "4h",
      decisionTime: DECISION_TIME,
    } as never)).toThrow();
    expect(() => parseCycleKey(`cycle:v1:1h:${DECISION_TIME + 0.5}`)).toThrow();
    expect(() => parseCycleKey(`cycle:v1:1h:${DECISION_TIME}x`)).toThrow();
  });
});
