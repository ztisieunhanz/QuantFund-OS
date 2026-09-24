import { describe, expect, it } from "vitest";
import type { HistoricalDataset, HistoricalMacroRelease } from "../historicalPit";
import {
  RESEARCH_DATA_SCHEMA_VERSION,
  RESEARCH_PIT_POLICY_ID,
  RESEARCH_SERIES_SPECS,
  type ResearchSeriesId,
  type ResearchSeriesManifestEntry,
} from "../researchDataProtocol";
import {
  M13B_OPTIONAL_RESEARCH_SERIES,
  M13B_REQUIRED_RESEARCH_SERIES,
  M13B_RESEARCH_DATASET_READINESS_POLICY,
  assessResearchDatasetReadiness,
  canonicalJson,
  createResearchDatasetSnapshot,
  sha256Hex,
  verifyRawArtifact,
  type ResearchDatasetSnapshotInput,
  type ResearchDatasetSnapshot,
  type ResearchSourceArtifactType,
  type VerifiedRawArtifact,
} from "../historicalSources";

const START = Date.UTC(2024, 0, 1);
const END = Date.UTC(2024, 11, 31, 23, 59, 59);
const RELEASE = Date.UTC(2024, 1, 1, 13, 30);
const MONTH = 31 * 86_400_000;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function artifact(
  seriesId: ResearchSeriesId,
  provider: string,
  label: string,
  sourceArtifactType: ResearchSourceArtifactType
): VerifiedRawArtifact {
  const bytes = new TextEncoder().encode(`raw:${label}`);
  const archiveUrl = `https://example.test/${label}`;
  if (provider === "BINANCE_PUBLIC_DATA") {
    return verifyRawArtifact({
      provider,
      sourceArtifactType,
      instrument: seriesId,
      archiveUrl,
      checksumUrl: `${archiveUrl}.CHECKSUM`,
      partition: label,
      retrievedAt: "2026-09-24T00:00:00.000Z",
      rawBytes: bytes,
      parserVersion: "TEST",
      licensingClassification: "TEST",
      providerChecksumPolicy: "REQUIRED",
      expectedFileName: label,
      checksumText: `${sha256Hex(bytes)}  ${label}`,
    });
  }
  return verifyRawArtifact({
    provider,
    sourceArtifactType,
    instrument: seriesId,
    archiveUrl,
    checksumUrl: null,
    partition: label,
    retrievedAt: "2026-09-24T00:00:00.000Z",
    rawBytes: bytes,
    parserVersion: "TEST",
    licensingClassification: "TEST",
    providerChecksumPolicy: "NOT_PUBLISHED",
  });
}

function macro(
  seriesId: ResearchSeriesId,
  provider: string,
  observationTime: number,
  revisionIndex: number,
  value: number,
  availableAt: number
): HistoricalMacroRelease {
  return {
    seriesId,
    provider,
    observationTime,
    publishedAt: availableAt,
    availableAt,
    revisionIndex,
    value,
    vintageDate: new Date(availableAt).toISOString().slice(0, 10),
    unit: "TEST",
  };
}

interface FixtureOptions {
  readonly btcMissing?: number;
  readonly cpiMissing?: number;
  readonly omitNfpSecondRevision?: boolean;
}

