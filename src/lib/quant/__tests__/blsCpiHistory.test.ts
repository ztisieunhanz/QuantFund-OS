import { describe, expect, it } from "vitest";
import { RESEARCH_SERIES_SPECS } from "../researchDataProtocol";
import * as historicalSources from "../historicalSources";
import {
  BLS_CPI_MOM_STATUS,
  BLS_CPI_RELEASE_TIME,
  BLS_CPI_RELEASE_TIME_ZONE,
  acquireBlsCpiHistory,
  evaluateBlsCpiMomSeasonalVintagePair,
  processBlsCpiHistory,
  type BlsCpiReleaseArtifactInput,
} from "../historicalSources/blsCpiHistory";
import { sha256Hex } from "../historicalSources/immutableAcquisition";

const RETRIEVED_AT = "2026-09-23T12:00:00.000Z";
const RELEASED_THROUGH = Date.parse("2026-09-23T23:59:59.999Z");

interface ReleaseFixture {
  readonly referenceMonth: string;
  readonly referenceYear: number;
  readonly releaseMonth: string;
  readonly releaseDay: number;
  readonly releaseYear: number;
  readonly weekday?: string | null;
  readonly releaseId: string;
  readonly indexValue: number;
  readonly yoyValue: number;
  readonly releaseTime?: string;
  readonly titleSeparator?: string;
  readonly verb?: "increased" | "decreased";
  readonly sourceUrl?: string;
}

function monthNumber(month: string): string {
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  return String(months.indexOf(month) + 1).padStart(2, "0");
}

function releaseHtml(fixture: ReleaseFixture): string {
  const verb = fixture.verb ?? "increased";
  return `<!doctype html><html><body>
    <h1>Consumer Price Index News Release</h1>
    <p>Transmission of material in this release is embargoed until
    ${fixture.releaseTime ?? "8:30 a.m."} (ET) ${fixture.weekday === null ? "" : `${fixture.weekday ?? "Thursday"}, `}
    ${fixture.releaseMonth} ${fixture.releaseDay}, ${fixture.releaseYear} ${fixture.releaseId}</p>
    <h2>CONSUMER PRICE INDEX ${fixture.titleSeparator ?? "-"} ${fixture.referenceMonth.toUpperCase()} ${fixture.referenceYear}</h2>
    <p>The Consumer Price Index for All Urban Consumers (CPI-U) ${verb}
    ${Math.abs(fixture.yoyValue)} percent over the last 12 months to an index level of
    ${fixture.indexValue} (1982-84=100).</p>
  </body></html>`;
}

function sourceUrl(fixture: ReleaseFixture): string {
  return fixture.sourceUrl ??
    `https://www.bls.gov/news.release/archives/cpi_${monthNumber(fixture.releaseMonth)}` +
    `${String(fixture.releaseDay).padStart(2, "0")}${fixture.releaseYear}.htm`;
}

function artifact(fixture: ReleaseFixture, retrievedAt = RETRIEVED_AT): BlsCpiReleaseArtifactInput {
  return {
    sourceUrl: sourceUrl(fixture),
    responseBytes: new TextEncoder().encode(releaseHtml(fixture)),
    retrievedAt,
  };
}

const JULY_2023: ReleaseFixture = Object.freeze({
  referenceMonth: "July",
  referenceYear: 2023,
  releaseMonth: "August",
  releaseDay: 10,
  releaseYear: 2023,
  releaseId: "USDL-23-1755",
  indexValue: 305.691,
  yoyValue: 3.2,
});

const DECEMBER_2023: ReleaseFixture = Object.freeze({
  referenceMonth: "December",
  referenceYear: 2023,
  releaseMonth: "January",
  releaseDay: 11,
  releaseYear: 2024,
  releaseId: "USDL-24-0019",
  indexValue: 306.746,
  yoyValue: 3.4,
});

function process(fixtures: readonly ReleaseFixture[] = [JULY_2023], overrides: {
  readonly retrievedAt?: string;
  readonly releasedThroughMs?: number;
} = {}) {
  return processBlsCpiHistory({
    artifacts: fixtures.map((fixture) => artifact(fixture, overrides.retrievedAt)),
    releasedThroughMs: overrides.releasedThroughMs ?? RELEASED_THROUGH,
  });
}

