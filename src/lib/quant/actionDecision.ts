// ============================================================================
// FILE: src/lib/quant/actionDecision.ts
// MODULE: CANONICAL PRODUCT-FACING ACTION CLASSIFICATION (M14 / A-04 STEP 4)
//
// ActionDecision observes validated canonical valuation, Omega target, and
// target-lifecycle evidence. It never creates or changes those authorities.
// ============================================================================

import {
  isExecutableRebalanceDelta,
  validateExecutionPlannerPolicy,
  type ExecutionPlannerPolicy,
} from "./executionEngine";
import {
  canonicalProducerJson,
  immutableProducerCopy,
  producerIdentity,
} from "./producerProvenance";
import {
  validateActiveTargetLifecycle,
  type ActiveTargetLifecycle,
  type AssetExecutionRelation,
} from "./targetExecutionLifecycle";
import type { AssetId, ProvenancedTargetPortfolioWeight } from "./types";

export const ACTION_DECISION_SCHEMA_VERSION = "M14-A04-STEP4-1" as const;

export const ACTION_DECISION_ACTION_VOCABULARY = Object.freeze([
  "WAIT",
  "ENTER",
  "ADD",
  "HOLD",
  "REDUCE",
  "EXIT",
] as const);

export type ActionDecisionAction = typeof ACTION_DECISION_ACTION_VOCABULARY[number];

export type ActionDecisionReason =
  | "WAIT_CANONICAL_EVIDENCE_UNAVAILABLE_OR_INVALID"
  | "WAIT_CANONICAL_EVIDENCE_TIME_MISMATCH"
  | "WAIT_ASSET_RELATIONSHIP_UNAVAILABLE"
  | "WAIT_INVALID_TARGET_LIFECYCLE"
  | "WAIT_NO_MATERIALLY_EXECUTABLE_TRANSITION"
  | "ENTER_CANONICAL_ZERO_TO_MATERIALLY_POSITIVE_TARGET"
  | "ADD_CANONICAL_MATERIALLY_HIGHER_POSITIVE_TARGET"
  | "HOLD_CANONICAL_POSITIVE_TARGET_SATISFIED_UNDER_POLICY"
  | "REDUCE_CANONICAL_MATERIALLY_LOWER_POSITIVE_TARGET"
  | "EXIT_CANONICAL_POSITIVE_TO_ZERO_TARGET";

export type ActionDecisionContradiction =
  | "CANONICAL_EVIDENCE_UNAVAILABLE_OR_INVALID"
  | "CANONICAL_EVIDENCE_TIME_MISMATCH"
  | "ASSET_RELATIONSHIP_UNAVAILABLE"
  | "ACTIVE_TARGET_LIFECYCLE_INVALID";

export interface ActionDecisionInput {
  readonly assetId: AssetId;
  readonly decisionTime: number;
  readonly asOf: number;
}

export interface CanonicalActionDecisionInput extends ActionDecisionInput {
  readonly lifecycle: ActiveTargetLifecycle | null;
}

export interface ActionConditionEvidence {
  readonly status: "PROVEN" | "NOT_APPLICABLE" | "UNAVAILABLE";
  readonly evidenceSemanticIdentities: readonly string[];
}

