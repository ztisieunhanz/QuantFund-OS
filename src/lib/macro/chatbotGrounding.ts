// ============================================================================
// FILE: src/lib/macro/chatbotGrounding.ts
// MODULE: MACRO V2 CHATBOT GROUNDING SERIALIZER & PROMPT BUILDER (GATE M4)
// PRINCIPLE: Grounded AI Responses strictly based on CurrentMarketSnapshot (DEC-011)
// ============================================================================

import { formatGoldLabel } from "./helpers";
import type { AvailableMacroDatum, CurrentMarketSnapshot, MacroDatum } from "./types";

function formatDatumForChat(datum: MacroDatum<unknown>): string {
  if (!datum || datum.status === "UNAVAILABLE") {
    return "UNAVAILABLE (Data missing/unfetchable)";
  }

  const avail = datum as AvailableMacroDatum<unknown>;
  const basisTag = avail.basis ? ` [Basis: ${avail.basis}]` : "";
  const asOfStr = new Date(avail.asOf).toISOString();

  if (typeof avail.value === "number") {
    return `${avail.value} (${avail.sourceClassification} via ${avail.provider} ${avail.instrument}, asOf: ${asOfStr})${basisTag}`;
  }

  if (typeof avail.value === "object" && avail.value !== null) {
    return `${JSON.stringify(avail.value)} (${avail.sourceClassification} via ${avail.provider}, asOf: ${asOfStr})${basisTag}`;
  }

  return `${String(avail.value)} (${avail.sourceClassification}, asOf: ${asOfStr})${basisTag}`;
}

/**
 * Serializes CurrentMarketSnapshot into a structured prompt context for Chatbot grounding.
 */
export function serializeCurrentMarketSnapshotForChatbot(
  snapshot: CurrentMarketSnapshot
): string {
  const d = snapshot.data;
  const m = snapshot.macro;
  const q = snapshot.quant;
  const r = snapshot.risk;
  const o = snapshot.omega;
  const s = snapshot.synthesis;

  const lines: string[] = [];

  lines.push("==================================================");
  lines.push("CURRENT MARKET SNAPSHOT CONTEXT (AUTHORITATIVE)");
  lines.push(`Snapshot Timestamp: ${new Date(snapshot.timestamp).toISOString()}`);
  lines.push("==================================================");
  lines.push("");

  // SECTION 1: OBSERVED DATA
  lines.push("--- 1. OBSERVED DATA (LAYER 1) ---");
  lines.push(`DXY Index: ${formatDatumForChat(d.dxy)}`);
  lines.push(`US 2Y Yield: ${formatDatumForChat(d.us2y)}`);
  lines.push(`US 10Y Yield: ${formatDatumForChat(d.us10y)}`);
  lines.push(`VIX Volatility: ${formatDatumForChat(d.vix)}`);

  const goldLabel = formatGoldLabel(d.gold);
  lines.push(`${goldLabel}: ${formatDatumForChat(d.gold)}`);

  lines.push(`Bitcoin (BTC): ${formatDatumForChat(d.btc)}`);
  lines.push(`VN-Index: ${formatDatumForChat(d.vnindex)}`);
  lines.push(`Vietnam Market Breadth: ${formatDatumForChat(d.breadth)}`);
  lines.push(`Vietnam Market Liquidity: ${formatDatumForChat(d.liquidity)}`);
  lines.push(`Vietnam Foreign Flow: ${formatDatumForChat(d.foreignFlow)}`);
  lines.push("");

  // SECTION 2: MODEL OUTPUT
  lines.push("--- 2. MODEL OUTPUT (LAYER 2) ---");

  // Macro Assessment
  if (m && m.status === "AVAILABLE") {
    lines.push(`Macro Regime: ${m.regime ?? "MIXED"} (Confidence: ${m.confidence ?? "N/A"}/100)`);
    lines.push(`Usable Core Metrics: ${m.usableMetrics.join(", ") || "None"}`);
    lines.push(`Unavailable/Stale Metrics: ${[...m.unavailableMetrics, ...m.staleMetrics].join(", ") || "None"}`);
  } else {
    lines.push(`Macro Regime: INSUFFICIENT_DATA (${m?.reason ?? "Missing required core metrics"})`);
  }

  // Quant Layer
  if (q && q.status !== "UNAVAILABLE") {
    lines.push(`Quant Engine Status: ${q.status}`);
    lines.push(`Strongest Alpha Signal: ${q.strongestStrategyId ? `${q.strongestStrategyId} (defined strictly as the largest absolute currently valid normalized alpha signal)` : "None"}`);
    lines.push("Active Strategy Signals:");
    for (const strat of q.strategies) {
      lines.push(`  - ${strat.name} (${strat.id}): Signal=${strat.signal ?? "N/A"} [State: ${strat.state}]`);
    }
  } else {
    lines.push("Quant Engine Status: UNAVAILABLE");
  }

  // Risk Layer
  if (r && r.status === "AVAILABLE") {
    lines.push(`Risk State: ${r.riskState ?? "NORMAL"}`);
    lines.push(`Allowed Target Exposure: ${r.allowedExposure != null ? r.allowedExposure : "N/A"}`);
    lines.push(`Gross Exposure: ${r.grossExposure != null ? r.grossExposure : "N/A"}`);
    if (r.note) lines.push(`Risk Note: ${r.note}`);
  } else {
    lines.push("Risk State: UNAVAILABLE (Operating without live risk limits)");
  }

  // Omega Layer
  if (o && o.status === "AVAILABLE" && o.targetWeights) {
    const wStr = Object.entries(o.targetWeights)
      .map(([k, v]) => `${k}: ${(v * 100).toFixed(1)}%`)
      .join(", ");
    lines.push(`Omega Target Weights (Paper/Research Allocation Only): ${wStr}`);
  } else {
    lines.push("Omega Target Weights: UNAVAILABLE");
  }
  lines.push("");

  // SECTION 3: INTERPRETATION (SYNTHESIS)
  lines.push("--- 3. INTERPRETATION & SYNTHESIS (LAYER 3) ---");
  if (s) {
    lines.push(`Synthesis Status: ${s.status}`);
    lines.push(`Market Stance: ${s.stance}`);
    lines.push(`Synthesis Confidence: ${s.confidence != null ? `${s.confidence}/100` : "N/A"}`);
    lines.push(`Headline: ${s.headline}`);
    lines.push("Rationale:");
    for (const rItem of s.rationale) {
      lines.push(`  - ${rItem}`);
    }
    if (s.supportingEvidence.length > 0) {
      lines.push("Supporting Evidence:");
      for (const ev of s.supportingEvidence) {
        lines.push(`  - [${ev.layer}] ${ev.description} (Sources: ${ev.sourceIds.join(", ")})`);
      }
    }
    if (s.conflictingEvidence.length > 0) {
      lines.push("Conflicting Evidence:");
      for (const ev of s.conflictingEvidence) {
        lines.push(`  - [${ev.layer}] ${ev.description} (Sources: ${ev.sourceIds.join(", ")})`);
      }
    }
    if (s.risks.length > 0) {
      lines.push("Identified Risks:");
      for (const rk of s.risks) {
        lines.push(`  - ${rk}`);
      }
    }
    if (s.invalidation.length > 0) {
      lines.push("Invalidation Triggers:");
      for (const inv of s.invalidation) {
        lines.push(`  - ${inv}`);
      }
    }
  } else {
    lines.push("Synthesis: NOT_EVALUATED");
  }
  lines.push("");

  // SECTION 4: UNCERTAINTY & BOUNDARIES
  lines.push("--- 4. UNCERTAINTY & CHATBOT BOUNDARIES ---");
  lines.push(`Data Coverage Ratio: ${s ? (s.dataCoverage * 100).toFixed(0) : "0"}%`);
  if (!s || s.status === "PARTIAL" || s.status === "INSUFFICIENT_DATA") {
    lines.push("WARNING: Market data or model layer output is PARTIAL or INSUFFICIENT. Explicitly state uncertainty and refrain from making confident predictions.");
  }
  lines.push("INSTRUCTIONS TO MODEL:");
  lines.push("- Current snapshot contains the above observed and model-derived information. Respect provenance and unavailable fields.");
  lines.push("- Do NOT invent missing market data or convert UNAVAILABLE into a numeric estimate.");
  lines.push("- Do NOT call strongestStrategyId 'best strategy'. Describe it strictly as the largest absolute currently valid normalized signal.");
  lines.push("- Do NOT claim strategy profitability, win rate, Sharpe ratio, or PnL unless canonical validated evidence exists.");
  lines.push("- Do NOT reinterpret Omega paper weights as an investment recommendation or financial advice.");
  lines.push("- Do NOT claim confidence is a forecast probability.");

  return lines.join("\n");
}

