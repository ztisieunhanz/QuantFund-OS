// ============================================================================
// FILE: src/views/MacroViewV2.tsx
// MODULE: MACRO V2 PRESENTATION SCREEN (GATE M4 STRANGLER MIGRATION)
// PRINCIPLE: Single Source of Truth via CurrentMarketSnapshot (DEC-008, DEC-010)
// ============================================================================

import { useEffect, useState, useRef } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  HelpCircle,
  Info,
  Loader2,
  RefreshCw,
  Send,
  ShieldAlert,
  TrendingDown,
  TrendingUp,
  XCircle,
} from "lucide-react";
import { Panel } from "@/components/ui/Panel";
import { clsx } from "@/lib/clsx";
import { buildGroundedChatbotSystemPrompt } from "@/lib/macro/chatbotGrounding";
import { formatGoldLabel } from "@/lib/macro/helpers";
import type {
  AvailableMacroDatum,
  MacroDatum,
  MarketStance,
  SynthesisStatus,
  UnavailableMacroDatum,
} from "@/lib/macro/types";
import { useSnapshotStore } from "@/stores/snapshotStore";

function formatTimestamp(asOf?: number | null): string {
  if (!asOf || !Number.isFinite(asOf)) return "N/A";
  const date = new Date(asOf);
  if (
    date.getUTCHours() === 0 &&
    date.getUTCMinutes() === 0 &&
    date.getUTCSeconds() === 0 &&
    date.getUTCMilliseconds() === 0
  ) {
    return date.toISOString().slice(0, 10);
  }
  return date.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function StanceBadge({ stance }: { stance: MarketStance }) {
  switch (stance) {
    case "RISK_ON":
      return (
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-mono font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/40">
          <TrendingUp size={14} /> RISK_ON
        </span>
      );
    case "RISK_OFF":
      return (
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-mono font-bold bg-rose-500/20 text-rose-400 border border-rose-500/40">
          <TrendingDown size={14} /> RISK_OFF
        </span>
      );
    case "DEFENSIVE":
      return (
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-mono font-bold bg-amber-500/20 text-amber-400 border border-amber-500/40">
          <ShieldAlert size={14} /> DEFENSIVE
        </span>
      );
    case "MIXED":
      return (
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-mono font-bold bg-purple-500/20 text-purple-400 border border-purple-500/40">
          <Activity size={14} /> MIXED
        </span>
      );
    case "NEUTRAL":
      return (
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-mono font-bold bg-slate-500/20 text-slate-300 border border-slate-500/40">
          <Info size={14} /> NEUTRAL
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-mono font-bold bg-slate-800 text-slate-400 border border-slate-700">
          <HelpCircle size={14} /> UNDETERMINED
        </span>
      );
  }
}

function StatusBadge({ status }: { status: SynthesisStatus }) {
  switch (status) {
    case "AVAILABLE":
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded text-[11px] font-mono font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
          <CheckCircle2 size={12} /> AVAILABLE
        </span>
      );
    case "PARTIAL":
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded text-[11px] font-mono font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/30">
          <AlertTriangle size={12} /> PARTIAL
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded text-[11px] font-mono font-semibold bg-rose-500/10 text-rose-400 border border-rose-500/30">
          <XCircle size={12} /> INSUFFICIENT_DATA
        </span>
      );
  }
}

function QualityBadge({ quality }: { quality: string }) {
  if (quality === "USABLE") {
    return <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400 font-bold">USABLE</span>;
  }
  if (quality === "DEGRADED") {
    return <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 font-bold">DEGRADED</span>;
  }
  if (quality === "STALE") {
    return <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-400 font-bold">STALE</span>;
  }
  return <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 font-bold">UNAVAILABLE</span>;
}

function ProvenanceBadge({ classification }: { classification: string }) {
  if (classification === "LIVE") {
    return <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-cyan/20 text-cyan border border-cyan/30 font-bold">LIVE</span>;
  }
  if (classification === "DERIVED") {
    return <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300 font-bold">DERIVED</span>;
  }
  if (classification === "SYNTHETIC") {
    return <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 font-bold">SYNTHETIC</span>;
  }
  return <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 font-bold">UNAVAILABLE</span>;
}

