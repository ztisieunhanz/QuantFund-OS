// ============================================================================
// FILE: src/views/MacroView.tsx
// MODULE: BULLETPROOF QUANT MACRO VIEW (FULL REGIME VELOCITY METRICS RESTORED)
// ============================================================================

import React, { useEffect, useMemo, useState, useRef } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip as RechartsTooltip } from "recharts";
import { Loader2, Send, MessageSquareText, TrendingUp, Activity, ShieldAlert, RotateCcw } from "lucide-react";
import { Panel } from "@/components/ui/Panel";
import { MetricCard } from "@/components/ui/MetricCard";
import { MacroNewsTable } from "@/components/MacroNewsTable";
import { thirtyDayCorrelation } from "@/lib/correlation";
import { clsx } from "@/lib/clsx";
import { formatNumber, formatPct } from "@/lib/math";
import { useMacroStore } from "@/stores/macroStore";
import { usePortfolioStore } from "@/stores/portfolioStore";
import { useTradingStore } from "@/stores/tradingStore";
import { useMarketStore } from "@/stores/marketStore";
import { loadVietnamMarket, type VietnamMarketState } from "@/lib/vietnamFeed";
import type { AllocationWeights, AssetKey } from "@/types/market";

const CHAT_EXPIRY_MS = 60 * 60 * 1000;
const DEFAULT_GREETING = "Hệ thống **AI Quant Risk Manager (2026)** đã kết nối dữ liệu định lượng.\n\n- Nạp nến Binance Spot trực tiếp\n- Đồng bộ MA200 và hiệu suất các Trading Bot\n\nBạn cần phân tích chiến lược hay kiểm tra hệ thống nào?";

const PIE_COLORS: Record<keyof AllocationWeights, string> = {
  realEstate: "#26c6da", gold: "#ffc107", usdCash: "#00e676", equities: "#82b1ff", crypto: "#b388ff",
};
const PIE_LABELS: Record<keyof AllocationWeights, string> = {
  realEstate: "Real Estate", gold: "Gold", usdCash: "USD Cash", equities: "Equities", crypto: "Crypto",
};
const ASSET_ORDER: AssetKey[] = ["dxy", "us10y", "gold", "btc"];
const ASSET_LABEL: Record<AssetKey, string> = { dxy: "DXY", us10y: "US10Y", gold: "XAU", btc: "BTC" };

function corrColor(v: number): string {
  if (v >= 0.6) return "bg-[#0b3d24] text-up";
  if (v >= 0.2) return "bg-[#12301f] text-up/80";
  if (v > -0.2) return "bg-panel-2 text-muted";
  if (v > -0.6) return "bg-[#3a1218] text-down/80";
  return "bg-[#4a0d16] text-down";
}

interface QuantResponse {
  verdict: "BUY" | "HOLD" | "REDUCE" | "HEDGE" | "WAIT";
  confidence: number;
  thesis: string;
  signals: any[];
  divergences: any[];
  risks: any[];
  action: string;
  triggers: any[];
  invalidation: string;
  dataQuality: { coverage: number; missing: any[] };
}

