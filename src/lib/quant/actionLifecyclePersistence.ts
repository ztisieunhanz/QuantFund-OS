import {
  createCanonicalActionDecision,
  validateActionDecision,
  type ActionDecision,
} from "./actionDecision";
import {
  canonicalProducerJson,
  immutableProducerCopy,
  producerIdentity,
  validateRiskOutput,
} from "./producerProvenance";
import {
  validateActiveTargetLifecycle,
  validateActiveTargetLifecycleAgainstPrior,
  type ActiveTargetLifecycle,
} from "./targetExecutionLifecycle";
import type { AssetId, DecisionState, ProvenancedTargetPortfolioWeight } from "./types";

export const DURABLE_TARGET_LIFECYCLE_CHECKPOINT_SCHEMA_VERSION =
  "M14_A04_DURABLE_TARGET_LIFECYCLE_CHECKPOINT_V2" as const;

export interface DurableTargetLifecycleCheckpoint {
  readonly kind: "DURABLE_TARGET_LIFECYCLE_CHECKPOINT";
  readonly schemaVersion: typeof DURABLE_TARGET_LIFECYCLE_CHECKPOINT_SCHEMA_VERSION;
  readonly intendedUse: "PAPER_REPLAY_LIFECYCLE_RECOVERY_EVIDENCE_ONLY";
  readonly actionAssetId: AssetId;
  readonly decisionTime: number;
  readonly decisionStateIdentity: string;
  readonly lifecycleIdentity: string;
  /** Ordered prior evidence; append lifecycle to obtain the complete root-to-terminal proof. */
  readonly lineageWitness: readonly ActiveTargetLifecycle[];
  readonly lifecycle: ActiveTargetLifecycle;
  readonly semanticIdentity: string;
  readonly grantsPermissionAuthority: false;
  readonly grantsRiskAuthority: false;
  readonly grantsAllocationAuthority: false;
  readonly grantsTargetWeightAuthority: false;
  readonly grantsExecutionAuthority: false;
  readonly grantsAccountingAuthority: false;
  readonly priceAuthority: "NONE";
}

export interface RestoredLifecycleEvidence {
  readonly checkpoint: DurableTargetLifecycleCheckpoint;
  readonly actionDecision: ActionDecision;
}

function requireDecisionStateBinding(
  decision: DecisionState,
  lifecycle: ActiveTargetLifecycle,
): void {
  if (!Number.isSafeInteger(decision.timestamp) || decision.timestamp < 0) {
    throw new Error("Durable lifecycle checkpoint requires a valid DecisionState timestamp");
  }
  if (decision.timestamp !== lifecycle.currentAssessment.decisionTime
    || decision.timestamp !== lifecycle.latestDecisionTime) {
    throw new Error("Durable lifecycle checkpoint DecisionState/lifecycle time mismatch");
  }
  const target = decision.targetWeights as ProvenancedTargetPortfolioWeight;
  if (!target.provenance
    || target.provenance.targetDecisionIdentity !== lifecycle.latestTargetDecisionIdentity
    || canonicalProducerJson(target) !== canonicalProducerJson(lifecycle.currentAssessment.target)) {
    throw new Error("Durable lifecycle checkpoint DecisionState/target binding mismatch");
  }
  validateRiskOutput(decision.risk);
  if (decision.risk.provenance.decisionTime !== decision.timestamp
    || decision.risk.provenance.valuationBindingStatus !== "BOUND_CANONICAL_VALUATION"
    || decision.risk.provenance.valuationIdentity !== lifecycle.currentAssessment.valuationIdentity) {
    throw new Error("Durable lifecycle checkpoint DecisionState/Risk valuation binding mismatch");
  }

  const inventoryProjection = (cash: number, positions: DecisionState["positions"]) => ({
    cash,
    positions: Object.fromEntries(Object.entries(positions)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([assetId, position]) => [assetId, {
        assetId: position.assetId,
        quantity: position.quantity,
        entryPrice: position.entryPrice,
        side: position.side,
        status: position.status,
      }])),
  });
  const valuationAccount = lifecycle.currentAssessment.valuation.accountState;
  if (canonicalProducerJson(inventoryProjection(decision.cash, decision.positions))
    !== canonicalProducerJson(inventoryProjection(valuationAccount.cash, valuationAccount.positions))) {
    throw new Error("Durable lifecycle checkpoint DecisionState/ledger-inventory binding mismatch");
  }
}

function validateLifecycleLineage(
  lifecycleEvidence: readonly ActiveTargetLifecycle[],
): ActiveTargetLifecycle {
  if (!Array.isArray(lifecycleEvidence) || lifecycleEvidence.length === 0) {
    throw new Error("Durable lifecycle checkpoint requires ordered root-to-terminal evidence");
  }
  for (let index = 0; index < lifecycleEvidence.length; index += 1) {
    const lifecycle = lifecycleEvidence[index];
    validateActiveTargetLifecycle(lifecycle);
    if (index === 0) {
      if (lifecycle.transition !== "ROOT_CREATED" || lifecycle.predecessorLifecycleIdentity !== null) {
        throw new Error("Durable lifecycle lineage does not begin at a valid root");
      }
    } else {
      validateActiveTargetLifecycleAgainstPrior(lifecycle, lifecycleEvidence[index - 1]);
    }
  }
  return lifecycleEvidence[lifecycleEvidence.length - 1];
}

