import type { PortfolioAccountState } from "@/lib/quant/executionEngine";
import type { AssetId, DataQualityStatus, PointInTimeBar, PositionRecord } from "@/lib/quant/types";
import { BAR_DURATION_MS } from "@/lib/quant/timeDomain";
import {
  canonicalProducerJson,
  immutableProducerCopy,
  producerIdentity,
} from "@/lib/quant/producerProvenance";

export const CANONICAL_PORTFOLIO_VALUATION_SCHEMA_VERSION = "M14_A04_PORTFOLIO_VALUATION_V1" as const;
/** Floating-point reconciliation guard only; never an action/lifecycle comparison tolerance. */
export const PORTFOLIO_WEIGHT_RECONCILIATION_TOLERANCE = 1e-12;
const trustedCanonicalValuations = new WeakSet<object>();

export interface CanonicalValuationMarkInput {
  readonly assetId: AssetId;
  readonly bar: PointInTimeBar;
}

export interface CanonicalPortfolioValuationMark {
  readonly assetId: AssetId;
  readonly priceField: "CLOSE";
  readonly price: number;
  readonly availableAt: number;
  readonly bar: PointInTimeBar;
  readonly priceEvidenceIdentity: string;
}

export interface CanonicalPortfolioMarketValue {
  readonly assetId: AssetId;
  readonly units: number;
  readonly price: number;
  readonly marketValue: number;
}

export interface CanonicalPortfolioValuationSnapshot {
  readonly schemaVersion: typeof CANONICAL_PORTFOLIO_VALUATION_SCHEMA_VERSION;
  readonly boundary: "BAR_CLOSE_AFTER_PRIOR_TARGET_EXECUTION_BEFORE_NEW_TARGET";
  readonly decisionTime: number;
  readonly priceAuthority: "BACKTEST_DATASET_ASSET_BARS";
  readonly dataQuality: "LIVE";
  readonly accountState: PortfolioAccountState;
  readonly accountStateIdentity: string;
  readonly valuationMarks: readonly CanonicalPortfolioValuationMark[];
  readonly marketValues: readonly CanonicalPortfolioMarketValue[];
  readonly cash: number;
  readonly nav: number;
  readonly assetWeights: Readonly<Record<AssetId, number>>;
  readonly cashWeight: number;
  readonly semanticIdentity: string;
}

function validatePosition(assetId: string, position: PositionRecord): void {
  if (position.assetId !== assetId) throw new Error(`Valuation account position asset mismatch for ${assetId}`);
  if (![position.quantity, position.entryPrice, position.unrealizedPnl].every(Number.isFinite)) throw new Error(`Valuation account position contains non-finite values for ${assetId}`);
  if (position.quantity < 0 || position.entryPrice < 0 || position.side === "SHORT") throw new Error(`Valuation account violates long-only requirements for ${assetId}`);
  if (position.quantity > 0 && (position.side !== "LONG" || position.status !== "OPEN")) throw new Error(`Positive valuation holding must be an open long position for ${assetId}`);
  if (position.quantity === 0 && position.side !== "FLAT") throw new Error(`Zero valuation holding must be flat for ${assetId}`);
}

function validateBar(assetId: string, bar: PointInTimeBar, decisionTime: number): void {
  if (!Number.isSafeInteger(bar.timestamp) || bar.timestamp < 0) throw new Error(`Valuation mark for ${assetId} has an invalid candle-open timestamp`);
  const availableAt = bar.timestamp + BAR_DURATION_MS;
  if (!Number.isSafeInteger(availableAt) || availableAt !== decisionTime) throw new Error(`Valuation mark for ${assetId} is not the exact completed 1H close available at the decision boundary`);
  if (![bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite)) throw new Error(`Valuation mark for ${assetId} contains non-finite bar values`);
  if (bar.open <= 0 || bar.high <= 0 || bar.low <= 0 || bar.close <= 0 || bar.volume < 0) throw new Error(`Valuation mark for ${assetId} contains invalid price/volume evidence`);
}

function snapshotSemanticMaterial(snapshot: Omit<CanonicalPortfolioValuationSnapshot, "semanticIdentity">) {
  return snapshot;
}

