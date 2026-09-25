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
5. read `ROADMAP_V1.md` and `ARCHITECTURE_V1.md`;
6. inspect the relevant current source files.

Do not rely only on AI memory or previous agent reports.

---

## 2. Last Verified Code Checkpoint

- **Repository**: `ztisieunhanz/QuantFund-OS`
- **Last Verified Code Checkpoint**: `14ac61c888e5ba5b34070a455cdda98c005af31e`
- **Checkpoint Message**: `M13D D-C: record calibration lane not required for v1`
- **Authority Note**: Git itself is authoritative for the actual current HEAD. This document records verified checkpoints and phases; it does not claim to track a future commit containing its own edits.
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
  - **Gate M12** (Historical Point-in-Time Data Infrastructure): **COMPLETE**
  - **Gate M13B-1** (Historical Research Data Protocol, Manifest & Coverage Contract): **COMPLETE**
  - **SYNC-01** (v1 Architecture, Roadmap & Recovery Source-of-Truth Sync): **COMPLETE** at `2f5de0124df67f38b626bae0077537848f6696ee`
  - **SYNC-02** (CI, Portability & Agent-Handoff Enforcement): **COMPLETE** at `8689339a91d41eafc9e9a04a4985bba9b15e11ea`
  - **M13B-2 / B2-A** (Historical Research Data Source Audit): **COMPLETE** at `459d2e2eedb3d1c4354c7c92ddaa5efa2940b8f5`
  - **M13B-2 / B2-B1** (Immutable Acquisition Foundation + Binance BTC/PAXG Adapter): **COMPLETE** at `459d2e2eedb3d1c4354c7c92ddaa5efa2940b8f5`
  - **M13B-2 / B2-B2R** (VIX Source Contract): **BLOCKED** pending defensible timestamped source semantics/access
  - **M13B-2 / B2-B3** (Federal Reserve H.15 US2Y/US10Y PIT Acquisition): **COMPLETE** at `dce533a0702f974469e0c24df96d9d8ba1b0c5c4`
  - **M13B-2 / B2-B4** (BLS CPI Historical PIT Acquisition): **COMPLETE** at `29c777079e0483c84b5875a9c09e42cd4b20848d`; CPI Index/YoY implemented for a bounded archive regime, CPI MoM remains conditional
  - **M13B-2 / B2-B5** (FOMC Decision + Fed Funds Target Upper PIT Acquisition): **COMPLETE** at `65b268923ab7509391b2ee39a0bc87099d352b6d`
  - **M13B-2 / B2-B6** (BLS Labor Historical PIT Acquisition): **COMPLETE** at `4354558ac5042777e0423dcfac498a4e57587ea3`; bounded NFP vintage acquisition is implemented while unemployment remains conditional
  - **M13B-2 / B2-C** (Immutable Dataset Snapshot / Hash / Reproducibility): **COMPLETE** at `5d07cb5c28b33ba92e0a09872468eaaa0ff91fc6`
  - **M13B-2 / B2-C-R1** (Shared Source-Artifact Identity Contract Repair): **COMPLETE** at `700fd05aa9fdf556c7e49e9bece94387440ce6d0`
  - **M13B-2 / B2-C-R2** (Artifact-Type ↔ Canonical-Series Link Validation): **COMPLETE** at `700fd05aa9fdf556c7e49e9bece94387440ce6d0`
  - **M13B-2 / B2-D** (Coverage / Missingness / Revision / Dataset Readiness): **COMPLETE** at `3ffdc42701ac480f69f438114dcccd996db7fec6`
  - **M13B-2 / B2-E** (Final Data Policy + M13B Checkpoint Gate): **COMPLETE** at `2aaee91e9f36511060687106470c4378d68081e9`
  - **M13C / C-A** (Derived PIT-Safe 4H + 1D Research Context): **COMPLETE** at `6e350f29e3d941a280322a23ee2db709aa90701a`
  - **M13C / C-B** (ResearchRule Interface + Combinators): **COMPLETE** at `45e4487d850e8fdd612286fc110991383e408995`
  - **M13C / C-C** (PIT-Safe Stateful & Sequence Research Rules): **COMPLETE** at `5aa01a387d41f9da3574f167c58b9ad4857ff38d`
  - **M13C / C-D** (Hypothesis Registry + Anti-Data-Mining Governance): **COMPLETE** at `096297f28574518614a07eb46fde75bbf5da8da5`; predictive validity remains unassessed and no hypothesis is approved for paper action
  - **M13C / C-E** (PIT-Safe Macro + Technical Feature Builder): **COMPLETE** at `a8bc389b86149cf0d64eb48f91e65872044e7e83`; research features grant no action or execution authority
  - **M13C / C-F** (PIT-Safe Shadow Research Harness): **COMPLETE** at `9b36758cae3b6e33dbc1005a84e1fe007e9c9d11`; observations remain research-only and grant no action or execution authority
  - **M13D / D-A** (Fixed-Rule Held-Out OOS Evaluation): **COMPLETE** at `2e3474f8640cf9abbfaa70388d3fcaec137aa9be`; evidence-only aggregation does not assess predictive validity or economic performance
  - **M13D / D-A-R1** (Preregistered Stateful OOS Boundary Policy): **COMPLETE** at `3894a1308bfc66e647b75e2ceb9428519ba4595a`
  - **M13D / D-A-R2** (CARRY State Lineage Integrity): **COMPLETE** at `2e3474f8640cf9abbfaa70388d3fcaec137aa9be`; isolated unknown-origin witnesses are rejected in favor of a canonically anchored pre-OOS transition chain
  - **M13D / D-B** (Robustness & Sensitivity): **COMPLETE** at `61722d9639a49083ad052fccf5a286caaf95ad1a`; descriptive shared-OOS categorical sensitivity only, with no ranking, selection, threshold, economic metric, or authority
  - **M13D / D-B-R1** (Robustness Family Preregistration Contract Repair): **COMPLETE** at `5dfa01c0fbec51893293832c4ca7599c7b8f6490`; preregistration only, with no robustness evaluation or selection
  - **M13D / D-C** (Training / Calibration Lane Necessity Audit): **COMPLETE — NOT REQUIRED FOR CURRENT V1** at `14ac61c888e5ba5b34070a455cdda98c005af31e`; no implemented component performs genuine TRAIN-only fitting
  - **M13D / D-D** (Evidence Registry & Research Evidence Classification): **IMPLEMENTED — NOT REVIEWED / NOT CHECKPOINTED**; current methodology supports `CANDIDATE` and `INSUFFICIENT_EVIDENCE` only
