// ============================================================================
// FILE: src/lib/quant/statefulResearchRules.ts
// MODULE: PIT-SAFE STATEFUL RESEARCH RULES (M13C / C-C)
//
// State is explicit, immutable, asset-scoped research evaluation state only.
// This module has no permission, sizing, execution, or accounting authority.
// ============================================================================

import type { AssetId } from "./types";
import type {
  ResearchDependency,
  ResearchEvaluationContext,
  ResearchRule,
  ResearchRuleResult,
  ResearchRuleStatus,
} from "./researchRules";

export type StatefulResearchEvent =
  | "WAITING_FOR_A"
  | "ACTIVATED"
  | "WAITING_FOR_B"
  | "COMPLETED"
  | "EXPIRED"
  | "STREAK_ADVANCED"
  | "STREAK_RESET"
  | "INSUFFICIENT_EVIDENCE";

export interface StatefulRuleDefinition {
  readonly ruleId: string;
  readonly version: string;
  readonly description: string;
  readonly rationale: string;
}

interface StatefulResearchStateBase {
  readonly ruleSemanticIdentity: string;
  readonly assetId: AssetId;
  readonly lastDecisionTime: number | null;
}

export interface OrderedSequenceState extends StatefulResearchStateBase {
  readonly kind: "ORDERED_SEQUENCE_STATE";
  readonly phase: "WAITING_FOR_A" | "WAITING_FOR_B";
  readonly activatedAt: number | null;
  readonly eligibleObservationsSinceActivation: number;
  readonly activationEvidence: ResearchRuleResult | null;
}

export interface PersistenceState extends StatefulResearchStateBase {
  readonly kind: "PERSISTENCE_STATE";
  readonly streak: number;
  readonly streakStartedAt: number | null;
  readonly streakStartEvidence: ResearchRuleResult | null;
  readonly lastMatchEvidence: ResearchRuleResult | null;
}

export type StatefulResearchState = OrderedSequenceState | PersistenceState;

export interface StatefulResearchTransition<S extends StatefulResearchState> {
  readonly kind: "RESEARCH_STATE_TRANSITION";
  readonly ruleId: string;
  readonly version: string;
  readonly semanticIdentity: string;
  readonly decisionTime: number;
  readonly asOf: number;
  readonly assetId: AssetId;
  readonly status: ResearchRuleStatus;
  readonly event: StatefulResearchEvent;
  readonly reasons: readonly Readonly<{ code: string; message: string }>[];
  readonly childResults: readonly ResearchRuleResult[];
  readonly previousState: S;
  readonly nextState: S;
  readonly predictiveValidityAssessed: false;
  readonly grantsExecutionAuthority: false;
}

export interface StatefulResearchRule<S extends StatefulResearchState> {
  readonly ruleId: string;
  readonly version: string;
  readonly description: string;
  readonly rationale: string;
  readonly dependencies: readonly ResearchDependency[];
  readonly semanticIdentity: string;
  createInitialState(assetId: AssetId): S;
  transition(state: S, context: ResearchEvaluationContext): StatefulResearchTransition<S>;
}

export interface OrderedSequenceDefinition extends StatefulRuleDefinition {
  readonly first: ResearchRule;
  readonly then: ResearchRule;
  readonly windowObservations: number;
}

export interface PersistenceDefinition extends StatefulRuleDefinition {
  readonly condition: ResearchRule;
  readonly requiredConsecutive: number;
}

export interface StatefulReplayResult<S extends StatefulResearchState> {
  readonly transitions: readonly StatefulResearchTransition<S>[];
  readonly finalState: S;
}

export class StatefulResearchRuleValidationError extends Error {
  constructor(message: string) {
    super(`[StatefulResearchRule] ${message}`);
    this.name = "StatefulResearchRuleValidationError";
  }
}

function fail(message: string): never {
  throw new StatefulResearchRuleValidationError(message);
}

function requireText(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) fail(`${field} must be a non-empty string.`);
}

