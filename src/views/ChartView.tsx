import { useEffect, useRef } from "react";
import { CandlestickSeries, ColorType, createChart, HistogramSeries, LineSeries } from "lightweight-charts";
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

  const { bars, ema20, ema50, rsi14, interval, loading, source, lastPrice, setIntervalTf, load } = useMarketStore();
  const runOnBars = useTradingStore((s) => s.runOnBars);

  useEffect(() => { if (bars.length === 0) void load(); }, [bars.length, load]);
  useEffect(() => { if (bars.length >= 55) runOnBars(bars); }, [bars, runOnBars]);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;

    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "#ffffff" }, // Nền Trắng
        textColor: "#64748b", // Chữ xám đậm
        fontFamily: "Inter, sans-serif",
      },
      grid: {
        vertLines: { color: "#f1f5f9" },
        horzLines: { color: "#f1f5f9" },
      },
      rightPriceScale: { borderColor: "#e2e8f0" },
      timeScale: { borderColor: "#e2e8f0", timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
    });

    const candles = chart.addSeries(CandlestickSeries, {
      upColor: "#10b981", downColor: "#f43f5e", borderVisible: false, wickUpColor: "#10b981", wickDownColor: "#f43f5e",
    });
    const e20 = chart.addSeries(LineSeries, { color: "#0ea5e9", lineWidth: 2, priceLineVisible: false });
    const e50 = chart.addSeries(LineSeries, { color: "#f59e0b", lineWidth: 2, priceLineVisible: false });
    const vol = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "vol" }, 0);
    vol.priceScale().applyOptions({ scaleMargins: { top: 0.78, bottom: 0 } });
    const rsiSeries = chart.addSeries(LineSeries, { color: "#8b5cf6", lineWidth: 2, priceLineVisible: false }, 1);
    rsiSeries.priceScale().applyOptions({ scaleMargins: { top: 0.12, bottom: 0.08 } });

    chartRef.current = chart; candleRef.current = candles; ema20Ref.current = e20; ema50Ref.current = e50; volRef.current = vol; rsiRef.current = rsiSeries;

    return () => { chart.remove(); chartRef.current = null; };
  }, []);

  useEffect(() => {
    if (!candleRef.current || bars.length === 0) return;
    candleRef.current.setData(bars.map((b) => ({ time: b.time as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close })));
    ema20Ref.current?.setData(bars.flatMap((b, i) => ema20[i] == null ? [] : [{ time: b.time as UTCTimestamp, value: ema20[i] as number }]));
    ema50Ref.current?.setData(bars.flatMap((b, i) => ema50[i] == null ? [] : [{ time: b.time as UTCTimestamp, value: ema50[i] as number }]));
    volRef.current?.setData(bars.map((b) => ({ time: b.time as UTCTimestamp, value: b.volume, color: b.close >= b.open ? "rgba(16, 185, 129, 0.4)" : "rgba(244, 63, 94, 0.4)" })));
    rsiRef.current?.setData(bars.flatMap((b, i) => rsi14[i] == null ? [] : [{ time: b.time as UTCTimestamp, value: rsi14[i] as number }]));
    chartRef.current?.timeScale().fitContent();
  }, [bars, ema20, ema50, rsi14]);

  const prev = bars.at(-2)?.close ?? lastPrice;
  const chg = lastPrice && prev ? lastPrice / prev - 1 : 0;
  const lastRsi = [...rsi14].reverse().find((v) => v != null) ?? null;
  const lastE20 = [...ema20].reverse().find((v) => v != null) ?? null;
  const lastE50 = [...ema50].reverse().find((v) => v != null) ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-5 bg-[#f8fafc] font-sans">
      <div className="flex items-center justify-between gap-4 border border-slate-200 bg-white px-5 py-3 rounded-2xl shadow-sm">
        <div className="flex items-end gap-6">
          <div>
            <div className="font-bold text-[10px] tracking-widest text-sky-600 uppercase">SÀN BINANCE</div>
            <div className="font-sans text-xl font-black text-slate-800">BTC/USDT</div>
          </div>
          <div className={clsx("font-sans text-2xl font-bold", chg >= 0 ? "text-emerald-500" : "text-rose-500")}>
            {formatNumber(lastPrice, 2)}
          </div>
          <div className={clsx("font-sans text-sm font-bold mb-1", chg >= 0 ? "text-emerald-500" : "text-rose-500")}>
            {chg >= 0 ? "+" : ""}{formatPct(chg)}
          </div>
        </div>
        <div className="flex items-center gap-5 font-sans text-[12px] text-slate-500 font-semibold">
          <span className="bg-slate-50 px-2 py-1 rounded-md border border-slate-100">EMA20: <span className="text-slate-800">{lastE20 ? formatNumber(lastE20, 1) : "—"}</span></span>
          <span className="bg-slate-50 px-2 py-1 rounded-md border border-slate-100">EMA50: <span className="text-slate-800">{lastE50 ? formatNumber(lastE50, 1) : "—"}</span></span>
          <span className="bg-slate-50 px-2 py-1 rounded-md border border-slate-100">RSI14: <span className="text-slate-800">{lastRsi ? formatNumber(lastRsi, 1) : "—"}</span></span>
          <span className="text-sky-600 bg-sky-50 px-2 py-1 rounded-md border border-sky-100">{source === "live" ? "DỮ LIỆU TRỰC TIẾP" : "DỮ LIỆU MÔ PHỎNG"}</span>
          <div className="flex bg-slate-100 rounded-lg p-1 border border-slate-200">
            {INTERVALS.map((tf) => (
              <button key={tf} onClick={() => setIntervalTf(tf)} className={clsx("px-3 py-1.5 rounded-md font-bold transition-all", interval === tf ? "bg-white text-sky-600 shadow-sm" : "text-slate-500 hover:text-slate-700")}>
                {tf.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
      </div>

      <Panel title="BIỂU ĐỒ KỸ THUẬT OHLCV · EMA 20/50 · RSI(14)" right={loading ? "ĐANG TẢI..." : `${bars.length} NẾN`} className="min-h-0 flex-1 bg-white border border-slate-200 shadow-sm rounded-2xl overflow-hidden">
        <div ref={hostRef} className="h-full min-h-[420px] w-full" />
      </Panel>
    </div>
  );
}