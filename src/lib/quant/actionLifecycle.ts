// ============================================================================
// FILE: src/lib/quant/actionLifecycle.ts
// MODULE: ACTION LIFECYCLE METHODOLOGY CONTRACT (M14 / A-03)
//
// A-03 freezes the meaning of the long-only action vocabulary. It does not
// classify numeric weights or model execution lifecycle state. Those actions
// remain deferred until A-04 supplies reviewed, identity-bearing canonical
// current/target/gate bindings and an explicit comparison policy.
// ============================================================================

import {
  ACTION_DECISION_ACTION_VOCABULARY,
  ACTION_DECISION_SCHEMA_VERSION,
  validateActionDecision,
  type ActionDecision,
  type ActionDecisionAction,
} from "./actionDecision";

export const ACTION_LIFECYCLE_SCHEMA_VERSION = "M14-A-03-1";

export type LifecycleConstructibility =
  | "CONSTRUCTIBLE_FAIL_CLOSED"
  | "DEFERRED_CANONICAL_BINDINGS_AND_COMPARISON_POLICY";

export interface ActionLifecycleDefinition {
  readonly action: ActionDecisionAction;
  readonly meaning: string;
  readonly currentExposureRelation: string;
  readonly authorizedTargetRelation: string;
  readonly constructibility: LifecycleConstructibility;
  readonly requiresCanonicalCurrentWeight: boolean;
  readonly requiresCanonicalTargetWeight: boolean;
  readonly requiresMaterialComparisonPolicy: boolean;
  readonly executionLifecycleRequired: boolean;
}

export interface ActionLifecyclePolicy {
  readonly kind: "ACTION_LIFECYCLE_POLICY";
  readonly schemaVersion: typeof ACTION_LIFECYCLE_SCHEMA_VERSION;
  readonly intendedUse: "PRODUCT_ACTION_LIFECYCLE_METHODOLOGY_ONLY";
  readonly methodologyOutcome: "PARTIAL_NON_WAIT_DERIVATION_DEFERRED";
  readonly actionDecisionSchemaVersion: typeof ACTION_DECISION_SCHEMA_VERSION;
  readonly vocabulary: readonly ActionDecisionAction[];
  readonly currentlyConstructibleActions: readonly ["WAIT"];
  readonly definitions: readonly ActionLifecycleDefinition[];
  readonly waitHoldDistinction: "WAIT_NO_PROVABLE_TRANSITION_HOLD_PROVABLE_POSITIVE_EQUAL_TARGET";
  readonly currentStateAuthority: "DEFERRED_IDENTITY_BEARING_CANONICAL_WEIGHT_BINDING";
  readonly targetStateAuthority: "DEFERRED_IDENTITY_BEARING_OMEGA_TARGET_BINDING";
  readonly comparisonPolicy: "DEFERRED_NO_CANONICAL_WEIGHT_TOLERANCE";
  readonly numericValidationPolicy: Readonly<{
    nonFinite: "REJECT";
    negative: "REJECT_LONG_ONLY";
    aboveOne: "DEFER_UNTIL_A04_CANONICAL_POLICY";
    signedZero: "DEFER_UNTIL_A04_NORMALIZATION_POLICY";
    floatingBoundary: "DEFER_UNTIL_A04_COMPARISON_POLICY";
    absentValuation: "WAIT_FAIL_CLOSED";
    staleOrMismatchedTimestamp: "WAIT_FAIL_CLOSED";
  }>;
  readonly executionLifecyclePolicy: Readonly<{
    newlyAuthorizedTarget: "DEFERRED_NOT_PERSISTED_AS_CANONICAL_LIFECYCLE_STATE";
    outstandingTarget: "DEFERRED_NOT_PERSISTED_AS_CANONICAL_LIFECYCLE_STATE";
    partialFill: "DEFERRED_NOT_PERSISTED_AS_CANONICAL_LIFECYCLE_STATE";
    completedTarget: "DEFERRED_NO_CANONICAL_COMPLETION_BINDING";
    repeatedTarget: "DEFERRED_NO_CANONICAL_TARGET_LINEAGE_IDENTITY";
    staleTarget: "WAIT_FAIL_CLOSED";
    replayBoundary: "DEFERRED_PENDING_REBALANCE_NOT_IN_DECISION_STATE";
  }>;
  readonly strategyEligibilityRole: "ADMISSION_ONLY_NEVER_ACTION_TRIGGER";
  readonly permissionRiskRole: "CONSUME_FUTURE_CANONICAL_RESULTS_NEVER_REIMPLEMENT";
  readonly omegaRole: "SOLE_TARGET_WEIGHT_AUTHORITY";
  readonly executionPath: "TARGET_PORTFOLIO_WEIGHT_DIRECT_TO_EXECUTION";
  readonly ledgerRole: "SOLE_CURRENT_PORTFOLIO_STATE_AUTHORITY";
  readonly reasonsAndConditionsRole: "EXPLANATORY_ONLY_NOT_ACTION_INPUT";
  readonly executableTimeframe: "1H";
  readonly derivedTimeframesRole: "4H_1D_EXPLANATORY_ONLY";
  readonly longOnly: true;
  readonly predictiveValidityEstablished: false;
  readonly approvedForPaperAction: false;
  readonly grantsPermissionAuthority: false;
  readonly grantsRiskAuthority: false;
  readonly grantsAllocationAuthority: false;
  readonly grantsTargetWeightAuthority: false;
  readonly grantsExecutionAuthority: false;
  readonly grantsAccountingAuthority: false;
  readonly semanticIdentity: string;
}

