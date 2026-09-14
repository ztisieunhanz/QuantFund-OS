import React from 'react';
import { Newspaper, Calendar, ArrowUpRight, ArrowDownRight, Minus } from 'lucide-react';

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
    <div className="bg-[#ffffff] border border-[#e2e8f0] rounded-2xl p-5 shadow-sm font-sans">
      <div className="flex items-center justify-between mb-4 pb-4 border-b border-[#f1f5f9]">
        <div className="flex items-center gap-3">
          <div className="bg-[#e0f2fe] p-2 rounded-lg border border-[#bae6fd]">
            <Newspaper className="w-4 h-4 text-[#0ea5e9]" />
          </div>
          <h3 className="font-bold text-sm tracking-wide text-[#1e293b] uppercase">Lịch Sự Kiện Vĩ Mô</h3>
        </div>
        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-[#64748b] bg-[#f8fafc] px-3 py-1.5 rounded-full border border-[#e2e8f0]">
          <Calendar className="w-3.5 h-3.5" />
          <span>Real-time Macro Feed</span>
        </div>
      </div>

      <div className="overflow-x-auto custom-scrollbar">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-[#f1f5f9] text-[11px] text-[#94a3b8] uppercase tracking-wider">
              <th className="py-3 px-4 font-bold">Thời gian</th>
              <th className="py-3 px-4 font-bold">Sự kiện Vĩ mô</th>
              <th className="py-3 px-4 font-bold">Mức tác động</th>
              <th className="py-3 px-4 font-bold">Tác động thị trường</th>
              <th className="py-3 px-4 font-bold">Phân tích tác động</th>
            </tr>
          </thead>
          <tbody className="text-[13px] divide-y divide-[#f1f5f9]">
            {mockNews.map((item) => (
              <tr key={item.id} className="hover:bg-[#f8fafc] transition-colors">
                <td className="py-4 px-4 font-mono text-xs text-[#64748b] whitespace-nowrap">{item.time}</td>
                <td className="py-4 px-4 font-bold text-[#334155]">{item.event}</td>
                <td className="py-4 px-4">
                  <span className={`px-2.5 py-1 rounded-md text-[10px] font-bold tracking-wider ${
                    item.impact === 'HIGH' ? 'bg-[#ffe4e6] text-[#e11d48] border border-[#fecdd3]' : 'bg-[#fef3c7] text-[#d97706] border border-[#fde68a]'
                  }`}>
                    {item.impact}
                  </span>
                </td>
                <td className="py-4 px-4">
                  <div className="flex items-center gap-1.5 font-bold text-xs">
                    {item.direction === 'BULLISH' && <ArrowUpRight className="w-4 h-4 text-[#10b981]" />}
                    {item.direction === 'BEARISH' && <ArrowDownRight className="w-4 h-4 text-[#f43f5e]" />}
                    {item.direction === 'NEUTRAL' && <Minus className="w-4 h-4 text-[#94a3b8]" />}
                    <span className={item.direction === 'BULLISH' ? 'text-[#10b981]' : item.direction === 'BEARISH' ? 'text-[#f43f5e]' : 'text-[#64748b]'}>
                      {item.direction}
                    </span>
                  </div>
                </td>
                <td className="py-4 px-4 text-[#475569] leading-relaxed min-w-[300px]">{item.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};