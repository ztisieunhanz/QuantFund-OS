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

The implemented D-B evaluator consumes one integrity-validated D-B-R1 family and revalidates each member's supplied C-F observations through D-A. Every declared member must be present exactly once; unexpected, duplicate, mixed, or outside-grid evidence fails closed. Missing preregistered grid points remain explicit `INSUFFICIENT_EVIDENCE` without fabricated observations. For stateful RESET/CARRY members, every supplied observation after the first missing expected transition is also retained but classified as lineage-unproven insufficient evidence; D-B never bridges state across an unobserved required grid transition. Stateless later observations remain independently usable. Its immutable output reports only per-member categorical `MATCH`, `NO_MATCH`, and insufficient-evidence counts plus completeness and lineage evidence. Shared OOS remains descriptive sensitivity evidence, never independent confirmation, ranking, selection, a robustness conclusion, predictive validity, or economic performance evidence. The evaluator grants no paper-action, price, allocation, execution, accounting, or ActionDecision authority.

The D-C necessity audit found no implemented v1 research path that learns, fits, estimates, optimizes, selects, or calibrates a parameter or model quantity from TRAIN data. Current trials are exact preregistered configurations; finite candidate spaces and D-B families are trial-accounting and descriptive sensitivity contracts, not selection mechanisms. TRAIN is used only for declared interval classification, eligible pre-roll/context, and auditable state-boundary evidence. Therefore a separate D-C training/calibration lane is intentionally not required for current v1. A future train-fitted model must first introduce an independently reviewed, preregistered TRAIN-only fitting contract that fixes its inputs and objective, gives the frozen fitted output a deterministic identity, and keeps OOS untouched; D-B shared-OOS evidence cannot be used for that fitting or selection.

The implemented D-D Evidence Registry converts integrity-validated C-D, D-A, and optional D-B artifacts into deterministic immutable research evidence records without rerunning rules, rebuilding features, replaying OOS, or re-evaluating robustness. Each record preserves exact hypothesis, rule, parameter configuration, trial, asset, TRAIN/OOS, state-policy, D-A, optional D-B, and provenance identities. Current M13 methodology supports only `CANDIDATE` for complete evaluable evidence and `INSUFFICIENT_EVIDENCE` for incomplete, unusable, or non-evaluable required evidence. `APPROVED_FOR_PAPER` remains unavailable because no preregistered promotion contract or validated predictive/economic threshold exists; `REJECTED` remains unavailable because no machine-executable falsification contract exists. D-B shared OOS remains descriptive, non-selecting, and non-independent. The registry is not `StrategyEligibility`, establishes no predictive validity, grants no paper-action, price, allocation, execution, accounting, or `ActionDecision` authority, and has no direct path to the decision or execution planes.

The implemented A-01 `StrategyEligibility` contract is a deterministic paper-evaluation admission gate, not an alpha or approval engine. It consumes the complete integrity-validated D-D registry and its canonical C-D scientific-integrity witness, then applies one fixed versioned non-performance policy to every evidence entry. `ELIGIBLE_FOR_PAPER_EVALUATION` requires an M13 `CANDIDATE` with complete declared D-B shared-OOS sensitivity evidence. `INSUFFICIENT_EVIDENCE` maps to `INELIGIBLE_INSUFFICIENT_EVIDENCE`; a candidate without required D-B evidence maps to `INELIGIBLE_REQUIRED_SHARED_OOS_EVIDENCE_ABSENT`. No entry may be dropped or selected by the caller. Eligibility does not mean proven alpha or `APPROVED_FOR_PAPER`; predictive validity and paper-action approval remain false. D-B remains descriptive, non-selecting, and `independentConfirmation = false`. The contract produces no signal, candidate intent, Permission, Risk, allocation, target weight, execution, accounting, or `ActionDecision` authority.

These research-plane components are target architecture unless separately identified as implemented. Historical context remains audit-first today.

## Decision plane target