- **Validation Baseline**:
  - `npm run build`: **PASS**
  - `npx vitest run`: **PASS** (1032/1032 tests at the recorded D-A validation checkpoint; later exact-commit CI is authoritative for subsequent checkpoints)
  - `git diff --check`: **PASS**
  - **CI target sequence**: submitted-range `git diff --check` → `npm ci` → `npx vitest run` → `npm run build` → post-validation whitespace and clean-tree checks on Ubuntu with Node 22 LTS.
  - **CI status**: The D-C checkpoint at `14ac61c888e5ba5b34070a455cdda98c005af31e` passed the required remote workflow.
- **Current Documented Phase**: M13B, M13C/C-A through C-F, D-A, D-B-R1, D-B, and the D-C not-required audit are **COMPLETE**. D-D evidence classification is implemented for independent review but is not checkpointed. No research component grants predictive or trading authority.
- **Architecture Sources**: `ROADMAP_V1.md` and `ARCHITECTURE_V1.md`.

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

## 10. Completed Gate M12 — Historical Point-in-Time Data Infrastructure

**Status**: **COMPLETE**

Gate M12 designed, ingested, normalized, verified, and connected point-in-time (PIT) historical market factor observations, macroeconomic releases with revision vintages, and official central bank/economic events into the deterministic QuantFund OS backtest and walk-forward evaluation engines:

