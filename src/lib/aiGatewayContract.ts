// ============================================================================
// FILE: src/lib/aiGatewayContract.ts
// MODULE: SAME-ORIGIN AI GATEWAY CONTRACT (M15.2A)
// PRINCIPLE: Public advisory messages only; no credentials or economic authority
// ============================================================================

export const AI_GATEWAY_ENDPOINT = "/api/ai-advisor" as const;
export const AI_GATEWAY_OPERATION = "GROUNDED_CHAT" as const;
export const AI_GATEWAY_MAX_BODY_BYTES = 65_536;
export const AI_GATEWAY_MAX_MESSAGES = 50;
export const AI_GATEWAY_MAX_MESSAGE_CHARS = 24_000;
export const AI_GATEWAY_MAX_TOTAL_MESSAGE_CHARS = 60_000;

export type AiGatewayMessageRole = "user" | "model";

export interface AiGatewayMessage {
  readonly role: AiGatewayMessageRole;
  readonly text: string;
}

export interface AiGatewayRequest {
  readonly operation: typeof AI_GATEWAY_OPERATION;
  readonly messages: readonly AiGatewayMessage[];
}

export type AiGatewayFailureCode =
  | "INVALID_REQUEST"
  | "UNAVAILABLE"
  | "UPSTREAM_FAILURE"
  | "MALFORMED_UPSTREAM_RESPONSE";

export interface AiGatewaySuccess {
  readonly status: "SUCCESS";
  readonly text: string;
}

export interface AiGatewayFailure {
  readonly status: "FAILURE";
  readonly error: Readonly<{
    readonly code: AiGatewayFailureCode;
    readonly message: string;
  }>;
}

export type AiGatewayResponse = AiGatewaySuccess | AiGatewayFailure;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

/**
 * Validates the complete public browser request shape. The browser cannot
 * select a provider, model, URL, credential, generation policy, or operation
 * other than the allowlisted grounded-chat operation.
 */
export function parseAiGatewayRequest(value: unknown): AiGatewayRequest | null {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["operation", "messages"])) return null;
  if (value.operation !== AI_GATEWAY_OPERATION || !Array.isArray(value.messages)) return null;
  if (value.messages.length === 0 || value.messages.length > AI_GATEWAY_MAX_MESSAGES) return null;

  let totalChars = 0;
  const messages: AiGatewayMessage[] = [];
  for (const candidate of value.messages) {
    if (!isPlainRecord(candidate) || !hasExactKeys(candidate, ["role", "text"])) return null;
    if (candidate.role !== "user" && candidate.role !== "model") return null;
    if (typeof candidate.text !== "string") return null;
    const text = candidate.text.trim();
    if (text.length === 0 || text.length > AI_GATEWAY_MAX_MESSAGE_CHARS) return null;
    totalChars += text.length;
    if (totalChars > AI_GATEWAY_MAX_TOTAL_MESSAGE_CHARS) return null;
    messages.push(Object.freeze({ role: candidate.role, text }));
  }

  return Object.freeze({
    operation: AI_GATEWAY_OPERATION,
    messages: Object.freeze(messages),
  });
}

export function isAiGatewayResponse(value: unknown): value is AiGatewayResponse {
  if (!isPlainRecord(value)) return false;
  if (value.status === "SUCCESS") {
    return hasExactKeys(value, ["status", "text"]) &&
      typeof value.text === "string" && value.text.trim().length > 0;
  }
  if (value.status !== "FAILURE" || !hasExactKeys(value, ["status", "error"])) return false;
  if (!isPlainRecord(value.error) || !hasExactKeys(value.error, ["code", "message"])) return false;
  return [
    "INVALID_REQUEST",
    "UNAVAILABLE",
    "UPSTREAM_FAILURE",
    "MALFORMED_UPSTREAM_RESPONSE",
  ].includes(String(value.error.code)) && typeof value.error.message === "string";
}
