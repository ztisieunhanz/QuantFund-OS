// ============================================================================
// FILE: src/lib/quant/timeDomain.ts
// MODULE: CANONICAL 1-HOUR BAR TIME-DOMAIN CONSTANTS
// PURPOSE: Single source of truth for all 1H quant time-unit assumptions.
//
// The current executable QuantFund OS engine is a 1-HOUR BAR ENGINE.
//   1 bar = 1 hour
//
// All quantitative calculations (annualization, holding periods, validUntil,
// event expiry) MUST use these constants, not raw numeric literals.
// ============================================================================

/** The canonical bar interval label for the production quant engine. */
export const QUANT_BAR_INTERVAL = "1h" as const;

/**
 * Duration of one bar in milliseconds.
 * 1 bar = 1 hour = 3_600_000 ms.
 * Do NOT use 86_400_000 (1 day) as a bar duration.
 */
export const BAR_DURATION_MS = 60 * 60 * 1000; // 3_600_000

/**
 * Number of 1H bars in one calendar year.
 * Used for annualizing volatility, Sharpe, Sortino, CAGR.
 * = 24 hours x 365 days = 8760.
 * Do NOT use 252 (trading days) as the bar-count per year.
 */
export const BARS_PER_YEAR = 24 * 365; // 8760

/**
 * Square root of BARS_PER_YEAR, pre-computed for use in Sharpe/Sortino/vol
 * annualization: annualizedSharpe = (mean / std) * ANNUALIZATION_FACTOR
 */
export const ANNUALIZATION_FACTOR = Math.sqrt(BARS_PER_YEAR);

/**
 * Explicit market-context required by PaperEngine.replay() and tradingStore.runOnBars().
 *
 * Both interval and source MUST be provided by the caller - no defaults allowed.
 * This enforces that the quant replay boundary carries full provenance.
 *
 *   interval: The candlestick interval of the bars being passed in.
 *             Must equal QUANT_BAR_INTERVAL ("1h") for replay to proceed.
 *             Any other value causes an immediate neutral reset / rejection.
 *
 *   source:   Provenance of the bars ("live" = Binance, "synthetic" = fallback).
 *             Mapped 1:1 to BacktestConfig.dataQuality - no default-to-LIVE path.
 */
export interface QuantReplayMarketContext {
  readonly interval: string;             // compared against QUANT_BAR_INTERVAL
  readonly source: "live" | "synthetic"; // no default - caller must be explicit
}
