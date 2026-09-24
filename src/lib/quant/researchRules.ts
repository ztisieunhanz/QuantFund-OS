// ============================================================================
// FILE: src/lib/quant/researchRules.ts
// MODULE: STATELESS RESEARCH RULE CONTRACT + COMBINATORS (M13C / C-B)
//
// ResearchRule produces audit evidence only. It has no permission, sizing,
// allocation, execution, accounting, or ActionDecision authority.
// ============================================================================

import type { DerivedResearchBar, DerivedTimeframeContext } from "./derivedTimeframeContext";
import type {
  HistoricalEventRecord,
  HistoricalMacroRelease,
  HistoricalMarketObservation,
} from "./historicalPit";
import { RESEARCH_SERIES_SPECS, type ResearchSeriesId } from "./researchDataProtocol";
import { BAR_DURATION_MS } from "./timeDomain";
import type { AssetId, PointInTimeBar } from "./types";

export type ResearchRuleStatus = "MATCH" | "NO_MATCH" | "INSUFFICIENT_EVIDENCE";
export type ResearchTimeframe = "1H" | "4H" | "1D";
export type ResearchSeriesEvidence =
  | HistoricalMarketObservation
  | HistoricalMacroRelease
  | HistoricalEventRecord;

export type ResearchParameterValue =
  | string
  | number
  | boolean
  | null
  | readonly ResearchParameterValue[]
  | Readonly<{ [key: string]: ResearchParameterValue }>;

export type ResearchRuleParameters = Readonly<Record<string, ResearchParameterValue>>;

export type ResearchDependency =
  | Readonly<{ kind: "SERIES"; seriesId: ResearchSeriesId }>
  | Readonly<{ kind: "TIMEFRAME"; timeframe: ResearchTimeframe }>;

export interface ResearchEvidenceReason {
  readonly code: string;
  readonly message: string;
}

export interface ResearchDependencyAvailability {
  readonly dependency: ResearchDependency;
  readonly status: "AVAILABLE" | "UNAVAILABLE";
  readonly reasonCode: "AVAILABLE" | "DECLARED_DEPENDENCY_UNAVAILABLE";
}

/** Caller-owned, already PIT-eligible research context. */
export interface ResearchEvaluationContext {
  readonly decisionTime: number;
  readonly asOf: number;
  readonly assetId: AssetId;
  readonly series?: Readonly<Partial<Record<ResearchSeriesId, ResearchSeriesEvidence>>>;
  readonly oneHourBars?: readonly PointInTimeBar[];
  readonly derivedTimeframes?: DerivedTimeframeContext;
}

/** A leaf evaluator receives only inputs that it explicitly declared. */
export interface DeclaredResearchInputs {
  readonly decisionTime: number;
  readonly asOf: number;
  readonly assetId: AssetId;
  readonly series: Readonly<Partial<Record<ResearchSeriesId, ResearchSeriesEvidence>>>;
  readonly oneHourBars: readonly PointInTimeBar[] | null;
  readonly fourHourBars: readonly DerivedResearchBar[] | null;
  readonly oneDayBars: readonly DerivedResearchBar[] | null;
}

export interface ResearchRuleDecision {
  readonly status: ResearchRuleStatus;
  readonly reasons: readonly ResearchEvidenceReason[];
  readonly metadata?: ResearchRuleParameters;
}

export interface ResearchRuleResult {
  readonly kind: "RESEARCH_EVIDENCE";
  readonly ruleId: string;
  readonly version: string;
  readonly semanticIdentity: string;
  readonly status: ResearchRuleStatus;
  readonly decisionTime: number;
  readonly evaluatedAt: number;
  readonly asOf: number;
  readonly assetId: AssetId;
  readonly reasons: readonly ResearchEvidenceReason[];
  readonly dependencyAvailability: readonly ResearchDependencyAvailability[];
  readonly childResults: readonly ResearchRuleResult[];
  readonly metadata: ResearchRuleParameters;
  readonly predictiveValidityAssessed: false;
  readonly grantsExecutionAuthority: false;
}

export interface ResearchRule<P extends ResearchRuleParameters = ResearchRuleParameters> {
  readonly ruleId: string;
  readonly version: string;
  readonly description: string;
  readonly rationale: string;
  readonly dependencies: readonly ResearchDependency[];
  readonly parameters: P;
  readonly semanticIdentity: string;
  evaluate(context: ResearchEvaluationContext): ResearchRuleResult;
}

