import { describe, expect, it, vi } from "vitest";
import {
  createResearchRule,
  type ResearchDependency,
  type ResearchEvaluationContext,
  type ResearchRuleStatus,
} from "../researchRules";
import {
  createOrderedSequenceRule,
  createPersistenceRule,
  replayStatefulResearchRule,
  type OrderedSequenceState,
} from "../statefulResearchRules";

const T1 = Date.UTC(2024, 0, 1, 1);
const HOUR = 60 * 60 * 1000;
const T2 = T1 + HOUR;
const T3 = T2 + HOUR;
const T4 = T3 + HOUR;
const T5 = T4 + HOUR;

function context(decisionTime: number, overrides: Partial<ResearchEvaluationContext> = {}): ResearchEvaluationContext {
  return { decisionTime, asOf: decisionTime, assetId: "BTC", series: {}, ...overrides };
}

function vix(availableAt: number) {
  return { seriesId: "VIX", value: 25, observationTime: T1, availableAt, provider: "TEST" } as const;
}

function timeRule(
  ruleId: string,
  statuses: Readonly<Record<number, ResearchRuleStatus>>,
  fallback: ResearchRuleStatus = "NO_MATCH"
) {
  return createResearchRule({
    ruleId,
    version: "1.0.0",
    description: `${ruleId} description`,
    rationale: `${ruleId} rationale`,
    dependencies: [],
    parameters: {},
    evaluate: (inputs) => ({
      status: statuses[inputs.decisionTime] ?? fallback,
      reasons: [{ code: `${ruleId}_STATUS`, message: `${statuses[inputs.decisionTime] ?? fallback}` }],
    }),
  });
}

function optionalVixRule(ruleId: string, status: ResearchRuleStatus = "MATCH") {
  return createResearchRule({
    ruleId,
    version: "1.0.0",
    description: `${ruleId} description`,
    rationale: `${ruleId} rationale`,
    dependencies: [{ kind: "SERIES", seriesId: "VIX" }],
    parameters: {},
    evaluate: () => ({ status, reasons: [{ code: `${ruleId}_STATUS`, message: status }] }),
  });
}

function spiedRule(
  ruleId: string,
  status: ResearchRuleStatus,
  dependencies: readonly ResearchDependency[] = []
) {
  const evaluator = vi.fn(() => ({
    status,
    reasons: [{ code: `${ruleId}_STATUS`, message: status }],
  }));
  return {
    evaluator,
    rule: createResearchRule({
      ruleId,
      version: "1.0.0",
      description: `${ruleId} description`,
      rationale: `${ruleId} rationale`,
      dependencies,
      parameters: {},
      evaluate: evaluator,
    }),
  };
}

function sequence(
  first = timeRule("FIRST", { [T1]: "MATCH" }),
  then = timeRule("THEN", { [T2]: "MATCH" }),
  windowObservations = 3,
  version = "1.0.0"
) {
  return createOrderedSequenceRule({
    ruleId: "SEQUENCE",
    version,
    description: "A then B",
    rationale: "Test ordered evidence",
    first,
    then,
    windowObservations,
  });
}

function persistence(
  condition = timeRule("CONDITION", { [T1]: "MATCH", [T2]: "MATCH", [T3]: "MATCH" }),
  requiredConsecutive = 3
) {
  return createPersistenceRule({
    ruleId: "PERSISTENCE",
    version: "1.0.0",
    description: "N consecutive matches",
    rationale: "Test persistence evidence",
    condition,
    requiredConsecutive,
  });
}

