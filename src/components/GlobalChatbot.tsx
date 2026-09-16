import React, { useState, useEffect, useRef } from "react";
import { BrainCircuit, X, Send, Loader2, MessageSquareText, Target } from "lucide-react";
import { clsx } from "@/lib/clsx";
import { useMacroStore } from "@/stores/macroStore";
import { usePortfolioStore } from "@/stores/portfolioStore";

const CHAT_EXPIRY_MS = 60 * 60 * 1000;

interface Message {
  sender: "user" | "ai";
  text: string;
}

// Bộ phân tích Markdown cơ bản giúp tin nhắn của AI hiển thị tuyệt đẹp (Tiêu đề, in đậm, xuống dòng)
const FormatMessage = ({ text }: { text: string }) => {
  const lines = text.split('\n');
  return (
    <div className="space-y-1.5 text-[13px] leading-relaxed">
      {lines.map((line, i) => {
        if (!line.trim()) return <div key={i} className="h-1"></div>; // Khoảng trống
        if (line.startsWith('### ')) return <h3 key={i} className="text-sm font-bold text-[#b388ff] mt-3 mb-1 uppercase tracking-wide">{line.replace('### ', '')}</h3>;
        if (line.startsWith('## ')) return <h2 key={i} className="text-[13px] font-bold text-white mt-2 mb-1">{line.replace('## ', '')}</h2>;
        
        // Xử lý in đậm và gạch đầu dòng
        let isList = line.startsWith('- ') || line.startsWith('* ');
        let content = isList ? line.substring(2) : line;
        
        // Render thẻ in đậm **bold**
        const formattedHTML = content.replace(/\*\*(.*?)\*\*/g, '<strong class="text-white font-bold">$1</strong>').replace(/\*(.*?)\*/g, '<em class="italic text-slate-300">$1</em>');

        if (isList) {
          return (
            <div key={i} className="flex items-start gap-2 ml-1">
              <span className="text-[#b388ff] mt-0.5">•</span>
              <span dangerouslySetInnerHTML={{ __html: formattedHTML }} />
            </div>
          );
        }
        return <div key={i} dangerouslySetInnerHTML={{ __html: formattedHTML }} />;
      })}
    </div>
  );
};

