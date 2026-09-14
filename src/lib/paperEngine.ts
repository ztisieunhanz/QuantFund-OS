import type { BotMetrics, EquityPoint, OhlcvBar, Side, TradeFill } from "@/types/market";
import { ema, rsi } from "@/lib/math";

export const STARTING_EQUITY = 10_000;
export const FEE_BPS = 0.001;
export const SLIPPAGE_BPS = 0.0005;

interface BotState {
  id: "trend" | "meanrev" | "dca";
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
  lastBarTime: number;
}

function createBot(id: BotState["id"], name: string): BotState {
  return {
    id, name,
    cash: STARTING_EQUITY, qty: 0, entry: null, realized: 0,
    wins: 0, losses: 0, peak: STARTING_EQUITY, maxDd: 0,
    trades: [], equityCurve: [], lastSignal: "FLAT", lastBarTime: 0,
  };
}

function markEquity(bot: BotState, price: number, time: number): number {
  const equity = bot.cash + bot.qty * price;
  bot.peak = Math.max(bot.peak, equity);
  const dd = bot.peak > 0 ? (bot.peak - equity) / bot.peak : 0;
  bot.maxDd = Math.max(bot.maxDd, dd);
  const last = bot.equityCurve.at(-1);
  if (!last || last.time !== time) bot.equityCurve.push({ time, equity });
  else last.equity = equity;
  return equity;
}

function fill(bot: BotState, side: Side, rawPrice: number, time: number): void {
  const slipped = side === "BUY" ? rawPrice * (1 + SLIPPAGE_BPS) : rawPrice * (1 - SLIPPAGE_BPS);
  if (side === "BUY") {
    if (bot.qty > 0 || bot.cash <= 1) return;
    const notional = bot.cash;
    const fee = notional * FEE_BPS;
    const spend = notional - fee;
    const qty = spend / slipped;
    bot.qty = qty; bot.cash = 0; bot.entry = slipped;
    bot.trades.push({ id: `${bot.id}-${time}-B`, botId: bot.id, time, side, price: slipped, qty, fee, slippage: slipped - rawPrice, notional });
    bot.lastSignal = "BUY";
    return;
  }
  if (bot.qty <= 0) return;
  const qty = bot.qty;
  const gross = qty * slipped;
  const fee = gross * FEE_BPS;
  const proceeds = gross - fee;
  if (bot.entry != null) {
    const pnl = proceeds - qty * bot.entry;
    if (pnl >= 0) bot.wins += 1; else bot.losses += 1;
    bot.realized += pnl;
  }
  bot.cash += proceeds; bot.qty = 0; bot.entry = null;
  bot.trades.push({ id: `${bot.id}-${time}-S`, botId: bot.id, time, side, price: slipped, qty, fee, slippage: rawPrice - slipped, notional: gross });
  bot.lastSignal = "SELL";
}

function fillDca(bot: BotState, rawPrice: number, time: number): void {
  const spend = STARTING_EQUITY * 0.1; // Mỗi lần gom 10% vốn
  if (bot.cash < spend) return;
  
  const slipped = rawPrice * (1 + SLIPPAGE_BPS);
  const fee = spend * FEE_BPS;
  const netSpend = spend - fee;
  const qty = netSpend / slipped;

  const totalCostBefore = bot.qty * (bot.entry ?? 0);
  bot.qty += qty;
  bot.entry = (totalCostBefore + (qty * slipped)) / bot.qty;
  bot.cash -= spend;

  bot.trades.push({
    id: `${bot.id}-${time}-DCA`, botId: bot.id, time, side: "BUY",
    price: slipped, qty, fee, slippage: slipped - rawPrice, notional: spend,
  });
  bot.lastSignal = "DCA ACCUMULATING";
}

function toMetrics(bot: BotState, price: number): BotMetrics {
  const equity = bot.cash + bot.qty * price;
  const closed = bot.wins + bot.losses;
  return {
    botId: bot.id, name: bot.name, cash: bot.cash, qty: bot.qty, lastPrice: price, equity,
    pnl: equity - STARTING_EQUITY, pnlPct: (equity - STARTING_EQUITY) / STARTING_EQUITY,
    winRate: closed === 0 ? 0 : bot.wins / closed, maxDrawdown: bot.maxDd,
    totalTrades: bot.trades.length, wins: bot.wins, losses: bot.losses,
    position: bot.qty > 0 ? (bot.id === "dca" ? "HOLDING" : "LONG") : "FLAT",
    lastSignal: bot.lastSignal, trades: bot.trades, equityCurve: bot.equityCurve,
  };
}

export class PaperEngine {
  trend = createBot("trend", "Bot A · Trend Follower");
  mean = createBot("meanrev", "Bot B · Mean Reversion");
  dca = createBot("dca", "Bot C · Macro Accumulator");

  reset(): void {
    this.trend = createBot("trend", "Bot A · Trend Follower");
    this.mean = createBot("meanrev", "Bot B · Mean Reversion");
    this.dca = createBot("dca", "Bot C · Macro Accumulator");
  }

  replay(bars: OhlcvBar[], isRiskOff: boolean = false): { trend: BotMetrics; mean: BotMetrics; dca: BotMetrics } {
    this.reset();
    const closes = bars.map((b) => b.close);
    const e20 = ema(closes, 20);
    const e50 = ema(closes, 50);
    const r = rsi(closes, 14);
    let lastDcaTime = 0;

    for (let i = 0; i < bars.length; i += 1) {
      const bar = bars[i];
      const cur20 = e20[i]; const cur50 = e50[i]; const curRsi = r[i];
      const prev20 = i > 0 ? e20[i - 1] : null; const prev50 = i > 0 ? e50[i - 1] : null;

      if (prev20 != null && prev50 != null && cur20 != null && cur50 != null) {
        if (prev20 <= prev50 && cur20 > cur50) {
          if (isRiskOff) this.trend.lastSignal = "BLOCKED (RISK-OFF)";
          else fill(this.trend, "BUY", bar.close, bar.time);
        }
        if (prev20 >= prev50 && cur20 < cur50) fill(this.trend, "SELL", bar.close, bar.time);
      }

      if (curRsi != null) {
        if (curRsi < 30) fill(this.mean, "BUY", bar.close, bar.time);
        if (curRsi > 70) fill(this.mean, "SELL", bar.close, bar.time);
        
        if (cur50 != null && bar.close < cur50 * 0.985 && curRsi < 35) {
          if (bar.time - lastDcaTime > 3600) {
            fillDca(this.dca, bar.close, bar.time);
            lastDcaTime = bar.time;
          }
        }
      }

      markEquity(this.trend, bar.close, bar.time);
      markEquity(this.mean, bar.close, bar.time);
      markEquity(this.dca, bar.close, bar.time);
      this.trend.lastBarTime = bar.time; this.mean.lastBarTime = bar.time; this.dca.lastBarTime = bar.time;
    }

    const last = bars.at(-1)?.close ?? 0;
    return { trend: toMetrics(this.trend, last), mean: toMetrics(this.mean, last), dca: toMetrics(this.dca, last) };
  }

  ingestBar(bar: OhlcvBar, history: OhlcvBar[], isRiskOff: boolean = false): { trend: BotMetrics; mean: BotMetrics; dca: BotMetrics } {
    return this.replay(history, isRiskOff);
  }
}