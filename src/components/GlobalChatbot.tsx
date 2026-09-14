import React, { useState, useEffect, useRef } from "react";
import { BrainCircuit, X, Send, Loader2, MessageSquareText, TrendingUp, Target } from "lucide-react";
import { clsx } from "@/lib/clsx";
import { useMacroStore } from "@/stores/macroStore";
import { usePortfolioStore } from "@/stores/portfolioStore";

const CHAT_EXPIRY_MS = 60 * 60 * 1000; // 1 tiếng (60 phút * 60 giây * 1000 ms)

interface Message {
  sender: "user" | "ai";
  text: string;
}

export const GlobalChatbot: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const portfolio = usePortfolioStore();
  const { regime } = useMacroStore();

  // Tự động cuộn xuống tin nhắn mới nhất
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Logic tự động Reset lịch sử trò chuyện sau 1 tiếng
  useEffect(() => {
    const lastReset = localStorage.getItem("quant_chat_last_reset");
    const now = Date.now();

    if (!lastReset || now - parseInt(lastReset) > CHAT_EXPIRY_MS) {
      setMessages([{ 
        sender: "ai", 
        text: "Xin chào! Tôi là Trợ lý AI Quản trị Rủi ro (Quant Expert). Dữ liệu Vĩ mô và Danh mục tài sản của bạn đã được tôi đồng bộ. Bạn cần tôi phân tích chiến lược gì lúc này?" 
      }]);
      localStorage.setItem("quant_chat_last_reset", now.toString());
      localStorage.removeItem("quant_chat_history"); // Xóa lịch sử cũ
    } else {
      const savedHistory = localStorage.getItem("quant_chat_history");
      if (savedHistory) {
        setMessages(JSON.parse(savedHistory));
      } else {
        setMessages([{ sender: "ai", text: "Xin chào! Dữ liệu đã được đồng bộ, tôi đã sẵn sàng hỗ trợ." }]);
      }
    }
  }, []);

  // Lưu lịch sử vào LocalStorage mỗi khi có tin nhắn mới
  useEffect(() => {
    if (messages.length > 1) {
      localStorage.setItem("quant_chat_history", JSON.stringify(messages));
    }
  }, [messages]);

  const handleSend = async (text: string) => {
    if (!text.trim() || isLoading) return;

    const userText = text.trim();
    setInput("");
    setMessages((prev) => [...prev, { sender: "user", text: userText }]);
    setIsLoading(true);

    try {
      const apiKey = (import.meta.env.VITE_GEMINI_API_KEY || "").trim();
      if (!apiKey) throw new Error("Missing API Key");

      // Cài đặt bối cảnh hệ thống (System Prompt) liên kết thẳng với Dữ liệu thực tế
      const systemPrompt = `
        Đóng vai trò là một Chuyên gia Tài chính Định lượng (Quant Expert) & Chuyên gia AI hàng đầu thế giới.
        KIẾN THỨC BẮT BUỘC: Hiểu biết sâu sắc về tài chính vĩ mô, chu kỳ kinh tế, thị trường Crypto, Vàng, Bất động sản và cách tối ưu hóa lợi nhuận.
        
        DỮ LIỆU HỆ THỐNG HIỆN TẠI (REAL-TIME DATA):
        - Tổng Tài sản (NAV): $${portfolio.getTotalNav()}
        - Tiền mặt (Cash): $${portfolio.cashUsd}
        - Trạng thái Vĩ mô hiện tại: ${regime?.label || 'Chưa rõ'} (Điểm rủi ro: ${regime?.score || 0}/100)
        - Luận điểm Vĩ mô: ${regime?.thesis || 'Đang cập nhật'}
        - Phân bổ tài sản hiện tại: ${JSON.stringify(portfolio.assets.map(a => ({ Tên: a.name, Giá_trị: `$${a.currentValue}`, Tỷ_trọng: `${a.allocationPercent}%` })))}

        YÊU CẦU TRẢ LỜI:
        1. Phân tích dựa trên DỮ LIỆU THỰC TẾ ở trên. KHÔNG trả lời chung chung.
        2. Phong cách: Chuyên nghiệp, súc tích, logic, sắc bén, mang tính định hướng hành động cao (Actionable).
        3. Dùng tiếng Việt chuẩn, có thể chêm thuật ngữ tài chính tiếng Anh khi cần thiết. Trình bày rõ ràng bằng gạch đầu dòng.
      `;

      // Cấu trúc lịch sử tin nhắn chuẩn cho Gemini API
      const apiContents = [
        { role: "user", parts: [{ text: systemPrompt }] },
        { role: "model", parts: [{ text: "Đã hiểu. Tôi đã nạp toàn bộ dữ liệu danh mục và thông số vĩ mô theo thời gian thực. Tôi đã sẵn sàng tư vấn chiến lược." }] },
        ...messages.slice(1).map(m => ({
          role: m.sender === "user" ? "user" : "model",
          parts: [{ text: m.text }]
        })),
        { role: "user", parts: [{ text: userText }] }
      ];

      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: apiContents,
          generationConfig: { temperature: 0.3 } // Đặt nhiệt độ thấp để câu trả lời logic và tập trung hơn
        })
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || "Lỗi API");

      const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || "Xin lỗi, tôi không thể phân tích lúc này.";
      setMessages((prev) => [...prev, { sender: "ai", text: reply }]);
    } catch (err) {
      setMessages((prev) => [...prev, { sender: "ai", text: "⚠️ Lỗi kết nối AI. Vui lòng kiểm tra lại API Key hoặc mạng." }]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <>
      {/* Nút bấm nổi (Floating Button) */}
      {!isOpen && (
        <button
          onClick={() => setIsOpen(true)}
          className="fixed bottom-6 right-6 z-50 p-4 bg-gradient-to-r from-[#b388ff] to-[#7c4dff] text-black rounded-full shadow-[0_0_20px_rgba(179,136,255,0.4)] hover:scale-110 transition-transform flex items-center justify-center animate-bounce-slow"
        >
          <BrainCircuit size={28} />
        </button>
      )}

      {/* Cửa sổ Chatbot (Chat Window) */}
      {isOpen && (
        <div className="fixed bottom-6 right-6 z-50 w-[400px] h-[600px] max-h-[85vh] bg-[#0c1017] border border-[#2d213f] rounded-2xl shadow-2xl flex flex-col overflow-hidden animate-in slide-in-from-bottom-4 fade-in duration-300">
          
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 bg-[#121824] border-b border-[#1c2736]">
            <div className="flex items-center gap-3">
              <div className="bg-[#b388ff]/20 p-2 rounded-lg border border-[#b388ff]/40">
                <BrainCircuit size={18} className="text-[#b388ff]" />
              </div>
              <div>
                <h3 className="font-bold text-sm text-white leading-tight">AI Quant Expert</h3>
                <p className="text-[10px] text-[#00e676] flex items-center gap-1">
                  <span className="w-1.5 h-1.5 bg-[#00e676] rounded-full animate-pulse"></span> Data Synced
                </p>
              </div>
            </div>
            <button onClick={() => setIsOpen(false)} className="text-[#7d8ea3] hover:text-white p-1 rounded-md hover:bg-white/5 transition-colors">
              <X size={20} />
            </button>
          </div>

          {/* Lịch sử trò chuyện (Messages) */}
          <div className="flex-1 p-4 overflow-y-auto space-y-4 font-mono text-xs bg-[#07090d]">
            {messages.map((msg, idx) => (
              <div key={idx} className={clsx("flex flex-col max-w-[90%]", msg.sender === "user" ? "ml-auto items-end" : "mr-auto items-start")}>
                <div className={clsx(
                  "p-3 rounded-xl leading-relaxed whitespace-pre-wrap", 
                  msg.sender === "user" ? "bg-[#b388ff] text-black font-semibold rounded-br-none" : "bg-[#151b26] border border-[#2d213f] text-[#d7e2ee] rounded-bl-none"
                )}>
                  {msg.text}
                </div>
              </div>
            ))}
            {isLoading && (
              <div className="flex items-center gap-2 text-[#7d8ea3] text-[11px] p-2">
                <Loader2 size={14} className="animate-spin text-[#b388ff]" /> Phân tích dữ liệu hệ thống...
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Gợi ý Prompt Nhanh (Quick Prompts) */}
          <div className="px-3 pt-2 pb-1 bg-[#121824] flex gap-2 overflow-x-auto hide-scrollbar border-t border-[#1c2736]">
            <button 
              onClick={() => handleSend("Tóm tắt thị trường hôm nay và tôi nên hành động thế nào với danh mục hiện tại?")}
              className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 bg-[#1c2736] hover:bg-[#b388ff]/20 text-[#b388ff] rounded-lg text-[10px] font-mono transition-colors whitespace-nowrap border border-[#2d213f]"
            >
              <MessageSquareText size={12} /> Tóm tắt thị trường & Hành động
            </button>
            <button 
              onClick={() => handleSend("Trong 3 tháng tới tôi nên tái cơ cấu tỷ trọng tài sản ra sao để tối đa hóa thu nhập/vốn?")}
              className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 bg-[#1c2736] hover:bg-[#b388ff]/20 text-[#b388ff] rounded-lg text-[10px] font-mono transition-colors whitespace-nowrap border border-[#2d213f]"
            >
              <Target size={12} /> Chiến lược 3 tháng tới
            </button>
            <button 
              onClick={() => handleSend("Đánh giá mức độ rủi ro của danh mục tôi hiện tại khi điểm Stagflation đang ở mức này.")}
              className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 bg-[#1c2736] hover:bg-[#b388ff]/20 text-[#b388ff] rounded-lg text-[10px] font-mono transition-colors whitespace-nowrap border border-[#2d213f]"
            >
              <TrendingUp size={12} /> Đánh giá rủi ro danh mục
            </button>
          </div>

          {/* Khung Nhập liệu (Input) */}
          <form onSubmit={(e) => { e.preventDefault(); handleSend(input); }} className="p-3 bg-[#121824] flex gap-2">
            <input 
              type="text" 
              value={input} 
              onChange={(e) => setInput(e.target.value)}
              placeholder="Hỏi AI về chiến lược danh mục..."
              className="flex-1 bg-[#07090d] border border-[#1c2736] text-white px-3.5 py-2.5 rounded-xl text-xs font-mono focus:outline-none focus:border-[#b388ff]"
            />
            <button type="submit" disabled={isLoading} className="bg-[#b388ff] hover:bg-[#9c66ff] text-black font-bold px-4 py-2.5 rounded-xl flex items-center justify-center transition-colors disabled:opacity-50 shadow-md">
              <Send size={15} />
            </button>
          </form>

        </div>
      )}
    </>
  );
};