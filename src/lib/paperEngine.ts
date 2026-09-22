// ============================================================================
// FILE: src/lib/paperEngine.ts
// MODULE: QUANT ADAPTER & REPLAY ENGINE
//
// CORE-02/03: Historical macro and event timelines are NOT fabricated here.
//   Paper replay provides no historical macro and no historical event data.
//   Until genuine point-in-time historical data exists, both timelines are empty.
//
// CORE-04: Market data source ("live" | "synthetic") is propagated truthfully
//   into BacktestConfig.dataQuality.
//
// CORE-05: Alpha sub-bots hold SIGNAL TELEMETRY ONLY.
//   They do not manufacture fills, cash changes, trades, fees, or PnL.
//   The canonical ledger is the Omega/ExecutionEngine path only.
//
// BLOCKER 1/2: replay() takes QuantReplayMarketContext explicitly.
//   Both interval and source are REQUIRED — no default-to-LIVE path.
//   PaperEngine enforces its own 1H boundary independently.
// ============================================================================

import type {
  BotMetrics,
  EquityPoint,
  PositionSide,
  QuantBotId,
  TradeFill,
} from "@/types/market";

import { runBacktest, type BacktestDataset } from "@/lib/quant/backtestEngine";
import type {
  BacktestConfig,
  DecisionState,
  PointInTimeBar,
  StrategyId,
} from "@/lib/quant/types";
import { QUANT_BAR_INTERVAL, type QuantReplayMarketContext } from "@/lib/quant/timeDomain";

export const STARTING_EQUITY = 10_000;
export const FEE_BPS = 0.001;       // 10 bps hoa hồng
export const SLIPPAGE_BPS = 0.0005; // 5 bps trượt giá cố định

/**
 * CORE-04: Production mapping from caller-supplied source provenance
 * to BacktestConfig.dataQuality.
 *
 * Exported as a pure function so tests can verify the exact production
 * path — not a test-local duplicate.
 * There is NO default: the caller must supply "live" or "synthetic".
 */
export function mapSourceToDataQuality(
  source: "live" | "synthetic"
): "LIVE" | "SYNTHETIC" {
  return source === "live" ? "LIVE" : "SYNTHETIC";
}

/**
 * CORE-02/03: Production helper to construct the canonical BacktestDataset
 * for PaperEngine replay.
 *
 * Historical macro and event timelines are intentionally empty.
 * No historical macro or event data is fabricated.
 *
 * Exported so tests inspect the exact production dataset construction seam.
 */
export function buildPaperEngineDataset(
  bars: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>
): BacktestDataset {
  const pitBars: PointInTimeBar[] = bars.map((b) => ({
    timestamp: b.time < 1e11 ? b.time * 1000 : b.time,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
  }));

  return {
    assetBars: { BTC: pitBars },
    macroTimeline: [],
    eventTimeline: [],
    benchmarkAssetId: "BTC",
  };
}

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

