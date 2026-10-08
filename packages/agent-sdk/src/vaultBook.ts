import { YieldVault } from "./yield.js";

/**
 * One line of the vault's public ledger. Every entry except `default` carries the Tachi txRef that
 * moved the sats, so anyone can check the books against the chain.
 */
export type VaultEntry =
  | { type: "deposit"; pubkey: string; amountSats: number; txRef: string; at: number }
  | { type: "withdraw"; pubkey: string; amountSats: number; txRef: string; at: number; requestId?: string }
  /** A depositor underwrites `borrower` up to amountSats: its own shares take any loss first. */
  | { type: "vouch"; pubkey: string; borrower: string; amountSats: number; at: number; requestId?: string }
  | { type: "borrow"; pubkey: string; sponsor: string; amountSats: number; feeSats: number; dueAt: number; txRef: string; at: number; requestId?: string }
  | { type: "repay"; pubkey: string; amountSats: number; txRef: string; at: number }
  /** A loan past due: what's still unpaid is written off, from the sponsor's shares first. amountSats = the loss. */
  | { type: "default"; pubkey: string; amountSats: number; at: number };

export interface Loan {
  sponsor: string;
  principal: number;
  feeSats: number;
  dueAt: number;
  repaid: number;
  txRef: string;
}

/** Share of what depositors are owed that may be lent out; the rest stays liquid for withdrawals. */
export const MAX_UTILIZATION = 0.8;

/**
 * The loan fee from an agent's reputation score (0-100): 1% at 100, 3% at 0. Reputation is built
 * from events the agent signs itself, so it only prices a loan; it never unlocks credit. Credit
 * comes from a sponsor's vouch, backed by the sponsor's own shares.
 */
export function feeBpsFor(score: number): number {
  return Math.round(100 + (100 - Math.max(0, Math.min(100, score))) * 2);
}

/**
 * The vault's books, rebuilt by replaying its ledger. Deposits mint shares; loans move sats from
 * reserves to receivables without changing what depositors are owed; a repaid loan's fee raises the
 * share price (that's the yield). Only an agent a depositor vouched for can borrow, and a default is
 * taken from that sponsor's shares first, so no one can borrow against the vault with fresh keys.
 */
export class VaultBook {
  readonly vault = new YieldVault();
  readonly loans = new Map<string, Loan>();
  readonly vouches = new Map<string, { sponsor: string; limitSats: number }>(); // borrower -> vouch
  readonly usedRequests = new Set<string>();
  readonly creditedTxRefs = new Set<string>();
  readonly entries: VaultEntry[] = [];
  realizedYieldSats = 0;
  writtenOffSats = 0;
  /** The part of writtenOffSats taken from sponsors' shares rather than all depositors. */
  sponsorCoveredSats = 0;

  constructor(entries: VaultEntry[] = []) {
    entries.forEach((e) => this.apply(e));
  }

