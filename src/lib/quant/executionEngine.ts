// ============================================================================
// FILE: src/lib/quant/executionEngine.ts
// MODULE: DETERMINISTIC REBALANCE & POSITION ACCOUNTING SIMULATOR
// ============================================================================

import type {
  AssetId,
  ExecutionRecord,
  ExecutionRule,
  OrderSide,
  PointInTimeBar,
  PositionRecord,
  SlippageModelConfig,
  TargetPortfolioWeight,
} from "@/lib/quant/types";

export interface ExecutionContext {
  readonly decisionTimestamp: number;
  readonly executionTimestamp: number;
  readonly executionRule: ExecutionRule;
  readonly commissionRate: number;
  readonly slippageConfig: SlippageModelConfig;
  readonly minRebalanceThresholdUsd?: number;
}

export interface PortfolioAccountState {
  readonly cash: number;
  readonly positions: Readonly<Record<AssetId, PositionRecord>>;
}

export interface ExecutionEngineResult {
  readonly updatedAccount: PortfolioAccountState;
  readonly records: readonly ExecutionRecord[];
  readonly totalFeesUsd: number;
  readonly totalSlippageCostUsd: number;
  readonly netCashFlowUsd: number;
}

interface PriceImpactResult {
  readonly executionPrice: number;
  readonly slippageBps: number;
  readonly slippageCostUsd: number;
}

function calculatePriceImpact(
  basePrice: number,
  side: OrderSide,
  quantity: number,
  barVolume: number,
  config: SlippageModelConfig
): PriceImpactResult {
  if (basePrice <= 0 || quantity <= 0) {
    return { executionPrice: basePrice, slippageBps: 0, slippageCostUsd: 0 };
  }

  let effectiveBps = Math.max(0, config.baseBps);

  if (config.type === "VOLUME_SHARE_IMPACT" && barVolume > 0) {
    const impactCoeff = config.impactFactor ?? 0.1;
    const volumeShare = Math.min(1.0, quantity / barVolume);
    effectiveBps += impactCoeff * Math.sqrt(volumeShare) * 10000;
  } else if (config.type === "LINEAR_SLIPPAGE" && barVolume > 0) {
    const impactCoeff = config.impactFactor ?? 0.05;
    const volumeShare = Math.min(1.0, quantity / barVolume);
    effectiveBps += impactCoeff * volumeShare * 10000;
  }

  const slippageFactor = effectiveBps / 10000;
  const slippagePerUnit = basePrice * slippageFactor;
  const executionPrice = side === "BUY" ? basePrice + slippagePerUnit : Math.max(0.0001, basePrice - slippagePerUnit);

  return {
    executionPrice,
    slippageBps: effectiveBps,
    slippageCostUsd: quantity * slippagePerUnit,
  };
}

interface OrderIntent {
  readonly assetId: AssetId;
  readonly side: OrderSide;
  readonly targetUnitsDelta: number;
  readonly notionalUsd: number;
}

