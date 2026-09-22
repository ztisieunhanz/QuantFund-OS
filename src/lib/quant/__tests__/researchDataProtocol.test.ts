import { describe, expect, it } from "vitest";
import { runBacktest } from "../backtestEngine";
import type { BacktestConfig, PointInTimeBar } from "../types";
import type { HistoricalDataset } from "../historicalPit";
import { buildSampleMarketObservations } from "../historicalSources/sampleMarketData";
import {
  buildRealHistoricalEventRecords,
  buildRealHistoricalMacroReleases,
} from "../historicalSources/sampleMacroData";
import {
  DEFAULT_RESEARCH_COVERAGE_POLICY,
  RESEARCH_DATA_SCHEMA_VERSION,
  RESEARCH_PIT_POLICY_ID,
  RESEARCH_SERIES_SPECS,
  assessResearchCoverage,
  buildResearchSnapshotCanonicalInput,
  calculateResearchSnapshotHash,
  validateResearchDatasetManifest,
  type ResearchDatasetManifest,
  type ResearchSeriesId,
  type ResearchSeriesManifestEntry,
} from "../researchDataProtocol";

const HOUR = 3_600_000;

function fixtureDataset(): HistoricalDataset {
  return {
    marketObservations: buildSampleMarketObservations(),
    macroReleases: buildRealHistoricalMacroReleases(),
    eventRecords: buildRealHistoricalEventRecords().filter(
      (event) => event.eventType === "FED_RATE_DECISION" || event.eventType === "FOMC_STATEMENT"
    ),
  };
}

function eventSeriesId(eventType: string): ResearchSeriesId {
  if (eventType === "FED_RATE_DECISION" || eventType === "FOMC_STATEMENT") return "FOMC_RATE_DECISION";
  throw new Error(`unsupported test event ${eventType}`);
}

function buildManifest(dataset: HistoricalDataset): ResearchDatasetManifest {
  const grouped = new Map<ResearchSeriesId, Array<{
    observationTime: number;
    availableAt: number;
    provider: string;
    unit?: string | null;
  }>>();
  for (const record of dataset.marketObservations) {
    const key = record.seriesId as ResearchSeriesId;
    grouped.set(key, [...(grouped.get(key) ?? []), record]);
  }
  for (const record of dataset.macroReleases) {
    const key = record.seriesId as ResearchSeriesId;
    grouped.set(key, [...(grouped.get(key) ?? []), record]);
  }
  for (const record of dataset.eventRecords) {
    const key = eventSeriesId(record.eventType);
    grouped.set(key, [...(grouped.get(key) ?? []), record]);
  }

  const sources: ResearchSeriesManifestEntry[] = [...grouped.entries()].map(([seriesId, records]) => {
    const spec = RESEARCH_SERIES_SPECS[seriesId];
    return {
      seriesId,
      kind: spec.kind,
      provider: records[0].provider,
      providerInstrument: `TEST:${seriesId}`,
      cadence: spec.cadence,
      unit: records[0].unit ?? (spec.kind === "OFFICIAL_EVENT" ? "EVENT" : "UNKNOWN"),
      firstObservationTime: Math.min(...records.map((record) => record.observationTime)),
      lastObservationTime: Math.max(...records.map((record) => record.observationTime)),
      firstAvailableAt: Math.min(...records.map((record) => record.availableAt)),
      lastAvailableAt: Math.max(...records.map((record) => record.availableAt)),
      recordCount: records.length,
      missingness: { missingCount: 0, method: "Explicit fixture enumeration" },
      revisionSemantics: spec.revisionSemantics,
      timezoneSessionRule: "Source-specific America/New_York rule or continuous UTC kline",
      availabilityRule: "Record is usable only when availableAt <= decisionTime",
      provenance: `Official deterministic fixture descriptor for ${seriesId}`,
      contentHash: `sha256:test-${seriesId.toLowerCase()}`,
    };
  });
  const allTimes = sources.flatMap((source) => [
    source.firstObservationTime,
    source.lastObservationTime,
    source.firstAvailableAt,
    source.lastAvailableAt,
  ]);
  return {
    datasetId: "m13b1-fixture-snapshot",
    schemaVersion: RESEARCH_DATA_SCHEMA_VERSION,
    createdAt: "2026-09-22T00:00:00.000Z",
    interval: "1h",
    intendedUse: "RESEARCH_ONLY",
    priceAuthority: "RESEARCH_CONTEXT_ONLY",
    pitPolicy: RESEARCH_PIT_POLICY_ID,
    snapshotHash: "sha256:test-snapshot",
    startTime: Math.min(...allTimes),
    endTime: Math.max(...allTimes),
    totalRecordCount: sources.reduce((sum, source) => sum + source.recordCount, 0),
    sources,
  };
}

