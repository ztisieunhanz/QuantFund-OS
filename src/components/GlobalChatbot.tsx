// ============================================================================
// FILE: src/components/GlobalChatbot.tsx
// MODULE: GLOBAL CHATBOT COMPONENT (GATE M4 GROUNDING)
// PRINCIPLE: Grounded on Single Shared Authoritative CurrentMarketSnapshot
// ============================================================================

import React, { useState, useEffect, useRef } from "react";
import { BrainCircuit, X, Send, Loader2, MessageSquareText, Target } from "lucide-react";
import { clsx } from "@/lib/clsx";
import { requestAiAdvisor } from "@/lib/aiGatewayClient";
import { AI_GATEWAY_OPERATION } from "@/lib/aiGatewayContract";
import { buildAiAdvisorGrounding } from "@/lib/aiAdvisorGroundingProjection";
import { createChatRequestCoordinator } from "@/lib/chatRequestCoordinator";
import { useSnapshotStore } from "@/stores/snapshotStore";
import { useTradingStore } from "@/stores/tradingStore";

const CHAT_EXPIRY_MS = 60 * 60 * 1000;

interface Message {
  sender: "user" | "ai";
  text: string;
  kind?: "response" | "request-error" | "system";
}

function isMessage(value: unknown): value is Message {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (candidate.sender === "user" || candidate.sender === "ai")
    && typeof candidate.text === "string"
    && (candidate.kind === undefined
      || candidate.kind === "response"
      || candidate.kind === "request-error"
      || candidate.kind === "system");
}

function InlineMessage({ text }: { readonly text: string }) {
  return text.split(/(\*\*.*?\*\*|\*.*?\*)/gu).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={index} className="font-bold text-white">{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("*") && part.endsWith("*")) {
      return <em key={index} className="italic text-slate-300">{part.slice(1, -1)}</em>;
    }
    return <React.Fragment key={index}>{part}</React.Fragment>;
  });
}

