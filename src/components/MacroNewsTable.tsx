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
  {
    id: '1',
    time: '2026-09-18 01:00 UTC',
    event: 'FOMC Rate Decision & Projections',
    impact: 'HIGH',
    direction: 'BULLISH',
    description: 'Dự báo FED giữ nguyên lãi suất nhưng phát tín hiệu ôn hòa (dovish), hỗ trợ tài sản rủi ro và vàng.'
  },
  {
    id: '2',
    time: '2026-09-20 12:30 UTC',
    event: 'US Core CPI (MoM/YoY)',
    impact: 'HIGH',
    direction: 'BEARISH',
    description: 'Chỉ số giá tiêu dùng lõi có thể nóng hơn dự kiến, gây áp lực tăng lợi suất trái phiếu 10 năm.'
  },
  {
    id: '3',
    time: '2026-09-24 14:00 UTC',
    event: 'US Flash Manufacturing PMI',
    impact: 'MEDIUM',
    direction: 'NEUTRAL',
    description: 'Đo lường sức khỏe sản xuất công nghiệp, định hình kịch bản Stagflation hiện tại.'
  }
];

export const MacroNewsTable: React.FC = () => {
  return (
    <div className="bg-[#0c1017] border border-[#1c2736] rounded-xl p-5 mb-6 text-[#d7e2ee]">
      <div className="flex items-center justify-between mb-4 pb-3 border-b border-[#1c2736]">
        <div className="flex items-center gap-2">
          <Newspaper className="w-5 h-5 text-[#26c6da]" />
          <h3 className="font-bold text-sm tracking-wide uppercase">Bảng Tin Tức Vĩ Mô & Lịch Sự Kiện Sắp Diễn Ra</h3>
        </div>
        <div className="flex items-center gap-1 text-xs text-[#7d8ea3]">
          <Calendar className="w-4 h-4" />
          <span>Real-time Macro Feed</span>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-[#1c2736] text-xs text-[#7d8ea3]">
              <th className="py-2.5 px-3">Thời gian</th>
              <th className="py-2.5 px-3">Sự kiện Vĩ mô</th>
              <th className="py-2.5 px-3">Mức tác động</th>
              <th className="py-2.5 px-3">Tác động thị trường</th>
              <th className="py-2.5 px-3">Phân tích tác động</th>
            </tr>
          </thead>
          <tbody className="text-xs divide-y divide-[#1c2736]/50">
            {mockNews.map((item) => (
              <tr key={item.id} className="hover:bg-[#10151e] transition-colors">
                <td className="py-3 px-3 font-mono text-[#7d8ea3] whitespace-nowrap">{item.time}</td>
                <td className="py-3 px-3 font-semibold text-white">{item.event}</td>
                <td className="py-3 px-3">
                  <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                    item.impact === 'HIGH' ? 'bg-[#ff3d57]/20 text-[#ff3d57]' : 'bg-[#ffc107]/20 text-[#ffc107]'
                  }`}>
                    {item.impact}
                  </span>
                </td>
                <td className="py-3 px-3">
                  <div className="flex items-center gap-1">
                    {item.direction === 'BULLISH' && <ArrowUpRight className="w-4 h-4 text-[#00e676]" />}
                    {item.direction === 'BEARISH' && <ArrowDownRight className="w-4 h-4 text-[#ff3d57]" />}
                    {item.direction === 'NEUTRAL' && <Minus className="w-4 h-4 text-[#ffc107]" />}
                    <span className={
                      item.direction === 'BULLISH' ? 'text-[#00e676]' : item.direction === 'BEARISH' ? 'text-[#ff3d57]' : 'text-[#ffc107]'
                    }>
                      {item.direction}
                    </span>
                  </div>
                </td>
                <td className="py-3 px-3 text-[#d7e2ee]/80 max-w-xs">{item.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};