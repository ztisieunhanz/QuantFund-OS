import type { AssetKey, CorrelationMatrix, MacroSeries } from "@/types/market";
import { pearson, returns } from "@/lib/math";

const KEYS: AssetKey[] = ["dxy", "us10y", "gold", "btc"];

export function thirtyDayCorrelation(series: MacroSeries[]): CorrelationMatrix {
  const map = new Map(series.map((s) => [s.id, s]));
  const ret: Record<AssetKey, number[]> = {
    dxy: [],
    us10y: [],
    gold: [],
    btc: [],
  };
  for (const key of KEYS) {
    const pts = map.get(key)?.points ?? [];
    const vals = pts.slice(-31).map((p) => p.value);
    ret[key] = returns(vals);
  }

  const matrix = {} as CorrelationMatrix;
  for (const a of KEYS) {
    matrix[a] = {} as Record<AssetKey, number>;
    for (const b of KEYS) {
      matrix[a][b] = a === b ? 1 : pearson(ret[a], ret[b]);
    }
  }
  return matrix;
}
