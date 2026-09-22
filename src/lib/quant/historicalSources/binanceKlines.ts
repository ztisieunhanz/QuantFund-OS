// ============================================================================
// FILE: src/lib/quant/historicalSources/binanceKlines.ts
// MODULE: BINANCE 1H HISTORICAL KLINES PARSER (GATE M12C)
// PRINCIPLE: Bar-Close Availability Boundary Without Lookahead (BTC & PAXG)
// ============================================================================

import {
  type HistoricalMarketObservation,
  validateHistoricalMarketObservation,
} from "../historicalPit";
import type { MarketSeriesParserResult } from "./types";

export const ONE_HOUR_MS = 3_600_000;

export interface BinanceKlineParserOptions {
  readonly seriesId: "BTC" | "PAXG";
}

/**
 * Parses raw Binance 1H klines payload into normalized HistoricalMarketObservation[].
 *
 * AVAILABILITY INVARIANT (Requirement 4 & 5):
 * - Binance row[0] is candle openTime.
 * - Binance row[4] is candle close price.
 * - Binance row[6] is candle closeTime (openTime + 3,599,999 ms).
 * - A candle's final close price is ONLY knowable at candle completion (openTime + 3,600,000 ms).
 * - Therefore: availableAt = openTime + ONE_HOUR_MS.
 *
 * TRUTHFUL PROVENANCE:
 * - PAXG is preserved with instrument identity PAXGUSDT (PAXG tokenized gold).
 * - It is NEVER mislabeled as literal OTC spot XAU.
 */
export function parseBinance1HKlines(
  rawKlines: unknown,
  options: BinanceKlineParserOptions
): MarketSeriesParserResult {
  const { seriesId } = options;

  if (!Array.isArray(rawKlines)) {
    return {
      success: false,
      seriesId,
      error: `Binance ${seriesId} payload is not an array.`,
    };
  }

  if (rawKlines.length === 0) {
    return {
      success: true,
      seriesId,
      observations: [],
      metadata: {
        count: 0,
        firstAvailableAt: null,
        lastAvailableAt: null,
        provider: "BINANCE",
        unit: "USD",
      },
    };
  }

  const observations: HistoricalMarketObservation[] = [];

  for (let i = 0; i < rawKlines.length; i++) {
    const row = rawKlines[i];

    if (!Array.isArray(row) || row.length < 7) {
      return {
        success: false,
        seriesId,
        error: `Malformed Binance kline row at index ${i}: expected array with at least 7 fields.`,
      };
    }

    const openTime = Number(row[0]);
    const closeStr = row[4] != null ? String(row[4]).trim() : "";
    const closePrice = parseFloat(closeStr);
    const closeTime = Number(row[6]);

    if (!Number.isFinite(openTime) || openTime < 0) {
      return {
        success: false,
        seriesId,
        error: `Invalid openTime at index ${i}: ${row[0]} is not a finite non-negative epoch ms.`,
      };
    }

    if (!Number.isFinite(closePrice) || closePrice <= 0) {
      return {
        success: false,
        seriesId,
        error: `Invalid close price at index ${i}: "${closeStr}" parsed to non-finite or non-positive value.`,
      };
    }

    if (!Number.isFinite(closeTime) || closeTime < openTime) {
      return {
        success: false,
        seriesId,
        error: `Invalid closeTime at index ${i}: ${row[6]} is less than openTime ${openTime}.`,
      };
    }

    // Candle completion boundary: exactly openTime + ONE_HOUR_MS
    const availableAt = openTime + ONE_HOUR_MS;

    const obs: HistoricalMarketObservation = {
      seriesId,
      value: closePrice,
      observationTime: openTime,
      availableAt,
      providerTimestamp: closeTime,
      provider: "BINANCE",
      unit: "USD",
    };

    try {
      validateHistoricalMarketObservation(obs);
    } catch (err) {
      return {
        success: false,
        seriesId,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    observations.push(obs);
  }

  return {
    success: true,
    seriesId,
    observations,
    metadata: {
      count: observations.length,
      firstAvailableAt: observations[0]?.availableAt ?? null,
      lastAvailableAt: observations[observations.length - 1]?.availableAt ?? null,
      provider: "BINANCE",
      unit: "USD",
    },
  };
}
