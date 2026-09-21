// ============================================================================
// FILE: src/lib/macro/vietnamHistory.ts
// MODULE: VIETNAM EOD PER-SECURITY CLOSE HISTORY MANAGEMENT (GATE M6E-3)
// PRINCIPLE: Deterministic Per-Security Historical State for SMA (DEC-014)
// ============================================================================

export interface SecurityCloseItem {
  readonly date: string;  // YYYY-MM-DD
  readonly close: number;
}

export type PerSecurityHistoryMap = Map<string, SecurityCloseItem[]>;

export const MAX_SECURITY_HISTORY_BARS = 200;

/**
 * Creates a clean per-security history map.
 */
export function createEmptyHistoryMap(): PerSecurityHistoryMap {
  return new Map<string, SecurityCloseItem[]>();
}

/**
 * Adds or updates a completed EOD close observation for a security symbol.
 * - Unique session date per symbol (updates if date already exists).
 * - Chronologically sorted by date (YYYY-MM-DD).
 * - Capped at maximum 200 latest valid completed sessions.
 * - Rejects non-finite close or invalid date format.
 * - Zero synthetic data, zero forward fill, zero interpolation.
 */
export function addSecurityCloseObservation(
  historyMap: PerSecurityHistoryMap,
  symbol: string,
  date: string,
  close: number
): PerSecurityHistoryMap {
  if (!symbol || !date || typeof close !== "number" || !Number.isFinite(close)) {
    return historyMap;
  }

  // Validate YYYY-MM-DD date format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return historyMap;
  }

  const normalizedSymbol = symbol.trim().toUpperCase();
  const existingHistory = historyMap.get(normalizedSymbol) || [];

  // Check if date already exists in history
  const existingIndex = existingHistory.findIndex((item) => item.date === date);

  let updatedHistory: SecurityCloseItem[];

  if (existingIndex >= 0) {
    // Update existing observation
    updatedHistory = [...existingHistory];
    updatedHistory[existingIndex] = { date, close };
  } else {
    // Append new observation
    updatedHistory = [...existingHistory, { date, close }];
  }

  // Sort chronologically by YYYY-MM-DD string
  updatedHistory.sort((a, b) => a.date.localeCompare(b.date));

  // Cap at latest 200 sessions
  if (updatedHistory.length > MAX_SECURITY_HISTORY_BARS) {
    updatedHistory = updatedHistory.slice(updatedHistory.length - MAX_SECURITY_HISTORY_BARS);
  }

  historyMap.set(normalizedSymbol, updatedHistory);
  return historyMap;
}

/**
 * Returns chronological historical closes for a security up to and including maxDate.
 * Guarantees zero future bars enter calculations.
 */
export function getClosesUpToDate(
  historyMap: PerSecurityHistoryMap,
  symbol: string,
  maxDate: string
): SecurityCloseItem[] {
  const normalizedSymbol = symbol.trim().toUpperCase();
  const history = historyMap.get(normalizedSymbol) || [];
  return history.filter((item) => item.date.localeCompare(maxDate) <= 0);
}
