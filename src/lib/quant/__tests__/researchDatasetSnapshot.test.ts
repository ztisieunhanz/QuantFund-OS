import { describe, expect, it } from "vitest";
import type { HistoricalDataset, HistoricalEventRecord, HistoricalMacroRelease, HistoricalMarketObservation } from "../historicalPit";
import {
  RESEARCH_DATA_SCHEMA_VERSION,
  RESEARCH_PIT_POLICY_ID,
  RESEARCH_SERIES_SPECS,
  type ResearchSeriesId,
  type ResearchSeriesManifestEntry,
} from "../researchDataProtocol";
import {
  BLS_CPI_MOM_STATUS,
  BLS_UNEMPLOYMENT_STATUS,
  APPROVED_RESEARCH_SOURCE_ARTIFACT_SERIES,
  CURRENT_UNRESOLVED_RESEARCH_SERIES,
  RAW_ARTIFACT_IDENTITY_VERSION,
  ResearchDatasetSnapshotRegistry,
  buildResearchDatasetSnapshotCanonicalInput,
  canonicalJson,
  computeResearchDatasetSnapshotHash,
  createResearchDatasetSnapshot,
  processBlsCpiHistory,
  sha256Hex,
  validateResearchDatasetSnapshot,
  verifyRawArtifact,
  type ResearchDatasetSnapshotInput,
  type ResearchDatasetSnapshotManifestInput,
  type ResearchSourceArtifactType,
  type VerifiedRawArtifact,
} from "../historicalSources";

const START = Date.UTC(2024, 0, 1);
const END = Date.UTC(2024, 11, 31, 23, 59, 59);
const RELEASE = Date.UTC(2024, 1, 1, 13, 30);

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function digest(label: string): string {
  return `sha256:${sha256Hex(label)}`;
}

function makeArtifact(
  seriesId: ResearchSeriesId,
  provider: string,
  label: string,
  retrievedAt = "2026-09-24T00:00:00.000Z",
  checksumRequired = false
): VerifiedRawArtifact {
  const sourceArtifactType: ResearchSourceArtifactType = provider === "BINANCE_PUBLIC_DATA"
    ? "BINANCE_SPOT_MONTHLY_KLINES_1H"
    : provider === "FEDERAL_RESERVE_FRED_ALFRED"
      ? "FRED_ALFRED_H15_INITIAL_RELEASE_OBSERVATIONS"
      : provider === "US_BUREAU_OF_LABOR_STATISTICS"
        ? seriesId === "US_NFP_NET_CHANGE"
          ? "BLS_EMPLOYMENT_SITUATION_ARCHIVED_NEWS_RELEASE"
          : "BLS_CPI_ARCHIVED_NEWS_RELEASE"
        : seriesId === "US_FED_FUNDS_TARGET_UPPER"
          ? "FOMC_IMPLEMENTATION_NOTE"
          : "FOMC_POLICY_STATEMENT";
  const rawBytes = new TextEncoder().encode(`raw:${label}`);
  const archiveUrl = `https://example.test/${label}.bin`;
  if (checksumRequired) {
    return verifyRawArtifact({
      provider,
      sourceArtifactType,
      instrument: `INSTRUMENT_${seriesId}`,
      archiveUrl,
      partition: label,
      retrievedAt,
      rawBytes,
      parserVersion: `PARSER_${label}`,
      licensingClassification: "OFFICIAL_TEST_FIXTURE",
      providerChecksumPolicy: "REQUIRED",
      checksumUrl: `${archiveUrl}.CHECKSUM`,
      expectedFileName: `${label}.bin`,
      checksumText: `${sha256Hex(rawBytes)}  ${label}.bin`,
    });
  }
  return verifyRawArtifact({
    provider,
    sourceArtifactType,
    instrument: `INSTRUMENT_${seriesId}`,
    archiveUrl,
    partition: label,
    retrievedAt,
    rawBytes,
    parserVersion: `PARSER_${label}`,
    licensingClassification: "OFFICIAL_TEST_FIXTURE",
    providerChecksumPolicy: "NOT_PUBLISHED",
    checksumUrl: null,
  });
}

function market(seriesId: ResearchSeriesId, provider: string, offset: number, value: number): HistoricalMarketObservation {
  return {
    seriesId,
    provider,
    value,
    observationTime: START + offset,
    availableAt: START + offset + 3_600_000,
    providerTimestamp: START + offset,
    unit: seriesId === "US2Y" || seriesId === "US10Y" ? "PERCENT_PER_ANNUM" : "USDT",
  };
}

function macro(
  seriesId: ResearchSeriesId,
  provider: string,
  offset: number,
  value: number,
  revisionIndex = 0,
  availableAt = RELEASE + offset
): HistoricalMacroRelease {
  return {
    seriesId,
    provider,
    value,
    observationTime: START + offset,
    publishedAt: availableAt,
    availableAt,
    revisionIndex,
    vintageDate: "2024-02-01",
    unit: "PERCENT",
  };
}

function event(provider: string): HistoricalEventRecord {
  return {
    eventId: "FOMC-2024-01-31",
    eventType: "FED_RATE_DECISION",
    provider,
    observationTime: START + 30 * 86_400_000,
    publishedAt: RELEASE,
    availableAt: RELEASE,
    actual: 5.5,
    consensus: null,
    consensusFrozenAt: null,
    previous: 5.5,
    surprise: null,
    sourceQuality: "TIER_1_OFFICIAL",
  };
}

interface FixtureParts {
  readonly input: ResearchDatasetSnapshotInput;
  readonly artifactsByLabel: Readonly<Record<string, VerifiedRawArtifact>>;
}

