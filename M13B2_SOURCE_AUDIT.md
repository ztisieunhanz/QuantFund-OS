# M13B-2 / B2-A Historical Research Data Source Audit

**Audit date:** 2026-09-22
**Starting checkpoint:** `8689339a91d41eafc9e9a04a4985bba9b15e11ea`
**Scope:** documentation-only source and acquisition contract audit
**Authority:** `RESEARCH_SERIES_SPECS` in `src/lib/quant/researchDataProtocol.ts`

## 1. Executive conclusion

**Decision: CONDITIONAL GO for B2-B.**

B2-B may implement acquisition and normalization adapters for the source-resolved series and small contract-verification fixtures for the conditional series. It must not claim a complete dataset or `RESEARCH_READY` status while any required series remains unresolved.

- Nine series have a sufficiently explicit provider, instrument, acquisition path, timestamp rule, and PIT reconstruction path: BTC, PAXG, US2Y, US10Y, CPI YoY, CPI Index, NFP net change, Fed Funds target upper, and FOMC rate decisions.
- Two series are conditional pending a deterministic source proof: CPI MoM must prove reconstruction of annual seasonal-adjustment vintages, and unemployment must prove complete as-published vintage mapping rather than ingesting today's revised history.
- VIX is blocked. The official free Cboe historical CSV provides daily closing values but does not establish a defensible per-row historical availability timestamp across ordinary, early-close, and GTH-only dates.
- DXY is blocked. ICE is the official administrator and offers historical daily data through licensed ICE data products. The existing Yahoo `DX-Y.NYB` path is useful M12 evidence but is not an approved official research-grade substitute and has no verified historical publication-time contract.

No source in this audit changes the execution-price boundary. Every acquired series remains `RESEARCH_CONTEXT_ONLY`; `BacktestDataset.assetBars` remains the sole executable-price authority.

## 2. Canonical source matrix

| Canonical ID | Kind | Cadence | Revision | Intended provider / exact instrument | Acquisition mechanism | PIT status |
|---|---|---:|---|---|---|---|
| `BTC` | `MARKET_FACTOR` | `1H` | `NOT_APPLICABLE` | Binance Spot `BTCUSDT`, interval `1h` | Binance Public Data monthly/daily kline ZIP plus `.CHECKSUM`; public Spot klines endpoint only for gap checks | RESOLVED |
| `PAXG` | `MARKET_FACTOR` | `1H` | `NOT_APPLICABLE` | Binance Spot `PAXGUSDT`, interval `1h` | Same Binance Public Data contract | RESOLVED |
| `DXY` | `MARKET_FACTOR` | `DAILY` | `NOT_APPLICABLE` | ICE U.S. Dollar Index, `DXY` / ICE identifier `NYICDX` | Licensed ICE Data API, Data Files, or Consolidated History | **BLOCKED** pending licensed access and exact EOD field contract |
| `VIX` | `MARKET_FACTOR` | `DAILY` | `NOT_APPLICABLE` | Cboe VIX Index, `VIX` | Official free Cboe `VIX_History.csv` daily closing-value download; timestamped Cboe Global Indices/EOD history is a possible future source subject to access and licensing | **BLOCKED** pending a defensible per-row PIT availability contract |
| `US2Y` | `MARKET_FACTOR` | `DAILY` | `NOT_APPLICABLE` | Federal Reserve H.15 / FRED `DGS2` | FRED/ALFRED observations API `output_type=4` initial-release rows plus the Board's H.15 calendar/time contract | RESOLVED for the bounded 2021-01-01 through 2026-09-21 observation regime; FRED API key required |
| `US10Y` | `MARKET_FACTOR` | `DAILY` | `NOT_APPLICABLE` | Federal Reserve H.15 / FRED `DGS10` | Same H.15/FRED initial-release contract | RESOLVED for the same bounded regime; FRED API key required |
| `US_CPI_YOY` | `MACRO_RELEASE` | `MONTHLY` | `VINTAGE_AWARE` | BLS CPI-U All Items 12-month percent change, NSA; underlying `CUUR0000SA0` | Official archived BLS CPI HTML releases with explicit release header and published NSA summary | RESOLVED / IMPLEMENTED for bounded 2021-01 through 2026-08 reference-period regime |
| `US_CPI_MOM` | `MACRO_RELEASE` | `MONTHLY` | `VINTAGE_AWARE` | BLS CPI-U All Items 1-month percent change, SA; Table A; underlying `CUSR0000SA0` | BLS archived releases, monthly supplemental files, and annual seasonal-adjustment archives | **CONDITIONAL** |
| `US_CPI_INDEX` | `MACRO_RELEASE` | `MONTHLY` | `VINTAGE_AWARE` | BLS CPI-U All Items index, NSA, `CUUR0000SA0` | Official archived BLS CPI HTML releases with explicit release header and published NSA summary | RESOLVED / IMPLEMENTED for bounded 2021-01 through 2026-08 reference-period regime |
| `US_NFP_NET_CHANGE` | `MACRO_RELEASE` | `MONTHLY` | `VINTAGE_AWARE` | BLS CES Total Nonfarm over-the-month change; underlying level `CES0000000001` | Official archived Employment Situation HTML releases, corroborated by official CES vintage documentation/files | RESOLVED / IMPLEMENTED for bounded 2021-01 through 2026-08 reference-period regime |
| `US_UNEMPLOYMENT_RATE` | `MACRO_RELEASE` | `MONTHLY` | `VINTAGE_AWARE` | BLS CPS unemployment rate, SA, `LNS14000000` | Employment Situation archived releases and annual CPS seasonal-adjustment revision material; ALFRED `UNRATE` may validate value-vintage mapping | **CONDITIONAL**; no broad executable adapter |
| `US_FED_FUNDS_TARGET_UPPER` | `MACRO_RELEASE` | `EVENT_DRIVEN` | `INITIAL_ONLY` | Federal Reserve FOMC statement target-range upper bound; FRED `DFEDTARU` is cross-check only | Official statement HTML/PDF and press-release metadata | RESOLVED from 2008 target-range era |
| `FOMC_RATE_DECISION` | `OFFICIAL_EVENT` | `EVENT_DRIVEN` | `NOT_APPLICABLE` | Federal Reserve FOMC policy statement / rate decision | FOMC calendar plus official statement HTML/PDF | RESOLVED |

