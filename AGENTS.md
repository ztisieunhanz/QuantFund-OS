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
- A reviewed push becomes a verified checkpoint only after the required CI run passes; local validation remains mandatory.
- If CI fails, do not rewrite history. Identify the root cause, make a same-gate refinement, validate locally, and push a follow-up commit for CI.
- Never force push.
- Never destructively reset, checkout, clean, or discard uncommitted user work.
- Do not install packages or change dependencies without explicit need and approval.
- Never place secrets in review bundles.
- Handoffs must be product-independent and include the current HEAD, status, diff or patch, validation evidence, and an inventory or safe copies of relevant untracked files.
- Never infer repository state from chat memory. On any agent, provider, or quota failure, preserve and hand off filesystem and Git evidence; never discard work in progress.
- Store handoffs outside the repository in an environment-specific location; never assume a username or fixed absolute path.