export interface ActionDecision {
  readonly kind: "ACTION_DECISION";
  readonly schemaVersion: typeof ACTION_DECISION_SCHEMA_VERSION;
  readonly intendedUse: "PRODUCT_ACTION_EXPLANATION_ONLY";
  readonly contractStage: "CANONICAL_ACTION_CLASSIFICATION";
  readonly semanticIdentity: string;
  readonly assetId: AssetId;
  readonly decisionTime: number;
  readonly asOf: number;
  readonly action: ActionDecisionAction;
  readonly supportedActionVocabulary: readonly ActionDecisionAction[];
  readonly currentlyDerivableActions: readonly ActionDecisionAction[];
  readonly actionDerivationStatus: "CANONICALLY_DERIVED" | "WAIT_FAIL_CLOSED";
  readonly canonicalEvidence: ActiveTargetLifecycle | null;
  readonly currentPortfolioState: Readonly<{
    status: "BOUND_CANONICAL_VALUATION" | "UNAVAILABLE_CANONICAL_CURRENT_WEIGHT_BINDING";
    currentWeight: number | null;
    sourceSemanticIdentity: string | null;
  }>;
  readonly canonicalTargetState: Readonly<{
    status: "BOUND_OMEGA_TARGET" | "UNAVAILABLE_CANONICAL_TARGET_WEIGHT_BINDING";
    targetWeight: number | null;
    sourceSemanticIdentity: string | null;
    targetContentIdentity: string | null;
    economicTargetContentIdentity: string | null;
  }>;
  readonly deltaWeight: number | null;
  readonly materialComparison: Readonly<{
    status: "BOUND_EXECUTION_PLANNER_POLICY" | "UNAVAILABLE";
    plannerPolicy: ExecutionPlannerPolicy | null;
    plannerPolicyIdentity: string | null;
    currentNotionalUsd: number | null;
    targetNotionalUsd: number | null;
    deltaNotionalUsd: number | null;
    executableUnderPolicy: boolean | null;
    relation: AssetExecutionRelation | null;
  }>;
  readonly lifecycleState: Readonly<{
    status: "BOUND_ACTIVE_TARGET_LIFECYCLE" | "UNAVAILABLE";
    lifecycleStatus: ActiveTargetLifecycle["lifecycleStatus"] | null;
    transition: ActiveTargetLifecycle["transition"] | null;
    sourceSemanticIdentity: string | null;
    activeTargetRootIdentity: string | null;
  }>;
  readonly canonicalSourceIdentities: Readonly<{
    valuationIdentity: string | null;
    relationshipEvidenceIdentity: string | null;
    targetDecisionIdentity: string | null;
    lifecycleIdentity: string | null;
    activeTargetRootIdentity: string | null;
  }>;
  readonly strategyEligibility: Readonly<{
    status: "NOT_BOUND_ACTION_CLASSIFICATION_DOES_NOT_INFER_ELIGIBILITY";
    sourceSemanticIdentity: null;
  }>;
  readonly permissionStatus: Readonly<{
    status: "BOUND_BY_OMEGA_TARGET_PROVENANCE" | "NOT_BOUND";
    sourceSemanticIdentities: readonly string[];
  }>;
  readonly riskStatus: Readonly<{
    status: "BOUND_BY_OMEGA_TARGET_PROVENANCE" | "NOT_BOUND";
    sourceSemanticIdentity: string | null;
  }>;
  readonly targetAuthorityStatus: "BOUND_OMEGA_TARGET" | "UNAVAILABLE_CANONICAL_TARGET_WEIGHT_BINDING";
  readonly timeframeAuthority: Readonly<{
    executableDomain: "1H";
    derived4hRole: "EXPLANATORY_ONLY_NOT_BOUND";
    derived1dRole: "EXPLANATORY_ONLY_NOT_BOUND";
  }>;
  readonly macroContextStatus: "NOT_BOUND";
  readonly dataQualityStatus: "LIVE_CANONICAL" | "NOT_BOUND";
  readonly reasons: readonly ActionDecisionReason[];
  readonly contradictions: readonly ActionDecisionContradiction[];
  readonly entryConditions: ActionConditionEvidence;
  readonly addConditions: ActionConditionEvidence;
  readonly holdConditions: ActionConditionEvidence;
  readonly reduceConditions: ActionConditionEvidence;
  readonly exitConditions: ActionConditionEvidence;
  readonly invalidationConditions: ActionConditionEvidence;
  readonly longOnly: true;
  readonly predictiveValidityEstablished: false;
  readonly approvedForPaperAction: false;
  readonly grantsPermissionAuthority: false;
  readonly grantsRiskAuthority: false;
  readonly grantsAllocationAuthority: false;
  readonly grantsTargetWeightAuthority: false;
  readonly grantsExecutionAuthority: false;
  readonly grantsAccountingAuthority: false;
  readonly modifiesCanonicalTargetWeight: false;
  readonly consumableByExecutionAsTargetAuthority: false;
  readonly priceAuthority: "NONE";
}

type RelationshipEvidence = Readonly<{
  sourceTime: number;
  valuationIdentity: string;
  relationshipEvidenceIdentity: string;
  target: ProvenancedTargetPortfolioWeight;
  targetDecisionIdentity: string;
  targetContentIdentity: string;
  economicTargetContentIdentity: string;
  plannerPolicy: ExecutionPlannerPolicy;
  currentWeight: number;
  targetWeight: number;
  currentNotionalUsd: number;
  targetNotionalUsd: number;
  deltaNotionalUsd: number;
  executableUnderPolicy: boolean;
  relation: AssetExecutionRelation;
}>;

