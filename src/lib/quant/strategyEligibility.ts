// ============================================================================
// FILE: src/lib/quant/strategyEligibility.ts
// MODULE: STRATEGY ELIGIBILITY (M14 / A-01)
//
// Deterministic paper-evaluation admission over canonical M13 evidence.
// Eligibility is not predictive validity, paper-action approval, permission,
// sizing, allocation, execution, accounting, or ActionDecision authority.
// ============================================================================

import {
  serializeHypothesisRegistry,
  type HypothesisRegistrySnapshot,
  type RegisteredResearchHypothesis,
  type ResearchInterval,
  type StatefulOosBoundaryPolicy,
} from "./hypothesisRegistry";
import {
  validateResearchEvidenceRegistry,
  type CurrentM13ResearchEvidenceStatus,
  type RegisteredResearchEvidence,
  type RegisteredRobustnessEvidenceBinding,
  type ResearchEvidenceRegistrySnapshot,
} from "./researchEvidenceRegistry";
import { validateParameterConfigurationIdentity } from "./shadowResearchHarness";
import type { AssetId } from "./types";

export const STRATEGY_ELIGIBILITY_SCHEMA_VERSION = "M14-A-01-1";

export type StrategyEligibilityStatus =
  | "ELIGIBLE_FOR_PAPER_EVALUATION"
  | "INELIGIBLE_INSUFFICIENT_EVIDENCE"
  | "INELIGIBLE_REQUIRED_SHARED_OOS_EVIDENCE_ABSENT";

export interface StrategyEligibilityPolicy {
  readonly policyId: "M14_A01_INTEGRITY_AND_COMPLETENESS";
  readonly version: "1.0.0";
  readonly intendedUse: "PAPER_EVALUATION_ADMISSION_ONLY";
  readonly requiredEvidenceStatus: "CANDIDATE";
  readonly requiresCompleteHeldOutOosEvidence: true;
  readonly requiresCompleteSharedOosSensitivityEvidence: true;
  readonly sharedOosInterpretation: "DESCRIPTIVE_ONLY_NOT_INDEPENDENT_CONFIRMATION";
  readonly selectionPolicy: "NO_POST_OOS_VARIANT_SELECTION";
  readonly performanceThreshold: "NONE";
  readonly predictiveValidityRequired: false;
  readonly semanticIdentity: string;
}

export interface StrategyEligibilityRecord {
  readonly kind: "STRATEGY_ELIGIBILITY_RECORD";
  readonly schemaVersion: typeof STRATEGY_ELIGIBILITY_SCHEMA_VERSION;
  readonly policyId: StrategyEligibilityPolicy["policyId"];
  readonly policyVersion: StrategyEligibilityPolicy["version"];
  readonly policySemanticIdentity: string;
  readonly evidenceRegistrySemanticIdentity: string;
  readonly evidenceSemanticIdentity: string;
  readonly hypothesisId: string;
  readonly hypothesisVersion: string;
  readonly hypothesisSemanticIdentity: string;
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly ruleSemanticIdentity: string;
  readonly parameterConfigurationIdentity: string;
  readonly trialAccountingIdentity: string;
  readonly assetId: AssetId;
  readonly trainingInterval: ResearchInterval;
  readonly oosInterval: ResearchInterval;
  readonly statefulOosBoundaryPolicy: StatefulOosBoundaryPolicy;
  readonly heldOutEvidenceSemanticIdentity: string;
  readonly robustnessEvidence: RegisteredRobustnessEvidenceBinding | null;
  readonly evidenceStatus: CurrentM13ResearchEvidenceStatus;
  readonly eligibilityStatus: StrategyEligibilityStatus;
  readonly eligibleForPaperEvaluation: boolean;
  readonly reasons: readonly string[];
  readonly predictiveValidityEstablished: false;
  readonly approvedForPaperAction: false;
  readonly grantsPermissionAuthority: false;
  readonly grantsRiskAuthority: false;
  readonly grantsAllocationAuthority: false;
  readonly grantsExecutionAuthority: false;
  readonly grantsAccountingAuthority: false;
  readonly priceAuthority: "NONE";
  readonly semanticIdentity: string;
}

