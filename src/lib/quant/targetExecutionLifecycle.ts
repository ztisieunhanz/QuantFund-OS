import {
  CANONICAL_EXECUTION_PLANNER_POLICY,
  createExecutionRebalancePlan,
  executeRebalance,
  isExecutableRebalanceDelta,
  portfolioAccountIdentity,
  validateBoundExecutionRecord,
  validateExecutionPlannerPolicy,
  validateExecutionRebalancePlan,
  type ExecutionContext,
  type ExecutionEngineResult,
  type ExecutionPlannerPolicy,
  type ExecutionRebalancePlan,
  type PortfolioAccountState,
} from "@/lib/quant/executionEngine";
import { validateTargetPortfolioWeightArtifact } from "@/lib/quant/omegaAllocator";
import {
  validateCanonicalPortfolioValuationSnapshot,
  type CanonicalPortfolioValuationSnapshot,
} from "@/lib/quant/portfolioValuation";
import {
  canonicalProducerJson,
  immutableProducerCopy,
  producerIdentity,
} from "@/lib/quant/producerProvenance";
import type { AssetId, PointInTimeBar, ProvenancedTargetPortfolioWeight } from "@/lib/quant/types";
import { BAR_DURATION_MS } from "@/lib/quant/timeDomain";

export const TARGET_EXECUTION_ASSESSMENT_SCHEMA_VERSION = "M14_A04_TARGET_EXECUTION_ASSESSMENT_V1" as const;
export const EXECUTION_BOUND_TARGET_ASSESSMENT_SCHEMA_VERSION = "M14_A04_EXECUTION_BOUND_TARGET_ASSESSMENT_V1" as const;
export const ACTIVE_TARGET_LIFECYCLE_SCHEMA_VERSION = "M14_A04_ACTIVE_TARGET_LIFECYCLE_V1" as const;

// Only artifacts created and deep-frozen by this module enter these sets.
// This avoids repeatedly reconstructing unchanged transient replay evidence;
// arbitrary caller objects and forged clones always take the full validator path.
const trustedTargetAssessments = new WeakSet<object>();
const trustedExecutionAssessments = new WeakSet<object>();
const trustedActiveTargetLifecycles = new WeakSet<object>();

export type AssetExecutionRelation =
  | "SATISFIED_UNDER_EXECUTION_POLICY"
  | "INCREASE_FROM_ZERO"
  | "INCREASE_FROM_POSITIVE"
  | "DECREASE_TO_POSITIVE"
  | "EXIT_TO_ZERO";

export type TargetExecutionAssessmentStatus =
  | "ALREADY_SATISFIED"
  | "REQUIRES_EXECUTABLE_INCREASE"
  | "REQUIRES_EXECUTABLE_DECREASE"
  | "REQUIRES_EXIT_TO_ZERO"
  | "REQUIRES_CANONICAL_REBALANCE";

export interface AssetExecutionAssessment {
  readonly assetId: AssetId;
  readonly currentWeight: number;
  readonly targetWeight: number;
  readonly currentNotionalUsd: number;
  readonly targetNotionalUsd: number;
  readonly deltaNotionalUsd: number;
  readonly relation: AssetExecutionRelation;
  readonly executableUnderPolicy: boolean;
}

export interface TargetExecutionAssessment {
  readonly kind: "TARGET_EXECUTION_ASSESSMENT";
  readonly schemaVersion: typeof TARGET_EXECUTION_ASSESSMENT_SCHEMA_VERSION;
  readonly intendedUse: "DERIVED_EXECUTION_RELATIONSHIP_EVIDENCE_ONLY";
  readonly decisionTime: number;
  readonly valuation: CanonicalPortfolioValuationSnapshot;
  readonly target: ProvenancedTargetPortfolioWeight;
  readonly plannerPolicy: ExecutionPlannerPolicy;
  readonly valuationIdentity: string;
  readonly accountStateIdentity: string;
  readonly targetContentIdentity: string;
  readonly economicTargetContentIdentity: string;
  readonly targetDecisionIdentity: string;
  readonly assetUniverseIdentity: string;
  readonly assetAssessments: readonly AssetExecutionAssessment[];
  readonly status: TargetExecutionAssessmentStatus;
  readonly semanticIdentity: string;
  readonly modifiesTargetWeight: false;
  readonly grantsExecutionAuthority: false;
  readonly grantsAccountingAuthority: false;
  readonly priceAuthority: "NONE_DERIVED_FROM_CANONICAL_VALUATION";
}

export type ExecutionBoundTargetStatus =
  | "SATISFIED_AFTER_CANONICAL_EXECUTION"
  | "PARTIALLY_SATISFIED_EXECUTABLE_RESIDUAL"
  | "OUTSTANDING_UNEXECUTED"
  | "INVALID_UNPROVABLE";

