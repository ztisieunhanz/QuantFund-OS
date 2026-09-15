// ============================================================================
// FILE: src/lib/paperEngine.ts
// MODULE: QUANT ADAPTER & REPLAY ENGINE (LIVE STREAM SYNCED)
// ============================================================================

import type {
  BotMetrics,
  EquityPoint,
  OhlcvBar,
  PositionSide,
  QuantBotId,
  TradeFill,
} from "@/types/market";

import { runBacktest, type BacktestDataset } from "@/lib/quant/backtestEngine";
import type {
  BacktestConfig,
  DecisionState,
  PointInTimeBar,
  PointInTimeEvent,
  PointInTimeMacro,
  StrategyId,
} from "@/lib/quant/types";

import { useMacroStore } from "@/stores/macroStore";

export const STARTING_EQUITY = 10_000;
export const FEE_BPS = 0.001;       // 10 bps hoa hồng
export const SLIPPAGE_BPS = 0.0005; // 5 bps trượt giá cố định

interface SubBotTracker {
  readonly id: QuantBotId;
  readonly strategyId: StrategyId | "OMEGA_PORTFOLIO" | "BENCHMARK_DCA";
  readonly name: string;
  cash: number;
  qty: number;
  entryPrice: number | null;
  realizedPnl: number;
  wins: number;
  losses: number;
  peakNav: number;
  maxDrawdown: number;
  trades: TradeFill[];
  equityCurve: EquityPoint[];
  lastSignalDescription: string;
}

function createSubBot(
  id: QuantBotId,
  strategyId: StrategyId | "OMEGA_PORTFOLIO" | "BENCHMARK_DCA",
  name: string
): SubBotTracker {
  return {
    id,
    strategyId,
    name,
    cash: STARTING_EQUITY,
    qty: 0,
    entryPrice: null,
    realizedPnl: 0,
    wins: 0,
    losses: 0,
    peakNav: STARTING_EQUITY,
    maxDrawdown: 0,
    trades: [],
    equityCurve: [],
    lastSignalDescription: "INITIALIZING",
  };
}

function toBotMetrics(tracker: SubBotTracker, markPrice: number): BotMetrics {
  const currentEquity = tracker.cash + tracker.qty * markPrice;
  const closedTradesCount = tracker.wins + tracker.losses;
  const pnl = currentEquity - STARTING_EQUITY;
  const position: PositionSide = tracker.qty > 0.00001 ? "LONG" : "FLAT";

  return {
    botId: tracker.id,
    name: tracker.name,
    cash: Math.round(tracker.cash * 100) / 100,
    qty: Math.round(tracker.qty * 100000) / 100000,
    lastPrice: markPrice,
    equity: Math.round(currentEquity * 100) / 100,
    pnl: Math.round(pnl * 100) / 100,
    pnlPct: pnl / STARTING_EQUITY,
    winRate: closedTradesCount === 0 ? 0 : tracker.wins / closedTradesCount,
    maxDrawdown: tracker.maxDrawdown,
    totalTrades: tracker.trades.length,
    wins: tracker.wins,
    losses: tracker.losses,
    position,
    lastSignal: tracker.lastSignalDescription,
    trades: tracker.trades,
    equityCurve: tracker.equityCurve,
  };
}

export class PaperEngine {
  trend: SubBotTracker = createSubBot("trend", "ADAPTIVE_TREND", "Alpha 1 · Adaptive Trend");
  event: SubBotTracker = createSubBot("event", "EVENT_REACTION", "Alpha 2 · Event Catalyst");
  mean: SubBotTracker = createSubBot("meanrev", "MEAN_REVERSION", "Alpha 3 · Mean Reversion");
  omega: SubBotTracker = createSubBot("omega", "OMEGA_PORTFOLIO", "Omega · Quant Meta-Fund");
  benchmarkDca: SubBotTracker = createSubBot("benchmark_dca", "BENCHMARK_DCA", "Control · Passive DCA 5%");
  
  latestDecision: DecisionState | null = null;

