// ============================================================================
// FILE: src/lib/macro/vndirectParsers.ts
// MODULE: VIETNAM LAYER 1 DETERMINISTIC PARSERS & CALCULATORS (GATE M6E-3)
// PRINCIPLE: Fail-Closed Authoritative Universe Reconciliation & Layer 1 Telemetry (DEC-013, DEC-014)
// ============================================================================

import type {
  VietnamBreadthData,
  VietnamForeignFlowData,
  VietnamLiquidityData,
} from "./types";
import {
  getClosesUpToDate,
  type PerSecurityHistoryMap,
} from "./vietnamHistory";

export interface ParsedStockPriceRow {
  readonly code: string;
  readonly date: string;
  readonly close: number;
  readonly basicPrice: number;
  readonly nmValue: number;
}

export interface ParsedForeignRow {
  readonly code: string;
  readonly tradingDate: string;
  readonly netVal: number;
}

export type Result<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly error: string };

/**
 * Parses Security Master payload into an authoritative HOSE common-equity universe set.
 * Criteria: floor === "HOSE", type === "STOCK", status === "listed".
 * Fails closed on malformed rows, duplicate symbols, or empty payload.
 */
export function parseVndirectSecurityMaster(
  rawPayload: unknown
): Result<Set<string>> {
  if (!rawPayload || typeof rawPayload !== "object") {
    return { success: false, error: "Invalid Security Master payload structure" };
  }

  const items = Array.isArray(rawPayload)
    ? rawPayload
    : Array.isArray((rawPayload as { data?: unknown[] }).data)
    ? (rawPayload as { data: unknown[] }).data
    : null;

  if (!items || items.length === 0) {
    return { success: false, error: "Security Master payload contains no data items" };
  }

  const symbolSet = new Set<string>();

  for (const item of items) {
    if (!item || typeof item !== "object") {
      return { success: false, error: "Malformed item in Security Master payload" };
    }

    const rec = item as Record<string, unknown>;
    const code = typeof rec.code === "string" ? rec.code.trim().toUpperCase() : null;
    const floor = typeof rec.floor === "string" ? rec.floor.trim().toUpperCase() : null;
    const type = typeof rec.type === "string" ? rec.type.trim().toUpperCase() : null;
    const status = typeof rec.status === "string" ? rec.status.trim().toLowerCase() : null;

    if (!code) {
      return { success: false, error: "Security Master row missing required 'code' field" };
    }

    // Filter strictly for HOSE listed common equities
    if (floor === "HOSE" && type === "STOCK" && status === "listed") {
      if (symbolSet.has(code)) {
        // Fail closed on duplicate symbol in Security Master
        return {
          success: false,
          error: `Duplicate symbol '${code}' detected in authoritative Security Master`,
        };
      }
      symbolSet.add(code);
    }
  }

  if (symbolSet.size === 0) {
    return {
      success: false,
      error: "No HOSE listed common equity stocks matched Security Master filters",
    };
  }

  return { success: true, data: symbolSet };
}

/**
 * Parses stock_prices payload for a target session date and reconciles against authoritative universe.
 * Fails closed if any symbol in authoritativeSymbols is missing or duplicated.
 */
