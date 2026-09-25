import { describe, expect, it } from "vitest";
import {
  createHypothesisRegistry,
  hypothesisRuleReference,
  type HypothesisRegistrySnapshot,
  type HypothesisLifecycle,
  type ResearchHypothesisDefinition,
} from "../hypothesisRegistry";
import { evaluateHeldOutOosEvidence, type HeldOutOosEvidenceSummary } from "../heldOutOosEvaluation";
import { buildResearchFeatureVector, type ResearchFeatureDefinition } from "../researchFeatureBuilder";
import { createResearchRule, type ResearchRuleStatus } from "../researchRules";
import {
  ROBUSTNESS_FAMILY_PREREGISTRATION_SCHEMA_VERSION,
  defineRobustnessFamilyPreregistration,
  type RobustnessFamilyPreregistration,
} from "../robustnessFamilyPreregistration";
import {
  evaluateRobustnessFamily,
  type RobustnessFamilyEvaluation,
  type RobustnessFamilyMemberEvidenceInput,
} from "../robustnessFamilyEvaluation";
import {
  createResearchEvidenceRegistry,
  serializeResearchEvidenceRegistry,
  validateResearchEvidenceRegistry,
  type ResearchEvidenceInput,
  type ResearchEvidenceRegistrySnapshot,
} from "../researchEvidenceRegistry";
import { runStatelessShadowObservation, type ShadowResearchObservation } from "../shadowResearchHarness";
import { BAR_DURATION_MS } from "../timeDomain";
import type { PointInTimeBar } from "../types";

const HOUR = BAR_DURATION_MS;
const TRAIN_START = Date.UTC(2020, 0, 1);
const OOS_START = Date.UTC(2022, 0, 1);
const OOS_END = OOS_START + 10 * HOUR;
const GRID = [OOS_START, OOS_START + HOUR, OOS_START + 2 * HOUR] as const;

const closeFeature: ResearchFeatureDefinition = {
  featureId: "BTC_1H_CLOSE",
  version: "1.0.0",
  description: "Canonical close evidence",
  dependency: { kind: "TIMEFRAME", timeframe: "1H" },
  transformation: { kind: "BAR_CLOSE", lag: 0 },
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) result[key] = canonicalize(child);
    }
    return result;
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function bars(time: number): PointInTimeBar[] {
  return [{ timestamp: time - HOUR, open: 100, high: 102, low: 99, close: 101, volume: 10 }];
}

function rule(hypothesisId: string, threshold: number, status: ResearchRuleStatus = "MATCH") {
  return createResearchRule({
    ruleId: `${hypothesisId}-RULE`,
    version: "1.0.0",
    description: "Exact fixed D-D trial",
    rationale: "Produce categorical evidence without promotion.",
    dependencies: [{ kind: "TIMEFRAME", timeframe: "1H" }],
    parameters: { threshold },
    evaluate: () => ({ status, reasons: [{ code: `DD_${status}`, message: status }] }),
  });
}

function hypothesis(
  hypothesisId: string,
  threshold: number,
  lifecycle: HypothesisLifecycle = "EVALUATION_PENDING"
): ResearchHypothesisDefinition {
  const exactRule = rule(hypothesisId, threshold);
  return {
    hypothesisId,
    version: "1.0.0",
    title: `${hypothesisId} evidence trial`,
    description: "One exact fixed preregistered trial.",
    rationale: "Preserve held-out evidence without selection.",
    rule: hypothesisRuleReference(exactRule),
    assetScope: ["BTC"],
    requiredDependencies: exactRule.dependencies,
    parameterSpace: [{ name: "threshold", kind: "FIXED", value: threshold }],
    researchIntent: {
      question: "What categorical evidence does the exact trial produce?",
      falsificationCriterion: "No machine-executable rejection threshold is declared.",
    },
    trainOosPolicy: {
      policyId: "DD-FIXED-OOS",
      training: { startTime: TRAIN_START, endTime: OOS_START },
      oos: { startTime: OOS_START, endTime: OOS_END },
      ordering: "TRAIN_BEFORE_OOS",
      oosReuse: "NEVER_TUNE_ON_OOS",
    },
    statefulOosBoundaryPolicy: "NOT_APPLICABLE",
    trialAccounting: {
      familyId: "DD-TRIALS",
      unit: "ONE_TRIAL_PER_RULE_PARAMETER_CONFIGURATION",
      variantHandling: "COUNT_EACH_VARIANT",
      declaredTrialCount: 1,
    },
    lifecycle,
    preRegistration: {
      declaredBy: "D-D-test",
      sourceReference: "D-D-test-plan",
      declarationOrdinal: threshold,
    },
  };
}

