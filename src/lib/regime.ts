import type { AllocationWeights, MacroSeries, RegimeLabel, RegimeResult } from "@/types/market";
import { clamp, linearSlope } from "@/lib/math";

function lastN(values: number[], n: number): number[] {
  return values.slice(-n);
}

function normalize(weights: AllocationWeights): AllocationWeights {
  const minFloor = 0.02;
  const raw: AllocationWeights = {
    realEstate: Math.max(minFloor, weights.realEstate),
    gold: Math.max(minFloor, weights.gold),
    usdCash: Math.max(minFloor, weights.usdCash),
    equities: Math.max(minFloor, weights.equities),
    crypto: Math.max(minFloor, weights.crypto),
  };
  const sum = raw.realEstate + raw.gold + raw.usdCash + raw.equities + raw.crypto;
  return {
    realEstate: raw.realEstate / sum,
    gold: raw.gold / sum,
    usdCash: raw.usdCash / sum,
    equities: raw.equities / sum,
    crypto: raw.crypto / sum,
  };
}

function tanh(x: number): number {
  return Math.tanh(x);
}

export function scoreMacroRegime(series: MacroSeries[]): RegimeResult {
  const dxy = series.find((s) => s.id === "dxy");
  const yld = series.find((s) => s.id === "us10y");
  const gold = series.find((s) => s.id === "gold");
  const btc = series.find((s) => s.id === "btc");

  const dxyVals = dxy?.points.map((p) => p.value) ?? [];
  const yldVals = yld?.points.map((p) => p.value) ?? [];
  const goldVals = gold?.points.map((p) => p.value) ?? [];
  const btcVals = btc?.points.map((p) => p.value) ?? [];

  const dxyTrend = linearSlope(lastN(dxyVals, 30));
  const yieldTrend = linearSlope(lastN(yldVals, 30));
  const yieldLevel = yldVals.at(-1) ?? 4;
  const goldTrend = linearSlope(lastN(goldVals, 30));
  const btcTrend = linearSlope(lastN(btcVals, 30));

  const dxyRising = dxyTrend > 0.0004;
  const dxyFalling = dxyTrend < -0.0004;
  const yieldsHigh = yieldLevel >= 4.0;
  const yieldsRising = yieldTrend > 0.002;

  /*
   * Global Risk/Regime Score in [0, 100].
   * High = risk-on (liquidity expanding into cyclicals/crypto).
   * Low = risk-off (dollar + duration tightness draining liquidity).
   * DXY trend and 10Y yield dominate by design.
   */
  const raw =
    50 -
    28 * tanh(dxyTrend * 120) -
    18 * tanh((yieldLevel - 3.75) / 1.35) -
    16 * tanh(yieldTrend * 80) +
    8 * tanh(btcTrend * 40) -
    4 * tanh(goldTrend * 50);
  const score = clamp(raw, 0, 100);

  let label: RegimeLabel = "Transitional Mixed";
  let thesis =
    "Cross-currents in the dollar and the front of the Treasury curve leave no dominant liquidity impulse.";

  if (dxyRising && yieldsHigh) {
    label = "Liquidity Drain";
    thesis =
      "Rising DXY plus elevated real-policy tightness is a classic liquidity drain: de-risk beta, raise USD cash, keep a gold hedge.";
  } else if (dxyFalling && !yieldsHigh && !yieldsRising) {
    label = "Risk-On Expansion";
    thesis =
      "A softer dollar and contained yields expand global dollar liquidity. Overweight equities and crypto; keep cash at a tactical minimum.";
  } else if (!dxyRising && yieldsHigh) {
    label = "Stagflation Hedge";
    thesis =
      "Yields remain restrictive while the dollar is not confirming. Real assets (gold, select real estate) hedge fiscal/inflation risk better than duration.";
  } else if (dxyRising && !yieldsHigh) {
    label = "Flight to Dollar";
    thesis =
      "Dollar bid with still-moderate yields: funding-stress / risk-off. Hold cash and gold; cut crypto beta hard.";
  } else if (score >= 62 && goldTrend < 0) {
    label = "Goldilocks";
    thesis =
      "Disinflationary growth mix: yields not spiking, dollar not squeezing. Equities lead; gold is the funding source.";
  }

  const allocation = buildAllocation({
    dxyTrend,
    yieldLevel,
    yieldTrend,
    score,
  });

  return { score, label, thesis, dxyTrend, yieldLevel, yieldTrend, allocation };
}

function buildAllocation(input: {
  dxyTrend: number;
  yieldLevel: number;
  yieldTrend: number;
  score: number;
}): AllocationWeights {
  const dxy = tanh(input.dxyTrend * 140);
  const yLevel = tanh((input.yieldLevel - 3.75) / 1.2);
  const yTrend = tanh(input.yieldTrend * 90);
  const riskOn = (input.score - 50) / 50;

  let realEstate = 0.18 - 0.08 * yLevel - 0.05 * yTrend + 0.04 * riskOn;
  let gold = 0.16 + 0.07 * dxy + 0.04 * yLevel - 0.05 * riskOn;
  let usdCash = 0.14 + 0.1 * dxy + 0.08 * yLevel + 0.06 * yTrend - 0.08 * riskOn;
  let equities = 0.4 - 0.09 * dxy - 0.05 * yLevel + 0.1 * riskOn;
  let crypto = 0.12 - 0.08 * dxy - 0.03 * yLevel + 0.08 * riskOn;

  if (dxy > 0.25 && input.yieldLevel >= 4) {
    usdCash += 0.08;
    gold += 0.05;
    equities -= 0.08;
    crypto -= 0.05;
  }

  return normalize({ realEstate, gold, usdCash, equities, crypto });
}
