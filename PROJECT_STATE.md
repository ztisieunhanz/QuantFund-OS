# QuantFund OS — Project State

## 1. Source of Truth

This file is a project navigation document.

The actual Git repository, source code, tests, and verified Git history remain the authoritative source of truth.

If this document disagrees with the repository, the repository wins and this file must be corrected.

Before any major architecture decision, forensic repair plan, or coding-agent prompt:

1. verify the current Git HEAD;
2. verify working-tree status;
3. read this file;
4. inspect the relevant current source files.

Do not rely only on AI memory or previous agent reports.

---

## 2. Current Verified Checkpoint

Repository:

`ztisieunhanz/QuantFund-OS`

Verified checkpoint before this documentation change:

`65ea16c2b08710f1f09ac12902c3993f0745686c`

Commit:

`Gate 0: repair build and type contracts`

Status at that checkpoint:

- production build passes;
- TypeScript contract/build baseline repaired;
- Vitest infrastructure installed;
- working tree was clean;
- checkpoint was pushed to GitHub master.

Gate 1 forensic audit was performed read-only against this checkpoint.

No Gate 1 repair has been committed yet.

---

## 3. Frozen Architecture

The intended architecture is:

POINT-IN-TIME DATA
→ ALPHA ENGINES
→ SIGNAL NORMALIZATION
→ PERMISSION GATE
→ RISK ENGINE
→ OMEGA ALLOCATOR
→ TARGET POSITION
→ EXECUTION ENGINE
→ SINGLE CANONICAL LEDGER / AUDIT / PnL

Current Alpha engines:

- Adaptive Trend
- Event Reaction
- Mean Reversion

Benchmark:

- DCA is benchmark/control only.
- DCA must not participate in Omega.
- DCA must not become a fallback allocator.
- DCA must not alter Alpha/Omega portfolio PnL.

---

## 4. Non-Negotiable Invariants

### Layer separation

Signal != Permission

Permission != Risk

Risk != Allocation

Allocation != Execution

Alpha engines do not decide final portfolio position size.

Omega consumes existing Alpha / Permission / Risk information.

Omega must not manufacture a new Alpha signal.

### Point-in-time integrity

No future information may influence a decision at time T.

Every decision must use information available at or before T.

Every execution must have an explicit timestamp.

NEXT_BAR_OPEN means:

decision at bar T
→ execution at bar T+1 OPEN

### Determinism

Same:

- input data
- config
- deterministic seed

must produce the same result.

Unseeded randomness is not acceptable in validation fixtures.

### Accounting

There must be one canonical execution/accounting ledger for the Alpha/Omega portfolio.

UI or sub-bot simulations must not independently manufacture authoritative:

- fills
- cash
- position quantity
- fees
- slippage
- realized PnL
- NAV
- trade statistics

### Research discipline

Do not tune strategy parameters because a backtest looks bad.

Do not alter strategy formulas merely to make tests pass.

A passing test is not proof of correctness.

A failing statistical test is not automatically proof of a strategy bug.

---

## 5. Current Time-Domain Policy

The current executable QuantFund OS engine is a:

**1-HOUR BAR ENGINE**

Current production market state defaults to:

`1h`

Therefore:

`1 bar = 1 hour`

Runtime/backtest logic must not silently interpret one bar as one calendar day.

Multi-timeframe quant support is NOT currently implemented.

Non-1H input must not silently use 1H quantitative assumptions.

---

## 6. Gate Progress

### Gate 0 — Build / Type Contract Repair

Status:

**COMPLETE**

Checkpoint:

`65ea16c2b08710f1f09ac12902c3993f0745686c`

Gate 0 established a compilable baseline and restored type-contract consistency.

---

### Gate 1 — Forensic Audit

Status:

**AUDIT COMPLETE — REPAIRS NOT YET APPLIED**

Gate 1 was read-only.

The audit report was independently reviewed before defining Gate 2.

Important rule:

Agent finding IDs from Gate 1 are evidence candidates, not automatically verified truth.

Independent review reclassified several findings.

---

## 7. Independently Confirmed Core Problems

These findings are currently considered sufficiently evidenced to guide the next repair gate.

### CORE-01 — 1H timeframe mismatch

The production market store defaults to 1H bars, while parts of the quantitative engine still contain daily assumptions including:

- `86_400_000` milliseconds per bar;
- Event Reaction age expressed as elapsed calendar days;
- validUntil calculations treating holding-period bars as days;
- annualization based on `252`;
- CAGR / Sharpe / Sortino time conversion based on daily observations.

This is a core validity issue.

Gate 2 must correct UNITS only.

It must not tune Alpha parameters.

---

### CORE-02 — Historical macro contamination

Paper replay currently reads present/live macro-store values and projects them backward into historical replay.

This violates point-in-time historical integrity.

If genuine historical macro data is unavailable, historical replay must not fabricate it.

---

### CORE-03 — Synthetic event contamination