### Subphases Summary
- **M12A — Forensic Audit & Source Semantics**: Audited historical source semantics, publication timings, revision mechanics, and data contracts.
- **M12B — Canonical Contracts & Anti-Lookahead Lookups**: Established canonical interfaces (`HistoricalMarketObservation`, `HistoricalMacroRelease`, `HistoricalEventRecord`, `HistoricalDataset`, `HistoricalContextAtTime`), deterministic PIT lookup functions (`getLatestMarketObservationAt`, `getLatestMacroReleaseAt`, `getLatestEventAt`), vintage/revision semantics, and strict event eligibility rules.
- **M12C — Historical Market Data Ingestion**: Offline-ingested BTC/PAXG Binance 1H bars, DXY/VIX daily observations via Yahoo, and US2Y/US10Y daily yields via Federal Reserve H.15. Implemented verified availability timestamps with DST handling and strict offline determinism (no replay-time network requests).
- **M12D — Historical Macro Releases & Events Ingestion**: Ingested BLS CPI, BLS Employment Situation (Nonfarm Payrolls with initial and subsequent revision vintages), and FOMC rate decision events. Guaranteed official release timing integrity; historical consensus remains `null` when unavailable to prevent fabricated event surprise.
- **M12E — Historical Replay Integration**: Connected `HistoricalDataset` to `runBacktest`, attaching a compact, point-in-time `HistoricalContextAtTime` audit snapshot to each `DecisionState` (`availableAt <= decisionTime`). Ensured future-suffix invariance and full backwards compatibility for replays without historical datasets.
- **M12F & M12F-B — Consumption Audit & Replay Boundary Closure**: Removed `HistoricalDataset.marketBars` to cement `BacktestDataset.assetBars` as the sole canonical price authority. Implemented carry-forward-safe `sliceHistoricalDataset()` for walk-forward OOS validation folds. Verified zero mutation of baseline strategy behavior.

### M12 Completion Validation
- **Unit & Integration Suite**: **459/459 PASS** across 22 test files.
- **Production Build (`npm run build`)**: **PASS**.
- **Working Tree & Linter**: `git diff --check` clean.
- **Verified M12 checkpoint at completion**: `baabeaa945533a4cb711350b373e575ab46de781`.

### Canonical Historical Architecture
The platform enforces a unidirectional historical data flow:
```
Historical Provider Ingestion / Offline Preparation
  ↓
HistoricalDataset (observations, macroReleases, events)
  ↓
Validation & Deterministic Normalization (sorted, finite, verified availableAt)
  ↓
buildHistoricalContextAtTime(decisionTime)
  ↓
DecisionState.historicalContext (audit-only snapshot)
  ↓
Alpha / Permission / Risk / Omega Pipeline
```

**Key Contract Properties**:
- `HistoricalContextAtTime` contains:
  1. `decisionTime`: Timestamp of the decision bar.
  2. `market`: Latest eligible observation per series (`Record<HistoricalMarketSeriesId, HistoricalMarketObservation>`).
  3. `macro`: Latest eligible release/vintage per series (`Record<HistoricalMacroSeriesId, HistoricalMacroRelease>`).
  4. `latestEvent`: Most recent published eligible event (`HistoricalEventRecord | null`).
- `HistoricalContextAtTime` does **NOT** contain full historical time series or future knowledge.
- Canonical visibility constraint: `availableAt <= decisionTime`.

### Single Price Source of Truth
`BacktestDataset.assetBars` is the **sole canonical source** for:
- Executable asset prices
- Replay bar iteration
- Order execution and fill pricing
- NAV marking and portfolio valuation
- Benchmark and risk price history

`HistoricalDataset` contains strictly:
- Market factor observations (`observations`)
- Macroeconomic releases with revision vintages (`macroReleases`)
- Economic calendar / central bank events (`events`)

`HistoricalDataset` no longer contains executable `marketBars`.

### Walk-Forward PIT Semantics
Each rolling OOS fold receives a sliced `HistoricalDataset` via `sliceHistoricalDataset(dataset, foldStart, foldEnd)`.
The slice semantics preserve:
- Exactly **one latest pre-fold observation** per market series (`availableAt <= foldStart`).
- The **appropriate latest pre-fold macro release/vintage** per series (`availableAt <= foldStart`).
- At most **one latest pre-fold event** (`availableAt <= foldStart`).
- **All records inside the fold range** (`foldStart < availableAt <= foldEnd`).
- **Zero records after fold end** (`availableAt > foldEnd`).

Fold boundaries are **evaluation boundaries**, NOT data-publication reset boundaries. Macroeconomic knowledge published before fold start carries forward safely without execution state contamination.

