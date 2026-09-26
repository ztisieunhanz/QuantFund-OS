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

const GEMINI_GENERATE_CONTENT_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent";

export interface AiGatewayUpstreamResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly json: () => Promise<unknown>;
}

export type AiGatewayUpstreamFetch = (
  input: string,
  init: Readonly<{
    method: "POST";
    headers: Readonly<Record<string, string>>;
    body: string;
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

  let upstream: AiGatewayUpstreamResponse;
  try {
    const fetchFn = dependencies.fetchFn ?? globalThis.fetch;
    upstream = await fetchFn(upstreamUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        contents: request.messages.map((message) => ({
          role: message.role,
          parts: [{ text: message.text }],
        })),
        generationConfig: { temperature: 0.2 },
      }),
    });
  } catch {
    return failure(502, "UPSTREAM_FAILURE", "AI provider request failed.");
  }

  if (!upstream.ok) {
    return failure(502, "UPSTREAM_FAILURE", "AI provider rejected the request.");
  }

  let upstreamPayload: unknown;
  try {
    upstreamPayload = await upstream.json();
  } catch {
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
