// ============================================================================
// FILE: src/lib/quant/historicalPit.ts
// MODULE: POINT-IN-TIME HISTORICAL DATA CONTRACTS & DETERMINISTIC LOOKUP (GATE M12B)
// PRINCIPLE: Truthful Historical Availability Without Lookahead Bias (DEC-001, DEC-005)
// ============================================================================

// ----------------------------------------------------------------------------
// 1. DISCRIMINATED HISTORICAL DATA CONTRACTS
// ----------------------------------------------------------------------------

/**
 * Historical Market Observation (e.g. BTC, DXY, US10Y, US2Y, VIX, Gold, VNINDEX).
 * Represents realized market trade, quote, or settlement observations where revision
 * is nonexistent, but session and bar availability thresholds must be enforced.
 */
export interface HistoricalMarketObservation {
  readonly seriesId: string;                   // Canonical symbol e.g. "BTC", "DXY", "US10Y", "VIX"
  readonly value: number;                      // Numeric market price, index level, or yield
  readonly observationTime: number;            // Timestamp of the underlying bar/session (Unix epoch ms)
  readonly availableAt: number;                // Exact earliest timestamp when knowable in replay (Unix epoch ms)
  readonly providerTimestamp?: number | null;  // Vendor timestamp if reported (Unix epoch ms)
  readonly provider: string;                   // Data vendor e.g. "BINANCE", "YAHOO", "US_TREASURY"
  readonly unit?: string | null;               // e.g. "USD", "INDEX_POINTS", "PERCENT"
}

/**
 * Historical Macroeconomic Release (e.g. CPI, GDP, Non-Farm Payrolls).
 * Represents economic indicator releases subject to publication delays and subsequent
 * historical revisions (vintages).
 */
export interface HistoricalMacroRelease {
  readonly seriesId: string;                   // Canonical series identifier e.g. "US_CPI_YOY", "US_GDP_QOQ"
  readonly observationTime: number;            // Reference period (e.g. end of reference month in epoch ms)
  readonly publishedAt: number;                // Official public dissemination timestamp (Unix epoch ms)
  readonly availableAt: number;                // Earliest timestamp when eligible in replay (Unix epoch ms)
  readonly vintageDate?: string | null;        // Date-level vintage metadata e.g. "2024-02-13" (NOT used as ms timestamp)
  readonly revisionIndex: number;              // 0 = Initial Release, 1 = First Revision, etc. (integer >= 0)
  readonly value: number;                      // Reported macroeconomic figure
  readonly provider: string;                   // Authoritative agency e.g. "BLS", "BEA", "ALFRED"
  readonly unit?: string | null;               // e.g. "PERCENT", "USD_BILLIONS"
}

/**
 * Historical Event / News Release Record.
 * Represents scheduled releases or discrete geopolitical/economic catalysts with
 * optional consensus forecast and surprise tracking.
 */
export interface HistoricalEventRecord {
  readonly eventId: string;                    // Unique canonical identifier e.g. "BLS-CPI-20240213"
  readonly eventType: string;                  // Classification e.g. "US_CPI_REPORT", "FED_RATE_DECISION"
  readonly observationTime: number;            // Reference period or event occurrence timestamp (Unix epoch ms)
  readonly publishedAt: number;                // Official public dissemination timestamp (Unix epoch ms)
  readonly availableAt: number;                // Earliest timestamp when visible in replay (Unix epoch ms)

  readonly actual: number | null;              // Actual reported value (null if unannounced or qualitative)
  readonly consensus: number | null;           // Verified PIT market consensus (null if unavailable - DO NOT GUESS)
  readonly consensusFrozenAt: number | null;   // Cutoff timestamp when consensus was locked (Unix epoch ms)
  readonly previous: number | null;            // Prior period benchmark figure
  readonly surprise: number | null;            // actual - consensus (null if consensus is null)

  readonly provider: string;                   // Official source e.g. "BLS", "FEDERAL_RESERVE"
  readonly sourceQuality: "TIER_1_OFFICIAL" | "TIER_2_BROKER" | "UNVERIFIED";
}

