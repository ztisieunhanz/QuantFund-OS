import type { BotMetrics, EquityPoint, OhlcvBar, Side, TradeFill } from "@/types/market";
import { runBacktest, type BacktestDataset } from "@/lib/quant/backtestEngine";
import type {
  BacktestConfig,
  DecisionState,
  ExecutionRecord,
  PointInTimeBar,
  PointInTimeEvent,
  PointInTimeMacro,
  StrategyId,
} from "@/lib/quant/types";
import { useMacroStore } from "@/stores/macroStore";

export const STARTING_EQUITY = 10_000;
export const FEE_BPS = 0.001; // 10 bps
export const SLIPPAGE_BPS = 0.0005; // 5 bps

interface SubBotTracker {
  id: "trend" | "meanrev" | "dca" | "omega";
  strategyId: StrategyId | "OMEGA_PORTFOLIO";
  name: string;
  cash: number;
  qty: number;
  entry: number | null;
  realized: number;
  wins: number;
  losses: number;
  peak: number;
  maxDd: number;
  trades: TradeFill[];
  equityCurve: EquityPoint[];
  lastSignal: string;
}

function createSubBot(
  id: SubBotTracker["id"],
  strategyId: StrategyId | "OMEGA_PORTFOLIO",
  name: string
): SubBotTracker {
  return {
    id,
    strategyId,
    name,
    cash: STARTING_EQUITY,
    qty: 0,
    entry: null,
    realized: 0,
    wins: 0,
    losses: 0,
    peak: STARTING_EQUITY,
    maxDd: 0,
    trades: [],
    equityCurve: [],
    lastSignal: "WAITING_DATA",
  };
}

function toMetrics(bot: SubBotTracker, lastPrice: number): BotMetrics {
  const equity = bot.cash + bot.qty * lastPrice;
  const closed = bot.wins + bot.losses;
  return {
    botId: bot.id as any,
    name: bot.name,
    cash: Math.round(bot.cash * 100) / 100,
    qty: Math.round(bot.qty * 100000) / 100000,
    lastPrice,
    equity: Math.round(equity * 100) / 100,
    pnl: Math.round((equity - STARTING_EQUITY) * 100) / 100,
    pnlPct: (equity - STARTING_EQUITY) / STARTING_EQUITY,
    winRate: closed === 0 ? 0 : bot.wins / closed,
    maxDrawdown: bot.maxDd,
    totalTrades: bot.trades.length,
    wins: bot.wins,
    losses: bot.losses,
    position: bot.qty > 0 ? "LONG" : "FLAT",
    lastSignal: bot.lastSignal,
    trades: bot.trades,
    equityCurve: bot.equityCurve,
  };
}

export class PaperEngine {
  trend = createSubBot("trend", "ADAPTIVE_TREND", "Bot 1 · Adaptive Trend");
  event = createSubBot("dca", "EVENT_REACTION", "Bot 2 · Event Catalyst Driver");
  mean = createSubBot("meanrev", "MEAN_REVERSION", "Bot 3 · Short Mean Reversion");
  omega = createSubBot("omega", "OMEGA_PORTFOLIO", "Omega · Quant Meta-Fund");
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
    if (bars.length < 25) {
      const p = bars.at(-1)?.close ?? 0;
      return {
        trend: toMetrics(this.trend, p),
        mean: toMetrics(this.mean, p),
        dca: toMetrics(this.event, p),
        omega: toMetrics(this.omega, p),
        latestDecision: null,
      };
    }

    const pitBars: PointInTimeBar[] = bars.map((b) => ({
      timestamp: b.time < 1e11 ? b.time * 1000 : b.time,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
    }));

    const macroStore = useMacroStore.getState();
    const macroTimeline: PointInTimeMacro[] = [
      {
        asOfTimestamp: pitBars[0].timestamp,
        regime: (macroStore.regime?.label as any) ?? "Transitional Mixed",
        regimeScore: macroStore.regime?.score ?? 50,
        yield10Y: macroStore.series.find((s) => s.id === "us10y")?.last ?? 4.58,
        yield2Y: macroStore.series.find((s) => s.id === "us2y")?.last ?? 4.86,
        yieldSpreadBps: -28,
        vixLevel: macroStore.series.find((s) => s.id === "vix")?.last ?? 20.85,
        vixZScore: 1.4,
        marketBreadthRatio: 0.45,
        marketBreadthPctAboveMa20: 38,
        marketLiquidityRatio: 0.8,
        foreignNetFlowBillion: -500,
      },
    ];