function observation(
  registry: HypothesisRegistrySnapshot,
  hypothesisId: "H-BASE" | "H-VAR",
  threshold: number,
  status: ResearchRuleStatus,
  time: number
): ShadowResearchObservation {
  const exactRule = rule(hypothesisId, threshold, status);
  return runStatelessShadowObservation({
    registry,
    hypothesisId,
    hypothesisVersion: "1.0.0",
    parameterConfiguration: { threshold },
    rule: exactRule,
    context: { assetId: "BTC", decisionTime: time, asOf: time, oneHourBars: bars(time) },
    featureVector: buildResearchFeatureVector({
      assetId: "BTC",
      decisionTime: time,
      asOf: time,
      definitions: [closeFeature],
      oneHourBars: bars(time),
    }),
  });
}

function heldOut(
  registry: HypothesisRegistrySnapshot,
  hypothesisId: "H-BASE" | "H-VAR",
  observations: readonly ShadowResearchObservation[]
): HeldOutOosEvidenceSummary {
  return evaluateHeldOutOosEvidence({
    registry,
    hypothesisId,
    hypothesisVersion: "1.0.0",
    observations,
  });
}

function familyFor(registry: HypothesisRegistrySnapshot): RobustnessFamilyPreregistration {
  const registered = (id: string) => registry.hypotheses.find((item) => item.hypothesisId === id)!;
  return defineRobustnessFamilyPreregistration(registry, {
    schemaVersion: ROBUSTNESS_FAMILY_PREREGISTRATION_SCHEMA_VERSION,
    familyId: "RF-DD-BTC",
    version: "1.0.0",
    title: "D-D BTC sensitivity",
    description: "Two exact fixed trials.",
    scientificRationale: "Describe shared-OOS sensitivity without selection.",
    baselineMemberId: "baseline",
    members: [
      {
        memberId: "baseline",
        hypothesisId: "H-BASE",
        hypothesisVersion: "1.0.0",
        hypothesisSemanticIdentity: registered("H-BASE").semanticIdentity,
        perturbation: { kind: "BASELINE", axisId: "BASELINE", description: "Reference." },
      },
      {
        memberId: "variant",
        hypothesisId: "H-VAR",
        hypothesisVersion: "1.0.0",
        hypothesisSemanticIdentity: registered("H-VAR").semanticIdentity,
        perturbation: { kind: "RULE_PARAMETER", axisId: "threshold", description: "Threshold change." },
      },
    ],
    expectedMemberCount: 2,
    commonAsset: "BTC",
    commonTrainingInterval: { startTime: TRAIN_START, endTime: OOS_START },
    commonOosInterval: { startTime: OOS_START, endTime: OOS_END },
    commonStatefulOosBoundaryPolicy: "NOT_APPLICABLE",
    observationCompletenessPolicy: {
      memberRequirement: "EVERY_DECLARED_MEMBER",
      observationGridRequirement: "EXACT_EXPECTED_DECISION_TIMES",
      expectedDecisionTimes: GRID,
      missingObservationOutcome: "INSUFFICIENT_EVIDENCE",
      insufficientEvidenceTreatment: "RETAIN_AND_REPORT",
      interpretation: "DESCRIPTIVE_ONLY_NO_ROBUSTNESS_THRESHOLD",
    },
    preRegistration: { declaredBy: "D-D-test", sourceReference: "D-D-family", declarationOrdinal: 1 },
    oosReusePolicy: "PREREGISTERED_SHARED_OOS_SENSITIVITY",
    selectionPolicy: "NO_POST_OOS_VARIANT_SELECTION",
    independentConfirmation: false,
    intendedUse: "RESEARCH_ROBUSTNESS_PREREGISTRATION_ONLY",
    predictiveValidityEstablished: false,
    approvedForPaperAction: false,
    grantsExecutionAuthority: false,
    priceAuthority: "NONE",
  });
}