export function parseVndirectStockPrices(
  rawPayload: unknown,
  targetDate: string,
  authoritativeSymbols: Set<string>
): Result<ParsedStockPriceRow[]> {
  if (!rawPayload || typeof rawPayload !== "object" || !targetDate) {
    return { success: false, error: "Invalid stock_prices payload or target date" };
  }

  const items = Array.isArray(rawPayload)
    ? rawPayload
    : Array.isArray((rawPayload as { data?: unknown[] }).data)
    ? (rawPayload as { data: unknown[] }).data
    : null;

  if (!items || items.length === 0) {
    return { success: false, error: `stock_prices payload empty for session ${targetDate}` };
  }

  const parsedRows: ParsedStockPriceRow[] = [];
  const seenSymbols = new Set<string>();

  for (const item of items) {
    if (!item || typeof item !== "object") {
      return { success: false, error: "Malformed row in stock_prices payload" };
    }

    const rec = item as Record<string, unknown>;
    const code = typeof rec.code === "string" ? rec.code.trim().toUpperCase() : null;
    const date = typeof rec.date === "string" ? rec.date.trim() : null;
    const close = typeof rec.close === "number" && Number.isFinite(rec.close) ? rec.close : null;
    const basicPrice =
      typeof rec.basicPrice === "number" && Number.isFinite(rec.basicPrice)
        ? rec.basicPrice
        : null;
    const nmValue =
      typeof rec.nmValue === "number" && Number.isFinite(rec.nmValue) ? rec.nmValue : null;

    if (!code || !date || close === null || basicPrice === null || nmValue === null) {
      return { success: false, error: `Malformed fields in stock_prices row for '${code || "unknown"}'` };
    }

    if (date !== targetDate) {
      return {
        success: false,
        error: `Row date '${date}' does not match target session date '${targetDate}'`,
      };
    }

    if (authoritativeSymbols.has(code)) {
      if (seenSymbols.has(code)) {
        return {
          success: false,
          error: `Duplicate symbol '${code}' in stock_prices session payload for ${targetDate}`,
        };
      }
      seenSymbols.add(code);
      parsedRows.push({ code, date, close, basicPrice, nmValue });
    }
  }

  // Universe Reconciliation Check: Every authoritative symbol MUST be present
  const missingSymbols: string[] = [];
  for (const authSymbol of authoritativeSymbols) {
    if (!seenSymbols.has(authSymbol)) {
      missingSymbols.push(authSymbol);
    }
  }

  if (missingSymbols.length > 0) {
    return {
      success: false,
      error: `Universe reconciliation failed: ${missingSymbols.length} authoritative symbols missing from session ${targetDate} payload (e.g. ${missingSymbols.slice(0, 3).join(", ")})`,
    };
  }

  return { success: true, data: parsedRows };
}

/**
 * Calculates EOD Breadth & Moving Average Breadth (Option A) for session targetDate.
 */
export function calculateVietnamBreadth(
  rows: ParsedStockPriceRow[],
  targetDate: string,
  historyMap: PerSecurityHistoryMap
): VietnamBreadthData {
  let advancing = 0;
  let declining = 0;
  let unchanged = 0;

  for (const row of rows) {
    if (row.close > row.basicPrice) {
      advancing++;
    } else if (row.close < row.basicPrice) {
      declining++;
    } else {
      unchanged++;
    }
  }

  // adRatio: null when declining == 0 (DEC-014)
  const adRatio = declining > 0 ? advancing / declining : null;

  // Calculate Option A SMA breadth for horizons H in {20, 50, 200}
  const calculatePctAboveMA = (H: number): number | null => {
    let eligibleCount = 0;
    let aboveCount = 0;

    for (const row of rows) {
      const history = getClosesUpToDate(historyMap, row.code, targetDate);

      // Require exactly >= H valid closes ending at targetDate
      if (history.length >= H) {
        eligibleCount++;
        // SMA_H includes targetDate close (latest H bars up to targetDate)
        const trailingH = history.slice(history.length - H);
        const sum = trailingH.reduce((acc, item) => acc + item.close, 0);
        const smaH = sum / H;

        if (row.close > smaH) {
          aboveCount++;
        }
      }
    }

    if (eligibleCount === 0) {
      return null;
    }

    return (aboveCount / eligibleCount) * 100;
  };

  return {
    advancing,
    declining,
    unchanged,
    adRatio,
    pctAboveMA20: calculatePctAboveMA(20),
    pctAboveMA50: calculatePctAboveMA(50),
    pctAboveMA200: calculatePctAboveMA(200),
  };
}

/**
 * Calculates HOSE Common-Equity Order-Matched Liquidity for session D and MA20 liquidity.
 * Requires exactly 20 valid completed market session payloads (current session + 19 historical).
 */
export function calculateVietnamLiquidity(
  currentSessionRows: ParsedStockPriceRow[],
  historical20SessionRows: ParsedStockPriceRow[][]
): Result<VietnamLiquidityData> {
  if (!historical20SessionRows || historical20SessionRows.length !== 20) {
    return {
      success: false,
      error: `Liquidity MA20 calculation requires exactly 20 completed session payloads (received ${historical20SessionRows?.length ?? 0})`,
    };
  }

  // Calculate matchingValueBillion for current session D
  const matchingValueBillion =
    currentSessionRows.reduce((acc, row) => acc + row.nmValue, 0) / 1e9;

  // Calculate matchingValueBillion for each of the 20 sessions
  const dailyMatchingValuesBillion: number[] = [];
  for (const sessionRows of historical20SessionRows) {
    const sessionSum = sessionRows.reduce((acc, row) => acc + row.nmValue, 0) / 1e9;
    dailyMatchingValuesBillion.push(sessionSum);
  }

  const sumMa20 = dailyMatchingValuesBillion.reduce((acc, val) => acc + val, 0);
  const ma20ValueBillion = sumMa20 / 20;

  const ratioToMa20 = matchingValueBillion / ma20ValueBillion;

  return {
    success: true,
    data: {
      matchingValueBillion,
      ma20ValueBillion,
      ratioToMa20,
      status: null,
    },
  };
}

