# QuantFund-OS Agent Operating Rules

These rules always apply to major repository tasks.

## Startup sequence

1. Run `git rev-parse HEAD`.
2. Run `git status --short`.
3. Read `PROJECT_STATE.md`, `DECISIONS.md`, `ROADMAP_V1.md`, and `ARCHITECTURE_V1.md`.
4. Identify the current gate.
5. Confirm scope before editing.

## Invariants

- Use point-in-time data only; future information is prohibited.
- 1H is the canonical execution domain.
- Maintain one canonical ledger and long-only execution unless separately approved.
- Never fabricate market, macro, or consensus data; never label synthetic fallback as real.
- Research is not action; action is not final size.
- Rules cannot bypass Permission, Risk, or Omega.
- `BacktestDataset.assetBars` remains the executable-price authority.
- Do not expand milestones beyond M17 automatically.
- Do not tune parameters merely because results look bad.

## Required workflow

```text
PRECHECK
→ IMPLEMENT NARROW SCOPE
→ FOCUSED TEST
→ FULL TEST
→ BUILD
→ DIFF CHECK
→ REVIEW BUNDLE
→ INDEPENDENT REVIEW
→ CORRECTION IF REQUIRED
→ FINAL VALIDATION
→ DOC SYNC IF STATE CHANGED
→ COMMIT
→ PUSH
→ CI
→ CLEAN TREE
```

- Do not commit before review unless explicitly instructed.
- Never force push.
- Never destructively reset, checkout, clean, or discard uncommitted user work.
- Do not install packages or change dependencies without explicit need and approval.
- Never place secrets in review bundles.
- On agent/provider/quota failure, hand off using filesystem and Git evidence; never reconstruct uncommitted work from memory.
- Store handoffs outside the repository in an environment-specific location; never assume a username or fixed absolute path.
