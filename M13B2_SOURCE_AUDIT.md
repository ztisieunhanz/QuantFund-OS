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
| `US2Y` | `MARKET_FACTOR` | `DAILY` | `NOT_APPLICABLE` | Federal Reserve H.15 / FRED `DGS2` | Board H.15 download plus release witness, or FRED/ALFRED observations API | RESOLVED; FRED API key if API route used |
| `US10Y` | `MARKET_FACTOR` | `DAILY` | `NOT_APPLICABLE` | Federal Reserve H.15 / FRED `DGS10` | Same H.15/FRED contract | RESOLVED; FRED API key if API route used |
| `US_CPI_YOY` | `MACRO_RELEASE` | `MONTHLY` | `VINTAGE_AWARE` | BLS CPI-U All Items 12-month percent change, NSA; Table A; underlying `CUUR0000SA0` | BLS archived CPI releases and archived supplemental files | RESOLVED |
| `US_CPI_MOM` | `MACRO_RELEASE` | `MONTHLY` | `VINTAGE_AWARE` | BLS CPI-U All Items 1-month percent change, SA; Table A; underlying `CUSR0000SA0` | BLS archived releases, monthly supplemental files, and annual seasonal-adjustment archives | **CONDITIONAL** |
| `US_CPI_INDEX` | `MACRO_RELEASE` | `MONTHLY` | `VINTAGE_AWARE` | BLS CPI-U All Items index, NSA, `CUUR0000SA0` | BLS archived CPI supplemental files / archived releases | RESOLVED |
| `US_NFP_NET_CHANGE` | `MACRO_RELEASE` | `MONTHLY` | `VINTAGE_AWARE` | BLS CES Total Nonfarm over-the-month change; underlying level `CES0000000001` | Official CES Total Nonfarm vintage XLSX/ZIP plus Employment Situation release archive | RESOLVED |
| `US_UNEMPLOYMENT_RATE` | `MACRO_RELEASE` | `MONTHLY` | `VINTAGE_AWARE` | BLS CPS unemployment rate, SA, `LNS14000000` | Employment Situation archived releases; ALFRED `UNRATE` may validate value-vintage mapping | **CONDITIONAL** |
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
- Raw release witness: the H.15 release date or the value's recoverable initial ALFRED/FRED vintage date. Observation date alone is insufficient.
- Canonical `observationTime`: UTC midnight for the market observation date.
- Canonical `availableAt`: 16:15 `America/New_York` on the verified H.15 release date. The Board states H.15 is posted Monday-Friday at 4:15 p.m.; holidays/Board closures are excluded.
- B2-B must recover observation-to-release-date mapping. It may use archived H.15 releases or ALFRED output that associates the initial value with its vintage date; it may not assume every value was available on its observation date.

**Revisions, coverage, and access**

- Protocol semantics remain `NOT_APPLICABLE`: these are market observations, not modeled macro-release vintages. Provider corrections must produce a new immutable snapshot and provenance note, not a silent overwrite.
- Expected history is multiple decades and comfortably exceeds the five-year policy. Missing `.`/`n.a.` values, weekends, holidays, and closed days are explicit non-observations.
- FRED API v1 requires an API key and enforces rate limits (documented as up to 120 requests/minute). A Board CSV route may avoid the key but still needs a release-date witness.
- No Treasury futures or Yahoo yield proxy is permitted.

### 3.5 BLS CPI family

**Canonical measures**

- `US_CPI_YOY`: direct published 12-month CPI-U All Items percent change, not seasonally adjusted, Table A; underlying BLS series `CUUR0000SA0`.
- `US_CPI_MOM`: direct published 1-month CPI-U All Items percent change, seasonally adjusted, Table A; underlying `CUSR0000SA0`.
- `US_CPI_INDEX`: CPI-U All Items index level, not seasonally adjusted, `CUUR0000SA0`, index 1982-84=100.

The two percent-change series are measures, not aliases for index-level series. If a value is derived from levels for validation, both levels must come from the same publication vintage and the derived result must reconcile to the directly published figure within a declared rounding tolerance.

**Acquisition and timestamps**

- Primary acquisition: BLS CPI archived news releases and archived monthly supplemental files. These preserve as-published releases; the BLS current API/database alone returns published historical series but is not a complete historical-vintage contract.
- Raw timestamps: reference month, official release date, and release header/schedule time.
- Canonical `observationTime`: reference-month end at UTC midnight, matching the M12 contract.
- Canonical `publishedAt` and `availableAt`: official release date at 08:30 `America/New_York`, DST-aware, unless the archived release carries a different explicit release time.
- Acquisition time is provenance only.

**Vintage semantics**