```text
Integrity-Validated M13 Evidence
  → StrategyEligibility
  → Paper-Evaluation-Eligible Evidence
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

`ActionDecision` is the target single source of truth for describing product-facing action state. It is a pure, deterministic contract derived from canonical target weight and current canonical portfolio state. It cannot modify target weight or bypass Permission, Risk, Omega, or Execution. It is not a second allocation, execution, accounting, or financial authority.

The implemented A-02 contract is intentionally partial. The current repository has canonical Omega `TargetPortfolioWeight` values and canonical ledger positions/cash, but it does not yet expose identity-bearing bindings that jointly prove current portfolio weight, authorized target weight, Permission/Risk provenance, valuation time, and pending-execution state. A-02 therefore accepts none of those values from callers and can construct only `WAIT`, with all authority-bearing inputs explicitly unavailable. The partial artifact is immutable, deterministic, product-explanatory only, and cannot be consumed by Execution as target authority.

The implemented A-03 lifecycle methodology freezes the long-only meanings of `WAIT`, `ENTER`, `ADD`, `HOLD`, `REDUCE`, and `EXIT` while remaining partial. `WAIT` means no currently provable authorized transition; it is distinct from `HOLD`, which requires proven positive exposure materially equal to a proven authorized target. The five non-WAIT labels retain their zero/positive and relative-target meanings but remain non-constructible. No canonical weight tolerance exists, `TargetPortfolioWeight` has no durable lifecycle identity, current weight lacks an identity-bearing valuation binding, and the replay engine's pending target is not persisted in `DecisionState`. A-03 therefore defers numeric comparison, repeated/outstanding/partial/completed-target classification, and non-WAIT derivation to A-04 rather than inventing state or an epsilon.

A-04 Step 1 adds browser-safe deterministic producer provenance at the existing Signal, Permission, Risk, and Omega target boundaries. Each producer binds its actual available inputs/configuration and exact output to a reconstructable semantic identity. Omega targets separate time-independent target-content identity from decision identity, which additionally binds decision time and upstream Signal/Permission/Risk/configuration/correlation lineage. This provenance does not change any economic calculation or authority: Omega remains the sole target-weight producer, Execution still consumes `TargetPortfolioWeight` directly, and Risk explicitly records canonical valuation provenance as deferred to A-04 Step 2. No non-`WAIT` `ActionDecision` is enabled; Steps 2-6 remain unimplemented.

A-04 Step 2 adds `CanonicalPortfolioValuationSnapshot` as an immutable derived witness, never a ledger. Canonical `PointInTimeBar.timestamp` is the 1H candle-open time, so a final CLOSE is eligible only at `timestamp + 1H`; the replay witness values the post-prior-target execution account using the exact latest bar whose close availability equals `decisionTime`, before the newly issued Omega target can execute. The snapshot binds decision time, explicit close `availableAt`, exact cash and position records, held-asset mark evidence, mechanically derived market values/NAV/current weights, account identity, and valuation identity. It rejects missing, duplicate, stale/future, conflicting, non-finite, non-positive, mismatched, short, or synthetic evidence rather than forward-filling or accepting caller-authored weights. Risk binds the exact valuation identity only on this proven canonical path; synthetic replay and the standalone live adapter retain an explicit unbound compatibility status. The `1e-12` weight-sum guard is floating-point reconciliation only and cannot classify `ENTER` / `ADD` / `HOLD` / `REDUCE` / `EXIT`. The execution account remains sole accounting authority, and no snapshot is routed into Execution.

A-04 Step 3/R1 separates decision-bound relationship evidence from execution-bound lifecycle evidence without inserting either into the authority chain. `TargetExecutionAssessment` relates one exact Step-2 close valuation to one identity-valid Omega target and can describe the rebalance that would be required, but it cannot prove a future fill, partial execution, or completion. The ExecutionEngine and both pre/post execution assessments reuse one immutable versioned rebalance planner, including the existing default USD 50 boundary and the rule that exact zero delta is never executable even when a custom threshold is zero. Canonical fills may carry reconstructable bindings to the exact target decision, stable active root, pre-execution account, and execution plan. `ExecutionBoundTargetAssessment` then binds those fills, deterministic pre/post account identities, exact next-1H-open price evidence, the post-fill Step-2 valuation, and executable residuals. Fixed-bps slippage needs no current-candle volume; volume-dependent models remain invalid for this lifecycle proof until PIT-available execution-volume evidence is established. The assessment classifies satisfied, partially satisfied, outstanding/unexecuted, or invalid/unprovable; missing price, time, provenance, account, fill, or lineage evidence never manufactures completion.

`ActiveTargetLifecycle` reconciles only this execution-bound evidence for partial/completed execution. Repeated-target recognition uses a separately named economic identity over asset weights, cash weight, gross exposure, and net exposure. Rationale, strategy attribution, risk adjustment, and upstream explanatory lineage remain preserved in target provenance and decision identity but do not manufacture a new economic root. Same economic content preserves an unresolved root across partial execution; changed economic allocation creates a new root from the current canonical post-fill valuation; and a completed target that later becomes unsatisfied starts a new root. Every retained execution assessment is revalidated against its artifact identity, stable root, economic target, and bounded time lineage; a historical assessment is not required to impersonate a later reaffirmed target decision. Canonical LIVE next-open replay now carries this binding transiently through Execution and emits separate in-memory lifecycle audit evidence after reconstructing the actual result and post-fill valuation. It does not add a sidecar to `DecisionState`, alter execution economics, or create durable persistence. No lifecycle weight epsilon is introduced, and the Step-2 `1e-12` reconciliation guard remains irrelevant. Durable persistence remains deferred to Step 5. Step 4 remains responsible for non-`WAIT` ActionDecision classification, and none of this evidence can modify targets, fills, accounting, Permission, Risk, or Omega.

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

Derived 4H/1D research context, the stateless ResearchRule/combinator foundation, bounded stateful sequence/persistence primitives, deterministic Hypothesis Registry governance, PIT-safe research feature construction, the research-only shadow observation harness, fixed-trial held-out OOS evidence aggregation, D-B-R1 robustness-family preregistration, descriptive shared-OOS D-B evaluation, and the D-D research Evidence Registry are implemented without connection to trading behavior. D-A is checkpointed at `2e3474f8640cf9abbfaa70388d3fcaec137aa9be`; D-B-R1 is checkpointed at `5dfa01c0fbec51893293832c4ca7599c7b8f6490`; D-B is checkpointed at `61722d9639a49083ad052fccf5a286caaf95ad1a`; the D-C not-required audit is checkpointed at `14ac61c888e5ba5b34070a455cdda98c005af31e`; D-D/D-D-R1 are checkpointed at `901c687a79a01b663d33c539fb6a6a9960c5430a`; A-01 StrategyEligibility is checkpointed at `d74adfd2c5b062b182a51c38922605b04b1901ee`; A-02 is checkpointed at `761353b59f092ac3511781f9de5e0538264bd755`; A-03 is checkpointed at `f70085027d2da235ca9647db0b4cb1086351a7f6`; A-04 Step 1 is checkpointed at `da599a325fc8c20f9d32e6ba091a14e9861e1d01`; and A-04 Step 2/R1 is checkpointed at `aa8fb7379b5dcaf9bc97d0104c805b3a55b6aaa0`. No hypothesis has established predictive validity or approval for paper action. A-04 Step 3 execution assessment and target lineage are implemented for independent review. Non-`WAIT` derivation remains deferred to Step 4, persistence/replay integration to Step 5, and all work must preserve baseline replay, execution, and accounting parity.
