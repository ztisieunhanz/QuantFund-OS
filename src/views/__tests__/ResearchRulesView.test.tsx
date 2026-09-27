import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResearchRulesView } from "../ResearchRulesView";
import {
  canonicalResearchRuntimeStateSource,
  createAvailableCanonicalResearchRuntimeState,
  createUnavailableCanonicalResearchRuntimeState,
  markCanonicalResearchRuntimeStateUnavailable,
  publishCanonicalResearchArtifacts,
} from "@/lib/quant/canonicalResearchRuntimeState";
import {
  createHypothesisRegistry,
  hypothesisRuleReference,
  type ResearchHypothesisDefinition,
} from "@/lib/quant/hypothesisRegistry";
import { evaluateHeldOutOosEvidence } from "@/lib/quant/heldOutOosEvaluation";
import { buildResearchFeatureVector, type ResearchFeatureDefinition } from "@/lib/quant/researchFeatureBuilder";
import { createResearchEvidenceRegistry } from "@/lib/quant/researchEvidenceRegistry";
import { createResearchRule, type ResearchRuleStatus } from "@/lib/quant/researchRules";
import { runStatelessShadowObservation } from "@/lib/quant/shadowResearchHarness";
import { createStrategyEligibilityRegistry } from "@/lib/quant/strategyEligibility";
import { BAR_DURATION_MS } from "@/lib/quant/timeDomain";
import type { PointInTimeBar } from "@/lib/quant/types";
import { presentCanonicalResearchRuntimeState } from "@/lib/researchRulesPresenter";

const TRAIN_START = Date.UTC(2020, 0, 1);
const OOS_START = Date.UTC(2022, 0, 1);
const OOS_END = OOS_START + 2 * BAR_DURATION_MS;

const closeFeature: ResearchFeatureDefinition = {
  featureId: "R1B_1H_CLOSE",
  version: "1.0.0",
  description: "Canonical closed-bar presentation fixture",
  dependency: { kind: "TIMEFRAME", timeframe: "1H" },
  transformation: { kind: "BAR_CLOSE", lag: 0 },
};

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
  evidenceStatus: ResearchRuleStatus = "MATCH",
  includeEligibility = true
) {
  const rule = createResearchRule({
    ruleId: "H-R1B-RULE",
    version: "1.0.0",
    description: "Exact preregistered R1B presentation rule",
    rationale: "Produce categorical test evidence without action authority.",
    dependencies: [{ kind: "TIMEFRAME", timeframe: "1H" }],
    parameters: { threshold: 7 },
    evaluate: () => ({
      status: evidenceStatus,
      reasons: [{ code: `R1B_${evidenceStatus}`, message: evidenceStatus }],
    }),
  });
  const definition: ResearchHypothesisDefinition = {
    hypothesisId: "H-R1B",
    version: "1.0.0",
    title: "R1B canonical presentation hypothesis",
    description: "A deterministic test-only hypothesis for the research UI.",
    rationale: "Verify exact canonical fields without runtime demo data.",
    rule: hypothesisRuleReference(rule),
    assetScope: ["BTC"],
    requiredDependencies: rule.dependencies,
    parameterSpace: [{ name: "threshold", kind: "FIXED", value: 7 }],
    researchIntent: {
      question: "Does the presenter preserve canonical research fields?",
      falsificationCriterion: "No machine-executable rejection criterion is declared.",
    },
    trainOosPolicy: {
      policyId: "R1B-FIXED-OOS",
      training: { startTime: TRAIN_START, endTime: OOS_START },
      oos: { startTime: OOS_START, endTime: OOS_END },
      ordering: "TRAIN_BEFORE_OOS",
      oosReuse: "NEVER_TUNE_ON_OOS",
    },
    statefulOosBoundaryPolicy: "NOT_APPLICABLE",
    trialAccounting: {
      familyId: "R1B-TRIALS",
      unit: "ONE_TRIAL_PER_RULE_PARAMETER_CONFIGURATION",
      variantHandling: "COUNT_EACH_VARIANT",
      declaredTrialCount: 1,
    },
    lifecycle: "EVALUATION_PENDING",
    preRegistration: {
      declaredBy: "P16-C-R1B-test",
      sourceReference: "P16-C-R1B-test-plan",
      declarationOrdinal: 1,
    },
  };
  const hypothesisRegistry = createHypothesisRegistry([definition]);
  const oneHourBars = bars(OOS_START);
  const observation = runStatelessShadowObservation({
    registry: hypothesisRegistry,
    hypothesisId: definition.hypothesisId,
    hypothesisVersion: definition.version,
    parameterConfiguration: { threshold: 7 },
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
    hypothesisId: definition.hypothesisId,
    hypothesisVersion: definition.version,
    observations: [observation],
  });
  const evidenceRegistry = createResearchEvidenceRegistry(hypothesisRegistry, [{
    hypothesisId: definition.hypothesisId,
    hypothesisVersion: definition.version,
    heldOutEvidence,
  }]);
  const strategyEligibilityRegistry = includeEligibility
    ? createStrategyEligibilityRegistry(hypothesisRegistry, evidenceRegistry)
    : null;
  return { hypothesisRegistry, evidenceRegistry, strategyEligibilityRegistry };
}