export class ActionLifecycleValidationError extends Error {
  constructor(message: string) {
    super(`[ActionLifecycle] ${message}`);
    this.name = "ActionLifecycleValidationError";
  }
}

function fail(message: string): never {
  throw new ActionLifecycleValidationError(message);
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

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    if (!Object.isFrozen(value)) Object.freeze(value);
  }
  return value;
}

function definition(
  action: ActionDecisionAction,
  meaning: string,
  currentExposureRelation: string,
  authorizedTargetRelation: string,
  constructible: boolean
): ActionLifecycleDefinition {
  return deepFreeze({
    action,
    meaning,
    currentExposureRelation,
    authorizedTargetRelation,
    constructibility: constructible
      ? "CONSTRUCTIBLE_FAIL_CLOSED" as const
      : "DEFERRED_CANONICAL_BINDINGS_AND_COMPARISON_POLICY" as const,
    requiresCanonicalCurrentWeight: !constructible,
    requiresCanonicalTargetWeight: !constructible,
    requiresMaterialComparisonPolicy: !constructible,
    executionLifecycleRequired: !constructible,
  });
}

function policyMaterial(): Omit<ActionLifecyclePolicy, "semanticIdentity"> {
  return deepFreeze({
    kind: "ACTION_LIFECYCLE_POLICY" as const,
    schemaVersion: ACTION_LIFECYCLE_SCHEMA_VERSION,
    intendedUse: "PRODUCT_ACTION_LIFECYCLE_METHODOLOGY_ONLY" as const,
    methodologyOutcome: "PARTIAL_NON_WAIT_DERIVATION_DEFERRED" as const,
    actionDecisionSchemaVersion: ACTION_DECISION_SCHEMA_VERSION,
    vocabulary: ACTION_DECISION_ACTION_VOCABULARY,
    currentlyConstructibleActions: Object.freeze(["WAIT"] as const),
    definitions: Object.freeze([
      definition(
        "WAIT",
        "No currently provable authorized transition exists, including unavailable or invalid canonical bindings.",
        "NOT_REQUIRED_FOR_FAIL_CLOSED_WAIT",
        "NOT_PROVABLY_ACTIONABLE",
        true
      ),
      definition(
        "ENTER",
        "Canonical long-only exposure is zero and the authorized canonical target is materially positive.",
        "ZERO",
        "MATERIALLY_POSITIVE",
        false
      ),
      definition(
        "ADD",
        "Canonical long-only exposure is positive and the authorized canonical target is materially higher.",
        "POSITIVE",
        "MATERIALLY_GREATER_THAN_CURRENT",
        false
      ),
      definition(
        "HOLD",
        "Canonical long-only exposure is positive and materially equal to the authorized canonical target.",
        "POSITIVE",
        "MATERIALLY_EQUAL_TO_CURRENT",
        false
      ),
      definition(
        "REDUCE",
        "The authorized canonical target remains positive but is materially below current canonical exposure.",
        "POSITIVE",
        "POSITIVE_AND_MATERIALLY_LESS_THAN_CURRENT",
        false
      ),
      definition(
        "EXIT",
        "Canonical long-only exposure is positive and the authorized canonical target is zero.",
        "POSITIVE",
        "ZERO",
        false
      ),
    ]),
    waitHoldDistinction: "WAIT_NO_PROVABLE_TRANSITION_HOLD_PROVABLE_POSITIVE_EQUAL_TARGET" as const,
    currentStateAuthority: "DEFERRED_IDENTITY_BEARING_CANONICAL_WEIGHT_BINDING" as const,
    targetStateAuthority: "DEFERRED_IDENTITY_BEARING_OMEGA_TARGET_BINDING" as const,
    comparisonPolicy: "DEFERRED_NO_CANONICAL_WEIGHT_TOLERANCE" as const,
    numericValidationPolicy: {
      nonFinite: "REJECT" as const,
      negative: "REJECT_LONG_ONLY" as const,
      aboveOne: "DEFER_UNTIL_A04_CANONICAL_POLICY" as const,
      signedZero: "DEFER_UNTIL_A04_NORMALIZATION_POLICY" as const,
      floatingBoundary: "DEFER_UNTIL_A04_COMPARISON_POLICY" as const,
      absentValuation: "WAIT_FAIL_CLOSED" as const,
      staleOrMismatchedTimestamp: "WAIT_FAIL_CLOSED" as const,
    },
    executionLifecyclePolicy: {
      newlyAuthorizedTarget: "DEFERRED_NOT_PERSISTED_AS_CANONICAL_LIFECYCLE_STATE" as const,
      outstandingTarget: "DEFERRED_NOT_PERSISTED_AS_CANONICAL_LIFECYCLE_STATE" as const,
      partialFill: "DEFERRED_NOT_PERSISTED_AS_CANONICAL_LIFECYCLE_STATE" as const,
      completedTarget: "DEFERRED_NO_CANONICAL_COMPLETION_BINDING" as const,
      repeatedTarget: "DEFERRED_NO_CANONICAL_TARGET_LINEAGE_IDENTITY" as const,
      staleTarget: "WAIT_FAIL_CLOSED" as const,
      replayBoundary: "DEFERRED_PENDING_REBALANCE_NOT_IN_DECISION_STATE" as const,
    },
    strategyEligibilityRole: "ADMISSION_ONLY_NEVER_ACTION_TRIGGER" as const,
    permissionRiskRole: "CONSUME_FUTURE_CANONICAL_RESULTS_NEVER_REIMPLEMENT" as const,
    omegaRole: "SOLE_TARGET_WEIGHT_AUTHORITY" as const,
    executionPath: "TARGET_PORTFOLIO_WEIGHT_DIRECT_TO_EXECUTION" as const,
    ledgerRole: "SOLE_CURRENT_PORTFOLIO_STATE_AUTHORITY" as const,
    reasonsAndConditionsRole: "EXPLANATORY_ONLY_NOT_ACTION_INPUT" as const,
    executableTimeframe: "1H" as const,
    derivedTimeframesRole: "4H_1D_EXPLANATORY_ONLY" as const,
    longOnly: true as const,
    predictiveValidityEstablished: false as const,
    approvedForPaperAction: false as const,
    grantsPermissionAuthority: false as const,
    grantsRiskAuthority: false as const,
    grantsAllocationAuthority: false as const,
    grantsTargetWeightAuthority: false as const,
    grantsExecutionAuthority: false as const,
    grantsAccountingAuthority: false as const,
  });
}