function fixture(): FixtureParts {
  const artifactsByLabel = {
    btc: makeArtifact("BTC", "BINANCE_PUBLIC_DATA", "btc", undefined, true),
    paxg: makeArtifact("PAXG", "BINANCE_PUBLIC_DATA", "paxg", undefined, true),
    us2y: makeArtifact("US2Y", "FEDERAL_RESERVE_FRED_ALFRED", "us2y"),
    us10y: makeArtifact("US10Y", "FEDERAL_RESERVE_FRED_ALFRED", "us10y"),
    cpi: makeArtifact("US_CPI_INDEX", "US_BUREAU_OF_LABOR_STATISTICS", "cpi"),
    fomc: makeArtifact("FOMC_RATE_DECISION", "FEDERAL_RESERVE_BOARD", "fomc"),
    target: makeArtifact("US_FED_FUNDS_TARGET_UPPER", "FEDERAL_RESERVE_BOARD", "target"),
    nfp: makeArtifact("US_NFP_NET_CHANGE", "US_BUREAU_OF_LABOR_STATISTICS", "nfp"),
  } as const;
  const dataset: HistoricalDataset = {
    marketObservations: [
      market("BTC", "BINANCE_PUBLIC_DATA", 0, 42_000),
      market("PAXG", "BINANCE_PUBLIC_DATA", 3_600_000, 2_000),
      market("US2Y", "FEDERAL_RESERVE_H15_VIA_FRED_ALFRED", 7_200_000, 4.2),
      market("US10Y", "FEDERAL_RESERVE_H15_VIA_FRED_ALFRED", 10_800_000, 4.0),
    ],
    macroReleases: [
      macro("US_CPI_INDEX", "BLS_ARCHIVED_CPI_RELEASE", 0, 308.4),
      macro("US_CPI_YOY", "BLS_ARCHIVED_CPI_RELEASE", 0, 3.1),
      macro("US_NFP_NET_CHANGE", "BLS_ARCHIVED_EMPLOYMENT_SITUATION", 0, 353),
      macro("US_NFP_NET_CHANGE", "BLS_ARCHIVED_EMPLOYMENT_SITUATION", 0, 350, 1, RELEASE + 31 * 86_400_000),
      macro("US_NFP_NET_CHANGE", "BLS_ARCHIVED_EMPLOYMENT_SITUATION", 0, 347, 2, RELEASE + 60 * 86_400_000),
      macro("US_FED_FUNDS_TARGET_UPPER", "FEDERAL_RESERVE_BOARD", 30 * 86_400_000, 5.5, 0, RELEASE + 10 * 3_600_000),
    ],
    eventRecords: [event("FEDERAL_RESERVE_BOARD")],
    metadata: { interval: "1h", startTime: START, endTime: END, sourceIdentifiers: { purpose: "B2-C" } },
  };

  const artifactForSeries: Readonly<Record<string, readonly VerifiedRawArtifact[]>> = {
    BTC: [artifactsByLabel.btc],
    PAXG: [artifactsByLabel.paxg],
    US2Y: [artifactsByLabel.us2y],
    US10Y: [artifactsByLabel.us10y],
    US_CPI_INDEX: [artifactsByLabel.cpi],
    US_CPI_YOY: [artifactsByLabel.cpi],
    US_NFP_NET_CHANGE: [artifactsByLabel.nfp],
    US_FED_FUNDS_TARGET_UPPER: [artifactsByLabel.fomc, artifactsByLabel.target],
    FOMC_RATE_DECISION: [artifactsByLabel.fomc, artifactsByLabel.target],
  };
  const allRecords = [
    ...dataset.marketObservations,
    ...dataset.macroReleases,
    ...dataset.eventRecords.map((record) => ({ ...record, seriesId: "FOMC_RATE_DECISION" })),
  ];
  const seriesIds = [...new Set(allRecords.map((record) => record.seriesId as ResearchSeriesId))];
  const sources: ResearchSeriesManifestEntry[] = seriesIds.map((seriesId) => {
    const records = allRecords.filter((record) => record.seriesId === seriesId);
    const spec = RESEARCH_SERIES_SPECS[seriesId];
    const linkedArtifacts = artifactForSeries[seriesId];
    if (!linkedArtifacts) throw new Error(`missing artifact fixture for ${seriesId}`);
    return {
      seriesId,
      kind: spec.kind,
      provider: records[0].provider,
      providerInstrument: `OFFICIAL_${seriesId}`,
      cadence: spec.cadence,
      unit: "TEST_UNIT",
      firstObservationTime: Math.min(...records.map((record) => record.observationTime)),
      lastObservationTime: Math.max(...records.map((record) => record.observationTime)),
      firstAvailableAt: Math.min(...records.map((record) => record.availableAt)),
      lastAvailableAt: Math.max(...records.map((record) => record.availableAt)),
      recordCount: records.length,
      missingness: { missingCount: 0, method: "Official expected release/slot denominator" },
      revisionSemantics: spec.revisionSemantics,
      timezoneSessionRule: "Provider-witnessed source rule",
      availabilityRule: seriesId === "US_FED_FUNDS_TARGET_UPPER"
        ? "availableAt is max(public release, effective boundary)"
        : "availableAt is the witnessed public release or completed observation boundary",
      provenance: canonicalJson({ artifactIds: linkedArtifacts.map((artifact) => artifact.artifactId).sort() }),
      contentHash: digest(`content:${seriesId}`),
    };
  });
  const manifest: ResearchDatasetSnapshotManifestInput = {
    datasetId: "b2-c-cross-provider-fixture",
    schemaVersion: RESEARCH_DATA_SCHEMA_VERSION,
    createdAt: "2026-09-24T00:00:00.000Z",
    interval: "1h",
    intendedUse: "RESEARCH_ONLY",
    priceAuthority: "RESEARCH_CONTEXT_ONLY",
    pitPolicy: RESEARCH_PIT_POLICY_ID,
    startTime: START,
    endTime: END,
    totalRecordCount: allRecords.length,
    sources,
  };
  return { input: { dataset, manifest, rawArtifacts: Object.values(artifactsByLabel) }, artifactsByLabel };
}

function fixtureWithRealBlsCpiOutput(): ResearchDatasetSnapshotInput {
  const base = fixture();
  const html = `<!doctype html><html><body>
    <h1>Consumer Price Index News Release</h1>
    <p>Transmission of material in this release is embargoed until
    8:30 a.m. (ET) Tuesday, February 13, 2024 USDL-24-0256</p>
    <h2>CONSUMER PRICE INDEX - JANUARY 2024</h2>
    <p>The Consumer Price Index for All Urban Consumers (CPI-U) increased
    3.1 percent over the last 12 months to an index level of
    308.417 (1982-84=100).</p>
  </body></html>`;
  const cpi = processBlsCpiHistory({
    artifacts: [{
      sourceUrl: "https://www.bls.gov/news.release/archives/cpi_02132024.htm",
      responseBytes: new TextEncoder().encode(html),
      retrievedAt: "2026-09-24T00:00:00.000Z",
    }],
    releasedThroughMs: END,
  });
  const macroReleases = [
    ...base.input.dataset.macroReleases.filter(
      (release) => release.seriesId !== "US_CPI_INDEX" && release.seriesId !== "US_CPI_YOY"
    ),
    ...cpi.series.US_CPI_INDEX.releases,
    ...cpi.series.US_CPI_YOY.releases,
  ];
  const sources = [
    ...base.input.manifest.sources.filter(
      (source) => source.seriesId !== "US_CPI_INDEX" && source.seriesId !== "US_CPI_YOY"
    ),
    cpi.series.US_CPI_INDEX.manifestEntry,
    cpi.series.US_CPI_YOY.manifestEntry,
  ];
  const dataset = { ...base.input.dataset, macroReleases };
  return {
    dataset,
    manifest: {
      ...base.input.manifest,
      totalRecordCount:
        dataset.marketObservations.length + dataset.macroReleases.length + dataset.eventRecords.length,
      sources,
    },
    rawArtifacts: [
      ...base.input.rawArtifacts.filter((artifact) => artifact.artifactId !== base.artifactsByLabel.cpi.artifactId),
      ...cpi.artifacts,
    ],
  };
}

