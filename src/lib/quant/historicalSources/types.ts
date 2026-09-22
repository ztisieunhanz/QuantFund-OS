// ============================================================================
// FILE: src/lib/quant/historicalSources/types.ts
// MODULE: HISTORICAL MARKET-OBSERVED SOURCE DEFINITIONS & PARSER CONTRACTS (GATE M12C-R)
// ============================================================================

import type { HistoricalMarketObservation } from "../historicalPit";

/**
 * Supported market-observed series in Gate M12C & M12C-R.
 */
export type MarketSeriesId =
  | "BTC"
  | "PAXG"
  | "DXY"
  | "US2Y"
  | "US10Y"
  | "VIX";

/**
 * Continuous intraday bar availability policy (e.g. 24/7 crypto klines).
 * Availability occurs strictly at the completion of the candle period.
 */
export interface ContinuousKlinePolicy {
  readonly kind: "INTRADAY_KLINE";
  readonly description: string;
  readonly intervalMs: number;
}

/**
 * Daily session availability policy based on official market close or publication window.
 * Availability occurs at a verified local wall-clock time in the authoritative IANA timezone
 * (e.g. "America/New_York"), dynamically converted to UTC based on the historical session date.
 * NO FIXED UTC OFFSETS ALLOWED ACROSS DST TRANSITIONS.
 */
export interface DailySessionPolicy {
  readonly kind: "DAILY_SESSION";
  readonly description: string;
  readonly localTime: string; // "HH:mm" or "HH:mm:ss"
  readonly timeZone: string;   // IANA timeZone, e.g. "America/New_York"
}

export type AvailabilityPolicy = ContinuousKlinePolicy | DailySessionPolicy;

/**
 * Authoritative availability policies for M12C-R market series:
 *
 * 1. BTC (Binance 1H): Available at candle completion boundary (openTime + 3,600,000 ms).
 * 2. PAXG (Binance 1H): Available at candle completion boundary (openTime + 3,600,000 ms).
 * 3. US2Y / US10Y (Federal Reserve H.15 Selected Interest Rates): Daily CMT par yields
 *    published Monday-Friday at 16:15 America/New_York on an explicit releaseDate.
 *    (21:15 UTC in winter EST, 20:15 UTC in summer EDT). Fails closed if releaseDate is missing.
 * 4. DXY (ICE Dollar Index via Yahoo): New York forex desks close at 17:00 ET;
 *    ICE futures settlement window is 14:59-15:00 ET. Conservative post-session boundary:
 *    18:00 America/New_York (23:00 UTC in winter EST, 22:00 UTC in summer EDT).
 * 5. VIX (CBOE via Yahoo): Regular trading hours for VIX index calculation conclude at
 *    16:15 America/New_York (21:15 UTC in winter EST, 20:15 UTC in summer EDT).
 */
export const MARKET_AVAILABILITY_POLICIES: Record<MarketSeriesId, AvailabilityPolicy> = {
  BTC: {
    kind: "INTRADAY_KLINE",
    description: "Binance 1H Kline close boundary (openTime + 3,600,000 ms)",
    intervalMs: 3_600_000,
  },
  PAXG: {
    kind: "INTRADAY_KLINE",
    description: "Binance 1H Kline close boundary (openTime + 3,600,000 ms)",
    intervalMs: 3_600_000,
  },
  US2Y: {
    kind: "DAILY_SESSION",
    description: "Federal Reserve H.15 Selected Interest Rates publication boundary (16:15 America/New_York on explicit releaseDate)",
    localTime: "16:15",
    timeZone: "America/New_York",
  },
  US10Y: {
    kind: "DAILY_SESSION",
    description: "Federal Reserve H.15 Selected Interest Rates publication boundary (16:15 America/New_York on explicit releaseDate)",
    localTime: "16:15",
    timeZone: "America/New_York",
  },
  DXY: {
    kind: "DAILY_SESSION",
    description: "ICE US Dollar Index via Yahoo conservative post-session availability boundary (18:00 America/New_York)",
    localTime: "18:00",
    timeZone: "America/New_York",
  },
  VIX: {
    kind: "DAILY_SESSION",
    description: "CBOE Volatility Index regular trading close boundary (16:15 America/New_York)",
    localTime: "16:15",
    timeZone: "America/New_York",
  },
};

/**
 * Result returned by historical provider parsers.
 */
export type MarketSeriesParserResult =
  | {
      readonly success: true;
      readonly seriesId: MarketSeriesId;
      readonly observations: readonly HistoricalMarketObservation[];
      readonly metadata: {
        readonly count: number;
        readonly firstAvailableAt: number | null;
        readonly lastAvailableAt: number | null;
        readonly provider: string;
        readonly unit: string;
      };
    }
  | {
      readonly success: false;
      readonly seriesId: MarketSeriesId;
      readonly error: string;
    };
