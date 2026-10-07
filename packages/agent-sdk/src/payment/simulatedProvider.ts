import { randomUUID } from "node:crypto";
import type { PaymentProvider, PaymentResult } from "./types.js";

/**
 * ponytail: simulates instant settlement instead of a real cooperative-quorum vault spend.
 * Ceiling: no real sats move, txRef is not chain-verifiable. Real path: TachiPaymentProvider.
 */
export class SimulatedPaymentProvider implements PaymentProvider {
  async pay(params: { fromPubkey?: string; toPubkey: string; amountSats: number; resource?: string }): Promise<PaymentResult> {
    if (params.amountSats <= 0) throw new Error("amountSats must be positive");
    return {
      txRef: `sim_${randomUUID()}`,
      amountSats: params.amountSats,
      fromPubkey: params.fromPubkey ?? "",
      toPubkey: params.toPubkey,
      settledAt: Math.floor(Date.now() / 1000),
      mode: "simulated",
      resource: params.resource,
    };
  }
}
