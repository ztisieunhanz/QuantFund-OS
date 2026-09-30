// ============================================================================
// FILE: server/__tests__/productionServer.test.ts
// MODULE: PRODUCTION SERVER SHELL CONTRACT TESTS (M16-E1A / M18-C1)
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer as createViteServer } from "vite";
import {
  createProductionServer,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  type ProductionServerInstance,
  type ProductionServerOptions,
} from "../productionServer";
import * as productionServerModule from "../productionServer";
import { isNodeVersionSupported } from "../storage";
import { AI_GATEWAY_OPERATION } from "../../src/lib/aiGatewayContract";
import { buildAiAdvisorGrounding } from "../../src/lib/aiAdvisorGroundingProjection";

const validAiRequest = JSON.stringify({
  operation: AI_GATEWAY_OPERATION,
  grounding: buildAiAdvisorGrounding(null, null),
  messages: [{ role: "user", text: "Summarize current evidence" }],
});

function requestHttp(
  url: string,
  options: http.RequestOptions & { body?: string } = {}
): Promise<{
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

function stopChildProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    child.once("close", finish);
    child.once("error", fail);

    if (child.exitCode !== null || child.signalCode !== null) {
      finish();
      return;
    }

    if (!child.kill()) {
      if (child.exitCode !== null || child.signalCode !== null) finish();
      else fail(new Error("Unable to terminate production server child process"));
    }
  });
}

