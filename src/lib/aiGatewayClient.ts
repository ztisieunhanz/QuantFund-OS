import {
  AI_GATEWAY_ENDPOINT,
  isAiGatewayResponse,
  type AiGatewayFailureCode,
  type AiGatewayRequest,
} from "./aiGatewayContract";

export interface AiGatewayFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly json: () => Promise<unknown>;
}

export type AiGatewayFetch = (
  input: string,
  init: Readonly<{
    method: "POST";
    headers: Readonly<Record<string, string>>;
    body: string;
  }>
) => Promise<AiGatewayFetchResponse>;

export class AiGatewayClientError extends Error {
  readonly code: AiGatewayFailureCode | "MALFORMED_GATEWAY_RESPONSE";

  constructor(
    code: AiGatewayFailureCode | "MALFORMED_GATEWAY_RESPONSE",
    message: string
  ) {
    super(message);
    this.name = "AiGatewayClientError";
    this.code = code;
  }
}

/** Calls only the application's same-origin AI gateway. No credential is accepted. */
export async function requestAiAdvisor(
  request: AiGatewayRequest,
  fetchFn: AiGatewayFetch = globalThis.fetch
): Promise<string> {
  const response = await fetchFn(AI_GATEWAY_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new AiGatewayClientError(
      "MALFORMED_GATEWAY_RESPONSE",
      "AI gateway returned an unreadable response."
    );
  }

  if (!isAiGatewayResponse(payload)) {
    throw new AiGatewayClientError(
      "MALFORMED_GATEWAY_RESPONSE",
      "AI gateway returned an invalid response."
    );
  }

  if (!response.ok || payload.status === "FAILURE") {
    const failure = payload.status === "FAILURE"
      ? payload.error
      : { code: "UPSTREAM_FAILURE" as const, message: "AI gateway request failed." };
    throw new AiGatewayClientError(failure.code, failure.message);
  }

  return payload.text;
}
