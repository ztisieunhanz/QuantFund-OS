import { create } from "zustand";
import type { CorrelationMatrix, MacroSeries, RegimeResult } from "@/types/market";
import { thirtyDayCorrelation } from "@/lib/correlation";
import { loadMacroUniverse } from "@/lib/macroFeed";
import { scoreMacroRegime } from "@/lib/regime";

interface MacroState {
  loading: boolean;
  error: string | null;
  series: MacroSeries[];
  regime: RegimeResult | null;
  correlation: CorrelationMatrix | null;
  refreshedAt: number | null;
  load: () => Promise<void>;
}

export const useMacroStore = create<MacroState>((set) => ({
  loading: false,
  error: null,
  series: [],
  regime: null,
  correlation: null,
  refreshedAt: null,
  load: async () => {
    set({ loading: true, error: null });
    try {
      const series = await loadMacroUniverse();
      const regime = scoreMacroRegime(series);
      const correlation = thirtyDayCorrelation(series);
      set({ series, regime, correlation, loading: false, refreshedAt: Date.now() });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : "Macro feed failed",
      });
    }
  },
}));
