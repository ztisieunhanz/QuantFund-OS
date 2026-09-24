# QuantFund OS - Architectural & Product Decision Log

This document serves as the append-only architectural and product decision log for QuantFund OS.

## Entry Schema Standard

All decisions in this log follow a compact, standard format:

- **ID**: Sequential Decision Identifier (`DEC-XXX`)
- **Date**: YYYY-MM-DD
- **Status**: `ACCEPTED` | `PROPOSED` | `SUPERSEDED` | `REJECTED`
- **Decision**: Concise title and statement of the decision made
- **Rationale**: Core technical or strategic reasoning
- **Scope / Consequences**: Impacted subsystems, architecture, and developer workflows
- **Explicit Non-Goals**: What this decision intentionally does NOT cover
- **Supersedes / Superseded by**: Cross-references to prior or replacement decisions

---

## Log Entries

### DEC-001: Frozen Quant Architecture
- **ID**: `DEC-001`
- **Date**: 2026-09-20
- **Status**: `ACCEPTED`
- **Decision**: Enforce a strict unidirectional pipeline for quantitative processing:
  `Point-in-Time Data -> Alpha Engines -> Signal Normalization -> Permission Gate -> Risk Engine -> Omega Allocator -> Target Position -> Execution Engine -> Single Canonical Ledger / Audit / PnL`.
- **Rationale**: Clear separation of responsibilities prevents silent feedback loops, look-ahead bias, and competing accounting authorities.
- **Scope / Consequences**: All research, backtesting, and paper execution must pass through this exact linear pipeline. Alpha strategies (Adaptive Trend, Event Reaction, Mean Reversion) only produce signals; Omega and Risk determine weights; Execution determines fills. DCA is strictly benchmark/control.
- **Explicit Non-Goals**: Does not alter Alpha strategy mathematical formulas or tune strategy parameters.
- **Supersedes / Superseded by**: None

---

### DEC-002: Single Canonical Ledger
- **ID**: `DEC-002`
- **Date**: 2026-09-20
- **Status**: `ACCEPTED`
- **Decision**: All financial accounting, PnL tracking, cash balances, position sizes, fills, fees, and NAV calculation must belong exclusively to the single canonical execution ledger.
- **Rationale**: Rogue sub-simulations in individual strategy modules create conflicting telemetry, misinform portfolio allocators, and break accounting integrity.
- **Scope / Consequences**: Strategy modules retain only signal and research metrics. Isolated per-strategy round-trip financial tracking is removed from authority unless re-built on top of canonical ledger fills.
- **Explicit Non-Goals**: Does not prevent research modules from logging non-authoritative signal diagnostics.
- **Supersedes / Superseded by**: None

---

### DEC-003: Current Quant Time Domain = 1H
- **ID**: `DEC-003`
- **Date**: 2026-09-20
- **Status**: `ACCEPTED`
- **Decision**: The canonical executable quant engine operates strictly in a 1-hour bar domain (`QUANT_BAR_INTERVAL = "1h"`, `BAR_DURATION_MS = 3,600,000`, `BARS_PER_YEAR = 8,760`).
- **Rationale**: Hard-coded calendar-day assumptions in an hourly bar domain cause severe annualization and timing skew.
- **Scope / Consequences**: Runtime and paper execution reject unsupported bar intervals or clear stale hourly state when switching intervals. Multi-timeframe execution is explicitly deferred.
- **Explicit Non-Goals**: Does not implement multi-timeframe aggregation or sub-hourly bar domains.
- **Supersedes / Superseded by**: None

---

### DEC-004: Current Execution Semantics = Long-Only
- **ID**: `DEC-004`
- **Date**: 2026-09-20
- **Status**: `ACCEPTED`
- **Decision**: The executable portfolio operates under strict long-only constraints (non-negative asset weights). Upstream negative signals remain valid research telemetry but cannot produce short positions.
- **Rationale**: Execution engine and exchange adapters currently support long-only spot trades; claiming short allocations creates position and PnL semantics mismatches.
- **Scope / Consequences**: Omega output targets are clamped to non-negative weights prior to execution.
- **Explicit Non-Goals**: Does not rule out future short-selling engine support.
- **Supersedes / Superseded by**: None

---

