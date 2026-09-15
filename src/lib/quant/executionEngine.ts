// ============================================================================
// FILE: src/lib/quant/executionEngine.ts
// MODULE: EXECUTION ENGINE & TRANSACTION AUDIT SIMULATOR
// ARCHITECTURE: TargetPortfolioWeight + AccountState -> Fills -> UpdatedAccountState
// ============================================================================

import type {
  AssetId,
  ExecutionRecord,
  ExecutionRule,
  PointInTimeBar,
  Side,
  SlippageModelConfig,
  TargetPortfolioWeight,
} from "@/lib/quant/types";

// ----------------------------------------------------------------------------
// 1. CONTEXT & CONFIGURATION CONTRACTS
// ----------------------------------------------------------------------------

export interface ExecutionContext {
  readonly decisionTimestamp: number;
  readonly executionTimestamp: number;
  readonly executionRule: ExecutionRule;
  readonly commissionRate: number; // Ví dụ 0.001 = 10 bps
  readonly slippageConfig: SlippageModelConfig;
  readonly minRebalanceThresholdUsd?: number; // Ngưỡng bỏ qua các lệnh tái cân bằng vụn vặt (mặc định $50)
}

export interface PortfolioAccountState {
  readonly cash: number;
  readonly holdings: Readonly<Record<AssetId, number>>;
}

export interface ExecutionEngineResult {
  readonly updatedAccount: PortfolioAccountState;
  readonly records: readonly ExecutionRecord[];
  readonly totalFeesUsd: number;
  readonly totalSlippageCostUsd: number;
  readonly netCashFlowUsd: number;
}

// ----------------------------------------------------------------------------
// 2. SLIPPAGE & TRANSACTION COST CALCULATION
// ----------------------------------------------------------------------------

interface PriceImpactResult {
  readonly executionPrice: number;
  readonly slippagePerUnit: number;
  readonly slippageBps: number;
  readonly slippageCostUsd: number;
}

function calculatePriceImpact(
  basePrice: number,
  side: "BUY" | "SELL",
  quantity: number,
  barVolume: number,
  config: SlippageModelConfig
): PriceImpactResult {
  if (basePrice <= 0 || quantity <= 0) {
    return { executionPrice: basePrice, slippagePerUnit: 0, slippageBps: 0, slippageCostUsd: 0 };
  }

  let effectiveBps = Math.max(0, config.baseBps);

  // Mô hình trượt giá theo thị phần thanh khoản (Square-root law of market impact)
  if (config.type === "VOLUME_SHARE_IMPACT" && barVolume > 0) {
    const impactCoeff = config.impactFactor ?? 0.1;
    const volumeShare = Math.min(1.0, quantity / barVolume);
    const dynamicImpactBps = impactCoeff * Math.sqrt(volumeShare) * 10000;
    effectiveBps += dynamicImpactBps;
  } else if (config.type === "LINEAR_SLIPPAGE" && barVolume > 0) {
    const impactCoeff = config.impactFactor ?? 0.05;
    const volumeShare = Math.min(1.0, quantity / barVolume);
    effectiveBps += impactCoeff * volumeShare * 10000;
  }

  const slippageFactor = effectiveBps / 10000;
  const slippagePerUnit = basePrice * slippageFactor;

  // Chi phí trượt giá luôn bất lợi: Mua giá cao hơn (+), Bán giá thấp hơn (-)
  const executionPrice = side === "BUY" 
    ? basePrice + slippagePerUnit 
    : Math.max(0.0001, basePrice - slippagePerUnit);

  const slippageCostUsd = quantity * slippagePerUnit;

  return {
    executionPrice,
    slippagePerUnit,
    slippageBps: effectiveBps,
    slippageCostUsd,
  };
}

// ----------------------------------------------------------------------------
// 3. REBALANCE DELTA RESOLVER & EXECUTION LOGIC
// ----------------------------------------------------------------------------

interface OrderIntent {
  readonly assetId: AssetId;
  readonly side: Side;
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
  const holdings = { ...currentAccount.holdings };
  let cash = currentAccount.cash;

  // 1. TÍNH TOÁN NAV HIỆN HỮU TẠI THỜI ĐIỂM KHỚP LỆNH
  let currentNav = cash;
  for (const [assetId, units] of Object.entries(holdings)) {
    const bar = assetBars[assetId];
    if (bar && units > 0) {
      const price = context.executionRule === "NEXT_BAR_OPEN" ? bar.open : bar.close;
      currentNav += units * price;
    }
  }