/**
 * Lightweight Historical Dataset Container.
 */
export interface HistoricalDatasetMetadata {
  readonly interval: "1h";
  readonly startTime?: number | null;
  readonly endTime?: number | null;
  readonly sourceIdentifiers?: Readonly<Record<string, string>>;
}

export interface HistoricalDataset {
  readonly marketObservations: readonly HistoricalMarketObservation[];
  readonly macroReleases: readonly HistoricalMacroRelease[];
  readonly eventRecords: readonly HistoricalEventRecord[];
  readonly metadata?: HistoricalDatasetMetadata;
}

// ----------------------------------------------------------------------------
// 2. VALIDATION & ERROR HANDLING (FAIL-CLOSED)
// ----------------------------------------------------------------------------

export class HistoricalDatasetValidationError extends Error {
  constructor(message: string) {
    super(`HistoricalDatasetValidationError: ${message}`);
    this.name = "HistoricalDatasetValidationError";
  }
}

/**
 * Validates a single HistoricalMarketObservation fail-closed.
 */
export function validateHistoricalMarketObservation(obs: HistoricalMarketObservation): void {
  if (!obs.seriesId || typeof obs.seriesId !== "string" || obs.seriesId.trim().length === 0) {
    throw new HistoricalDatasetValidationError("Market observation seriesId must be a non-empty string.");
  }
  if (!Number.isFinite(obs.value)) {
    throw new HistoricalDatasetValidationError(`Market observation "${obs.seriesId}" has non-finite value (${obs.value}).`);
  }
  if (!Number.isFinite(obs.observationTime) || obs.observationTime < 0) {
    throw new HistoricalDatasetValidationError(
      `Market observation "${obs.seriesId}" has invalid observationTime (${obs.observationTime}). Must be a non-negative finite number.`
    );
  }
  if (!Number.isFinite(obs.availableAt) || obs.availableAt < 0) {
    throw new HistoricalDatasetValidationError(
      `Market observation "${obs.seriesId}" has invalid availableAt (${obs.availableAt}). Must be an explicit non-negative finite timestamp.`
    );
  }
  if (obs.availableAt < obs.observationTime) {
    throw new HistoricalDatasetValidationError(
      `Market observation "${obs.seriesId}" has contradictory timestamps: availableAt (${obs.availableAt}) < observationTime (${obs.observationTime}).`
    );
  }
  if (obs.providerTimestamp != null && (!Number.isFinite(obs.providerTimestamp) || obs.providerTimestamp < 0)) {
    throw new HistoricalDatasetValidationError(
      `Market observation "${obs.seriesId}" has invalid providerTimestamp (${obs.providerTimestamp}).`
    );
  }
  if (!obs.provider || typeof obs.provider !== "string" || obs.provider.trim().length === 0) {
    throw new HistoricalDatasetValidationError(`Market observation "${obs.seriesId}" must specify a provider.`);
  }
}

/**
 * Validates a single HistoricalMacroRelease fail-closed.
 */
