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

// MOCK DATA: Toàn bộ mảng mockNews này đang là hard-code
const mockNews: NewsItem[] = [
  { id: '1', time: '2026-09-15 01:00 UTC', event: 'Tin đồn: FED cân nhắc cắt giảm 50bps', impact: 'HIGH', direction: 'BULLISH', description: 'Kỳ vọng FED mạnh tay nới lỏng gia tăng, hỗ trợ đà tăng cho Vàng (XAU) và Tiền số (BTC).' },
  { id: '2', time: '2026-09-14 12:30 UTC', event: 'Căng thẳng Địa chính trị Trung Đông', impact: 'HIGH', direction: 'BEARISH', description: 'Rủi ro gián đoạn chuỗi cung ứng dầu mỏ, đẩy nguy cơ lạm phát quay lại (Stagflation).' },
  { id: '3', time: '2026-09-13 14:00 UTC', event: 'NHNN Việt Nam hút ròng tín phiếu', impact: 'MEDIUM', direction: 'NEUTRAL', description: 'Động thái ổn định tỷ giá USD/VND, thanh khoản hệ thống ngắn hạn chịu áp lực nhẹ.' }
];

export const MacroNewsTable: React.FC = () => {
  return (
    <div className="border border-line bg-panel p-4 mt-3 shrink-0 block w-full relative z-10">
      <div className="flex items-center justify-between mb-3">
        <div className="font-mono text-[11px] tracking-[0.2em] text-cyan font-bold">MACRO EVENT CALENDAR · SỰ KIỆN VĨ MÔ</div>
        <div className="font-mono text-[10px] text-amber border border-amber px-2 py-0.5 bg-panel-2">MOCK FEED</div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse font-mono text-[12px]">
          <thead className="text-muted border-b border-line bg-panel-2">
            <tr>
              <th className="py-2.5 px-3 font-normal">THỜI GIAN (UTC)</th>
              <th className="py-2.5 px-3 font-normal">SỰ KIỆN CHÍNH</th>
              <th className="py-2.5 px-3 text-center font-normal">MỨC ĐỘ</th>
              <th className="py-2.5 px-3 text-center font-normal">TÁC ĐỘNG</th>
              <th className="py-2.5 px-3 font-normal">PHÂN TÍCH CHUYÊN SÂU</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {mockNews.map((item) => (
              <tr key={item.id} className="hover:bg-panel-2 transition-colors">
                <td className="py-3.5 px-3 text-muted whitespace-nowrap">{item.time}</td>
                <td className="py-3.5 px-3 text-ink font-bold">{item.event}</td>
                <td className="py-3.5 px-3 text-center">
                  <span className={clsx("px-2 py-1 rounded text-[10px] font-bold tracking-wider", 
                    item.impact === 'HIGH' ? "bg-[#ff3d57]/20 text-down border border-[#ff3d57]/30" : "bg-[#ffc107]/20 text-amber border border-[#ffc107]/30"
                  )}>
                    {item.impact}
                  </span>
                </td>
                <td className="py-3.5 px-3">
                  <div className="flex items-center justify-center gap-1.5 text-[11px] font-bold">
                    {item.direction === 'BULLISH' && <ArrowUpRight className="w-3.5 h-3.5 text-up" />}
                    {item.direction === 'BEARISH' && <ArrowDownRight className="w-3.5 h-3.5 text-down" />}
                    {item.direction === 'NEUTRAL' && <Minus className="w-3.5 h-3.5 text-muted" />}
                    <span className={clsx(
                      item.direction === 'BULLISH' ? "text-up" : item.direction === 'BEARISH' ? "text-down" : "text-muted"
                    )}>
                      {item.direction}
                    </span>
                  </div>
                </td>
                <td className="py-3.5 px-3 text-muted leading-relaxed whitespace-normal">{item.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};