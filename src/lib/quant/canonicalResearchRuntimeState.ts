// ============================================================================
// FILE: src/lib/quant/canonicalResearchRuntimeState.ts
// MODULE: CANONICAL RUNTIME RESEARCH-STATE BRIDGE (P16-C / R1A)
//
// Read-only transport for already-produced canonical research artifacts. This
// module does not create hypotheses, evaluate research, classify evidence,
// derive eligibility, persist state, or participate in the decision plane.
// ============================================================================

import {
  serializeHypothesisRegistry,
  type HypothesisRegistrySnapshot,
} from "./hypothesisRegistry";
import {
  validateResearchEvidenceRegistry,
  type ResearchEvidenceRegistrySnapshot,
} from "./researchEvidenceRegistry";
import {
  validateResearchEvidenceScientificBindings,
  validateStrategyEligibilityRegistry,
  type StrategyEligibilityRegistrySnapshot,
} from "./strategyEligibility";

export const CANONICAL_RESEARCH_RUNTIME_STATE_SCHEMA_VERSION = "P16-C-R1A-1";

interface ResearchRuntimeAuthorityBoundary {
  readonly predictiveValidityEstablished: false;
  readonly approvedForPaperAction: false;
  readonly grantsPermissionAuthority: false;
  readonly grantsRiskAuthority: false;
  readonly grantsAllocationAuthority: false;
  readonly grantsExecutionAuthority: false;
  readonly grantsAccountingAuthority: false;
  readonly grantsActionDecisionAuthority: false;
  readonly priceAuthority: "NONE";
}

export interface AvailableCanonicalResearchRuntimeState extends ResearchRuntimeAuthorityBoundary {
  readonly schemaVersion: typeof CANONICAL_RESEARCH_RUNTIME_STATE_SCHEMA_VERSION;
  readonly availability: "AVAILABLE";
  readonly intendedUse: "READ_ONLY_RESEARCH_PRESENTATION";
  readonly hypothesisRegistry: HypothesisRegistrySnapshot;
  readonly evidenceRegistry: ResearchEvidenceRegistrySnapshot;
  readonly strategyEligibilityRegistry: StrategyEligibilityRegistrySnapshot | null;
  readonly linkage: Readonly<{
    hypothesisRegistrySemanticIdentity: string;
    evidenceRegistrySemanticIdentity: string;
    strategyEligibilityRegistrySemanticIdentity: string | null;
  }>;
}

export interface UnavailableCanonicalResearchRuntimeState extends ResearchRuntimeAuthorityBoundary {
  readonly schemaVersion: typeof CANONICAL_RESEARCH_RUNTIME_STATE_SCHEMA_VERSION;
  readonly availability: "UNAVAILABLE";
  readonly intendedUse: "READ_ONLY_RESEARCH_PRESENTATION";
  readonly reason: Readonly<{
    code: "NO_CANONICAL_RESEARCH_ARTIFACT";
    message: "No canonical runtime research artifact is available.";
  }>;
}

export type CanonicalResearchRuntimeState =
  | AvailableCanonicalResearchRuntimeState
  | UnavailableCanonicalResearchRuntimeState;

export interface CanonicalResearchArtifacts {
  readonly hypothesisRegistry: HypothesisRegistrySnapshot;
  readonly evidenceRegistry: ResearchEvidenceRegistrySnapshot;
  readonly strategyEligibilityRegistry?: StrategyEligibilityRegistrySnapshot | null;
}

export interface CanonicalResearchRuntimeStateSource {
  readonly getSnapshot: () => CanonicalResearchRuntimeState;
  readonly subscribe: (listener: () => void) => () => void;
}

const NO_AUTHORITY: ResearchRuntimeAuthorityBoundary = Object.freeze({
  predictiveValidityEstablished: false,
  approvedForPaperAction: false,
  grantsPermissionAuthority: false,
  grantsRiskAuthority: false,
  grantsAllocationAuthority: false,
  grantsExecutionAuthority: false,
  grantsAccountingAuthority: false,
  grantsActionDecisionAuthority: false,
  priceAuthority: "NONE",
});

function canonicalClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function createUnavailableCanonicalResearchRuntimeState(): UnavailableCanonicalResearchRuntimeState {
  return deepFreeze({
    schemaVersion: CANONICAL_RESEARCH_RUNTIME_STATE_SCHEMA_VERSION,
    availability: "UNAVAILABLE" as const,
    intendedUse: "READ_ONLY_RESEARCH_PRESENTATION" as const,
    reason: {
      code: "NO_CANONICAL_RESEARCH_ARTIFACT" as const,
      message: "No canonical runtime research artifact is available." as const,
    },
    ...NO_AUTHORITY,
  });
}

export function createAvailableCanonicalResearchRuntimeState(
  artifacts: CanonicalResearchArtifacts
): AvailableCanonicalResearchRuntimeState {
  serializeHypothesisRegistry(artifacts.hypothesisRegistry);
  validateResearchEvidenceRegistry(artifacts.evidenceRegistry);
  validateResearchEvidenceScientificBindings(
    artifacts.hypothesisRegistry,
    artifacts.evidenceRegistry
  );
  if (artifacts.strategyEligibilityRegistry !== undefined
    && artifacts.strategyEligibilityRegistry !== null) {
    validateStrategyEligibilityRegistry(
      artifacts.hypothesisRegistry,
      artifacts.evidenceRegistry,
      artifacts.strategyEligibilityRegistry
    );
  }

  const owned = deepFreeze(canonicalClone({
    hypothesisRegistry: artifacts.hypothesisRegistry,
    evidenceRegistry: artifacts.evidenceRegistry,
    strategyEligibilityRegistry: artifacts.strategyEligibilityRegistry ?? null,
  }));

  // Revalidate the owned transport copy so callers cannot retain a mutable
  // alias and so the bridge never relies on validation of a different object.
  serializeHypothesisRegistry(owned.hypothesisRegistry);
  validateResearchEvidenceRegistry(owned.evidenceRegistry);
  validateResearchEvidenceScientificBindings(owned.hypothesisRegistry, owned.evidenceRegistry);
  if (owned.strategyEligibilityRegistry !== null) {
    validateStrategyEligibilityRegistry(
      owned.hypothesisRegistry,
      owned.evidenceRegistry,
      owned.strategyEligibilityRegistry
    );
  }

  return deepFreeze({
    schemaVersion: CANONICAL_RESEARCH_RUNTIME_STATE_SCHEMA_VERSION,
    availability: "AVAILABLE" as const,
    intendedUse: "READ_ONLY_RESEARCH_PRESENTATION" as const,
    ...owned,
    linkage: {
      hypothesisRegistrySemanticIdentity: owned.hypothesisRegistry.semanticIdentity,
      evidenceRegistrySemanticIdentity: owned.evidenceRegistry.semanticIdentity,
      strategyEligibilityRegistrySemanticIdentity:
        owned.strategyEligibilityRegistry?.semanticIdentity ?? null,
    },
    ...NO_AUTHORITY,
  });
}

let currentState: CanonicalResearchRuntimeState = createUnavailableCanonicalResearchRuntimeState();
const listeners = new Set<() => void>();

export const canonicalResearchRuntimeStateSource: CanonicalResearchRuntimeStateSource = Object.freeze({
  getSnapshot: (): CanonicalResearchRuntimeState => currentState,
  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
});

export function publishCanonicalResearchArtifacts(
  artifacts: CanonicalResearchArtifacts
): AvailableCanonicalResearchRuntimeState {
  const validated = createAvailableCanonicalResearchRuntimeState(artifacts);
  currentState = validated;
  listeners.forEach((listener) => listener());
  return validated;
}

export function markCanonicalResearchRuntimeStateUnavailable(): UnavailableCanonicalResearchRuntimeState {
  const unavailable = createUnavailableCanonicalResearchRuntimeState();
  currentState = unavailable;
  listeners.forEach((listener) => listener());
  return unavailable;
}
