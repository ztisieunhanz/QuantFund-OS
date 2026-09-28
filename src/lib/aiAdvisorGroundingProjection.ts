import {
  AI_ADVISOR_GROUNDING_SCHEMA_VERSION,
  AI_ADVISOR_MAX_EVIDENCE_IDENTITIES,
  type AiAdvisorGrounding,
  type GroundedActionDecision,
  type GroundedCondition,
  type GroundedMarketSnapshot,
  type GroundedObservedDatum,
  type GroundedOperationalState,
} from "./aiAdvisorGrounding";
import {
  validateActionDecision,
  type ActionConditionEvidence,
  type ActionDecision,
} from "./quant/actionDecision";
import type { CurrentMarketSnapshot } from "./macro/types";

const OBSERVED_IDS = ["dxy", "us2y", "us10y", "vix", "gold", "btc", "vnindex"] as const;

function freezeCondition(condition: ActionConditionEvidence): GroundedCondition {
  return Object.freeze({
    status: condition.status,
    evidenceSemanticIdentities: Object.freeze(
      condition.evidenceSemanticIdentities.slice(0, AI_ADVISOR_MAX_EVIDENCE_IDENTITIES),
    ),
  });
}

function unavailableAction(reason: "NO_CANONICAL_ACTION_DECISION" | "INVALID_CANONICAL_ACTION_DECISION"): GroundedActionDecision {
  return Object.freeze({ status: "UNAVAILABLE", reason });
}

function projectActionDecision(decision: ActionDecision | null): GroundedActionDecision {
  if (!decision) return unavailableAction("NO_CANONICAL_ACTION_DECISION");
  try {
    validateActionDecision(decision);
  } catch {
    return unavailableAction("INVALID_CANONICAL_ACTION_DECISION");
  }
  return Object.freeze({
    status: "AVAILABLE",
    semanticIdentity: decision.semanticIdentity,
    assetId: decision.assetId,
    action: decision.action,
    actionDerivationStatus: decision.actionDerivationStatus,
    failClosed: decision.actionDerivationStatus === "WAIT_FAIL_CLOSED",
    decisionTime: decision.decisionTime,
    asOf: decision.asOf,
    currentWeight: decision.currentPortfolioState.currentWeight,
    targetWeight: decision.canonicalTargetState.targetWeight,
    deltaWeight: decision.deltaWeight,
    dataQualityStatus: decision.dataQualityStatus,
    targetAuthorityStatus: decision.targetAuthorityStatus,
    permissionStatus: decision.permissionStatus.status,
    riskStatus: decision.riskStatus.status,
    lifecycleStatus: decision.lifecycleState.lifecycleStatus,
    reasons: Object.freeze([...decision.reasons]),
    contradictions: Object.freeze([...decision.contradictions]),
    conditions: Object.freeze({
      entry: freezeCondition(decision.entryConditions),
      add: freezeCondition(decision.addConditions),
      hold: freezeCondition(decision.holdConditions),
      reduce: freezeCondition(decision.reduceConditions),
      exit: freezeCondition(decision.exitConditions),
      invalidation: freezeCondition(decision.invalidationConditions),
    }),
  });
}

function projectMarketSnapshot(snapshot: CurrentMarketSnapshot | null): GroundedMarketSnapshot {
  if (!snapshot || !Number.isFinite(snapshot.timestamp)) {
    return Object.freeze({ status: "UNAVAILABLE", contextRole: "OBSERVED_CONTEXT_ONLY_NOT_ACTION_AUTHORITY" });
  }
  const observed = OBSERVED_IDS.map((id): GroundedObservedDatum => {
    const datum = snapshot.data[id];
    const available = datum.status === "AVAILABLE" && typeof datum.value === "number" && Number.isFinite(datum.value);
    return Object.freeze({
      id,
      status: available ? "AVAILABLE" : "UNAVAILABLE",
      value: available ? datum.value as number : null,
      asOf: available && Number.isFinite(datum.asOf) ? datum.asOf : null,
      quality: available ? datum.quality : "UNAVAILABLE",
      sourceClassification: available ? datum.sourceClassification : "UNAVAILABLE",
      provider: datum.provider,
      instrument: datum.instrument,
    });
  });
  const macro = snapshot.macro;
  const synthesis = snapshot.synthesis;
  const operationalState: GroundedOperationalState | undefined = snapshot.operationalState
    ? {
      schemaVersion: snapshot.operationalState.schemaVersion,
      status: snapshot.operationalState.status,
      cycleKeySerialized: snapshot.operationalState.cycleKeySerialized,
      decisionTime: snapshot.operationalState.decisionTime,
      observationTime: snapshot.operationalState.observationTime,
      source: snapshot.operationalState.source,
      historicalOnly: snapshot.operationalState.historicalOnly,
      reason: snapshot.operationalState.reason,
    }
    : undefined;
  return Object.freeze({
    status: "AVAILABLE",
    contextRole: "OBSERVED_CONTEXT_ONLY_NOT_ACTION_AUTHORITY",
    timestamp: snapshot.timestamp,
    observed: Object.freeze(observed),
    macro: Object.freeze({
      status: macro?.status ?? "UNAVAILABLE",
      regime: macro?.regime ?? null,
      confidence: macro?.confidence ?? null,
      unavailableMetrics: Object.freeze([...(macro?.unavailableMetrics ?? [])].slice(0, 16)),
      staleMetrics: Object.freeze([...(macro?.staleMetrics ?? [])].slice(0, 16)),
    }),
    synthesis: Object.freeze({
      status: synthesis?.status ?? "UNAVAILABLE",
      stance: synthesis?.stance ?? null,
      headline: synthesis?.headline?.slice(0, 500) ?? null,
      confidence: synthesis?.confidence ?? null,
      dataCoverage: synthesis?.dataCoverage ?? null,
    }),
    ...(operationalState ? { operationalState: Object.freeze(operationalState) } : {}),
  });
}

export function buildAiAdvisorGrounding(
  actionDecision: ActionDecision | null,
  marketSnapshot: CurrentMarketSnapshot | null,
): AiAdvisorGrounding {
  const currentActionDecision = marketSnapshot?.operationalState
    && marketSnapshot.operationalState.status !== "FRESH_CURRENT"
    ? null
    : actionDecision;
  return Object.freeze({
    schemaVersion: AI_ADVISOR_GROUNDING_SCHEMA_VERSION,
    actionDecision: projectActionDecision(currentActionDecision),
    marketSnapshot: projectMarketSnapshot(marketSnapshot),
    authority: Object.freeze({
      explanationOnly: true,
      paperResearchOnly: true,
      grantsPermissionAuthority: false,
      grantsRiskAuthority: false,
      grantsAllocationAuthority: false,
      grantsExecutionAuthority: false,
      grantsAccountingAuthority: false,
    }),
  });
}