/**
 * Builds the full system prompt for Gemini Chatbot grounded strictly on CurrentMarketSnapshot.
 */
export function buildGroundedChatbotSystemPrompt(
  snapshot: CurrentMarketSnapshot
): string {
  const contextStr = serializeCurrentMarketSnapshotForChatbot(snapshot);

  return `
Đóng vai trò là Chuyên gia Phân tích Định lượng & Quản trị Rủi ro (AI Quant Expert) của QuantFund OS.
Trả lời bằng tiếng Việt chuyên nghiệp, sắc bén, khách quan và sử dụng Markdown:
- Dùng "### [Tiêu đề]" cho các ý chính.
- Dùng "**[Từ khóa]**" để in đậm các chỉ số hoặc thuật ngữ quan trọng.
- Dùng "- " cho các gạch đầu dòng.

QUY TẮC AN TOÀN & CHÍNH XÁC (NON-NEGOTIABLE):
1. CHỈ dựa vào thông tin có trong DỮ LIỆU SNAPSHOT THỰC TẾ bên dưới.
2. TUYỆT ĐỐI KHÔNG tự tạo dữ liệu thị trường bị thiếu (UNAVAILABLE). Nếu dữ liệu thiếu, phải trả lời rõ là UNAVAILABLE.
3. KHÔNG gọi chiến lược mạnh nhất là "chiến lược tốt nhất" hay "chiến lược lời nhất". Chỉ mô tả nó là chiến lược có tín hiệu alpha chuẩn hóa tuyệt đối lớn nhất hiện tại.
4. KHÔNG bịa đặt tỷ lệ thắng (win rate), PnL, PnL từng chiến lược hay Sharpe ratio.
5. KHÔNG biến phân bổ Omega Paper thành lời khuyên đầu tư tài chính. Mọi phân bổ chỉ là mô phỏng nghiên cứu (Paper/Research Allocation).
6. Khi trạng thái tổng hợp là PARTIAL hoặc INSUFFICIENT_DATA, BẮT BUỘC phải nêu rõ yếu tố không chắc chắn (Uncertainty).

${contextStr}
  `.trim();
}
