import { create } from 'zustand';

export interface AssetPosition {
  id: string;
  name: string;
  category: string;
  currentValue: number;
  allocationPercent: number;
}

interface PortfolioState {
  cashUsd: number;
  totalNav: number;
  assets: AssetPosition[];
  setCash: (cash: number) => void;
  setTotalNav: (nav: number) => void;
  getTotalNav: () => number;
}

export const usePortfolioStore = create<PortfolioState>((set, get) => ({
  cashUsd: 15000,
  totalNav: 100000,
  assets: [
    { id: 'realestate', name: 'Real Estate', category: 'Real Estate', currentValue: 12800, allocationPercent: 12.8 },
    { id: 'gold', name: 'Gold', category: 'Gold', currentValue: 28600, allocationPercent: 28.6 },
    { id: 'usdCash', name: 'USD Cash', category: 'Cash', currentValue: 21900, allocationPercent: 21.9 },
    { id: 'equities', name: 'Equities', category: 'Equities', currentValue: 36100, allocationPercent: 36.1 },
    { id: 'crypto', name: 'Crypto', category: 'Crypto', allocationPercent: 8.6, currentValue: 8600 }
  ],
  setCash: (cash: number) => set({ cashUsd: cash }),
  setTotalNav: (nav: number) => set({ totalNav: nav }),
  getTotalNav: () => {
    return get().totalNav;
  }
}));