// ============================================================================
// FILE: src/lib/quant/actionDecision.ts
// MODULE: PRODUCT-FACING ACTION DECISION CONTRACT (M14 / A-02)
//
// This first contract version is deliberately partial. The repository does
// not yet expose identity-bearing canonical bindings that jointly prove the
// current portfolio weight, authorized target weight, gate results, and
// pending-execution state. Until A-03/A-04 provide those bindings, only WAIT
// is constructible. No caller-supplied authority or explanation is accepted.
// ============================================================================

import type { AssetId } from "./types";

export const ACTION_DECISION_SCHEMA_VERSION = "M14-A-02-1";

export const ACTION_DECISION_ACTION_VOCABULARY = Object.freeze([
  "WAIT",
  "ENTER",
  "ADD",
  "HOLD",
  "REDUCE",
  "EXIT",
] as const);

export type ActionDecisionAction = typeof ACTION_DECISION_ACTION_VOCABULARY[number];

export type DeferredActionCondition = Readonly<{
  status: "DEFERRED_CANONICAL_BINDINGS_UNAVAILABLE";
  evidenceSemanticIdentities: readonly [];
}>;

export interface ActionDecisionInput {
  readonly assetId: AssetId;
  readonly decisionTime: number;
  readonly asOf: number;
}

