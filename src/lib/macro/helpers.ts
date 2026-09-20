// ============================================================================
// FILE: src/lib/macro/helpers.ts
// MODULE: MACRO V2 DATA & PROVENANCE HELPERS
// PRINCIPLE: Pure, Deterministic Functions for Datum Creation & Freshness Evaluation
// ============================================================================

import type {
  DerivationMetadata,
  DerivedMacroDatum,
  FreshnessEvaluation,
  HardcodedMacroDatum,
  LiveMacroDatum,
  MacroDataQuality,
  MacroDatum,
  SyntheticMacroDatum,
  UnavailableMacroDatum,
} from "./types";

/**
 * Creates a verified LIVE macro datum.
 */
export function createLiveDatum<T = number>(opts: {
  id: string;
  value: T;
  provider: string;
  instrument: string;
  asOf: number;
  fetchedAt: number;
  quality?: MacroDataQuality;
  basis?: string | null;
}): LiveMacroDatum<T> {
  return {
    status: "AVAILABLE",
    id: opts.id,
    value: opts.value,
    sourceClassification: "LIVE",
    provider: opts.provider,
    instrument: opts.instrument,
    asOf: opts.asOf,
    fetchedAt: opts.fetchedAt,
    quality: opts.quality ?? "USABLE",
    basis: opts.basis ?? null,
    derivation: null,
  };
}

/**
 * Creates a DERIVED macro datum with mandatory derivation metadata.
 */
export function createDerivedDatum<T = number>(opts: {
  id: string;
  value: T;
  provider: string;
  instrument: string;
  asOf: number;
  fetchedAt: number;
  derivation: DerivationMetadata;
  quality?: MacroDataQuality;
  basis?: string | null;
}): DerivedMacroDatum<T> {
  return {
    status: "AVAILABLE",
    id: opts.id,
    value: opts.value,
    sourceClassification: "DERIVED",
    provider: opts.provider,
    instrument: opts.instrument,
    asOf: opts.asOf,
    fetchedAt: opts.fetchedAt,
    quality: opts.quality ?? "USABLE",
    derivation: opts.derivation,
    basis: opts.basis ?? null,
  };
}

/**
 * Creates an explicitly SYNTHETIC macro datum.
 */
export function createSyntheticDatum<T = number>(opts: {
  id: string;
  value: T;
  provider?: string;
  instrument?: string;
  asOf: number;
  fetchedAt: number;
  quality?: MacroDataQuality;
}): SyntheticMacroDatum<T> {
  return {
    status: "AVAILABLE",
    id: opts.id,
    value: opts.value,
    sourceClassification: "SYNTHETIC",
    provider: opts.provider ?? "SyntheticGenerator",
    instrument: opts.instrument ?? opts.id,
    asOf: opts.asOf,
    fetchedAt: opts.fetchedAt,
    quality: opts.quality ?? "DEGRADED",
    derivation: null,
    basis: "SIMULATED",
  };
}

/**
 * Creates a HARDCODED macro datum.
 */
export function createHardcodedDatum<T = number>(opts: {
  id: string;
  value: T;
  provider?: string;
  instrument?: string;
  asOf: number;
  fetchedAt: number;
}): HardcodedMacroDatum<T> {
  return {
    status: "AVAILABLE",
    id: opts.id,
    value: opts.value,
    sourceClassification: "HARDCODED",
    provider: opts.provider ?? "CodeLiteral",
    instrument: opts.instrument ?? opts.id,
    asOf: opts.asOf,
    fetchedAt: opts.fetchedAt,
    quality: "DEGRADED",
    derivation: null,
    basis: "STATIC_CONSTANT",
  };
}

/**
 * Creates a genuinely UNAVAILABLE macro datum without fabricating dummy numeric values.
 */
export function createUnavailableDatum(
  id: string,
  opts?: {
    provider?: string;
    instrument?: string;
    reason?: string | null;
    asOf?: number | null;
    fetchedAt?: number | null;
  }
): UnavailableMacroDatum {
  return {
    status: "UNAVAILABLE",
    id,
    value: null,
    sourceClassification: "UNAVAILABLE",
    provider: opts?.provider ?? "UNKNOWN",
    instrument: opts?.instrument ?? id,
    asOf: opts?.asOf ?? null,
    fetchedAt: opts?.fetchedAt ?? null,
    quality: "UNAVAILABLE",
    reason: opts?.reason ?? "Feed un-fetchable or data missing",
  };
}

