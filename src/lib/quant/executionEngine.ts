// ============================================================================
// FILE: src/lib/quant/executionEngine.ts
// MODULE: DETERMINISTIC REBALANCE & POSITION ACCOUNTING SIMULATOR
// ============================================================================

import type {
  AssetId,
  ExecutionRecord,
  ExecutionRecordLifecycleBinding,
  ExecutionRule,
  OrderSide,
  PointInTimeBar,
  PositionRecord,
  SlippageModelConfig,
  TargetPortfolioWeight,
} from "@/lib/quant/types";
import { canonicalProducerJson, immutableProducerCopy, producerIdentity } from "@/lib/quant/producerProvenance";

export const EXECUTION_PLANNER_POLICY_SCHEMA_VERSION = "M14_A04_EXECUTION_PLANNER_POLICY_V1" as const;
export const DEFAULT_MIN_REBALANCE_THRESHOLD_USD = 50;

export interface ExecutionPlannerPolicy {
  readonly schemaVersion: typeof EXECUTION_PLANNER_POLICY_SCHEMA_VERSION;
  readonly minimumRebalanceThresholdUsd: number;
  readonly comparison: "ABSOLUTE_DELTA_NOTIONAL_GTE_THRESHOLD";
  readonly longOnly: true;
  readonly policyIdentity: string;
}

function buildExecutionPlannerPolicy(minimumRebalanceThresholdUsd: number): ExecutionPlannerPolicy {
  if (!Number.isFinite(minimumRebalanceThresholdUsd) || minimumRebalanceThresholdUsd < 0) throw new Error("Execution minimum rebalance threshold must be finite and non-negative");
  const material = {
    schemaVersion: EXECUTION_PLANNER_POLICY_SCHEMA_VERSION,
    minimumRebalanceThresholdUsd,
    comparison: "ABSOLUTE_DELTA_NOTIONAL_GTE_THRESHOLD" as const,
    longOnly: true as const,
  };
  return immutableProducerCopy({ ...material, policyIdentity: producerIdentity(material) });
}

export const CANONICAL_EXECUTION_PLANNER_POLICY = buildExecutionPlannerPolicy(DEFAULT_MIN_REBALANCE_THRESHOLD_USD);

export function resolveExecutionPlannerPolicy(minimumRebalanceThresholdUsd = DEFAULT_MIN_REBALANCE_THRESHOLD_USD): ExecutionPlannerPolicy {
  return buildExecutionPlannerPolicy(minimumRebalanceThresholdUsd);
}

export function validateExecutionPlannerPolicy(policy: ExecutionPlannerPolicy): void {
  const rebuilt = buildExecutionPlannerPolicy(policy.minimumRebalanceThresholdUsd);
  if (producerIdentity(policy) !== producerIdentity(rebuilt)) throw new Error("Execution planner policy identity/content mismatch");
}

export function isExecutableRebalanceDelta(deltaNotionalUsd: number, policy: ExecutionPlannerPolicy): boolean {
  validateExecutionPlannerPolicy(policy);
  if (!Number.isFinite(deltaNotionalUsd)) throw new Error("Execution delta notional must be finite");
  return deltaNotionalUsd !== 0 && Math.abs(deltaNotionalUsd) >= policy.minimumRebalanceThresholdUsd;
}

export interface ExecutionLifecycleBindingInput {
  readonly targetDecisionIdentity: string;
  readonly activeTargetRootIdentity: string;
}

export interface ExecutionContext {
  readonly decisionTimestamp: number;
  readonly executionTimestamp: number;
  readonly executionRule: ExecutionRule;
  readonly commissionRate: number;
  readonly slippageConfig: SlippageModelConfig;
  readonly minRebalanceThresholdUsd?: number;
  readonly lifecycleBinding?: ExecutionLifecycleBindingInput;
}

export interface PortfolioAccountState {
  readonly cash: number;
  readonly positions: Readonly<Record<AssetId, PositionRecord>>;
}

export interface ExecutionEngineResult {
  readonly updatedAccount: PortfolioAccountState;
  readonly records: readonly ExecutionRecord[];
  readonly totalFeesUsd: number;
  readonly totalSlippageCostUsd: number;
  readonly netCashFlowUsd: number;
}