export function executeRebalance(
  currentAccount: PortfolioAccountState,
  targetWeights: TargetPortfolioWeight,
  assetBars: Readonly<Record<AssetId, PointInTimeBar>>,
  context: ExecutionContext
): ExecutionEngineResult {
  const minThresholdUsd = context.minRebalanceThresholdUsd ?? 50.0;
  const currentPositions = { ...currentAccount.positions };
  let cash = currentAccount.cash;

  // 1. TÍNH TOÁN NAV CHÍNH XÁC THEO GIÁ THỰC THI (Mở cửa nến T+1 hoặc Đóng cửa T)
  let currentNav = cash;
  for (const [assetId, pos] of Object.entries(currentPositions)) {
    const bar = assetBars[assetId];
    if (bar && pos.quantity > 0) {
      const price = context.executionRule === "NEXT_BAR_OPEN" ? bar.open : bar.close;
      currentNav += pos.quantity * price;
    }
  }

  // 2. TÍNH TOÁN DELTA VỊ THẾ
  const allAssetIds = Array.from(
    new Set([...Object.keys(currentPositions), ...Object.keys(targetWeights.assetWeights)])
  ).sort(); // Deterministic asset order

  const rawIntents: OrderIntent[] = [];

  for (const assetId of allAssetIds) {
    const bar = assetBars[assetId];
    if (!bar) continue;

    const basePrice = context.executionRule === "NEXT_BAR_OPEN" ? bar.open : bar.close;
    if (basePrice <= 0) continue;

    const currentUnits = currentPositions[assetId]?.quantity ?? 0;
    const currentNotional = currentUnits * basePrice;

    // Trong phiên bản Long-Only có kiểm soát, trọng số âm được đưa về 0
    const targetWeight = Math.max(0, targetWeights.assetWeights[assetId] ?? 0);
    const targetNotional = targetWeight * currentNav;
    const deltaNotional = targetNotional - currentNotional;

    if (Math.abs(deltaNotional) < minThresholdUsd) continue;

    const deltaUnits = Math.abs(deltaNotional) / basePrice;
    const side: OrderSide = deltaNotional > 0 ? "BUY" : "SELL";

    rawIntents.push({
      assetId,
      side,
      targetUnitsDelta: deltaUnits,
      notionalUsd: Math.abs(deltaNotional),
    });
  }

  // 3. DETERMINISTIC SORT KEY: Bán trước, Mua sau. 
  // Đối với nhiều lệnh Mua: ưu tiên Notional lớn nhất, sau đó đến thứ tự bảng chữ cái của AssetId
  const sortedIntents = [...rawIntents].sort((a, b) => {
    if (a.side === "SELL" && b.side === "BUY") return -1;
    if (a.side === "BUY" && b.side === "SELL") return 1;
    if (b.notionalUsd !== a.notionalUsd) return b.notionalUsd - a.notionalUsd;
    return a.assetId.localeCompare(b.assetId);
  });

  const records: ExecutionRecord[] = [];
  let totalFeesUsd = 0;
  let totalSlippageCostUsd = 0;
  let netCashFlowUsd = 0;

  for (const intent of sortedIntents) {
    const bar = assetBars[intent.assetId];
    if (!bar) continue;

    const basePrice = context.executionRule === "NEXT_BAR_OPEN" ? bar.open : bar.close;
    let executableUnits = intent.targetUnitsDelta;

    if (intent.side === "SELL") {
      const currentUnits = currentPositions[intent.assetId]?.quantity ?? 0;
      executableUnits = Math.min(currentUnits, executableUnits);
      if (executableUnits <= 0) continue;
    }

    const impact = calculatePriceImpact(
      basePrice,
      intent.side,
      executableUnits,
      bar.volume,
      context.slippageConfig
    );

    let grossTradeValue = executableUnits * impact.executionPrice;
    let fees = grossTradeValue * context.commissionRate;

    if (intent.side === "BUY") {
      const totalRequired = grossTradeValue + fees;
      if (totalRequired > cash) {
        const affordableValue = Math.max(0, cash / (1 + context.commissionRate));
        executableUnits = affordableValue / impact.executionPrice;
        grossTradeValue = executableUnits * impact.executionPrice;
        fees = grossTradeValue * context.commissionRate;
      }
      if (executableUnits <= 1e-8) continue;
    }

    let netCashImpact = 0;
    const existingPos = currentPositions[intent.assetId];

    if (intent.side === "SELL") {
      netCashImpact = grossTradeValue - fees;
      cash += netCashImpact;
      const remainingUnits = Math.max(0, (existingPos?.quantity ?? 0) - executableUnits);

      if (remainingUnits > 1e-8) {
        currentPositions[intent.assetId] = {
          assetId: intent.assetId,
          side: "LONG",
          status: "OPEN",
          quantity: remainingUnits,
          entryPrice: existingPos?.entryPrice ?? impact.executionPrice,
          unrealizedPnl: (basePrice - (existingPos?.entryPrice ?? impact.executionPrice)) * remainingUnits,
        };
      } else {
        currentPositions[intent.assetId] = {
          assetId: intent.assetId,
          side: "FLAT",
          status: "CLOSED",
          quantity: 0,
          entryPrice: 0,
          unrealizedPnl: 0,
        };
      }
    } else {
      netCashImpact = -(grossTradeValue + fees);
      cash += netCashImpact;
      const prevQty = existingPos?.quantity ?? 0;
      const prevEntry = existingPos?.entryPrice ?? impact.executionPrice;
      const newQty = prevQty + executableUnits;
      const newEntry = (prevQty * prevEntry + executableUnits * impact.executionPrice) / newQty;

      currentPositions[intent.assetId] = {
        assetId: intent.assetId,
        side: "LONG",
        status: "OPEN",
        quantity: newQty,
        entryPrice: newEntry,
        unrealizedPnl: (basePrice - newEntry) * newQty,
      };
    }

    totalFeesUsd += fees;
    totalSlippageCostUsd += impact.slippageCostUsd;
    netCashFlowUsd += netCashImpact;

    records.push({
      executionId: `exec-${intent.assetId}-${context.executionTimestamp}-${intent.side}`,
      orderId: `ord-${intent.assetId}-${context.decisionTimestamp}`,
      strategyId: "OMEGA_REBALANCE",
      assetId: intent.assetId,
      side: intent.side,
      orderType: "MARKET",
      signalTimestamp: targetWeights.asOfTimestamp,
      decisionTimestamp: context.decisionTimestamp,
      executionTimestamp: context.executionTimestamp,
      intendedPrice: Math.round(basePrice * 100) / 100,
      executionPrice: Math.round(impact.executionPrice * 100) / 100,
      quantity: Math.round(executableUnits * 100000) / 100000,
      notionalUsd: Math.round(grossTradeValue * 100) / 100,
      slippage: Math.round(impact.slippageBps * 10) / 10,
      fees: Math.round(fees * 100) / 100,
      netCashImpact: Math.round(netCashImpact * 100) / 100,
    });
  }

  return {
    updatedAccount: {
      cash: Math.round(cash * 100) / 100,
      positions: currentPositions,
    },
    records,
    totalFeesUsd: Math.round(totalFeesUsd * 100) / 100,
    totalSlippageCostUsd: Math.round(totalSlippageCostUsd * 100) / 100,
    netCashFlowUsd: Math.round(netCashFlowUsd * 100) / 100,
  };
}