Paper replay currently generates synthetic CPI / Fed / geopolitical events.

These synthetic events must not be presented as genuine LIVE historical event data.

Synthetic scenarios are allowed only in explicitly synthetic test/simulation contexts.

---

### CORE-04 — Data provenance loss

The market layer knows whether bars are:

- live
- synthetic

That provenance is currently lost before the quant backtest configuration, which can report data as LIVE even when upstream data is synthetic.

Data quality must remain truthful end-to-end.

---

### CORE-05 — Rogue Alpha sub-simulation

`paperEngine.ts::simulateAlphaStrategy()` independently manufactures Alpha:

- target weights
- cash
- quantity
- entry price
- fees
- slippage
- realized PnL
- wins/losses
- fills
- equity curves

This bypasses the canonical:

Permission
→ Risk
→ Omega
→ Execution

pipeline.

It must not remain an authoritative Alpha-performance ledger.

---

### CORE-06 — Fabricated strategy-PnL correlation

The backtest currently creates strategy PnL proxies from:

`alphaScore × total portfolio return`

This is not genuine strategy-level PnL attribution.

That synthetic proxy must not feed an Omega correlation penalty as though it were canonical strategy PnL.

Until real attribution exists, fabricated correlation input should not be used.

---

### CORE-07 — Long-only semantic mismatch

Current execution is long-only.

Omega may emit negative target asset weights while execution clamps them to zero.

Therefore target state can imply a short position while the executable portfolio is actually flat.

Current policy:

Negative Alpha remains valid signal information.

But final executable target weight in the current long-only portfolio must not claim a short position.

---

### CORE-08 — Non-deterministic validation fixtures

Some validation tests use unseeded `Math.random()`.

A prior run produced 8/9 passing tests while a later unchanged run produced 9/9.

Statistical validation fixtures must become deterministic before test results can be used as reliable evidence.

---

## 8. Findings NOT Approved as Gate 2 Core Bugs

The following Gate 1 claims must NOT automatically be implemented as repairs:

### Slippage `baseBps`

Current PaperEngine conversion:

`0.0005 × 10000 = 5 bps`

is mathematically consistent.

Naming may be confusing, but this is not currently a critical accounting defect.

### NEXT_BAR_OPEN close marking

Executing at T+1 open and marking the resulting position to T+1 close is not by itself look-ahead.

Do not redesign peak-NAV accounting solely from the previous audit claim.

### NAV conservation test using close

End-of-bar NAV being marked using close is not inherently incorrect.

A separate explicit NEXT_BAR_OPEN timing test is needed instead.

### Slippage reporting

Slippage is already embedded in execution price.

A separately reported slippage-cost metric is not automatically double-counting NAV.

Do not redesign fee/slippage accounting without a reconciliation-specific finding.

---

## 9. Deferred Issues

Do not mix these into the immediate core repair unless independently required:

- final round-trip trade reconstruction;
- final win-rate definition;
- walk-forward aggregate metric repair;
- walk-forward methodology;
- Adaptive Trend persistence research;
- Mean Reversion trend-guard research;
- Alpha statistical-quality tuning;
- liveRuntime execution API redesign;
- multi-timeframe engine support;
- short-selling implementation;
- real per-strategy PnL attribution;
- real historical macro ingestion infrastructure;
- real historical event ingestion infrastructure;
- broad UI redesign.

---

## 10. Next Gate

Next planned work:

**Gate 2A — Core Validity Repair**

Strict scope:

1. establish one coherent 1H time-domain contract;
2. remove fake/future historical macro/event information;
3. preserve market data provenance and dataQuality;
4. remove rogue Alpha accounting as an authoritative ledger;
5. stop fabricated strategy-PnL correlation from feeding Omega;
6. align long-only Omega target semantics with executable behavior;
7. make validation fixtures deterministic;
8. add a small set of targeted invariant tests.

Gate 2A must NOT:

- tune Alpha parameters;
- change Alpha formulas for performance;
- change Omega base strategy weights;
- change fee/slippage assumptions;
- change DCA architecture;
- implement shorts;
- perform broad research refactors.

---

## 11. Required Workflow

For every major gate:

1. ChatGPT independently verifies current repository state.
2. ChatGPT defines the narrow task/specification.
3. Coding agent reads the REAL local repository.
4. Coding agent implements and runs real tests.
5. Coding agent does not commit or push.
6. Full diff is independently reviewed.
7. Only reviewed changes are accepted.
8. Create local Git checkpoint.
9. Verify clean working tree.
10. Push reviewed checkpoint.
11. Update this PROJECT_STATE.md after the milestone.

No AI agent should independently:

design
→ implement
→ test
→ approve
→ commit

the same architectural change without an independent review step.

---

## 12. Current Immediate Action

Create this PROJECT_STATE.md documentation checkpoint first.

After it is reviewed and committed, Gate 2A begins from that new clean checkpoint.