## 3. Detailed source contracts

### 3.1 Binance Spot 1H — BTC and PAXG

**Source identity**

- Provider: Binance.
- Instruments: `BTCUSDT` and `PAXGUSDT` Spot pairs, not composite BTC/USD and not physical or OTC gold.
- Archive pattern: `https://data.binance.vision/data/spot/monthly/klines/{SYMBOL}/1h/{SYMBOL}-1h-{YYYY}-{MM}.zip`.
- Integrity witness: sibling `.CHECKSUM` file supplied by Binance.
- API gap-check endpoint: public `/api/v3/klines`; no signed account endpoint is needed.

**Timestamp contract**

- Raw timestamps: kline open time at field 0 and close time at field 6.
- Canonical `observationTime`: kline open time in UTC.
- Canonical `availableAt`: `openTime + 3,600,000 ms`; the final close cannot be used before candle completion.
- `providerTimestamp`: raw close time, retained separately from `availableAt`.
- Binance documents microsecond timestamps for Spot archive data from 2025-01-01 onward. B2-B must detect/normalize units deterministically before applying the M12 parser contract; blindly interpreting all archive values as milliseconds is invalid.

**Coverage and missingness**

- Expected BTC coverage begins with Binance Spot history in 2017; expected PAXG coverage begins with the pair's 2020 listing/archive. Exact first-file dates must be inventory evidence in the manifest, not hard-coded assumptions.
- Expected slots are hourly UTC slots only after the instrument's first valid archive record and through the closed acquisition boundary.
- Missingness excludes pre-listing time and the still-open current hour. Any interior missing hour is recorded; it is never forward-filled.

**Acquisition and failure policy**

- Public HTTPS, no key. Download time and HTTP metadata are provenance, not market availability.
- Verify every ZIP against Binance's published checksum and record archive URL, checksum URL, checksum digest, retrieval time, and parser version.
- If an archive/checksum is absent, malformed, later replaced, or inconsistent with a gap-check response, fail that partition. A replacement creates a new immutable snapshot; no synthetic bars and no silent cross-provider substitution.

### 3.2 DXY — ICE U.S. Dollar Index

**Source identity and blocker**

- Official administrator/instrument: ICE U.S. Dollar Index, symbol `DXY`; ICE documentation also identifies `NYICDX`.
- ICE documents daily and historical delivery through ICE Data API, ICE Data Files, ICE Connect, or Consolidated History. This is licensed market data; this audit did not verify an unauthenticated official bulk-history endpoint or redistribution right.
- Existing M12/live code uses Yahoo chart symbol `DX-Y.NYB`. That path does not establish ICE licensing, an authoritative close field, correction policy, or historical publication timestamp. It is not approved for M13B-2 `RESEARCH_READY` acquisition.

**Required contract before implementation**

- Obtain licensed ICE access or written approval for a specifically named alternative.
- Freeze exact product identifier, daily field (official close/EOD index level), calendar, currency/index unit, publication timestamp or conservative provider-documented availability boundary, correction policy, history start, and redistribution/storage terms.
- Canonical `observationTime` is the ICE index session date/time represented by the chosen EOD field. `availableAt` must come from the chosen ICE delivery/publication contract; it must not be inferred merely from the observation date.

