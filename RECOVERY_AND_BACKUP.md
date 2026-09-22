# Recovery and Backup Policy

## Code recovery

- Create reviewed commits and push each accepted gate. A push is a verified checkpoint only after its required CI run passes.
- Planned major-gate tags: `m13-complete`, `m14-complete`, `m15-complete`, `m16-complete`, `m17-rc`, and `v1.0`.
- Git history, local validation evidence, source-of-truth documents, and CI are authoritative. Local validation remains required; CI is the independent checkpoint authority after push.
- If CI fails, do not amend, reset, rebase, or force push. Record the root cause, correct it as a same-gate refinement, rerun local validation, and push a follow-up commit for CI.

## Uncommitted work handoff

Handoff storage must be outside the repository. Its location is machine/environment-specific; agents must not assume a particular Windows username or absolute path.

On this current machine, the preferred example/default is:

```text
C:\Users\acer\Documents\QuantProjects\_handoffs\
```

On another machine or environment, use an equivalent external directory.

A handoff should contain, as applicable:

- The current branch and exact `HEAD`
- `status.txt`
- `diff.patch`
- An inventory and safe copies of relevant untracked files
- `validation.txt`
- `review-bundle.txt`

Handoffs must remain product-independent: repository state is reconstructed from filesystem and Git evidence, never from chat memory or a provider-specific session. Never include secrets. If any agent, provider, or quota fails: do not reset, checkout, stash, clean, or discard work in progress; inspect status and diff, preserve the handoff evidence, and continue the same gate with another agent or environment.

## Research data recovery

Each production research dataset must eventually include a manifest, schema version, provenance, normalized snapshot identity, cryptographic hash, and immutable/versioned storage. Historical snapshot identity must never be silently overwritten.

## Application state recovery

M15 and M17 must establish paper portfolio/state persistence, an export/restore or equivalent recovery path, restart testing, and fail-closed behavior for corrupt state.

## Provider failure

Use a fallback only when it is explicitly approved and semantically compatible. Otherwise report `STALE` or `UNAVAILABLE`. Never fabricate values.

## Deployment rollback

M17 must prove that a failed release can return to the prior known-good build and version.

## Methodology fallbacks

- Macro shows no edge: keep it explanatory only.
- Derived multi-timeframe context is not useful: retain the 1H action policy.
- A custom rule fails: mark it `REJECTED`; keep the engine usable.
- Action integration breaks canonical parity: disable the integration and preserve the baseline canonical pipeline.