### DEC-005: Truthful Data Provenance
- **ID**: `DEC-005`
- **Date**: 2026-09-20
- **Status**: `ACCEPTED`
- **Decision**: Market data items and feeds must accurately propagate data provenance (`LIVE`, `DERIVED`, `SYNTHETIC`, `UNAVAILABLE`). Synthetic or fallback data must never masquerade as factual live data.
- **Rationale**: Hidden synthetic fallbacks compromise backtest validity and mislead users/models regarding actual market conditions.
- **Scope / Consequences**: All data feeds must convey quality and source metadata end-to-end across Quant and Macro layers.
- **Explicit Non-Goals**: Does not eliminate synthetic data usage in explicitly marked synthetic simulation/test environments.
- **Supersedes / Superseded by**: None

---

### DEC-006: Do Not Rebuild the Entire Application
- **ID**: `DEC-006`
- **Date**: 2026-09-20
- **Status**: `ACCEPTED`
- **Decision**: Preserve and iterate upon existing valuable codebase assets (app routing, UI primitives, market plumbing, type definitions, repaired quant core, and test harness) rather than starting from zero.
- **Rationale**: Green-field rewrites waste existing audited work, destroy test coverage, and re-introduce solved baseline issues.
- **Scope / Consequences**: Architectural evolution is achieved through targeted refactoring and strangler migrations.
- **Explicit Non-Goals**: Does not prohibit refactoring or replacing flawed modules (e.g., legacy Macro UI).
- **Supersedes / Superseded by**: None

---

### DEC-007: Rebuild Macro + Chatbot as V2 via Strangler Migration
- **ID**: `DEC-007`
- **Date**: 2026-09-20
- **Status**: `ACCEPTED`
- **Decision**: Rebuild Macro Intelligence and Chatbot Grounding as V2 modules alongside legacy implementations using a strangler migration pattern.
- **Rationale**: Legacy `MacroView` and chatbot integration suffer from coupled responsibilities, hard-coded static arrays, and synthetic data leaks. Endlessly patching them risks regression.
- **Scope / Consequences**: Macro V2 will be built and validated in parallel. Routes will switch only after V2 passes verification, after which legacy paths will be retired.
- **Explicit Non-Goals**: Does not modify legacy Macro UI directly during M1.
- **Supersedes / Superseded by**: None

---

### DEC-008: Product Information Hierarchy
- **ID**: `DEC-008`
- **Date**: 2026-09-20
- **Status**: `ACCEPTED`
- **Decision**: All sophisticated product outputs and UI modules must structure information to answer four primary user questions:
  1. **What is happening?** (Observed factual data)
  2. **What does the model think?** (Model stance/regime)
  3. **Why?** (Underlying evidence & indicators)
  4. **How trustworthy is it?** (Data quality, freshness, coverage, uncertainty)
- **Rationale**: Prevents presenting model heuristics as objective market facts and ensures transparent model interpretation.
- **Scope / Consequences**: UI components, synthesis layers, and chatbot responses must adhere to this 4-tier communication hierarchy.
- **Explicit Non-Goals**: Does not simplify or compromise underlying quantitative model sophistication.
- **Supersedes / Superseded by**: None

---

### DEC-009: Macro V2 Layering Architecture
- **ID**: `DEC-009`
- **Date**: 2026-09-20
- **Status**: `ACCEPTED`
- **Decision**: Macro V2 must enforce three strict architectural layers:
  - **Layer 1 - Data / Macro Intelligence**: Ingests raw feeds (DXY, US2Y, US10Y, VIX, Gold, BTC, VNINDEX, liquidity, breadth, foreign flow, events) with explicit `value`, `source`, `asOf`, `freshness`, and `quality`.
  - **Layer 2 - Research / Quant**: Core engines (Alpha, Risk, Omega, Backtest, Simulation).
  - **Layer 3 - Synthesis / Human Explanation**: Combines macro data, quant state, risk envelope, and data quality into an understandable narrative.
- **Rationale**: Isolates raw data integrity from opinionated models and human-readable explanation.
- **Scope / Consequences**: Data layer cannot embed heuristic regime logic; synthesis layer cannot bypass data quality checks.
- **Explicit Non-Goals**: Does not combine Layer 1 data ingestion with Layer 3 UI components.
- **Supersedes / Superseded by**: None