  // 2. TÍNH TOÁN SAI LỆCH VỊ THẾ (REBALANCE DELTAS)
  const allAssetIds = Array.from(
    new Set([...Object.keys(holdings), ...Object.keys(targetWeights.assetWeights)])
  );

  const rawIntents: OrderIntent[] = [];

  for (const assetId of allAssetIds) {
    const bar = assetBars[assetId];
    if (!bar) continue;

    const basePrice = context.executionRule === "NEXT_BAR_OPEN" ? bar.open : bar.close;
    if (basePrice <= 0) continue;

    const currentUnits = holdings[assetId] ?? 0;
    const currentNotional = currentUnits * basePrice;

    const targetWeight = targetWeights.assetWeights[assetId] ?? 0;
    const targetNotional = Math.max(0, targetWeight * currentNav);
    const deltaNotional = targetNotional - currentNotional;

    // Bỏ qua nếu chênh lệch danh nghĩa nhỏ hơn ngưỡng tối thiểu
    if (Math.abs(deltaNotional) < minThresholdUsd) {
      continue;
    }

    const deltaUnits = Math.abs(deltaNotional) / basePrice;
    const side: Side = deltaNotional > 0 ? "BUY" : "SELL";

    rawIntents.push({
      assetId,
      side,
      targetUnitsDelta: deltaUnits,
      notionalUsd: Math.abs(deltaNotional),
    });
  }

  // 3. THỰC THI NGUYÊN TẮC: BÁN TRƯỚC - MUA SAU (SELL-FIRST EXECUTION ORDER)
  // Đảm bảo dòng tiền được giải phóng trước khi phân bổ lệnh mua, tránh thâm hụt tiền mặt giả định
  const sortedIntents = [...rawIntents].sort((a, b) => {
    if (a.side === "SELL" && b.side === "BUY") return -1;
    if (a.side === "BUY" && b.side === "SELL") return 1;
    return 0;
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

    // Kiểm tra tính khả dụng của số dư với lệnh BÁN
    if (intent.side === "SELL") {
      const currentHolding = holdings[intent.assetId] ?? 0;
      executableUnits = Math.min(currentHolding, executableUnits);
      if (executableUnits <= 0) continue;
    }

    // Tính toán trượt giá (Slippage)
    const impact = calculatePriceImpact(
      basePrice,
      intent.side,
      executableUnits,
      bar.volume,
      context.slippageConfig
    );

    let grossTradeValue = executableUnits * impact.executionPrice;
    let fees = grossTradeValue * context.commissionRate;

    // Kiểm tra khả năng chi trả với lệnh MUA (kể cả phí)
    if (intent.side === "BUY") {
      const totalCost = grossTradeValue + fees;
      if (totalCost > cash) {
        // Tự động thu hẹp khối lượng mua nếu tiền mặt còn lại không đủ
        const affordableValue = Math.max(0, cash / (1 + context.commissionRate));
        executableUnits = affordableValue / impact.executionPrice;
        grossTradeValue = executableUnits * impact.executionPrice;
        fees = grossTradeValue * context.commissionRate;
      }
      if (executableUnits <= 0) continue;
    }

    // Cập nhật số dư tiền mặt và khối lượng tài sản
    let netCashImpact = 0;
    if (intent.side === "SELL") {
      netCashImpact = grossTradeValue - fees;
      cash += netCashImpact;
      holdings[intent.assetId] = Math.max(0, (holdings[intent.assetId] ?? 0) - executableUnits);
    } else {
      netCashImpact = -(grossTradeValue + fees);
      cash += netCashImpact;
      holdings[intent.assetId] = (holdings[intent.assetId] ?? 0) + executableUnits;
    }

    totalFeesUsd += fees;
    totalSlippageCostUsd += impact.slippageCostUsd;
    netCashFlowUsd += netCashImpact;

    // Ghi biên lai kiểm toán chính xác tại thời điểm khớp lệnh
    const record: ExecutionRecord = {
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
    };

    records.push(record);
  }

  // Dọn dẹp các vị thế đã bán sạch (zero-units)
  for (const assetId of Object.keys(holdings)) {
    if (holdings[assetId] < 1e-8) {
      delete holdings[assetId];
    }
  }

  return {
    updatedAccount: {
      cash: Math.round(cash * 100) / 100,
      holdings,
    },
    records,
    totalFeesUsd: Math.round(totalFeesUsd * 100) / 100,
    totalSlippageCostUsd: Math.round(totalSlippageCostUsd * 100) / 100,
    netCashFlowUsd: Math.round(netCashFlowUsd * 100) / 100,
  };
}