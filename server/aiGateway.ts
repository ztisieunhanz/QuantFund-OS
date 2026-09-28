// ============================================================================
// FILE: server/aiGateway.ts
// MODULE: SERVER-SIDE AI GATEWAY HANDLER (M15.2A)
// NOTE: Runtime-neutral handler; Vite middleware is only the local/dev adapter.
// ============================================================================

import {
  AI_GATEWAY_MAX_BODY_BYTES,
  parseAiGatewayRequest,
  type AiGatewayFailure,
  type AiGatewayFailureCode,
  type AiGatewayResponse,
} from "../src/lib/aiGatewayContract";
import { buildServerGroundedAdvisorInstruction } from "../src/lib/aiAdvisorGrounding";

const GEMINI_GENERATE_CONTENT_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent";

export const AI_GATEWAY_UPSTREAM_TIMEOUT_MS = 20_000;
export const AI_GATEWAY_MAX_UPSTREAM_BODY_BYTES = 1_048_576;

export interface AiGatewayUpstreamResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly body?: unknown;
  readonly text?: () => Promise<string>;
  readonly json?: () => Promise<unknown>;
}

export type AiGatewayUpstreamFetch = (
  input: string,
  init: Readonly<{
    method: "POST";
    headers: Readonly<Record<string, string>>;
    body: string;
    signal?: AbortSignal;
  }>
) => Promise<AiGatewayUpstreamResponse>;

export interface AiGatewayServerResult {
  readonly statusCode: number;
  readonly body: AiGatewayResponse;
}

function failure(
  statusCode: number,
  code: AiGatewayFailureCode,
  message: string
): AiGatewayServerResult {
  const body: AiGatewayFailure = Object.freeze({
    status: "FAILURE",
    error: Object.freeze({ code, message }),
  });
  return Object.freeze({ statusCode, body });
}

function extractGeminiText(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const candidates = (payload as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const content = (candidates[0] as { content?: unknown } | undefined)?.content;
  if (typeof content !== "object" || content === null) return null;
  const parts = (content as { parts?: unknown }).parts;
  if (!Array.isArray(parts) || parts.length === 0) return null;
  const text = (parts[0] as { text?: unknown } | undefined)?.text;
  return typeof text === "string" && text.trim().length > 0 ? text : null;
}

interface BoundedReader {
  read: () => Promise<{ done: boolean; value?: unknown }>;
  cancel?: () => Promise<void> | void;
  releaseLock?: () => void;
}

class UpstreamDeadlineError extends Error {
  constructor() {
    super("AI provider deadline exceeded.");
    this.name = "UpstreamDeadlineError";
  }
}

async function awaitWithAbort<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new UpstreamDeadlineError();

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new UpstreamDeadlineError());
    };
    const resolveOnce = (value: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error("Upstream operation failed."));
    };

    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(operation)
      .then(
        resolveOnce,
        rejectOnce,
      );
  });
}

async function readBoundedUpstreamJson(
  upstream: AiGatewayUpstreamResponse,
  signal: AbortSignal,
): Promise<unknown | null> {
  const body = upstream.body as { getReader?: () => BoundedReader } | null | undefined;
  if (body?.getReader) {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    let cancelReader = false;

    try {
      while (true) {
        const chunk = await awaitWithAbort(() => reader.read(), signal);
        if (chunk.done) break;
        if (!(chunk.value instanceof Uint8Array)) return null;
        totalBytes += chunk.value.byteLength;
        if (totalBytes > AI_GATEWAY_MAX_UPSTREAM_BODY_BYTES) {
          cancelReader = true;
          return null;
        }
        chunks.push(chunk.value);
      }
    } finally {
      if (cancelReader || signal.aborted) {
        try {
          await reader.cancel?.();
        } catch {
          // Preserve the sanitized gateway failure even if cancellation fails.
        }
      }
      reader.releaseLock?.();
    }

    const rawBody = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
    try {
      return JSON.parse(rawBody) as unknown;
    } catch {
      return null;
    }
  }

  if (upstream.text) {
    try {
      const rawBody = await awaitWithAbort(() => upstream.text!(), signal);
      if (Buffer.byteLength(rawBody, "utf8") > AI_GATEWAY_MAX_UPSTREAM_BODY_BYTES) return null;
      return JSON.parse(rawBody) as unknown;
    } catch {
      if (signal.aborted) throw new UpstreamDeadlineError();
      return null;
    }
  }

  // Kept for the existing deterministic unit-test adapter. Production fetch
  // always exposes Response.body and therefore uses the bounded stream path.
  if (upstream.json) {
    try {
      return await awaitWithAbort(() => upstream.json!(), signal);
    } catch {
      if (signal.aborted) throw new UpstreamDeadlineError();
      return null;
    }
  }

  return null;
}