---

### DEC-010: Central CurrentMarketSnapshot Contract
- **ID**: `DEC-010`
- **Date**: 2026-09-20
- **Status**: `ACCEPTED`
- **Decision**: Macro V2 components must converge on a unified, typed `CurrentMarketSnapshot` contract containing:
  - **DATA**: Observed values, changes, sources, timestamps, freshness, quality.
  - **MACRO**: Regime, evidence, conflicts, coverage.
  - **QUANT**: Alpha engine states, Risk metrics, Omega targets.
  - **SYNTHESIS**: Stance, reasons, contradictions, risks, invalidation triggers, data coverage.
- **Rationale**: A single typed contract provides a clean flow: `DATA -> CurrentMarketSnapshot -> Decision Synthesis -> Chatbot`.
- **Scope / Consequences**: Eliminates ad-hoc state assembly across UI views and chatbot prompts.
- **Explicit Non-Goals**: Does not replace lower-level quant bar series used for backtesting.
- **Supersedes / Superseded by**: None

---

### DEC-011: Strict Chatbot Grounding Rules
- **ID**: `DEC-011`
- **Date**: 2026-09-20
- **Status**: `ACCEPTED`
- **Decision**: The chatbot must explicitly categorize its context into: `OBSERVED DATA`, `MODEL OUTPUT`, `INTERPRETATION`, and `UNCERTAINTY`. It must report missing data as `UNAVAILABLE` and lower its confidence accordingly.
- **Rationale**: Prevents chatbot hallucination of market facts or confusing model opinions with actual market prices.
- **Scope / Consequences**: Prompts and context builders must provide structured `CurrentMarketSnapshot` inputs. The chatbot is strictly forbidden from fabricating missing market facts.
- **Explicit Non-Goals**: Does not restrict conversational fluency on general quantitative finance principles.
- **Supersedes / Superseded by**: None

---

### DEC-012: Macro V2 Implementation Order
- **ID**: `DEC-012`
- **Date**: 2026-09-20
- **Status**: `ACCEPTED`
- **Decision**: Execute Macro V2 development in strict sequential gates:
  1. **M1 - Macro Data Integrity** (Feeds, contracts, quality flags, `CurrentMarketSnapshot` schema)
  2. **M2 - Macro Interpretation** (Regime models, evidence mapping)
  3. **M3 - Decision Synthesis** (Unified stance, invalidation triggers)
  4. **M4 - Chatbot Grounding** (Grounded prompt pipeline, uncertainty handling)
- **Rationale**: UI designs and chatbot prompts depend entirely on truthful, robust data contracts. Building UI before data integrity leads to hard-coded hacks.
- **Scope / Consequences**: Gate M1 must be complete and verified before starting M2/M3/M4 or broad UI redesigns.
- **Explicit Non-Goals**: Does not start UI layout work during Gate M1.
- **Supersedes / Superseded by**: None

---

### DEC-013: Vietnam Market Layer 1 Scope & Data Contract
- **ID**: `DEC-013`
- **Date**: 2026-09-21
- **Status**: `ACCEPTED`
- **Decision**: Define the explicit scope, universe boundary, and accounting conventions for Layer 1 Vietnam market telemetry:
  1. **VN-Index**: Semantic instrument identifier is `"VNINDEX"` representing the official HOSE VN-Index. Yahoo-specific `"^VNINDEX"` or provider symbols belong strictly in provider adapter mappings, not in the core architecture contract.
  2. **Market Breadth**: Scope is strictly restricted to HOSE listed common equities (excluding ETFs, covered warrants, fund certificates, preferred shares, and non-common equity instruments). `advancing`/`declining`/`unchanged` are measured against the official HOSE exchange reference price. Security status handling must follow explicit provider metadata where available or fail closed if universe eligibility cannot be established. `pctAboveMA20/50/200` use dynamic eligible denominators comprising only common stocks with sufficient valid historical bars ($\ge 20/50/200$).
  3. **Liquidity**: Restricted strictly to HOSE order-matching trading VALUE in Billion VND (excluding negotiated/put-through transactions). Evaluated strictly on completed daily session basis (`ratioToMa20 = matchingValueBillion / ma20ValueBillion`). Incomplete intraday values are never compared against full-day MA20.
  4. **Foreign Flow**: Restricted strictly to HOSE foreign-investor net trading VALUE in Billion VND on a completed-session basis (`net1dBillion` = latest completed valid session, `net5dBillion` = rolling sum of latest 5 completed valid sessions). Does not mix HNX or UPCoM. Transaction-scope treatment must remain consistent across 1d and 5d without mixing negotiated and matched values.
  5. **Layer 1 Telemetry Scope**: Vietnam metrics remain supplementary Layer 1 telemetry. They do NOT enter current global `coreMetricIds` or alter Macro V2 regime scoring. Any future regime/synthesis integration requires an explicit separate decision.
  6. **Fail-Closed Provenance (DEC-005)**: Preserve strict fail-closed data integrity. No synthetic, PRNG, or hardcoded fallback data is permitted. Provider, instrument, source, and `asOf` timestamps must be truthful.