function requireActionAsset(lifecycle: ActiveTargetLifecycle, actionAssetId: AssetId): void {
  if (typeof actionAssetId !== "string" || actionAssetId.length === 0 || actionAssetId.trim() !== actionAssetId) {
    throw new Error("Durable lifecycle checkpoint action asset is invalid");
  }
  if (!lifecycle.currentAssessment.assetAssessments.some((item) => item.assetId === actionAssetId)) {
    throw new Error("Durable lifecycle checkpoint action asset is absent from canonical lifecycle evidence");
  }
}

function checkpointMaterial(input: {
  readonly actionAssetId: AssetId;
  readonly lifecycleEvidence: readonly ActiveTargetLifecycle[];
  readonly decisionState: DecisionState;
}): Omit<DurableTargetLifecycleCheckpoint, "semanticIdentity"> {
  const lifecycle = validateLifecycleLineage(input.lifecycleEvidence);
  requireActionAsset(lifecycle, input.actionAssetId);
  requireDecisionStateBinding(input.decisionState, lifecycle);
  return {
    kind: "DURABLE_TARGET_LIFECYCLE_CHECKPOINT",
    schemaVersion: DURABLE_TARGET_LIFECYCLE_CHECKPOINT_SCHEMA_VERSION,
    intendedUse: "PAPER_REPLAY_LIFECYCLE_RECOVERY_EVIDENCE_ONLY",
    actionAssetId: input.actionAssetId,
    decisionTime: input.decisionState.timestamp,
    decisionStateIdentity: producerIdentity(input.decisionState),
    lifecycleIdentity: lifecycle.semanticIdentity,
    lineageWitness: input.lifecycleEvidence.slice(0, -1),
    lifecycle,
    grantsPermissionAuthority: false,
    grantsRiskAuthority: false,
    grantsAllocationAuthority: false,
    grantsTargetWeightAuthority: false,
    grantsExecutionAuthority: false,
    grantsAccountingAuthority: false,
    priceAuthority: "NONE",
  };
}

export function createDurableTargetLifecycleCheckpoint(input: {
  readonly actionAssetId: AssetId;
  readonly lifecycleEvidence: readonly ActiveTargetLifecycle[];
  readonly decisionState: DecisionState;
}): DurableTargetLifecycleCheckpoint {
  const material = checkpointMaterial(input);
  return immutableProducerCopy({ ...material, semanticIdentity: producerIdentity(material) });
}

export function createDurableTargetLifecycleCheckpointFromReplay(input: {
  readonly actionAssetId: AssetId;
  readonly lifecycleEvidence: readonly ActiveTargetLifecycle[];
  readonly decisionState: DecisionState;
}): DurableTargetLifecycleCheckpoint {
  return createDurableTargetLifecycleCheckpoint({
    actionAssetId: input.actionAssetId,
    lifecycleEvidence: input.lifecycleEvidence,
    decisionState: input.decisionState,
  });
}

export function validateDurableTargetLifecycleCheckpoint(
  checkpoint: DurableTargetLifecycleCheckpoint,
  decisionState: DecisionState,
): DurableTargetLifecycleCheckpoint {
  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) {
    throw new Error("Durable lifecycle checkpoint must be an object");
  }
  const rebuilt = createDurableTargetLifecycleCheckpoint({
    actionAssetId: checkpoint.actionAssetId,
    lifecycleEvidence: [...checkpoint.lineageWitness, checkpoint.lifecycle],
    decisionState,
  });
  if (checkpoint.schemaVersion !== DURABLE_TARGET_LIFECYCLE_CHECKPOINT_SCHEMA_VERSION
    || checkpoint.kind !== "DURABLE_TARGET_LIFECYCLE_CHECKPOINT"
    || checkpoint.intendedUse !== "PAPER_REPLAY_LIFECYCLE_RECOVERY_EVIDENCE_ONLY"
    || canonicalProducerJson(checkpoint) !== canonicalProducerJson(rebuilt)) {
    throw new Error("Durable lifecycle checkpoint is forged, stale, authority-bearing, or unsupported");
  }
  return rebuilt;
}

export function reconstructActionDecisionFromCheckpoint(
  checkpoint: DurableTargetLifecycleCheckpoint,
  decisionState: DecisionState,
): RestoredLifecycleEvidence {
  const validated = validateDurableTargetLifecycleCheckpoint(checkpoint, decisionState);
  const actionDecision = createCanonicalActionDecision({
    assetId: validated.actionAssetId,
    decisionTime: validated.decisionTime,
    asOf: validated.decisionTime,
    lifecycle: validated.lifecycle,
  });
  validateActionDecision(actionDecision);
  return immutableProducerCopy({ checkpoint: validated, actionDecision });
}

export function serializeDurableTargetLifecycleCheckpoint(
  checkpoint: DurableTargetLifecycleCheckpoint,
  decisionState: DecisionState,
): string {
  return canonicalProducerJson(validateDurableTargetLifecycleCheckpoint(checkpoint, decisionState));
}

export function parseAndRestoreDurableTargetLifecycleCheckpoint(
  serialized: string,
  decisionState: DecisionState,
): RestoredLifecycleEvidence {
  const parsed = JSON.parse(serialized) as DurableTargetLifecycleCheckpoint;
  return reconstructActionDecisionFromCheckpoint(parsed, decisionState);
}