**Status:** blocked. B2-B must not silently fall back to Yahoo, a futures proxy, a trade-weighted-dollar series, or a synthetic currency basket.

### 3.3 VIX — official Cboe daily history

**Source identity**

- Provider/instrument: Cboe VIX Index (`VIX`).
- Official download: `https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv`, linked by Cboe's VIX historical-data page as daily closing values from 1990 to present.
- Use the `CLOSE` field, not VIX futures or an ETF proxy.

**Timestamp blocker**

- Raw source timestamp: Cboe `DATE`; source file has date-level history, not a per-row download timestamp.
- The free CSV does not expose a per-row publication timestamp, effective business date, or session identifier. Official free-source documentation does not establish whether a row's `CLOSE` is tied to the ordinary RTH endpoint, an early-close endpoint, a GTH-only segment, or another end-of-day convention.
- A universal 16:15 `America/New_York` rule is not approved. Some CSV rows occur on dates with no RTH but with GTH, and those rows must not be excluded merely to force an RTH-only contract.
- Canonical `observationTime` and `availableAt` must remain unassigned for research-grade ingestion until the source contract is resolved. Acquisition time must not be substituted for historical availability.
- Cboe Global Indices feed/EOD historical products expose or may preserve timestamped close/effective-date evidence and are a possible future resolution path, subject to approved access, licensing, exact field semantics, and a verified historical contract. This audit does not claim that paid access has been obtained.

**Coverage and missingness**

- The free file contains history from 1990 to present, but that history is not approved for PIT normalization while per-row availability remains unresolved.
- A coverage denominator cannot be inferred from generic weekdays or RTH sessions because valid source rows can exist on GTH-only/no-RTH dates. No interpolation, row deletion, or synthetic calendar repair is allowed.
- Public HTTPS requires no key for the free CSV. That accessibility does not resolve PIT timestamp semantics. Yahoo `^VIX`, VIX futures, and ETF proxies are not automatic research-grade fallbacks.

**Status:** blocked. Do not implement or expose a VIX acquisition adapter until a defensible timestamped source contract is approved.

### 3.4 Federal Reserve H.15 — US2Y and US10Y

**Source identity**

- Provider: Board of Governors H.15 Selected Interest Rates; FRED is an official Federal Reserve Bank distribution channel.
- Exact series: `DGS2` and `DGS10`, daily Treasury constant-maturity yields, percent, not seasonally adjusted.
- Acquisition: Board H.15 Data Download Program/preformatted CSV while available, or FRED/ALFRED `fred/series/observations` API. The Board is transitioning expanded downloads toward FRED.

**Timestamp contract**

- Raw observation date: the Treasury constant-maturity market date.
- Raw release witness: `realtime_start` from FRED/ALFRED `fred/series/observations` with `output_type=4` (Observations, Initial Release Only). Observation date, current-value CSV retrieval time, and generic FRED release-calendar dates are insufficient by themselves.
- Canonical `observationTime`: UTC midnight for the market observation date.
- Canonical `availableAt`: 16:15 `America/New_York` on the witnessed initial-release date. The Board's calendars explicitly schedule H.15 at 4:15 p.m. ET and identify holiday deferrals; historical DST conversion must use `America/New_York` rather than a fixed UTC offset.
- The implemented support regime is intentionally bounded to observation dates from 2021-01-01 through 2026-09-21 and release dates through 2026-09-22. Official Board calendars at the beginning and throughout that interval show the same 4:15 p.m. H.15 schedule. Rows outside that proven regime fail closed.
- The initial-release date must be later than the observation date. This prevents `availableAt = observationTime`, same-date midnight, market-close, retrieval-time, and arbitrary-next-day shortcuts.
- Holiday and Board-closure handling comes from the witnessed `realtime_start` date. The adapter does not infer release dates from a generic Monday-Friday or federal-holiday calendar.

**Revisions, coverage, and access**

- H.15 values can be corrected or initially omitted; the Board's announcement feed documents such cases, including a September 2023 Treasury-rate omission. The B2-B3 adapter therefore consumes only ALFRED initial-release rows and never assigns a current corrected value to an earlier initial-release boundary.
- Protocol semantics remain `NOT_APPLICABLE`: these are initial-published market observations, not a macro-vintage series. Later provider corrections are not silently rewritten into the bounded initial-release dataset; a different correction-aware contract would require separate approval.
- Coverage uses source-emitted `output_type=4` rows. A `.` value is an explicit non-observation counted as missing; generic weekdays, interpolation, forward fill, and backfill are prohibited.
- FRED API v1 requires an API key and enforces rate limits (documented as up to 120 requests/minute). The key is runtime-only and is excluded from artifact identity, provenance, errors, fixtures, and review material. A current Board/FRED CSV without initial-release metadata is not sufficient for PIT acquisition.
- No Treasury futures or Yahoo yield proxy is permitted.