export interface StrategyEligibilityRegistrySnapshot {
  readonly schemaVersion: typeof STRATEGY_ELIGIBILITY_SCHEMA_VERSION;
  readonly intendedUse: "PAPER_EVALUATION_ADMISSION_ONLY";
  readonly sourceEvidenceRegistrySemanticIdentity: string;
  readonly policy: StrategyEligibilityPolicy;
  readonly records: readonly StrategyEligibilityRecord[];
  readonly supportedStatuses: readonly StrategyEligibilityStatus[];
  readonly predictiveValidityEstablished: false;
  readonly approvedForPaperAction: false;
  readonly grantsPermissionAuthority: false;
  readonly grantsRiskAuthority: false;
  readonly grantsAllocationAuthority: false;
  readonly grantsExecutionAuthority: false;
  readonly grantsAccountingAuthority: false;
  readonly priceAuthority: "NONE";
  readonly semanticIdentity: string;
}

export class StrategyEligibilityValidationError extends Error {
  constructor(message: string) {
    super(`[StrategyEligibility] ${message}`);
    this.name = "StrategyEligibilityValidationError";
  }
}

function fail(message: string): never {
  throw new StrategyEligibilityValidationError(message);
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

function canonicalClone<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    if (!Object.isFrozen(value)) Object.freeze(value);
  }
  return value;
}

const POLICY_MATERIAL = {
  policyId: "M14_A01_INTEGRITY_AND_COMPLETENESS" as const,
  version: "1.0.0" as const,
  intendedUse: "PAPER_EVALUATION_ADMISSION_ONLY" as const,
  requiredEvidenceStatus: "CANDIDATE" as const,
  requiresCompleteHeldOutOosEvidence: true as const,
  requiresCompleteSharedOosSensitivityEvidence: true as const,
  sharedOosInterpretation: "DESCRIPTIVE_ONLY_NOT_INDEPENDENT_CONFIRMATION" as const,
  selectionPolicy: "NO_POST_OOS_VARIANT_SELECTION" as const,
  performanceThreshold: "NONE" as const,
  predictiveValidityRequired: false as const,
};

export const CURRENT_STRATEGY_ELIGIBILITY_POLICY: StrategyEligibilityPolicy = deepFreeze({
  ...POLICY_MATERIAL,
  semanticIdentity: canonicalJson(POLICY_MATERIAL),
});

function classify(entry: RegisteredResearchEvidence): Readonly<{
  status: StrategyEligibilityStatus;
  eligible: boolean;
  reasons: readonly string[];
}> {
  if (entry.status === "INSUFFICIENT_EVIDENCE") {
    return deepFreeze({
      status: "INELIGIBLE_INSUFFICIENT_EVIDENCE" as const,
      eligible: false,
      reasons: [
        "SOURCE_EVIDENCE_STATUS_INSUFFICIENT",
        "PAPER_EVALUATION_ADMISSION_DENIED_FAIL_CLOSED",
      ],
    });
  }
  if (entry.status !== "CANDIDATE") {
    fail(`unsupported M13 evidence status ${String(entry.status)}.`);
  }
  if (entry.robustnessEvidence === null) {
    return deepFreeze({
      status: "INELIGIBLE_REQUIRED_SHARED_OOS_EVIDENCE_ABSENT" as const,
      eligible: false,
      reasons: [
        "DECLARED_OOS_EVIDENCE_COMPLETE",
        "REQUIRED_SHARED_OOS_SENSITIVITY_EVIDENCE_ABSENT",
        "PAPER_EVALUATION_ADMISSION_DENIED_FAIL_CLOSED",
      ],
    });
  }
  if (entry.robustnessEvidence.familyCompleteness !== "COMPLETE"
    || entry.robustnessEvidence.memberCompleteness !== "COMPLETE"
    || entry.robustnessEvidence.independentConfirmation !== false
    || entry.robustnessEvidence.selectionPolicy !== "NO_POST_OOS_VARIANT_SELECTION"
    || entry.robustnessEvidence.interpretation !== "DESCRIPTIVE_ONLY_NO_ROBUSTNESS_THRESHOLD") {
    fail("shared-OOS evidence contradicts the canonical non-selecting descriptive policy.");
  }
  return deepFreeze({
    status: "ELIGIBLE_FOR_PAPER_EVALUATION" as const,
    eligible: true,
    reasons: [
      "INTEGRITY_VALIDATED_M13_CANDIDATE",
      "DECLARED_OOS_EVIDENCE_COMPLETE",
      "SHARED_OOS_SENSITIVITY_EVIDENCE_COMPLETE",
      "PAPER_EVALUATION_ONLY_NO_PREDICTIVE_OR_ACTION_AUTHORITY",
    ],
  });
}