export class ActionDecisionValidationError extends Error {
  constructor(message: string) {
    super(`[ActionDecision] ${message}`);
    this.name = "ActionDecisionValidationError";
  }
}

function fail(message: string): never {
  throw new ActionDecisionValidationError(message);
}

function validateBaseInput(input: ActionDecisionInput, expectedKeys: readonly string[]): void {
  if (input === null || typeof input !== "object" || Array.isArray(input)) fail("input must be an object.");
  if (canonicalProducerJson(Object.keys(input).sort()) !== canonicalProducerJson([...expectedKeys].sort())) {
    fail(`input may contain only ${expectedKeys.join(", ")}; action and authority evidence are not caller-authored.`);
  }
  if (typeof input.assetId !== "string" || input.assetId.length === 0 || input.assetId.trim() !== input.assetId) {
    fail("assetId must be a non-empty canonical identifier.");
  }
  if (!Number.isSafeInteger(input.decisionTime) || input.decisionTime < 0
    || !Number.isSafeInteger(input.asOf) || input.asOf < 0
    || input.asOf > input.decisionTime) {
    fail("decisionTime/asOf must be non-negative safe integers with asOf <= decisionTime.");
  }
}

function condition(status: ActionConditionEvidence["status"], identities: readonly string[]): ActionConditionEvidence {
  return { status, evidenceSemanticIdentities: identities };
}

function relationshipFromLifecycle(lifecycle: ActiveTargetLifecycle, assetId: AssetId): RelationshipEvidence | null {
  const executionTransition = lifecycle.transition.startsWith("EXECUTION_");
  if (executionTransition) {
    const execution = lifecycle.latestExecutionAssessment;
    if (!execution) return null;
    const valuation = execution.postExecutionValuation;
    const target = execution.target;
    if (!(assetId in valuation.assetWeights) && !(assetId in target.assetWeights)) return null;
    const currentWeight = valuation.assetWeights[assetId] ?? 0;
    const targetWeight = target.assetWeights[assetId] ?? 0;
    const plannerPolicy = execution.postExecutionPlan.plannerPolicy;
    validateExecutionPlannerPolicy(plannerPolicy);
    const currentNotionalUsd = currentWeight * valuation.nav;
    const targetNotionalUsd = targetWeight * valuation.nav;
    const deltaNotionalUsd = targetNotionalUsd - currentNotionalUsd;
    const executableUnderPolicy = isExecutableRebalanceDelta(deltaNotionalUsd, plannerPolicy);
    const relation: AssetExecutionRelation = !executableUnderPolicy
      ? "SATISFIED_UNDER_EXECUTION_POLICY"
      : deltaNotionalUsd > 0
        ? currentNotionalUsd === 0 ? "INCREASE_FROM_ZERO" : "INCREASE_FROM_POSITIVE"
        : targetNotionalUsd === 0 ? "EXIT_TO_ZERO" : "DECREASE_TO_POSITIVE";
    return {
      sourceTime: execution.executionTime,
      valuationIdentity: valuation.semanticIdentity,
      relationshipEvidenceIdentity: execution.semanticIdentity,
      target,
      targetDecisionIdentity: execution.targetDecisionIdentity,
      targetContentIdentity: target.provenance.targetContentIdentity,
      economicTargetContentIdentity: execution.economicTargetContentIdentity,
      plannerPolicy,
      currentWeight,
      targetWeight,
      currentNotionalUsd,
      targetNotionalUsd,
      deltaNotionalUsd,
      executableUnderPolicy,
      relation,
    };
  }

  const assessment = lifecycle.currentAssessment;
  const asset = assessment.assetAssessments.find((item) => item.assetId === assetId);
  if (!asset) return null;
  return {
    sourceTime: assessment.decisionTime,
    valuationIdentity: assessment.valuationIdentity,
    relationshipEvidenceIdentity: assessment.semanticIdentity,
    target: assessment.target,
    targetDecisionIdentity: assessment.targetDecisionIdentity,
    targetContentIdentity: assessment.targetContentIdentity,
    economicTargetContentIdentity: assessment.economicTargetContentIdentity,
    plannerPolicy: assessment.plannerPolicy,
    currentWeight: asset.currentWeight,
    targetWeight: asset.targetWeight,
    currentNotionalUsd: asset.currentNotionalUsd,
    targetNotionalUsd: asset.targetNotionalUsd,
    deltaNotionalUsd: asset.deltaNotionalUsd,
    executableUnderPolicy: asset.executableUnderPolicy,
    relation: asset.relation,
  };
}