function available(
  evidenceStatus: ResearchRuleStatus = "MATCH",
  includeEligibility = true
) {
  return createAvailableCanonicalResearchRuntimeState(
    canonicalArtifacts(evidenceStatus, includeEligibility)
  );
}

function renderView(): string {
  return renderToStaticMarkup(createElement(ResearchRulesView));
}

afterEach(() => {
  markCanonicalResearchRuntimeStateUnavailable();
});

describe("P16-C R1B canonical research presenter", () => {
  it("presents normal runtime UNAVAILABLE truthfully without synthetic statuses or actions", () => {
    const presentation = presentCanonicalResearchRuntimeState(
      createUnavailableCanonicalResearchRuntimeState()
    );
    const serialized = JSON.stringify(presentation);

    expect(presentation).toMatchObject({
      availability: "UNAVAILABLE",
      title: "Research evidence unavailable",
      reasonCode: "NO_CANONICAL_RESEARCH_ARTIFACT",
    });
    expect(serialized).not.toMatch(/CANDIDATE|INSUFFICIENT_EVIDENCE|APPROVED_FOR_PAPER|REJECTED/u);
    expect(serialized).not.toMatch(/"(WAIT|ENTER|ADD|HOLD|REDUCE|EXIT)"/u);
  });

  it("presents CANDIDATE exactly without paper-action approval", () => {
    const presentation = presentCanonicalResearchRuntimeState(available());
    if (presentation.availability !== "AVAILABLE") throw new Error("Expected AVAILABLE fixture.");
    const entry = presentation.entries[0];

    expect(entry.evidenceStatus).toBe("CANDIDATE");
    expect(entry.evidenceMeaning).toContain("not predictive validation or paper-action approval");
    expect(entry.approvedForPaperAction).toBe(false);
    expect(entry.predictiveValidityEstablished).toBe(false);
  });

  it("keeps INSUFFICIENT_EVIDENCE distinct from REJECTED", () => {
    const presentation = presentCanonicalResearchRuntimeState(available("INSUFFICIENT_EVIDENCE"));
    if (presentation.availability !== "AVAILABLE") throw new Error("Expected AVAILABLE fixture.");
    const entry = presentation.entries[0];

    expect(entry.evidenceStatus).toBe("INSUFFICIENT_EVIDENCE");
    expect(entry.evidenceMeaning).toContain("not rejection");
    expect(entry.evidenceStatus).not.toBe("REJECTED" as never);
    expect(presentation.unavailableEvidenceStatuses).toEqual(["APPROVED_FOR_PAPER", "REJECTED"]);
  });

  it("renders exact linked StrategyEligibility separately from research evidence", () => {
    const presentation = presentCanonicalResearchRuntimeState(available());
    if (presentation.availability !== "AVAILABLE") throw new Error("Expected AVAILABLE fixture.");
    const entry = presentation.entries[0];

    expect(entry.evidenceStatus).toBe("CANDIDATE");
    expect(entry.eligibility?.status)
      .toBe("INELIGIBLE_REQUIRED_SHARED_OOS_EVIDENCE_ABSENT");
    expect(entry.eligibility?.eligibleForPaperEvaluation).toBe(false);
  });

  it("does not derive eligibility when StrategyEligibility was not published", () => {
    const presentation = presentCanonicalResearchRuntimeState(available("MATCH", false));
    if (presentation.availability !== "AVAILABLE") throw new Error("Expected AVAILABLE fixture.");

    expect(presentation.entries[0].evidenceStatus).toBe("CANDIDATE");
    expect(presentation.entries[0].eligibility).toBeNull();
    expect(presentation.eligibilityRegistryIdentity).toBeNull();
  });

  it("copies canonical hypothesis, rule, asset, parameter, interval, and identity fields", () => {
    const state = available();
    const presentation = presentCanonicalResearchRuntimeState(state);
    if (presentation.availability !== "AVAILABLE") throw new Error("Expected AVAILABLE fixture.");
    const source = state.evidenceRegistry.entries[0];
    const entry = presentation.entries[0];

    expect(entry).toMatchObject({
      hypothesisId: "H-R1B",
      hypothesisVersion: "1.0.0",
      hypothesisTitle: "R1B canonical presentation hypothesis",
      ruleId: "H-R1B-RULE",
      ruleVersion: "1.0.0",
      assetId: "BTC",
      declaredParameters: ["threshold = 7"],
      parameterConfigurationIdentity: source.parameterConfigurationIdentity,
      statefulOosBoundaryPolicy: "NOT_APPLICABLE",
      heldOutEvidenceSemanticIdentity: source.heldOutEvidenceSemanticIdentity,
      evidenceSemanticIdentity: source.semanticIdentity,
    });
    expect(entry.trainingInterval).toBe(
      `${new Date(TRAIN_START).toISOString()} → ${new Date(OOS_START).toISOString()}`
    );
    expect(entry.oosInterval).toBe(
      `${new Date(OOS_START).toISOString()} → ${new Date(OOS_END).toISOString()}`
    );
    expect(entry.robustness).toBeNull();
  });

  it("does not emit trading actions or invented economic metrics", () => {
    const presentation = presentCanonicalResearchRuntimeState(available());
    const serialized = JSON.stringify(presentation);

    expect(serialized).not.toMatch(/"(WAIT|ENTER|ADD|HOLD|REDUCE|EXIT)"/u);
    expect(serialized).not.toMatch(/"(pnl|return|sharpe|drawdown|hitRate|confidence|ranking|probability|expectedReturn|alphaScore)"\s*:/iu);
  });

  it("does not mutate canonical snapshots and returns deeply frozen presentation state", () => {
    const state = available();
    const before = JSON.stringify(state);
    const presentation = presentCanonicalResearchRuntimeState(state);

    expect(JSON.stringify(state)).toBe(before);
    expect(Object.isFrozen(presentation)).toBe(true);
    if (presentation.availability !== "AVAILABLE") throw new Error("Expected AVAILABLE fixture.");
    expect(Object.isFrozen(presentation.entries)).toBe(true);
    expect(Object.isFrozen(presentation.entries[0])).toBe(true);
  });
});

