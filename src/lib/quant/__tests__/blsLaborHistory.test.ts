import { describe, expect, it } from "vitest";
import { RESEARCH_SERIES_SPECS } from "../researchDataProtocol";
import * as historicalSources from "../historicalSources";
import {
  BLS_LABOR_RELEASE_TIME,
  BLS_LABOR_RELEASE_TIME_ZONE,
  BLS_UNEMPLOYMENT_STATUS,
  acquireBlsLaborHistory,
  evaluateBlsUnemploymentVintagePair,
  processBlsLaborHistory,
  type BlsLaborReleaseArtifactInput,
} from "../historicalSources/blsLaborHistory";
import { BLS_CPI_MOM_STATUS } from "../historicalSources/blsCpiHistory";
import { sha256Hex } from "../historicalSources/immutableAcquisition";

const RETRIEVED_AT = "2026-09-24T12:00:00.000Z";
const RELEASED_THROUGH = Date.parse("2026-09-24T23:59:59.999Z");

interface LaborFixture {
  readonly referenceMonth: string;
  readonly referenceYear: number;
  readonly releaseMonth: string;
  readonly releaseDay: number;
  readonly releaseYear: number;
  readonly releaseId: string;
  readonly initialValue: number;
  readonly olderMonth: string;
  readonly olderPrevious: number;
  readonly olderRevised: number;
  readonly newerMonth: string;
  readonly newerPrevious: number;
  readonly newerRevised: number;
  readonly releaseTime?: string;
  readonly correctionNotice?: string;
  readonly sourceUrl?: string;
  readonly initialSentence?: string;
  readonly titleSeparator?: "-" | "--";
}

const MONTH_NUMBER: Readonly<Record<string, string>> = Object.freeze({
  January: "01", February: "02", March: "03", April: "04", May: "05", June: "06",
  July: "07", August: "08", September: "09", October: "10", November: "11", December: "12",
});

function signed(value: number): string {
  const absolute = Math.abs(value * 1_000).toLocaleString("en-US");
  return `${value >= 0 ? "+" : "-"}${absolute}`;
}

function releaseHtml(fixture: LaborFixture): string {
  const initial = fixture.initialSentence ??
    `Total nonfarm payroll employment rose by ${(fixture.initialValue * 1_000).toLocaleString("en-US")} ` +
    `in ${fixture.referenceMonth}, and the unemployment rate remained at 3.7 percent.`;
  return `<!doctype html><html><body>
    <p>Transmission of material in this news release is embargoed until ${fixture.releaseId}
    ${fixture.releaseTime ?? "8:30 a.m."} (ET) Friday, ${fixture.releaseMonth} ${fixture.releaseDay}, ${fixture.releaseYear}</p>
    <h1>THE EMPLOYMENT SITUATION ${fixture.titleSeparator ?? "--"} ${fixture.referenceMonth.toUpperCase()} ${fixture.referenceYear}</h1>
    <p>${fixture.correctionNotice ?? ""}</p>
    <p>${initial}</p>
    <p>Establishment Survey Data</p>
    <p>${initial}</p>
    <p>The change in total nonfarm payroll employment for ${fixture.olderMonth} was revised down by 1,000,
    from ${signed(fixture.olderPrevious)} to ${signed(fixture.olderRevised)}, and the change for
    ${fixture.newerMonth} was revised down by 1,000, from ${signed(fixture.newerPrevious)} to
    ${signed(fixture.newerRevised)}. With these revisions, employment changed.</p>
  </body></html>`;
}

function sourceUrl(fixture: LaborFixture): string {
  return fixture.sourceUrl ?? `${"https://www.bls.gov/news.release/archives/empsit_"}` +
    `${MONTH_NUMBER[fixture.releaseMonth]}${String(fixture.releaseDay).padStart(2, "0")}${fixture.releaseYear}.htm`;
}

function artifact(fixture: LaborFixture, retrievedAt = RETRIEVED_AT): BlsLaborReleaseArtifactInput {
  return {
    sourceUrl: sourceUrl(fixture),
    responseBytes: new TextEncoder().encode(releaseHtml(fixture)),
    retrievedAt,
  };
}

