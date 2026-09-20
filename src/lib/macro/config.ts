// ============================================================================
// FILE: src/lib/macro/config.ts
// MODULE: MACRO V2 CENTRALIZED CONFIGURATION & FRESHNESS THRESHOLDS
// PRINCIPLE: Explicit, Centralized Thresholds for Gate M2 Quality Evaluation
// ============================================================================

export interface MacroV2Config {
  readonly coreMetricIds: readonly string[];
  readonly minUsableCore: number;
  readonly freshnessThresholdsMs: Readonly<Record<string, number>>;
}

export const MACRO_V2_CONFIG: MacroV2Config = {
  coreMetricIds: ["dxy", "us2y", "us10y", "vix", "gold", "btc"],
  minUsableCore: 4,
  freshnessThresholdsMs: {
    btc: 86_400_000,      // 24 hours (24/7 trading crypto spot)
    gold: 86_400_000,     // 24 hours (PAXG tokenized spot)
    dxy: 259_200_000,     // 72 hours (tolerates weekend FX market closures)
    us10y: 259_200_000,   // 72 hours (tolerates weekend bond market closures)
    us2y: 259_200_000,    // 72 hours (tolerates weekend bond market closures)
    vix: 259_200_000,     // 72 hours (tolerates weekend CBOE closures)
    vnindex: 259_200_000, // 72 hours (tolerates weekend equity market closures)
    default: 259_200_000, // 72 hours default threshold
  },
};

/**
 * Helper to retrieve maximum age threshold for a metric.
 */
export function getFreshnessThresholdMs(
  metricId: string,
  config: MacroV2Config = MACRO_V2_CONFIG
): number {
  return config.freshnessThresholdsMs[metricId] ?? config.freshnessThresholdsMs.default ?? 259_200_000;
}
