import { describe, expect, it } from "vitest";
import {
  createHypothesisRegistry,
  hypothesisRuleReference,
  serializeHypothesisRegistry,
  type HypothesisRegistrySnapshot,
  type ResearchHypothesisDefinition,
  type StatefulOosBoundaryPolicy,
} from "../hypothesisRegistry";
import { createResearchRule } from "../researchRules";
import {
  ROBUSTNESS_FAMILY_PREREGISTRATION_SCHEMA_VERSION,
  defineRobustnessFamilyPreregistration,
  serializeRobustnessFamilyPreregistration,
  validateRobustnessFamilyPreregistration,
  type RobustnessFamilyMemberDefinition,
  type RobustnessFamilyPreregistration,
  type RobustnessFamilyPreregistrationDefinition,
} from "../robustnessFamilyPreregistration";

const HOUR = 3_600_000;
const TRAIN_START = Date.UTC(2020, 0, 1);
const TRAIN_END = Date.UTC(2022, 0, 1);
const OOS_END = Date.UTC(2023, 0, 1);

function rule(ruleId: string, threshold: number) {
  return createResearchRule({
    ruleId,
    version: "1.0.0",
    description: `${ruleId} fixed rule`,
    rationale: "Exercise exact fixed robustness trials.",
    dependencies: [{ kind: "TIMEFRAME", timeframe: "1H" }],
    parameters: { threshold },
    evaluate: () => ({ status: "NO_MATCH", reasons: [{ code: "TEST", message: "Test only." }] }),
  });
}

function hypothesis(
  hypothesisId: string,
  threshold: number,
  overrides: Partial<ResearchHypothesisDefinition> = {}
): ResearchHypothesisDefinition {
  const exactRule = rule(`${hypothesisId}-RULE`, threshold);
  return {
    hypothesisId,
    version: "1.0.0",
    title: `${hypothesisId} exact trial`,
    description: "One exact fixed preregistered robustness trial.",
    rationale: "A scientific perturbation declared before shared-OOS inspection.",
    rule: hypothesisRuleReference(exactRule),
    assetScope: ["BTC"],
    requiredDependencies: exactRule.dependencies,
    parameterSpace: [{ name: "threshold", kind: "FIXED", value: threshold }],
    researchIntent: {
      question: "Does categorical evidence remain stable under this declared perturbation?",
      falsificationCriterion: "Retain all MATCH, NO_MATCH, and insufficient evidence.",
    },
    trainOosPolicy: {
      policyId: "DB-R1-COMMON-OOS",
      training: { startTime: TRAIN_START, endTime: TRAIN_END },
      oos: { startTime: TRAIN_END, endTime: OOS_END },
      ordering: "TRAIN_BEFORE_OOS",
      oosReuse: "NEVER_TUNE_ON_OOS",
    },
    statefulOosBoundaryPolicy: "NOT_APPLICABLE",
    trialAccounting: {
      familyId: "DB-R1-EXACT-TRIALS",
      unit: "ONE_TRIAL_PER_RULE_PARAMETER_CONFIGURATION",
      variantHandling: "COUNT_EACH_VARIANT",
      declaredTrialCount: 1,
    },
    lifecycle: "PREREGISTERED",
    preRegistration: {
      declaredBy: "D-B-R1-test",
      sourceReference: "robustness-family-test-plan",
      declarationOrdinal: threshold,
    },
    ...overrides,
  };
}

function registryWith(
  extra: readonly ResearchHypothesisDefinition[] = []
): HypothesisRegistrySnapshot {
  return createHypothesisRegistry([
    hypothesis("H-BASELINE", 1),
    hypothesis("H-VARIANT", 2),
    ...extra,
  ]);
}

function member(
  registry: HypothesisRegistrySnapshot,
  hypothesisId: string,
  memberId: string,
  kind: RobustnessFamilyMemberDefinition["perturbation"]["kind"]
): RobustnessFamilyMemberDefinition {
  const registered = registry.hypotheses.find((item) => item.hypothesisId === hypothesisId);
  if (!registered) throw new Error(`Missing test hypothesis ${hypothesisId}.`);
  return {
    memberId,
    hypothesisId: registered.hypothesisId,
    hypothesisVersion: registered.version,
    hypothesisSemanticIdentity: registered.semanticIdentity,
    perturbation: {
      kind,
      axisId: kind === "BASELINE" ? "BASELINE" : "threshold",
      description: kind === "BASELINE" ? "Declared reference trial." : "Declared threshold perturbation.",
    },
  };
}

