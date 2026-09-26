import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  AI_GATEWAY_MAX_BODY_BYTES,
  AI_GATEWAY_OPERATION,
} from "../../src/lib/aiGatewayContract";
import {
  handleAiGatewayRequest,
  type AiGatewayUpstreamFetch,
} from "../aiGateway";

const SERVER_SECRET_PLACEHOLDER = "server-secret-placeholder";
const validRequest = JSON.stringify({
  operation: AI_GATEWAY_OPERATION,
  messages: [
    { role: "user", text: "Grounded system context" },
    { role: "model", text: "Acknowledged" },
    { role: "user", text: "Summarize current evidence" },
  ],
});

describe("M15.2A server-side AI gateway handler", () => {
  it("returns only the narrow success envelope from an allowlisted upstream request", async () => {
    const fetchFn = vi.fn<AiGatewayUpstreamFetch>().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: "Grounded answer" }] } }],
      }),
    });

    const result = await handleAiGatewayRequest(
      { method: "POST", rawBody: validRequest },
      { apiKey: SERVER_SECRET_PLACEHOLDER, fetchFn }
    );

    expect(result).toEqual({ statusCode: 200, body: { status: "SUCCESS", text: "Grounded answer" } });
    expect(Object.keys(result.body)).toEqual(["status", "text"]);
    expect(JSON.stringify(result)).not.toContain(SERVER_SECRET_PLACEHOLDER);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][0]).toContain("generativelanguage.googleapis.com");
    expect(fetchFn.mock.calls[0][1].headers["x-goog-api-key"]).toBe(SERVER_SECRET_PLACEHOLDER);
    const upstreamBody = JSON.parse(fetchFn.mock.calls[0][1].body);
    expect(upstreamBody.generationConfig).toEqual({ temperature: 0.2 });
    expect(upstreamBody.contents).toHaveLength(3);
  });

  it("rejects malformed JSON, unexpected operations, extra fields, and oversized requests", async () => {
    const dependencies = { apiKey: SERVER_SECRET_PLACEHOLDER };
    const malformed = await handleAiGatewayRequest(
      { method: "POST", rawBody: "{not-json" },
      dependencies
    );
    const unexpectedOperation = await handleAiGatewayRequest(
      { method: "POST", rawBody: JSON.stringify({ operation: "ARBITRARY_PROXY", messages: [] }) },
      dependencies
    );
    const extraField = await handleAiGatewayRequest(
      {
        method: "POST",
        rawBody: JSON.stringify({
          operation: AI_GATEWAY_OPERATION,
          messages: [{ role: "user", text: "hello" }],
          model: "caller-selected-model",
        }),
      },
      dependencies
    );
    const oversized = await handleAiGatewayRequest(
      { method: "POST", rawBody: "", bodyByteLength: AI_GATEWAY_MAX_BODY_BYTES + 1 },
      dependencies
    );

    expect(malformed).toMatchObject({ statusCode: 400, body: { status: "FAILURE", error: { code: "INVALID_REQUEST" } } });
    expect(unexpectedOperation).toMatchObject({ statusCode: 400, body: { status: "FAILURE", error: { code: "INVALID_REQUEST" } } });
    expect(extraField).toMatchObject({ statusCode: 400, body: { status: "FAILURE", error: { code: "INVALID_REQUEST" } } });
    expect(oversized).toMatchObject({ statusCode: 413, body: { status: "FAILURE", error: { code: "INVALID_REQUEST" } } });
  });

  it("keeps missing credentials and upstream failures secret-safe", async () => {
    const missingCredential = await handleAiGatewayRequest(
      { method: "POST", rawBody: validRequest },
      { apiKey: undefined }
    );
    const rejected = await handleAiGatewayRequest(
      { method: "POST", rawBody: validRequest },
      {
        apiKey: SERVER_SECRET_PLACEHOLDER,
        fetchFn: vi.fn<AiGatewayUpstreamFetch>().mockResolvedValue({
          ok: false,
          status: 429,
          json: async () => ({ error: { message: `provider echoed ${SERVER_SECRET_PLACEHOLDER}` } }),
        }),
      }
    );

    expect(missingCredential).toMatchObject({ statusCode: 503, body: { status: "FAILURE", error: { code: "UNAVAILABLE" } } });
    expect(rejected).toMatchObject({ statusCode: 502, body: { status: "FAILURE", error: { code: "UPSTREAM_FAILURE" } } });
    expect(JSON.stringify(missingCredential)).not.toContain(SERVER_SECRET_PLACEHOLDER);
    expect(JSON.stringify(rejected)).not.toContain(SERVER_SECRET_PLACEHOLDER);
  });

  it("normalizes unreadable and structurally invalid upstream responses", async () => {
    const unreadable = await handleAiGatewayRequest(
      { method: "POST", rawBody: validRequest },
      {
        apiKey: SERVER_SECRET_PLACEHOLDER,
        fetchFn: vi.fn<AiGatewayUpstreamFetch>().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => { throw new SyntaxError("bad upstream JSON"); },
        }),
      }
    );
    const invalid = await handleAiGatewayRequest(
      { method: "POST", rawBody: validRequest },
      {
        apiKey: SERVER_SECRET_PLACEHOLDER,
        fetchFn: vi.fn<AiGatewayUpstreamFetch>().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({ candidates: [] }),
        }),
      }
    );

    expect(unreadable).toMatchObject({ body: { status: "FAILURE", error: { code: "MALFORMED_UPSTREAM_RESPONSE" } } });
    expect(invalid).toMatchObject({ body: { status: "FAILURE", error: { code: "MALFORMED_UPSTREAM_RESPONSE" } } });
  });

  it("introduces no economic-authority fields in gateway results", async () => {
    const result = await handleAiGatewayRequest(
      { method: "GET", rawBody: "" },
      { apiKey: SERVER_SECRET_PLACEHOLDER }
    );
    const serialized = JSON.stringify(result);

    for (const forbidden of ["targetWeights", "fills", "ledger", "account", "permission", "riskDecision", "lifecycleTransition", "executablePrice"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe("M15.2A active browser wiring", () => {
  const readSource = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

  it("removes browser credential and direct Gemini ownership from both active AI surfaces", () => {
    for (const path of ["src/components/GlobalChatbot.tsx", "src/views/MacroViewV2.tsx"]) {
      const source = readSource(path);
      expect(source).toContain("requestAiAdvisor");
      expect(source).toContain("AI_GATEWAY_OPERATION");
      expect(source).not.toContain("VITE_GEMINI_API_KEY");
      expect(source).not.toContain("GEMINI_API_KEY");
      expect(source).not.toContain("generativelanguage.googleapis.com");
      expect(source).not.toContain("generateContent");
    }
  });

  it("keeps the credential in the server adapter and out of the shared browser client", () => {
    const viteSource = readSource("vite.config.ts");
    const clientSource = readSource("src/lib/aiGatewayClient.ts");

    expect(viteSource).toContain("env.GEMINI_API_KEY");
    expect(viteSource).not.toContain("env.VITE_GEMINI_API_KEY");
    expect(clientSource).not.toContain("GEMINI_API_KEY");
    expect(clientSource).not.toContain("VITE_GEMINI_API_KEY");
    expect(clientSource).toContain("AI_GATEWAY_ENDPOINT");
  });
});
