// ============================================================================
// FILE: src/views/ChartView.tsx
// MODULE: QUANT SIGNAL VISUALIZER (CHANDELIER STOP & MEAN REVERSION BANDS)
// ============================================================================

import { useEffect, useMemo, useRef } from "react";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  HistogramSeries,
  LineSeries,
  LineStyle,
} from "lightweight-charts";
import type { IChartApi, ISeriesApi, UTCTimestamp } from "lightweight-charts";
import { Activity, Compass, ShieldAlert } from "lucide-react";
import { Panel } from "@/components/ui/Panel";
import { clsx } from "@/lib/clsx";
import { formatNumber, formatPct } from "@/lib/math";
import type { BinanceInterval } from "@/lib/binance";
import type { OhlcvBar } from "@/types/market";
import { useMarketStore } from "@/stores/marketStore";
import { useTradingStore } from "@/stores/tradingStore";

const INTERVALS: BinanceInterval[] = ["15m", "1h", "4h", "1d"];

interface QuantOverlays {
  chandelier: Array<{ time: UTCTimestamp; value: number }>;
  upperBand: Array<{ time: UTCTimestamp; value: number }>;
  lowerBand: Array<{ time: UTCTimestamp; value: number }>;
  zScores: Array<{ time: UTCTimestamp; value: number }>;
  lastZScore: number | null;
  lastStop: number | null;
  volumeRatio: number | null;
}

function calculateQuantOverlays(bars: OhlcvBar[]): QuantOverlays {
  const n = bars.length;
  const chandelier: Array<{ time: UTCTimestamp; value: number }> = [];
  const upperBand: Array<{ time: UTCTimestamp; value: number }> = [];
  const lowerBand: Array<{ time: UTCTimestamp; value: number }> = [];
  const zScores: Array<{ time: UTCTimestamp; value: number }> = [];

  const mrPeriod = 20;
  const chandelierPeriod = 22;
  const chandelierAtrMult = 3.0;

  for (let i = 0; i < n; i++) {
    const t = bars[i].time as UTCTimestamp;

    // 1. Tính toán dải biên và Z-Score của Alpha 3 (Mean Reversion)
    if (i >= mrPeriod - 1) {
      const slice = bars.slice(i - mrPeriod + 1, i + 1);
      const mean = slice.reduce((sum, b) => sum + b.close, 0) / mrPeriod;
      const variance = slice.reduce((sum, b) => sum + Math.pow(b.close - mean, 2), 0) / mrPeriod;
      const std = Math.sqrt(variance);

      upperBand.push({ time: t, value: Math.round((mean + 2 * std) * 100) / 100 });
      lowerBand.push({ time: t, value: Math.round((mean - 2 * std) * 100) / 100 });

      const z = std > 0 ? (bars[i].close - mean) / std : 0;
      zScores.push({ time: t, value: Math.round(z * 100) / 100 });
    }

    // 2. Tính toán dải Chandelier ATR Trailing Stop của Alpha 1 (Adaptive Trend)
    if (i >= chandelierPeriod) {
      const slice = bars.slice(i - chandelierPeriod + 1, i + 1);
      let highestHigh = -Infinity;
      let trSum = 0;

      for (let j = 0; j < slice.length; j++) {
        if (slice[j].high > highestHigh) highestHigh = slice[j].high;
        const prevClose = j > 0 ? slice[j - 1].close : slice[j].open;
        const tr = Math.max(
          slice[j].high - slice[j].low,
          Math.abs(slice[j].high - prevClose),
          Math.abs(slice[j].low - prevClose)
        );
        trSum += tr;
      }

      const atr = trSum / chandelierPeriod;
      const stopPrice = highestHigh - atr * chandelierAtrMult;
      chandelier.push({ time: t, value: Math.round(stopPrice * 100) / 100 });
    }
  }

  // Tính Volume Exhaustion Ratio (Volume hiện tại / MA20 Volume)
  let volumeRatio: number | null = null;
  if (n >= 20) {
    const last20Vol = bars.slice(-20).reduce((acc, b) => acc + b.volume, 0) / 20;
    const currentVol = bars[n - 1]?.volume ?? 0;
    volumeRatio = last20Vol > 0 ? Math.round((currentVol / last20Vol) * 100) / 100 : 1.0;
  }

  return {
    chandelier,
    upperBand,
    lowerBand,
    zScores,
    lastZScore: zScores.at(-1)?.value ?? null,
    lastStop: chandelier.at(-1)?.value ?? null,
    volumeRatio,
  };
}

