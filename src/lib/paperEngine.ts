// ============================================================================
// FILE: src/lib/paperEngine.ts
// MODULE: QUANT ADAPTER & CONCURRENT STRATEGY RUNNER
// ARCHITECTURE:
//   OhlcvBar Feed -> Point-in-Time Dataset -> runBacktest()
//   -> Multi-Alpha Continuous Sizing + Omega Meta-Fund Tracking -> BotMetrics
// ============================================================================

import type {
  BotMetrics,
  EquityPoint,
  OhlcvBar,
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
export const FEE_BPS = 0.001;       // 10 bps (0.10%)
export const SLIPPAGE_BPS = 0.0005; // 5 bps (0.05%)

interface SubBotTracker {
  readonly id: QuantBotId;
  readonly strategyId: StrategyId | "OMEGA_PORTFOLIO";
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
  strategyId: StrategyId | "OMEGA_PORTFOLIO",
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
    position: tracker.qty > 0.00001 ? "LONG" : "FLAT",
    lastSignal: tracker.lastSignalDescription,
    trades: tracker.trades,
    equityCurve: tracker.equityCurve,
  };
}

export class PaperEngine {
  trend: SubBotTracker = createSubBot("trend", "ADAPTIVE_TREND", "Bot 1 · Adaptive Trend");
  event: SubBotTracker = createSubBot("dca", "EVENT_REACTION", "Bot 2 · Event Catalyst Driver");
  mean: SubBotTracker = createSubBot("meanrev", "MEAN_REVERSION", "Bot 3 · Short Mean Reversion");
  omega: SubBotTracker = createSubBot("omega", "OMEGA_PORTFOLIO", "Omega · Quant Meta-Fund");
  latestDecision: DecisionState | null = null;

  reset(): void {
    this.trend = createSubBot("trend", "ADAPTIVE_TREND", "Bot 1 · Adaptive Trend");
    this.event = createSubBot("dca", "EVENT_REACTION", "Bot 2 · Event Catalyst Driver");
    this.mean = createSubBot("meanrev", "MEAN_REVERSION", "Bot 3 · Short Mean Reversion");
    this.omega = createSubBot("omega", "OMEGA_PORTFOLIO", "Omega · Quant Meta-Fund");
    this.latestDecision = null;
  }

