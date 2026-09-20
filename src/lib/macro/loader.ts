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
import type { MarketSnapshotData } from "./types";

/**
 * Aggregates all core Macro V2 universe feeds into a structured MarketSnapshotData object.
 * Pure Layer 1 Data Ingestion — does NOT run regime scoring, asset allocation, or chatbot logic.
 */
export async function loadMacroUniverseV2(
  opts?: AdapterOptions
): Promise<MarketSnapshotData> {
  const [
    dxy,
    us2y,
    us10y,
    vix,
    gold,
    btc,
    vnindex,
    breadth,
    liquidity,
    foreignFlow,
  ] = await Promise.all([
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

  return {
    dxy,
    us2y,
    us10y,
    vix,
    gold,
    btc,
    vnindex,
    breadth,
    liquidity,
    foreignFlow,
  };
}
