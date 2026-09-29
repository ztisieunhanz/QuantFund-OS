# QuantFund-OS V1 Deployment and Rollback Runbook

This document defines the operational procedures for building, configuring, deploying, verifying, and rolling back QuantFund-OS V1 in a production environment.

---

## 1. Runtime contract

- **Runtime Environment**: Standard Node.js runtime (version 22 LTS, exact tested patch `22.23.3`, supported architecture range `>= 22.16.0 < 23` with native `node:sqlite` storage support). Vendor-neutral; requires no specialized cloud container or proprietary serverless wrapper.
- **Topology**: Single-origin architecture. The Node production HTTP server serves both the built client Single Page Application (SPA) static assets, the isolated reverse-proxy endpoints under `/api/*`, and server-side SQLite storage infrastructure.
- **Storage Foundation (M18-C1)**: Single-node canonical SQLite storage engine (`node:sqlite`) with WAL journal mode, full synchronous durability, foreign keys enabled, bounded busy timeouts, and forward-only transactional migrations.
- **Stateless/Stateful Boundary**: During M18-C1, server-side storage hosts foundation schema metadata and migration history. Browser operational cutover to the Node controller and financial journal occurs in M18-D.
- **Process Lifecycle**: Managed via standard Node HTTP server process lifecycle; terminates via bounded graceful shutdown upon standard process signals (`SIGTERM`, `SIGINT`), refusing new requests, draining active in-flight request handlers before closing storage, and exiting 0 on clean completion or non-zero if bounded cleanup times out or fails.

---

## 2. Configuration

Production configuration is supplied via process environment variables.

| Variable | Requirement | Default | Type | Description / Missing Behavior |
| :--- | :--- | :--- | :--- | :--- |
| `PORT` | Optional | `3000` | Non-secret | Integer port number on which the HTTP server listens. |
| `HOST` | Optional | `0.0.0.0` | Non-secret | Host IP interface to which the server binds. |
| `QUANTFUND_DATA_DIR` | Optional | `data` | Non-secret | Local filesystem directory path for persistent SQLite database storage and online backups. Fail-closed if path is unusable or unwritable. |
| `QUANTFUND_ENABLE_STORAGE` | Optional | `false` | Non-secret | Boolean flag to automatically initialize and establish SQLite storage on standalone server startup. |
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

## 6. Health, readiness and post-deploy verification

### 1. Process Health Verification (Process Liveness)

```bash
curl -i http://localhost:3000/api/health
```

- **Expected Response**: HTTP `200 OK` with payload `{"status":"ok","uptime":<seconds>}`.
- **What It Proves**: The Node.js process is active, the event loop is responsive, the configured port is open, and core HTTP routing is functional.
- **What It Does NOT Prove**: It does not probe storage readiness, external market providers, client `localStorage` integrity, or confer executable trading permissions.

### 2. Operational Storage Readiness Verification (Storage Readiness)

```bash
curl -i http://localhost:3000/api/ready
```

- **Expected Response (when storage is enabled and ready)**: HTTP `200 OK` with payload `{"status":"ready","storage":{...}}`.
- **Expected Response (when storage is not enabled/configured)**: HTTP `503 Service Unavailable` with payload `{"status":"unready","error":{"code":"STORAGE_NOT_CONFIGURED","message":"Operational storage is not configured."},"storage":{"configured":false,"ready":false}}`.
- **Expected Response (when storage is enabled but unready/closed)**: HTTP `503 Service Unavailable` with JSON `{"status":"unready","error":{"code":"STORAGE_NOT_READY",...}}`.
- **Operational Configuration**: Storage defaults to disabled on standalone startup unless `QUANTFUND_ENABLE_STORAGE="true"` is configured or explicit programmatic storage is provided. Supported operational smoke and runtime validation enable storage explicitly.
- **What It Proves**: When ready (200), the server-side SQLite storage engine is open, WAL mode is active, synchronous FULL is enforced, foreign keys are ON, bounded busy timeout is set, bootstrap migrations are applied, and startup quick integrity checks succeeded.

### 3. Client SPA Availability

```bash
curl -i http://localhost:3000/
```

- **Expected Response**: HTTP `200 OK`, `Content-Type: text/html; charset=utf-8`, containing `<div id="root"></div>`.

### 4. Market Gateway Proxy Verification

```bash
curl -i "http://localhost:3000/api/binance/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=500"
```