describe("Gate M13B-2/B2-B4 — BLS archived CPI PIT acquisition", () => {
  it("parses a valid as-published CPI-U NSA index", () => {
    expect(process().series.US_CPI_INDEX.releases[0]).toMatchObject({
      seriesId: "US_CPI_INDEX",
      value: 305.691,
      revisionIndex: 0,
      provider: "BLS_ARCHIVED_CPI_RELEASE",
      unit: "INDEX_1982_84_100",
    });
  });

  it("parses the explicit published 12-month NSA change without recomputation", () => {
    expect(process().series.US_CPI_YOY.releases[0]).toMatchObject({
      seriesId: "US_CPI_YOY",
      value: 3.2,
      unit: "PERCENT_12_MONTH_NSA",
    });
  });

  it("normalizes the reference period to UTC month-end", () => {
    expect(process().series.US_CPI_INDEX.releases[0].observationTime)
      .toBe(Date.parse("2023-07-31T00:00:00.000Z"));
  });

  it("maps a summer release to 08:30 America/New_York with DST", () => {
    expect(process().series.US_CPI_YOY.releases[0].availableAt)
      .toBe(Date.parse("2023-08-10T12:30:00.000Z"));
  });

  it("maps a winter release to 08:30 America/New_York with DST", () => {
    expect(process([DECEMBER_2023]).series.US_CPI_YOY.releases[0].availableAt)
      .toBe(Date.parse("2024-01-11T13:30:00.000Z"));
  });

  it("accepts the proven 2021 archive header variant without a weekday", () => {
    const legacy: ReleaseFixture = {
      referenceMonth: "January",
      referenceYear: 2021,
      releaseMonth: "February",
      releaseDay: 10,
      releaseYear: 2021,
      weekday: null,
      titleSeparator: "�",
      releaseId: "USDL-21-0226",
      indexValue: 261.582,
      yoyValue: 1.4,
    };
    expect(process([legacy]).series.US_CPI_INDEX.releases[0].value).toBe(261.582);
  });

  it("fails closed on a reissued or errata-bearing archived release", () => {
    const input = artifact(JULY_2023);
    const html = releaseHtml(JULY_2023).replace(
      "<h2>",
      "<p>NOTE: This news release was reissued to correct values.</p><h2>"
    );
    expect(() => processBlsCpiHistory({
      artifacts: [{ ...input, responseBytes: new TextEncoder().encode(html) }],
      releasedThroughMs: RELEASED_THROUGH,
    })).toThrow(/reissue or errata/i);
  });

  it("keeps publication and availability equal to the witnessed release boundary", () => {
    const release = process().series.US_CPI_INDEX.releases[0];
    expect(release.publishedAt).toBe(release.availableAt);
    expect(release.availableAt).toBeGreaterThan(release.observationTime);
  });

  it("preserves official release identity and raw provenance", () => {
    const result = process();
    expect(result.releaseEvidence[0]).toMatchObject({
      releaseId: "USDL-23-1755",
      referencePeriod: "2023-07",
      releaseDate: "2023-08-10",
      releaseTime: "08:30",
    });
    expect(result.series.US_CPI_INDEX.vintageEvidence[0].artifactId)
      .toBe(result.artifacts[0].artifactId);
  });

  it("distinguishes a later changed vintage for the same reference period", () => {
    const correction: ReleaseFixture = {
      ...JULY_2023,
      releaseMonth: "September",
      releaseDay: 13,
      releaseId: "USDL-23-1900",
      indexValue: 305.700,
      yoyValue: 3.3,
    };
    const result = process([JULY_2023, correction]);
    expect(result.series.US_CPI_INDEX.releases.map((row) => row.revisionIndex)).toEqual([0, 1]);
    expect(result.series.US_CPI_YOY.releases.map((row) => row.value)).toEqual([3.2, 3.3]);
  });

  it("does not create a synthetic revision when a later witness has the same value", () => {
    const repeated: ReleaseFixture = {
      ...JULY_2023,
      releaseMonth: "September",
      releaseDay: 13,
      releaseId: "USDL-23-1900",
    };
    const result = process([JULY_2023, repeated]);
    expect(result.series.US_CPI_INDEX.releases).toHaveLength(1);
    expect(result.series.US_CPI_YOY.releases).toHaveLength(1);
  });

  it("sorts multiple releases deterministically", () => {
    const result = process([DECEMBER_2023, JULY_2023]);
    expect(result.releaseEvidence.map((row) => row.referencePeriod)).toEqual(["2023-07", "2023-12"]);
  });

  it("makes normalized identity independent of source artifact order", () => {
    const forward = process([JULY_2023, DECEMBER_2023]);
    const reverse = process([DECEMBER_2023, JULY_2023]);
    expect(reverse.series.US_CPI_INDEX.normalizedContentHash)
      .toBe(forward.series.US_CPI_INDEX.normalizedContentHash);
    expect(reverse.series.US_CPI_YOY.normalizedContentHash)
      .toBe(forward.series.US_CPI_YOY.normalizedContentHash);
  });

  it("changes normalized identity when the release date changes", () => {
    const changed: ReleaseFixture = {
      ...JULY_2023,
      releaseMonth: "August",
      releaseDay: 11,
    };
    expect(process([changed]).series.US_CPI_INDEX.normalizedContentHash)
      .not.toBe(process().series.US_CPI_INDEX.normalizedContentHash);
  });

  it("changes normalized identity when the published value changes", () => {
    const changed = { ...JULY_2023, indexValue: 305.692, yoyValue: 3.3 };
    expect(process([changed]).series.US_CPI_YOY.normalizedContentHash)
      .not.toBe(process().series.US_CPI_YOY.normalizedContentHash);
  });

  it("excludes retrieval time from normalized identity", () => {
    const first = process();
    const second = process([JULY_2023], { retrievedAt: "2026-09-24T00:00:00.000Z" });
    expect(second.series.US_CPI_INDEX.normalizedContentHash)
      .toBe(first.series.US_CPI_INDEX.normalizedContentHash);
  });

  it("computes deterministic raw SHA-256", () => {
    const input = artifact(JULY_2023);
    expect(process().artifacts[0].rawSha256).toBe(sha256Hex(input.responseBytes));
  });

  it("records truthful NOT_PUBLISHED provider checksum semantics", () => {
    const artifactResult = process().artifacts[0];
    expect(artifactResult.providerChecksum).toBeNull();
    expect(artifactResult.request.checksumUrl).toBeNull();
  });

  it("rejects an empty artifact", () => {
    expect(() => processBlsCpiHistory({
      artifacts: [{ ...artifact(JULY_2023), responseBytes: new Uint8Array() }],
      releasedThroughMs: RELEASED_THROUGH,
    })).toThrow(/non-empty provider artifact/i);
  });

  it("rejects corrupted or non-HTML content", () => {
    expect(() => processBlsCpiHistory({
      artifacts: [{ ...artifact(JULY_2023), responseBytes: new TextEncoder().encode("not html") }],
      releasedThroughMs: RELEASED_THROUGH,
    })).toThrow(/supported HTML/i);
  });

  it("rejects an unsupported release schema", () => {
    const bytes = new TextEncoder().encode("<!doctype html><html><body>missing release</body></html>");
    expect(() => processBlsCpiHistory({
      artifacts: [{ ...artifact(JULY_2023), responseBytes: bytes }],
      releasedThroughMs: RELEASED_THROUGH,
    })).toThrow(/unsupported or missing/i);
  });

  it("rejects a malformed or unproven release time", () => {
    expect(() => process([{ ...JULY_2023, releaseTime: "9:00 a.m." }]))
      .toThrow(/outside the proven 08:30 ET regime/i);
  });

  it("rejects a malformed reference period", () => {
    expect(() => process([{ ...JULY_2023, referenceMonth: "Smarch" }]))
      .toThrow(/unsupported reference month/i);
  });

  it("rejects a malformed release date", () => {
    expect(() => process([{ ...JULY_2023, releaseDay: 32 }]))
      .toThrow(/valid calendar date/i);
  });

  it("rejects a source URL date that conflicts with the release header", () => {
    expect(() => process([{ ...JULY_2023, sourceUrl: "https://www.bls.gov/news.release/archives/cpi_08112023.htm" }]))
      .toThrow(/conflicts with the release header/i);
  });

  it("rejects non-official source provenance", () => {
    expect(() => process([{ ...JULY_2023, sourceUrl: "https://example.com/cpi_08102023.htm" }]))
      .toThrow(/official archived BLS CPI HTML/i);
  });

  it("rejects a release whose reference period is outside the proven regime", () => {
    expect(() => process([{ ...JULY_2023, referenceYear: 2020 }]))
      .toThrow(/outside the proven archive regime/i);
  });

  it("rejects a release at or before its reference-period boundary", () => {
    const invalid: ReleaseFixture = {
      ...JULY_2023,
      releaseMonth: "July",
      releaseDay: 31,
      releaseId: "USDL-23-1700",
    };
    expect(() => process([invalid])).toThrow(/must follow the reference period boundary/i);
  });

  it("rejects a release beyond the acquisition boundary", () => {
    expect(() => process([JULY_2023], {
      releasedThroughMs: Date.parse("2023-08-10T12:29:59.999Z"),
    })).toThrow(/incomplete or unreleased/i);
  });

  it("accepts a release exactly at the acquisition boundary", () => {
    expect(() => process([JULY_2023], {
      releasedThroughMs: Date.parse("2023-08-10T12:30:00.000Z"),
    })).not.toThrow();
  });

  it("rejects an exact duplicate source artifact", () => {
    expect(() => process([JULY_2023, JULY_2023])).toThrow(/duplicate source artifact/i);
  });

  it("rejects a conflicting duplicate release identity", () => {
    const conflict = {
      ...JULY_2023,
      sourceUrl: "https://www.bls.gov/news.release/archives/cpi_08112023.htm",
      releaseMonth: "August",
      releaseDay: 11,
      indexValue: 999,
    };
    expect(() => process([JULY_2023, conflict])).toThrow(/duplicate or conflicting release ID/i);
  });

  it("counts missing monthly reference periods without interpolation", () => {
    const result = process([JULY_2023, DECEMBER_2023]).series.US_CPI_INDEX.coverage;
    expect(result.missingReferencePeriods).toEqual(["2023-08", "2023-09", "2023-10", "2023-11"]);
    expect(result.missingCount).toBe(4);
    expect(result.observationPeriodCount).toBe(2);
  });

  it("emits canonical manifest semantics for both implemented series", () => {
    const result = process();
    for (const seriesId of ["US_CPI_INDEX", "US_CPI_YOY"] as const) {
      expect(result.series[seriesId].manifestEntry).toMatchObject({
        seriesId,
        kind: "MACRO_RELEASE",
        cadence: "MONTHLY",
        revisionSemantics: "VINTAGE_AWARE",
      });
      expect(RESEARCH_SERIES_SPECS[seriesId]).toEqual({
        kind: "MACRO_RELEASE",
        cadence: "MONTHLY",
        revisionSemantics: "VINTAGE_AWARE",
      });
    }
  });

  it("remains research-only and research-context-only", () => {
    const result = process();
    expect(result.intendedUse).toBe("RESEARCH_ONLY");
    expect(result.priceAuthority).toBe("RESEARCH_CONTEXT_ONLY");
  });

  it("does not expose assetBars, readiness, execution, allocation, or accounting outputs", () => {
    const result = process() as unknown as Record<string, unknown>;
    expect(result).not.toHaveProperty("assetBars");
    expect(result).not.toHaveProperty("readiness");
    expect(result).not.toHaveProperty("targetWeights");
    expect(result).not.toHaveProperty("fills");
    expect(result).not.toHaveProperty("ledger");
  });

  it("keeps CPI MoM conditional and exposes no broad ingestion path", () => {
    expect(process().cpiMomStatus).toBe("CONDITIONAL");
    expect(BLS_CPI_MOM_STATUS).toBe("CONDITIONAL");
    expect("processBlsCpiMomHistory" in historicalSources).toBe(false);
    expect("acquireBlsCpiMomHistory" in historicalSources).toBe(false);
  });

  it("detects the representative December 2023 seasonal-revision difference", () => {
    const proof = evaluateBlsCpiMomSeasonalVintagePair({
      referencePeriod: "2023-12",
      releaseId: "USDL-24-0019",
      releaseDate: "2024-01-11",
      value: 0.3,
      sourceUrl: "https://www.bls.gov/news.release/archives/cpi_01112024.htm",
    }, {
      referencePeriod: "2023-12",
      releaseId: "USDL-24-0256",
      releaseDate: "2024-02-13",
      value: 0.2,
      sourceUrl: "https://www.bls.gov/news.release/archives/cpi_02132024.htm",
    });
    expect(proof).toMatchObject({
      status: "CONDITIONAL",
      initialValue: 0.3,
      revisedValue: 0.2,
      revisionDetected: true,
    });
  });

  it("fails the CPI MoM proof when a required vintage witness is missing", () => {
    expect(() => evaluateBlsCpiMomSeasonalVintagePair({
      referencePeriod: "2023-12",
      releaseId: "USDL-24-0019",
      releaseDate: "2024-01-11",
      value: 0.3,
      sourceUrl: "https://www.bls.gov/news.release/archives/cpi_01112024.htm",
    }, undefined as never)).toThrow();
  });

  it("does not accept a current revised SA value as an initial CPI MoM release", () => {
    expect("US_CPI_MOM" in process().series).toBe(false);
  });

  it("keeps the rejected Cboe VIX adapter absent", () => {
    expect("processCboeVixHistory" in historicalSources).toBe(false);
    expect("acquireCboeVixHistory" in historicalSources).toBe(false);
  });

  it("uses a thin injectable network acquisition boundary", async () => {
    const input = artifact(JULY_2023);
    const requested: string[] = [];
    const result = await acquireBlsCpiHistory({
      sourceUrls: [input.sourceUrl],
      retrievedAt: RETRIEVED_AT,
      releasedThroughMs: RELEASED_THROUGH,
    }, {
      fetchBinary: async (url) => {
        requested.push(url);
        return input.responseBytes;
      },
    });
    expect(requested).toEqual([input.sourceUrl]);
    expect(result.series.US_CPI_YOY.releases[0].value).toBe(3.2);
  });

  it("exports the proven release time contract", () => {
    expect(BLS_CPI_RELEASE_TIME).toBe("08:30");
    expect(BLS_CPI_RELEASE_TIME_ZONE).toBe("America/New_York");
  });
});