function actionFor(relationship: RelationshipEvidence): ActionDecisionAction {
  if (!relationship.executableUnderPolicy) {
    return relationship.currentWeight > 0 && relationship.targetWeight > 0 ? "HOLD" : "WAIT";
  }
  if (relationship.relation === "INCREASE_FROM_ZERO") return "ENTER";
  if (relationship.relation === "INCREASE_FROM_POSITIVE") return "ADD";
  if (relationship.relation === "DECREASE_TO_POSITIVE") return "REDUCE";
  if (relationship.relation === "EXIT_TO_ZERO") return "EXIT";
  return "WAIT";
}

function reasonFor(action: ActionDecisionAction): ActionDecisionReason {
  if (action === "ENTER") return "ENTER_CANONICAL_ZERO_TO_MATERIALLY_POSITIVE_TARGET";
  if (action === "ADD") return "ADD_CANONICAL_MATERIALLY_HIGHER_POSITIVE_TARGET";
  if (action === "HOLD") return "HOLD_CANONICAL_POSITIVE_TARGET_SATISFIED_UNDER_POLICY";
  if (action === "REDUCE") return "REDUCE_CANONICAL_MATERIALLY_LOWER_POSITIVE_TARGET";
  if (action === "EXIT") return "EXIT_CANONICAL_POSITIVE_TO_ZERO_TARGET";
  return "WAIT_NO_MATERIALLY_EXECUTABLE_TRANSITION";
}

function sharedMaterial(input: ActionDecisionInput) {
  return {
    kind: "ACTION_DECISION" as const,
    schemaVersion: ACTION_DECISION_SCHEMA_VERSION,
    intendedUse: "PRODUCT_ACTION_EXPLANATION_ONLY" as const,
    contractStage: "CANONICAL_ACTION_CLASSIFICATION" as const,
    assetId: input.assetId,
    decisionTime: input.decisionTime,
    asOf: input.asOf,
    supportedActionVocabulary: ACTION_DECISION_ACTION_VOCABULARY,
    currentlyDerivableActions: ACTION_DECISION_ACTION_VOCABULARY,
    strategyEligibility: {
      status: "NOT_BOUND_ACTION_CLASSIFICATION_DOES_NOT_INFER_ELIGIBILITY" as const,
      sourceSemanticIdentity: null,
    },
    timeframeAuthority: {
      executableDomain: "1H" as const,
      derived4hRole: "EXPLANATORY_ONLY_NOT_BOUND" as const,
      derived1dRole: "EXPLANATORY_ONLY_NOT_BOUND" as const,
    },
    macroContextStatus: "NOT_BOUND" as const,
    longOnly: true as const,
    predictiveValidityEstablished: false as const,
    approvedForPaperAction: false as const,
    grantsPermissionAuthority: false as const,
    grantsRiskAuthority: false as const,
    grantsAllocationAuthority: false as const,
    grantsTargetWeightAuthority: false as const,
    grantsExecutionAuthority: false as const,
    grantsAccountingAuthority: false as const,
    modifiesCanonicalTargetWeight: false as const,
    consumableByExecutionAsTargetAuthority: false as const,
    priceAuthority: "NONE" as const,
  };
}

function deferredMaterial(input: ActionDecisionInput): Omit<ActionDecision, "semanticIdentity"> {
  return {
    ...sharedMaterial(input),
    action: "WAIT",
    actionDerivationStatus: "WAIT_FAIL_CLOSED",
    canonicalEvidence: null,
    currentPortfolioState: { status: "UNAVAILABLE_CANONICAL_CURRENT_WEIGHT_BINDING", currentWeight: null, sourceSemanticIdentity: null },
    canonicalTargetState: { status: "UNAVAILABLE_CANONICAL_TARGET_WEIGHT_BINDING", targetWeight: null, sourceSemanticIdentity: null, targetContentIdentity: null, economicTargetContentIdentity: null },
    deltaWeight: null,
    materialComparison: { status: "UNAVAILABLE", plannerPolicy: null, plannerPolicyIdentity: null, currentNotionalUsd: null, targetNotionalUsd: null, deltaNotionalUsd: null, executableUnderPolicy: null, relation: null },
    lifecycleState: { status: "UNAVAILABLE", lifecycleStatus: null, transition: null, sourceSemanticIdentity: null, activeTargetRootIdentity: null },
    canonicalSourceIdentities: { valuationIdentity: null, relationshipEvidenceIdentity: null, targetDecisionIdentity: null, lifecycleIdentity: null, activeTargetRootIdentity: null },
    permissionStatus: { status: "NOT_BOUND", sourceSemanticIdentities: [] },
    riskStatus: { status: "NOT_BOUND", sourceSemanticIdentity: null },
    targetAuthorityStatus: "UNAVAILABLE_CANONICAL_TARGET_WEIGHT_BINDING",
    dataQualityStatus: "NOT_BOUND",
    reasons: ["WAIT_CANONICAL_EVIDENCE_UNAVAILABLE_OR_INVALID"],
    contradictions: ["CANONICAL_EVIDENCE_UNAVAILABLE_OR_INVALID"],
    entryConditions: condition("UNAVAILABLE", []),
    addConditions: condition("UNAVAILABLE", []),
    holdConditions: condition("UNAVAILABLE", []),
    reduceConditions: condition("UNAVAILABLE", []),
    exitConditions: condition("UNAVAILABLE", []),
    invalidationConditions: condition("PROVEN", []),
  };
}