function fixture(options: FixtureOptions = {}): ResearchDatasetSnapshotInput {
  const artifacts = {
    btc: artifact("BTC", "BINANCE_PUBLIC_DATA", "btc", "BINANCE_SPOT_MONTHLY_KLINES_1H"),
    paxg: artifact("PAXG", "BINANCE_PUBLIC_DATA", "paxg", "BINANCE_SPOT_MONTHLY_KLINES_1H"),
    us2y: artifact("US2Y", "FEDERAL_RESERVE_FRED_ALFRED", "us2y", "FRED_ALFRED_H15_INITIAL_RELEASE_OBSERVATIONS"),
    us10y: artifact("US10Y", "FEDERAL_RESERVE_FRED_ALFRED", "us10y", "FRED_ALFRED_H15_INITIAL_RELEASE_OBSERVATIONS"),
    cpi: artifact("US_CPI_INDEX", "US_BUREAU_OF_LABOR_STATISTICS", "cpi", "BLS_CPI_ARCHIVED_NEWS_RELEASE"),
    nfp: artifact("US_NFP_NET_CHANGE", "US_BUREAU_OF_LABOR_STATISTICS", "nfp", "BLS_EMPLOYMENT_SITUATION_ARCHIVED_NEWS_RELEASE"),
    fomc: artifact("FOMC_RATE_DECISION", "FEDERAL_RESERVE_BOARD", "fomc", "FOMC_POLICY_STATEMENT"),
    note: artifact("US_FED_FUNDS_TARGET_UPPER", "FEDERAL_RESERVE_BOARD", "note", "FOMC_IMPLEMENTATION_NOTE"),
  };
  const nfp = [
    macro("US_NFP_NET_CHANGE", "BLS_ARCHIVED_EMPLOYMENT_SITUATION", START, 0, 300, RELEASE),
    macro("US_NFP_NET_CHANGE", "BLS_ARCHIVED_EMPLOYMENT_SITUATION", START, 1, 295, RELEASE + MONTH),
    ...(!options.omitNfpSecondRevision
      ? [macro("US_NFP_NET_CHANGE", "BLS_ARCHIVED_EMPLOYMENT_SITUATION", START, 2, 290, RELEASE + 2 * MONTH)]
      : []),
    macro("US_NFP_NET_CHANGE", "BLS_ARCHIVED_EMPLOYMENT_SITUATION", START + MONTH, 0, 310, RELEASE + MONTH),
    macro("US_NFP_NET_CHANGE", "BLS_ARCHIVED_EMPLOYMENT_SITUATION", START + MONTH, 1, 305, RELEASE + 2 * MONTH),
    macro("US_NFP_NET_CHANGE", "BLS_ARCHIVED_EMPLOYMENT_SITUATION", START + 2 * MONTH, 0, 320, RELEASE + 2 * MONTH),
  ];
  const dataset: HistoricalDataset = {
    marketObservations: [
      { seriesId: "BTC", provider: "BINANCE_PUBLIC_DATA", value: 42_000, observationTime: START, availableAt: START + 3_600_000, providerTimestamp: START, unit: "USDT" },
      { seriesId: "PAXG", provider: "BINANCE_PUBLIC_DATA", value: 2_000, observationTime: START, availableAt: START + 3_600_000, providerTimestamp: START, unit: "USDT" },
      { seriesId: "US2Y", provider: "FEDERAL_RESERVE_H15_VIA_FRED_ALFRED", value: 4.2, observationTime: START, availableAt: START + 16 * 3_600_000, unit: "PERCENT" },
      { seriesId: "US10Y", provider: "FEDERAL_RESERVE_H15_VIA_FRED_ALFRED", value: 4.0, observationTime: START, availableAt: START + 16 * 3_600_000, unit: "PERCENT" },
    ],
    macroReleases: [
      macro("US_CPI_INDEX", "BLS_ARCHIVED_CPI_RELEASE", START, 0, 308.4, RELEASE),
      macro("US_CPI_YOY", "BLS_ARCHIVED_CPI_RELEASE", START, 0, 3.1, RELEASE),
      ...nfp,
      macro("US_FED_FUNDS_TARGET_UPPER", "FEDERAL_RESERVE_BOARD", START + MONTH, 0, 5.5, RELEASE + MONTH),
    ],
    eventRecords: [{
      eventId: "FOMC-2024-01-31",
      eventType: "FED_RATE_DECISION",
      provider: "FEDERAL_RESERVE_BOARD",
      observationTime: START + 30 * 86_400_000,
      publishedAt: RELEASE,
      availableAt: RELEASE,
      actual: 5.5,
      consensus: null,
      consensusFrozenAt: null,
      previous: 5.5,
      surprise: null,
      sourceQuality: "TIER_1_OFFICIAL",
    }],
    metadata: { interval: "1h", startTime: START, endTime: END },
  };
  const artifactLinks: Readonly<Record<string, readonly VerifiedRawArtifact[]>> = {
    BTC: [artifacts.btc],
    PAXG: [artifacts.paxg],
    US2Y: [artifacts.us2y],
    US10Y: [artifacts.us10y],
    US_CPI_INDEX: [artifacts.cpi],
    US_CPI_YOY: [artifacts.cpi],
    US_NFP_NET_CHANGE: [artifacts.nfp],
    US_FED_FUNDS_TARGET_UPPER: [artifacts.fomc, artifacts.note],
    FOMC_RATE_DECISION: [artifacts.fomc, artifacts.note],
  };
  const eventRecords = dataset.eventRecords.map((record) => ({ ...record, seriesId: "FOMC_RATE_DECISION" }));
  const records = [...dataset.marketObservations, ...dataset.macroReleases, ...eventRecords];
  const sources = [...new Set(records.map((record) => record.seriesId as ResearchSeriesId))].map(
    (seriesId): ResearchSeriesManifestEntry => {
      const seriesRecords = records.filter((record) => record.seriesId === seriesId);
      const spec = RESEARCH_SERIES_SPECS[seriesId];
      const linked = artifactLinks[seriesId];
      const missingCount = seriesId === "BTC"
        ? options.btcMissing ?? 0
        : seriesId === "US_CPI_INDEX" || seriesId === "US_CPI_YOY"
          ? options.cpiMissing ?? 0
          : 0;
      return {
        seriesId,
        kind: spec.kind,
        provider: seriesRecords[0].provider,
        providerInstrument: `OFFICIAL_${seriesId}`,
        cadence: spec.cadence,
        unit: "TEST",
        firstObservationTime: Math.min(...seriesRecords.map((record) => record.observationTime)),
        lastObservationTime: Math.max(...seriesRecords.map((record) => record.observationTime)),
        firstAvailableAt: Math.min(...seriesRecords.map((record) => record.availableAt)),
        lastAvailableAt: Math.max(...seriesRecords.map((record) => record.availableAt)),
        recordCount: seriesRecords.length,
        missingness: { missingCount, method: "Approved provider-specific expected denominator" },
        revisionSemantics: spec.revisionSemantics,
        timezoneSessionRule: "Provider-witnessed rule",
        availabilityRule: "Explicit PIT boundary",
        provenance: canonicalJson({ artifactIds: linked.map((item) => item.artifactId).sort() }),
        contentHash: `sha256:${sha256Hex(`content:${seriesId}`)}`,
      };
    }
  );
  return {
    dataset,
    manifest: {
      datasetId: "b2-d-fixture",
      schemaVersion: RESEARCH_DATA_SCHEMA_VERSION,
      createdAt: "2026-09-24T00:00:00.000Z",
      interval: "1h",
      intendedUse: "RESEARCH_ONLY",
      priceAuthority: "RESEARCH_CONTEXT_ONLY",
      pitPolicy: RESEARCH_PIT_POLICY_ID,
      startTime: START,
      endTime: END,
      totalRecordCount: records.length,
      sources,
    },
    rawArtifacts: Object.values(artifacts),
  };
}

