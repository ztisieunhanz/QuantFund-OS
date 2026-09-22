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
- **HEAD Commit**: `c1bf65416d650f598d055521d53f20d1cfd20159`
- **Commit Message**: `Gate M7: persist paper decision across reloads`
- **Gate Statuses**:
  - **Gate 0** (Build / Type Contract Repair): **COMPLETE**
  - **Gate 1** (Forensic Audit): **COMPLETE**
  - **Gate 2A** (Core Quant Validity Repair): **COMPLETE**
  - **Gate M6** (Vietnam Layer 1 Integration): **COMPLETE**
  - **Gate M7** (Paper Decision Persistence Across Reloads): **COMPLETE**
  - **Gate M8** (Canonical Portfolio Accounting & Deterministic Validation): **COMPLETE**
- **Latest Verification Results**:
  - `npm run build`: **PASS**
  - `npx vitest run`: **PASS** (187/187 tests across 14 test files)
  - `git diff --check`: **PASS**
- **Working Tree State**: Clean baseline prior to Gate M8 commit.

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

## 7. Open / Deferred Technical & Macro Risks

### Accounting & Execution Limitations
- **Authoritative Round-Trip Trade Reconstruction**: Connecting BUY and SELL fills into completed round-trip trades remains explicitly deferred (`DEC-002`).
- **Fee-Inclusive Trade Realized PnL Attribution**: Allocating historical BUY commission to trade-level realized PnL remains deferred.
- **Trade Statistics Nullability**: Trade win rate, wins, and losses evaluate to `null` until canonical round-trip reconstruction exists.
- **Internal Naming Debt**: `TradingLabView.tsx` KPI grid label still displays `"TRADES"` for execution fill count (`bot.totalTrades`).
- **Control Benchmark Scope**: DCA remains strictly benchmark/control only (`DEC-001`).

### Deferred Quant Engineering
- Genuine historical point-in-time macro ingestion.
- Genuine historical point-in-time event/news ingestion.
- Multi-timeframe quant engine support.
- Short-selling support and margin semantics.
- Broader walk-forward methodology and aggregate metric updates.
- Further Adaptive Trend persistence research.
- Mean Reversion research improvements.
- `liveRuntime` / execution API production hardening.

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

---

## 9. Next Active Engineering Gate

### GATE M9 — No-Lookahead / Point-in-Time Validation

**Status**: Gate M8 is complete. Gate M9 is the next active engineering gate.

**High-Level Scope**:
- Comprehensive audit of all signal, permission, risk, and omega inputs for future-information leakage.
- Verification of bar timestamp alignment and decision vs execution timing (`NEXT_BAR_OPEN` vs `SAME_BAR_CLOSE`).
- Verification of macro and event Point-in-Time (PIT) publication timestamp handling.
- Addition of deterministic anti-lookahead test suite.
- **Explicit Non-Goals**: No strategy formula or parameter tuning.
