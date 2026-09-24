// ============================================================================
// FILE: src/lib/quant/researchFeatureBuilder.ts
// MODULE: PIT-SAFE MACRO + TECHNICAL FEATURE BUILDER (M13C / C-E)
//
// Deterministic research evidence only. Features do not grant predictive,
// paper-action, allocation, execution, or accounting authority.
// ============================================================================

import {
  FOUR_HOUR_DURATION_MS,
  ONE_DAY_DURATION_MS,
  type DerivedResearchBar,
  type DerivedTimeframeContext,
} from "./derivedTimeframeContext";
import {
  validateHistoricalEvent,
  validateHistoricalMacroRelease,
  validateHistoricalMarketObservation,
  type HistoricalEventRecord,
  type HistoricalMacroRelease,
  type HistoricalMarketObservation,
} from "./historicalPit";
import { RESEARCH_SERIES_SPECS, type ResearchSeriesId } from "./researchDataProtocol";
import type { ResearchDependency, ResearchSeriesEvidence, ResearchTimeframe } from "./researchRules";
import { BAR_DURATION_MS } from "./timeDomain";
import type { AssetId, PointInTimeBar } from "./types";

export const RESEARCH_FEATURE_SCHEMA_VERSION = "M13C-C-E-1";

export type ResearchFeatureTransformation =
  | Readonly<{ kind: "BAR_CLOSE"; lag: number }>
  | Readonly<{ kind: "BAR_SIMPLE_RETURN"; lookback: number }>
  | Readonly<{ kind: "SERIES_LEVEL" }>;

export interface ResearchFeatureDefinition {
  readonly featureId: string;
  readonly version: string;
  readonly description: string;
  readonly dependency: ResearchDependency;
  readonly transformation: ResearchFeatureTransformation;
}

export interface DefinedResearchFeature extends ResearchFeatureDefinition {
  readonly semanticIdentity: string;
  readonly intendedUse: "RESEARCH_FEATURE_ONLY";
  readonly predictiveValidityEstablished: false;
  readonly approvedForPaperAction: false;
  readonly grantsExecutionAuthority: false;
}