describe("M13C C-C stateful research rules", () => {
  it("completes A at T1 then B only at T2", () => {
    const rule = sequence();
    const first = rule.transition(rule.createInitialState("BTC"), context(T1));
    expect(first).toMatchObject({ status: "NO_MATCH", event: "ACTIVATED" });
    const second = rule.transition(first.nextState, context(T2));
    expect(second).toMatchObject({ status: "MATCH", event: "COMPLETED", decisionTime: T2 });
  });

  it("evaluates only A while waiting for A", () => {
    const first = spiedRule("SPY_A", "MATCH");
    const then = spiedRule("SPY_B", "MATCH");
    const rule = sequence(first.rule, then.rule);
    const transition = rule.transition(rule.createInitialState("BTC"), context(T1));
    expect(first.evaluator).toHaveBeenCalledOnce();
    expect(then.evaluator).not.toHaveBeenCalled();
    expect(transition.childResults.map((item) => item.ruleId)).toEqual(["SPY_A"]);
  });

  it("evaluates only B while waiting for B", () => {
    const first = spiedRule("ONCE_A", "MATCH");
    const then = spiedRule("ACTIVE_B", "MATCH");
    const rule = sequence(first.rule, then.rule);
    const activated = rule.transition(rule.createInitialState("BTC"), context(T1));
    const completed = rule.transition(activated.nextState, context(T2));
    expect(first.evaluator).toHaveBeenCalledOnce();
    expect(then.evaluator).toHaveBeenCalledOnce();
    expect(completed.childResults.map((item) => item.ruleId)).toEqual(["ACTIVE_B"]);
  });

  it("activates A despite a missing dependency belonging only to inactive B", () => {
    const first = spiedRule("AVAILABLE_A", "MATCH");
    const then = spiedRule("MISSING_DEP_B", "MATCH", [{ kind: "SERIES", seriesId: "VIX" }]);
    const rule = sequence(first.rule, then.rule);
    const transition = rule.transition(rule.createInitialState("BTC"), context(T1));
    expect(transition).toMatchObject({ event: "ACTIVATED", nextState: { phase: "WAITING_FOR_B" } });
    expect(then.evaluator).not.toHaveBeenCalled();
  });

  it("completes B despite a now-missing dependency belonging only to inactive A", () => {
    const first = spiedRule("VIX_A", "MATCH", [{ kind: "SERIES", seriesId: "VIX" }]);
    const then = spiedRule("VALID_B", "MATCH");
    const rule = sequence(first.rule, then.rule);
    const activated = rule.transition(
      rule.createInitialState("BTC"),
      context(T1, { series: { VIX: vix(T1) } })
    );
    const completed = rule.transition(activated.nextState, context(T2, { series: {} }));
    expect(completed).toMatchObject({ status: "MATCH", event: "COMPLETED" });
    expect(first.evaluator).toHaveBeenCalledOnce();
    expect(then.evaluator).toHaveBeenCalledOnce();
  });

  it("ignores future evidence belonging only to the inactive child", () => {
    const first = spiedRule("PIT_SAFE_A", "MATCH");
    const then = spiedRule("FUTURE_INACTIVE_B", "MATCH", [{ kind: "SERIES", seriesId: "VIX" }]);
    const rule = sequence(first.rule, then.rule);
    const transition = rule.transition(
      rule.createInitialState("BTC"),
      context(T1, { series: { VIX: vix(T2) } })
    );
    expect(transition.event).toBe("ACTIVATED");
    expect(then.evaluator).not.toHaveBeenCalled();
  });

  it("does not expose future completion in the T1 replay result", () => {
    const rule = sequence();
    const replay = replayStatefulResearchRule(rule, rule.createInitialState("BTC"), [context(T1), context(T2)]);
    expect(replay.transitions.map((item) => item.status)).toEqual(["NO_MATCH", "MATCH"]);
    expect(replay.transitions[0].nextState.phase).toBe("WAITING_FOR_B");
  });

  it("does not complete when B occurs before A", () => {
    const rule = sequence(
      timeRule("LATE_A", { [T2]: "MATCH" }),
      timeRule("EARLY_B", { [T1]: "MATCH" })
    );
    const replay = replayStatefulResearchRule(rule, rule.createInitialState("BTC"), [context(T1), context(T2)]);
    expect(replay.transitions.map((item) => item.event)).toEqual(["WAITING_FOR_A", "ACTIVATED"]);
    expect(replay.transitions.some((item) => item.status === "MATCH")).toBe(false);
  });

  it("rejects future evidence before it can enter state", () => {
    const rule = sequence(optionalVixRule("FUTURE_A"));
    const initial = rule.createInitialState("BTC");
    expect(() => rule.transition(initial, context(T1, { series: { VIX: vix(T2) } }))).toThrow(/not PIT-eligible/);
    expect(initial).toEqual(rule.createInitialState("BTC"));
  });

  it("rejects decreasing decisionTime", () => {
    const rule = sequence();
    const accepted = rule.transition(rule.createInitialState("BTC"), context(T2));
    expect(() => rule.transition(accepted.nextState, context(T1))).toThrow(/strictly greater/);
  });

  it("rejects equal decisionTime rather than inventing intra-time ordering", () => {
    const rule = sequence();
    const accepted = rule.transition(rule.createInitialState("BTC"), context(T1));
    expect(() => rule.transition(accepted.nextState, context(T1))).toThrow(/strictly greater/);
  });

  it("matches B inside the declared observation window", () => {
    const rule = sequence(undefined, timeRule("B_INSIDE", { [T3]: "MATCH" }), 3);
    const replay = replayStatefulResearchRule(rule, rule.createInitialState("BTC"), [context(T1), context(T2), context(T3)]);
    expect(replay.transitions.at(-1)).toMatchObject({ status: "MATCH", event: "COMPLETED" });
  });

  it("expires when B occurs outside the declared window", () => {
    const rule = sequence(undefined, timeRule("B_OUTSIDE", { [T5]: "MATCH" }), 2);
    const replay = replayStatefulResearchRule(rule, rule.createInitialState("BTC"), [context(T1), context(T2), context(T3), context(T5)]);
    expect(replay.transitions[2]).toMatchObject({ status: "NO_MATCH", event: "EXPIRED" });
    expect(replay.transitions[3].status).toBe("NO_MATCH");
  });

  it("includes the exact final observation-window boundary", () => {
    const rule = sequence(undefined, timeRule("B_BOUNDARY", { [T3]: "MATCH" }), 2);
    const replay = replayStatefulResearchRule(rule, rule.createInitialState("BTC"), [context(T1), context(T2), context(T3)]);
    expect(replay.transitions[2]).toMatchObject({ status: "MATCH", event: "COMPLETED" });
  });

  it("changes semantic identity when the window changes", () => {
    expect(sequence(undefined, undefined, 3).semanticIdentity).not.toBe(sequence(undefined, undefined, 5).semanticIdentity);
  });

  it("does not advance the sequence window on insufficient B evidence", () => {
    const rule = sequence(undefined, optionalVixRule("OPTIONAL_B"), 1);
    const activated = rule.transition(rule.createInitialState("BTC"), context(T1));
    const missing = rule.transition(activated.nextState, context(T2));
    expect(missing).toMatchObject({ status: "INSUFFICIENT_EVIDENCE", event: "INSUFFICIENT_EVIDENCE" });
    expect(missing.nextState.eligibleObservationsSinceActivation).toBe(0);
    const completed = rule.transition(missing.nextState, context(T3, { series: { VIX: vix(T3) } }));
    expect(completed.status).toBe("MATCH");
  });

  it("cannot complete a sequence from a missing optional dependency", () => {
    const rule = sequence(undefined, optionalVixRule("MISSING_B"));
    const activated = rule.transition(rule.createInitialState("BTC"), context(T1));
    expect(rule.transition(activated.nextState, context(T2)).status).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("matches persistence only on the Nth consecutive success", () => {
    const rule = persistence();
    const replay = replayStatefulResearchRule(rule, rule.createInitialState("BTC"), [context(T1), context(T2), context(T3)]);
    expect(replay.transitions.map((item) => item.status)).toEqual(["NO_MATCH", "NO_MATCH", "MATCH"]);
  });

  it("resets a persistence streak on NO_MATCH", () => {
    const rule = persistence(timeRule("BREAK", { [T1]: "MATCH", [T2]: "NO_MATCH", [T3]: "MATCH" }), 2);
    const replay = replayStatefulResearchRule(rule, rule.createInitialState("BTC"), [context(T1), context(T2), context(T3)]);
    expect(replay.transitions[1]).toMatchObject({ event: "STREAK_RESET", nextState: { streak: 0 } });
    expect(replay.transitions[2]).toMatchObject({ status: "NO_MATCH", nextState: { streak: 1 } });
  });

  it("resets persistence on insufficient evidence", () => {
    const rule = persistence(timeRule("GAP", { [T1]: "MATCH", [T2]: "INSUFFICIENT_EVIDENCE", [T3]: "MATCH" }), 2);
    const replay = replayStatefulResearchRule(rule, rule.createInitialState("BTC"), [context(T1), context(T2), context(T3)]);
    expect(replay.transitions[1]).toMatchObject({ status: "INSUFFICIENT_EVIDENCE", nextState: { streak: 0 } });
    expect(replay.transitions[2].status).toBe("NO_MATCH");
  });

  it("changes semantic identity when persistence N changes", () => {
    expect(persistence(undefined, 2).semanticIdentity).not.toBe(persistence(undefined, 3).semanticIdentity);
  });

  it("is deterministic for repeated identical initial state and contexts", () => {
    const rule = sequence();
    const initial = rule.createInitialState("BTC");
    const contexts = [context(T1), context(T2)];
    expect(replayStatefulResearchRule(rule, initial, contexts)).toEqual(replayStatefulResearchRule(rule, initial, contexts));
  });

  it("rejects state from a different semantic rule identity", () => {
    const source = sequence(undefined, undefined, 3);
    const target = sequence(undefined, undefined, 5);
    expect(() => target.transition(source.createInitialState("BTC"), context(T1))).toThrow(/incompatible rule identity/);
  });

  it("rejects state created by an incompatible version", () => {
    const source = sequence(undefined, undefined, 3, "1.0.0");
    const target = sequence(undefined, undefined, 3, "2.0.0");
    expect(() => target.transition(source.createInitialState("BTC"), context(T1))).toThrow(/incompatible rule identity/);
  });

  it("rejects state created with incompatible parameters", () => {
    const target = sequence(undefined, undefined, 4);
    expect(() => target.transition(sequence(undefined, undefined, 2).createInitialState("BTC"), context(T1)))
      .toThrow(/incompatible rule identity/);
  });

  it("rejects cross-asset state reuse", () => {
    const rule = sequence();
    expect(() => rule.transition(rule.createInitialState("BTC"), context(T1, { assetId: "PAXG" }))).toThrow(/assetId/);
  });

  it("does not mutate input context", () => {
    const rule = sequence();
    const input = context(T1);
    const before = structuredClone(input);
    rule.transition(rule.createInitialState("BTC"), input);
    expect(input).toEqual(before);
  });

  it("does not mutate prior state", () => {
    const rule = sequence();
    const initial = rule.createInitialState("BTC");
    const before = structuredClone(initial);
    rule.transition(initial, context(T1));
    expect(initial).toEqual(before);
  });

  it("returns deterministic immutable state", () => {
    const rule = sequence();
    const result = rule.transition(rule.createInitialState("BTC"), context(T1));
    expect(Object.isFrozen(result.nextState)).toBe(true);
    expect(result.nextState).toEqual(rule.transition(rule.createInitialState("BTC"), context(T1)).nextState);
  });

  it("keeps state evidence bounded rather than appending history", () => {
    const rule = sequence(undefined, timeRule("NEVER_B", {}), 100);
    let state: OrderedSequenceState = rule.transition(rule.createInitialState("BTC"), context(T1)).nextState;
    for (let index = 2; index <= 20; index += 1) {
      state = rule.transition(state, context(T1 + index * HOUR)).nextState;
    }
    expect(Object.keys(state).sort()).toEqual([
      "activatedAt", "activationEvidence", "assetId", "eligibleObservationsSinceActivation",
      "kind", "lastDecisionTime", "phase", "ruleSemanticIdentity",
    ]);
    expect(state.activationEvidence?.decisionTime).toBe(T1);
  });

  it("preserves only the active phase child evidence", () => {
    const rule = sequence(
      timeRule("A_EVIDENCE", { [T1]: "MATCH", [T2]: "NO_MATCH" }),
      timeRule("B_EVIDENCE", { [T1]: "INSUFFICIENT_EVIDENCE", [T2]: "NO_MATCH" })
    );
    const first = rule.transition(rule.createInitialState("BTC"), context(T1));
    expect(first.childResults.map((item) => item.status)).toEqual(["MATCH"]);
    const second = rule.transition(first.nextState, context(T2));
    expect(second.childResults.map((item) => item.status)).toEqual(["NO_MATCH"]);
  });

  it("preserves C-B dependency fail-closed behavior before leaf evaluation", () => {
    const evaluator = vi.fn(() => ({ status: "MATCH" as const, reasons: [{ code: "X", message: "X" }] }));
    const dependent = createResearchRule({
      ruleId: "DEPENDENT", version: "1", description: "dependent", rationale: "dependent",
      dependencies: [{ kind: "SERIES", seriesId: "VIX" }], parameters: {}, evaluate: evaluator,
    });
    const rule = persistence(dependent, 1);
    expect(rule.transition(rule.createInitialState("BTC"), context(T1)).status).toBe("INSUFFICIENT_EVIDENCE");
    expect(evaluator).not.toHaveBeenCalled();
  });

  it("has no SignalOutput coupling or trading authority fields", () => {
    const rule = sequence();
    const result = rule.transition(rule.createInitialState("BTC"), context(T1));
    expect(result).toMatchObject({ predictiveValidityAssessed: false, grantsExecutionAuthority: false });
    for (const field of ["signalOutput", "targetWeights", "orders", "executions", "ledger", "actionDecision"]) {
      expect(result).not.toHaveProperty(field);
      expect(result.nextState).not.toHaveProperty(field);
    }
  });

  it("does not call Permission, Risk, or Omega services", () => {
    const rule = sequence();
    const result = rule.transition(rule.createInitialState("BTC"), context(T1));
    expect(JSON.stringify(result)).not.toMatch(/PermissionGate|RiskEngine|OmegaAllocator/);
  });

  it("does not perform network or provider access", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const rule = sequence();
    rule.transition(rule.createInitialState("BTC"), context(T1));
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("pure replay uses the same one-step transition semantics", () => {
    const rule = sequence();
    const initial = rule.createInitialState("BTC");
    const first = rule.transition(initial, context(T1));
    const second = rule.transition(first.nextState, context(T2));
    expect(replayStatefulResearchRule(rule, initial, [context(T1), context(T2)]).transitions).toEqual([first, second]);
  });
});