export function MacroViewV2() {
  const { snapshot, loading, refreshSnapshot } = useSnapshotStore();
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<Array<{ sender: "user" | "ai"; text: string }>>([
    {
      sender: "ai",
      text: "Xin chào! Tôi là **AI Quant Advisor V2**. Dữ liệu `CurrentMarketSnapshot` đã được đồng bộ hóa thành công. Bạn cần tôi phân tích góc nhìn vĩ mô hay kiểm tra tín hiệu gì?",
    },
  ]);
  const [chatLoading, setChatLoading] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!snapshot) {
      void refreshSnapshot();
    }
  }, [snapshot, refreshSnapshot]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages]);

  const handleSendChat = async (userText: string) => {
    if (!userText.trim() || chatLoading || !snapshot) return;
    const text = userText.trim();
    setChatInput("");
    setChatMessages((prev) => [...prev, { sender: "user", text }]);
    setChatLoading(true);

    try {
      const apiKey = (import.meta.env.VITE_GEMINI_API_KEY || "").trim();
      if (!apiKey) throw new Error("Missing VITE_GEMINI_API_KEY");

      const systemPrompt = buildGroundedChatbotSystemPrompt(snapshot);
      const apiContents = [
        { role: "user", parts: [{ text: systemPrompt }] },
        { role: "model", parts: [{ text: "Đã hiểu. Tôi sẽ phân tích dựa trên dữ liệu CurrentMarketSnapshot được cung cấp." }] },
        ...chatMessages.slice(1).map((m) => ({
          role: m.sender === "user" ? "user" : "model",
          parts: [{ text: m.text }],
        })),
        { role: "user", parts: [{ text }] },
      ];

      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: apiContents,
            generationConfig: { temperature: 0.2 },
          }),
        }
      );

      const data = await res.json();
      const reply =
        data.candidates?.[0]?.content?.parts?.[0]?.text ||
        "Xin lỗi, không thể nhận hồi đáp từ AI lúc này.";

      setChatMessages((prev) => [...prev, { sender: "ai", text: reply }]);
    } catch (err) {
      setChatMessages((prev) => [
        ...prev,
        {
          sender: "ai",
          text: `⚠️ **Lỗi kết nối AI:** ${err instanceof Error ? err.message : "Vui lòng kiểm tra lại API key hoặc mạng."}`,
        },
      ]);
    } finally {
      setChatLoading(false);
    }
  };

  if (loading && !snapshot) {
    return (
      <div className="flex h-full min-h-[500px] flex-col items-center justify-center gap-3 bg-[#07090d] text-slate-300">
        <Loader2 size={36} className="animate-spin text-cyan" />
        <div className="font-mono text-xs tracking-widest text-cyan uppercase">
          Loading Authoritative Market Snapshot (Macro V2)...
        </div>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="flex h-full min-h-[500px] flex-col items-center justify-center gap-3 bg-[#07090d] text-rose-400">
        <AlertTriangle size={36} />
        <div className="font-mono text-sm font-bold">Failed to load CurrentMarketSnapshot</div>
        <button
          onClick={() => void refreshSnapshot()}
          className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded font-mono text-xs"
        >
          Retry Load
        </button>
      </div>
    );
  }

  const { data, macro, quant, risk, omega, synthesis } = snapshot;

  const dataMetrics: Array<{ id: string; label: string; datum: MacroDatum<unknown> }> = [
    { id: "dxy", label: "US Dollar Index (DXY)", datum: data.dxy },
    { id: "us2y", label: "US 2-Year Treasury Yield", datum: data.us2y },
    { id: "us10y", label: "US 10-Year Treasury Yield", datum: data.us10y },
    { id: "vix", label: "CBOE Volatility Index (VIX)", datum: data.vix },
    { id: "gold", label: formatGoldLabel(data.gold), datum: data.gold },
    { id: "btc", label: "Bitcoin Spot (BTC)", datum: data.btc },
    { id: "vnindex", label: "VN-Index", datum: data.vnindex },
    { id: "breadth", label: "Vietnam Market Breadth", datum: data.breadth },
    { id: "liquidity", label: "Vietnam Market Liquidity", datum: data.liquidity },
    { id: "foreignFlow", label: "Vietnam Foreign Net Flow", datum: data.foreignFlow },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-auto p-4 bg-[#07090d] text-slate-100 custom-scrollbar font-sans">
      {/* HEADER BAR */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#1c2736] pb-3 shrink-0">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-bold text-white tracking-wide">Macro V2 Intelligence & Decision Synthesis</h1>
            <StatusBadge status={synthesis?.status ?? "INSUFFICIENT_DATA"} />
          </div>
          <p className="text-xs text-slate-400 mt-0.5">
            Single Source of Truth Grounding (Gate M4 Strangler Architecture) · Evaluated asOf:{" "}
            <span className="font-mono text-cyan">{formatTimestamp(snapshot.timestamp)}</span>
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => void refreshSnapshot()}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-[#151b26] hover:bg-[#1c2736] border border-[#2a384c] text-xs font-mono text-cyan rounded transition-colors disabled:opacity-50"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
            REFRESH SNAPSHOT
          </button>
        </div>
      </div>

      {/* 1. SECTION A: MARKET ASSESSMENT (4 QUESTIONS - WHAT IS HAPPENING / WHAT MODEL THINKS) */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3 shrink-0">
        <Panel title="Market Stance" className="bg-[#0f141d] border-[#1c2736]">
          <div className="flex flex-col justify-between h-full py-1">
            <div className="text-2xl font-black font-mono tracking-wider mt-1">
              <StanceBadge stance={synthesis?.stance ?? "UNDETERMINED"} />
            </div>
            <div className="text-[11px] text-slate-400 mt-2">
              Status: <span className="font-mono font-bold text-white">{synthesis?.status}</span>
            </div>
          </div>
        </Panel>

        <Panel title="Synthesis Confidence" className="bg-[#0f141d] border-[#1c2736]">
          <div className="flex flex-col justify-between h-full py-1">
            <div className="text-3xl font-black font-mono text-cyan">
              {synthesis?.confidence != null ? `${synthesis.confidence}/100` : "N/A"}
            </div>
            <div className="text-[11px] text-slate-400 mt-2">
              {synthesis?.status === "PARTIAL" ? "Capped (Partial Availability)" : "Cross-layer agreement score"}
            </div>
          </div>
        </Panel>

        <Panel title="Data Coverage" className="bg-[#0f141d] border-[#1c2736]">
          <div className="flex flex-col justify-between h-full py-1">
            <div className="text-3xl font-black font-mono text-emerald-400">
              {synthesis ? `${Math.round(synthesis.dataCoverage * 100)}%` : "0%"}
            </div>
            <div className="text-[11px] text-slate-400 mt-2">
              Usable Core Metrics: <span className="font-mono text-white">{macro?.coverage.usable ?? 0}/{macro?.coverage.totalCore ?? 6}</span>
            </div>
          </div>
        </Panel>

        <Panel title="Primary Headline" className="bg-[#0f141d] border-[#1c2736]">
          <div className="flex flex-col justify-between h-full py-1">
            <p className="text-xs font-semibold leading-relaxed text-slate-200">
              {synthesis?.headline ?? "Evaluating market snapshot..."}
            </p>
          </div>
        </Panel>
      </div>

      {/* 2. SECTION B: WHY? (SUPPORTING & CONFLICTING EVIDENCE) */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 shrink-0">
        <Panel title="Supporting Cross-Layer Evidence (Why Risk-On / Defensive)">
          {synthesis && synthesis.supportingEvidence.length > 0 ? (
            <ul className="space-y-2 text-xs">
              {synthesis.supportingEvidence.map((ev) => (
                <li key={ev.id} className="flex items-start gap-2 bg-[#121824] border border-[#1c2736] p-2.5 rounded">
                  <span className="font-mono text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400 shrink-0">
                    {ev.layer}
                  </span>
                  <span className="text-slate-300 leading-tight">{ev.description}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-xs text-slate-500 italic py-2">No supporting evidence items recorded.</div>
          )}
        </Panel>

        <Panel title="Conflicting Cross-Layer Evidence (Surfaced Contradictions)">
          {synthesis && synthesis.conflictingEvidence.length > 0 ? (
            <ul className="space-y-2 text-xs">
              {synthesis.conflictingEvidence.map((ev) => (
                <li key={ev.id} className="flex items-start gap-2 bg-[#1b1520] border border-[#3b1d28] p-2.5 rounded">
                  <span className="font-mono text-[10px] font-bold px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-400 shrink-0">
                    {ev.layer}
                  </span>
                  <span className="text-slate-300 leading-tight">{ev.description}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-xs text-slate-500 italic py-2">No cross-layer conflicts detected.</div>
          )}
        </Panel>
      </div>

      {/* 3. SECTION C, D, E, F: MACRO, QUANT, RISK, OMEGA DETAILS */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-3 shrink-0">
        {/* MACRO */}
        <Panel title="Macro Intelligence (Layer 1 & 2)">
          <div className="space-y-2.5 text-xs">
            <div className="flex justify-between items-center border-b border-[#1c2736] pb-1.5">
              <span className="text-slate-400 font-mono text-[11px]">Macro Regime:</span>
              <span className="font-mono font-bold text-amber">{macro?.regime ?? "INSUFFICIENT_DATA"}</span>
            </div>
            <div className="flex justify-between items-center border-b border-[#1c2736] pb-1.5">
              <span className="text-slate-400 font-mono text-[11px]">Macro Confidence:</span>
              <span className="font-mono text-white">{macro?.confidence != null ? `${macro.confidence}/100` : "N/A"}</span>
            </div>
            <div>
              <span className="text-[11px] text-slate-400 font-mono block mb-1">Usable Metrics:</span>
              <div className="flex flex-wrap gap-1">
                {macro?.usableMetrics.map((m) => (
                  <span key={m} className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                    {m}
                  </span>
                )) || <span className="text-slate-500 italic">None</span>}
              </div>
            </div>
            {macro && (macro.unavailableMetrics.length > 0 || macro.staleMetrics.length > 0) && (
              <div className="pt-1">
                <span className="text-[11px] text-rose-400 font-mono block mb-1">Unavailable / Stale:</span>
                <div className="flex flex-wrap gap-1">
                  {[...macro.unavailableMetrics, ...macro.staleMetrics].map((m) => (
                    <span key={m} className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-rose-500/10 text-rose-400 border border-rose-500/20">
                      {m}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </Panel>

        {/* QUANT */}
        <Panel title="Quant Alpha Engine (Layer 2 Telemetry)">
          <div className="space-y-2 text-xs">
            <div className="border-b border-[#1c2736] pb-1.5">
              <span className="text-slate-400 font-mono text-[10px] block">STRONGEST SIGNAL:</span>
              <span className="font-mono font-bold text-cyan text-xs">
                {quant?.strongestStrategyId ?? "None"}
              </span>
              <p className="text-[9px] text-slate-500 mt-0.5 italic leading-tight">
                *Defined strictly as largest absolute currently valid normalized alpha signal.
              </p>
            </div>
            <div className="space-y-1.5 pt-1">
              {quant?.strategies.map((st) => (
                <div key={st.id} className="flex justify-between items-center bg-[#121824] px-2 py-1.5 rounded text-[11px] font-mono">
                  <span className="text-slate-300 font-medium">{st.id}</span>
                  <span className={clsx("font-bold", st.signal != null && st.signal > 0 ? "text-emerald-400" : st.signal != null && st.signal < 0 ? "text-rose-400" : "text-slate-400")}>
                    {st.signal != null ? (st.signal > 0 ? `+${st.signal.toFixed(2)}` : st.signal.toFixed(2)) : "EXPIRED"}
                  </span>
                </div>
              ))}
              {(!quant || quant.strategies.length === 0) && (
                <div className="text-slate-500 italic text-[11px]">No quant strategy signals active.</div>
              )}
            </div>
          </div>
        </Panel>

        {/* RISK */}
        <Panel title="Risk Engine (Layer 2 Limits)">
          <div className="space-y-2.5 text-xs">
            <div className="flex justify-between items-center border-b border-[#1c2736] pb-1.5">
              <span className="text-slate-400 font-mono text-[11px]">Risk State:</span>
              <span className={clsx("font-mono font-bold", risk?.riskState === "TRIPPED" ? "text-rose-400" : risk?.riskState === "WARNING" ? "text-amber" : "text-emerald-400")}>
                {risk?.riskState ?? "UNAVAILABLE"}
              </span>
            </div>
            <div className="flex justify-between items-center border-b border-[#1c2736] pb-1.5">
              <span className="text-slate-400 font-mono text-[11px]">Target Exposure:</span>
              <span className="font-mono text-white">{risk?.allowedExposure != null ? `${(risk.allowedExposure * 100).toFixed(0)}%` : "N/A"}</span>
            </div>
            <div className="flex justify-between items-center border-b border-[#1c2736] pb-1.5">
              <span className="text-slate-400 font-mono text-[11px]">Gross Exposure:</span>
              <span className="font-mono text-white">{risk?.grossExposure != null ? `${(risk.grossExposure * 100).toFixed(0)}%` : "N/A"}</span>
            </div>
            {risk?.note && (
              <div className="text-[10px] text-amber italic bg-amber-500/10 p-1.5 rounded border border-amber-500/20">
                {risk.note}
              </div>
            )}
          </div>
        </Panel>

        {/* OMEGA PAPER */}
        <Panel title="Omega Allocator (Paper Simulation)">
          <div className="space-y-2 text-xs">
            <div className="border-b border-[#1c2736] pb-1.5">
              <span className="text-[10px] font-mono text-purple-400 font-bold block">SOURCE: OMEGA_PAPER</span>
              <span className="text-[10px] text-slate-400">Research & Paper Execution Target Weights Only</span>
            </div>
            {omega && omega.status === "AVAILABLE" && omega.targetWeights ? (
              <ul className="space-y-1.5 font-mono text-[11px]">
                {Object.entries(omega.targetWeights).map(([asset, weight]) => (
                  <li key={asset} className="flex justify-between items-center bg-[#121824] px-2.5 py-1.5 rounded">
                    <span className="text-slate-200 font-bold">{asset}</span>
                    <span className="text-cyan font-bold">{(weight * 100).toFixed(1)}%</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="text-slate-500 italic text-[11px] py-2">
                Omega target weights unavailable or unverified.
              </div>
            )}
          </div>
        </Panel>
      </div>

      {/* 4. SECTION G: DATA PROVENANCE & FRESHNESS TABLE */}
      <Panel title="Truthful Data Provenance Inventory (Layer 1)" className="shrink-0">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse font-mono text-[11px] text-left">
            <thead>
              <tr className="border-b border-[#1c2736] text-slate-400 text-[10px]">
                <th className="py-2 px-3">METRIC</th>
                <th className="py-2 px-3">VALUE</th>
                <th className="py-2 px-3">PROVENANCE</th>
                <th className="py-2 px-3">PROVIDER</th>
                <th className="py-2 px-3">INSTRUMENT</th>
                <th className="py-2 px-3">AS OF</th>
                <th className="py-2 px-3">QUALITY</th>
              </tr>
            </thead>
            <tbody>
              {dataMetrics.map(({ id, label, datum }) => {
                if (!datum || datum.status === "UNAVAILABLE") {
                  const unavail = datum as UnavailableMacroDatum | undefined;
                  return (
                    <tr key={id} className="border-b border-[#151b26] text-slate-500">
                      <td className="py-2 px-3 font-semibold text-slate-300">{label}</td>
                      <td className="py-2 px-3 italic font-bold text-rose-400">UNAVAILABLE</td>
                      <td className="py-2 px-3"><ProvenanceBadge classification="UNAVAILABLE" /></td>
                      <td className="py-2 px-3 text-slate-300">{unavail?.provider ?? "N/A"}</td>
                      <td className="py-2 px-3 text-slate-300">{unavail?.instrument ?? id}</td>
                      <td className="py-2 px-3 text-slate-400">{unavail?.asOf ? formatTimestamp(unavail.asOf) : "N/A"}</td>
                      <td className="py-2 px-3"><QualityBadge quality="UNAVAILABLE" /></td>
                    </tr>
                  );
                }

                const avail = datum as AvailableMacroDatum<unknown>;
                const valDisplay =
                  typeof avail.value === "number"
                    ? avail.value.toLocaleString(undefined, { maximumFractionDigits: 2 })
                    : typeof avail.value === "object" && avail.value !== null
                    ? JSON.stringify(avail.value).slice(0, 30) + "..."
                    : String(avail.value);

                return (
                  <tr key={id} className="border-b border-[#151b26] hover:bg-[#0f141d]">
                    <td className="py-2 px-3 font-semibold text-slate-200">{label}</td>
                    <td className="py-2 px-3 font-bold text-cyan">{valDisplay}</td>
                    <td className="py-2 px-3"><ProvenanceBadge classification={avail.sourceClassification} /></td>
                    <td className="py-2 px-3 text-slate-300">{avail.provider}</td>
                    <td className="py-2 px-3 text-slate-300">{avail.instrument}</td>
                    <td className="py-2 px-3 text-slate-400">{formatTimestamp(avail.asOf)}</td>
                    <td className="py-2 px-3"><QualityBadge quality={avail.quality} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      {/* 5. GROUNDED CHATBOT EMBEDDED SURFACE */}
      <Panel
        title="GROUNDED AI QUANT ADVISOR (SNAPSHOT SINGLE SOURCE OF TRUTH)"
        className="shrink-0 mt-2 mb-6 flex flex-col h-[500px] border-[#1c2736]"
      >
        <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-[#07090d] custom-scrollbar font-sans">
          {chatMessages.map((msg, idx) => (
            <div
              key={idx}
              className={clsx(
                "flex flex-col max-w-[85%]",
                msg.sender === "user" ? "ml-auto items-end" : "mr-auto items-start"
              )}
            >
              <div
                className={clsx(
                  "p-3.5 rounded-xl text-xs leading-relaxed shadow-sm",
                  msg.sender === "user"
                    ? "bg-cyan/20 border border-cyan/40 text-cyan rounded-br-none"
                    : "bg-[#121824] border border-[#1c2736] text-slate-200 rounded-bl-none whitespace-pre-wrap"
                )}
              >
                {msg.text}
              </div>
            </div>
          ))}
          {chatLoading && (
            <div className="flex items-center gap-2 text-cyan text-xs p-2">
              <Loader2 size={16} className="animate-spin" /> Trợ lý AI đang suy luận trên CurrentMarketSnapshot...
            </div>
          )}
          <div ref={chatEndRef} />
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSendChat(chatInput);
          }}
          className="p-3 bg-[#0f141d] border-t border-[#1c2736] flex gap-3"
        >
          <input
            type="text"
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            placeholder="Hỏi AI Advisor dựa trên dữ liệu CurrentMarketSnapshot..."
            className="flex-1 bg-[#07090d] border border-[#1c2736] text-white px-4 py-2.5 rounded text-xs font-sans focus:outline-none focus:border-cyan"
          />
          <button
            type="submit"
            disabled={chatLoading || !chatInput.trim()}
            className="px-4 py-2.5 bg-cyan hover:bg-cyan/80 text-[#07090d] font-bold text-xs rounded flex items-center gap-1.5 transition-colors disabled:opacity-50"
          >
            <Send size={14} /> Gửi
          </button>
        </form>
      </Panel>
    </div>
  );
}
