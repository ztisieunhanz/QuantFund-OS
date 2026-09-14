import { useMacroStore } from "@/stores/macroStore";
import { usePortfolioStore } from "@/stores/portfolioStore";

export interface AiRecommendation {
  marketView: string;
  riskStatus: "AGGRESSIVE" | "NEUTRAL" | "DEFENSIVE";
  actions: {
    assetId: string;
    action: "BUY" | "SELL" | "HOLD";
    percentageToMove: number;
    usdAmountToMove: number;
    reasoning: string;
  }[];
}

export async function generatePortfolioAction(): Promise<AiRecommendation> {
  const apiKey = (import.meta.env.VITE_GEMINI_API_KEY || "").trim();
  if (!apiKey) throw new Error("Không tìm thấy VITE_GEMINI_API_KEY trong file .env!");

  const macro = useMacroStore.getState().regime;
  const portfolio = usePortfolioStore.getState();
  const totalNav = portfolio.getTotalNav();

  if (!macro) throw new Error("Chưa có dữ liệu vĩ mô.");

  const prompt = `
    Đóng vai trò là Giám đốc Quản trị Rủi ro (Chief Risk Officer) của quỹ Quant Fund.
    Tổng NAV khách hàng: $${totalNav}, Tiền mặt: $${portfolio.cashUsd}.
    Điểm rủi ro vĩ mô: ${macro.score}/100 (${macro.label}). Bối cảnh: ${macro.thesis}.

    YÊU CẦU:
    1. Đưa ra marketView nhận định thực chiến ngắn gọn bằng tiếng Việt.
    2. Xác định riskStatus (AGGRESSIVE / NEUTRAL / DEFENSIVE).
    3. Đưa ra lệnh giao dịch cụ thể (actions). Mỗi lệnh phải tính rõ percentageToMove (tính trên % tài sản đó hoặc % NAV) và usdAmountToMove (số tiền USD thực tế dịch chuyển dựa trên tổng NAV $${totalNav}).

    BẮT BUỘC TRẢ VỀ ĐÚNG ĐỊNH DẠNG JSON SAU, KHÔNG DÙNG MARKDOWN BLOCK:
    {
      "marketView": "Nhận định thị trường thực chiến...",
      "riskStatus": "DEFENSIVE",
      "actions": [
        {
          "assetId": "btc",
          "action": "SELL",
          "percentageToMove": 25,
          "usdAmountToMove": 12500,
          "reasoning": "Thu hồi $12,500 tiền mặt từ Bitcoin để phòng thủ rủi ro vĩ mô."
        }
      ]
    }
  `;

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2 },
    }),
  });

  const rawText = await response.text();
  let data = JSON.parse(rawText);

  if (!response.ok) {
    throw new Error(data?.error?.message || "Lỗi gọi Google API");
  }

  let text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  text = text.replace(/```json/g, "").replace(/```/g, "").trim();

  return JSON.parse(text) as AiRecommendation;
}