export type ExecutionPlanAssetStatus =
  | "SATISFIED_UNDER_POLICY"
  | "EXECUTABLE"
  | "UNPROVABLE_MISSING_PRICE"
  | "UNPROVABLE_INVALID_PRICE"
  | "UNPROVABLE_ACCOUNT_NAV";

export interface ExecutionPlanAsset {
  readonly assetId: AssetId;
  readonly status: ExecutionPlanAssetStatus;
  readonly side: OrderSide | null;
  readonly basePrice: number | null;
  readonly currentNotionalUsd: number | null;
  readonly targetNotionalUsd: number | null;
  readonly deltaNotionalUsd: number | null;
  readonly targetUnitsDelta: number | null;
}

export interface ExecutionRebalancePlan {
  readonly schemaVersion: "M14_A04_EXECUTION_REBALANCE_PLAN_V1";
  readonly intendedUse: "CANONICAL_EXECUTION_PLANNING_EVIDENCE";
  readonly decisionTimestamp: number;
  readonly executionTimestamp: number;
  readonly executionRule: ExecutionRule;
  readonly accountIdentity: string;
  readonly targetArtifactIdentity: string;
  readonly targetDecisionIdentity: string | null;
  readonly plannerPolicy: ExecutionPlannerPolicy;
  readonly currentNav: number | null;
  readonly assets: readonly ExecutionPlanAsset[];
  readonly provable: boolean;
  readonly semanticIdentity: string;
}

export function portfolioAccountIdentity(account: PortfolioAccountState): string {
  return producerIdentity({ schemaVersion: "M14_A04_PORTFOLIO_ACCOUNT_IDENTITY_V1", account });
}

function executionBasePrice(bar: PointInTimeBar, rule: ExecutionRule): number {
  return rule === "NEXT_BAR_OPEN" ? bar.open : bar.close;
}

export function createExecutionRebalancePlan(
  account: PortfolioAccountState,
  targetWeights: TargetPortfolioWeight,
  assetBars: Readonly<Record<AssetId, PointInTimeBar>>,
  context: ExecutionContext,
): ExecutionRebalancePlan {
  const plannerPolicy = resolveExecutionPlannerPolicy(context.minRebalanceThresholdUsd);
  const accountIdentity = portfolioAccountIdentity(account);
  let currentNav = account.cash;
  let navProvable = Number.isFinite(currentNav) && currentNav >= 0;
  for (const [assetId, position] of Object.entries(account.positions)) {
    if (position.quantity <= 0) continue;
    const bar = assetBars[assetId];
    const price = bar ? executionBasePrice(bar, context.executionRule) : Number.NaN;
    if (!bar || !Number.isFinite(price) || price <= 0 || !Number.isFinite(position.quantity)) continue;
    currentNav += position.quantity * price;
  }
  if (!Number.isFinite(currentNav) || currentNav <= 0) navProvable = false;

  const allAssetIds = [...new Set([...Object.keys(account.positions), ...Object.keys(targetWeights.assetWeights)])].sort();
  const assets = allAssetIds.map((assetId): ExecutionPlanAsset => {
    const currentUnits = account.positions[assetId]?.quantity ?? 0;
    const targetWeight = Math.max(0, targetWeights.assetWeights[assetId] ?? 0);
    if (!navProvable) return { assetId, status: "UNPROVABLE_ACCOUNT_NAV", side: null, basePrice: null, currentNotionalUsd: null, targetNotionalUsd: null, deltaNotionalUsd: null, targetUnitsDelta: null };
    if (currentUnits === 0 && targetWeight === 0) return { assetId, status: "SATISFIED_UNDER_POLICY", side: null, basePrice: null, currentNotionalUsd: 0, targetNotionalUsd: 0, deltaNotionalUsd: 0, targetUnitsDelta: 0 };
    const bar = assetBars[assetId];
    if (!bar) return { assetId, status: "UNPROVABLE_MISSING_PRICE", side: null, basePrice: null, currentNotionalUsd: null, targetNotionalUsd: null, deltaNotionalUsd: null, targetUnitsDelta: null };
    const basePrice = executionBasePrice(bar, context.executionRule);
    if (!Number.isFinite(basePrice) || basePrice <= 0) return { assetId, status: "UNPROVABLE_INVALID_PRICE", side: null, basePrice, currentNotionalUsd: null, targetNotionalUsd: null, deltaNotionalUsd: null, targetUnitsDelta: null };
    const currentNotionalUsd = currentUnits * basePrice;
    const targetNotionalUsd = targetWeight * currentNav;
    const deltaNotionalUsd = targetNotionalUsd - currentNotionalUsd;
    const executable = isExecutableRebalanceDelta(deltaNotionalUsd, plannerPolicy);
    return {
      assetId,
      status: executable ? "EXECUTABLE" : "SATISFIED_UNDER_POLICY",
      side: executable ? (deltaNotionalUsd > 0 ? "BUY" : "SELL") : null,
      basePrice,
      currentNotionalUsd,
      targetNotionalUsd,
      deltaNotionalUsd,
      targetUnitsDelta: executable ? Math.abs(deltaNotionalUsd) / basePrice : 0,
    };
  });
  const material = {
    schemaVersion: "M14_A04_EXECUTION_REBALANCE_PLAN_V1" as const,
    intendedUse: "CANONICAL_EXECUTION_PLANNING_EVIDENCE" as const,
    decisionTimestamp: context.decisionTimestamp,
    executionTimestamp: context.executionTimestamp,
    executionRule: context.executionRule,
    accountIdentity,
    targetArtifactIdentity: producerIdentity(targetWeights),
    targetDecisionIdentity: targetWeights.provenance?.targetDecisionIdentity ?? null,
    plannerPolicy,
    currentNav: navProvable ? currentNav : null,
    assets,
    provable: navProvable && assets.every((asset) => !asset.status.startsWith("UNPROVABLE_")),
  };
  return immutableProducerCopy({ ...material, semanticIdentity: producerIdentity(material) });
}