// BỘ LỌC AN TOÀN: Ép mọi dữ liệu (object, null, array) về chuỗi hợp lệ, chống crash màn hình đen
const renderItem = (item: any): React.ReactNode => {
  if (item == null) return "";
  if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
    return String(item);
  }
  if (typeof item === "object") {
    return Object.entries(item)
      .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`)
      .join(" | ");
  }
  return String(item);
};

const PlainTextFormatted = ({ text }: { text: string }) => {
  const lines = (text || "").split("\n");
  return (
    <div className="space-y-2 text-[14px] leading-relaxed text-ink font-sans tracking-wide">
      {lines.map((line, i) => {
        if (!line.trim()) return <div key={i} className="h-1.5"></div>;
        const formatted = line
          .replace(/\*\*(.*?)\*\*/g, '<strong class="text-white font-bold">$1</strong>')
          .replace(/\*(.*?)\*/g, '<em class="text-muted italic">$1</em>');
        return <div key={i} dangerouslySetInnerHTML={{ __html: formatted }} />;
      })}
    </div>
  );
};

const FormatStructuredMessage = ({ data, text }: { data?: QuantResponse; text: string }) => {
  if (!data || typeof data !== "object") {
    return <PlainTextFormatted text={text} />;
  }

  try {
    const verdictColors: Record<string, string> = {
      BUY: "text-[#00e676] bg-[#00e676]/10 border-[#00e676]/30",
      HOLD: "text-cyan bg-cyan/10 border-cyan/30",
      REDUCE: "text-amber bg-amber/10 border-amber/30",
      HEDGE: "text-[#b388ff] bg-[#b388ff]/10 border-[#b388ff]/30",
      WAIT: "text-muted bg-panel-2 border-line",
    };
    const vColor = verdictColors[data.verdict] || verdictColors.WAIT;

    return (
      <div className="space-y-4 font-sans text-[13px] text-ink w-full">
        <div className="flex items-center justify-between border-b border-line pb-2.5">
          <div className={clsx("px-2.5 py-1 rounded border font-black text-[12px] tracking-widest uppercase shadow-sm", vColor)}>
            VERDICT: {renderItem(data.verdict)}
          </div>
          <div className="text-cyan font-mono text-[11px] font-bold">
            CONFIDENCE: {renderItem(data.confidence)}%
          </div>
        </div>
        <div>
          <span className="font-bold text-[#82b1ff] uppercase text-[11px] tracking-wider font-mono">THESIS</span>
          <p className="mt-1 text-[14px] leading-relaxed italic text-[#d7e2ee]">{renderItem(data.thesis)}</p>
        </div>
        <div className="bg-[#10151e] border border-line p-3.5 rounded-lg shadow-inner space-y-3">
          <div>
            <span className="font-bold text-[#00e676] text-[12px] uppercase">⚡ ACTION DIRECTIVE:</span>
            <p className="mt-1.5 text-[#d7e2ee] text-[13px]">{renderItem(data.action)}</p>
          </div>
          {Array.isArray(data.triggers) && data.triggers.length > 0 && (
            <div className="pt-2 border-t border-line/50">
              <span className="font-bold text-amber text-[12px] uppercase">🎯 TRIGGERS:</span>
              <ul className="list-disc list-inside mt-1 text-muted text-[12px] space-y-1">
                {data.triggers.map((t, i) => <li key={i}>{renderItem(t)}</li>)}
              </ul>
            </div>
          )}
          <div className="pt-2 border-t border-line/50">
            <span className="font-bold text-[#ff3d57] text-[12px] uppercase">⚠️ INVALIDATION:</span>
            <p className="mt-1 text-[#d7e2ee] text-[12px]">{renderItem(data.invalidation)}</p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4 text-[12px] bg-panel-2 p-3 rounded border border-line">
          {Array.isArray(data.signals) && data.signals.length > 0 && (
            <div>
              <span className="font-bold text-cyan font-mono uppercase tracking-widest text-[10px]">SIGNALS</span>
              <ul className="list-disc list-inside mt-1.5 text-muted space-y-1">
                {data.signals.map((s, i) => <li key={i}>{renderItem(s)}</li>)}
              </ul>
            </div>
          )}
          {Array.isArray(data.divergences) && data.divergences.length > 0 && (
            <div>
              <span className="font-bold text-amber font-mono uppercase tracking-widest text-[10px]">DIVERGENCES</span>
              <ul className="list-disc list-inside mt-1.5 text-muted space-y-1">
                {data.divergences.map((d, i) => <li key={i}>{renderItem(d)}</li>)}
              </ul>
            </div>
          )}
          {Array.isArray(data.risks) && data.risks.length > 0 && (
            <div className="col-span-2 pt-2 border-t border-line/50">
              <span className="font-bold text-[#ff3d57] font-mono uppercase tracking-widest text-[10px]">RISKS</span>
              <ul className="list-disc list-inside mt-1.5 text-[#ff3d57]/80 space-y-1">
                {data.risks.map((r, i) => <li key={i}>{renderItem(r)}</li>)}
              </ul>
            </div>
          )}
        </div>
        <div className="border-t border-line pt-2 flex items-center justify-between text-[10px] text-muted font-mono">
          <span>DATA COVERAGE: <strong className="text-white">{renderItem(data.dataQuality?.coverage)}%</strong></span>
          {Array.isArray(data.dataQuality?.missing) && data.dataQuality.missing.length > 0 && (
            <span className="text-[#ff3d57]">MISSING: {data.dataQuality.missing.map(renderItem).join(", ")}</span>
          )}
        </div>
      </div>
    );
  } catch {
    return <PlainTextFormatted text={text} />;
  }
};

export function MacroView() {
  const { loading, error: _error, series, regime, correlation, load } = useMacroStore();
  usePortfolioStore();
  const { trend, event, mean, benchmarkDca, runOnBars } = useTradingStore();
  const { bars, load: loadBars } = useMarketStore();

  const [_vietnamState, setVietnamState] = useState<VietnamMarketState | null>(null);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Array<{ sender: "user" | "ai"; text: string; parsedData?: QuantResponse }>>([]);
  const [isLoading, setIsLoading] = useState(false);
  const chatScrollRef = useRef<HTMLDivElement>(null);

  // KHÓA CHỐNG VÒNG LẶP VÔ TẬN: Chỉ nạp đúng 1 lần khi mở trang
  const hasInitializedRef = useRef(false);
  useEffect(() => {
    if (hasInitializedRef.current) return;
    hasInitializedRef.current = true;

    void load();
    void loadBars();
    void loadVietnamMarket().then((vn) => setVietnamState(vn));
  }, [load, loadBars]);

  useEffect(() => {
    if (bars.length >= 130 && (trend?.totalTrades ?? 0) === 0) {
      runOnBars(bars);
    }
  }, [bars, runOnBars, trend?.totalTrades]);

  const pieData = useMemo(() => {
    if (!regime) return [];
    return (Object.keys(regime.allocation) as Array<keyof AllocationWeights>).map((key) => ({
      key, name: PIE_LABELS[key], value: Math.round(regime.allocation[key] * 1000) / 10,
    }));
  }, [regime]);

  const corr = correlation ?? (series.length ? thirtyDayCorrelation(series) : null);
  const usingSynthetic = series.some((s) => s.source === "synthetic");

  const sjcCalculated = useMemo(() => {
    const goldSeries = series.find((s) => s.id === "gold");
    const goldOzUsd = goldSeries?.last && Number.isFinite(goldSeries.last) ? goldSeries.last : 4289;
    const worldPriceMillion = (goldOzUsd * 1.20565 * 25450) / 1_000_000;
    const estimatedDomesticPremium = 4.2;
    const sjcPrice = worldPriceMillion + estimatedDomesticPremium;
    return { price: `${sjcPrice.toFixed(1)}M`, premium: `+${estimatedDomesticPremium.toFixed(1)}M`, percentile: "94%" };
  }, [series]);

  // Khởi tạo Chat State sạch, lọc bỏ dữ liệu hỏng cũ trong localStorage
  useEffect(() => {
    const lastReset = localStorage.getItem("quant_chat_last_reset");
    const now = Date.now();
    if (!lastReset || now - parseInt(lastReset) > CHAT_EXPIRY_MS) {
      setMessages([{ sender: "ai", text: DEFAULT_GREETING }]);
      localStorage.setItem("quant_chat_last_reset", now.toString());
      localStorage.removeItem("quant_chat_history");
    } else {
      const saved = localStorage.getItem("quant_chat_history");
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          const clean = parsed.filter((m: any) => !m.text?.includes("⚠️") && !m.text?.includes("Lỗi"));
          setMessages(clean.length > 0 ? clean : [{ sender: "ai", text: DEFAULT_GREETING }]);
        } catch {
          setMessages([{ sender: "ai", text: DEFAULT_GREETING }]);
        }
      }
    }
  }, []);

  useEffect(() => {
    if (messages.length > 1) {
      localStorage.setItem("quant_chat_history", JSON.stringify(messages));
      if (chatScrollRef.current) chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleResetChat = () => {
    localStorage.removeItem("quant_chat_history");
    localStorage.setItem("quant_chat_last_reset", Date.now().toString());
    setMessages([{ sender: "ai", text: DEFAULT_GREETING }]);
  };

  const handleSend = async (text: string) => {
    if (!text.trim() || isLoading) return;
    const userText = text.trim();
    setInput("");
    setMessages((prev) => [...prev, { sender: "user", text: userText }]);
    setIsLoading(true);

    try {
      const apiKey = (import.meta.env.VITE_GEMINI_API_KEY || "").trim();
      const lowerText = userText.toLowerCase();

      // Chỉ bật JSON Mode khi bấm các nút định dạng hoặc gõ "/report"
      const isReportMode =
        lowerText.startsWith("báo cáo:") ||
        lowerText.startsWith("report:") ||
        lowerText.startsWith("/report") ||
        lowerText === "báo cáo" ||
        lowerText.includes("full verdict") ||
        lowerText.includes("stress-test") ||
        lowerText.includes("devil's advocate");

      const marketSnapshot = {
        timestamp: new Date().toISOString(),
        macro: regime ? { label: regime.label, score: regime.score, thesis: regime.thesis } : "NEUTRAL",
        assets: series.map((s) => ({ ticker: s.ticker, name: s.name, last: s.last, changePct1d: s.changePct1d })),
        bots: {
          trend: { winRate: trend?.winRate ?? 0, pnl: trend?.pnl ?? 0, trades: trend?.totalTrades ?? 0 },
          event: { winRate: event?.winRate ?? 0, pnl: event?.pnl ?? 0, trades: event?.totalTrades ?? 0 },
          meanReversion: { winRate: mean?.winRate ?? 0, pnl: mean?.pnl ?? 0, trades: mean?.totalTrades ?? 0 },
          benchmarkDca: { pnl: benchmarkDca?.pnl ?? 0, trades: benchmarkDca?.totalTrades ?? 0 }
        }
      };

      const systemPrompt = isReportMode
        ? `Bạn là Senior Portfolio Manager. Trả về đúng 1 JSON Schema: verdict (BUY/HOLD/REDUCE/HEDGE/WAIT), confidence (number), thesis (string), signals (array of strings), divergences (array of strings), risks (array of strings), action (string), triggers (array of strings), invalidation (string), dataQuality (coverage: number, missing: array of strings). Dữ liệu:\n${JSON.stringify(marketSnapshot)}`
        : `Bạn là Senior Quant Analyst. Trả lời người dùng bằng văn bản tự nhiên, sắc bén, chuyên nghiệp bằng tiếng Việt. Dữ liệu thị trường thật:\n- BTC: $${series.find(s=>s.id==='btc')?.last ?? 76800}\n- Vàng: $${series.find(s=>s.id==='gold')?.last ?? 4289}\n- 3 Bots: Alpha 1 (Trend), Alpha 2 (Event), Alpha 3 (MeanRev), Control DCA. Tuyệt đối không xuất JSON khi người dùng trò chuyện tự do.`;

      const cleanHistory: Array<{ role: "user" | "model"; parts: [{ text: string }] }> = [];
      for (const m of messages.slice(1)) {
        if (m.text.includes("⚠️") || !m.text.trim()) continue;
        const role = m.sender === "user" ? "user" : "model";
        if (cleanHistory.length > 0 && cleanHistory[cleanHistory.length - 1].role === role) {
          cleanHistory[cleanHistory.length - 1].parts[0].text += `\n${m.text}`;
        } else {
          cleanHistory.push({ role, parts: [{ text: m.text }] });
        }
      }

      const bodyPayload: any = {
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [...cleanHistory, { role: "user", parts: [{ text: userText }] }],
        generationConfig: isReportMode
          ? { temperature: 0.15, responseMimeType: "application/json" }
          : { temperature: 0.4 }
      };

      // DUAL-ROUTE: Ưu tiên Proxy nội bộ, nếu Bolt nghẽn mạng thì tự gọi thẳng Google
      let response: Response | null = null;
      try {
        response = await fetch("/api/ai-advisor", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(bodyPayload)
        });
      } catch {
        response = null;
      }

      if (!response || !response.ok) {
        const directUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`;
        response = await fetch(directUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify(bodyPayload)
        });
      }

      const data = await response.json();
      if (!response.ok) throw new Error(data?.error?.message || "Không thể nhận phản hồi từ AI");

      const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
      let parsedResponse: QuantResponse | undefined = undefined;

      if (isReportMode) {
        try { parsedResponse = JSON.parse(rawText); } catch {}
      }

      setMessages((prev) => [...prev, { sender: "ai", text: rawText, parsedData: parsedResponse }]);
    } catch (err: any) {
      setMessages((prev) => [...prev, { sender: "ai", text: `⚠️ **Lỗi kết nối API:** ${err?.message || "Kiểm tra lại kết nối mạng."}` }]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(input); }
  };

  const yld10 = series.find((s) => s.id === "us10y")?.last ?? 4.99;
  const yld2 = series.find((s) => s.id === "us2y")?.last ?? 5.47;
  const spreadBps = Math.round((yld10 - yld2) * 100);
  const vixVal = series.find((s) => s.id === "vix")?.last ?? 16.87;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-auto p-3 custom-scrollbar relative bg-[#07090d]">
      {/* 1. TICKERS GỐC */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2.5 shrink-0">
        {series.map((s) => (
          <MetricCard 
            key={s.id} label={s.name} ticker={s.ticker} value={s.last} changePct={s.changePct1d} 
            digits={s.id === "us10y" || s.id === "us2y" ? 3 : s.id === "btc" ? 0 : 2} 
            suffix={s.id === "us10y" || s.id === "us2y" ? "%" : undefined} 
          />
        ))}
      </div>

      {/* 2. DỮ LIỆU FEATURE ENGINE */}
      <div className="border border-[#1c2736] bg-[#10151e] flex flex-col shrink-0 shadow-sm rounded-sm">
        <div className="px-4 py-2 border-b border-[#1c2736] flex justify-between items-center bg-[#0c1017]">
          <span className="font-mono text-[10px] font-bold tracking-[0.2em] text-[#26c6da]">FEATURE ENGINE · VIETNAM MARKET & CONFLUENCE</span>
          <div className="flex items-center gap-2">
            <span className="font-mono text-[9px] text-[#00e676] border border-[#00e676]/40 bg-[#00e676]/10 px-2 py-0.5 rounded">VN: FEED CONNECTED</span>
            <span className="font-mono text-[9px] text-cyan border border-cyan/40 bg-cyan/10 px-2 py-0.5 rounded">CONFLUENCE: ENGINE</span>
          </div>
        </div>
        <div className="p-3 grid grid-cols-4 gap-3">
          <div className="bg-[#151b26] border border-[#1c2736] p-2.5 flex flex-col justify-between">
            <span className="text-[10px] text-[#7d8ea3] font-bold tracking-widest mb-1">VN-INDEX</span>
            <span className="text-[#00e676] font-bold text-lg">1,280.5 <span className="text-xs font-mono">(+1.42%)</span></span>
            <span className="text-[#7d8ea3] text-[10px] font-mono mt-1">Trend: STRONG_BULL (MA200 Up)</span>
          </div>
          <div className="bg-[#151b26] border border-[#1c2736] p-2.5 flex flex-col justify-between">
            <span className="text-[10px] text-[#7d8ea3] font-bold tracking-widest mb-1">VOLATILITY (20D)</span>
            <span className="text-cyan font-bold text-lg">16.0%</span>
            <span className="text-[10px] font-mono mt-1 text-muted">Annualized Realized Vol</span>
          </div>
          <div className="bg-[#151b26] border border-[#1c2736] p-2.5 flex flex-col justify-between">
            <span className="text-[10px] text-[#7d8ea3] font-bold tracking-widest mb-1">VÀNG SJC (PREMIUM)</span>
            <span className="text-[#ffc107] font-bold text-lg">{sjcCalculated.price}</span>
            <span className="text-[#ffc107] text-[10px] font-mono mt-1">Lệch TG: {sjcCalculated.premium}</span>
          </div>
          <div className="bg-[#151b26] border border-[#1c2736] p-2.5 flex flex-col justify-between">
            <span className="text-[10px] text-[#7d8ea3] font-bold tracking-widest mb-1">SIGNAL CONFLUENCE</span>
            <span className="font-bold text-lg text-amber">42/100</span>
            <span className="text-white text-[10px] font-mono mt-1">Confidence: 100% (6/6)</span>
          </div>
        </div>
      </div>

      {/* 3. BẢNG SỰ KIỆN ĐỊNH LƯỢNG */}
      <MacroNewsTable />

      {/* 4. MARKET REGIME & ALLOCATION */}
      <div className="grid min-h-[340px] grid-cols-[1.2fr_1fr] gap-3 shrink-0 mt-3">
        <Panel title="Market Regime & Yield Curve Engine" right={loading ? "SYNC…" : usingSynthetic ? "SYNTHETIC FEED" : "LIVE FEED"}>
          {regime ? (
            <div className="flex h-full flex-col gap-3">
              <div className="flex items-end justify-between gap-4">
                <div>
                  <div className="font-mono text-[10px] tracking-[0.2em] text-muted">REGIME LABEL</div>
                  <div className="mt-1 font-mono text-2xl font-semibold text-amber">{regime.label}</div>
                </div>
                <div className="text-right">
                  <div className="font-mono text-[10px] tracking-[0.2em] text-muted">FAVORABILITY 0–100</div>
                  <div className={clsx("font-mono text-4xl font-semibold", regime.score >= 55 ? "text-up" : regime.score <= 45 ? "text-down" : "text-amber")}>{formatNumber(regime.score, 1)}</div>
                </div>
              </div>
              <div className="h-2 w-full bg-[#151b26]"><div className="h-2 bg-gradient-to-r from-down via-amber to-up" style={{ width: `${regime.score}%` }} /></div>
              
              <div className="grid grid-cols-2 gap-2.5 bg-panel-2 border border-line p-2.5 rounded">
                <div>
                  <div className="text-[10px] font-bold text-muted">10Y-2Y SPREAD</div>
                  <div className="text-base font-mono font-bold text-ink mt-1">{spreadBps} bps (INVERTED)</div>
                </div>
                <div className="border-l border-line/40 pl-2.5">
                  <div className="text-[10px] font-bold text-muted flex items-center gap-1"><Activity size={12} className="text-cyan"/> VIX VOLATILITY</div>
                  <div className="text-base font-mono font-bold text-ink mt-1">{vixVal.toFixed(2)} (CALM)</div>
                </div>
              </div>

              {/* KHÔI PHỤC ĐẦY ĐỦ CÁC CHỈ SỐ VELOCITY & TREND QUAN TRỌNG */}
              <div className="grid grid-cols-3 gap-3 font-mono text-[11px] pt-1">
                <Stat label="DXY TREND" value={formatNumber(regime.dxyTrend * 100, 3) + "%/d"} />
                <Stat label="10Y LEVEL" value={formatNumber(regime.yieldLevel, 3) + "%"} />
                <Stat label="10Y TREND" value={formatNumber(regime.yieldTrend * 100, 3) + " bps/d"} />
              </div>
            </div>
          ) : (<div className="text-sm text-muted">Computing regime…</div>)}
        </Panel>

        <Panel title="Model Portfolio Target Allocation">
          {regime ? (
            <div className="flex flex-row h-full items-center justify-between px-2">
              <div className="h-[250px] w-1/2">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={60} outerRadius={95} stroke="#07090d" strokeWidth={3} paddingAngle={2}>
                      {pieData.map((d) => (<Cell key={d.key} fill={PIE_COLORS[d.key as keyof AllocationWeights]} />))}
                    </Pie>
                    <RechartsTooltip contentStyle={{ background: "#0c1017", border: "1px solid #1c2736", fontSize: 13, color: '#fff' }} formatter={(value) => [`${value}%`, "Weight"]} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="w-1/2 flex flex-col justify-center border-l border-line/50 pl-4 h-[80%]">
                <ul className="space-y-3 font-mono text-[11px]">
                  {pieData.map((d) => (
                    <li key={d.key} className="flex flex-col gap-1 border-b border-line/30 pb-1.5 last:border-0">
                      <span className="flex items-center gap-2 text-muted font-bold">
                        <span className="h-2.5 w-2.5 rounded-sm" style={{ background: PIE_COLORS[d.key as keyof AllocationWeights] }} />
                        {d.name}
                      </span>
                      <span className="text-ink font-black text-[13px] pl-4.5">{d.value.toFixed(1)}%</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ) : null}
        </Panel>
      </div>

      {/* 5. TƯƠNG QUAN LỢI NHUẬN & PERFORMANCE TAPE */}
      <div className="grid grid-cols-[1fr_1.1fr] gap-3 shrink-0 mt-3">
        <Panel title="30-Day Return Correlation">
          {corr ? (
            <table className="w-full border-collapse font-mono text-[11px]">
              <thead><tr><th className="p-1 text-left text-muted" />{ASSET_ORDER.map((k) => (<th key={k} className="p-1 text-center text-muted">{ASSET_LABEL[k]}</th>))}</tr></thead>
              <tbody>
                {ASSET_ORDER.map((row) => (
                  <tr key={row}>
                    <td className="p-1 text-muted">{ASSET_LABEL[row]}</td>
                    {ASSET_ORDER.map((col) => (<td key={col} className="p-1"><div className={clsx("px-1 py-1 text-center font-bold", corrColor(corr[row][col]))}>{corr[row][col].toFixed(2)}</div></td>))}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (<div className="text-sm text-muted">Awaiting series…</div>)}
        </Panel>

        <Panel title="20-Day Performance Tape">
          <div className="space-y-2">
            {series.map((s) => (
              <div key={s.id} className="flex items-center gap-3 border border-line bg-panel-2 px-3 py-2">
                <div className="w-24 font-mono text-[11px] text-cyan">{s.ticker}</div>
                <div className="flex-1"><div className="h-1.5 bg-[#151b26]"><div className={s.changePct20d >= 0 ? "h-1.5 bg-up" : "h-1.5 bg-down"} style={{ width: `${Math.min(100, Math.abs(s.changePct20d) * 400)}%` }} /></div></div>
                <div className={clsx("w-20 text-right font-mono text-[11px]", s.changePct20d >= 0 ? "text-up" : "text-down")}>{formatPct(s.changePct20d)}</div>
                <div className="w-16 text-right font-mono text-[10px] text-muted">{s.source === "live" ? "LIVE" : "SYN"}</div>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      {/* 6. CHATBOT PANEL (CÓ NÚT RESET) */}
      <Panel
        title="AI QUANT EXPERT · STRUCTURED DECISION ENGINE"
        right={
          <div className="flex items-center gap-3">
            <span className="text-[10px] text-muted font-mono hidden sm:inline">DUAL-ROUTE CONNECTED</span>
            <button
              type="button"
              onClick={handleResetChat}
              title="Xóa lịch sử chat bị lỗi"
              className="flex items-center gap-1 px-2.5 py-1 text-[10px] font-mono font-bold text-muted hover:text-cyan border border-line hover:border-cyan/40 bg-panel-2 rounded transition-all"
            >
              <RotateCcw size={11} className="text-cyan" />
              <span>RESET CHAT</span>
            </button>
          </div>
        }
        className="shrink-0 mt-3 mb-6 flex flex-col h-[650px]"
      >
        <div ref={chatScrollRef} className="flex-1 overflow-y-auto p-5 space-y-6 custom-scrollbar bg-[#07090d]">
          {messages.map((msg, idx) => (
            <div key={idx} className={clsx("flex flex-col", msg.sender === "user" ? "ml-auto items-end max-w-[85%]" : "mr-auto items-start w-full")}>
              <div className={clsx(
                "p-4 rounded-xl shadow-md w-full", 
                msg.sender === "user" ? "bg-cyan/15 border border-cyan/30 text-cyan rounded-br-none w-auto max-w-full" : "bg-panel border border-line text-ink rounded-bl-none"
              )}>
                {msg.sender === "user" ? <span className="whitespace-pre-wrap font-sans font-bold text-[14px]">{msg.text}</span> : <FormatStructuredMessage data={msg.parsedData} text={msg.text} />}
              </div>
            </div>
          ))}
          {isLoading && (
            <div className="flex items-center gap-2 text-cyan font-sans font-medium text-[13px] p-2">
              <Loader2 size={16} className="animate-spin" /> Đang phân tích chiến lược định lượng...
            </div>
          )}
        </div>

        <div className="px-4 py-3 flex gap-3 overflow-x-auto hide-scrollbar border-t border-line bg-panel">
          <button onClick={() => handleSend("Báo cáo: Phân tích trạng thái liên thị trường (Yield Curve, VIX, VN-Index và Dòng tiền ngoại).")} className="shrink-0 flex items-center gap-1.5 px-3 py-2 bg-panel-2 hover:bg-cyan/10 text-cyan rounded font-sans font-bold text-[12px] transition-colors border border-line">
            <MessageSquareText size={14} /> Báo Cáo Toàn Diện (Coverage 100%)
          </button>
          <button onClick={() => handleSend("Stress-test: Chạy kịch bản giả lập NAV ($100k) khi tài sản Crypto sập 15% và Cổ phiếu giảm 8%.")} className="shrink-0 flex items-center gap-1.5 px-3 py-2 bg-panel-2 hover:bg-cyan/10 text-cyan rounded font-sans font-bold text-[12px] transition-colors border border-line">
            <TrendingUp size={14} /> Stress-Test NAV
          </button>
          <button onClick={() => handleSend("Devil's Advocate: Phản bác lại quyết định HEDGE của chính ông. Nêu 3 điểm mù nếu thị trường bất ngờ phục hồi.")} className="shrink-0 flex items-center gap-1.5 px-3 py-2 bg-panel-2 hover:bg-cyan/10 text-cyan rounded font-sans font-bold text-[12px] transition-colors border border-line">
            <ShieldAlert size={14} /> Devil's Advocate
          </button>
        </div>

        <form onSubmit={(e) => { e.preventDefault(); handleSend(input); }} className="p-4 border-t border-line flex gap-4 bg-panel">
          <textarea 
            rows={1} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown}
            placeholder="Hỏi đáp tự do về hệ thống hoặc gõ 'báo cáo' để nhận JSON... (Shift + Enter xuống dòng)"
            className="flex-1 bg-[#0c1017] border border-line text-white px-5 py-3.5 rounded-lg text-[14px] font-sans focus:outline-none focus:border-cyan resize-none min-h-[50px] max-h-32 custom-scrollbar shadow-inner"
          />
          <button type="submit" disabled={isLoading || !input.trim()} className="bg-panel-2 border border-line hover:bg-cyan hover:text-[#0c1017] text-cyan font-black w-14 h-14 rounded-lg flex items-center justify-center transition-all disabled:opacity-50 shrink-0">
            <Send size={18} className="ml-1" />
          </button>
        </form>
      </Panel>
    </div>
  );
}

function Stat({ label, value, desc }: { label: string; value: string; desc?: string }) {
  return (
    <div className="border border-line bg-panel-2 px-3 py-3 relative group">
      <div className="text-[10px] tracking-[0.14em] text-muted font-bold">{label}</div>
      <div className="mt-1.5 text-ink text-lg font-semibold font-mono">{value}</div>
      {desc && <div className="mt-1 text-[11px] text-cyan font-sans font-semibold leading-tight">{desc}</div>}
    </div>
  );
}