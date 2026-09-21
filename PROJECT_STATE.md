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
- **HEAD Commit**: `e590c4664fabe51846f689017974f448ba87b7dc`
- **Commit Message**: `Gate M6E-5: validate VNDirect runtime integration`
- **Gate Statuses**:
  - **Gate 0** (Build / Type Contract Repair): **COMPLETE**
  - **Gate 1** (Forensic Audit): **COMPLETE**
  - **Gate 2A** (Core Quant Validity Repair): **COMPLETE**
  - **Gate M6** (Vietnam Layer 1 Integration): **COMPLETE**
- **Latest Verification Results**:
  - `npm run build`: **PASS**
  - `npx vitest run`: **PASS** (152/152 tests across 11 test files)
  - `git diff --check`: **PASS**
- **Working Tree State**: Clean immediately following Gate M6E-5 commit. Documenting M6 state (Gate M6F).

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

## 6. Completed Gate M6 — Vietnam Layer 1 Integration

Gate M6 successfully implemented and verified live Vietnam Layer 1 market data integration using VNDirect public endpoints over same-origin gateway routes.

### 1. Vietnam Layer 1 Provider
- **Provider**: VNDirect is the active Layer 1 implementation provider.
- **Gateway Routes**: The browser application connects via development same-origin gateway proxy routes (`/api/vndirect/finfo` and `/api/vndirect/dchart`).
- **Endpoint Responsibilities**:
  - `FINfo`: Supplies HOSE security master (`/v4/stocks`), exact-date daily session prices (`/v4/stock_prices`), and foreign trading flow (`/v4/foreigns`).
  - `DChart`: Supplies daily session price history for VNINDEX (`/dchart/history`).
- **Redistribution Rights**: Public endpoint availability does NOT imply or establish production redistribution or commercial data licensing rights.

### 2. VNINDEX Telemetry
- **Semantic Instrument Identifier**: `VNINDEX` (official HOSE benchmark).
- **Provider**: VNDirect DChart (`/api/vndirect/dchart/history?symbol=VNINDEX&resolution=D`).
- **Runtime Quality**: Verified **LIVE / USABLE**.
- **Fallback Invariant**: Strictly fail-closed. No Yahoo `^VNINDEX` fallback, no synthetic data fallback, and no hardcoded price fallback.

### 3. HOSE Authoritative Universe
- **Boundary**: Strictly HOSE listed common equities (`floor=HOSE`, `type=STOCK`, `status=listed`).
- **Security Master Reconciliation**: Daily stock price cross-sections are reconciled against the authoritative security master returned by FINfo.
- **Observed Count**: Runtime verification observed 405 securities during M6 acceptance. This is an empirical observation and MUST NOT be encoded as a permanent hardcoded threshold. Universe completeness is dynamically determined by reconciliation against the authoritative security master.

### 4. Vietnam Market Breadth
- **Discovery**: Provider-driven latest `stock_prices` session date discovery via single-row HOSE probe (`q=floor:HOSE~type:STOCK&sort=date:desc&size=1`).
- **Cross-Section**: Exact session cross-section query (`q=floor:HOSE~type:STOCK~date:${D}&size=500`).
- **Metrics**: Computes advancing, declining, and unchanged counts against official reference prices.
- **Nullability**: `adRatio` is typed as `number | null` and evaluates to `null` when `declining == 0` (no division by zero or forced substitution). `pctAboveMA20`, `pctAboveMA50`, and `pctAboveMA200` are independently typed as `number | null`.
- **Per-Security History**: Moving averages require per-security historical daily close series up to 200 sessions. Newly listed securities with fewer than H bars are excluded from both numerator and denominator for horizon H.
- **Forward Fill Prohibition**: No forward fill, interpolation, or synthetic price history.
- **Runtime Quality**: Verified **LIVE / USABLE**.

### 5. Vietnam Market Liquidity
- **Transaction Scope**: HOSE common-equity normal order-matched value only (`nmValue`). Put-through / negotiated transactions (`ptValue`) are strictly excluded.
- **Session Horizon**: Evaluated across the latest 20 valid completed market sessions.
- **Session Calendar**: Derived directly from the VNINDEX DChart session history calendar, rather than calendar subtraction or single-stock session proxies.
- **Categorical Status**: `status` remains `null` because no categorical regime thresholds have been formally validated.
- **Runtime Quality**: Verified **LIVE / USABLE**.

### 6. Vietnam Foreign Net Flow
- **Transaction Scope**: HOSE common-equity foreign net trading value (`netVal`).
- **Session Horizon**: Evaluated across the latest 5 valid completed foreign trading sessions (`net1dBillion` and rolling `net5dBillion`).
- **Session Calendar**: Candidate dates are derived from the provider market-session calendar. Incomplete or missing candidate sessions are skipped until 5 valid sessions are established.
- **Categorical Status**: `status` remains `null` because no categorical regime thresholds have been formally validated.
- **Runtime Quality**: Verified **LIVE / USABLE**.

