import { describe, expect, it, vi } from "vitest";
import { deriveHigherTimeframeContext } from "../derivedTimeframeContext";
import {
  andResearchRules,
  createResearchRule,
  notResearchRule,
  orResearchRules,
  type ResearchDependency,
  type ResearchEvaluationContext,
  type ResearchRuleStatus,
} from "../researchRules";
import { BAR_DURATION_MS } from "../timeDomain";
import type { PointInTimeBar } from "../types";

const HOUR = BAR_DURATION_MS;
const START = Date.UTC(2024, 0, 1);
const DECISION_TIME = START + 24 * HOUR;

function bars(count = 24): PointInTimeBar[] {
  return Array.from({ length: count }, (_, index) => ({
    timestamp: START + index * HOUR,
    open: 100 + index,
    high: 102 + index,
    low: 99 + index,
    close: 101 + index,
    volume: 10 + index,
  }));
}

function context(overrides: Partial<ResearchEvaluationContext> = {}): ResearchEvaluationContext {
  const oneHourBars = bars();
  return {
    decisionTime: DECISION_TIME,
    asOf: DECISION_TIME,
    assetId: "BTC",
    series: {},
    oneHourBars,
    derivedTimeframes: deriveHigherTimeframeContext({
      assetId: "BTC",
      eligible1hBars: oneHourBars,
      decisionTime: DECISION_TIME,
    }),
    ...overrides,
  };
}

function leaf(
  ruleId: string,
  status: ResearchRuleStatus,
  dependencies: readonly ResearchDependency[] = [],
  parameters: Readonly<Record<string, string | number | boolean | null>> = {}
) {
  return createResearchRule({
    ruleId,
    version: "1.0.0",
    description: `${ruleId} description`,
    rationale: `${ruleId} rationale`,
    dependencies,
    parameters,
    evaluate: (inputs) => ({
      status,
      reasons: [{ code: `${ruleId}_${status}`, message: `${inputs.assetId}:${status}` }],
      metadata: { observedAt: inputs.decisionTime },
    }),
  });
}

const combinatorDefinition = (ruleId: string) => ({
  ruleId,
  version: "1.0.0",
  description: `${ruleId} description`,
  rationale: `${ruleId} rationale`,
});

