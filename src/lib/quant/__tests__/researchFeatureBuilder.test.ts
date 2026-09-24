import { describe, expect, it } from "vitest";
import { deriveHigherTimeframeContext } from "../derivedTimeframeContext";
import type { HistoricalEventRecord, HistoricalMacroRelease } from "../historicalPit";
import {
  buildResearchFeatureVector,
  defineResearchFeature,
  type BuildResearchFeatureVectorInput,
  type ResearchFeatureDefinition,
} from "../researchFeatureBuilder";
import { BAR_DURATION_MS } from "../timeDomain";
import type { PointInTimeBar } from "../types";

const HOUR = BAR_DURATION_MS;
const START = Date.UTC(2024, 0, 1);
const DECISION = START + 24 * HOUR;

function bars(count = 24, start = START): PointInTimeBar[] {
  return Array.from({ length: count }, (_, index) => ({
    timestamp: start + index * HOUR,
    open: 100 + index,
    high: 102 + index,
    low: 99 + index,
    close: 101 + index,
    volume: 10 + index,
  }));
}

const close = (
  featureId: string,
  timeframe: "1H" | "4H" | "1D" = "1H",
  lag = 0
): ResearchFeatureDefinition => ({
  featureId,
  version: "1.0.0",
  description: `${timeframe} close`,
  dependency: { kind: "TIMEFRAME", timeframe },
  transformation: { kind: "BAR_CLOSE", lag },
});

const simpleReturn = (
  featureId: string,
  timeframe: "1H" | "4H" | "1D",
  lookback: number
): ResearchFeatureDefinition => ({
  featureId,
  version: "1.0.0",
  description: `${timeframe} simple return`,
  dependency: { kind: "TIMEFRAME", timeframe },
  transformation: { kind: "BAR_SIMPLE_RETURN", lookback },
});

const level = (featureId: string, seriesId: "US_CPI_YOY" | "VIX" | "FOMC_RATE_DECISION"):
ResearchFeatureDefinition => ({
  featureId,
  version: "1.0.0",
  description: `${seriesId} level`,
  dependency: { kind: "SERIES", seriesId },
  transformation: { kind: "SERIES_LEVEL" },
});

function macro(availableAt = DECISION, revisionIndex = 0): HistoricalMacroRelease {
  return {
    seriesId: "US_CPI_YOY",
    observationTime: START - 30 * 24 * HOUR,
    publishedAt: availableAt,
    availableAt,
    vintageDate: "2024-01-01",
    revisionIndex,
    value: 3.2 + revisionIndex,
    provider: "BLS",
    unit: "PERCENT",
  };
}

function event(availableAt = DECISION, actual: number | null = 5.5): HistoricalEventRecord {
  return {
    eventId: "FOMC-2024-01",
    eventType: "FED_RATE_DECISION",
    observationTime: availableAt,
    publishedAt: availableAt,
    availableAt,
    actual,
    consensus: null,
    consensusFrozenAt: null,
    previous: 5.5,
    surprise: null,
    provider: "FEDERAL_RESERVE",
    sourceQuality: "TIER_1_OFFICIAL",
  };
}

function input(overrides: Partial<BuildResearchFeatureVectorInput> = {}): BuildResearchFeatureVectorInput {
  const oneHourBars = bars();
  return {
    assetId: "BTC",
    decisionTime: DECISION,
    asOf: DECISION,
    definitions: [close("BTC_1H_CLOSE")],
    oneHourBars,
    derivedTimeframes: deriveHigherTimeframeContext({
      assetId: "BTC",
      eligible1hBars: oneHourBars,
      decisionTime: DECISION,
    }),
    series: {},
    ...overrides,
  };
}

