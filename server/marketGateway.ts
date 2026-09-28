export const MARKET_GATEWAY_UPSTREAM_TIMEOUT_MS = 10_000;
export const MARKET_GATEWAY_MAX_UPSTREAM_BODY_BYTES = 1_048_576;

const BINANCE_ORIGIN = "https://api.binance.com";
const YAHOO_ORIGIN = "https://query1.finance.yahoo.com";
const VNDIRECT_FINFO_ORIGIN = "https://api-finfo.vndirect.com.vn";
const VNDIRECT_DCHART_ORIGIN = "https://dchart-api.vndirect.com.vn";

const BINANCE_SYMBOLS = new Set(["BTCUSDT", "PAXGUSDT"]);
const BINANCE_INTERVALS = new Set(["15m", "1h", "4h", "1d"]);
const BINANCE_LIMITS = new Set([250, 500]);
const YAHOO_SYMBOLS = new Set([
  "BTC-USD",
  "GC=F",
  "DX-Y.NYB",
  "^TNX",
  "2YY=F",
  "^VIX",
  "^VNINDEX",
]);

const FINFO_RESOURCES = new Set(["stocks", "stock_prices", "foreigns"]);
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type MarketGatewayFailureCode =
  | "INVALID_REQUEST"
  | "UPSTREAM_FAILURE"
  | "MALFORMED_UPSTREAM_RESPONSE";

export interface MarketGatewayResult {
  readonly statusCode: number;
  readonly body: unknown;
}

export interface MarketGatewayRequest {
  readonly method: string | undefined;
  readonly pathname: string;
  readonly query: URLSearchParams;
}

export interface MarketGatewayDependencies {
  readonly fetchFn?: typeof fetch;
  readonly upstreamTimeoutMs?: number;
}

function failure(
  statusCode: number,
  code: MarketGatewayFailureCode,
  message: string
): MarketGatewayResult {
  return {
    statusCode,
    body: { status: "FAILURE", error: { code, message } },
  };
}

function success(payload: unknown): MarketGatewayResult {
  return { statusCode: 200, body: payload };
}

function hasOnlyKeys(query: URLSearchParams, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return [...query.keys()].every((key) => allowedSet.has(key));
}

function getSingle(query: URLSearchParams, key: string): string | null {
  const values = query.getAll(key);
  return values.length === 1 ? values[0] : null;
}