export interface ResearchFeatureBarEvidence {
  readonly assetId: AssetId;
  readonly timeframe: ResearchTimeframe;
  readonly timestamp: number;
  readonly startTime: number;
  readonly endTime: number;
  readonly availableAt: number;
  readonly componentCount: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

export type ResearchFeatureSeriesEvidence =
  | HistoricalMarketObservation
  | HistoricalMacroRelease
  | HistoricalEventRecord;

export type ResearchFeatureProvenance =
  | Readonly<{
    kind: "TECHNICAL_BARS";
    timeframe: ResearchTimeframe;
    records: readonly ResearchFeatureBarEvidence[];
    latestAvailableAt: number;
    evidenceAgeMs: number;
  }>
  | Readonly<{
    kind: "RESEARCH_SERIES";
    seriesId: ResearchSeriesId;
    record: ResearchFeatureSeriesEvidence;
    availableAt: number;
    evidenceAgeMs: number;
    observationAgeMs: number;
  }>;

export type ResearchFeatureAvailabilityReason =
  | "AVAILABLE"
  | "DEPENDENCY_UNAVAILABLE"
  | "INSUFFICIENT_HISTORY"
  | "EVIDENCE_NOT_PIT_ELIGIBLE"
  | "NUMERIC_VALUE_UNAVAILABLE";

export interface ResearchFeatureValue {
  readonly featureId: string;
  readonly version: string;
  readonly semanticIdentity: string;
  readonly dependency: ResearchDependency;
  readonly transformation: ResearchFeatureTransformation;
  readonly status: "AVAILABLE" | "UNAVAILABLE";
  readonly reasonCode: ResearchFeatureAvailabilityReason;
  readonly value: number | null;
  readonly provenance: ResearchFeatureProvenance | null;
  readonly decisionTime: number;
  readonly asOf: number;
  readonly assetId: AssetId;
  readonly predictiveValidityEstablished: false;
  readonly approvedForPaperAction: false;
  readonly grantsExecutionAuthority: false;
}

export interface ResearchFeatureVector {
  readonly schemaVersion: typeof RESEARCH_FEATURE_SCHEMA_VERSION;
  readonly intendedUse: "RESEARCH_ONLY";
  readonly assetId: AssetId;
  readonly decisionTime: number;
  readonly asOf: number;
  readonly specificationIdentity: string;
  readonly semanticIdentity: string;
  readonly features: readonly ResearchFeatureValue[];
  readonly predictiveValidityEstablished: false;
  readonly approvedForPaperAction: false;
  readonly grantsExecutionAuthority: false;
  readonly priceAuthority: "NONE";
}

export interface BuildResearchFeatureVectorInput {
  readonly assetId: AssetId;
  readonly decisionTime: number;
  readonly asOf: number;
  readonly definitions: readonly ResearchFeatureDefinition[];
  readonly oneHourBars?: readonly PointInTimeBar[];
  readonly derivedTimeframes?: DerivedTimeframeContext;
  readonly series?: Readonly<Partial<Record<ResearchSeriesId, ResearchSeriesEvidence>>>;
}

export class ResearchFeatureValidationError extends Error {
  constructor(message: string) {
    super(`[ResearchFeature] ${message}`);
    this.name = "ResearchFeatureValidationError";
  }
}

const FORBIDDEN_RESULT_FIELDS = new Set([
  "performance", "sharpe", "return", "returns", "winrate", "oosresult",
  "ranking", "rank", "score", "pnl", "bestparameter", "bestparameters",
  "selectedparameter", "selectedparameters",
]);

function fail(message: string): never {
  throw new ResearchFeatureValidationError(message);
}

function requireText(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) fail(`${field} must be a non-empty string.`);
  return value.trim();
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) normalized[key] = canonicalize(child);
    }
    return normalized;
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function rejectResultFields(value: unknown, path = "definition", seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) fail(`${path} must not contain cycles.`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectResultFields(item, `${path}[${index}]`, seen));
  } else {
    for (const [key, child] of Object.entries(value)) {
      const normalizedKey = key.replace(/[_\-\s]/g, "").toLowerCase();
      if (FORBIDDEN_RESULT_FIELDS.has(normalizedKey)) {
        fail(`${path}.${key} is a result/performance-selection field and is prohibited.`);
      }
      rejectResultFields(child, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function dependencyKey(dependency: ResearchDependency): string {
  return dependency.kind === "SERIES"
    ? `SERIES:${dependency.seriesId}`
    : `TIMEFRAME:${dependency.timeframe}`;
}

function normalizeDependency(dependency: ResearchDependency): ResearchDependency {
  if (dependency.kind === "SERIES") {
    if (!(dependency.seriesId in RESEARCH_SERIES_SPECS)) fail(`unsupported series ${dependency.seriesId}.`);
    return Object.freeze({ kind: "SERIES", seriesId: dependency.seriesId });
  }
  if (!(["1H", "4H", "1D"] as readonly string[]).includes(dependency.timeframe)) {
    fail(`unsupported timeframe ${String(dependency.timeframe)}.`);
  }
  return Object.freeze({ kind: "TIMEFRAME", timeframe: dependency.timeframe });
}

function normalizeTransformation(
  dependency: ResearchDependency,
  transformation: ResearchFeatureTransformation
): ResearchFeatureTransformation {
  if (dependency.kind === "SERIES") {
    if (transformation.kind !== "SERIES_LEVEL") fail("series features require SERIES_LEVEL transformation.");
    return Object.freeze({ kind: "SERIES_LEVEL" });
  }
  if (transformation.kind === "BAR_CLOSE") {
    if (!Number.isSafeInteger(transformation.lag) || transformation.lag < 0 || transformation.lag > 10_000) {
      fail("BAR_CLOSE lag must be a safe integer between 0 and 10000.");
    }
    return Object.freeze({ kind: "BAR_CLOSE", lag: transformation.lag });
  }
  if (transformation.kind === "BAR_SIMPLE_RETURN") {
    if (!Number.isSafeInteger(transformation.lookback)
      || transformation.lookback <= 0 || transformation.lookback > 10_000) {
      fail("BAR_SIMPLE_RETURN lookback must be a safe integer between 1 and 10000.");
    }
    return Object.freeze({ kind: "BAR_SIMPLE_RETURN", lookback: transformation.lookback });
  }
  fail("timeframe features require BAR_CLOSE or BAR_SIMPLE_RETURN transformation.");
}

export function defineResearchFeature(definition: ResearchFeatureDefinition): DefinedResearchFeature {
  rejectResultFields(definition);
  const dependency = normalizeDependency(definition.dependency);
  const transformation = normalizeTransformation(dependency, definition.transformation);
  const normalized: ResearchFeatureDefinition = Object.freeze({
    featureId: requireText(definition.featureId, "featureId"),
    version: requireText(definition.version, "version"),
    description: requireText(definition.description, "description"),
    dependency,
    transformation,
  });
  const semanticIdentity = canonicalJson({
    featureId: normalized.featureId,
    version: normalized.version,
    dependency: dependencyKey(normalized.dependency),
    transformation: normalized.transformation,
  });
  return deepFreeze({
    ...normalized,
    semanticIdentity,
    intendedUse: "RESEARCH_FEATURE_ONLY" as const,
    predictiveValidityEstablished: false as const,
    approvedForPaperAction: false as const,
    grantsExecutionAuthority: false as const,
  });
}

function validateBoundary(input: BuildResearchFeatureVectorInput): void {
  requireText(input.assetId, "assetId");
  if (!Number.isSafeInteger(input.decisionTime) || input.decisionTime < 0) {
    fail("decisionTime must be a non-negative safe-integer epoch millisecond.");
  }
  if (input.asOf !== input.decisionTime) fail("asOf must equal decisionTime.");
  if (!Array.isArray(input.definitions)) fail("definitions must be an explicit array.");
}

function validateOhlcv(bar: PointInTimeBar, label: string): void {
  if (!Number.isSafeInteger(bar.timestamp) || bar.timestamp < 0 || bar.timestamp % BAR_DURATION_MS !== 0) {
    fail(`${label} has an invalid or unaligned timestamp.`);
  }
  if (![bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite)
    || bar.open <= 0 || bar.high <= 0 || bar.low <= 0 || bar.close <= 0 || bar.volume < 0
    || bar.high < Math.max(bar.open, bar.low, bar.close)
    || bar.low > Math.min(bar.open, bar.high, bar.close)) {
    fail(`${label} has invalid OHLCV values.`);
  }
}

function oneHourEvidence(input: BuildResearchFeatureVectorInput): readonly ResearchFeatureBarEvidence[] {
  const eligible = new Map<number, ResearchFeatureBarEvidence>();
  for (const bar of input.oneHourBars ?? []) {
    const availableAt = bar.timestamp + BAR_DURATION_MS;
    if (!Number.isSafeInteger(availableAt) || availableAt > input.decisionTime) continue;
    validateOhlcv(bar, `1H bar at ${bar.timestamp}`);
    if (eligible.has(bar.timestamp)) fail(`duplicate eligible 1H bar at ${bar.timestamp}.`);
    eligible.set(bar.timestamp, Object.freeze({
      assetId: input.assetId,
      timeframe: "1H",
      timestamp: bar.timestamp,
      startTime: bar.timestamp,
      endTime: availableAt,
      availableAt,
      componentCount: 1,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
    }));
  }
  return Object.freeze([...eligible.values()].sort((left, right) => left.timestamp - right.timestamp));
}

function validateDerivedContext(input: BuildResearchFeatureVectorInput): void {
  const context = input.derivedTimeframes;
  if (!context) return;
  if (context.assetId !== input.assetId || context.decisionTime !== input.decisionTime || context.asOf !== input.asOf) {
    fail("derived timeframe context does not share the feature-vector asset and PIT boundary.");
  }
  if (context.intendedUse !== "RESEARCH_CONTEXT_ONLY"
    || context.grantsExecutionAuthority !== false || context.priceAuthority !== "NONE") {
    fail("derived timeframe context claims incompatible authority.");
  }
}

function derivedEvidence(
  input: BuildResearchFeatureVectorInput,
  timeframe: "4H" | "1D"
): readonly ResearchFeatureBarEvidence[] {
  validateDerivedContext(input);
  const bars = timeframe === "4H"
    ? input.derivedTimeframes?.completed4hBars ?? []
    : input.derivedTimeframes?.completed1dBars ?? [];
  const duration = timeframe === "4H" ? FOUR_HOUR_DURATION_MS : ONE_DAY_DURATION_MS;
  const componentCount = timeframe === "4H" ? 4 : 24;
  const seen = new Set<number>();
  return Object.freeze(bars.map((bar: DerivedResearchBar) => {
    if (bar.assetId !== input.assetId || bar.timeframe !== timeframe || bar.availableAt > input.decisionTime
      || bar.endTime !== bar.availableAt || bar.startTime !== bar.timestamp
      || bar.startTime % duration !== 0 || bar.endTime - bar.startTime !== duration
      || bar.componentCount !== componentCount) {
      fail(`${timeframe} context contains mislabeled or non-PIT evidence.`);
    }
    validateOhlcv(bar, `${timeframe} bar at ${bar.timestamp}`);
    if (seen.has(bar.timestamp)) fail(`duplicate ${timeframe} bar at ${bar.timestamp}.`);
    seen.add(bar.timestamp);
    return Object.freeze({ ...bar });
  }).sort((left, right) => left.timestamp - right.timestamp));
}

function unavailable(
  feature: DefinedResearchFeature,
  input: BuildResearchFeatureVectorInput,
  reasonCode: Exclude<ResearchFeatureAvailabilityReason, "AVAILABLE">
): ResearchFeatureValue {
  return deepFreeze({
    featureId: feature.featureId,
    version: feature.version,
    semanticIdentity: feature.semanticIdentity,
    dependency: feature.dependency,
    transformation: feature.transformation,
    status: "UNAVAILABLE" as const,
    reasonCode,
    value: null,
    provenance: null,
    decisionTime: input.decisionTime,
    asOf: input.asOf,
    assetId: input.assetId,
    predictiveValidityEstablished: false as const,
    approvedForPaperAction: false as const,
    grantsExecutionAuthority: false as const,
  });
}

function available(
  feature: DefinedResearchFeature,
  input: BuildResearchFeatureVectorInput,
  value: number,
  provenance: ResearchFeatureProvenance
): ResearchFeatureValue {
  if (!Number.isFinite(value)) fail(`${feature.featureId} produced a non-finite value.`);
  return deepFreeze({
    featureId: feature.featureId,
    version: feature.version,
    semanticIdentity: feature.semanticIdentity,
    dependency: feature.dependency,
    transformation: feature.transformation,
    status: "AVAILABLE" as const,
    reasonCode: "AVAILABLE" as const,
    value,
    provenance,
    decisionTime: input.decisionTime,
    asOf: input.asOf,
    assetId: input.assetId,
    predictiveValidityEstablished: false as const,
    approvedForPaperAction: false as const,
    grantsExecutionAuthority: false as const,
  });
}

function buildTechnicalFeature(
  feature: DefinedResearchFeature,
  input: BuildResearchFeatureVectorInput
): ResearchFeatureValue {
  if (feature.dependency.kind !== "TIMEFRAME") fail("internal feature dependency mismatch.");
  const timeframe = feature.dependency.timeframe;
  const bars = timeframe === "1H"
    ? oneHourEvidence(input)
    : derivedEvidence(input, timeframe);
  if (bars.length === 0) return unavailable(feature, input, "DEPENDENCY_UNAVAILABLE");

  let selected: readonly ResearchFeatureBarEvidence[];
  let value: number;
  if (feature.transformation.kind === "BAR_CLOSE") {
    const selectedBar = bars.at(-(feature.transformation.lag + 1));
    if (!selectedBar) return unavailable(feature, input, "INSUFFICIENT_HISTORY");
    selected = [selectedBar];
    value = selectedBar.close;
  } else if (feature.transformation.kind === "BAR_SIMPLE_RETURN") {
    const latest = bars.at(-1);
    const prior = bars.at(-(feature.transformation.lookback + 1));
    if (!latest || !prior) return unavailable(feature, input, "INSUFFICIENT_HISTORY");
    selected = [prior, latest];
    value = latest.close / prior.close - 1;
  } else {
    fail("timeframe feature has an incompatible transformation.");
  }
  const latestAvailableAt = Math.max(...selected.map((bar) => bar.availableAt));
  return available(feature, input, value, deepFreeze({
    kind: "TECHNICAL_BARS" as const,
    timeframe,
    records: Object.freeze(selected.map((bar) => Object.freeze({ ...bar }))),
    latestAvailableAt,
    evidenceAgeMs: input.decisionTime - latestAvailableAt,
  }));
}

function validateSeriesEvidence(seriesId: ResearchSeriesId, evidence: ResearchSeriesEvidence): void {
  const expectedKind = RESEARCH_SERIES_SPECS[seriesId].kind;
  if ("eventId" in evidence) {
    if (expectedKind !== "OFFICIAL_EVENT") fail(`${seriesId} requires ${expectedKind} evidence.`);
    validateHistoricalEvent(evidence);
    if (seriesId === "FOMC_RATE_DECISION"
      && evidence.eventType !== "FED_RATE_DECISION" && evidence.eventType !== "FOMC_STATEMENT") {
      fail("FOMC_RATE_DECISION evidence has an incompatible eventType.");
    }
  } else if ("revisionIndex" in evidence) {
    if (expectedKind !== "MACRO_RELEASE") fail(`${seriesId} requires ${expectedKind} evidence.`);
    validateHistoricalMacroRelease(evidence);
    if (evidence.seriesId !== seriesId) fail(`series key ${seriesId} conflicts with record ${evidence.seriesId}.`);
  } else {
    if (expectedKind !== "MARKET_FACTOR") fail(`${seriesId} requires ${expectedKind} evidence.`);
    validateHistoricalMarketObservation(evidence);
    if (evidence.seriesId !== seriesId) fail(`series key ${seriesId} conflicts with record ${evidence.seriesId}.`);
  }
}

function cloneSeriesEvidence(evidence: ResearchSeriesEvidence): ResearchFeatureSeriesEvidence {
  return Object.freeze({ ...evidence });
}

function buildSeriesFeature(
  feature: DefinedResearchFeature,
  input: BuildResearchFeatureVectorInput
): ResearchFeatureValue {
  if (feature.dependency.kind !== "SERIES" || feature.transformation.kind !== "SERIES_LEVEL") {
    fail("internal series feature mismatch.");
  }
  const seriesId = feature.dependency.seriesId;
  const evidence = input.series?.[seriesId];
  if (!evidence) return unavailable(feature, input, "DEPENDENCY_UNAVAILABLE");
  validateSeriesEvidence(seriesId, evidence);
  if (evidence.availableAt > input.decisionTime) {
    return unavailable(feature, input, "EVIDENCE_NOT_PIT_ELIGIBLE");
  }
  const value = "eventId" in evidence ? evidence.actual : evidence.value;
  if (value === null || !Number.isFinite(value)) {
    return unavailable(feature, input, "NUMERIC_VALUE_UNAVAILABLE");
  }
  const record = cloneSeriesEvidence(evidence);
  return available(feature, input, value, deepFreeze({
    kind: "RESEARCH_SERIES" as const,
    seriesId,
    record,
    availableAt: evidence.availableAt,
    evidenceAgeMs: input.decisionTime - evidence.availableAt,
    observationAgeMs: input.decisionTime - evidence.observationTime,
  }));
}

function featureValue(
  feature: DefinedResearchFeature,
  input: BuildResearchFeatureVectorInput
): ResearchFeatureValue {
  return feature.dependency.kind === "TIMEFRAME"
    ? buildTechnicalFeature(feature, input)
    : buildSeriesFeature(feature, input);
}

export function buildResearchFeatureVector(
  input: BuildResearchFeatureVectorInput
): ResearchFeatureVector {
  validateBoundary(input);
  validateDerivedContext(input);
  const features = input.definitions.map(defineResearchFeature).sort((left, right) =>
    left.featureId.localeCompare(right.featureId)
      || left.version.localeCompare(right.version)
      || left.semanticIdentity.localeCompare(right.semanticIdentity)
  );
  const identities = new Set<string>();
  const idVersions = new Set<string>();
  for (const feature of features) {
    if (identities.has(feature.semanticIdentity)) fail(`duplicate feature identity ${feature.featureId}@${feature.version}.`);
    identities.add(feature.semanticIdentity);
    const idVersion = `${feature.featureId}@${feature.version}`;
    if (idVersions.has(idVersion)) fail(`incompatible duplicate feature ${idVersion}.`);
    idVersions.add(idVersion);
  }
  const values = Object.freeze(features.map((feature) => featureValue(feature, input)));
  const specificationIdentity = canonicalJson(features.map((feature) => feature.semanticIdentity));
  const semanticIdentity = canonicalJson({
    schemaVersion: RESEARCH_FEATURE_SCHEMA_VERSION,
    assetId: input.assetId,
    decisionTime: input.decisionTime,
    asOf: input.asOf,
    specificationIdentity,
    features: values.map((feature) => ({
      semanticIdentity: feature.semanticIdentity,
      status: feature.status,
      reasonCode: feature.reasonCode,
      value: feature.value,
      provenance: feature.provenance,
    })),
  });
  return deepFreeze({
    schemaVersion: RESEARCH_FEATURE_SCHEMA_VERSION,
    intendedUse: "RESEARCH_ONLY" as const,
    assetId: input.assetId,
    decisionTime: input.decisionTime,
    asOf: input.asOf,
    specificationIdentity,
    semanticIdentity,
    features: values,
    predictiveValidityEstablished: false as const,
    approvedForPaperAction: false as const,
    grantsExecutionAuthority: false as const,
    priceAuthority: "NONE" as const,
  });
}