- **Rationale**: Eliminates cross-exchange skew (HNX/UPCoM), transaction-type distortion (put-through trades), ticker coupling, and time-of-day bias while upholding fail-closed data integrity.
- **Scope / Consequences**: All future Vietnam data provider adapters and contract types must conform to this HOSE-only, completed-session schema.
- **Explicit Non-Goals**: Does not alter global core macro regime scoring, introduce HNX/UPCoM feeds, or implement a specific data provider.
- **Supersedes / Superseded by**: None

---

### DEC-014: Vietnam Market Layer 1 Data Contracts & Semantics Refinement
- **ID**: `DEC-014`
- **Date**: 2026-09-21
- **Status**: `ACCEPTED`
- **Decision**: Refine and freeze Vietnam market data contracts, universe rules, session dependency, and calculation semantics:
  1. **Provider-Independent Authoritative Universe**: The eligible breadth universe is defined by the complete, verified Security Master response from the currently selected provider. Selected implementation provider is VNDirect, with parameter mapping: `floor=HOSE`, `type=STOCK`, `status=listed`. Static universe count heuristics (e.g. `< 100`) and price/volume-zero heuristics for trading status are strictly prohibited. Returned session price rows must be reconciled against the authoritative security master; missing required rows prevent truthful computation and fail closed (`status: "UNAVAILABLE"`).
  2. **Per-Datum Session Dependency & Composite Synchronization**: Each Vietnam Layer 1 metric (`vnindex`, `breadth`, `liquidity`, `foreignFlow`) evaluates session availability independently based on its own feed requirements. A failure or publication delay in `vnindex` does not invalidate `breadth` or `liquidity` if their own feed requirements are satisfied. Composite UI presentation or chatbot grounding that claims a single unified Vietnam session requires explicit date equality (`D_vnindex == D_stock == D_foreign`). Otherwise, per-metric session dates must be explicitly displayed.
  3. **Nullable AD Ratio Contract**: `VietnamBreadthData.adRatio` is typed as `number | null`. If `declining > 0`, `adRatio = advancing / declining`. If `declining == 0`, `adRatio = null`. Zero division, denominator 1 substitution, infinity, or advancing count substitution are prohibited.
  4. **Moving Average Breadth Semantics (Option A) & Per-Security History**: `pctAboveMA_H(D) = count(close_D > SMA_H) / count(securities with H valid closes) * 100`. `SMA_H` includes session D close (`H` in `{20, 50, 200}`). MA calculation requires per-security historical EOD close state (`Map<symbol, Array<{date, close}>>`) up to 200 completed sessions. Securities with fewer than H valid completed session closes (such as newly listed stocks) are excluded from both numerator and denominator for horizon H. `pctAboveMA20`, `pctAboveMA50`, and `pctAboveMA200` are typed as `number | null` to support independent availability during cold-start or incomplete historical state. Forward fill, interpolation, and synthetic history generation are strictly prohibited.
  5. **Instrument Scope Alignment**: Breadth, Liquidity (`nmValue`), and Foreign Flow (`netVal`) are restricted strictly to common equities (`floor:HOSE~type:STOCK`). Basis metadata tags: `"HOSE_COMMON_EQUITY_NORMAL_MATCHED_VALUE_BILLION_VND"` and `"HOSE_COMMON_EQUITY_FOREIGN_NET_VALUE_BILLION_VND"`.
  6. **Bounded Transport Pagination**: Pagination iteration is bounded by provider `totalPages` metadata. An operational guard (50 pages) acts purely as transport safety. Exceeding the guard returns `status: "UNAVAILABLE"` and never truncates successful results.
  7. **Preservation of Macro V2 Synthesis Contract (DEC-013)**: Vietnam market metrics remain supplementary Layer 1 telemetry. They MUST NOT alter current global macro regime scoring, confidence, or stance.