export interface ResearchRuleDefinition<P extends ResearchRuleParameters> {
  readonly ruleId: string;
  readonly version: string;
  readonly description: string;
  readonly rationale: string;
  readonly dependencies: readonly ResearchDependency[];
  readonly parameters: P;
  readonly evaluate: (inputs: DeclaredResearchInputs, parameters: P) => ResearchRuleDecision;
}

export interface ResearchCombinatorDefinition {
  readonly ruleId: string;
  readonly version: string;
  readonly description: string;
  readonly rationale: string;
}

export class ResearchRuleValidationError extends Error {
  constructor(message: string) {
    super(`[ResearchRule] ${message}`);
    this.name = "ResearchRuleValidationError";
  }
}

function fail(message: string): never {
  throw new ResearchRuleValidationError(message);
}

function requireText(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) fail(`${field} must be a non-empty string.`);
}

function deepFreeze<T>(value: T): T {
  if ((typeof value === "object" || typeof value === "function") && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function normalizeParameterValue(value: unknown, path: string, seen: WeakSet<object>): ResearchParameterValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(`${path} must contain only finite numbers.`);
    return value;
  }
  if (typeof value !== "object") fail(`${path} must be deterministic JSON data.`);
  if (seen.has(value)) fail(`${path} must not contain cycles.`);
  seen.add(value);
  if (Array.isArray(value)) {
    const normalized = value.map((item, index) => normalizeParameterValue(item, `${path}[${index}]`, seen));
    seen.delete(value);
    return Object.freeze(normalized);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`${path} must contain only plain objects.`);
  const normalized: Record<string, ResearchParameterValue> = {};
  for (const key of Object.keys(value).sort()) {
    normalized[key] = normalizeParameterValue((value as Record<string, unknown>)[key], `${path}.${key}`, seen);
  }
  seen.delete(value);
  return Object.freeze(normalized);
}

function normalizeParameters<P extends ResearchRuleParameters>(parameters: P): P {
  return normalizeParameterValue(parameters, "parameters", new WeakSet()) as P;
}

function canonicalJson(value: ResearchParameterValue): string {
  return JSON.stringify(value);
}

function dependencyKey(dependency: ResearchDependency): string {
  return dependency.kind === "SERIES"
    ? `SERIES:${dependency.seriesId}`
    : `TIMEFRAME:${dependency.timeframe}`;
}

function normalizeDependencies(dependencies: readonly ResearchDependency[]): readonly ResearchDependency[] {
  const byKey = new Map<string, ResearchDependency>();
  for (const dependency of dependencies) {
    if (dependency.kind === "SERIES") {
      if (!(dependency.seriesId in RESEARCH_SERIES_SPECS)) fail(`Unsupported series dependency ${dependency.seriesId}.`);
    } else if (!(["1H", "4H", "1D"] as const).includes(dependency.timeframe)) {
      fail(`Unsupported timeframe dependency ${String(dependency.timeframe)}.`);
    }
    const key = dependencyKey(dependency);
    if (byKey.has(key)) fail(`Duplicate dependency ${key}.`);
    byKey.set(key, Object.freeze({ ...dependency }));
  }
  return Object.freeze([...byKey.values()].sort((left, right) => dependencyKey(left).localeCompare(dependencyKey(right))));
}

function semanticIdentity(
  ruleId: string,
  version: string,
  dependencies: readonly ResearchDependency[],
  parameters: ResearchRuleParameters
): string {
  return canonicalJson(normalizeParameterValue({
    ruleId,
    version,
    dependencies: dependencies.map(dependencyKey),
    parameters,
  }, "identity", new WeakSet()));
}

