// ============================================================================
// FILE: src/types/market.ts
// MODULE: APPLICATION DOMAIN TYPES
// ============================================================================

import type { OrderSide, PositionSide } from "@/lib/quant/types";

export type ViewId = "macro" | "charts" | "lab";

export interface OhlcvBar {
  readonly time: number; // Giây hoặc ms
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

export interface TimeSeriesPoint {
  readonly time: number;
  readonly value: number;
}

export interface MacroSeries {
  readonly id: "dxy" | "us10y" | "gold" | "btc" | "us2y" | "vix";
  readonly ticker: string;
  readonly name: string;
  readonly points: readonly TimeSeriesPoint[];
  readonly last: number;
  readonly change1d: number;
  readonly changePct1d: number;
  readonly changePct20d: number;
  readonly source: "live" | "synthetic";
}

export type RegimeLabel =
  | "Liquidity Drain"
  | "Risk-On Expansion"
  | "Stagflation Hedge"
  | "Flight to Dollar"
  | "Goldilocks"
  | "Transitional Mixed";

export interface AllocationWeights {
  readonly realEstate: number;
  readonly gold: number;
  readonly usdCash: number;
  readonly equities: number;
  readonly crypto: number;
}

export interface RegimeResult {
  readonly score: number;
  readonly label: RegimeLabel;
  readonly thesis: string;
  readonly dxyTrend: number;
  readonly yieldLevel: number;
  readonly yieldTrend: number;
  readonly allocation: AllocationWeights;
}

export type AssetKey = "dxy" | "us10y" | "gold" | "btc";

export type CorrelationMatrix = Record<AssetKey, Record<AssetKey, number>>;

// Định danh chuẩn: 3 Alpha độc lập + Omega Fund + 1 Benchmark đối chứng
export type QuantBotId = "trend" | "event" | "meanrev" | "omega" | "benchmark_dca";

export interface TradeFill {
  readonly id: string;
  readonly botId: QuantBotId;
  readonly time: number;
  readonly side: OrderSide;
  readonly price: number;
  readonly qty: number;
  readonly fee: number;
  readonly slippage: number;
  readonly notional: number;
}

export interface EquityPoint {
  readonly time: number;
  readonly equity: number;
}

export interface BotMetrics {
  readonly botId: QuantBotId;
  readonly name: string;
  readonly cash: number;
  readonly qty: number;
  readonly lastPrice: number;
  readonly equity: number;
  readonly pnl: number;
  readonly pnlPct: number;
  readonly winRate: number;
  readonly maxDrawdown: number;
  readonly totalTrades: number;
  readonly wins: number;
  readonly losses: number;
  readonly position: PositionSide; // LONG | SHORT | FLAT
  readonly lastSignal: string;
  readonly trades: readonly TradeFill[];
  readonly equityCurve: readonly EquityPoint[];
}