// ============================================================================
// FILE: src/lib/quant/__tests__/macroReleaseIngestion.test.ts
// MODULE: TEST SUITE FOR HISTORICAL MACROECONOMIC RELEASES & EVENT PIT INGESTION (GATE M12D)
// ============================================================================

import { describe, expect, it } from "vitest";
import {
  type HistoricalEventRecord,
  type HistoricalDataset,
  HistoricalDatasetValidationError,
  validateHistoricalMacroRelease,
  validateHistoricalEvent,
  validateHistoricalDataset,
  normalizeHistoricalDataset,
  latestEligibleMacroRelease,
  latestEligibleVintage,
  latestEligibleEvent,
  isEventReactionEligible,
} from "../historicalPit";
import {
  parseBlsCpiRelease,
  parseBlsEmploymentRelease,
  getReferenceMonthEndEpochMs,
  BLS_SERIES_DEFINITIONS,
  deriveVintageConsistentChange,
} from "../historicalSources/blsReleases";
import {
  parseFomcEvent,
} from "../historicalSources/fomcEvents";
import {
  REAL_HISTORICAL_FIXTURE_BLS_CPI,
  REAL_HISTORICAL_FIXTURE_BLS_NFP,
  REAL_HISTORICAL_FIXTURE_FOMC,
  SYNTHETIC_TEST_FIXTURE_INVALID_BLS,
  SYNTHETIC_TEST_FIXTURE_INVALID_FOMC,
  buildRealHistoricalMacroReleases,
  buildRealHistoricalEventRecords,
} from "../historicalSources/sampleMacroData";