export function validateHistoricalMacroRelease(rel: HistoricalMacroRelease): void {
  if (!rel.seriesId || typeof rel.seriesId !== "string" || rel.seriesId.trim().length === 0) {
    throw new HistoricalDatasetValidationError("Macro release seriesId must be a non-empty string.");
  }
  if (!Number.isFinite(rel.value)) {
    throw new HistoricalDatasetValidationError(`Macro release "${rel.seriesId}" has non-finite value (${rel.value}).`);
  }
  if (!Number.isFinite(rel.observationTime) || rel.observationTime < 0) {
    throw new HistoricalDatasetValidationError(
      `Macro release "${rel.seriesId}" has invalid observationTime (${rel.observationTime}). Must be a non-negative finite number.`
    );
  }
  if (!Number.isFinite(rel.publishedAt) || rel.publishedAt < 0) {
    throw new HistoricalDatasetValidationError(
      `Macro release "${rel.seriesId}" has invalid publishedAt (${rel.publishedAt}). Must be an explicit non-negative finite timestamp.`
    );
  }
  if (!Number.isFinite(rel.availableAt) || rel.availableAt < 0) {
    throw new HistoricalDatasetValidationError(
      `Macro release "${rel.seriesId}" has invalid availableAt (${rel.availableAt}). Must be an explicit non-negative finite timestamp.`
    );
  }
  if (rel.publishedAt < rel.observationTime) {
    throw new HistoricalDatasetValidationError(
      `Macro release "${rel.seriesId}" has contradictory timestamps: publishedAt (${rel.publishedAt}) < observationTime (${rel.observationTime}).`
    );
  }
  if (rel.availableAt < rel.publishedAt) {
    throw new HistoricalDatasetValidationError(
      `Macro release "${rel.seriesId}" has contradictory timestamps: availableAt (${rel.availableAt}) < publishedAt (${rel.publishedAt}).`
    );
  }
  if (!Number.isInteger(rel.revisionIndex) || rel.revisionIndex < 0) {
    throw new HistoricalDatasetValidationError(
      `Macro release "${rel.seriesId}" has invalid revisionIndex (${rel.revisionIndex}). Must be an integer >= 0.`
    );
  }
  if (!rel.provider || typeof rel.provider !== "string" || rel.provider.trim().length === 0) {
    throw new HistoricalDatasetValidationError(`Macro release "${rel.seriesId}" must specify a provider.`);
  }
}

/**
 * Validates a single HistoricalEventRecord fail-closed.
 */
export function validateHistoricalEvent(ev: HistoricalEventRecord): void {
  if (!ev.eventId || typeof ev.eventId !== "string" || ev.eventId.trim().length === 0) {
    throw new HistoricalDatasetValidationError("Event record eventId must be a non-empty string.");
  }
  if (!ev.eventType || typeof ev.eventType !== "string" || ev.eventType.trim().length === 0) {
    throw new HistoricalDatasetValidationError(`Event "${ev.eventId}" eventType must be a non-empty string.`);
  }
  if (!Number.isFinite(ev.observationTime) || ev.observationTime < 0) {
    throw new HistoricalDatasetValidationError(
      `Event "${ev.eventId}" has invalid observationTime (${ev.observationTime}). Must be a non-negative finite number.`
    );
  }
  if (!Number.isFinite(ev.publishedAt) || ev.publishedAt < 0) {
    throw new HistoricalDatasetValidationError(
      `Event "${ev.eventId}" has invalid publishedAt (${ev.publishedAt}). Must be an explicit non-negative finite timestamp.`
    );
  }
  if (!Number.isFinite(ev.availableAt) || ev.availableAt < 0) {
    throw new HistoricalDatasetValidationError(
      `Event "${ev.eventId}" has invalid availableAt (${ev.availableAt}). Must be an explicit non-negative finite timestamp.`
    );
  }
  if (ev.publishedAt < ev.observationTime) {
    throw new HistoricalDatasetValidationError(
      `Event "${ev.eventId}" has contradictory timestamps: publishedAt (${ev.publishedAt}) < observationTime (${ev.observationTime}).`
    );
  }
  if (ev.availableAt < ev.publishedAt) {
    throw new HistoricalDatasetValidationError(
      `Event "${ev.eventId}" has contradictory timestamps: availableAt (${ev.availableAt}) < publishedAt (${ev.publishedAt}).`
    );
  }

  // Surprise and Consensus Integrity (CORRECTION B: Never fabricate or mismatch surprise)
  if (ev.surprise !== null) {
    if (ev.actual === null || !Number.isFinite(ev.actual)) {
      throw new HistoricalDatasetValidationError(
        `Event "${ev.eventId}" defines surprise (${ev.surprise}) but actual is null or non-finite.`
      );
    }
    if (ev.consensus === null || !Number.isFinite(ev.consensus)) {
      throw new HistoricalDatasetValidationError(
        `Event "${ev.eventId}" defines surprise (${ev.surprise}) but consensus is null or non-finite.`
      );
    }
    if (ev.consensusFrozenAt === null || !Number.isFinite(ev.consensusFrozenAt) || ev.consensusFrozenAt < 0) {
      throw new HistoricalDatasetValidationError(
        `Event "${ev.eventId}" defines surprise (${ev.surprise}) but consensusFrozenAt is missing or invalid.`
      );
    }
    if (ev.consensusFrozenAt > ev.publishedAt) {
      throw new HistoricalDatasetValidationError(
        `Event "${ev.eventId}" has consensusFrozenAt (${ev.consensusFrozenAt}) > publishedAt (${ev.publishedAt}). Lookahead violation.`
      );
    }
    const expectedSurprise = ev.actual - ev.consensus;
    if (Math.abs(ev.surprise - expectedSurprise) > 1e-4) {
      throw new HistoricalDatasetValidationError(
        `Event "${ev.eventId}" surprise mismatch: provided ${ev.surprise}, expected (actual - consensus) = ${expectedSurprise}.`
      );
    }
  } else {
    // If surprise is null, consensusFrozenAt should not claim an unverified freeze timestamp
    if (ev.consensus === null && ev.consensusFrozenAt !== null) {
      throw new HistoricalDatasetValidationError(
        `Event "${ev.eventId}" has consensusFrozenAt (${ev.consensusFrozenAt}) but consensus is null.`
      );
    }
  }

  if (!ev.provider || typeof ev.provider !== "string" || ev.provider.trim().length === 0) {
    throw new HistoricalDatasetValidationError(`Event "${ev.eventId}" must specify a provider.`);
  }
}

