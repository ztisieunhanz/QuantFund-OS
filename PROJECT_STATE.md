# QuantFund OS — Project State

## 1. Source of Truth

This file is a project navigation document.

The actual Git repository, source code, tests, and verified Git history remain the authoritative source of truth.

If this document disagrees with the repository, the repository wins and this file must be corrected.

Before any major architecture decision, forensic repair plan, or coding-agent prompt:

1. verify the current Git HEAD;
2. verify working-tree status;
3. read this file;
4. read `DECISIONS.md`;
5. inspect the relevant current source files.

Do not rely only on AI memory or previous agent reports.

---

## 2. Current Verified Checkpoint

- **Repository**: `ztisieunhanz/QuantFund-OS`
- **HEAD Commit**: `49e42dea219069600fb0ba67495cef0598769540`
- **Commit Message**: `Gate 2A: repair core quant validity`
- **Gate Statuses**:
  - **Gate 0** (Build / Type Contract Repair): **COMPLETE**
  - **Gate 1** (Forensic Audit): **COMPLETE**
  - **Gate 2A** (Core Quant Validity Repair): **COMPLETE**
- **Latest Verification Results**:
  - `npm run build`: **PASS**
  - `npx vitest run`: **PASS** (24/24 tests across 3 test files)
  - `git diff --check`: **PASS**
- **Working Tree State**: Clean immediately following Gate 2A commit.

---

## 3. Frozen Architecture

The canonical QuantFund OS processing pipeline is:

```
POINT-IN-TIME DATA
  ↓
ALPHA ENGINES (Adaptive Trend, Event Reaction, Mean Reversion)
  ↓
SIGNAL NORMALIZATION
  ↓
PERMISSION GATE
  ↓
RISK ENGINE
  ↓
OMEGA ALLOCATOR
  ↓
TARGET POSITION
  ↓
EXECUTION ENGINE
  ↓
SINGLE CANONICAL LEDGER / AUDIT / PnL
```

### Alpha Engines
- Adaptive Trend
- Event Reaction
- Mean Reversion

### Benchmark & Control Policy
- DCA (Dollar-Cost Averaging) is benchmark/control only.
- DCA must never participate in Omega allocation or become a fallback allocator.
- DCA must never alter Alpha/Omega portfolio PnL or decisions.

---

## 4. Core Non-Negotiable Invariants

### Architectural Layer Separation
- **Signal != Permission**: An Alpha engine generates signal metrics, not authorization to trade.
- **Permission != Risk**: Being permitted to trade does not dictate risk limits.
- **Risk != Allocation**: Risk boundaries define safe envelopes, not optimal asset weights.
- **Allocation != Execution**: Target position weights require execution mechanics (order timing, slippage, fills) to become trades.
- **Alpha does not decide final position size**: Omega and Risk control position sizing.
- **Omega does not manufacture alpha**: Omega operates on existing Alpha, Permission, and Risk signals.

### Point-in-Time & Execution Integrity
- **No future information**: No future data may influence decisions at time T.
- **Point-in-Time execution**: All decisions use strictly available point-in-time state.
- **Explicit execution timestamps**: Every execution is timestamped. `NEXT_BAR_OPEN` means decision at bar T executed at bar T+1 OPEN.

### Determinism & Research Discipline
- **Determinism**: Same input data + config + seed strictly yields the same result. Unseeded `Math.random` is prohibited in validation fixtures.
- **No superficial tuning**: Parameters and strategy formulas must never be tuned merely because a backtest or test result looks bad.

### Single Canonical Ledger & Provenance
- **Single Canonical Ledger**: Financial PnL, cash, positions, fills, and NAV belong exclusively to the canonical execution ledger. Alpha engines cannot maintain authoritative competing ledgers.
- **No Rogue Simulation**: Alpha engines must not manufacture authoritative financial accounting telemetry.
- **Truthful Market Provenance**: Synthetic data must never be presented or flagged as real/live market history. `LIVE` maps to live feeds; `SYNTHETIC` maps to synthetic data.

### Domain & Portfolio Semantics
- **1H Time Domain**: The canonical executable quant engine operates strictly on 1H bars (`QUANT_BAR_INTERVAL = "1h"`, `BAR_DURATION_MS = 3,600,000`, `BARS_PER_YEAR = 8,760`).
- **Long-Only Execution**: The current executable portfolio is strictly long-only. Negative Alpha signals remain valid research telemetry, but final executable target asset weights must not claim short positions (non-negative weights).

---

## 5. Gate 2A Completed Repairs

Gate 2A addressed and repaired the following core validity issues:

1. **Canonical 1H Time Domain**:
   - Explicitly defined constants: `QUANT_BAR_INTERVAL = "1h"`, `BAR_DURATION_MS = 3,600,000`, `BARS_PER_YEAR = 8,760`.
   - Annualization aligned to hourly BTC/24x7 trading domain.

2. **Explicit Replay Market Context**:
   - Market context (interval + data source) is explicitly propagated through quant pipeline.
   - Unsupported bar intervals block canonical quant execution.
   - Stale 1H quant state is cleared when switching to unsupported bar intervals.

