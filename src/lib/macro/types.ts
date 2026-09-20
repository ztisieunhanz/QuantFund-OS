// ============================================================================
// FILE: src/lib/macro/types.ts
// MODULE: MACRO V2 DATA & PROVENANCE CONTRACT FOUNDATION
// PRINCIPLE: Truthful Data Provenance & Explicit Quality Gating (DEC-005, DEC-010)
// ============================================================================

/**
 * Explicit provenance classification for macro and market data.
 * - LIVE: Directly fetched from an authoritative external/current market source.
 * - DERIVED: Calculated from other primary data inputs (must specify derivation metadata).
 * - SYNTHETIC: Generated via PRNG, fallback simulation, or mock formula.
 * - HARDCODED: Static literal value embedded in codebase.
 * - UNAVAILABLE: Genuinely missing data; no fake numeric value supplied.
 */
export type MacroProvenanceClassification =
  | "LIVE"
  | "DERIVED"
  | "SYNTHETIC"
  | "HARDCODED"
  | "UNAVAILABLE";

/**
 * Quality and availability status of a market datum.
 * - USABLE: Data is fresh, valid, and suitable for quantitative regime scoring.
 * - DEGRADED: Data is present but marked with reduced confidence or non-standard basis.
 * - STALE: Data age exceeds the specified maximum threshold or has invalid timing.
 * - UNAVAILABLE: Data is missing or un-fetchable.
 */
export type MacroDataQuality =
  | "USABLE"
  | "DEGRADED"
  | "STALE"
  | "UNAVAILABLE";

/**
 * Metadata documenting how a DERIVED datum was constructed.
 */
export interface DerivationMetadata {
  readonly method: string;
  readonly parentIds: readonly string[];
  readonly parameters?: Readonly<Record<string, number | string | boolean>> | null;
}

/**
 * Base available datum attributes common across all available data classifications.
 */
export interface BaseAvailableMacroDatum<T = number> {
  readonly status: "AVAILABLE";
  readonly id: string;
  readonly value: T;
  readonly provider: string;      // e.g. "Yahoo", "Binance", "LocalFormula"
  readonly instrument: string;    // e.g. "^VIX", "BTCUSDT", "2YY=F"
  readonly asOf: number;          // Source timestamp (Unix epoch ms)
  readonly fetchedAt: number;     // System ingestion timestamp (Unix epoch ms)
  readonly quality: MacroDataQuality;
  readonly basis?: string | null; // e.g. "PAXG_TOKEN", "SPOT_INDEX", "FUTURES_CONTINUOUS"
}

/**
 * Available LIVE datum — directly from exchange/feed.
 */
export interface LiveMacroDatum<T = number> extends BaseAvailableMacroDatum<T> {
  readonly sourceClassification: "LIVE";
  readonly derivation?: null;
}

/**
 * Available DERIVED datum — strictly REQUIRES DerivationMetadata at type level.
 */
export interface DerivedMacroDatum<T = number> extends BaseAvailableMacroDatum<T> {
  readonly sourceClassification: "DERIVED";
  readonly derivation: DerivationMetadata; // MANDATORY at type level
}

/**
 * Available SYNTHETIC datum — explicitly marked PRNG/simulated.
 */
export interface SyntheticMacroDatum<T = number> extends BaseAvailableMacroDatum<T> {
  readonly sourceClassification: "SYNTHETIC";
  readonly derivation?: null;
}

/**
 * Available HARDCODED datum — static literal constant.
 */
export interface HardcodedMacroDatum<T = number> extends BaseAvailableMacroDatum<T> {
  readonly sourceClassification: "HARDCODED";
  readonly derivation?: null;
}

/**
 * Discriminated union of all available macro data classifications.
 */
export type AvailableMacroDatum<T = number> =
  | LiveMacroDatum<T>
  | DerivedMacroDatum<T>
  | SyntheticMacroDatum<T>
  | HardcodedMacroDatum<T>;