/**
 * Validates an entire HistoricalDataset fail-closed, verifying all entries and rejecting
 * conflicting duplicate canonical records.
 */
export function validateHistoricalDataset(dataset: HistoricalDataset): { valid: true } {
  // 1. Validate Market Observations
  const marketSeen = new Map<string, HistoricalMarketObservation>();
  for (const obs of dataset.marketObservations) {
    validateHistoricalMarketObservation(obs);
    const key = `${obs.seriesId}|${obs.observationTime}|${obs.availableAt}`;
    const existing = marketSeen.get(key);
    if (existing) {
      if (existing.value !== obs.value || existing.provider !== obs.provider) {
        throw new HistoricalDatasetValidationError(
          `Conflicting duplicate market observation found for "${obs.seriesId}" at availableAt ${obs.availableAt} (values: ${existing.value} vs ${obs.value}).`
        );
      }
    } else {
      marketSeen.set(key, obs);
    }
  }

  // 2. Validate Macro Releases
  const macroSeen = new Map<string, HistoricalMacroRelease>();
  for (const rel of dataset.macroReleases) {
    validateHistoricalMacroRelease(rel);
    const key = `${rel.seriesId}|${rel.observationTime}|${rel.revisionIndex}|${rel.availableAt}`;
    const existing = macroSeen.get(key);
    if (existing) {
      if (existing.value !== rel.value || existing.publishedAt !== rel.publishedAt) {
        throw new HistoricalDatasetValidationError(
          `Conflicting duplicate macro release found for "${rel.seriesId}" at observationTime ${rel.observationTime}, revision ${rel.revisionIndex} (values: ${existing.value} vs ${rel.value}).`
        );
      }
    } else {
      macroSeen.set(key, rel);
    }
  }

  // 3. Validate Event Records
  const eventSeen = new Map<string, HistoricalEventRecord>();
  for (const ev of dataset.eventRecords) {
    validateHistoricalEvent(ev);
    const existing = eventSeen.get(ev.eventId);
    if (existing) {
      const isIdentical =
        existing.eventType === ev.eventType &&
        existing.observationTime === ev.observationTime &&
        existing.publishedAt === ev.publishedAt &&
        existing.availableAt === ev.availableAt &&
        existing.actual === ev.actual &&
        existing.consensus === ev.consensus &&
        existing.surprise === ev.surprise &&
        existing.consensusFrozenAt === ev.consensusFrozenAt;
      if (!isIdentical) {
        throw new HistoricalDatasetValidationError(
          `Conflicting duplicate event found for eventId "${ev.eventId}".`
        );
      }
    } else {
      eventSeen.set(ev.eventId, ev);
    }
  }

  return { valid: true };
}

