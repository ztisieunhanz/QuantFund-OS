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

describe("M14 A-04 Step 4 action lifecycle methodology", () => {
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

  it("records canonical classification enablement", () => {
    expect(CURRENT_ACTION_LIFECYCLE_POLICY.methodologyOutcome)
      .toBe("CANONICAL_ACTION_CLASSIFICATION_ENABLED");
  });

  it("makes every frozen action constructible only under its evidence policy", () => {
    expect(CURRENT_ACTION_LIFECYCLE_POLICY.currentlyConstructibleActions)
      .toEqual(["WAIT", "ENTER", "ADD", "HOLD", "REDUCE", "EXIT"]);
    expect(definition("WAIT").constructibility).toBe("CONSTRUCTIBLE_FAIL_CLOSED");
    for (const action of ["ENTER", "ADD", "HOLD", "REDUCE", "EXIT"]) {
      expect(definition(action).constructibility).toBe("CONSTRUCTIBLE_FROM_CANONICAL_EVIDENCE");
    }
  });

  it("makes WAIT distinct from HOLD", () => {
    expect(CURRENT_ACTION_LIFECYCLE_POLICY.waitHoldDistinction)
      .toBe("WAIT_NO_PROVABLE_TRANSITION_HOLD_PROVABLE_POSITIVE_EQUAL_TARGET");
    expect(definition("WAIT").authorizedTargetRelation).toBe("NOT_PROVABLY_ACTIONABLE");
    expect(definition("HOLD").authorizedTargetRelation).toBe("MATERIALLY_EQUAL_TO_CURRENT");
  });

  it("freezes zero-to-positive as ENTER methodology", () => {
    expect(definition("ENTER")).toMatchObject({
      currentExposureRelation: "ZERO",
      authorizedTargetRelation: "MATERIALLY_POSITIVE",
      constructibility: "CONSTRUCTIBLE_FROM_CANONICAL_EVIDENCE",
    });
  });

  it("freezes positive-to-higher-positive as ADD methodology", () => {
    expect(definition("ADD")).toMatchObject({
      currentExposureRelation: "POSITIVE",
      authorizedTargetRelation: "MATERIALLY_GREATER_THAN_CURRENT",
    });
  });

  it("freezes positive-to-equal-positive as HOLD methodology", () => {
    expect(definition("HOLD")).toMatchObject({
      currentExposureRelation: "POSITIVE",
      authorizedTargetRelation: "MATERIALLY_EQUAL_TO_CURRENT",
    });
  });

  it("freezes positive-to-lower-positive as REDUCE methodology", () => {
    expect(definition("REDUCE")).toMatchObject({
      currentExposureRelation: "POSITIVE",
      authorizedTargetRelation: "POSITIVE_AND_MATERIALLY_LESS_THAN_CURRENT",
    });
  });

  it("freezes positive-to-zero as EXIT methodology", () => {
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

  it("binds current-state authority to canonical valuation", () => {
    expect(CURRENT_ACTION_LIFECYCLE_POLICY.currentStateAuthority)
      .toBe("CANONICAL_PORTFOLIO_VALUATION_SNAPSHOT");
  });

  it("keeps Omega target authority exclusive through lifecycle evidence", () => {
    expect(CURRENT_ACTION_LIFECYCLE_POLICY.targetStateAuthority)
      .toBe("OMEGA_TARGET_VIA_ACTIVE_TARGET_LIFECYCLE");
    expect(CURRENT_ACTION_LIFECYCLE_POLICY.omegaRole).toBe("SOLE_TARGET_WEIGHT_AUTHORITY");
  });

  it("does not invent a numeric tolerance", () => {
    expect(CURRENT_ACTION_LIFECYCLE_POLICY.comparisonPolicy)
      .toBe("CANONICAL_EXECUTION_PLANNER_USD_THRESHOLD_NO_WEIGHT_EPSILON");
    expect(serializeActionLifecyclePolicy(CURRENT_ACTION_LIFECYCLE_POLICY)).not.toMatch(/1e-12|Number\.EPSILON/);
  });

  it("rejects non-finite and negative long-only values methodologically", () => {
    expect(CURRENT_ACTION_LIFECYCLE_POLICY.numericValidationPolicy.nonFinite).toBe("REJECT");
    expect(CURRENT_ACTION_LIFECYCLE_POLICY.numericValidationPolicy.negative).toBe("REJECT_LONG_ONLY");
  });

  it("inherits above-one, signed-zero, and floating-boundary handling from canonical producers and planner", () => {
    expect(CURRENT_ACTION_LIFECYCLE_POLICY.numericValidationPolicy.aboveOne).toBe("ACCEPT_ONLY_IF_UPSTREAM_CANONICAL_CONTRACT_ACCEPTS");
    expect(CURRENT_ACTION_LIFECYCLE_POLICY.numericValidationPolicy.signedZero).toBe("CANONICAL_PRODUCER_NORMALIZES_TO_ZERO");
    expect(CURRENT_ACTION_LIFECYCLE_POLICY.numericValidationPolicy.floatingBoundary).toBe("CANONICAL_EXECUTION_PLANNER_USD_THRESHOLD");
  });

  it("fails closed to WAIT for absent valuation or stale/mismatched time", () => {
    expect(CURRENT_ACTION_LIFECYCLE_POLICY.numericValidationPolicy.absentValuation).toBe("WAIT_FAIL_CLOSED");
    expect(CURRENT_ACTION_LIFECYCLE_POLICY.numericValidationPolicy.staleOrMismatchedTimestamp)
      .toBe("WAIT_FAIL_CLOSED");
  });

  it("classifies lifecycle states without granting lifecycle authority", () => {
    expect(CURRENT_ACTION_LIFECYCLE_POLICY.executionLifecyclePolicy.newlyAuthorizedTarget).toBe("CLASSIFY_CURRENT_ASSESSMENT");
    expect(CURRENT_ACTION_LIFECYCLE_POLICY.executionLifecyclePolicy.partialFill).toBe("CLASSIFY_POST_FILL_CANONICAL_VALUATION");
    expect(CURRENT_ACTION_LIFECYCLE_POLICY.executionLifecyclePolicy.completedTarget).toBe("CLASSIFY_POST_FILL_CANONICAL_VALUATION");
    expect(CURRENT_ACTION_LIFECYCLE_POLICY.executionLifecyclePolicy.staleTarget).toBe("WAIT_FAIL_CLOSED");
  });

  it("records that classification remains transient and absent from DecisionState persistence", () => {
    expect(CURRENT_ACTION_LIFECYCLE_POLICY.executionLifecyclePolicy.replayBoundary)
      .toBe("TRANSIENT_CLASSIFICATION_ONLY_NO_DECISION_STATE_PERSISTENCE");
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
