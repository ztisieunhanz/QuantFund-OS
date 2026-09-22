# Historical Research Data Protocol (M13B-1)

This protocol defines machine-checkable metadata and coverage rules for immutable, point-in-time historical research snapshots. It does not make a dataset predictive, authorize a model, or grant the dataset any trading authority.

## Fixture data versus research-grade data

The repository's compact M12 samples are deterministic parser and anti-lookahead fixtures. They are not a research-grade history. A snapshot is `RESEARCH_READY` only when it passes the predeclared coverage policy; otherwise it is classified as `FIXTURE_ONLY` or `INSUFFICIENT` with explicit blockers.

## Initial universe

Market/factor series are BTC, PAXG, DXY, VIX, US2Y, and US10Y. Macro series are US_CPI_YOY, US_CPI_MOM, US_CPI_INDEX, US_NFP_NET_CHANGE, US_UNEMPLOYMENT_RATE, and US_FED_FUNDS_TARGET_UPPER. Official FOMC rate decisions and statements are the initial event series.

## Canonical series semantics

The protocol maintains one canonical series-spec table used by manifest validation and coverage assessment. BTC and PAXG are `1H`. DXY, VIX, US2Y, and US10Y are `DAILY`. CPI YoY, CPI MoM, CPI Index, NFP net change, and unemployment rate are `MONTHLY`. `US_FED_FUNDS_TARGET_UPPER` is an `EVENT_DRIVEN` macro-release value derived from official FOMC decisions; it is not treated as a generic monthly release. `FOMC_RATE_DECISION` is an `EVENT_DRIVEN` official event.

Manifest entries fail closed when their kind, cadence, or revision semantics differ from the canonical spec. The minimum monthly-observation requirement applies only to canonically `MONTHLY` series and therefore does not apply to `US_FED_FUNDS_TARGET_UPPER`.

## Point-in-time and revision rules

Every usable record has an explicit `availableAt` timestamp and remains unavailable before that time, in accordance with DEC-015. Monthly releases retain initial and later vintages as separate records where revisions apply. A later vintage cannot replace an earlier value before publication. Timezone and market-session rules must be documented per series.

Consensus is optional and nullable. It is not required because no separately verified point-in-time consensus provider is currently approved. Missing consensus must never be inferred or fabricated.

## Missingness, provenance, and coverage

Each series reports a record count, missing count and counting method, coverage timestamps, provider instrument, availability rule, and a durable source descriptor. Missing observations are not silently interpolated. The coverage policy requires multi-year breadth, sufficiently broad monthly history, at least one observed VIX value at or above the predeclared administrative threshold, observed upward and downward Fed Funds target transitions, PIT availability, and revision-aware storage.

The VIX and rate-direction checks establish only that those observations exist in the snapshot. One elevated VIX datapoint does not establish a stress regime, and one rate move does not establish a tightening or easing phase. Accordingly, the policy and coverage report use observation/transition terminology and `RESEARCH_READY` makes no claim that an economic regime or policy cycle has been represented. These are data-readiness criteria, not guarantees of regime diversity, statistical significance, or predictive validity.

## Immutable snapshot identity

Snapshot identity is computed from normalized historical content plus manifest identity fields, including per-series content hashes. Record and source-entry ordering do not change the canonical input. `createdAt` and `snapshotHash` are excluded from the snapshot preimage to avoid wall-clock dependence and recursive hashing. The module exposes canonical serialization and an injectable cryptographic hashing boundary; production acquisition should supply a documented cryptographic implementation such as SHA-256.

## Architectural boundary

All snapshots have `intendedUse: RESEARCH_ONLY` and `priceAuthority: RESEARCH_CONTEXT_ONLY`. `BacktestDataset.assetBars` remains the sole executable-price authority under DEC-016. During M13, research data and future research telemetry cannot affect Alpha engines, PermissionGate, RiskEngine, OmegaAllocator, target positions, execution, the canonical ledger, or portfolio accounting. Historical context remains audit-first under DEC-017, including DEC-018 carry-forward semantics at walk-forward boundaries.
