import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import type { Budget } from "./budget.js";
import type { TachiPaymentProvider } from "./payment/tachiProvider.js";

/**
 * x402 on Tachi. Message shapes follow the x402 spec (x402Version 1): a 402 body lists `accepts`
 * requirements; the client pays and retries with an `X-PAYMENT` header; the server answers with
 * `X-PAYMENT-RESPONSE`. Scheme "exact" on network "tachi-<regtest|signet>", asset "sats".
 *
 * The payment payload is a committed Tachi TRANSFER (txRef) plus the payer's BIP-340 signature over
 * (txRef, resource). The signature proves the claimant is the payer, so a txRef seen on the
 * explorer can't be claimed by someone else, and it binds the payment to one resource.
 */
export const X402_VERSION = 1;
export const PAYMENT_HEADER = "x-payment";
export const PAYMENT_RESPONSE_HEADER = "x-payment-response";

export interface PaymentRequirements {
  scheme: "exact" | "simulated";
  network: string;
  maxAmountRequired: string; // sats, as a string per the spec
  resource: string;
  description: string;
  mimeType: string;
  payTo: string; // x-only pubkey (Nostr npub hex) of the payee
  maxTimeoutSeconds: number;
  asset: "sats";
  extra?: Record<string, unknown>;
}
export interface PaymentChallenge {
  x402Version: number;
  error: string;
  accepts: PaymentRequirements[];
}
export interface PaymentPayload {
  x402Version: number;
  scheme: PaymentRequirements["scheme"];
  network: string;
  payload: { txRef: string; payer: string; resource: string; signature?: string };
}
export interface PaymentResponse {
  success: boolean;
  transaction: string;
  network: string;
  payer: string;
}

const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");
export const encodePaymentHeader = (p: PaymentPayload) => encode(p);
export const encodePaymentResponse = (r: PaymentResponse) => encode(r);
export function decodeHeader<T>(value: string): T {
  return JSON.parse(Buffer.from(value, "base64").toString("utf8")) as T;
}

const claimDigest = (txRef: string, resource: string) => createHash("sha256").update(`x402-tachi:${txRef}:${resource}`).digest();

export function signClaim(secretKey: Uint8Array, txRef: string, resource: string): string {
  return Buffer.from(schnorr.sign(claimDigest(txRef, resource), secretKey)).toString("hex");
}

export function verifyClaim(p: PaymentPayload["payload"]): boolean {
  if (!p.signature) return false;
  try {
    return schnorr.verify(Buffer.from(p.signature, "hex"), claimDigest(p.txRef, p.resource), Buffer.from(p.payer, "hex"));
  } catch {
    return false;
  }
}

export interface X402FetchOptions {
  wallet: TachiPaymentProvider;
  /** Spending policy checked before any sats move. */
  budget?: Budget;
  onStep?: (msg: string) => void;
}

/**
 * fetch() that pays for itself: on a 402 it picks the Tachi requirement, checks the budget, pays
 * with a signed VTXO transfer, and retries with X-PAYMENT. Returns the response and what was paid.
 */
export async function x402Fetch(url: string, init: RequestInit = {}, opts: X402FetchOptions) {
  const first = await fetch(url, init);
  if (first.status !== 402) return { response: first, payment: null };

  const challenge = (await first.json()) as PaymentChallenge;
  const req = challenge.accepts.find((a) => a.scheme === "exact" && a.network === `tachi-${opts.wallet.network}`);
  if (!req) throw new Error(`No Tachi ${opts.wallet.network} payment option in the 402 (offered: ${challenge.accepts.map((a) => a.network).join(", ")})`);
  const amountSats = Number(req.maxAmountRequired);

  opts.budget?.authorize(amountSats, req.resource);
  opts.onStep?.(`Paying ${amountSats} sats on Tachi ${opts.wallet.network}`);
  const paid = await opts.wallet.pay({ toPubkey: req.payTo, amountSats, resource: req.resource });
  opts.budget?.record(amountSats);

  const header = encodePaymentHeader({
    x402Version: X402_VERSION,
    scheme: "exact",
    network: req.network,
    payload: { txRef: paid.txRef, payer: opts.wallet.pubkey, resource: req.resource, signature: opts.wallet.signClaim(paid.txRef, req.resource) },
  });
  opts.onStep?.("Server is verifying the payment on chain");
  const headers = new Headers(init.headers);
  headers.set(PAYMENT_HEADER, header);
  const response = await fetch(url, { ...init, headers });
  const receipt = response.headers.get(PAYMENT_RESPONSE_HEADER);
  return { response, payment: { ...paid, requirements: req, receipt: receipt ? decodeHeader<PaymentResponse>(receipt) : null } };
}