// ----------------------------------------------------------------------------
// 3. DETERMINISTIC SORTING & NORMALIZATION
// ----------------------------------------------------------------------------

/**
 * Deterministically sorts and normalizes dataset arrays so insertion order does not
 * alter downstream lookup results. Deduplicates identical records.
 */
export function normalizeHistoricalDataset(dataset: HistoricalDataset): HistoricalDataset {
  validateHistoricalDataset(dataset);

  // 1. Normalize market observations
  const marketMap = new Map<string, HistoricalMarketObservation>();
  for (const obs of dataset.marketObservations) {
    const key = `${obs.seriesId}|${obs.observationTime}|${obs.availableAt}|${obs.value}|${obs.provider}`;
    if (!marketMap.has(key)) {
      marketMap.set(key, obs);
    }
  }
  const sortedMarket = Array.from(marketMap.values()).sort((a, b) => {
    if (a.seriesId !== b.seriesId) return a.seriesId.localeCompare(b.seriesId);
    if (a.availableAt !== b.availableAt) return a.availableAt - b.availableAt;
    if (a.observationTime !== b.observationTime) return a.observationTime - b.observationTime;
    return a.provider.localeCompare(b.provider);
  });

  // 2. Normalize macro releases
  const macroMap = new Map<string, HistoricalMacroRelease>();
  for (const rel of dataset.macroReleases) {
    const key = `${rel.seriesId}|${rel.observationTime}|${rel.revisionIndex}|${rel.availableAt}|${rel.value}|${rel.publishedAt}`;
    if (!macroMap.has(key)) {
      macroMap.set(key, rel);
    }
  }
  const sortedMacro = Array.from(macroMap.values()).sort((a, b) => {
    if (a.seriesId !== b.seriesId) return a.seriesId.localeCompare(b.seriesId);
    if (a.observationTime !== b.observationTime) return a.observationTime - b.observationTime;
    if (a.revisionIndex !== b.revisionIndex) return a.revisionIndex - b.revisionIndex;
    if (a.availableAt !== b.availableAt) return a.availableAt - b.availableAt;
    return a.publishedAt - b.publishedAt;
  });

  // 3. Normalize event records
  const eventMap = new Map<string, HistoricalEventRecord>();
  for (const ev of dataset.eventRecords) {
    if (!eventMap.has(ev.eventId)) {
      eventMap.set(ev.eventId, ev);
    }
  }
  const sortedEvents = Array.from(eventMap.values()).sort((a, b) => {
    if (a.availableAt !== b.availableAt) return a.availableAt - b.availableAt;
    if (a.publishedAt !== b.publishedAt) return a.publishedAt - b.publishedAt;
    if (a.observationTime !== b.observationTime) return a.observationTime - b.observationTime;
    return a.eventId.localeCompare(b.eventId);
  });

  return {
    marketObservations: sortedMarket,
    macroReleases: sortedMacro,
    eventRecords: sortedEvents,
    metadata: dataset.metadata,
  };
}

// ----------------------------------------------------------------------------
// 4. PURE POINT-IN-TIME LOOKUP PRIMITIVES
// ----------------------------------------------------------------------------

/**
 * Looks up the latest eligible market observation for seriesId at decisionTime.
 *
 * Invariant: availableAt <= decisionTime.
 * Never interpolates from future.
 * Never backfills unavailable future data into earlier decisions.
 */