const JANUARY_2024: LaborFixture = Object.freeze({
  referenceMonth: "January", referenceYear: 2024,
  releaseMonth: "February", releaseDay: 2, releaseYear: 2024,
  releaseId: "USDL-24-0148", initialValue: 353,
  olderMonth: "November", olderPrevious: 173, olderRevised: 182,
  newerMonth: "December", newerPrevious: 216, newerRevised: 333,
});

const FEBRUARY_2024: LaborFixture = Object.freeze({
  referenceMonth: "February", referenceYear: 2024,
  releaseMonth: "March", releaseDay: 8, releaseYear: 2024,
  releaseId: "USDL-24-0451", initialValue: 275,
  olderMonth: "December", olderPrevious: 333, olderRevised: 290,
  newerMonth: "January", newerPrevious: 353, newerRevised: 229,
});

const MARCH_2024: LaborFixture = Object.freeze({
  referenceMonth: "March", referenceYear: 2024,
  releaseMonth: "April", releaseDay: 5, releaseYear: 2024,
  releaseId: "USDL-24-0574", initialValue: 303,
  olderMonth: "January", olderPrevious: 229, olderRevised: 256,
  newerMonth: "February", newerPrevious: 275, newerRevised: 270,
});

const JANUARY_2021: LaborFixture = Object.freeze({
  referenceMonth: "January", referenceYear: 2021,
  releaseMonth: "February", releaseDay: 5, releaseYear: 2021,
  releaseId: "USDL-21-0158", initialValue: 49,
  olderMonth: "November", olderPrevious: 336, olderRevised: 264,
  newerMonth: "December", newerPrevious: -140, newerRevised: -227,
  initialSentence:
    "The unemployment rate fell by 0.4 percentage point to 6.3 percent in January, while " +
    "nonfarm payroll employment changed little (+49,000), the U.S. Bureau of Labor Statistics reported today.",
});

function process(fixtures: readonly LaborFixture[] = [JANUARY_2024], options: {
  readonly retrievedAt?: string;
  readonly releasedThroughMs?: number;
} = {}) {
  return processBlsLaborHistory({
    artifacts: fixtures.map((fixture) => artifact(fixture, options.retrievedAt)),
    releasedThroughMs: options.releasedThroughMs ?? RELEASED_THROUGH,
  });
}