function requirePositiveCount(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${field} must be a positive safe integer.`);
}

function dependencyKey(dependency: ResearchDependency): string {
  return dependency.kind === "SERIES"
    ? `SERIES:${dependency.seriesId}`
    : `TIMEFRAME:${dependency.timeframe}`;
}

function combineDependencies(rules: readonly ResearchRule[]): readonly ResearchDependency[] {
  const dependencies = new Map<string, ResearchDependency>();
  for (const rule of rules) {
    for (const dependency of rule.dependencies) dependencies.set(dependencyKey(dependency), dependency);
  }
  return Object.freeze(
    [...dependencies.values()].sort((left, right) => dependencyKey(left).localeCompare(dependencyKey(right)))
  );
}

function contextForRule(
  context: ResearchEvaluationContext,
  child: ResearchRule
): ResearchEvaluationContext {
  const seriesEntries = child.dependencies
    .filter((dependency) => dependency.kind === "SERIES")
    .flatMap((dependency) => {
      const evidence = context.series?.[dependency.seriesId];
      return evidence === undefined ? [] : [[dependency.seriesId, evidence] as const];
    });
  const needs1h = child.dependencies.some(
    (dependency) => dependency.kind === "TIMEFRAME" && dependency.timeframe === "1H"
  );
  const needs4h = child.dependencies.some(
    (dependency) => dependency.kind === "TIMEFRAME" && dependency.timeframe === "4H"
  );
  const needs1d = child.dependencies.some(
    (dependency) => dependency.kind === "TIMEFRAME" && dependency.timeframe === "1D"
  );
  const derived = context.derivedTimeframes && (needs4h || needs1d)
    ? Object.freeze({
        ...context.derivedTimeframes,
        completed4hBars: needs4h ? context.derivedTimeframes.completed4hBars : Object.freeze([]),
        completed1dBars: needs1d ? context.derivedTimeframes.completed1dBars : Object.freeze([]),
        latestCompleted4hBar: needs4h ? context.derivedTimeframes.latestCompleted4hBar : null,
        latestCompleted1dBar: needs1d ? context.derivedTimeframes.latestCompleted1dBar : null,
      })
    : undefined;
  return Object.freeze({
    decisionTime: context.decisionTime,
    asOf: context.asOf,
    assetId: context.assetId,
    series: Object.freeze(Object.fromEntries(seriesEntries)),
    oneHourBars: needs1h ? context.oneHourBars : undefined,
    derivedTimeframes: derived,
  });
}

function makeSemanticIdentity(
  definition: StatefulRuleDefinition,
  primitive: "A_THEN_B" | "PERSISTENCE",
  children: readonly ResearchRule[],
  parameterName: "windowObservations" | "requiredConsecutive",
  parameterValue: number
): string {
  return JSON.stringify({
    ruleId: definition.ruleId,
    version: definition.version,
    primitive,
    children: children.map((child) => child.semanticIdentity),
    parameters: { [parameterName]: parameterValue },
  });
}

function freezeState<S extends StatefulResearchState>(state: S): S {
  return Object.freeze(state);
}

function validateState(
  state: StatefulResearchState,
  expectedKind: StatefulResearchState["kind"],
  semanticIdentity: string,
  context: ResearchEvaluationContext
): void {
  if (!state || state.kind !== expectedKind) fail(`Expected ${expectedKind}.`);
  if (state.ruleSemanticIdentity !== semanticIdentity) fail("State belongs to an incompatible rule identity.");
  if (state.assetId !== context.assetId) fail("State assetId does not match evaluation assetId.");
  if (state.lastDecisionTime !== null) {
    if (!Number.isSafeInteger(state.lastDecisionTime) || state.lastDecisionTime < 0) {
      fail("State lastDecisionTime is invalid.");
    }
    if (context.decisionTime <= state.lastDecisionTime) {
      fail("decisionTime must be strictly greater than the last accepted observation time.");
    }
  }
}

function makeTransition<S extends StatefulResearchState>(
  rule: Pick<StatefulResearchRule<S>, "ruleId" | "version" | "semanticIdentity">,
  context: ResearchEvaluationContext,
  status: ResearchRuleStatus,
  event: StatefulResearchEvent,
  reason: Readonly<{ code: string; message: string }>,
  childResults: readonly ResearchRuleResult[],
  previousState: S,
  nextState: S
): StatefulResearchTransition<S> {
  return Object.freeze({
    kind: "RESEARCH_STATE_TRANSITION" as const,
    ruleId: rule.ruleId,
    version: rule.version,
    semanticIdentity: rule.semanticIdentity,
    decisionTime: context.decisionTime,
    asOf: context.asOf,
    assetId: context.assetId,
    status,
    event,
    reasons: Object.freeze([Object.freeze({ ...reason })]),
    childResults: Object.freeze([...childResults]),
    previousState,
    nextState,
    predictiveValidityAssessed: false as const,
    grantsExecutionAuthority: false as const,
  });
}

export function createOrderedSequenceRule(
  definition: OrderedSequenceDefinition
): StatefulResearchRule<OrderedSequenceState> {
  requireText(definition.ruleId, "ruleId");
  requireText(definition.version, "version");
  requireText(definition.description, "description");
  requireText(definition.rationale, "rationale");
  requirePositiveCount(definition.windowObservations, "windowObservations");

  const dependencies = combineDependencies([definition.first, definition.then]);
  const identity = makeSemanticIdentity(
    definition,
    "A_THEN_B",
    [definition.first, definition.then],
    "windowObservations",
    definition.windowObservations
  );

  const rule: StatefulResearchRule<OrderedSequenceState> = {
    ruleId: definition.ruleId,
    version: definition.version,
    description: definition.description,
    rationale: definition.rationale,
    dependencies,
    semanticIdentity: identity,
    createInitialState(assetId): OrderedSequenceState {
      requireText(assetId, "assetId");
      return freezeState({
        kind: "ORDERED_SEQUENCE_STATE",
        ruleSemanticIdentity: identity,
        assetId,
        lastDecisionTime: null,
        phase: "WAITING_FOR_A",
        activatedAt: null,
        eligibleObservationsSinceActivation: 0,
        activationEvidence: null,
      });
    },
    transition(state, context): StatefulResearchTransition<OrderedSequenceState> {
      validateState(state, "ORDERED_SEQUENCE_STATE", identity, context);

      if (state.phase === "WAITING_FOR_A") {
        const firstResult = definition.first.evaluate(contextForRule(context, definition.first));
        const childResults = [firstResult] as const;
        if (firstResult.status === "INSUFFICIENT_EVIDENCE") {
          const nextState = freezeState({ ...state, lastDecisionTime: context.decisionTime });
          return makeTransition(rule, context, "INSUFFICIENT_EVIDENCE", "INSUFFICIENT_EVIDENCE", {
            code: "SEQUENCE_A_INSUFFICIENT",
            message: "A lacked sufficient evidence; the sequence did not activate.",
          }, childResults, state, nextState);
        }
        if (firstResult.status === "MATCH") {
          const nextState = freezeState({
            ...state,
            lastDecisionTime: context.decisionTime,
            phase: "WAITING_FOR_B" as const,
            activatedAt: context.decisionTime,
            eligibleObservationsSinceActivation: 0,
            activationEvidence: firstResult,
          });
          return makeTransition(rule, context, "NO_MATCH", "ACTIVATED", {
            code: "SEQUENCE_A_ACTIVATED",
            message: "A matched; B is eligible only at a later decisionTime.",
          }, childResults, state, nextState);
        }
        const nextState = freezeState({ ...state, lastDecisionTime: context.decisionTime });
        return makeTransition(rule, context, "NO_MATCH", "WAITING_FOR_A", {
          code: "SEQUENCE_WAITING_FOR_A",
          message: "A did not match; the sequence remains inactive.",
        }, childResults, state, nextState);
      }

      const thenResult = definition.then.evaluate(contextForRule(context, definition.then));
      const childResults = [thenResult] as const;
      if (thenResult.status === "INSUFFICIENT_EVIDENCE") {
        const nextState = freezeState({ ...state, lastDecisionTime: context.decisionTime });
        return makeTransition(rule, context, "INSUFFICIENT_EVIDENCE", "INSUFFICIENT_EVIDENCE", {
          code: "SEQUENCE_B_INSUFFICIENT",
          message: "B lacked sufficient evidence; the observation window did not advance.",
        }, childResults, state, nextState);
      }

      const observationNumber = state.eligibleObservationsSinceActivation + 1;
      if (thenResult.status === "MATCH") {
        const nextState = freezeState({
          ...rule.createInitialState(state.assetId),
          lastDecisionTime: context.decisionTime,
        });
        return makeTransition(rule, context, "MATCH", "COMPLETED", {
          code: "SEQUENCE_COMPLETED",
          message: `B matched on eligible observation ${observationNumber} of ${definition.windowObservations}.`,
        }, childResults, state, nextState);
      }

      if (observationNumber >= definition.windowObservations) {
        const nextState = freezeState({
          ...rule.createInitialState(state.assetId),
          lastDecisionTime: context.decisionTime,
        });
        return makeTransition(rule, context, "NO_MATCH", "EXPIRED", {
          code: "SEQUENCE_EXPIRED",
          message: `B did not match within ${definition.windowObservations} eligible observations.`,
        }, childResults, state, nextState);
      }

      const nextState = freezeState({
        ...state,
        lastDecisionTime: context.decisionTime,
        eligibleObservationsSinceActivation: observationNumber,
      });
      return makeTransition(rule, context, "NO_MATCH", "WAITING_FOR_B", {
        code: "SEQUENCE_WAITING_FOR_B",
        message: `B did not match on eligible observation ${observationNumber} of ${definition.windowObservations}.`,
      }, childResults, state, nextState);
    },
  };
  return Object.freeze(rule);
}

export function createPersistenceRule(
  definition: PersistenceDefinition
): StatefulResearchRule<PersistenceState> {
  requireText(definition.ruleId, "ruleId");
  requireText(definition.version, "version");
  requireText(definition.description, "description");
  requireText(definition.rationale, "rationale");
  requirePositiveCount(definition.requiredConsecutive, "requiredConsecutive");

  const dependencies = combineDependencies([definition.condition]);
  const identity = makeSemanticIdentity(
    definition,
    "PERSISTENCE",
    [definition.condition],
    "requiredConsecutive",
    definition.requiredConsecutive
  );

  const rule: StatefulResearchRule<PersistenceState> = {
    ruleId: definition.ruleId,
    version: definition.version,
    description: definition.description,
    rationale: definition.rationale,
    dependencies,
    semanticIdentity: identity,
    createInitialState(assetId): PersistenceState {
      requireText(assetId, "assetId");
      return freezeState({
        kind: "PERSISTENCE_STATE",
        ruleSemanticIdentity: identity,
        assetId,
        lastDecisionTime: null,
        streak: 0,
        streakStartedAt: null,
        streakStartEvidence: null,
        lastMatchEvidence: null,
      });
    },
    transition(state, context): StatefulResearchTransition<PersistenceState> {
      validateState(state, "PERSISTENCE_STATE", identity, context);
      const result = definition.condition.evaluate(context);
      const childResults = [result] as const;

      if (result.status === "INSUFFICIENT_EVIDENCE") {
        const nextState = freezeState({
          ...rule.createInitialState(state.assetId),
          lastDecisionTime: context.decisionTime,
        });
        return makeTransition(rule, context, "INSUFFICIENT_EVIDENCE", "INSUFFICIENT_EVIDENCE", {
          code: "PERSISTENCE_INSUFFICIENT_RESET",
          message: "Insufficient evidence reset the streak; missing evidence cannot establish continuity.",
        }, childResults, state, nextState);
      }

      if (result.status === "NO_MATCH") {
        const nextState = freezeState({
          ...rule.createInitialState(state.assetId),
          lastDecisionTime: context.decisionTime,
        });
        return makeTransition(rule, context, "NO_MATCH", "STREAK_RESET", {
          code: "PERSISTENCE_NO_MATCH_RESET",
          message: "A determinate NO_MATCH reset the persistence streak.",
        }, childResults, state, nextState);
      }

      const streak = state.streak + 1;
      if (streak >= definition.requiredConsecutive) {
        const nextState = freezeState({
          ...rule.createInitialState(state.assetId),
          lastDecisionTime: context.decisionTime,
        });
        return makeTransition(rule, context, "MATCH", "COMPLETED", {
          code: "PERSISTENCE_COMPLETED",
          message: `Condition matched for ${definition.requiredConsecutive} consecutive eligible evaluations.`,
        }, childResults, state, nextState);
      }

      const nextState = freezeState({
        ...state,
        lastDecisionTime: context.decisionTime,
        streak,
        streakStartedAt: state.streakStartedAt ?? context.decisionTime,
        streakStartEvidence: state.streakStartEvidence ?? result,
        lastMatchEvidence: result,
      });
      return makeTransition(rule, context, "NO_MATCH", "STREAK_ADVANCED", {
        code: "PERSISTENCE_STREAK_ADVANCED",
        message: `Persistence streak advanced to ${streak} of ${definition.requiredConsecutive}.`,
      }, childResults, state, nextState);
    },
  };
  return Object.freeze(rule);
}

export function replayStatefulResearchRule<S extends StatefulResearchState>(
  rule: StatefulResearchRule<S>,
  initialState: S,
  contexts: readonly ResearchEvaluationContext[]
): StatefulReplayResult<S> {
  const transitions: StatefulResearchTransition<S>[] = [];
  let state = initialState;
  for (const context of contexts) {
    const transition = rule.transition(state, context);
    transitions.push(transition);
    state = transition.nextState;
  }
  return Object.freeze({ transitions: Object.freeze(transitions), finalState: state });
}