describe("M13C C-B ResearchRule contract", () => {
  it("returns a structured MATCH result", () => {
    const result = leaf("MATCH_RULE", "MATCH").evaluate(context());
    expect(result).toMatchObject({ kind: "RESEARCH_EVIDENCE", status: "MATCH", ruleId: "MATCH_RULE" });
    expect(result.reasons).toHaveLength(1);
  });

  it("returns a structured NO_MATCH result", () => {
    expect(leaf("NO_RULE", "NO_MATCH").evaluate(context()).status).toBe("NO_MATCH");
  });

  it("returns INSUFFICIENT_EVIDENCE without invoking the evaluator when a dependency is missing", () => {
    const evaluator = vi.fn(() => ({ status: "MATCH" as const, reasons: [{ code: "X", message: "X" }] }));
    const rule = createResearchRule({
      ruleId: "MISSING_SERIES",
      version: "1",
      description: "missing series",
      rationale: "dependency gate",
      dependencies: [{ kind: "SERIES", seriesId: "VIX" }],
      parameters: {},
      evaluate: evaluator,
    });
    const result = rule.evaluate(context());
    expect(result.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(evaluator).not.toHaveBeenCalled();
  });

  it("allows an available optional dataset series to satisfy a declared dependency", () => {
    const vix = {
      seriesId: "VIX",
      value: 25,
      observationTime: START,
      availableAt: START + HOUR,
      provider: "TEST",
    } as const;
    const rule = leaf("VIX_RULE", "MATCH", [{ kind: "SERIES", seriesId: "VIX" }]);
    expect(rule.evaluate(context({ series: { VIX: vix } })).status).toBe("MATCH");
  });

  it("does not assume an unavailable optional dataset series exists", () => {
    const rule = leaf("OPTIONAL_VIX", "MATCH", [{ kind: "SERIES", seriesId: "VIX" }]);
    expect(rule.evaluate(context({ series: {} })).status).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("supports a declared 1H dependency", () => {
    const rule = leaf("ONE_HOUR", "MATCH", [{ kind: "TIMEFRAME", timeframe: "1H" }]);
    expect(rule.evaluate(context()).dependencyAvailability[0].status).toBe("AVAILABLE");
  });

  it("supports a declared 4H dependency", () => {
    const rule = leaf("FOUR_HOUR", "MATCH", [{ kind: "TIMEFRAME", timeframe: "4H" }]);
    expect(rule.evaluate(context()).status).toBe("MATCH");
  });

  it("supports a declared 1D dependency", () => {
    const rule = leaf("ONE_DAY", "MATCH", [{ kind: "TIMEFRAME", timeframe: "1D" }]);
    expect(rule.evaluate(context()).status).toBe("MATCH");
  });

  it("gives leaf evaluators only declared dependencies", () => {
    const rule = createResearchRule({
      ruleId: "SCOPED_INPUT",
      version: "1",
      description: "scoped input",
      rationale: "prevent hidden dependency access",
      dependencies: [{ kind: "TIMEFRAME", timeframe: "4H" }],
      parameters: {},
      evaluate: (inputs) => ({
        status: inputs.fourHourBars && inputs.oneHourBars === null && inputs.oneDayBars === null ? "MATCH" : "NO_MATCH",
        reasons: [{ code: "SCOPED", message: "Only 4H was exposed." }],
      }),
    });
    expect(rule.evaluate(context()).status).toBe("MATCH");
  });

  it("implements AND: all MATCH => MATCH", () => {
    const rule = andResearchRules(combinatorDefinition("AND_MATCH"), [leaf("A", "MATCH"), leaf("B", "MATCH")]);
    expect(rule.evaluate(context()).status).toBe("MATCH");
  });

  it("implements AND: any NO_MATCH => NO_MATCH", () => {
    const rule = andResearchRules(combinatorDefinition("AND_NO"), [leaf("A1", "INSUFFICIENT_EVIDENCE"), leaf("B1", "NO_MATCH")]);
    expect(rule.evaluate(context()).status).toBe("NO_MATCH");
  });

  it("implements AND: otherwise insufficient", () => {
    const rule = andResearchRules(combinatorDefinition("AND_IE"), [leaf("A2", "MATCH"), leaf("B2", "INSUFFICIENT_EVIDENCE")]);
    expect(rule.evaluate(context()).status).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("implements OR: any MATCH => MATCH", () => {
    const rule = orResearchRules(combinatorDefinition("OR_MATCH"), [leaf("A3", "INSUFFICIENT_EVIDENCE"), leaf("B3", "MATCH")]);
    expect(rule.evaluate(context()).status).toBe("MATCH");
  });

  it("implements OR: all NO_MATCH => NO_MATCH", () => {
    const rule = orResearchRules(combinatorDefinition("OR_NO"), [leaf("A4", "NO_MATCH"), leaf("B4", "NO_MATCH")]);
    expect(rule.evaluate(context()).status).toBe("NO_MATCH");
  });

  it("implements OR: otherwise insufficient", () => {
    const rule = orResearchRules(combinatorDefinition("OR_IE"), [leaf("A5", "NO_MATCH"), leaf("B5", "INSUFFICIENT_EVIDENCE")]);
    expect(rule.evaluate(context()).status).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("implements NOT MATCH => NO_MATCH", () => {
    expect(notResearchRule(combinatorDefinition("NOT_MATCH"), leaf("A6", "MATCH")).evaluate(context()).status).toBe("NO_MATCH");
  });

  it("implements NOT NO_MATCH => MATCH", () => {
    expect(notResearchRule(combinatorDefinition("NOT_NO"), leaf("A7", "NO_MATCH")).evaluate(context()).status).toBe("MATCH");
  });

  it("implements NOT insufficient => insufficient", () => {
    expect(notResearchRule(combinatorDefinition("NOT_IE"), leaf("A8", "INSUFFICIENT_EVIDENCE")).evaluate(context()).status).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("evaluates nested combinators deterministically", () => {
    const nested = andResearchRules(combinatorDefinition("NESTED"), [
      orResearchRules(combinatorDefinition("INNER_OR"), [leaf("A9", "NO_MATCH"), leaf("B9", "MATCH")]),
      notResearchRule(combinatorDefinition("INNER_NOT"), leaf("C9", "NO_MATCH")),
    ]);
    expect(nested.evaluate(context())).toEqual(nested.evaluate(context()));
    expect(nested.evaluate(context()).status).toBe("MATCH");
  });

  it("preserves child rule identity and evidence for audit", () => {
    const child = leaf("AUDIT_CHILD", "MATCH");
    const result = notResearchRule(combinatorDefinition("AUDIT_PARENT"), child).evaluate(context());
    expect(result.childResults[0]).toMatchObject({
      ruleId: "AUDIT_CHILD",
      semanticIdentity: child.semanticIdentity,
      status: "MATCH",
    });
  });

  it("gives identical parameters a deterministic semantic identity", () => {
    const first = leaf("PARAM_RULE", "MATCH", [], { slow: 20, fast: 5 });
    const second = leaf("PARAM_RULE", "MATCH", [], { fast: 5, slow: 20 });
    expect(first.semanticIdentity).toBe(second.semanticIdentity);
  });

  it("distinguishes changed parameter configurations", () => {
    expect(leaf("PARAM_CHANGE", "MATCH", [], { threshold: 1 }).semanticIdentity)
      .not.toBe(leaf("PARAM_CHANGE", "MATCH", [], { threshold: 2 }).semanticIdentity);
  });

  it("preserves decisionTime and asOf", () => {
    expect(leaf("TIME", "MATCH").evaluate(context())).toMatchObject({
      decisionTime: DECISION_TIME,
      evaluatedAt: DECISION_TIME,
      asOf: DECISION_TIME,
    });
  });

  it("preserves asset identity", () => {
    expect(leaf("ASSET", "MATCH").evaluate(context({
      assetId: "PAXG",
      derivedTimeframes: undefined,
    })).assetId).toBe("PAXG");
  });

  it("does not mutate caller context", () => {
    const input = context();
    const before = structuredClone(input);
    leaf("IMMUTABLE", "MATCH", [{ kind: "TIMEFRAME", timeframe: "1H" }]).evaluate(input);
    expect(input).toEqual(before);
  });

  it("is deterministic across repeated invocation", () => {
    const rule = leaf("REPEAT", "MATCH", [], { threshold: 3 });
    expect(rule.evaluate(context())).toEqual(rule.evaluate(context()));
  });

  it("does not perform network or provider access", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    leaf("OFFLINE", "MATCH").evaluate(context());
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("fails closed when supplied evidence is from the future", () => {
    const futureVix = {
      seriesId: "VIX",
      value: 25,
      observationTime: START,
      availableAt: DECISION_TIME + 1,
      provider: "TEST",
    } as const;
    expect(() => leaf("PIT", "MATCH").evaluate(context({ series: { VIX: futureVix } }))).toThrow(/not PIT-eligible/);
  });

  it("fails closed when a series key is paired with the wrong evidence kind", () => {
    const event = {
      eventId: "EVENT-1",
      eventType: "FOMC_STATEMENT",
      observationTime: START,
      publishedAt: START + HOUR,
      availableAt: START + HOUR,
      actual: null,
      consensus: null,
      consensusFrozenAt: null,
      previous: null,
      surprise: null,
      provider: "TEST",
      sourceQuality: "TIER_1_OFFICIAL",
    } as const;
    expect(() => leaf("KIND", "MATCH").evaluate(context({ series: { VIX: event } }))).toThrow(/evidence kind/);
  });

  it("returns research evidence with no trading authority", () => {
    const result = leaf("AUTHORITY", "MATCH").evaluate(context());
    expect(result).toMatchObject({
      kind: "RESEARCH_EVIDENCE",
      predictiveValidityAssessed: false,
      grantsExecutionAuthority: false,
    });
    expect(result).not.toHaveProperty("targetWeights");
    expect(result).not.toHaveProperty("orders");
    expect(result).not.toHaveProperty("executions");
    expect(result).not.toHaveProperty("actionDecision");
  });
});