describe("Gate M13B-2/B2-B6 — BLS labor PIT acquisition", () => {
  it("parses the direct initial total-nonfarm monthly change", () => {
    const release = process().macroReleases.find((item) => item.revisionIndex === 0);
    expect(release).toMatchObject({
      seriesId: "US_NFP_NET_CHANGE",
      value: 353,
      unit: "THOUSANDS_OF_PERSONS",
      provider: "BLS_ARCHIVED_EMPLOYMENT_SITUATION",
    });
  });

  it("accepts the proven changed-little headline and excludes prior revisions outside the bounded regime", () => {
    const result = process([JANUARY_2021]);
    expect(result.vintageEvidence).toHaveLength(1);
    expect(result.vintageEvidence[0]).toMatchObject({
      referencePeriod: "2021-01", revisionIndex: 0, value: 49,
    });
  });

  it("accepts the official 2026 single-hyphen title schema", () => {
    expect(process([{ ...MARCH_2024, titleSeparator: "-" }]).releaseEvidence[0].releaseReferencePeriod)
      .toBe("2024-03");
  });

  it("parses the explicit first revision", () => {
    const release = process().macroReleases.find((item) => item.revisionIndex === 1);
    expect(release).toMatchObject({ value: 333, revisionIndex: 1 });
  });

  it("parses the explicit second/final regular revision", () => {
    const release = process().macroReleases.find((item) => item.revisionIndex === 2);
    expect(release).toMatchObject({ value: 182, revisionIndex: 2 });
  });

  it("preserves multiple vintages for one reference month", () => {
    const vintages = process([JANUARY_2024, FEBRUARY_2024, MARCH_2024]).vintageEvidence
      .filter((item) => item.referencePeriod === "2024-01");
    expect(vintages.map((item) => [item.revisionIndex, item.value])).toEqual([[0, 353], [1, 229], [2, 256]]);
  });

  it("assigns distinct canonical vintage identity", () => {
    const vintages = process([JANUARY_2024, FEBRUARY_2024, MARCH_2024]).vintageEvidence
      .filter((item) => item.referencePeriod === "2024-01");
    expect(new Set(vintages.map((item) => `${item.referencePeriod}#${item.revisionIndex}#${item.releaseId}`)).size).toBe(3);
  });

  it("retains the initial value after later revisions", () => {
    const values = process([JANUARY_2024, FEBRUARY_2024, MARCH_2024]).macroReleases
      .filter((item) => item.observationTime === Date.parse("2024-01-31T00:00:00.000Z"))
      .map((item) => item.value);
    expect(values).toEqual([353, 229, 256]);
  });

  it("does not overwrite a prior vintage", () => {
    const rows = process([JANUARY_2024, FEBRUARY_2024]).macroReleases
      .filter((item) => item.observationTime === Date.parse("2024-01-31T00:00:00.000Z"));
    expect(rows).toHaveLength(2);
    expect(rows.map((item) => item.revisionIndex)).toEqual([0, 1]);
  });

  it("converts an EST release boundary", () => {
    const initial = process().macroReleases.find((item) => item.revisionIndex === 0);
    expect(initial?.availableAt).toBe(Date.parse("2024-02-02T13:30:00.000Z"));
  });

  it("converts an EDT release boundary", () => {
    const initial = process([MARCH_2024]).macroReleases.find((item) => item.revisionIndex === 0);
    expect(initial?.availableAt).toBe(Date.parse("2024-04-05T12:30:00.000Z"));
  });

  it("is visible exactly at the release boundary", () => {
    const boundary = Date.parse("2024-02-02T13:30:00.000Z");
    expect(() => process([JANUARY_2024], { releasedThroughMs: boundary })).not.toThrow();
  });

  it("excludes a future release at releasedThroughMs", () => {
    const result = process([JANUARY_2024, FEBRUARY_2024], {
      releasedThroughMs: Date.parse("2024-02-02T13:30:00.000Z"),
    });
    expect(result.releaseEvidence.map((item) => item.releaseId)).toEqual(["USDL-24-0148"]);
    expect(result.macroReleases.some((item) => item.value === 275)).toBe(false);
  });

  it("excludes future raw artifact and provenance identity", () => {
    const result = process([JANUARY_2024, FEBRUARY_2024], {
      releasedThroughMs: Date.parse("2024-02-02T13:30:00.000Z"),
    });
    expect(result.artifacts).toHaveLength(1);
    expect(result.manifestEntry.provenance).not.toContain("empsit_03082024.htm");
    expect(result.coverage.lastAvailableAt).toBe(Date.parse("2024-02-02T13:30:00.000Z"));
  });

  it("fails when no artifact is public", () => {
    expect(() => process([JANUARY_2024], { releasedThroughMs: Date.parse("2024-02-02T13:29:59.999Z") }))
      .toThrow(/no archived Employment Situation release was public/i);
  });

  it("rejects a malformed initial value", () => {
    expect(() => process([{ ...JANUARY_2024, initialSentence: "Total nonfarm payroll employment rose by many in January." }]))
      .toThrow(/missing or conflicting explicit initial/i);
  });

  it("rejects conflicting initial prose values", () => {
    const input = artifact(JANUARY_2024);
    const html = releaseHtml(JANUARY_2024).replace("</body>", "<p>Total nonfarm payroll employment rose by 999,000 in January.</p></body>");
    expect(() => processBlsLaborHistory({
      artifacts: [{ ...input, responseBytes: new TextEncoder().encode(html) }],
      releasedThroughMs: RELEASED_THROUGH,
    })).toThrow(/conflicting explicit initial/i);
  });

  it("rejects a conflicting vintage chain", () => {
    expect(() => process([JANUARY_2024, { ...FEBRUARY_2024, newerPrevious: 352 }]))
      .toThrow(/revision chain conflict/i);
  });

  it("rejects a duplicate source release", () => {
    expect(() => process([JANUARY_2024, JANUARY_2024])).toThrow(/duplicate source artifact/i);
  });

  it("rejects duplicate release identity across different official URLs", () => {
    const duplicate = {
      ...JANUARY_2024,
      releaseMonth: "February", releaseDay: 3,
      sourceUrl: "https://www.bls.gov/news.release/archives/empsit_02032024.htm",
    };
    expect(() => process([JANUARY_2024, duplicate])).toThrow(/duplicate or conflicting release ID/i);
  });

  it("rejects an unsupported historical regime", () => {
    expect(() => process([{ ...JANUARY_2024, referenceYear: 2020 }])).toThrow(/outside the proven archive regime/i);
  });

  it("rejects correction or reissue ambiguity", () => {
    expect(() => process([{ ...JANUARY_2024, correctionNotice: "This news release was reissued to correct data." }]))
      .toThrow(/correction\/reissue/i);
  });

  it("rejects missing revision prose", () => {
    const input = artifact(JANUARY_2024);
    const html = releaseHtml(JANUARY_2024).replace(/The change in total nonfarm[^<]+/u, "Revision unavailable.");
    expect(() => processBlsLaborHistory({
      artifacts: [{ ...input, responseBytes: new TextEncoder().encode(html) }],
      releasedThroughMs: RELEASED_THROUGH,
    })).toThrow(/missing or conflicting first\/second payroll revision/i);
  });

  it("rejects revision months inconsistent with the title", () => {
    expect(() => process([{ ...JANUARY_2024, olderMonth: "October" }])).toThrow(/revision months/i);
  });

  it("rejects an unproven release clock", () => {
    expect(() => process([{ ...JANUARY_2024, releaseTime: "9:00 a.m." }])).toThrow(/08:30 ET embargo/i);
  });

  it("rejects non-official source provenance", () => {
    expect(() => process([{ ...JANUARY_2024, sourceUrl: "https://example.com/empsit_02022024.htm" }]))
      .toThrow(/official archived BLS Employment Situation/i);
  });

  it("rejects a source URL date conflict", () => {
    expect(() => process([{ ...JANUARY_2024, sourceUrl: "https://www.bls.gov/news.release/archives/empsit_02032024.htm" }]))
      .toThrow(/conflicts with the release header/i);
  });

  it("sorts releases and vintages deterministically", () => {
    const result = process([MARCH_2024, JANUARY_2024, FEBRUARY_2024]);
    expect(result.releaseEvidence.map((item) => item.releaseId)).toEqual(["USDL-24-0148", "USDL-24-0451", "USDL-24-0574"]);
    expect(result.vintageEvidence.map((item) => `${item.referencePeriod}#${item.revisionIndex}`)).toEqual([
      "2023-11#2", "2023-12#1", "2023-12#2", "2024-01#0", "2024-01#1", "2024-01#2", "2024-02#0", "2024-02#1", "2024-03#0",
    ]);
  });

  it("makes normalized identity independent of artifact ordering", () => {
    expect(process([JANUARY_2024, FEBRUARY_2024]).normalizedContentHash)
      .toBe(process([FEBRUARY_2024, JANUARY_2024]).normalizedContentHash);
  });

  it("makes normalized identity independent of retrieval time", () => {
    expect(process().normalizedContentHash)
      .toBe(process([JANUARY_2024], { retrievedAt: "2026-09-25T00:00:00.000Z" }).normalizedContentHash);
  });

  it("changes normalized identity when a value changes", () => {
    expect(process().normalizedContentHash).not.toBe(process([{ ...JANUARY_2024, initialValue: 354 }]).normalizedContentHash);
  });

  it("changes normalized identity when the release date changes", () => {
    const changed = { ...JANUARY_2024, releaseDay: 3 };
    expect(process().normalizedContentHash).not.toBe(process([changed]).normalizedContentHash);
  });

  it("rejects rather than normalizes a changed release-time contract", () => {
    expect(() => process([{ ...JANUARY_2024, releaseTime: "8:31 a.m." }])).toThrow();
  });

  it("computes deterministic raw SHA-256", () => {
    const input = artifact(JANUARY_2024);
    expect(process().artifacts[0].rawSha256).toBe(sha256Hex(input.responseBytes));
  });

  it("uses truthful NOT_PUBLISHED checksum semantics", () => {
    expect(process().artifacts[0].providerChecksum).toBeNull();
    expect(process().artifacts[0].request.checksumUrl).toBeNull();
  });

  it("emits the canonical NFP manifest contract", () => {
    expect(process().manifestEntry).toMatchObject({
      seriesId: "US_NFP_NET_CHANGE",
      kind: "MACRO_RELEASE",
      cadence: "MONTHLY",
      revisionSemantics: "VINTAGE_AWARE",
      unit: "THOUSANDS_OF_PERSONS",
    });
    expect(RESEARCH_SERIES_SPECS.US_NFP_NET_CHANGE).toEqual({
      kind: "MACRO_RELEASE", cadence: "MONTHLY", revisionSemantics: "VINTAGE_AWARE",
    });
  });

  it("remains research-only and research-context-only", () => {
    expect(process()).toMatchObject({ intendedUse: "RESEARCH_ONLY", priceAuthority: "RESEARCH_CONTEXT_ONLY" });
  });

  it("does not expose executable price, allocation, execution, or accounting outputs", () => {
    const result = process() as unknown as Record<string, unknown>;
    for (const field of ["assetBars", "targetWeights", "orders", "fills", "ledger", "readiness"]) {
      expect(result).not.toHaveProperty(field);
    }
  });

  it("counts missing monthly periods without interpolation", () => {
    const sparse = process([JANUARY_2024, MARCH_2024]).coverage;
    expect(sparse.missingReferencePeriods).toEqual([]);
    expect(sparse.missingVintageCount).toBeGreaterThan(0);
    expect(sparse.method).toMatch(/no interpolation/i);
  });

  it("records regular-vintage and benchmark boundaries explicitly", () => {
    const coverage = process().coverage;
    expect(coverage.missingVintagePolicy).toMatch(/revisionIndex 0/i);
    expect(coverage.benchmarkPolicy).toMatch(/does not ingest later benchmark-restated history/i);
  });

  it("uses a thin injectable network boundary", async () => {
    const input = artifact(JANUARY_2024);
    const requested: string[] = [];
    const result = await acquireBlsLaborHistory({
      sourceUrls: [input.sourceUrl], retrievedAt: RETRIEVED_AT, releasedThroughMs: RELEASED_THROUGH,
    }, {
      fetchBinary: async (url) => { requested.push(url); return input.responseBytes; },
    });
    expect(requested).toEqual([input.sourceUrl]);
    expect(result.macroReleases.some((item) => item.value === 353)).toBe(true);
  });

  it("proves an archived as-published unemployment value can differ after annual revision", () => {
    const proof = evaluateBlsUnemploymentVintagePair({
      referencePeriod: "2023-10", releaseId: "USDL-23-2450", releaseDate: "2023-11-03", value: 3.9,
      sourceUrl: "https://www.bls.gov/news.release/archives/empsit_11032023.htm",
    }, {
      referencePeriod: "2023-10", releaseId: "USDL-24-0016", releaseDate: "2024-01-05", value: 3.8,
      sourceUrl: "https://www.bls.gov/news.release/archives/empsit_01052024.htm",
    });
    expect(proof).toMatchObject({ status: "CONDITIONAL", initialValue: 3.9, revisedValue: 3.8, revisionDetected: true });
  });

  it("fails unemployment proof when historical revision evidence is missing", () => {
    expect(() => evaluateBlsUnemploymentVintagePair({
      referencePeriod: "2023-10", releaseId: "USDL-23-2450", releaseDate: "2023-11-03", value: 3.9,
      sourceUrl: "https://www.bls.gov/news.release/archives/empsit_11032023.htm",
    }, undefined as never)).toThrow();
  });

  it("does not backdate the current unemployment value or expose broad ingestion", () => {
    expect(BLS_UNEMPLOYMENT_STATUS).toBe("CONDITIONAL");
    expect(process().unemploymentStatus).toBe("CONDITIONAL");
    expect("processBlsUnemploymentHistory" in historicalSources).toBe(false);
    expect("acquireBlsUnemploymentHistory" in historicalSources).toBe(false);
    expect(process().macroReleases.some((item) => item.seriesId === "US_UNEMPLOYMENT_RATE")).toBe(false);
  });

  it("preserves adjacent gate blocker semantics", () => {
    expect(BLS_CPI_MOM_STATUS).toBe("CONDITIONAL");
    expect("processCboeVixHistory" in historicalSources).toBe(false);
    expect("processIceDxyHistory" in historicalSources).toBe(false);
  });

  it("exports the witnessed release-time contract", () => {
    expect(BLS_LABOR_RELEASE_TIME).toBe("08:30");
    expect(BLS_LABOR_RELEASE_TIME_ZONE).toBe("America/New_York");
  });
});