### What Gate M12 Does NOT Do
Gate M12 is strictly a historical point-in-time data infrastructure gate. It does **NOT**:
- Create a historical macro trading strategy or alpha model.
- Map VIX, yield, or DXY observations into `PermissionGate` or `RiskEngine`.
- Reuse live `CurrentMarketSnapshot` heuristics historically.
- Change `RiskEngine` or `OmegaAllocator` macro behavior.
- Alter `AdaptiveTrend` or `MeanReversion` signals or parameters.
- Fabricate economic event consensus or surprise values.

Official CPI, NFP, and FOMC events lacking verified historical consensus remain `EventReaction`-ineligible and generate zero event alpha.

### Explicit Open Design Debts
- **Debt A — PermissionGate Null Macro Default**: `macro === null -> Transitional Mixed`. This is preserved legacy baseline behavior. Changing it requires a dedicated future model-methodology gate.
- **Debt B — Historical Macro Strategy Model**: No approved model currently maps PIT historical macro factors into `PointInTimeMacro`, `MacroRegime`, or `PermissionGate`. This requires a separate quantitative research gate.
- **Debt C — Historical Event Consensus**: Official BLS and Federal Reserve sources do not publish verified pre-release market consensus. Integrating a consensus provider requires its own PIT source-validation gate.
- **Debt D — Historical Freshness / Regime Semantics**: Current Macro V2 live 24h/72h freshness thresholds must not automatically be reused historically across weekends, market holidays, or daily/monthly series publication cadences.

---

## 11. Completed Gate M13B-1 — Research Data Protocol

**Status**: **COMPLETE**

M13B-1 established a machine-checkable, research-only manifest, canonical per-series cadence/kind/revision semantics, deterministic snapshot serialization with an injectable hashing boundary, and a fail-closed coverage-readiness assessment. Compact fixtures remain `FIXTURE_ONLY`; no research-grade dataset or macro model was introduced.

### Explicit Current Debts

- No bulk research snapshot is stored in the repository; approved adapters assemble externally persisted immutable snapshots for readiness evaluation.
- Dataset-level immutable SHA-256 snapshot assembly and the B2-C-R1/R2 provenance repairs are checkpointed; production persistence remains pending.
- B2-E resolves the B2-D policy limitation with an explicit nine-series required minimum and four-series optional classification; optional dependencies remain fail-closed at future rule level.
- No historical macro model or macro action evidence is approved.
- No action layer or `ActionDecision` is implemented.
- C-A derived 4H/1D research context is checkpointed and remains disconnected from trading authority.
- C-B's stateless ResearchRule contract and combinators are checkpointed; no rule is action-eligible.
- C-C's stateful sequence and persistence primitives are checkpointed; state remains research-evaluation-only.
- C-D's deterministic Hypothesis Registry and anti-data-mining controls are checkpointed. Predictive validity remains unassessed and no hypothesis is approved for paper action.
- C-E's PIT-safe technical and macro/event feature builder is checkpointed. Missing evidence remains explicit and no feature is action-eligible.
- C-F's PIT-safe shadow research harness is checkpointed. It binds preregistered hypotheses, explicit parameter configurations, C-E feature evidence, and C-B/C-C evaluation without creating action authority.
- D-A is checkpointed at `2e3474f8640cf9abbfaa70388d3fcaec137aa9be`. Its evidence-only aggregation validates C-F observation identity, fixed-trial binding, OOS isolation, chronology, and reset/carry state continuity without economic metrics or promotion.
- D-B methodology identified that the existing hypothesis parameter-space declaration could not safely represent a complete shared-OOS sensitivity family because C-F correctly binds one exact rule identity and configuration. D-B-R1 implements only the missing immutable family preregistration relationship over existing exact fixed trials; independent review approved it and checkpoint `5dfa01c0fbec51893293832c4ca7599c7b8f6490` completed. D-B revalidates supplied member evidence through D-A, enforces exact declared membership and OOS grids, retains missing/insufficient evidence, and emits descriptive categorical evidence only; checkpoint `61722d9639a49083ad052fccf5a286caaf95ad1a` completed.
- The D-C audit found no current v1 component that fits or calibrates parameters from TRAIN data. Current fixed trials and finite families remain preregistered evidence contracts, not optimization or winner-selection mechanisms. D-C is intentionally not required for current v1; checkpoint `14ac61c888e5ba5b34070a455cdda98c005af31e` completed.
- D-D implements an immutable research-only Evidence Registry over validated hypothesis, held-out OOS, and optional shared-OOS sensitivity artifacts. Current methodology supports `CANDIDATE` and `INSUFFICIENT_EVIDENCE`; promotion and rejection remain explicitly unavailable pending separate preregistered methodology. D-D is implemented for independent review and is not checkpointed.

