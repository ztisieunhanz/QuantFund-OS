// ============================================================================
// FILE: server/productionServer.ts
// MODULE: PRODUCTION NODE 22 SERVER SHELL (M16-E1A)
// NOTE: Vendor-neutral HTTP runtime serving built SPA & isolated /api routes.
// ============================================================================

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { createProductionApiHandler, type ProductionApiHandler } from "./productionApi";
import { SqliteStorage } from "./storage";

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

export interface ProductionServerOptions {
  readonly port?: number;
  readonly host?: string;
  readonly staticDir?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetchFn?: typeof fetch;
  readonly upstreamTimeoutMs?: number;
  readonly storage?: SqliteStorage;
  readonly autoInitStorage?: boolean;
  readonly apiHandler?: ProductionApiHandler | ((
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
    query: URLSearchParams
  ) => Promise<boolean | void> | boolean | void);
}

export interface ProductionServerAddress {
  readonly port: number;
  readonly host: string;
  readonly address: string;
  readonly url: string;
}

export interface ProductionServerInstance {
  readonly httpServer: http.Server;
  readonly storage: SqliteStorage | null;
  listen(port?: number, host?: string): Promise<ProductionServerAddress>;
  close(): Promise<void>;
  getAddress(): ProductionServerAddress | null;
}

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

export function createProductionServer(
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

  const server = http.createServer(async (req, res) => {
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
          sendJson(res, 200, {
            status: "ready",
            storage: {
              configured: false,
              ready: true,
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

      // API isolation: unknown API routes return 404 JSON, never SPA index.html
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

    // Path traversal protection
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

    // Missing static resources (with explicit file extension or asset directory path) must 404 truthfully
    const hasFileExtension = path.extname(decodedPathname).length > 0;
    const isAssetPath =
      decodedPathname.startsWith("/assets/") || decodedPathname.startsWith("/public/");

    if (hasFileExtension || isAssetPath) {
      sendJson(res, 404, {
        error: { code: "NOT_FOUND", message: "Static resource not found" },
      });
      return;
    }

    // SPA fallback only for client-side navigation routes
    const spaIndexPath = path.join(resolvedStaticDir, "index.html");
    if (fs.existsSync(spaIndexPath) && fs.statSync(spaIndexPath).isFile()) {
      serveStaticFile(res, req.method, spaIndexPath, resolvedStaticDir, true);
      return;
    }

    sendJson(res, 404, {
      error: { code: "NOT_FOUND", message: "SPA entry not found" },
    });
  });

  return {
    get httpServer() {
      return server;
    },
    get storage() {
      return storageInstance;
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
    close(): Promise<void> {
      if (storageInstance) {
        try {
          storageInstance.close();
        } catch {
          // Graceful close
        }
      }
      return new Promise((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        if (typeof server.closeIdleConnections === "function") {
          server.closeIdleConnections();
        }
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
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

// Direct execution CLI entry
const currentModulePath = url.fileURLToPath(import.meta.url);
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const isDirectEntry =
  Boolean(invokedPath) &&
  (invokedPath === path.resolve(currentModulePath) ||
    invokedPath.endsWith("productionServer.js") ||
    invokedPath.endsWith("productionServer.ts"));

if (isDirectEntry) {
  const port = parseInt(process.env.PORT || "3000", 10);
  const host = process.env.HOST || "0.0.0.0";
  const autoInitStorage = process.env.QUANTFUND_ENABLE_STORAGE === "true";
  const instance = createProductionServer({ autoInitStorage });
  instance
    .listen(port, host)
    .then((addr) => {
      // eslint-disable-next-line no-console
      console.log(`QuantFund-OS Production Server listening on ${addr.url}`);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error("Failed to start production server:", err);
      process.exit(1);
    });
}
