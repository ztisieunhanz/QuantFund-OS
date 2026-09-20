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