/**
 * Handles the narrow gateway contract without selecting a production host.
 * Credential material is accepted only as a server dependency and is never
 * included in browser responses or diagnostics.
 */
export async function handleAiGatewayRequest(
  input: Readonly<{
    method: string | undefined;
    rawBody: string;
    bodyByteLength?: number;
  }>,
  dependencies: Readonly<{
    apiKey: string | undefined;
    fetchFn?: AiGatewayUpstreamFetch;
    upstreamTimeoutMs?: number;
  }>
): Promise<AiGatewayServerResult> {
  if (input.method !== "POST") {
    return failure(405, "INVALID_REQUEST", "Method not allowed.");
  }

  const bodyByteLength = input.bodyByteLength ?? Buffer.byteLength(input.rawBody, "utf8");
  if (bodyByteLength > AI_GATEWAY_MAX_BODY_BYTES) {
    return failure(413, "INVALID_REQUEST", "Request body is too large.");
  }

  let untrustedPayload: unknown;
  try {
    untrustedPayload = JSON.parse(input.rawBody);
  } catch {
    return failure(400, "INVALID_REQUEST", "Request body must be valid JSON.");
  }

  const request = parseAiGatewayRequest(untrustedPayload);
  if (!request) {
    return failure(400, "INVALID_REQUEST", "Request payload is invalid.");
  }

  const apiKey = dependencies.apiKey?.trim();
  if (!apiKey) {
    return failure(503, "UNAVAILABLE", "AI service is unavailable.");
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  let upstreamUrl = GEMINI_GENERATE_CONTENT_URL;
  if (apiKey.startsWith("AQ.")) {
    headers.Authorization = `Bearer ${apiKey}`;
  } else if (apiKey.startsWith("AIzaSy")) {
    upstreamUrl = `${upstreamUrl}?key=${encodeURIComponent(apiKey)}`;
  } else {
    headers["x-goog-api-key"] = apiKey;
  }

  let upstream: AiGatewayUpstreamResponse | undefined;
  const abortController = new AbortController();
  const timeoutMs = dependencies.upstreamTimeoutMs ?? AI_GATEWAY_UPSTREAM_TIMEOUT_MS;
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);
  let upstreamPayload: unknown | null = null;
  try {
    const fetchFn = dependencies.fetchFn ?? globalThis.fetch;
    upstream = await fetchFn(upstreamUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: buildServerGroundedAdvisorInstruction(request.grounding) }],
        },
        contents: request.messages.map((message) => ({
          role: message.role,
          parts: [{ text: message.text }],
        })),
        generationConfig: { temperature: 0.2 },
      }),
      signal: abortController.signal,
    });
    if (!upstream.ok) {
      return failure(502, "UPSTREAM_FAILURE", "AI provider rejected the request.");
    }
    upstreamPayload = await readBoundedUpstreamJson(upstream, abortController.signal);
  } catch (error) {
    if (error instanceof UpstreamDeadlineError || abortController.signal.aborted) {
      return failure(502, "UPSTREAM_FAILURE", "AI provider request failed.");
    }
    if (!upstream) {
      return failure(502, "UPSTREAM_FAILURE", "AI provider request failed.");
    }
    return failure(502, "MALFORMED_UPSTREAM_RESPONSE", "AI provider returned an unreadable response.");
  } finally {
    clearTimeout(timeout);
  }

  if (upstreamPayload === null) {
    return failure(502, "MALFORMED_UPSTREAM_RESPONSE", "AI provider returned an unreadable response.");
  }

  const text = extractGeminiText(upstreamPayload);
  if (!text) {
    return failure(502, "MALFORMED_UPSTREAM_RESPONSE", "AI provider returned an invalid response.");
  }

  return Object.freeze({
    statusCode: 200,
    body: Object.freeze({ status: "SUCCESS", text }),
  });
}