describe("Gate M12D — Historical Macroeconomic Releases & Event PIT Ingestion", () => {
  // --------------------------------------------------------------------------
  // REFERENCE BENCHMARK EPOCH TIMESTAMPS
  // --------------------------------------------------------------------------

  // 2024-01-31 00:00:00 UTC (End of January reference month)
  const JAN_31_2024_UTC = 1706659200000;
  // 2024-02-01 00:00:00 UTC
  const FEB_01_2024_UTC = 1706745600000;

  // Jan 2024 NFP Initial Release: 2024-02-02 08:30 EST (UTC-5 -> 13:30:00 UTC)
  const FEB_02_2024_0830_EST = 1706880600000;

  // Jan 2024 CPI Initial Release: 2024-02-13 08:30 EST (UTC-5 -> 13:30:00 UTC)
  const FEB_13_2024_0830_EST = 1707831000000;
  // 2024-02-13 00:00:00 UTC (ALFRED midnight date - NOT public release time)
  const FEB_13_2024_MIDNIGHT_UTC = 1707782400000;
  // 2024-02-13 05:00:00 UTC (morning in UTC, 00:00 EST - before 08:30 release)
  const FEB_13_2024_0500_UTC = 1707800400000;

  // 2024-02-29 00:00:00 UTC (End of February leap-year reference month)
  const FEB_29_2024_UTC = 1709164800000;

  // Feb 2024 Employment & Jan 2024 NFP 1st Revision: 2024-03-08 08:30 EST (13:30:00 UTC)
  const MAR_08_2024_0830_EST = 1709904600000;

  // Feb 2024 CPI Release: 2024-03-12 08:30 EDT (US DST began Mar 10! UTC-4 -> 12:30:00 UTC)
  const MAR_12_2024_0830_EDT = 1710246600000;

  // Jun 2024 CPI Release: 2024-07-11 08:30 EDT (UTC-4 -> 12:30:00 UTC)
  const JUL_11_2024_0830_EDT = 1720701000000;

  // Jan 31, 2024 FOMC Rate Decision Statement: 14:00 EST (UTC-5 -> 19:00:00 UTC)
  const JAN_31_2024_1400_EST = 1706727600000;

  // Jun 12, 2024 FOMC Rate Decision Statement: 14:00 EDT (UTC-4 -> 18:00:00 UTC)
  const JUN_12_2024_1400_EDT = 1718215200000;

  // ==========================================================================
  // 1. CPI TEST REQUIREMENTS (C1 - C10)
  // ==========================================================================
  describe("CPI Release Ingestion & Vintage Semantics (C1 - C10)", () => {
    const rawJanCpi = {
      observationPeriod: "2024-01",
      releaseDate: "2024-02-13",
      releaseTime: "08:30",
      cpiYoY: 3.1,
      cpiMoM: 0.3,
      cpiIndex: 308.417,
      revisionIndex: 0,
      vintageDate: "2024-02-13",
    };

    it("C1: CPI observation period is invisible before verified release timestamp", () => {
      const parsed = parseBlsCpiRelease(rawJanCpi);
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;

      const releases = parsed.macroReleases;
      // Before release date (e.g. Feb 01)
      expect(latestEligibleMacroRelease(releases, "US_CPI_YOY", FEB_01_2024_UTC)).toBeNull();
      // On release date 1 millisecond before 08:30 EST (13:30:00 UTC)
      expect(latestEligibleMacroRelease(releases, "US_CPI_YOY", FEB_13_2024_0830_EST - 1)).toBeNull();
    });

    it("C2: visible exactly at release boundary", () => {
      const parsed = parseBlsCpiRelease(rawJanCpi);
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;

      const releases = parsed.macroReleases;
      const result = latestEligibleMacroRelease(releases, "US_CPI_YOY", FEB_13_2024_0830_EST);
      expect(result).not.toBeNull();
      expect(result?.value).toBe(3.1);
      expect(result?.availableAt).toBe(FEB_13_2024_0830_EST);
    });

    it("C3: winter 08:30 ET converts correctly to UTC (13:30 UTC)", () => {
      const parsed = parseBlsCpiRelease(rawJanCpi);
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;

      const yoy = parsed.macroReleases.find((r) => r.seriesId === "US_CPI_YOY");
      expect(yoy).toBeDefined();
      expect(yoy?.publishedAt).toBe(FEB_13_2024_0830_EST);
      expect(yoy?.availableAt).toBe(1707831000000); // 13:30:00 UTC exactly
    });

    it("C4: summer 08:30 ET converts correctly to UTC (12:30 UTC)", () => {
      const rawJulCpi = {
        observationPeriod: "2024-06",
        releaseDate: "2024-07-11",
        releaseTime: "08:30",
        cpiYoY: 3.0,
      };
      const parsed = parseBlsCpiRelease(rawJulCpi);
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;

      const yoy = parsed.macroReleases.find((r) => r.seriesId === "US_CPI_YOY");
      expect(yoy).toBeDefined();
      // July 11, 2024 08:30 EDT = 12:30:00 UTC = 1720701000000
      expect(yoy?.publishedAt).toBe(JUL_11_2024_0830_EDT);
      expect(yoy?.availableAt).toBe(1720701000000);
    });

    it("C5: vintageDate is not used as midnight availableAt", () => {
      const parsed = parseBlsCpiRelease(rawJanCpi);
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;

      const releases = parsed.macroReleases;
      const yoy = releases.find((r) => r.seriesId === "US_CPI_YOY")!;
      expect(yoy.vintageDate).toBe("2024-02-13");

      // Querying at 00:00 UTC (ALFRED midnight) or 05:00 UTC must return null!
      expect(latestEligibleMacroRelease(releases, "US_CPI_YOY", FEB_13_2024_MIDNIGHT_UTC)).toBeNull();
      expect(latestEligibleMacroRelease(releases, "US_CPI_YOY", FEB_13_2024_0500_UTC)).toBeNull();
    });

    it("C6: revision unavailable before revision publication", () => {
      const parsedInitial = parseBlsCpiRelease(rawJanCpi);
      const rawJanCpiRev1 = {
        observationPeriod: "2024-01",
        releaseDate: "2024-03-12", // Published alongside Feb CPI
        releaseTime: "08:30",
        cpiYoY: 3.2, // Revised from 3.1
        revisionIndex: 1,
      };
      const parsedRev = parseBlsCpiRelease(rawJanCpiRev1);
      expect(parsedInitial.success && parsedRev.success).toBe(true);
      if (!parsedInitial.success || !parsedRev.success) return;

      const allReleases = [...parsedInitial.macroReleases, ...parsedRev.macroReleases];

      // At March 01 (before March 12 revision publication), revision 1 is unavailable
      const lookupAtMar01 = latestEligibleVintage(allReleases, "US_CPI_YOY", JAN_31_2024_UTC, FEB_29_2024_UTC + 86400000);
      expect(lookupAtMar01?.revisionIndex).toBe(0);
      expect(lookupAtMar01?.value).toBe(3.1);
    });

    it("C7: initial release remains visible before later revision", () => {
      const parsedInitial = parseBlsCpiRelease(rawJanCpi);
      const rawJanCpiRev1 = {
        observationPeriod: "2024-01",
        releaseDate: "2024-03-12",
        releaseTime: "08:30",
        cpiYoY: 3.2,
        revisionIndex: 1,
      };
      const parsedRev = parseBlsCpiRelease(rawJanCpiRev1);
      if (!parsedInitial.success || !parsedRev.success) return;

      const allReleases = [...parsedInitial.macroReleases, ...parsedRev.macroReleases];
      // On March 11 (day before revision), initial value remains historical truth
      const lookupAtMar11 = latestEligibleVintage(allReleases, "US_CPI_YOY", JAN_31_2024_UTC, MAR_12_2024_0830_EDT - 1000);
      expect(lookupAtMar11?.revisionIndex).toBe(0);
      expect(lookupAtMar11?.value).toBe(3.1);
    });

    it("C8: latest eligible revision selected after its publication", () => {
      const parsedInitial = parseBlsCpiRelease(rawJanCpi);
      const rawJanCpiRev1 = {
        observationPeriod: "2024-01",
        releaseDate: "2024-03-12",
        releaseTime: "08:30",
        cpiYoY: 3.2,
        revisionIndex: 1,
      };
      const parsedRev = parseBlsCpiRelease(rawJanCpiRev1);
      if (!parsedInitial.success || !parsedRev.success) return;

      const allReleases = [...parsedInitial.macroReleases, ...parsedRev.macroReleases];
      // At March 12 12:30 EDT, latest eligible revision (index 1) is selected
      const lookupAfter = latestEligibleVintage(allReleases, "US_CPI_YOY", JAN_31_2024_UTC, MAR_12_2024_0830_EDT);
      expect(lookupAfter?.revisionIndex).toBe(1);
      expect(lookupAfter?.value).toBe(3.2);
    });

    it("C9: missing releaseDate fails closed", () => {
      const invalid = {
        observationPeriod: "2024-01",
        cpiYoY: 3.1,
      } as unknown as typeof rawJanCpi;

      const result = parseBlsCpiRelease(invalid);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/Missing or malformed releaseDate/);
      }
    });

    it("C10: missing exact release time/witness fails closed", () => {
      const invalidTime = {
        observationPeriod: "2024-01",
        releaseDate: "2024-02-13",
        releaseTime: "99:99", // Nonexistent time
        cpiYoY: 3.1,
      };
      const result = parseBlsCpiRelease(invalidTime);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/Invalid time values/);
      }
    });
  });

  // ==========================================================================
  // BLS PROVENANCE & USDL RELEASE IDENTIFIERS (P1 - P7)
  // ==========================================================================
  describe("BLS Provenance & USDL Release Identifiers (P1 - P7)", () => {
    it("P1: Jan 2024 CPI fixture has USDL-24-0265", () => {
      const janCpi = REAL_HISTORICAL_FIXTURE_BLS_CPI.find((r) => r.observationPeriod === "2024-01");
      expect(janCpi?.releaseId).toBe("USDL-24-0265");
      expect(janCpi?.releaseDate).toBe("2024-02-13");
    });

    it("P2: Feb 2024 CPI fixture has USDL-24-0483", () => {
      const febCpi = REAL_HISTORICAL_FIXTURE_BLS_CPI.find((r) => r.observationPeriod === "2024-02");
      expect(febCpi?.releaseId).toBe("USDL-24-0483");
      expect(febCpi?.releaseDate).toBe("2024-03-12");
    });

    it("P3: Jun 2024 CPI fixture has USDL-24-1325", () => {
      const junCpi = REAL_HISTORICAL_FIXTURE_BLS_CPI.find((r) => r.observationPeriod === "2024-06");
      expect(junCpi?.releaseId).toBe("USDL-24-1325");
      expect(junCpi?.releaseDate).toBe("2024-07-11");
    });

    it("P4: Jan 2024 Employment fixture has USDL-24-0148", () => {
      const janNfp = REAL_HISTORICAL_FIXTURE_BLS_NFP.find(
        (r) => r.observationPeriod === "2024-01" && r.revisionIndex === 0
      );
      expect(janNfp?.releaseId).toBe("USDL-24-0148");
      expect(janNfp?.releaseDate).toBe("2024-02-02");
    });

    it("P5: Feb 2024 Employment fixture has USDL-24-0451", () => {
      const febNfp = REAL_HISTORICAL_FIXTURE_BLS_NFP.find(
        (r) => r.observationPeriod === "2024-02" && r.revisionIndex === 0
      );
      expect(febNfp?.releaseId).toBe("USDL-24-0451");
      expect(febNfp?.releaseDate).toBe("2024-03-08");
    });

    it("P6: Jun 2024 Employment fixture has USDL-24-1270", () => {
      const junNfp = REAL_HISTORICAL_FIXTURE_BLS_NFP.find(
        (r) => r.observationPeriod === "2024-06" && r.revisionIndex === 0
      );
      expect(junNfp?.releaseId).toBe("USDL-24-1270");
      expect(junNfp?.releaseDate).toBe("2024-07-05");
    });

    it("P7: no known incorrect fixture IDs remain", () => {
      const prohibitedIds = [
        "USDL-24-0275",
        "USDL-24-0466",
        "USDL-24-1355",
        "USDL-24-0186",
        "USDL-24-0435",
        "USDL-24-1317",
      ];

      const allCpiIds = REAL_HISTORICAL_FIXTURE_BLS_CPI.map((r) => r.releaseId);
      const allNfpIds = REAL_HISTORICAL_FIXTURE_BLS_NFP.map((r) => r.releaseId);
      const allFixtureIds = [...allCpiIds, ...allNfpIds];

      for (const prohibited of prohibitedIds) {
        expect(allFixtureIds).not.toContain(prohibited);
      }
    });
  });

  // ==========================================================================
  // 2. NFP TEST REQUIREMENTS (N1 - N16)
  // ==========================================================================
  describe("NFP / Employment Situation Ingestion & Semantics (N1 - N16)", () => {
    const rawJanNfp = {
      observationPeriod: "2024-01",
      releaseDate: "2024-02-02",
      releaseTime: "08:30",
      nfpNetChangeThousands: 353,
      unemploymentRate: 3.7,
      revisionIndex: 0,
      vintageDate: "2024-02-02",
    };

    it("N1: NFP observation/reference period invisible before release", () => {
      const parsed = parseBlsEmploymentRelease(rawJanNfp);
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;

      const releases = parsed.macroReleases;
      expect(latestEligibleMacroRelease(releases, "US_NFP_NET_CHANGE", JAN_31_2024_UTC)).toBeNull();
      expect(latestEligibleMacroRelease(releases, "US_NFP_NET_CHANGE", FEB_01_2024_UTC)).toBeNull();
      expect(latestEligibleMacroRelease(releases, "US_NFP_NET_CHANGE", FEB_02_2024_0830_EST - 1)).toBeNull();
    });

    it("N2: visible exactly at verified BLS release boundary", () => {
      const parsed = parseBlsEmploymentRelease(rawJanNfp);
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;

      const releases = parsed.macroReleases;
      const lookup = latestEligibleMacroRelease(releases, "US_NFP_NET_CHANGE", FEB_02_2024_0830_EST);
      expect(lookup).not.toBeNull();
      expect(lookup?.value).toBe(353);
      expect(lookup?.availableAt).toBe(FEB_02_2024_0830_EST);
    });

    it("N3: payroll unit/series identity preserved", () => {
      const parsed = parseBlsEmploymentRelease(rawJanNfp);
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;

      const nfpRel = parsed.macroReleases.find((r) => r.seriesId === "US_NFP_NET_CHANGE");
      expect(nfpRel).toBeDefined();
      expect(nfpRel?.unit).toBe("THOUSANDS_OF_PERSONS");
      expect(nfpRel?.provider).toBe("BLS");
      expect(nfpRel?.value).toBe(353);
    });

    it("N4: revised employment value cannot leak before revision publication", () => {
      const parsedInitial = parseBlsEmploymentRelease(rawJanNfp);
      const rawJanNfpRev1 = {
        observationPeriod: "2024-01",
        releaseDate: "2024-03-08",
        releaseTime: "08:30",
        nfpNetChangeThousands: 229, // Revised down to 229k
        unemploymentRate: 3.7,
        revisionIndex: 1,
        vintageDate: "2024-03-08",
      };
      const parsedRev = parseBlsEmploymentRelease(rawJanNfpRev1);
      expect(parsedInitial.success && parsedRev.success).toBe(true);
      if (!parsedInitial.success || !parsedRev.success) return;

      const timeline = [...parsedInitial.macroReleases, ...parsedRev.macroReleases];
      // On March 01 (before March 08 revision), revision 1 cannot leak
      const lookup = latestEligibleVintage(timeline, "US_NFP_NET_CHANGE", JAN_31_2024_UTC, MAR_08_2024_0830_EST - 1);
      expect(lookup?.revisionIndex).toBe(0);
      expect(lookup?.value).toBe(353);
    });

    it("N5: initial value remains historical truth before revision", () => {
      const parsedInitial = parseBlsEmploymentRelease(rawJanNfp);
      const rawJanNfpRev1 = {
        observationPeriod: "2024-01",
        releaseDate: "2024-03-08",
        releaseTime: "08:30",
        nfpNetChangeThousands: 229,
        revisionIndex: 1,
      };
      const parsedRev = parseBlsEmploymentRelease(rawJanNfpRev1);
      if (!parsedInitial.success || !parsedRev.success) return;

      const timeline = [...parsedInitial.macroReleases, ...parsedRev.macroReleases];
      const lookupAtFeb15 = latestEligibleMacroRelease(timeline, "US_NFP_NET_CHANGE", FEB_02_2024_0830_EST + 86400000 * 13);
      expect(lookupAtFeb15?.value).toBe(353);
      expect(lookupAtFeb15?.revisionIndex).toBe(0);
    });

    it("N6: unemployment rate is not silently substituted for payroll change", () => {
      const parsed = parseBlsEmploymentRelease(rawJanNfp);
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;

      // Check macro releases separation
      const nfpRel = parsed.macroReleases.find((r) => r.seriesId === "US_NFP_NET_CHANGE");
      const urRel = parsed.macroReleases.find((r) => r.seriesId === "US_UNEMPLOYMENT_RATE");
      expect(nfpRel?.value).toBe(353);
      expect(urRel?.value).toBe(3.7);

      // Check event record strictly uses payroll net change
      const ev = parsed.eventRecords.find((e) => e.eventType === "NON_FARM_PAYROLLS_REPORT");
      expect(ev).toBeDefined();
      expect(ev?.actual).toBe(353);
      expect(ev?.actual).not.toBe(3.7);
    });

    it("N7: missing release witness fails closed", () => {
      const invalidWitness = {
        observationPeriod: "2024-01",
        nfpNetChangeThousands: 353,
      } as unknown as typeof rawJanNfp;

      const result = parseBlsEmploymentRelease(invalidWitness);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/Missing or malformed releaseDate/);
      }
    });

    it("N8: no synthetic consensus generated", () => {
      const parsed = parseBlsEmploymentRelease(rawJanNfp);
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;

      const ev = parsed.eventRecords[0];
      expect(ev.consensus).toBeNull();
      expect(ev.consensusFrozenAt).toBeNull();
      expect(ev.surprise).toBeNull();
    });

    it("N9: CES0000000001 is modeled/described as Total Nonfarm employment LEVEL, not direct net monthly change", () => {
      const nfpDef = BLS_SERIES_DEFINITIONS.US_NFP_NET_CHANGE;
      expect(nfpDef.underlyingLevelSeriesId).toBe("CES0000000001");
      expect(nfpDef.underlyingLevelDescription).toMatch(/Employment LEVEL/);
      expect(nfpDef.canonicalMeasure).toBe("US_NFP_NET_CHANGE");
      expect(nfpDef.canonicalMeasure).not.toBe("CES0000000001");
    });

    it("N10: US_NFP_NET_CHANGE source/derivation is explicit", () => {
      const nfpDef = BLS_SERIES_DEFINITIONS.US_NFP_NET_CHANGE;
      expect(nfpDef.measureDerivation).toBe("DIRECT_PUBLISHED_CHANGE");
      expect(nfpDef.unit).toBe("THOUSANDS_OF_PERSONS");
      expect(nfpDef.provider).toBe("BLS");
    });

    it("N11: Jan 2024 first-release NFP change = +353", () => {
      const parsed = parseBlsEmploymentRelease(REAL_HISTORICAL_FIXTURE_BLS_NFP[0]);
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;

      const nfpRel = parsed.macroReleases.find((r) => r.seriesId === "US_NFP_NET_CHANGE");
      expect(nfpRel?.value).toBe(353);
      expect(nfpRel?.revisionIndex).toBe(0);

      const nfpEv = parsed.eventRecords[0];
      expect(nfpEv.actual).toBe(353);
    });

    it("N12: Jan 2024 +353 remains visible before Mar 8 revision", () => {
      const parsed = parseBlsEmploymentRelease(REAL_HISTORICAL_FIXTURE_BLS_NFP);
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;

      // Decision on March 7, 2024 (before March 8 08:30 release of revision)
      const lookup = latestEligibleVintage(
        parsed.macroReleases,
        "US_NFP_NET_CHANGE",
        JAN_31_2024_UTC,
        MAR_08_2024_0830_EST - 1000
      );
      expect(lookup).not.toBeNull();
      expect(lookup?.value).toBe(353);
      expect(lookup?.revisionIndex).toBe(0);
    });

    it("N13: Mar 8 revision changes latest eligible January value to +229", () => {
      const parsed = parseBlsEmploymentRelease(REAL_HISTORICAL_FIXTURE_BLS_NFP);
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;

      // Decision at March 8 08:30 EST
      const lookup = latestEligibleVintage(
        parsed.macroReleases,
        "US_NFP_NET_CHANGE",
        JAN_31_2024_UTC,
        MAR_08_2024_0830_EST
      );
      expect(lookup).not.toBeNull();
      expect(lookup?.value).toBe(229);
      expect(lookup?.revisionIndex).toBe(1);
    });

    it("N14: initial +353 record remains preserved after revision", () => {
      const parsed = parseBlsEmploymentRelease(REAL_HISTORICAL_FIXTURE_BLS_NFP);
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;

      const janReleases = parsed.macroReleases.filter(
        (r) => r.seriesId === "US_NFP_NET_CHANGE" && r.observationTime === JAN_31_2024_UTC
      );
      expect(janReleases.length).toBe(2);

      const initial = janReleases.find((r) => r.revisionIndex === 0);
      const revision1 = janReleases.find((r) => r.revisionIndex === 1);

      expect(initial?.value).toBe(353);
      expect(initial?.publishedAt).toBe(FEB_02_2024_0830_EST);

      expect(revision1?.value).toBe(229);
      expect(revision1?.publishedAt).toBe(MAR_08_2024_0830_EST);
    });

    it("N15: no calculation mixes different vintages", () => {
      // Current observation from USDL-24-0148 (Jan 2024 initial release)
      const jan2024InitialLevel = { value: 157700, releaseId: "USDL-24-0148", releaseDate: "2024-02-02" };
      const dec2023ContemporaneousLevel = { value: 157347, releaseId: "USDL-24-0148", releaseDate: "2024-02-02" };

      // Same vintage subtraction succeeds: 157700 - 157347 = +353
      const consistentDiff = deriveVintageConsistentChange(jan2024InitialLevel, dec2023ContemporaneousLevel);
      expect(consistentDiff).toBe(353);

      // Revised Dec 2023 level from later USDL-24-0451 release (March 8, 2024)
      const dec2023RevisedLevel = { value: 157471, releaseId: "USDL-24-0451", releaseDate: "2024-03-08" };

      // Subtracting across conflicting release vintages must throw fail-closed
      expect(() => deriveVintageConsistentChange(jan2024InitialLevel, dec2023RevisedLevel)).toThrowError(
        HistoricalDatasetValidationError
      );
    });

    it("N16: unemployment rate remains a distinct series and cannot substitute for NFP", () => {
      const parsed = parseBlsEmploymentRelease(REAL_HISTORICAL_FIXTURE_BLS_NFP[0]);
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;

      const nfpRel = parsed.macroReleases.find((r) => r.seriesId === "US_NFP_NET_CHANGE");
      const urRel = parsed.macroReleases.find((r) => r.seriesId === "US_UNEMPLOYMENT_RATE");

      expect(nfpRel?.unit).toBe("THOUSANDS_OF_PERSONS");
      expect(urRel?.unit).toBe("PERCENT");
      expect(nfpRel?.value).toBe(353);
      expect(urRel?.value).toBe(3.7);

      // Event actual must strictly equal NFP net change, never the unemployment rate
      const ev = parsed.eventRecords[0];
      expect(ev.eventType).toBe("NON_FARM_PAYROLLS_REPORT");
      expect(ev.actual).toBe(353);
      expect(ev.actual).not.toBe(3.7);
    });
  });

  // ==========================================================================
  // 3. EVENT & CONSENSUS TEST REQUIREMENTS (E1 - E8)
  // ==========================================================================
  describe("Event Record & Consensus Integrity (E1 - E8)", () => {
    it("E1: official CPI event with actual but no consensus is visible", () => {
      const parsed = parseBlsCpiRelease(REAL_HISTORICAL_FIXTURE_BLS_CPI[0]);
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;

      const ev = parsed.eventRecords[0];
      const lookup = latestEligibleEvent([ev], FEB_13_2024_0830_EST);
      expect(lookup).not.toBeNull();
      expect(lookup?.eventId).toBe("BLS-CPI-2024-01");
      expect(lookup?.actual).toBe(3.1);
      expect(lookup?.consensus).toBeNull();
    });

    it("E2: official CPI event is NOT EventReactionEligible", () => {
      const parsed = parseBlsCpiRelease(REAL_HISTORICAL_FIXTURE_BLS_CPI[0]);
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;

      const ev = parsed.eventRecords[0];
      // Visible in replay, but strictly ineligible for EventReaction alpha generation
      expect(isEventReactionEligible(ev, FEB_13_2024_0830_EST)).toBe(false);
    });

    it("E3: NFP event without verified consensus is NOT EventReactionEligible", () => {
      const parsed = parseBlsEmploymentRelease(REAL_HISTORICAL_FIXTURE_BLS_NFP[0]);
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;

      const ev = parsed.eventRecords[0];
      expect(isEventReactionEligible(ev, FEB_02_2024_0830_EST)).toBe(false);
    });

    it("E4: consensus=null implies surprise=null", () => {
      const parsed = parseBlsCpiRelease(REAL_HISTORICAL_FIXTURE_BLS_CPI);
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;

      for (const ev of parsed.eventRecords) {
        if (ev.consensus === null) {
          expect(ev.surprise).toBeNull();
        }
      }
    });

    it("E5: previous value must not be used as consensus", () => {
      const parsed = parseBlsCpiRelease(REAL_HISTORICAL_FIXTURE_BLS_CPI[0]);
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;

      const ev = parsed.eventRecords[0];
      expect(ev.consensus).toBeNull();
      expect(ev.surprise).toBeNull();
    });

    it("E6: current/post-release estimate cannot populate historical consensus", () => {
      const parsed = parseBlsCpiRelease(REAL_HISTORICAL_FIXTURE_BLS_CPI);
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;

      for (const ev of parsed.eventRecords) {
        expect(ev.consensus).toBeNull();
        expect(ev.consensusFrozenAt).toBeNull();
      }
    });

    it("E7: consensusFrozenAt after publishedAt fails closed", () => {
      const lookaheadEvent: HistoricalEventRecord = {
        eventId: "TEST-LOOKAHEAD",
        eventType: "US_CPI_REPORT",
        observationTime: JAN_31_2024_UTC,
        publishedAt: FEB_13_2024_0830_EST,
        availableAt: FEB_13_2024_0830_EST,
        actual: 3.1,
        consensus: 2.9,
        // Frozen 1 hour AFTER release -> Lookahead violation!
        consensusFrozenAt: FEB_13_2024_0830_EST + 3600000,
        previous: 3.4,
        surprise: 0.2,
        provider: "BLS",
        sourceQuality: "TIER_1_OFFICIAL",
      };

      expect(() => validateHistoricalEvent(lookaheadEvent)).toThrowError(HistoricalDatasetValidationError);
    });

    it("E8: synthetic newsFeed events cannot enter canonical historical dataset", () => {
      // In src/lib/newsFeed.ts, synthetic historical events lack verified consensusFrozenAt timestamps
      // and mismatch PIT contracts. Verify that an unverified synthetic event fails validation.
      const syntheticFakeTier1: HistoricalEventRecord = {
        eventId: "pit-hist-135",
        eventType: "CPI_INFLATION_RELEASE",
        observationTime: FEB_01_2024_UTC,
        publishedAt: FEB_01_2024_UTC,
        availableAt: FEB_01_2024_UTC,
        actual: 2.8,
        consensus: 3.2,
        // Missing consensusFrozenAt while claiming surprise
        consensusFrozenAt: null,
        previous: 3.2,
        surprise: -0.4,
        provider: "BLS",
        sourceQuality: "TIER_1_OFFICIAL",
      };

      expect(() => validateHistoricalEvent(syntheticFakeTier1)).toThrowError(HistoricalDatasetValidationError);
    });
  });

  // ==========================================================================
  // 4. FOMC TEST REQUIREMENTS (F1 - F8)
  // ==========================================================================
  describe("FOMC Decision & Statement Ingestion (F1 - F8)", () => {
    const rawJanFomc = {
      eventId: "FED-FOMC-20240131",
      meetingDate: "2024-01-31",
      releaseDate: "2024-01-31",
      releaseTime: "14:00",
      eventType: "FED_RATE_DECISION" as const,
      targetRateUpper: 5.50,
      targetRateLower: 5.25,
      previousTargetRateUpper: 5.50,
    };

    it("F1: event invisible before verified statement publication time", () => {
      const parsed = parseFomcEvent(rawJanFomc);
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;

      const ev = parsed.eventRecords[0];
      // Meeting occurred Jan 30-31; before 14:00 EST (19:00 UTC), statement is invisible
      expect(latestEligibleEvent([ev], JAN_31_2024_1400_EST - 1)).toBeNull();
      expect(latestEligibleEvent([ev], JAN_31_2024_UTC)).toBeNull();
    });

    it("F2: visible exactly at publication boundary", () => {
      const parsed = parseFomcEvent(rawJanFomc);
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;

      const ev = parsed.eventRecords[0];
      const lookup = latestEligibleEvent([ev], JAN_31_2024_1400_EST);
      expect(lookup).not.toBeNull();
      expect(lookup?.actual).toBe(5.50);
      expect(lookup?.availableAt).toBe(JAN_31_2024_1400_EST);
    });

    it("F3: DST conversion is date-aware if release time is Eastern", () => {
      const parsedJan = parseFomcEvent(rawJanFomc);
      expect(parsedJan.success).toBe(true);
      if (!parsedJan.success) return;

      // Winter: Jan 31, 2024 14:00 EST -> 19:00:00 UTC (1706727600000)
      expect(parsedJan.eventRecords[0].publishedAt).toBe(JAN_31_2024_1400_EST);
      expect(parsedJan.eventRecords[0].publishedAt).toBe(1706727600000);

      const rawJunFomc = {
        eventId: "FED-FOMC-20240612",
        meetingDate: "2024-06-12",
        releaseDate: "2024-06-12",
        releaseTime: "14:00",
        targetRateUpper: 5.50,
      };
      const parsedJun = parseFomcEvent(rawJunFomc);
      expect(parsedJun.success).toBe(true);
      if (!parsedJun.success) return;

      // Summer: June 12, 2024 14:00 EDT -> 18:00:00 UTC (1718215200000)
      expect(parsedJun.eventRecords[0].publishedAt).toBe(JUN_12_2024_1400_EDT);
      expect(parsedJun.eventRecords[0].publishedAt).toBe(1718215200000);
    });

    it("F4: no fixed UTC release assumption", () => {
      // Both meetings were scheduled at 14:00 local time in America/New_York
      // But their UTC epoch hours differ: 19:00 UTC in winter vs 18:00 UTC in summer
      const janUtcHour = new Date(JAN_31_2024_1400_EST).getUTCHours();
      const junUtcHour = new Date(JUN_12_2024_1400_EDT).getUTCHours();
      expect(janUtcHour).toBe(19);
      expect(junUtcHour).toBe(18);
      expect(janUtcHour).not.toBe(junUtcHour);
    });

    it("F5: missing verified exact release time fails closed", () => {
      const missingTime = {
        meetingDate: "2024-01-31",
        releaseDate: "2024-01-31",
        targetRateUpper: 5.50,
      } as unknown as typeof rawJanFomc;

      const result = parseFomcEvent(missingTime);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/Missing or invalid explicit releaseTime/);
      }
    });

    it("F6: no fabricated consensus/surprise", () => {
      const parsed = parseFomcEvent(rawJanFomc);
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;

      const ev = parsed.eventRecords[0];
      expect(ev.consensus).toBeNull();
      expect(ev.consensusFrozenAt).toBeNull();
      expect(ev.surprise).toBeNull();
      expect(isEventReactionEligible(ev, JAN_31_2024_1400_EST)).toBe(false);
    });

    it("F7: official provider identity preserved", () => {
      const parsed = parseFomcEvent(rawJanFomc);
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;

      const ev = parsed.eventRecords[0];
      expect(ev.provider).toBe("FEDERAL_RESERVE");
      expect(ev.sourceQuality).toBe("TIER_1_OFFICIAL");
    });

    it("F8: qualitative statement event does not require numeric fake actual", () => {
      const qualitativeEvent = {
        eventId: "FED-FOMC-STATEMENT-QUAL",
        meetingDate: "2024-01-31",
        releaseDate: "2024-01-31",
        releaseTime: "14:00",
        eventType: "FOMC_STATEMENT" as const,
        isQualitativeOnly: true,
        statementText: "Statement on Longer-Run Goals and Monetary Policy Strategy.",
      };

      const parsed = parseFomcEvent(qualitativeEvent);
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;

      const ev = parsed.eventRecords[0];
      expect(ev.actual).toBeNull(); // No fake zero!
      expect(ev.eventType).toBe("FOMC_STATEMENT");
      expect(() => validateHistoricalEvent(ev)).not.toThrow();

      const lookup = latestEligibleEvent([ev], JAN_31_2024_1400_EST);
      expect(lookup).not.toBeNull();
      expect(lookup?.actual).toBeNull();
    });
  });

  // ==========================================================================
  // 5. DETERMINISTIC DATASET NORMALIZATION & BUILDERS
  // ==========================================================================
  describe("Dataset Normalization & Builder Functions", () => {
    it("builds valid deterministic macro releases and event records from real fixtures", () => {
      const releases = buildRealHistoricalMacroReleases();
      const events = buildRealHistoricalEventRecords();

      expect(releases.length).toBeGreaterThan(0);
      expect(events.length).toBeGreaterThan(0);

      const dataset: HistoricalDataset = {
        marketObservations: [],
        macroReleases: releases,
        eventRecords: events,
      };

      expect(() => validateHistoricalDataset(dataset)).not.toThrow();
      const normalized = normalizeHistoricalDataset(dataset);
      expect(normalized.macroReleases.length).toBe(releases.length);
      expect(normalized.eventRecords.length).toBe(events.length);
    });

    it("parses REAL_HISTORICAL_FIXTURE_FOMC accurately without errors", () => {
      const result = parseFomcEvent(REAL_HISTORICAL_FIXTURE_FOMC);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.eventRecords.length).toBe(REAL_HISTORICAL_FIXTURE_FOMC.length);
      for (const rel of result.macroReleases) {
        expect(() => validateHistoricalMacroRelease(rel)).not.toThrow();
      }
    });

    it("fails closed on all invalid synthetic BLS fixtures", () => {
      for (const invalid of SYNTHETIC_TEST_FIXTURE_INVALID_BLS) {
        const result = parseBlsCpiRelease(invalid as unknown as Parameters<typeof parseBlsCpiRelease>[0]);
        expect(result.success).toBe(false);
      }
    });

    it("fails closed on all invalid synthetic FOMC fixtures", () => {
      for (const invalid of SYNTHETIC_TEST_FIXTURE_INVALID_FOMC) {
        const result = parseFomcEvent(invalid as unknown as Parameters<typeof parseFomcEvent>[0]);
        expect(result.success).toBe(false);
      }
    });

    it("getReferenceMonthEndEpochMs computes exact end of month and handles leap years", () => {
      // Jan 2024 (31 days)
      expect(getReferenceMonthEndEpochMs("2024-01")).toBe(JAN_31_2024_UTC);
      // Feb 2024 leap year (29 days)
      expect(getReferenceMonthEndEpochMs("2024-02")).toBe(FEB_29_2024_UTC);
      // Feb 2023 non-leap year (28 days)
      const feb28_2023 = Date.UTC(2023, 1, 28, 0, 0, 0, 0);
      expect(getReferenceMonthEndEpochMs("2023-02")).toBe(feb28_2023);
    });
  });
});