export function latestEligibleMarketObservation(
  timeline: readonly HistoricalMarketObservation[] | undefined | null,
  seriesId: string,
  decisionTime: number
): HistoricalMarketObservation | null {
  if (!timeline || timeline.length === 0 || !Number.isFinite(decisionTime)) {
    return null;
  }

  let best: HistoricalMarketObservation | null = null;

  for (const obs of timeline) {
    if (obs.seriesId !== seriesId) continue;
    if (obs.availableAt > decisionTime) continue; // Future data invisible

    if (!best) {
      best = obs;
      continue;
    }

    // Select latest available observation
    if (obs.availableAt > best.availableAt) {
      best = obs;
    } else if (obs.availableAt === best.availableAt) {
      // Tie-breaker: higher observationTime
      if (obs.observationTime > best.observationTime) {
        best = obs;
      } else if (obs.observationTime === best.observationTime) {
        // Deterministic stable provider tie-breaker
        if (obs.provider.localeCompare(best.provider) > 0) {
          best = obs;
        }
      }
    }
  }

  return best;
}

/**
 * Looks up the latest eligible macroeconomic vintage for a SPECIFIC observation period.
 *
 * Invariant: availableAt <= decisionTime.
 * If multiple revisions exist for this observation period <= decisionTime,
 * selects the latest vintage knowable at decisionTime.
 */
export function latestEligibleVintage(
  timeline: readonly HistoricalMacroRelease[] | undefined | null,
  seriesId: string,
  observationTime: number,
  decisionTime: number
): HistoricalMacroRelease | null {
  if (!timeline || timeline.length === 0 || !Number.isFinite(decisionTime) || !Number.isFinite(observationTime)) {
    return null;
  }

  let bestVintage: HistoricalMacroRelease | null = null;

  for (const rel of timeline) {
    if (rel.seriesId !== seriesId) continue;
    if (rel.observationTime !== observationTime) continue;
    if (rel.availableAt > decisionTime) continue; // Future vintage invisible

    if (!bestVintage) {
      bestVintage = rel;
      continue;
    }

    // Select latest available revision
    if (rel.availableAt > bestVintage.availableAt) {
      bestVintage = rel;
    } else if (rel.availableAt === bestVintage.availableAt) {
      if (rel.revisionIndex > bestVintage.revisionIndex) {
        bestVintage = rel;
      }
    }
  }

  return bestVintage;
}

/**
 * Looks up the latest knowable macroeconomic release for seriesId at decisionTime.
 *
 * Revision & Observation Selection Algorithm:
 * 1. Collect all records for seriesId with availableAt <= decisionTime.
 * 2. For each unique observation period, select the latest vintage with availableAt <= decisionTime.
 * 3. From the vintage-filtered subset, select the record with the most recent observationTime.
 *
 * Guarantees: A future revision does not replace an earlier vintage during backtest,
 * and future observation periods are never seen early.
 */
export function latestEligibleMacroRelease(
  timeline: readonly HistoricalMacroRelease[] | undefined | null,
  seriesId: string,
  decisionTime: number
): HistoricalMacroRelease | null {
  if (!timeline || timeline.length === 0 || !Number.isFinite(decisionTime)) {
    return null;
  }

  // 1. Group eligible records by observationTime
  const eligibleByObservation = new Map<number, HistoricalMacroRelease>();

  for (const rel of timeline) {
    if (rel.seriesId !== seriesId) continue;
    if (rel.availableAt > decisionTime) continue; // Future release invisible

    const currentBest = eligibleByObservation.get(rel.observationTime);
    if (!currentBest) {
      eligibleByObservation.set(rel.observationTime, rel);
      continue;
    }

    // Select latest revision for this observation period known by decisionTime
    if (rel.availableAt > currentBest.availableAt) {
      eligibleByObservation.set(rel.observationTime, rel);
    } else if (rel.availableAt === currentBest.availableAt && rel.revisionIndex > currentBest.revisionIndex) {
      eligibleByObservation.set(rel.observationTime, rel);
    }
  }

  if (eligibleByObservation.size === 0) {
    return null;
  }

  // 2. Select the latest observation period known
  let latestObservationTime = -1;
  let latestRelease: HistoricalMacroRelease | null = null;

  for (const [obsTime, rel] of eligibleByObservation.entries()) {
    if (obsTime > latestObservationTime) {
      latestObservationTime = obsTime;
      latestRelease = rel;
    }
  }

  return latestRelease;
}

