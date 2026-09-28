# QuantFund-OS V1 Deployment and Rollback Runbook

This document defines the operational procedures for building, configuring, deploying, verifying, and rolling back QuantFund-OS V1 in a production environment.

---

## 1. Runtime contract

- **Runtime Environment**: Standard Node.js runtime (version 22 LTS, `>= 22.12.0`). Vendor-neutral; requires no specialized cloud container or proprietary serverless wrapper.
- **Topology**: Single-origin architecture. The Node production HTTP server serves both the built client Single Page Application (SPA) static assets and the isolated reverse-proxy endpoints under `/api/*`.
- **Stateless Server**: The production server process is stateless with respect to trading, orders, positions, and accounting state.
- **No Production Database**: There is no server-side database (SQL, NoSQL, or key-value store), transaction log file, or server-side durable ledger.
- **Process Lifecycle**: Managed via standard Node HTTP server process lifecycle; terminates cleanly upon standard process signals (`SIGTERM`, `SIGINT`).

---

## 2. Configuration

Production configuration is supplied via process environment variables.

| Variable | Requirement | Default | Type | Description / Missing Behavior |
| :--- | :--- | :--- | :--- | :--- |
| `PORT` | Optional | `3000` | Non-secret | Integer port number on which the HTTP server listens. |
| `HOST` | Optional | `0.0.0.0` | Non-secret | Host IP interface to which the server binds. |
| `GEMINI_API_KEY` | Optional | *None* | Secret | Google Gemini API key for AI Advisor features. If absent, base server startup and all market/trading features remain operational; `/api/ai-advisor` requests fail closed with HTTP 503 `UNAVAILABLE`. |

*Note: Never commit or log secret values. Server logs and health responses do not emit environment secrets.*

---

## 3. Clean release build

Every production release artifact must be built and validated from the exact candidate Git commit.

The canonical build and validation sequence matching CI is:

```bash
# 1. Clean installation of locked dependencies
npm ci

# 2. Build server bundle
npm run build:server

# 3. Execute unit and contract test suite
npx vitest run

# 4. Execute performance budget checker self-tests
npm run perf:test

# 5. Build client SPA bundle
npm run build

# 6. Validate bundle size and performance budgets
npm run perf:check

# 7. Execute production runtime smoke verification
npm run smoke:production
```

---

## 4. Release artifacts

A deployable release artifact consists of the following filesystem structure generated from the build:

- `dist/`: Compiled client SPA static assets (`index.html`, JavaScript bundles, CSS, static assets).
- `dist-server/`: Compiled production server runtime (`productionServer.js`).
- `package.json` & `package-lock.json`: Project manifests.
- `node_modules/`: Runtime dependencies required by Node.

*Source files (`src/`, `server/*.ts`, `*.test.ts`, configuration files) are not required at runtime.*

---

## 5. Start

Start the production service using the repository start script:

```bash
npm start
```

Or execute the compiled entrypoint directly:

```bash
node dist-server/productionServer.js
```

### Binding Behavior
- Listens on `http://${HOST}:${PORT}` (defaults to `http://0.0.0.0:3000`).
- If the configured port is already in use, the process logs an `EADDRINUSE` error and exits with code `1`.

---

## 6. Health and post-deploy verification

### 1. Process Health Verification

```bash
curl -i http://localhost:3000/api/health
```

- **Expected Response**: HTTP `200 OK` with payload `{"status":"ok","uptime":<seconds>}`.
- **What It Proves**: The Node.js process is active, the event loop is responsive, the configured port is open, and core HTTP routing is functional.
- **What It Does NOT Prove**: It does not probe external market providers (Binance, Yahoo, VNDirect), verify client `localStorage` integrity, or confer executable trading permissions.

### 2. Client SPA Availability

```bash
curl -i http://localhost:3000/
```

- **Expected Response**: HTTP `200 OK`, `Content-Type: text/html; charset=utf-8`, containing `<div id="root"></div>`.