const FormatMessage = ({ text }: { text: string }) => {
  const lines = text.split("\n");
  return (
    <div className="space-y-1.5 text-[13px] leading-relaxed">
      {lines.map((line, i) => {
        if (!line.trim()) return <div key={i} className="h-1"></div>;
        if (line.startsWith("### ")) return <h3 key={i} className="text-sm font-bold text-[#b388ff] mt-3 mb-1 uppercase tracking-wide">{line.replace("### ", "")}</h3>;
        if (line.startsWith("## ")) return <h2 key={i} className="text-[13px] font-bold text-white mt-2 mb-1">{line.replace("## ", "")}</h2>;
        
        const isList = line.startsWith("- ") || line.startsWith("* ");
        const content = isList ? line.substring(2) : line;
        
        if (isList) {
          return (
            <div key={i} className="flex items-start gap-2 ml-1">
              <span className="text-[#b388ff] mt-0.5">•</span>
              <span className="min-w-0 break-words"><InlineMessage text={content} /></span>
            </div>
          );
        }
        return <div key={i} className="break-words"><InlineMessage text={content} /></div>;
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
  const requestCoordinatorRef = useRef(createChatRequestCoordinator());

  const snapshot = useSnapshotStore((s) => s.snapshot);
  const loading = useSnapshotStore((s) => s.loading);
  const actionDecision = useTradingStore((s) => s.actionDecision);

  useEffect(() => () => {
    requestCoordinatorRef.current.dispose();
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isOpen]);

  useEffect(() => {
    const lastReset = localStorage.getItem("quant_chat_last_reset");
    const now = Date.now();

    const initialGreeting = snapshot
      ? "Xin chào! Tôi là **Trợ lý AI Quản trị Rủi ro (Quant Expert)**.\n\nDữ liệu `CurrentMarketSnapshot` đã được đồng bộ hóa thành công. Bạn cần tôi phân tích chiến lược gì hôm nay?"
      : "Xin chào! Tôi là **Trợ lý AI Quản trị Rủi ro (Quant Expert)**.\n\nHệ thống đang chờ dữ liệu `CurrentMarketSnapshot`. Vui lòng mở màn hình Macro V2 để tải snapshot.";

    if (!lastReset || now - parseInt(lastReset) > CHAT_EXPIRY_MS) {
      setMessages([{ sender: "ai", text: initialGreeting, kind: "system" }]);
      localStorage.setItem("quant_chat_last_reset", now.toString());
      localStorage.removeItem("quant_chat_history");
    } else {
      const savedHistory = localStorage.getItem("quant_chat_history");
      if (!savedHistory) {
        setMessages([{ sender: "ai", text: initialGreeting, kind: "system" }]);
        return;
      }
      try {
        const parsed: unknown = JSON.parse(savedHistory);
        setMessages(Array.isArray(parsed) && parsed.every(isMessage)
          ? parsed
          : [{ sender: "ai", text: initialGreeting, kind: "system" }]);
      } catch {
        setMessages([{ sender: "ai", text: initialGreeting, kind: "system" }]);
      }
    }
  }, [snapshot]);

  useEffect(() => {
    if (messages.length > 1) {
      localStorage.setItem("quant_chat_history", JSON.stringify(messages));
    }
  }, [messages]);

  const handleSend = async (text: string) => {
    if (!text.trim()) return;
    const { requestId } = requestCoordinatorRef.current.begin();
    const userText = text.trim();
    setInput("");
    setMessages((prev) => [...prev, { sender: "user", text: userText }]);

    // Strict Gate M4 Requirement: Read snapshot from shared Zustand store only.
    // MUST NOT call loadRuntimeMarketSnapshot() independently during handleSend().
    const currentSnapshot = useSnapshotStore.getState().snapshot;
    const currentActionDecision = useTradingStore.getState().actionDecision;

    setIsLoading(true);

    try {
      const reply = await requestAiAdvisor({
        operation: AI_GATEWAY_OPERATION,
        grounding: buildAiAdvisorGrounding(currentActionDecision, currentSnapshot),
        messages: [
          ...messages.slice(1).map((message) => ({
            role: message.sender === "user" ? "user" as const : "model" as const,
            text: message.text,
          })),
          { role: "user", text: userText },
        ],
      });
      if (requestCoordinatorRef.current.isCurrent(requestId)) {
        setMessages((prev) => [...prev, { sender: "ai", text: reply, kind: "response" }]);
      }
    } catch {
      if (requestCoordinatorRef.current.isCurrent(requestId)) {
        setMessages((prev) => [...prev, {
          sender: "ai",
          text: "Yêu cầu AI không thành công. Canonical ActionDecision không thay đổi; vui lòng thử lại sau.",
          kind: "request-error",
        }]);
      }
    } finally {
      if (requestCoordinatorRef.current.isCurrent(requestId)) {
        requestCoordinatorRef.current.finish(requestId);
        setIsLoading(false);
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend(input);
    }
  };

  // Truthful canonical action status; snapshot remains contextual only.
  let statusText = actionDecision
    ? `Canonical ${actionDecision.action}${actionDecision.actionDerivationStatus === "WAIT_FAIL_CLOSED" ? " · Fail-closed" : ""}`
    : "Canonical Action Unavailable";
  let statusColor = "text-rose-400";
  let dotColor = "bg-rose-400";

  if (loading) {
    statusText += " · Loading Context";
    statusColor = "text-amber-400";
    dotColor = "bg-amber-400 animate-pulse";
  } else if (actionDecision) {
    statusColor = actionDecision.actionDerivationStatus === "WAIT_FAIL_CLOSED" ? "text-amber-400" : "text-emerald-400";
    dotColor = actionDecision.actionDerivationStatus === "WAIT_FAIL_CLOSED" ? "bg-amber-400" : "bg-emerald-400 animate-pulse";
  } else if (snapshot) {
    statusText += " · Context Ready";
  }

  return (
    <>
      {!isOpen && (
        <button
          onClick={() => setIsOpen(true)}
          type="button"
          aria-label="Open grounded AI advisor"
          className="fixed bottom-3 right-3 z-[999] flex items-center justify-center rounded-full bg-gradient-to-r from-[#b388ff] to-[#7c4dff] p-3 text-white shadow-[0_0_25px_rgba(179,136,255,0.4)] transition-all hover:scale-105 sm:bottom-6 sm:right-6 sm:p-4"
        >
          <BrainCircuit size={28} />
        </button>
      )}

      {isOpen && (
        <div className="fixed inset-x-2 bottom-2 z-[999] flex h-[min(650px,calc(100vh-1rem))] max-h-[85vh] min-w-0 flex-col overflow-hidden rounded-2xl border border-[#1e293b] bg-[#0f172a] font-sans shadow-2xl sm:inset-x-auto sm:bottom-6 sm:right-6 sm:w-[450px]">
          
          <div className="flex items-center justify-between px-5 py-4 bg-[#1e293b]/50 backdrop-blur-md border-b border-[#334155]">
            <div className="flex items-center gap-3">
              <div className="bg-[#b388ff]/20 p-2 rounded-xl border border-[#b388ff]/30 shadow-inner">
                <BrainCircuit size={20} className="text-[#b388ff]" />
              </div>
              <div>
                <h3 className="font-bold text-sm text-slate-100 tracking-wide">AI Quant Expert</h3>
                <p className={clsx("text-[11px] flex items-center gap-1.5 mt-0.5 font-mono", statusColor)}>
                  <span className={clsx("w-1.5 h-1.5 rounded-full", dotColor)}></span> {statusText}
                </p>
              </div>
            </div>
            <button type="button" aria-label="Close grounded AI advisor" onClick={() => setIsOpen(false)} className="text-slate-400 hover:text-white p-1.5 rounded-lg hover:bg-slate-700 transition-colors">
              <X size={20} />
            </button>
          </div>

          <div className="flex-1 p-5 overflow-y-auto space-y-5 bg-[#0b1120]">
            {messages.map((msg, idx) => (
              <div key={idx} className={clsx("flex flex-col max-w-[90%]", msg.sender === "user" ? "ml-auto items-end" : "mr-auto items-start")}>
                <div className={clsx(
                  "min-w-0 break-words p-4 rounded-2xl shadow-md",
                  msg.sender === "user" 
                    ? "bg-gradient-to-br from-[#b388ff] to-[#9c66ff] text-black font-medium rounded-br-sm" 
                    : msg.kind === "request-error"
                    ? "border border-amber/40 bg-amber/10 text-amber rounded-bl-sm"
                    : "bg-[#1e293b] border border-[#334155] text-slate-300 rounded-bl-sm"
                )}>
                  {msg.sender === "user" ? <span className="whitespace-pre-wrap text-[13px]">{msg.text}</span> : (
                    <div>
                      <div className="mb-2 text-[9px] font-mono uppercase tracking-widest text-slate-500">AI explanation · non-authoritative</div>
                      <FormatMessage text={msg.text} />
                    </div>
                  )}
                </div>
              </div>
            ))}
            {isLoading && (
              <div className="flex items-center gap-2 text-slate-400 text-xs p-2" role="status" aria-live="polite">
                <Loader2 size={16} className="animate-spin text-[#b388ff]" /> Trợ lý đang suy luận dữ liệu...
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          <div className="px-3 pt-3 pb-2 bg-[#0f172a] flex gap-2 overflow-x-auto hide-scrollbar border-t border-[#1e293b]">
            <button type="button" onClick={() => handleSend("Tóm tắt thị trường hôm nay và tôi nên hành động thế nào?")} className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 bg-[#1e293b] hover:bg-[#b388ff]/20 text-[#b388ff] rounded-lg text-[11px] font-medium transition-colors whitespace-nowrap border border-[#334155]">
              <MessageSquareText size={14} /> Tóm tắt & Hành động
            </button>
            <button type="button" onClick={() => handleSend("Trong 3 tháng tới tôi nên tái cơ cấu tỷ trọng tài sản ra sao để tối đa hóa thu nhập/vốn?")} className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 bg-[#1e293b] hover:bg-[#b388ff]/20 text-[#b388ff] rounded-lg text-[11px] font-medium transition-colors whitespace-nowrap border border-[#334155]">
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
              className="min-h-[44px] min-w-0 flex-1 resize-none bg-[#1e293b] border border-[#334155] text-slate-100 px-4 py-3 rounded-xl text-[13px] focus:outline-none focus:border-[#b388ff] max-h-32 custom-scrollbar disabled:opacity-60"
            />
            <button type="submit" disabled={!input.trim()} className="bg-gradient-to-br from-[#b388ff] to-[#9c66ff] hover:opacity-90 text-black font-bold w-11 h-11 rounded-xl flex items-center justify-center transition-all disabled:opacity-50 shadow-lg shrink-0">
              <Send size={18} className="ml-0.5" />
            </button>
          </form>

        </div>
      )}
    </>
  );
};