export function validateExecutionRebalancePlan(plan: ExecutionRebalancePlan): void {
  if (plan.schemaVersion !== "M14_A04_EXECUTION_REBALANCE_PLAN_V1" || plan.intendedUse !== "CANONICAL_EXECUTION_PLANNING_EVIDENCE") throw new Error("Invalid execution rebalance plan contract");
  const { semanticIdentity, ...material } = plan;
  validateExecutionPlannerPolicy(plan.plannerPolicy);
  if (semanticIdentity !== producerIdentity(material)) throw new Error("Execution rebalance plan identity/content mismatch");
}

export function validateBoundExecutionRecord(input: {
  readonly record: ExecutionRecord;
  readonly targetDecisionIdentity: string;
  readonly activeTargetRootIdentity: string;
  readonly preExecutionAccountIdentity: string;
  readonly executionPlanIdentity: string;
}): void {
  const { lifecycleBinding, ...recordMaterial } = input.record;
  if (!lifecycleBinding || lifecycleBinding.schemaVersion !== "M14_A04_EXECUTION_RECORD_LIFECYCLE_BINDING_V1") throw new Error("Execution record lacks canonical lifecycle binding");
  const bindingMaterial = {
    schemaVersion: lifecycleBinding.schemaVersion,
    targetDecisionIdentity: input.targetDecisionIdentity,
    activeTargetRootIdentity: input.activeTargetRootIdentity,
    preExecutionAccountIdentity: input.preExecutionAccountIdentity,
    executionPlanIdentity: input.executionPlanIdentity,
  };
  const expected = { ...bindingMaterial, fillIdentity: producerIdentity({ record: recordMaterial, binding: bindingMaterial }) };
  if (canonicalProducerJson(lifecycleBinding) !== canonicalProducerJson(expected)) throw new Error("Execution record lifecycle binding mismatch");
}

interface PriceImpactResult {
  readonly executionPrice: number;
  readonly slippageBps: number;
  readonly slippageCostUsd: number;
}