export interface ActionDecision {
  readonly kind: "ACTION_DECISION";
  readonly schemaVersion: typeof ACTION_DECISION_SCHEMA_VERSION;
  readonly intendedUse: "PRODUCT_ACTION_EXPLANATION_ONLY";
  readonly contractStage: "PARTIAL_ACTION_DERIVATION_DEFERRED";
  readonly semanticIdentity: string;
  readonly assetId: AssetId;
  readonly decisionTime: number;
  readonly asOf: number;
  readonly action: ActionDecisionAction;
  readonly supportedActionVocabulary: readonly ActionDecisionAction[];
  readonly currentlyDerivableActions: readonly ["WAIT"];
  readonly actionDerivationStatus: "DEFERRED_CANONICAL_BINDINGS_UNAVAILABLE";
  readonly currentPortfolioState: Readonly<{
    status: "UNAVAILABLE_CANONICAL_CURRENT_WEIGHT_BINDING";
    currentWeight: null;
    sourceSemanticIdentity: null;
  }>;
  readonly canonicalTargetState: Readonly<{
    status: "UNAVAILABLE_CANONICAL_TARGET_WEIGHT_BINDING";
    targetWeight: null;
    sourceSemanticIdentity: null;
  }>;
  readonly deltaWeight: null;
  readonly strategyEligibility: Readonly<{
    status: "NOT_BOUND_A03_A04_PENDING";
    sourceSemanticIdentity: null;
  }>;
  readonly permissionStatus: Readonly<{
    status: "NOT_BOUND_A03_A04_PENDING";
    sourceSemanticIdentity: null;
  }>;
  readonly riskStatus: Readonly<{
    status: "NOT_BOUND_A03_A04_PENDING";
    sourceSemanticIdentity: null;
  }>;
  readonly targetAuthorityStatus: "UNAVAILABLE_CANONICAL_TARGET_WEIGHT_BINDING";
  readonly timeframeAuthority: Readonly<{
    executableDomain: "1H";
    derived4hRole: "EXPLANATORY_ONLY_NOT_BOUND";
    derived1dRole: "EXPLANATORY_ONLY_NOT_BOUND";
  }>;
  readonly macroContextStatus: "NOT_BOUND";
  readonly dataQualityStatus: "NOT_BOUND";
  readonly reasons: readonly [
    "WAIT_CANONICAL_CURRENT_WEIGHT_BINDING_UNAVAILABLE",
    "WAIT_CANONICAL_TARGET_WEIGHT_BINDING_UNAVAILABLE",
    "ACTION_DERIVATION_DEFERRED_TO_A03_A04"
  ];
  readonly contradictions: readonly [];
  readonly entryConditions: DeferredActionCondition;
  readonly addConditions: DeferredActionCondition;
  readonly reduceConditions: DeferredActionCondition;
  readonly exitConditions: DeferredActionCondition;
  readonly invalidationConditions: DeferredActionCondition;
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

export class ActionDecisionValidationError extends Error {
  constructor(message: string) {
    super(`[ActionDecision] ${message}`);
    this.name = "ActionDecisionValidationError";
  }
}

function fail(message: string): never {
  throw new ActionDecisionValidationError(message);
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

function validateInput(input: ActionDecisionInput): void {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    fail("input must be an object.");
  }
  const keys = Object.keys(input).sort();
  if (canonicalJson(keys) !== canonicalJson(["asOf", "assetId", "decisionTime"])) {
    fail("input may contain only assetId, decisionTime, and asOf; authority and explanation are not caller-authored.");
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

function deferredCondition(): DeferredActionCondition {
  return deepFreeze({
    status: "DEFERRED_CANONICAL_BINDINGS_UNAVAILABLE" as const,
    evidenceSemanticIdentities: Object.freeze([]) as readonly [],
  });
}

function materialFor(input: ActionDecisionInput): Omit<ActionDecision, "semanticIdentity"> {
  validateInput(input);
  return deepFreeze({
    kind: "ACTION_DECISION" as const,
    schemaVersion: ACTION_DECISION_SCHEMA_VERSION,
    intendedUse: "PRODUCT_ACTION_EXPLANATION_ONLY" as const,
    contractStage: "PARTIAL_ACTION_DERIVATION_DEFERRED" as const,
    assetId: input.assetId,
    decisionTime: input.decisionTime,
    asOf: input.asOf,
    action: "WAIT" as const,
    supportedActionVocabulary: ACTION_DECISION_ACTION_VOCABULARY,
    currentlyDerivableActions: Object.freeze(["WAIT"] as const),
    actionDerivationStatus: "DEFERRED_CANONICAL_BINDINGS_UNAVAILABLE" as const,
    currentPortfolioState: {
      status: "UNAVAILABLE_CANONICAL_CURRENT_WEIGHT_BINDING" as const,
      currentWeight: null,
      sourceSemanticIdentity: null,
    },
    canonicalTargetState: {
      status: "UNAVAILABLE_CANONICAL_TARGET_WEIGHT_BINDING" as const,
      targetWeight: null,
      sourceSemanticIdentity: null,
    },
    deltaWeight: null,
    strategyEligibility: { status: "NOT_BOUND_A03_A04_PENDING" as const, sourceSemanticIdentity: null },
    permissionStatus: { status: "NOT_BOUND_A03_A04_PENDING" as const, sourceSemanticIdentity: null },
    riskStatus: { status: "NOT_BOUND_A03_A04_PENDING" as const, sourceSemanticIdentity: null },
    targetAuthorityStatus: "UNAVAILABLE_CANONICAL_TARGET_WEIGHT_BINDING" as const,
    timeframeAuthority: {
      executableDomain: "1H" as const,
      derived4hRole: "EXPLANATORY_ONLY_NOT_BOUND" as const,
      derived1dRole: "EXPLANATORY_ONLY_NOT_BOUND" as const,
    },
    macroContextStatus: "NOT_BOUND" as const,
    dataQualityStatus: "NOT_BOUND" as const,
    reasons: Object.freeze([
      "WAIT_CANONICAL_CURRENT_WEIGHT_BINDING_UNAVAILABLE",
      "WAIT_CANONICAL_TARGET_WEIGHT_BINDING_UNAVAILABLE",
      "ACTION_DERIVATION_DEFERRED_TO_A03_A04",
    ] as const),
    contradictions: Object.freeze([]) as readonly [],
    entryConditions: deferredCondition(),
    addConditions: deferredCondition(),
    reduceConditions: deferredCondition(),
    exitConditions: deferredCondition(),
    invalidationConditions: deferredCondition(),
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
  });
}

export function createDeferredActionDecision(input: ActionDecisionInput): ActionDecision {
  const material = materialFor(input);
  return deepFreeze({ ...material, semanticIdentity: canonicalJson(material) });
}

export function validateActionDecision(decision: ActionDecision): ActionDecision {
  if (decision === null || typeof decision !== "object" || Array.isArray(decision)) {
    fail("decision must be an object.");
  }
  const rebuilt = createDeferredActionDecision({
    assetId: decision.assetId,
    decisionTime: decision.decisionTime,
    asOf: decision.asOf,
  });
  if (decision.semanticIdentity !== rebuilt.semanticIdentity
    || canonicalJson(decision) !== canonicalJson(rebuilt)) {
    fail("decision is forged, stale, authority-bearing, or incompatible with the partial A-02 contract.");
  }
  return decision;
}

export function serializeActionDecision(decision: ActionDecision): string {
  return canonicalJson(validateActionDecision(decision));
}
