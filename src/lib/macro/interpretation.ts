// ============================================================================
// FILE: src/lib/macro/interpretation.ts
// MODULE: MACRO V2 HEURISTIC INTERPRETATION ENGINE WITH QUALITY GATING
// PRINCIPLE: Truthful Quality Gating & Transparent Evidence Extraction (Gate M2)
// ============================================================================

import { getFreshnessThresholdMs, MACRO_V2_CONFIG, type MacroV2Config } from "./config";
import { calculateFreshness } from "./helpers";
import type {
  AvailableMacroDatum,
  MacroAssessment,
  MacroEvidence,
  MacroRegimeV2,
  MacroDatum,
  MarketSnapshotData,
} from "./types";

export interface QualityGateResult {
  readonly eligibleMetrics: Readonly<Record<string, AvailableMacroDatum<unknown>>>;
  readonly usableMetrics: readonly string[];
  readonly unavailableMetrics: readonly string[];
  readonly staleMetrics: readonly string[];
  readonly excludedMetrics: readonly string[];
}

/**
 * Evaluates Layer 1 MarketSnapshotData against strict provenance and freshness criteria.
 * Strictly EXCLUDES: SYNTHETIC, HARDCODED, DERIVED, STALE, UNAVAILABLE, or future timestamps.
 */
export function evaluateDataQualityGate(
  data: MarketSnapshotData,
  referenceTimeMs: number,
  config: MacroV2Config = MACRO_V2_CONFIG
): QualityGateResult {
  const eligibleMetrics: Record<string, AvailableMacroDatum<unknown>> = {};
  const usableMetrics: string[] = [];
  const unavailableMetrics: string[] = [];
  const staleMetrics: string[] = [];
  const excludedMetrics: string[] = [];

  const keys = Object.keys(data) as Array<keyof MarketSnapshotData>;

  for (const key of keys) {
    if (key === "customMetrics") continue;

    const datum = data[key] as MacroDatum<unknown>;
    if (!datum) {
      unavailableMetrics.push(key);
      continue;
    }

    if (datum.status === "UNAVAILABLE") {
      unavailableMetrics.push(key);
      continue;
    }

    // Gate M2 Rule: Only LIVE provenance is eligible for authoritative current regime evidence
    if (datum.sourceClassification !== "LIVE") {
      excludedMetrics.push(key);
      continue;
    }

    // Check future timestamps (asOf > referenceTimeMs)
    if (datum.asOf > referenceTimeMs) {
      staleMetrics.push(key);
      continue;
    }

    const thresholdMs = getFreshnessThresholdMs(key, config);
    const freshness = calculateFreshness(datum, referenceTimeMs, thresholdMs);

    if (freshness.isStale) {
      staleMetrics.push(key);
      continue;
    }

    if (datum.quality !== "USABLE") {
      excludedMetrics.push(key);
      continue;
    }

    // Passed all quality gate checks
    eligibleMetrics[key] = datum;
    usableMetrics.push(key);
  }

  return {
    eligibleMetrics,
    usableMetrics,
    unavailableMetrics,
    staleMetrics,
    excludedMetrics,
  };
}

/**
 * Core Layer 2 Interpretation Engine (Gate M2).
 * Evaluates macro regime stance from eligible live evidence without returning asset allocations.
 *
 * NOTE: Snapshot point observations must NOT claim directional momentum/trend facts.
 * Absolute levels emit heuristic evidence only where supported by level thresholds.
 * BTC absolute price alone produces NO directional MacroEvidence.
 */
