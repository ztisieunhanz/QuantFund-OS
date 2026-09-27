// ============================================================================
// FILE: src/lib/macro/loader.ts
// MODULE: MACRO V2 UNIVERSE DATA LOADER
// PRINCIPLE: Pure Layer 1 Data Aggregator — No Regime Scoring & No Synthetic Fallbacks (DEC-009, DEC-010)
// ============================================================================

import {
  type AdapterOptions,
  fetchBtcDatumV2,
  fetchDxyDatumV2,
  fetchGoldDatumV2,
  fetchUs10yDatumV2,
  fetchUs2yDatumV2,
  fetchVietnamBreadthV2,
  fetchVietnamForeignFlowV2,
  fetchVietnamLiquidityV2,
  fetchVixDatumV2,
  fetchVnIndexDatumV2,
} from "./adapters";
import { getFreshnessThresholdMs } from "./config";
import { BoundedOperationalProviderCache } from "../operationalReliability";
import {
  acquireMacroDatumWithEvidence,
  loadReliableMacroDatum,
  MACRO_PROVIDER_CACHE_MAX_ENTRIES,
} from "./reliableProvider";
import type { AvailableMacroDatum, MacroDatum, MarketSnapshotData } from "./types";

const runtimeCache = new BoundedOperationalProviderCache<AvailableMacroDatum<unknown>>(
  MACRO_PROVIDER_CACHE_MAX_ENTRIES
);

export function resetMacroProviderReliabilityCache(): void {
  runtimeCache.clear();
}

async function loadDirect(opts?: AdapterOptions): Promise<MarketSnapshotData> {
  const [dxy, us2y, us10y, vix, gold, btc, vnindex, breadth, liquidity, foreignFlow] =
    await Promise.all([
      fetchDxyDatumV2(opts),
      fetchUs2yDatumV2(opts),
      fetchUs10yDatumV2(opts),
      fetchVixDatumV2(opts),
      fetchGoldDatumV2(opts),
      fetchBtcDatumV2(opts),
      fetchVnIndexDatumV2(opts),
      fetchVietnamBreadthV2(opts),
      fetchVietnamLiquidityV2(opts),
      fetchVietnamForeignFlowV2(opts),
    ]);

  return { dxy, us2y, us10y, vix, gold, btc, vnindex, breadth, liquidity, foreignFlow };
}

/**
 * Aggregates all core Macro V2 universe feeds into a structured MarketSnapshotData object.
 * Pure Layer 1 Data Ingestion — does NOT run regime scoring, asset allocation, or chatbot logic.
 */
export async function loadMacroUniverseV2(
  opts?: AdapterOptions
): Promise<MarketSnapshotData> {
  // Explicitly injected adapters retain direct deterministic behavior for tests
  // and callers that own their transport policy. The active runtime path uses
  // the shared process-local reliability boundary below.
  if (opts !== undefined) return loadDirect(opts);

  const referenceTimeMs = Date.now();
  const directLoaders = {
    dxy: fetchDxyDatumV2,
    us2y: fetchUs2yDatumV2,
    us10y: fetchUs10yDatumV2,
    vix: fetchVixDatumV2,
    gold: fetchGoldDatumV2,
    btc: fetchBtcDatumV2,
    vnindex: fetchVnIndexDatumV2,
    breadth: fetchVietnamBreadthV2,
    liquidity: fetchVietnamLiquidityV2,
    foreignFlow: fetchVietnamForeignFlowV2,
  } as const;

  const load = async <T>(
    metricId: keyof typeof directLoaders,
    acquire: (opts?: AdapterOptions) => Promise<MacroDatum<T>>
  ): Promise<MacroDatum<T>> => loadReliableMacroDatum({
    metricId,
    freshnessMaxAgeMs: getFreshnessThresholdMs(metricId),
    referenceTimeMs,
    acquire: () => acquireMacroDatumWithEvidence({
      acquire: (fetchFn) => acquire({ fetchFn, fetchedAt: Date.now() }),
    }),
    cache: runtimeCache as BoundedOperationalProviderCache<AvailableMacroDatum<T>>,
  });

  const [dxy, us2y, us10y, vix, gold, btc, vnindex, breadth, liquidity, foreignFlow] =
    await Promise.all([
      load("dxy", directLoaders.dxy),
      load("us2y", directLoaders.us2y),
      load("us10y", directLoaders.us10y),
      load("vix", directLoaders.vix),
      load("gold", directLoaders.gold),
      load("btc", directLoaders.btc),
      load("vnindex", directLoaders.vnindex),
      load("breadth", directLoaders.breadth),
      load("liquidity", directLoaders.liquidity),
      load("foreignFlow", directLoaders.foreignFlow),
    ]);

  return { dxy, us2y, us10y, vix, gold, btc, vnindex, breadth, liquidity, foreignFlow };
}