/**
 * Represents a genuinely unavailable macro datum without fabricating a dummy numeric value.
 */
export interface UnavailableMacroDatum {
  readonly status: "UNAVAILABLE";
  readonly id: string;
  readonly value: null;
  readonly sourceClassification: "UNAVAILABLE";
  readonly provider: string;
  readonly instrument: string;
  readonly asOf?: number | null;
  readonly fetchedAt?: number | null;
  readonly quality: "UNAVAILABLE";
  readonly reason?: string | null;
}

/**
 * Discriminated union representing any macro datum state.
 */
export type MacroDatum<T = number> = AvailableMacroDatum<T> | UnavailableMacroDatum;

/**
 * Standard identifiers for core Macro V2 universe metrics.
 */
export type MacroMetricId =
  | "dxy"
  | "us2y"
  | "us10y"
  | "vix"
  | "gold"
  | "btc"
  | "vnindex"
  | "breadth"
  | "liquidity"
  | "foreignFlow";

/**
 * Structured Vietnam market internal metrics.
 */
export interface VietnamBreadthData {
  readonly advancing: number;
  readonly declining: number;
  readonly unchanged: number;
  readonly adRatio: number;
  readonly pctAboveMA20: number;
  readonly pctAboveMA50: number;
  readonly pctAboveMA200: number;
}

export interface VietnamLiquidityData {
  readonly matchingValueBillion: number;
  readonly ma20ValueBillion: number;
  readonly ratioToMa20: number;
  readonly status: "EXPANDING" | "CONTRACTING" | "NORMAL";
}

export interface VietnamForeignFlowData {
  readonly net1dBillion: number;
  readonly net5dBillion: number;
  readonly status: "NET_BUYING" | "NET_SELLING" | "NEUTRAL";
}

/**
 * Layer 1 DATA section of CurrentMarketSnapshot (DEC-010).
 */
export interface MarketSnapshotData {
  readonly dxy: MacroDatum<number>;
  readonly us2y: MacroDatum<number>;
  readonly us10y: MacroDatum<number>;
  readonly vix: MacroDatum<number>;
  readonly gold: MacroDatum<number>;
  readonly btc: MacroDatum<number>;
  readonly vnindex: MacroDatum<number>;
  readonly breadth: MacroDatum<VietnamBreadthData>;
  readonly liquidity: MacroDatum<VietnamLiquidityData>;
  readonly foreignFlow: MacroDatum<VietnamForeignFlowData>;
  readonly customMetrics?: Readonly<Record<string, MacroDatum<unknown>>> | null;
}

/**
 * Explicit placeholders for future Macro V2 layers (DEC-010 / DEC-012).
 * These types allow CurrentMarketSnapshot to be typed without fabricating model outputs.
 */
export interface MarketSnapshotMacroPlaceholder {
  readonly status: "NOT_IMPLEMENTED";
  readonly note: string;
}

export interface MarketSnapshotQuantPlaceholder {
  readonly status: "NOT_IMPLEMENTED";
  readonly note: string;
}

export interface MarketSnapshotSynthesisPlaceholder {
  readonly status: "NOT_IMPLEMENTED";
  readonly note: string;
}

/**
 * Foundation contract for CurrentMarketSnapshot (DEC-010).
 * Holds typed observed DATA in M1B-1, with explicit placeholders for M2-M4 layers.
 */
export interface CurrentMarketSnapshot {
  readonly timestamp: number;
  readonly data: MarketSnapshotData;
  readonly macro?: MarketSnapshotMacroPlaceholder | null;
  readonly quant?: MarketSnapshotQuantPlaceholder | null;
  readonly synthesis?: MarketSnapshotSynthesisPlaceholder | null;
}

/**
 * Evaluation report returned by freshness calculation helpers.
 */
export interface FreshnessEvaluation {
  readonly ageMs: number;
  readonly isStale: boolean;
  readonly maxAgeMs: number;
  readonly evaluatedAt: number;
  readonly quality: MacroDataQuality;
}
