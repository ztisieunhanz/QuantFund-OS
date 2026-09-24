# Historical Research Data Protocol (M13B-1)

This protocol defines machine-checkable metadata and coverage rules for immutable, point-in-time historical research snapshots. It does not make a dataset predictive, authorize a model, or grant the dataset any trading authority.

## Fixture data versus research-grade data

The repository's compact M12 samples are deterministic parser and anti-lookahead fixtures. They are not a research-grade history. The legacy M13B-1 coverage API retains its `FIXTURE_ONLY` / `INSUFFICIENT` / `RESEARCH_READY` classifications, but B2-D does not promote an immutable B2-C snapshot merely because its hash is valid. B2-D fails closed as `READINESS_POLICY_UNRESOLVED` until an approved required-versus-optional series policy reconciles the original all-series requirement with the source-audit statuses below.

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

B2-C extends that authoritative identity with the immutable raw-artifact set and explicit per-series acquisition statuses. B2-C-R1 separates the two identity domains that acquisition must not conflate: a canonical `ResearchSeriesId` names normalized research content, while a closed `sourceArtifactType` names the provider-level release, archive, or source dataset that supplied raw bytes. Raw-artifact identity preserves provider, source-artifact type, instrument, request, raw SHA-256, parser, checksum policy/checksum, and licensing classification while excluding retrieval time from the hash preimage.

Canonical manifest provenance must be structured JSON and must explicitly reference every supporting raw artifact identity. Snapshot assembly derives and validates a separate artifact-to-canonical-series link table from that provenance. Provider-to-source-artifact-type approval and source-artifact-type-to-canonical-series compatibility are distinct closed contracts: passing the provider/type check does not authorize that artifact type to support an unrelated canonical series. Every derived link must pass both checks. One artifact may support one or multiple explicitly approved canonical research series, so one BLS CPI release can truthfully support both CPI Index and CPI YoY without duplicating raw bytes or pretending that the release is itself a canonical series. Unknown artifact references, incompatible artifact/series links, acquired series without artifact links, unapproved provider/source-artifact-type pairs, and unlinked artifacts fail closed. The sorted link table is included in the SHA-256 snapshot preimage; changing source identity or canonical linkage changes snapshot identity, while retrieval time and set ordering do not. Manifest sources, raw artifacts, links, and per-series statuses are set-like and sort canonically; record normalization continues to follow the M13B-1 protocol. The assembled snapshot is deeply immutable.

The snapshot-wide `startTime` and `endTime` retain the manifest's requested research window. They are not inferred as a claim that heterogeneous series are complete over a min/max union or intersection. Snapshot assembly reports acquired, not-included, conditional, and blocked series explicitly. It never creates zero-row manifests for unresolved series and leaves readiness as `NOT_EVALUATED`; a valid snapshot hash does not imply `RESEARCH_READY`.

## B2-D coverage and readiness assessment

B2-D evaluates immutable snapshots without changing their identity or embedded `NOT_EVALUATED` assembly marker. It reports the requested window, acquisition status, canonical record and unique-observation counts, declared missingness, first/last observation and availability boundaries, PIT validity, and a coverage ratio only when the approved provider contract supplies a truthful denominator.

Denominators are provider-specific. Binance BTC/PAXG use eligible closed 1H slots from the archive partition contract. H.15 US2Y/US10Y use actual provider source rows, including explicit `.` non-observation witnesses; weekends are not synthesized as missing rows. BLS CPI Index/YoY and NFP use monthly reference periods between accepted bounded releases, with revisions counted separately from periods. FOMC decisions use the bounded official event-date set and never a daily or monthly calendar. Fed Funds target-upper state coverage remains `UNKNOWN` where the manifest does not separately encode which announced states were effective by the boundary. Missing observations are never interpolated, forward-filled, or manufactured.

Revision completeness is independent of observation coverage. NFP expects revision indexes 0, 1, and 2 only as their initial, first-revision, and second/final regular release opportunities become public. A missing NFP revision can therefore make revision completeness `INCOMPLETE` while monthly observation coverage remains `COMPLETE`. CPI Index/YoY preserve observed as-published vintages, but the approved contract does not define a universal final-vintage opportunity count, so final revision completeness remains `UNKNOWN` when all initial vintages are present. Binance, H.15, and FOMC events have no manufactured revision requirement; Fed Funds target upper remains `INITIAL_ONLY`.

Current source status is explicit: BTC, PAXG, US2Y, US10Y, CPI Index, CPI YoY, NFP, Fed Funds target upper, and FOMC decisions are acquired when present in a validated snapshot; VIX and DXY remain `BLOCKED`; CPI MoM and unemployment remain `CONDITIONAL`; other supported-but-absent content is `NOT_INCLUDED`. Blocked or conditional series receive no fake zero-row manifest.

The original M13B-1 policy lists every canonical series as required, while approved source evidence leaves four of those series unresolved. No approved document currently says which unresolved series are mandatory or optional for B2-D readiness. The evaluator therefore emits the machine-readable reason `REQUIRED_SERIES_POLICY_UNRESOLVED` and cannot return `RESEARCH_READY`. This limitation must be resolved by an independently approved data policy, not by acquisition code. Readiness, once definable, will mean only compliance with the historical data-quality, coverage, PIT, and revision contract. It will not establish profitability, predictive validity, statistical significance, ActionDecision eligibility, paper allocation, or execution authority.

## Architectural boundary

All snapshots have `intendedUse: RESEARCH_ONLY` and `priceAuthority: RESEARCH_CONTEXT_ONLY`. `BacktestDataset.assetBars` remains the sole executable-price authority under DEC-016. During M13, research data and future research telemetry cannot affect Alpha engines, PermissionGate, RiskEngine, OmegaAllocator, target positions, execution, the canonical ledger, or portfolio accounting. Historical context remains audit-first under DEC-017, including DEC-018 carry-forward semantics at walk-forward boundaries.
