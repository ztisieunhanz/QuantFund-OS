import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  canonicalResearchRuntimeStateSource,
  createAvailableCanonicalResearchRuntimeState,
  createUnavailableCanonicalResearchRuntimeState,
  markCanonicalResearchRuntimeStateUnavailable,
  publishCanonicalResearchArtifacts,
} from "../canonicalResearchRuntimeState";
import {
  createHypothesisRegistry,
  hypothesisRuleReference,
  type HypothesisRegistrySnapshot,
  type ResearchHypothesisDefinition,
} from "../hypothesisRegistry";
import { evaluateHeldOutOosEvidence } from "../heldOutOosEvaluation";
import { buildResearchFeatureVector, type ResearchFeatureDefinition } from "../researchFeatureBuilder";
import {
  createResearchEvidenceRegistry,
  type ResearchEvidenceRegistrySnapshot,
} from "../researchEvidenceRegistry";
import { createResearchRule, type ResearchRuleStatus } from "../researchRules";
import { runStatelessShadowObservation } from "../shadowResearchHarness";
import {
  createStrategyEligibilityRegistry,
  type StrategyEligibilityRegistrySnapshot,
} from "../strategyEligibility";
import { BAR_DURATION_MS } from "../timeDomain";
import type { PointInTimeBar } from "../types";

const TRAIN_START = Date.UTC(2020, 0, 1);
const OOS_START = Date.UTC(2022, 0, 1);
const OOS_END = OOS_START + 2 * BAR_DURATION_MS;

