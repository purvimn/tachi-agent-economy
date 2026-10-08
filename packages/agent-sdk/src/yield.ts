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
  sharePrice(): number {
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
    if (amountSats <= 0) throw new Error("amountSats must be positive");
    const owned = this.positions.get(pubkey) ?? 0;
    // Float share math: withdrawing a whole balance can come out a hair above `owned`.
    const shares = Math.min(amountSats / this.sharePrice(), owned);
    if (amountSats > this.balanceOf(pubkey) + 1e-6) throw new Error("insufficient shares");
    this.positions.set(pubkey, owned - shares);
    this.totalShares -= shares;
    this.totalAssetsSats -= amountSats;
  }

  balanceOf(pubkey: string): number {
    return (this.positions.get(pubkey) ?? 0) * this.sharePrice();
  }

  summary(): { totalAssetsSats: number; totalShares: number; depositorCount: number } {
    return {
      totalAssetsSats: this.totalAssetsSats,
      totalShares: this.totalShares,
      depositorCount: [...this.positions.values()].filter((s) => s > 1e-9).length,
    };
  }

  /** Realized gain (fees earned) or loss (a write-off): moves every depositor's balance via the share price. */
  realize(deltaSats: number): void {
    if (this.totalShares === 0) throw new Error("no depositors to credit");
    this.totalAssetsSats += deltaSats;
  }
}
