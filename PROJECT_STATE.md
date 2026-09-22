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
- **HEAD Commit**: `f289f4f4b128be2fa2be52d919e2c1e3859a03ce`
- **Commit Message**: `Gate M11: add canonical trade attribution`
- **Gate Statuses**:
  - **Gate 0** (Build / Type Contract Repair): **COMPLETE**
  - **Gate 1** (Forensic Audit): **COMPLETE**
  - **Gate 2A** (Core Quant Validity Repair): **COMPLETE**
  - **Gate M6** (Vietnam Layer 1 Integration): **COMPLETE**
  - **Gate M7** (Paper Decision Persistence Across Reloads): **COMPLETE**
  - **Gate M8** (Canonical Portfolio Accounting & Deterministic Validation): **COMPLETE**
  - **Gate M9** (No-Lookahead / Point-in-Time Validation): **COMPLETE**
  - **Gate M10** (Rolling OOS Methodology & Validation): **COMPLETE**
  - **Gate M11** (Trade Attribution & Round-Trip Reconstruction): **COMPLETE**
- **Latest Verification Results**:
  - `npm run build`: **PASS**
  - `npx vitest run`: **PASS** (259/259 tests across 17 test files)
  - `git diff --check`: **PASS**
- **Working Tree State**: Clean baseline following Gate M11 implementation and validation.

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
PERMISSON GATE
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

## 5. Completed Gate M7 — Paper Decision Persistence Across Reloads

Gate M7 implemented fail-closed persistence and rehydration for canonical Paper Engine decision state (`latestDecision`):

1. **Single Persisted Decision Artifact**: `latestDecision` is the sole decision artifact persisted in `localStorage` under key `quant_paper_engine_state`.
2. **Fail-Closed Structural Validation**: `isValidDecisionState()` validates structure and critical numeric fields before rehydration. Malformed state resets to neutral.
3. **Derived UI Telemetry Rehydration**: `deriveMetricsFromDecision()` reconstructs UI telemetry (`omega`, `trend`, `event`, `mean`, `benchmarkDca`) from canonical `latestDecision` without re-running simulation or creating duplicate accounting state.
4. **Hydration Parity**: Hydrated UI state matches fresh replay UI state on canonical equity, cash, positions, and drawdown.

---

## 6. Completed Gate M8 — Canonical Portfolio Accounting & Deterministic Validation

Gate M8 audited, repaired, and validated the canonical execution and portfolio accounting pipeline across `backtestEngine`, `executionEngine`, `paperEngine`, and `tradingStore`:

1. **Canonical Omega NAV & Cash Parity**:
   - `PaperEngine.replay()` derives Omega BotMetrics directly from `latestDecision.nav` and `latestDecision.cash`.
   - Fresh replay UI state and hydrated UI state agree 100% on canonical portfolio NAV.
2. **Position Unrealized PnL Bar-Close Mark Alignment**:
   - `backtestEngine.ts` updates `account.positions[id].unrealizedPnl` at `bar.close` prior to emitting `DecisionState`, matching the exact closing mark price used by `DecisionState.nav`.
3. **Exact Accounting Equations**:
   - `NAV_t = cash_t + sum(qty_i,t * markPrice_i,t)` marked at `bar.close`.
   - BUY: `cash_after = cash_before - (executedQty * execPrice) - fees`.
   - SELL: `cash_after = cash_before + (executedQty * execPrice) - fees`.
   - Fees affect cash once during execution; slippage adjusts `executionPrice` once during execution. Summary metrics (`totalFeesUsd`, `totalSlippageCostUsd`) are strictly read-only.
4. **Long-Only & Affordability Safety**:
   - Position quantity remains non-negative ($\ge 0$).
   - BUY affordability clamp prevents cash from becoming negative (`maxAffordableValue = cash / (1 + commissionRate)`).
   - Weighted-average cost basis updated on BUY and preserved on partial SELL.
5. **Fill / Trade Semantic Truthfulness**:
   - `ExecutionRecord` count represents fill count (`totalTrades`).
   - Closed round-trip trade statistics (`winRate`, `wins`, `losses`) evaluate to `null` where actual trade statistics are expected.