### 3.5 BLS CPI family

**Canonical measures**

- `US_CPI_YOY`: direct published 12-month CPI-U All Items percent change, not seasonally adjusted, Table A; underlying BLS series `CUUR0000SA0`.
- `US_CPI_MOM`: direct published 1-month CPI-U All Items percent change, seasonally adjusted, Table A; underlying `CUSR0000SA0`.
- `US_CPI_INDEX`: CPI-U All Items index level, not seasonally adjusted, `CUUR0000SA0`, index 1982-84=100.

The two percent-change series are measures, not aliases for index-level series. If a value is derived from levels for validation, both levels must come from the same publication vintage and the derived result must reconcile to the directly published figure within a declared rounding tolerance.

**Acquisition and timestamps**

- B2-B4 acquisition is deliberately limited to official archived BLS CPI HTML releases at `www.bls.gov/news.release/archives/cpi_MMDDYYYY.htm`. The parser requires the archive URL date, the release's `USDL` identity, the reference-month title, the explicit embargo header, and the published CPI-U NSA summary sentence to agree.
- The accepted value source is the archived release's explicit statement that CPI-U changed by the stated 12-month percentage to the stated NSA index level. YoY is not recomputed from a later database index.
- Raw timestamps are the reference month and the archived release's official release date/time witness. The modern archive includes both weekday-bearing and older date-only header variants; both must still state the same explicit `8:30 a.m. (ET)` boundary.
- Canonical `observationTime`: reference-month end at UTC midnight, matching the M12 contract.
- Canonical `publishedAt` and `availableAt`: the witnessed release date at 08:30 `America/New_York`, converted with historical DST. A different or missing release time fails closed rather than being inferred from a schedule or acquisition time.
- Acquisition time is provenance only.
- BLS does not publish a checksum for these HTML releases. Raw SHA-256 and immutable artifact identity are retained with `providerChecksumPolicy = NOT_PUBLISHED`; no checksum is invented.
- A page carrying a reissue, correction, or errata notice is rejected by this bounded parser. It requires a separately approved correction contract so a corrected page cannot be backdated silently to its original embargo time.

**Vintage semantics**

- Every distinct accepted as-published value for an observation month is a separate canonical `HistoricalMacroRelease` with its own `vintageDate`, publication timestamp, release identity evidence, raw artifact identity, and monotonically ordered `revisionIndex`.
- CPI YoY and the unadjusted index use the archived as-published release. BLS describes CPI-U as final when released; if a later accepted artifact repeats an unchanged value, no synthetic duplicate revision is created. Conflicting release identity or correction ambiguity fails closed.
- CPI MoM is seasonally adjusted. BLS recalculates seasonal factors annually and can revise the previous five years. The narrow proof confirms a concrete change: the December 2023 all-items monthly SA value was published as `0.3` in release `USDL-24-0019` on 2024-01-11 and appears as `0.2` after the annual recalculation in the 2024-02-13 release. This proves current revised SA history cannot be backdated, but one representative pair does not prove complete release-by-release vintage reconstruction for the required window. CPI MoM therefore remains **CONDITIONAL**, and no broad CPI MoM adapter is exposed.
- ALFRED `CPIAUCNS`/`CPIAUCSL` can be a cross-check or explicit secondary source because `fred/series/observations` output types 2/3/4 return value-vintage mappings. Vintage-date metadata without the corresponding value rows is insufficient.

**Coverage, access, and missingness**

- The implemented parser is bounded to reference periods 2021-01 through 2026-08, the modern HTML archive regime examined in B2-B4. It fails closed outside that range and on unsupported/reissued schemas. A production acquisition must still inventory at least 60 accepted monthly reference periods.
- Expected periods are monthly reference periods between the first and last accepted releases, not elapsed days. Revisions add vintages rather than periods; internal gaps are reported without interpolation, and unknown trailing future periods are not marked missing.
- BLS archives are public HTTPS. BLS API v1 is unauthenticated with lower limits; v2 registration increases limits. ALFRED API requires a secret API key, which must never enter manifests or snapshots.

### 3.6 BLS Employment Situation — NFP and unemployment

**NFP source contract**

