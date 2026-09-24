# QuantFund-OS v1.0 Architecture

This document freezes the target v1.0 architecture. It preserves all accepted decisions and distinguishes implemented behavior from future target components.

## Canonical pipeline

```text
PIT DATA
  → Alpha / approved evidence
  → Permission
  → Risk
  → Omega
  → Target Position
  → Execution
  → Canonical Ledger
```

Signal is not permission, permission is not risk, risk is not allocation, and allocation is not execution. Rules and Alpha may propose evidence or intent; Risk and Omega retain final sizing authority. Financial state belongs only to the canonical ledger.

## Data plane

- Live providers and historical PIT providers retain truthful provenance.
- Historical research datasets use immutable, versioned snapshots.
- `BacktestDataset.assetBars` remains the sole executable-price authority.
- Canonical executable market bars remain 1H.
- Missing, stale, or unavailable data is never replaced with fabricated values.

## Timeframe rule

- 1H is the only canonical execution domain for v1.0.
- 4H and 1D are implemented as derived research context only.
- Derived bars may use only fully closed, eligible 1H bars available at `decisionTime`.
- An unfinished 4H or 1D bar must never be visible.
- Derived buckets are UTC-aligned: 4H requires exactly four consecutive canonical 1H intervals and 1D requires all 24 intervals of the UTC day.
- Canonical 1H timestamps represent candle open time for this derivation; final OHLCV eligibility is the exclusive interval end (`timestamp + 1H <= decisionTime`).
- Missing or duplicate component intervals are never compressed into a derived candle.
- Derived context cannot become a second executable-price authority.
- 15m and additional execution domains are post-v1 unless explicitly approved.

## Research plane

```text
Historical PIT Context
  → Feature Builder
  → ResearchRule / Hypothesis Registry
  → Shadow Research
  → OOS / Robustness
  → Evidence Status
```

Required evidence states are:

- `CANDIDATE`
- `APPROVED_FOR_PAPER`
- `REJECTED`
- `INSUFFICIENT_EVIDENCE`

The target rule system must allow complex moving-average stacks, multiple indicators, sequential/stateful rules, parameterized rules, derived 4H/1D conditions, and macro-conditioned technical hypotheses without modifying canonical execution or accounting architecture. A rule does not directly decide final size, and a candidate does not automatically become actionable.

The implemented C-B `ResearchRule` foundation is stateless and research-only. Each rule has explicit ID/version/parameters, receives only its declared PIT-safe canonical-series or 1H/4H/1D dependencies, and returns structured `MATCH`, `NO_MATCH`, or `INSUFFICIENT_EVIDENCE`. AND/OR/NOT use explicit three-valued fail-closed semantics. These results are evidence, not `SignalOutput`, permission, allocation, execution, or action authority.

The implemented C-C extension adds explicit immutable research-evaluation state for bounded A-then-B sequences and consecutive-evaluation persistence. Each transition consumes only prior compatible asset-scoped state plus one current PIT-safe context; `decisionTime` must increase strictly, so equal-time ordering is rejected. Ordered sequences evaluate only the child active in the current phase, using that child's declared dependency view. Missing evidence never advances a sequence, and it resets persistence to avoid inferring continuity across a data gap. State and transition evidence are bounded, deterministic, and grant no trading authority.

The implemented C-D Hypothesis Registry is research-governance infrastructure only. It deterministically preserves predeclared hypothesis ID/version/semantic identity, rationale, exact rule identity, asset/dependency scope, finite parameter space, non-overlapping training/OOS intervals, and exact declarative trial counts. Before a snapshot is trusted, extended, or serialized, its top-level schema/use/non-authority contract is validated; each existing entry then independently regenerates its scientific identity from normalized material content and revalidates its non-authority flags. Material changes produce distinguishable identities or versions; negative lifecycle outcomes remain representable rather than being removed from a winners-only record. Registration contains no performance, ranking, selected-parameter, or OOS-result fields and performs no evaluation, search, tuning, or strategy selection. It establishes no predictive validity and grants no Permission, Risk, Omega, allocation, execution, accounting, paper-action, or ActionDecision authority.

These research-plane components are target architecture unless separately identified as implemented. Historical context remains audit-first today.

## Decision plane target

```text
Approved Evidence
  → StrategyEligibility
  → Candidate Intent
  → PermissionGate
  → RiskEngine
  → OmegaAllocator
  → Canonical Target Weight

Canonical Target Weight
  → ExecutionEngine
  → Canonical Ledger

Canonical Target Weight
  + Current Canonical Portfolio State
  → ActionDecision Builder
  → UI / Chatbot
```

`ActionDecision` is the target single source of truth for describing product-facing action state. It is a pure, deterministic contract derived from canonical target weight and current canonical portfolio state. It cannot modify target weight or bypass Permission, Risk, Omega, or Execution. It is not a second allocation, execution, accounting, or financial authority. It is not yet implemented.

Target action vocabulary:

- `WAIT`
- `ENTER`
- `ADD`
- `HOLD`
- `REDUCE`
- `EXIT`

These values are derived action semantics, not independent orders or sizing instructions.

The target contract should expose timestamp, asset, action, current/target/delta weight, primary strategy, supporting rules, timeframe context, evidence status, macro context, risk status, reasons, contradictions, entry/add/reduce/exit conditions, invalidation condition, data quality, and `asOf`.

## Product grounding

The chatbot must not independently invent trading actions. It may explain grounded `CurrentMarketSnapshot` and future `ActionDecision` state, clearly separating observed data, model output, interpretation, and uncertainty. When no approved actionable evidence exists, `WAIT` / no action is valid.

## Current implementation boundary

Derived 4H/1D research context, the stateless ResearchRule/combinator foundation, bounded stateful sequence/persistence primitives, and deterministic Hypothesis Registry governance are implemented without connection to trading behavior. No hypothesis has established predictive validity or approval for paper action. Feature building, shadow/OOS evaluation, actual approved evidence, StrategyEligibility, evidence-gated action policy, and ActionDecision do not yet exist. Their implementation belongs to later roadmap gates and must preserve baseline replay, execution, and accounting parity.