function parseBoundedInteger(value: string | null, min: number, max: number): number | null {
  if (!value || !/^(0|[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFinitePositive(value: unknown): boolean {
  if (typeof value !== "string" && typeof value !== "number") return false;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

function isBinancePayload(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every((row) =>
    Array.isArray(row) &&
    row.length >= 6 &&
    isFinitePositive(row[0]) &&
    isFinitePositive(row[1]) &&
    isFinitePositive(row[2]) &&
    isFinitePositive(row[3]) &&
    isFinitePositive(row[4]) &&
    (typeof row[5] === "string" || typeof row[5] === "number") &&
    Number.isFinite(Number(row[5])) &&
    Number(row[5]) >= 0
  );
}

function isYahooPayload(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.chart) || !Array.isArray(value.chart.result)) return false;
  return value.chart.result.length > 0 && value.chart.result.every((result) => isRecord(result));
}

function isFinfoPayload(value: unknown): boolean {
  if (Array.isArray(value)) return true;
  if (!isRecord(value) || !Array.isArray(value.data)) return false;
  if (value.totalPages === undefined) return true;
  return typeof value.totalPages === "number" &&
    Number.isInteger(value.totalPages) &&
    value.totalPages >= 1 &&
    value.totalPages <= 50;
}

function isDchartPayload(value: unknown): boolean {
  if (!isRecord(value) || value.s !== "ok") return false;
  if (!Array.isArray(value.t) || !Array.isArray(value.c) || value.t.length === 0 || value.t.length !== value.c.length) return false;
  return value.t.every((timestamp) => isFinitePositive(timestamp)) &&
    value.c.every((close) => isFinitePositive(close));
}

function validateBinance(query: URLSearchParams): string | null {
  if (!hasOnlyKeys(query, ["symbol", "interval", "limit"])) return null;
  const symbol = getSingle(query, "symbol");
  const interval = getSingle(query, "interval");
  const limit = parseBoundedInteger(getSingle(query, "limit"), 250, 500);
  if (!symbol || !BINANCE_SYMBOLS.has(symbol) || !interval || !BINANCE_INTERVALS.has(interval) || limit === null || !BINANCE_LIMITS.has(limit)) return null;
  return `${BINANCE_ORIGIN}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}`;
}

function validateYahoo(pathname: string, query: URLSearchParams): string | null {
  const symbol = pathname.slice("/api/yahoo/v8/finance/chart/".length);
  if (!YAHOO_SYMBOLS.has(symbol) || !hasOnlyKeys(query, ["interval", "range"])) return null;
  if (getSingle(query, "interval") !== "1d" || getSingle(query, "range") !== "2y") return null;
  return `${YAHOO_ORIGIN}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=2y`;
}

function validateFinfoQuery(resource: string, query: URLSearchParams): string | null {
  const allowedKeys = ["q", "size", "page", "sort"];
  if (!hasOnlyKeys(query, allowedKeys)) return null;

  const filter = getSingle(query, "q");
  const size = parseBoundedInteger(getSingle(query, "size"), 1, 500);
  const page = query.has("page") ? parseBoundedInteger(getSingle(query, "page"), 1, 50) : 1;
  const sort = query.has("sort") ? getSingle(query, "sort") : null;
  if (!filter || size === null || page === null) return null;

  if (resource === "stocks" && (
    filter !== "floor:HOSE~type:STOCK~status:listed" || size !== 500 || sort !== null
  )) return null;

  if (resource === "stock_prices") {
    const validFilter = filter === "floor:HOSE~type:STOCK" ||
      (filter.startsWith("floor:HOSE~type:STOCK~date:") &&
        isValidIsoDate(filter.slice("floor:HOSE~type:STOCK~date:".length)));
    if (!validFilter || (size !== 1 && size !== 500) || (sort !== null && sort !== "date:desc")) return null;
  }

  if (resource === "foreigns" && (
    !filter.startsWith("floor:HOSE~type:STOCK~tradingDate:") ||
    !isValidIsoDate(filter.slice("floor:HOSE~type:STOCK~tradingDate:".length)) ||
    size !== 500 ||
    sort !== null
  )) return null;

  return `${VNDIRECT_FINFO_ORIGIN}/v4/${resource}?${query.toString()}`;
}

function validateDchart(query: URLSearchParams): string | null {
  if (!hasOnlyKeys(query, ["symbol", "resolution"])) return null;
  if (getSingle(query, "symbol") !== "VNINDEX" || getSingle(query, "resolution") !== "D") return null;
  return `${VNDIRECT_DCHART_ORIGIN}/dchart/history?symbol=VNINDEX&resolution=D`;
}

async function readBoundedJson(response: Response): Promise<unknown | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > MARKET_GATEWAY_MAX_UPSTREAM_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  try {
    return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

async function fetchProviderJson(
  upstreamUrl: string,
  dependencies: MarketGatewayDependencies
): Promise<{ kind: "success"; payload: unknown } | { kind: "failure"; result: MarketGatewayResult }> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    dependencies.upstreamTimeoutMs ?? MARKET_GATEWAY_UPSTREAM_TIMEOUT_MS
  );

  try {
    const fetchFn = dependencies.fetchFn ?? globalThis.fetch;
    const response = await fetchFn(upstreamUrl, {
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": "QuantFund-OS" },
      signal: controller.signal,
    });
    if (!response.ok) {
      return { kind: "failure", result: failure(502, "UPSTREAM_FAILURE", "Market data provider request failed.") };
    }
    const payload = await readBoundedJson(response);
    if (payload === null) {
      return { kind: "failure", result: failure(502, "MALFORMED_UPSTREAM_RESPONSE", "Market data provider returned an invalid response.") };
    }
    return { kind: "success", payload };
  } catch {
    return { kind: "failure", result: failure(502, "UPSTREAM_FAILURE", "Market data provider request failed.") };
  } finally {
    clearTimeout(timeout);
  }
}

export async function handleMarketGatewayRequest(
  input: MarketGatewayRequest,
  dependencies: MarketGatewayDependencies = {}
): Promise<MarketGatewayResult | null> {
  const isBinance = input.pathname === "/api/binance/api/v3/klines";
  const isYahoo = input.pathname.startsWith("/api/yahoo/v8/finance/chart/");
  const isFinfo = input.pathname.startsWith("/api/vndirect/finfo/v4/");
  const isDchart = input.pathname === "/api/vndirect/dchart/history";
  if (!isBinance && !isYahoo && !isFinfo && !isDchart) return null;

  if (input.method !== "GET") return failure(405, "INVALID_REQUEST", "Method not allowed.");

  let upstreamUrl: string | null = null;
  let validate: (payload: unknown) => boolean;

  if (isBinance) {
    upstreamUrl = validateBinance(input.query);
    validate = isBinancePayload;
  } else if (isYahoo) {
    upstreamUrl = validateYahoo(input.pathname, input.query);
    validate = isYahooPayload;
  } else if (isFinfo) {
    const resource = input.pathname.slice("/api/vndirect/finfo/v4/".length);
    if (!FINFO_RESOURCES.has(resource)) return failure(404, "INVALID_REQUEST", "Market data route not found.");
    upstreamUrl = validateFinfoQuery(resource, input.query);
    validate = isFinfoPayload;
  } else {
    upstreamUrl = validateDchart(input.query);
    validate = isDchartPayload;
  }

  if (!upstreamUrl) return failure(400, "INVALID_REQUEST", "Market data request is invalid.");

  const upstreamResult = await fetchProviderJson(upstreamUrl, dependencies);
  if (upstreamResult.kind === "failure") return upstreamResult.result;
  if (!validate(upstreamResult.payload)) {
    return failure(502, "MALFORMED_UPSTREAM_RESPONSE", "Market data provider returned an invalid response.");
  }
  return success(upstreamResult.payload);
}