export interface ExecutionBoundTargetAssessment {
  readonly kind: "EXECUTION_BOUND_TARGET_ASSESSMENT";
  readonly schemaVersion: typeof EXECUTION_BOUND_TARGET_ASSESSMENT_SCHEMA_VERSION;
  readonly intendedUse: "POST_FILL_EXECUTION_EVIDENCE_ONLY";
  readonly activeTargetRootIdentity: string;
  readonly target: ProvenancedTargetPortfolioWeight;
  readonly targetDecisionIdentity: string;
  readonly economicTargetContentIdentity: string;
  readonly decisionTime: number;
  readonly executionTime: number;
  readonly executionContext: ExecutionContext;
  readonly executionPriceEvidence: readonly {
    readonly assetId: AssetId;
    readonly timestamp: number;
    readonly priceField: "OPEN";
    readonly price: number;
    readonly volume: number | null;
  }[];
  readonly preExecutionAccount: PortfolioAccountState;
  readonly preExecutionAccountIdentity: string;
  readonly postExecutionValuation: CanonicalPortfolioValuationSnapshot;
  readonly postExecutionAccountIdentity: string;
  readonly preExecutionPlan: ExecutionRebalancePlan;
  readonly postExecutionPlan: ExecutionRebalancePlan;
  readonly executionResult: ExecutionEngineResult;
  readonly executionResultIdentity: string;
  readonly executionRecords: ExecutionEngineResult["records"];
  readonly fillIdentities: readonly string[];
  readonly residualExecutableAssetIds: readonly AssetId[];
  readonly status: ExecutionBoundTargetStatus;
  readonly semanticIdentity: string;
  readonly modifiesTargetWeight: false;
  readonly grantsExecutionAuthority: false;
  readonly grantsAccountingAuthority: false;
}

export type ActiveTargetLifecycleTransition =
  | "ROOT_CREATED"
  | "ROOT_CREATED_AFTER_COMPLETION"
  | "ROOT_REAFFIRMED_UNRESOLVED"
  | "COMPLETED_ROOT_REAFFIRMED"
  | "ROOT_SUPERSEDED_BY_CHANGED_TARGET"
  | "EXECUTION_SATISFIED"
  | "EXECUTION_PARTIALLY_SATISFIED"
  | "EXECUTION_OUTSTANDING"
  | "EXECUTION_INVALID";

export interface ActiveTargetLifecycle {
  readonly kind: "ACTIVE_TARGET_LIFECYCLE";
  readonly schemaVersion: typeof ACTIVE_TARGET_LIFECYCLE_SCHEMA_VERSION;
  readonly intendedUse: "TARGET_LINEAGE_EVIDENCE_ONLY";
  readonly lifecycleStatus: "ACTIVE" | "COMPLETED" | "INVALID";
  readonly transition: ActiveTargetLifecycleTransition;
  readonly activeTargetRootIdentity: string;
  readonly rootEconomicTargetContentIdentity: string;
  readonly rootTargetDecisionIdentity: string;
  readonly rootDecisionTime: number;
  readonly rootAssessment: TargetExecutionAssessment;
  readonly latestTargetDecisionIdentity: string;
  readonly latestDecisionTime: number;
  readonly currentAssessment: TargetExecutionAssessment;
  readonly latestExecutionAssessment: ExecutionBoundTargetAssessment | null;
  readonly predecessorLifecycleIdentity: string | null;
  readonly supersededRootLifecycleIdentity: string | null;
  readonly semanticIdentity: string;
  readonly grantsExecutionAuthority: false;
  readonly grantsAccountingAuthority: false;
  readonly grantsActionDecisionAuthority: false;
}

function relationFor(
  currentNotionalUsd: number,
  targetNotionalUsd: number,
  deltaNotionalUsd: number,
  executableUnderPolicy: boolean,
): AssetExecutionRelation {
  if (!executableUnderPolicy) return "SATISFIED_UNDER_EXECUTION_POLICY";
  if (deltaNotionalUsd > 0) return currentNotionalUsd === 0 ? "INCREASE_FROM_ZERO" : "INCREASE_FROM_POSITIVE";
  return targetNotionalUsd === 0 ? "EXIT_TO_ZERO" : "DECREASE_TO_POSITIVE";
}

function aggregateStatus(items: readonly AssetExecutionAssessment[]): TargetExecutionAssessmentStatus {
  const executable = items.filter((item) => item.executableUnderPolicy);
  if (executable.length === 0) return "ALREADY_SATISFIED";
  if (executable.every((item) => item.relation === "INCREASE_FROM_ZERO" || item.relation === "INCREASE_FROM_POSITIVE")) return "REQUIRES_EXECUTABLE_INCREASE";
  if (executable.every((item) => item.relation === "EXIT_TO_ZERO")) return "REQUIRES_EXIT_TO_ZERO";
  if (executable.every((item) => item.relation === "EXIT_TO_ZERO" || item.relation === "DECREASE_TO_POSITIVE")) return "REQUIRES_EXECUTABLE_DECREASE";
  return "REQUIRES_CANONICAL_REBALANCE";
}

