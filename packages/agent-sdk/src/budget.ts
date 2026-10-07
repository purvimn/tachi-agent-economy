/** Per-agent spending policy — enforced before any PaymentProvider is called. */
export class Budget {
  private spentSats = 0;

  constructor(
    readonly totalSats: number,
    readonly maxPerRequestSats: number,
    readonly allowedServices?: Set<string>
  ) {}

  get remainingSats(): number {
    return this.totalSats - this.spentSats;
  }

  /** Throws if the request violates policy; call before paying, never after. */
  authorize(amountSats: number, service?: string): void {
    if (amountSats > this.maxPerRequestSats) {
      throw new Error(`Payment of ${amountSats} sats exceeds per-request cap of ${this.maxPerRequestSats}`);
    }
    if (amountSats > this.remainingSats) {
      throw new Error(`Payment of ${amountSats} sats exceeds remaining budget of ${this.remainingSats}`);
    }
    if (service && this.allowedServices && !this.allowedServices.has(service)) {
      throw new Error(`Service "${service}" is not in this agent's allowed-services list`);
    }
  }

  record(amountSats: number): void {
    this.spentSats += amountSats;
  }
}
