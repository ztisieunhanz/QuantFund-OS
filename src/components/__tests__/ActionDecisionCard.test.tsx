import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActionDecisionCard } from "../ActionDecisionCard";
import {
  formatActionTime,
  formatActionWeight,
  presentActionDecision,
} from "../../lib/actionDecisionPresenter";
import {
  createDeferredActionDecision,
  type ActionConditionEvidence,
  type ActionDecision,
  type ActionDecisionAction,
  type ActionDecisionReason,
} from "../../lib/quant/actionDecision";

const DECISION_TIME = Date.parse("2026-09-27T08:00:00.000Z");
const AS_OF = Date.parse("2026-09-27T07:00:00.000Z");
const EMPTY_CONDITION: ActionConditionEvidence = Object.freeze({
  status: "NOT_APPLICABLE",
  evidenceSemanticIdentities: Object.freeze([]),
});

const REASON_BY_ACTION: Readonly<Record<ActionDecisionAction, ActionDecisionReason>> = Object.freeze({
  WAIT: "WAIT_NO_MATERIALLY_EXECUTABLE_TRANSITION",
  ENTER: "ENTER_CANONICAL_ZERO_TO_MATERIALLY_POSITIVE_TARGET",
  ADD: "ADD_CANONICAL_MATERIALLY_HIGHER_POSITIVE_TARGET",
  HOLD: "HOLD_CANONICAL_POSITIVE_TARGET_SATISFIED_UNDER_POLICY",
  REDUCE: "REDUCE_CANONICAL_MATERIALLY_LOWER_POSITIVE_TARGET",
  EXIT: "EXIT_CANONICAL_POSITIVE_TO_ZERO_TARGET",
});

function canonicalDecision(
  action: ActionDecisionAction,
  overrides: Partial<ActionDecision> = {},
): ActionDecision {
  const base = createDeferredActionDecision({ assetId: "BTC", decisionTime: DECISION_TIME, asOf: AS_OF });
  const proven: ActionConditionEvidence = Object.freeze({
    status: "PROVEN",
    evidenceSemanticIdentities: Object.freeze([`evidence-${action}`]),
  });
  const conditions = {
    entryConditions: action === "ENTER" ? proven : EMPTY_CONDITION,
    addConditions: action === "ADD" ? proven : EMPTY_CONDITION,
    holdConditions: action === "HOLD" ? proven : EMPTY_CONDITION,
    reduceConditions: action === "REDUCE" ? proven : EMPTY_CONDITION,
    exitConditions: action === "EXIT" ? proven : EMPTY_CONDITION,
    invalidationConditions: action === "WAIT" ? proven : EMPTY_CONDITION,
  };

  return Object.freeze({
    ...base,
    semanticIdentity: `canonical-${action.toLowerCase()}`,
    action,
    actionDerivationStatus: action === "WAIT" ? "WAIT_FAIL_CLOSED" : "CANONICALLY_DERIVED",
    currentPortfolioState: {
      status: "BOUND_CANONICAL_VALUATION",
      currentWeight: 0.1234,
      sourceSemanticIdentity: "valuation-id",
    },
    canonicalTargetState: {
      status: "BOUND_OMEGA_TARGET",
      targetWeight: 0.5678,
      sourceSemanticIdentity: "target-id",
      targetContentIdentity: "target-content-id",
      economicTargetContentIdentity: "economic-target-id",
    },
    deltaWeight: 0.4444,
    permissionStatus: {
      status: "BOUND_BY_OMEGA_TARGET_PROVENANCE",
      sourceSemanticIdentities: Object.freeze(["permission-id"]),
    },
    riskStatus: {
      status: "BOUND_BY_OMEGA_TARGET_PROVENANCE",
      sourceSemanticIdentity: "risk-id",
    },
    targetAuthorityStatus: "BOUND_OMEGA_TARGET",
    dataQualityStatus: "LIVE_CANONICAL",
    reasons: Object.freeze([REASON_BY_ACTION[action]]),
    contradictions: Object.freeze([]),
    ...conditions,
    ...overrides,
  }) as ActionDecision;
}

function render(decision: ActionDecision | null): string {
  return renderToStaticMarkup(createElement(ActionDecisionCard, { decision }));
}