function buildPolicy(): ActionLifecyclePolicy {
  const material = policyMaterial();
  return deepFreeze({ ...material, semanticIdentity: canonicalJson(material) });
}

export const CURRENT_ACTION_LIFECYCLE_POLICY = buildPolicy();

export function validateActionLifecyclePolicy(policy: ActionLifecyclePolicy): ActionLifecyclePolicy {
  if (policy === null || typeof policy !== "object" || Array.isArray(policy)) {
    fail("policy must be an object.");
  }
  const rebuilt = buildPolicy();
  if (policy.semanticIdentity !== rebuilt.semanticIdentity
    || canonicalJson(policy) !== canonicalJson(rebuilt)) {
    fail("policy is forged, stale, authority-bearing, or incompatible with A-03 methodology.");
  }
  return policy;
}

export function serializeActionLifecyclePolicy(policy: ActionLifecyclePolicy): string {
  return canonicalJson(validateActionLifecyclePolicy(policy));
}

export function validateActionLifecycleDecision(decision: ActionDecision): ActionDecision {
  const validated = validateActionDecision(decision);
  validateActionLifecyclePolicy(CURRENT_ACTION_LIFECYCLE_POLICY);
  if (!CURRENT_ACTION_LIFECYCLE_POLICY.currentlyConstructibleActions.includes(validated.action as "WAIT")) {
    fail(`action ${validated.action} is not constructible under the partial A-03 policy.`);
  }
  return validated;
}