function validateContext(context: ResearchEvaluationContext): void {
  if (!Number.isSafeInteger(context.decisionTime) || context.decisionTime < 0) {
    fail("decisionTime must be a non-negative safe-integer epoch millisecond.");
  }
  if (context.asOf !== context.decisionTime) fail("asOf must equal decisionTime for a PIT evaluation context.");
  requireText(context.assetId, "assetId");

  for (const [key, evidence] of Object.entries(context.series ?? {})) {
    if (!(key in RESEARCH_SERIES_SPECS)) fail(`Context contains unsupported research series ${key}.`);
    if (!evidence || !Number.isFinite(evidence.availableAt) || evidence.availableAt > context.decisionTime) {
      fail(`Series ${key} is not PIT-eligible at decisionTime.`);
    }
    const expectedKind = RESEARCH_SERIES_SPECS[key as ResearchSeriesId].kind;
    const actualKind = "eventId" in evidence
      ? "OFFICIAL_EVENT"
      : "revisionIndex" in evidence ? "MACRO_RELEASE" : "MARKET_FACTOR";
    if (actualKind !== expectedKind) fail(`Series ${key} evidence kind must be ${expectedKind}, received ${actualKind}.`);
    if ("seriesId" in evidence && evidence.seriesId !== key) {
      fail(`Series evidence key ${key} conflicts with record seriesId ${evidence.seriesId}.`);
    }
    if (key === "FOMC_RATE_DECISION" && "eventType" in evidence
      && evidence.eventType !== "FED_RATE_DECISION" && evidence.eventType !== "FOMC_STATEMENT") {
      fail("FOMC_RATE_DECISION evidence has an incompatible eventType.");
    }
  }

  const seenTimestamps = new Set<number>();
  for (const bar of context.oneHourBars ?? []) {
    if (!Number.isSafeInteger(bar.timestamp) || bar.timestamp < 0 || bar.timestamp + BAR_DURATION_MS > context.decisionTime) {
      fail(`1H bar at ${bar.timestamp} is not PIT-eligible at decisionTime.`);
    }
    if (bar.timestamp % BAR_DURATION_MS !== 0
      || ![bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite)
      || bar.open <= 0 || bar.high <= 0 || bar.low <= 0 || bar.close <= 0 || bar.volume < 0
      || bar.high < Math.max(bar.open, bar.low, bar.close)
      || bar.low > Math.min(bar.open, bar.high, bar.close)) {
      fail(`1H bar at ${bar.timestamp} is invalid.`);
    }
    if (seenTimestamps.has(bar.timestamp)) fail(`Duplicate 1H context timestamp ${bar.timestamp}.`);
    seenTimestamps.add(bar.timestamp);
  }

  if (context.derivedTimeframes) {
    const derived = context.derivedTimeframes;
    if (derived.intendedUse !== "RESEARCH_CONTEXT_ONLY"
      || derived.grantsExecutionAuthority !== false
      || derived.priceAuthority !== "NONE") {
      fail("Derived timeframe context claims incompatible authority.");
    }
    if (derived.assetId !== context.assetId) fail("Derived timeframe assetId conflicts with evaluation assetId.");
    if (derived.decisionTime !== context.decisionTime || derived.asOf !== context.asOf) {
      fail("Derived timeframe context does not share the evaluation PIT boundary.");
    }
    for (const [expectedTimeframe, bars] of [["4H", derived.completed4hBars], ["1D", derived.completed1dBars]] as const) {
      for (const bar of bars) {
        if (bar.timeframe !== expectedTimeframe || bar.assetId !== context.assetId || bar.availableAt > context.decisionTime) {
          fail("Derived timeframe context contains ineligible, mislabeled, or cross-asset evidence.");
        }
      }
    }
  }
}

function availabilityFor(
  dependency: ResearchDependency,
  context: ResearchEvaluationContext
): ResearchDependencyAvailability {
  let available: boolean;
  if (dependency.kind === "SERIES") {
    available = context.series?.[dependency.seriesId] !== undefined;
  } else if (dependency.timeframe === "1H") {
    available = (context.oneHourBars?.length ?? 0) > 0;
  } else if (dependency.timeframe === "4H") {
    available = (context.derivedTimeframes?.completed4hBars.length ?? 0) > 0;
  } else {
    available = (context.derivedTimeframes?.completed1dBars.length ?? 0) > 0;
  }
  return Object.freeze({
    dependency,
    status: available ? "AVAILABLE" : "UNAVAILABLE",
    reasonCode: available ? "AVAILABLE" : "DECLARED_DEPENDENCY_UNAVAILABLE",
  });
}

function cloneBar<T extends PointInTimeBar | DerivedResearchBar>(bar: T): T {
  return Object.freeze({ ...bar }) as unknown as T;
}