function calculatePriceImpact(
  basePrice: number,
  side: OrderSide,
  quantity: number,
  barVolume: number,
  config: SlippageModelConfig
): PriceImpactResult {
  if (basePrice <= 0 || quantity <= 0) {
    return { executionPrice: basePrice, slippageBps: 0, slippageCostUsd: 0 };
  }

  let effectiveBps = Math.max(0, config.baseBps);

  if (config.type === "VOLUME_SHARE_IMPACT" && barVolume > 0) {
    const impactCoeff = config.impactFactor ?? 0.1;
    const volumeShare = Math.min(1.0, quantity / barVolume);
    effectiveBps += impactCoeff * Math.sqrt(volumeShare) * 10000;
  } else if (config.type === "LINEAR_SLIPPAGE" && barVolume > 0) {
    const impactCoeff = config.impactFactor ?? 0.05;
    const volumeShare = Math.min(1.0, quantity / barVolume);
    effectiveBps += impactCoeff * volumeShare * 10000;
  }

  const slippageFactor = effectiveBps / 10000;
  const slippagePerUnit = basePrice * slippageFactor;
  const executionPrice = side === "BUY" ? basePrice + slippagePerUnit : Math.max(0.0001, basePrice - slippagePerUnit);

  return {
    executionPrice,
    slippageBps: effectiveBps,
    slippageCostUsd: quantity * slippagePerUnit,
  };
}

interface OrderIntent {
  readonly assetId: AssetId;
  readonly side: OrderSide;
  readonly targetUnitsDelta: number;
  readonly notionalUsd: number;
}

