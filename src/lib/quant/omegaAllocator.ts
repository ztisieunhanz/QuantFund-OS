// ============================================================================
// FILE: src/lib/quant/omegaAllocator.ts
// MODULE: OMEGA ALLOCATOR (PORTFOLIO ALLOCATION META-CONTROLLER)
// ARCHITECTURE: (Signals * Permissions) + RiskOutput + Correlation -> TargetPortfolioWeight
// ============================================================================

import type {
  AssetId,
  StrategyId,
  SignalOutput,
  PermissionOutput,
  RiskOutput,
  TargetPortfolioWeight,
  ProvenancedTargetPortfolioWeight,
} from "@/lib/quant/types";
import {
  canonicalProducerJson,
  immutableProducerCopy,
  producerIdentity,
  validatePermissionOutput,
  validateRiskOutput,
  validateSignalOutput,
} from "@/lib/quant/producerProvenance";

export interface OmegaAllocatorConfig {
  readonly baseStrategyWeights: Readonly<Record<StrategyId, number>>;
  readonly correlationPenaltyThreshold: number; // Ngưỡng tương quan PnL bắt đầu giảm tỷ trọng (mặc định 0.70)
  readonly maxAssetWeightCap: number;           // Trần tỷ trọng tối đa cho 1 tài sản rủi ro (mặc định 0.40 = 40%)
}

export const DEFAULT_OMEGA_CONFIG: OmegaAllocatorConfig = {
  baseStrategyWeights: {
    ADAPTIVE_TREND: 0.45,
    EVENT_REACTION: 0.35,
    MEAN_REVERSION: 0.20,
  },
  correlationPenaltyThreshold: 0.70,
  maxAssetWeightCap: 0.40,
};

type TargetMaterial = Omit<TargetPortfolioWeight, "provenance">;

function targetContentMaterial(target: TargetMaterial) {
  const { asOfTimestamp: _decisionTime, ...content } = target;
  return content;
}

function validateTargetMaterial(target: TargetMaterial): void {
  const expectedKeys = ["asOfTimestamp", "assetWeights", "cashWeight", "grossExposure", "netExposure", "rationale", "riskAdjustmentRatio", "strategyAllocations"].sort();
  if (canonicalProducerJson(Object.keys(target).sort()) !== canonicalProducerJson(expectedKeys)) throw new Error("Unsupported target portfolio content");
  if (!Number.isFinite(target.asOfTimestamp)) throw new Error("Target decision time must be finite");
  const assetWeights = Object.values(target.assetWeights);
  if (assetWeights.some((weight) => !Number.isFinite(weight) || weight < 0)) throw new Error("Target asset weights must be finite and long-only");
  const numericFields = [target.cashWeight, target.grossExposure, target.netExposure, target.riskAdjustmentRatio, ...Object.values(target.strategyAllocations)];
  if (numericFields.some((value) => !Number.isFinite(value))) throw new Error("Target portfolio content must be finite");
  if (target.cashWeight < 0 || target.grossExposure < 0 || target.netExposure < 0) throw new Error("Target portfolio content violates long-only invariants");
  const gross = assetWeights.reduce((sum, weight) => sum + Math.abs(weight), 0);
  const net = assetWeights.reduce((sum, weight) => sum + weight, 0);
  const expectedCash = Math.max(0, Math.round((1 - gross) * 1000) / 1000);
  if (Math.abs(gross - target.grossExposure) > 1e-9 || Math.abs(net - target.netExposure) > 1e-9 || Math.abs(expectedCash - target.cashWeight) > 1e-9) throw new Error("Target portfolio aggregate fields are inconsistent");
}