function familyDefinition(
  registry: HypothesisRegistrySnapshot,
  overrides: Partial<RobustnessFamilyPreregistrationDefinition> = {}
): RobustnessFamilyPreregistrationDefinition {
  return {
    schemaVersion: ROBUSTNESS_FAMILY_PREREGISTRATION_SCHEMA_VERSION,
    familyId: "RF-BTC-THRESHOLD",
    version: "1.0.0",
    title: "BTC threshold sensitivity family",
    description: "Finite exact fixed trials sharing one OOS observation grid.",
    scientificRationale: "Check whether categorical evidence is fragile to a declared threshold change.",
    baselineMemberId: "baseline",
    members: [
      member(registry, "H-BASELINE", "baseline", "BASELINE"),
      member(registry, "H-VARIANT", "threshold-up", "RULE_PARAMETER"),
    ],
    expectedMemberCount: 2,
    commonAsset: "BTC",
    commonTrainingInterval: { startTime: TRAIN_START, endTime: TRAIN_END },
    commonOosInterval: { startTime: TRAIN_END, endTime: OOS_END },
    commonStatefulOosBoundaryPolicy: "NOT_APPLICABLE",
    observationCompletenessPolicy: {
      memberRequirement: "EVERY_DECLARED_MEMBER",
      observationGridRequirement: "EXACT_EXPECTED_DECISION_TIMES",
      expectedDecisionTimes: [TRAIN_END, TRAIN_END + HOUR],
      missingObservationOutcome: "INSUFFICIENT_EVIDENCE",
      insufficientEvidenceTreatment: "RETAIN_AND_REPORT",
      interpretation: "DESCRIPTIVE_ONLY_NO_ROBUSTNESS_THRESHOLD",
    },
    preRegistration: {
      declaredBy: "D-B-R1-test",
      sourceReference: "robustness-family-test-plan",
      declarationOrdinal: 1,
    },
    oosReusePolicy: "PREREGISTERED_SHARED_OOS_SENSITIVITY",
    selectionPolicy: "NO_POST_OOS_VARIANT_SELECTION",
    independentConfirmation: false,
    intendedUse: "RESEARCH_ROBUSTNESS_PREREGISTRATION_ONLY",
    predictiveValidityEstablished: false,
    approvedForPaperAction: false,
    grantsExecutionAuthority: false,
    priceAuthority: "NONE",
    ...overrides,
  };
}

