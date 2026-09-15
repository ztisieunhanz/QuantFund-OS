export type ViewId = "macro" | "charts" | "lab";

export interface OhlcvBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TimeSeriesPoint {
  time: number;
  value: number;
}

export interface MacroSeries {
  id: "dxy" | "us10y" | "gold" | "btc" | "us2y" | "vix";
  ticker: string;
  name: string;
  points: TimeSeriesPoint[];
  last: number;
  change1d: number;
  changePct1d: number;
  changePct20d: number;
  source: "live" | "synthetic";
}

export type RegimeLabel =
  | "Liquidity Drain"
  | "Risk-On Expansion"
  | "Stagflation Hedge"
  | "Flight to Dollar"
  | "Goldilocks"
  | "Transitional Mixed";

export interface AllocationWeights {
  realEstate: number;
  gold: number;
  usdCash: number;
  equities: number;
  crypto: number;
}

export interface RegimeResult {
  score: number;
  label: RegimeLabel;
  thesis: string;
  dxyTrend: number;
  yieldLevel: number;
  yieldTrend: number;
  allocation: AllocationWeights;
}

export type AssetKey = "dxy" | "us10y" | "gold" | "btc";

export type CorrelationMatrix = Record<AssetKey, Record<AssetKey, number>>;

export type Side = "BUY" | "SELL";

export interface TradeFill {
  id: string;
  botId: "trend" | "meanrev";
  time: number;
  side: Side;
  price: number;
  qty: number;
  fee: number;
  slippage: number;
  notional: number;
}

export interface EquityPoint {
  time: number;
  equity: number;
}

export interface BotMetrics {
  botId: "trend" | "meanrev";
  name: string;
  cash: number;
  qty: number;
  lastPrice: number;
  equity: number;
  pnl: number;
  pnlPct: number;
  winRate: number;
  maxDrawdown: number;
  totalTrades: number;
  wins: number;
  losses: number;
  position: "LONG" | "FLAT";
  lastSignal: string;
  trades: TradeFill[];
  equityCurve: EquityPoint[];
}