- Every distinct as-published value for an observation month is a separate record with its own publication timestamp and monotonically ordered `revisionIndex`.
- CPI YoY and the unadjusted index use archived as-published tables; if values do not change, no synthetic duplicate revision is created.
- CPI MoM is seasonally adjusted. BLS recalculates seasonal factors annually and can revise the previous five years. B2-B must prove that the combination of archived monthly supplemental files and archived annual seasonal-adjustment tables reconstructs each changed value and its release date. Until that fixture passes, CPI MoM remains conditional.
- ALFRED `CPIAUCNS`/`CPIAUCSL` can be a cross-check or explicit secondary source because `fred/series/observations` output types 2/3/4 return value-vintage mappings. Vintage-date metadata without the corresponding value rows is insufficient.

**Coverage, access, and missingness**

- BLS CPI release archives extend well beyond the required five years; B2-B should target at least 60 consecutive published reference months plus all discovered revisions.
- Expected periods are scheduled monthly CPI releases, not every calendar day. Government shutdown/nonpublication and explicit BLS errata are recorded, not imputed.
- BLS archives are public HTTPS. BLS API v1 is unauthenticated with lower limits; v2 registration increases limits. ALFRED API requires a secret API key, which must never enter manifests or snapshots.

### 3.6 BLS Employment Situation — NFP and unemployment

**NFP source contract**

- Canonical measure: directly published seasonally adjusted over-the-month Total Nonfarm employment change, thousands of persons.
- Provider identifier: BLS CES Total Nonfarm; underlying employment-level series `CES0000000001`.
- Primary source: official CES Total Nonfarm vintage file (`cesvin00.xlsx`, or the official CES vintage ZIP/CSV) plus Employment Situation archived releases for release identity and timestamp.
- BLS states the vintage tables include both employment levels and over-the-month changes and preserve published values from first preliminary estimates onward (current-method vintages from May 2003).
- Do not subtract a revised level from a different vintage. If levels are used, both months must be from the exact same publication row/vintage.

**Unemployment source contract and condition**

- Canonical measure: seasonally adjusted CPS unemployment rate, percent, BLS series `LNS14000000`.
- Primary evidence: as-published Employment Situation archived releases. ALFRED `UNRATE` output with explicit value-vintage rows may be used as a secondary reconstruction/validation source.
- The current BLS API series is not sufficient by itself because it does not promise the full historical sequence of values known at each release.
- Before full acquisition, B2-B must demonstrate a deterministic five-year fixture that maps every initial/revised unemployment value to the exact archived release date. If archives omit a changed historical value, the series remains unresolved rather than backfilled with today's value.

**Shared timestamps and coverage**

- Raw timestamps: reference month, release date, release time, archive/release ID, and vintage publication row/date.
- Canonical `observationTime`: reference-month end at UTC midnight.
- Canonical `publishedAt`/`availableAt`: release date at 08:30 `America/New_York`, unless an explicit archived witness differs.
- Expected denominator: scheduled monthly Employment Situation releases. Missing/cancelled releases and explicit errata are recorded; weekends are irrelevant.
- Public BLS archives/vintage files need no secret. ALFRED validation requires an API key and is subject to its rate limit.

### 3.7 Federal Reserve FOMC — target upper and rate-decision events

**Source identity**

- Primary source: Federal Reserve FOMC calendars and official policy-statement/press-release HTML or PDF.
- `US_FED_FUNDS_TARGET_UPPER`: target-range upper bound stated in the policy decision.
- `FOMC_RATE_DECISION`: the corresponding official `FED_RATE_DECISION`/statement event.
- FRED `DFEDTARU` is a useful official cross-check for the effective upper-limit level after 2008, but its repeated daily values must not be ingested as event-driven decisions.

**Timestamp contract**

- Raw timestamps: meeting date, press-release date, and explicit “For release at” time from the official statement page.
- Canonical event/macro `observationTime`: UTC midnight for the meeting decision date, preserving the M12 parser contract.
- Canonical `publishedAt` and `availableAt`: the witnessed release date/time in `America/New_York`, DST-aware. Never assume 14:00: historical FOMC release times varied.
- For the target upper series, create one `revisionIndex: 0` record per numeric policy decision, including unchanged decisions if required for event completeness. Do not create daily carry-forward macro releases.
- `FOMC_RATE_DECISION` actual is the upper bound for numeric rate decisions and `null` for qualitative-only statements. Consensus and surprise remain `null` without an independently approved PIT consensus source.

**Coverage and failure policy**

- Target-range upper coverage begins in December 2008. Official statement history supports the five-year readiness window and both upward/downward transition observations when the selected window contains them.
- The statement archive is public HTTPS and needs no secret. Each record retains statement URL, release title/date/time, meeting date, extracted target text, document hash, and parser version.
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
2. **CPI MoM — conditional:** annual revisions affect up to five prior years. A fixture must prove that archived monthly and annual BLS files produce complete direct-published value/vintage mappings and correct release timestamps.
3. **Unemployment — conditional:** archived Employment Situation releases or ALFRED must be shown to recover every as-published value/vintage required by the protocol, not merely current history.
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
- H.15 Data Download Program: https://www.federalreserve.gov/datadownload/Choose.aspx?rel=H15
- FRED `DGS2`: https://fred.stlouisfed.org/series/DGS2
- FRED `DGS10`: https://fred.stlouisfed.org/series/DGS10
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