function replaceSource(
  manifest: ResearchDatasetManifest,
  index: number,
  replacement: Partial<ResearchSeriesManifestEntry>
): ResearchDatasetManifest {
  const sources = manifest.sources.map((source, sourceIndex) =>
    sourceIndex === index ? { ...source, ...replacement } : source
  );
  return { ...manifest, sources };
}

function bars(count: number, startTime: number): PointInTimeBar[] {
  return Array.from({ length: count }, (_, index) => {
    const price = 50_000 + index * 5;
    return {
      timestamp: startTime + index * HOUR,
      open: price,
      high: price + 10,
      low: price - 10,
      close: price + 2,
      volume: 1_000 + index,
    };
  });
}

const backtestConfig: BacktestConfig = {
  runId: "m13b1-parity",
  startDate: 0,
  endDate: 0,
  warmupPeriod: 125,
  initialCapital: 10_000,
  commissionRate: 0.001,
  slippageModel: { type: "FIXED_BPS", baseBps: 5 },
  executionRule: "NEXT_BAR_OPEN",
  deterministicSeed: 13_001,
  dataQuality: "LIVE",
};

describe("Gate M13B-1 — research data protocol", () => {
  it("accepts a valid research-only manifest", () => {
    expect(() => validateResearchDatasetManifest(buildManifest(fixtureDataset()))).not.toThrow();
  });

  it("rejects duplicate series entries", () => {
    const manifest = buildManifest(fixtureDataset());
    const invalid = { ...manifest, sources: [...manifest.sources, manifest.sources[0]] };
    expect(() => validateResearchDatasetManifest(invalid)).toThrow(/duplicate series/i);
  });

  it("rejects invalid coverage timestamps", () => {
    const manifest = buildManifest(fixtureDataset());
    const invalid = replaceSource(manifest, 0, {
      firstObservationTime: manifest.sources[0].lastObservationTime + 1,
    });
    expect(() => validateResearchDatasetManifest(invalid)).toThrow(/impossible coverage window/i);
  });

  it("rejects missing provenance", () => {
    const manifest = replaceSource(buildManifest(fixtureDataset()), 0, { provenance: "" });
    expect(() => validateResearchDatasetManifest(manifest)).toThrow(/provenance/i);
  });

  it("rejects a total record mismatch", () => {
    const manifest = buildManifest(fixtureDataset());
    expect(() => validateResearchDatasetManifest({ ...manifest, totalRecordCount: manifest.totalRecordCount + 1 }))
      .toThrow(/does not equal per-series total/i);
  });

  it("rejects unsupported series and executable-price authority claims", () => {
    const manifest = buildManifest(fixtureDataset());
    const unsupported = replaceSource(manifest, 0, { seriesId: "US_GDP_QOQ" as ResearchSeriesId });
    expect(() => validateResearchDatasetManifest(unsupported)).toThrow(/unsupported research series/i);
    expect(() => validateResearchDatasetManifest({
      ...manifest,
      priceAuthority: "EXECUTABLE" as "RESEARCH_CONTEXT_ONLY",
    })).toThrow(/executable-price authority/i);
  });

  it("rejects invalid revision semantics and mismatched series kinds", () => {
    const manifest = buildManifest(fixtureDataset());
    const marketIndex = manifest.sources.findIndex((source) => source.seriesId === "BTC");
    expect(() => validateResearchDatasetManifest(
      replaceSource(manifest, marketIndex, { revisionSemantics: "VINTAGE_AWARE" })
    )).toThrow(/revisionSemantics must be NOT_APPLICABLE/i);
    expect(() => validateResearchDatasetManifest(
      replaceSource(manifest, marketIndex, { kind: "MACRO_RELEASE" })
    )).toThrow(/kind must be MARKET_FACTOR/i);
  });

  it("accepts the canonical cadence for every supported series", () => {
    const manifest = buildManifest(fixtureDataset());
    expect(() => validateResearchDatasetManifest(manifest)).not.toThrow();
    for (const source of manifest.sources) {
      expect(source.cadence).toBe(RESEARCH_SERIES_SPECS[source.seriesId].cadence);
    }
    expect(RESEARCH_SERIES_SPECS.US_FED_FUNDS_TARGET_UPPER.cadence).toBe("EVENT_DRIVEN");
  });

  it("rejects incompatible cadence declarations fail-closed", () => {
    const manifest = buildManifest(fixtureDataset());
    const cases = [
      ["BTC", "MONTHLY", "1H"],
      ["US_CPI_YOY", "1H", "MONTHLY"],
      ["FOMC_RATE_DECISION", "DAILY", "EVENT_DRIVEN"],
    ] as const;
    for (const [seriesId, wrongCadence, expectedCadence] of cases) {
      const index = manifest.sources.findIndex((source) => source.seriesId === seriesId);
      expect(() => validateResearchDatasetManifest(
        replaceSource(manifest, index, { cadence: wrongCadence })
      )).toThrow(new RegExp(`${seriesId}\\.cadence must be ${expectedCadence}`));
    }
  });

  it("applies monthly-period minimums only to canonically monthly series", () => {
    const dataset = fixtureDataset();
    const report = assessResearchCoverage(dataset, buildManifest(dataset));
    const resultFor = (seriesId: ResearchSeriesId) => {
      const result = report.perSeries.find((series) => series.seriesId === seriesId);
      if (!result) throw new Error(`missing coverage result for ${seriesId}`);
      return result;
    };

    expect(resultFor("US_FED_FUNDS_TARGET_UPPER").blockers).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/unique periods is below/i)])
    );
    for (const seriesId of [
      "US_CPI_YOY",
      "US_CPI_MOM",
      "US_CPI_INDEX",
      "US_NFP_NET_CHANGE",
      "US_UNEMPLOYMENT_RATE",
    ] as const) {
      expect(resultFor(seriesId).blockers).toEqual(
        expect.arrayContaining([expect.stringMatching(/unique periods is below 60/i)])
      );
    }
  });

  it("classifies current compact fixtures as not research ready", () => {
    const dataset = fixtureDataset();
    const report = assessResearchCoverage(dataset, buildManifest(dataset));
    expect(report.readiness).toBe("FIXTURE_ONLY");
    expect(report.readiness).not.toBe("RESEARCH_READY");
    expect(report.blockers.length).toBeGreaterThan(0);
  });

  it("produces deterministic readiness output", () => {
    const dataset = fixtureDataset();
    const manifest = buildManifest(dataset);
    expect(assessResearchCoverage(dataset, manifest)).toEqual(assessResearchCoverage(dataset, manifest));
  });

  it("labels a single rate move only as an observed transition, never an economic phase", () => {
    const original = fixtureDataset();
    const fedFunds = original.macroReleases
      .filter((record) => record.seriesId === "US_FED_FUNDS_TARGET_UPPER")
      .sort((left, right) => left.observationTime - right.observationTime)
      .slice(0, 2)
      .map((record, index) => ({ ...record, value: index === 0 ? 1 : 2 }));
    const dataset: HistoricalDataset = {
      ...original,
      macroReleases: [
        ...original.macroReleases.filter((record) => record.seriesId !== "US_FED_FUNDS_TARGET_UPPER"),
        ...fedFunds,
      ],
    };
    const report = assessResearchCoverage(dataset, buildManifest(dataset));
    expect(report.hasUpwardRateTransition).toBe(true);
    expect(report.hasDownwardRateTransition).toBe(false);
    expect((report as unknown as Record<string, unknown>).hasTighteningPhase).toBeUndefined();
    expect((report as unknown as Record<string, unknown>).hasEasingPhase).toBeUndefined();
    expect(JSON.stringify(report)).not.toMatch(/tightening phase|easing phase/i);
  });

  it("labels one VIX threshold crossing only as an elevated observation, never a stress regime", () => {
    const original = fixtureDataset();
    let changed = false;
    const dataset: HistoricalDataset = {
      ...original,
      marketObservations: original.marketObservations.map((record) => {
        if (!changed && record.seriesId === "VIX") {
          changed = true;
          return { ...record, value: DEFAULT_RESEARCH_COVERAGE_POLICY.elevatedVixThreshold };
        }
        return record;
      }),
    };
    const report = assessResearchCoverage(dataset, buildManifest(dataset));
    expect(report.hasElevatedVixObservation).toBe(true);
    expect((report as unknown as Record<string, unknown>).hasStressRegime).toBeUndefined();
    expect(JSON.stringify(report)).not.toMatch(/stress regime/i);
  });

  it("produces deterministic canonical serialization and injected hash output", () => {
    const dataset = fixtureDataset();
    const manifest = buildManifest(dataset);
    const input = buildResearchSnapshotCanonicalInput(dataset, manifest);
    const deterministicTestHasher = (value: string) => `test:${value.length}:${value.charCodeAt(0)}`;
    expect(buildResearchSnapshotCanonicalInput(dataset, manifest)).toBe(input);
    expect(calculateResearchSnapshotHash(dataset, manifest, deterministicTestHasher)).toBe(
      deterministicTestHasher(input)
    );
  });

  it("normalizes reordered equivalent records and manifest sources identically", () => {
    const dataset = fixtureDataset();
    const manifest = buildManifest(dataset);
    const reordered: HistoricalDataset = {
      marketObservations: [...dataset.marketObservations].reverse(),
      macroReleases: [...dataset.macroReleases].reverse(),
      eventRecords: [...dataset.eventRecords].reverse(),
    };
    const reorderedManifest = { ...manifest, sources: [...manifest.sources].reverse() };
    expect(buildResearchSnapshotCanonicalInput(reordered, reorderedManifest)).toBe(
      buildResearchSnapshotCanonicalInput(dataset, manifest)
    );
  });

  it("changes canonical snapshot identity input when actual data changes", () => {
    const dataset = fixtureDataset();
    const manifest = buildManifest(dataset);
    const changed: HistoricalDataset = {
      ...dataset,
      marketObservations: dataset.marketObservations.map((record, index) =>
        index === 0 ? { ...record, value: record.value + 1 } : record
      ),
    };
    expect(buildResearchSnapshotCanonicalInput(changed, manifest)).not.toBe(
      buildResearchSnapshotCanonicalInput(dataset, manifest)
    );
  });

  it("fails closed on an empty dataset", () => {
    const dataset = fixtureDataset();
    expect(() => assessResearchCoverage(
      { marketObservations: [], macroReleases: [], eventRecords: [] },
      buildManifest(dataset),
      DEFAULT_RESEARCH_COVERAGE_POLICY
    )).toThrow(/historical dataset is empty/i);
  });

  it("represents revision vintages truthfully", () => {
    const dataset = fixtureDataset();
    const januaryNfp = dataset.macroReleases.filter(
      (record) => record.seriesId === "US_NFP_NET_CHANGE" && record.observationTime === 1706659200000
    );
    expect(januaryNfp.map((record) => record.revisionIndex).sort()).toEqual([0, 1]);
    const report = assessResearchCoverage(dataset, buildManifest(dataset));
    expect(report.perSeries.find((series) => series.seriesId === "US_NFP_NET_CHANGE")?.hasMultipleVintages).toBe(true);
  });

  it("keeps consensus nullable and never fabricates it", () => {
    const dataset = fixtureDataset();
    expect(dataset.eventRecords.length).toBeGreaterThan(0);
    expect(dataset.eventRecords.every((event) => event.consensus === null && event.surprise === null)).toBe(true);
  });

  it("does not mutate dataset or manifest inputs", () => {
    const dataset = fixtureDataset();
    const manifest = buildManifest(dataset);
    const beforeDataset = JSON.stringify(dataset);
    const beforeManifest = JSON.stringify(manifest);
    assessResearchCoverage(dataset, manifest);
    buildResearchSnapshotCanonicalInput(dataset, manifest);
    expect(JSON.stringify(dataset)).toBe(beforeDataset);
    expect(JSON.stringify(manifest)).toBe(beforeManifest);
  });

  it("does not change Alpha, Permission, Risk, Omega, execution, or accounting outputs", () => {
    const dataset = fixtureDataset();
    const manifest = buildManifest(dataset);
    const assetBars = bars(145, 1706745600000);
    const baseline = runBacktest(backtestConfig, { assetBars: { BTC: assetBars } });
    assessResearchCoverage(dataset, manifest);
    buildResearchSnapshotCanonicalInput(dataset, manifest);
    const afterProtocolEvaluation = runBacktest(backtestConfig, { assetBars: { BTC: assetBars } });
    expect(afterProtocolEvaluation).toEqual(baseline);
  });
});
