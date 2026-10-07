export interface YieldStrategy {
  id: string;
  name: string;
  aprBps: number; // annualized yield, basis points
  riskScore: number; // 0-100
}

export interface Position {
  ownerPubkey: string;
  shares: number;
}

/**
 * ERC4626-style share accounting, same pattern as yieldagg-backend's strategy-wallet pooling:
 * deposits mint shares at the current share price, withdrawals burn shares at the current price,
 * so yield accrual is reflected purely by share price movement — no per-user interest bookkeeping.
 */
export class YieldVault {
  private totalShares = 0;
  private totalAssetsSats = 0;
  private positions = new Map<string, number>(); // pubkey -> shares
  private strategies: YieldStrategy[];
  private allocatedStrategyId: string | null = null;

  constructor(strategies: YieldStrategy[]) {
    this.strategies = strategies;
  }

  private sharePrice(): number {
    return this.totalShares === 0 ? 1 : this.totalAssetsSats / this.totalShares;
  }

  deposit(pubkey: string, amountSats: number): number {
    if (amountSats <= 0) throw new Error("amountSats must be positive");
    const shares = amountSats / this.sharePrice();
    this.totalAssetsSats += amountSats;
    this.totalShares += shares;
    this.positions.set(pubkey, (this.positions.get(pubkey) ?? 0) + shares);
    return shares;
  }

  withdraw(pubkey: string, amountSats: number): void {
    const shares = amountSats / this.sharePrice();
    const owned = this.positions.get(pubkey) ?? 0;
    if (shares > owned) throw new Error("insufficient shares");
    this.positions.set(pubkey, owned - shares);
    this.totalShares -= shares;
    this.totalAssetsSats -= amountSats;
  }

  balanceOf(pubkey: string): number {
    return (this.positions.get(pubkey) ?? 0) * this.sharePrice();
  }

  summary(): { totalAssetsSats: number; totalShares: number; depositorCount: number; allocatedStrategy: YieldStrategy | null } {
    return {
      totalAssetsSats: this.totalAssetsSats,
      totalShares: this.totalShares,
      depositorCount: this.positions.size,
      allocatedStrategy: this.strategies.find((s) => s.id === this.allocatedStrategyId) ?? null,
    };
  }

  /** Picks the highest-yield strategy whose risk score is within the caller's constraint. */
  selectStrategy(maxRiskScore: number): YieldStrategy {
    const eligible = this.strategies.filter((s) => s.riskScore <= maxRiskScore);
    if (eligible.length === 0) throw new Error(`no strategy available within risk score ${maxRiskScore}`);
    return eligible.reduce((best, s) => (s.aprBps > best.aprBps ? s : best));
  }

  /** Simulates one rebalance tick: accrue yield from the currently allocated strategy, then re-pick. */
  rebalance(maxRiskScore: number, elapsedSeconds: number): { strategy: YieldStrategy; accruedSats: number } {
    const strategy = this.selectStrategy(maxRiskScore);
    const accruedSats =
      this.allocatedStrategyId === null
        ? 0
        : this.totalAssetsSats * (strategy.aprBps / 10_000) * (elapsedSeconds / (365 * 24 * 3600));
    this.totalAssetsSats += accruedSats;
    this.allocatedStrategyId = strategy.id;
    return { strategy, accruedSats };
  }
}

export const DEFAULT_STRATEGIES: YieldStrategy[] = [
  { id: "conservative-lend", name: "Conservative BTC Lending", aprBps: 320, riskScore: 15 },
  { id: "balanced-lp", name: "Balanced Liquidity Provision", aprBps: 670, riskScore: 40 },
  { id: "aggressive-yield", name: "Aggressive Yield Farming", aprBps: 1140, riskScore: 75 },
];
