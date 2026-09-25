import { describe, expect, it } from "vitest";
import {
  CURRENT_ACTION_LIFECYCLE_POLICY,
  serializeActionLifecyclePolicy,
  validateActionLifecycleDecision,
  validateActionLifecyclePolicy,
  type ActionLifecyclePolicy,
} from "../actionLifecycle";
import {
  createDeferredActionDecision,
  type ActionDecision,
} from "../actionDecision";

const decision = () => createDeferredActionDecision({
  assetId: "BTC",
  decisionTime: Date.UTC(2026, 0, 2, 12),
  asOf: Date.UTC(2026, 0, 2, 11),
});

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function forgedPolicy(mutator: (draft: Record<string, any>) => void): ActionLifecyclePolicy {
  const draft = clone(CURRENT_ACTION_LIFECYCLE_POLICY) as unknown as Record<string, any>;
  mutator(draft);
  return draft as unknown as ActionLifecyclePolicy;
}

function definition(action: string) {
  return CURRENT_ACTION_LIFECYCLE_POLICY.definitions.find((item) => item.action === action)!;
}

describe("M14 A-03 partial action lifecycle methodology", () => {
  it("has deterministic identity", () => {
    expect(CURRENT_ACTION_LIFECYCLE_POLICY.semanticIdentity)
      .toBe(validateActionLifecyclePolicy(CURRENT_ACTION_LIFECYCLE_POLICY).semanticIdentity);
  });

  it("serializes deterministically", () => {
    expect(serializeActionLifecyclePolicy(CURRENT_ACTION_LIFECYCLE_POLICY))
      .toBe(serializeActionLifecyclePolicy(CURRENT_ACTION_LIFECYCLE_POLICY));
  });

  it("is deeply immutable", () => {
    expect(Object.isFrozen(CURRENT_ACTION_LIFECYCLE_POLICY)).toBe(true);
    expect(Object.isFrozen(CURRENT_ACTION_LIFECYCLE_POLICY.definitions)).toBe(true);
    expect(Object.isFrozen(CURRENT_ACTION_LIFECYCLE_POLICY.executionLifecyclePolicy)).toBe(true);
  });

  it("records a truthful PARTIAL outcome", () => {
    expect(CURRENT_ACTION_LIFECYCLE_POLICY.methodologyOutcome)
      .toBe("PARTIAL_NON_WAIT_DERIVATION_DEFERRED");
  });

  it("keeps WAIT as the only constructible action", () => {
    expect(CURRENT_ACTION_LIFECYCLE_POLICY.currentlyConstructibleActions).toEqual(["WAIT"]);
    expect(definition("WAIT").constructibility).toBe("CONSTRUCTIBLE_FAIL_CLOSED");
  });

  it("makes WAIT distinct from HOLD", () => {
    expect(CURRENT_ACTION_LIFECYCLE_POLICY.waitHoldDistinction)
      .toBe("WAIT_NO_PROVABLE_TRANSITION_HOLD_PROVABLE_POSITIVE_EQUAL_TARGET");
    expect(definition("WAIT").authorizedTargetRelation).toBe("NOT_PROVABLY_ACTIONABLE");
    expect(definition("HOLD").authorizedTargetRelation).toBe("MATERIALLY_EQUAL_TO_CURRENT");
  });

  it("freezes zero-to-positive as ENTER methodology without constructing it", () => {
    expect(definition("ENTER")).toMatchObject({
      currentExposureRelation: "ZERO",
      authorizedTargetRelation: "MATERIALLY_POSITIVE",
      constructibility: "DEFERRED_CANONICAL_BINDINGS_AND_COMPARISON_POLICY",
    });
  });

  it("freezes positive-to-higher-positive as ADD methodology without constructing it", () => {
    expect(definition("ADD")).toMatchObject({
      currentExposureRelation: "POSITIVE",
      authorizedTargetRelation: "MATERIALLY_GREATER_THAN_CURRENT",
    });
  });

  it("freezes positive-to-equal-positive as HOLD methodology without constructing it", () => {
    expect(definition("HOLD")).toMatchObject({
      currentExposureRelation: "POSITIVE",
      authorizedTargetRelation: "MATERIALLY_EQUAL_TO_CURRENT",
    });
  });

  it("freezes positive-to-lower-positive as REDUCE methodology without constructing it", () => {
    expect(definition("REDUCE")).toMatchObject({
      currentExposureRelation: "POSITIVE",
      authorizedTargetRelation: "POSITIVE_AND_MATERIALLY_LESS_THAN_CURRENT",
    });
  });

  it("freezes positive-to-zero as EXIT methodology without constructing it", () => {
    expect(definition("EXIT")).toMatchObject({
      currentExposureRelation: "POSITIVE",
      authorizedTargetRelation: "ZERO",
    });
  });

  it("requires canonical current and target bindings for every non-WAIT action", () => {
    for (const action of ["ENTER", "ADD", "HOLD", "REDUCE", "EXIT"]) {
      expect(definition(action)).toMatchObject({
        requiresCanonicalCurrentWeight: true,
        requiresCanonicalTargetWeight: true,
        requiresMaterialComparisonPolicy: true,
        executionLifecycleRequired: true,
      });
    }
  });

  it("keeps current-state authority deferred", () => {
    expect(CURRENT_ACTION_LIFECYCLE_POLICY.currentStateAuthority)
      .toBe("DEFERRED_IDENTITY_BEARING_CANONICAL_WEIGHT_BINDING");
  });

  it("keeps Omega target authority deferred but exclusive", () => {
    expect(CURRENT_ACTION_LIFECYCLE_POLICY.targetStateAuthority)
      .toBe("DEFERRED_IDENTITY_BEARING_OMEGA_TARGET_BINDING");
    expect(CURRENT_ACTION_LIFECYCLE_POLICY.omegaRole).toBe("SOLE_TARGET_WEIGHT_AUTHORITY");
  });

  it("does not invent a numeric tolerance", () => {
    expect(CURRENT_ACTION_LIFECYCLE_POLICY.comparisonPolicy)
      .toBe("DEFERRED_NO_CANONICAL_WEIGHT_TOLERANCE");
    expect(serializeActionLifecyclePolicy(CURRENT_ACTION_LIFECYCLE_POLICY)).not.toMatch(/epsilon/i);
  });

  it("rejects non-finite and negative long-only values methodologically", () => {
    expect(CURRENT_ACTION_LIFECYCLE_POLICY.numericValidationPolicy.nonFinite).toBe("REJECT");
    expect(CURRENT_ACTION_LIFECYCLE_POLICY.numericValidationPolicy.negative).toBe("REJECT_LONG_ONLY");
  });

  it("defers above-one, signed-zero, and floating-boundary policy", () => {
    expect(CURRENT_ACTION_LIFECYCLE_POLICY.numericValidationPolicy.aboveOne).toMatch(/^DEFER_/);
    expect(CURRENT_ACTION_LIFECYCLE_POLICY.numericValidationPolicy.signedZero).toMatch(/^DEFER_/);
    expect(CURRENT_ACTION_LIFECYCLE_POLICY.numericValidationPolicy.floatingBoundary).toMatch(/^DEFER_/);
  });

  it("fails closed to WAIT for absent valuation or stale/mismatched time", () => {
    expect(CURRENT_ACTION_LIFECYCLE_POLICY.numericValidationPolicy.absentValuation).toBe("WAIT_FAIL_CLOSED");
    expect(CURRENT_ACTION_LIFECYCLE_POLICY.numericValidationPolicy.staleOrMismatchedTimestamp)
      .toBe("WAIT_FAIL_CLOSED");
  });

  it("defers newly authorized, outstanding, partial, completed, and repeated target state", () => {
    for (const value of Object.values(CURRENT_ACTION_LIFECYCLE_POLICY.executionLifecyclePolicy)) {
      expect(value).toMatch(/^(DEFERRED_|WAIT_FAIL_CLOSED)/);
    }
  });

  it("records that pending replay state is absent from DecisionState", () => {
    expect(CURRENT_ACTION_LIFECYCLE_POLICY.executionLifecyclePolicy.replayBoundary)
      .toBe("DEFERRED_PENDING_REBALANCE_NOT_IN_DECISION_STATE");
  });

  it("does not let StrategyEligibility trigger action", () => {
    expect(CURRENT_ACTION_LIFECYCLE_POLICY.strategyEligibilityRole)
      .toBe("ADMISSION_ONLY_NEVER_ACTION_TRIGGER");
  });

  it("does not duplicate Permission or Risk", () => {
    expect(CURRENT_ACTION_LIFECYCLE_POLICY.permissionRiskRole)
      .toBe("CONSUME_FUTURE_CANONICAL_RESULTS_NEVER_REIMPLEMENT");
    expect(CURRENT_ACTION_LIFECYCLE_POLICY.grantsPermissionAuthority).toBe(false);
    expect(CURRENT_ACTION_LIFECYCLE_POLICY.grantsRiskAuthority).toBe(false);
  });

  it("preserves direct target-to-execution authority", () => {
    expect(CURRENT_ACTION_LIFECYCLE_POLICY.executionPath)
      .toBe("TARGET_PORTFOLIO_WEIGHT_DIRECT_TO_EXECUTION");
    expect(CURRENT_ACTION_LIFECYCLE_POLICY.grantsExecutionAuthority).toBe(false);
  });

  it("preserves the canonical ledger as current-state authority", () => {
    expect(CURRENT_ACTION_LIFECYCLE_POLICY.ledgerRole)
      .toBe("SOLE_CURRENT_PORTFOLIO_STATE_AUTHORITY");
    expect(CURRENT_ACTION_LIFECYCLE_POLICY.grantsAccountingAuthority).toBe(false);
  });

  it("keeps reasons and conditions explanatory only", () => {
    expect(CURRENT_ACTION_LIFECYCLE_POLICY.reasonsAndConditionsRole)
      .toBe("EXPLANATORY_ONLY_NOT_ACTION_INPUT");
  });

  it("preserves 1H execution and explanatory 4H/1D", () => {
    expect(CURRENT_ACTION_LIFECYCLE_POLICY.executableTimeframe).toBe("1H");
    expect(CURRENT_ACTION_LIFECYCLE_POLICY.derivedTimeframesRole).toBe("4H_1D_EXPLANATORY_ONLY");
  });

  it("validates the existing fail-closed WAIT decision deterministically", () => {
    expect(validateActionLifecycleDecision(decision()).action).toBe("WAIT");
    expect(validateActionLifecycleDecision(decision()).semanticIdentity).toBe(decision().semanticIdentity);
  });

  it("rejects caller-fabricated non-WAIT action through the A-02 integrity boundary", () => {
    const forged = clone(decision()) as unknown as Record<string, any>;
    forged.action = "ENTER";
    expect(() => validateActionLifecycleDecision(forged as unknown as ActionDecision)).toThrow(/forged/);
  });

  it("rejects forged lifecycle semantics", () => {
    expect(() => validateActionLifecyclePolicy(forgedPolicy((draft) => {
      draft.definitions[1].constructibility = "CONSTRUCTIBLE_FAIL_CLOSED";
    }))).toThrow(/forged/);
  });

  it("rejects authority escalation even with the old semantic identity", () => {
    expect(() => validateActionLifecyclePolicy(forgedPolicy((draft) => {
      draft.grantsExecutionAuthority = true;
    }))).toThrow(/forged/);
  });

  it("does not establish predictive validity or paper-action approval", () => {
    expect(CURRENT_ACTION_LIFECYCLE_POLICY.predictiveValidityEstablished).toBe(false);
    expect(CURRENT_ACTION_LIFECYCLE_POLICY.approvedForPaperAction).toBe(false);
  });

  it("replay-equivalent A-02 inputs preserve lifecycle validation identity", () => {
    const first = decision();
    const second = decision();
    expect(validateActionLifecycleDecision(first).semanticIdentity)
      .toBe(validateActionLifecycleDecision(second).semanticIdentity);
  });
});