---

## 12. Open / Deferred Technical & Macro Risks

### Accounting & Execution Limitations
- **Control Benchmark Scope**: DCA remains strictly benchmark/control only (`DEC-001`).
- **SAME_BAR_CLOSE Mode**: Not executable/PIT-safe (theoretical research benchmark mode only).

### Deferred Quant Engineering & Research
- Historical macro alpha & regime strategy models (mapping PIT macro context to quant signals).
- Historical event consensus provider integration & verified surprise calculation.
- Historical factor freshness thresholds calibrated for daily/monthly series.
- **M13D and later**: D-D evidence classification is implemented for review; later roadmap gates remain pending. D-C training/calibration infrastructure is not required unless a future approved methodology introduces genuine TRAIN-only fitting.
- **Post-v1 unless explicitly approved**: Additional executable time domains or a true multi-timeframe execution engine.
- Short-selling support and margin semantics.
- Train-set hyperparameter optimization & grid search engine.
- Parallel DCA control benchmark evaluation in walk-forward reports.
- Further Adaptive Trend persistence research.
- Mean Reversion research improvements.
- Provider-specific bar timestamp validation when new external market feeds are added.
- `liveRuntime` / execution API production hardening.

---

## 13. Required Workflow

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

## 14. Current Documented Phase

### M13D / D-A — Fixed-Rule Held-Out OOS Evaluation

**Status**: **COMPLETE** at `2e3474f8640cf9abbfaa70388d3fcaec137aa9be`

D-A consumes existing integrity-validated C-F observations for one exact preregistered hypothesis, rule, parameter configuration, trial identity, asset, OOS interval, and state-boundary policy. It rejects mixed identities, TRAIN/outside contamination, malformed chronology, and forged observations rather than sorting or filtering them. Stateful RESET proves the first prior state is canonical initial state. D-A-R2 removes acceptance of an isolated unknown-origin CARRY witness: CARRY requires a strictly chronological pre-OOS C-F transition chain anchored at the same rule/asset canonical initial state, continuous across every prior/next state identity and decision time, and linked exactly into the first OOS prior state; ordered witness identities remain summary-identity audit evidence and are excluded from OOS totals. Every later OOS transition must chain from the immediately preceding OOS next state. The immutable summary counts `MATCH`, `NO_MATCH`, and `INSUFFICIENT_EVIDENCE` separately. It calculates no return, PnL, hit/win rate, Sharpe, drawdown, profitability, or direction metric; predictive assessment, robustness, evidence promotion, and all trading/action authority remain unimplemented.

### M13D / D-B-R1 — Robustness Family Preregistration Contract Repair

**Status**: **COMPLETE — INDEPENDENT REVIEW APPROVED; CHECKPOINTED at `5dfa01c0fbec51893293832c4ca7599c7b8f6490`**

D-B methodology review found that C-D can declare finite candidate parameter spaces while C-F correctly requires one exact registered rule semantic identity and matching parameter configuration. D-B-R1 does not weaken that boundary. It preregisters a finite family of separately valid exact fixed C-D trials and fixes the baseline, scientifically described perturbation axes, member count, one common asset, identical TRAIN/OOS intervals, one stateful OOS-boundary policy, and an exact expected OOS decision-time grid. Every family member resolves to a registered single-asset, fixed-parameter, one-trial hypothesis. The identity-bearing contract fixes `PREREGISTERED_SHARED_OOS_SENSITIVITY`, `NO_POST_OOS_VARIANT_SELECTION`, and `independentConfirmation = false`; it contains no interpretation threshold and cannot assert robustness. Independent review approved D-B-R1 and checkpoint `5dfa01c0fbec51893293832c4ca7599c7b8f6490` completed. D-B evaluation is implemented for review without changing these semantics. No predictive validity, paper action, price authority, execution authority, or accounting authority is introduced.