- Canonical measure: directly published seasonally adjusted over-the-month Total Nonfarm employment change, thousands of persons.
- Provider identifier: BLS CES Total Nonfarm; underlying employment-level series `CES0000000001`.
- The B2-B6 implementation uses official archived Employment Situation HTML releases as the primary executable artifacts. It requires the direct headline monthly change, the two explicit prior-month revision sentences, the `USDL` release identity, the archive URL date, and the explicit embargo header to agree. It never derives NFP by subtracting current employment levels.
- Official CES Total Nonfarm vintage files (`cesvin00.xlsx` and the official CES vintage ZIP/CSV) corroborate the publication model and remain an audit/expansion source rather than a second executable parser in this bounded gate.
- BLS states the vintage tables include both employment levels and over-the-month changes and preserve published values from first preliminary estimates onward (current-method vintages from May 2003).
- BLS revises an initial CES monthly estimate in each of the next two releases. B2-B6 maps these source-defined publications to canonical `revisionIndex` 0 (initial), 1 (first revision), and 2 (second/final regular revision). The prior-published value in each revision sentence must agree with any supplied preceding vintage or acquisition fails closed.
- Annual benchmark and seasonal-readjustment effects that are explicitly reflected in those two regular revision sentences are preserved. Later benchmark-restated historical tables are not ingested as extra vintages in this implementation; extending beyond the regular three-publication sequence requires a separately reviewed contract.
- The implemented parser is bounded to reference periods 2021-01 through 2026-08 and the examined modern archive schema. Unsupported, corrected/reissued, ambiguous, conflicting, or out-of-regime artifacts fail closed.
- Do not subtract a revised level from a different vintage. If levels are used by a future extension, both months must be from the exact same publication row/vintage.

**Unemployment source contract and condition**

- Canonical measure: seasonally adjusted CPS unemployment rate, percent, BLS series `LNS14000000`.
- Primary evidence: as-published Employment Situation archived releases. ALFRED `UNRATE` output with explicit value-vintage rows may be used as a secondary reconstruction/validation source.
- The current BLS API series is not sufficient by itself because it does not promise the full historical sequence of values known at each release.
- Archived releases do expose the actual as-published monthly unemployment rate. They also prove that current history can differ: October 2023 was first published as `3.9` percent and was shown as `3.8` after the January 2024 annual seasonal-adjustment revision.
- BLS states that seasonally adjusted CPS history for the previous five years is revised annually and that population-control changes can introduce additional comparability and correction issues. The 2026 January estimate was revised in March without reissuing its original Employment Situation release, demonstrating that archived headline pages alone do not enumerate every later value-vintage transition.
- B2-B6 therefore does not establish a complete deterministic five-year mapping across annual seasonal revisions, population-control changes, errata, and non-reissued releases. `US_UNEMPLOYMENT_RATE` remains **CONDITIONAL**; no broad executable unemployment acquisition function or canonical unemployment release output is exposed.
- A future resolution must inventory every required initial and revised value against its exact official publication artifact and release boundary. Missing evidence must fail closed rather than being replaced with today's revised value.

**Shared timestamps and coverage**

- Raw timestamps: reference month, release date, release time, archive/release ID, and vintage publication row/date.
- Canonical `observationTime`: reference-month end at UTC midnight.
- Canonical `publishedAt`/`availableAt`: each accepted archived release's explicitly witnessed 08:30 ET boundary, converted in `America/New_York` with historical DST. The B2-B6 parser rejects rather than assumes a different or missing release clock.
- Expected denominator: scheduled monthly Employment Situation releases. Missing/cancelled releases and explicit errata are recorded; weekends are irrelevant.
- For NFP, expected observation periods are monthly reference periods; revisions add vintages rather than periods. Missing reference periods and publication opportunities for revision indexes 0/1/2 are reported separately without interpolation or forward fill.
- `releasedThroughMs` filters the complete PIT-facing result. A future release contributes no macro row, evidence row, raw artifact identity/hash, manifest provenance, normalized identity, or coverage endpoint.
- Public BLS archives/vintage files need no secret. ALFRED validation requires an API key and is subject to its rate limit.

### 3.7 Federal Reserve FOMC — target upper and rate-decision events

**Source identity**

- Primary source: Federal Reserve FOMC calendars and official policy-statement/press-release HTML or PDF.
- `US_FED_FUNDS_TARGET_UPPER`: target-range upper bound stated in the policy decision.
- `FOMC_RATE_DECISION`: the corresponding official `FED_RATE_DECISION`/statement event.
- FRED `DFEDTARU` is a useful official cross-check for the effective upper-limit level after 2008, but its repeated daily values must not be ingested as event-driven decisions.

**Timestamp contract (B2-B5 bounded implementation)**

