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
  assessResearchDatasetReadiness,
  canonicalJson,
  createResearchDatasetSnapshot,
  sha256Hex,
  verifyRawArtifact,
  type ResearchDatasetSnapshotInput,
  type ResearchSourceArtifactType,
  type VerifiedRawArtifact,
} from "../historicalSources";

const START = Date.UTC(2024, 0, 1);
const END = Date.UTC(2024, 11, 31, 23, 59, 59);
const RELEASE = Date.UTC(2024, 1, 1, 13, 30);
const MONTH = 31 * 86_400_000;

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

function assessment(options: FixtureOptions = {}) {
  return assessResearchDatasetReadiness(createResearchDatasetSnapshot(fixture(options)));
}

function series(result: ReturnType<typeof assessment>, seriesId: ResearchSeriesId) {
  const item = result.series.find((candidate) => candidate.seriesId === seriesId);
  if (!item) throw new Error(`missing ${seriesId}`);
  return item;
}

describe("B2-D research dataset readiness", () => {
  it("assesses the complete supported acquired-series fixture without inventing policy readiness", () => {
    const result = assessment();
    expect(result.series.filter((item) => item.acquisitionStatus === "ACQUIRED")).toHaveLength(9);
    expect(result.readiness).toBe("READINESS_POLICY_UNRESOLVED");
    expect(result.reasons[0].code).toBe("REQUIRED_SERIES_POLICY_UNRESOLVED");
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
    expect(assessResearchDatasetReadiness(snapshot).readiness).toBe("READINESS_POLICY_UNRESOLVED");
  });

  it("produces explicit machine-readable insufficient-coverage reasons", () => {
    const result = assessment({ btcMissing: 2 });
    expect(series(result, "BTC").reasons.map((reason) => reason.code)).toContain("DECLARED_MISSING_OBSERVATIONS");
    expect(result.reasons.some((reason) => reason.message.startsWith("BTC:"))).toBe(true);
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

  it("reports target-upper denominator uncertainty instead of imposing a calendar cadence", () => {
    const item = series(assessment(), "US_FED_FUNDS_TARGET_UPPER");
    expect(item.cadence).toBe("EVENT_DRIVEN");
    expect(item.denominator.status).toBe("UNKNOWN");
    expect(item.coverageRatio).toBeNull();
  });
});
