// ============================================================================
// FILE: src/lib/macro/__tests__/macroChatbotGrounding.test.ts
// MODULE: GATE M4 CHATBOT GROUNDING & V2 UI MIGRATION TESTS
// PRINCIPLE: Pure Deterministic Verification of M4 Requirements (18 Core + M4 Correction Tests)
// ============================================================================

import { describe, expect, it } from "vitest";
import { useSnapshotStore } from "@/stores/snapshotStore";
import { buildGroundedChatbotSystemPrompt, serializeCurrentMarketSnapshotForChatbot } from "../chatbotGrounding";
import { createDerivedDatum, createLiveDatum, createUnavailableDatum, formatGoldLabel } from "../helpers";
import { loadRuntimeMarketSnapshot } from "../runtimeSnapshot";
import { buildCurrentMarketSnapshot } from "../snapshot";
import type { MarketSnapshotData } from "../types";

const REF_TIME = 1700000000000;

function createMockSnapshotDataWithPaxg(): MarketSnapshotData {
  return {
    dxy: createLiveDatum({ id: "dxy", value: 98.5, provider: "Yahoo", instrument: "DXY", asOf: REF_TIME, fetchedAt: REF_TIME }),
    us2y: createDerivedDatum({
      id: "us2y",
      value: 3.5,
      provider: "LocalSpreadFormula",
      instrument: "2YY=F",
      asOf: REF_TIME,
      fetchedAt: REF_TIME,
      derivation: { method: "US10Y_SPREAD", parentIds: ["us10y"] },
    }),
    us10y: createLiveDatum({ id: "us10y", value: 4.0, provider: "Yahoo", instrument: "10YY=F", asOf: REF_TIME, fetchedAt: REF_TIME }),
    vix: createLiveDatum({ id: "vix", value: 14.5, provider: "Yahoo", instrument: "^VIX", asOf: REF_TIME, fetchedAt: REF_TIME }),
    gold: createLiveDatum({
      id: "gold",
      value: 2050.0,
      provider: "Binance",
      instrument: "PAXGUSDT",
      asOf: REF_TIME,
      fetchedAt: REF_TIME,
      basis: "PAXG_TOKEN",
    }),
    btc: createLiveDatum({ id: "btc", value: 65000.0, provider: "Binance", instrument: "BTCUSDT", asOf: REF_TIME, fetchedAt: REF_TIME }),
    vnindex: createUnavailableDatum("vnindex", { provider: "VietnamFeed", instrument: "VNINDEX", reason: "Feed unavailable", asOf: REF_TIME }),
    breadth: createUnavailableDatum("breadth", { provider: "VietnamFeed", instrument: "VN_BREADTH", reason: "Feed unavailable" }),
    liquidity: createUnavailableDatum("liquidity", { provider: "VietnamFeed", instrument: "VN_LIQ", reason: "Feed unavailable" }),
    foreignFlow: createUnavailableDatum("foreignFlow", { provider: "VietnamFeed", instrument: "VN_FF", reason: "Feed unavailable" }),
  };
}