function declaredInputs(
  dependencies: readonly ResearchDependency[],
  context: ResearchEvaluationContext
): DeclaredResearchInputs {
  const series: Partial<Record<ResearchSeriesId, ResearchSeriesEvidence>> = {};
  let oneHourBars: readonly PointInTimeBar[] | null = null;
  let fourHourBars: readonly DerivedResearchBar[] | null = null;
  let oneDayBars: readonly DerivedResearchBar[] | null = null;

  for (const dependency of dependencies) {
    if (dependency.kind === "SERIES") {
      const evidence = context.series?.[dependency.seriesId];
      if (evidence) series[dependency.seriesId] = Object.freeze({ ...evidence });
    } else if (dependency.timeframe === "1H") {
      oneHourBars = Object.freeze((context.oneHourBars ?? []).map(cloneBar));
    } else if (dependency.timeframe === "4H") {
      fourHourBars = Object.freeze((context.derivedTimeframes?.completed4hBars ?? []).map(cloneBar));
    } else {
      oneDayBars = Object.freeze((context.derivedTimeframes?.completed1dBars ?? []).map(cloneBar));
    }
  }

  return Object.freeze({
    decisionTime: context.decisionTime,
    asOf: context.asOf,
    assetId: context.assetId,
    series: Object.freeze(series),
    oneHourBars,
    fourHourBars,
    oneDayBars,
  });
}

function validateDecision(decision: ResearchRuleDecision): ResearchRuleDecision {
  if (!["MATCH", "NO_MATCH", "INSUFFICIENT_EVIDENCE"].includes(decision.status)) {
    fail(`Evaluator returned unsupported status ${String(decision.status)}.`);
  }
  if (!Array.isArray(decision.reasons) || decision.reasons.length === 0) {
    fail("Evaluator must return at least one structured reason.");
  }
  const reasons = decision.reasons.map((reason, index) => {
    requireText(reason.code, `reasons[${index}].code`);
    requireText(reason.message, `reasons[${index}].message`);
    return Object.freeze({ ...reason });
  });
  return Object.freeze({
    status: decision.status,
    reasons: Object.freeze(reasons),
    metadata: normalizeParameters(decision.metadata ?? {}),
  });
}

function makeResult(
  rule: Pick<ResearchRule, "ruleId" | "version" | "semanticIdentity">,
  context: ResearchEvaluationContext,
  status: ResearchRuleStatus,
  reasons: readonly ResearchEvidenceReason[],
  dependencyAvailability: readonly ResearchDependencyAvailability[],
  childResults: readonly ResearchRuleResult[],
  metadata: ResearchRuleParameters = {}
): ResearchRuleResult {
  return deepFreeze({
    kind: "RESEARCH_EVIDENCE" as const,
    ruleId: rule.ruleId,
    version: rule.version,
    semanticIdentity: rule.semanticIdentity,
    status,
    decisionTime: context.decisionTime,
    evaluatedAt: context.decisionTime,
    asOf: context.asOf,
    assetId: context.assetId,
    reasons: [...reasons],
    dependencyAvailability: [...dependencyAvailability],
    childResults: [...childResults],
    metadata: normalizeParameters(metadata),
    predictiveValidityAssessed: false as const,
    grantsExecutionAuthority: false as const,
  });
}

export function createResearchRule<P extends ResearchRuleParameters>(
  definition: ResearchRuleDefinition<P>
): ResearchRule<P> {
  requireText(definition.ruleId, "ruleId");
  requireText(definition.version, "version");
  requireText(definition.description, "description");
  requireText(definition.rationale, "rationale");
  const dependencies = normalizeDependencies(definition.dependencies);
  const parameters = normalizeParameters(definition.parameters);
  const identity = semanticIdentity(definition.ruleId, definition.version, dependencies, parameters);

  const rule: ResearchRule<P> = {
    ruleId: definition.ruleId,
    version: definition.version,
    description: definition.description,
    rationale: definition.rationale,
    dependencies,
    parameters,
    semanticIdentity: identity,
    evaluate(context): ResearchRuleResult {
      validateContext(context);
      const availability = Object.freeze(dependencies.map((dependency) => availabilityFor(dependency, context)));
      const missing = availability.filter((item) => item.status === "UNAVAILABLE");
      if (missing.length > 0) {
        return makeResult(rule, context, "INSUFFICIENT_EVIDENCE", missing.map((item) => ({
          code: item.reasonCode,
          message: `${dependencyKey(item.dependency)} was declared but is unavailable.`,
        })), availability, []);
      }
      const decision = validateDecision(definition.evaluate(declaredInputs(dependencies, context), parameters));
      return makeResult(rule, context, decision.status, decision.reasons, availability, [], decision.metadata);
    },
  };
  return Object.freeze(rule);
}