- Raw timestamps: meeting date, press-release date, and explicit “For release at” time from the official statement page.
- Canonical event/macro `observationTime`: UTC midnight for the meeting decision date, preserving the M12 parser contract.
- `FOMC_RATE_DECISION.publishedAt` and `availableAt`: the statement's witnessed public release date/time in `America/New_York`, DST-aware. The B2-B5 parser does not assume 14:00 without the artifact's explicit `For release at` witness.
- The paired official implementation note supplies a separate effective date for the Desk directive. B2-B5 preserves that date as provenance and represents its deterministic canonical boundary as 00:00 `America/New_York` at the start of the named effective date; this is a date-boundary representation, not a claim that the provider published an exact effective clock time.
- `US_FED_FUNDS_TARGET_UPPER.publishedAt` remains the public statement time, while its replay `availableAt` is `max(statement release, effective-date boundary)`. This prevents announced-but-not-yet-effective policy state from appearing operational early without pretending that the decision itself was unknowable until the effective date.
- The snapshot `releasedThroughMs` boundary filters the entire PIT-facing result: unreleased decisions cannot expose event/evidence rows, raw artifact identities or hashes, manifest provenance URLs, normalized rows, or coverage endpoints. Target-state rows remain separately gated by their effective boundary.
- The target-upper series creates one `revisionIndex: 0` value per numeric policy decision, including unchanged decisions. Event completeness stays explicit and no daily carry-forward macro releases are created.
- `FOMC_RATE_DECISION` actual is the upper bound for numeric rate decisions and `null` for qualitative-only statements. Consensus and surprise remain `null` without an independently approved PIT consensus source.

**Bounded source evidence and regime**

- Supported B2-B5 regime: January 27, 2021 through September 16, 2026, using the official meeting calendar, annual FOMC press-release indexes, same-day policy statement HTML, and paired implementation-note HTML.
- Representative official statement evidence proves explicit 2:00 p.m. EST/EDT release witnesses across the regime: January 27, 2021 (unchanged, EST), March 16, 2022 (increase, EDT), June 14, 2023 (unchanged, EDT), September 18, 2024 (decrease, EDT), January 29, 2025 (unchanged, EST), and July 29, 2026 (unchanged, EDT).
- Paired implementation notes state that the Desk directive is effective on the following date for those representatives, including March 17, 2022 and September 19, 2024. Statement and implementation ranges must agree exactly or acquisition fails.
- Official annual FOMC release indexes for 2021 through September 2026 enumerate the regular policy statements and show no emergency/intermeeting target decision in this bounded window. An event identity outside the frozen calendar denominator fails closed and requires a separately reviewed exceptional-event regime; it is never silently omitted.
- Corrected/reissued statement semantics are not approved. A correction/reissue marker fails closed rather than being forced into `INITIAL_ONLY`.

**Coverage and failure policy**

- Target-range upper coverage can begin in December 2008 in a future expanded regime. The implemented B2-B5 contract is deliberately bounded to 2021-01-27 through 2026-09-16 and supports both upward/downward transition observations when the selected snapshot contains them.
- The statement archive is public HTTPS and needs no secret. Each normalized decision retains statement and implementation-note URLs, release/event/effective dates, release time/zone, action, target bounds, raw artifact identities/hashes, and parser version.
- Missing exact release-time witness, ambiguous target language, emergency/intermeeting action ambiguity, or source conflict fails that event. `DFEDTARU` may flag a conflict but cannot silently replace the statement timestamp.

## 4. PIT and revision analysis

The canonical time fields are distinct:

1. **Observation/event time** identifies the market interval, reference month, market date, or meeting date being described.
2. **Source publication/release time** is when the provider says the value/document was released.
3. **`availableAt`** is the earliest defensible instant the normalized value can enter research. It equals candle completion for Binance and the verified publication/close boundary for daily/macro/event sources.
4. **Acquisition time** is when the pipeline downloaded the artifact. It is provenance and must not be substituted for historical availability.

For all `VINTAGE_AWARE` series, the normalized identity is `(seriesId, observationTime, revisionIndex, publishedAt/availableAt, value)`. A current BLS/FRED value cannot overwrite an earlier vintage. ALFRED is acceptable only when the actual value-vintage rows are retrieved (for example observations output types 2/3/4), not when only `series/vintagedates` metadata is collected.

## 5. Canonical content and snapshot hashing

The repository's `buildResearchSnapshotCanonicalInput` hashes normalized dataset content plus manifest identity, with series entries sorted deterministically. `createdAt` and `snapshotHash` are excluded.

B2-B should preserve two related identities:

- **Raw acquisition identity:** provider, instrument/series ID, exact URL/request parameters, response headers where stable, retrieval time, provider checksum when supplied, raw-byte SHA-256, parser version, and licensing classification.
- **Canonical normalized identity:** every validated historical record field plus manifest fields already included by M13B-1, including each per-series normalized content hash.

Acquisition time and transient transport headers must not change the canonical normalized hash. A changed raw artifact or provider correction must create a new immutable snapshot/version; it must never mutate an accepted snapshot in place.

## 6. Coverage and missingness expectations

- The readiness policy requires at least five years for every required series and at least 60 unique periods for canonically monthly series.
- The likely common-window constraint is PAXG, whose Binance history begins around its 2020 listing. B2-B must discover and record the exact first valid archive record.
- Market missingness denominators use eligible provider sessions/slots after listing and before the final closed boundary: 24/7 hourly slots for Binance, ICE's contracted calendar for DXY, and H.15 publication-eligible observations for yields. The VIX denominator remains blocked until its source date/session semantics are resolved.
- Macro denominators use scheduled/released reference periods, not elapsed days. Revisions add vintages but not new observation periods.
- FOMC denominators use official policy decisions/statements in the chosen window, including emergency/intermeeting actions when they meet the same source contract.
- No series is interpolated solely to improve readiness. Closures, holidays, nonpublication, unavailable values, and provider corrections remain explicit.