describe("M13C C-E PIT-safe research feature builder", () => {
  it("binds every feature and vector to one exact decision boundary", () => {
    const vector = buildResearchFeatureVector(input());
    expect(vector).toMatchObject({ assetId: "BTC", decisionTime: DECISION, asOf: DECISION });
    expect(vector.features[0]).toMatchObject({ assetId: "BTC", decisionTime: DECISION, asOf: DECISION });
  });

  it("rejects an asOf boundary different from decisionTime", () => {
    expect(() => buildResearchFeatureVector(input({ asOf: DECISION - 1 }))).toThrow(/asOf must equal decisionTime/);
  });

  it("makes a 1H close visible exactly when the canonical bar closes", () => {
    const boundaryBar = bars().at(-1)!;
    const vector = buildResearchFeatureVector(input());
    expect(vector.features[0]).toMatchObject({ status: "AVAILABLE", value: boundaryBar.close });
    expect(vector.features[0].provenance).toMatchObject({ latestAvailableAt: DECISION, evidenceAgeMs: 0 });
  });

  it("does not expose a future 1H bar", () => {
    const futureOnly = bars(1, DECISION);
    const vector = buildResearchFeatureVector(input({ oneHourBars: futureOnly, derivedTimeframes: undefined }));
    expect(vector.features[0]).toMatchObject({
      status: "UNAVAILABLE",
      reasonCode: "DEPENDENCY_UNAVAILABLE",
      value: null,
      provenance: null,
    });
  });

  it("uses eligible history while ignoring a later future 1H bar", () => {
    const eligible = bars();
    const future = bars(1, DECISION)[0];
    const vector = buildResearchFeatureVector(input({ oneHourBars: [...eligible, future] }));
    expect(vector.features[0].value).toBe(eligible.at(-1)!.close);
  });

  it("uses C-A completed 4H bars without reconstructing an incomplete bucket", () => {
    const threeBars = bars(3);
    const decisionTime = START + 4 * HOUR;
    const derived = deriveHigherTimeframeContext({ assetId: "BTC", eligible1hBars: threeBars, decisionTime });
    const vector = buildResearchFeatureVector(input({
      decisionTime,
      asOf: decisionTime,
      definitions: [close("BTC_4H_CLOSE", "4H")],
      oneHourBars: threeBars,
      derivedTimeframes: derived,
    }));
    expect(vector.features[0]).toMatchObject({ status: "UNAVAILABLE", value: null });
  });

  it("keeps incomplete 1D context unavailable while unrelated completed 4H remains usable", () => {
    const partial = bars(23);
    const derived = deriveHigherTimeframeContext({ assetId: "BTC", eligible1hBars: partial, decisionTime: DECISION });
    const vector = buildResearchFeatureVector(input({
      definitions: [close("BTC_1D_CLOSE", "1D"), close("BTC_4H_CLOSE", "4H")],
      oneHourBars: partial,
      derivedTimeframes: derived,
    }));
    expect(vector.features.find((feature) => feature.featureId === "BTC_1D_CLOSE")?.status).toBe("UNAVAILABLE");
    expect(vector.features.find((feature) => feature.featureId === "BTC_4H_CLOSE")?.status).toBe("AVAILABLE");
  });

  it("rejects a forged derived bar that claims completion with too few components", () => {
    const derived = deriveHigherTimeframeContext({ assetId: "BTC", eligible1hBars: bars(), decisionTime: DECISION });
    const forged = {
      ...derived,
      completed4hBars: [{ ...derived.completed4hBars[0], componentCount: 3 }],
    };
    expect(() => buildResearchFeatureVector(input({
      definitions: [close("BTC_4H_CLOSE", "4H")],
      derivedTimeframes: forged,
    }))).toThrow(/mislabeled or non-PIT evidence/);
  });

  it("computes a deterministic simple return from eligible closed bars only", () => {
    const vector = buildResearchFeatureVector(input({ definitions: [simpleReturn("BTC_1H_RETURN", "1H", 2)] }));
    const source = bars();
    expect(vector.features[0].value).toBeCloseTo(source.at(-1)!.close / source.at(-3)!.close - 1);
    expect(vector.features[0].provenance).toMatchObject({ kind: "TECHNICAL_BARS" });
  });

  it("marks insufficient technical history explicitly", () => {
    const vector = buildResearchFeatureVector(input({
      definitions: [simpleReturn("BTC_1H_RETURN", "1H", 3)],
      oneHourBars: bars(2),
      derivedTimeframes: undefined,
    }));
    expect(vector.features[0]).toMatchObject({ status: "UNAVAILABLE", reasonCode: "INSUFFICIENT_HISTORY" });
  });

  it("keeps a macro release unavailable immediately before availableAt", () => {
    const decisionTime = DECISION - 1;
    const release = macro(DECISION);
    const vector = buildResearchFeatureVector(input({
      decisionTime,
      asOf: decisionTime,
      definitions: [level("CPI_LEVEL", "US_CPI_YOY")],
      derivedTimeframes: undefined,
      series: { US_CPI_YOY: release },
    }));
    expect(vector.features[0]).toMatchObject({
      status: "UNAVAILABLE",
      reasonCode: "EVIDENCE_NOT_PIT_ELIGIBLE",
      value: null,
    });
  });

  it("exposes a macro release exactly at availableAt with full source metadata", () => {
    const release = macro();
    const vector = buildResearchFeatureVector(input({
      definitions: [level("CPI_LEVEL", "US_CPI_YOY")],
      series: { US_CPI_YOY: release },
    }));
    expect(vector.features[0]).toMatchObject({ status: "AVAILABLE", value: release.value });
    expect(vector.features[0].provenance).toMatchObject({
      kind: "RESEARCH_SERIES",
      availableAt: DECISION,
      evidenceAgeMs: 0,
      record: release,
    });
  });

  it("does not expose a future macro revision", () => {
    const revision = macro(DECISION + HOUR, 1);
    const vector = buildResearchFeatureVector(input({
      definitions: [level("CPI_LEVEL", "US_CPI_YOY")],
      series: { US_CPI_YOY: revision },
    }));
    expect(vector.features[0]).toMatchObject({ status: "UNAVAILABLE", reasonCode: "EVIDENCE_NOT_PIT_ELIGIBLE" });
  });

  it("exposes event actual only at its public availability boundary", () => {
    const fomc = event();
    const before = buildResearchFeatureVector(input({
      decisionTime: DECISION - 1,
      asOf: DECISION - 1,
      definitions: [level("FOMC_LEVEL", "FOMC_RATE_DECISION")],
      derivedTimeframes: undefined,
      series: { FOMC_RATE_DECISION: fomc },
    }));
    const at = buildResearchFeatureVector(input({
      definitions: [level("FOMC_LEVEL", "FOMC_RATE_DECISION")],
      series: { FOMC_RATE_DECISION: fomc },
    }));
    expect(before.features[0].status).toBe("UNAVAILABLE");
    expect(at.features[0]).toMatchObject({ status: "AVAILABLE", value: 5.5 });
  });

  it("does not fabricate a numeric event value when actual is unavailable", () => {
    const vector = buildResearchFeatureVector(input({
      definitions: [level("FOMC_LEVEL", "FOMC_RATE_DECISION")],
      series: { FOMC_RATE_DECISION: event(DECISION, null) },
    }));
    expect(vector.features[0]).toMatchObject({
      status: "UNAVAILABLE",
      reasonCode: "NUMERIC_VALUE_UNAVAILABLE",
      value: null,
    });
  });

  it("does not fabricate a missing optional series or invalidate unrelated features", () => {
    const vector = buildResearchFeatureVector(input({
      definitions: [level("VIX_LEVEL", "VIX"), close("BTC_1H_CLOSE")],
      series: {},
    }));
    expect(vector.features.find((feature) => feature.featureId === "VIX_LEVEL")).toMatchObject({
      status: "UNAVAILABLE",
      value: null,
      provenance: null,
    });
    expect(vector.features.find((feature) => feature.featureId === "BTC_1H_CLOSE")?.status).toBe("AVAILABLE");
  });

  it("is deterministic across definition ordering", () => {
    const definitions = [level("CPI_LEVEL", "US_CPI_YOY"), close("BTC_1H_CLOSE")];
    const left = buildResearchFeatureVector(input({ definitions, series: { US_CPI_YOY: macro() } }));
    const right = buildResearchFeatureVector(input({ definitions: [...definitions].reverse(), series: { US_CPI_YOY: macro() } }));
    expect(left.semanticIdentity).toBe(right.semanticIdentity);
    expect(left).toEqual(right);
  });

  it("changes feature identity for material source, timeframe, transformation, or parameter changes", () => {
    const oneHour = defineResearchFeature(close("FEATURE", "1H"));
    const fourHour = defineResearchFeature(close("FEATURE", "4H"));
    const lagged = defineResearchFeature(close("FEATURE", "1H", 1));
    const transformed = defineResearchFeature(simpleReturn("FEATURE", "1H", 1));
    expect(new Set([
      oneHour.semanticIdentity,
      fourHour.semanticIdentity,
      lagged.semanticIdentity,
      transformed.semanticIdentity,
    ]).size).toBe(4);
  });

  it("rejects result-driven fields in feature definitions", () => {
    const malformed = { ...close("FEATURE"), sharpe: 2 } as ResearchFeatureDefinition;
    expect(() => defineResearchFeature(malformed)).toThrow(/result\/performance-selection field/);
  });

  it("rejects transformation/dependency mismatches and invalid parameters", () => {
    expect(() => defineResearchFeature({
      ...level("CPI_LEVEL", "US_CPI_YOY"),
      transformation: { kind: "BAR_CLOSE", lag: 0 },
    })).toThrow(/series features require SERIES_LEVEL/);
    expect(() => defineResearchFeature(close("FEATURE", "1H", -1))).toThrow(/lag must be/);
  });

  it("rejects mismatched derived context boundaries and assets", () => {
    const derived = deriveHigherTimeframeContext({ assetId: "PAXG", eligible1hBars: bars(), decisionTime: DECISION });
    expect(() => buildResearchFeatureVector(input({ derivedTimeframes: derived }))).toThrow(/does not share/);
  });

  it("does not mutate caller inputs and returns deeply frozen output", () => {
    const sourceBars = bars();
    const definitions = [close("BTC_1H_CLOSE")];
    const originalBars = JSON.stringify(sourceBars);
    const originalDefinitions = JSON.stringify(definitions);
    const vector = buildResearchFeatureVector(input({ oneHourBars: sourceBars, definitions }));
    expect(JSON.stringify(sourceBars)).toBe(originalBars);
    expect(JSON.stringify(definitions)).toBe(originalDefinitions);
    expect(Object.isFrozen(vector)).toBe(true);
    expect(Object.isFrozen(vector.features)).toBe(true);
    expect(Object.isFrozen(vector.features[0])).toBe(true);
  });

  it("grants no predictive, paper-action, execution, or price authority", () => {
    const vector = buildResearchFeatureVector(input());
    expect(vector).toMatchObject({
      predictiveValidityEstablished: false,
      approvedForPaperAction: false,
      grantsExecutionAuthority: false,
      priceAuthority: "NONE",
    });
    expect(vector.features[0]).toMatchObject({
      predictiveValidityEstablished: false,
      approvedForPaperAction: false,
      grantsExecutionAuthority: false,
    });
    expect(JSON.stringify(vector)).not.toMatch(/targetWeight|orderId|ActionDecision|pnl/i);
  });
});