function combinedDependencies(children: readonly ResearchRule[]): readonly ResearchDependency[] {
  const byKey = new Map<string, ResearchDependency>();
  for (const child of children) {
    for (const dependency of child.dependencies) byKey.set(dependencyKey(dependency), dependency);
  }
  return Object.freeze([...byKey.values()].sort((left, right) => dependencyKey(left).localeCompare(dependencyKey(right))));
}

function combinedAvailability(results: readonly ResearchRuleResult[]): readonly ResearchDependencyAvailability[] {
  const byKey = new Map<string, ResearchDependencyAvailability>();
  for (const result of results) {
    for (const item of result.dependencyAvailability) {
      const key = dependencyKey(item.dependency);
      const prior = byKey.get(key);
      if (!prior || item.status === "UNAVAILABLE") byKey.set(key, item);
    }
  }
  return Object.freeze([...byKey.values()].sort((left, right) => dependencyKey(left.dependency).localeCompare(dependencyKey(right.dependency))));
}

function createCombinator(
  operator: "AND" | "OR",
  definition: ResearchCombinatorDefinition,
  children: readonly ResearchRule[]
): ResearchRule {
  requireText(definition.ruleId, "ruleId");
  requireText(definition.version, "version");
  requireText(definition.description, "description");
  requireText(definition.rationale, "rationale");
  if (children.length === 0) fail(`${operator} requires at least one child rule.`);
  const dependencies = combinedDependencies(children);
  const parameters = normalizeParameters({ operator, children: children.map((child) => child.semanticIdentity) });
  const identity = semanticIdentity(definition.ruleId, definition.version, dependencies, parameters);
  const rule: ResearchRule = {
    ...definition,
    dependencies,
    parameters,
    semanticIdentity: identity,
    evaluate(context): ResearchRuleResult {
      validateContext(context);
      const childResults = Object.freeze(children.map((child) => child.evaluate(context)));
      const statuses = childResults.map((result) => result.status);
      const status: ResearchRuleStatus = operator === "AND"
        ? statuses.includes("NO_MATCH")
          ? "NO_MATCH"
          : statuses.every((item) => item === "MATCH") ? "MATCH" : "INSUFFICIENT_EVIDENCE"
        : statuses.includes("MATCH")
          ? "MATCH"
          : statuses.every((item) => item === "NO_MATCH") ? "NO_MATCH" : "INSUFFICIENT_EVIDENCE";
      return makeResult(rule, context, status, [{
        code: `${operator}_${status}`,
        message: `${operator} evaluated child statuses: ${statuses.join(", ")}.`,
      }], combinedAvailability(childResults), childResults, { operator });
    },
  };
  return Object.freeze(rule);
}

export function andResearchRules(
  definition: ResearchCombinatorDefinition,
  children: readonly ResearchRule[]
): ResearchRule {
  return createCombinator("AND", definition, children);
}

export function orResearchRules(
  definition: ResearchCombinatorDefinition,
  children: readonly ResearchRule[]
): ResearchRule {
  return createCombinator("OR", definition, children);
}

export function notResearchRule(
  definition: ResearchCombinatorDefinition,
  child: ResearchRule
): ResearchRule {
  requireText(definition.ruleId, "ruleId");
  requireText(definition.version, "version");
  requireText(definition.description, "description");
  requireText(definition.rationale, "rationale");
  const parameters = normalizeParameters({ operator: "NOT", child: child.semanticIdentity });
  const identity = semanticIdentity(definition.ruleId, definition.version, child.dependencies, parameters);
  const rule: ResearchRule = {
    ...definition,
    dependencies: child.dependencies,
    parameters,
    semanticIdentity: identity,
    evaluate(context): ResearchRuleResult {
      validateContext(context);
      const childResult = child.evaluate(context);
      const status: ResearchRuleStatus = childResult.status === "MATCH"
        ? "NO_MATCH"
        : childResult.status === "NO_MATCH" ? "MATCH" : "INSUFFICIENT_EVIDENCE";
      return makeResult(rule, context, status, [{
        code: `NOT_${status}`,
        message: `NOT evaluated child status: ${childResult.status}.`,
      }], childResult.dependencyAvailability, [childResult], { operator: "NOT" });
    },
  };
  return Object.freeze(rule);
}