function createOmegaTargetPortfolioWeight(target: TargetMaterial, signals: readonly SignalOutput[], permissions: readonly PermissionOutput[], risk: RiskOutput, correlations: unknown, config: OmegaAllocatorConfig): ProvenancedTargetPortfolioWeight {
  validateTargetMaterial(target);
  signals.forEach((signal) => validateSignalOutput(signal));
  permissions.forEach((permission) => validatePermissionOutput(permission));
  validateRiskOutput(risk);
  const targetContentIdentity = producerIdentity(targetContentMaterial(target));
  const signalIdentities = signals.map((item) => { validateSignalOutput(item); return item.provenance.semanticIdentity; }).sort();
  const permissionIdentities = permissions.map((item) => { validatePermissionOutput(item); return item.provenance.semanticIdentity; }).sort();
  const base = {
    schemaVersion: "M14_A04_TARGET_PROVENANCE_V1" as const,
    targetContentIdentity,
    signalIdentities,
    permissionIdentities,
    riskIdentity: risk.provenance.semanticIdentity,
    omegaConfigIdentity: producerIdentity(config),
    correlationsIdentity: correlations === null ? "NONE" as const : producerIdentity(correlations),
  };
  return immutableProducerCopy({ ...target, provenance: { ...base, targetDecisionIdentity: producerIdentity({ ...base, asOfTimestamp: target.asOfTimestamp }) } });
}

export function validateTargetPortfolioWeight(target: TargetPortfolioWeight, signals: readonly SignalOutput[], permissions: readonly PermissionOutput[], risk: RiskOutput, correlations: unknown, config: OmegaAllocatorConfig): void {
  const { provenance, ...material } = target;
  if (!provenance || provenance.schemaVersion !== "M14_A04_TARGET_PROVENANCE_V1") throw new Error("Invalid target provenance contract");
  const rebuilt = createOmegaTargetPortfolioWeight(material, signals, permissions, risk, correlations, config);
  if (canonicalProducerJson(rebuilt.provenance) !== canonicalProducerJson(provenance)) throw new Error("Target portfolio provenance mismatch");
}