function canonicalMaterial(input: CanonicalActionDecisionInput, lifecycle: ActiveTargetLifecycle, relationship: RelationshipEvidence | null): Omit<ActionDecision, "semanticIdentity"> {
  const lifecycleIdentities = [lifecycle.semanticIdentity, lifecycle.activeTargetRootIdentity];
  const temporalMismatch = relationship !== null && (input.decisionTime !== relationship.sourceTime || input.asOf !== relationship.sourceTime);
  const lifecycleInvalid = lifecycle.lifecycleStatus === "INVALID";
  const action = !relationship || temporalMismatch || lifecycleInvalid ? "WAIT" : actionFor(relationship);
  const contradiction: ActionDecisionContradiction[] = !relationship
    ? ["ASSET_RELATIONSHIP_UNAVAILABLE"]
    : temporalMismatch
      ? ["CANONICAL_EVIDENCE_TIME_MISMATCH"]
      : lifecycleInvalid
        ? ["ACTIVE_TARGET_LIFECYCLE_INVALID"]
        : [];
  const reason: ActionDecisionReason = !relationship
    ? "WAIT_ASSET_RELATIONSHIP_UNAVAILABLE"
    : temporalMismatch
      ? "WAIT_CANONICAL_EVIDENCE_TIME_MISMATCH"
      : lifecycleInvalid
        ? "WAIT_INVALID_TARGET_LIFECYCLE"
        : reasonFor(action);
  const evidenceIdentities = relationship
    ? [...lifecycleIdentities, relationship.valuationIdentity, relationship.relationshipEvidenceIdentity, relationship.targetDecisionIdentity]
    : lifecycleIdentities;
  const conditionFor = (candidate: ActionDecisionAction): ActionConditionEvidence => condition(
    action === candidate ? "PROVEN" : "NOT_APPLICABLE",
    action === candidate ? evidenceIdentities : [],
  );
  return {
    ...sharedMaterial(input),
    action,
    actionDerivationStatus: action === "WAIT" ? "WAIT_FAIL_CLOSED" : "CANONICALLY_DERIVED",
    canonicalEvidence: lifecycle,
    currentPortfolioState: relationship
      ? { status: "BOUND_CANONICAL_VALUATION", currentWeight: relationship.currentWeight, sourceSemanticIdentity: relationship.valuationIdentity }
      : { status: "UNAVAILABLE_CANONICAL_CURRENT_WEIGHT_BINDING", currentWeight: null, sourceSemanticIdentity: null },
    canonicalTargetState: relationship
      ? { status: "BOUND_OMEGA_TARGET", targetWeight: relationship.targetWeight, sourceSemanticIdentity: relationship.targetDecisionIdentity, targetContentIdentity: relationship.targetContentIdentity, economicTargetContentIdentity: relationship.economicTargetContentIdentity }
      : { status: "UNAVAILABLE_CANONICAL_TARGET_WEIGHT_BINDING", targetWeight: null, sourceSemanticIdentity: null, targetContentIdentity: null, economicTargetContentIdentity: null },
    deltaWeight: relationship ? relationship.targetWeight - relationship.currentWeight : null,
    materialComparison: relationship
      ? { status: "BOUND_EXECUTION_PLANNER_POLICY", plannerPolicy: relationship.plannerPolicy, plannerPolicyIdentity: producerIdentity(relationship.plannerPolicy), currentNotionalUsd: relationship.currentNotionalUsd, targetNotionalUsd: relationship.targetNotionalUsd, deltaNotionalUsd: relationship.deltaNotionalUsd, executableUnderPolicy: relationship.executableUnderPolicy, relation: relationship.relation }
      : { status: "UNAVAILABLE", plannerPolicy: null, plannerPolicyIdentity: null, currentNotionalUsd: null, targetNotionalUsd: null, deltaNotionalUsd: null, executableUnderPolicy: null, relation: null },
    lifecycleState: { status: "BOUND_ACTIVE_TARGET_LIFECYCLE", lifecycleStatus: lifecycle.lifecycleStatus, transition: lifecycle.transition, sourceSemanticIdentity: lifecycle.semanticIdentity, activeTargetRootIdentity: lifecycle.activeTargetRootIdentity },
    canonicalSourceIdentities: { valuationIdentity: relationship?.valuationIdentity ?? null, relationshipEvidenceIdentity: relationship?.relationshipEvidenceIdentity ?? null, targetDecisionIdentity: relationship?.targetDecisionIdentity ?? null, lifecycleIdentity: lifecycle.semanticIdentity, activeTargetRootIdentity: lifecycle.activeTargetRootIdentity },
    permissionStatus: relationship ? { status: "BOUND_BY_OMEGA_TARGET_PROVENANCE", sourceSemanticIdentities: relationship.target.provenance.permissionIdentities } : { status: "NOT_BOUND", sourceSemanticIdentities: [] },
    riskStatus: relationship ? { status: "BOUND_BY_OMEGA_TARGET_PROVENANCE", sourceSemanticIdentity: relationship.target.provenance.riskIdentity } : { status: "NOT_BOUND", sourceSemanticIdentity: null },
    targetAuthorityStatus: relationship ? "BOUND_OMEGA_TARGET" : "UNAVAILABLE_CANONICAL_TARGET_WEIGHT_BINDING",
    dataQualityStatus: relationship ? "LIVE_CANONICAL" : "NOT_BOUND",
    reasons: [reason],
    contradictions: contradiction,
    entryConditions: conditionFor("ENTER"),
    addConditions: conditionFor("ADD"),
    holdConditions: conditionFor("HOLD"),
    reduceConditions: conditionFor("REDUCE"),
    exitConditions: conditionFor("EXIT"),
    invalidationConditions: condition(action === "WAIT" ? "PROVEN" : "NOT_APPLICABLE", action === "WAIT" ? evidenceIdentities : []),
  };
}