  reset(): void {
    this.trend = createSubBot("trend", "ADAPTIVE_TREND", "Alpha 1 · Adaptive Trend");
    this.event = createSubBot("event", "EVENT_REACTION", "Alpha 2 · Event Catalyst");
    this.mean = createSubBot("meanrev", "MEAN_REVERSION", "Alpha 3 · Mean Reversion");
    this.omega = createSubBot("omega", "OMEGA_PORTFOLIO", "Omega · Quant Meta-Fund");
    this.benchmarkDca = createSubBot("benchmark_dca", "BENCHMARK_DCA", "Control · Passive DCA 5%");
    this.latestDecision = null;
  }

  replay(
    bars: OhlcvBar[]
  ): {
    trend: BotMetrics;
    event: BotMetrics;
    mean: BotMetrics;
    omega: BotMetrics;
    benchmarkDca: BotMetrics;
    latestDecision: DecisionState | null;
  } {
    this.reset();
    const lastClosePrice = bars && bars.length > 0 ? (bars.at(-1)?.close ?? 0) : 0;

    // Yêu cầu tối thiểu 130 nến để vượt qua 125 nến warmup của Adaptive Trend
    if (!bars || bars.length < 130) {
      return {
        trend: toBotMetrics(this.trend, lastClosePrice),
        event: toBotMetrics(this.event, lastClosePrice),
        mean: toBotMetrics(this.mean, lastClosePrice),
        omega: toBotMetrics(this.omega, lastClosePrice),
        benchmarkDca: toBotMetrics(this.benchmarkDca, lastClosePrice),
        latestDecision: null,
      };
    }

    try {
      const pitBars: PointInTimeBar[] = bars.map((b) => ({
        timestamp: b.time < 1e11 ? b.time * 1000 : b.time,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
      }));

      const macroStore = useMacroStore.getState();
      const seriesList = macroStore?.series ?? [];

      const yld10 = seriesList.find((s) => s.id === "us10y")?.last ?? 4.58;
      const yld2 = seriesList.find((s) => s.id === "us2y")?.last ?? 4.86;
      const vixVal = seriesList.find((s) => s.id === "vix")?.last ?? 18.5;

      const macroTimeline: PointInTimeMacro[] = [
        {
          asOfTimestamp: pitBars[0]?.timestamp ?? Date.now(),
          regime: (macroStore?.regime?.label as any) ?? "Transitional Mixed",
          regimeScore: macroStore?.regime?.score ?? 50,
          yield10Y: yld10,
          yield2Y: yld2,
          yieldSpreadBps: Math.round((yld10 - yld2) * 100),
          vixLevel: vixVal,
          vixZScore: vixVal >= 25 ? 2.1 : vixVal >= 20 ? 1.2 : 0.2,
          marketBreadthRatio: 0.45,
          marketBreadthPctAboveMa20: 42,
          marketLiquidityRatio: 0.9,
          foreignNetFlowBillion: -350,
        },
      ];

      // Đặt sự kiện kiểm toán vĩ mô tại mốc 20 nến trước thời điểm hiện tại
      const eventIdx = Math.max(0, pitBars.length - 20);
      const eventTimestamp = pitBars[eventIdx]?.timestamp ?? Date.now();

      const eventTimeline: PointInTimeEvent[] = [
        {
          eventId: "fed-policy-decision",
          eventType: "FED_RATE_DECISION",
          eventTimestamp,
          publicationTimestamp: eventTimestamp,
          consensusSnapshotTimestamp: eventTimestamp - 3600000,
          actual: 4.75,
          consensus: 5.0,
          previous: 5.25,
          surprise: -0.25,
          sourceQuality: "TIER_1_OFFICIAL",
          noveltyScore: 0.85,
        },
      ];

      const dataset: BacktestDataset = {
        assetBars: { BTC: pitBars },
        macroTimeline,
        eventTimeline,
        benchmarkAssetId: "BTC",
      };

      const config: BacktestConfig = {
        runId: `run-live-${Date.now()}`,
        startDate: 0,
        endDate: 0,
        warmupPeriod: 125,
        initialCapital: STARTING_EQUITY,
        commissionRate: FEE_BPS,
        slippageModel: { type: "FIXED_BPS", baseBps: SLIPPAGE_BPS * 10000 },
        executionRule: "NEXT_BAR_OPEN",
        deterministicSeed: 20260915,
        dataQuality: "LIVE",
      };

      const backtestResult = runBacktest(config, dataset);
      this.latestDecision = backtestResult.timeline.at(-1) ?? null;

      // Replay chi tiết từng bước nến sau warmup
      for (const step of backtestResult.timeline) {
        const bar = bars[step.barIndex] ?? bars[bars.length - 1];
        const barPrice = bar?.close ?? lastClosePrice;
        const barTimestampSec = Math.floor(step.timestamp / 1000);

        // 1. Cập nhật Omega Meta-Fund
        this.omega.equityCurve.push({ time: barTimestampSec, equity: step.nav });
        this.omega.cash = step.cash;
        this.omega.qty = step.positions["BTC"]?.quantity ?? 0;
        this.omega.peakNav = Math.max(this.omega.peakNav, step.nav);
        this.omega.maxDrawdown = Math.max(this.omega.maxDrawdown, step.currentDrawdown);
        this.omega.lastSignalDescription = step.targetWeights.rationale.slice(0, 48);

        // 2. Cập nhật 3 Alphas độc lập
        const signalsList = step.signals ?? [];
        const trendSig = signalsList.find((s) => s.strategyId === "ADAPTIVE_TREND");
        const eventSig = signalsList.find((s) => s.strategyId === "EVENT_REACTION");
        const mrSig = signalsList.find((s) => s.strategyId === "MEAN_REVERSION");

        this.simulateAlphaStrategy(this.trend, trendSig?.alphaScore ?? 0, trendSig?.confidence ?? 0, barPrice, barTimestampSec, trendSig?.rationale);
        this.simulateAlphaStrategy(this.event, eventSig?.alphaScore ?? 0, eventSig?.confidence ?? 0, barPrice, barTimestampSec, eventSig?.rationale);
        this.simulateAlphaStrategy(this.mean, mrSig?.alphaScore ?? 0, mrSig?.confidence ?? 0, barPrice, barTimestampSec, mrSig?.rationale);

        // 3. Cập nhật Benchmark Đối chứng DCA (Tích sản 5% vốn mỗi 7 phiên)
        this.simulateBenchmarkDca(barPrice, barTimestampSec, step.barIndex);
      }
    } catch (err) {
      console.error("[QuantEngine Live Sync] Replay execution error:", err);
    }

    return {
      trend: toBotMetrics(this.trend, lastClosePrice),
      event: toBotMetrics(this.event, lastClosePrice),
      mean: toBotMetrics(this.mean, lastClosePrice),
      omega: toBotMetrics(this.omega, lastClosePrice),
      benchmarkDca: toBotMetrics(this.benchmarkDca, lastClosePrice),
      latestDecision: this.latestDecision,
    };
  }

