import { describe, expect, it, vi } from "vitest";
import {
  AiGatewayClientError,
  requestAiAdvisor,
  type AiGatewayFetch,
} from "../aiGatewayClient";
import { AI_GATEWAY_ENDPOINT, AI_GATEWAY_OPERATION } from "../aiGatewayContract";

const request = {
  operation: AI_GATEWAY_OPERATION,
  messages: [{ role: "user" as const, text: "Grounded public prompt" }],
};

describe("M15.2A browser AI gateway client", () => {
  it("uses only the same-origin application endpoint and sends the narrow public payload", async () => {
    const fetchFn = vi.fn<AiGatewayFetch>().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: "SUCCESS", text: "Grounded response" }),
    });

    await expect(requestAiAdvisor(request, fetchFn)).resolves.toBe("Grounded response");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledWith(AI_GATEWAY_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    expect(fetchFn.mock.calls[0][0]).toBe("/api/ai-advisor");
    expect(fetchFn.mock.calls[0][0]).not.toContain("googleapis.com");
    expect(fetchFn.mock.calls[0][1].body).not.toContain("apiKey");
    expect(fetchFn.mock.calls[0][1].body).not.toContain("credential");
  });

  it("surfaces the gateway's normalized failure without provider details", async () => {
    const fetchFn = vi.fn<AiGatewayFetch>().mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({
        status: "FAILURE",
        error: { code: "UPSTREAM_FAILURE", message: "AI provider request failed." },
      }),
    });

    const error = await requestAiAdvisor(request, fetchFn).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AiGatewayClientError);
    expect(error).toMatchObject({ code: "UPSTREAM_FAILURE", message: "AI provider request failed." });
  });

  it("rejects malformed gateway responses fail closed", async () => {
    const fetchFn = vi.fn<AiGatewayFetch>().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ secretProviderShape: true }] }),
    });

    await expect(requestAiAdvisor(request, fetchFn)).rejects.toMatchObject({
      code: "MALFORMED_GATEWAY_RESPONSE",
    });
  });
});