### 3. Market Gateway Proxy Verification

```bash
curl -i "http://localhost:3000/api/binance/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=500"
```

- **Expected Response (when Binance is reachable)**: HTTP `200 OK` with JSON array of OHLCV candlestick data.
- **Expected Response (when Binance is unreachable)**: HTTP `502 Bad Gateway` with JSON `{"status":"FAILURE","error":{"code":"UPSTREAM_FAILURE","message":"Market data provider request failed."}}`.
- **Distinction**: Receiving HTTP 502 from upstream confirms the gateway routing and validation logic are operational even during external provider outages.

---

## 7. Durable state

### Storage Mechanics
- **Location**: Browser `localStorage` (client-side only).
- **Key**: `quant_paper_engine_state`
- **Schema Version**: `2`

### Persisted Fields
- `latestDecision`: Canonical `DecisionState` containing accounting state (`nav`, `cash`, `currentDrawdown`), positions, signals, and execution history.
- `lifecycleCheckpoint`: Durable `M14_A04_DURABLE_TARGET_LIFECYCLE_CHECKPOINT_V2` structure recording terminal execution proof and lineage witnesses.
- `lastRunAt`: Epoch millisecond timestamp of last replay run.

### Runtime and Financial Invariants
- **No Server DB**: The server holds no durable copy of paper trading or accounting history.
- **Replay & Evidence Only**: Restored lifecycle checkpoints serve strictly as historical audit evidence. They do **not** grant fresh executable permission, risk clearance, or pricing authority.
- **Market Authority Requirement**: Execution and active decision updates require fresh canonical market data from the active market feed (`BacktestDataset.assetBars`).
- **Schema Migration and Fail-Closed Hydration**: Schema version 2 is the active persisted schema. Valid legacy schema version 1 state is migrated by retaining historical `latestDecision` and `lastRunAt` while clearing `lifecycleCheckpoint` and `actionDecision`. Corrupted JSON, invalid decision structures, or unrecognized schema versions fail closed by resetting persisted fields to initial empty state (`null`). Migrated historical state never confers fresh executable authority.
- **Explicit Reset**: Explicit state reset in the UI or store is destructive, resetting all runtime and persisted trading fields (`latestDecision`, `lifecycleCheckpoint`, `actionDecision`, `lastRunAt`) to their initial null/empty state through the persistence layer. No historical lifecycle or action authority survives the reset (physical `localStorage` key removal is not performed or required).

---

## 8. Expected degraded states

| Provider / Endpoint | Condition | Response / Behavior | Classification | Action Required |
| :--- | :--- | :--- | :--- | :--- |
| **Binance** (`/api/binance/api/v3/klines`) | Upstream unreachable or rate-limited | HTTP 502 `UPSTREAM_FAILURE`; client displays disconnected status; paper engine halts execution. | Expected Degraded | Monitor upstream Binance status; do not rollback application code. |
| **Yahoo Finance** (`/api/yahoo/v8/finance/chart/*`) | Upstream error or block | HTTP 502 `UPSTREAM_FAILURE`; Macro view displays `UNAVAILABLE`; synthetic fallback prohibited. | Expected Degraded | Monitor Yahoo status; do not rollback application code. |
| **VNDirect** (`/api/vndirect/finfo/v4/*`, `dchart/history`) | Upstream timeout or outage | HTTP 502 `UPSTREAM_FAILURE`; Vietnam macro widgets indicate no-data state. | Expected Degraded | Monitor VNDirect status; do not rollback application code. |
| **Gemini AI** (`/api/ai-advisor`) | `GEMINI_API_KEY` not configured | HTTP 503 `UNAVAILABLE`; UI displays "GEMINI_API_KEY is not configured on the server". | Expected Configuration | Set `GEMINI_API_KEY` if AI features are needed; base application remains operational. |
| **Gemini AI** (`/api/ai-advisor`) | Upstream rate-limit or outage | HTTP 502 `UPSTREAM_FAILURE` or HTTP 503; UI displays transient error banner. | Expected Degraded | Wait for upstream recovery; do not rollback application code. |
| **Quant Events** (`/api/quant-events`) | `GET /api/quant-events` | HTTP 503 `UNAVAILABLE` (`"Quant event feed is not connected to a production source."`). | Expected By Design | Dormant route; fail-closed by design. |
| **Quant Events** (`/api/quant-events`) | `POST /api/quant-events` (unsupported method) | HTTP 405 `METHOD_NOT_ALLOWED` with `Allow: GET` header. | Expected By Design | None. |