## 7. Provider, authentication, rate-limit, and network requirements

| Provider | Network/auth contract |
|---|---|
| Binance Public Data | Public HTTPS; no key for archive/checksums or public market-data endpoint; throttle requests and prefer monthly files over API crawling. |
| ICE Data Services | Licensed account/product entitlement expected; exact credentials, limits, and storage/redistribution rights unresolved. |
| Cboe | Public HTTPS historical CSV; no key observed for the free daily VIX file, but its per-row PIT availability contract is unresolved. Timestamped Global Indices/EOD historical data is a possible future path subject to access and licensing approval. |
| Federal Reserve Board H.15 | Public page/download; no secret for Board files. |
| FRED/ALFRED API | Registered API key required; documented limit up to 120 requests/minute; secret supplied at acquisition runtime only. |
| BLS | Public archives/files; API v1 unauthenticated, API v2 registration key for higher limits. Prefer archived files over high-volume API calls. |
| Federal Reserve FOMC | Public HTML/PDF; no key. Use polite bounded retrieval and immutable local raw cache during B2-B. |

No credential value belongs in source code, manifests, normalized records, snapshot hashes, logs, fixtures, or review bundles.

## 8. Failure and fallback policy

1. Fail closed on absent source artifacts, invalid checksum, unsupported schema, ambiguous timestamp, non-finite values, unit mismatch, duplicate conflicts, impossible PIT ordering, or incomplete vintage mapping.
2. Retry only transient transport/rate-limit failures with bounded backoff. A retry does not alter historical `availableAt`.
3. Never synthesize missing records, forward-fill to hide missingness, or relabel a proxy as the canonical series.
4. A fallback is allowed only after explicit source-contract approval and must receive its own provider/instrument/provenance identity. No automatic Binance-to-other-exchange, ICE-to-Yahoo, Cboe-to-Yahoo, H.15-to-futures, or BLS-to-current-value fallback.
5. Provider corrections create a new raw hash and immutable dataset snapshot. Preserve the superseded snapshot and document why the source changed.
6. If one required series remains blocked, the dataset cannot be `RESEARCH_READY` even when all other series pass.

## 9. Unresolved risks and blockers

1. **DXY — blocking:** licensed ICE delivery, exact EOD field, publication boundary, history entitlement, and storage/redistribution terms are not yet approved. Yahoo `DX-Y.NYB` is not an approved substitute.
2. **CPI MoM — conditional:** the B2-B4 proof detects a representative annual revision (`2023-12`: `0.3` initially, `0.2` after the February 2024 recalculation), confirming that current revised SA history is unsafe for backdating. Complete release-by-release seasonal-vintage reconstruction and missing-artifact handling across the required window remain unproven, so no executable broad CPI MoM adapter exists.
3. **Unemployment — conditional:** B2-B6 proves individual archived as-published values and an annual revision difference, but not a complete deterministic five-year map across annual CPS seasonal revisions, population-control changes, errata, and non-reissued releases. No broad unemployment adapter exists; current revised history must not be backdated.
4. **H.15 release mapping:** B2-B must prove the observation-date to release-date witness for a sample spanning ordinary weekdays, weekends, holidays, and a Board closure. Observation date alone is forbidden.
5. **Binance timestamp units:** archive timestamps switch to microseconds from 2025. The current M12 millisecond parser contract needs an acquisition-side unit-normalization boundary and deterministic tests.
6. **Historical file schemas:** BLS HTML/PDF/XLSX layouts vary by era. Parsers must be versioned, fixture-backed, and fail closed on unknown layouts.
7. **FOMC historical timing:** do not extrapolate modern 14:00 releases backward. Every event needs its own official time witness; unverifiable events remain absent/blocking.
8. **Licensing/provenance:** raw source retention and redistribution rights must be checked before any licensed ICE artifact is committed or bundled.

## 10. Recommended B2-B implementation scope

Proceed only in these bounded adapter families:

