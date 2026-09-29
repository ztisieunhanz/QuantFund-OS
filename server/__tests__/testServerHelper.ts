// ============================================================================
// FILE: server/__tests__/testServerHelper.ts
// MODULE: TEST-SCOPED SERVER MECHANISM HARNESS (M18-C1)
// NOTE: For test suite execution only. Not part of production exports.
// ============================================================================

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import type { Socket } from "node:net";
import { createProductionApiHandler } from "../productionApi";
import { SqliteStorage } from "../storage";
import {
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  type ProductionServerInstance,
  type ProductionServerOptions,
  type ProductionServerAddress,
} from "../productionServer";

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

function applySecurityHeaders(res: http.ServerResponse): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
}

function sendJson(
  res: http.ServerResponse,
  statusCode: number,
  payload: unknown,
  headers?: Record<string, string>
): void {
  applySecurityHeaders(res);
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (headers) {
    for (const [key, val] of Object.entries(headers)) {
      res.setHeader(key, val);
    }
  }
  res.end(JSON.stringify(payload));
}

function serveStaticFile(
  res: http.ServerResponse,
  method: string,
  filePath: string,
  _staticDir: string,
  isSpaFallback = false
): void {
  try {
    const stat = fs.statSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";

    applySecurityHeaders(res);
    res.statusCode = 200;
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", stat.size);

    const isHtml = ext === ".html" || isSpaFallback;
    const isHashedAsset =
      filePath.includes(path.sep + "assets" + path.sep) ||
      /[.-][a-f0-9]{8,}\./i.test(path.basename(filePath));

    if (isHtml) {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
    } else if (isHashedAsset) {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    } else {
      res.setHeader("Cache-Control", "public, max-age=3600");
    }

    if (method === "HEAD") {
      res.end();
      return;
    }

    const stream = fs.createReadStream(filePath);
    stream.on("error", () => {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end();
      }
    });
    stream.pipe(res);
  } catch {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end();
    }
  }
}

/**
 * Creates an ungated test server instance for Vitest unit tests under local Node 24.
 * Not part of production exports or server builds.
 */
