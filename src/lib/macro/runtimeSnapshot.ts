// ============================================================================
// FILE: src/lib/macro/runtimeSnapshot.ts
// MODULE: MACRO V2 RUNTIME SNAPSHOT ORCHESTRATION LAYER (GATE M4)
// PRINCIPLE: Single Source of Truth for UI & Chatbot (DEC-010)
// ============================================================================

import { useTradingStore } from "@/stores/tradingStore";
import { evaluateMacroRegimeV2 } from "./interpretation";
import { loadMacroUniverseV2 } from "./loader";
import { buildCurrentMarketSnapshot } from "./snapshot";
import type { CurrentMarketSnapshot, MarketSnapshotData } from "./types";

export interface LoadRuntimeSnapshotOptions {
  readonly referenceTimeMs?: number;
  readonly mockData?: MarketSnapshotData;
}

/**
 * Loads and orchestrates the authoritative CurrentMarketSnapshot for Macro V2 UI and Chatbot grounding.
 *
 * CONCEPTUAL RUNTIME FLOW:
 * REAL DATA -> loadMacroUniverseV2()
 *           -> evaluateMacroRegimeV2()
 *           -> existing Quant/Risk/Omega trading store state
 *           -> buildCurrentMarketSnapshot()
 */
export async function loadRuntimeMarketSnapshot(
  opts?: LoadRuntimeSnapshotOptions
): Promise<CurrentMarketSnapshot> {
  const referenceTimeMs = opts?.referenceTimeMs ?? Date.now();

  // 1. Layer 1: Ingest Macro V2 Data Universe (or use provided mock for deterministic tests)
  const data: MarketSnapshotData = opts?.mockData ?? (await loadMacroUniverseV2());

  // 2. Layer 2: Evaluate Macro V2 Regime & Evidence
  const macro = evaluateMacroRegimeV2(data, referenceTimeMs);

  // 3. Layer 2: Extract current canonical Quant, Risk, and Omega state from tradingStore (if available)
  const { latestDecision, isRestored } = useTradingStore.getState();
  const signals = latestDecision?.signals ?? null;
  const riskOutput = latestDecision?.risk ?? null;
  const targetWeights = latestDecision?.targetWeights ?? null;
  const drawdown = latestDecision?.currentDrawdown ?? null;

  // 4. Layer 3: Build & Return Unified CurrentMarketSnapshot
  const snapshot = buildCurrentMarketSnapshot({
    timestamp: referenceTimeMs,
    data,
    macro,
    signals,
    riskOutput,
    targetWeights,
    drawdown,
  });

  // GATE M7B: Truthfully annotate restored research provenance without modifying canonical decision timestamp
  if (isRestored && latestDecision) {
    const decisionTimeStr = new Date(latestDecision.timestamp).toISOString().slice(0, 19).replace("T", " ");
    const restoredNote = `Restored research state (asOf ${decisionTimeStr} UTC)`;
    if (snapshot.omega && snapshot.omega.status === "AVAILABLE") {
      (snapshot.omega as { note?: string | null }).note =
        (targetWeights?.rationale ? `${targetWeights.rationale} · ` : "") + restoredNote;
    }
  }

  return snapshot;
}