export function evaluateMacroRegimeV2(
  data: MarketSnapshotData,
  referenceTimeMs: number,
  config: MacroV2Config = MACRO_V2_CONFIG
): MacroAssessment {
  const gate = evaluateDataQualityGate(data, referenceTimeMs, config);
  const { eligibleMetrics, usableMetrics, unavailableMetrics, staleMetrics, excludedMetrics } = gate;

  // Filter usable metrics against 6 core global metrics
  const usableCoreMetrics = config.coreMetricIds.filter((id) => usableMetrics.includes(id));
  const usableCoreCount = usableCoreMetrics.length;
  const totalCore = config.coreMetricIds.length;
  const coverageRatio = usableCoreCount / totalCore;

  const coverage = {
    usable: usableCoreCount,
    required: config.minUsableCore,
    totalCore,
    ratio: Math.round(coverageRatio * 100) / 100,
  };

  const hasVolatilityCategory = usableCoreMetrics.includes("vix") || usableCoreMetrics.includes("btc");
  const hasRatesDollarCategory =
    usableCoreMetrics.includes("dxy") ||
    usableCoreMetrics.includes("us2y") ||
    usableCoreMetrics.includes("us10y");

  // Check Minimum-Data Rule
  if (usableCoreCount < config.minUsableCore) {
    return createInsufficientDataAssessment(
      gate,
      coverage,
      `Fewer than ${config.minUsableCore} usable core metrics available (${usableCoreCount}/${totalCore} usable)`
    );
  }

  if (!hasVolatilityCategory) {
    return createInsufficientDataAssessment(
      gate,
      coverage,
      "Missing required volatility/risk metric category (requires vix or btc)"
    );
  }

  if (!hasRatesDollarCategory) {
    return createInsufficientDataAssessment(
      gate,
      coverage,
      "Missing required rates/dollar metric category (requires dxy, us2y, or us10y)"
    );
  }

  // Extract Evidence from Eligible Metrics
  const evidenceList: MacroEvidence[] = [];

  // 1. Yield Curve Evidence (REQUIRES BOTH us10y AND us2y to be eligible LIVE metrics!)
  // Inversion (< 0 bps) produces stress/RISK_OFF evidence. Positive/steep curve alone produces NO RISK_ON evidence.
  const us10y = eligibleMetrics.us10y as AvailableMacroDatum<number> | undefined;
  const us2y = eligibleMetrics.us2y as AvailableMacroDatum<number> | undefined;

  if (us10y && us2y && Number.isFinite(us10y.value) && Number.isFinite(us2y.value)) {
    const spreadBps = Math.round((us10y.value - us2y.value) * 100);
    if (spreadBps < 0) {
      evidenceList.push({
        id: "ev-yield-curve-inverted",
        direction: "RISK_OFF",
        strength: 0.85,
        observedValue: spreadBps,
        description: `Inverted yield curve level (-${Math.abs(spreadBps)} bps: 10Y ${us10y.value}% vs 2Y ${us2y.value}%). Macro credit and recession stress heuristic.`,
        sourceIds: ["us10y", "us2y"],
      });
    }
  }

  // 2. VIX Implied Volatility Level Evidence
  const vix = eligibleMetrics.vix as AvailableMacroDatum<number> | undefined;
  if (vix && Number.isFinite(vix.value)) {
    if (vix.value >= 22) {
      evidenceList.push({
        id: "ev-vix-high",
        direction: "RISK_OFF",
        strength: 0.9,
        observedValue: vix.value,
        description: `Elevated VIX implied volatility level (${vix.value.toFixed(1)}). Risk-off market stress heuristic.`,
        sourceIds: ["vix"],
      });
    } else if (vix.value <= 16) {
      evidenceList.push({
        id: "ev-vix-calm",
        direction: "RISK_ON",
        strength: 0.75,
        observedValue: vix.value,
        description: `Subdued VIX implied volatility level (${vix.value.toFixed(1)}). Calm risk-on environment heuristic.`,
        sourceIds: ["vix"],
      });
    }
  }

  // 3. DXY Dollar Index Level Evidence (Descriptive level heuristics only — no momentum claim)
  const dxy = eligibleMetrics.dxy as AvailableMacroDatum<number> | undefined;
  if (dxy && Number.isFinite(dxy.value)) {
    if (dxy.value >= 104) {
      evidenceList.push({
        id: "ev-dxy-strong",
        direction: "RISK_OFF",
        strength: 0.8,
        observedValue: dxy.value,
        description: `Elevated US Dollar Index level (${dxy.value.toFixed(1)}) associated with tighter global financial conditions.`,
        sourceIds: ["dxy"],
      });
    } else if (dxy.value <= 100) {
      evidenceList.push({
        id: "ev-dxy-soft",
        direction: "RISK_ON",
        strength: 0.75,
        observedValue: dxy.value,
        description: `Subdued US Dollar Index level (${dxy.value.toFixed(1)}) associated with accommodative global dollar conditions.`,
        sourceIds: ["dxy"],
      });
    }
  }

  // 4. US 10Y Yield Level Evidence (Descriptive level heuristics only — no momentum claim)
  if (us10y && Number.isFinite(us10y.value)) {
    if (us10y.value >= 4.8) {
      evidenceList.push({
        id: "ev-us10y-high",
        direction: "RISK_OFF",
        strength: 0.75,
        observedValue: us10y.value,
        description: `Elevated 10Y Treasury yield level (${us10y.value.toFixed(2)}%) associated with restrictive discount-rate conditions.`,
        sourceIds: ["us10y"],
      });
    } else if (us10y.value <= 3.8) {
      evidenceList.push({
        id: "ev-us10y-low",
        direction: "RISK_ON",
        strength: 0.65,
        observedValue: us10y.value,
        description: `Subdued 10Y Treasury yield level (${us10y.value.toFixed(2)}%) associated with accommodative discount-rate conditions.`,
        sourceIds: ["us10y"],
      });
    }
  }

  // NOTE: BTC absolute price alone produces NO directional MacroEvidence because establishing
  // direction requires historical return/change data not present in point snapshot.
  // BTC still satisfies minimum-data volatility/risk availability rule.

  // Partition evidence into Risk-On vs Risk-Off
  const riskOnItems = evidenceList.filter((e) => e.direction === "RISK_ON");
  const riskOffItems = evidenceList.filter((e) => e.direction === "RISK_OFF");

  const riskOnStrength = riskOnItems.reduce((acc, e) => acc + e.strength, 0);
  const riskOffStrength = riskOffItems.reduce((acc, e) => acc + e.strength, 0);

  let regime: MacroRegimeV2 = "MIXED";
  let primaryEvidence: MacroEvidence[] = [];
  let conflictingEvidence: MacroEvidence[] = [];

  const isYieldInverted = evidenceList.some((e) => e.id === "ev-yield-curve-inverted");
  const isVixHigh = evidenceList.some((e) => e.id === "ev-vix-high");

  if (isYieldInverted && isVixHigh) {
    regime = "LIQUIDITY_STRESS";
    primaryEvidence = riskOffItems;
    conflictingEvidence = riskOnItems;
  } else if (riskOnStrength >= 0.6 && riskOffStrength >= 0.6) {
    regime = "MIXED";
    primaryEvidence = evidenceList;
    conflictingEvidence = [];
  } else if (riskOffStrength > riskOnStrength + 0.3) {
    regime = "RISK_OFF";
    primaryEvidence = riskOffItems;
    conflictingEvidence = riskOnItems;
  } else if (riskOnStrength > riskOffStrength + 0.3) {
    regime = "RISK_ON";
    primaryEvidence = riskOnItems;
    conflictingEvidence = riskOffItems;
  } else {
    regime = "MIXED";
    primaryEvidence = evidenceList;
    conflictingEvidence = [];
  }

  // Calculate Bounded Confidence Score [0 .. 100]
  // Note: Confidence is a heuristic data-coverage & evidence-agreement score, NOT a calibrated probability.
  const totalStrength = riskOnStrength + riskOffStrength;
  const dominantStrength =
    regime === "RISK_ON"
      ? riskOnStrength
      : regime === "RISK_OFF" || regime === "LIQUIDITY_STRESS"
      ? riskOffStrength
      : Math.max(riskOnStrength, riskOffStrength);

  const agreementRatio = totalStrength > 0 ? dominantStrength / totalStrength : 0.5;
  const confidence = Math.round(coverageRatio * agreementRatio * 100);

  return {
    status: "AVAILABLE",
    regime,
    evidence: primaryEvidence,
    conflicts: conflictingEvidence,
    usableMetrics,
    unavailableMetrics,
    staleMetrics,
    excludedMetrics,
    coverage,
    confidence,
    model: {
      name: "MacroRegimeHeuristicV2",
      version: "2.0.0",
      classification: "HEURISTIC",
    },
  };
}

function createInsufficientDataAssessment(
  gate: QualityGateResult,
  coverage: MacroAssessment["coverage"],
  reason: string
): MacroAssessment {
  return {
    status: "INSUFFICIENT_DATA",
    regime: null,
    evidence: [],
    conflicts: [],
    usableMetrics: gate.usableMetrics,
    unavailableMetrics: gate.unavailableMetrics,
    staleMetrics: gate.staleMetrics,
    excludedMetrics: gate.excludedMetrics,
    coverage,
    confidence: null,
    model: {
      name: "MacroRegimeHeuristicV2",
      version: "2.0.0",
      classification: "HEURISTIC",
    },
    reason,
  };
}