function exactHypothesis(
  registry: HypothesisRegistrySnapshot,
  entry: RegisteredResearchEvidence
): RegisteredResearchHypothesis {
  serializeHypothesisRegistry(registry);
  const matches = registry.hypotheses.filter((hypothesis) =>
    hypothesis.hypothesisId === entry.hypothesisId
      && hypothesis.version === entry.hypothesisVersion
  );
  if (matches.length !== 1) {
    fail("evidence must resolve exactly one registered hypothesis.");
  }
  return matches[0];
}

function validateScientificBinding(
  hypothesisRegistry: HypothesisRegistrySnapshot,
  entry: RegisteredResearchEvidence
): void {
  const hypothesis = exactHypothesis(hypothesisRegistry, entry);
  if (entry.hypothesisSemanticIdentity !== hypothesis.semanticIdentity
    || entry.ruleId !== hypothesis.rule.ruleId
    || entry.ruleVersion !== hypothesis.rule.version
    || entry.ruleSemanticIdentity !== hypothesis.rule.semanticIdentity
    || entry.trialAccountingIdentity !== canonicalJson(hypothesis.trialAccounting)
    || !hypothesis.assetScope.includes(entry.assetId)
    || canonicalJson(entry.trainingInterval) !== canonicalJson(hypothesis.trainOosPolicy.training)
    || canonicalJson(entry.oosInterval) !== canonicalJson(hypothesis.trainOosPolicy.oos)
    || entry.statefulOosBoundaryPolicy !== hypothesis.statefulOosBoundaryPolicy) {
    fail("evidence contradicts its canonical hypothesis, rule, trial, asset, interval, or state-policy binding.");
  }
  const parameterBinding = validateParameterConfigurationIdentity(
    hypothesis,
    entry.parameterConfigurationIdentity
  );
  if (parameterBinding.trialAccountingIdentity !== entry.trialAccountingIdentity) {
    fail("evidence parameter configuration contradicts its canonical trial contract.");
  }
}

