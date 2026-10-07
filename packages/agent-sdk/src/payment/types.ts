/** Result of a completed payment settlement, real or simulated. */
export interface PaymentResult {
  txRef: string;
  amountSats: number;
  fromPubkey: string;
  toPubkey: string;
  settledAt: number;
  /** "simulated" = in-process; otherwise the Tachi network the TRANSFER committed on (txRef is its hash). */
  mode: "simulated" | "regtest" | "signet";
  proof?: string;
  /** The resource this proof is bound to (e.g. "GET /datasets/<id>/purchase"). Prevents replaying one payment across endpoints. */
  resource?: string;
}

/**
 * Abstraction over how sats actually move: SimulatedPaymentProvider (in-process, no funds needed)
 * or TachiPaymentProvider (agent-signed VTXO transfer, committed by the Tachi validator quorum).
 */
export interface PaymentProvider {
  pay(params: { fromPubkey?: string; toPubkey: string; amountSats: number; resource?: string }): Promise<PaymentResult>;
}