/**
 * Checks whether an event satisfies the strict requirements to generate quant event alpha.
 *
 * Invariant (CORRECTION B):
 * - Must be publicly available at decisionTime
 * - Must have verified actual AND verified consensus
 * - Must have consensusFrozenAt <= publishedAt
 * - Must have surprise == actual - consensus
 *
 * An event missing consensus is visible as historical information but returns FALSE here,
 * preventing EventReaction from manufacturing fabricated signals.
 */
export function isEventReactionEligible(
  event: HistoricalEventRecord | null | undefined,
  decisionTime: number
): boolean {
  if (!event) return false;
  if (!Number.isFinite(decisionTime) || event.availableAt > decisionTime) return false;

  if (event.actual === null || event.consensus === null || event.surprise === null || event.consensusFrozenAt === null) {
    return false;
  }

  if (!Number.isFinite(event.actual) || !Number.isFinite(event.consensus)) return false;
  if (!Number.isFinite(event.surprise) || !Number.isFinite(event.consensusFrozenAt)) return false;

  if (event.consensusFrozenAt > event.publishedAt) return false;
  if (event.publishedAt > event.availableAt) return false;

  return true;
}

/**
 * Retrieves all historical events whose availability falls within an explicit time window [windowStart, windowEnd].
 *
 * Invariant:
 * - Window filtering evaluates event.availableAt, NEVER event.observationTime.
 * - Both bounds are inclusive: windowStart <= event.availableAt && event.availableAt <= windowEnd.
 */
export function getEligibleEventsInWindow(
  timeline: readonly HistoricalEventRecord[] | undefined | null,
  windowStart: number,
  windowEnd: number
): readonly HistoricalEventRecord[] {
  if (!timeline || timeline.length === 0 || !Number.isFinite(windowStart) || !Number.isFinite(windowEnd)) {
    return [];
  }

  const matches: HistoricalEventRecord[] = [];

  for (const ev of timeline) {
    if (ev.availableAt >= windowStart && ev.availableAt <= windowEnd) {
      matches.push(ev);
    }
  }

  return matches.sort((a, b) => {
    if (a.availableAt !== b.availableAt) return a.availableAt - b.availableAt;
    if (a.publishedAt !== b.publishedAt) return a.publishedAt - b.publishedAt;
    return a.eventId.localeCompare(b.eventId);
  });
}

/**
 * Looks up the single latest eligible historical event at decisionTime.
 * Optional maxLookbackMs parameter bounds how far in the past the event can have occurred.
 */
export function latestEligibleEvent(
  timeline: readonly HistoricalEventRecord[] | undefined | null,
  decisionTime: number,
  maxLookbackMs?: number
): HistoricalEventRecord | null {
  if (!timeline || timeline.length === 0 || !Number.isFinite(decisionTime)) {
    return null;
  }

  const minAvailableAt = maxLookbackMs != null ? decisionTime - maxLookbackMs : -Infinity;
  let best: HistoricalEventRecord | null = null;

  for (const ev of timeline) {
    if (ev.availableAt > decisionTime) continue; // Future event invisible
    if (ev.availableAt < minAvailableAt) continue; // Expired event

    if (!best) {
      best = ev;
      continue;
    }

    if (ev.availableAt > best.availableAt) {
      best = ev;
    } else if (ev.availableAt === best.availableAt) {
      if (ev.publishedAt > best.publishedAt) {
        best = ev;
      } else if (ev.publishedAt === best.publishedAt) {
        if (ev.eventId.localeCompare(best.eventId) > 0) {
          best = ev;
        }
      }
    }
  }

  return best;
}
