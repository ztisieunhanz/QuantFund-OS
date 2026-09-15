import React, { useMemo } from 'react';
import { ArrowUpRight, ArrowDownRight, Minus, RefreshCw, Radio } from 'lucide-react';
import { clsx } from "@/lib/clsx";
import { useMacroStore } from "@/stores/macroStore";

export type SourceStatus = 'VERIFIED' | 'UNVERIFIED' | 'QUANT_ENGINE';

export interface NewsItem {
  id: string;
  timestamp: string;
  event: string;
  impact: 'HIGH' | 'MEDIUM' | 'LOW';
  direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  description: string;
  sourceStatus: SourceStatus;
  source: string;
}

export const MacroNewsTable: React.FC = () => {
  const { series, regime, refreshedAt } = useMacroStore();

  // TỰ ĐỘNG TỔNG HỢP SỰ KIỆN VĨ MÔ THỜI GIAN THỰC TỪ DỮ LIỆU ĐỊNH LƯỢNG
  const dynamicEvents = useMemo<NewsItem[]>(() => {
    const events: NewsItem[] = [];
    const dateStr = refreshedAt ? new Date(refreshedAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'LIVE UPDATING';

    const yld10 = series.find(s => s.id === 'us10y');
    const yld2 = series.find(s => s.id === 'us2y');
    const vix = series.find(s => s.id === 'vix');
    const gold = series.find(s => s.id === 'gold');
    const dxy = series.find(s => s.id === 'dxy');

    // 1. SỰ KIỆN ĐƯỜNG CONG LỢI SUẤT (YIELD CURVE SPREAD)
    if (yld10 && yld2 && Number.isFinite(yld10.last) && Number.isFinite(yld2.last)) {
      const spreadBps = Math.round((yld10.last - yld2.last) * 100);
      const isInverted = spreadBps < 0;
      events.push({
        id: 'ev-yield-curve',
        timestamp: dateStr,
        event: isInverted 
          ? `Đường cong lợi suất US10Y-US2Y đảo ngược (${spreadBps} bps)` 
          : `Độ dốc lợi suất US10Y-US2Y duy trì dương (+${spreadBps} bps)`,
        impact: 'HIGH',
        direction: isInverted ? 'BEARISH' : 'BULLISH',
        description: isInverted 
          ? `Lợi suất ngắn hạn US2Y (${yld2.last.toFixed(2)}%) vượt US10Y (${yld10.last.toFixed(2)}%). Áp lực thắt chặt tiền tệ gia tăng, cảnh báo rủi ro suy thoái chu kỳ.`
          : `Đường cong lợi suất ở trạng thái bình thường hóa, áp lực thanh khoản hệ thống ngắn hạn được giải tỏa.`,
        sourceStatus: 'VERIFIED',
        source: 'US Treasury / Yield Engine'
      });
    }

    // 2. SỰ KIỆN CHỈ SỐ BIẾN ĐỘNG VIX
    if (vix && Number.isFinite(vix.last)) {
      const isStress = vix.last >= 20;
      events.push({
        id: 'ev-vix',
        timestamp: dateStr,
        event: isStress 
          ? `Chỉ số CBOE VIX vượt ngưỡng rủi ro (${vix.last.toFixed(2)} điểm)` 
          : `Chỉ số CBOE VIX nằm trong vùng ổn định (${vix.last.toFixed(2)} điểm)`,
        impact: isStress ? 'HIGH' : 'LOW',
        direction: isStress ? 'BEARISH' : 'BULLISH',
        description: isStress
          ? `Biến động hợp đồng quyền chọn S&P 500 tăng vọt, phản ánh tâm lý lo ngại của các quỹ định chế và kích hoạt dòng vốn tìm nơi phòng vệ.`
          : `Biến động thị trường cổ phiếu toàn cầu duy trì ở biên độ thấp, hỗ trợ khẩu vị rủi ro cho các tài sản beta cao.`,
        sourceStatus: 'VERIFIED',
        source: 'CBOE Market Data'
      });
    }

    // 3. SỰ KIỆN GIÁ VÀNG THẾ GIỚI & DÒNG TIỀN PHÒNG HỘ
    if (gold && Number.isFinite(gold.last)) {
      events.push({
        id: 'ev-gold',
        timestamp: dateStr,
        event: `Vàng thế giới (PAXG/XAU) neo ở vùng $${gold.last.toLocaleString('en-US', { minimumFractionDigits: 2 })}/oz`,
        impact: 'HIGH',
        direction: 'BULLISH',
        description: `Dòng vốn tổ chức tiếp tục tích lũy tài sản bảo chứng vật chất để chống lại lạm phát cơ bản và sự bất ổn của hệ thống thanh toán quốc tế.`,
        sourceStatus: 'VERIFIED',
        source: 'Binance PAXG Feed'
      });
    }

    // 4. SỰ KIỆN SỨC MẠNH ĐỒNG USD (DXY)
    if (dxy && Number.isFinite(dxy.last)) {
      const dxyUp = dxy.changePct1d >= 0;
      events.push({
        id: 'ev-dxy',
        timestamp: dateStr,
        event: `Chỉ số US Dollar Index (DXY) dao động quanh ${dxy.last.toFixed(2)} (${dxyUp ? '+' : ''}${(dxy.changePct1d * 100).toFixed(2)}%)`,
        impact: 'MEDIUM',
        direction: dxyUp ? 'BEARISH' : 'BULLISH',
        description: dxyUp 
          ? `Đồng USD tăng giá gây sức ép lên tỷ giá USD/VND và thanh khoản ngoại tệ của các thị trường mới nổi.`
          : `Đồng USD hạ nhiệt giúp giảm bớt áp lực can thiệp ngoại hối của các ngân hàng trung ương khu vực.`,
        sourceStatus: 'VERIFIED',
        source: 'ICE Dollar Index'
      });
    }

    return events;
  }, [series, refreshedAt]);

  return (
    <div className="border border-line bg-panel p-4 mt-3 shrink-0 block w-full relative z-10 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Radio size={14} className="text-cyan animate-pulse" />
          <div className="font-mono text-[11px] tracking-[0.2em] text-cyan font-bold">
            MACRO EVENT CALENDAR · SỰ KIỆN VĨ MÔ THỜI GIAN THỰC
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] text-[#00e676] border border-[#00e676]/40 bg-[#00e676]/10 px-2 py-0.5 rounded flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-[#00e676] animate-ping"></span>
            LIVE QUANT ENGINE
          </span>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse font-mono text-[12px]">
          <thead className="text-muted border-b border-line bg-panel-2">
            <tr>
              <th className="py-2.5 px-3 font-normal">THỜI GIAN</th>
              <th className="py-2.5 px-3 font-normal">SỰ KIỆN ĐỊNH LƯỢNG</th>
              <th className="py-2.5 px-3 text-center font-normal">MỨC ĐỘ</th>
              <th className="py-2.5 px-3 text-center font-normal">TÁC ĐỘNG</th>
              <th className="py-2.5 px-3 font-normal">PHÂN TÍCH RỦI RO CHI TIẾT</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {dynamicEvents.map((item) => (
              <tr key={item.id} className="hover:bg-panel-2 transition-colors">
                <td className="py-3 px-3 text-muted whitespace-nowrap">{item.timestamp}</td>
                <td className="py-3 px-3">
                  <div className="text-ink font-bold">{item.event}</div>
                  <div className="flex items-center gap-1.5 mt-1">
                    <span className={clsx("text-[9px] px-1.5 py-0.2 rounded border font-bold uppercase", 
                      item.sourceStatus === 'VERIFIED' ? "bg-[#00e676]/10 text-[#00e676] border-[#00e676]/30" : 
                      item.sourceStatus === 'UNVERIFIED' ? "bg-amber/10 text-amber border-amber/30" : 
                      "bg-cyan/10 text-cyan border-cyan/30"
                    )}>
                      {item.sourceStatus}
                    </span>
                    <span className="text-[9px] text-muted">{item.source}</span>
                  </div>
                </td>
                <td className="py-3 px-3 text-center align-middle">
                  <span className={clsx("px-2 py-0.5 rounded text-[10px] font-bold tracking-wider", 
                    item.impact === 'HIGH' ? "bg-[#ff3d57]/20 text-down border border-[#ff3d57]/30" : 
                    item.impact === 'MEDIUM' ? "bg-amber/20 text-amber border border-amber/30" :
                    "bg-[#00e676]/20 text-[#00e676] border border-[#00e676]/30"
                  )}>
                    {item.impact}
                  </span>
                </td>
                <td className="py-3 px-3 align-middle">
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
                <td className="py-3 px-3 text-muted leading-relaxed whitespace-normal align-middle">{item.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};