import { useEffect, useRef } from "react";

import {

  CandlestickSeries,

  ColorType,

  createChart,

  HistogramSeries,

  LineSeries,

} from "lightweight-charts";

import type { IChartApi, ISeriesApi, UTCTimestamp } from "lightweight-charts";

import { Panel } from "@/components/ui/Panel";

import { clsx } from "@/lib/clsx";

import { formatNumber, formatPct } from "@/lib/math";

import type { BinanceInterval } from "@/lib/binance";

import { useMarketStore } from "@/stores/marketStore";

import { useTradingStore } from "@/stores/tradingStore";



const INTERVALS: BinanceInterval[] = ["15m", "1h", "4h", "1d"];



export function ChartView() {

  const hostRef = useRef<HTMLDivElement | null>(null);

  const chartRef = useRef<IChartApi | null>(null);

  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);

  const ema20Ref = useRef<ISeriesApi<"Line"> | null>(null);

  const ema50Ref = useRef<ISeriesApi<"Line"> | null>(null);

  const volRef = useRef<ISeriesApi<"Histogram"> | null>(null);

  const rsiRef = useRef<ISeriesApi<"Line"> | null>(null);



  const { bars, ema20, ema50, rsi14, interval, loading, source, lastPrice, setIntervalTf, load } =

    useMarketStore();

  const runOnBars = useTradingStore((s) => s.runOnBars);



  useEffect(() => {

    if (bars.length === 0) void load();

  }, [bars.length, load]);



  useEffect(() => {

    if (bars.length >= 55) runOnBars(bars);

  }, [bars, runOnBars]);



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



    const candles = chart.addSeries(CandlestickSeries, {

      upColor: "#00e676",

      downColor: "#ff3d57",

      borderVisible: false,

      wickUpColor: "#00e676",

      wickDownColor: "#ff3d57",

    });

    const e20 = chart.addSeries(LineSeries, { color: "#26c6da", lineWidth: 2, priceLineVisible: false });

    const e50 = chart.addSeries(LineSeries, { color: "#ffc107", lineWidth: 2, priceLineVisible: false });

    const vol = chart.addSeries(

      HistogramSeries,

      { priceFormat: { type: "volume" }, priceScaleId: "vol" },

      0,

    );

    vol.priceScale().applyOptions({ scaleMargins: { top: 0.78, bottom: 0 } });

    const rsiSeries = chart.addSeries(

      LineSeries,

      { color: "#b388ff", lineWidth: 2, priceLineVisible: false },

      1,

    );

    rsiSeries.priceScale().applyOptions({ scaleMargins: { top: 0.12, bottom: 0.08 } });



    chartRef.current = chart;

    candleRef.current = candles;

    ema20Ref.current = e20;

    ema50Ref.current = e50;

    volRef.current = vol;

    rsiRef.current = rsiSeries;



    return () => {

      chart.remove();

      chartRef.current = null;

    };

  }, []);



  useEffect(() => {

    if (!candleRef.current || bars.length === 0) return;

    candleRef.current.setData(

      bars.map((b) => ({

        time: b.time as UTCTimestamp,

        open: b.open,

        high: b.high,

        low: b.low,

        close: b.close,

      })),

    );

    ema20Ref.current?.setData(

      bars.flatMap((b, i) =>

        ema20[i] == null ? [] : [{ time: b.time as UTCTimestamp, value: ema20[i] as number }],

      ),

    );

    ema50Ref.current?.setData(

      bars.flatMap((b, i) =>

        ema50[i] == null ? [] : [{ time: b.time as UTCTimestamp, value: ema50[i] as number }],

      ),

    );

    volRef.current?.setData(

      bars.map((b) => ({

        time: b.time as UTCTimestamp,

        value: b.volume,

        color: b.close >= b.open ? "rgba(0,230,118,0.45)" : "rgba(255,61,87,0.45)",

      })),

    );

    rsiRef.current?.setData(

      bars.flatMap((b, i) =>

        rsi14[i] == null ? [] : [{ time: b.time as UTCTimestamp, value: rsi14[i] as number }],

      ),

    );

    chartRef.current?.timeScale().fitContent();

  }, [bars, ema20, ema50, rsi14]);



  const prev = bars.at(-2)?.close ?? lastPrice;

  const chg = lastPrice && prev ? lastPrice / prev - 1 : 0;

  const lastRsi = [...rsi14].reverse().find((v) => v != null) ?? null;

  const lastE20 = [...ema20].reverse().find((v) => v != null) ?? null;

  const lastE50 = [...ema50].reverse().find((v) => v != null) ?? null;



  return (

    <div className="flex h-full min-h-0 flex-col gap-3 p-3">

      <div className="flex items-center justify-between gap-3 border border-line bg-panel px-3 py-2">

        <div className="flex items-end gap-4">

          <div>

            <div className="font-mono text-[10px] tracking-[0.2em] text-cyan">BINANCE</div>

            <div className="font-mono text-lg font-semibold">BTC/USDT</div>

          </div>

          <div className={clsx("font-mono text-2xl", chg >= 0 ? "text-up" : "text-down")}>

            {formatNumber(lastPrice, 2)}

          </div>

          <div className={clsx("font-mono text-sm", chg >= 0 ? "text-up" : "text-down")}>

            {formatPct(chg)}

          </div>

        </div>

        <div className="flex items-center gap-4 font-mono text-[11px] text-muted">

          <span>EMA20 {lastE20 ? formatNumber(lastE20, 1) : "—"}</span>

          <span>EMA50 {lastE50 ? formatNumber(lastE50, 1) : "—"}</span>

          <span>RSI14 {lastRsi ? formatNumber(lastRsi, 1) : "—"}</span>

          <span>{source === "live" ? "FEED LIVE" : "FEED SYNTHETIC"}</span>

          <div className="flex border border-line">

            {INTERVALS.map((tf) => (

              <button

                key={tf}

                type="button"

                onClick={() => setIntervalTf(tf)}

                className={clsx(

                  "px-2 py-1",

                  interval === tf ? "bg-up/15 text-up" : "text-muted hover:text-ink",

                )}

              >

                {tf.toUpperCase()}

              </button>

            ))}

          </div>

        </div>

      </div>



      <Panel title="OHLCV · EMA 20/50 · VOLUME · RSI(14)" right={loading ? "LOADING" : `${bars.length} BARS`} className="min-h-0 flex-1">

        <div ref={hostRef} className="h-full min-h-[420px] w-full" />

      </Panel>

    </div>

  );

}