const closeFeature: ResearchFeatureDefinition = {
  featureId: "RUNTIME_BRIDGE_1H_CLOSE",
  version: "1.0.0",
  description: "Canonical closed-bar test evidence",
  dependency: { kind: "TIMEFRAME", timeframe: "1H" },
  transformation: { kind: "BAR_CLOSE", lag: 0 },
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function bars(decisionTime: number): PointInTimeBar[] {
  return [{
    timestamp: decisionTime - BAR_DURATION_MS,
    open: 100,
    high: 102,
    low: 99,
    close: 101,
    volume: 10,
  }];
}

function canonicalArtifacts(
  hypothesisId = "H-RUNTIME-BRIDGE",
  evidenceStatus: ResearchRuleStatus = "MATCH"
) {
  const rule = createResearchRule({
    ruleId: `${hypothesisId}-RULE`,
    version: "1.0.0",
    description: "Exact preregistered runtime-bridge test rule",
    rationale: "Produce categorical held-out evidence without action authority.",
    dependencies: [{ kind: "TIMEFRAME", timeframe: "1H" }],
    parameters: { threshold: 1 },
    evaluate: () => ({
      status: evidenceStatus,
      reasons: [{ code: `BRIDGE_${evidenceStatus}`, message: evidenceStatus }],
    }),
  });
  const definition: ResearchHypothesisDefinition = {
    hypothesisId,
    version: "1.0.0",
    title: `${hypothesisId} runtime bridge evidence`,
    description: "One exact preregistered bridge test trial.",
    rationale: "Preserve canonical identity through read-only transport.",
    rule: hypothesisRuleReference(rule),
    assetScope: ["BTC"],
    requiredDependencies: rule.dependencies,
    parameterSpace: [{ name: "threshold", kind: "FIXED", value: 1 }],
    researchIntent: {
      question: "Can canonical evidence cross the runtime bridge unchanged?",
      falsificationCriterion: "No promotion or rejection criterion is declared.",
    },
    trainOosPolicy: {
      policyId: "RUNTIME-BRIDGE-FIXED-OOS",
      training: { startTime: TRAIN_START, endTime: OOS_START },
      oos: { startTime: OOS_START, endTime: OOS_END },
      ordering: "TRAIN_BEFORE_OOS",
      oosReuse: "NEVER_TUNE_ON_OOS",
    },
    statefulOosBoundaryPolicy: "NOT_APPLICABLE",
    trialAccounting: {
      familyId: `${hypothesisId}-TRIALS`,
      unit: "ONE_TRIAL_PER_RULE_PARAMETER_CONFIGURATION",
      variantHandling: "COUNT_EACH_VARIANT",
      declaredTrialCount: 1,
    },
    lifecycle: "EVALUATION_PENDING",
    preRegistration: {
      declaredBy: "P16-C-R1A-test",
      sourceReference: "P16-C-R1A-test-plan",
      declarationOrdinal: 1,
    },
  };
  const hypothesisRegistry = createHypothesisRegistry([definition]);
  const oneHourBars = bars(OOS_START);
  const observation = runStatelessShadowObservation({
    registry: hypothesisRegistry,
    hypothesisId,
    hypothesisVersion: "1.0.0",
    parameterConfiguration: { threshold: 1 },
    rule,
    context: {
      assetId: "BTC",
      decisionTime: OOS_START,
      asOf: OOS_START,
      oneHourBars,
    },
    featureVector: buildResearchFeatureVector({
      assetId: "BTC",
      decisionTime: OOS_START,
      asOf: OOS_START,
      definitions: [closeFeature],
      oneHourBars,
    }),
  });
  const heldOutEvidence = evaluateHeldOutOosEvidence({
    registry: hypothesisRegistry,
    hypothesisId,
    hypothesisVersion: "1.0.0",
    observations: [observation],
  });
  const evidenceRegistry = createResearchEvidenceRegistry(hypothesisRegistry, [{
    hypothesisId,
    hypothesisVersion: "1.0.0",
    heldOutEvidence,
  }]);
  const strategyEligibilityRegistry = createStrategyEligibilityRegistry(
    hypothesisRegistry,
    evidenceRegistry
  );
  return { hypothesisRegistry, evidenceRegistry, strategyEligibilityRegistry };
}

describe("P16-C R1A canonical runtime research-state bridge", () => {
  beforeEach(() => {
    markCanonicalResearchRuntimeStateUnavailable();
  });

  it("admits a valid linked canonical snapshot as AVAILABLE without changing identities", () => {
    const artifacts = canonicalArtifacts();
    const state = createAvailableCanonicalResearchRuntimeState(artifacts);

    expect(state.availability).toBe("AVAILABLE");
    expect(state.linkage).toEqual({
      hypothesisRegistrySemanticIdentity: artifacts.hypothesisRegistry.semanticIdentity,
      evidenceRegistrySemanticIdentity: artifacts.evidenceRegistry.semanticIdentity,
      strategyEligibilityRegistrySemanticIdentity: artifacts.strategyEligibilityRegistry.semanticIdentity,
    });
    expect(state.hypothesisRegistry.semanticIdentity).toBe(artifacts.hypothesisRegistry.semanticIdentity);
    expect(state.evidenceRegistry.entries[0].semanticIdentity)
      .toBe(artifacts.evidenceRegistry.entries[0].semanticIdentity);
  });

  it("allows canonical M13 state without synthesizing StrategyEligibility", () => {
    const { hypothesisRegistry, evidenceRegistry } = canonicalArtifacts();
    const state = createAvailableCanonicalResearchRuntimeState({
      hypothesisRegistry,
      evidenceRegistry,
    });

    expect(state.strategyEligibilityRegistry).toBeNull();
    expect(state.linkage.strategyEligibilityRegistrySemanticIdentity).toBeNull();
  });

  it("fails closed on malformed HypothesisRegistrySnapshot", () => {
    const artifacts = canonicalArtifacts();
    const malformed = {
      ...artifacts.hypothesisRegistry,
      schemaVersion: "forged-schema",
    } as unknown as HypothesisRegistrySnapshot;

    expect(() => createAvailableCanonicalResearchRuntimeState({
      ...artifacts,
      hypothesisRegistry: malformed,
    })).toThrow(/incompatible|forged|stale/i);
  });

  it("fails closed on malformed ResearchEvidenceRegistrySnapshot", () => {
    const artifacts = canonicalArtifacts();
    const malformed = clone(artifacts.evidenceRegistry) as unknown as Record<string, unknown>;
    malformed.schemaVersion = "forged-schema";

    expect(() => createAvailableCanonicalResearchRuntimeState({
      ...artifacts,
      evidenceRegistry: malformed as unknown as ResearchEvidenceRegistrySnapshot,
    })).toThrow(/incompatible|forged|stale/i);
  });

  it("fails closed on stale or forged semantic identities", () => {
    const artifacts = canonicalArtifacts();
    const stale = {
      ...artifacts.hypothesisRegistry,
      semanticIdentity: "forged",
    };

    expect(() => createAvailableCanonicalResearchRuntimeState({
      ...artifacts,
      hypothesisRegistry: stale,
    })).toThrow(/forged|stale/i);
  });

  it("rejects mismatched hypothesis and evidence linkage", () => {
    const first = canonicalArtifacts("H-RUNTIME-A");
    const second = canonicalArtifacts("H-RUNTIME-B");

    expect(() => createAvailableCanonicalResearchRuntimeState({
      hypothesisRegistry: second.hypothesisRegistry,
      evidenceRegistry: first.evidenceRegistry,
    })).toThrow(/resolve exactly one|contradicts/i);
  });

  it("rejects mismatched eligibility and evidence linkage", () => {
    const first = canonicalArtifacts("H-RUNTIME-A");
    const second = canonicalArtifacts("H-RUNTIME-B");

    expect(() => createAvailableCanonicalResearchRuntimeState({
      hypothesisRegistry: first.hypothesisRegistry,
      evidenceRegistry: first.evidenceRegistry,
      strategyEligibilityRegistry: second.strategyEligibilityRegistry,
    })).toThrow(/conflicts|source evidence|forged|stale|incompatible/i);
  });

  it("rejects duplicate evidence rather than dropping or repairing entries", () => {
    const artifacts = canonicalArtifacts();
    const duplicated = clone(artifacts.evidenceRegistry) as unknown as Record<string, unknown>;
    duplicated.entries = [
      artifacts.evidenceRegistry.entries[0],
      artifacts.evidenceRegistry.entries[0],
    ];

    expect(() => createAvailableCanonicalResearchRuntimeState({
      hypothesisRegistry: artifacts.hypothesisRegistry,
      evidenceRegistry: duplicated as unknown as ResearchEvidenceRegistrySnapshot,
    })).toThrow(/duplicate evidence entry/i);
  });

  it("starts explicitly UNAVAILABLE and contains no synthetic evidence", () => {
    const state = canonicalResearchRuntimeStateSource.getSnapshot();

    expect(state).toEqual(createUnavailableCanonicalResearchRuntimeState());
    expect(state.availability).toBe("UNAVAILABLE");
    expect(JSON.stringify(state)).not.toContain("CANDIDATE");
    expect(JSON.stringify(state)).not.toContain("hypothesisRegistry");
  });

  it("publishes atomically only after validation and retains prior state on failure", () => {
    const listener = vi.fn();
    const unsubscribe = canonicalResearchRuntimeStateSource.subscribe(listener);
    const artifacts = canonicalArtifacts();
    const published = publishCanonicalResearchArtifacts(artifacts);
    const invalid = {
      ...artifacts.evidenceRegistry,
      semanticIdentity: "forged",
    };

    expect(canonicalResearchRuntimeStateSource.getSnapshot()).toBe(published);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(() => publishCanonicalResearchArtifacts({
      hypothesisRegistry: artifacts.hypothesisRegistry,
      evidenceRegistry: invalid,
    })).toThrow(/forged|stale/i);
    expect(canonicalResearchRuntimeStateSource.getSnapshot()).toBe(published);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("cannot manufacture APPROVED_FOR_PAPER or REJECTED", () => {
    const candidate = createAvailableCanonicalResearchRuntimeState(canonicalArtifacts());
    const insufficient = createAvailableCanonicalResearchRuntimeState(
      canonicalArtifacts("H-RUNTIME-INSUFFICIENT", "INSUFFICIENT_EVIDENCE")
    );

    for (const state of [candidate, insufficient]) {
      expect(state.evidenceRegistry.entries.every((entry) =>
        entry.status !== ("APPROVED_FOR_PAPER" as never)
          && entry.status !== ("REJECTED" as never)
      )).toBe(true);
      expect(state.evidenceRegistry.unavailableStatuses)
        .toEqual(["APPROVED_FOR_PAPER", "REJECTED"]);
    }
  });

  it("keeps CANDIDATE research-only and separate from paper-evaluation eligibility", () => {
    const state = createAvailableCanonicalResearchRuntimeState(canonicalArtifacts());
    const evidence = state.evidenceRegistry.entries[0];
    const eligibility = state.strategyEligibilityRegistry!.records[0];

    expect(evidence.status).toBe("CANDIDATE");
    expect(evidence.approvedForPaperAction).toBe(false);
    expect(eligibility.eligibilityStatus)
      .toBe("INELIGIBLE_REQUIRED_SHARED_OOS_EVIDENCE_ABSENT");
    expect(eligibility.eligibleForPaperEvaluation).toBe(false);
  });

  it("keeps INSUFFICIENT_EVIDENCE distinct from rejection", () => {
    const state = createAvailableCanonicalResearchRuntimeState(
      canonicalArtifacts("H-RUNTIME-INSUFFICIENT", "INSUFFICIENT_EVIDENCE")
    );
    const evidence = state.evidenceRegistry.entries[0];

    expect(evidence.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(evidence.status).not.toBe("REJECTED" as never);
    expect(evidence.rejectionDisposition)
      .toBe("UNAVAILABLE_NO_MACHINE_EXECUTABLE_FALSIFICATION_CONTRACT");
  });

  it("keeps StrategyEligibility distinct from evidence and ActionDecision", () => {
    const state = createAvailableCanonicalResearchRuntimeState(canonicalArtifacts());
    const serialized = JSON.stringify(state);

    expect(state.evidenceRegistry.entries[0].status).toBe("CANDIDATE");
    expect(state.strategyEligibilityRegistry!.records[0].eligibilityStatus)
      .toBe("INELIGIBLE_REQUIRED_SHARED_OOS_EVIDENCE_ABSENT");
    expect(serialized).not.toMatch(/"action"\s*:/u);
    expect(serialized).not.toMatch(/"(WAIT|ENTER|ADD|HOLD|REDUCE|EXIT)"/u);
  });

  it("owns a deeply immutable copy and cannot mutate source snapshots", () => {
    const canonical = canonicalArtifacts();
    const mutable = clone(canonical);
    const original = clone(mutable);
    const state = createAvailableCanonicalResearchRuntimeState(mutable);

    (mutable.hypothesisRegistry.hypotheses[0] as unknown as { title: string }).title = "caller mutation";
    expect(state.hypothesisRegistry.hypotheses[0].title).toBe(
      original.hypothesisRegistry.hypotheses[0].title
    );
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.hypothesisRegistry.hypotheses[0])).toBe(true);
    expect(Object.isFrozen(state.evidenceRegistry.entries[0])).toBe(true);
  });

  it("remains transport-only with no decision, price, or economic authority", () => {
    const state = createAvailableCanonicalResearchRuntimeState(canonicalArtifacts());

    expect(state).toMatchObject({
      predictiveValidityEstablished: false,
      approvedForPaperAction: false,
      grantsPermissionAuthority: false,
      grantsRiskAuthority: false,
      grantsAllocationAuthority: false,
      grantsExecutionAuthority: false,
      grantsAccountingAuthority: false,
      grantsActionDecisionAuthority: false,
      priceAuthority: "NONE",
    });
  });

  it("runtime initialization stays UNAVAILABLE without running research evaluation", () => {
    markCanonicalResearchRuntimeStateUnavailable();
    const first = canonicalResearchRuntimeStateSource.getSnapshot();
    const second = canonicalResearchRuntimeStateSource.getSnapshot();

    expect(first).toBe(second);
    expect(first.availability).toBe("UNAVAILABLE");
  });

  it("rejects a forged StrategyEligibility snapshot", () => {
    const artifacts = canonicalArtifacts();
    const forged = {
      ...artifacts.strategyEligibilityRegistry,
      semanticIdentity: "forged",
    } as StrategyEligibilityRegistrySnapshot;

    expect(() => createAvailableCanonicalResearchRuntimeState({
      ...artifacts,
      strategyEligibilityRegistry: forged,
    })).toThrow(/forged|stale|conflicts/i);
  });
});