function recordFor(
  evidenceRegistry: ResearchEvidenceRegistrySnapshot,
  entry: RegisteredResearchEvidence
): StrategyEligibilityRecord {
  const classification = classify(entry);
  const material = {
    kind: "STRATEGY_ELIGIBILITY_RECORD" as const,
    schemaVersion: STRATEGY_ELIGIBILITY_SCHEMA_VERSION as typeof STRATEGY_ELIGIBILITY_SCHEMA_VERSION,
    policyId: CURRENT_STRATEGY_ELIGIBILITY_POLICY.policyId,
    policyVersion: CURRENT_STRATEGY_ELIGIBILITY_POLICY.version,
    policySemanticIdentity: CURRENT_STRATEGY_ELIGIBILITY_POLICY.semanticIdentity,
    evidenceRegistrySemanticIdentity: evidenceRegistry.semanticIdentity,
    evidenceSemanticIdentity: entry.semanticIdentity,
    hypothesisId: entry.hypothesisId,
    hypothesisVersion: entry.hypothesisVersion,
    hypothesisSemanticIdentity: entry.hypothesisSemanticIdentity,
    ruleId: entry.ruleId,
    ruleVersion: entry.ruleVersion,
    ruleSemanticIdentity: entry.ruleSemanticIdentity,
    parameterConfigurationIdentity: entry.parameterConfigurationIdentity,
    trialAccountingIdentity: entry.trialAccountingIdentity,
    assetId: entry.assetId,
    trainingInterval: canonicalClone(entry.trainingInterval),
    oosInterval: canonicalClone(entry.oosInterval),
    statefulOosBoundaryPolicy: entry.statefulOosBoundaryPolicy,
    heldOutEvidenceSemanticIdentity: entry.heldOutEvidenceSemanticIdentity,
    robustnessEvidence: entry.robustnessEvidence === null
      ? null
      : canonicalClone(entry.robustnessEvidence),
    evidenceStatus: entry.status,
    eligibilityStatus: classification.status,
    eligibleForPaperEvaluation: classification.eligible,
    reasons: classification.reasons,
    predictiveValidityEstablished: false as const,
    approvedForPaperAction: false as const,
    grantsPermissionAuthority: false as const,
    grantsRiskAuthority: false as const,
    grantsAllocationAuthority: false as const,
    grantsExecutionAuthority: false as const,
    grantsAccountingAuthority: false as const,
    priceAuthority: "NONE" as const,
  };
  return deepFreeze({ ...material, semanticIdentity: canonicalJson(material) });
}

function snapshotFor(
  evidenceRegistry: ResearchEvidenceRegistrySnapshot,
  records: readonly StrategyEligibilityRecord[]
): StrategyEligibilityRegistrySnapshot {
  const owned = records.map((record) => canonicalClone(record));
  const sorted = Object.freeze(owned.sort((left, right) =>
    left.hypothesisId.localeCompare(right.hypothesisId)
      || left.hypothesisVersion.localeCompare(right.hypothesisVersion)
      || left.assetId.localeCompare(right.assetId)
      || left.parameterConfigurationIdentity.localeCompare(right.parameterConfigurationIdentity)
      || left.evidenceSemanticIdentity.localeCompare(right.evidenceSemanticIdentity)
  ));
  const evidenceIdentities = sorted.map((record) => record.evidenceSemanticIdentity);
  if (new Set(evidenceIdentities).size !== evidenceIdentities.length) {
    fail("duplicate or conflicting eligibility records for one evidence artifact.");
  }
  const material = {
    schemaVersion: STRATEGY_ELIGIBILITY_SCHEMA_VERSION as typeof STRATEGY_ELIGIBILITY_SCHEMA_VERSION,
    intendedUse: "PAPER_EVALUATION_ADMISSION_ONLY" as const,
    sourceEvidenceRegistrySemanticIdentity: evidenceRegistry.semanticIdentity,
    policy: CURRENT_STRATEGY_ELIGIBILITY_POLICY,
    records: sorted,
    supportedStatuses: Object.freeze([
      "ELIGIBLE_FOR_PAPER_EVALUATION",
      "INELIGIBLE_INSUFFICIENT_EVIDENCE",
      "INELIGIBLE_REQUIRED_SHARED_OOS_EVIDENCE_ABSENT",
    ] as const),
    predictiveValidityEstablished: false as const,
    approvedForPaperAction: false as const,
    grantsPermissionAuthority: false as const,
    grantsRiskAuthority: false as const,
    grantsAllocationAuthority: false as const,
    grantsExecutionAuthority: false as const,
    grantsAccountingAuthority: false as const,
    priceAuthority: "NONE" as const,
  };
  return deepFreeze({ ...material, semanticIdentity: canonicalJson(material) });
}

