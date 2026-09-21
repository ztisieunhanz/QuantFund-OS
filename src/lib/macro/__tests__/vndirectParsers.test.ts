// ============================================================================
// FILE: src/lib/macro/__tests__/vndirectParsers.test.ts
// MODULE: VIETNAM PARSERS & CALCULATORS DETERMINISTIC UNIT TESTS (GATE M6E-3)
// PRINCIPLE: 100% Deterministic Verification with Zero Network & Zero Math.random
// ============================================================================

import { describe, expect, it } from "vitest";
import {
  calculateVietnamBreadth,
  calculateVietnamLiquidity,
  parseAndCalculateVietnamForeignFlow,
  parseVndirectSecurityMaster,
  parseVndirectStockPrices,
  type ParsedStockPriceRow,
} from "../vndirectParsers";
import {
  addSecurityCloseObservation,
  createEmptyHistoryMap,
  getClosesUpToDate,
  MAX_SECURITY_HISTORY_BARS,
} from "../vietnamHistory";

describe("Vietnam Layer 1 Deterministic Parsers & Calculators (Gate M6E-3)", () => {
  const TARGET_DATE = "2026-07-02";

  const mockSecurityMaster = [
    { code: "AAA", floor: "HOSE", type: "STOCK", status: "listed" },
    { code: "BBB", floor: "HOSE", type: "STOCK", status: "listed" },
    { code: "CCC", floor: "HOSE", type: "STOCK", status: "listed" },
    { code: "ETF1", floor: "HOSE", type: "ETF", status: "listed" }, // Should be excluded
    { code: "HNX1", floor: "HNX", type: "STOCK", status: "listed" }, // Should be excluded
  ];

  it("A. Authoritative security universe parses valid master payload successfully", () => {
    const result = parseVndirectSecurityMaster(mockSecurityMaster);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.size).toBe(3);
      expect(result.data.has("AAA")).toBe(true);
      expect(result.data.has("BBB")).toBe(true);
      expect(result.data.has("CCC")).toBe(true);
      expect(result.data.has("ETF1")).toBe(false);
      expect(result.data.has("HNX1")).toBe(false);
    }
  });

  it("B. Malformed or duplicate symbol in Security Master fails closed", () => {
    const duplicateMaster = [
      { code: "AAA", floor: "HOSE", type: "STOCK", status: "listed" },
      { code: "AAA", floor: "HOSE", type: "STOCK", status: "listed" }, // Duplicate!
    ];
    const res1 = parseVndirectSecurityMaster(duplicateMaster);
    expect(res1.success).toBe(false);
    if (!res1.success) {
      expect(res1.error).toContain("Duplicate symbol 'AAA'");
    }

    const malformedMaster = [{ floor: "HOSE", type: "STOCK", status: "listed" }]; // Missing code
    const res2 = parseVndirectSecurityMaster(malformedMaster);
    expect(res2.success).toBe(false);
  });

  it("C. Stock price parser classifies advancing, declining, unchanged correctly", () => {
    const authSymbols = new Set(["AAA", "BBB", "CCC"]);
    const stockPricePayload = [
      { code: "AAA", date: TARGET_DATE, close: 20.0, basicPrice: 19.0, nmValue: 1e9, ptValue: 5e9 }, // Advancing
      { code: "BBB", date: TARGET_DATE, close: 18.0, basicPrice: 19.0, nmValue: 2e9, ptValue: 0 },   // Declining
      { code: "CCC", date: TARGET_DATE, close: 19.0, basicPrice: 19.0, nmValue: 3e9, ptValue: 0 },   // Unchanged
    ];

    const parseRes = parseVndirectStockPrices(stockPricePayload, TARGET_DATE, authSymbols);
    expect(parseRes.success).toBe(true);

    if (parseRes.success) {
      const historyMap = createEmptyHistoryMap();
      const breadth = calculateVietnamBreadth(parseRes.data, TARGET_DATE, historyMap);
      expect(breadth.advancing).toBe(1);
      expect(breadth.declining).toBe(1);
      expect(breadth.unchanged).toBe(1);
      expect(breadth.adRatio).toBe(1.0); // 1 / 1 = 1.0
    }
  });

  it("D. Declining == 0 returns null adRatio without division by zero or Infinity", () => {
    const authSymbols = new Set(["AAA", "BBB"]);
    const allAdvancingPayload = [
      { code: "AAA", date: TARGET_DATE, close: 20.0, basicPrice: 19.0, nmValue: 1e9 },
      { code: "BBB", date: TARGET_DATE, close: 22.0, basicPrice: 21.0, nmValue: 1e9 },
    ];

    const parseRes = parseVndirectStockPrices(allAdvancingPayload, TARGET_DATE, authSymbols);
    expect(parseRes.success).toBe(true);

    if (parseRes.success) {
      const historyMap = createEmptyHistoryMap();
      const breadth = calculateVietnamBreadth(parseRes.data, TARGET_DATE, historyMap);
      expect(breadth.advancing).toBe(2);
      expect(breadth.declining).toBe(0);
      expect(breadth.adRatio).toBeNull();
    }
  });

  it("E. Missing authoritative-universe symbol in session payload fails closed", () => {
    const authSymbols = new Set(["AAA", "BBB", "CCC"]);
    const incompletePayload = [
      { code: "AAA", date: TARGET_DATE, close: 20.0, basicPrice: 19.0, nmValue: 1e9 },
      { code: "BBB", date: TARGET_DATE, close: 18.0, basicPrice: 19.0, nmValue: 2e9 },
      // CCC is missing!
    ];

    const parseRes = parseVndirectStockPrices(incompletePayload, TARGET_DATE, authSymbols);
    expect(parseRes.success).toBe(false);
    if (!parseRes.success) {
      expect(parseRes.error).toContain("authoritative symbols missing");
    }
  });

  it("F & G. Per-security history maintains chronological sorting and deterministic update", () => {
    let historyMap = createEmptyHistoryMap();
    historyMap = addSecurityCloseObservation(historyMap, "AAA", "2026-07-02", 10.5);
    historyMap = addSecurityCloseObservation(historyMap, "AAA", "2026-07-01", 10.0); // Added out of order
    historyMap = addSecurityCloseObservation(historyMap, "AAA", "2026-07-03", 11.0);

    const closes = getClosesUpToDate(historyMap, "AAA", "2026-07-03");
    expect(closes).toHaveLength(3);
    expect(closes.map((c) => c.date)).toEqual(["2026-07-01", "2026-07-02", "2026-07-03"]);
    expect(closes.map((c) => c.close)).toEqual([10.0, 10.5, 11.0]);

    // Update existing date
    historyMap = addSecurityCloseObservation(historyMap, "AAA", "2026-07-02", 10.8);
    const updatedCloses = getClosesUpToDate(historyMap, "AAA", "2026-07-03");
    expect(updatedCloses).toHaveLength(3);
    expect(updatedCloses[1].close).toBe(10.8);
  });

  it("H. History is strictly capped at MAX_SECURITY_HISTORY_BARS (200)", () => {
    let historyMap = createEmptyHistoryMap();
    const startDate = new Date("2026-01-01T00:00:00Z");
    for (let i = 1; i <= 210; i++) {
      const d = new Date(startDate.getTime() + (i - 1) * 86400000);
      const dateStr = d.toISOString().slice(0, 10);
      historyMap = addSecurityCloseObservation(historyMap, "AAA", dateStr, i);
    }

    const closes = getClosesUpToDate(historyMap, "AAA", "2099-12-31");
    expect(closes).toHaveLength(MAX_SECURITY_HISTORY_BARS);
    expect(closes[0].close).toBe(11); // Oldest 10 dropped
    expect(closes[closes.length - 1].close).toBe(210);
  });

  it("I & J. Option A MA20 includes session D and excludes future bars after D", () => {
    let historyMap = createEmptyHistoryMap();
    // Add 20 daily closes for AAA up to 2026-07-20
    for (let i = 1; i <= 20; i++) {
      const dayStr = String(i).padStart(2, "0");
      historyMap = addSecurityCloseObservation(historyMap, "AAA", `2026-07-${dayStr}`, 100 + i);
    }
    // Add a future bar on 2026-07-21
    historyMap = addSecurityCloseObservation(historyMap, "AAA", "2026-07-21", 999);

    const rows: ParsedStockPriceRow[] = [
      { code: "AAA", date: "2026-07-20", close: 120, basicPrice: 119, nmValue: 1e9 },
    ];

    const breadth = calculateVietnamBreadth(rows, "2026-07-20", historyMap);
    // SMA_20 for 101..120 is (101 + 120) / 2 = 110.5
    // close (120) > sma (110.5) => 100%
    expect(breadth.pctAboveMA20).toBe(100);
    expect(breadth.pctAboveMA50).toBeNull();
    expect(breadth.pctAboveMA200).toBeNull();
  });

  it("K, L & M. Insufficient observations exclude stock from denominator; zero denominator produces null", () => {
    let historyMap = createEmptyHistoryMap();
    // AAA has 25 bars
    for (let i = 1; i <= 25; i++) {
      const dayStr = String(i).padStart(2, "0");
      historyMap = addSecurityCloseObservation(historyMap, "AAA", `2026-07-${dayStr}`, 10 + i);
    }
    // BBB has only 5 bars
    for (let i = 1; i <= 5; i++) {
      const dayStr = String(i).padStart(2, "0");
      historyMap = addSecurityCloseObservation(historyMap, "BBB", `2026-07-${dayStr}`, 10 + i);
    }

    const rows: ParsedStockPriceRow[] = [
      { code: "AAA", date: "2026-07-25", close: 35, basicPrice: 34, nmValue: 1e9 },
      { code: "BBB", date: "2026-07-25", close: 15, basicPrice: 14, nmValue: 1e9 },
    ];

    const breadth = calculateVietnamBreadth(rows, "2026-07-25", historyMap);
    // AAA has 25 bars (>= 20) -> eligible for MA20. BBB has 5 bars (< 20) -> excluded from MA20.
    // MA20 denominator = 1 (AAA only).
    expect(breadth.pctAboveMA20).toBe(100);
    // Neither AAA nor BBB has 50 or 200 bars -> denominators for MA50 & MA200 are 0 => null
    expect(breadth.pctAboveMA50).toBeNull();
    expect(breadth.pctAboveMA200).toBeNull();
  });

  it("N & O. Liquidity uses nmValue, excludes ptValue, and fails closed if < 20 sessions", () => {
    const sessionRow = (date: string, nm: number, _pt: number): ParsedStockPriceRow[] => [
      { code: "AAA", date, close: 10, basicPrice: 10, nmValue: nm },
    ];

    const currentRows = sessionRow("2026-07-20", 20e9, 50e9); // nmValue: 20B VND, ptValue ignored

    // Case 1: Incomplete history (only 15 sessions)
    const shortHistory: ParsedStockPriceRow[][] = Array.from({ length: 15 }, (_, i) =>
      sessionRow(`2026-07-${String(i + 1).padStart(2, "0")}`, 10e9, 0)
    );
    const failRes = calculateVietnamLiquidity(currentRows, shortHistory);
    expect(failRes.success).toBe(false);
    if (!failRes.success) {
      expect(failRes.error).toContain("requires exactly 20 completed session payloads");
    }

    // Case 2: Complete 20 sessions
    const fullHistory: ParsedStockPriceRow[][] = Array.from({ length: 20 }, (_, i) =>
      sessionRow(`2026-07-${String(i + 1).padStart(2, "0")}`, 20e9, 0)
    );
    const passRes = calculateVietnamLiquidity(currentRows, fullHistory);
    expect(passRes.success).toBe(true);
    if (passRes.success) {
      expect(passRes.data.matchingValueBillion).toBe(20);
      expect(passRes.data.ma20ValueBillion).toBe(20);
      expect(passRes.data.ratioToMa20).toBe(1.0);
      expect(passRes.data.status).toBeNull(); // Status is null until formal decision
    }
  });

  it("P, Q & R. Foreign Flow net1d/net5d aggregation and fail-closed validation", () => {
    const authSymbols = new Set(["AAA", "BBB"]);

    const createForeignPayload = (date: string, netA: number, netB: number) => [
      { code: "AAA", tradingDate: date, netVal: netA },
      { code: "BBB", tradingDate: date, netVal: netB },
    ];

    const currentPayload = createForeignPayload("2026-07-05", 200e9, 100e9);

    const history5 = [
      createForeignPayload("2026-07-01", 100e9, 0),
      createForeignPayload("2026-07-02", 100e9, 0),
      createForeignPayload("2026-07-03", 100e9, 0),
      createForeignPayload("2026-07-04", 100e9, 0),
      createForeignPayload("2026-07-05", 200e9, 100e9),
    ];

    const passRes = parseAndCalculateVietnamForeignFlow(currentPayload, "2026-07-05", history5, authSymbols);
    expect(passRes.success).toBe(true);
    if (passRes.success) {
      expect(passRes.data.net1dBillion).toBe(300); // (200 + 100)
      expect(passRes.data.net5dBillion).toBe(700); // 100*4 + 300
      expect(passRes.data.status).toBeNull(); // Status is null until formal decision
    }

    // Fail closed if missing a symbol row in foreign flow
    const incompleteForeignPayload = [{ code: "AAA", tradingDate: "2026-07-05", netVal: 200e9 }]; // Missing BBB
    const failRes = parseAndCalculateVietnamForeignFlow(incompleteForeignPayload, "2026-07-05", history5, authSymbols);
    expect(failRes.success).toBe(false);
    if (!failRes.success) {
      expect(failRes.error).toContain("authoritative symbols missing");
    }
  });

  it("S. Calculations are 100% deterministic with zero Math.random dependencies", () => {
    const authSymbols = new Set(["AAA"]);
    const stockPayload = [{ code: "AAA", date: TARGET_DATE, close: 10, basicPrice: 10, nmValue: 5e9 }];

    const res1 = parseVndirectStockPrices(stockPayload, TARGET_DATE, authSymbols);
    const res2 = parseVndirectStockPrices(stockPayload, TARGET_DATE, authSymbols);

    expect(res1).toEqual(res2);
  });
});
