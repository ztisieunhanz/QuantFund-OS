import React from 'react';
import { ArrowUpRight, ArrowDownRight, Minus } from 'lucide-react';
import { clsx } from "@/lib/clsx";

interface NewsItem {
  id: string;
  time: string;
  event: string;
  impact: 'HIGH' | 'MEDIUM' | 'LOW';
  direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  description: string;
}

const mockNews: NewsItem[] = [
  { id: '1', time: '2026-09-18 01:00 UTC', event: 'FOMC Rate Decision & Projections', impact: 'HIGH', direction: 'BULLISH', description: 'Dự báo FED giữ nguyên lãi suất nhưng phát tín hiệu ôn hòa (dovish), hỗ trợ tài sản rủi ro và vàng.' },
  { id: '2', time: '2026-09-20 12:30 UTC', event: 'US Core CPI (MoM/YoY)', impact: 'HIGH', direction: 'BEARISH', description: 'Chỉ số giá tiêu dùng lõi có thể nóng hơn dự kiến, gây áp lực tăng lợi suất trái phiếu 10 năm.' },
  { id: '3', time: '2026-09-24 14:00 UTC', event: 'US Flash Manufacturing PMI', impact: 'MEDIUM', direction: 'NEUTRAL', description: 'Đo lường sức khỏe sản xuất công nghiệp, định hình kịch bản Stagflation hiện tại.' }
];

export const MacroNewsTable: React.FC = () => {
  return (
    <div className="border border-line bg-panel p-3">
      <div className="flex items-center justify-between mb-3">
        <div className="font-mono text-[10px] tracking-[0.2em] text-cyan">MACRO EVENT CALENDAR</div>
        <div className="font-mono text-[10px] text-muted">REAL-TIME FEED</div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse font-mono text-[11px]">
          <thead className="text-muted border-b border-line">
            <tr>
              <th className="pb-2 px-2 font-normal">TIME (UTC)</th>
              <th className="pb-2 px-2 font-normal">EVENT</th>
              <th className="pb-2 px-2 text-center font-normal">IMPACT</th>
              <th className="pb-2 px-2 text-center font-normal">DIRECTION</th>
              <th className="pb-2 px-2 font-normal">ANALYSIS</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {mockNews.map((item) => (
              <tr key={item.id} className="hover:bg-panel-2 transition-colors">
                <td className="py-3 px-2 text-muted whitespace-nowrap">{item.time}</td>
                <td className="py-3 px-2 text-ink font-semibold">{item.event}</td>
                <td className="py-3 px-2 text-center">
                  <span className={clsx("px-2 py-0.5 rounded text-[9px] font-bold tracking-wider", 
                    item.impact === 'HIGH' ? "bg-[#ff3d57]/20 text-down" : "bg-[#ffc107]/20 text-amber"
                  )}>
                    {item.impact}
                  </span>
                </td>
                <td className="py-3 px-2">
                  <div className="flex items-center justify-center gap-1 text-[10px]">
                    {item.direction === 'BULLISH' && <ArrowUpRight className="w-3 h-3 text-up" />}
                    {item.direction === 'BEARISH' && <ArrowDownRight className="w-3 h-3 text-down" />}
                    {item.direction === 'NEUTRAL' && <Minus className="w-3 h-3 text-muted" />}
                    <span className={clsx(
                      item.direction === 'BULLISH' ? "text-up" : item.direction === 'BEARISH' ? "text-down" : "text-muted"
                    )}>
                      {item.direction}
                    </span>
                  </div>
                </td>
                <td className="py-3 px-2 text-muted leading-relaxed max-w-sm whitespace-normal">{item.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};