// ============================================================================
// FILE: scripts/production-smoke.mjs
// MODULE: PRODUCTION RUNTIME SMOKE HARNESS (M16-E3)
// NOTE: Exercises built client + built server against local ephemeral port.
// ============================================================================

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const DIST_SERVER = path.join(ROOT_DIR, "dist-server", "productionServer.js");
const DIST_MANIFEST = path.join(ROOT_DIR, "dist", ".vite", "manifest.json");

const STARTUP_TIMEOUT_MS = 10_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;

function httpRequest(
  urlStr,
  options = {}
) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(urlStr);
    const reqOptions = {
      protocol: urlObj.protocol,
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: `${urlObj.pathname}${urlObj.search}`,
      method: options.method || "GET",
      headers: options.headers || {},
    };

    const req = http.request(reqOptions, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });

    req.on("error", reject);

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

function parseServerUrl(stdout) {
  const match = stdout.match(/QuantFund-OS Production Server listening on (https?:\/\/[^\s]+)/);
  return match ? match[1] : null;
}

export async function runProductionSmoke() {
  if (!fs.existsSync(DIST_SERVER)) {
    throw new Error(`[smoke] dist-server entrypoint not found at ${DIST_SERVER}. Run npm run build:server first.`);
  }
  if (!fs.existsSync(DIST_MANIFEST)) {
    throw new Error(`[smoke] client manifest not found at ${DIST_MANIFEST}. Run npm run build first.`);
  }

  const manifest = JSON.parse(fs.readFileSync(DIST_MANIFEST, "utf8"));

  let child = null;
  let serverUrl = null;
  let stdoutAccum = "";
  let stderrAccum = "";

  try {
    // 1. Spawn production server with PORT=0 and isolated AI environment
    const childEnv = { ...process.env, PORT: "0", HOST: "127.0.0.1" };
    delete childEnv.GEMINI_API_KEY;
    delete childEnv.VITE_GEMINI_API_KEY;

    child = spawn(process.execPath, [DIST_SERVER], {
      cwd: ROOT_DIR,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let earlyExitError = null;
    child.on("exit", (code, signal) => {
      if (!serverUrl) {
        earlyExitError = new Error(`Child process exited prematurely with code=${code} signal=${signal}\nStderr: ${stderrAccum}\nStdout: ${stdoutAccum}`);
      }
    });

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdoutAccum += text;
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderrAccum += text;
    });

    // Await server readiness via stdout URL parsing with timeout
    await new Promise((resolve, reject) => {
      let resolved = false;
      const interval = setInterval(() => {
        if (earlyExitError) {
          clearInterval(interval);
          clearTimeout(timer);
          resolved = true;
          reject(earlyExitError);
          return;
        }
        const detectedUrl = parseServerUrl(stdoutAccum);
        if (detectedUrl) {
          serverUrl = detectedUrl;
          clearInterval(interval);
          clearTimeout(timer);
          resolved = true;
          resolve();
        }
      }, 50);

      const timer = setTimeout(() => {
        if (!resolved) {
          clearInterval(interval);
          reject(new Error(`[smoke] Server failed to start within ${STARTUP_TIMEOUT_MS}ms.\nStdout: ${stdoutAccum}\nStderr: ${stderrAccum}`));
        }
      }, STARTUP_TIMEOUT_MS);
    });

    console.log(`[smoke] Production server ready on ${serverUrl}`);
    const failures = [];

    // ========================================================================
    // SMOKE A: Process Health & Readiness Distinction
    // ========================================================================
    console.log("[smoke] Running Smoke A: Process Health & Readiness...");
    const healthRes = await httpRequest(`${serverUrl}/api/health`, { method: "GET" });
    if (healthRes.statusCode !== 200) {
      throw new Error(`[smoke A] GET /api/health returned status ${healthRes.statusCode}, expected 200. Body: ${healthRes.body}`);
    }
    const healthJson = JSON.parse(healthRes.body);
    if (healthJson.status !== "ok" || typeof healthJson.uptime !== "number") {
      throw new Error(`[smoke A] GET /api/health returned invalid JSON shape: ${healthRes.body}`);
    }
    if (healthRes.body.includes("GEMINI") || healthRes.body.includes("secret")) {
      throw new Error("[smoke A] GET /api/health leaked secret or provider configuration");
    }

    const healthHeadRes = await httpRequest(`${serverUrl}/api/health`, { method: "HEAD" });
    if (healthHeadRes.statusCode !== 405) {
      throw new Error(`[smoke A] HEAD /api/health returned status ${healthHeadRes.statusCode}, expected 405 Method Not Allowed`);
    }

    const readyRes = await httpRequest(`${serverUrl}/api/ready`, { method: "GET" });
    if (readyRes.statusCode !== 200) {
      throw new Error(`[smoke A] GET /api/ready returned status ${readyRes.statusCode}, expected 200. Body: ${readyRes.body}`);
    }
    const readyJson = JSON.parse(readyRes.body);
    if (readyJson.status !== "ready") {
      throw new Error(`[smoke A] GET /api/ready returned invalid JSON shape: ${readyRes.body}`);
    }

    // ========================================================================
    // SMOKE B: Built SPA Root & Active Routes
    // ========================================================================
    console.log("[smoke] Running Smoke B: Built SPA Root & Active Routes...");
    const rootRes = await httpRequest(`${serverUrl}/`, { method: "GET" });
    if (rootRes.statusCode !== 200 || !rootRes.body.includes('<div id="root">')) {
      throw new Error(`[smoke B] GET / failed to return SPA index.html. Status: ${rootRes.statusCode}`);
    }
    if (rootRes.body.startsWith("{") || rootRes.body.startsWith("[")) {
      throw new Error("[smoke B] GET / returned JSON instead of HTML");
    }

    const activeRoutes = ["/macro", "/charts", "/research", "/lab"];
    for (const route of activeRoutes) {
      const routeRes = await httpRequest(`${serverUrl}${route}`, { method: "GET" });
      if (routeRes.statusCode !== 200 || !routeRes.body.includes('<div id="root">')) {
        throw new Error(`[smoke B] GET ${route} failed to return SPA fallback. Status: ${routeRes.statusCode}`);
      }
    }

    // ========================================================================
    // SMOKE C: Built Lazy Assets
    // ========================================================================
    console.log("[smoke] Running Smoke C: Built Lazy Assets...");
    const requiredLazyChunks = [
      "src/views/ChartView.tsx",
      "src/views/MacroViewV2.tsx",
      "src/views/ResearchRulesView.tsx",
    ];

    for (const chunkKey of requiredLazyChunks) {
      const manifestEntry = manifest[chunkKey];
      if (!manifestEntry || !manifestEntry.file) {
        throw new Error(`[smoke C] Manifest entry for ${chunkKey} is missing or has no file`);
      }
      const assetUrl = `${serverUrl}/${manifestEntry.file}`;
      const assetRes = await httpRequest(assetUrl, { method: "GET" });
      if (assetRes.statusCode !== 200) {
        throw new Error(`[smoke C] Failed to serve lazy chunk ${manifestEntry.file}. Status: ${assetRes.statusCode}`);
      }
      const contentType = assetRes.headers["content-type"] || "";
      if (!contentType.includes("javascript")) {
        throw new Error(`[smoke C] Lazy chunk ${manifestEntry.file} has non-JS content-type: ${contentType}`);
      }
      if (!assetRes.body || assetRes.body.length < 10) {
        throw new Error(`[smoke C] Lazy chunk ${manifestEntry.file} returned empty or truncated body`);
      }
    }

    // ========================================================================
    // SMOKE D: Static Cache / Security Headers Contract
    // ========================================================================
    console.log("[smoke] Running Smoke D: Static Cache / Security Headers...");
    const htmlCacheControl = rootRes.headers["cache-control"] || "";
    if (htmlCacheControl.includes("immutable") || !htmlCacheControl.includes("no-cache")) {
      throw new Error(`[smoke D] HTML entry received incorrect Cache-Control: ${htmlCacheControl}`);
    }

    const firstEntry = manifest[requiredLazyChunks[0]];
    const jsAssetRes = await httpRequest(`${serverUrl}/${firstEntry.file}`, { method: "GET" });
    const jsCacheControl = jsAssetRes.headers["cache-control"] || "";
    if (!jsCacheControl.includes("immutable") || !jsCacheControl.includes("max-age=31536000")) {
      throw new Error(`[smoke D] Hashed JS asset received incorrect Cache-Control: ${jsCacheControl}`);
    }

    if (rootRes.headers["x-content-type-options"] !== "nosniff" || jsAssetRes.headers["x-content-type-options"] !== "nosniff") {
      throw new Error("[smoke D] X-Content-Type-Options: nosniff header missing");
    }
    if (rootRes.headers["x-frame-options"] !== "DENY" || jsAssetRes.headers["x-frame-options"] !== "DENY") {
      throw new Error("[smoke D] X-Frame-Options: DENY header missing");
    }

    // ========================================================================
    // SMOKE E: API Never Falls Through to SPA
    // ========================================================================
    console.log("[smoke] Running Smoke E: API Never Falls Through to SPA...");
    const unknownApiRes = await httpRequest(`${serverUrl}/api/__m16_smoke_missing__`, { method: "GET" });
    if (unknownApiRes.statusCode !== 404) {
      throw new Error(`[smoke E] Unknown API returned status ${unknownApiRes.statusCode}, expected 404`);
    }
    if (unknownApiRes.body.includes("<title>") || unknownApiRes.body.includes("<!DOCTYPE html>")) {
      throw new Error("[smoke E] Unknown API route fell through to SPA HTML");
    }
    const unknownApiJson = JSON.parse(unknownApiRes.body);
    if (!unknownApiJson.error || unknownApiJson.error.code !== "NOT_FOUND") {
      throw new Error(`[smoke E] Unknown API route did not return standard 404 JSON error: ${unknownApiRes.body}`);
    }

    // ========================================================================
    // SMOKE F: AI Fail-Closed
    // ========================================================================
    console.log("[smoke] Running Smoke F: AI Fail-Closed Without Secrets...");
    const aiPayload = JSON.stringify({
      operation: "GROUNDED_CHAT",
      messages: [{ role: "user", text: "Production smoke test prompt" }],
      grounding: {
        schemaVersion: 1,
        actionDecision: {
          status: "UNAVAILABLE",
          reason: "NO_CANONICAL_ACTION_DECISION",
        },
        marketSnapshot: {
          status: "UNAVAILABLE",
          contextRole: "OBSERVED_CONTEXT_ONLY_NOT_ACTION_AUTHORITY",
        },
        authority: {
          explanationOnly: true,
          paperResearchOnly: true,
          grantsPermissionAuthority: false,
          grantsRiskAuthority: false,
          grantsAllocationAuthority: false,
          grantsExecutionAuthority: false,
          grantsAccountingAuthority: false,
        },
      },
    });

    const aiRes = await httpRequest(`${serverUrl}/api/ai-advisor`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(aiPayload, "utf8")),
      },
      body: aiPayload,
    });

    if (aiRes.statusCode !== 503) {
      throw new Error(`[smoke F] AI without secret returned status ${aiRes.statusCode}, expected 503. Body: ${aiRes.body}`);
    }
    const aiJson = JSON.parse(aiRes.body);
    if (aiJson.status !== "FAILURE" || aiJson.error?.code !== "UNAVAILABLE") {
      throw new Error(`[smoke F] AI without secret did not return UNAVAILABLE failure envelope: ${aiRes.body}`);
    }
    if (aiRes.body.includes("googleapis.com") || aiRes.body.includes("stack") || aiRes.body.includes("Error:")) {
      throw new Error("[smoke F] AI failure leaked upstream provider URL or stack trace");
    }

    // ========================================================================
    // SMOKE G: Market Boundary Without Network
    // ========================================================================
    console.log("[smoke] Running Smoke G: Market Boundary Local Rejection...");
    const invalidMarketRes = await httpRequest(
      `${serverUrl}/api/binance/api/v3/klines?symbol=INVALID_SYMBOL&interval=1h&limit=500`,
      { method: "GET" }
    );
    if (invalidMarketRes.statusCode !== 400) {
      throw new Error(`[smoke G] Invalid Binance request returned status ${invalidMarketRes.statusCode}, expected 400. Body: ${invalidMarketRes.body}`);
    }
    const invalidMarketJson = JSON.parse(invalidMarketRes.body);
    if (invalidMarketJson.status !== "FAILURE" || invalidMarketJson.error?.code !== "INVALID_REQUEST") {
      throw new Error(`[smoke G] Invalid Binance request did not return INVALID_REQUEST envelope: ${invalidMarketRes.body}`);
    }

    const invalidMethodRes = await httpRequest(`${serverUrl}/api/binance/api/v3/klines`, { method: "POST" });
    if (invalidMethodRes.statusCode !== 405) {
      throw new Error(`[smoke G] POST on klines returned status ${invalidMethodRes.statusCode}, expected 405`);
    }

    // ========================================================================
    // SMOKE H: Quant Events Fail-Closed Contract
    // ========================================================================
    console.log("[smoke] Running Smoke H: Quant Events Contract Check...");
    const quantEventsRes = await httpRequest(`${serverUrl}/api/quant-events`, { method: "GET" });

    // Validate that it does NOT return fabricated events or SPA HTML
    if (quantEventsRes.body.includes("<!DOCTYPE html>") || quantEventsRes.body.includes("<title>")) {
      failures.push("[smoke H] /api/quant-events returned SPA HTML instead of an API response");
    } else if (quantEventsRes.body.includes("ev-fallback-1") || quantEventsRes.body.includes("Yield & Volatility Engine")) {
      failures.push("[smoke H] /api/quant-events returned fabricated event data");
    } else if (quantEventsRes.statusCode === 503) {
      const qeJson = JSON.parse(quantEventsRes.body);
      if (qeJson.status !== "FAILURE" || qeJson.error?.code !== "UNAVAILABLE") {
        failures.push(`[smoke H] /api/quant-events 503 returned unexpected envelope: ${quantEventsRes.body}`);
      } else {
        console.log("[smoke H] /api/quant-events returned 503 UNAVAILABLE (fail-closed target matched).");
      }
    } else if (quantEventsRes.statusCode === 404) {
      console.warn("[smoke H] PRODUCTION_CONTRACT_MISMATCH: /api/quant-events returned 404 NOT_FOUND (dormant route not explicitly implemented in productionApi.ts).");
      failures.push("PRODUCTION_CONTRACT_MISMATCH: /api/quant-events returned 404 NOT_FOUND instead of 503 UNAVAILABLE");
    } else {
      failures.push(`[smoke H] /api/quant-events returned unexpected status ${quantEventsRes.statusCode}. Body: ${quantEventsRes.body}`);
    }

    // ========================================================================
    // SMOKE I: Path Safety
    // ========================================================================
    console.log("[smoke] Running Smoke I: Path Safety...");
    const traversalRes1 = await httpRequest(`${serverUrl}/../../../package.json`, { method: "GET" });
    if (![400, 403, 404].includes(traversalRes1.statusCode) || traversalRes1.body.includes('"name": "quantfund-os"')) {
      failures.push("[smoke I] Path traversal attempt /../../../package.json leaked repository root file");
    }

    const traversalRes2 = await httpRequest(`${serverUrl}/%2e%2e%2f%2e%2e%2fpackage.json`, { method: "GET" });
    if (![400, 403, 404].includes(traversalRes2.statusCode) || traversalRes2.body.includes('"name": "quantfund-os"')) {
      failures.push("[smoke I] Encoded path traversal attempt /%2e%2e%2f%2e%2e%2fpackage.json leaked repository root file");
    }

    if (failures.length > 0) {
      throw new Error(`Smoke failures occurred:\n  - ${failures.join("\n  - ")}`);
    }

    console.log("[smoke] All production smoke checks PASSED successfully.");
  } finally {
    // Teardown: ensure child process is cleanly terminated and awaited
    if (child && child.pid) {
      console.log("[smoke] Terminating production server process...");
      try {
        child.kill("SIGTERM");
      } catch {}

      await new Promise((resolve) => {
        let finished = false;
        child.on("exit", () => {
          finished = true;
          resolve();
        });
        setTimeout(() => {
          if (!finished) {
            try {
              child.kill("SIGKILL");
            } catch {}
            resolve();
          }
        }, SHUTDOWN_TIMEOUT_MS);
      });
      console.log("[smoke] Production server process confirmed terminated.");
    }
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  runProductionSmoke()
    .then(() => {
      process.exit(0);
    })
    .catch((err) => {
      console.error(`[smoke] FAILED: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
