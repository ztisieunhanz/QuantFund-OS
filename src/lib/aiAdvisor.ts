import { useMacroStore } from "@/stores/macroStore";
import { usePortfolioStore } from "@/stores/portfolioStore";

export interface AiRecommendation {
  marketView: string;
  riskStatus: "AGGRESSIVE" | "NEUTRAL" | "DEFENSIVE";
  actions: {
    assetId: string;
    action: "BUY" | "SELL" | "HOLD";
    percentageToMove: number;
    reasoning: string;
  }[];
}

export async function generatePortfolioAction(): Promise<AiRecommendation> {
  const macro = useMacroStore.getState().regime;
  const portfolio = usePortfolioStore.getState();

  if (!macro) throw new Error("Chưa có dữ liệu vĩ mô (Macro data not ready).");

  const prompt = `
    Đóng vai trò là Giám đốc Quản trị Rủi ro (Chief Risk Officer) của một quỹ Quant Fund.
    Hãy phân tích dữ liệu Vĩ mô và Danh mục tài chính hiện tại:
    
    [DỮ LIỆU VĨ MÔ]
    - Điểm rủi ro (Regime Score): ${macro.score}/100
    - Trạng thái: ${macro.label}
    - Bối cảnh: ${macro.thesis}

    [DANH MỤC KHÁCH HÀNG]
    - Tiền mặt: $${portfolio.cashUsd}
    - Tài sản: ${JSON.stringify(portfolio.assets.map(a => ({ id: a.id, name: a.name, value: a.currentValue })))}
    - Tổng NAV: $${portfolio.getTotalNav()}

    [YÊU CẦU]
    1. Đưa ra marketView (nhận định ngắn gọn, thực chiến bằng tiếng Việt).
    2. Xác định riskStatus (AGGRESSIVE / NEUTRAL / DEFENSIVE).
    3. Đưa ra lệnh giao dịch cụ thể (actions). Nếu điểm rủi ro < 45, ưu tiên SELL bớt tài sản rủi ro và thu tiền mặt.

    BẮT BUỘC TRẢ VỀ ĐÚNG ĐỊNH DẠNG JSON SAU, TUYỆT ĐỐI KHÔNG DÙNG MARKDOWN BLOCK:
    {
      "marketView": "Nhận định ngắn gọn bằng tiếng Việt...",
      "riskStatus": "DEFENSIVE",
      "actions": [
        {
          "assetId": "btc",
          "action": "SELL",
          "percentageToMove": 25,
          "reasoning": "Giảm bớt tỷ trọng crypto để gom tiền mặt phòng thủ."
        }
      ]
    }
  `;

  const response = await fetch('/api/ai-advisor', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  });

  const rawText = await response.text();
  let data: any;

  try {
    data = JSON.parse(rawText);
  } catch (e) {
    throw new Error(`Phản hồi từ Server không hợp lệ: ${rawText.slice(0, 150)}`);
  }

  if (!response.ok) {
    const errorMsg = data?.error?.message || data?.error || JSON.stringify(data);
    throw new Error(`Google API Error (${response.status}): ${errorMsg}`);
  }

  let text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  text = text.replace(/```json/g, "").replace(/```/g, "").trim();

  return JSON.parse(text) as AiRecommendation;
}