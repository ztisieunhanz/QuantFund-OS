// ============================================================================
// FILE: src/lib/macro/vndirectClient.ts
// MODULE: VNDIRECT LAYER 1 TRANSPORT CLIENT & GATEWAY CONTRACT (GATE M6E-2)
// PRINCIPLE: Same-Origin Gateway Transport Boundary & Bounded Pagination (DEC-014)
// ============================================================================

/**
 * Transport safety limit to protect against infinite HTTP loops or broken provider metadata.
 * Does NOT define market universe eligibility or financial semantics.
 */
export const MAX_TRANSPORT_PAGINATION_PAGES = 50;

/**
 * Explicit transport error classification for downstream adapter handling.
 */
export type VndirectTransportErrorCode =
  | "HTTP_ERROR"
  | "NETWORK_ERROR"
  | "MALFORMED_JSON"
  | "INVALID_PAGINATION"
  | "PAGINATION_GUARD_EXCEEDED";

export interface VndirectTransportError {
  readonly success: false;
  readonly code: VndirectTransportErrorCode;
  readonly message: string;
  readonly statusCode?: number;
  readonly url?: string;
}

export interface VndirectTransportSuccess<T> {
  readonly success: true;
  readonly data: T;
  readonly url: string;
}

export type VndirectTransportResult<T> =
  | VndirectTransportSuccess<T>
  | VndirectTransportError;

interface FinfoPaginatedResponse<T> {
  readonly data?: T[];
  readonly currentPage?: number;
  readonly size?: number;
  readonly totalElements?: number;
  readonly totalPages?: number;
}

/**
 * Same-origin transport endpoint paths.
 * The browser client MUST NEVER call external VNDirect domains directly.
 */
const VNDIRECT_FINFO_BASE_PATH = "/api/vndirect/finfo";
const VNDIRECT_DCHART_BASE_PATH = "/api/vndirect/dchart";

function buildUrl(basePath: string, pathAndQuery: string): string {
  const cleanPath = pathAndQuery.startsWith("/") ? pathAndQuery : `/${pathAndQuery}`;
  return `${basePath}${cleanPath}`;
}

/**
 * Executes a single same-origin HTTP GET request to the FINfo gateway.
 */
export async function fetchVndirectFinfo<T>(
  pathAndQuery: string
): Promise<VndirectTransportResult<T>> {
  const url = buildUrl(VNDIRECT_FINFO_BASE_PATH, pathAndQuery);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      return {
        success: false,
        code: "HTTP_ERROR",
        message: `FINfo HTTP ${response.status}: ${response.statusText}`,
        statusCode: response.status,
        url,
      };
    }

    try {
      const data = (await response.json()) as T;
      return { success: true, data, url };
    } catch {
      return {
        success: false,
        code: "MALFORMED_JSON",
        message: `FINfo response from ${url} contained malformed JSON`,
        statusCode: response.status,
        url,
      };
    }
  } catch (err: unknown) {
    return {
      success: false,
      code: "NETWORK_ERROR",
      message: `FINfo network request failed for ${url}: ${err instanceof Error ? err.message : String(err)}`,
      url,
    };
  }
}

/**
 * Executes a single same-origin HTTP GET request to the DChart gateway.
 */
export async function fetchVndirectDchart<T>(
  pathAndQuery: string
): Promise<VndirectTransportResult<T>> {
  const url = buildUrl(VNDIRECT_DCHART_BASE_PATH, pathAndQuery);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      return {
        success: false,
        code: "HTTP_ERROR",
        message: `DChart HTTP ${response.status}: ${response.statusText}`,
        statusCode: response.status,
        url,
      };
    }

    try {
      const data = (await response.json()) as T;
      return { success: true, data, url };
    } catch {
      return {
        success: false,
        code: "MALFORMED_JSON",
        message: `DChart response from ${url} contained malformed JSON`,
        statusCode: response.status,
        url,
      };
    }
  } catch (err: unknown) {
    return {
      success: false,
      code: "NETWORK_ERROR",
      message: `DChart network request failed for ${url}: ${err instanceof Error ? err.message : String(err)}`,
      url,
    };
  }
}

/**
 * Appends or replaces a pagination query parameter (e.g. page=N, size=M) on a URL path.
 */
function updateUrlQueryParam(pathAndQuery: string, key: string, value: string | number): string {
  const [base, queryStr] = pathAndQuery.split("?");
  const params = new URLSearchParams(queryStr || "");
  params.set(key, String(value));
  return `${base}?${params.toString()}`;
}

/**
 * Bounded pagination helper for FINfo responses.
 * Retrieves all pages specified by totalPages metadata.
 * Fails closed immediately if any page fails or if totalPages exceeds safety guard.
 */
export async function fetchPaginatedVndirectFinfo<T>(
  pathAndQuery: string
): Promise<VndirectTransportResult<T[]>> {
  // Page 1 initial fetch
  const initialUrl = updateUrlQueryParam(pathAndQuery, "page", 1);
  const firstResult = await fetchVndirectFinfo<FinfoPaginatedResponse<T>>(initialUrl);

  if (!firstResult.success) {
    return firstResult;
  }

  const payload = firstResult.data;

  if (!payload || !Array.isArray(payload.data)) {
    return {
      success: false,
      code: "MALFORMED_JSON",
      message: `Paginated FINfo payload missing 'data' array on ${firstResult.url}`,
      url: firstResult.url,
    };
  }

  const totalPages = payload.totalPages;

  if (
    typeof totalPages !== "number" ||
    !Number.isFinite(totalPages) ||
    totalPages < 1 ||
    !Number.isInteger(totalPages)
  ) {
    return {
      success: false,
      code: "INVALID_PAGINATION",
      message: `Invalid or non-integer 'totalPages' (${String(totalPages)}) on ${firstResult.url}`,
      url: firstResult.url,
    };
  }

  if (totalPages > MAX_TRANSPORT_PAGINATION_PAGES) {
    return {
      success: false,
      code: "PAGINATION_GUARD_EXCEEDED",
      message: `Provider totalPages (${totalPages}) exceeds transport safety guard cap (${MAX_TRANSPORT_PAGINATION_PAGES}) on ${firstResult.url}`,
      url: firstResult.url,
    };
  }

  const accumulatedRows: T[] = [...payload.data];

  // Fetch subsequent pages 2..totalPages if multi-page
  for (let page = 2; page <= totalPages; page++) {
    const pageUrl = updateUrlQueryParam(pathAndQuery, "page", page);
    const pageResult = await fetchVndirectFinfo<FinfoPaginatedResponse<T>>(pageUrl);

    if (!pageResult.success) {
      // Fail closed immediately on any single page failure. NEVER return partial rows.
      return pageResult;
    }

    const pagePayload = pageResult.data;
    if (!pagePayload || !Array.isArray(pagePayload.data)) {
      return {
        success: false,
        code: "MALFORMED_JSON",
        message: `Paginated FINfo payload missing 'data' array on page ${page} (${pageResult.url})`,
        url: pageResult.url,
      };
    }

    accumulatedRows.push(...pagePayload.data);
  }

  return {
    success: true,
    data: accumulatedRows,
    url: firstResult.url,
  };
}