describe("P16-C R1B ResearchRulesView", () => {
  it("renders canonical UNAVAILABLE production state without a fake evidence entry", () => {
    const html = renderView();

    expect(html).toContain("Research evidence unavailable");
    expect(html).toContain("NO_CANONICAL_RESEARCH_ARTIFACT");
    expect(html).toContain("No canonical runtime research artifact has been published");
    expect(html).not.toContain("H-R1B");
    expect(html).not.toContain("CANDIDATE");
    expect(html).not.toContain("INSUFFICIENT_EVIDENCE");
    expect(html).not.toContain("APPROVED_FOR_PAPER");
    expect(html).not.toContain(">REJECTED<");
  });

  it("reads the canonical source after publication and renders exact AVAILABLE state", () => {
    const listener = vi.fn();
    const unsubscribe = canonicalResearchRuntimeStateSource.subscribe(listener);
    const state = publishCanonicalResearchArtifacts(canonicalArtifacts());
    const html = renderView();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(canonicalResearchRuntimeStateSource.getSnapshot()).toBe(state);
    expect(html).toContain("H-R1B");
    expect(html).toContain("CANDIDATE");
    expect(html).toContain("INELIGIBLE_REQUIRED_SHARED_OOS_EVIDENCE_ABSENT");
    expect(html).toContain("threshold = 7");
    expect(html).toContain("NOT_PUBLISHED");
    unsubscribe();
  });

  it("renders null StrategyEligibility as not published without deriving it", () => {
    publishCanonicalResearchArtifacts(canonicalArtifacts("MATCH", false));
    const html = renderView();

    expect(html).toContain("STRATEGY ELIGIBILITY");
    expect(html).toContain("NOT_PUBLISHED");
    expect(html).toContain("Eligibility is not derived by this view");
  });

  it("contains no research mutation controls", () => {
    publishCanonicalResearchArtifacts(canonicalArtifacts());
    const html = renderView();

    expect(html).not.toContain("<button");
    expect(html).not.toMatch(/>\s*(Approve|Reject|Promote|Run trade|Apply strategy|Optimize|Execute)\s*</iu);
  });

  it("imports only the read-only research source and no financial authority", () => {
    const viewSource = readFileSync("src/views/ResearchRulesView.tsx", "utf8");
    const presenterSource = readFileSync("src/lib/researchRulesPresenter.ts", "utf8");
    const implementation = `${viewSource}\n${presenterSource}`;

    expect(viewSource).toContain("canonicalResearchRuntimeStateSource");
    expect(viewSource).not.toContain("publishCanonicalResearchArtifacts");
    expect(implementation).not.toMatch(/from ["'].*(permission|riskEngine|omega|executionEngine|ledger|actionDecision)/iu);
  });
});