function replaceSource(
  input: ResearchDatasetSnapshotInput,
  seriesId: ResearchSeriesId,
  patch: Partial<ResearchSeriesManifestEntry>
): ResearchDatasetSnapshotInput {
  return {
    ...clone(input),
    manifest: {
      ...clone(input.manifest),
      sources: input.manifest.sources.map((source) => source.seriesId === seriesId ? { ...source, ...patch } : clone(source)),
    },
  };
}

function addUnresolvedMonthlySeries(
  input: ResearchDatasetSnapshotInput,
  seriesId: "US_CPI_MOM" | "US_UNEMPLOYMENT_RATE",
  artifactId: string
): ResearchDatasetSnapshotInput {
  const provider = seriesId === "US_CPI_MOM"
    ? "BLS_ARCHIVED_CPI_RELEASE"
    : "BLS_ARCHIVED_EMPLOYMENT_SITUATION";
  const record = macro(seriesId, provider, 5 * 86_400_000, 3.7);
  const spec = RESEARCH_SERIES_SPECS[seriesId];
  const source: ResearchSeriesManifestEntry = {
    seriesId,
    kind: spec.kind,
    provider,
    providerInstrument: `OFFICIAL_${seriesId}`,
    cadence: spec.cadence,
    unit: "PERCENT",
    firstObservationTime: record.observationTime,
    lastObservationTime: record.observationTime,
    firstAvailableAt: record.availableAt,
    lastAvailableAt: record.availableAt,
    recordCount: 1,
    missingness: { missingCount: 0, method: "Official expected monthly release denominator" },
    revisionSemantics: spec.revisionSemantics,
    timezoneSessionRule: "America/New_York release witness",
    availabilityRule: "Explicit archived release boundary",
    provenance: canonicalJson({ artifactId }),
    contentHash: digest(`content:${seriesId}`),
  };
  return {
    ...clone(input),
    dataset: {
      ...clone(input.dataset),
      macroReleases: [...input.dataset.macroReleases, record],
    },
    manifest: {
      ...clone(input.manifest),
      totalRecordCount: input.manifest.totalRecordCount + 1,
      sources: [...input.manifest.sources, source],
    },
  };
}

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverseObjectKeys(item)]));
  }
  return value;
}