function toBotMetrics(
  tracker: SubBotTracker,
  markPrice: number,
  latestDecision?: DecisionState | null
): BotMetrics {
  const isOmega = tracker.id === "omega";
  const isAlpha = tracker.id === "trend" || tracker.id === "event" || tracker.id === "meanrev";

  if (isAlpha) {
    return {
      botId: tracker.id,
      name: tracker.name,
      cash: STARTING_EQUITY,
      qty: 0,
      lastPrice: markPrice,
      equity: STARTING_EQUITY,
      pnl: 0,
      pnlPct: 0,
      winRate: null,
      maxDrawdown: tracker.maxDrawdown,
      totalTrades: 0,
      wins: 0,
      losses: 0,
      position: "FLAT",
      lastSignal: tracker.lastSignalDescription,
      trades: [],
      equityCurve: tracker.equityCurve,
      status: "UNAVAILABLE",
    };
  }

  if (isOmega && latestDecision) {
    const btcPos = latestDecision.positions["BTC"];
    const qty = btcPos?.quantity ?? 0;
    const entryPrice = btcPos?.entryPrice ?? 0;
    const pnl = Math.round((latestDecision.nav - STARTING_EQUITY) * 100) / 100;
    const pnlPct = (latestDecision.nav - STARTING_EQUITY) / STARTING_EQUITY;

    const trades: TradeFill[] = (latestDecision.executions ?? []).map((e) => ({
      id: e.executionId,
      botId: "omega",
      time: Math.floor(e.executionTimestamp / 1000),
      side: e.side,
      price: e.executionPrice,
      qty: e.quantity,
      fee: e.fees,
      slippage: e.slippage,
      notional: e.notionalUsd,
    }));

    return {
      botId: "omega",
      name: tracker.name,
      cash: Math.round(latestDecision.cash * 100) / 100,
      qty: Math.round(qty * 100000) / 100000,
      lastPrice: entryPrice > 0 ? entryPrice : markPrice,
      equity: Math.round(latestDecision.nav * 100) / 100,
      pnl,
      pnlPct,
      winRate: null,
      maxDrawdown: latestDecision.currentDrawdown,
      totalTrades: trades.length,
      wins: null,
      losses: null,
      position: qty > 0.00001 ? "LONG" : "FLAT",
      lastSignal: tracker.lastSignalDescription,
      trades,
      equityCurve: tracker.equityCurve,
      status: "AVAILABLE",
    };
  }

  const currentEquity = tracker.cash + tracker.qty * markPrice;
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
    winRate: isOmega ? null : tracker.wins / Math.max(1, tracker.wins + tracker.losses),
    maxDrawdown: tracker.maxDrawdown,
    totalTrades: tracker.trades.length,
    wins: isOmega ? null : tracker.wins,
    losses: isOmega ? null : tracker.losses,
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

  /**
   * Replay bars through the canonical quant engine.
   *
   * @param bars - OHLCV bars from the market store (OhlcvBar[] format).
   * @param ctx  - QuantReplayMarketContext carrying interval and source.
   *               Both fields are REQUIRED — there is no default.
   *               source: "live" | "synthetic" — mapped directly to dataQuality.
   *               interval: must equal QUANT_BAR_INTERVAL ("1h").
   *
   * BLOCKER 2: PaperEngine enforces the 1H boundary independently.
   * If interval !== QUANT_BAR_INTERVAL, an error is thrown immediately
   * before any backtestEngine call.
   * The tradingStore normally prevents this by resetting to neutral first.
   */
  replay(
    bars: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>,
    ctx: QuantReplayMarketContext
  ): {
    trend: BotMetrics;
    event: BotMetrics;
    mean: BotMetrics;
    omega: BotMetrics;
    benchmarkDca: BotMetrics;
    latestDecision: DecisionState | null;
  } {
    // BLOCKER 2: PaperEngine independently enforces the 1H boundary.
    // The store normally prevents this path, but a direct call cannot bypass the contract.
    if (ctx.interval !== QUANT_BAR_INTERVAL) {
      throw new Error(
        `[PaperEngine] Unsupported interval "${ctx.interval}". ` +
        `The canonical quant engine only processes "${QUANT_BAR_INTERVAL}" bars. ` +
        `tradingStore must reset to neutral before calling replay on non-1H intervals.`
      );
    }

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
      // CORE-02/03: Production dataset constructed via exported pure helper.
      // macroTimeline and eventTimeline are intentionally empty.
      const dataset = buildPaperEngineDataset(bars);

      // CORE-04: Map data source truthfully to dataQuality.
      // Uses the exported production helper — no inline ternary, no default.
      const dataQuality = mapSourceToDataQuality(ctx.source);

      const config: BacktestConfig = {
        runId: `run-live-${Date.now()}`,
        startDate: 0,
        endDate: 0,
        warmupPeriod: 125,
        initialCapital: STARTING_EQUITY,
        commissionRate: FEE_BPS,
        slippageModel: { type: "FIXED_BPS", baseBps: SLIPPAGE_BPS * 10000 },
        executionRule: "NEXT_BAR_OPEN",
        requirePitExecution: true,
        deterministicSeed: 20260915,
        dataQuality,
      };

      const backtestResult = runBacktest(config, dataset);
      this.latestDecision = backtestResult.timeline.at(-1) ?? null;

      // Replay chi tiết từng bước nến sau warmup
      for (const step of backtestResult.timeline) {
        const bar = bars[step.barIndex] ?? bars[bars.length - 1];
        const barPrice = bar?.close ?? lastClosePrice;
        const barTimestampSec = Math.floor(step.timestamp / 1000);

        // 1. Cập nhật Omega Meta-Fund (canonical ledger)
        this.omega.equityCurve.push({ time: barTimestampSec, equity: step.nav });
        this.omega.cash = step.cash;
        this.omega.qty = step.positions["BTC"]?.quantity ?? 0;
        this.omega.peakNav = Math.max(this.omega.peakNav, step.nav);
        this.omega.maxDrawdown = Math.max(this.omega.maxDrawdown, step.currentDrawdown);
        this.omega.lastSignalDescription = step.targetWeights.rationale.slice(0, 48);

        // 2. CORE-05: Alpha bots record SIGNAL TELEMETRY ONLY.
        // No fills, no cash changes, no trades, no PnL fabrication.
        const signalsList = step.signals ?? [];
        const trendSig = signalsList.find((s) => s.strategyId === "ADAPTIVE_TREND");
        const eventSig = signalsList.find((s) => s.strategyId === "EVENT_REACTION");
        const mrSig = signalsList.find((s) => s.strategyId === "MEAN_REVERSION");

        this.recordAlphaTelemetry(this.trend, trendSig?.rationale, barTimestampSec);
        this.recordAlphaTelemetry(this.event, eventSig?.rationale, barTimestampSec);
        this.recordAlphaTelemetry(this.mean, mrSig?.rationale, barTimestampSec);

        // 3. Cập nhật Benchmark Đối chứng DCA (Tích sản 5% vốn mỗi 7 phiên)
        this.simulateBenchmarkDca(barPrice, barTimestampSec, step.barIndex);
      }
    } catch (err) {
      console.error("[QuantEngine Live Sync] Replay execution error:", err);
    }

    return {
      trend: toBotMetrics(this.trend, lastClosePrice, this.latestDecision),
      event: toBotMetrics(this.event, lastClosePrice, this.latestDecision),
      mean: toBotMetrics(this.mean, lastClosePrice, this.latestDecision),
      omega: toBotMetrics(this.omega, lastClosePrice, this.latestDecision),
      benchmarkDca: toBotMetrics(this.benchmarkDca, lastClosePrice, this.latestDecision),
      latestDecision: this.latestDecision,
    };
  }

  /**
   * CORE-05: Record Alpha signal telemetry for display purposes only.
   *
   * Alpha bots are SIGNAL-ONLY — they do NOT:
   *   - execute trades
   *   - change cash
   *   - change qty
   *   - record fills, fees, slippage
   *   - manufacture realized PnL or wins/losses
   *
   * cash = STARTING_EQUITY (fixed), qty = 0, trades = [] at all times.
   * A flat equity point at STARTING_EQUITY is appended each bar so the
   * equity chart renderer has data to display.
   */
  private recordAlphaTelemetry(
    bot: SubBotTracker,
    rationale: string | undefined,
    timestampSec: number
  ): void {
    // Update last signal description for UI display
    if (rationale && bot.lastSignalDescription === "INITIALIZING") {
      bot.lastSignalDescription = rationale.slice(0, 42);
    } else if (rationale) {
      bot.lastSignalDescription = rationale.slice(0, 42);
    }

    // Flat equity line: cash stays STARTING_EQUITY, qty stays 0
    // This is not simulated trading — it is a telemetry placeholder for the chart.
    bot.equityCurve.push({ time: timestampSec, equity: STARTING_EQUITY });
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