export function createTestProductionServer(
  options: ProductionServerOptions = {}
): ProductionServerInstance {
  const resolvedStaticDir = path.resolve(
    options.staticDir ?? path.resolve(process.cwd(), "dist")
  );
  let storageInstance: SqliteStorage | null = options.storage ?? null;
  if (!storageInstance && options.autoInitStorage) {
    storageInstance = new SqliteStorage({ env: options.env });
    storageInstance.open();
  }

  const apiHandler = options.apiHandler ?? createProductionApiHandler({
    env: options.env,
    fetchFn: options.fetchFn,
    upstreamTimeoutMs: options.upstreamTimeoutMs,
  });

  let isShuttingDownState = false;
  let shutdownPromise: Promise<void> | null = null;
  const activeSockets = new Set<Socket>();
  const activeHandlers = new Set<Promise<void>>();

  const server = http.createServer(async (req, res) => {
    if (isShuttingDownState) {
      res.setHeader("Connection", "close");
      sendJson(res, 503, {
        error: { code: "SERVER_SHUTTING_DOWN", message: "Server is undergoing graceful shutdown" },
      });
      return;
    }

    let handlerDone: () => void;
    const handlerPromise = new Promise<void>((resolve) => {
      handlerDone = resolve;
    });
    activeHandlers.add(handlerPromise);

    try {
      if (!req.url) {
        sendJson(res, 400, { error: { code: "BAD_REQUEST", message: "Missing request URL" } });
        return;
      }

      let parsedUrl: url.URL;
      try {
        parsedUrl = new url.URL(req.url, "http://localhost");
      } catch {
        sendJson(res, 400, { error: { code: "BAD_REQUEST", message: "Malformed request URL" } });
        return;
      }

      const rawPathname = parsedUrl.pathname;
      let decodedPathname: string;
      try {
        decodedPathname = decodeURIComponent(rawPathname);
      } catch {
        sendJson(res, 400, { error: { code: "BAD_REQUEST", message: "Invalid URL encoding" } });
        return;
      }

      if (decodedPathname.includes("\0")) {
        sendJson(res, 400, {
          error: { code: "BAD_REQUEST", message: "Null bytes are not allowed in path" },
        });
        return;
      }

      // 1. /api/* ROUTES
      if (decodedPathname.startsWith("/api/") || decodedPathname === "/api") {
        if (decodedPathname === "/api/health") {
          if (req.method === "GET") {
            sendJson(res, 200, {
              status: "ok",
              uptime: Math.floor(process.uptime()),
            });
            return;
          }
          sendJson(
            res,
            405,
            { error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" } },
            { Allow: "GET" }
          );
          return;
        }

        if (decodedPathname === "/api/ready") {
          if (req.method === "GET") {
            if (storageInstance) {
              const status = storageInstance.getStatus();
              if (status.isReady && !status.isClosed) {
                sendJson(res, 200, {
                  status: "ready",
                  storage: status,
                });
                return;
              }
              sendJson(res, 503, {
                status: "unready",
                error: {
                  code: "STORAGE_NOT_READY",
                  message: "Operational storage is not ready or has been closed.",
                },
                storage: status,
              });
              return;
            }
            sendJson(res, 503, {
              status: "unready",
              error: {
                code: "STORAGE_NOT_CONFIGURED",
                message: "Operational storage is not configured.",
              },
              storage: {
                configured: false,
                ready: false,
              },
            });
            return;
          }
          sendJson(
            res,
            405,
            { error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" } },
            { Allow: "GET" }
          );
          return;
        }

        if (apiHandler) {
          try {
            const handled = await apiHandler(req, res, decodedPathname, parsedUrl.searchParams);
            if (handled || res.writableEnded) {
              return;
            }
          } catch {
            if (!res.writableEnded) {
              sendJson(res, 500, {
                error: { code: "INTERNAL_ERROR", message: "Internal server error" },
              });
            }
            return;
          }
        }

        sendJson(res, 404, {
          error: {
            code: "NOT_FOUND",
            message: "API route not found",
          },
        });
        return;
      }

      // 2. STATIC ASSETS & SPA ROUTING
      if (req.method !== "GET" && req.method !== "HEAD") {
        sendJson(
          res,
          405,
          { error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" } },
          { Allow: "GET, HEAD" }
        );
        return;
      }

      const relativePath = decodedPathname.replace(/^\/+/, "");
      const targetFilePath = path.resolve(resolvedStaticDir, relativePath);

      if (
        targetFilePath !== resolvedStaticDir &&
        !targetFilePath.startsWith(resolvedStaticDir + path.sep)
      ) {
        sendJson(res, 403, { error: { code: "FORBIDDEN", message: "Access denied" } });
        return;
      }

      let isDirectFile = false;
      let finalPath = targetFilePath;

      try {
        const stat = fs.statSync(finalPath);
        if (stat.isDirectory()) {
          const candidateIndex = path.join(finalPath, "index.html");
          if (fs.existsSync(candidateIndex) && fs.statSync(candidateIndex).isFile()) {
            finalPath = candidateIndex;
            isDirectFile = true;
          }
        } else if (stat.isFile()) {
          isDirectFile = true;
        }
      } catch {
        isDirectFile = false;
      }

      if (isDirectFile) {
        serveStaticFile(res, req.method, finalPath, resolvedStaticDir);
        return;
      }

      const hasFileExtension = path.extname(decodedPathname).length > 0;
      const isAssetPath =
        decodedPathname.startsWith("/assets/") || decodedPathname.startsWith("/public/");

      if (hasFileExtension || isAssetPath) {
        sendJson(res, 404, {
          error: { code: "NOT_FOUND", message: "Static resource not found" },
        });
        return;
      }

      const spaIndexPath = path.join(resolvedStaticDir, "index.html");
      if (fs.existsSync(spaIndexPath) && fs.statSync(spaIndexPath).isFile()) {
        serveStaticFile(res, req.method, spaIndexPath, resolvedStaticDir, true);
        return;
      }

      sendJson(res, 404, {
        error: { code: "NOT_FOUND", message: "SPA entry not found" },
      });
    } finally {
      activeHandlers.delete(handlerPromise);
      handlerDone!();
    }
  });

  server.on("connection", (socket: Socket) => {
    activeSockets.add(socket);
    socket.on("close", () => {
      activeSockets.delete(socket);
    });
  });

  const performGracefulShutdown = (timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS): Promise<void> => {
    if (shutdownPromise) {
      return shutdownPromise;
    }

    isShuttingDownState = true;

    shutdownPromise = (async () => {
      const errors: Error[] = [];

      let serverCloseError: Error | null = null;
      let serverClosed = false;

      if (server.listening) {
        server.close((err) => {
          serverClosed = true;
          if (err && (err as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
            serverCloseError = err;
          }
        });

        if (typeof server.closeIdleConnections === "function") {
          server.closeIdleConnections();
        }
      } else {
        serverClosed = true;
      }

      const waitForQuiescence = async () => {
        while (activeHandlers.size > 0) {
          await Promise.all(Array.from(activeHandlers));
        }
        if (!serverClosed && server.listening) {
          await new Promise<void>((resolve) => {
            server.once("close", () => resolve());
          });
        }
      };

      let timeoutHandle: NodeJS.Timeout | null = null;
      const timeoutPromise = new Promise<{ timedOut: boolean }>((resolve) => {
        timeoutHandle = setTimeout(() => resolve({ timedOut: true }), Math.max(100, timeoutMs));
      });

      const { timedOut } = await Promise.race([
        waitForQuiescence().then(() => ({ timedOut: false })),
        timeoutPromise,
      ]);

      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }

      if (timedOut) {
        if (typeof server.closeAllConnections === "function") {
          server.closeAllConnections();
        } else {
          for (const socket of activeSockets) {
            socket.destroy();
          }
        }

        const lingeringCount = activeHandlers.size;
        errors.push(
          new Error(
            `SHUTDOWN_TIMEOUT: Shutdown timed out after ${timeoutMs}ms with ${lingeringCount} active request handler(s) still in-flight.`
          )
        );
      }

      if (serverCloseError) {
        errors.push(serverCloseError);
      }

      if (activeHandlers.size === 0) {
        if (storageInstance) {
          try {
            storageInstance.close();
          } catch (storageErr) {
            errors.push(
              storageErr instanceof Error
                ? storageErr
                : new Error(`STORAGE_CLOSE_FAILED: ${String(storageErr)}`)
            );
          }
        }
      } else {
        errors.push(
          new Error(
            "STORAGE_CLOSE_SKIPPED: Storage close was skipped because active request handlers did not quiesce before timeout."
          )
        );
      }

      if (errors.length > 0) {
        const combinedMessage = errors.map((e) => e.message).join("; ");
        const failure = new Error(`SHUTDOWN_FAILED: ${combinedMessage}`);
        (failure as unknown as { errors: Error[] }).errors = errors;
        throw failure;
      }
    })();

    return shutdownPromise;
  };

  return {
    get httpServer() {
      return server;
    },
    get storage() {
      return storageInstance;
    },
    get isShuttingDown() {
      return isShuttingDownState;
    },
    listen(port?: number, host?: string): Promise<ProductionServerAddress> {
      const targetPort = port ?? options.port ?? parseInt(process.env.PORT || "3000", 10);
      const targetHost = host ?? options.host ?? process.env.HOST ?? "0.0.0.0";

      return new Promise((resolve, reject) => {
        server.on("error", reject);
        server.listen(targetPort, targetHost, () => {
          server.off("error", reject);
          const addr = server.address();
          if (!addr || typeof addr === "string") {
            const result: ProductionServerAddress = {
              port: targetPort,
              host: targetHost,
              address: targetHost,
              url: `http://${targetHost === "0.0.0.0" ? "127.0.0.1" : targetHost}:${targetPort}`,
            };
            resolve(result);
            return;
          }

          const listenHost =
            addr.address === "::" || addr.address === "0.0.0.0" ? "127.0.0.1" : addr.address;
          const result: ProductionServerAddress = {
            port: addr.port,
            host: addr.address,
            address: `${addr.address}:${addr.port}`,
            url: `http://${listenHost}:${addr.port}`,
          };
          resolve(result);
        });
      });
    },
    close(timeoutMs?: number): Promise<void> {
      return performGracefulShutdown(timeoutMs);
    },
    getAddress(): ProductionServerAddress | null {
      const addr = server.address();
      if (!addr) return null;
      if (typeof addr === "string") {
        return {
          port: options.port ?? 3000,
          host: addr,
          address: addr,
          url: `http://${addr}`,
        };
      }
      const listenHost =
        addr.address === "::" || addr.address === "0.0.0.0" ? "127.0.0.1" : addr.address;
      return {
        port: addr.port,
        host: addr.address,
        address: `${addr.address}:${addr.port}`,
        url: `http://${listenHost}:${addr.port}`,
      };
    },
  };
}