function setup(options: {
  baseStatuses?: readonly ResearchRuleStatus[];
  baseTimes?: readonly number[];
  baseLifecycle?: HypothesisLifecycle;
} = {}) {
  const registry = createHypothesisRegistry([
    hypothesis("H-BASE", 1, options.baseLifecycle),
    hypothesis("H-VAR", 2),
  ]);
  const baseTimes = options.baseTimes ?? GRID;
  const baseStatuses = options.baseStatuses ?? baseTimes.map(() => "MATCH" as const);
  const baseObservations = baseTimes.map((time, index) =>
    observation(registry, "H-BASE", 1, baseStatuses[index], time)
  );
  const variantObservations = GRID.map((time) => observation(registry, "H-VAR", 2, "MATCH", time));
  const baseHeldOut = heldOut(registry, "H-BASE", baseObservations);
  const variantHeldOut = heldOut(registry, "H-VAR", variantObservations);
  const family = familyFor(registry);
  const members: RobustnessFamilyMemberEvidenceInput[] = [
    { memberId: "baseline", observations: baseObservations },
    { memberId: "variant", observations: variantObservations },
  ];
  const evaluation = evaluateRobustnessFamily({ registry, family, members });
  const baseInput: ResearchEvidenceInput = {
    hypothesisId: "H-BASE",
    hypothesisVersion: "1.0.0",
    heldOutEvidence: baseHeldOut,
  };
  const baseWithRobustness: ResearchEvidenceInput = {
    ...baseInput,
    robustnessEvidence: { family, evaluation, memberId: "baseline" },
  };
  const variantInput: ResearchEvidenceInput = {
    hypothesisId: "H-VAR",
    hypothesisVersion: "1.0.0",
    heldOutEvidence: variantHeldOut,
    robustnessEvidence: { family, evaluation, memberId: "variant" },
  };
  return {
    registry,
    family,
    evaluation,
    baseHeldOut,
    variantHeldOut,
    baseInput,
    baseWithRobustness,
    variantInput,
  };
}

function create(input?: ResearchEvidenceInput) {
  const current = setup();
  return createResearchEvidenceRegistry(current.registry, [input ?? current.baseWithRobustness]);
}

function forgeHeldOut(
  value: HeldOutOosEvidenceSummary,
  mutate: (draft: Record<string, any>) => void
): HeldOutOosEvidenceSummary {
  const draft = clone(value) as unknown as Record<string, any>;
  mutate(draft);
  return draft as unknown as HeldOutOosEvidenceSummary;
}

function forgeAndReidentifyHeldOut(
  value: HeldOutOosEvidenceSummary,
  mutate: (draft: Record<string, any>) => void
): HeldOutOosEvidenceSummary {
  const draft = clone(value) as unknown as Record<string, any>;
  mutate(draft);
  const { kind: _kind, semanticIdentity: _semanticIdentity, ...identityMaterial } = draft;
  draft.semanticIdentity = canonicalJson(identityMaterial);
  return draft as unknown as HeldOutOosEvidenceSummary;
}

function forgeEvaluation(
  value: RobustnessFamilyEvaluation,
  mutate: (draft: Record<string, any>) => void
): RobustnessFamilyEvaluation {
  const draft = clone(value) as unknown as Record<string, any>;
  mutate(draft);
  return draft as unknown as RobustnessFamilyEvaluation;
}

