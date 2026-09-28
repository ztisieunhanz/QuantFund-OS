// ============================================================================
// FILE: src/stores/snapshotStore.ts
// MODULE: MACRO V2 SHARED SNAPSHOT STORE
// PRINCIPLE: Single Authoritative CurrentMarketSnapshot Store (DEC-010, Gate M4)
// ============================================================================

import { create } from "zustand";
import { loadRuntimeMarketSnapshot, type LoadRuntimeSnapshotOptions } from "@/lib/macro/runtimeSnapshot";
import type { CurrentMarketSnapshot } from "@/lib/macro/types";
import { useTradingStore } from "@/stores/tradingStore";

interface SnapshotState {
  snapshot: CurrentMarketSnapshot | null;
  loading: boolean;
  error: string | null;
  refreshedAt: number | null;
  refreshSnapshot: (opts?: LoadRuntimeSnapshotOptions) => Promise<CurrentMarketSnapshot | null>;
  setSnapshotDirect: (snapshot: CurrentMarketSnapshot | null) => void;
}

export const useSnapshotStore = create<SnapshotState>((set) => ({
  snapshot: null,
  loading: false,
  error: null,
  refreshedAt: null,

  refreshSnapshot: async (opts) => {
    set({ loading: true, error: null });
    try {
      const snap = await loadRuntimeMarketSnapshot(opts);
      set({
        snapshot: snap,
        loading: false,
        refreshedAt: Date.now(),
      });
      return snap;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Failed to load CurrentMarketSnapshot";
      set({
        snapshot: null,
        loading: false,
        error: errMsg,
      });
      return null;
    }
  },

  setSnapshotDirect: (snapshot) => {
    set({
      snapshot,
      loading: false,
      error: snapshot ? null : "No snapshot set",
      refreshedAt: snapshot ? Date.now() : null,
    });
  },
}));

// Snapshot is a derived cache. Invalidate a cached current projection synchronously
// when the canonical operational truth leaves FRESH_CURRENT; tradingStore remains
// the sole operational authority and no store dependency points back to snapshotStore.
useTradingStore.subscribe((state, previousState) => {
  if (
    previousState.operationalState.status === "FRESH_CURRENT"
    && state.operationalState.status !== "FRESH_CURRENT"
    && useSnapshotStore.getState().snapshot?.operationalState?.status === "FRESH_CURRENT"
  ) {
    useSnapshotStore.setState({
      snapshot: null,
      refreshedAt: null,
      error: state.operationalState.reason ?? "Current snapshot invalidated by operational degradation.",
    });
  }
});
