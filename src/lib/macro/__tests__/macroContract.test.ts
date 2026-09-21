// ============================================================================
// FILE: src/lib/macro/__tests__/macroContract.test.ts
// MODULE: MACRO V2 DATA CONTRACT UNIT TESTS
// PRINCIPLE: Fully Deterministic Invariant Verification (No Math.random / Wall Clock)
// ============================================================================

import { describe, expect, it } from "vitest";
import {
  calculateFreshness,
  createDerivedDatum,
  createHardcodedDatum,
  createLiveDatum,
  createSyntheticDatum,
  createUnavailableDatum,
  isDerivedDatum,
  isLiveDatum,
  isSyntheticDatum,
  isUsableDatum,
} from "../helpers";
import type {
  CurrentMarketSnapshot,
  DerivedMacroDatum,
  LiveMacroDatum,
  MacroDatum,
  MarketSnapshotData,
  VietnamBreadthData,
} from "../types";

describe("Macro V2 Data Contract & Provenance Foundation", () => {
  const REF_TIME = 1_700_000_000_000; // Fixed deterministic reference time (ms)
  const ONE_DAY = 86_400_000;

  it("1. LIVE datum preserves provider/instrument/asOf metadata", () => {
    const liveVix = createLiveDatum({
      id: "vix",
      value: 16.5,
      provider: "Yahoo",
      instrument: "^VIX",
      asOf: REF_TIME - 3600_000,
      fetchedAt: REF_TIME,
      quality: "USABLE",
    });

    expect(liveVix.status).toBe("AVAILABLE");
    expect(liveVix.id).toBe("vix");
    expect(liveVix.value).toBe(16.5);
    expect(liveVix.sourceClassification).toBe("LIVE");
    expect(liveVix.provider).toBe("Yahoo");
    expect(liveVix.instrument).toBe("^VIX");
    expect(liveVix.asOf).toBe(REF_TIME - 3600_000);
    expect(liveVix.fetchedAt).toBe(REF_TIME);
    expect(liveVix.quality).toBe("USABLE");
    expect(liveVix.derivation).toBeNull();
    expect(isLiveDatum(liveVix)).toBe(true);
    expect(isDerivedDatum(liveVix)).toBe(false);
    expect(isSyntheticDatum(liveVix)).toBe(false);
  });

  it("2. DERIVED datum strictly requires DerivationMetadata at type level", () => {
    const derivedUs2y = createDerivedDatum({
      id: "us2y",
      value: 4.86,
      provider: "LocalSpreadFormula",
      instrument: "2YY=F",
      asOf: REF_TIME - 1800_000,
      fetchedAt: REF_TIME,
      derivation: {
        method: "US10Y_SPREAD",
        parentIds: ["us10y"],
        parameters: { spreadBps: 28 },
      },
      quality: "USABLE",
    });

    expect(derivedUs2y.status).toBe("AVAILABLE");
    expect(derivedUs2y.sourceClassification).toBe("DERIVED");
    // Verify derivation metadata is mandatory and populated
    expect(derivedUs2y.derivation.method).toBe("US10Y_SPREAD");
    expect(derivedUs2y.derivation.parentIds).toEqual(["us10y"]);

    expect(isLiveDatum(derivedUs2y)).toBe(false);
    expect(isDerivedDatum(derivedUs2y)).toBe(true);
    expect(isSyntheticDatum(derivedUs2y)).toBe(false);

    // Compile-time & runtime check: LIVE datum cannot satisfy DerivedMacroDatum
    const liveDatum: LiveMacroDatum = createLiveDatum({
      id: "us10y",
      value: 4.58,
      provider: "Yahoo",
      instrument: "^TNX",
      asOf: REF_TIME - 1800_000,
      fetchedAt: REF_TIME,
    });

    const genericDatum: MacroDatum = liveDatum;
    if (isDerivedDatum(genericDatum)) {
      // Should not enter here
      const _derivedCheck: DerivedMacroDatum = genericDatum;
      expect(_derivedCheck).toBeUndefined();
    } else {
      expect(isDerivedDatum(genericDatum)).toBe(false);
    }
  });

  it("3. SYNTHETIC datum remains explicitly synthetic", () => {
    const synDxy = createSyntheticDatum({
      id: "dxy",
      value: 99.6,
      provider: "PRNGMulberry32",
      instrument: "DX-Y.NYB",
      asOf: REF_TIME - 5000_000,
      fetchedAt: REF_TIME,
    });

    expect(synDxy.status).toBe("AVAILABLE");
    expect(synDxy.sourceClassification).toBe("SYNTHETIC");
    expect(synDxy.provider).toBe("PRNGMulberry32");
    expect(synDxy.quality).toBe("DEGRADED");
    expect(isSyntheticDatum(synDxy)).toBe(true);
    expect(isLiveDatum(synDxy)).toBe(false);
    expect(isDerivedDatum(synDxy)).toBe(false);
  });

  it("4. UNAVAILABLE datum does not require a fake numeric value", () => {
    const unavailableVnIndex = createUnavailableDatum("vnindex", {
      provider: "Yahoo",
      instrument: "^VNINDEX",
      reason: "API rate limit 429",
      asOf: null,
    });

    expect(unavailableVnIndex.status).toBe("UNAVAILABLE");
    expect(unavailableVnIndex.id).toBe("vnindex");
    expect(unavailableVnIndex.value).toBeNull();
    expect(unavailableVnIndex.sourceClassification).toBe("UNAVAILABLE");
    expect(unavailableVnIndex.quality).toBe("UNAVAILABLE");
    expect(unavailableVnIndex.reason).toBe("API rate limit 429");
    expect(isLiveDatum(unavailableVnIndex)).toBe(false);
    expect(isUsableDatum(unavailableVnIndex)).toBe(false);
  });

  it("5. Rejects invalid and future timestamps conservatively in freshness evaluation", () => {
    const normalLive = createLiveDatum({
      id: "btc",
      value: 76800,
      provider: "Binance",
      instrument: "BTCUSDT",
      asOf: REF_TIME - 2 * ONE_DAY, // 2 days old
      fetchedAt: REF_TIME - 2 * ONE_DAY,
    });

    // A. Normal valid timestamp behavior remains unchanged
    const evalNormalStale = calculateFreshness(normalLive, REF_TIME, ONE_DAY);
    expect(evalNormalStale.ageMs).toBe(2 * ONE_DAY);
    expect(evalNormalStale.isStale).toBe(true);
    expect(evalNormalStale.quality).toBe("STALE");

    const evalNormalFresh = calculateFreshness(normalLive, REF_TIME, 3 * ONE_DAY);
    expect(evalNormalFresh.ageMs).toBe(2 * ONE_DAY);
    expect(evalNormalFresh.isStale).toBe(false);
    expect(evalNormalFresh.quality).toBe("USABLE");

    // B. Rejects future asOf timestamp (asOf > referenceTimeMs)
    const futureDatum = createLiveDatum({
      id: "btc",
      value: 77000,
      provider: "Binance",
      instrument: "BTCUSDT",
      asOf: REF_TIME + ONE_DAY, // 1 day in the FUTURE
      fetchedAt: REF_TIME,
    });

    const evalFuture = calculateFreshness(futureDatum, REF_TIME, ONE_DAY);
    expect(evalFuture.isStale).toBe(true);
    expect(evalFuture.quality).toBe("STALE");
    expect(evalFuture.ageMs).toBeLessThan(0);
    expect(isUsableDatum(futureDatum, REF_TIME, ONE_DAY)).toBe(false);

    // C. Rejects invalid maxAgeMs (negative or non-finite)
    const evalNegMaxAge = calculateFreshness(normalLive, REF_TIME, -100);
    expect(evalNegMaxAge.isStale).toBe(true);
    expect(evalNegMaxAge.quality).toBe("UNAVAILABLE");

    const evalNanMaxAge = calculateFreshness(normalLive, REF_TIME, Number.NaN);
    expect(evalNanMaxAge.isStale).toBe(true);
    expect(evalNanMaxAge.quality).toBe("UNAVAILABLE");

    // D. Rejects non-finite referenceTimeMs or asOf
    const evalNanRef = calculateFreshness(normalLive, Number.NaN, ONE_DAY);
    expect(evalNanRef.isStale).toBe(true);
    expect(evalNanRef.quality).toBe("UNAVAILABLE");
  });

  it("6. CurrentMarketSnapshot DATA section can represent mixed LIVE / DERIVED / UNAVAILABLE inputs without losing provenance", () => {
    const snapshotData: MarketSnapshotData = {
      dxy: createLiveDatum({
        id: "dxy",
        value: 104.2,
        provider: "Yahoo",
        instrument: "DX-Y.NYB",
        asOf: REF_TIME - 1800_000,
        fetchedAt: REF_TIME,
      }),
      us10y: createLiveDatum({
        id: "us10y",
        value: 4.58,
        provider: "Yahoo",
        instrument: "^TNX",
        asOf: REF_TIME - 1800_000,
        fetchedAt: REF_TIME,
      }),
      us2y: createDerivedDatum({
        id: "us2y",
        value: 4.86,
        provider: "LocalSpreadFormula",
        instrument: "2YY=F",
        asOf: REF_TIME - 1800_000,
        fetchedAt: REF_TIME,
        derivation: { method: "US10Y_SPREAD", parentIds: ["us10y"], parameters: { spreadBps: 28 } },
      }),
      vix: createSyntheticDatum({
        id: "vix",
        value: 20.8,
        provider: "PRNGMulberry32",
        instrument: "^VIX",
        asOf: REF_TIME - 3600_000,
        fetchedAt: REF_TIME,
      }),
      gold: createLiveDatum({
        id: "gold",
        value: 2750.5,
        provider: "Binance",
        instrument: "PAXGUSDT",
        asOf: REF_TIME - 600_000,
        fetchedAt: REF_TIME,
        basis: "PAXG_TOKEN",
      }),
      btc: createLiveDatum({
        id: "btc",
        value: 76800,
        provider: "Binance",
        instrument: "BTCUSDT",
        asOf: REF_TIME - 600_000,
        fetchedAt: REF_TIME,
        basis: "SPOT",
      }),
      vnindex: createUnavailableDatum("vnindex", {
        provider: "Yahoo",
        instrument: "^VNINDEX",
        reason: "Feed timeout",
      }),
      breadth: createHardcodedDatum({
        id: "breadth",
        value: {
          advancing: 145,
          declining: 320,
          unchanged: 65,
          adRatio: 0.45,
          pctAboveMA20: 38.0,
          pctAboveMA50: 31.0,
          pctAboveMA200: 45.0,
        },
        provider: "StaticBaseline",
        asOf: REF_TIME - ONE_DAY,
        fetchedAt: REF_TIME,
      }),
      liquidity: createHardcodedDatum({
        id: "liquidity",
        value: {
          matchingValueBillion: 14800,
          ma20ValueBillion: 18500,
          ratioToMa20: 0.8,
          status: "CONTRACTING",
        },
        provider: "StaticBaseline",
        asOf: REF_TIME - ONE_DAY,
        fetchedAt: REF_TIME,
      }),
      foreignFlow: createHardcodedDatum({
        id: "foreignFlow",
        value: {
          net1dBillion: -500,
          net5dBillion: -1200,
          status: "NET_SELLING",
        },
        provider: "StaticBaseline",
        asOf: REF_TIME - ONE_DAY,
        fetchedAt: REF_TIME,
      }),
    };

    const snapshot: CurrentMarketSnapshot = {
      timestamp: REF_TIME,
      data: snapshotData,
      macro: null,
      quant: { status: "UNAVAILABLE", strategies: [], strongestStrategyId: null },
      synthesis: null,
    };

    // Assert provenance integrity across mixed metrics
    expect(snapshot.data.dxy.sourceClassification).toBe("LIVE");
    expect(snapshot.data.dxy.provider).toBe("Yahoo");

    expect(snapshot.data.us2y.sourceClassification).toBe("DERIVED");
    expect(snapshot.data.us2y.provider).toBe("LocalSpreadFormula");

    if (isDerivedDatum(snapshot.data.us2y)) {
      expect(snapshot.data.us2y.derivation.method).toBe("US10Y_SPREAD");
    } else {
      throw new Error("Expected snapshot.data.us2y to be DerivedMacroDatum");
    }

    expect(snapshot.data.vix.sourceClassification).toBe("SYNTHETIC");
    expect(snapshot.data.vix.quality).toBe("DEGRADED");

    expect(snapshot.data.vnindex.status).toBe("UNAVAILABLE");
    expect(snapshot.data.vnindex.value).toBeNull();
    expect(snapshot.data.vnindex.sourceClassification).toBe("UNAVAILABLE");

    expect(snapshot.data.gold.status === "AVAILABLE" && snapshot.data.gold.basis).toBe("PAXG_TOKEN");

    expect(snapshot.macro).toBeNull();
  });

  it("6. VietnamBreadthData supports nullable adRatio and pctAboveMA fields (DEC-014)", () => {
    const breadthDataNullable: VietnamBreadthData = {
      advancing: 120,
      declining: 0,
      unchanged: 50,
      adRatio: null, // Null when declining == 0
      pctAboveMA20: 45.5,
      pctAboveMA50: null, // Null when cold-start history < 50
      pctAboveMA200: null, // Null when cold-start history < 200
    };

    expect(breadthDataNullable.adRatio).toBeNull();
    expect(breadthDataNullable.pctAboveMA20).toBe(45.5);
    expect(breadthDataNullable.pctAboveMA50).toBeNull();
    expect(breadthDataNullable.pctAboveMA200).toBeNull();

    const breadthDatum = createHardcodedDatum({
      id: "breadth",
      value: breadthDataNullable,
      provider: "VNDirect",
      asOf: REF_TIME - ONE_DAY,
      fetchedAt: REF_TIME,
    });

    expect(breadthDatum.status).toBe("AVAILABLE");
    expect(breadthDatum.value.adRatio).toBeNull();
    expect(breadthDatum.value.pctAboveMA50).toBeNull();
    expect(breadthDatum.value.pctAboveMA200).toBeNull();
  });
});
