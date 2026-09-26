import { describe, expect, it } from "vitest";
import {
  ACTION_DECISION_ACTION_VOCABULARY,
  createDeferredActionDecision,
  serializeActionDecision,
  validateActionDecision,
  type ActionDecision,
  type ActionDecisionInput,
} from "../actionDecision";

const INPUT: ActionDecisionInput = {
  assetId: "BTC",
  decisionTime: Date.UTC(2026, 0, 2, 12),
  asOf: Date.UTC(2026, 0, 2, 11),
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function decision(): ActionDecision {
  return createDeferredActionDecision(INPUT);
}

function forged(mutator: (draft: Record<string, any>) => void): ActionDecision {
  const draft = clone(decision()) as unknown as Record<string, any>;
  mutator(draft);
  return draft as unknown as ActionDecision;
}

describe("M14 A-04 Step 4 ActionDecision contract", () => {
  it("creates deterministic identity from identical inputs", () => {
    expect(createDeferredActionDecision(INPUT).semanticIdentity)
      .toBe(createDeferredActionDecision({ ...INPUT }).semanticIdentity);
  });

  it("serializes deterministically", () => {
    expect(serializeActionDecision(decision())).toBe(serializeActionDecision(decision()));
  });

  it("does not mutate caller input", () => {
    const input = { ...INPUT };
    const before = clone(input);
    createDeferredActionDecision(input);
    expect(input).toEqual(before);
  });

  it("deep-freezes the result", () => {
    const result = decision();
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.currentPortfolioState)).toBe(true);
    expect(Object.isFrozen(result.entryConditions.evidenceSemanticIdentities)).toBe(true);
  });

  it("binds the exact asset", () => {
    expect(decision().assetId).toBe("BTC");
    expect(createDeferredActionDecision({ ...INPUT, assetId: "PAXG" }).semanticIdentity)
      .not.toBe(decision().semanticIdentity);
  });

  it("binds exact decisionTime and asOf", () => {
    expect(createDeferredActionDecision({ ...INPUT, decisionTime: INPUT.decisionTime + 1 }).semanticIdentity)
      .not.toBe(decision().semanticIdentity);
    expect(createDeferredActionDecision({ ...INPUT, asOf: INPUT.asOf + 1 }).semanticIdentity)
      .not.toBe(decision().semanticIdentity);
  });

  it("fails closed for invalid asset identifiers", () => {
    expect(() => createDeferredActionDecision({ ...INPUT, assetId: "" })).toThrow(/assetId/);
    expect(() => createDeferredActionDecision({ ...INPUT, assetId: " BTC" })).toThrow(/assetId/);
  });

  it("fails closed for non-finite, fractional, negative, or future PIT times", () => {
    expect(() => createDeferredActionDecision({ ...INPUT, decisionTime: Number.NaN })).toThrow(/decisionTime/);
    expect(() => createDeferredActionDecision({ ...INPUT, decisionTime: 1.5 })).toThrow(/decisionTime/);
    expect(() => createDeferredActionDecision({ ...INPUT, asOf: -1 })).toThrow(/decisionTime/);
    expect(() => createDeferredActionDecision({ ...INPUT, asOf: INPUT.decisionTime + 1 })).toThrow(/decisionTime/);
  });

  it("exposes the reviewed long-only action vocabulary without BUY or SELL", () => {
    expect(ACTION_DECISION_ACTION_VOCABULARY).toEqual(["WAIT", "ENTER", "ADD", "HOLD", "REDUCE", "EXIT"]);
    expect(decision().longOnly).toBe(true);
  });

  it("keeps deferred construction fail-closed while exposing the reviewed vocabulary", () => {
    expect(decision().action).toBe("WAIT");
    expect(decision().currentlyDerivableActions).toEqual(["WAIT", "ENTER", "ADD", "HOLD", "REDUCE", "EXIT"]);
  });

  it("keeps current weight unavailable instead of deriving it from position units", () => {
    expect(decision().currentPortfolioState).toEqual({
      status: "UNAVAILABLE_CANONICAL_CURRENT_WEIGHT_BINDING",
      currentWeight: null,
      sourceSemanticIdentity: null,
    });
  });

  it("keeps target weight unavailable instead of accepting a caller target", () => {
    expect(decision().canonicalTargetState).toEqual({
      status: "UNAVAILABLE_CANONICAL_TARGET_WEIGHT_BINDING",
      targetWeight: null,
      sourceSemanticIdentity: null,
      targetContentIdentity: null,
      economicTargetContentIdentity: null,
    });
  });

  it("does not compute a delta without both canonical bindings", () => {
    expect(decision().deltaWeight).toBeNull();
  });

  it("rejects caller-invented current weight", () => {
    expect(() => createDeferredActionDecision({ ...INPUT, currentWeight: 0.2 } as ActionDecisionInput))
      .toThrow(/only assetId/);
  });

  it("rejects caller-invented target weight", () => {
    expect(() => createDeferredActionDecision({ ...INPUT, targetWeight: 0.4 } as ActionDecisionInput))
      .toThrow(/only assetId/);
  });

  it("rejects negative caller weights rather than reinterpreting them", () => {
    expect(() => createDeferredActionDecision({ ...INPUT, currentWeight: -0.1 } as ActionDecisionInput)).toThrow();
    expect(() => createDeferredActionDecision({ ...INPUT, targetWeight: -0.1 } as ActionDecisionInput)).toThrow();
  });

  it("does not let StrategyEligibility imply action", () => {
    expect(() => createDeferredActionDecision({
      ...INPUT,
      strategyEligibility: "ELIGIBLE_FOR_PAPER_EVALUATION",
    } as ActionDecisionInput)).toThrow(/only assetId/);
    expect(decision().strategyEligibility.status).toBe("NOT_BOUND_ACTION_CLASSIFICATION_DOES_NOT_INFER_ELIGIBILITY");
  });

  it("does not let caller-provided Permission state imply action", () => {
    expect(() => createDeferredActionDecision({ ...INPUT, permissionStatus: "PERMITTED" } as ActionDecisionInput))
      .toThrow(/only assetId/);
    expect(decision().grantsPermissionAuthority).toBe(false);
  });

  it("does not let caller-provided Risk state imply action", () => {
    expect(() => createDeferredActionDecision({ ...INPUT, riskStatus: "ACCEPTED" } as ActionDecisionInput))
      .toThrow(/only assetId/);
    expect(decision().grantsRiskAuthority).toBe(false);
  });

  it("grants no allocation or target-weight authority", () => {
    expect(decision().grantsAllocationAuthority).toBe(false);
    expect(decision().grantsTargetWeightAuthority).toBe(false);
    expect(decision().modifiesCanonicalTargetWeight).toBe(false);
  });

  it("grants no execution authority and cannot be an execution target", () => {
    expect(decision().grantsExecutionAuthority).toBe(false);
    expect(decision().consumableByExecutionAsTargetAuthority).toBe(false);
  });

  it("grants no ledger or accounting authority", () => {
    expect(decision().grantsAccountingAuthority).toBe(false);
  });

  it("does not establish predictive validity or paper-action approval", () => {
    expect(decision().predictiveValidityEstablished).toBe(false);
    expect(decision().approvedForPaperAction).toBe(false);
  });

  it("preserves 1H as the sole executable domain", () => {
    expect(decision().timeframeAuthority.executableDomain).toBe("1H");
  });

  it("keeps 4H context explanatory and unbound", () => {
    expect(decision().timeframeAuthority.derived4hRole).toBe("EXPLANATORY_ONLY_NOT_BOUND");
  });

  it("keeps 1D context explanatory and unbound", () => {
    expect(decision().timeframeAuthority.derived1dRole).toBe("EXPLANATORY_ONLY_NOT_BOUND");
  });

  for (const action of ["ENTER", "ADD", "HOLD", "REDUCE", "EXIT"] as const) {
    it(`rejects fabricated ${action} without canonical bindings`, () => {
      expect(() => validateActionDecision(forged((draft) => { draft.action = action; }))).toThrow(/forged/);
    });
  }

  it("does not accept caller-authored reasons", () => {
    expect(() => createDeferredActionDecision({ ...INPUT, reasons: ["ENTER_NOW"] } as ActionDecisionInput))
      .toThrow(/only assetId/);
    expect(() => validateActionDecision(forged((draft) => { draft.reasons = ["ENTER_NOW"]; }))).toThrow(/forged/);
  });

  it("does not accept caller-authored contradictions", () => {
    expect(() => createDeferredActionDecision({ ...INPUT, contradictions: ["IGNORE_RISK"] } as ActionDecisionInput))
      .toThrow(/only assetId/);
    expect(() => validateActionDecision(forged((draft) => { draft.contradictions = ["IGNORE_RISK"]; }))).toThrow(/forged/);
  });

  it("does not accept caller-authored conditions", () => {
    expect(() => createDeferredActionDecision({ ...INPUT, entryConditions: ["PRICE_UP"] } as ActionDecisionInput))
      .toThrow(/only assetId/);
    expect(() => validateActionDecision(forged((draft) => { draft.entryConditions.status = "MET"; }))).toThrow(/forged/);
  });

  it("keeps macro and data-quality context explicitly unbound", () => {
    expect(decision().macroContextStatus).toBe("NOT_BOUND");
    expect(decision().dataQualityStatus).toBe("NOT_BOUND");
  });

  it("rejects a forged current-state source", () => {
    expect(() => validateActionDecision(forged((draft) => {
      draft.currentPortfolioState.currentWeight = 0.25;
      draft.currentPortfolioState.sourceSemanticIdentity = "caller-ledger";
    }))).toThrow(/forged/);
  });

  it("rejects a forged target authority source", () => {
    expect(() => validateActionDecision(forged((draft) => {
      draft.canonicalTargetState.targetWeight = 0.25;
      draft.canonicalTargetState.sourceSemanticIdentity = "caller-target";
    }))).toThrow(/forged/);
  });

  it("rejects forged authority flags", () => {
    expect(() => validateActionDecision(forged((draft) => { draft.grantsExecutionAuthority = true; }))).toThrow(/forged/);
    expect(() => validateActionDecision(forged((draft) => { draft.grantsAccountingAuthority = true; }))).toThrow(/forged/);
  });

  it("rejects a forged semantic identity", () => {
    expect(() => validateActionDecision(forged((draft) => { draft.semanticIdentity = "forged"; }))).toThrow(/forged/);
  });

  it("rejects material changes even when the old identity is retained", () => {
    expect(() => validateActionDecision(forged((draft) => { draft.assetId = "PAXG"; }))).toThrow(/forged/);
  });

  it("validates a legitimate untouched decision", () => {
    expect(validateActionDecision(decision())).toBeDefined();
  });
});