export const GlobalChatbot: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const portfolio = usePortfolioStore();
  const { regime } = useMacroStore();

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isOpen]);

  useEffect(() => {
    const lastReset = localStorage.getItem("quant_chat_last_reset");
    const now = Date.now();

    if (!lastReset || now - parseInt(lastReset) > CHAT_EXPIRY_MS) {
      setMessages([{ 
        sender: "ai", 
        text: "Xin chào! Tôi là **Trợ lý AI Quản trị Rủi ro (Quant Expert)**.\n\nDữ liệu Vĩ mô và Danh mục của bạn đã được đồng bộ hóa thành công. Bạn cần tôi phân tích chiến lược gì hôm nay?" 
      }]);
      localStorage.setItem("quant_chat_last_reset", now.toString());
      localStorage.removeItem("quant_chat_history");
    } else {
      const savedHistory = localStorage.getItem("quant_chat_history");
      if (savedHistory) setMessages(JSON.parse(savedHistory));
    }
  }, []);

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

      const systemPrompt = `
        Đóng vai trò là một Chuyên gia Tài chính Định lượng (Quant Expert). Trả lời bằng tiếng Việt, trình bày BẮT BUỘC sử dụng Markdown:
        - Dùng "### [Tiêu đề]" cho các luận điểm chính.
        - Dùng "**[Chữ]**" để in đậm các con số hoặc từ khóa quan trọng.
        - Dùng "- " để gạch đầu dòng các ý.
        - XUỐNG DÒNG rõ ràng, KHÔNG viết thành một khối chữ dài.
        
        DỮ LIỆU THỰC TẾ CỦA KHÁCH HÀNG:
        - Tổng NAV: $${portfolio.getTotalNav()}
        - Tiền mặt: $${portfolio.cashUsd}
        - Trạng thái Vĩ mô: ${regime?.label || 'Chưa rõ'} (Điểm rủi ro: ${regime?.score || 0}/100)
        - Phân bổ tài sản: ${JSON.stringify(portfolio.assets.map(a => ({ Tên: a.name, Giá_trị: `$${a.currentValue}`, Tỷ_trọng: `${a.allocationPercent}%` })))}
      `;

      const apiContents = [
        { role: "user", parts: [{ text: systemPrompt }] },
        { role: "model", parts: [{ text: "Đã hiểu, tôi sẽ phân tích sắc bén và trình bày Markdown rõ ràng." }] },
        ...messages.slice(1).map(m => ({ role: m.sender === "user" ? "user" : "model", parts: [{ text: m.text }] })),
        { role: "user", parts: [{ text: userText }] }
      ];

      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: apiContents, generationConfig: { temperature: 0.2 } })
      });

      const data = await response.json();
      const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || "Xin lỗi, không thể phân tích lúc này.";
      setMessages((prev) => [...prev, { sender: "ai", text: reply }]);
    } catch (err) {
      setMessages((prev) => [...prev, { sender: "ai", text: "⚠️ **Lỗi kết nối AI.** Vui lòng kiểm tra lại API Key." }]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault(); // Ngăn xuống dòng
      handleSend(input);
    }
  };

  return (
    <>
      {!isOpen && (
        <button
          onClick={() => setIsOpen(true)}
          className="fixed bottom-6 right-6 z-[999] p-4 bg-gradient-to-r from-[#b388ff] to-[#7c4dff] text-white rounded-full shadow-[0_0_25px_rgba(179,136,255,0.4)] hover:scale-105 transition-all flex items-center justify-center animate-bounce-slow"
        >
          <BrainCircuit size={28} />
        </button>
      )}

      {isOpen && (
        <div className="fixed bottom-6 right-6 z-[999] w-[450px] h-[650px] max-h-[85vh] bg-[#0f172a] border border-[#1e293b] rounded-2xl shadow-2xl flex flex-col overflow-hidden font-sans animate-in slide-in-from-bottom-4 fade-in duration-200">
          
          <div className="flex items-center justify-between px-5 py-4 bg-[#1e293b]/50 backdrop-blur-md border-b border-[#334155]">
            <div className="flex items-center gap-3">
              <div className="bg-[#b388ff]/20 p-2 rounded-xl border border-[#b388ff]/30 shadow-inner">
                <BrainCircuit size={20} className="text-[#b388ff]" />
              </div>
              <div>
                <h3 className="font-bold text-sm text-slate-100 tracking-wide">AI Quant Expert</h3>
                <p className="text-[11px] text-emerald-400 flex items-center gap-1.5 mt-0.5">
                  <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-pulse"></span> Data Synced
                </p>
              </div>
            </div>
            <button onClick={() => setIsOpen(false)} className="text-slate-400 hover:text-white p-1.5 rounded-lg hover:bg-slate-700 transition-colors">
              <X size={20} />
            </button>
          </div>

          <div className="flex-1 p-5 overflow-y-auto space-y-5 bg-[#0b1120]">
            {messages.map((msg, idx) => (
              <div key={idx} className={clsx("flex flex-col max-w-[90%]", msg.sender === "user" ? "ml-auto items-end" : "mr-auto items-start")}>
                <div className={clsx(
                  "p-4 rounded-2xl shadow-md", 
                  msg.sender === "user" 
                    ? "bg-gradient-to-br from-[#b388ff] to-[#9c66ff] text-black font-medium rounded-br-sm" 
                    : "bg-[#1e293b] border border-[#334155] text-slate-300 rounded-bl-sm"
                )}>
                  {msg.sender === "user" ? <span className="whitespace-pre-wrap text-[13px]">{msg.text}</span> : <FormatMessage text={msg.text} />}
                </div>
              </div>
            ))}
            {isLoading && (
              <div className="flex items-center gap-2 text-slate-400 text-xs p-2">
                <Loader2 size={16} className="animate-spin text-[#b388ff]" /> Trợ lý đang tính toán dữ liệu...
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          <div className="px-3 pt-3 pb-2 bg-[#0f172a] flex gap-2 overflow-x-auto hide-scrollbar border-t border-[#1e293b]">
            <button onClick={() => handleSend("Tóm tắt thị trường hôm nay và tôi nên hành động thế nào?")} className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 bg-[#1e293b] hover:bg-[#b388ff]/20 text-[#b388ff] rounded-lg text-[11px] font-medium transition-colors whitespace-nowrap border border-[#334155]">
              <MessageSquareText size={14} /> Tóm tắt & Hành động
            </button>
            <button onClick={() => handleSend("Trong 3 tháng tới tôi nên tái cơ cấu tỷ trọng tài sản ra sao để tối đa hóa thu nhập/vốn?")} className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 bg-[#1e293b] hover:bg-[#b388ff]/20 text-[#b388ff] rounded-lg text-[11px] font-medium transition-colors whitespace-nowrap border border-[#334155]">
              <Target size={14} /> Chiến lược 3 tháng
            </button>
          </div>

          <form onSubmit={(e) => { e.preventDefault(); handleSend(input); }} className="p-3 bg-[#0f172a] flex gap-2">
            <textarea 
              rows={1}
              value={input} 
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Hỏi AI... (Shift + Enter để xuống dòng)"
              className="flex-1 bg-[#1e293b] border border-[#334155] text-slate-100 px-4 py-3 rounded-xl text-[13px] focus:outline-none focus:border-[#b388ff] resize-none max-h-32 min-h-[44px] custom-scrollbar"
            />
            <button type="submit" disabled={isLoading || !input.trim()} className="bg-gradient-to-br from-[#b388ff] to-[#9c66ff] hover:opacity-90 text-black font-bold w-11 h-11 rounded-xl flex items-center justify-center transition-all disabled:opacity-50 shadow-lg shrink-0">
              <Send size={18} className="ml-0.5" />
            </button>
          </form>

        </div>
      )}
    </>
  );
};