describe("Gate M13B-2 B2-C — immutable research dataset snapshots", () => {
  it("creates a valid immutable snapshot", () => {
    const snapshot = createResearchDatasetSnapshot(fixture().input);
    expect(() => validateResearchDatasetSnapshot(snapshot)).not.toThrow();
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it("uses a lowercase SHA-256 snapshot identity", () => {
    expect(createResearchDatasetSnapshot(fixture().input).snapshotHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("produces the same hash for the same semantic content", () => {
    expect(computeResearchDatasetSnapshotHash(fixture().input)).toBe(computeResearchDatasetSnapshotHash(fixture().input));
  });

  it("excludes createdAt from identity", () => {
    const first = fixture().input;
    const second = { ...clone(first), manifest: { ...clone(first.manifest), createdAt: "2030-01-01T00:00:00.000Z" } };
    expect(computeResearchDatasetSnapshotHash(second)).toBe(computeResearchDatasetSnapshotHash(first));
  });

  it("excludes raw retrieval timestamps from identity", () => {
    const first = fixture();
    const replacement = makeArtifact("US2Y", "FEDERAL_RESERVE_FRED_ALFRED", "us2y", "2030-01-01T00:00:00.000Z");
    expect(replacement.artifactId).toBe(first.artifactsByLabel.us2y.artifactId);
    const second = { ...clone(first.input), rawArtifacts: first.input.rawArtifacts.map((item) => item.artifactId === first.artifactsByLabel.us2y.artifactId ? replacement : item) };
    expect(computeResearchDatasetSnapshotHash(second)).toBe(computeResearchDatasetSnapshotHash(first.input));
  });

  it("ignores object-key insertion order", () => {
    const input = fixture().input;
    expect(buildResearchDatasetSnapshotCanonicalInput(reverseObjectKeys(input) as ResearchDatasetSnapshotInput))
      .toBe(buildResearchDatasetSnapshotCanonicalInput(input));
  });

  it("ignores manifest source ordering", () => {
    const input = fixture().input;
    const reordered = { ...clone(input), manifest: { ...clone(input.manifest), sources: [...input.manifest.sources].reverse() } };
    expect(computeResearchDatasetSnapshotHash(reordered)).toBe(computeResearchDatasetSnapshotHash(input));
  });

  it("ignores raw artifact ordering", () => {
    const input = fixture().input;
    expect(computeResearchDatasetSnapshotHash({ ...clone(input), rawArtifacts: [...input.rawArtifacts].reverse() }))
      .toBe(computeResearchDatasetSnapshotHash(input));
  });

  it("normalizes historical record ordering through the M13B-1 protocol", () => {
    const input = fixture().input;
    const reordered = {
      ...clone(input),
      dataset: {
        ...clone(input.dataset),
        marketObservations: [...input.dataset.marketObservations].reverse(),
        macroReleases: [...input.dataset.macroReleases].reverse(),
        eventRecords: [...input.dataset.eventRecords].reverse(),
      },
    };
    expect(computeResearchDatasetSnapshotHash(reordered)).toBe(computeResearchDatasetSnapshotHash(input));
  });

  it("changes identity when normalized contentHash changes", () => {
    const input = fixture().input;
    expect(computeResearchDatasetSnapshotHash(replaceSource(input, "BTC", { contentHash: digest("changed") })))
      .not.toBe(computeResearchDatasetSnapshotHash(input));
  });

  it("changes identity when raw artifact SHA changes", () => {
    const base = fixture();
    const changed = makeArtifact("US2Y", "FEDERAL_RESERVE_FRED_ALFRED", "us2y-changed");
    let input: ResearchDatasetSnapshotInput = { ...clone(base.input), rawArtifacts: base.input.rawArtifacts.map((item) => item.artifactId === base.artifactsByLabel.us2y.artifactId ? changed : item) };
    input = replaceSource(input, "US2Y", { provenance: canonicalJson({ artifactIds: [changed.artifactId] }) });
    expect(computeResearchDatasetSnapshotHash(input)).not.toBe(computeResearchDatasetSnapshotHash(base.input));
  });

  it("changes identity when provider identity changes", () => {
    const base = fixture();
    let input = replaceSource(base.input, "US2Y", {
      provider: "ALTERNATE_OFFICIAL_PROVIDER",
    });
    input = {
      ...input,
      dataset: {
        ...input.dataset,
        marketObservations: input.dataset.marketObservations.map((item) => item.seriesId === "US2Y" ? { ...item, provider: "ALTERNATE_OFFICIAL_PROVIDER" } : item),
      },
    };
    expect(computeResearchDatasetSnapshotHash(input)).not.toBe(computeResearchDatasetSnapshotHash(base.input));
  });

  it("changes identity when missingness changes", () => {
    const input = fixture().input;
    expect(computeResearchDatasetSnapshotHash(replaceSource(input, "BTC", {
      missingness: { missingCount: 1, method: "Official expected release/slot denominator" },
    }))).not.toBe(computeResearchDatasetSnapshotHash(input));
  });

  it("changes identity when the requested window changes", () => {
    const input = fixture().input;
    const changed = { ...clone(input), manifest: { ...clone(input.manifest), endTime: END + 1 } };
    expect(computeResearchDatasetSnapshotHash(changed)).not.toBe(computeResearchDatasetSnapshotHash(input));
  });

  it("changes identity when a normalized value changes", () => {
    const input = fixture().input;
    const changed = { ...clone(input), dataset: { ...clone(input.dataset), marketObservations: input.dataset.marketObservations.map((item, index) => index === 0 ? { ...item, value: item.value + 1 } : item) } };
    expect(computeResearchDatasetSnapshotHash(changed)).not.toBe(computeResearchDatasetSnapshotHash(input));
  });

  it("changes identity when availability semantics change", () => {
    const input = fixture().input;
    const changed = replaceSource(input, "BTC", { availabilityRule: "Different approved availability rule" });
    expect(computeResearchDatasetSnapshotHash(changed)).not.toBe(computeResearchDatasetSnapshotHash(input));
  });

  it("changes identity when the raw artifact set changes", () => {
    const base = fixture();
    const extra = makeArtifact("BTC", "BINANCE_PUBLIC_DATA", "btc-extra", undefined, true);
    const btc = base.input.manifest.sources.find((source) => source.seriesId === "BTC");
    if (!btc) throw new Error("BTC fixture missing");
    const changed = replaceSource(
      { ...clone(base.input), rawArtifacts: [...base.input.rawArtifacts, extra] },
      "BTC",
      { provenance: canonicalJson({ artifactIds: [base.artifactsByLabel.btc.artifactId, extra.artifactId].sort() }) }
    );
    expect(computeResearchDatasetSnapshotHash(changed)).not.toBe(computeResearchDatasetSnapshotHash(base.input));
  });

  it("rejects an empty dataset", () => {
    const input = fixture().input;
    expect(() => createResearchDatasetSnapshot({ ...input, dataset: { marketObservations: [], macroReleases: [], eventRecords: [] } }))
      .toThrow(/must not be empty/i);
  });

  it("rejects duplicate manifest series", () => {
    const input = fixture().input;
    expect(() => createResearchDatasetSnapshot({ ...input, manifest: { ...input.manifest, sources: [...input.manifest.sources, input.manifest.sources[0]] } }))
      .toThrow(/duplicate series/i);
  });

  it("rejects unsupported manifest series", () => {
    const input = fixture().input;
    const changed = replaceSource(input, "BTC", { seriesId: "US_GDP" as ResearchSeriesId });
    expect(() => createResearchDatasetSnapshot(changed)).toThrow(/unsupported research series/i);
  });

  it("rejects malformed normalized content hashes", () => {
    expect(() => createResearchDatasetSnapshot(replaceSource(fixture().input, "BTC", { contentHash: "sha256:nope" })))
      .toThrow(/contentHash.*64 hex/i);
  });

  it("rejects malformed raw hashes", () => {
    const input = fixture().input;
    const artifact = { ...input.rawArtifacts[2], rawSha256: "bad" };
    expect(() => createResearchDatasetSnapshot({ ...input, rawArtifacts: [artifact, ...input.rawArtifacts.slice(3), ...input.rawArtifacts.slice(0, 2)] }))
      .toThrow(/rawSha256/i);
  });

  it("rejects wrong canonical kind", () => {
    expect(() => createResearchDatasetSnapshot(replaceSource(fixture().input, "BTC", { kind: "MACRO_RELEASE" })))
      .toThrow(/kind must be MARKET_FACTOR/i);
  });

  it("rejects wrong canonical cadence", () => {
    expect(() => createResearchDatasetSnapshot(replaceSource(fixture().input, "BTC", { cadence: "MONTHLY" })))
      .toThrow(/cadence must be 1H/i);
  });

  it("rejects wrong canonical revision semantics", () => {
    expect(() => createResearchDatasetSnapshot(replaceSource(fixture().input, "US_CPI_INDEX", { revisionSemantics: "INITIAL_ONLY" })))
      .toThrow(/revisionSemantics must be VINTAGE_AWARE/i);
  });

  it("rejects non-research intended use", () => {
    const input = fixture().input;
    expect(() => createResearchDatasetSnapshot({ ...input, manifest: { ...input.manifest, intendedUse: "EXECUTION" as "RESEARCH_ONLY" } }))
      .toThrow(/intendedUse/i);
  });

  it("rejects executable price authority", () => {
    const input = fixture().input;
    expect(() => createResearchDatasetSnapshot({ ...input, manifest: { ...input.manifest, priceAuthority: "EXECUTABLE" as "RESEARCH_CONTEXT_ONLY" } }))
      .toThrow(/priceAuthority|executable-price authority/i);
  });

  it("rejects unsupported protocol schema versions", () => {
    const input = fixture().input;
    expect(() => createResearchDatasetSnapshot({ ...input, manifest: { ...input.manifest, schemaVersion: "M13B-UNKNOWN" } }))
      .toThrow(/unsupported protocol schemaVersion/i);
  });

  it("rejects unsupported snapshot schema versions", () => {
    const snapshot = clone(createResearchDatasetSnapshot(fixture().input));
    (snapshot as unknown as { snapshotSchemaVersion: string }).snapshotSchemaVersion = "UNKNOWN";
    expect(() => validateResearchDatasetSnapshot(snapshot)).toThrow(/unsupported snapshot schemaVersion/i);
  });

  it("rejects fake acquisition of a currently unresolved series at the artifact compatibility boundary", () => {
    const base = fixture();
    const dxyRecord = market("DXY", "UNAPPROVED_DXY", 14_400_000, 104);
    const dxySource: ResearchSeriesManifestEntry = {
      ...base.input.manifest.sources[0],
      seriesId: "DXY",
      provider: dxyRecord.provider,
      providerInstrument: "DXY",
      cadence: "DAILY",
      firstObservationTime: dxyRecord.observationTime,
      lastObservationTime: dxyRecord.observationTime,
      firstAvailableAt: dxyRecord.availableAt,
      lastAvailableAt: dxyRecord.availableAt,
      recordCount: 1,
      provenance: canonicalJson({ artifactIds: [base.artifactsByLabel.btc.artifactId] }),
      contentHash: digest("dxy"),
    };
    const input: ResearchDatasetSnapshotInput = {
      dataset: { ...base.input.dataset, marketObservations: [...base.input.dataset.marketObservations, dxyRecord] },
      manifest: {
        ...base.input.manifest,
        totalRecordCount: base.input.manifest.totalRecordCount + 1,
        sources: [...base.input.manifest.sources, dxySource],
      },
      rawArtifacts: base.input.rawArtifacts,
    };
    expect(() => createResearchDatasetSnapshot(input)).toThrow(/not approved to support canonical research series DXY/i);
  });

  it("rejects a caller-provided wrong snapshot hash", () => {
    expect(() => createResearchDatasetSnapshot({ ...fixture().input, claimedSnapshotHash: digest("wrong") }))
      .toThrow(/claimed snapshot hash/i);
  });

  it("deep-freezes nested snapshot content", () => {
    const snapshot = createResearchDatasetSnapshot(fixture().input);
    expect(Object.isFrozen(snapshot.manifest.sources)).toBe(true);
    expect(Object.isFrozen(snapshot.dataset.macroReleases[0])).toBe(true);
    expect(Object.isFrozen(snapshot.rawArtifacts[0].request)).toBe(true);
  });

  it("protects snapshot content from caller mutation after creation", () => {
    const input = clone(fixture().input);
    const snapshot = createResearchDatasetSnapshot(input);
    (input.dataset.marketObservations[0] as unknown as { value: number }).value = 1;
    (input.manifest.sources[0] as unknown as { contentHash: string }).contentHash = digest("mutated");
    expect(snapshot.dataset.marketObservations[0].value).not.toBe(1);
    expect(snapshot.snapshotHash).toBe(computeResearchDatasetSnapshotHash(fixture().input));
  });

  it("does not mutate the first snapshot when creating a second", () => {
    const input = fixture().input;
    const first = createResearchDatasetSnapshot(input);
    const firstJson = JSON.stringify(first);
    createResearchDatasetSnapshot(replaceSource(input, "BTC", { contentHash: digest("second") }));
    expect(JSON.stringify(first)).toBe(firstJson);
  });

  it("registers identical content idempotently", () => {
    const registry = new ResearchDatasetSnapshotRegistry();
    const first = registry.register(createResearchDatasetSnapshot(fixture().input));
    const second = registry.register(createResearchDatasetSnapshot(fixture().input));
    expect(second).toBe(first);
    expect(registry.size).toBe(1);
  });

  it("rejects forged same-hash different content", () => {
    const registry = new ResearchDatasetSnapshotRegistry();
    const snapshot = createResearchDatasetSnapshot(fixture().input);
    registry.register(snapshot);
    const forged = clone(snapshot);
    (forged.dataset.marketObservations[0] as unknown as { value: number }).value += 1;
    expect(() => registry.register(forged)).toThrow(/snapshotHash mismatch/i);
  });

  it("assembles a deterministic mixed-provider snapshot", () => {
    const snapshot = createResearchDatasetSnapshot(fixture().input);
    expect(new Set(snapshot.rawArtifacts.map((artifact) => artifact.provider)).size).toBeGreaterThanOrEqual(4);
    expect(snapshot.manifest.sources).toHaveLength(9);
  });

  it("assembles actual BLS CPI adapter output with one source artifact linked to both canonical CPI series", () => {
    const snapshot = createResearchDatasetSnapshot(fixtureWithRealBlsCpiOutput());
    const artifact = snapshot.rawArtifacts.find(
      (item) => item.sourceArtifactType === "BLS_CPI_ARCHIVED_NEWS_RELEASE"
    );
    expect(artifact).toBeDefined();
    expect(snapshot.rawArtifacts.filter(
      (item) => item.sourceArtifactType === "BLS_CPI_ARCHIVED_NEWS_RELEASE"
    )).toHaveLength(1);
    expect(snapshot.artifactSeriesLinks.find((link) => link.artifactId === artifact?.artifactId)?.researchSeriesIds)
      .toEqual(["US_CPI_INDEX", "US_CPI_YOY"]);
  });

  it("accepts only the approved CPI artifact links to CPI Index and CPI YoY", () => {
    const snapshot = createResearchDatasetSnapshot(fixtureWithRealBlsCpiOutput());
    const artifact = snapshot.rawArtifacts.find(
      (item) => item.sourceArtifactType === "BLS_CPI_ARCHIVED_NEWS_RELEASE"
    );
    const link = snapshot.artifactSeriesLinks.find((item) => item.artifactId === artifact?.artifactId);
    expect(link?.researchSeriesIds).toEqual(["US_CPI_INDEX", "US_CPI_YOY"]);
    expect(snapshot.rawArtifacts.filter((item) => item.artifactId === artifact?.artifactId)).toHaveLength(1);
  });

  it("rejects a BLS CPI artifact linked to BTC", () => {
    const base = fixture();
    try {
      createResearchDatasetSnapshot(replaceSource(base.input, "BTC", {
        provenance: canonicalJson({ artifactId: base.artifactsByLabel.cpi.artifactId }),
      }));
      throw new Error("expected incompatible artifact/series link to fail");
    } catch (error) {
      const message = String(error);
      expect(message).toContain(base.artifactsByLabel.cpi.artifactId);
      expect(message).toContain("BLS_CPI_ARCHIVED_NEWS_RELEASE");
      expect(message).toContain("BTC");
    }
  });

  it("rejects a BLS CPI artifact linked to NFP", () => {
    const base = fixture();
    expect(() => createResearchDatasetSnapshot(replaceSource(base.input, "US_NFP_NET_CHANGE", {
      provenance: canonicalJson({ artifactId: base.artifactsByLabel.cpi.artifactId }),
    }))).toThrow(/BLS_CPI_ARCHIVED_NEWS_RELEASE.*US_NFP_NET_CHANGE/i);
  });

  it("accepts Employment Situation for NFP but rejects unemployment while it remains conditional", () => {
    const base = fixture();
    const snapshot = createResearchDatasetSnapshot(base.input);
    const nfpLink = snapshot.artifactSeriesLinks.find(
      (link) => link.artifactId === base.artifactsByLabel.nfp.artifactId
    );
    expect(nfpLink?.researchSeriesIds).toEqual(["US_NFP_NET_CHANGE"]);
    expect(snapshot.seriesStatuses.find((status) => status.seriesId === "US_UNEMPLOYMENT_RATE")?.status)
      .toBe("CONDITIONAL");
    expect(() => createResearchDatasetSnapshot(addUnresolvedMonthlySeries(
      base.input,
      "US_UNEMPLOYMENT_RATE",
      base.artifactsByLabel.nfp.artifactId
    ))).toThrow(/BLS_EMPLOYMENT_SITUATION_ARCHIVED_NEWS_RELEASE.*US_UNEMPLOYMENT_RATE/i);
  });

  it("accepts Binance artifacts for BTC and PAXG but rejects a Binance-to-CPI cross-link", () => {
    const base = fixture();
    const snapshot = createResearchDatasetSnapshot(base.input);
    expect(snapshot.artifactSeriesLinks.find(
      (link) => link.artifactId === base.artifactsByLabel.btc.artifactId
    )?.researchSeriesIds).toEqual(["BTC"]);
    expect(snapshot.artifactSeriesLinks.find(
      (link) => link.artifactId === base.artifactsByLabel.paxg.artifactId
    )?.researchSeriesIds).toEqual(["PAXG"]);
    expect(() => createResearchDatasetSnapshot(replaceSource(base.input, "US_CPI_INDEX", {
      provenance: canonicalJson({ artifactId: base.artifactsByLabel.btc.artifactId }),
    }))).toThrow(/BINANCE_SPOT_MONTHLY_KLINES_1H.*US_CPI_INDEX/i);
  });

  it("accepts H.15 artifacts for US2Y and US10Y but rejects an H.15-to-BTC cross-link", () => {
    const base = fixture();
    const snapshot = createResearchDatasetSnapshot(base.input);
    expect(snapshot.artifactSeriesLinks.find(
      (link) => link.artifactId === base.artifactsByLabel.us2y.artifactId
    )?.researchSeriesIds).toEqual(["US2Y"]);
    expect(snapshot.artifactSeriesLinks.find(
      (link) => link.artifactId === base.artifactsByLabel.us10y.artifactId
    )?.researchSeriesIds).toEqual(["US10Y"]);
    expect(() => createResearchDatasetSnapshot(replaceSource(base.input, "BTC", {
      provenance: canonicalJson({ artifactId: base.artifactsByLabel.us2y.artifactId }),
    }))).toThrow(/FRED_ALFRED_H15_INITIAL_RELEASE_OBSERVATIONS.*BTC/i);
  });

  it("matches FOMC statement/note compatibility to the approved paired provenance contract", () => {
    const base = fixture();
    const snapshot = createResearchDatasetSnapshot(base.input);
    for (const artifact of [base.artifactsByLabel.fomc, base.artifactsByLabel.target]) {
      expect(snapshot.artifactSeriesLinks.find((link) => link.artifactId === artifact.artifactId)?.researchSeriesIds)
        .toEqual(["FOMC_RATE_DECISION", "US_FED_FUNDS_TARGET_UPPER"]);
    }
    expect(APPROVED_RESEARCH_SOURCE_ARTIFACT_SERIES.FOMC_POLICY_STATEMENT)
      .toEqual(["FOMC_RATE_DECISION", "US_FED_FUNDS_TARGET_UPPER"]);
    expect(APPROVED_RESEARCH_SOURCE_ARTIFACT_SERIES.FOMC_IMPLEMENTATION_NOTE)
      .toEqual(["FOMC_RATE_DECISION", "US_FED_FUNDS_TARGET_UPPER"]);
  });

  it("rejects an invalid FOMC statement-to-BTC cross-link", () => {
    const base = fixture();
    expect(() => createResearchDatasetSnapshot(replaceSource(base.input, "BTC", {
      provenance: canonicalJson({ artifactId: base.artifactsByLabel.fomc.artifactId }),
    }))).toThrow(/FOMC_POLICY_STATEMENT.*BTC/i);
  });

  it("does not permit a CPI artifact to make unresolved CPI MoM acquired", () => {
    const base = fixture();
    expect(createResearchDatasetSnapshot(base.input).seriesStatuses.find(
      (status) => status.seriesId === "US_CPI_MOM"
    )?.status).toBe("CONDITIONAL");
    expect(() => createResearchDatasetSnapshot(addUnresolvedMonthlySeries(
      base.input,
      "US_CPI_MOM",
      base.artifactsByLabel.cpi.artifactId
    ))).toThrow(/BLS_CPI_ARCHIVED_NEWS_RELEASE.*US_CPI_MOM/i);
  });

  it("keeps every closed source-artifact compatibility list deterministic", () => {
    for (const allowedSeries of Object.values(APPROVED_RESEARCH_SOURCE_ARTIFACT_SERIES)) {
      expect(Object.isFrozen(allowedSeries)).toBe(true);
      expect(allowedSeries).toEqual([...allowedSeries].sort((left, right) => left.localeCompare(right)));
      expect(new Set(allowedSeries).size).toBe(allowedSeries.length);
    }
  });

  it("includes explicit artifact-to-series links in the snapshot hash preimage", () => {
    const canonicalInput = buildResearchDatasetSnapshotCanonicalInput(fixture().input);
    expect(JSON.parse(canonicalInput)).toHaveProperty("artifactSeriesLinks");
    expect(createResearchDatasetSnapshot(fixture().input).artifactSeriesLinks.every(
      (link) => link.researchSeriesIds.length > 0
    )).toBe(true);
  });

  it("changes snapshot identity when canonical artifact linkage changes", () => {
    const base = fixture();
    const changed = replaceSource(base.input, "FOMC_RATE_DECISION", {
      provenance: canonicalJson({ artifactId: base.artifactsByLabel.fomc.artifactId }),
    });
    expect(computeResearchDatasetSnapshotHash(changed))
      .not.toBe(computeResearchDatasetSnapshotHash(base.input));
  });

  it("changes snapshot identity when source artifact identity changes", () => {
    const base = fixture();
    const changedArtifact = makeArtifact(
      "US_FED_FUNDS_TARGET_UPPER",
      "FEDERAL_RESERVE_BOARD",
      "fomc"
    );
    let changed: ResearchDatasetSnapshotInput = {
      ...clone(base.input),
      rawArtifacts: base.input.rawArtifacts.map((artifact) =>
        artifact.artifactId === base.artifactsByLabel.fomc.artifactId ? changedArtifact : artifact
      ),
    };
    for (const seriesId of ["FOMC_RATE_DECISION", "US_FED_FUNDS_TARGET_UPPER"] as const) {
      changed = replaceSource(changed, seriesId, {
        provenance: canonicalJson({
          artifactIds: [changedArtifact.artifactId, base.artifactsByLabel.target.artifactId].sort(),
        }),
      });
    }
    expect(changedArtifact.rawSha256).toBe(base.artifactsByLabel.fomc.rawSha256);
    expect(changedArtifact.sourceArtifactType).not.toBe(base.artifactsByLabel.fomc.sourceArtifactType);
    expect(computeResearchDatasetSnapshotHash(changed))
      .not.toBe(computeResearchDatasetSnapshotHash(base.input));
  });

  it("does not confuse a source artifact type with a canonical research series", () => {
    const snapshot = createResearchDatasetSnapshot(fixtureWithRealBlsCpiOutput());
    const artifact = snapshot.rawArtifacts.find(
      (item) => item.sourceArtifactType === "BLS_CPI_ARCHIVED_NEWS_RELEASE"
    );
    expect(artifact?.sourceArtifactType).toBe("BLS_CPI_ARCHIVED_NEWS_RELEASE");
    expect(snapshot.manifest.sources.some((source) => source.seriesId === "US_CPI_INDEX")).toBe(true);
    expect(snapshot.manifest.sources.some((source) => source.seriesId === "US_CPI_YOY")).toBe(true);
  });

  it("makes source artifact type part of immutable raw identity", () => {
    const common = {
      provider: "FEDERAL_RESERVE_BOARD",
      instrument: "FOMC",
      archiveUrl: "https://www.federalreserve.gov/test.htm",
      partition: "2024-01-31",
      retrievedAt: "2026-09-24T00:00:00.000Z",
      rawBytes: new TextEncoder().encode("same official bytes"),
      parserVersion: "TEST-V1",
      licensingClassification: "OFFICIAL_TEST_FIXTURE",
      providerChecksumPolicy: "NOT_PUBLISHED" as const,
      checksumUrl: null,
    };
    const statement = verifyRawArtifact({ ...common, sourceArtifactType: "FOMC_POLICY_STATEMENT" });
    const note = verifyRawArtifact({ ...common, sourceArtifactType: "FOMC_IMPLEMENTATION_NOTE" });
    expect(statement.artifactId).not.toBe(note.artifactId);
  });

  it("rejects an unapproved provider and source-artifact-type pair", () => {
    expect(() => verifyRawArtifact({
      provider: "FEDERAL_RESERVE_BOARD",
      sourceArtifactType: "BLS_CPI_ARCHIVED_NEWS_RELEASE",
      instrument: "CPI",
      archiveUrl: "https://www.federalreserve.gov/not-cpi.htm",
      partition: "2024-01",
      retrievedAt: "2026-09-24T00:00:00.000Z",
      rawBytes: new TextEncoder().encode("invalid provider/type pair"),
      parserVersion: "TEST-V1",
      licensingClassification: "OFFICIAL_TEST_FIXTURE",
      providerChecksumPolicy: "NOT_PUBLISHED",
      checksumUrl: null,
    })).toThrow(/not approved for provider/i);
  });

  it("never creates executable assetBars", () => {
    const snapshot = createResearchDatasetSnapshot(fixture().input) as unknown as Record<string, unknown>;
    expect(snapshot.assetBars).toBeUndefined();
    expect((snapshot.dataset as Record<string, unknown>).assetBars).toBeUndefined();
  });

  it("does not expose execution, allocation, or accounting authority", () => {
    const json = JSON.stringify(createResearchDatasetSnapshot(fixture().input));
    expect(json).not.toMatch(/ExecutionEngine|OmegaAllocator|Canonical Ledger|targetWeight/u);
  });

  it("does not claim RESEARCH_READY from hash existence", () => {
    const snapshot = createResearchDatasetSnapshot(fixture().input);
    expect(snapshot.readinessAssessment).toBe("NOT_EVALUATED");
    expect(JSON.stringify(snapshot)).not.toMatch(/RESEARCH_READY/u);
  });

  it("preserves Binance required-checksum semantics", () => {
    const snapshot = createResearchDatasetSnapshot(fixture().input);
    const binance = snapshot.rawArtifacts.filter((artifact) => artifact.provider === "BINANCE_PUBLIC_DATA");
    expect(binance).toHaveLength(2);
    expect(binance.every((artifact) => artifact.providerChecksumPolicy === "REQUIRED" && artifact.providerChecksum?.digest === artifact.rawSha256)).toBe(true);
  });

  it("rejects a Binance artifact without its provider checksum", () => {
    const base = fixture();
    const invalid = makeArtifact("BTC", "BINANCE_PUBLIC_DATA", "btc-no-checksum");
    expect(() => createResearchDatasetSnapshot({ ...base.input, rawArtifacts: [invalid, ...base.input.rawArtifacts.slice(1)] }))
      .toThrow(/immutable artifact metadata|require.*checksum/i);
  });

  it("preserves H.15 witnessed availability and NOT_PUBLISHED checksum semantics", () => {
    const snapshot = createResearchDatasetSnapshot(fixture().input);
    const us2y = snapshot.manifest.sources.find((source) => source.seriesId === "US2Y");
    const artifact = snapshot.rawArtifacts.find((item) => item.sourceArtifactType === "FRED_ALFRED_H15_INITIAL_RELEASE_OBSERVATIONS");
    expect(us2y?.availabilityRule).toMatch(/witnessed/i);
    expect(artifact?.providerChecksumPolicy).toBe("NOT_PUBLISHED");
  });

  it("preserves CPI vintage-aware semantics while CPI MoM stays conditional", () => {
    const snapshot = createResearchDatasetSnapshot(fixture().input);
    expect(snapshot.manifest.sources.find((source) => source.seriesId === "US_CPI_INDEX")?.revisionSemantics).toBe("VINTAGE_AWARE");
    expect(snapshot.seriesStatuses.find((item) => item.seriesId === "US_CPI_MOM")?.status).toBe("CONDITIONAL");
    expect(BLS_CPI_MOM_STATUS).toBe("CONDITIONAL");
  });

  it("preserves the FOMC public-release versus target-effective boundary distinction", () => {
    const snapshot = createResearchDatasetSnapshot(fixture().input);
    const policyEvent = snapshot.dataset.eventRecords[0];
    const target = snapshot.dataset.macroReleases.find((item) => item.seriesId === "US_FED_FUNDS_TARGET_UPPER");
    expect(target?.availableAt).toBeGreaterThan(policyEvent.publishedAt);
    expect(snapshot.manifest.sources.find((item) => item.seriesId === "US_FED_FUNDS_TARGET_UPPER")?.availabilityRule)
      .toMatch(/max\(public release, effective boundary\)/i);
  });

  it("preserves NFP vintage indexes 0, 1, and 2", () => {
    const snapshot = createResearchDatasetSnapshot(fixture().input);
    expect(snapshot.dataset.macroReleases.filter((item) => item.seriesId === "US_NFP_NET_CHANGE").map((item) => item.revisionIndex))
      .toEqual([0, 1, 2]);
  });

  it("keeps VIX and DXY blocked", () => {
    const snapshot = createResearchDatasetSnapshot(fixture().input);
    expect(snapshot.seriesStatuses.find((item) => item.seriesId === "VIX")?.status).toBe("BLOCKED");
    expect(snapshot.seriesStatuses.find((item) => item.seriesId === "DXY")?.status).toBe("BLOCKED");
    expect(CURRENT_UNRESOLVED_RESEARCH_SERIES.VIX?.status).toBe("BLOCKED");
  });

  it("keeps unemployment conditional without a fabricated manifest", () => {
    const snapshot = createResearchDatasetSnapshot(fixture().input);
    expect(snapshot.seriesStatuses.find((item) => item.seriesId === "US_UNEMPLOYMENT_RATE")?.status).toBe("CONDITIONAL");
    expect(snapshot.manifest.sources.some((item) => item.seriesId === "US_UNEMPLOYMENT_RATE")).toBe(false);
    expect(BLS_UNEMPLOYMENT_STATUS).toBe("CONDITIONAL");
  });

  it("represents every supported series with an explicit status", () => {
    const snapshot = createResearchDatasetSnapshot(fixture().input);
    expect(snapshot.seriesStatuses).toHaveLength(Object.keys(RESEARCH_SERIES_SPECS).length);
    expect(new Set(snapshot.seriesStatuses.map((item) => item.seriesId)).size).toBe(snapshot.seriesStatuses.length);
  });

  it("uses the manifest requested window without inferring heterogeneous completeness", () => {
    const snapshot = createResearchDatasetSnapshot(fixture().input);
    expect(snapshot.window).toEqual({ semantics: "REQUESTED_WINDOW", startTime: START, endTime: END });
  });

  it("rejects manifest coverage that disagrees with normalized records", () => {
    expect(() => createResearchDatasetSnapshot(replaceSource(fixture().input, "BTC", { lastAvailableAt: START + 99 })))
      .toThrow(/coverage window|coverage does not match normalized content/i);
  });

  it("rejects a manifest provider that disagrees with normalized records", () => {
    expect(() => createResearchDatasetSnapshot(replaceSource(fixture().input, "US2Y", { provider: "WRONG" })))
      .toThrow(/provider does not match normalized content/i);
  });

  it("rejects a raw artifact not linked from manifest provenance", () => {
    const input = fixture().input;
    const orphan = makeArtifact("BTC", "BINANCE_PUBLIC_DATA", "orphan", undefined, true);
    expect(() => createResearchDatasetSnapshot({ ...input, rawArtifacts: [...input.rawArtifacts, orphan] }))
      .toThrow(/not linked by any series manifest/i);
  });

  it("rejects a manifest with no linked raw artifact", () => {
    expect(() => createResearchDatasetSnapshot(replaceSource(fixture().input, "BTC", { provenance: canonicalJson({ artifactIds: [] }) })))
      .toThrow(/not linked|does not link a raw artifact/i);
  });

  it("rejects an unknown artifact identity declared by structured provenance", () => {
    expect(() => createResearchDatasetSnapshot(replaceSource(fixture().input, "BTC", {
      provenance: canonicalJson({ artifactId: digest("unknown-artifact") }),
    }))).toThrow(/unknown raw artifact/i);
  });

  it("does not accept an artifact ID merely embedded in unstructured provenance text", () => {
    const base = fixture();
    expect(() => createResearchDatasetSnapshot(replaceSource(base.input, "BTC", {
      provenance: canonicalJson({ note: `downloaded ${base.artifactsByLabel.btc.artifactId}` }),
    }))).toThrow(/does not link a raw artifact identity/i);
  });

  it("deduplicates identical artifact identity across retrieval times deterministically", () => {
    const base = fixture();
    const later = makeArtifact("US2Y", "FEDERAL_RESERVE_FRED_ALFRED", "us2y", "2030-01-01T00:00:00.000Z");
    const snapshot = createResearchDatasetSnapshot({ ...base.input, rawArtifacts: [...base.input.rawArtifacts, later] });
    expect(snapshot.rawArtifacts.filter((artifact) => artifact.artifactId === later.artifactId)).toHaveLength(1);
    expect(snapshot.rawArtifacts.find((artifact) => artifact.artifactId === later.artifactId)?.retrievedAt).toBe("2026-09-24T00:00:00.000Z");
  });

  it("preserves semantic array order where the protocol treats it as meaningful", () => {
    expect(canonicalJson({ sequence: ["INITIAL", "FIRST_REVISION", "SECOND_REVISION"] }))
      .not.toBe(canonicalJson({ sequence: ["SECOND_REVISION", "FIRST_REVISION", "INITIAL"] }));
  });

  it("keeps the raw artifact identity version explicit", () => {
    const snapshot = createResearchDatasetSnapshot(fixture().input);
    expect(snapshot.rawArtifacts.every((artifact) => artifact.identityVersion === RAW_ARTIFACT_IDENTITY_VERSION)).toBe(true);
  });
});