export function evaluateOmegaAllocation(
  signals: readonly SignalOutput[],
  permissions: readonly PermissionOutput[],
  risk: RiskOutput,
  strategyCorrelations: Readonly<Record<StrategyId, Readonly<Record<StrategyId, number>>>> | null,
  asOfTimestamp: number,
  config: OmegaAllocatorConfig = DEFAULT_OMEGA_CONFIG
): ProvenancedTargetPortfolioWeight {
  // 1. TÍNH TOÁN ALPHA HIỆU DỤNG: EffectiveAlpha = AlphaScore * Permission * Confidence
  const permissionMap = new Map<StrategyId, number>();
  for (const p of permissions) {
    permissionMap.set(p.strategyId, p.isPermitted ? p.permission : 0);
  }

  const effectiveAlphaMap = new Map<StrategyId, { asset: AssetId; score: number }>();
  for (const s of signals) {
    const perm = permissionMap.get(s.strategyId) ?? 1.0;
    const effectiveScore = s.alphaScore * perm * s.confidence;
    effectiveAlphaMap.set(s.strategyId, { asset: s.assetId, score: effectiveScore });
  }

  // 2. ĐÁNH GIÁ RỦI RO ĐỒNG PHA / TẬP TRUNG CHIẾN LƯỢC (CORRELATION PENALTY)
  let riskAdjustmentRatio = 1.0;
  if (strategyCorrelations) {
    const trendSignal = effectiveAlphaMap.get("ADAPTIVE_TREND")?.score ?? 0;
    const eventSignal = effectiveAlphaMap.get("EVENT_REACTION")?.score ?? 0;
    const corrTrendEvent = strategyCorrelations.ADAPTIVE_TREND?.EVENT_REACTION ?? 0;

    // Nếu Trend và Event cùng đánh mạnh 1 hướng và tương quan PnL cao -> Chiết khấu rủi ro
    if (Math.sign(trendSignal) === Math.sign(eventSignal) && Math.abs(trendSignal) > 0.3 && Math.abs(eventSignal) > 0.3) {
      if (corrTrendEvent > config.correlationPenaltyThreshold) {
        riskAdjustmentRatio = Math.max(0.70, 1.0 - (corrTrendEvent - config.correlationPenaltyThreshold));
      }
    }
  }

  // 3. PHÂN BỔ TỶ TRỌNG VỐN TỪNG CHIẾN LƯỢC (STRATEGY BUDGETING)
  const strategyAllocations: Record<StrategyId, number> = {
    ADAPTIVE_TREND: 0,
    EVENT_REACTION: 0,
    MEAN_REVERSION: 0,
  };

  const assetWeightAccumulator: Record<AssetId, number> = {};

  for (const [strategyId, baseWeight] of Object.entries(config.baseStrategyWeights) as Array<[StrategyId, number]>) {
    const signalData = effectiveAlphaMap.get(strategyId);
    if (!signalData || Math.abs(signalData.score) < 0.05) {
      strategyAllocations[strategyId] = 0;
      continue;
    }

    // Tỷ trọng chiến lược = Ngân sách cơ sở * EffectiveAlpha * Chiết khấu tương quan
    const allocatedFraction = baseWeight * signalData.score * riskAdjustmentRatio;
    strategyAllocations[strategyId] = Math.round(allocatedFraction * 1000) / 1000;

    // Cộng dồn phơi nhiễm vào từng tài sản cụ thể
    const currentAssetWeight = assetWeightAccumulator[signalData.asset] ?? 0;
    assetWeightAccumulator[signalData.asset] = currentAssetWeight + allocatedFraction;
  }

  // 4. CHUẨN HÓA VÀ ÁP TRẦN ĐÒN BẨY GỘP THEO RISK ENGINE (GROSS EXPOSURE CAP)
  //
  // CORE-07: Long-only executable clamp.
  // Negative alphaScore is valid signal information (allowed upstream), but the
  // current executable portfolio is LONG-ONLY. A negative raw accumulator entry
  // (from a strategy with negative effective alpha) must NOT produce a negative
  // final assetWeight in the returned TargetPortfolioWeight. The clamp occurs
  // here — before scaling and before the result is handed to ExecutionEngine —
  // so that target state never claims a short position that execution won't take.
  // ExecutionEngine.Math.max(0, ...) remains as a defensive guard.
  const longOnlyAccumulator: Record<AssetId, number> = {};
  for (const [asset, weight] of Object.entries(assetWeightAccumulator)) {
    longOnlyAccumulator[asset] = Math.max(0, weight);
  }

  let totalGrossRequested = 0;
  for (const weight of Object.values(longOnlyAccumulator)) {
    totalGrossRequested += Math.abs(weight); // always >= 0 after clamp
  }

  const finalAssetWeights: Record<AssetId, number> = {};
  const maxAllowedGross = risk.targetExposure; // Nhận trực tiếp từ Risk Engine

  // Nếu tổng đòn bẩy yêu cầu vượt mức Risk Engine cho phép, scale tỷ lệ nghịch toàn bộ
  const scalingFactor = totalGrossRequested > maxAllowedGross && totalGrossRequested > 0
    ? maxAllowedGross / totalGrossRequested
    : 1.0;

  let finalGross = 0;
  let finalNet = 0;

  for (const [asset, rawWeight] of Object.entries(longOnlyAccumulator)) {
    // Áp trần tỷ trọng tối đa cho từng tài sản đơn lẻ (Concentration Cap)
    // rawWeight is already >= 0; scaledWeight is >= 0; cap is non-negative
    let scaledWeight = rawWeight * scalingFactor;
    scaledWeight = Math.min(scaledWeight, config.maxAssetWeightCap);

    finalAssetWeights[asset] = Math.round(scaledWeight * 1000) / 1000;
    finalGross += Math.abs(finalAssetWeights[asset]);
    finalNet += finalAssetWeights[asset];
  }

  // Phần vốn còn lại phân bổ vào tiền mặt phòng hộ
  const cashWeight = Math.max(0.0, Math.round((1.0 - finalGross) * 1000) / 1000);

  const rationale = `OmegaAlloc: TargetExposure=${maxAllowedGross.toFixed(2)}, GrossAllocated=${finalGross.toFixed(2)}, Cash=${cashWeight.toFixed(2)}, CorrDiscount=${riskAdjustmentRatio.toFixed(2)}`;

  return createOmegaTargetPortfolioWeight({
    asOfTimestamp,
    assetWeights: finalAssetWeights,
    cashWeight,
    grossExposure: Math.round(finalGross * 1000) / 1000,
    netExposure: Math.round(finalNet * 1000) / 1000,
    strategyAllocations,
    riskAdjustmentRatio: Math.round(riskAdjustmentRatio * 100) / 100,
    rationale,
  }, signals, permissions, risk, strategyCorrelations, config);
}
