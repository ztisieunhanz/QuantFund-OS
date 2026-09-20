// ============================================================================
// FILE: src/lib/macro/quantAdapter.ts
// MODULE: MACRO V2 QUANT LAYER ADAPTER
// PRINCIPLE: Reads Existing Quant Telemetry Only — No Rogue Ledgers & No Fake PnLs (DEC-002, Gate M3)
// ============================================================================

import type { SignalOutput, StrategyId } from "@/lib/quant/types";
import type { QuantLayerSummary, QuantStrategySummary } from "./types";

const STRATEGY_NAMES: Record<StrategyId, string> = {
  ADAPTIVE_TREND: "Alpha 1 · Adaptive Trend",
  EVENT_REACTION: "Alpha 2 · Event Catalyst",
  MEAN_REVERSION: "Alpha 3 · Mean Reversion",
};

/**
 * Translates existing canonical SignalOutput telemetry into a clean QuantLayerSummary contract.
 *
 * IMPORTANT INVARIANTS (DEC-002, Gate M3):
 * 1. Signals are telemetry/signal generators ONLY.
 * 2. NO per-strategy PnL, fake trade count, fake win rate, or synthetic attribution is computed here.
 * 3. strongestStrategyId means strictly: "largest absolute currently valid normalized alpha signal".
 * 4. Expired/invalid signals (validUntil < referenceTimeMs) are excluded from strongestStrategyId.
 */
export function buildQuantLayerSummary(
  signals: readonly SignalOutput[] | null | undefined,
  referenceTimeMs?: number
): QuantLayerSummary {
  if (!signals || signals.length === 0) {
    return {
      status: "UNAVAILABLE",
      strategies: [],
      strongestStrategyId: null,
      note: "No quant strategy signals available",
    };
  }

  const strategies: QuantStrategySummary[] = [];
  let validCount = 0;
  let strongestId: string | null = null;
  let maxAbsSignal = 0;

  for (const sig of signals) {
    const isExpired =
      referenceTimeMs != null &&
      sig.validUntil != null &&
      referenceTimeMs > sig.validUntil;

    const isValid = !isExpired && Number.isFinite(sig.alphaScore);

    const strategyName = STRATEGY_NAMES[sig.strategyId] ?? sig.strategyId;

    const summary: QuantStrategySummary = {
      id: sig.strategyId,
      name: strategyName,
      signal: isValid ? sig.alphaScore : null,
      state: isExpired ? "EXPIRED" : (sig.rationale || "ACTIVE"),
      validUntil: sig.validUntil ?? null,
      source: "ALPHA_ENGINE",
    };

    strategies.push(summary);

    if (isValid) {
      validCount++;
      const absSignal = Math.abs(sig.alphaScore);
      // Semantics: largest absolute currently valid normalized alpha signal (> 0)
      if (absSignal > maxAbsSignal) {
        maxAbsSignal = absSignal;
        strongestId = sig.strategyId;
      }
    }
  }

  let status: QuantLayerSummary["status"] = "UNAVAILABLE";
  if (validCount >= 3) {
    status = "AVAILABLE";
  } else if (validCount > 0) {
    status = "PARTIAL";
  }

  return {
    status,
    strategies,
    strongestStrategyId: strongestId,
    note: validCount === 0 ? "All quant strategy signals are expired or invalid" : null,
  };
}