    const eventTimeline: PointInTimeEvent[] = [
      {
        eventId: "fed-rate-cut-50bps",
        eventType: "FED_RATE_DECISION",
        eventTimestamp: pitBars[Math.max(0, pitBars.length - 15)].timestamp,
        publicationTimestamp: pitBars[Math.max(0, pitBars.length - 15)].timestamp,
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

    const warmupPeriod = Math.min(25, Math.floor(bars.length * 0.25));

    const config: BacktestConfig = {
      runId: `run-${Date.now()}`,
      startDate: 0,
      endDate: 0,
      warmupPeriod,
      initialCapital: STARTING_EQUITY,
      commissionRate: FEE_BPS,
      slippageModel: { type: "FIXED_BPS", baseBps: SLIPPAGE_BPS * 10000 },
      executionRule: "SAME_BAR_CLOSE",
      deterministicSeed: 20260915,
      dataQuality: "LIVE",
    };

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

    for (const step of backtestResult.timeline) {
      const barPrice = bars.find((b) => (b.time < 1e11 ? b.time * 1000 : b.time) === step.timestamp)?.close ?? step.nav;
      const barSec = Math.floor(step.timestamp / 1000);

      this.omega.equityCurve.push({ time: barSec, equity: step.nav });
      this.omega.cash = step.cash;
      this.omega.qty = step.holdings["BTC"] ?? 0;
      this.omega.peak = Math.max(this.omega.peak, step.nav);
      this.omega.maxDd = Math.max(this.omega.maxDd, step.currentDrawdown);
      this.omega.lastSignal = step.targetWeights.rationale.slice(0, 45);

      const trendSignal = step.signals.find((s) => s.strategyId === "ADAPTIVE_TREND");
      const eventSignal = step.signals.find((s) => s.strategyId === "EVENT_REACTION");
      const mrSignal = step.signals.find((s) => s.strategyId === "MEAN_REVERSION");

      this.simulateSubStrategy(this.trend, trendSignal?.alphaScore ?? 0, barPrice, barSec, trendSignal?.rationale);
      this.simulateSubStrategy(this.event, eventSignal?.alphaScore ?? 0, barPrice, barSec, eventSignal?.rationale);
      this.simulateSubStrategy(this.mean, mrSignal?.alphaScore ?? 0, barPrice, barSec, mrSignal?.rationale);
    }

    const lastClose = bars.at(-1)?.close ?? 0;
    return {
      trend: toMetrics(this.trend, lastClose),
      mean: toMetrics(this.mean, lastClose),
      dca: toMetrics(this.event, lastClose),
      omega: toMetrics(this.omega, lastClose),
      latestDecision: this.latestDecision,
    };
  }

  private simulateSubStrategy(
    bot: SubBotTracker,
    alphaScore: number,
    price: number,
    timeSec: number,
    rationale?: string
  ): void {
    const slippedBuy = price * (1 + SLIPPAGE_BPS);
    const slippedSell = price * (1 - SLIPPAGE_BPS);

    if (alphaScore >= 0.25 && bot.qty === 0 && bot.cash > 50) {
      const notional = bot.cash;
      const fee = notional * FEE_BPS;
      const qty = (notional - fee) / slippedBuy;
      bot.qty = qty;
      bot.cash = 0;
      bot.entry = slippedBuy;
      bot.trades.push({
        id: `${bot.id}-${timeSec}-B`,
        botId: bot.id as any,
        time: timeSec,
        side: "BUY",
        price: slippedBuy,
        qty,
        fee,
        slippage: slippedBuy - price,
        notional,
      });
      bot.lastSignal = `LONG (Alpha: ${alphaScore.toFixed(2)})`;
    } else if (alphaScore <= -0.25 && bot.qty > 0) {
      const gross = bot.qty * slippedSell;
      const fee = gross * FEE_BPS;
      const net = gross - fee;
      const pnl = net - bot.qty * (bot.entry ?? slippedSell);
      if (pnl >= 0) bot.wins++;
      else bot.losses++;
      bot.realized += pnl;
      bot.cash += net;
      bot.qty = 0;
      bot.entry = null;
      bot.trades.push({
        id: `${bot.id}-${timeSec}-S`,
        botId: bot.id as any,
        time: timeSec,
        side: "SELL",
        price: slippedSell,
        qty: bot.qty,
        fee,
        slippage: price - slippedSell,
        notional: gross,
      });
      bot.lastSignal = `EXIT (Alpha: ${alphaScore.toFixed(2)})`;
    } else if (rationale) {
      bot.lastSignal = rationale.slice(0, 40);
    }

    const eq = bot.cash + bot.qty * price;
    bot.peak = Math.max(bot.peak, eq);
    const dd = bot.peak > 0 ? (bot.peak - eq) / bot.peak : 0;
    bot.maxDd = Math.max(bot.maxDd, dd);
    bot.equityCurve.push({ time: timeSec, equity: Math.round(eq * 100) / 100 });
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