/**
 * Deterministically evaluates freshness of a datum against an explicit reference timestamp.
 * Strictly rejects invalid, non-finite, or future timestamps.
 * Hides NO wall-clock Date.now() calls internally.
 */
export function calculateFreshness(
  datum: MacroDatum<unknown>,
  referenceTimeMs: number,
  maxAgeMs: number
): FreshnessEvaluation {
  // Reject non-finite parameters or negative maxAgeMs
  if (
    !Number.isFinite(referenceTimeMs) ||
    !Number.isFinite(maxAgeMs) ||
    maxAgeMs < 0
  ) {
    return {
      ageMs: Number.POSITIVE_INFINITY,
      isStale: true,
      maxAgeMs,
      evaluatedAt: referenceTimeMs,
      quality: "UNAVAILABLE",
    };
  }

  // Reject unavailable status, null asOf, or non-finite asOf
  if (
    datum.status === "UNAVAILABLE" ||
    datum.asOf == null ||
    !Number.isFinite(datum.asOf)
  ) {
    return {
      ageMs: Number.POSITIVE_INFINITY,
      isStale: true,
      maxAgeMs,
      evaluatedAt: referenceTimeMs,
      quality: "UNAVAILABLE",
    };
  }

  // Reject future timestamps (asOf > referenceTimeMs indicates look-ahead or clock skew)
  if (datum.asOf > referenceTimeMs) {
    return {
      ageMs: referenceTimeMs - datum.asOf, // Negative age
      isStale: true,                       // Explicitly stale/invalid!
      maxAgeMs,
      evaluatedAt: referenceTimeMs,
      quality: "STALE",
    };
  }

  const ageMs = referenceTimeMs - datum.asOf;
  const isStale = ageMs > maxAgeMs;

  let quality: MacroDataQuality = datum.quality;
  if (isStale && quality !== "UNAVAILABLE") {
    quality = "STALE";
  }

  return {
    ageMs,
    isStale,
    maxAgeMs,
    evaluatedAt: referenceTimeMs,
    quality,
  };
}

/**
 * Type guard for LIVE provenance.
 */
export function isLiveDatum<T = number>(
  datum: MacroDatum<T>
): datum is LiveMacroDatum<T> {
  return datum.status === "AVAILABLE" && datum.sourceClassification === "LIVE";
}

/**
 * Type guard for DERIVED provenance.
 */
export function isDerivedDatum<T = number>(
  datum: MacroDatum<T>
): datum is DerivedMacroDatum<T> {
  return datum.status === "AVAILABLE" && datum.sourceClassification === "DERIVED";
}

/**
 * Type guard for SYNTHETIC provenance.
 */
export function isSyntheticDatum<T = number>(
  datum: MacroDatum<T>
): datum is SyntheticMacroDatum<T> {
  return datum.status === "AVAILABLE" && datum.sourceClassification === "SYNTHETIC";
}

/**
 * Type guard for HARDCODED provenance.
 */
export function isHardcodedDatum<T = number>(
  datum: MacroDatum<T>
): datum is HardcodedMacroDatum<T> {
  return datum.status === "AVAILABLE" && datum.sourceClassification === "HARDCODED";
}

/**
 * Evaluates whether a datum is usable for quantitative model inputs.
 */
export function isUsableDatum<T = number>(
  datum: MacroDatum<T>,
  referenceTimeMs?: number,
  maxAgeMs?: number
): boolean {
  if (datum.status === "UNAVAILABLE") return false;
  if (datum.quality === "UNAVAILABLE" || datum.quality === "STALE") return false;

  if (referenceTimeMs != null && maxAgeMs != null) {
    const freshness = calculateFreshness(datum, referenceTimeMs, maxAgeMs);
    if (freshness.isStale) return false;
  }

  return datum.quality === "USABLE";
}