function candidateRangeSetup() {
  const exactRule = createResearchRule({
    ruleId: "H-VARIABLE-RULE",
    version: "1.0.0",
    description: "Exact member of a finite candidate/range space",
    rationale: "Validate one exact allowed configuration without selection.",
    dependencies: [{ kind: "TIMEFRAME", timeframe: "1H" }],
    parameters: { threshold: 2, window: 3 },
    evaluate: () => ({ status: "MATCH" as const, reasons: [{ code: "MATCH", message: "match" }] }),
  });
  const definition: ResearchHypothesisDefinition = {
    ...hypothesis("H-BASE", 1),
    hypothesisId: "H-VARIABLE",
    rule: hypothesisRuleReference(exactRule),
    requiredDependencies: exactRule.dependencies,
    parameterSpace: [
      { name: "threshold", kind: "CANDIDATES", values: [1, 2] },
      { name: "window", kind: "RANGE", minimum: 2, maximum: 4, step: 1 },
    ],
    trialAccounting: {
      familyId: "DD-VARIABLE-TRIALS",
      unit: "ONE_TRIAL_PER_RULE_PARAMETER_CONFIGURATION",
      variantHandling: "COUNT_EACH_VARIANT",
      declaredTrialCount: 6,
    },
  };
  const registry = createHypothesisRegistry([definition]);
  const evidence = runStatelessShadowObservation({
    registry,
    hypothesisId: "H-VARIABLE",
    hypothesisVersion: "1.0.0",
    parameterConfiguration: { threshold: 2, window: 3 },
    rule: exactRule,
    context: { assetId: "BTC", decisionTime: OOS_START, asOf: OOS_START, oneHourBars: bars(OOS_START) },
    featureVector: buildResearchFeatureVector({
      assetId: "BTC",
      decisionTime: OOS_START,
      asOf: OOS_START,
      definitions: [closeFeature],
      oneHourBars: bars(OOS_START),
    }),
  });
  const summary = evaluateHeldOutOosEvidence({
    registry,
    hypothesisId: "H-VARIABLE",
    hypothesisVersion: "1.0.0",
    observations: [evidence],
  });
  const input: ResearchEvidenceInput = {
    hypothesisId: "H-VARIABLE",
    hypothesisVersion: "1.0.0",
    heldOutEvidence: summary,
  };
  return { registry, summary, input };
}