function rebuild(
  hypothesisRegistry: HypothesisRegistrySnapshot,
  evidenceRegistry: ResearchEvidenceRegistrySnapshot
): StrategyEligibilityRegistrySnapshot {
  serializeHypothesisRegistry(hypothesisRegistry);
  validateResearchEvidenceRegistry(evidenceRegistry);
  evidenceRegistry.entries.forEach((entry) => validateScientificBinding(hypothesisRegistry, entry));
  return snapshotFor(
    evidenceRegistry,
    evidenceRegistry.entries.map((entry) => recordFor(evidenceRegistry, entry))
  );
}

export function createStrategyEligibilityRegistry(
  hypothesisRegistry: HypothesisRegistrySnapshot,
  evidenceRegistry: ResearchEvidenceRegistrySnapshot
): StrategyEligibilityRegistrySnapshot {
  return rebuild(hypothesisRegistry, evidenceRegistry);
}

export function validateStrategyEligibilityRegistry(
  hypothesisRegistry: HypothesisRegistrySnapshot,
  evidenceRegistry: ResearchEvidenceRegistrySnapshot,
  eligibilityRegistry: StrategyEligibilityRegistrySnapshot
): StrategyEligibilityRegistrySnapshot {
  serializeHypothesisRegistry(hypothesisRegistry);
  validateResearchEvidenceRegistry(evidenceRegistry);
  if (eligibilityRegistry.schemaVersion !== STRATEGY_ELIGIBILITY_SCHEMA_VERSION
    || eligibilityRegistry.intendedUse !== "PAPER_EVALUATION_ADMISSION_ONLY"
    || eligibilityRegistry.sourceEvidenceRegistrySemanticIdentity !== evidenceRegistry.semanticIdentity
    || canonicalJson(eligibilityRegistry.policy) !== canonicalJson(CURRENT_STRATEGY_ELIGIBILITY_POLICY)
    || canonicalJson(eligibilityRegistry.supportedStatuses) !== canonicalJson([
      "ELIGIBLE_FOR_PAPER_EVALUATION",
      "INELIGIBLE_INSUFFICIENT_EVIDENCE",
      "INELIGIBLE_REQUIRED_SHARED_OOS_EVIDENCE_ABSENT",
    ])
    || eligibilityRegistry.predictiveValidityEstablished !== false
    || eligibilityRegistry.approvedForPaperAction !== false
    || eligibilityRegistry.grantsPermissionAuthority !== false
    || eligibilityRegistry.grantsRiskAuthority !== false
    || eligibilityRegistry.grantsAllocationAuthority !== false
    || eligibilityRegistry.grantsExecutionAuthority !== false
    || eligibilityRegistry.grantsAccountingAuthority !== false
    || eligibilityRegistry.priceAuthority !== "NONE") {
    fail("registry has incompatible policy, intended-use, status, or authority semantics.");
  }
  const rebuilt = rebuild(hypothesisRegistry, evidenceRegistry);
  if (rebuilt.semanticIdentity !== eligibilityRegistry.semanticIdentity
    || canonicalJson(rebuilt) !== canonicalJson(eligibilityRegistry)) {
    fail("eligibility registry is forged, stale, incomplete, duplicated, or conflicts with source evidence.");
  }
  return eligibilityRegistry;
}

export function serializeStrategyEligibilityRegistry(
  hypothesisRegistry: HypothesisRegistrySnapshot,
  evidenceRegistry: ResearchEvidenceRegistrySnapshot,
  eligibilityRegistry: StrategyEligibilityRegistrySnapshot
): string {
  return canonicalJson(validateStrategyEligibilityRegistry(
    hypothesisRegistry,
    evidenceRegistry,
    eligibilityRegistry
  ));
}