- **Rationale**: Establishes provider-independent universe integrity, strict mathematical handling of zero denominators and incomplete historical observations, independent per-metric session availability, and bounded transport execution without corrupting macro regime scoring.
- **Scope / Consequences**: All Vietnam Layer 1 provider adapters, parsers, and type contracts must strictly implement these rules.
- **Explicit Non-Goals**: Does not alter global core macro regime scoring or implement provider transport/parsers in this sub-gate.
- **Supersedes / Superseded by**: None

---

### DEC-015: Historical PIT Data Boundary
- **ID**: `DEC-015`
- **Date**: 2026-09-22
- **Status**: `ACCEPTED`
- **Decision**: Historical replay consumes only market observations, macro release vintages, and event records strictly available at or before decision time (`availableAt <= decisionTime`). Future revisions, subsequent publication updates, and future events never leak backward into past decision states.
- **Rationale**: Preserves strict point-in-time anti-lookahead integrity across backtest and paper replay.
- **Scope / Consequences**: All historical market and macro data must carry verified availability timestamps (`availableAt`). Deterministic lookup functions (`getLatestMarketObservationAt`, `getLatestMacroReleaseAt`, `getLatestEventAt`) filter by decision timestamp. Replay states are future-suffix invariant.
- **Explicit Non-Goals**: Does not synthesize or backfill missing historical data timestamps with synthetic heuristics.
- **Supersedes / Superseded by**: None

---

### DEC-016: Canonical Historical Price Authority
- **ID**: `DEC-016`
- **Date**: 2026-09-22
- **Status**: `ACCEPTED`
- **Decision**: `BacktestDataset.assetBars` is the sole canonical source for executable asset prices, replay bar iteration, execution fills, NAV marking, and benchmark/risk price history. `HistoricalDataset` factor observations (`observations`) are purely explanatory/audit signals and cannot override or substitute executable price series.
- **Rationale**: Dual price series in replay engines create conflicting accounting authorities, fill price divergence, and hidden execution look-ahead.
- **Scope / Consequences**: `HistoricalDataset.marketBars` is permanently removed. Backtest engine bar loops iterate strictly on `BacktestDataset.assetBars`.
- **Explicit Non-Goals**: Does not eliminate macro factor observations (e.g. DXY, VIX, yields) from `HistoricalDataset.observations`.
- **Supersedes / Superseded by**: None

---

### DEC-017: Historical Context Is Audit-First
- **ID**: `DEC-017`
- **Date**: 2026-09-22
- **Status**: `ACCEPTED`
- **Decision**: Point-in-time historical macro and factor context attached to `DecisionState` (`historicalContext`) serves strictly as audit and telemetry context unless a separately approved, validated quantitative model explicitly consumes it.
- **Rationale**: Prevents unverified ad-hoc macro heuristic models from mutating baseline strategy signals or permission gates without formal research gates.
- **Scope / Consequences**: Baseline Alpha strategies (Adaptive Trend, Mean Reversion) and PermissionGate continue operating on their verified core inputs. Historical CPI/NFP/FOMC events lacking verified consensus remain EventReaction-ineligible (0 event alpha).
- **Explicit Non-Goals**: Does not prohibit future approved research gates from developing validated historical macro alpha models.
- **Supersedes / Superseded by**: None

---