export function createCanonicalPortfolioValuationSnapshot(input: {
  readonly decisionTime: number;
  readonly account: PortfolioAccountState;
  readonly marks: readonly CanonicalValuationMarkInput[];
  readonly dataQuality: DataQualityStatus;
}): CanonicalPortfolioValuationSnapshot {
  if (!Number.isSafeInteger(input.decisionTime) || input.decisionTime < 0) throw new Error("Valuation decisionTime must be a non-negative safe-integer epoch millisecond");
  if (input.dataQuality !== "LIVE") throw new Error("Canonical valuation requires LIVE canonical price evidence; synthetic/degraded inputs remain unbound");
  if (!Number.isFinite(input.account.cash) || input.account.cash < 0) throw new Error("Valuation account cash must be finite and non-negative");

  const positionEntries = Object.entries(input.account.positions).sort(([a], [b]) => a.localeCompare(b));
  for (const [assetId, position] of positionEntries) validatePosition(assetId, position);
  const heldAssets = positionEntries.filter(([, position]) => position.quantity > 0).map(([assetId]) => assetId);

  const marksByAsset = new Map<string, CanonicalValuationMarkInput>();
  for (const mark of input.marks) {
    if (!mark.assetId) throw new Error("Valuation mark assetId is required");
    if (marksByAsset.has(mark.assetId)) throw new Error(`Duplicate/conflicting valuation mark for ${mark.assetId}`);
    validateBar(mark.assetId, mark.bar, input.decisionTime);
    marksByAsset.set(mark.assetId, mark);
  }
  const markAssets = [...marksByAsset.keys()].sort();
  if (canonicalProducerJson(markAssets) !== canonicalProducerJson(heldAssets)) throw new Error("Valuation marks must match held assets exactly; missing or unrelated marks are forbidden");

  const accountState: PortfolioAccountState = {
    cash: input.account.cash,
    positions: Object.fromEntries(positionEntries),
  };
  const accountStateIdentity = producerIdentity({
    schemaVersion: CANONICAL_PORTFOLIO_VALUATION_SCHEMA_VERSION,
    accountState,
  });
  const valuationMarks: CanonicalPortfolioValuationMark[] = [];
  const marketValues: CanonicalPortfolioMarketValue[] = [];
  const assetWeights: Record<AssetId, number> = {};
  let nav = input.account.cash;

  for (const assetId of heldAssets) {
    const markInput = marksByAsset.get(assetId)!;
    const position = input.account.positions[assetId];
    const priceEvidenceIdentity = producerIdentity({
      schemaVersion: CANONICAL_PORTFOLIO_VALUATION_SCHEMA_VERSION,
      assetId,
      priceField: "CLOSE",
      availableAt: markInput.bar.timestamp + BAR_DURATION_MS,
      bar: markInput.bar,
    });
    const marketValue = position.quantity * markInput.bar.close;
    if (!Number.isFinite(marketValue) || marketValue < 0) throw new Error(`Invalid market value for ${assetId}`);
    valuationMarks.push({ assetId, priceField: "CLOSE", price: markInput.bar.close, availableAt: markInput.bar.timestamp + BAR_DURATION_MS, bar: markInput.bar, priceEvidenceIdentity });
    marketValues.push({ assetId, units: position.quantity, price: markInput.bar.close, marketValue });
    nav += marketValue;
  }
  if (!Number.isFinite(nav) || nav <= 0) throw new Error("Canonical valuation NAV must be finite and positive");
  for (const value of marketValues) assetWeights[value.assetId] = value.marketValue / nav;
  const cashWeight = input.account.cash / nav;
  const totalWeight = cashWeight + Object.values(assetWeights).reduce((sum, weight) => sum + weight, 0);
  if (!Number.isFinite(totalWeight) || Math.abs(totalWeight - 1) > PORTFOLIO_WEIGHT_RECONCILIATION_TOLERANCE) throw new Error("Canonical valuation weights do not reconcile to NAV");

  const material = {
    schemaVersion: CANONICAL_PORTFOLIO_VALUATION_SCHEMA_VERSION,
    boundary: "BAR_CLOSE_AFTER_PRIOR_TARGET_EXECUTION_BEFORE_NEW_TARGET" as const,
    decisionTime: input.decisionTime,
    priceAuthority: "BACKTEST_DATASET_ASSET_BARS" as const,
    dataQuality: "LIVE" as const,
    accountState,
    accountStateIdentity,
    valuationMarks,
    marketValues,
    cash: input.account.cash,
    nav,
    assetWeights,
    cashWeight,
  };
  const snapshot = immutableProducerCopy({ ...material, semanticIdentity: producerIdentity(snapshotSemanticMaterial(material)) });
  trustedCanonicalValuations.add(snapshot);
  return snapshot;
}

export function validateCanonicalPortfolioValuationSnapshot(snapshot: CanonicalPortfolioValuationSnapshot): void {
  if (trustedCanonicalValuations.has(snapshot)) return;
  if (snapshot.schemaVersion !== CANONICAL_PORTFOLIO_VALUATION_SCHEMA_VERSION || snapshot.boundary !== "BAR_CLOSE_AFTER_PRIOR_TARGET_EXECUTION_BEFORE_NEW_TARGET" || snapshot.priceAuthority !== "BACKTEST_DATASET_ASSET_BARS" || snapshot.dataQuality !== "LIVE") throw new Error("Invalid canonical portfolio valuation contract");
  const rebuilt = createCanonicalPortfolioValuationSnapshot({
    decisionTime: snapshot.decisionTime,
    account: snapshot.accountState,
    marks: snapshot.valuationMarks.map((mark) => ({ assetId: mark.assetId, bar: mark.bar })),
    dataQuality: snapshot.dataQuality,
  });
  if (canonicalProducerJson(rebuilt) !== canonicalProducerJson(snapshot)) throw new Error("Canonical portfolio valuation identity/content mismatch");
}
