import { describe, expect, it } from "vitest";
import { validateHistoricalMarketObservation } from "../historicalPit";
import { RESEARCH_SERIES_SPECS } from "../researchDataProtocol";
import * as historicalSources from "../historicalSources";
import {
  H15_RELEASE_TIME,
  H15_RELEASE_TIME_ZONE,
  H15_SUPPORTED_OBSERVATION_END,
  H15_SUPPORTED_OBSERVATION_START,
  acquireH15TreasuryInitialRelease,
  createH15TreasuryRequestIdentity,
  processH15TreasuryInitialRelease,
  type H15TreasurySeriesId,
  type ProcessH15TreasuryInput,
} from "../historicalSources/h15TreasuryYields";
import { sha256Hex } from "../historicalSources/immutableAcquisition";

const RETRIEVED_AT = "2026-09-23T12:00:00.000Z";
const RELEASED_THROUGH = Date.parse("2026-09-23T23:59:59.999Z");

interface FixtureRow {
  readonly realtime_start?: string;
  readonly realtime_end?: string;
  readonly date?: string;
  readonly value?: string;
}

function encode(value: unknown, suffix = ""): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value)}${suffix}`);
}

function response(
  rows: readonly FixtureRow[],
  observationStart = "2024-01-02",
  observationEnd = "2024-01-05",
  overrides: Readonly<Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    realtime_start: "1776-07-04",
    realtime_end: "9999-12-31",
    observation_start: observationStart,
    observation_end: observationEnd,
    units: "lin",
    output_type: 4,
    file_type: "json",
    order_by: "observation_date",
    sort_order: "asc",
    count: rows.length,
    offset: 0,
    limit: 100000,
    observations: rows,
    ...overrides,
  };
}

const DEFAULT_ROWS: readonly FixtureRow[] = Object.freeze([
  Object.freeze({
    realtime_start: "2024-01-03",
    realtime_end: "2024-01-03",
    date: "2024-01-02",
    value: "4.33",
  }),
  Object.freeze({
    realtime_start: "2024-01-04",
    realtime_end: "2024-01-04",
    date: "2024-01-03",
    value: "4.31",
  }),
  Object.freeze({
    realtime_start: "2024-01-05",
    realtime_end: "2024-01-05",
    date: "2024-01-04",
    value: ".",
  }),
  Object.freeze({
    realtime_start: "2024-01-08",
    realtime_end: "2024-01-08",
    date: "2024-01-05",
    value: "4.38",
  }),
]);

function processFixture(
  seriesId: H15TreasurySeriesId = "US2Y",
  rows: readonly FixtureRow[] = DEFAULT_ROWS,
  inputOverrides: Partial<ProcessH15TreasuryInput> = {},
  responseOverrides: Readonly<Record<string, unknown>> = {}
) {
  const observationStart = inputOverrides.observationStart ?? "2024-01-02";
  const observationEnd = inputOverrides.observationEnd ?? "2024-01-05";
  return processH15TreasuryInitialRelease({
    seriesId,
    observationStart,
    observationEnd,
    responseBytes:
      inputOverrides.responseBytes ??
      encode(response(rows, observationStart, observationEnd, responseOverrides)),
    retrievedAt: inputOverrides.retrievedAt ?? RETRIEVED_AT,
    releasedThroughMs: inputOverrides.releasedThroughMs ?? RELEASED_THROUGH,
  });
}

describe("Gate M13B-2/B2-B3 — H.15 DGS2/DGS10 initial-release acquisition", () => {
  it("accepts a valid US2Y initial-release observation", () => {
    const result = processFixture("US2Y");
    expect(result.observations[0]).toMatchObject({
      seriesId: "US2Y",
      value: 4.33,
      provider: "FEDERAL_RESERVE_H15_VIA_FRED_ALFRED",
      unit: "PERCENT_PER_ANNUM",
    });
  });

  it("accepts a valid US10Y initial-release observation without cross-series substitution", () => {
    const result = processFixture("US10Y");
    expect(result.observations.every((row) => row.seriesId === "US10Y")).toBe(true);
    expect(result.manifestEntry.providerInstrument).toBe("DGS10");
  });

  it("parses multiple rows and excludes an explicit missing source value", () => {
    const result = processFixture();
    expect(result.observations).toHaveLength(3);
    expect(result.coverage.sourceRowCount).toBe(4);
    expect(result.coverage.missingObservationDates).toEqual(["2024-01-04"]);
  });

  it("sorts observations deterministically by observation date", () => {
    const result = processFixture("US2Y", [...DEFAULT_ROWS].reverse());
    expect(result.observations.map((row) => row.value)).toEqual([4.33, 4.31, 4.38]);
  });

  it("normalizes the source observation date to UTC midnight", () => {
    expect(processFixture().observations[0].observationTime)
      .toBe(Date.parse("2024-01-02T00:00:00.000Z"));
  });

  it("keeps observationTime distinct from availableAt", () => {
    const observation = processFixture().observations[0];
    expect(observation.availableAt).toBeGreaterThan(observation.observationTime);
    expect(observation.availableAt).not.toBe(observation.observationTime);
  });

  it("maps a normal initial-release witness to 16:15 America/New_York", () => {
    expect(processFixture().observations[0].availableAt)
      .toBe(Date.parse("2024-01-03T21:15:00.000Z"));
  });

  it("uses the witnessed delayed release date across a holiday/weekend gap", () => {
    const result = processFixture("US2Y", [{
      realtime_start: "2024-07-08",
      realtime_end: "2024-07-08",
      date: "2024-07-03",
      value: "4.71",
    }], {
      observationStart: "2024-07-03",
      observationEnd: "2024-07-03",
    });
    expect(result.observations[0].availableAt).toBe(Date.parse("2024-07-08T20:15:00.000Z"));
  });

  it("converts winter and summer release witnesses with historical DST", () => {
    const winter = processFixture().observations[0].availableAt;
    const summer = processFixture("US2Y", [{
      realtime_start: "2024-07-05",
      realtime_end: "2024-07-05",
      date: "2024-07-03",
      value: "4.71",
    }], {
      observationStart: "2024-07-03",
      observationEnd: "2024-07-03",
    }).observations[0].availableAt;
    expect(new Date(winter).toISOString().slice(11, 16)).toBe("21:15");
    expect(new Date(summer).toISOString().slice(11, 16)).toBe("20:15");
  });

  it("counts '.' as missing without synthesizing a yield", () => {
    const result = processFixture();
    expect(result.coverage.missingCount).toBe(1);
    expect(result.observations.some((row) => row.observationTime === Date.parse("2024-01-04T00:00:00Z")))
      .toBe(false);
  });

  it("rejects a missing row whose release is beyond the acquisition boundary", () => {
    expect(() => processFixture("US2Y", [DEFAULT_ROWS[0], DEFAULT_ROWS[2]], {
      observationStart: "2024-01-02",
      observationEnd: "2024-01-04",
      releasedThroughMs: Date.parse("2024-01-05T21:14:59.999Z"),
    })).toThrow(/incomplete or unreleased/i);
  });

  it("accepts a missing row exactly at the acquisition boundary", () => {
    const result = processFixture("US2Y", [DEFAULT_ROWS[0], DEFAULT_ROWS[2]], {
      observationStart: "2024-01-02",
      observationEnd: "2024-01-04",
      releasedThroughMs: Date.parse("2024-01-05T21:15:00.000Z"),
    });
    expect(result.coverage).toMatchObject({
      sourceRowCount: 2,
      recordCount: 1,
      missingCount: 1,
    });
  });

  it("rejects a malformed observation date", () => {
    expect(() => processFixture("US2Y", [{
      realtime_start: "2024-02-02",
      realtime_end: "2024-02-02",
      date: "2024-02-30",
      value: "4.2",
    }], { observationStart: "2024-02-01", observationEnd: "2024-02-29" }))
      .toThrow(/valid calendar date/i);
  });

  it("rejects a malformed numeric value", () => {
    expect(() => processFixture("US2Y", [{
      realtime_start: "2024-01-03",
      realtime_end: "2024-01-03",
      date: "2024-01-02",
      value: "not-a-number",
    }])).toThrow(/not finite/i);
  });

  it("rejects a non-finite numeric value", () => {
    expect(() => processFixture("US2Y", [{
      realtime_start: "2024-01-03",
      realtime_end: "2024-01-03",
      date: "2024-01-02",
      value: "Infinity",
    }])).toThrow(/not finite/i);
  });

  it("rejects an exact duplicate observation date", () => {
    const row = DEFAULT_ROWS[0];
    expect(() => processFixture("US2Y", [row, row])).toThrow(/duplicate observation/i);
  });

  it("rejects a conflicting duplicate observation date", () => {
    expect(() => processFixture("US2Y", [
      DEFAULT_ROWS[0],
      { ...DEFAULT_ROWS[0], realtime_start: "2024-01-04" },
    ])).toThrow(/conflicting duplicate/i);
  });

  it("rejects a missing initial-release witness", () => {
    expect(() => processFixture("US2Y", [{
      realtime_end: "2024-01-03",
      date: "2024-01-02",
      value: "4.33",
    }])).toThrow(/realtime_start/i);
  });

  it("rejects an ambiguous release mapping", () => {
    expect(() => processFixture("US2Y", [
      DEFAULT_ROWS[0],
      { ...DEFAULT_ROWS[0], realtime_start: "2024-01-05", realtime_end: "2024-01-05" },
    ])).toThrow(/conflicting duplicate/i);
  });

  it("rejects observations before the proven publication regime", () => {
    expect(() => processFixture("US2Y", [{
      realtime_start: "2021-01-04",
      realtime_end: "2021-01-04",
      date: "2020-12-31",
      value: "0.13",
    }], { observationStart: "2020-12-31", observationEnd: "2020-12-31" }))
      .toThrow(/outside the proven publication regime/i);
  });

  it("rejects an observation whose release is incomplete at the acquisition boundary", () => {
    expect(() => processFixture("US2Y", [DEFAULT_ROWS[0]], {
      releasedThroughMs: Date.parse("2024-01-03T21:14:59.999Z"),
    })).toThrow(/incomplete or unreleased/i);
  });

  it("computes a deterministic raw SHA-256", () => {
    const responseBytes = encode(response(DEFAULT_ROWS));
    const result = processFixture();
    expect(result.artifact.rawSha256).toBe(sha256Hex(responseBytes));
  });

  it("computes a deterministic normalized content hash independent of retrieval time", () => {
    const first = processFixture();
    const second = processFixture("US2Y", DEFAULT_ROWS, { retrievedAt: "2026-09-24T00:00:00.000Z" });
    expect(second.normalizedContentHash).toBe(first.normalizedContentHash);
  });

  it("makes normalized identity independent of source row order", () => {
    const forward = processFixture();
    const reverse = processFixture("US2Y", [...DEFAULT_ROWS].reverse());
    expect(reverse.normalizedContentHash).toBe(forward.normalizedContentHash);
  });

  it("changes normalized identity when a missing row release witness changes", () => {
    const changedRows = DEFAULT_ROWS.map((row) => row.value === "."
      ? { ...row, realtime_start: "2024-01-08", realtime_end: "2024-01-08" }
      : row);
    const first = processFixture();
    const second = processFixture("US2Y", changedRows);
    expect(second.coverage.missingObservationDates).toEqual(first.coverage.missingObservationDates);
    expect(second.normalizedContentHash).not.toBe(first.normalizedContentHash);
  });

  it("changes raw artifact identity when raw content changes", () => {
    const base = response(DEFAULT_ROWS);
    const first = processFixture();
    const second = processFixture("US2Y", DEFAULT_ROWS, { responseBytes: encode(base, " ") });
    expect(second.artifact.artifactId).not.toBe(first.artifact.artifactId);
    expect(second.normalizedContentHash).toBe(first.normalizedContentHash);
  });

  it("records truthful NOT_PUBLISHED provider-checksum semantics", () => {
    const artifact = processFixture().artifact;
    expect(artifact.providerChecksum).toBeNull();
    expect(artifact.request.checksumUrl).toBeNull();
  });

  it("emits the canonical US2Y manifest contract", () => {
    const manifest = processFixture("US2Y").manifestEntry;
    expect(manifest).toMatchObject({
      seriesId: "US2Y",
      kind: "MARKET_FACTOR",
      providerInstrument: "DGS2",
      cadence: "DAILY",
      revisionSemantics: "NOT_APPLICABLE",
    });
    expect(RESEARCH_SERIES_SPECS.US2Y).toEqual({
      kind: "MARKET_FACTOR",
      cadence: "DAILY",
      revisionSemantics: "NOT_APPLICABLE",
    });
  });

  it("emits the canonical US10Y manifest contract", () => {
    expect(processFixture("US10Y").manifestEntry).toMatchObject({
      seriesId: "US10Y",
      providerInstrument: "DGS10",
      unit: "PERCENT_PER_ANNUM",
    });
  });

  it("remains RESEARCH_ONLY", () => {
    expect(processFixture().intendedUse).toBe("RESEARCH_ONLY");
  });

  it("remains RESEARCH_CONTEXT_ONLY", () => {
    expect(processFixture().priceAuthority).toBe("RESEARCH_CONTEXT_ONLY");
  });

  it("does not create assetBars or executable-price authority", () => {
    expect(processFixture()).not.toHaveProperty("assetBars");
  });

  it("does not claim full RESEARCH_READY", () => {
    expect(processFixture()).not.toHaveProperty("readiness");
  });

  it("parses entirely offline", () => {
    expect(() => processFixture()).not.toThrow();
  });

  it("does not reintroduce the rejected Cboe VIX adapter", () => {
    expect("processCboeVixHistory" in historicalSources).toBe(false);
    expect("acquireCboeVixHistory" in historicalSources).toBe(false);
  });

  it("does not expose allocation, execution, or accounting outputs", () => {
    const result = processFixture() as unknown as Record<string, unknown>;
    expect(result).not.toHaveProperty("targetWeights");
    expect(result).not.toHaveProperty("fills");
    expect(result).not.toHaveProperty("ledger");
  });

  it("rejects an unsupported series", () => {
    expect(() => createH15TreasuryRequestIdentity(
      "US5Y" as H15TreasurySeriesId,
      "2024-01-02",
      "2024-01-05"
    )).toThrow(/unsupported research series/i);
  });

  it("rejects a malformed response schema", () => {
    expect(() => processFixture("US2Y", DEFAULT_ROWS, {}, { observations: "not-an-array" }))
      .toThrow(/observations must be an array/i);
  });

  it("rejects an incompatible output type instead of treating current values as initial releases", () => {
    expect(() => processFixture("US2Y", DEFAULT_ROWS, {}, { output_type: 1 }))
      .toThrow(/output_type must be 4/i);
  });

  it("rejects an empty raw artifact", () => {
    expect(() => processFixture("US2Y", DEFAULT_ROWS, { responseBytes: new Uint8Array() }))
      .toThrow(/non-empty provider artifact/i);
  });

  it("rejects corrupted JSON", () => {
    expect(() => processFixture("US2Y", DEFAULT_ROWS, {
      responseBytes: new TextEncoder().encode("{")
    })).toThrow(/not valid JSON/i);
  });

  it("rejects a release witness that precedes the observation", () => {
    expect(() => processFixture("US2Y", [{
      realtime_start: "2024-01-01",
      realtime_end: "2024-01-01",
      date: "2024-01-02",
      value: "4.33",
    }])).toThrow(/later than its observation date/i);
  });

  it("rejects the observation-date shortcut even when the date is valid", () => {
    expect(() => processFixture("US2Y", [{
      realtime_start: "2024-01-02",
      realtime_end: "2024-01-02",
      date: "2024-01-02",
      value: "4.33",
    }])).toThrow(/later than its observation date/i);
  });

  it("rejects a truncated paginated response", () => {
    expect(() => processFixture("US2Y", DEFAULT_ROWS, {}, { count: DEFAULT_ROWS.length + 1 }))
      .toThrow(/count does not match/i);
  });

  it("uses source-emitted rows rather than a generic Monday-Friday denominator", () => {
    const coverage = processFixture().coverage;
    expect(coverage.sourceRowCount).toBe(coverage.recordCount + coverage.missingCount);
    expect(coverage.method).toContain("no generic weekday denominator");
  });

  it("declares the exact bounded publication regime", () => {
    const coverage = processFixture().coverage;
    expect(coverage.supportedPublicationRegime).toContain(H15_SUPPORTED_OBSERVATION_START);
    expect(coverage.supportedPublicationRegime).toContain(H15_SUPPORTED_OBSERVATION_END);
    expect(H15_RELEASE_TIME).toBe("16:15");
    expect(H15_RELEASE_TIME_ZONE).toBe("America/New_York");
  });

  it("keeps the runtime API key out of artifact and manifest provenance", async () => {
    const secret = "test-runtime-key-not-a-secret";
    let requestedUrl = "";
    const responseBytes = encode(response(DEFAULT_ROWS));
    const result = await acquireH15TreasuryInitialRelease({
      seriesId: "US2Y",
      observationStart: "2024-01-02",
      observationEnd: "2024-01-05",
      retrievedAt: RETRIEVED_AT,
      releasedThroughMs: RELEASED_THROUGH,
      apiKey: secret,
    }, {
      fetchBinary: async (url) => {
        requestedUrl = url;
        return responseBytes;
      },
    });
    expect(requestedUrl).toContain(`api_key=${secret}`);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.artifact.request.url).not.toContain("api_key");
  });

  it("requires a runtime API key for network acquisition", async () => {
    await expect(acquireH15TreasuryInitialRelease({
      seriesId: "US2Y",
      observationStart: "2024-01-02",
      observationEnd: "2024-01-05",
      retrievedAt: RETRIEVED_AT,
      releasedThroughMs: RELEASED_THROUGH,
      apiKey: "",
    })).rejects.toThrow(/apiKey must be supplied at runtime/i);
  });

  it("emits observations that satisfy the canonical historical PIT validator", () => {
    for (const observation of processFixture().observations) {
      expect(() => validateHistoricalMarketObservation(observation)).not.toThrow();
    }
  });
});
