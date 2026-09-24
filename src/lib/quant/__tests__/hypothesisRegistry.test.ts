import { describe, expect, it } from "vitest";
import {
  createHypothesisRegistry,
  defineResearchHypothesis,
  hypothesisRuleReference,
  registerHypothesis,
  serializeHypothesisRegistry,
  type HypothesisLifecycle,
  type HypothesisRegistrySnapshot,
  type RegisteredResearchHypothesis,
  type ResearchHypothesisDefinition,
} from "../hypothesisRegistry";
import { createResearchRule } from "../researchRules";

const TRAIN_START = Date.UTC(2018, 0, 1);
const TRAIN_END = Date.UTC(2022, 0, 1);
const OOS_END = Date.UTC(2024, 0, 1);

const rule = createResearchRule({
  ruleId: "BTC_TREND",
  version: "1.0.0",
  description: "BTC trend research rule",
  rationale: "Test whether closed-bar trend evidence persists.",
  dependencies: [{ kind: "TIMEFRAME", timeframe: "4H" }],
  parameters: { lookback: 24 },
  evaluate: () => ({ status: "NO_MATCH", reasons: [{ code: "TEST", message: "Test only." }] }),
});

function definition(
  overrides: Partial<ResearchHypothesisDefinition> = {}
): ResearchHypothesisDefinition {
  return {
    hypothesisId: "H-BTC-TREND",
    version: "1.0.0",
    title: "BTC trend persistence",
    description: "Pre-registered trend hypothesis.",
    rationale: "A declared economic rationale before evaluation.",
    rule: hypothesisRuleReference(rule),
    assetScope: ["BTC"],
    requiredDependencies: [{ kind: "TIMEFRAME", timeframe: "4H" }],
    parameterSpace: [
      { name: "threshold", kind: "CANDIDATES", values: [2, 1] },
      { name: "window", kind: "RANGE", minimum: 2, maximum: 4, step: 1 },
    ],
    researchIntent: {
      question: "Does declared trend evidence persist out of sample?",
      falsificationCriterion: "Reject when the predeclared OOS criterion is not met.",
    },
    trainOosPolicy: {
      policyId: "TRAIN-2018-OOS-2022",
      training: { startTime: TRAIN_START, endTime: TRAIN_END },
      oos: { startTime: TRAIN_END, endTime: OOS_END },
      ordering: "TRAIN_BEFORE_OOS",
      oosReuse: "NEVER_TUNE_ON_OOS",
    },
    trialAccounting: {
      familyId: "BTC-TREND-FAMILY",
      unit: "ONE_TRIAL_PER_RULE_PARAMETER_CONFIGURATION",
      variantHandling: "COUNT_EACH_VARIANT",
      declaredTrialCount: 6,
    },
    lifecycle: "PREREGISTERED",
    preRegistration: {
      declaredBy: "research-governance",
      sourceReference: "C-D-test-plan",
      declarationOrdinal: 1,
    },
    ...overrides,
  };
}

function forgeExistingHypothesis(
  transform: (hypothesis: RegisteredResearchHypothesis) => RegisteredResearchHypothesis
): HypothesisRegistrySnapshot {
  const registry = createHypothesisRegistry([definition()]);
  return {
    ...registry,
    hypotheses: [transform(registry.hypotheses[0])],
  };
}