6. **Deterministic Accounting Validation Suite**:
   - Created [`src/lib/quant/__tests__/accountingValidation.test.ts`](file:///c:/Users/acer/Documents/QuantProjects/QuantFund-OS/src/lib/quant/__tests__/accountingValidation.test.ts) covering 24 deterministic accounting tests (T1–T24) — **24/24 PASS**.
7. **Runtime Acceptance (Gate M8C)**:
   - Fresh replay NAV parity: **PASS**.
   - Fresh cash parity: **PASS**.
   - NAV reconciliation (`cash + qty * close`): **PASS**.
   - Position `unrealizedPnl` reconciliation: **PASS**.
   - F5 hydration parity: **PASS**.
   - Post-return automatic replay parity: **PASS**.

---

## 7. Completed Gate M9 — No-Lookahead / Point-in-Time Validation

Gate M9 audited, enforced, and validated Point-in-Time (PIT) integrity and anti-lookahead execution rules across all engine components:

1. **NEXT_BAR_OPEN Canonical PIT Mode**:
   - `NEXT_BAR_OPEN` is the canonical PIT-safe executable mode across the platform.
   - Canonical `PaperEngine` sets `requirePitExecution = true`.
2. **SAME_BAR_CLOSE Rejection**:
   - `SAME_BAR_CLOSE` is preserved only as a theoretical research/benchmark timing mode.
   - Any path claiming executable/PIT-safe replay rejects `SAME_BAR_CLOSE` fail-closed with a deterministic error.
3. **Execution Timing Integrity**:
   - Decisions at bar $t$ use data strictly $\le t$ close.
   - Target rebalance weights execute at bar $t+1$ open.
   - Bar $t+1$ High, Low, and Close do not influence $t+1$ open execution price.
4. **Prefix-Only Indicator & Risk Inputs**:
   - Alpha indicator windows (SMAs, ATR, Chandelier, Z-Scores) operate exclusively on prefix slices (`0..t`).
   - Risk Engine inputs (realized volatility, peak drawdown) use prefix benchmark slices (`0..t`).
   - Omega Allocator targets depend strictly on point-in-time signals, permissions, and risk state.
5. **Macro / Event PIT Integrity**:
   - Active `PaperEngine` macro and event timelines remain empty until truthful historical PIT ingestion exists (`CORE-02/03` invariant preserved).
   - Future macro observations (`asOfTimestamp > timestamp`) and event releases (`publicationTimestamp > timestamp`) are ignored before publication.
6. **Strict Bar Timestamp Validation**:
   - `runBacktest` validates every asset bar series before replay, rejecting duplicate, descending/out-of-order, or non-finite timestamps fail-closed without silent data repair.
7. **Deterministic Anti-Lookahead Validation Suite**:
   - Created [`src/lib/quant/__tests__/lookaheadValidation.test.ts`](file:///c:/Users/acer/Documents/QuantProjects/QuantFund-OS/src/lib/quant/__tests__/lookaheadValidation.test.ts) covering 20 deterministic anti-lookahead tests (T1–T20) — **20/20 PASS**.
8. **DecisionState Timing Semantics**:
   - `DecisionState` remains a coherent end-of-bar audit snapshot containing executions from bar $t$ open, decisions from bar $t$ close, and NAV/positions marked at bar $t$ close.
9. **Runtime Acceptance (Gate M9C)**:
   - Replay execution rule: **PASS** (`NEXT_BAR_OPEN`).
   - `requirePitExecution`: **PASS** (`true`).
   - `SAME_BAR_CLOSE` rejection: **PASS**.
   - Timestamp validation rejections (duplicate, unsorted, non-finite): **PASS**.
   - F5 hydration & Paper Lab automatic replay: **PASS**.

---

## 8. Completed Gate M10 — Rolling OOS Methodology & Validation

Gate M10 audited, repaired, and validated the rolling out-of-sample (OOS) evaluation engine:

1. **Truthful Methodology Classification**:
   - Classified as **Rolling Fixed-Parameter OOS Evaluation**.
   - Training/pre-test bars serve strictly as pre-roll indicator context (no parameter fitting, grid search, or model selection).
2. **Strict Fold Methodology & Non-Overlapping Windows**:
   - Enforced `stepBars === testWindowBars` fail-closed so OOS test windows are contiguous and non-overlapping.
   - Evaluates complete folds only; trailing partial folds shorter than `trainWindowBars + testWindowBars` are excluded explicitly.
3. **Fold Independence & State Reset**:
   - Each fold starts clean with initial capital ($10,000$), fresh risk state, clean strategy states, and empty execution ledger. No cash, positions, or risk flags are carried between folds.
4. **Canonical Chained OOS Aggregation Semantics**:
   - Per-bar OOS returns are chained synthetically into a continuous chained OOS equity curve (`stitchedOosTimeline`) used exclusively for aggregate performance measurement.
   - Raw fold NAVs are not concatenated as a single portfolio ledger.
   - Aggregate metrics are recomputed directly from the full stitched OOS series (eliminating the Fold-0-as-aggregate bug).
5. **Verified Aggregate Performance Metrics**:
   - Total return and global max drawdown recomputed from chained OOS equity.
   - Sharpe and Sortino ratios recomputed from the complete stitched 1H per-bar OOS return series using standard time-domain constants (`BARS_PER_YEAR = 8760`, `ANNUALIZATION_FACTOR = sqrt(8760)`).
   - OOS timestamps are unique and strictly chronological without double counting.
6. **Execution Statistic Semantics**:
   - Execution fill count (`totalTrades`), fees, and slippage are aggregated across independent fold runs for telemetry reporting and are not subtracted again from chained NAV.
7. **Terminal Pending-Order Behavior**:
   - Target generated on the final OOS bar of fold $k$ remains unexecuted outside fold $k$, is not carried into fold $k+1$, and is not counted as an OOS fill.
8. **Deterministic Validation Suite**:
   - Created [`src/lib/quant/__tests__/walkForwardValidation.test.ts`](file:///c:/Users/acer/Documents/QuantProjects/QuantFund-OS/src/lib/quant/__tests__/walkForwardValidation.test.ts) covering 26 deterministic methodology tests (T1–T26) plus explicit regression test — **26/26 PASS**.
9. **Runtime Acceptance (Gate M10C)**:
   - Methodology label: **PASS** (`Rolling Fixed-Parameter OOS Evaluation`).
   - Boundary math & metadata: **PASS**.
   - Aggregate return & max drawdown reconciliation: **PASS**.
   - F5 hydration & regression checks: **PASS**.

---

## 9. Completed Gate M11 — Canonical Trade Attribution & Round-Trip Reconstruction

Gate M11 designed, implemented, and validated a pure derived trade reconstruction layer over canonical `ExecutionRecord[]` fills:

1. **Three Distinct Concepts**:
   - **Execution / Fill** (`ExecutionRecord`): Individual fill record. Legacy `totalTrades` field remains execution fill count.
   - **Closed Realized Lot** (`ClosedTradeRecord`): Realized SELL fill closing quantity against current average-cost inventory. Accounting attribution unit (`closedTradeCount`).
   - **Round-Trip Episode** (`RoundTripEpisode`): Position lifecycle (`FLAT -> OPEN -> [scale-ins / partial exits] -> FLAT`). Authoritative performance trade unit (`roundTripCount`).
2. **Authoritative Win Rate & Win/Loss Semantics**:
   - Performance trade statistics (`wins`, `losses`, `breakEven`, `winRatePct`) are strictly derived from completed `RoundTripEpisode` net PnL.
   - Numerical tolerance $\epsilon = 10^{-4}$ USD (`WIN`: $> +1e-4$, `LOSS`: $< -1e-4$, `BREAK_EVEN`: $|\text{PnL}| \le 1e-4$).
   - Win Rate equation: $\text{winRatePct} = \frac{\text{wins}}{\text{wins} + \text{losses}} \times 100$. Break-even episodes are excluded from the denominator. If $\text{wins} + \text{losses} = 0$, $\text{winRatePct} = \text{null}$.
   - Partial SELL lots do not independently count as performance trades.
3. **Average-Cost Inventory & Fee Attribution Math**:
   - Weighted-average cost basis $\bar{P}_{\text{entry}}$ updated on scale-ins.
   - BUY fees accumulated as remaining entry-fee basis $F_{\text{entry}}$ and allocated proportionally on SELL ($F_{\text{alloc}} = F_{\text{entry}} \cdot \frac{q}{Q}$).
   - Exit fee $f_{\text{sell}}$ deducted once on exit.
   - Slippage is embedded directly in `executionPrice` and is not deducted twice.
   - Full exit resets attribution inventory; re-entry creates a new independent episode ID (`ep-BTC-2`).
4. **Single Canonical Ledger Preservation**:
   - Implemented as a pure derived view (`reconstructTradeAttribution`) over canonical `ExecutionRecord[]` fills in [`src/lib/quant/tradeAttribution.ts`](file:///c:/Users/acer/Documents/QuantProjects/QuantFund-OS/src/lib/quant/tradeAttribution.ts).
   - Does NOT create a second cash/NAV accounting ledger.
5. **Exact Ledger Reconciliation Identities**:
   - **Flat Ending**: $\text{EndingNAV} - \text{InitialCapital} = \sum \text{ClosedTrade.netPnl} = \sum \text{RoundTripEpisode.netPnl}$.
   - **Open Ending**: $\text{PortfolioPnL}_t = \sum \text{CompletedEpisode.netPnl} + \sum \text{ActiveEpisodeClosedLots.netPnl} + \text{GrossUnrealizedPnL}_{\text{open}} - \text{RemainingEntryFees}_{\text{open}}$ reconciles to portfolio PnL.
6. **Hydration Truthfulness**:
   - `latestDecision` persistence does not contain full historical execution history.
   - Hydrated trade statistics remain `null` / unavailable until a legitimate fresh replay reconstructs full attribution.
7. **Walk-Forward Fold Isolation**:
   - Trade attribution is fold-local; no episode crosses fold boundaries.
   - Aggregate OOS trade statistics sum fold-local completed episodes (`roundTripCount`, `wins`, `losses`, `breakEven`); win rate is recomputed from aggregate wins/losses.
   - Stitched OOS return curve is NOT treated as a continuous execution/inventory ledger.
8. **Exclusions**:
   - DCA benchmark fills and Alpha telemetry are excluded from Omega canonical trade attribution.
   - Current scope remains long-only spot portfolio.
9. **Deterministic Validation & Acceptance**:
   - Created [`src/lib/quant/__tests__/tradeAttributionValidation.test.ts`](file:///c:/Users/acer/Documents/QuantProjects/QuantFund-OS/src/lib/quant/__tests__/tradeAttributionValidation.test.ts) covering 37 deterministic tests (T1–T37) — **37/37 PASS**.
   - Full Test Suite: **259/259 PASS** across 17 test files.
   - Production Build (`npm run build`): **PASS**.
   - `git diff --check`: **PASS**.

---

## 10. Open / Deferred Technical & Macro Risks

### Accounting & Execution Limitations
- **Control Benchmark Scope**: DCA remains strictly benchmark/control only (`DEC-001`).
- **SAME_BAR_CLOSE Mode**: Not executable/PIT-safe (theoretical research benchmark mode only).

### Deferred Quant Engineering
- Genuine historical point-in-time macro data ingestion.
- Genuine historical point-in-time event/news ingestion.
- Multi-timeframe quant engine support.
- Short-selling support and margin semantics.
- Train-set hyperparameter optimization & grid search engine.
- Parallel DCA control benchmark evaluation in walk-forward reports.
- Further Adaptive Trend persistence research.
- Mean Reversion research improvements.
- Provider-specific bar timestamp validation when new external market feeds are added.
- `liveRuntime` / execution API production hardening.

---

## 11. Required Workflow

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

---

## 12. Next Active Engineering Gate

### GATE M12 — Point-in-Time Macro & Event History Ingestion & Dynamic Synthesis

**Status**: Gate M11 is complete. Gate M12 is the next active engineering gate.

**High-Level Scope**:
- Ingest truthful historical Point-in-Time macro and event timelines.
- Connect historical PIT macro/event data to Layer 2 Macro Interpretation & Layer 3 Synthesis.
- Integrate PIT macro/event timelines into `runBacktest` and `PaperEngine` replay without look-ahead leakage.
- **Explicit Non-Goals**: No strategy parameter or formula tuning to artificially boost returns or Sharpe ratio.