export function ChartView() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);

  // Series References
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const chandelierRef = useRef<ISeriesApi<"Line"> | null>(null);
  const upperBandRef = useRef<ISeriesApi<"Line"> | null>(null);
  const lowerBandRef = useRef<ISeriesApi<"Line"> | null>(null);
  const volRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const zScoreRef = useRef<ISeriesApi<"Line"> | null>(null);

  const { bars, interval, loading, source, lastPrice, setIntervalTf, load } = useMarketStore();
  const runOnBars = useTradingStore((s) => s.runOnBars);

  useEffect(() => {
    if (bars.length === 0) void load();
  }, [bars.length, load]);

  useEffect(() => {
    if (bars.length >= 130) runOnBars(bars);
  }, [bars, runOnBars]);

  // Tính toán toán học cho các tín hiệu Quant
  const quantData = useMemo(() => calculateQuantOverlays(bars), [bars]);

  // Khởi tạo Canvas Lightweight Charts
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;

    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "#0c1017" },
        textColor: "#7d8ea3",
        fontFamily: "IBM Plex Mono, monospace",
        panes: { separatorColor: "#1c2736", separatorHoverColor: "#26c6da" },
      },
      grid: {
        vertLines: { color: "#151b26" },
        horzLines: { color: "#151b26" },
      },
      rightPriceScale: { borderColor: "#1c2736" },
      timeScale: { borderColor: "#1c2736", timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
    });

    // Main Pane (0): Candlestick + Chandelier + MR Bands + Volume
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: "#00e676",
      downColor: "#ff3d57",
      borderVisible: false,
      wickUpColor: "#00e676",
      wickDownColor: "#ff3d57",
    });

    const upper = chart.addSeries(LineSeries, {
      color: "rgba(179, 136, 255, 0.45)",
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      priceLineVisible: false,
    });

    const lower = chart.addSeries(LineSeries, {
      color: "rgba(179, 136, 255, 0.45)",
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      priceLineVisible: false,
    });

    const chStop = chart.addSeries(LineSeries, {
      color: "#ff9800",
      lineWidth: 2,
      priceLineVisible: true,
      title: "Chandelier Stop",
    });

    const vol = chart.addSeries(
      HistogramSeries,
      { priceFormat: { type: "volume" }, priceScaleId: "vol" },
      0
    );
    vol.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    // Subpane (1): Z-Score Oscillator (-3.0 to +3.0)
    const zScore = chart.addSeries(
      LineSeries,
      {
        color: "#26c6da",
        lineWidth: 2,
        priceLineVisible: false,
        title: "Z-Score (20)",
      },
      1
    );
    zScore.priceScale().applyOptions({ scaleMargins: { top: 0.15, bottom: 0.15 } });

    // Ngưỡng Extreme Bands trên Pane 1
    zScore.createPriceLine({
      price: 2.0,
      color: "#ff3d57",
      lineWidth: 1,
      lineStyle: LineStyle.Dotted,
      axisLabelVisible: true,
      title: "+2σ Extreme",
    });
    zScore.createPriceLine({
      price: -2.0,
      color: "#00e676",
      lineWidth: 1,
      lineStyle: LineStyle.Dotted,
      axisLabelVisible: true,
      title: "-2σ Extreme",
    });
    zScore.createPriceLine({
      price: 0.0,
      color: "#7d8ea3",
      lineWidth: 1,
      lineStyle: LineStyle.Dotted,
      axisLabelVisible: false,
    });

    chartRef.current = chart;
    candleRef.current = candles;
    chandelierRef.current = chStop;
    upperBandRef.current = upper;
    lowerBandRef.current = lower;
    volRef.current = vol;
    zScoreRef.current = zScore;

    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, []);

  // Đồng bộ nạp dữ liệu vào Series
  useEffect(() => {
    if (!candleRef.current || bars.length === 0) return;

    candleRef.current.setData(
      bars.map((b) => ({
        time: b.time as UTCTimestamp,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
      }))
    );

    chandelierRef.current?.setData(quantData.chandelier);
    upperBandRef.current?.setData(quantData.upperBand);
    lowerBandRef.current?.setData(quantData.lowerBand);

    volRef.current?.setData(
      bars.map((b) => ({
        time: b.time as UTCTimestamp,
        value: b.volume,
        color: b.close >= b.open ? "rgba(0,230,118,0.3)" : "rgba(255,61,87,0.3)",
      }))
    );

    zScoreRef.current?.setData(quantData.zScores);

    chartRef.current?.timeScale().fitContent();
  }, [bars, quantData]);

  const prev = bars.at(-2)?.close ?? lastPrice;
  const chg = lastPrice && prev ? lastPrice / prev - 1 : 0;
  const z = quantData.lastZScore;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3 bg-[#07090d]">
      {/* 1. QUANT TELEMETRY HUD */}
      <div className="flex flex-wrap items-center justify-between gap-3 border border-line bg-panel px-3 py-2 rounded-sm font-mono text-[11px]">
        <div className="flex items-center gap-5">
          <div>
            <div className="text-[10px] tracking-[0.2em] text-cyan font-bold">BENCHMARK ASSET</div>
            <div className="text-lg font-bold text-white">
              BTC/USDT <span className="text-sm font-normal text-muted">Binance Spot</span>
            </div>
          </div>
          <div>
            <div className="text-[10px] text-muted tracking-wider">MARK PRICE</div>
            <div className={clsx("text-2xl font-bold", chg >= 0 ? "text-up" : "text-down")}>
              {formatNumber(lastPrice, 2)}{" "}
              <span className="text-xs font-semibold">{formatPct(chg)}</span>
            </div>
          </div>
        </div>

        {/* Trạng thái 2 Alpha Cốt lõi */}
        <div className="flex flex-wrap items-center gap-6">
          <div className="flex flex-col">
            <span className="text-[10px] text-muted flex items-center gap-1">
              <ShieldAlert size={12} className="text-[#ff9800]" /> ALPHA 1 · CHANDELIER STOP
            </span>
            <span className="text-sm font-bold text-[#ff9800]">
              {quantData.lastStop ? `$${quantData.lastStop.toLocaleString()}` : "WARMING UP"}
            </span>
          </div>

          <div className="flex flex-col">
            <span className="text-[10px] text-muted flex items-center gap-1">
              <Compass size={12} className="text-[#26c6da]" /> ALPHA 3 · DEVIATION Z-SCORE
            </span>
            <span
              className={clsx(
                "text-sm font-bold",
                z == null
                  ? "text-muted"
                  : z <= -2.0
                  ? "text-up"
                  : z >= 2.0
                  ? "text-down"
                  : "text-white"
              )}
            >
              {z != null ? `${z.toFixed(2)} σ` : "WARMING UP"}{" "}
              <span className="text-[10px] font-normal text-muted">
                {z == null ? "" : z <= -2.0 ? "(OVERSOLD)" : z >= 2.0 ? "(OVERBOUGHT)" : "(NEUTRAL)"}
              </span>
            </span>
          </div>

          <div className="flex flex-col">
            <span className="text-[10px] text-muted flex items-center gap-1">
              <Activity size={12} className="text-amber" /> VOL EXHAUSTION
            </span>
            <span className="text-sm font-bold text-white">
              {quantData.volumeRatio != null ? `${quantData.volumeRatio}x MA20` : "—"}
            </span>
          </div>

          <div className="flex items-center gap-3">
            <span
              className={clsx(
                "px-2 py-0.5 rounded text-[10px] font-bold border",
                source === "live"
                  ? "bg-up/10 text-up border-up/30"
                  : "bg-amber/10 text-amber border-amber/30"
              )}
            >
              {source === "live" ? "FEED: LIVE BINANCE" : "FEED: SYNTHETIC"}
            </span>

            <div className="flex border border-line rounded overflow-hidden">
              {INTERVALS.map((tf) => (
                <button
                  key={tf}
                  type="button"
                  onClick={() => setIntervalTf(tf)}
                  className={clsx(
                    "px-2.5 py-1 text-[11px] font-bold transition-colors",
                    interval === tf ? "bg-up/20 text-up" : "text-muted hover:text-white bg-panel-2"
                  )}
                >
                  {tf.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* 2. KHUNG BIỂU ĐỒ 2 PHÂN VÙNG (MAIN + Z-SCORE SUBPANE) */}
      <Panel
        title="QUANT SIGNAL VISUALIZER · CHANDELIER TRAILING STOP (PANE 0) & Z-SCORE DEVIATION OSCILLATOR (PANE 1)"
        right={loading ? "SYNCING..." : `${bars.length} BARS LOADED`}
        className="min-h-0 flex-1 flex flex-col"
      >
        <div ref={hostRef} className="h-full min-h-[440px] w-full" />
      </Panel>
    </div>
  );
}