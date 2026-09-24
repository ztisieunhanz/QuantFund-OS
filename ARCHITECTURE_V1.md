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

The implemented C-D Hypothesis Registry is research-governance infrastructure only. It deterministically preserves predeclared hypothesis ID/version/semantic identity, rationale, exact rule identity, asset/dependency scope, finite parameter space, non-overlapping training/OOS intervals, stateful OOS-boundary policy, and exact declarative trial counts. Stateful hypotheses must predeclare reset-at-OOS or PIT-safe pre-OOS state carry; stateless hypotheses declare the policy non-applicable, with concrete rule-kind compatibility enforced when C-F receives the rule. Before a snapshot is trusted, extended, or serialized, its top-level schema/use/non-authority contract is validated; each existing entry then independently regenerates its scientific identity from normalized material content and revalidates its non-authority flags. Material changes produce distinguishable identities or versions; negative lifecycle outcomes remain representable rather than being removed from a winners-only record. Registration contains no performance, ranking, selected-parameter, or OOS-result fields and performs no evaluation, search, tuning, or strategy selection. It establishes no predictive validity and grants no Permission, Risk, Omega, allocation, execution, accounting, paper-action, or ActionDecision authority.

The implemented C-E feature builder produces deterministic research-only values at one explicit asset and `decisionTime`/`asOf` boundary. Technical features consume eligible canonical 1H bars or C-A's fully closed UTC-aligned 4H/1D research context; macro and event levels consume only caller-supplied canonical evidence with `availableAt <= decisionTime`. Missing inputs remain explicit per feature, so an unavailable optional series cannot fabricate a value or invalidate unrelated evidence. Versioned feature identity includes dependency/timeframe, transformation, and parameters. Output preserves source records and evidence-age metadata while granting no predictive, paper-action, price, allocation, execution, or accounting authority.

The implemented C-F shadow research harness produces immutable research-only observations by explicitly binding one integrity-validated C-D hypothesis, the exact supplied C-B or C-C rule identity, a parameter configuration inside the preregistered finite space, and one revalidated C-E feature vector at a single PIT boundary. It classifies each observation against the declared TRAIN/OOS intervals without tuning, scopes runtime inputs to declared dependencies with available feature evidence, and preserves missing required evidence as `INSUFFICIENT_EVIDENCE`. Stateless evaluation requires a non-applicable state boundary policy. Stateful evaluation requires reset or carry semantics and preserves the supplied prior-state identity, prior-state decision time, and canonical initial-state identity so later D-A validation can prove the declared boundary without duplicating C-C state construction. Stateless evaluation and stateful transition remain delegated to the existing C-B/C-C engines. Shadow results preserve hypothesis, trial-accounting, feature-evidence, rule-result, and state-transition audit identity while granting no predictive, paper-action, price, allocation, execution, accounting, or ActionDecision authority.

The implemented D-A held-out evaluator consumes existing C-F observations without rerunning rules, rebuilding features, or creating another replay engine. One result binds exactly one preregistered hypothesis/rule/configuration/trial/asset and accepts only strictly chronological observations inside the declared half-open OOS interval. It validates each C-F observation identity and authority boundary, rejects mixed or contaminated input fail-closed, proves RESET from canonical initial state, and proves CARRY through an ordered pre-OOS transition chain anchored at the same rule/asset canonical initial state, continuous through every intermediate state, and linked exactly into the first OOS prior state. Ordered witness identities remain summary identity evidence but never enter OOS counts. Its immutable output is evidence-only: `MATCH`, `NO_MATCH`, and `INSUFFICIENT_EVIDENCE` remain separately counted, and no return, PnL, win/hit rate, Sharpe, drawdown, profitability, ranking, selection, predictive-validity, or action conclusion is produced.

The implemented D-B-R1 repair adds an immutable robustness-family preregistration artifact over existing exact fixed C-D trials. A family canonicalizes a finite member set and baseline while fixing one asset, TRAIN interval, OOS interval, and stateful OOS-boundary policy. Every member resolves to one registered single-asset hypothesis with fixed parameters and one declared trial; no free-form runtime configuration can enter the family. The contract preregisters scientifically described rule/feature perturbation axes, an exact OOS decision-time grid, complete-member requirements, shared-OOS sensitivity use, no post-OOS variant selection, and non-independent-confirmation semantics. It performs no robustness evaluation, chooses no variant, establishes no predictive validity, and grants no paper-action, price, allocation, execution, or accounting authority.

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

Derived 4H/1D research context, the stateless ResearchRule/combinator foundation, bounded stateful sequence/persistence primitives, deterministic Hypothesis Registry governance, PIT-safe research feature construction, the research-only shadow observation harness, fixed-trial held-out OOS evidence aggregation, and the D-B-R1 robustness-family preregistration repair are implemented without connection to trading behavior. D-A is checkpointed at `2e3474f8640cf9abbfaa70388d3fcaec137aa9be`; D-B-R1 remains unreviewed and uncheckpointed. No hypothesis has established predictive validity or approval for paper action. D-B robustness evaluation, actual approved evidence, StrategyEligibility, evidence-gated action policy, and ActionDecision do not yet exist. Their implementation belongs to later roadmap gates and must preserve baseline replay, execution, and accounting parity.