- **Expected Response (when Binance is reachable)**: HTTP `200 OK` with JSON array of OHLCV candlestick data.
- **Expected Response (when Binance is unreachable)**: HTTP `502 Bad Gateway` with JSON `{"status":"FAILURE","error":{"code":"UPSTREAM_FAILURE","message":"Market data provider request failed."}}`.

---

## 7. Durable state and backup recovery

### Storage Mechanics
- **Client Storage**: Browser `localStorage` (canonical execution authority during M18-C1). Key: `quant_paper_engine_state`, Schema Version: `2`.
- **Server Storage (M18-C1)**: Single-node SQLite database in `QUANTFUND_DATA_DIR` (`quantfund.db`). Tracks schema metadata and migration records (`_schema_metadata`, `_schema_migrations`).
- **Backup & Recovery Protocol**: Server SQLite backups use `node:sqlite` online backup into verified sibling temporary files. When overwriting existing backups, the previous backup is moved aside to a recovery path before promotion and unlinked only upon verified promotion. If promotion fails, the previous backup is preserved and restored. Filesystem source-alias detection prevents overwriting the active source database.

### Runtime and Financial Invariants
- **No Financial Authority in C1**: C1 establishes SQLite runtime infrastructure only. Paper trading execution, accounting, and target lifecycle remain on existing client paths until M18-D cutover. Later M18-D will make Node operational financial authority.
- **Replay & Evidence Only**: Restored lifecycle checkpoints serve strictly as historical audit evidence. They do **not** grant fresh executable permission, risk clearance, or pricing authority.
- **Market Authority Requirement**: Execution and active decision updates require fresh canonical market data from the active market feed (`BacktestDataset.assetBars`).
- **Fail-Closed Storage Integrity**: Storage initialization enforces strict pragma verification, forward-only migrations with checksum checks, and quick integrity diagnostics. Corrupted databases or unrecognized future migration schemas fail closed.

---

## 8. Expected degraded states

| Provider / Endpoint | Condition | Response / Behavior | Classification | Action Required |
| :--- | :--- | :--- | :--- | :--- |
| **Storage** (`/api/ready`) | `QUANTFUND_ENABLE_STORAGE` false or absent | HTTP 503 `STORAGE_NOT_CONFIGURED`; operational storage unconfigured. | Expected Configuration | Set `QUANTFUND_ENABLE_STORAGE="true"` if server-side stateful storage is desired. |
| **Storage** (`/api/ready`) | Storage enabled but uninitialized or closed | HTTP 503 `STORAGE_NOT_READY`; operational storage degraded/closed. | Expected Degraded | Check directory permissions, `QUANTFUND_DATA_DIR` accessibility, or server logs. |
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

### Post-Rollback Verification
1. Verify `GET /api/health` returns HTTP `200 OK`.
2. Verify `GET /api/ready` returns HTTP `200 OK`.
3. Verify `GET /` serves the SPA `index.html`.
4. Open the application in a browser containing existing `localStorage` and verify the UI loads without unhandled runtime exceptions.
5. Confirm market feeds connect and trading stores remain fail-closed when disconnected.

---

## 10. Rollback triggers

### Legitimate Rollback Triggers
Rollback should be initiated when evidence shows defects in the deployed application release:
- **Startup Failure**: The production server process crashes on boot or throws uncaught exceptions.
- **Health/Readiness Route Broken**: `GET /api/health` or `GET /api/ready` returns non-200 status codes, hangs, or errors.
- **SPA Delivery Failure**: `GET /` returns HTTP 404 or 500 errors, or static assets in `/assets/` fail to resolve.
- **API Routing Regressions**: Active proxy endpoints (e.g. `/api/binance/*`, `/api/yahoo/*`) fail to route valid query shapes.
- **Client Hydration Crash**: Uncaught JavaScript exceptions during store hydration crash the client application.
- **Financial Invariant Regression**: Failure in risk boundary checks, emission of synthetic market data, or execution without valid market authority.

### Non-Rollback Conditions
Do **not** trigger application rollback for:
- External outages or transient network errors from third-party data providers (Binance, Yahoo, VNDirect).
- Absent `GEMINI_API_KEY` (AI advisor gracefully degrades to 503 while base product functions).
- Dormant `/api/quant-events` returning HTTP 503 `UNAVAILABLE` as designed.
- Degraded storage due to host environment volume misconfiguration where server process is healthy.

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
| **Readiness Verification** | `HTTP 200 (status: ready)` | Output of `GET /api/ready`. |
| **SPA Verification** | `HTTP 200 (index.html)` | Output of `GET /`. |
| **Rollback Target SHA** | `<previous-commit-sha>` | Designated target if rollback is required. |