export function executeRebalance(
  currentAccount: PortfolioAccountState,
  targetWeights: TargetPortfolioWeight,
  assetBars: Readonly<Record<AssetId, PointInTimeBar>>,
  context: ExecutionContext
): ExecutionEngineResult {
  const preExecutionPlan = createExecutionRebalancePlan(currentAccount, targetWeights, assetBars, context);
  if (context.lifecycleBinding) {
    if (!targetWeights.provenance || targetWeights.provenance.targetDecisionIdentity !== context.lifecycleBinding.targetDecisionIdentity) throw new Error("Execution lifecycle target decision identity mismatch");
    if (!context.lifecycleBinding.activeTargetRootIdentity) throw new Error("Execution active target root identity is required");
  }
  const currentPositions = { ...currentAccount.positions };
  let cash = currentAccount.cash;
  const rawIntents: OrderIntent[] = preExecutionPlan.assets
    .filter((asset) => asset.status === "EXECUTABLE")
    .map((asset) => ({
      assetId: asset.assetId,
      side: asset.side!,
      targetUnitsDelta: asset.targetUnitsDelta!,
      notionalUsd: Math.abs(asset.deltaNotionalUsd!),
    }));

  // 3. DETERMINISTIC SORT KEY: Bán trước, Mua sau. 
  // Đối với nhiều lệnh Mua: ưu tiên Notional lớn nhất, sau đó đến thứ tự bảng chữ cái của AssetId
  const sortedIntents = [...rawIntents].sort((a, b) => {
    if (a.side === "SELL" && b.side === "BUY") return -1;
    if (a.side === "BUY" && b.side === "SELL") return 1;
    if (b.notionalUsd !== a.notionalUsd) return b.notionalUsd - a.notionalUsd;
    return a.assetId.localeCompare(b.assetId);
  });

  const records: ExecutionRecord[] = [];
  let totalFeesUsd = 0;
  let totalSlippageCostUsd = 0;
  let netCashFlowUsd = 0;

  for (const intent of sortedIntents) {
    const bar = assetBars[intent.assetId];
    if (!bar) continue;

    const basePrice = context.executionRule === "NEXT_BAR_OPEN" ? bar.open : bar.close;
    let executableUnits = intent.targetUnitsDelta;

    if (intent.side === "SELL") {
      const currentUnits = currentPositions[intent.assetId]?.quantity ?? 0;
      executableUnits = Math.min(currentUnits, executableUnits);
      if (executableUnits <= 0) continue;
    }

    const impact = calculatePriceImpact(
      basePrice,
      intent.side,
      executableUnits,
      bar.volume,
      context.slippageConfig
    );

    let grossTradeValue = executableUnits * impact.executionPrice;
    let fees = grossTradeValue * context.commissionRate;

    if (intent.side === "BUY") {
      const totalRequired = grossTradeValue + fees;
      if (totalRequired > cash) {
        const affordableValue = Math.max(0, cash / (1 + context.commissionRate));
        executableUnits = affordableValue / impact.executionPrice;
        grossTradeValue = executableUnits * impact.executionPrice;
        fees = grossTradeValue * context.commissionRate;
      }
      if (executableUnits <= 1e-8) continue;
    }

    let netCashImpact = 0;
    const existingPos = currentPositions[intent.assetId];

    if (intent.side === "SELL") {
      netCashImpact = grossTradeValue - fees;
      cash += netCashImpact;
      const remainingUnits = Math.max(0, (existingPos?.quantity ?? 0) - executableUnits);

      if (remainingUnits > 1e-8) {
        currentPositions[intent.assetId] = {
          assetId: intent.assetId,
          side: "LONG",
          status: "OPEN",
          quantity: remainingUnits,
          entryPrice: existingPos?.entryPrice ?? impact.executionPrice,
          unrealizedPnl: (basePrice - (existingPos?.entryPrice ?? impact.executionPrice)) * remainingUnits,
        };
      } else {
        currentPositions[intent.assetId] = {
          assetId: intent.assetId,
          side: "FLAT",
          status: "CLOSED",
          quantity: 0,
          entryPrice: 0,
          unrealizedPnl: 0,
        };
      }
    } else {
      netCashImpact = -(grossTradeValue + fees);
      cash += netCashImpact;
      const prevQty = existingPos?.quantity ?? 0;
      const prevEntry = existingPos?.entryPrice ?? impact.executionPrice;
      const newQty = prevQty + executableUnits;
      const newEntry = (prevQty * prevEntry + executableUnits * impact.executionPrice) / newQty;

      currentPositions[intent.assetId] = {
        assetId: intent.assetId,
        side: "LONG",
        status: "OPEN",
        quantity: newQty,
        entryPrice: newEntry,
        unrealizedPnl: (basePrice - newEntry) * newQty,
      };
    }

    totalFeesUsd += fees;
    totalSlippageCostUsd += impact.slippageCostUsd;
    netCashFlowUsd += netCashImpact;

    const recordMaterial: Omit<ExecutionRecord, "lifecycleBinding"> = {
      executionId: `exec-${intent.assetId}-${context.executionTimestamp}-${intent.side}`,
      orderId: `ord-${intent.assetId}-${context.decisionTimestamp}`,
      strategyId: "OMEGA_REBALANCE",
      assetId: intent.assetId,
      side: intent.side,
      orderType: "MARKET",
      signalTimestamp: targetWeights.asOfTimestamp,
      decisionTimestamp: context.decisionTimestamp,
      executionTimestamp: context.executionTimestamp,
      intendedPrice: Math.round(basePrice * 100) / 100,
      executionPrice: Math.round(impact.executionPrice * 100) / 100,
      quantity: Math.round(executableUnits * 100000) / 100000,
      notionalUsd: Math.round(grossTradeValue * 100) / 100,
      slippage: Math.round(impact.slippageBps * 10) / 10,
      fees: Math.round(fees * 100) / 100,
      netCashImpact: Math.round(netCashImpact * 100) / 100,
    };
    let lifecycleBinding: ExecutionRecordLifecycleBinding | undefined;
    if (context.lifecycleBinding) {
      const bindingMaterial = {
        schemaVersion: "M14_A04_EXECUTION_RECORD_LIFECYCLE_BINDING_V1" as const,
        targetDecisionIdentity: context.lifecycleBinding.targetDecisionIdentity,
        activeTargetRootIdentity: context.lifecycleBinding.activeTargetRootIdentity,
        preExecutionAccountIdentity: preExecutionPlan.accountIdentity,
        executionPlanIdentity: preExecutionPlan.semanticIdentity,
      };
      lifecycleBinding = immutableProducerCopy({
        ...bindingMaterial,
        fillIdentity: producerIdentity({ record: recordMaterial, binding: bindingMaterial }),
      });
    }
    records.push(lifecycleBinding ? { ...recordMaterial, lifecycleBinding } : recordMaterial);
  }

  return {
    updatedAccount: {
      cash: Math.round(cash * 100) / 100,
      positions: currentPositions,
    },
    records,
    totalFeesUsd: Math.round(totalFeesUsd * 100) / 100,
    totalSlippageCostUsd: Math.round(totalSlippageCostUsd * 100) / 100,
    netCashFlowUsd: Math.round(netCashFlowUsd * 100) / 100,
  };
}
