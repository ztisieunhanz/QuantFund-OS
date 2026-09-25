# QuantFund-OS v1.0 Roadmap

This is the finite pre-release roadmap for the public research and paper-trading application. Gate refinements use `Mxx-R1`, `Mxx-R2`, and so on; they do not create new major gates.

## M13 — Historical research and evidence

- **M13B — Data foundation and acquisition**: research-data protocol, provider acquisition, immutable PIT snapshots, provenance, coverage, and readiness.
- **M13C — Extensible rule engine and derived multi-timeframe research**: modular hypotheses, parameterized/stateful rules, and 4H/1D context derived only from closed eligible 1H bars.
- **M13D — OOS, robustness, and evidence classification**: held-out evaluation, robustness checks, and evidence status assignment. The D-C audit found no current v1 component that learns or calibrates parameters from TRAIN data, so a separate training/calibration lane is intentionally not required unless a future preregistered methodology introduces genuine TRAIN-only fitting with frozen outputs before OOS.

## M14 — Action layer integration

Integrate integrity-validated evidence through `StrategyEligibility`, candidate intent, Permission, Risk, Omega, target allocation, and the product-facing `ActionDecision`. StrategyEligibility is paper-evaluation admission, not predictive validation or paper-action approval. Scope is paper-only and must prove replay/OOS parity with the canonical pipeline.

A-01 StrategyEligibility and the partial A-02 `ActionDecision` contract are checkpointed. A-03 freezes the six long-only lifecycle meanings but remains partial: `WAIT` is the only constructible action, while canonical current/target/gate binding, comparison tolerance, pending-execution lifecycle, and all non-WAIT derivation remain deferred to A-04. This does not alter the M14 authority chain or authorize execution.

## M15 — Production data, backend, and reliability

Implement provider adapters, same-origin/server gateways, secrets handling, caching, freshness, retries, outage behavior, persistence, recovery, monitoring, immutable research snapshots, and backup/restore foundations.

## M16 — Product, UI, and deployment hardening

Deliver the action-first dashboard, grounded chatbot, research/rule visibility, loading/error/stale states, responsive behavior, performance work, and deployment configuration.

## M17 — Final release candidate and acceptance

M17 is the **final pre-release major gate**. It must verify clean installation, full regression, production build, provider-outage behavior, restart/recovery, backup/restore, rollback, security/configuration audit, smoke/E2E coverage, and release acceptance.

## v1.0 — Public research / paper app

Release follows accepted M17 evidence.

## Roadmap ceiling

- Agents must not autonomously create M18, M19, or later pre-release major gates.
- Bugs, validity failures, data/provider issues, UI defects, and reliability work must be absorbed into the appropriate existing M13–M17 gate as `Mxx-Rn`.
- New product scope belongs in `POST_V1_BACKLOG.md` unless the user explicitly changes this roadmap.
- Only a fundamental blocker that changes the definition of v1.0 may justify proposing a roadmap change, and that requires explicit user approval.

## v1.0 non-goals

- Real-money automated execution or broker integration
- Short-selling architecture expansion
- Options
- Arbitrary multi-timeframe execution domains; 1H remains canonical
- AI-autonomous parameter optimization
- Guaranteed alpha or profitability
- Mandatory macro alpha

Failure to establish actionable macro edge does not block v1.0. Macro data may remain explanatory and context-only.
