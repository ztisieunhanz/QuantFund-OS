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
  readonly adRatio: number | null;
  readonly pctAboveMA20: number | null;
  readonly pctAboveMA50: number | null;
  readonly pctAboveMA200: number | null;
}

export interface VietnamLiquidityData {
  readonly matchingValueBillion: number;
  readonly ma20ValueBillion: number;
  readonly ratioToMa20: number;
  readonly status: "EXPANDING" | "CONTRACTING" | "NORMAL" | null;
}

export interface VietnamForeignFlowData {
  readonly net1dBillion: number;
  readonly net5dBillion: number;
  readonly status: "NET_BUYING" | "NET_SELLING" | "NEUTRAL" | null;
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

// ----------------------------------------------------------------------------
// LAYER 2 - MACRO INTERPRETATION & ASSESSMENT TYPES (GATE M2)
// ----------------------------------------------------------------------------

export type MacroAssessmentStatus = "AVAILABLE" | "INSUFFICIENT_DATA";

export type MacroRegimeV2 =
  | "RISK_ON"
  | "RISK_OFF"
  | "LIQUIDITY_STRESS"
  | "INFLATIONARY"
  | "DISINFLATIONARY"
  | "MIXED";

export type MacroEvidenceDirection = "RISK_ON" | "RISK_OFF" | "NEUTRAL";

export interface MacroEvidence {
  readonly id: string;
  readonly direction: MacroEvidenceDirection;
  readonly strength: number; // [0.0 .. 1.0]
  readonly observedValue?: number | null;
  readonly description: string;
  readonly sourceIds: readonly string[];
}

export interface MacroCoverage {
  readonly usable: number;
  readonly required: number;
  readonly totalCore: number;
  readonly ratio: number; // [0.0 .. 1.0]
}

export interface MacroAssessmentModelMetadata {
  readonly name: string;
  readonly version: string;
  readonly classification: "HEURISTIC";
}

export interface MacroAssessment {
  readonly status: MacroAssessmentStatus;
  readonly regime: MacroRegimeV2 | null;
  readonly evidence: readonly MacroEvidence[];
  readonly conflicts: readonly MacroEvidence[];
  readonly usableMetrics: readonly string[];
  readonly unavailableMetrics: readonly string[];
  readonly staleMetrics: readonly string[];
  readonly excludedMetrics: readonly string[];
  readonly coverage: MacroCoverage;
  /**
   * Heuristic data-coverage and evidence-agreement score in [0 .. 100].
   * NOTE: This is NOT a calibrated probability and NOT a forecast probability.
   */
  readonly confidence: number | null;
  readonly model: MacroAssessmentModelMetadata;
  readonly reason?: string | null;
}

// ----------------------------------------------------------------------------
// LAYER 3 - SYNTHESIS & ADAPTER TYPES (GATE M3)
// ----------------------------------------------------------------------------

export type SynthesisStatus =
  | "AVAILABLE"
  | "PARTIAL"
  | "INSUFFICIENT_DATA";

export type MarketStance =
  | "RISK_ON"
  | "RISK_OFF"
  | "MIXED"
  | "DEFENSIVE"
  | "NEUTRAL"
  | "UNDETERMINED";

export interface QuantStrategySummary {
  readonly id: string;
  readonly name: string;
  readonly signal: number | null;
  readonly state: string;
  readonly validUntil?: number | null;
  readonly source: "ALPHA_ENGINE";
}

export interface QuantLayerSummary {
  readonly status: "AVAILABLE" | "PARTIAL" | "UNAVAILABLE";
  readonly strategies: readonly QuantStrategySummary[];
  readonly strongestStrategyId: string | null;
  readonly note?: string | null;
}

export interface RiskLayerSummary {
  readonly status: "AVAILABLE" | "UNAVAILABLE";
  readonly riskState?: string | null;
  readonly grossExposure?: number | null;
  readonly allowedExposure?: number | null;
  readonly drawdown?: number | null;
  readonly note?: string | null;
}

export interface OmegaLayerSummary {
  readonly status: "AVAILABLE" | "UNAVAILABLE";
  readonly targetWeights?: Readonly<Record<string, number>> | null;
  readonly source: "OMEGA_PAPER";
  readonly note?: string | null;
}

export interface SynthesisEvidence {
  readonly id: string;
  readonly layer: "DATA" | "MACRO" | "QUANT" | "RISK" | "OMEGA";
  readonly description: string;
  readonly sourceIds: readonly string[];
}

export interface SynthesisAssessmentModelMetadata {
  readonly name: string;
  readonly version: string;
  readonly classification: "SYNTHESIS";
}

export interface SynthesisAssessment {
  readonly status: SynthesisStatus;
  readonly stance: MarketStance;

  readonly headline: string;
  readonly rationale: readonly string[];

  readonly supportingEvidence: readonly SynthesisEvidence[];
  readonly conflictingEvidence: readonly SynthesisEvidence[];

  readonly risks: readonly string[];
  readonly invalidation: readonly string[];

  readonly dataCoverage: number;
  readonly confidence: number | null;

  readonly model: SynthesisAssessmentModelMetadata;
}

/**
 * Backward compatibility alias placeholders for future layers.
 */
export interface MarketSnapshotQuantPlaceholder {
  readonly status: "NOT_IMPLEMENTED";
  readonly note: string;
}

export interface MarketSnapshotSynthesisPlaceholder {
  readonly status: "NOT_IMPLEMENTED";
  readonly note: string;
}

/**
 * Unified CurrentMarketSnapshot contract (DEC-010, Gate M3).
 * Contains DATA, MACRO, QUANT, RISK, OMEGA, and SYNTHESIS layers.
 */
export interface CurrentMarketSnapshot {
  readonly timestamp: number;
  readonly data: MarketSnapshotData;
  readonly macro?: MacroAssessment | null;
  readonly quant?: QuantLayerSummary | null;
  readonly risk?: RiskLayerSummary | null;
  readonly omega?: OmegaLayerSummary | null;
  readonly synthesis?: SynthesisAssessment | null;
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