  private simulateAlphaStrategy(
    bot: SubBotTracker,
    alphaScore: number,
    confidence: number,
    price: number,
    timestampSec: number,
    rationale?: string
  ): void {
    if (price <= 0) return;

    const targetWeight = alphaScore > 0.05
      ? Math.min(0.85, alphaScore * Math.max(0.3, confidence))
      : 0.0;

    const currentNav = bot.cash + bot.qty * price;
    const targetNotional = targetWeight * currentNav;
    const currentNotional = bot.qty * price;
    const deltaNotional = targetNotional - currentNotional;

    const minRebalanceThresholdUsd = 50;

    if (deltaNotional > minRebalanceThresholdUsd && bot.cash > 20) {
      const allocUsd = Math.min(bot.cash, deltaNotional);
      const slippedPrice = price * (1 + SLIPPAGE_BPS);
      const fee = allocUsd * FEE_BPS;
      const netSpend = allocUsd - fee;
      const addedQty = netSpend / slippedPrice;

      if (addedQty > 0) {
        const totalCostPrev = bot.qty * (bot.entryPrice ?? slippedPrice);
        bot.qty += addedQty;
        bot.entryPrice = (totalCostPrev + addedQty * slippedPrice) / bot.qty;
        bot.cash = Math.max(0, bot.cash - allocUsd);

        bot.trades.push({
          id: `${bot.id}-${timestampSec}-B`,
          botId: bot.id,
          time: timestampSec,
          side: "BUY",
          price: slippedPrice,
          qty: addedQty,
          fee,
          slippage: slippedPrice - price,
          notional: allocUsd,
        });
        bot.lastSignalDescription = `ALLOC (α: ${alphaScore.toFixed(2)}, Target: ${(targetWeight * 100).toFixed(0)}%)`;
      }
    } else if (deltaNotional < -minRebalanceThresholdUsd && bot.qty > 0) {
      const reduceUsd = Math.abs(deltaNotional);
      const unitsToSell = Math.min(bot.qty, reduceUsd / price);
      const slippedPrice = price * (1 - SLIPPAGE_BPS);
      const grossProceeds = unitsToSell * slippedPrice;
      const fee = grossProceeds * FEE_BPS;
      const netProceeds = grossProceeds - fee;

      const pnl = netProceeds - unitsToSell * (bot.entryPrice ?? slippedPrice);
      if (pnl >= 0) bot.wins++;
      else bot.losses++;
      bot.realizedPnl += pnl;

      bot.cash += netProceeds;
      bot.qty = Math.max(0, bot.qty - unitsToSell);
      if (bot.qty < 1e-6) {
        bot.qty = 0;
        bot.entryPrice = null;
      }

      bot.trades.push({
        id: `${bot.id}-${timestampSec}-S`,
        botId: bot.id,
        time: timestampSec,
        side: "SELL",
        price: slippedPrice,
        qty: unitsToSell,
        fee,
        slippage: price - slippedPrice,
        notional: grossProceeds,
      });
      bot.lastSignalDescription = `DE-ALLOC (α: ${alphaScore.toFixed(2)}, Target: ${(targetWeight * 100).toFixed(0)}%)`;
    } else if (rationale && bot.lastSignalDescription === "INITIALIZING") {
      bot.lastSignalDescription = rationale.slice(0, 42);
    }

    const closingEquity = bot.cash + bot.qty * price;
    bot.peakNav = Math.max(bot.peakNav, closingEquity);
    const dd = bot.peakNav > 0 ? (bot.peakNav - closingEquity) / bot.peakNav : 0;
    bot.maxDrawdown = Math.max(bot.maxDrawdown, dd);
    bot.equityCurve.push({ time: timestampSec, equity: Math.round(closingEquity * 100) / 100 });
  }

