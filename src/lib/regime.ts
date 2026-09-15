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

export interface ExtendedRegimeResult extends RegimeResult {
  yieldSpreadBps: number;
  vixLevel: number;
}

export function scoreMacroRegime(series: MacroSeries[]): ExtendedRegimeResult {
  const dxy = series.find((s) => s.id === "dxy");
  const yld10 = series.find((s) => s.id === "us10y");
  const yld2 = series.find((s) => s.id === "us2y");
  const vix = series.find((s) => s.id === "vix");
  const gold = series.find((s) => s.id === "gold");
  const btc = series.find((s) => s.id === "btc");

  const dxyVals = dxy?.points.map((p) => p.value) ?? [];
  const yld10Vals = yld10?.points.map((p) => p.value) ?? [];
  const yld2Vals = yld2?.points.map((p) => p.value) ?? [];
  const vixVals = vix?.points.map((p) => p.value) ?? [];
  const goldVals = gold?.points.map((p) => p.value) ?? [];
  const btcVals = btc?.points.map((p) => p.value) ?? [];

  const dxyTrend = linearSlope(lastN(dxyVals, 30));
  const yieldTrend = linearSlope(lastN(yld10Vals, 30));
  const yieldLevel = yld10Vals.at(-1) ?? 4;
  const yield2Level = yld2Vals.at(-1) ?? 4.2;
  const yieldSpreadBps = Math.round((yieldLevel - yield2Level) * 100); // 10Y - 2Y Spread (bps)
  const vixLevel = vixVals.at(-1) ?? 16;

  const goldTrend = linearSlope(lastN(goldVals, 30));
  const btcTrend = linearSlope(lastN(btcVals, 30));

  const dxyRising = dxyTrend > 0.0004;
  const dxyFalling = dxyTrend < -0.0004;
  const yieldsHigh = yieldLevel >= 4.0;
  const yieldsRising = yieldTrend > 0.002;
  const isYieldInverted = yieldSpreadBps < 0;
  const isVixHigh = vixLevel > 22;

  // Global Risk/Regime Score trong [0, 100], điều chỉnh theo Yield Spread và VIX
  let raw =
    50 -
    28 * tanh(dxyTrend * 120) -
    18 * tanh((yieldLevel - 3.75) / 1.35) -
    16 * tanh(yieldTrend * 80) +
    8 * tanh(btcTrend * 40) -
    4 * tanh(goldTrend * 50) +
    0.05 * yieldSpreadBps -
    0.8 * (vixLevel - 16);

  const score = clamp(raw, 0, 100);

  let label: RegimeLabel = "Transitional Mixed";
  let thesis =
    "Cross-currents in the dollar and the front of the Treasury curve leave no dominant liquidity impulse.";

  if (isVixHigh) {
    label = "Flight to Dollar";
    thesis = `Market volatility spike (VIX: ${vixLevel.toFixed(1)}). Capital shifting rapidly to safety, raising cash and gold reserves.`;
  } else if (isYieldInverted) {
    label = "Liquidity Drain";
    thesis = `Yield curve inverted (${yieldSpreadBps} bps). Tight policy squeezing credit creation and testing equity valuations.`;
  } else if (dxyRising && yieldsHigh) {
    label = "Liquidity Drain";
    thesis = "Rising DXY plus elevated real-policy tightness is a classic liquidity drain: de-risk beta, raise USD cash, keep a gold hedge.";
  } else if (dxyFalling && !yieldsHigh && !yieldsRising) {
    label = "Risk-On Expansion";
    thesis = "A softer dollar and contained yields expand global dollar liquidity. Overweight equities and crypto; keep cash at a tactical minimum.";
  } else if (!dxyRising && yieldsHigh) {
    label = "Stagflation Hedge";
    thesis = "Yields remain restrictive while the dollar is not confirming. Real assets (gold, select real estate) hedge fiscal/inflation risk better than duration.";
  } else if (score >= 62 && goldTrend < 0) {
    label = "Goldilocks";
    thesis = "Disinflationary growth mix: yields not spiking, dollar not squeezing. Equities lead; gold is the funding source.";
  }

  const allocation = buildAllocation({
    dxyTrend,
    yieldLevel,
    yieldTrend,
    score,
  });

  return { score, label, thesis, dxyTrend, yieldLevel, yieldTrend, yieldSpreadBps, vixLevel, allocation };
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