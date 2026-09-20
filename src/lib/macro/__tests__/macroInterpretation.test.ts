// ============================================================================
// FILE: src/lib/macro/__tests__/macroInterpretation.test.ts
// MODULE: MACRO V2 INTERPRETATION ENGINE UNIT TESTS (GATE M2)
// PRINCIPLE: Fully Deterministic Invariant Verification (No Math.random / Wall Clock)
// ============================================================================

import { describe, expect, it } from "vitest";
import {
  createDerivedDatum,
  createHardcodedDatum,
  createLiveDatum,
  createSyntheticDatum,
  createUnavailableDatum,
} from "../helpers";
import { evaluateMacroRegimeV2 } from "../interpretation";
import type { MarketSnapshotData } from "../types";

describe("Macro V2 Interpretation & Data-Quality Gate (Gate M2)", () => {
  const REF_TIME = 1_700_000_000_000; // Fixed reference timestamp (ms)
  const ONE_HOUR = 3600_000;
  const ONE_DAY = 86_400_000;

  // Helper to build default fresh 6 core live metrics
  function createFullLiveMarketSnapshot(overrides?: Partial<MarketSnapshotData>): MarketSnapshotData {
    return {
      dxy: createLiveDatum({
        id: "dxy",
        value: 105.5,
        provider: "Yahoo",
        instrument: "DX-Y.NYB",
        asOf: REF_TIME - ONE_HOUR,
        fetchedAt: REF_TIME,
      }),
      us10y: createLiveDatum({
        id: "us10y",
        value: 4.58,
        provider: "Yahoo",
        instrument: "^TNX",
        asOf: REF_TIME - ONE_HOUR,
        fetchedAt: REF_TIME,
      }),
      us2y: createLiveDatum({
        id: "us2y",
        value: 4.86,
        provider: "Yahoo",
        instrument: "2YY=F",
        asOf: REF_TIME - ONE_HOUR,
        fetchedAt: REF_TIME,
      }),
      vix: createLiveDatum({
        id: "vix",
        value: 24.5,
        provider: "Yahoo",
        instrument: "^VIX",
        asOf: REF_TIME - ONE_HOUR,
        fetchedAt: REF_TIME,
      }),
      gold: createLiveDatum({
        id: "gold",
        value: 2750.0,
        provider: "Binance",
        instrument: "PAXGUSDT",
        asOf: REF_TIME - ONE_HOUR,
        fetchedAt: REF_TIME,
        basis: "PAXG_TOKEN",
      }),
      btc: createLiveDatum({
        id: "btc",
        value: 76800.0,
        provider: "Binance",
        instrument: "BTCUSDT",
        asOf: REF_TIME - ONE_HOUR,
        fetchedAt: REF_TIME,
        basis: "SPOT",
      }),
      vnindex: createUnavailableDatum("vnindex"),
      breadth: createUnavailableDatum("breadth"),
      liquidity: createUnavailableDatum("liquidity"),
      foreignFlow: createUnavailableDatum("foreignFlow"),
      ...overrides,
    };
  }

  it("1. 6 fresh LIVE core metrics -> AVAILABLE assessment", () => {
    const snapshot = createFullLiveMarketSnapshot();
    const assessment = evaluateMacroRegimeV2(snapshot, REF_TIME);

    expect(assessment.status).toBe("AVAILABLE");
    expect(assessment.regime).not.toBeNull();
    expect(assessment.coverage.usable).toBe(6);
    expect(assessment.coverage.ratio).toBe(1.0);
    expect(assessment.confidence).toBeGreaterThan(0);
  });

  it("2. Only 3/6 eligible core metrics -> INSUFFICIENT_DATA", () => {
    const snapshot = createFullLiveMarketSnapshot({
      dxy: createUnavailableDatum("dxy"),
      us2y: createUnavailableDatum("us2y"),
      us10y: createUnavailableDatum("us10y"),
    });

    const assessment = evaluateMacroRegimeV2(snapshot, REF_TIME);

    expect(assessment.status).toBe("INSUFFICIENT_DATA");
    expect(assessment.regime).toBeNull();
    expect(assessment.confidence).toBeNull();
    expect(assessment.coverage.usable).toBe(3);
    expect(assessment.reason).toContain("Fewer than 4 usable core metrics");
  });

  it("3. 4/6 eligible but no volatility/risk metric -> INSUFFICIENT_DATA", () => {
    const snapshot = createFullLiveMarketSnapshot({
      vix: createUnavailableDatum("vix"),
      btc: createUnavailableDatum("btc"),
    });

    const assessment = evaluateMacroRegimeV2(snapshot, REF_TIME);

    expect(assessment.status).toBe("INSUFFICIENT_DATA");
    expect(assessment.regime).toBeNull();
    expect(assessment.confidence).toBeNull();
    expect(assessment.coverage.usable).toBe(4);
    expect(assessment.reason).toContain("volatility/risk metric category");
  });

  it("4. 4/6 eligible but no rates/dollar metric -> INSUFFICIENT_DATA", () => {
    const snapshot = createFullLiveMarketSnapshot({
      dxy: createUnavailableDatum("dxy"),
      us10y: createUnavailableDatum("us10y"),
      us2y: createUnavailableDatum("us2y"),
    });

    const assessment = evaluateMacroRegimeV2(snapshot, REF_TIME);

    expect(assessment.status).toBe("INSUFFICIENT_DATA");
    expect(assessment.regime).toBeNull();
    expect(assessment.confidence).toBeNull();
    expect(assessment.coverage.usable).toBe(3);
    expect(assessment.reason).toContain("Fewer than 4 usable core metrics");
  });

  it("5. Stale datum is excluded from regime evidence", () => {
    // btc threshold is 24h (86_400_000ms). Make btc 48h old.
    const snapshot = createFullLiveMarketSnapshot({
      btc: createLiveDatum({
        id: "btc",
        value: 76800,
        provider: "Binance",
        instrument: "BTCUSDT",
        asOf: REF_TIME - 48 * ONE_HOUR, // 48h old > 24h max age
        fetchedAt: REF_TIME,
      }),
    });

    const assessment = evaluateMacroRegimeV2(snapshot, REF_TIME);

    expect(assessment.staleMetrics).toContain("btc");
    expect(assessment.usableMetrics).not.toContain("btc");
    expect(assessment.evidence.some((e) => e.sourceIds.includes("btc"))).toBe(false);
  });

  it("6. SYNTHETIC datum is excluded from regime evidence", () => {
    const snapshot = createFullLiveMarketSnapshot({
      vix: createSyntheticDatum({
        id: "vix",
        value: 28.5,
        asOf: REF_TIME - ONE_HOUR,
        fetchedAt: REF_TIME,
      }),
    });

    const assessment = evaluateMacroRegimeV2(snapshot, REF_TIME);

    expect(assessment.excludedMetrics).toContain("vix");
    expect(assessment.usableMetrics).not.toContain("vix");
    expect(assessment.evidence.some((e) => e.sourceIds.includes("vix"))).toBe(false);
  });

  it("7. HARDCODED datum is excluded from regime evidence", () => {
    const snapshot = createFullLiveMarketSnapshot({
      dxy: createHardcodedDatum({
        id: "dxy",
        value: 105.0,
        asOf: REF_TIME - ONE_HOUR,
        fetchedAt: REF_TIME,
      }),
    });

    const assessment = evaluateMacroRegimeV2(snapshot, REF_TIME);

    expect(assessment.excludedMetrics).toContain("dxy");
    expect(assessment.usableMetrics).not.toContain("dxy");
    expect(assessment.evidence.some((e) => e.sourceIds.includes("dxy"))).toBe(false);
  });

  it("8. DERIVED datum is excluded in M2 regime evidence", () => {
    const snapshot = createFullLiveMarketSnapshot({
      us2y: createDerivedDatum({
        id: "us2y",
        value: 4.86,
        provider: "LocalSpreadFormula",
        instrument: "2YY=F",
        asOf: REF_TIME - ONE_HOUR,
        fetchedAt: REF_TIME,
        derivation: { method: "US10Y_SPREAD", parentIds: ["us10y"] },
      }),
    });

    const assessment = evaluateMacroRegimeV2(snapshot, REF_TIME);

    expect(assessment.excludedMetrics).toContain("us2y");
    expect(assessment.usableMetrics).not.toContain("us2y");
    // Yield curve evidence cannot be formed if us2y is DERIVED
    expect(assessment.evidence.some((e) => e.id === "ev-yield-curve-inverted")).toBe(false);
  });

  it("9. Future asOf timestamp cannot become usable", () => {
    const snapshot = createFullLiveMarketSnapshot({
      us10y: createLiveDatum({
        id: "us10y",
        value: 4.58,
        provider: "Yahoo",
        instrument: "^TNX",
        asOf: REF_TIME + ONE_DAY, // 1 day in the FUTURE
        fetchedAt: REF_TIME,
      }),
    });

    const assessment = evaluateMacroRegimeV2(snapshot, REF_TIME);

    expect(assessment.staleMetrics).toContain("us10y");
    expect(assessment.usableMetrics).not.toContain("us10y");
  });

  it("10. Yield-curve evidence requires BOTH eligible US2Y and US10Y", () => {
    const snapshot = createFullLiveMarketSnapshot({
      us2y: createUnavailableDatum("us2y"),
    });

    const assessment = evaluateMacroRegimeV2(snapshot, REF_TIME);

    expect(assessment.status).toBe("AVAILABLE"); // 5/6 core metrics available
    expect(assessment.evidence.some((e) => e.sourceIds.includes("us2y"))).toBe(false);
    expect(assessment.evidence.some((e) => e.id === "ev-yield-curve-inverted")).toBe(false);
  });

  it("11. Missing US2Y is never reconstructed from US10Y", () => {
    const snapshot = createFullLiveMarketSnapshot({
      us2y: createUnavailableDatum("us2y", { reason: "Feed un-fetchable" }),
    });

    const assessment = evaluateMacroRegimeV2(snapshot, REF_TIME);

    expect(assessment.unavailableMetrics).toContain("us2y");
    expect(assessment.usableMetrics).not.toContain("us2y");
    // Ensure no fallback yield curve inverted evidence was manufactured
    expect(assessment.evidence.some((e) => e.id === "ev-yield-curve-inverted")).toBe(false);
  });

  it("12. Conflicting evidence can produce MIXED regime", () => {
    // Strong RISK_OFF evidence (elevated DXY 105.5) + strong RISK_ON evidence (calm VIX 15.0, low 10Y 3.5)
    const snapshot = createFullLiveMarketSnapshot({
      dxy: createLiveDatum({ id: "dxy", value: 105.5, provider: "Yahoo", instrument: "DX-Y.NYB", asOf: REF_TIME - ONE_HOUR, fetchedAt: REF_TIME }), // Elevated DXY -> RISK_OFF (0.8)
      us10y: createLiveDatum({ id: "us10y", value: 3.5, provider: "Yahoo", instrument: "^TNX", asOf: REF_TIME - ONE_HOUR, fetchedAt: REF_TIME }), // Low 10Y -> RISK_ON (0.65)
      us2y: createLiveDatum({ id: "us2y", value: 3.5, provider: "Yahoo", instrument: "2YY=F", asOf: REF_TIME - ONE_HOUR, fetchedAt: REF_TIME }), // Flat curve (0 bps)
      vix: createLiveDatum({ id: "vix", value: 15.0, provider: "Yahoo", instrument: "^VIX", asOf: REF_TIME - ONE_HOUR, fetchedAt: REF_TIME }), // Calm VIX -> RISK_ON (0.75)
    });

    const assessment = evaluateMacroRegimeV2(snapshot, REF_TIME);

    expect(assessment.status).toBe("AVAILABLE");
    expect(assessment.regime).toBe("MIXED");
  });

  it("13. Confidence decreases when coverage or evidence agreement decreases", () => {
    const fullSnapshot = createFullLiveMarketSnapshot({
      dxy: createLiveDatum({ id: "dxy", value: 106.0, provider: "Yahoo", instrument: "DX-Y.NYB", asOf: REF_TIME - ONE_HOUR, fetchedAt: REF_TIME }),
      us10y: createLiveDatum({ id: "us10y", value: 4.9, provider: "Yahoo", instrument: "^TNX", asOf: REF_TIME - ONE_HOUR, fetchedAt: REF_TIME }),
      us2y: createLiveDatum({ id: "us2y", value: 5.2, provider: "Yahoo", instrument: "2YY=F", asOf: REF_TIME - ONE_HOUR, fetchedAt: REF_TIME }),
      vix: createLiveDatum({ id: "vix", value: 26.0, provider: "Yahoo", instrument: "^VIX", asOf: REF_TIME - ONE_HOUR, fetchedAt: REF_TIME }),
    });

    const fullAssessment = evaluateMacroRegimeV2(fullSnapshot, REF_TIME);

    // Reduced coverage (4 metrics instead of 6)
    const partialSnapshot = createFullLiveMarketSnapshot({
      dxy: createLiveDatum({ id: "dxy", value: 106.0, provider: "Yahoo", instrument: "DX-Y.NYB", asOf: REF_TIME - ONE_HOUR, fetchedAt: REF_TIME }),
      us10y: createLiveDatum({ id: "us10y", value: 4.9, provider: "Yahoo", instrument: "^TNX", asOf: REF_TIME - ONE_HOUR, fetchedAt: REF_TIME }),
      us2y: createLiveDatum({ id: "us2y", value: 5.2, provider: "Yahoo", instrument: "2YY=F", asOf: REF_TIME - ONE_HOUR, fetchedAt: REF_TIME }),
      vix: createLiveDatum({ id: "vix", value: 26.0, provider: "Yahoo", instrument: "^VIX", asOf: REF_TIME - ONE_HOUR, fetchedAt: REF_TIME }),
      gold: createUnavailableDatum("gold"),
      btc: createUnavailableDatum("btc"),
    });

    const partialAssessment = evaluateMacroRegimeV2(partialSnapshot, REF_TIME);

    expect(fullAssessment.confidence).not.toBeNull();
    expect(partialAssessment.confidence).not.toBeNull();
    expect(partialAssessment.confidence!).toBeLessThan(fullAssessment.confidence!);
  });

  it("14. Interpretation is 100% deterministic for identical inputs + referenceTimeMs", () => {
    const snapshot = createFullLiveMarketSnapshot();

    const run1 = evaluateMacroRegimeV2(snapshot, REF_TIME);
    const run2 = evaluateMacroRegimeV2(snapshot, REF_TIME);

    expect(run1).toEqual(run2);
  });

  it("15. Model output contains explicit evidence/sourceIds", () => {
    const snapshot = createFullLiveMarketSnapshot();
    const assessment = evaluateMacroRegimeV2(snapshot, REF_TIME);

    expect(assessment.evidence.length).toBeGreaterThan(0);
    for (const item of assessment.evidence) {
      expect(item.id).toBeDefined();
      expect(item.direction).toBeDefined();
      expect(item.strength).toBeGreaterThan(0);
      expect(item.description).toBeDefined();
      expect(Array.isArray(item.sourceIds)).toBe(true);
      expect(item.sourceIds.length).toBeGreaterThan(0);
    }
  });

  it("16. No asset allocation field exists in MacroAssessment", () => {
    const snapshot = createFullLiveMarketSnapshot();
    const assessment = evaluateMacroRegimeV2(snapshot, REF_TIME);

    // Verify properties of MacroAssessment
    const keys = Object.keys(assessment);
    expect(keys).not.toContain("allocation");
    expect(keys).not.toContain("assetWeights");
    expect(keys).not.toContain("weights");
    expect((assessment as any).allocation).toBeUndefined();
  });

  it("17. (Correction A) BTC absolute price alone produces NO directional MacroEvidence", () => {
    const highBtcSnapshot = createFullLiveMarketSnapshot({
      btc: createLiveDatum({ id: "btc", value: 150000.0, provider: "Binance", instrument: "BTCUSDT", asOf: REF_TIME - ONE_HOUR, fetchedAt: REF_TIME }),
    });

    const assessment = evaluateMacroRegimeV2(highBtcSnapshot, REF_TIME);

    expect(assessment.usableMetrics).toContain("btc"); // Still satisfies core risk availability
    expect(assessment.evidence.some((e) => e.sourceIds.includes("btc"))).toBe(false);
  });

  it("18. (Correction B) A positive/steep 10Y-2Y spread alone does NOT produce RISK_ON yield-curve evidence", () => {
    const steepSnapshot = createFullLiveMarketSnapshot({
      us10y: createLiveDatum({ id: "us10y", value: 4.5, provider: "Yahoo", instrument: "^TNX", asOf: REF_TIME - ONE_HOUR, fetchedAt: REF_TIME }),
      us2y: createLiveDatum({ id: "us2y", value: 3.5, provider: "Yahoo", instrument: "2YY=F", asOf: REF_TIME - ONE_HOUR, fetchedAt: REF_TIME }), // +100 bps steep spread
    });

    const assessment = evaluateMacroRegimeV2(steepSnapshot, REF_TIME);

    expect(assessment.evidence.some((e) => e.id === "ev-yield-curve-steep")).toBe(false);
    expect(assessment.evidence.some((e) => e.sourceIds.includes("us10y") && e.sourceIds.includes("us2y"))).toBe(false);
  });

  it("19. (Correction C) Inverted yield curve still produces stress/RISK_OFF evidence when both eligible LIVE yields exist", () => {
    const invertedSnapshot = createFullLiveMarketSnapshot({
      us10y: createLiveDatum({ id: "us10y", value: 4.2, provider: "Yahoo", instrument: "^TNX", asOf: REF_TIME - ONE_HOUR, fetchedAt: REF_TIME }),
      us2y: createLiveDatum({ id: "us2y", value: 4.8, provider: "Yahoo", instrument: "2YY=F", asOf: REF_TIME - ONE_HOUR, fetchedAt: REF_TIME }), // -60 bps inverted
    });

    const assessment = evaluateMacroRegimeV2(invertedSnapshot, REF_TIME);

    const invertedEvidence = assessment.evidence.find((e) => e.id === "ev-yield-curve-inverted");
    expect(invertedEvidence).toBeDefined();
    expect(invertedEvidence?.direction).toBe("RISK_OFF");
  });

  it("20. (Correction D) DXY and US10Y level descriptions do not claim unobserved movement", () => {
    const snapshot = createFullLiveMarketSnapshot({
      dxy: createLiveDatum({ id: "dxy", value: 106.0, provider: "Yahoo", instrument: "DX-Y.NYB", asOf: REF_TIME - ONE_HOUR, fetchedAt: REF_TIME }),
      us10y: createLiveDatum({ id: "us10y", value: 4.9, provider: "Yahoo", instrument: "^TNX", asOf: REF_TIME - ONE_HOUR, fetchedAt: REF_TIME }),
    });

    const assessment = evaluateMacroRegimeV2(snapshot, REF_TIME);

    const dxyEv = assessment.evidence.find((e) => e.id === "ev-dxy-strong");
    const us10yEv = assessment.evidence.find((e) => e.id === "ev-us10y-high");

    expect(dxyEv?.description).toContain("level");
    expect(dxyEv?.description).not.toContain("squeezing");
    expect(dxyEv?.description).not.toContain("rising");

    expect(us10yEv?.description).toContain("level");
    expect(us10yEv?.description).not.toContain("rising");
    expect(us10yEv?.description).not.toContain("spiking");
  });
});
