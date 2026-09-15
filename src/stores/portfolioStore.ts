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

// CHUẨN HÓA DỮ LIỆU DANH MỤC (TỔNG CHÍNH XÁC 100%, NAV = $100,000)
// Tiền mặt được gom về một nguồn duy nhất (USD Cash: $20,000 = 20%)
export const usePortfolioStore = create<PortfolioState>((set, get) => ({
  cashUsd: 20000,
  totalNav: 100000,
  assets: [
    { id: 'equities', name: 'Equities', category: 'Equities', currentValue: 35000, allocationPercent: 35.0 },
    { id: 'gold', name: 'Gold', category: 'Gold', currentValue: 25000, allocationPercent: 25.0 },
    { id: 'usdCash', name: 'USD Cash', category: 'Cash', currentValue: 20000, allocationPercent: 20.0 },
    { id: 'realestate', name: 'Real Estate', category: 'Real Estate', currentValue: 12000, allocationPercent: 12.0 },
    { id: 'crypto', name: 'Crypto', category: 'Crypto', currentValue: 8000, allocationPercent: 8.0 }
  ],
  setCash: (cash: number) => set({ cashUsd: cash }),
  setTotalNav: (nav: number) => set({ totalNav: nav }),
  getTotalNav: () => {
    return get().totalNav;
  }
}));