### DEC-018: Walk-Forward Historical Carry-Forward
- **ID**: `DEC-018`
- **Date**: 2026-09-22
- **Status**: `ACCEPTED`
- **Decision**: Walk-forward rolling OOS evaluation fold boundaries are evaluation boundaries, not public knowledge or macroeconomic publication reset boundaries. Sliced fold historical datasets carry forward the latest already-known pre-fold observations and vintages (`availableAt <= foldStart`) to seed fold context, while strictly excluding all records published after fold end (`availableAt > foldEnd`).
- **Rationale**: Macroeconomic state (e.g. GDP, CPI, Fed Funds rate) known prior to fold start does not cease to exist when an evaluation window opens. Resetting to null would create artificial historical blindness.
- **Scope / Consequences**: `sliceHistoricalDataset()` preserves latest pre-fold observation per series, latest pre-fold release per series, and at most one latest pre-fold event, plus all in-fold records.
- **Explicit Non-Goals**: Does not carry forward financial execution state (cash, positions, PnL, open orders) between folds; execution state remains strictly fold-isolated.
- **Supersedes / Superseded by**: None

---

### DEC-019: Finite v1 Release Roadmap
- **ID**: `DEC-019`
- **Date**: 2026-09-22
- **Status**: `ACCEPTED`
- **Decision**: M17 is the final pre-release major gate. Validity fixes, data/provider issues, UI defects, and reliability refinements remain inside M13–M17 as `Mxx-Rn`. New feature scope moves to the post-v1 backlog unless the user explicitly approves a roadmap change.
- **Rationale**: A finite roadmap prevents autonomous milestone expansion and preserves a testable definition of v1.0.
- **Scope / Consequences**: Agents must follow `ROADMAP_V1.md` and may propose a roadmap change only for a fundamental blocker that changes the definition of v1.0.
- **Explicit Non-Goals**: Does not prohibit explicitly approved post-v1 planning.
- **Supersedes / Superseded by**: None

---

### DEC-020: Action-First Product Direction
- **ID**: `DEC-020`
- **Date**: 2026-09-22
- **Status**: `ACCEPTED`
- **Decision**: Research exists to inform deterministic paper actions; the product goal is grounded actionable state rather than unbounded analytics. `WAIT` is a first-class valid action. All v1.0 actions remain research/paper actions.
- **Rationale**: Users need a coherent decision state while preserving research discipline and avoiding claims of live investment execution.
- **Scope / Consequences**: Research outputs require explicit evidence and policy integration before they may affect paper actions.
- **Explicit Non-Goals**: Does not authorize real-money execution or guarantee actionable edge.
- **Supersedes / Superseded by**: None

---

### DEC-021: Canonical 1H Execution with Derived Multi-Timeframe Context
- **ID**: `DEC-021`
- **Date**: 2026-09-22
- **Status**: `ACCEPTED`
- **Decision**: The executable domain remains 1H. Future 4H and 1D context must be derived solely from fully closed eligible 1H bars available at decision time. Unfinished derived bars are invisible and derived context cannot become an alternative executable-price authority.
- **Rationale**: Derived context can enrich research without fragmenting timestamp semantics, fills, accounting, or price authority.
- **Scope / Consequences**: `BacktestDataset.assetBars` remains authoritative; additional execution domains require separate approval and are post-v1 by default.
- **Explicit Non-Goals**: Does not implement derived bars or authorize 15m/multi-domain execution.
- **Supersedes / Superseded by**: None

---

### DEC-022: Extensible Research Rule Architecture
- **ID**: `DEC-022`
- **Date**: 2026-09-22
- **Status**: `ACCEPTED`
- **Decision**: Research rules and hypotheses will be modular and capable of expressing multi-indicator, parameterized, sequential/stateful, derived-timeframe, and macro-conditioned technical logic without changing canonical execution or accounting architecture.
- **Rationale**: Research extensibility must not create strategy-specific bypasses or force repeated changes to financial infrastructure.
- **Scope / Consequences**: Rules produce research evidence or candidate intent; they do not decide final position size, and candidate status does not imply action eligibility.
- **Explicit Non-Goals**: Does not implement the rule engine or approve any particular rule.
- **Supersedes / Superseded by**: None

---

### DEC-023: Evidence-Gated Action Policy
- **ID**: `DEC-023`
- **Date**: 2026-09-22
- **Status**: `ACCEPTED`
- **Decision**: Research must pass declared OOS and robustness evaluation before action eligibility. Evidence states are `CANDIDATE`, `APPROVED_FOR_PAPER`, `REJECTED`, and `INSUFFICIENT_EVIDENCE`. `ActionDecision` must never consume unapproved research evidence.
- **Rationale**: Separating hypothesis generation from action eligibility prevents in-sample findings or weak evidence from silently becoming policy.
- **Scope / Consequences**: Approval applies only to paper use and remains subject to StrategyEligibility, Permission, Risk, and Omega.
- **Explicit Non-Goals**: Does not define thresholds, approve current macro evidence, or implement action policy.
- **Supersedes / Superseded by**: None