describe("M13D D-B-R1 robustness family preregistration", () => {
  it("accepts a valid finite family of exact fixed trials", () => {
    const registry = registryWith();
    const family = defineRobustnessFamilyPreregistration(registry, familyDefinition(registry));
    expect(family).toMatchObject({
      familyId: "RF-BTC-THRESHOLD",
      expectedMemberCount: 2,
      commonAsset: "BTC",
      independentConfirmation: false,
      predictiveValidityEstablished: false,
      approvedForPaperAction: false,
      grantsExecutionAuthority: false,
      priceAuthority: "NONE",
    });
    expect(family.baselineMemberIdentity).toBe(family.members[0].trialIdentity);
  });

  it("canonicalizes member order for deterministic identity and serialization", () => {
    const registry = registryWith();
    const left = defineRobustnessFamilyPreregistration(registry, familyDefinition(registry));
    const base = familyDefinition(registry);
    const right = defineRobustnessFamilyPreregistration(registry, {
      ...base,
      members: [...base.members].reverse(),
    });
    expect(right.members.map((item) => item.memberId)).toEqual(["baseline", "threshold-up"]);
    expect(right.semanticIdentity).toBe(left.semanticIdentity);
    expect(serializeRobustnessFamilyPreregistration(registry, right))
      .toBe(serializeRobustnessFamilyPreregistration(registry, left));
  });

  it("requires the baseline to be exactly one declared member", () => {
    const registry = registryWith();
    expect(() => defineRobustnessFamilyPreregistration(registry, familyDefinition(registry, {
      baselineMemberId: "missing",
    }))).toThrow(/baseline/);
  });

  it("rejects duplicate member IDs and duplicate exact hypothesis trials", () => {
    const registry = registryWith();
    const base = familyDefinition(registry);
    expect(() => defineRobustnessFamilyPreregistration(registry, {
      ...base,
      members: [base.members[0], { ...base.members[1], memberId: "baseline" }],
    })).toThrow(/duplicate family memberId/);
    expect(() => defineRobustnessFamilyPreregistration(registry, {
      ...base,
      members: [base.members[0], { ...base.members[0], memberId: "duplicate-trial", perturbation: base.members[1].perturbation }],
    })).toThrow(/duplicate family hypothesis\/trial/);
  });

  it("rejects an incorrect declared member count", () => {
    const registry = registryWith();
    expect(() => defineRobustnessFamilyPreregistration(registry, familyDefinition(registry, {
      expectedMemberCount: 3,
    }))).toThrow(/exactly equal/);
  });

  it("rejects an unknown or stale hypothesis identity", () => {
    const registry = registryWith();
    const base = familyDefinition(registry);
    expect(() => defineRobustnessFamilyPreregistration(registry, {
      ...base,
      members: [base.members[0], { ...base.members[1], hypothesisSemanticIdentity: "unknown" }],
    })).toThrow(/exactly one registered hypothesis/);
  });

  it("rejects mixed assets and multi-asset trial ambiguity", () => {
    const paxg = hypothesis("H-PAXG", 3, { assetScope: ["PAXG"] });
    const multi = hypothesis("H-MULTI", 4, { assetScope: ["BTC", "PAXG"] });
    const registry = registryWith([paxg, multi]);
    const base = familyDefinition(registry);
    for (const hypothesisId of ["H-PAXG", "H-MULTI"]) {
      expect(() => defineRobustnessFamilyPreregistration(registry, {
        ...base,
        members: [base.members[0], member(registry, hypothesisId, "other", "RULE_PARAMETER")],
      })).toThrow(/exact single-asset trial/);
    }
  });

  it("rejects mixed TRAIN or OOS intervals", () => {
    const shiftedTraining = hypothesis("H-TRAIN-SHIFT", 3, {
      trainOosPolicy: {
        ...hypothesis("TEMP", 3).trainOosPolicy,
        training: { startTime: TRAIN_START + HOUR, endTime: TRAIN_END },
      },
    });
    const shiftedOos = hypothesis("H-OOS-SHIFT", 4, {
      trainOosPolicy: {
        ...hypothesis("TEMP", 4).trainOosPolicy,
        oos: { startTime: TRAIN_END + HOUR, endTime: OOS_END },
      },
    });
    const registry = registryWith([shiftedTraining, shiftedOos]);
    const base = familyDefinition(registry);
    for (const hypothesisId of ["H-TRAIN-SHIFT", "H-OOS-SHIFT"]) {
      expect(() => defineRobustnessFamilyPreregistration(registry, {
        ...base,
        members: [base.members[0], member(registry, hypothesisId, "shifted", "RULE_PARAMETER")],
      })).toThrow(/common TRAIN\/OOS intervals/);
    }
  });

  it("rejects mixed RESET/CARRY or stateless boundary policies", () => {
    const policies: StatefulOosBoundaryPolicy[] = ["RESET_AT_OOS_START", "CARRY_PIT_STATE_FROM_PRE_OOS"];
    const extra = policies.map((policy, index) => hypothesis(`H-POLICY-${index}`, index + 3, {
      statefulOosBoundaryPolicy: policy,
    }));
    const registry = registryWith(extra);
    const base = familyDefinition(registry);
    for (const item of extra) {
      expect(() => defineRobustnessFamilyPreregistration(registry, {
        ...base,
        members: [base.members[0], member(registry, item.hypothesisId, "policy", "RULE_PARAMETER")],
      })).toThrow(/common stateful OOS boundary policy/);
    }
  });

  it("rejects malformed perturbation metadata and baseline role mismatch", () => {
    const registry = registryWith();
    const base = familyDefinition(registry);
    expect(() => defineRobustnessFamilyPreregistration(registry, {
      ...base,
      members: [base.members[0], {
        ...base.members[1],
        perturbation: { ...base.members[1].perturbation, axisId: "" },
      }],
    })).toThrow(/axisId/);
    expect(() => defineRobustnessFamilyPreregistration(registry, {
      ...base,
      members: [{ ...base.members[0], perturbation: base.members[1].perturbation }, base.members[1]],
    })).toThrow(/baseline/);
  });

  it("rejects candidate spaces instead of treating them as exact fixed trials", () => {
    const candidate = hypothesis("H-CANDIDATE", 3, {
      parameterSpace: [{ name: "threshold", kind: "CANDIDATES", values: [3, 4] }],
      trialAccounting: {
        ...hypothesis("TEMP", 3).trialAccounting,
        declaredTrialCount: 2,
      },
    });
    const registry = registryWith([candidate]);
    const base = familyDefinition(registry);
    expect(() => defineRobustnessFamilyPreregistration(registry, {
      ...base,
      members: [base.members[0], member(registry, "H-CANDIDATE", "candidate", "RULE_PARAMETER")],
    })).toThrow(/not an exact fixed one-trial hypothesis/);
  });

  it.each([
    ["OOS reuse", { oosReusePolicy: "REUSE_FOR_TUNING" }],
    ["selection", { selectionPolicy: "SELECT_BEST" }],
    ["independent confirmation", { independentConfirmation: true }],
    ["predictive authority", { predictiveValidityEstablished: true }],
    ["paper authority", { approvedForPaperAction: true }],
    ["execution authority", { grantsExecutionAuthority: true }],
    ["price authority", { priceAuthority: "CANONICAL" }],
  ] as const)("fixes %s semantics fail-closed", (_label, forged) => {
    const registry = registryWith();
    expect(() => defineRobustnessFamilyPreregistration(registry, {
      ...familyDefinition(registry),
      ...forged,
    } as unknown as RobustnessFamilyPreregistrationDefinition)).toThrow(/incompatible methodology/);
  });

  it("rejects free-form runtime parameter and result-selection fields", () => {
    const registry = registryWith();
    const base = familyDefinition(registry);
    expect(() => defineRobustnessFamilyPreregistration(registry, {
      ...base,
      members: [{ ...base.members[0], parameterConfiguration: { threshold: 99 } }, base.members[1]],
    } as RobustnessFamilyPreregistrationDefinition)).toThrow(/not part of the preregistration contract/);
    expect(() => defineRobustnessFamilyPreregistration(registry, {
      ...base,
      score: 1,
    } as RobustnessFamilyPreregistrationDefinition)).toThrow(/prohibited/);
  });

  it("requires a strict explicit OOS observation grid", () => {
    const registry = registryWith();
    const base = familyDefinition(registry);
    for (const expectedDecisionTimes of [[], [TRAIN_END, TRAIN_END], [TRAIN_END - HOUR]]) {
      expect(() => defineRobustnessFamilyPreregistration(registry, {
        ...base,
        observationCompletenessPolicy: {
          ...base.observationCompletenessPolicy,
          expectedDecisionTimes,
        },
      })).toThrow(/expectedDecisionTimes|finite non-empty grid/);
    }
  });

  it("changes identity when scientific family content changes", () => {
    const registry = registryWith();
    const left = defineRobustnessFamilyPreregistration(registry, familyDefinition(registry));
    const right = defineRobustnessFamilyPreregistration(registry, familyDefinition(registry, {
      scientificRationale: "A different preregistered scientific rationale.",
    }));
    expect(right.semanticIdentity).not.toBe(left.semanticIdentity);
  });

  it("rejects forged or stale family identity and resolved trial evidence", () => {
    const registry = registryWith();
    const family = defineRobustnessFamilyPreregistration(registry, familyDefinition(registry));
    const staleRationale = { ...family, scientificRationale: "forged" } as RobustnessFamilyPreregistration;
    const staleTrial = {
      ...family,
      members: [{ ...family.members[0], trialIdentity: "forged" }, family.members[1]],
    } as RobustnessFamilyPreregistration;
    expect(() => validateRobustnessFamilyPreregistration(registry, staleRationale)).toThrow(/forged or stale/);
    expect(() => serializeRobustnessFamilyPreregistration(registry, staleTrial)).toThrow(/forged or stale/);
  });

  it("does not mutate inputs and returns deeply immutable state", () => {
    const registry = registryWith();
    const input = familyDefinition(registry);
    const before = JSON.stringify(input);
    const family = defineRobustnessFamilyPreregistration(registry, input);
    expect(JSON.stringify(input)).toBe(before);
    expect(Object.isFrozen(family)).toBe(true);
    expect(Object.isFrozen(family.members)).toBe(true);
    expect(Object.isFrozen(family.members[0].perturbation)).toBe(true);
    expect(Object.isFrozen(family.observationCompletenessPolicy.expectedDecisionTimes)).toBe(true);
  });

  it("leaves existing C-D hypothesis registry behavior unchanged", () => {
    const registry = registryWith();
    const before = serializeHypothesisRegistry(registry);
    defineRobustnessFamilyPreregistration(registry, familyDefinition(registry));
    expect(serializeHypothesisRegistry(registry)).toBe(before);
    expect(registry.hypotheses).toHaveLength(2);
  });

  it("contains no evaluation, ranking, selection result, promotion, or trading contract", () => {
    const registry = registryWith();
    const serialized = serializeRobustnessFamilyPreregistration(
      registry,
      defineRobustnessFamilyPreregistration(registry, familyDefinition(registry))
    );
    expect(serialized).not.toMatch(/"(performance|return|sharpe|winRate|ranking|score|winner|selectedParameters|promotion|pnl|targetWeight|ActionDecision)"\s*:/i);
  });
});