export function economicTargetContentIdentity(target: ProvenancedTargetPortfolioWeight): string {
  validateTargetPortfolioWeightArtifact(target);
  const normalizedAssetWeights = Object.fromEntries(
    Object.entries(target.assetWeights)
      .filter(([, weight]) => weight !== 0)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  return producerIdentity({
    assetWeights: normalizedAssetWeights,
    cashWeight: target.cashWeight,
    grossExposure: target.grossExposure,
    netExposure: target.netExposure,
  });
}

function assessmentMaterial(
  valuation: CanonicalPortfolioValuationSnapshot,
  target: ProvenancedTargetPortfolioWeight,
  plannerPolicy: ExecutionPlannerPolicy,
): Omit<TargetExecutionAssessment, "semanticIdentity"> {
  validateCanonicalPortfolioValuationSnapshot(valuation);
  validateTargetPortfolioWeightArtifact(target);
  validateExecutionPlannerPolicy(plannerPolicy);
  if (valuation.decisionTime !== target.asOfTimestamp) throw new Error("Target/valuation decisionTime mismatch");

  const assetIds = [...new Set([
    ...Object.keys(valuation.assetWeights),
    ...Object.keys(target.assetWeights),
  ])].sort();
  const assetAssessments = assetIds.map((assetId): AssetExecutionAssessment => {
    const currentWeight = valuation.assetWeights[assetId] ?? 0;
    const targetWeight = target.assetWeights[assetId] ?? 0;
    if (![currentWeight, targetWeight].every(Number.isFinite) || currentWeight < 0 || targetWeight < 0) throw new Error(`Invalid long-only execution assessment weight for ${assetId}`);
    const currentNotionalUsd = currentWeight * valuation.nav;
    const targetNotionalUsd = targetWeight * valuation.nav;
    const deltaNotionalUsd = targetNotionalUsd - currentNotionalUsd;
    if (![currentNotionalUsd, targetNotionalUsd, deltaNotionalUsd].every(Number.isFinite)) throw new Error(`Invalid execution assessment notional for ${assetId}`);
    const executableUnderPolicy = isExecutableRebalanceDelta(deltaNotionalUsd, plannerPolicy);
    return {
      assetId,
      currentWeight,
      targetWeight,
      currentNotionalUsd,
      targetNotionalUsd,
      deltaNotionalUsd,
      relation: relationFor(currentNotionalUsd, targetNotionalUsd, deltaNotionalUsd, executableUnderPolicy),
      executableUnderPolicy,
    };
  });

  return {
    kind: "TARGET_EXECUTION_ASSESSMENT",
    schemaVersion: TARGET_EXECUTION_ASSESSMENT_SCHEMA_VERSION,
    intendedUse: "DERIVED_EXECUTION_RELATIONSHIP_EVIDENCE_ONLY",
    decisionTime: valuation.decisionTime,
    valuation,
    target,
    plannerPolicy,
    valuationIdentity: valuation.semanticIdentity,
    accountStateIdentity: valuation.accountStateIdentity,
    targetContentIdentity: target.provenance.targetContentIdentity,
    economicTargetContentIdentity: economicTargetContentIdentity(target),
    targetDecisionIdentity: target.provenance.targetDecisionIdentity,
    assetUniverseIdentity: producerIdentity(assetIds),
    assetAssessments,
    status: aggregateStatus(assetAssessments),
    modifiesTargetWeight: false,
    grantsExecutionAuthority: false,
    grantsAccountingAuthority: false,
    priceAuthority: "NONE_DERIVED_FROM_CANONICAL_VALUATION",
  };
}

export function createTargetExecutionAssessment(input: {
  readonly valuation: CanonicalPortfolioValuationSnapshot;
  readonly target: ProvenancedTargetPortfolioWeight;
  readonly plannerPolicy?: ExecutionPlannerPolicy;
}): TargetExecutionAssessment {
  const material = assessmentMaterial(
    input.valuation,
    input.target,
    input.plannerPolicy ?? CANONICAL_EXECUTION_PLANNER_POLICY,
  );
  const assessment = immutableProducerCopy({ ...material, semanticIdentity: producerIdentity(material) });
  trustedTargetAssessments.add(assessment);
  return assessment;
}

export function validateTargetExecutionAssessment(assessment: TargetExecutionAssessment): void {
  if (trustedTargetAssessments.has(assessment)) return;
  const rebuilt = createTargetExecutionAssessment({
    valuation: assessment.valuation,
    target: assessment.target,
    plannerPolicy: assessment.plannerPolicy,
  });
  if (canonicalProducerJson(rebuilt) !== canonicalProducerJson(assessment)) throw new Error("Target execution assessment identity/content mismatch");
}

export interface ExecutionBoundAssessmentInput {
  readonly activeTargetRootIdentity: string;
  readonly target: ProvenancedTargetPortfolioWeight;
  readonly preExecutionAccount: PortfolioAccountState;
  readonly assetBars: Readonly<Record<AssetId, PointInTimeBar>>;
  readonly context: ExecutionContext;
  readonly executionResult: ExecutionEngineResult;
  readonly postExecutionValuation: CanonicalPortfolioValuationSnapshot;
}

function buildExecutionBoundTargetAssessment(input: ExecutionBoundAssessmentInput): ExecutionBoundTargetAssessment {
  validateTargetPortfolioWeightArtifact(input.target);
  validateCanonicalPortfolioValuationSnapshot(input.postExecutionValuation);
  if (!input.activeTargetRootIdentity) throw new Error("Active target root identity is required for execution assessment");
  if (input.context.executionRule !== "NEXT_BAR_OPEN" || input.context.executionTimestamp !== input.context.decisionTimestamp + BAR_DURATION_MS) throw new Error("Execution assessment requires the canonical next-1H-open boundary");
  if (input.context.decisionTimestamp !== input.target.asOfTimestamp || input.postExecutionValuation.decisionTime !== input.context.executionTimestamp) throw new Error("Execution assessment target/valuation time mismatch");
  if (!input.context.lifecycleBinding
    || input.context.lifecycleBinding.targetDecisionIdentity !== input.target.provenance.targetDecisionIdentity
    || input.context.lifecycleBinding.activeTargetRootIdentity !== input.activeTargetRootIdentity) throw new Error("Execution assessment lifecycle binding mismatch");

  const executionAssetIds = [...new Set([...Object.keys(input.preExecutionAccount.positions), ...Object.keys(input.target.assetWeights)])].sort();
  const executionPriceEvidence = executionAssetIds.flatMap((assetId) => {
    const bar = input.assetBars[assetId];
    return bar ? [{
      assetId,
      timestamp: bar.timestamp,
      priceField: "OPEN" as const,
      price: bar.open,
      volume: input.context.slippageConfig.type === "FIXED_BPS" ? null : bar.volume,
    }] : [];
  });
  const canonicalExecutionBars: Readonly<Record<AssetId, PointInTimeBar>> = Object.fromEntries(
    executionPriceEvidence.map((evidence) => [evidence.assetId, {
      timestamp: evidence.timestamp,
      open: evidence.price,
      high: evidence.price,
      low: evidence.price,
      close: evidence.price,
      volume: evidence.volume ?? 0,
    }]),
  );

  const reconstructedResult = executeRebalance(input.preExecutionAccount, input.target, canonicalExecutionBars, input.context);
  if (canonicalProducerJson(reconstructedResult) !== canonicalProducerJson(input.executionResult)) throw new Error("Execution result does not reconstruct from canonical execution inputs");
  if (canonicalProducerJson(input.executionResult.updatedAccount) !== canonicalProducerJson(input.postExecutionValuation.accountState)) throw new Error("Post-execution valuation/account mismatch");

  const preExecutionPlan = createExecutionRebalancePlan(input.preExecutionAccount, input.target, canonicalExecutionBars, input.context);
  const postExecutionPlan = createExecutionRebalancePlan(input.executionResult.updatedAccount, input.target, canonicalExecutionBars, input.context);
  validateExecutionRebalancePlan(preExecutionPlan);
  validateExecutionRebalancePlan(postExecutionPlan);
  const executionBarsPitEligible = [...new Set([...Object.keys(input.preExecutionAccount.positions), ...Object.keys(input.target.assetWeights)])]
    .every((assetId) => {
      const planAsset = preExecutionPlan.assets.find((asset) => asset.assetId === assetId);
      if (!planAsset || planAsset.basePrice === null) return planAsset?.status === "SATISFIED_UNDER_POLICY";
      return canonicalExecutionBars[assetId]?.timestamp === input.context.executionTimestamp;
    });

  for (const record of input.executionResult.records) {
    validateBoundExecutionRecord({
      record,
      targetDecisionIdentity: input.target.provenance.targetDecisionIdentity,
      activeTargetRootIdentity: input.activeTargetRootIdentity,
      preExecutionAccountIdentity: preExecutionPlan.accountIdentity,
      executionPlanIdentity: preExecutionPlan.semanticIdentity,
    });
  }

  const residualExecutableAssetIds = postExecutionPlan.assets
    .filter((asset) => asset.status === "EXECUTABLE")
    .map((asset) => asset.assetId);
  const executionInputsPitEligible = input.context.slippageConfig.type === "FIXED_BPS";
  const provable = preExecutionPlan.provable && postExecutionPlan.provable && executionBarsPitEligible && executionInputsPitEligible;
  const status: ExecutionBoundTargetStatus = !provable
    ? "INVALID_UNPROVABLE"
    : residualExecutableAssetIds.length === 0
      ? "SATISFIED_AFTER_CANONICAL_EXECUTION"
      : input.executionResult.records.length > 0
        ? "PARTIALLY_SATISFIED_EXECUTABLE_RESIDUAL"
        : "OUTSTANDING_UNEXECUTED";
  const preExecutionAccountIdentity = portfolioAccountIdentity(input.preExecutionAccount);
  const postExecutionAccountIdentity = portfolioAccountIdentity(input.executionResult.updatedAccount);
  const executionResultIdentity = producerIdentity(input.executionResult);
  const material = {
    kind: "EXECUTION_BOUND_TARGET_ASSESSMENT" as const,
    schemaVersion: EXECUTION_BOUND_TARGET_ASSESSMENT_SCHEMA_VERSION,
    intendedUse: "POST_FILL_EXECUTION_EVIDENCE_ONLY" as const,
    activeTargetRootIdentity: input.activeTargetRootIdentity,
    target: input.target,
    targetDecisionIdentity: input.target.provenance.targetDecisionIdentity,
    economicTargetContentIdentity: economicTargetContentIdentity(input.target),
    decisionTime: input.context.decisionTimestamp,
    executionTime: input.context.executionTimestamp,
    executionContext: input.context,
    executionPriceEvidence,
    preExecutionAccount: input.preExecutionAccount,
    preExecutionAccountIdentity,
    postExecutionValuation: input.postExecutionValuation,
    postExecutionAccountIdentity,
    preExecutionPlan,
    postExecutionPlan,
    executionResult: input.executionResult,
    executionResultIdentity,
    executionRecords: input.executionResult.records,
    fillIdentities: input.executionResult.records.map((record) => record.lifecycleBinding!.fillIdentity),
    residualExecutableAssetIds,
    status,
    modifiesTargetWeight: false as const,
    grantsExecutionAuthority: false as const,
    grantsAccountingAuthority: false as const,
  };
  return immutableProducerCopy({ ...material, semanticIdentity: producerIdentity(material) });
}

export function createExecutionBoundTargetAssessment(input: ExecutionBoundAssessmentInput): ExecutionBoundTargetAssessment {
  const assessment = buildExecutionBoundTargetAssessment(input);
  trustedExecutionAssessments.add(assessment);
  return assessment;
}

export function validateExecutionBoundTargetAssessment(
  assessment: ExecutionBoundTargetAssessment,
): void {
  if (trustedExecutionAssessments.has(assessment)) return;
  const assetBars: Readonly<Record<AssetId, PointInTimeBar>> = Object.fromEntries(
    assessment.executionPriceEvidence.map((evidence) => [evidence.assetId, {
      timestamp: evidence.timestamp,
      open: evidence.price,
      high: evidence.price,
      low: evidence.price,
      close: evidence.price,
      volume: evidence.volume ?? 0,
    }]),
  );
  const rebuilt = buildExecutionBoundTargetAssessment({
    activeTargetRootIdentity: assessment.activeTargetRootIdentity,
    target: assessment.target,
    preExecutionAccount: assessment.preExecutionAccount,
    assetBars,
    context: assessment.executionContext,
    executionResult: assessment.executionResult,
    postExecutionValuation: assessment.postExecutionValuation,
  });
  if (canonicalProducerJson(rebuilt) !== canonicalProducerJson(assessment)) throw new Error("Execution-bound target assessment identity/content mismatch");
}

function activeRootIdentity(assessment: TargetExecutionAssessment): string {
  return producerIdentity({
    schemaVersion: ACTIVE_TARGET_LIFECYCLE_SCHEMA_VERSION,
    economicTargetContentIdentity: assessment.economicTargetContentIdentity,
    targetDecisionIdentity: assessment.targetDecisionIdentity,
    decisionTime: assessment.decisionTime,
    assessmentIdentity: assessment.semanticIdentity,
  });
}

function validateExecutionAssessmentArtifact(assessment: ExecutionBoundTargetAssessment): void {
  if (assessment.kind !== "EXECUTION_BOUND_TARGET_ASSESSMENT"
    || assessment.schemaVersion !== EXECUTION_BOUND_TARGET_ASSESSMENT_SCHEMA_VERSION
    || assessment.intendedUse !== "POST_FILL_EXECUTION_EVIDENCE_ONLY"
    || assessment.modifiesTargetWeight !== false
    || assessment.grantsExecutionAuthority !== false
    || assessment.grantsAccountingAuthority !== false) throw new Error("Invalid execution-bound target assessment contract");
  validateExecutionBoundTargetAssessment(assessment);
}

function lifecycleMaterial(input: Omit<ActiveTargetLifecycle, "semanticIdentity">): Omit<ActiveTargetLifecycle, "semanticIdentity"> {
  const transitions: readonly ActiveTargetLifecycleTransition[] = [
    "ROOT_CREATED",
    "ROOT_CREATED_AFTER_COMPLETION",
    "ROOT_REAFFIRMED_UNRESOLVED",
    "COMPLETED_ROOT_REAFFIRMED",
    "ROOT_SUPERSEDED_BY_CHANGED_TARGET",
    "EXECUTION_SATISFIED",
    "EXECUTION_PARTIALLY_SATISFIED",
    "EXECUTION_OUTSTANDING",
    "EXECUTION_INVALID",
  ];
  if (!transitions.includes(input.transition)) throw new Error("Invalid active target lifecycle transition");
  if (input.grantsExecutionAuthority !== false || input.grantsAccountingAuthority !== false || input.grantsActionDecisionAuthority !== false) throw new Error("Active target lifecycle cannot grant authority");
  validateTargetExecutionAssessment(input.rootAssessment);
  validateTargetExecutionAssessment(input.currentAssessment);
  if (input.activeTargetRootIdentity !== activeRootIdentity(input.rootAssessment)
    || input.rootEconomicTargetContentIdentity !== input.rootAssessment.economicTargetContentIdentity
    || input.rootTargetDecisionIdentity !== input.rootAssessment.targetDecisionIdentity
    || input.rootDecisionTime !== input.rootAssessment.decisionTime) throw new Error("Active target root binding mismatch");
  if (input.latestTargetDecisionIdentity !== input.currentAssessment.targetDecisionIdentity
    || input.latestDecisionTime !== input.currentAssessment.decisionTime) throw new Error("Active target latest binding mismatch");
  if (input.latestExecutionAssessment) {
    validateExecutionAssessmentArtifact(input.latestExecutionAssessment);
    if (input.latestExecutionAssessment.activeTargetRootIdentity !== input.activeTargetRootIdentity
      || input.latestExecutionAssessment.economicTargetContentIdentity !== input.rootEconomicTargetContentIdentity) throw new Error("Execution assessment/root binding mismatch");
    if (input.latestExecutionAssessment.decisionTime < input.rootDecisionTime
      || input.latestExecutionAssessment.decisionTime > input.latestDecisionTime) throw new Error("Execution assessment lifecycle time mismatch");
  }
  const executionTransition = input.transition.startsWith("EXECUTION_");
  if (executionTransition) {
    if (!input.latestExecutionAssessment) throw new Error("Execution lifecycle transition requires execution evidence");
    if (input.latestExecutionAssessment.targetDecisionIdentity !== input.currentAssessment.targetDecisionIdentity) throw new Error("Execution assessment/current target binding mismatch");
    const expected = input.latestExecutionAssessment.status === "SATISFIED_AFTER_CANONICAL_EXECUTION"
      ? ["EXECUTION_SATISFIED", "COMPLETED"]
      : input.latestExecutionAssessment.status === "PARTIALLY_SATISFIED_EXECUTABLE_RESIDUAL"
        ? ["EXECUTION_PARTIALLY_SATISFIED", "ACTIVE"]
        : input.latestExecutionAssessment.status === "OUTSTANDING_UNEXECUTED"
          ? ["EXECUTION_OUTSTANDING", "ACTIVE"]
          : ["EXECUTION_INVALID", "INVALID"];
    if (input.transition !== expected[0] || input.lifecycleStatus !== expected[1]) throw new Error("Execution assessment/lifecycle status mismatch");
  } else if (input.latestExecutionAssessment
    && input.latestExecutionAssessment.executionTime > input.latestDecisionTime) {
    throw new Error("Retained execution assessment cannot postdate the current lifecycle decision");
  }
  if (input.transition === "ROOT_CREATED" && (input.lifecycleStatus !== "ACTIVE" || input.predecessorLifecycleIdentity !== null || input.supersededRootLifecycleIdentity !== null || input.latestExecutionAssessment !== null || input.rootAssessment.semanticIdentity !== input.currentAssessment.semanticIdentity)) throw new Error("Invalid new-root lineage");
  if (input.transition === "ROOT_CREATED_AFTER_COMPLETION" && (input.lifecycleStatus !== "ACTIVE" || !input.predecessorLifecycleIdentity || input.supersededRootLifecycleIdentity !== null || input.latestExecutionAssessment !== null || input.rootAssessment.semanticIdentity !== input.currentAssessment.semanticIdentity)) throw new Error("Invalid post-completion root lineage");
  if (input.transition === "ROOT_SUPERSEDED_BY_CHANGED_TARGET" && (input.lifecycleStatus !== "ACTIVE" || !input.predecessorLifecycleIdentity || !input.supersededRootLifecycleIdentity || input.latestExecutionAssessment !== null || input.rootAssessment.semanticIdentity !== input.currentAssessment.semanticIdentity)) throw new Error("Invalid superseding-root lineage");
  if (["ROOT_REAFFIRMED_UNRESOLVED", "COMPLETED_ROOT_REAFFIRMED"].includes(input.transition)) {
    if (!input.predecessorLifecycleIdentity || input.supersededRootLifecycleIdentity !== null || input.rootEconomicTargetContentIdentity !== input.currentAssessment.economicTargetContentIdentity) throw new Error("Invalid same-root lineage");
    if (input.transition === "ROOT_REAFFIRMED_UNRESOLVED" && input.lifecycleStatus !== "ACTIVE") throw new Error("Unresolved root must remain active");
    if (input.transition === "COMPLETED_ROOT_REAFFIRMED" && input.lifecycleStatus !== "COMPLETED") throw new Error("Completed root reaffirmation must remain completed");
  }
  return input;
}

function buildLifecycle(
  material: Omit<ActiveTargetLifecycle, "semanticIdentity">,
  inputsAlreadyValidated = false,
): ActiveTargetLifecycle {
  const validated = inputsAlreadyValidated ? material : lifecycleMaterial(material);
  const semanticIdentity = activeTargetLifecycleSemanticIdentity(validated);
  const lifecycle = inputsAlreadyValidated
    ? Object.freeze({ ...validated, semanticIdentity })
    : immutableProducerCopy({ ...validated, semanticIdentity });
  trustedActiveTargetLifecycles.add(lifecycle);
  return lifecycle;
}

export function activeTargetLifecycleSemanticIdentity(
  material: Omit<ActiveTargetLifecycle, "semanticIdentity">,
): string {
  const {
    rootAssessment,
    currentAssessment,
    latestExecutionAssessment,
    ...outerMaterial
  } = material;
  return producerIdentity({
    ...outerMaterial,
    rootAssessmentIdentity: rootAssessment.semanticIdentity,
    currentAssessmentIdentity: currentAssessment.semanticIdentity,
    latestExecutionAssessmentIdentity: latestExecutionAssessment?.semanticIdentity ?? null,
  });
}

function rootLifecycleMaterial(assessment: TargetExecutionAssessment, input: {
  readonly transition: "ROOT_CREATED" | "ROOT_CREATED_AFTER_COMPLETION" | "ROOT_SUPERSEDED_BY_CHANGED_TARGET";
  readonly predecessorLifecycleIdentity: string | null;
  readonly supersededRootLifecycleIdentity: string | null;
}): Omit<ActiveTargetLifecycle, "semanticIdentity"> {
  return {
    kind: "ACTIVE_TARGET_LIFECYCLE",
    schemaVersion: ACTIVE_TARGET_LIFECYCLE_SCHEMA_VERSION,
    intendedUse: "TARGET_LINEAGE_EVIDENCE_ONLY",
    lifecycleStatus: "ACTIVE",
    transition: input.transition,
    activeTargetRootIdentity: activeRootIdentity(assessment),
    rootEconomicTargetContentIdentity: assessment.economicTargetContentIdentity,
    rootTargetDecisionIdentity: assessment.targetDecisionIdentity,
    rootDecisionTime: assessment.decisionTime,
    rootAssessment: assessment,
    latestTargetDecisionIdentity: assessment.targetDecisionIdentity,
    latestDecisionTime: assessment.decisionTime,
    currentAssessment: assessment,
    latestExecutionAssessment: null,
    predecessorLifecycleIdentity: input.predecessorLifecycleIdentity,
    supersededRootLifecycleIdentity: input.supersededRootLifecycleIdentity,
    grantsExecutionAuthority: false,
    grantsAccountingAuthority: false,
    grantsActionDecisionAuthority: false,
  };
}

export function createActiveTargetLifecycleRoot(assessment: TargetExecutionAssessment): ActiveTargetLifecycle {
  validateTargetExecutionAssessment(assessment);
  return buildLifecycle(rootLifecycleMaterial(assessment, { transition: "ROOT_CREATED", predecessorLifecycleIdentity: null, supersededRootLifecycleIdentity: null }), true);
}

export function advanceActiveTargetLifecycle(prior: ActiveTargetLifecycle, assessment: TargetExecutionAssessment): ActiveTargetLifecycle {
  validateActiveTargetLifecycle(prior);
  validateTargetExecutionAssessment(assessment);
  if (prior.lifecycleStatus === "INVALID") throw new Error("Invalid active target lineage cannot be advanced");
  if (assessment.decisionTime <= prior.latestDecisionTime) throw new Error("Active target lineage decisionTime must increase strictly");
  const sameEconomicTarget = assessment.economicTargetContentIdentity === prior.rootEconomicTargetContentIdentity;
  if (!sameEconomicTarget) {
    return buildLifecycle(rootLifecycleMaterial(assessment, { transition: "ROOT_SUPERSEDED_BY_CHANGED_TARGET", predecessorLifecycleIdentity: prior.semanticIdentity, supersededRootLifecycleIdentity: prior.semanticIdentity }), true);
  }
  if (prior.lifecycleStatus === "COMPLETED" && assessment.status !== "ALREADY_SATISFIED") {
    return buildLifecycle(rootLifecycleMaterial(assessment, { transition: "ROOT_CREATED_AFTER_COMPLETION", predecessorLifecycleIdentity: prior.semanticIdentity, supersededRootLifecycleIdentity: null }), true);
  }
  return buildLifecycle({
    kind: "ACTIVE_TARGET_LIFECYCLE",
    schemaVersion: ACTIVE_TARGET_LIFECYCLE_SCHEMA_VERSION,
    intendedUse: "TARGET_LINEAGE_EVIDENCE_ONLY",
    lifecycleStatus: prior.lifecycleStatus,
    transition: prior.lifecycleStatus === "COMPLETED" ? "COMPLETED_ROOT_REAFFIRMED" : "ROOT_REAFFIRMED_UNRESOLVED",
    activeTargetRootIdentity: prior.activeTargetRootIdentity,
    rootEconomicTargetContentIdentity: prior.rootEconomicTargetContentIdentity,
    rootTargetDecisionIdentity: prior.rootTargetDecisionIdentity,
    rootDecisionTime: prior.rootDecisionTime,
    rootAssessment: prior.rootAssessment,
    latestTargetDecisionIdentity: assessment.targetDecisionIdentity,
    latestDecisionTime: assessment.decisionTime,
    currentAssessment: assessment,
    latestExecutionAssessment: prior.latestExecutionAssessment,
    predecessorLifecycleIdentity: prior.semanticIdentity,
    supersededRootLifecycleIdentity: null,
    grantsExecutionAuthority: false,
    grantsAccountingAuthority: false,
    grantsActionDecisionAuthority: false,
  }, true);
}

export function reconcileActiveTargetLifecycleExecution(
  prior: ActiveTargetLifecycle,
  assessment: ExecutionBoundTargetAssessment,
): ActiveTargetLifecycle {
  validateActiveTargetLifecycle(prior);
  validateExecutionBoundTargetAssessment(assessment);
  if (prior.lifecycleStatus === "INVALID") throw new Error("Invalid active target lineage cannot be reconciled");
  if (assessment.activeTargetRootIdentity !== prior.activeTargetRootIdentity
    || assessment.targetDecisionIdentity !== prior.latestTargetDecisionIdentity
    || assessment.economicTargetContentIdentity !== prior.rootEconomicTargetContentIdentity) throw new Error("Execution assessment does not bind the active target root");
  const transition: ActiveTargetLifecycleTransition = assessment.status === "SATISFIED_AFTER_CANONICAL_EXECUTION"
    ? "EXECUTION_SATISFIED"
    : assessment.status === "PARTIALLY_SATISFIED_EXECUTABLE_RESIDUAL"
      ? "EXECUTION_PARTIALLY_SATISFIED"
      : assessment.status === "OUTSTANDING_UNEXECUTED"
        ? "EXECUTION_OUTSTANDING"
        : "EXECUTION_INVALID";
  const lifecycleStatus = assessment.status === "SATISFIED_AFTER_CANONICAL_EXECUTION"
    ? "COMPLETED" as const
    : assessment.status === "INVALID_UNPROVABLE"
      ? "INVALID" as const
      : "ACTIVE" as const;
  const { semanticIdentity: _priorIdentity, ...priorMaterial } = prior;
  return buildLifecycle({
    ...priorMaterial,
    lifecycleStatus,
    transition,
    latestExecutionAssessment: assessment,
    predecessorLifecycleIdentity: prior.semanticIdentity,
    supersededRootLifecycleIdentity: null,
  }, true);
}

export function validateActiveTargetLifecycle(lifecycle: ActiveTargetLifecycle): void {
  if (trustedActiveTargetLifecycles.has(lifecycle)) return;
  if (lifecycle.schemaVersion !== ACTIVE_TARGET_LIFECYCLE_SCHEMA_VERSION || lifecycle.kind !== "ACTIVE_TARGET_LIFECYCLE" || lifecycle.intendedUse !== "TARGET_LINEAGE_EVIDENCE_ONLY") throw new Error("Invalid active target lifecycle contract");
  const { semanticIdentity, ...material } = lifecycle;
  lifecycleMaterial(material);
  const expectedIdentity = activeTargetLifecycleSemanticIdentity(material);
  if (semanticIdentity !== expectedIdentity) throw new Error("Active target lifecycle identity/content mismatch");
}

export function validateActiveTargetLifecycleAgainstPrior(
  lifecycle: ActiveTargetLifecycle,
  prior: ActiveTargetLifecycle,
): void {
  validateActiveTargetLifecycle(lifecycle);
  const rebuilt = lifecycle.transition.startsWith("EXECUTION_")
    ? lifecycle.latestExecutionAssessment
      ? reconcileActiveTargetLifecycleExecution(prior, lifecycle.latestExecutionAssessment)
      : (() => { throw new Error("Execution lineage validation requires canonical execution evidence"); })()
    : advanceActiveTargetLifecycle(prior, lifecycle.currentAssessment);
  if (canonicalProducerJson(rebuilt) !== canonicalProducerJson(lifecycle)) throw new Error("Active target lifecycle prior-lineage mismatch");
}