1. **Binance archive adapter:** inventory monthly `BTCUSDT`/`PAXGUSDT` 1H files, verify published checksums, normalize millisecond/microsecond timestamps, and emit research-context records.
2. **Cboe VIX contract/access resolution only:** do not implement the free-CSV adapter. Resolve timestamped close/effective-date semantics and access/licensing before assigning `availableAt` or defining missingness.
3. **H.15/FRED adapter:** acquire `DGS2`/`DGS10`, recover explicit release-date witnesses, and emit daily observations at verified H.15 availability.
4. **BLS CPI adapter:** parse archived release/supplemental artifacts for YoY/index; add a small CPI MoM vintage proof before allowing broad acquisition.
5. **BLS labor adapter:** consume official CES vintage files for direct NFP net change; add an unemployment vintage proof before broad acquisition.
6. **FOMC adapter:** inventory official statements, require explicit release-time witnesses, parse target upper/event records, and cross-check levels against `DFEDTARU` without ingesting daily repeats.
7. **DXY contract spike only:** confirm ICE entitlement and freeze its exact field/timestamp/license contract. Do not implement a Yahoo substitution.
8. **Shared immutable acquisition layer:** raw artifact SHA-256, source request identity, normalized per-series hash, manifest construction, deterministic missingness report, and no writes into execution-price data.

B2-B must stop short of M13C rule research, predictive-edge evaluation, `ActionDecision`, Permission/Risk/Omega integration, and production behavior.

## 11. Decision

**CONDITIONAL GO**

B2-B may begin the resolved adapters and the two narrow vintage proofs. Completion of B2-B and any `RESEARCH_READY` claim remain blocked until:

- an approved DXY source contract exists;
- CPI MoM and unemployment vintage proofs pass;
- H.15 release-date mapping and Binance timestamp-unit tests pass; and
- every required series produces immutable provenance, explicit `availableAt`, and policy-compliant coverage without synthetic fallback.

## 12. Primary evidence consulted

- Binance Public Data README: https://github.com/binance/binance-public-data/blob/master/README.md
- Binance Spot API documentation: https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md
- ICE currency-index catalog: https://developer.ice.com/fixed-income-data-services/catalog/ice-data-indices-currency-indices
- ICE currency-index symbols: https://www.ice.com/fixed-income-data-services/index-solutions/currency-indices
- Cboe VIX historical data: https://www.cboe.com/tradable_products/vix/vix_historical_data
- Cboe VIX daily CSV: https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv
- Cboe hours: https://www.cboe.com/about/hours/us-options
- Cboe Global Indices Feed specification: https://www.cboe.com/document/tech-spec/document/technical-specifications/cboe-titanium-cboe-global-indices-feed-specification/
- Cboe Main Channel End-of-Day Summary: https://datashop.cboe.com/main-channel-end-of-day-summary
- Federal Reserve H.15: https://www.federalreserve.gov/releases/h15/
- Federal Reserve H.15 announcements/corrections: https://www.federalreserve.gov/feeds/h15.html
- Federal Reserve calendar — January 2021: https://www.federalreserve.gov/newsevents/2021-january.htm
- Federal Reserve calendar — May 2022: https://www.federalreserve.gov/newsevents/2022-may.htm
- Federal Reserve calendar — April 2023: https://www.federalreserve.gov/newsevents/2023-april.htm
- Federal Reserve calendar — April 2024: https://www.federalreserve.gov/newsevents/2024-april.htm
- Federal Reserve calendar — April 2025: https://www.federalreserve.gov/newsevents/2025-april.htm
- Federal Reserve calendar — September 2026: https://www.federalreserve.gov/newsevents/2026-september.htm
- H.15 Data Download Program: https://www.federalreserve.gov/datadownload/Choose.aspx?rel=H15
- FRED `DGS2`: https://fred.stlouisfed.org/series/DGS2
- FRED `DGS10`: https://fred.stlouisfed.org/series/DGS10
- ALFRED `DGS2` download/vintage interface: https://alfred.stlouisfed.org/series/downloaddata?seid=DGS2
- FRED observations API semantics: https://fred.stlouisfed.org/docs/api/fred/series_observations.html
- FRED vintage-date semantics: https://fred.stlouisfed.org/docs/api/fred/series_vintagedates.html
- FRED/ALFRED observations API: https://fred.stlouisfed.org/docs/api/fred/series_observations.html
- FRED/ALFRED real-time periods: https://fred.stlouisfed.org/docs/api/fred/realtime_period.html
- FRED API rate-limit errors: https://fred.stlouisfed.org/docs/api/fred/errors.html
- BLS CPI release archive: https://www.bls.gov/bls/news-release/cpi.htm
- BLS CPI supplemental archive: https://www.bls.gov/cpi/tables/supplemental-files/
- BLS CPI seasonal-adjustment archive: https://www.bls.gov/cpi/tables/seasonal-adjustment/
- BLS Employment Situation archive: https://www.bls.gov/bls/news-release/empsit.htm
- BLS CES vintage information/files: https://www.bls.gov/web/empsit/cesvininfo.htm
- BLS API: https://www.bls.gov/developers/
- FOMC calendars/statements: https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm
- FOMC historical materials: https://www.federalreserve.gov/monetarypolicy/fomc_historical.htm
- FRED `DFEDTARU`: https://fred.stlouisfed.org/series/DFEDTARU
