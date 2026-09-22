// ============================================================================
// FILE: src/lib/quant/historicalSources/timezoneUtils.ts
// MODULE: DETERMINISTIC HISTORICAL TIMEZONE CONVERSION UTILITY (GATE M12C-R)
// PRINCIPLE: DST-Aware Conversion to Numeric Unix Epoch ms Without Machine TZ Dependency
// ============================================================================

/**
 * Converts a calendar session date (YYYY-MM-DD) and a local wall-clock time (HH:mm or HH:mm:ss)
 * in an authoritative IANA timezone (default "America/New_York") to a deterministic UTC Unix epoch millisecond timestamp.
 *
 * CRITICAL REQUIREMENTS (Gate M12C-R):
 * 1. Deterministic: identical inputs always produce identical epoch ms.
 * 2. No Date.now().
 * 3. Invariant to machine-local timezone (runs identically on Windows, Linux, macOS regardless of host TZ).
 * 4. Historical DST aware: automatically handles US Eastern Time transitions:
 *    - Standard Time (EST): UTC-5 (e.g. 16:15 EST -> 21:15 UTC, 18:00 EST -> 23:00 UTC).
 *    - Daylight Saving Time (EDT): UTC-4 (e.g. 16:15 EDT -> 20:15 UTC, 18:00 EDT -> 22:00 UTC).
 * 5. Fails closed: invalid date/time formats, non-numeric values, or nonexistent local times throw an Error.
 */
export function marketDateTimeToEpochMs(
  sessionDateStr: string,
  localTimeStr: string,
  timeZone: string = "America/New_York"
): number {
  if (typeof sessionDateStr !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(sessionDateStr.trim())) {
    throw new Error(`Invalid sessionDate format: "${sessionDateStr}". Expected YYYY-MM-DD.`);
  }

  const trimmedTime = (localTimeStr || "").trim();
  if (!/^\d{2}:\d{2}(:\d{2})?$/.test(trimmedTime)) {
    throw new Error(`Invalid localTime format: "${localTimeStr}". Expected HH:mm or HH:mm:ss.`);
  }

  const [yearStr, monthStr, dayStr] = sessionDateStr.trim().split("-");
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);
  const day = parseInt(dayStr, 10);

  if (year < 1970 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`Invalid calendar date values in "${sessionDateStr}".`);
  }

  const timeParts = trimmedTime.split(":").map((p) => parseInt(p, 10));
  const hour = timeParts[0];
  const minute = timeParts[1] ?? 0;
  const second = timeParts[2] ?? 0;

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) {
    throw new Error(`Invalid time values in "${localTimeStr}".`);
  }

  // Use standard Intl.DateTimeFormat with target IANA timeZone and 24-hour cycle.
  // Note: en-US with hourCycle 'h23' ensures midnight is '00' and hours are 00-23.
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

  function getTzOffsetMs(utcEpochMs: number): number {
    const parts = formatter.formatToParts(new Date(utcEpochMs));
    let yr = 0;
    let mo = 0;
    let da = 0;
    let hr = 0;
    let mi = 0;
    let sc = 0;

    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p.type === "year") yr = parseInt(p.value, 10);
      else if (p.type === "month") mo = parseInt(p.value, 10);
      else if (p.type === "day") da = parseInt(p.value, 10);
      else if (p.type === "hour") hr = parseInt(p.value, 10);
      else if (p.type === "minute") mi = parseInt(p.value, 10);
      else if (p.type === "second") sc = parseInt(p.value, 10);
    }

    const asUtcMs = Date.UTC(yr, mo - 1, da, hr, mi, sc);
    return asUtcMs - utcEpochMs;
  }

  // Step 1: Initial naive UTC assumption
  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const offset1 = getTzOffsetMs(naiveUtc);
  let finalUtc = naiveUtc - offset1;

  // Step 2: Refine candidate offset in case naiveUtc falls on opposite side of DST boundary
  const offset2 = getTzOffsetMs(finalUtc);
  if (offset2 !== offset1) {
    finalUtc = naiveUtc - offset2;
  }

  // Step 3: Round-trip verification to fail closed on nonexistent DST gap hours (e.g. 02:30 during spring-forward)
  const checkParts = formatter.formatToParts(new Date(finalUtc));
  let chkYr = 0;
  let chkMo = 0;
  let chkDa = 0;
  let chkHr = 0;
  let chkMi = 0;
  let chkSc = 0;

  for (let i = 0; i < checkParts.length; i++) {
    const p = checkParts[i];
    if (p.type === "year") chkYr = parseInt(p.value, 10);
    else if (p.type === "month") chkMo = parseInt(p.value, 10);
    else if (p.type === "day") chkDa = parseInt(p.value, 10);
    else if (p.type === "hour") chkHr = parseInt(p.value, 10);
    else if (p.type === "minute") chkMi = parseInt(p.value, 10);
    else if (p.type === "second") chkSc = parseInt(p.value, 10);
  }

  if (
    chkYr !== year ||
    chkMo !== month ||
    chkDa !== day ||
    chkHr !== hour ||
    chkMi !== minute ||
    chkSc !== second
  ) {
    throw new Error(
      `Nonexistent or ambiguous local time in ${timeZone}: ${sessionDateStr} ${localTimeStr}`
    );
  }

  return finalUtc;
}

/**
 * Parses calendar date string YYYY-MM-DD to UTC midnight epoch ms.
 */
export function sessionDateToUtcMidnightEpochMs(sessionDateStr: string): number {
  if (typeof sessionDateStr !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(sessionDateStr.trim())) {
    throw new Error(`Invalid sessionDateStr: "${sessionDateStr}". Expected YYYY-MM-DD.`);
  }
  const [y, m, d] = sessionDateStr.trim().split("-").map((s) => parseInt(s, 10));
  const ms = Date.UTC(y, m - 1, d, 0, 0, 0, 0);
  if (!Number.isFinite(ms)) {
    throw new Error(`Failed to compute UTC midnight for date: "${sessionDateStr}".`);
  }
  return ms;
}

/**
 * Extracts session date string (YYYY-MM-DD) from a provider epoch millisecond timestamp,
 * respecting either UTC date anchor or market local date.
 */
export function extractSessionDateStr(
  timestampMs: number,
  timeZone: string = "America/New_York"
): string {
  if (!Number.isFinite(timestampMs)) {
    throw new Error(`Invalid timestampMs: ${timestampMs}. Must be a finite number.`);
  }

  const d = new Date(timestampMs);

  // If timestamp is exactly at UTC midnight, the provider used a UTC calendar anchor
  if (timestampMs % 86_400_000 === 0) {
    const yr = d.getUTCFullYear();
    const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
    const da = String(d.getUTCDate()).padStart(2, "0");
    return `${yr}-${mo}-${da}`;
  }

  // Otherwise, format the timestamp into parts in the target market timeZone
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(d);
  let yr = "";
  let mo = "";
  let da = "";

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.type === "year") yr = p.value;
    else if (p.type === "month") mo = p.value;
    else if (p.type === "day") da = p.value;
  }

  return `${yr}-${mo}-${da}`;
}