function minimumReadyFixture(): ResearchDatasetSnapshotInput {
  const base = fixture();
  const minimumStart = Date.UTC(2018, 0, 1);
  const minimumEnd = Date.UTC(2024, 0, 2);
  const marketObservations = ([
    ["BTC", "BINANCE_PUBLIC_DATA", 42_000, "USDT"],
    ["PAXG", "BINANCE_PUBLIC_DATA", 2_000, "USDT"],
    ["US2Y", "FEDERAL_RESERVE_H15_VIA_FRED_ALFRED", 4.2, "PERCENT"],
    ["US10Y", "FEDERAL_RESERVE_H15_VIA_FRED_ALFRED", 4.0, "PERCENT"],
  ] as const).flatMap(([seriesId, provider, value, unit]) => [minimumStart, minimumEnd - 3_600_000].map(
    (observationTime) => ({
      seriesId,
      provider,
      value,
      observationTime,
      availableAt: observationTime + 3_600_000,
      providerTimestamp: observationTime,
      unit,
    })
  ));
  const monthlyTimes = Array.from({ length: 61 }, (_, index) => Date.UTC(2018, index + 1, 0));
  const cpi = monthlyTimes.flatMap((observationTime, index) => [
    macro("US_CPI_INDEX", "BLS_ARCHIVED_CPI_RELEASE", observationTime, 0, 250 + index, observationTime + 40 * 86_400_000),
    macro("US_CPI_YOY", "BLS_ARCHIVED_CPI_RELEASE", observationTime, 0, 2 + index / 100, observationTime + 40 * 86_400_000),
  ]);
  const nfp = monthlyTimes.flatMap((observationTime, index) => {
    const vintages = [
      macro("US_NFP_NET_CHANGE", "BLS_ARCHIVED_EMPLOYMENT_SITUATION", observationTime, 0, 200 + index, observationTime + 40 * 86_400_000),
    ];
    if (index < monthlyTimes.length - 1) {
      vintages.push(macro("US_NFP_NET_CHANGE", "BLS_ARCHIVED_EMPLOYMENT_SITUATION", observationTime, 1, 199 + index, observationTime + 72 * 86_400_000));
    }
    if (index < monthlyTimes.length - 2) {
      vintages.push(macro("US_NFP_NET_CHANGE", "BLS_ARCHIVED_EMPLOYMENT_SITUATION", observationTime, 2, 198 + index, observationTime + 103 * 86_400_000));
    }
    return vintages;
  });
  const policyTimes = [minimumStart, Date.UTC(2020, 11, 31), minimumEnd - 86_400_000];
  const policyValues = [5, 6, 4];
  const macroReleases = [
    ...cpi,
    ...nfp,
    ...policyTimes.map((observationTime, index) =>
      macro("US_FED_FUNDS_TARGET_UPPER", "FEDERAL_RESERVE_BOARD", observationTime, 0, policyValues[index], observationTime + 14 * 3_600_000)
    ),
  ];
  const eventRecords = policyTimes.map((observationTime, index) => ({
    eventId: `FOMC-${index}`,
    eventType: "FED_RATE_DECISION",
    provider: "FEDERAL_RESERVE_BOARD",
    observationTime,
    publishedAt: observationTime + 14 * 3_600_000,
    availableAt: observationTime + 14 * 3_600_000,
    actual: policyValues[index],
    consensus: null,
    consensusFrozenAt: null,
    previous: index === 0 ? policyValues[index] : policyValues[index - 1],
    surprise: null,
    sourceQuality: "TIER_1_OFFICIAL" as const,
  }));
  const dataset: HistoricalDataset = {
    marketObservations,
    macroReleases,
    eventRecords,
    metadata: { interval: "1h", startTime: minimumStart, endTime: minimumEnd },
  };
  const manifestRecords = [
    ...marketObservations,
    ...macroReleases,
    ...eventRecords.map((record) => ({ ...record, seriesId: "FOMC_RATE_DECISION" })),
  ];
  const sources = base.manifest.sources.map((source) => {
    const records = manifestRecords.filter((record) => record.seriesId === source.seriesId);
    return {
      ...source,
      firstObservationTime: Math.min(...records.map((record) => record.observationTime)),
      lastObservationTime: Math.max(...records.map((record) => record.observationTime)),
      firstAvailableAt: Math.min(...records.map((record) => record.availableAt)),
      lastAvailableAt: Math.max(...records.map((record) => record.availableAt)),
      recordCount: records.length,
      missingness: { ...source.missingness, missingCount: 0 },
    };
  });
  return {
    dataset,
    manifest: {
      ...base.manifest,
      startTime: minimumStart,
      endTime: minimumEnd,
      totalRecordCount: manifestRecords.length,
      sources,
    },
    rawArtifacts: base.rawArtifacts,
  };
}