---

### DEC-024: ActionDecision as Product-Facing Single Source of Truth
- **ID**: `DEC-024`
- **Date**: 2026-09-22
- **Status**: `ACCEPTED`
- **Decision**: `ActionDecision` is the target single source of truth for describing product-facing action state. A pure, deterministic `ActionDecision Builder` derives it from canonical target weight and current canonical portfolio state for UI/chatbot consumption. It cannot modify target weight, bypass Permission/Risk/Omega/Execution, or become a second allocation, execution, accounting, or financial authority. The chatbot must not independently manufacture an action.
- **Rationale**: One typed action contract prevents contradictory UI, chatbot, and execution-facing narratives.
- **Scope / Consequences**: `WAIT`, `ENTER`, `ADD`, `HOLD`, `REDUCE`, and `EXIT` are derived action semantics. If no approved actionable evidence exists, `WAIT` / no action is valid. Existing `CurrentMarketSnapshot` grounding requirements remain applicable.
- **Explicit Non-Goals**: Does not claim `ActionDecision` is implemented or authorize chatbot-driven trading.
- **Supersedes / Superseded by**: None

---

### DEC-025: v1 Release Does Not Require Macro Alpha
- **ID**: `DEC-025`
- **Date**: 2026-09-22
- **Status**: `ACCEPTED`
- **Decision**: v1.0 does not require a macro model to demonstrate actionable alpha. If evidence is insufficient or rejected, macro data remains explanatory/context-only and release may proceed.
- **Rationale**: Product validity depends on truthful evidence and safe behavior, not on forcing a positive research result.
- **Scope / Consequences**: Macro research cannot be promoted without evidence, and lack of promotion is not a release blocker.
- **Explicit Non-Goals**: Does not prevent future approved macro research.
- **Supersedes / Superseded by**: None

---

### DEC-026: Recovery and Portability Principle
- **ID**: `DEC-026`
- **Date**: 2026-09-22
- **Status**: `ACCEPTED`
- **Decision**: Git history, tests, source-of-truth documents, and CI evidence define recoverable project state. Coding agents are replaceable workers. Uncommitted work must never be destructively discarded because an agent, provider, or quota fails.
- **Rationale**: Durable evidence and non-destructive handoff keep the project portable across tools and failures.
- **Scope / Consequences**: Follow `RECOVERY_AND_BACKUP.md`; inspect and preserve status/diff/untracked evidence before continuing the same gate with another agent.
- **Explicit Non-Goals**: Does not treat chat memory as recovery evidence or authorize secrets in handoff bundles.
- **Supersedes / Superseded by**: None

---

### DEC-027: Preregistered Stateful OOS Boundary Policy
- **ID**: `DEC-027`
- **Date**: 2026-09-24
- **Status**: `ACCEPTED`
- **Decision**: Every research hypothesis explicitly preregisters its stateful TRAIN→OOS boundary policy as `NOT_APPLICABLE`, `RESET_AT_OOS_START`, or `CARRY_PIT_STATE_FROM_PRE_OOS`. The policy participates in scientific semantic identity and cannot be selected or changed after OOS inspection. Stateless rules require `NOT_APPLICABLE`; stateful rules require RESET or CARRY when the concrete rule is supplied to the shadow harness.
- **Rationale**: Resetting state and carrying strictly earlier PIT-safe state can produce different OOS sequence and persistence evidence. Making the choice per hypothesis and identity-bearing prevents post-OOS methodology selection while allowing both legitimate research designs.
- **Scope / Consequences**: RESET requires the first OOS prior state to equal the rule/asset canonical initial state. CARRY requires a valid strictly earlier PIT-safe transition chain whose next state equals the first OOS prior state. C-F preserves the policy and state-identity proof material; D-A must validate the declared boundary before aggregation.
- **Explicit Non-Goals**: Does not choose a global policy, implement D-A aggregation, establish predictive validity, approve paper action, or grant trading authority.
- **Supersedes / Superseded by**: None