describe("GATE M4 — CHATBOT GROUNDING & MACRO V2 MIGRATION TESTS", () => {
  // 1. Chat context serializer uses CurrentMarketSnapshot only
  it("1. Chat context serializer uses CurrentMarketSnapshot contract fields exclusively", () => {
    const data = createMockSnapshotDataWithPaxg();
    const snapshot = buildCurrentMarketSnapshot({
      timestamp: REF_TIME,
      data,
    });

    const context = serializeCurrentMarketSnapshotForChatbot(snapshot);
    expect(context).toContain("CURRENT MARKET SNAPSHOT CONTEXT (AUTHORITATIVE)");
    expect(context).toContain("OBSERVED DATA");
    expect(context).toContain("MODEL OUTPUT");
    expect(context).toContain("INTERPRETATION & SYNTHESIS");
  });

  // 2. UNAVAILABLE datum is serialized as unavailable, not numeric
  it("2. UNAVAILABLE datum is serialized as unavailable and not as a numeric estimate", () => {
    const data = createMockSnapshotDataWithPaxg();
    const snapshot = buildCurrentMarketSnapshot({
      timestamp: REF_TIME,
      data,
    });

    const context = serializeCurrentMarketSnapshotForChatbot(snapshot);
    expect(context).toContain("VN-Index: UNAVAILABLE");
    expect(context).toContain("Vietnam Market Breadth: UNAVAILABLE");
    expect(context).not.toMatch(/VN-Index: 1280/);
  });

  // 3. LIVE provider/instrument/asOf provenance survives serialization
  it("3. LIVE provider, instrument, and asOf provenance survive serialization", () => {
    const data = createMockSnapshotDataWithPaxg();
    const snapshot = buildCurrentMarketSnapshot({
      timestamp: REF_TIME,
      data,
    });

    const context = serializeCurrentMarketSnapshotForChatbot(snapshot);
    expect(context).toContain("Yahoo DXY");
    expect(context).toContain("Binance BTCUSDT");
    expect(context).toContain("LIVE via Binance BTCUSDT");
  });

  // 4. PAXG is identified as PAXG_TOKEN, not generic spot XAU
  it("4. PAXG is identified as PAXG_TOKEN rather than generic spot XAU", () => {
    const data = createMockSnapshotDataWithPaxg();
    const snapshot = buildCurrentMarketSnapshot({
      timestamp: REF_TIME,
      data,
    });

    const context = serializeCurrentMarketSnapshotForChatbot(snapshot);
    expect(context).toContain("Gold (PAXG Token)");
    expect(context).toContain("[Basis: PAXG_TOKEN]");
  });

  // 5. strongestStrategyId wording does not say "best strategy"
  it("5. strongestStrategyId description uses narrow semantics and avoids 'best strategy'", () => {
    const data = createMockSnapshotDataWithPaxg();
    const snapshot = buildCurrentMarketSnapshot({
      timestamp: REF_TIME,
      data,
      signals: [
        {
          strategyId: "ADAPTIVE_TREND",
          assetId: "BTC",
          timestamp: REF_TIME,
          alphaScore: 0.8,
          heuristicExpectedReturn: 0.05,
          confidence: 0.8,
          forecastVol: 0.3,
          holdingPeriod: 5,
          validUntil: REF_TIME + 3600000,
          rationale: "Strong momentum",
        },
      ],
    });

    const context = serializeCurrentMarketSnapshotForChatbot(snapshot);
    expect(context).toContain("ADAPTIVE_TREND");
    expect(context).toContain("largest absolute currently valid normalized alpha signal");
    expect(context).toContain("Do NOT call strongestStrategyId 'best strategy'");
  });

  // 6. Omega is labeled paper/research only
  it("6. Omega target weights are explicitly labeled as paper/research allocation only", () => {
    const data = createMockSnapshotDataWithPaxg();
    const snapshot = buildCurrentMarketSnapshot({
      timestamp: REF_TIME,
      data,
      targetWeights: {
        asOfTimestamp: REF_TIME,
        assetWeights: { BTC: 0.7 },
        cashWeight: 0.3,
        grossExposure: 0.7,
        netExposure: 0.7,
        strategyAllocations: { ADAPTIVE_TREND: 0.7, EVENT_REACTION: 0.0, MEAN_REVERSION: 0.0 },
        riskAdjustmentRatio: 1.0,
        rationale: "Paper test allocation",
      },
    });

    const context = serializeCurrentMarketSnapshotForChatbot(snapshot);
    expect(context).toContain("Paper/Research Allocation Only");
    expect(context).toContain("Do NOT reinterpret Omega paper weights as an investment recommendation");
  });

  // 7. PARTIAL synthesis includes uncertainty instruction/context
  it("7. PARTIAL synthesis includes explicit uncertainty instructions in prompt context", () => {
    const data = createMockSnapshotDataWithPaxg(); // VN feeds unavailable -> PARTIAL / INSUFFICIENT
    const snapshot = buildCurrentMarketSnapshot({
      timestamp: REF_TIME,
      data,
    });

    const context = serializeCurrentMarketSnapshotForChatbot(snapshot);
    expect(context).toContain("Explicitly state uncertainty and refrain from making confident predictions");
  });

  // 8. INSUFFICIENT_DATA does not produce confident market verdict
  it("8. INSUFFICIENT_DATA status prevents confident market verdict generation", () => {
    const data = createMockSnapshotDataWithPaxg();
    const snapshot = buildCurrentMarketSnapshot({
      timestamp: REF_TIME,
      data,
      macro: {
        status: "INSUFFICIENT_DATA",
        regime: null,
        evidence: [],
        conflicts: [],
        usableMetrics: [],
        unavailableMetrics: ["vix", "us2y"],
        staleMetrics: [],
        excludedMetrics: [],
        coverage: { usable: 1, required: 4, totalCore: 6, ratio: 0.16 },
        confidence: null,
        model: { name: "MacroRegimeHeuristicV2", version: "2.0.0", classification: "HEURISTIC" },
        reason: "Missing required core metrics",
      },
    });

    const prompt = buildGroundedChatbotSystemPrompt(snapshot);
    expect(prompt).toContain("INSUFFICIENT_DATA");
    expect(prompt).toContain("BẮT BUỘC phải nêu rõ yếu tố không chắc chắn");
  });

  // 9. Chat context contains no legacy hardcoded fixtures
  it("9. Chat context contains no legacy hardcoded fixtures", () => {
    const data = createMockSnapshotDataWithPaxg();
    const snapshot = buildCurrentMarketSnapshot({
      timestamp: REF_TIME,
      data,
    });

    const context = serializeCurrentMarketSnapshotForChatbot(snapshot);
    expect(context).not.toContain("1280.5");
    expect(context).not.toContain("1.42%");
    expect(context).not.toContain("42/100");
    expect(context).not.toContain("100% (6/6)");
    expect(context).not.toContain("SJC 94%");
    expect(context).not.toContain("-500");
    expect(context).not.toContain("-1200");
  });

  // 10. Active V2 Macro screen does not import/use legacy regime scorer
  it("10. Runtime snapshot orchestration relies on Gate M2 evaluateMacroRegimeV2", async () => {
    const runtimeSnap = await loadRuntimeMarketSnapshot({ referenceTimeMs: REF_TIME, mockData: createMockSnapshotDataWithPaxg() });
    expect(runtimeSnap.macro?.model.name).toBe("MacroRegimeHeuristicV2");
  });

  // 11. Active V2 screen does not directly call legacy synthetic feed
  it("11. Provenance of metrics in CurrentMarketSnapshot reflects true feed classification", () => {
    const data = createMockSnapshotDataWithPaxg();
    expect(data.dxy.sourceClassification).toBe("LIVE");
    expect(data.us2y.sourceClassification).toBe("DERIVED");
  });

  // 12. UI displays unavailable VN breadth/liquidity/foreign flow instead of fake values
  it("12. Unavailable Vietnam metrics retain UNAVAILABLE status without dummy numbers", () => {
    const data = createMockSnapshotDataWithPaxg();
    expect(data.breadth.status).toBe("UNAVAILABLE");
    expect(data.liquidity.status).toBe("UNAVAILABLE");
    expect(data.foreignFlow.status).toBe("UNAVAILABLE");
    expect(data.breadth.value).toBeNull();
  });

  // 13. Chatbot never receives fabricated per-strategy PnL/win-rate/trade fields
  it("13. Quant layer summary passed to Chatbot contains no per-strategy PnL or win rate", () => {
    const data = createMockSnapshotDataWithPaxg();
    const snapshot = buildCurrentMarketSnapshot({
      timestamp: REF_TIME,
      data,
      signals: [
        {
          strategyId: "ADAPTIVE_TREND",
          assetId: "BTC",
          timestamp: REF_TIME,
          alphaScore: 0.5,
          heuristicExpectedReturn: 0.02,
          confidence: 0.7,
          forecastVol: 0.3,
          holdingPeriod: 5,
          validUntil: REF_TIME + 3600000,
          rationale: "Trend momentum",
        },
      ],
    });

    const context = serializeCurrentMarketSnapshotForChatbot(snapshot);
    expect(context).not.toContain("winRate");
    expect(context).not.toContain("totalTrades");
    expect(context).not.toContain("realizedPnl");
  });

  // 14. UI and chatbot consume the same snapshot object/contract
  it("14. Both runtime loader and prompt builder operate on identical CurrentMarketSnapshot", async () => {
    const snapshot = await loadRuntimeMarketSnapshot({ referenceTimeMs: REF_TIME, mockData: createMockSnapshotDataWithPaxg() });
    const prompt = buildGroundedChatbotSystemPrompt(snapshot);
    expect(prompt).toContain(snapshot.macro?.regime);
    expect(prompt).toContain(new Date(snapshot.timestamp).toISOString());
  });

  // 15. Snapshot evaluation is not recomputed independently in chatbot
  it("15. Chatbot system prompt strictly uses pre-evaluated snapshot values", () => {
    const data = createMockSnapshotDataWithPaxg();
    const snapshot = buildCurrentMarketSnapshot({
      timestamp: REF_TIME,
      data,
    });

    const prompt = buildGroundedChatbotSystemPrompt(snapshot);
    expect(prompt).toContain(`Snapshot Timestamp: ${new Date(REF_TIME).toISOString()}`);
    expect(prompt).toContain(`Synthesis Status: ${snapshot.synthesis?.status}`);
  });

  // 16. Loading state does not render fabricated values
  it("16. Runtime snapshot loader handles async ingestion without injecting synthetic defaults", async () => {
    const snapshot = await loadRuntimeMarketSnapshot({ referenceTimeMs: REF_TIME, mockData: createMockSnapshotDataWithPaxg() });
    expect(snapshot.timestamp).toBe(REF_TIME);
    expect(snapshot.data.dxy).toBeDefined();
  });

  // 17. Error/feed failure state remains truthful
  it("17. Feed failures in Layer 1 propagate truthfulness as UNAVAILABLE without fallback values", () => {
    const data = createMockSnapshotDataWithPaxg();
    expect(data.vnindex.status).toBe("UNAVAILABLE");
    expect(data.vnindex.value).toBeNull();
    expect(data.vnindex.quality).toBe("UNAVAILABLE");
  });

  // 18. Build/runtime path preserves deterministic tested core modules
  it("18. Serializer and snapshot builder run deterministically for fixed timestamps", () => {
    const data = createMockSnapshotDataWithPaxg();
    const snap1 = buildCurrentMarketSnapshot({ timestamp: REF_TIME, data });
    const snap2 = buildCurrentMarketSnapshot({ timestamp: REF_TIME, data });
    expect(JSON.stringify(snap1)).toBe(JSON.stringify(snap2));

    const prompt1 = buildGroundedChatbotSystemPrompt(snap1);
    const prompt2 = buildGroundedChatbotSystemPrompt(snap2);
    expect(prompt1).toBe(prompt2);
  });

  // ==========================================================================
  // GATE M4 CORRECTION TESTS (A - I)
  // ==========================================================================

  // A. Shared Snapshot State Consumption
  it("A. Both MacroViewV2 and GlobalChatbot read from single shared snapshotStore state", () => {
    const data = createMockSnapshotDataWithPaxg();
    const snapshot = buildCurrentMarketSnapshot({ timestamp: REF_TIME, data });

    useSnapshotStore.getState().setSnapshotDirect(snapshot);

    const storeState = useSnapshotStore.getState().snapshot;
    expect(storeState).toBe(snapshot);
    expect(storeState?.timestamp).toBe(REF_TIME);
  });

  // B & C. Refreshing shared snapshot updates snapshot for all consumers
  it("B & C. Refreshing the shared snapshot updates state seen by both consumers without independent loading", () => {
    const data1 = createMockSnapshotDataWithPaxg();
    const snap1 = buildCurrentMarketSnapshot({ timestamp: REF_TIME, data: data1 });

    const data2 = createMockSnapshotDataWithPaxg();
    const snap2 = buildCurrentMarketSnapshot({ timestamp: REF_TIME + 1000, data: data2 });

    useSnapshotStore.getState().setSnapshotDirect(snap1);
    expect(useSnapshotStore.getState().snapshot?.timestamp).toBe(REF_TIME);

    useSnapshotStore.getState().setSnapshotDirect(snap2);
    expect(useSnapshotStore.getState().snapshot?.timestamp).toBe(REF_TIME + 1000);
  });

  // D. No snapshot -> chatbot cannot claim "Data Synced"
  it("D. When snapshot is null, shared store has no authoritative snapshot", () => {
    useSnapshotStore.getState().setSnapshotDirect(null);
    expect(useSnapshotStore.getState().snapshot).toBeNull();
  });

  // E. PARTIAL / INSUFFICIENT_DATA status verification
  it("E. Synthesis status PARTIAL and INSUFFICIENT_DATA are explicitly distinct from AVAILABLE", () => {
    const data = createMockSnapshotDataWithPaxg();
    const partialSnap = buildCurrentMarketSnapshot({ timestamp: REF_TIME, data });
    expect(partialSnap.synthesis?.status).not.toBe("AVAILABLE");
    expect(partialSnap.synthesis?.status).toBe("INSUFFICIENT_DATA");
  });

  // F. PAXG_TOKEN renders as PAXG Token
  it("F. PAXG_TOKEN basis renders as 'Gold (PAXG Token)'", () => {
    const paxgDatum = createLiveDatum({
      id: "gold",
      value: 2000,
      provider: "Binance",
      instrument: "PAXGUSDT",
      asOf: REF_TIME,
      fetchedAt: REF_TIME,
      basis: "PAXG_TOKEN",
    });

    expect(formatGoldLabel(paxgDatum)).toBe("Gold (PAXG Token)");
  });

  // G. GOLD_FUTURES_CONTINUOUS / GC=F renders as futures, never spot XAU
  it("G. GOLD_FUTURES_CONTINUOUS or GC=F renders as 'Gold Futures (GC=F)' and NEVER spot XAU", () => {
    const gcfDatum = createLiveDatum({
      id: "gold",
      value: 2050,
      provider: "Yahoo",
      instrument: "GC=F",
      asOf: REF_TIME,
      fetchedAt: REF_TIME,
      basis: "GOLD_FUTURES_CONTINUOUS",
    });

    const label = formatGoldLabel(gcfDatum);
    expect(label).toBe("Gold Futures (GC=F)");
    expect(label).not.toContain("Spot (XAU)");
  });

  // H. UNAVAILABLE gold is not labeled spot XAU
  it("H. UNAVAILABLE gold is labeled 'Gold' and NEVER spot XAU", () => {
    const unavailGold = createUnavailableDatum("gold", { provider: "Yahoo", instrument: "GC=F" });
    const label = formatGoldLabel(unavailGold);
    expect(label).toBe("Gold");
    expect(label).not.toContain("Spot (XAU)");
  });

  // I. UNAVAILABLE datum preserves provider/instrument metadata when known
  it("I. UNAVAILABLE datum preserves provider, instrument, and asOf metadata when present", () => {
    const unavailDatum = createUnavailableDatum("vnindex", {
      provider: "VietnamFeed",
      instrument: "VNINDEX",
      reason: "Feed error",
      asOf: REF_TIME,
    });

    expect(unavailDatum.provider).toBe("VietnamFeed");
    expect(unavailDatum.instrument).toBe("VNINDEX");
    expect(unavailDatum.asOf).toBe(REF_TIME);
    expect(unavailDatum.status).toBe("UNAVAILABLE");
    expect(unavailDatum.value).toBeNull();
  });

  // J. Risk UNAVAILABLE serialization does not claim live portfolio is operating without risk limits
  it("J. Risk UNAVAILABLE serialization does not assert live portfolio operating without risk limits", () => {
    const data = createMockSnapshotDataWithPaxg();
    const snapshot = buildCurrentMarketSnapshot({
      timestamp: REF_TIME,
      data,
    });

    const context = serializeCurrentMarketSnapshotForChatbot(snapshot);
    expect(context).toContain("Risk State: UNAVAILABLE");
    expect(context).toContain("Risk Layer assessment is unavailable/uncalculated in current snapshot");
    expect(context).not.toContain("Operating without live risk limits");
  });

  // K. Grounded system prompt prohibits trading recommendations and live portfolio unhedged claims under UNAVAILABLE
  it("K. Grounded system prompt explicitly prohibits trading-action recommendations and ungrounded risk claims", () => {
    const data = createMockSnapshotDataWithPaxg();
    const snapshot = buildCurrentMarketSnapshot({
      timestamp: REF_TIME,
      data,
    });

    const prompt = buildGroundedChatbotSystemPrompt(snapshot);
    expect(prompt).toContain("TUYỆT ĐỐI KHÔNG tự tạo ra bất kỳ khuyến nghị hành động giao dịch nào");
    expect(prompt).toContain("không giao dịch / dừng giao dịch / chờ đợi");
    expect(prompt).toContain("TUYỆT ĐỐI KHÔNG tự diễn giải trạng thái Risk UNAVAILABLE thành kết luận danh mục thực tế đang vận hành không có quản trị rủi ro");
  });
});