### M13D / D-B — Preregistered Shared-OOS Robustness / Sensitivity Evaluation

**Status**: **COMPLETE** at `61722d9639a49083ad052fccf5a286caaf95ad1a`

D-B consumes one integrity-validated D-B-R1 family and exact member evidence, reusing D-A to validate every non-empty member observation set. Every declared member is required exactly once. The preregistered decision-time grid rejects duplicate, unexpected, outside-OOS, or mixed evidence; missing grid points remain explicit insufficient evidence and are never fabricated or forward-filled. For stateful RESET/CARRY members, supplied observations after the first missing expected transition remain visible but are counted as lineage-unproven insufficient evidence, because C-C/D-A strict chronology alone cannot prove an omitted preregistered transition. Missing final points do not invalidate the preceding proven prefix. Stateless later observations remain independently usable. The immutable result preserves exact family/member/trial identities, baseline identity, categorical counts, completeness and lineage evidence, shared-OOS reuse, no-selection policy, and `independentConfirmation = false`. It emits no robustness threshold or conclusion, ranking, winner, parameter selection, economic metric, predictive-validity conclusion, or trading/action authority.

### M13D / D-C — Training / Calibration Lane Necessity Audit

**Status**: **COMPLETE — NOT REQUIRED FOR CURRENT V1** at `14ac61c888e5ba5b34070a455cdda98c005af31e`

The audit found no implemented M13 research path that learns, fits, estimates, optimizes, selects, or calibrates a model or parameter from TRAIN data. C-D records fixed or finite preregistered parameter contracts and trial accounting; C-F binds one exact rule identity and parameter configuration without tuning; D-A evaluates one fixed held-out trial; and D-B compares a complete preregistered family descriptively on shared OOS while forbidding post-OOS selection. Existing walk-forward TRAIN/pre-test bars are indicator pre-roll context, not fitting data. TRAIN also supports declared interval classification and auditable state-boundary evidence, but none of these uses produces a fitted artifact.

Creating an optimizer or calibration engine now would invent methodology and weaken the anti-data-mining boundary. Current v1 therefore proceeds without a separate D-C lane. If a future model genuinely requires TRAIN-only fitting, its methodology must be separately preregistered and independently reviewed before implementation, including exact training inputs, fitting objective, frozen fitted-output identity, untouched OOS boundary, trial accounting, and preservation of failed/rejected/insufficient evidence. Shared D-B OOS cannot be used to choose a winner, tune a parameter, or claim independent confirmation. No predictive validity or trading/action authority follows from this audit.

### M13D / D-D — Evidence Registry & Research Evidence Classification

**Status**: **IMPLEMENTED — NOT REVIEWED / NOT CHECKPOINTED**

D-D registers already validated C-D hypotheses, D-A held-out summaries, and optional D-B family/evaluation evidence without creating another feature, rule, replay, OOS, or robustness engine. Every immutable entry binds exact hypothesis/scientific, rule, parameter-configuration, trial-accounting, asset, TRAIN/OOS, state-policy, D-A, optional D-B, and provenance identities. Stale identities, contradictory bindings, duplicate exact-trial entries, malformed authority, and forged output identities fail closed. Incomplete or non-evaluable required evidence is retained as `INSUFFICIENT_EVIDENCE`.

Current M13 methodology permits complete evaluable evidence to remain `CANDIDATE`; this is a research lifecycle state, not action eligibility. The registry cannot emit `APPROVED_FOR_PAPER` because no preregistered promotion contract or validated predictive/economic threshold exists. It cannot infer `REJECTED` from counts or free-text falsification language because no machine-executable rejection contract exists. D-B remains shared-OOS descriptive sensitivity with `independentConfirmation = false` and no selection. The registry fixes `predictiveValidityEstablished = false`, `approvedForPaperAction = false`, `grantsExecutionAuthority = false`, and `priceAuthority = NONE`; M14 must introduce a separate `StrategyEligibility` boundary before any action-layer use.
