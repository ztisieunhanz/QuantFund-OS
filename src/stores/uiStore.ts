import { create } from "zustand";
import type { ViewId } from "@/types/market";

interface UiState {
  view: ViewId;
  clock: number;
  setView: (view: ViewId) => void;
  tickClock: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  view: "macro",
  clock: Date.now(),
  setView: (view) => set({ view }),
  tickClock: () => set({ clock: Date.now() }),
}));