  /** Applies one entry; throws (leaving the books unchanged) if it isn't valid in the current state. */
  apply(e: VaultEntry): void {
    if ("requestId" in e && e.requestId && this.usedRequests.has(e.requestId)) throw new Error("This request was already used");
    if ((e.type === "deposit" || e.type === "repay") && this.creditedTxRefs.has(e.txRef)) throw new Error("This transaction was already credited");
    switch (e.type) {
      case "deposit":
        this.vault.deposit(e.pubkey, e.amountSats);
        this.creditedTxRefs.add(e.txRef);
        break;
      case "withdraw":
        if (e.amountSats > this.freeBalance(e.pubkey) + 1e-6) throw new Error(`Only ${Math.floor(this.freeBalance(e.pubkey))} sats are free; the rest covers loans this depositor vouched for`);
        this.vault.withdraw(e.pubkey, e.amountSats);
        break;
      case "vouch":
        if (e.amountSats <= 0) throw new Error("amountSats must be positive");
        if (this.vault.balanceOf(e.pubkey) <= 0) throw new Error("Only a depositor can vouch for an agent");
        this.vouches.set(e.borrower, { sponsor: e.pubkey, limitSats: e.amountSats });
        break;
      case "borrow": {
        if (this.loans.has(e.pubkey)) throw new Error("This agent already has an open loan");
        if (e.amountSats <= 0) throw new Error("amountSats must be positive");
        const vouch = this.vouches.get(e.pubkey);
        if (!vouch || vouch.sponsor !== e.sponsor) throw new Error("No depositor has vouched for this agent");
        if (e.amountSats > vouch.limitSats) throw new Error(`The sponsor vouched for up to ${vouch.limitSats} sats`);
        if (e.amountSats > this.freeBalance(e.sponsor)) throw new Error("The sponsor's free balance doesn't cover this loan");
        this.loans.set(e.pubkey, { sponsor: e.sponsor, principal: e.amountSats, feeSats: e.feeSats, dueAt: e.dueAt, repaid: 0, txRef: e.txRef });
        break;
      }
      case "repay": {
        const loan = this.loans.get(e.pubkey);
        if (!loan) throw new Error("This agent has no open loan");
        loan.repaid += e.amountSats;
        this.creditedTxRefs.add(e.txRef);
        if (loan.repaid >= loan.principal + loan.feeSats) this.close(e.pubkey, loan);
        break;
      }
      case "default": {
        const loan = this.loans.get(e.pubkey);
        if (!loan) throw new Error("This agent has no open loan");
        this.close(e.pubkey, loan);
        break;
      }
    }
    if ("requestId" in e && e.requestId) this.usedRequests.add(e.requestId);
    this.entries.push(e);
  }

  /** Reverses the last entry, for a withdraw/borrow whose on-chain payout failed. */
  undoLast(): void {
    const e = this.entries.pop();
    if (e?.type === "withdraw") this.vault.deposit(e.pubkey, e.amountSats);
    else if (e?.type === "borrow") this.loans.delete(e.pubkey);
    else throw new Error("Only a withdraw or borrow can be undone");
    if (e.requestId) this.usedRequests.delete(e.requestId);
  }

  private close(pubkey: string, loan: Loan) {
    this.loans.delete(pubkey); // first, so the sponsor's shares are no longer locked
    const delta = loan.repaid - loan.principal; // fee earned, or unpaid principal lost
    if (delta >= 0) {
      this.vault.realize(delta);
      this.realizedYieldSats += delta;
      return;
    }
    // Loss: burn the sponsor's shares first, then share whatever is left across all depositors.
    const loss = -delta;
    const covered = Math.min(loss, this.vault.balanceOf(loan.sponsor));
    if (covered > 0) this.vault.withdraw(loan.sponsor, covered);
    if (loss > covered) this.vault.realize(-(loss - covered));
    this.writtenOffSats += loss;
    this.sponsorCoveredSats += covered;
  }

  /** What a depositor has vouched for and is still out: locked as first-loss cover. */
  lockedFor(sponsor: string): number {
    return [...this.loans.values()].filter((l) => l.sponsor === sponsor).reduce((s, l) => s + Math.max(0, l.principal - l.repaid), 0);
  }

  freeBalance(pubkey: string): number {
    return this.vault.balanceOf(pubkey) - this.lockedFor(pubkey);
  }

  /** Writes off every loan past its due date. Returns the default entries it applied. */
  sweepDefaults(now: number): VaultEntry[] {
    const due = [...this.loans].filter(([, l]) => l.dueAt <= now);
    return due.map(([pubkey, l]) => {
      const e: VaultEntry = { type: "default", pubkey, amountSats: Math.max(0, l.principal - l.repaid), at: now };
      this.apply(e);
      return e;
    });
  }

  /** What depositors are owed in total: reserves on chain plus loans outstanding. */
  owedSats(): number {
    return this.vault.summary().totalAssetsSats;
  }

  outstandingSats(): number {
    return [...this.loans.values()].reduce((s, l) => s + Math.max(0, l.principal - l.repaid), 0);
  }

  /** Throws unless lending `amountSats` more keeps the vault within its utilization cap. */
  checkUtilization(amountSats: number): void {
    const room = Math.floor(this.owedSats() * MAX_UTILIZATION) - this.outstandingSats();
    if (amountSats > room) throw new Error(`The vault can lend at most ${Math.max(0, room)} more sats (${MAX_UTILIZATION * 100}% utilization cap)`);
  }
}