*Rule: External provider degradation or outages alone do not constitute application release failure.*

---

## 9. Rollback

### Rollback Unit
Rollback consists of redeploying the previous known-good application Git commit and its corresponding built release artifact (`dist/` and `dist-server/`).

### Procedure
1. Stop the active production process.
2. Deploy the previous known-good build artifact (or checkout the previous release Git SHA and run the clean release build sequence).
3. Start the production service (`npm start`).
4. Execute the post-rollback verification checks.

### State & Compatibility Considerations
- **No Database Restore**: There is no database backup or restore step because the server maintains no database.
- **Schema Version 2 Compatibility**: Rollbacks between releases that share `version: 2` persistence schema rehydrate `localStorage` without data loss.
- **Future Schema Incompatibility**: If rolling back from a hypothetical future major version (e.g. Version 3) to Version 2, the Version 2 client will reject Version 3 payloads and safely fail closed by initializing a clean default state.

### Post-Rollback Verification
1. Verify `GET /api/health` returns HTTP `200 OK`.
2. Verify `GET /` serves the SPA `index.html`.
3. Open the application in a browser containing existing `localStorage` and verify the UI loads without unhandled runtime exceptions.
4. Confirm market feeds connect and trading stores remain fail-closed when disconnected.

---

## 10. Rollback triggers

### Legitimate Rollback Triggers
Rollback should be initiated when evidence shows defects in the deployed application release:
- **Startup Failure**: The production server process crashes on boot or throws uncaught exceptions.
- **Health Route Broken**: `GET /api/health` returns non-200 status codes, hangs, or errors.
- **SPA Delivery Failure**: `GET /` returns HTTP 404 or 500 errors, or static assets in `/assets/` fail to resolve.
- **API Routing Regressions**: Active proxy endpoints (e.g. `/api/binance/*`, `/api/yahoo/*`) fail to route valid query shapes.
- **Client Hydration Crash**: Uncaught JavaScript exceptions during store hydration crash the client application.
- **Financial Invariant Regression**: Failure in risk boundary checks, emission of synthetic market data, or execution without valid market authority.

### Non-Rollback Conditions
Do **not** trigger application rollback for:
- External outages or transient network errors from third-party data providers (Binance, Yahoo, VNDirect).
- Absent `GEMINI_API_KEY` (AI advisor gracefully degrades to 503 while base product functions).
- Dormant `/api/quant-events` returning HTTP 503 `UNAVAILABLE` as designed.
- B22 load-sensitive test debt observed under local hardware constraints.

---

## 11. Release evidence record

For each production deployment, the operator should record the following release evidence:

| Item | Value / Identifier | Notes |
| :--- | :--- | :--- |
| **Release Git SHA** | `<40-character-commit-sha>` | Verified commit deployed. |
| **CI Run ID** | `<github-actions-run-id>` | Exact-SHA passing run. |
| **CI Conclusion** | `success` | All verification stages passed. |
| **Artifact Identifier** | `<build-hash-or-timestamp>` | Emitted `dist/` and `dist-server/`. |
| **Health Verification** | `HTTP 200 (uptime: <sec>)` | Output of `GET /api/health`. |
| **SPA Verification** | `HTTP 200 (index.html)` | Output of `GET /`. |
| **Rollback Target SHA** | `<previous-commit-sha>` | Designated target if rollback is required. |