  replay(
    bars: OhlcvBar[],
    _isRiskOff: boolean = false
  ): {
    trend: BotMetrics;
    mean: BotMetrics;
    dca: BotMetrics;
    omega: BotMetrics;
    latestDecision: DecisionState | null;
  } {
    this.reset();
    const lastClosePrice = bars && bars.length > 0 ? (bars.at(-1)?.close ?? 0) : 0;

    if (!bars || bars.length < 25) {
      return {
        trend: toBotMetrics(this.trend, lastClosePrice),
        mean: toBotMetrics(this.mean, lastClosePrice),
        dca: toBotMetrics(this.event, lastClosePrice),
        omega: toBotMetrics(this.omega, lastClosePrice),
        latestDecision: null,
      };
    }

    try {
      // 1. CHUYỂN ĐỔI OHLCV SANG POINT-IN-TIME TIMELINE
      const pitBars: PointInTimeBar[] = bars.map((b) => ({
        timestamp: b.time < 1e11 ? b.time * 1000 : b.time,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
      }));

      // 2. PHÒNG THỦ: Nạp an toàn dữ liệu vĩ mô và sự kiện
      const macroStore = useMacroStore.getState();
      const seriesList = macroStore?.series ?? [];

      const macroTimeline: PointInTimeMacro[] = [
        {
          asOfTimestamp: pitBars[0]?.timestamp ?? Date.now(),
          regime: (macroStore?.regime?.label as any) ?? "Transitional Mixed",
          regimeScore: macroStore?.regime?.score ?? 50,
          yield10Y: seriesList.find((s) => s.id === "us10y")?.last ?? 4.588,
          yield2Y: seriesList.find((s) => s.id === "us2y")?.last ?? 4.865,
          yieldSpreadBps: -28,
          vixLevel: seriesList.find((s) => s.id === "vix")?.last ?? 20.85,
          vixZScore: 1.4,
          marketBreadthRatio: 0.45,
          marketBreadthPctAboveMa20: 38,
          marketLiquidityRatio: 0.8,
          foreignNetFlowBillion: -500,
        },
      ];

      const eventIdx = Math.max(0, pitBars.length - 15);
      const eventTimestamp = pitBars[eventIdx]?.timestamp ?? Date.now();

      const eventTimeline: PointInTimeEvent[] = [
        {
          eventId: "macro-catalyst-window",
          eventType: "FED_RATE_DECISION",
          eventTimestamp,
          publicationTimestamp: eventTimestamp,
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

      const warmupBarsCount = Math.min(30, Math.max(15, Math.floor(bars.length * 0.2)));

      const config: BacktestConfig = {
        runId: `run-${Date.now()}`,
        startDate: 0,
        endDate: 0,
        warmupPeriod: warmupBarsCount,
        initialCapital: STARTING_EQUITY,
        commissionRate: FEE_BPS,
        slippageModel: { type: "FIXED_BPS", baseBps: SLIPPAGE_BPS * 10000 },
        executionRule: "SAME_BAR_CLOSE",
        deterministicSeed: 20260915,
        dataQuality: "LIVE",
      };

      // 3. THỰC THI REPLAY BẰNG DETERMINISTIC BACKTEST ENGINE
      const backtestResult = runBacktest(config, dataset, {
        trend: {
          lookbackShortBars: Math.min(20, Math.max(5, Math.floor(bars.length * 0.1))),
          lookbackMediumBars: Math.min(60, Math.max(10, Math.floor(bars.length * 0.2))),
          lookbackLongBars: Math.min(120, Math.max(20, Math.floor(bars.length * 0.35))),
          atrPeriodBars: 14,
          chandelierAtrMultiplier: 3.0,
          trendPersistenceThreshold: 0.55,
          baseHoldingPeriodBars: 20,
          assumedInformationRatio: 0.4,
        },
        event: {
          minSurpriseRelativeThreshold: 0.04,
          halfLifeDecayBars: 2,
          maxHoldingPeriodBars: 5,
          priceConfirmationToleranceBps: 0.0015,
          volSpikeFilterZScore: 2.5,
          assumedInformationRatio: 0.45,
          defaultVolAnnualized: 0.25,
        },
        meanReversion: {
          zScoreLookbackBars: Math.min(20, Math.max(10, Math.floor(bars.length * 0.15))),
          deviationThresholdZ: 1.8,
          maxZScoreCap: 3.5,
          maxAllowedTrendSlopeBps: 0.003,
          volumeExhaustionRatio: 1.2,
          baseHoldingPeriodBars: 3,
          maxHoldingPeriodBars: 6,
          assumedInformationRatio: 0.5,
          defaultVolAnnualized: 0.22,
        },
      });

      this.latestDecision = backtestResult.timeline.at(-1) ?? null;

      // 4. TRÍCH XUẤT VÀ TÁI CÂN BẰNG
      for (const step of backtestResult.timeline) {
        const bar = bars[step.barIndex] ?? bars[bars.length - 1];
        const barPrice = bar?.close ?? lastClosePrice;
        const barTimestampSec = Math.floor(step.timestamp / 1000);

        this.omega.equityCurve.push({ time: barTimestampSec, equity: step.nav });
        this.omega.cash = step.cash;
        this.omega.qty = step.holdings["BTC"] ?? 0;
        this.omega.peakNav = Math.max(this.omega.peakNav, step.nav);
        this.omega.maxDrawdown = Math.max(this.omega.maxDrawdown, step.currentDrawdown);
        this.omega.lastSignalDescription = step.targetWeights.rationale.slice(0, 48);

        const signalsList = step.signals ?? [];
        const trendSig = signalsList.find((s) => s.strategyId === "ADAPTIVE_TREND");
        const eventSig = signalsList.find((s) => s.strategyId === "EVENT_REACTION");
        const mrSig = signalsList.find((s) => s.strategyId === "MEAN_REVERSION");

        this.rebalanceSubStrategy(this.trend, trendSig?.alphaScore ?? 0, trendSig?.confidence ?? 0, barPrice, barTimestampSec, trendSig?.rationale);
        this.rebalanceSubStrategy(this.event, eventSig?.alphaScore ?? 0, eventSig?.confidence ?? 0, barPrice, barTimestampSec, eventSig?.rationale);
        this.rebalanceSubStrategy(this.mean, mrSig?.alphaScore ?? 0, mrSig?.confidence ?? 0, barPrice, barTimestampSec, mrSig?.rationale);
      }
    } catch (err) {
      console.error("[QuantEngine] Backtest replay error:", err);
    }

    return {
      trend: toBotMetrics(this.trend, lastClosePrice),
      mean: toBotMetrics(this.mean, lastClosePrice),
      dca: toBotMetrics(this.event, lastClosePrice),
      omega: toBotMetrics(this.omega, lastClosePrice),
      latestDecision: this.latestDecision,
    };
  }

  private rebalanceSubStrategy(
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
        bot.lastSignalDescription = `SCALE-IN (α: ${alphaScore.toFixed(2)}, Target: ${(targetWeight * 100).toFixed(0)}%)`;
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
      bot.lastSignalDescription = `SCALE-OUT (α: ${alphaScore.toFixed(2)}, Target: ${(targetWeight * 100).toFixed(0)}%)`;
    } else if (rationale && bot.lastSignalDescription === "INITIALIZING") {
      bot.lastSignalDescription = rationale.slice(0, 42);
    }

    const closingEquity = bot.cash + bot.qty * price;
    bot.peakNav = Math.max(bot.peakNav, closingEquity);
    const dd = bot.peakNav > 0 ? (bot.peakNav - closingEquity) / bot.peakNav : 0;
    bot.maxDrawdown = Math.max(bot.maxDrawdown, dd);
    bot.equityCurve.push({ time: timestampSec, equity: Math.round(closingEquity * 100) / 100 });
  }

  ingestBar(
    bar: OhlcvBar,
    history: OhlcvBar[],
    isRiskOff: boolean = false
  ): {
    trend: BotMetrics;
    mean: BotMetrics;
    dca: BotMetrics;
    omega: BotMetrics;
    latestDecision: DecisionState | null;
  } {
    return this.replay(history, isRiskOff);
  }
}