  private simulateBenchmarkDca(price: number, timestampSec: number, barIndex: number): void {
    const dcaInterval = 7;
    const allocAmount = STARTING_EQUITY * 0.05; // Giải ngân $500 mỗi chu kỳ

    if (barIndex % dcaInterval === 0 && this.benchmarkDca.cash >= allocAmount && price > 0) {
      const slippedPrice = price * (1 + SLIPPAGE_BPS);
      const fee = allocAmount * FEE_BPS;
      const netSpend = allocAmount - fee;
      const units = netSpend / slippedPrice;

      this.benchmarkDca.qty += units;
      this.benchmarkDca.cash -= allocAmount;
      this.benchmarkDca.trades.push({
        id: `dca-${timestampSec}`,
        botId: "benchmark_dca",
        time: timestampSec,
        side: "BUY",
        price: slippedPrice,
        qty: units,
        fee,
        slippage: slippedPrice - price,
        notional: allocAmount,
      });
      this.benchmarkDca.lastSignalDescription = `ACCUMULATE $${allocAmount}`;
    }

    const eq = this.benchmarkDca.cash + this.benchmarkDca.qty * price;
    this.benchmarkDca.peakNav = Math.max(this.benchmarkDca.peakNav, eq);
    const dd = this.benchmarkDca.peakNav > 0 ? (this.benchmarkDca.peakNav - eq) / this.benchmarkDca.peakNav : 0;
    this.benchmarkDca.maxDrawdown = Math.max(this.benchmarkDca.maxDrawdown, dd);
    this.benchmarkDca.equityCurve.push({ time: timestampSec, equity: Math.round(eq * 100) / 100 });
  }
}