function withoutBtc(input: ResearchDatasetSnapshotInput): ResearchDatasetSnapshotInput {
  return {
    dataset: {
      ...input.dataset,
      marketObservations: input.dataset.marketObservations.filter((record) => record.seriesId !== "BTC"),
    },
    manifest: {
      ...input.manifest,
      totalRecordCount: input.manifest.totalRecordCount - input.dataset.marketObservations.filter((record) => record.seriesId === "BTC").length,
      sources: input.manifest.sources.filter((source) => source.seriesId !== "BTC"),
    },
    rawArtifacts: input.rawArtifacts.filter((item) => item.instrument !== "BTC"),
  };
}

function assessment(options: FixtureOptions = {}) {
  return assessResearchDatasetReadiness(createResearchDatasetSnapshot(fixture(options)));
}

function series(result: ReturnType<typeof assessment>, seriesId: ResearchSeriesId) {
  const item = result.series.find((candidate) => candidate.seriesId === seriesId);
  if (!item) throw new Error(`missing ${seriesId}`);
  return item;
}

describe("B2-D research dataset readiness", () => {
  it("exposes the explicit required/optional policy as a machine-readable closed classification", () => {
    expect(M13B_RESEARCH_DATASET_READINESS_POLICY.policyId).toBe("M13B-2-B2E-MINIMUM-V1");
    expect(M13B_REQUIRED_RESEARCH_SERIES).toHaveLength(9);
    expect(M13B_OPTIONAL_RESEARCH_SERIES).toEqual([
      "DXY",
      "VIX",
      "US_CPI_MOM",
      "US_UNEMPLOYMENT_RATE",
    ]);
    expect(Object.keys(M13B_RESEARCH_DATASET_READINESS_POLICY.series)).toHaveLength(13);
    expect(M13B_RESEARCH_DATASET_READINESS_POLICY.optionalDependencyRule).toContain("INSUFFICIENT_EVIDENCE");
  });

  it("assesses the compact acquired-series fixture but does not mistake it for the minimum history", () => {
    const result = assessment();
    expect(result.series.filter((item) => item.acquisitionStatus === "ACQUIRED")).toHaveLength(9);
    expect(result.readiness).toBe("NOT_RESEARCH_READY");
    expect(result.reasons.map((reason) => reason.code)).toContain("REQUIRED_SERIES_COVERAGE_SPAN_INSUFFICIENT");
  });

  it("allows the valid required minimum to reach RESEARCH_READY", () => {
    const result = assessResearchDatasetReadiness(createResearchDatasetSnapshot(minimumReadyFixture()));
    expect(result.readiness).toBe("RESEARCH_READY");
    expect(result.reasons).toEqual([]);
  });

  it("fails closed when a required series is absent", () => {
    const result = assessResearchDatasetReadiness(createResearchDatasetSnapshot(withoutBtc(minimumReadyFixture())));
    expect(result.readiness).toBe("NOT_RESEARCH_READY");
    expect(result.reasons).toContainEqual(expect.objectContaining({ code: "REQUIRED_SERIES_NOT_ACQUIRED" }));
  });

  it("returns NOT_RESEARCH_READY for invalid required-series PIT evidence", () => {
    const forged = clone(createResearchDatasetSnapshot(minimumReadyFixture())) as ResearchDatasetSnapshot;
    const btc = forged.dataset.marketObservations.find((record) => record.seriesId === "BTC");
    if (!btc) throw new Error("missing BTC fixture");
    (btc as { availableAt: number }).availableAt = btc.observationTime - 1;
    const result = assessResearchDatasetReadiness(forged);
    expect(result.readiness).toBe("NOT_RESEARCH_READY");
    expect(result.snapshotCryptographicallyValid).toBe(false);
    expect(result.reasons[0].code).toBe("PIT_AVAILABILITY_INVALID");
  });

  it("fails required-series missingness above the approved maximum", () => {
    const input = minimumReadyFixture();
    const sources = input.manifest.sources.map((source) => source.seriesId === "BTC"
      ? { ...source, missingness: { ...source.missingness, missingCount: 1 } }
      : source);
    const result = assessResearchDatasetReadiness(createResearchDatasetSnapshot({
      ...input,
      manifest: { ...input.manifest, sources },
    }));
    expect(result.readiness).toBe("NOT_RESEARCH_READY");
    expect(result.reasons).toContainEqual(expect.objectContaining({ code: "REQUIRED_SERIES_MISSINGNESS_EXCEEDS_POLICY" }));
  });

  it("fails when a required NFP revision opportunity is missing", () => {
    const input = minimumReadyFixture();
    const firstNfpTime = Math.min(...input.dataset.macroReleases
      .filter((record) => record.seriesId === "US_NFP_NET_CHANGE")
      .map((record) => record.observationTime));
    const macroReleases = input.dataset.macroReleases.filter((record) => !(
      record.seriesId === "US_NFP_NET_CHANGE" &&
      record.observationTime === firstNfpTime &&
      record.revisionIndex === 2
    ));
    const nfpRecords = macroReleases.filter((record) => record.seriesId === "US_NFP_NET_CHANGE");
    const sources = input.manifest.sources.map((source) => source.seriesId === "US_NFP_NET_CHANGE"
      ? {
          ...source,
          recordCount: nfpRecords.length,
          firstAvailableAt: Math.min(...nfpRecords.map((record) => record.availableAt)),
          lastAvailableAt: Math.max(...nfpRecords.map((record) => record.availableAt)),
        }
      : source);
    const result = assessResearchDatasetReadiness(createResearchDatasetSnapshot({
      ...input,
      dataset: { ...input.dataset, macroReleases },
      manifest: { ...input.manifest, totalRecordCount: input.manifest.totalRecordCount - 1, sources },
    }));
    expect(result.readiness).toBe("NOT_RESEARCH_READY");
    expect(result.reasons).toContainEqual(expect.objectContaining({ code: "REQUIRED_SERIES_REVISION_INCOMPLETE" }));
  });

  it("does not let absent optional BLOCKED or CONDITIONAL series block readiness", () => {
    const result = assessResearchDatasetReadiness(createResearchDatasetSnapshot(minimumReadyFixture()));
    expect(series(result, "VIX").acquisitionStatus).toBe("BLOCKED");
    expect(series(result, "DXY").acquisitionStatus).toBe("BLOCKED");
    expect(series(result, "US_CPI_MOM").acquisitionStatus).toBe("CONDITIONAL");
    expect(series(result, "US_UNEMPLOYMENT_RATE").acquisitionStatus).toBe("CONDITIONAL");
    expect(result.readiness).toBe("RESEARCH_READY");
  });

  it("reports a missing monthly reference period with a truthful denominator", () => {
    const item = series(assessment({ cpiMissing: 1 }), "US_CPI_INDEX");
    expect(item.denominator).toMatchObject({ status: "KNOWN", basis: "BLS_MONTHLY_REFERENCE_PERIODS", expectedCount: 2 });
    expect(item.coverageRatio).toBe(0.5);
    expect(item.observationCoverage).toBe("INCOMPLETE");
    expect(item.reasons.map((reason) => reason.code)).toContain("DECLARED_MISSING_OBSERVATIONS");
  });

  it("uses declared eligible 1H slots for Binance missingness", () => {
    const item = series(assessment({ btcMissing: 1 }), "BTC");
    expect(item.denominator).toMatchObject({ basis: "BINANCE_ELIGIBLE_1H_SLOTS", expectedCount: 2 });
    expect(item.coverageRatio).toBe(0.5);
  });

  it("does not count weekends as missing H.15 observations", () => {
    const item = series(assessment(), "US2Y");
    expect(item.denominator).toMatchObject({ basis: "H15_PROVIDER_SOURCE_ROWS", expectedCount: 1 });
    expect(item.declaredMissingCount).toBe(0);
  });

  it("uses the official event set rather than a fake daily or monthly denominator", () => {
    const item = series(assessment(), "FOMC_RATE_DECISION");
    expect(item.cadence).toBe("EVENT_DRIVEN");
    expect(item.denominator).toMatchObject({ basis: "FOMC_OFFICIAL_EVENT_SET", expectedCount: 1 });
  });

  it("detects a missing expected NFP second/final regular revision", () => {
    const item = series(assessment({ omitNfpSecondRevision: true }), "US_NFP_NET_CHANGE");
    expect(item.revisionCompleteness.status).toBe("INCOMPLETE");
    expect(item.revisionCompleteness.missingExpectedVintages).toContain(`${START}#2`);
  });

  it("keeps revision completeness separate from observation coverage", () => {
    const item = series(assessment({ omitNfpSecondRevision: true }), "US_NFP_NET_CHANGE");
    expect(item.observationCoverage).toBe("COMPLETE");
    expect(item.revisionCompleteness.status).toBe("INCOMPLETE");
  });

  it("represents BLOCKED and CONDITIONAL series truthfully without fake manifests", () => {
    const result = assessment();
    expect(series(result, "VIX").acquisitionStatus).toBe("BLOCKED");
    expect(series(result, "DXY").acquisitionStatus).toBe("BLOCKED");
    expect(series(result, "US_CPI_MOM").acquisitionStatus).toBe("CONDITIONAL");
    expect(series(result, "US_UNEMPLOYMENT_RATE").acquisitionStatus).toBe("CONDITIONAL");
    expect(series(result, "VIX").canonicalRecordCount).toBe(0);
    expect(series(result, "VIX").denominator.status).toBe("NOT_APPLICABLE");
  });

  it("does not equate a valid immutable snapshot hash with readiness", () => {
    const snapshot = createResearchDatasetSnapshot(fixture());
    expect(snapshot.snapshotHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(assessResearchDatasetReadiness(snapshot).readiness).toBe("NOT_RESEARCH_READY");
  });

  it("produces explicit machine-readable insufficient-coverage reasons", () => {
    const result = assessment({ btcMissing: 2 });
    expect(series(result, "BTC").reasons.map((reason) => reason.code)).toContain("DECLARED_MISSING_OBSERVATIONS");
    expect(result.reasons.map((reason) => reason.code)).toContain("REQUIRED_SERIES_MISSINGNESS_EXCEEDS_POLICY");
  });

  it("is deterministic under equivalent input ordering", () => {
    const normal = fixture();
    const reversed: ResearchDatasetSnapshotInput = {
      dataset: {
        ...normal.dataset,
        marketObservations: [...normal.dataset.marketObservations].reverse(),
        macroReleases: [...normal.dataset.macroReleases].reverse(),
        eventRecords: [...normal.dataset.eventRecords].reverse(),
      },
      manifest: { ...normal.manifest, sources: [...normal.manifest.sources].reverse() },
      rawArtifacts: [...normal.rawArtifacts].reverse(),
    };
    const left = assessResearchDatasetReadiness(createResearchDatasetSnapshot(normal));
    const right = assessResearchDatasetReadiness(createResearchDatasetSnapshot(reversed));
    expect(right).toEqual(left);
  });

  it("does not mutate the immutable snapshot", () => {
    const snapshot = createResearchDatasetSnapshot(fixture());
    const before = JSON.stringify(snapshot);
    const result = assessResearchDatasetReadiness(snapshot);
    expect(JSON.stringify(snapshot)).toBe(before);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.series)).toBe(true);
  });

  it("grants no executable-price, action, execution, or accounting authority", () => {
    const result = assessment();
    expect(result.intendedUse).toBe("RESEARCH_ONLY");
    expect(result.priceAuthority).toBe("RESEARCH_CONTEXT_ONLY");
    expect(result.predictiveValidityAssessed).toBe(false);
    expect(result.grantsExecutionAuthority).toBe(false);
    expect("assetBars" in result).toBe(false);
  });

  it("accepts the documented Fed Funds denominator and CPI final-vintage UNKNOWN semantics", () => {
    const result = assessResearchDatasetReadiness(createResearchDatasetSnapshot(minimumReadyFixture()));
    const item = series(result, "US_FED_FUNDS_TARGET_UPPER");
    expect(item.cadence).toBe("EVENT_DRIVEN");
    expect(item.denominator.status).toBe("UNKNOWN");
    expect(item.coverageRatio).toBeNull();
    expect(series(result, "US_CPI_INDEX").revisionCompleteness.status).toBe("UNKNOWN");
    expect(series(result, "US_CPI_YOY").revisionCompleteness.status).toBe("UNKNOWN");
    expect(result.readiness).toBe("RESEARCH_READY");
  });
});