function buildDecision(material: Omit<ActionDecision, "semanticIdentity">): ActionDecision {
  return immutableProducerCopy({ ...material, semanticIdentity: producerIdentity(material) });
}

export function createDeferredActionDecision(input: ActionDecisionInput): ActionDecision {
  validateBaseInput(input, ["assetId", "decisionTime", "asOf"]);
  return buildDecision(deferredMaterial(input));
}

export function createCanonicalActionDecision(input: CanonicalActionDecisionInput): ActionDecision {
  validateBaseInput(input, ["assetId", "decisionTime", "asOf", "lifecycle"]);
  if (!input.lifecycle) return buildDecision(deferredMaterial(input));
  try {
    validateActiveTargetLifecycle(input.lifecycle);
  } catch {
    return buildDecision(deferredMaterial(input));
  }
  return buildDecision(canonicalMaterial(input, input.lifecycle, relationshipFromLifecycle(input.lifecycle, input.assetId)));
}

export function validateActionDecision(decision: ActionDecision): ActionDecision {
  if (decision === null || typeof decision !== "object" || Array.isArray(decision)) fail("decision must be an object.");
  const rebuilt = decision.canonicalEvidence === null
    ? createDeferredActionDecision({ assetId: decision.assetId, decisionTime: decision.decisionTime, asOf: decision.asOf })
    : createCanonicalActionDecision({ assetId: decision.assetId, decisionTime: decision.decisionTime, asOf: decision.asOf, lifecycle: decision.canonicalEvidence });
  if (decision.semanticIdentity !== rebuilt.semanticIdentity || canonicalProducerJson(decision) !== canonicalProducerJson(rebuilt)) {
    fail("decision is forged, stale, authority-bearing, or incompatible with canonical Step 4 classification.");
  }
  return decision;
}

export function serializeActionDecision(decision: ActionDecision): string {
  return canonicalProducerJson(validateActionDecision(decision));
}