3. **Macro/Event PIT Contamination Seam**:
   - `PaperEngine` adapter no longer projects current/live macro values into historical replay.
   - `macroTimeline` and `eventTimeline` remain empty until genuine historical point-in-time ingestion exists.

4. **Truthful Market Provenance**:
   - Live data sources map strictly to `LIVE`.
   - Synthetic sources map strictly to `SYNTHETIC`.
   - Hidden default-to-LIVE replay paths eliminated.

5. **Rogue Alpha Sub-Ledger Removed**:
   - Removed rogue sub-simulation authority from strategy layer.
   - Alpha engines restricted to signal/research telemetry.
   - Per-strategy round-trip trade reconstruction deferred until canonical attribution exists.

6. **Fabricated Strategy-PnL Correlation Removed**:
   - Eliminated synthetic `alphaScore × portfolio-PnL` proxies fed into Omega allocator.
   - Strategy correlation remains null/unavailable until genuine PnL attribution is built.

7. **Long-Only Semantic Repair**:
   - Preserved upstream negative alpha signals as research telemetry.
   - Guaranteed executable Omega target weights remain non-negative in the long-only execution context.

8. **Deterministic Validation Fixtures**:
   - Replaced unseeded `Math.random()` fixtures with seeded, deterministic test datasets and hourly timestamps.

9. **Targeted Invariant Tests Added (24/24 PASS)**:
   - Event expiry in hourly bar domain.
   - `NEXT_BAR_OPEN` execution timing.
   - Long-only target weight clamping.
   - Rogue Alpha ledger absence.
   - Fabricated correlation absence.
   - Provenance mapping accuracy.
   - `PaperEngine` empty macro/event dataset seam.
   - Stale-state clearing on unsupported interval.
   - Multi-run test determinism.

---

## 6. Preserved Audit Findings (Not Proven Defective)

The following Gate 1 claims were audited and determined NOT to be core defects requiring code changes:

- **Slippage `baseBps` Conversion**: Slippage `baseBps` conversion was not proven defective (`0.0005 × 10000 = 5 bps` is mathematically consistent).
- **NEXT_BAR_OPEN Close Marking**: Executing at T+1 open and marking the resulting position at T+1 close is not by itself evidence of look-ahead.
- **End-of-Bar NAV Close Marking**: End-of-bar NAV marked at close is not inherently invalid.
- **Slippage Metric Reporting**: A separately reported slippage-cost metric is not automatically accounting double-counting.

---

## 7. Open / Deferred Technical & Macro Risks

### Deferred Quant Engineering
- Genuine historical point-in-time macro ingestion.
- Genuine historical point-in-time event/news ingestion.
- Genuine per-strategy PnL attribution.
- Round-trip trade reconstruction and authoritative trade win-rate.
- Multi-timeframe quant engine support.
- Short-selling support and margin semantics.
- Broader walk-forward methodology and aggregate metric updates.
- Further Adaptive Trend persistence research.
- Mean Reversion research improvements.
- `liveRuntime` / execution API production hardening.

### Legacy Macro Risks (To Be Addressed in Macro V2)
Inspection of legacy Macro code revealed structural risks that require audit and redesign:
- **Synthetic Fallback Contamination**: Synthetic fallback paths can blend into apparently current macro state.
- **Misleading Provenance**: Derived or substitute market metrics lack explicit data quality lineage.
- **Hard-coded Data**: Vietnam market breadth, liquidity, and foreign flow contain hard-coded static arrays.
- **Heuristic Output Presented as Authority**: Macro regime and allocation outputs are heuristic and must be represented as model interpretation rather than objective factual truth.
- **Coupled Responsibilities**: Chatbot context mixes data retrieval, model evaluation, and UI rendering; `MacroView.tsx` currently owns excessive monolithic logic.

---

## 8. Required Workflow

For every major engineering gate:

1. Verify current Git HEAD and working-tree state.
2. Read `PROJECT_STATE.md` and `DECISIONS.md`.
3. Independently inspect relevant current source.
4. Define a narrow gate specification.
5. Coding agent edits the real local repository and runs real tests.
6. Coding agent does NOT commit or push before independent review.
7. Independently review the actual diff, not only the agent summary.
8. Only reviewed changes are checkpointed.
9. Verify clean working tree after commit.
10. Push reviewed checkpoint.
11. Update source-of-truth documentation when project state changes.

No single AI agent should independently design -> implement -> test -> approve -> commit the same architectural change without independent review.

---

## 9. Next Active Engineering Gate

### GATE M1 — MACRO V2 DATA INTEGRITY

**Goal**: Establish truthful, typed, inspectable market-data contracts before building new Macro UI or chatbot reasoning.

**Initial M1 Priorities**:
1. Inventory all legacy macro and Vietnam market data feeds.
2. Classify data feeds into explicit categories: `LIVE`, `DERIVED`, `SYNTHETIC`, or `UNAVAILABLE`.
3. Establish unified metadata contract: `source`, `asOf`, `freshness`, and `quality`.
4. Prevent synthetic or hard-coded fallbacks from masquerading as current market facts.
5. Define the data-side schema for `CurrentMarketSnapshot`.
6. Maintain strict scope: **No broad UI redesign, no chatbot rewrite, no quant parameter tuning** during M1.
