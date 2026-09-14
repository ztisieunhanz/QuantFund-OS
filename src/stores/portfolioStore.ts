import { create } from "zustand";

export interface Asset {
  id: string;
  name: string;
  allocation: number; // Tỷ trọng mục tiêu %
  currentValue: number; // Giá trị thực tế (USD)
}

interface PortfolioState {
  cashUsd: number;
  assets: Asset[];
  updateAssetValue: (id: string, value: number) => void;
  updateCash: (amount: number) => void;
  getTotalNav: () => number;
}

export const usePortfolioStore = create<PortfolioState>((set, get) => ({
  cashUsd: 15000, // Tiền mặt ban đầu
  assets: [
    { id: "btc", name: "Bitcoin", allocation: 40, currentValue: 25000 },
    { id: "gold", name: "Vàng XAU", allocation: 20, currentValue: 10000 },
    { id: "realestate", name: "Bất động sản", allocation: 40, currentValue: 50000 },
  ],
  
  updateAssetValue: (id, value) => set((state) => ({
    assets: state.assets.map(a => a.id === id ? { ...a, currentValue: value } : a)
  })),
  
  updateCash: (amount) => set({ cashUsd: amount }),
  
  getTotalNav: () => {
    const { cashUsd, assets } = get();
    return cashUsd + assets.reduce((sum, a) => sum + a.currentValue, 0);
  }
}));