### 7. Session Date & Provenance Semantics
- **FINfo Timestamps**: FINfo provides session `DATE` (`YYYY-MM-DD`), not verified intraday observation or market close times.
- **UTC Midnight Anchor**: `MacroDatum.asOf` for FINfo session data uses deterministic UTC-midnight session-date anchors (`T00:00:00Z`) purely as a structural representation.
- **UI Formatting**: Macro V2 UI explicitly renders FINfo session dates as `YYYY-MM-DD`. These timestamps MUST NOT be interpreted or presented as provider-reported midnight or 15:00 HOSE market close times.
- **DChart Timestamps**: DChart provider Unix timestamps are preserved but MUST NOT be relabeled as actual HOSE close times without authoritative empirical evidence.

### 8. Fail-Closed Invariants
- **Malformed Response**: Malformed transport or provider response -> `UNAVAILABLE`.
- **Incomplete Universe Reconciliation**: Unreconciled authoritative security master -> `UNAVAILABLE`.
- **Insufficient Liquidity Sessions**: Fewer than 20 valid market sessions -> `UNAVAILABLE`.
- **Insufficient Foreign Sessions**: Fewer than 5 valid foreign sessions -> `UNAVAILABLE`.
- **Insufficient MA History**: Insufficient MA history does NOT invalidate truthful current breadth (advancing/declining); affected MA fields remain `null`.
- **Synthetic Fallbacks**: No synthetic or hardcoded Vietnam fallbacks are permitted.

### 9. Macro Architecture Invariants
- **Supplementary Telemetry**: Vietnam market telemetry remains supplementary Layer 1 data.
- **Core Invariant**: Vietnam metrics MUST NOT alter:
  - `coreMetricIds`
  - Global macro regime scoring
  - Global macro confidence
  - Global stance
- **Current Core Metrics**: `coreMetricIds` remain strictly: `["dxy", "us2y", "us10y", "vix", "gold", "btc"]`.

### 10. Runtime Acceptance Evidence (Gate M6E-5)
- **Verified Metrics**:
  - VNINDEX: **LIVE / VNDirect / USABLE**
  - Vietnam Breadth: **LIVE / VNDirect / USABLE**
  - Vietnam Liquidity: **LIVE / VNDirect / USABLE**
  - Vietnam Foreign Net Flow: **LIVE / VNDirect / USABLE**
- **Gateway Health**: All VNDirect DChart + FINfo HTTP requests returned HTTP 200.
- **DChart HTTP 406 Resolution**:
  - Removed duplicated `/dchart/dchart/history` path in client/gateway.
  - Removed incompatible forced `Accept: application/json` header in Vite gateway proxy.
- **Verification Commands Passed**:
  - `npm run build`: **PASS**
  - `npx vitest run`: **PASS** (152/152 tests across 11 test files)
  - `git diff --check`: **PASS**

### 11. Relevant Gate Checkpoints
- `b7aad694d9ec16bb1db328e8af929534b73bedd6`: **Gate M6E-1: freeze Vietnam data contracts**
- `fa1ffac908f8131be1264f5922e42e3440a26a64`: **Gate M6E-2: add VNDirect transport gateway**
- `a36ba6f57528171665ef07e5326356231b5f408c`: **Gate M6E-3: add deterministic Vietnam data calculations**
- `ed301dd8bf50e306eb81f9a01c025d691620497f`: **Gate M6E-4: integrate VNDirect Vietnam market data**
- `e590c4664fabe51846f689017974f448ba87b7dc`: **Gate M6E-5: validate VNDirect runtime integration**

---

## 7. Preserved Audit Findings (Not Proven Defective)

The following Gate 1 claims were audited and determined NOT to be core defects requiring code changes:

- **Slippage `baseBps` Conversion**: Slippage `baseBps` conversion was not proven defective (`0.0005 × 10000 = 5 bps` is mathematically consistent).
- **NEXT_BAR_OPEN Close Marking**: Executing at T+1 open and marking the resulting position at T+1 close is not by itself evidence of look-ahead.
- **End-of-Bar NAV Close Marking**: End-of-bar NAV marked at close is not inherently invalid.
- **Slippage Metric Reporting**: A separately reported slippage-cost metric is not automatically accounting double-counting.

---

## 8. Open / Deferred Technical & Macro Risks

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

### Legacy Macro Risks (Addressed / Remaining in Macro V2)
Inspection of legacy Macro code revealed structural risks that require audit and redesign:
- **Synthetic Fallback Contamination**: Synthetic fallback paths can blend into apparently current macro state.
- **Misleading Provenance**: Derived or substitute market metrics lack explicit data quality lineage.
- **Hard-coded Data**: Vietnam market breadth, liquidity, and foreign flow contained hard-coded static arrays (*REPAIRED in Gate M6: Replaced with live VNDirect FINfo/DChart telemetry*).
- **Heuristic Output Presented as Authority**: Macro regime and allocation outputs are heuristic and must be represented as model interpretation rather than objective factual truth.
- **Coupled Responsibilities**: Chatbot context mixes data retrieval, model evaluation, and UI rendering; `MacroView.tsx` currently owns excessive monolithic logic.

---

## 9. Required Workflow

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

## 10. Next Active Engineering Gate

### GATE M6 — DOCUMENTATION COMPLETE (Gate M6F)

**Status**: Gate M6 Vietnam Layer 1 Integration (M6E-1 through M6E-5 & M6F documentation) is fully complete and verified.