describe("M16-E1A Production Server Shell", () => {
  let tempBaseDir: string;
  let tempStaticDir: string;
  let externalSentinelPath: string;
  const SENTINEL_SECRET = "OUTSIDE-SENTINEL-CANARY-998877";
  let serverInstance: ProductionServerInstance | null = null;
  let childProc: ChildProcess | null = null;
  let originalNodeVersion: string;

  beforeEach(() => {
    originalNodeVersion = process.versions.node;
    Object.defineProperty(process.versions, "node", {
      value: "22.23.3",
      configurable: true,
      writable: true,
    });
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantfund-test-base-"));
    tempStaticDir = path.join(tempBaseDir, "dist");
    fs.mkdirSync(tempStaticDir, { recursive: true });
    fs.mkdirSync(path.join(tempStaticDir, "assets"), { recursive: true });

    // Place an outside canary file in the parent base directory (outside staticDir)
    externalSentinelPath = path.join(tempBaseDir, "sentinel.txt");
    fs.writeFileSync(externalSentinelPath, SENTINEL_SECRET, "utf8");

    // Static SPA assets inside staticDir
    fs.writeFileSync(
      path.join(tempStaticDir, "index.html"),
      "<!DOCTYPE html><html><head><title>QuantFund-OS</title></head><body><div id=\"root\">SPA</div></body></html>"
    );
    fs.writeFileSync(
      path.join(tempStaticDir, "assets", "index-a1b2c3d4.js"),
      "console.log('client bundle');"
    );
    fs.writeFileSync(
      path.join(tempStaticDir, "robots.txt"),
      "User-agent: *\nDisallow: /"
    );
  });

  afterEach(async () => {
    Object.defineProperty(process.versions, "node", {
      value: originalNodeVersion,
      configurable: true,
      writable: true,
    });
    if (serverInstance) {
      try {
        await serverInstance.close();
      } catch {
        // ignore errors during cleanup of intentionally faulted tests
      }
      serverInstance = null;
    }
    if (childProc) {
      await stopChildProcess(childProc);
      childProc = null;
    }
    if (fs.existsSync(tempBaseDir)) {
      fs.rmSync(tempBaseDir, { recursive: true, force: true });
    }
  });

  it("A. serves GET /api/health with minimal process readiness without secrets or provider config", async () => {
    serverInstance = createProductionServer({
      staticDir: tempStaticDir,
      env: { SECRET_KEY: "super-secret-key", GEMINI_API_KEY: "ai-secret" },
    });
    const addr = await serverInstance.listen(0, "127.0.0.1");

    const res = await requestHttp(`${addr.url}/api/health`, { method: "GET" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");

    const body = JSON.parse(res.body);
    expect(body.status).toBe("ok");
    expect(typeof body.uptime).toBe("number");
    expect(res.body).not.toContain("super-secret-key");
    expect(res.body).not.toContain("ai-secret");
    expect(res.body).not.toContain("GEMINI");
  });

  it("A. enforces GET-only for /api/health and returns 405 for HEAD and POST", async () => {
    serverInstance = createProductionServer({ staticDir: tempStaticDir });
    const addr = await serverInstance.listen(0, "127.0.0.1");

    const headRes = await requestHttp(`${addr.url}/api/health`, { method: "HEAD" });
    expect(headRes.statusCode).toBe(405);
    expect(headRes.headers["content-type"]).toContain("application/json");
    expect(headRes.headers.allow).toBe("GET");

    const postRes = await requestHttp(`${addr.url}/api/health`, { method: "POST" });
    expect(postRes.statusCode).toBe(405);
    expect(postRes.headers["content-type"]).toContain("application/json");
    expect(postRes.headers.allow).toBe("GET");
    const parsed = JSON.parse(postRes.body);
    expect(parsed.error.code).toBe("METHOD_NOT_ALLOWED");
  });

  it("A. dispatches POST /api/ai-advisor through the shared gateway and preserves its success contract", async () => {
    const upstreamFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "Grounded answer" }] } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    serverInstance = createProductionServer({
      staticDir: tempStaticDir,
      env: { GEMINI_API_KEY: "server-only-secret" },
      fetchFn: upstreamFetch,
    });
    const addr = await serverInstance.listen(0, "127.0.0.1");

    const res = await requestHttp(`${addr.url}/api/ai-advisor`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Request-Id": "test-request-1" },
      body: validAiRequest,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-request-id"]).toBe("test-request-1");
    expect(JSON.parse(res.body)).toEqual({ status: "SUCCESS", text: "Grounded answer" });
    expect(res.body).not.toContain("server-only-secret");
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it("A. rejects unsupported AI methods, malformed JSON, and oversized requests", async () => {
    serverInstance = createProductionServer({
      staticDir: tempStaticDir,
      env: { GEMINI_API_KEY: "server-only-secret" },
    });
    const addr = await serverInstance.listen(0, "127.0.0.1");

    const getRes = await requestHttp(`${addr.url}/api/ai-advisor`, { method: "GET" });
    expect(getRes.statusCode).toBe(405);
    expect(getRes.headers.allow).toBe("POST");

    const malformedRes = await requestHttp(`${addr.url}/api/ai-advisor`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not-json",
    });
    expect(malformedRes.statusCode).toBe(400);
    expect(JSON.parse(malformedRes.body)).toMatchObject({ status: "FAILURE", error: { code: "INVALID_REQUEST" } });

    const oversizedRes = await requestHttp(`${addr.url}/api/ai-advisor`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "x".repeat(65_537),
    });
    expect(oversizedRes.statusCode).toBe(413);
    expect(JSON.parse(oversizedRes.body)).toMatchObject({ status: "FAILURE", error: { code: "INVALID_REQUEST" } });
  });

  it("A. fails AI closed for missing secret and upstream rejection without SPA fallback", async () => {
    serverInstance = createProductionServer({ staticDir: tempStaticDir });
    const addr = await serverInstance.listen(0, "127.0.0.1");

    const missingSecret = await requestHttp(`${addr.url}/api/ai-advisor`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: validAiRequest,
    });
    expect(missingSecret.statusCode).toBe(503);
    expect(JSON.parse(missingSecret.body)).toMatchObject({ status: "FAILURE", error: { code: "UNAVAILABLE" } });
    expect(missingSecret.body).not.toContain("<!DOCTYPE html>");

    await serverInstance.close();
    serverInstance = createProductionServer({
      staticDir: tempStaticDir,
      env: { GEMINI_API_KEY: "server-only-secret" },
      fetchFn: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "provider secret server-only-secret" } }), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        })
      ),
    });
    const rejectedAddr = await serverInstance.listen(0, "127.0.0.1");
    const rejected = await requestHttp(`${rejectedAddr.url}/api/ai-advisor`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: validAiRequest,
    });
    expect(rejected.statusCode).toBe(502);
    expect(JSON.parse(rejected.body)).toMatchObject({ status: "FAILURE", error: { code: "UPSTREAM_FAILURE" } });
    expect(rejected.body).not.toContain("server-only-secret");
    expect(rejected.body).not.toContain("provider secret");
  });

  it("A. dispatches a valid market request through the runtime-neutral provider gateway", async () => {
    const upstreamFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify([[
        1_700_000_000_000, "100", "101", "99", "100.5", "12.5", 1_700_000_060_000,
        "1256.25", 10, "5", "7", "0",
      ]]), { status: 200, headers: { "Content-Type": "application/json" } })
    );
    serverInstance = createProductionServer({ staticDir: tempStaticDir, fetchFn: upstreamFetch });
    const addr = await serverInstance.listen(0, "127.0.0.1");

    const result = await requestHttp(
      `${addr.url}/api/binance/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=500`,
      { method: "GET" }
    );

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toHaveLength(1);
    expect(upstreamFetch.mock.calls[0][0]).toBe(
      "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=500"
    );
  });

  it("B. isolates unknown /api/* routes returning JSON 404 without SPA fallback", async () => {
    serverInstance = createProductionServer({ staticDir: tempStaticDir });
    const addr = await serverInstance.listen(0, "127.0.0.1");

    const res = await requestHttp(`${addr.url}/api/unknown-endpoint`, { method: "GET" });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body).not.toContain("<!DOCTYPE html>");
    const parsed = JSON.parse(res.body);
    expect(parsed.error.code).toBe("NOT_FOUND");
  });

  it("H. returns quant events as an explicit unavailable capability without provider calls", async () => {
    const upstreamFetch = vi.fn<typeof fetch>();
    serverInstance = createProductionServer({ staticDir: tempStaticDir, fetchFn: upstreamFetch });
    const addr = await serverInstance.listen(0, "127.0.0.1");

    const res = await requestHttp(`${addr.url}/api/quant-events`, { method: "GET" });

    expect(res.statusCode).toBe(503);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).not.toContain("<!DOCTYPE html>");
    const body = JSON.parse(res.body);
    expect(body).not.toHaveProperty("events");
    expect(body).not.toHaveProperty("data");
    expect(body).toEqual({
      status: "FAILURE",
      error: {
        code: "UNAVAILABLE",
        message: "Quant event feed is not connected to a production source.",
      },
    });
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("H. rejects unsupported quant events methods with the established 405 contract", async () => {
    const upstreamFetch = vi.fn<typeof fetch>();
    serverInstance = createProductionServer({ staticDir: tempStaticDir, fetchFn: upstreamFetch });
    const addr = await serverInstance.listen(0, "127.0.0.1");

    const res = await requestHttp(`${addr.url}/api/quant-events`, { method: "POST" });

    expect(res.statusCode).toBe(405);
    expect(res.headers.allow).toBe("GET");
    expect(JSON.parse(res.body)).toEqual({
      error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" },
    });
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("C. serves static index.html entry and hashed assets correctly", async () => {
    serverInstance = createProductionServer({ staticDir: tempStaticDir });
    const addr = await serverInstance.listen(0, "127.0.0.1");

    // Root index.html
    const rootRes = await requestHttp(`${addr.url}/`, { method: "GET" });
    expect(rootRes.statusCode).toBe(200);
    expect(rootRes.headers["content-type"]).toContain("text/html");
    expect(rootRes.headers["cache-control"]).toContain("no-cache");
    expect(rootRes.body).toContain("<title>QuantFund-OS</title>");

    // Hashed asset
    const assetRes = await requestHttp(`${addr.url}/assets/index-a1b2c3d4.js`, { method: "GET" });
    expect(assetRes.statusCode).toBe(200);
    expect(assetRes.headers["content-type"]).toContain("text/javascript");
    expect(assetRes.headers["cache-control"]).toContain("immutable");
    expect(assetRes.body).toContain("console.log('client bundle');");
  });

  it("C. falls back to index.html only for client SPA routes", async () => {
    serverInstance = createProductionServer({ staticDir: tempStaticDir });
    const addr = await serverInstance.listen(0, "127.0.0.1");

    const res = await requestHttp(`${addr.url}/macro/dashboard`, { method: "GET" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.headers["cache-control"]).toContain("no-cache");
    expect(res.body).toContain("<title>QuantFund-OS</title>");
  });

  it("C. truthfully returns 404 for missing static resources with file extension", async () => {
    serverInstance = createProductionServer({ staticDir: tempStaticDir });
    const addr = await serverInstance.listen(0, "127.0.0.1");

    const res = await requestHttp(`${addr.url}/assets/missing-bundle-999.js`, { method: "GET" });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("<title>QuantFund-OS</title>");
  });

  it("C. supports HEAD requests on non-API static files with correct content length and no body", async () => {
    serverInstance = createProductionServer({ staticDir: tempStaticDir });
    const addr = await serverInstance.listen(0, "127.0.0.1");

    const res = await requestHttp(`${addr.url}/robots.txt`, { method: "HEAD" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(Number(res.headers["content-length"])).toBeGreaterThan(0);
    expect(res.body).toBe("");
  });

  it("C & D. strictly rejects path traversal and never leaks outside files", async () => {
    serverInstance = createProductionServer({ staticDir: tempStaticDir });
    const addr = await serverInstance.listen(0, "127.0.0.1");

    // Attempt 1: standard ../ traversal
    const res1 = await requestHttp(`${addr.url}/../sentinel.txt`, { method: "GET" });
    expect([400, 403, 404]).toContain(res1.statusCode);
    expect(res1.body).not.toContain(SENTINEL_SECRET);

    // Attempt 2: URL encoded %2e%2e%2f traversal
    const res2 = await requestHttp(`${addr.url}/%2e%2e%2fsentinel.txt`, { method: "GET" });
    expect([400, 403, 404]).toContain(res2.statusCode);
    expect(res2.body).not.toContain(SENTINEL_SECRET);
  });

  it("D. includes security headers and forbids wildcard CORS by default", async () => {
    serverInstance = createProductionServer({ staticDir: tempStaticDir });
    const addr = await serverInstance.listen(0, "127.0.0.1");

    const res = await requestHttp(`${addr.url}/`, { method: "GET" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("E. supports lifecycle, ephemeral port discovery, injected apiHandler, and clean shutdown", async () => {
    let customApiCalled = false;
    serverInstance = createProductionServer({
      staticDir: tempStaticDir,
      apiHandler: (_req, res, pathname) => {
        if (pathname === "/api/custom-test") {
          customApiCalled = true;
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ custom: true }));
          return true;
        }
        return false;
      },
    });

    const addr = await serverInstance.listen(0, "127.0.0.1");
    expect(addr.port).toBeGreaterThan(0);
    expect(serverInstance.getAddress()?.port).toBe(addr.port);

    const customRes = await requestHttp(`${addr.url}/api/custom-test`, { method: "GET" });
    expect(customRes.statusCode).toBe(200);
    expect(JSON.parse(customRes.body)).toEqual({ custom: true });
    expect(customApiCalled).toBe(true);

    await serverInstance.close();
    expect(serverInstance.getAddress()).toBeNull();

    // After shutdown, connection must fail
    await expect(
      requestHttp(`${addr.url}/api/health`, { method: "GET" })
    ).rejects.toThrow();
  });

  it("F. verifies direct executable entrypoint starts or enforces runtime compatibility via child process", async () => {
    const serverScriptPath = path.resolve(process.cwd(), "dist-server", "productionServer.js");
    expect(fs.existsSync(serverScriptPath)).toBe(true);

    const isSupported = isNodeVersionSupported(process.version).supported;

    childProc = spawn(process.execPath, [serverScriptPath], {
      env: { ...process.env, PORT: "0", HOST: "127.0.0.1" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      if (!isSupported) {
        // On unsupported runtime (Node 24 locally), the server must refuse startup fail-fast
        let stderr = "";
        childProc.stderr?.on("data", (c: Buffer) => { stderr += c.toString(); });
        const exitCode = await new Promise<number | null>((resolve) => {
          childProc?.once("exit", (code) => resolve(code));
        });
        expect(exitCode).not.toBe(0);
        expect(stderr).toContain("RUNTIME_INCOMPATIBLE");
      } else {
        // On supported runtime (Node 22 LTS in CI), server must start and serve health
        const address = await new Promise<string>((resolve, reject) => {
          let output = "";
          let settled = false;
          let startupTimer: ReturnType<typeof setTimeout> | undefined;
          const finish = (callback: () => void) => {
            if (settled) return;
            settled = true;
            if (startupTimer) clearTimeout(startupTimer);
            callback();
          };

          let stderr = "";
          childProc?.stderr?.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
          });
          childProc?.stdout?.on("data", (chunk: Buffer) => {
            output += chunk.toString();
            const match = output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/i);
            if (match?.[1]) finish(() => resolve(match[1]));
          });
          childProc?.once("error", (error) => finish(() => reject(error)));
          childProc?.once("exit", (code, signal) => {
            finish(() => reject(new Error(`Production server exited before startup: code=${code ?? "null"} signal=${signal ?? "null"}. Stderr: ${stderr}`)));
          });

          startupTimer = setTimeout(() => finish(() => reject(new Error(`Timed out waiting for production server startup. Stderr: ${stderr}`))), 5000);
        });

        const healthRes = await requestHttp(`${address}/api/health`, { method: "GET" });
        expect(healthRes.statusCode).toBe(200);
        const body = JSON.parse(healthRes.body);
        expect(body.status).toBe("ok");
      }
    } finally {
      if (childProc) {
        await stopChildProcess(childProc);
        childProc = null;
      }
    }
  });

  it("G. exercises graceful signal shutdown with SQLite storage in a child process", async () => {
    const serverScriptPath = path.resolve(process.cwd(), "dist-server", "productionServer.js");
    const isSupported = isNodeVersionSupported(process.version).supported;
    const testDataDir = path.join(tempBaseDir, "signal-test-data");

    childProc = spawn(process.execPath, [serverScriptPath], {
      env: {
        ...process.env,
        PORT: "0",
        HOST: "127.0.0.1",
        QUANTFUND_ENABLE_STORAGE: "true",
        QUANTFUND_DATA_DIR: testDataDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      if (!isSupported) {
        // On unsupported runtime (Node 24), fail fast
        let stderr = "";
        childProc.stderr?.on("data", (c: Buffer) => { stderr += c.toString(); });
        const exitCode = await new Promise<number | null>((resolve) => {
          childProc?.once("exit", (code) => resolve(code));
        });
        expect(exitCode).not.toBe(0);
        expect(stderr).toContain("RUNTIME_INCOMPATIBLE");
      } else {
        // On supported runtime, reach readiness then send SIGTERM
        const address = await new Promise<string>((resolve, reject) => {
          let output = "";
          let stderr = "";
          let settled = false;
          let startupTimer: ReturnType<typeof setTimeout> | undefined;
          const finish = (callback: () => void) => {
            if (settled) return;
            settled = true;
            if (startupTimer) clearTimeout(startupTimer);
            callback();
          };

          childProc?.stderr?.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
          });
          childProc?.stdout?.on("data", (chunk: Buffer) => {
            output += chunk.toString();
            const match = output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/i);
            if (match?.[1]) finish(() => resolve(match[1]));
          });
          childProc?.once("error", (error) => finish(() => reject(error)));
          childProc?.once("exit", (code, signal) => {
            finish(() => reject(new Error(`Production server exited unexpectedly: code=${code ?? "null"} signal=${signal ?? "null"}. Stderr: ${stderr}`)));
          });

          startupTimer = setTimeout(() => finish(() => reject(new Error(`Timed out waiting for production server startup. Stderr: ${stderr}`))), 5000);
        });

        // Verify storage is genuine ready
        const readyRes = await requestHttp(`${address}/api/ready`, { method: "GET" });
        expect(readyRes.statusCode).toBe(200);

        // Send SIGTERM for graceful shutdown
        childProc.kill("SIGTERM");

        const exitCode = await new Promise<number | null>((resolve) => {
          childProc?.once("exit", (code) => resolve(code));
        });
        expect(exitCode).toBe(0);

        // Verify database file was cleanly closed and is readable afterward
        const dbFile = path.join(testDataDir, "quantfund.db");
        expect(fs.existsSync(dbFile)).toBe(true);
        const verifyDb = new DatabaseSync(dbFile);
        const check = verifyDb.prepare("PRAGMA quick_check;").get() as Record<string, unknown>;
        const checkVal = String(check.quick_check ?? Object.values(check)[0] ?? "");
        expect(checkVal.toLowerCase()).toBe("ok");
        verifyDb.close();
      }
    } finally {
      if (childProc) {
        await stopChildProcess(childProc);
        childProc = null;
      }
    }
  });

  it("H. rejects production server creation on unsupported Node.js runtime without spoofing", () => {
    // 1. Explicitly verify unsupported runtime (Node 24) fails closed
    Object.defineProperty(process.versions, "node", {
      value: "24.19.0",
      configurable: true,
      writable: true,
    });
    expect(() => createProductionServer({ staticDir: tempStaticDir })).toThrow("RUNTIME_INCOMPATIBLE");

    // 2. Explicitly verify supported runtime (Node 22.23.3) succeeds without throwing
    Object.defineProperty(process.versions, "node", {
      value: "22.23.3",
      configurable: true,
      writable: true,
    });
    expect(() => {
      const s = createProductionServer({ staticDir: tempStaticDir });
      s.httpServer.close();
    }).not.toThrow();

    // 3. Evaluate live unmocked process runtime truthfully
    Object.defineProperty(process.versions, "node", {
      value: originalNodeVersion,
      configurable: true,
      writable: true,
    });
    const liveSupported = isNodeVersionSupported(originalNodeVersion).supported;
    if (liveSupported) {
      expect(() => {
        const s = createProductionServer({ staticDir: tempStaticDir });
        s.httpServer.close();
      }).not.toThrow();
    } else {
      expect(() => createProductionServer({ staticDir: tempStaticDir })).toThrow("RUNTIME_INCOMPATIBLE");
    }

    // 4. Verify no createProductionServerCore, createTestProductionServer, or openDirect bypass is exported
    expect((productionServerModule as any).createProductionServerCore).toBeUndefined();
    expect((productionServerModule as any).createTestProductionServer).toBeUndefined();
  });

  it("I1. enforces ordered bounded shutdown: waits for active async handler to quiesce before closing storage", async () => {
    let storageClosed = false;
    let storageClosedAt: number | null = null;
    let handlerFinishedAt: number | null = null;

    const mockStorage = {
      getStatus: () => ({ isReady: !storageClosed, isClosed: storageClosed } as any),
      close: () => {
        storageClosed = true;
        storageClosedAt = Date.now();
      },
    } as any;

    // Create custom async handler that takes 150ms
    let releaseHandler: () => void;
    const handlerGate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });

    serverInstance = createProductionServer({
      staticDir: tempStaticDir,
      storage: mockStorage,
      apiHandler: async (req, res, pathname) => {
        if (pathname === "/api/slow-task") {
          await handlerGate;
          handlerFinishedAt = Date.now();
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ status: "done" }));
          return true;
        }
        return false;
      },
    });

    const addr = await serverInstance.listen(0, "127.0.0.1");
    expect(serverInstance.isShuttingDown).toBe(false);

    // Start slow request
    let requestCompleted = false;
    const reqPromise = requestHttp(`${addr.url}/api/slow-task`).then((res) => {
      requestCompleted = true;
      return res;
    });

    // Give request a moment to enter the handler
    await new Promise((r) => setTimeout(r, 50));

    // Initiate shutdown while handler is in-flight
    const closePromise1 = serverInstance.close(3000);
    const closePromise2 = serverInstance.close(3000);

    // Verify idempotency: same shared promise
    expect(closePromise1).toBe(closePromise2);
    expect(serverInstance.isShuttingDown).toBe(true);

    // Verify storage is NOT closed yet while handler is running
    expect(storageClosed).toBe(false);
    expect(requestCompleted).toBe(false);

    // Now allow handler to complete
    releaseHandler!();

    const res = await reqPromise;
    expect(res.statusCode).toBe(200);

    // Await shutdown completion
    await closePromise1;

    expect(storageClosed).toBe(true);
    expect(handlerFinishedAt).not.toBeNull();
    expect(storageClosedAt).not.toBeNull();
    expect(storageClosedAt!).toBeGreaterThanOrEqual(handlerFinishedAt!);
  });

  it("I2. bounds shutdown on hanging handler: times out, skips storage close to protect storage, and rejects with error", async () => {
    let storageClosed = false;

    const mockStorage = {
      getStatus: () => ({ isReady: !storageClosed, isClosed: storageClosed } as any),
      close: () => {
        storageClosed = true;
      },
    } as any;

    // A handler that hangs indefinitely
    serverInstance = createProductionServer({
      staticDir: tempStaticDir,
      storage: mockStorage,
      apiHandler: async (req, res, pathname) => {
        if (pathname === "/api/hanging-task") {
          // Never resolves
          await new Promise(() => {});
          return true;
        }
        return false;
      },
    });

    const addr = await serverInstance.listen(0, "127.0.0.1");

    // Fire hanging request and catch expected client error on socket destroy
    const hangingReqPromise = requestHttp(`${addr.url}/api/hanging-task`).catch(() => {});

    // Wait a moment for handler to register
    await new Promise((r) => setTimeout(r, 50));

    // Close with short 150ms timeout
    let closeError: Error | null = null;
    try {
      await serverInstance.close(150);
    } catch (err) {
      closeError = err as Error;
    }

    await hangingReqPromise;

    expect(closeError).not.toBeNull();
    expect(closeError?.message).toContain("SHUTDOWN_FAILED");
    expect(closeError?.message).toContain("SHUTDOWN_TIMEOUT");
    expect(closeError?.message).toContain("STORAGE_CLOSE_SKIPPED");

    // CRITICAL: Storage was NOT closed underneath active handler
    expect(storageClosed).toBe(false);
  });

  it("I3. propagates storage.close failure as SHUTDOWN_FAILED", async () => {
    const mockStorage = {
      getStatus: () => ({ isReady: true, isClosed: false } as any),
      close: () => {
        throw new Error("DISK_CORRUPTION_ON_CLOSE");
      },
    } as any;

    serverInstance = createProductionServer({
      staticDir: tempStaticDir,
      storage: mockStorage,
    });

    await serverInstance.listen(0, "127.0.0.1");

    let closeError: Error | null = null;
    try {
      await serverInstance.close(1000);
    } catch (err) {
      closeError = err as Error;
    }

    expect(closeError).not.toBeNull();
    expect(closeError?.message).toContain("SHUTDOWN_FAILED");
    expect(closeError?.message).toContain("DISK_CORRUPTION_ON_CLOSE");
  });

  it("I4. proves server.close completion barrier holds until slow/streamed response completes, and storage closes only after complete server close (P1-D)", async () => {
    let storageClosed = false;
    let storageClosedAt: number | null = null;
    let streamFinishedAt: number | null = null;

    const mockStorage = {
      getStatus: () => ({ isReady: !storageClosed, isClosed: storageClosed } as any),
      close: () => {
        storageClosed = true;
        storageClosedAt = Date.now();
      },
    } as any;

    let releaseStream: () => void;
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });

    serverInstance = createProductionServer({
      staticDir: tempStaticDir,
      storage: mockStorage,
      apiHandler: async (req, res, pathname) => {
        if (pathname === "/api/streamed-report") {
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.write("part-1\n");
          // Hold stream open until release
          await streamGate;
          res.write("part-2\n");
          res.end();
          streamFinishedAt = Date.now();
          return true;
        }
        return false;
      },
    });

    const addr = await serverInstance.listen(0, "127.0.0.1");

    // Start request receiving chunks
    let fullBody = "";
    let requestFinished = false;
    const reqPromise = new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
      const req = http.request(`${addr.url}/api/streamed-report`, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(Buffer.from(c)));
        res.on("end", () => {
          requestFinished = true;
          fullBody = Buffer.concat(chunks).toString("utf8");
          resolve({ statusCode: res.statusCode || 0, body: fullBody });
        });
      });
      req.on("error", reject);
      req.end();
    });

    // Wait a moment for connection to establish and first chunk to arrive
    await new Promise((r) => setTimeout(r, 50));

    // Initiate shutdown while stream is still open
    const closePromise = serverInstance.close(3000);

    // Verify shutdown barrier is active and has NOT resolved
    let closeResolved = false;
    closePromise.then(() => {
      closeResolved = true;
    });

    await new Promise((r) => setTimeout(r, 60));
    expect(closeResolved).toBe(false);
    expect(storageClosed).toBe(false);
    expect(requestFinished).toBe(false);

    // Release the stream to allow HTTP response to finish and connection to close
    releaseStream!();

    const response = await reqPromise;
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("part-1\npart-2\n");

    // Await server close
    await closePromise;
    expect(closeResolved).toBe(true);
    expect(storageClosed).toBe(true);
    expect(streamFinishedAt).not.toBeNull();
    expect(storageClosedAt).not.toBeNull();
    expect(storageClosedAt!).toBeGreaterThanOrEqual(streamFinishedAt!);
  });

  it("matches production quant-events method semantics in the Vite development adapter", async () => {
    const viteServer = await createViteServer({
      configFile: path.resolve(process.cwd(), "vite.config.ts"),
      server: { middlewareMode: true },
      appType: "custom",
    });
    const middlewareServer = http.createServer(viteServer.middlewares);
    await new Promise<void>((resolve, reject) => {
      middlewareServer.once("error", reject);
      middlewareServer.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = middlewareServer.address();
      if (!address || typeof address === "string") throw new Error("Vite middleware server did not expose a TCP address");
      const baseUrl = `http://127.0.0.1:${address.port}`;

      const getResponse = await requestHttp(`${baseUrl}/api/quant-events`, { method: "GET" });
      expect(getResponse.statusCode).toBe(503);
      expect(JSON.parse(getResponse.body)).toEqual({
        status: "FAILURE",
        error: {
          code: "UNAVAILABLE",
          message: "Quant event feed is not connected to a production source.",
        },
      });

      const postResponse = await requestHttp(`${baseUrl}/api/quant-events`, { method: "POST" });
      expect(postResponse.statusCode).toBe(405);
      expect(postResponse.headers.allow).toBe("GET");
      expect(JSON.parse(postResponse.body)).toEqual({
        error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" },
      });

      const nestedGetResponse = await requestHttp(`${baseUrl}/api/quant-events/foo`, { method: "GET" });
      expect(nestedGetResponse.statusCode).toBe(404);
      expect(nestedGetResponse.headers["content-type"]).toContain("application/json");
      expect(nestedGetResponse.body).not.toContain("<!DOCTYPE html>");
      expect(JSON.parse(nestedGetResponse.body)).toEqual({
        error: { code: "NOT_FOUND", message: "API route not found" },
      });

      const nestedPostResponse = await requestHttp(`${baseUrl}/api/quant-events/foo`, { method: "POST" });
      expect(nestedPostResponse.statusCode).toBe(404);
      expect(nestedPostResponse.headers.allow).toBeUndefined();
      expect(JSON.parse(nestedPostResponse.body)).toEqual({
        error: { code: "NOT_FOUND", message: "API route not found" },
      });

      const trailingSlashResponse = await requestHttp(`${baseUrl}/api/quant-events/`, { method: "GET" });
      expect(trailingSlashResponse.statusCode).toBe(404);
      expect(trailingSlashResponse.body).not.toContain("<!DOCTYPE html>");
      expect(JSON.parse(trailingSlashResponse.body)).toEqual({
        error: { code: "NOT_FOUND", message: "API route not found" },
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        middlewareServer.close((error) => error ? reject(error) : resolve());
      });
      await viteServer.close();
    }
  });
});