/**
 * Parses and calculates Foreign Net Flow for session targetDate (net1dBillion) and 5-session rolling sum (net5dBillion).
 * Reconciles strictly against authoritative HOSE common equity universe.
 */
export function parseAndCalculateVietnamForeignFlow(
  currentPayload: unknown,
  targetDate: string,
  historical5Payloads: unknown[],
  authoritativeSymbols: Set<string>
): Result<VietnamForeignFlowData> {
  if (!historical5Payloads || historical5Payloads.length !== 5) {
    return {
      success: false,
      error: `Foreign Flow net5d calculation requires exactly 5 completed session payloads (received ${historical5Payloads?.length ?? 0})`,
    };
  }

  const parseSingleSessionForeign = (
    payload: unknown,
    sessionDate: string
  ): Result<number> => {
    if (!payload || typeof payload !== "object") {
      return { success: false, error: `Invalid foreign payload for session ${sessionDate}` };
    }

    const items = Array.isArray(payload)
      ? payload
      : Array.isArray((payload as { data?: unknown[] }).data)
      ? (payload as { data: unknown[] }).data
      : null;

    if (!items || items.length === 0) {
      return { success: false, error: `Foreign payload empty for session ${sessionDate}` };
    }

    let netSum = 0;
    const seenSymbols = new Set<string>();

    for (const item of items) {
      if (!item || typeof item !== "object") {
        return { success: false, error: "Malformed row in foreign payload" };
      }

      const rec = item as Record<string, unknown>;
      const code = typeof rec.code === "string" ? rec.code.trim().toUpperCase() : null;
      const tradingDate =
        typeof rec.tradingDate === "string"
          ? rec.tradingDate.trim()
          : typeof rec.date === "string"
          ? rec.date.trim()
          : null;
      const netVal = typeof rec.netVal === "number" && Number.isFinite(rec.netVal) ? rec.netVal : null;

      if (!code || !tradingDate || netVal === null) {
        return { success: false, error: `Malformed fields in foreign row for '${code || "unknown"}'` };
      }

      if (tradingDate !== sessionDate) {
        return {
          success: false,
          error: `Foreign row date '${tradingDate}' does not match expected session '${sessionDate}'`,
        };
      }

      if (authoritativeSymbols.has(code)) {
        if (seenSymbols.has(code)) {
          return {
            success: false,
            error: `Duplicate symbol '${code}' in foreign payload for ${sessionDate}`,
          };
        }
        seenSymbols.add(code);
        netSum += netVal;
      }
    }

    // Reconciliation check
    const missingSymbols: string[] = [];
    for (const authSymbol of authoritativeSymbols) {
      if (!seenSymbols.has(authSymbol)) {
        missingSymbols.push(authSymbol);
      }
    }

    if (missingSymbols.length > 0) {
      return {
        success: false,
        error: `Foreign flow universe reconciliation failed: ${missingSymbols.length} authoritative symbols missing for session ${sessionDate}`,
      };
    }

    return { success: true, data: netSum / 1e9 };
  };

  // Parse current session net1d
  const currentNetResult = parseSingleSessionForeign(currentPayload, targetDate);
  if (!currentNetResult.success) {
    return currentNetResult;
  }

  const net1dBillion = currentNetResult.data;

  // Calculate 5-session rolling net5d
  let net5dSum = 0;
  for (const sessionPayload of historical5Payloads) {
    // Extract date from first valid row
    const items = Array.isArray(sessionPayload)
      ? sessionPayload
      : (sessionPayload as { data?: unknown[] })?.data ?? [];
    const firstRow = items[0] as Record<string, unknown> | undefined;
    const sessionDate =
      typeof firstRow?.tradingDate === "string"
        ? firstRow.tradingDate.trim()
        : typeof firstRow?.date === "string"
        ? firstRow.date.trim()
        : targetDate;

    const sessionResult = parseSingleSessionForeign(sessionPayload, sessionDate);
    if (!sessionResult.success) {
      return sessionResult;
    }
    net5dSum += sessionResult.data;
  }

  const net5dBillion = net5dSum;

  return {
    success: true,
    data: {
      net1dBillion,
      net5dBillion,
      status: null,
    },
  };
}
