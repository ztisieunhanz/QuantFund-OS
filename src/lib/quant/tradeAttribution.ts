// ============================================================================
// FILE: src/lib/quant/tradeAttribution.ts
// MODULE: CANONICAL TRADE ATTRIBUTION & ROUND-TRIP RECONSTRUCTION ENGINE
// ============================================================================

import type {
  AssetId,
  ClosedTradeRecord,
  ExecutionRecord,
  RoundTripEpisode,
  TradeAttributionSummary,
} from "./types";

export interface TradeAttributionResult {
  readonly closedTrades: readonly ClosedTradeRecord[];
  readonly roundTrips: readonly RoundTripEpisode[];
  readonly summary: TradeAttributionSummary;
}

const EPSILON_QTY = 1e-8;
const EPSILON_PNL = 1e-4;
const EPSILON_OVERSELL_TOLERANCE = 1e-3;

/**
 * Reconstruct closed trade lots and completed round-trip episodes from execution fills.
 *
 * PURE DERIVATION ARCHITECTURE:
 * - Accepts an array of ExecutionRecord[].
 * - Derives average-cost inventory attribution, closed lot PnL, and completed episode statistics.
 * - Does NOT mutate canonical accounting state.
 */
export function reconstructTradeAttribution(
  executions: readonly ExecutionRecord[],
  _initialCapital = 10000
): TradeAttributionResult {
  // Input validation
  for (let i = 0; i < executions.length; i++) {
    const e = executions[i];
    if (
      !Number.isFinite(e.executionTimestamp) ||
      !Number.isFinite(e.quantity) ||
      !Number.isFinite(e.executionPrice) ||
      !Number.isFinite(e.fees)
    ) {
      throw new Error(`TradeAttribution Error: Non-finite numerical field in execution at index ${i}.`);
    }
    if (e.quantity <= 0) {
      throw new Error(`TradeAttribution Error: Execution quantity must be > 0 at index ${i}.`);
    }
    if (e.executionPrice <= 0) {
      throw new Error(`TradeAttribution Error: Execution price must be > 0 at index ${i}.`);
    }
    if (e.fees < 0) {
      throw new Error(`TradeAttribution Error: Execution fees must be >= 0 at index ${i}.`);
    }
    if (e.side !== "BUY" && e.side !== "SELL") {
      throw new Error(`TradeAttribution Error: Unsupported execution side "${e.side}" at index ${i}.`);
    }
  }

  const closedTrades: ClosedTradeRecord[] = [];
  const roundTrips: RoundTripEpisode[] = [];

  interface ActiveEpisodeState {
    episodeId: string;
    entryTimestamp: number;
    exitTimestamp: number;
    totalEntryQuantity: number;
    totalExitQuantity: number;
    closedLotCount: number;
    totalEntryFees: number;
    totalExitFees: number;
    grossPnl: number;
    netPnl: number;
  }

  interface AssetState {
    openQuantity: number;
    averageEntryPrice: number;
    remainingEntryFees: number;
    episodeCounter: number;
    tradeCounter: number;
    activeEpisode: ActiveEpisodeState | null;
  }

  const assetStates = new Map<AssetId, AssetState>();

  function getAssetState(assetId: AssetId): AssetState {
    let state = assetStates.get(assetId);
    if (!state) {
      state = {
        openQuantity: 0,
        averageEntryPrice: 0,
        remainingEntryFees: 0,
        episodeCounter: 0,
        tradeCounter: 0,
        activeEpisode: null,
      };
      assetStates.set(assetId, state);
    }
    return state;
  }

  let totalEntryFeesAcc = 0;
  let totalExitFeesAcc = 0;

  for (const exec of executions) {
    const state = getAssetState(exec.assetId);

    if (exec.side === "BUY") {
      totalEntryFeesAcc += exec.fees;
      if (state.openQuantity <= EPSILON_QTY) {
        // FLAT -> OPEN
        state.openQuantity = exec.quantity;
        state.averageEntryPrice = exec.executionPrice;
        state.remainingEntryFees = exec.fees;
        state.episodeCounter += 1;

        state.activeEpisode = {
          episodeId: `ep-${exec.assetId}-${state.episodeCounter}`,
          entryTimestamp: exec.executionTimestamp,
          exitTimestamp: exec.executionTimestamp,
          totalEntryQuantity: exec.quantity,
          totalExitQuantity: 0,
          closedLotCount: 0,
          totalEntryFees: exec.fees,
          totalExitFees: 0,
          grossPnl: 0,
          netPnl: 0,
        };
      } else {
        // SCALE-IN
        const prevQty = state.openQuantity;
        const prevAvgPrice = state.averageEntryPrice;
        const newQty = prevQty + exec.quantity;
        state.averageEntryPrice = (prevQty * prevAvgPrice + exec.quantity * exec.executionPrice) / newQty;
        state.remainingEntryFees += exec.fees;
        state.openQuantity = newQty;

        if (state.activeEpisode) {
          state.activeEpisode.totalEntryQuantity += exec.quantity;
          state.activeEpisode.totalEntryFees += exec.fees;
        }
      }
    } else if (exec.side === "SELL") {
      totalExitFeesAcc += exec.fees;

      if (state.openQuantity <= EPSILON_QTY) {
        throw new Error(`TradeAttribution Error: Cannot SELL asset "${exec.assetId}" when position is flat.`);
      }

      if (exec.quantity > state.openQuantity + EPSILON_OVERSELL_TOLERANCE) {
        throw new Error(
          `TradeAttribution Error: SELL quantity (${exec.quantity}) exceeds open inventory (${state.openQuantity}) for asset "${exec.assetId}".`
        );
      }

      const sellQty = Math.min(exec.quantity, state.openQuantity);
      const openQtyBeforeSell = state.openQuantity;

      const allocatedEntryFees = state.remainingEntryFees * (sellQty / openQtyBeforeSell);
      const allocatedEntryCost = sellQty * state.averageEntryPrice;
      const grossExitProceeds = sellQty * exec.executionPrice;
      const grossPnl = grossExitProceeds - allocatedEntryCost;
      const netPnl = grossPnl - allocatedEntryFees - exec.fees;

      state.tradeCounter += 1;
      const episodeId = state.activeEpisode ? state.activeEpisode.episodeId : `ep-${exec.assetId}-${state.episodeCounter}`;

      const closedLot: ClosedTradeRecord = {
        tradeId: `ct-${exec.executionId || state.tradeCounter}`,
        episodeId,
        assetId: exec.assetId,
        exitTimestamp: exec.executionTimestamp,
        quantity: sellQty,
        averageEntryPrice: state.averageEntryPrice,
        exitPrice: exec.executionPrice,
        allocatedEntryCost,
        allocatedEntryFees,
        exitFees: exec.fees,
        grossPnl,
        netPnl,
      };

      closedTrades.push(closedLot);

      state.remainingEntryFees -= allocatedEntryFees;
      state.openQuantity -= sellQty;

      if (state.activeEpisode) {
        state.activeEpisode.totalExitQuantity += sellQty;
        state.activeEpisode.closedLotCount += 1;
        state.activeEpisode.totalExitFees += exec.fees;
        state.activeEpisode.grossPnl += grossPnl;
        state.activeEpisode.netPnl += netPnl;
        state.activeEpisode.exitTimestamp = exec.executionTimestamp;
      }

      // Check for full exit (OPEN -> FLAT)
      if (state.openQuantity <= EPSILON_QTY) {
        state.openQuantity = 0;
        state.averageEntryPrice = 0;
        state.remainingEntryFees = 0;

        if (state.activeEpisode) {
          const epNetPnl = state.activeEpisode.netPnl;
          let result: "WIN" | "LOSS" | "BREAK_EVEN" = "BREAK_EVEN";
          if (epNetPnl > EPSILON_PNL) {
            result = "WIN";
          } else if (epNetPnl < -EPSILON_PNL) {
            result = "LOSS";
          }

          roundTrips.push({
            episodeId: state.activeEpisode.episodeId,
            assetId: exec.assetId,
            entryTimestamp: state.activeEpisode.entryTimestamp,
            exitTimestamp: state.activeEpisode.exitTimestamp,
            totalEntryQuantity: state.activeEpisode.totalEntryQuantity,
            totalExitQuantity: state.activeEpisode.totalExitQuantity,
            closedLotCount: state.activeEpisode.closedLotCount,
            totalEntryFees: state.activeEpisode.totalEntryFees,
            totalExitFees: state.activeEpisode.totalExitFees,
            grossPnl: state.activeEpisode.grossPnl,
            netPnl: epNetPnl,
            result,
          });

          state.activeEpisode = null;
        }
      }
    }
  }

  let wins = 0;
  let losses = 0;
  let breakEven = 0;
  let totalGrossPnl = 0;
  let totalNetPnl = 0;

  for (const rt of roundTrips) {
    if (rt.result === "WIN") wins += 1;
    else if (rt.result === "LOSS") losses += 1;
    else if (rt.result === "BREAK_EVEN") breakEven += 1;
  }

  for (const ct of closedTrades) {
    totalGrossPnl += ct.grossPnl;
    totalNetPnl += ct.netPnl;
  }

  const winRatePct = wins + losses > 0 ? (wins / (wins + losses)) * 100 : null;

  let totalUnallocatedEntryFees = 0;
  let totalOpenQuantity = 0;
  for (const s of assetStates.values()) {
    if (s.openQuantity > EPSILON_QTY) {
      totalUnallocatedEntryFees += s.remainingEntryFees;
      totalOpenQuantity += s.openQuantity;
    }
  }

  const summary: TradeAttributionSummary = {
    totalExecutions: executions.length,
    closedTradeCount: closedTrades.length,
    roundTripCount: roundTrips.length,
    wins,
    losses,
    breakEven,
    winRatePct: winRatePct != null ? Math.round(winRatePct * 100) / 100 : null,
    totalGrossPnl: Math.round(totalGrossPnl * 100) / 100,
    totalNetPnl: Math.round(totalNetPnl * 100) / 100,
    totalEntryFees: Math.round(totalEntryFeesAcc * 100) / 100,
    totalExitFees: Math.round(totalExitFeesAcc * 100) / 100,
    unallocatedEntryFees: Math.round(totalUnallocatedEntryFees * 100) / 100,
    openQuantity: Math.round(totalOpenQuantity * 100000) / 100000,
  };

  return {
    closedTrades,
    roundTrips,
    summary,
  };
}
