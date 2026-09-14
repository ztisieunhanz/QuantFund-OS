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
    <div className="bg-[#10151e] border border-[#1c2736] rounded-2xl p-5 shadow-lg font-sans">
      <div className="flex items-center justify-between mb-4 pb-4 border-b border-[#1c2736]">
        <div className="flex items-center gap-3">
          <div className="bg-[#26c6da]/20 p-2 rounded-lg border border-[#26c6da]/30">
            <Newspaper className="w-4 h-4 text-[#26c6da]" />
          </div>
          <h3 className="font-bold text-sm tracking-wide text-white uppercase">Lịch Sự Kiện Vĩ Mô</h3>
        </div>
        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-[#7d8ea3] bg-black/40 px-3 py-1.5 rounded-full border border-[#1c2736]">
          <Calendar className="w-3.5 h-3.5" />
          <span>Lịch Trình Vĩ Mô (Real-time)</span>
        </div>
      </div>

      <div className="overflow-x-auto custom-scrollbar">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-[#1c2736] text-[11px] text-[#7d8ea3] uppercase tracking-wider">
              <th className="py-3 px-4 font-bold">Thời gian</th>
              <th className="py-3 px-4 font-bold">Sự kiện Vĩ mô</th>
              <th className="py-3 px-4 font-bold">Mức độ</th>
              <th className="py-3 px-4 font-bold">Tác động kỳ vọng</th>
              <th className="py-3 px-4 font-bold">Giải nghĩa tác động</th>
            </tr>
          </thead>
          <tbody className="text-[13px] divide-y divide-[#1c2736]/50">
            {mockNews.map((item) => (
              <tr key={item.id} className="hover:bg-[#151b26] transition-colors">
                <td className="py-4 px-4 font-mono text-xs text-[#7d8ea3] whitespace-nowrap">{item.time}</td>
                <td className="py-4 px-4 font-bold text-white">{item.event}</td>
                <td className="py-4 px-4">
                  <span className={`px-2.5 py-1 rounded-md text-[10px] font-bold tracking-wider ${
                    item.impact === 'HIGH' ? 'bg-[#ff3d57]/20 text-[#ff3d57] border border-[#ff3d57]/30' : 'bg-[#ffc107]/20 text-[#ffc107] border border-[#ffc107]/30'
                  }`}>
                    {item.impact}
                  </span>
                </td>
                <td className="py-4 px-4">
                  <div className="flex items-center gap-1.5 font-bold text-xs">
                    {item.direction === 'BULLISH' && <ArrowUpRight className="w-4 h-4 text-[#00e676]" />}
                    {item.direction === 'BEARISH' && <ArrowDownRight className="w-4 h-4 text-[#ff3d57]" />}
                    {item.direction === 'NEUTRAL' && <Minus className="w-4 h-4 text-[#7d8ea3]" />}
                    <span className={item.direction === 'BULLISH' ? 'text-[#00e676]' : item.direction === 'BEARISH' ? 'text-[#ff3d57]' : 'text-[#7d8ea3]'}>
                      {item.direction}
                    </span>
                  </div>
                </td>
                <td className="py-4 px-4 text-[#7d8ea3] leading-relaxed min-w-[300px]">{item.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};