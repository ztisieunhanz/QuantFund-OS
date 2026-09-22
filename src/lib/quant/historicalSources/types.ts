// ============================================================================
// FILE: src/lib/quant/historicalSources/types.ts
// MODULE: HISTORICAL MARKET-OBSERVED SOURCE DEFINITIONS & PARSER CONTRACTS (GATE M12C-R)
// ============================================================================

import type {
  HistoricalMarketObservation,
  HistoricalMacroRelease,
  HistoricalEventRecord,
} from "../historicalPit";

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

// ============================================================================
// MACROECONOMIC RELEASES & EVENT CONTRACTS (GATE M12D)
// ============================================================================

/**
 * Supported macroeconomic series identifiers in Gate M12D.
 */
export type MacroSeriesId =
  | "US_CPI_YOY"
  | "US_CPI_MOM"
  | "US_CPI_INDEX"
  | "US_NFP_NET_CHANGE"
  | "US_UNEMPLOYMENT_RATE"
  | "US_FED_FUNDS_TARGET_UPPER";

/**
 * Explicit release witness for Bureau of Labor Statistics (BLS) reports.
 * Fail closed: releaseDate is required. releaseTime defaults to official 08:30 ET.
 */
export interface BlsReleaseWitness {
  readonly observationPeriod: string; // YYYY-MM e.g. "2024-01"
  readonly releaseDate: string;        // YYYY-MM-DD e.g. "2024-02-13"
  readonly releaseTime?: string;       // "HH:mm" e.g. "08:30" (default)
  readonly timeZone?: string;          // IANA timeZone, default "America/New_York"
  readonly vintageDate?: string;       // Date-level vintage string from ALFRED (NOT timestamp)
  readonly revisionIndex?: number;     // 0 = initial release, 1 = first revision, etc.
}

/**
 * Explicit release witness for Federal Reserve FOMC decisions and statements.
 * Fail closed: BOTH releaseDate AND explicit releaseTime are REQUIRED (no blind 14:00 default).
 */
export interface FomcReleaseWitness {
  readonly meetingDate: string;        // YYYY-MM-DD e.g. "2024-01-31"
  readonly releaseDate: string;        // YYYY-MM-DD e.g. "2024-01-31"
  readonly releaseTime: string;        // "HH:mm" e.g. "14:00" (REQUIRED witness)
  readonly timeZone?: string;          // default "America/New_York"
}

/**
 * Raw input payload for BLS CPI releases.
 */
export interface RawBlsCpiObservation {
  readonly observationPeriod: string;           // "YYYY-MM"
  readonly releaseId?: string;                  // Official BLS USDL release identifier e.g. "USDL-24-0265"
  readonly cpiYoY?: number | string | null;     // Headline YoY % change (Table A published change)
  readonly cpiMoM?: number | string | null;     // Monthly % change (Table A published change)
  readonly cpiIndex?: number | string | null;   // Level index (CUUR0000SA0 / CUSR0000SA0 index level)
  readonly underlyingLevelSeriesId?: string;    // e.g. "CUUR0000SA0" (Unadjusted) or "CUSR0000SA0" (Adjusted)
  readonly releaseDate: string;                 // YYYY-MM-DD
  readonly releaseTime?: string;                // "HH:mm" (default 08:30)
  readonly revisionIndex?: number;              // default 0
  readonly vintageDate?: string;                // Date-level vintage
}

/**
 * Raw input payload for BLS Employment Situation releases.
 */
export interface RawBlsEmploymentObservation {
  readonly observationPeriod: string;           // "YYYY-MM"
  readonly releaseId?: string;                  // Official BLS USDL release identifier e.g. "USDL-24-0148"
  readonly nfpNetChangeThousands: number | string;// Net change in thousands (e.g. 353 for +353k)
  readonly underlyingLevelSeriesId?: string;    // "CES0000000001" (Employment LEVEL, NOT net monthly change)
  readonly unemploymentRate?: number | string | null;// % e.g. 3.7 (Household Survey LNS14000000 - distinct!)
  readonly releaseDate: string;                 // YYYY-MM-DD
  readonly releaseTime?: string;                // "HH:mm" (default 08:30)
  readonly revisionIndex?: number;              // default 0
  readonly vintageDate?: string;                // Date-level vintage
}

/**
 * Raw input payload for FOMC meeting statement / rate decision.
 */
export interface RawFomcStatementObservation {
  readonly eventId?: string;
  readonly meetingDate: string;                 // YYYY-MM-DD
  readonly releaseDate: string;                 // YYYY-MM-DD
  readonly releaseTime: string;                 // "HH:mm" REQUIRED
  readonly eventType?: "FED_RATE_DECISION" | "FOMC_STATEMENT";
  readonly targetRateUpper?: number | string | null;// % e.g. 5.50
  readonly targetRateLower?: number | string | null;// % e.g. 5.25
  readonly previousTargetRateUpper?: number | string | null;
  readonly statementText?: string;
  readonly isQualitativeOnly?: boolean;
}

/**
 * Result returned by macroeconomic parser functions.
 */
export type MacroReleaseParserResult =
  | {
      readonly success: true;
      readonly macroReleases: readonly HistoricalMacroRelease[];
      readonly eventRecords: readonly HistoricalEventRecord[];
      readonly metadata: {
        readonly count: number;
        readonly seriesIds: readonly string[];
        readonly provider: string;
      };
    }
  | {
      readonly success: false;
      readonly error: string;
    };