describe("P16-A canonical ActionDecision presentation", () => {
  it.each(["WAIT", "ENTER", "ADD", "HOLD", "REDUCE", "EXIT"] as const)(
    "renders canonical %s without UI reclassification",
    (action) => {
      const decision = canonicalDecision(action);
      const view = presentActionDecision(decision);
      const html = render(decision);

      expect(view.action).toBe(action);
      expect(html).toContain(`data-action="${action}"`);
      expect(html).toContain(`>${action}</span>`);
      if (action === "WAIT") expect(html).not.toContain('data-action="HOLD"');
    },
  );

  it("copies canonical current, target, and delta weights without normalization", () => {
    const view = presentActionDecision(canonicalDecision("ADD"));
    expect(view.currentWeightLabel).toBe("12.34%");
    expect(view.targetWeightLabel).toBe("56.78%");
    expect(view.deltaWeightLabel).toBe("+44.44%");
  });

  it("preserves decision/as-of identity and deterministic UTC time", () => {
    const view = presentActionDecision(canonicalDecision("ENTER"));
    expect(view.semanticIdentity).toBe("canonical-enter");
    expect(view.decisionTime).toBe(DECISION_TIME);
    expect(view.asOf).toBe(AS_OF);
    expect(view.decisionTimeLabel).toBe("2026-09-27 08:00:00 UTC");
    expect(view.asOfLabel).toBe("2026-09-27 07:00:00 UTC");
  });

  it("keeps supporting reasons and contradictions visibly distinct", () => {
    const decision = canonicalDecision("WAIT", {
      contradictions: Object.freeze(["CANONICAL_EVIDENCE_TIME_MISMATCH"]),
    });
    const html = render(decision);

    expect(html).toContain("SUPPORTING EVIDENCE");
    expect(html).toContain("No materially executable transition is proven.");
    expect(html).toContain("CONTRADICTIONS");
    expect(html).toContain("Canonical evidence time mismatch.");
  });

  it("shows only canonically supplied relevant condition evidence", () => {
    const view = presentActionDecision(canonicalDecision("ENTER"));
    expect(view.conditions).toEqual([{
      label: "Entry",
      status: "PROVEN",
      evidenceSemanticIdentities: ["evidence-ENTER"],
    }]);
    const html = render(canonicalDecision("ENTER"));
    expect(html).toContain("Entry");
    expect(html).not.toContain("Invalidation</span>");
  });

  it("keeps canonical fail-closed WAIT visibly distinct from HOLD", () => {
    const decision = createDeferredActionDecision({
      assetId: "BTC",
      decisionTime: DECISION_TIME,
      asOf: AS_OF,
    });
    const html = render(decision);

    expect(presentActionDecision(decision).action).toBe("WAIT");
    expect(html).toContain('data-action="WAIT"');
    expect(html).toContain("FAIL-CLOSED EVIDENCE STATE");
    expect(html).toContain("NOT_BOUND");
    expect(html).not.toContain('data-action="HOLD"');
  });

  it("ignores explanatory macro/MTF decoration when displaying canonical action", () => {
    const decision = canonicalDecision("REDUCE");
    const decorated = {
      ...decision,
      explanatoryMacro: { regime: "RISK_ON" },
      explanatory4h: { trend: "UP" },
      explanatory1d: { trend: "DOWN" },
    } as ActionDecision;

    expect(presentActionDecision(decorated).action).toBe("REDUCE");
    expect(render(decorated)).toContain('data-action="REDUCE"');
  });

  it("does not mutate canonical authority state while presenting", () => {
    const decision = canonicalDecision("EXIT");
    const before = JSON.stringify(decision);
    presentActionDecision(decision);
    render(decision);

    expect(JSON.stringify(decision)).toBe(before);
    expect(decision.grantsPermissionAuthority).toBe(false);
    expect(decision.grantsRiskAuthority).toBe(false);
    expect(decision.grantsAllocationAuthority).toBe(false);
    expect(decision.grantsExecutionAuthority).toBe(false);
    expect(decision.grantsAccountingAuthority).toBe(false);
  });

  it("does not fabricate an action when canonical decision is absent", () => {
    const html = render(null);
    expect(html).toContain("Canonical paper action unavailable");
    expect(html).toContain("Unavailable");
    expect(html).not.toContain('data-action="WAIT"');
    expect(html).not.toContain('data-action="HOLD"');
  });

  it("formats weight and time fields deterministically", () => {
    expect(formatActionWeight(null)).toBe("Unavailable");
    expect(formatActionWeight(0)).toBe("0.00%");
    expect(formatActionWeight(-0.025, true)).toBe("-2.50%");
    expect(formatActionWeight(0.025, true)).toBe("+2.50%");
    expect(formatActionTime(DECISION_TIME)).toBe("2026-09-27 08:00:00 UTC");
  });

  it("contains long canonical identity and decision content without page-level overflow", () => {
    const decision = canonicalDecision("WAIT", {
      semanticIdentity: `canonical-${"identity".repeat(40)}`,
      contradictions: Object.freeze(["CANONICAL_EVIDENCE_TIME_MISMATCH"]),
    });
    const html = render(decision);

    expect(html).toContain("break-all");
    expect(html).toContain("break-words");
    expect(html).toContain("sm:grid-cols-3");
    expect(presentActionDecision(decision).action).toBe("WAIT");
  });
});