describe("M13C C-D hypothesis registry governance", () => {
  it("registers a structured, research-only pre-registration", () => {
    const hypothesis = defineResearchHypothesis(definition());
    expect(hypothesis).toMatchObject({
      hypothesisId: "H-BTC-TREND",
      lifecycle: "PREREGISTERED",
      predictiveValidityEstablished: false,
      approvedForPaperAction: false,
      grantsExecutionAuthority: false,
    });
    expect(hypothesis.semanticIdentity.length).toBeGreaterThan(0);
  });

  it("derives an exact versioned reference from a ResearchRule", () => {
    expect(hypothesisRuleReference(rule)).toEqual({
      ruleId: rule.ruleId,
      version: rule.version,
      semanticIdentity: rule.semanticIdentity,
    });
  });

  it("normalizes parameter, candidate, dependency, and asset ordering", () => {
    const left = defineResearchHypothesis(definition({ assetScope: ["PAXG", "BTC"] }));
    const right = defineResearchHypothesis(definition({
      assetScope: ["BTC", "PAXG"],
      parameterSpace: [
        { name: "window", kind: "RANGE", minimum: 2, maximum: 4, step: 1 },
        { name: "threshold", kind: "CANDIDATES", values: [1, 2] },
      ],
    }));
    expect(left.semanticIdentity).toBe(right.semanticIdentity);
    expect(left.assetScope).toEqual(["BTC", "PAXG"]);
    expect(left.parameterSpace[0].name).toBe("threshold");
  });

  it("changes identity for a meaningful parameter-space change", () => {
    const changed = definition({
      parameterSpace: [{ name: "threshold", kind: "CANDIDATES", values: [1, 2, 3] }],
      trialAccounting: { ...definition().trialAccounting, declaredTrialCount: 3 },
    });
    expect(defineResearchHypothesis(changed).semanticIdentity)
      .not.toBe(defineResearchHypothesis(definition()).semanticIdentity);
  });

  it("changes identity when the referenced rule identity changes", () => {
    const changed = definition({ rule: { ...hypothesisRuleReference(rule), semanticIdentity: "different" } });
    expect(defineResearchHypothesis(changed).semanticIdentity)
      .not.toBe(defineResearchHypothesis(definition()).semanticIdentity);
  });

  it("keeps lifecycle and declaration metadata out of scientific identity", () => {
    const rejected = defineResearchHypothesis(definition({
      lifecycle: "REJECTED",
      preRegistration: { declaredBy: "other", sourceReference: "other-ref", declarationOrdinal: 9 },
    }));
    expect(rejected.semanticIdentity).toBe(defineResearchHypothesis(definition()).semanticIdentity);
  });

  it.each<HypothesisLifecycle>([
    "PREREGISTERED",
    "EVALUATION_PENDING",
    "REJECTED",
    "FAILED",
    "INSUFFICIENT_EVIDENCE",
  ])("retains the %s lifecycle without converting it to success", (lifecycle) => {
    const hypothesis = defineResearchHypothesis(definition({ lifecycle }));
    expect(hypothesis.lifecycle).toBe(lifecycle);
    expect(hypothesis.predictiveValidityEstablished).toBe(false);
  });

  it("preserves older versions when a new version is registered", () => {
    const registry = createHypothesisRegistry([definition()]);
    const next = registerHypothesis(registry, definition({
      version: "2.0.0",
      rule: { ...hypothesisRuleReference(rule), version: "2.0.0", semanticIdentity: "rule-v2" },
      preRegistration: { ...definition().preRegistration, declarationOrdinal: 2 },
    }));
    expect(next.hypotheses.map((entry) => entry.version)).toEqual(["1.0.0", "2.0.0"]);
    expect(registry.hypotheses).toHaveLength(1);
  });

  it("rejects duplicate semantic identity", () => {
    const registry = createHypothesisRegistry([definition()]);
    expect(() => registerHypothesis(registry, definition())).toThrow(/duplicate hypothesis identity/);
  });

  it("rejects an incompatible definition under the same id and version", () => {
    const registry = createHypothesisRegistry([definition()]);
    expect(() => registerHypothesis(registry, definition({ title: "Changed title" })))
      .toThrow(/already exists with an incompatible identity/);
  });

  it("serializes deterministically regardless of registration order", () => {
    const second = definition({ hypothesisId: "H-SECOND", preRegistration: { ...definition().preRegistration, declarationOrdinal: 2 } });
    const left = createHypothesisRegistry([definition(), second]);
    const right = createHypothesisRegistry([second, definition()]);
    expect(left.semanticIdentity).toBe(right.semanticIdentity);
    expect(serializeHypothesisRegistry(left)).toBe(serializeHypothesisRegistry(right));
  });

  it("rejects a forged or stale registry snapshot before extension or serialization", () => {
    const registry = createHypothesisRegistry([definition()]);
    const forged = { ...registry, semanticIdentity: "forged" };
    expect(() => registerHypothesis(forged, definition({ hypothesisId: "H-OTHER" }))).toThrow(/forged or stale/);
    expect(() => serializeHypothesisRegistry(forged)).toThrow(/forged or stale/);
  });

  it.each([
    ["schemaVersion", (registry: HypothesisRegistrySnapshot) => ({ ...registry, schemaVersion: "forged-schema" })],
    ["intendedUse", (registry: HypothesisRegistrySnapshot) => ({ ...registry, intendedUse: "FORGED_USE" })],
    ["predictiveValidityEstablished", (registry: HypothesisRegistrySnapshot) => ({
      ...registry,
      predictiveValidityEstablished: true,
    })],
    ["approvedForPaperAction", (registry: HypothesisRegistrySnapshot) => ({
      ...registry,
      approvedForPaperAction: true,
    })],
    ["grantsExecutionAuthority", (registry: HypothesisRegistrySnapshot) => ({
      ...registry,
      grantsExecutionAuthority: true,
    })],
  ] as const)("serialization rejects forged top-level %s", (_field, forge) => {
    const registry = createHypothesisRegistry([definition()]);
    const forged = forge(registry) as unknown as HypothesisRegistrySnapshot;
    expect(() => serializeHypothesisRegistry(forged))
      .toThrow(/incompatible or authority-bearing contract/);
  });

  it.each([
    ["rationale", (hypothesis: RegisteredResearchHypothesis) => ({ ...hypothesis, rationale: "forged rationale" })],
    ["rule reference", (hypothesis: RegisteredResearchHypothesis) => ({
      ...hypothesis,
      rule: { ...hypothesis.rule, semanticIdentity: "forged-rule" },
    })],
    ["required dependencies", (hypothesis: RegisteredResearchHypothesis) => ({
      ...hypothesis,
      requiredDependencies: [{ kind: "TIMEFRAME" as const, timeframe: "1D" as const }],
    })],
    ["parameter space", (hypothesis: RegisteredResearchHypothesis) => ({
      ...hypothesis,
      parameterSpace: [
        { name: "threshold", kind: "CANDIDATES" as const, values: [3, 4] },
        { name: "window", kind: "RANGE" as const, minimum: 2, maximum: 4, step: 1 },
      ],
    })],
    ["train/OOS policy", (hypothesis: RegisteredResearchHypothesis) => ({
      ...hypothesis,
      trainOosPolicy: {
        ...hypothesis.trainOosPolicy,
        training: { ...hypothesis.trainOosPolicy.training, startTime: TRAIN_START + 1 },
      },
    })],
    ["trial accounting", (hypothesis: RegisteredResearchHypothesis) => ({
      ...hypothesis,
      trialAccounting: { ...hypothesis.trialAccounting, familyId: "forged-family" },
    })],
  ] as const)("rejects forged existing %s content during extension and serialization", (_label, transform) => {
    const forged = forgeExistingHypothesis(transform);
    expect(() => registerHypothesis(forged, definition({ hypothesisId: "H-OTHER" })))
      .toThrow(/forged or stale scientific identity/);
    expect(() => serializeHypothesisRegistry(forged)).toThrow(/forged or stale scientific identity/);
  });

  it("rejects a forged existing authority flag", () => {
    const forged = forgeExistingHypothesis((hypothesis) => ({
      ...hypothesis,
      predictiveValidityEstablished: true,
    } as unknown as RegisteredResearchHypothesis));
    expect(() => registerHypothesis(forged, definition({ hypothesisId: "H-OTHER" })))
      .toThrow(/forged research or action authority/);
    expect(() => serializeHypothesisRegistry(forged)).toThrow(/forged research or action authority/);
  });

  it("rejects forged lifecycle and preregistration metadata against the registry identity", () => {
    const forgedLifecycle = forgeExistingHypothesis((hypothesis) => ({
      ...hypothesis,
      lifecycle: "FAILED",
    }));
    const forgedRegistration = forgeExistingHypothesis((hypothesis) => ({
      ...hypothesis,
      preRegistration: { ...hypothesis.preRegistration, declarationOrdinal: 99 },
    }));
    expect(() => registerHypothesis(forgedLifecycle, definition({ hypothesisId: "H-OTHER" })))
      .toThrow(/registry semantic identity is forged or stale/);
    expect(() => serializeHypothesisRegistry(forgedLifecycle)).toThrow(/registry semantic identity is forged or stale/);
    expect(() => registerHypothesis(forgedRegistration, definition({ hypothesisId: "H-OTHER" })))
      .toThrow(/registry semantic identity is forged or stale/);
    expect(() => serializeHypothesisRegistry(forgedRegistration)).toThrow(/registry semantic identity is forged or stale/);
  });

  it("continues to serialize and extend a legitimate untouched registry", () => {
    const registry = createHypothesisRegistry([definition()]);
    expect(serializeHypothesisRegistry(registry)).toContain("H-BTC-TREND");
    const extended = registerHypothesis(registry, definition({
      hypothesisId: "H-OTHER",
      preRegistration: { ...definition().preRegistration, declarationOrdinal: 2 },
    }));
    expect(extended.hypotheses).toHaveLength(2);
    expect(() => serializeHypothesisRegistry(extended)).not.toThrow();
  });

  it("accepts an explicit parameter-free hypothesis as one trial", () => {
    const hypothesis = defineResearchHypothesis(definition({
      parameterSpace: [],
      trialAccounting: { ...definition().trialAccounting, declaredTrialCount: 1 },
    }));
    expect(hypothesis.parameterSpace).toEqual([]);
    expect(hypothesis.trialAccounting.declaredTrialCount).toBe(1);
  });

  it("accepts fixed, candidate, and finite exact ranges", () => {
    const hypothesis = defineResearchHypothesis(definition({
      parameterSpace: [
        { name: "enabled", kind: "FIXED", value: true },
        { name: "mode", kind: "CANDIDATES", values: ["slow", "fast"] },
        { name: "window", kind: "RANGE", minimum: 2, maximum: 6, step: 2 },
      ],
      trialAccounting: { ...definition().trialAccounting, declaredTrialCount: 6 },
    }));
    expect(hypothesis.parameterSpace).toHaveLength(3);
  });

  it("rejects non-finite parameter values", () => {
    expect(() => defineResearchHypothesis(definition({
      parameterSpace: [{ name: "bad", kind: "FIXED", value: Number.NaN }],
      trialAccounting: { ...definition().trialAccounting, declaredTrialCount: 1 },
    }))).toThrow(/finite numeric values/);
  });

  it("rejects duplicate parameter names and candidate values", () => {
    expect(() => defineResearchHypothesis(definition({
      parameterSpace: [
        { name: "x", kind: "FIXED", value: 1 },
        { name: "x", kind: "FIXED", value: 2 },
      ],
      trialAccounting: { ...definition().trialAccounting, declaredTrialCount: 1 },
    }))).toThrow(/duplicate parameter name/);
    expect(() => defineResearchHypothesis(definition({
      parameterSpace: [{ name: "x", kind: "CANDIDATES", values: [1, 1] }],
      trialAccounting: { ...definition().trialAccounting, declaredTrialCount: 2 },
    }))).toThrow(/must not contain duplicates/);
  });

  it("rejects malformed and unbounded range declarations", () => {
    expect(() => defineResearchHypothesis(definition({
      parameterSpace: [{ name: "x", kind: "RANGE", minimum: 0, maximum: 1, step: 0 }],
      trialAccounting: { ...definition().trialAccounting, declaredTrialCount: 1 },
    }))).toThrow(/step must be positive/);
    expect(() => defineResearchHypothesis(definition({
      parameterSpace: [{ name: "x", kind: "RANGE", minimum: 0, maximum: 1, step: 0.3 }],
      trialAccounting: { ...definition().trialAccounting, declaredTrialCount: 4 },
    }))).toThrow(/terminate exactly/);
  });

  it("rejects parameter spaces beyond the declared safety ceiling", () => {
    expect(() => defineResearchHypothesis(definition({
      parameterSpace: [
        { name: "x", kind: "RANGE", minimum: 1, maximum: 10_000, step: 1 },
        { name: "y", kind: "RANGE", minimum: 1, maximum: 101, step: 1 },
      ],
      trialAccounting: { ...definition().trialAccounting, declaredTrialCount: 1_010_000 },
    }))).toThrow(/one-million-trial safety ceiling/);
  });

  it("requires trial accounting to match exact parameter cardinality", () => {
    expect(() => defineResearchHypothesis(definition({
      trialAccounting: { ...definition().trialAccounting, declaredTrialCount: 5 },
    }))).toThrow(/must equal parameter-space cardinality 6/);
  });

  it("rejects overlapping or reversed train/OOS intervals", () => {
    expect(() => defineResearchHypothesis(definition({
      trainOosPolicy: {
        ...definition().trainOosPolicy,
        oos: { startTime: TRAIN_END - 1, endTime: OOS_END },
      },
    }))).toThrow(/training must end at or before/);
    expect(() => defineResearchHypothesis(definition({
      trainOosPolicy: {
        ...definition().trainOosPolicy,
        training: { startTime: TRAIN_END, endTime: TRAIN_START },
      },
    }))).toThrow(/startTime must be before/);
  });

  it("requires never-tune-on-OOS and count-each-variant policies", () => {
    const badOos = { ...definition().trainOosPolicy, oosReuse: "REUSE" } as unknown as ResearchHypothesisDefinition["trainOosPolicy"];
    expect(() => defineResearchHypothesis(definition({ trainOosPolicy: badOos }))).toThrow(/never be declared reusable/);
    const badTrials = { ...definition().trialAccounting, variantHandling: "IGNORE" } as unknown as ResearchHypothesisDefinition["trialAccounting"];
    expect(() => defineResearchHypothesis(definition({ trialAccounting: badTrials }))).toThrow(/count every distinct/);
  });

  it("rejects undeclared result, performance, ranking, and selected-parameter fields", () => {
    for (const field of ["sharpe", "oosResult", "ranking", "selectedParameters"]) {
      const malformed = { ...definition(), [field]: 1 } as ResearchHypothesisDefinition;
      expect(() => defineResearchHypothesis(malformed)).toThrow(/prohibited at registration/);
    }
  });

  it("rejects unsupported and duplicate dependencies", () => {
    expect(() => defineResearchHypothesis(definition({
      requiredDependencies: [{ kind: "SERIES", seriesId: "UNKNOWN" as "VIX" }],
    }))).toThrow(/unsupported series/);
    expect(() => defineResearchHypothesis(definition({
      requiredDependencies: [
        { kind: "TIMEFRAME", timeframe: "4H" },
        { kind: "TIMEFRAME", timeframe: "4H" },
      ],
    }))).toThrow(/duplicate dependency/);
  });

  it("does not mutate caller-owned definitions and returns deeply frozen state", () => {
    const input = definition();
    const original = JSON.stringify(input);
    const registry = createHypothesisRegistry([input]);
    expect(JSON.stringify(input)).toBe(original);
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.hypotheses)).toBe(true);
    expect(Object.isFrozen(registry.hypotheses[0].parameterSpace)).toBe(true);
  });

  it("contains no evaluation, optimization, action, allocation, or execution result contract", () => {
    const serialized = serializeHypothesisRegistry(createHypothesisRegistry([definition()]));
    expect(serialized).not.toMatch(/sharpe|winRate|pnl|targetWeight|ActionDecision|ExecutionEngine/);
    expect(serialized).toContain('"grantsExecutionAuthority":false');
  });
});
