import type {
  ActionConditionEvidence,
  ActionDecision,
  ActionDecisionAction,
  ActionDecisionContradiction,
  ActionDecisionReason,
} from "./quant/actionDecision";

export interface ActionDecisionConditionPresentation {
  readonly label: "Entry" | "Add" | "Hold" | "Reduce" | "Exit" | "Invalidation";
  readonly status: ActionConditionEvidence["status"];
  readonly evidenceSemanticIdentities: readonly string[];
}

export interface ActionDecisionPresentation {
  readonly semanticIdentity: string;
  readonly assetId: string;
  readonly action: ActionDecisionAction;
  readonly actionDerivationStatus: ActionDecision["actionDerivationStatus"];
  readonly decisionTime: number;
  readonly asOf: number;
  readonly decisionTimeLabel: string;
  readonly asOfLabel: string;
  readonly currentWeightLabel: string;
  readonly targetWeightLabel: string;
  readonly deltaWeightLabel: string;
  readonly dataQualityStatus: ActionDecision["dataQualityStatus"];
  readonly targetAuthorityStatus: ActionDecision["targetAuthorityStatus"];
  readonly permissionStatus: ActionDecision["permissionStatus"]["status"];
  readonly riskStatus: ActionDecision["riskStatus"]["status"];
  readonly lifecycleStatus: ActionDecision["lifecycleState"]["lifecycleStatus"];
  readonly reasons: readonly Readonly<{ code: ActionDecisionReason; label: string }>[];
  readonly contradictions: readonly Readonly<{ code: ActionDecisionContradiction; label: string }>[];
  readonly conditions: readonly ActionDecisionConditionPresentation[];
  readonly failClosed: boolean;
}

const REASON_LABELS: Readonly<Record<ActionDecisionReason, string>> = Object.freeze({
  WAIT_CANONICAL_EVIDENCE_UNAVAILABLE_OR_INVALID: "Canonical evidence is unavailable or invalid.",
  WAIT_CANONICAL_EVIDENCE_TIME_MISMATCH: "Canonical evidence does not match the decision time.",
  WAIT_ASSET_RELATIONSHIP_UNAVAILABLE: "Canonical asset relationship evidence is unavailable.",
  WAIT_INVALID_TARGET_LIFECYCLE: "The active target lifecycle is invalid.",
  WAIT_NO_MATERIALLY_EXECUTABLE_TRANSITION: "No materially executable transition is proven.",
  ENTER_CANONICAL_ZERO_TO_MATERIALLY_POSITIVE_TARGET: "Omega changed the target from zero to a materially positive weight.",
  ADD_CANONICAL_MATERIALLY_HIGHER_POSITIVE_TARGET: "Omega supplied a materially higher positive target.",
  HOLD_CANONICAL_POSITIVE_TARGET_SATISFIED_UNDER_POLICY: "The positive target is satisfied under execution policy.",
  REDUCE_CANONICAL_MATERIALLY_LOWER_POSITIVE_TARGET: "Omega supplied a materially lower positive target.",
  EXIT_CANONICAL_POSITIVE_TO_ZERO_TARGET: "Omega changed the target from positive exposure to zero.",
});

const CONTRADICTION_LABELS: Readonly<Record<ActionDecisionContradiction, string>> = Object.freeze({
  CANONICAL_EVIDENCE_UNAVAILABLE_OR_INVALID: "Canonical evidence unavailable or invalid.",
  CANONICAL_EVIDENCE_TIME_MISMATCH: "Canonical evidence time mismatch.",
  ASSET_RELATIONSHIP_UNAVAILABLE: "Asset relationship evidence unavailable.",
  ACTIVE_TARGET_LIFECYCLE_INVALID: "Active target lifecycle invalid.",
});

export function formatActionWeight(value: number | null, includeSign = false): string {
  if (value === null) return "Unavailable";
  const percentage = value * 100;
  const sign = includeSign && percentage > 0 ? "+" : "";
  return `${sign}${percentage.toFixed(2)}%`;
}

export function formatActionTime(value: number): string {
  return new Date(value).toISOString().replace("T", " ").replace(".000Z", " UTC");
}

function presentCondition(
  label: ActionDecisionConditionPresentation["label"],
  evidence: ActionConditionEvidence,
): ActionDecisionConditionPresentation | null {
  if (evidence.status !== "PROVEN" && evidence.evidenceSemanticIdentities.length === 0) return null;
  return Object.freeze({
    label,
    status: evidence.status,
    evidenceSemanticIdentities: Object.freeze([...evidence.evidenceSemanticIdentities]),
  });
}

/**
 * Deterministic presentation only. The displayed action is copied directly
 * from the canonical ActionDecision and is never inferred from weights,
 * evidence, macro context, rules, account state, or telemetry.
 */
export function presentActionDecision(decision: ActionDecision): ActionDecisionPresentation {
  const conditions = [
    presentCondition("Entry", decision.entryConditions),
    presentCondition("Add", decision.addConditions),
    presentCondition("Hold", decision.holdConditions),
    presentCondition("Reduce", decision.reduceConditions),
    presentCondition("Exit", decision.exitConditions),
    presentCondition("Invalidation", decision.invalidationConditions),
  ].filter((item): item is ActionDecisionConditionPresentation => item !== null);

  return Object.freeze({
    semanticIdentity: decision.semanticIdentity,
    assetId: decision.assetId,
    action: decision.action,
    actionDerivationStatus: decision.actionDerivationStatus,
    decisionTime: decision.decisionTime,
    asOf: decision.asOf,
    decisionTimeLabel: formatActionTime(decision.decisionTime),
    asOfLabel: formatActionTime(decision.asOf),
    currentWeightLabel: formatActionWeight(decision.currentPortfolioState.currentWeight),
    targetWeightLabel: formatActionWeight(decision.canonicalTargetState.targetWeight),
    deltaWeightLabel: formatActionWeight(decision.deltaWeight, true),
    dataQualityStatus: decision.dataQualityStatus,
    targetAuthorityStatus: decision.targetAuthorityStatus,
    permissionStatus: decision.permissionStatus.status,
    riskStatus: decision.riskStatus.status,
    lifecycleStatus: decision.lifecycleState.lifecycleStatus,
    reasons: Object.freeze(decision.reasons.map((code) => Object.freeze({ code, label: REASON_LABELS[code] }))),
    contradictions: Object.freeze(decision.contradictions.map((code) => Object.freeze({ code, label: CONTRADICTION_LABELS[code] }))),
    conditions: Object.freeze(conditions),
    failClosed: decision.actionDerivationStatus === "WAIT_FAIL_CLOSED",
  });
}
