// ============================================================================
// FILE: src/components/MacroNewsTable.tsx
// MODULE: REAL-TIME QUANT NEWS TABLE WITH TRUE PUBLICATION TIMESTAMPS
// ============================================================================

import React, { useEffect, useState } from "react";
import { ArrowUpRight, ArrowDownRight, Minus, RefreshCw, Terminal, Sparkles, ExternalLink } from "lucide-react";
import { clsx } from "@/lib/clsx";
import { fetchRealQuantEvents, type LiveQuantNewsItem } from "@/lib/newsFeed";

export const MacroNewsTable: React.FC = () => {
  const [events, setEvents] = useState<LiveQuantNewsItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  const loadNews = async () => {
    setLoading(true);
    try {
      const data = await fetchRealQuantEvents();
      setEvents(data);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadNews();
  }, []);

  return (
    <div className="border border-line bg-panel p-4 mt-3 shrink-0 block w-full relative z-10 shadow-sm rounded-sm">
      <div className="flex items-center justify-between mb-3 border-b border-line/50 pb-2">
        <div className="flex items-center gap-2">
          <Terminal size={14} className="text-cyan" />
          <div className="font-mono text-[11px] tracking-[0.2em] text-cyan font-bold">
            QUANT EVENT GATEWAY · SỰ KIỆN VĨ MÔ & CRYPTO REAL-TIME
          </div>
        </div>
        <button
          type="button"
          onClick={loadNews}
          disabled={loading}
          className="flex items-center gap-1 text-[10px] font-mono text-cyan bg-cyan/10 hover:bg-cyan/20 border border-cyan/30 px-2.5 py-1 rounded transition-all disabled:opacity-50"
        >
          <RefreshCw size={10} className={clsx(loading && "animate-spin")} />
          {loading ? "SYNCING..." : "REFRESH FEED"}
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse font-mono text-[12px]">
          <thead className="text-muted border-b border-line bg-panel-2">
            <tr>
              <th className="py-2.5 px-3 font-normal">THỜI GIAN GỐC</th>
              <th className="py-2.5 px-3 font-normal">SỰ KIỆN TRÍCH XUẤT (QUANT AUDIT)</th>
              <th className="py-2.5 px-3 text-center font-normal">MỨC ĐỘ</th>
              <th className="py-2.5 px-3 text-center font-normal">TÁC ĐỘNG</th>
              <th className="py-2.5 px-3 font-normal">PHÂN TÍCH RỦI RO ĐỊNH LƯỢNG</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {events.map((item) => (
              <tr key={item.id} className="hover:bg-panel-2/70 transition-colors">
                <td className="py-3 px-3 text-muted whitespace-nowrap">{item.timestamp}</td>
                <td className="py-3 px-3">
                  <div className="text-ink font-bold flex items-center gap-1.5">
                    <Sparkles size={12} className="text-cyan shrink-0" />
                    {item.url ? (
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noreferrer"
                        className="hover:text-cyan underline decoration-cyan/30 flex items-center gap-1"
                      >
                        <span>{item.event}</span>
                        <ExternalLink size={10} className="text-muted shrink-0" />
                      </a>
                    ) : (
                      <span>{item.event}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 mt-1">
                    <span
                      className={clsx(
                        "text-[9px] px-1.5 py-0.2 rounded border font-bold uppercase",
                        item.sourceStatus === "VERIFIED"
                          ? "bg-[#00e676]/10 text-[#00e676] border-[#00e676]/30"
                          : "bg-cyan/10 text-cyan border-cyan/30"
                      )}
                    >
                      {item.sourceStatus}
                    </span>
                    <span className="text-[9px] text-muted">{item.source}</span>
                  </div>
                </td>
                <td className="py-3 px-3 text-center align-middle">
                  <span
                    className={clsx(
                      "px-2 py-0.5 rounded text-[10px] font-bold tracking-wider",
                      item.impact === "HIGH"
                        ? "bg-[#ff3d57]/20 text-down border border-[#ff3d57]/30"
                        : item.impact === "MEDIUM"
                        ? "bg-amber/20 text-amber border border-amber/30"
                        : "bg-[#00e676]/20 text-[#00e676] border border-[#00e676]/30"
                    )}
                  >
                    {item.impact}
                  </span>
                </td>
                <td className="py-3 px-3 align-middle">
                  <div className="flex items-center justify-center gap-1.5 text-[11px] font-bold">
                    {item.direction === "BULLISH" && <ArrowUpRight className="w-3.5 h-3.5 text-up" />}
                    {item.direction === "BEARISH" && <ArrowDownRight className="w-3.5 h-3.5 text-down" />}
                    {item.direction === "NEUTRAL" && <Minus className="w-3.5 h-3.5 text-muted" />}
                    <span
                      className={clsx(
                        item.direction === "BULLISH"
                          ? "text-up"
                          : item.direction === "BEARISH"
                          ? "text-down"
                          : "text-muted"
                      )}
                    >
                      {item.direction}
                    </span>
                  </div>
                </td>
                <td className="py-3 px-3 text-muted leading-relaxed whitespace-normal align-middle">
                  {item.description}
                </td>
              </tr>
            ))}
            {!loading && events.length === 0 && (
              <tr>
                <td colSpan={5} className="py-8 text-center text-muted font-mono text-xs">
                  Đang đồng bộ luồng tin quốc tế... Bấm [REFRESH FEED] để thử lại.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};