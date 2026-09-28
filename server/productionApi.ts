import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AI_GATEWAY_MAX_BODY_BYTES } from "../src/lib/aiGatewayContract";
import {
  handleAiGatewayRequest,
  type AiGatewayUpstreamFetch,
} from "./aiGateway";
import { handleMarketGatewayRequest } from "./marketGateway";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

export interface ProductionApiOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetchFn?: typeof fetch;
  readonly upstreamTimeoutMs?: number;
}

export type ProductionApiHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  query: URLSearchParams
) => Promise<boolean>;

function writeJson(
  res: ServerResponse,
  statusCode: number,
  payload: unknown,
  headers: Readonly<Record<string, string>> = {}
): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  res.end(JSON.stringify(payload));
}

function failureBody(code: string, message: string) {
  return { status: "FAILURE", error: { code, message } };
}

function requestId(req: IncomingMessage): string {
  const candidate = req.headers["x-request-id"];
  if (typeof candidate === "string" && REQUEST_ID_PATTERN.test(candidate)) return candidate;
  return randomUUID();
}

function readRequestBody(
  req: IncomingMessage,
  maxBytes: number
): Promise<{ rawBody: string; bodyByteLength: number }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bodyByteLength = 0;

    req.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bodyByteLength += buffer.byteLength;
      if (bodyByteLength <= maxBytes) chunks.push(buffer);
    });
    req.on("end", () => {
      resolve({
        rawBody: Buffer.concat(chunks).toString("utf8"),
        bodyByteLength,
      });
    });
    req.on("error", reject);
  });
}

function createUpstreamFetch(fetchFn: typeof fetch): AiGatewayUpstreamFetch {
  return async (input, init) => {
    const response = await fetchFn(input, init);
    return {
      ok: response.ok,
      status: response.status,
      body: response.body,
      text: () => response.text(),
      json: () => response.json(),
    };
  };
}

export function createProductionApiHandler(
  options: ProductionApiOptions = {}
): ProductionApiHandler {
  const runtimeEnv = options.env ?? process.env;
  const upstreamFetch = createUpstreamFetch(options.fetchFn ?? globalThis.fetch);

  return async (req, res, pathname, query) => {
    const correlationId = requestId(req);
    res.setHeader("X-Request-Id", correlationId);

    const marketResult = await handleMarketGatewayRequest(
      { method: req.method, pathname, query },
      { fetchFn: options.fetchFn, upstreamTimeoutMs: options.upstreamTimeoutMs }
    );
    if (marketResult) {
      writeJson(res, marketResult.statusCode, marketResult.body);
      return true;
    }

    if (pathname === "/api/quant-events") {
      if (req.method !== "GET") {
        writeJson(
          res,
          405,
          { error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" } },
          { Allow: "GET" }
        );
        return true;
      }

      writeJson(
        res,
        503,
        failureBody("UNAVAILABLE", "Quant event feed is not connected to a production source.")
      );
      return true;
    }

    if (pathname !== "/api/ai-advisor") return false;

    if (req.method !== "POST") {
      writeJson(
        res,
        405,
        failureBody("INVALID_REQUEST", "Method not allowed."),
        { Allow: "POST" }
      );
      return true;
    }

    const contentType = req.headers["content-type"];
    if (typeof contentType !== "string" || contentType.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
      writeJson(res, 400, failureBody("INVALID_REQUEST", "Request body must be JSON."));
      return true;
    }

    const contentLength = Number(req.headers["content-length"] ?? "NaN");
    if (Number.isFinite(contentLength) && contentLength > AI_GATEWAY_MAX_BODY_BYTES) {
      req.resume();
      writeJson(res, 413, failureBody("INVALID_REQUEST", "Request body is too large."));
      return true;
    }

    let requestBody: { rawBody: string; bodyByteLength: number };
    try {
      requestBody = await readRequestBody(req, AI_GATEWAY_MAX_BODY_BYTES);
    } catch {
      writeJson(res, 400, failureBody("INVALID_REQUEST", "Request body could not be read."));
      return true;
    }
    const result = await handleAiGatewayRequest({ method: req.method, ...requestBody }, {
      apiKey: runtimeEnv.GEMINI_API_KEY,
      fetchFn: upstreamFetch,
      upstreamTimeoutMs: options.upstreamTimeoutMs,
    });
    writeJson(res, result.statusCode, result.body);
    return true;
  };
}
