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
    <div className="bg-[#0f172a] border border-[#1e293b] rounded-2xl p-5 shadow-lg font-sans">
      <div className="flex items-center justify-between mb-4 pb-4 border-b border-[#1e293b]">
        <div className="flex items-center gap-3">
          <div className="bg-sky-500/20 p-2 rounded-lg border border-sky-500/30">
            <Newspaper className="w-4 h-4 text-sky-400" />
          </div>
          <h3 className="font-bold text-sm tracking-wide text-slate-100 uppercase">Lịch Sự Kiện Vĩ Mô</h3>
        </div>
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-slate-400 bg-slate-800/50 px-3 py-1.5 rounded-full border border-slate-700/50">
          <Calendar className="w-3.5 h-3.5" />
          <span>Real-time Macro Feed</span>
        </div>
      </div>

      <div className="overflow-x-auto custom-scrollbar">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-[#1e293b] text-[11px] text-slate-400 uppercase tracking-wider">
              <th className="py-3 px-4 font-semibold">Thời gian</th>
              <th className="py-3 px-4 font-semibold">Sự kiện Vĩ mô</th>
              <th className="py-3 px-4 font-semibold">Mức tác động</th>
              <th className="py-3 px-4 font-semibold">Tác động thị trường</th>
              <th className="py-3 px-4 font-semibold">Phân tích tác động</th>
            </tr>
          </thead>
          <tbody className="text-[13px] divide-y divide-[#1e293b]">
            {mockNews.map((item) => (
              <tr key={item.id} className="hover:bg-slate-800/30 transition-colors">
                <td className="py-4 px-4 font-mono text-xs text-slate-400 whitespace-nowrap">{item.time}</td>
                <td className="py-4 px-4 font-bold text-slate-100">{item.event}</td>
                <td className="py-4 px-4">
                  <span className={`px-2.5 py-1 rounded-md text-[10px] font-bold tracking-wider ${
                    item.impact === 'HIGH' ? 'bg-rose-500/20 text-rose-400 border border-rose-500/30' : 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                  }`}>
                    {item.impact}
                  </span>
                </td>
                <td className="py-4 px-4">
                  <div className="flex items-center gap-1.5 font-bold text-xs">
                    {item.direction === 'BULLISH' && <ArrowUpRight className="w-4 h-4 text-emerald-400" />}
                    {item.direction === 'BEARISH' && <ArrowDownRight className="w-4 h-4 text-rose-400" />}
                    {item.direction === 'NEUTRAL' && <Minus className="w-4 h-4 text-slate-400" />}
                    <span className={item.direction === 'BULLISH' ? 'text-emerald-400' : item.direction === 'BEARISH' ? 'text-rose-400' : 'text-slate-400'}>
                      {item.direction}
                    </span>
                  </div>
                </td>
                <td className="py-4 px-4 text-slate-300 leading-relaxed min-w-[300px]">{item.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};