describe("M13D D-D research Evidence Registry", () => {
  it("accepts a valid exact FIXED parameter configuration", () => {
    const current = setup();
    expect(createResearchEvidenceRegistry(current.registry, [current.baseInput]).entries[0].status)
      .toBe("CANDIDATE");
  });

  it("accepts one exact allowed CANDIDATES/RANGE configuration without selecting it", () => {
    const current = candidateRangeSetup();
    const entry = createResearchEvidenceRegistry(current.registry, [current.input]).entries[0];
    expect(entry.status).toBe("CANDIDATE");
    expect(entry.parameterConfigurationIdentity).toBe(current.summary.binding.parameterConfigurationIdentity);
    expect(entry.classificationReasons).toContain("PROMOTION_AND_REJECTION_METHODOLOGY_UNAVAILABLE");
  });

  it("rejects an out-of-space CANDIDATES/RANGE identity even when D-A is reidentified", () => {
    const current = candidateRangeSetup();
    const hypothesisIdentity = current.registry.hypotheses[0].semanticIdentity;
    const forged = forgeAndReidentifyHeldOut(current.summary, (draft) => {
      draft.binding.parameterConfigurationIdentity = canonicalJson({
        hypothesisSemanticIdentity: hypothesisIdentity,
        parameters: { threshold: 2, window: 5 },
      });
    });
    expect(() => createResearchEvidenceRegistry(
      current.registry,
      [{ ...current.input, heldOutEvidence: forged }]
    )).toThrow(/outside the preregistered finite space/i);
  });

  it("creates deterministic identity and serialization independent of input order", () => {
    const current = setup();
    const first = createResearchEvidenceRegistry(current.registry, [current.baseWithRobustness, current.variantInput]);
    const second = createResearchEvidenceRegistry(current.registry, [current.variantInput, current.baseWithRobustness]);
    expect(first.semanticIdentity).toBe(second.semanticIdentity);
    expect(serializeResearchEvidenceRegistry(first)).toBe(serializeResearchEvidenceRegistry(second));
  });

  it("binds the exact hypothesis and rule identities", () => {
    const current = setup();
    const entry = createResearchEvidenceRegistry(current.registry, [current.baseInput]).entries[0];
    const hypothesis = current.registry.hypotheses.find((item) => item.hypothesisId === "H-BASE")!;
    expect(entry).toMatchObject({
      hypothesisSemanticIdentity: hypothesis.semanticIdentity,
      ruleSemanticIdentity: hypothesis.rule.semanticIdentity,
    });
  });

  it("binds the exact parameter and trial identities", () => {
    const current = setup();
    const entry = createResearchEvidenceRegistry(current.registry, [current.baseInput]).entries[0];
    expect(entry.parameterConfigurationIdentity).toBe(current.baseHeldOut.binding.parameterConfigurationIdentity);
    expect(entry.trialAccountingIdentity).toBe(current.baseHeldOut.binding.trialAccountingIdentity);
  });

  it("binds exact D-A evidence identity", () => {
    const current = setup();
    expect(createResearchEvidenceRegistry(current.registry, [current.baseInput]).entries[0]
      .heldOutEvidenceSemanticIdentity).toBe(current.baseHeldOut.semanticIdentity);
  });

  it("binds D-B family, evaluation, member, and D-A evidence when supplied", () => {
    const current = setup();
    const binding = createResearchEvidenceRegistry(current.registry, [current.baseWithRobustness])
      .entries[0].robustnessEvidence;
    expect(binding).toMatchObject({
      familySemanticIdentity: current.family.semanticIdentity,
      evaluationSemanticIdentity: current.evaluation.semanticIdentity,
      memberId: "baseline",
      independentConfirmation: false,
      selectionPolicy: "NO_POST_OOS_VARIANT_SELECTION",
    });
  });

  it("classifies complete current M13 evidence as research-only CANDIDATE", () => {
    const entry = create().entries[0];
    expect(entry.status).toBe("CANDIDATE");
    expect(entry.classificationReasons).toContain("PROMOTION_AND_REJECTION_METHODOLOGY_UNAVAILABLE");
  });

  it("classifies observed insufficient D-A evidence as INSUFFICIENT_EVIDENCE", () => {
    const current = setup({ baseStatuses: ["INSUFFICIENT_EVIDENCE", "MATCH", "NO_MATCH"] });
    const entry = createResearchEvidenceRegistry(current.registry, [current.baseInput]).entries[0];
    expect(entry.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(entry.classificationReasons).toContain("HELD_OUT_EVIDENCE_CONTAINS_INSUFFICIENT_OBSERVATIONS");
  });

  it("classifies incomplete required D-B grid evidence as INSUFFICIENT_EVIDENCE", () => {
    const current = setup({ baseTimes: [GRID[0], GRID[2]] });
    const entry = createResearchEvidenceRegistry(current.registry, [current.baseWithRobustness]).entries[0];
    expect(entry.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(entry.classificationReasons).toContain("SHARED_OOS_SENSITIVITY_EVIDENCE_INCOMPLETE");
  });

  it("does not automatically emit APPROVED_FOR_PAPER", () => {
    const registry = create();
    expect(registry.entries.every((entry) => entry.status !== ("APPROVED_FOR_PAPER" as never))).toBe(true);
    expect(registry.unavailableStatuses).toContain("APPROVED_FOR_PAPER");
    expect(registry.approvedForPaperAction).toBe(false);
  });

  it("does not infer REJECTED from NO_MATCH counts", () => {
    const current = setup({ baseStatuses: ["NO_MATCH", "NO_MATCH", "NO_MATCH"] });
    const entry = createResearchEvidenceRegistry(current.registry, [current.baseInput]).entries[0];
    expect(entry.status).toBe("CANDIDATE");
    expect(entry.rejectionDisposition).toBe("UNAVAILABLE_NO_MACHINE_EXECUTABLE_FALSIFICATION_CONTRACT");
  });

  it("does not convert a free-text REJECTED lifecycle into a D-D rejection conclusion", () => {
    const current = setup({ baseLifecycle: "REJECTED" });
    const entry = createResearchEvidenceRegistry(current.registry, [current.baseInput]).entries[0];
    expect(entry.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(entry.status).not.toBe("REJECTED" as never);
  });

  it("preserves D-B shared-OOS as non-independent and non-selecting", () => {
    const binding = create().entries[0].robustnessEvidence!;
    expect(binding.independentConfirmation).toBe(false);
    expect(binding.selectionPolicy).toBe("NO_POST_OOS_VARIANT_SELECTION");
    expect(binding.interpretation).toBe("DESCRIPTIVE_ONLY_NO_ROBUSTNESS_THRESHOLD");
  });

  it("rejects a stale or forged hypothesis identity", () => {
    const current = setup();
    const forged = clone(current.registry) as unknown as Record<string, any>;
    forged.hypotheses[0].rationale = "forged";
    expect(() => createResearchEvidenceRegistry(
      forged as unknown as HypothesisRegistrySnapshot,
      [current.baseInput]
    )).toThrow(/forged|stale/i);
  });

  it("rejects a stale trial identity", () => {
    const current = setup();
    const forged = forgeAndReidentifyHeldOut(current.baseHeldOut, (draft) => {
      draft.binding.trialAccountingIdentity = "forged-trial";
    });
    expect(() => createResearchEvidenceRegistry(current.registry, [{ ...current.baseInput, heldOutEvidence: forged }]))
      .toThrow(/trial contract/i);
  });

  it("rejects a stale D-A identity", () => {
    const current = setup();
    const forged = forgeHeldOut(current.baseHeldOut, (draft) => { draft.semanticIdentity = "forged"; });
    expect(() => createResearchEvidenceRegistry(current.registry, [{ ...current.baseInput, heldOutEvidence: forged }]))
      .toThrow(/semantic identity/i);
  });

  it("rejects a forged parameter identity even when D-A retains its stale identity", () => {
    const current = setup();
    const forged = forgeHeldOut(current.baseHeldOut, (draft) => {
      draft.binding.parameterConfigurationIdentity = "forged-parameter-identity";
    });
    expect(() => createResearchEvidenceRegistry(current.registry, [{ ...current.baseInput, heldOutEvidence: forged }]))
      .toThrow(/parameterConfigurationIdentity/i);
  });

  it("rejects a forged parameter identity even when D-A semantic identity is recomputed", () => {
    const current = setup();
    const hypothesisIdentity = current.registry.hypotheses.find((item) => item.hypothesisId === "H-BASE")!
      .semanticIdentity;
    const forged = forgeAndReidentifyHeldOut(current.baseHeldOut, (draft) => {
      draft.binding.parameterConfigurationIdentity = canonicalJson({
        hypothesisSemanticIdentity: hypothesisIdentity,
        parameters: { threshold: 999 },
      });
    });
    expect(() => createResearchEvidenceRegistry(current.registry, [{ ...current.baseInput, heldOutEvidence: forged }]))
      .toThrow(/outside the preregistered finite space/i);
  });

  it("rejects a configuration identity belonging to another declared hypothesis", () => {
    const current = setup();
    const forged = forgeAndReidentifyHeldOut(current.baseHeldOut, (draft) => {
      draft.binding.parameterConfigurationIdentity = current.variantHeldOut.binding.parameterConfigurationIdentity;
    });
    expect(() => createResearchEvidenceRegistry(current.registry, [{ ...current.baseInput, heldOutEvidence: forged }]))
      .toThrow(/contradicts the registered hypothesis/i);
  });

  it("rejects malformed D-A counts even when the stale identity is copied", () => {
    const current = setup();
    const forged = forgeHeldOut(current.baseHeldOut, (draft) => { draft.counts.match += 1; });
    expect(() => createResearchEvidenceRegistry(current.registry, [{ ...current.baseInput, heldOutEvidence: forged }]))
      .toThrow(/counts/i);
  });

  it("rejects a stale D-B evaluation identity", () => {
    const current = setup();
    const evaluation = forgeEvaluation(current.evaluation, (draft) => { draft.semanticIdentity = "forged"; });
    const input = { ...current.baseWithRobustness, robustnessEvidence: { family: current.family, evaluation, memberId: "baseline" } };
    expect(() => createResearchEvidenceRegistry(current.registry, [input])).toThrow(/semantic identity/i);
  });

  it("rejects a stale D-B family identity", () => {
    const current = setup();
    const family = clone(current.family) as unknown as Record<string, any>;
    family.semanticIdentity = "forged";
    const input = {
      ...current.baseWithRobustness,
      robustnessEvidence: {
        family: family as unknown as RobustnessFamilyPreregistration,
        evaluation: current.evaluation,
        memberId: "baseline",
      },
    };
    expect(() => createResearchEvidenceRegistry(current.registry, [input])).toThrow(/forged|stale/i);
  });

  it("rejects asset mismatch", () => {
    const current = setup();
    const forged = forgeHeldOut(current.baseHeldOut, (draft) => { draft.binding.assetId = "PAXG"; });
    expect(() => createResearchEvidenceRegistry(current.registry, [{ ...current.baseInput, heldOutEvidence: forged }]))
      .toThrow(/binding|asset/i);
  });

  it("rejects OOS interval mismatch", () => {
    const current = setup();
    const forged = forgeHeldOut(current.baseHeldOut, (draft) => { draft.binding.oosInterval.endTime += HOUR; });
    expect(() => createResearchEvidenceRegistry(current.registry, [{ ...current.baseInput, heldOutEvidence: forged }]))
      .toThrow(/binding|trial contract/i);
  });

  it("rejects state-policy mismatch", () => {
    const current = setup();
    const forged = forgeHeldOut(current.baseHeldOut, (draft) => {
      draft.binding.statefulOosBoundaryPolicy = "RESET_AT_OOS_START";
    });
    expect(() => createResearchEvidenceRegistry(current.registry, [{ ...current.baseInput, heldOutEvidence: forged }]))
      .toThrow(/binding|trial contract/i);
  });

  it("rejects contradictory D-B member binding", () => {
    const current = setup();
    const input = {
      ...current.baseWithRobustness,
      robustnessEvidence: { family: current.family, evaluation: current.evaluation, memberId: "variant" },
    };
    expect(() => createResearchEvidenceRegistry(current.registry, [input])).toThrow(/contradicts/i);
  });

  it("rejects duplicate evidence entries", () => {
    const current = setup();
    expect(() => createResearchEvidenceRegistry(
      current.registry,
      [current.baseWithRobustness, current.baseWithRobustness]
    )).toThrow(/duplicate evidence entry/i);
  });

  it("rejects malformed entry authority", () => {
    const forged = clone(create()) as unknown as Record<string, any>;
    forged.entries[0].grantsExecutionAuthority = true;
    expect(() => validateResearchEvidenceRegistry(forged as unknown as ResearchEvidenceRegistrySnapshot))
      .toThrow(/authority/i);
  });

  it("rejects malformed top-level authority", () => {
    const forged = clone(create()) as unknown as Record<string, any>;
    forged.approvedForPaperAction = true;
    expect(() => validateResearchEvidenceRegistry(forged as unknown as ResearchEvidenceRegistrySnapshot))
      .toThrow(/authority/i);
  });

  it("contains no economic metrics, ranking, score, winner, or action fields", () => {
    const serialized = serializeResearchEvidenceRegistry(create()).toLowerCase();
    for (const forbidden of ["pnl", "sharpe", "drawdown", "winrate", "profitability", "ranking", "score", "winner", "targetweight", "buy", "sell"]) {
      expect(serialized).not.toContain(`\"${forbidden}\"`);
    }
  });

  it("does not expose StrategyEligibility, ActionDecision, or execution authority", () => {
    const registry = create();
    const serialized = serializeResearchEvidenceRegistry(registry);
    expect(serialized).not.toContain("StrategyEligibility");
    expect(serialized).not.toContain("ActionDecision");
    expect(registry).toMatchObject({
      predictiveValidityEstablished: false,
      approvedForPaperAction: false,
      grantsExecutionAuthority: false,
      priceAuthority: "NONE",
    });
  });

  it("does not mutate or freeze caller-owned input wrappers", () => {
    const current = setup();
    const input: ResearchEvidenceInput = { ...current.baseWithRobustness };
    const before = JSON.stringify(input);
    createResearchEvidenceRegistry(current.registry, [input]);
    expect(JSON.stringify(input)).toBe(before);
    expect(Object.isFrozen(input)).toBe(false);
  });

  it("returns a deeply immutable registry", () => {
    const registry = create();
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.entries)).toBe(true);
    expect(Object.isFrozen(registry.entries[0])).toBe(true);
    expect(Object.isFrozen(registry.entries[0].provenance)).toBe(true);
  });

  it("rejects a forged output entry identity", () => {
    const forged = clone(create()) as unknown as Record<string, any>;
    forged.entries[0].classificationReasons = ["forged"];
    expect(() => validateResearchEvidenceRegistry(forged as unknown as ResearchEvidenceRegistrySnapshot))
      .toThrow(/semantic identity/i);
  });

  it("rejects a forged registry identity", () => {
    const forged = clone(create()) as unknown as Record<string, any>;
    forged.semanticIdentity = "forged";
    expect(() => serializeResearchEvidenceRegistry(forged as unknown as ResearchEvidenceRegistrySnapshot))
      .toThrow(/semantic identity/i);
  });

  it("keeps validation from freezing caller-owned forged snapshots", () => {
    const forged = clone(create()) as unknown as Record<string, any>;
    forged.semanticIdentity = "forged";
    expect(() => validateResearchEvidenceRegistry(forged as unknown as ResearchEvidenceRegistrySnapshot)).toThrow();
    expect(Object.isFrozen(forged)).toBe(false);
    expect(Object.isFrozen(forged.entries[0])).toBe(false);
  });
});
