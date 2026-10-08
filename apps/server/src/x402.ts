import type { Request, Response, NextFunction } from "express";
import {
  X402_VERSION,
  PAYMENT_HEADER,
  PAYMENT_RESPONSE_HEADER,
  decodeHeader,
  encodePaymentResponse,
  verifyClaim,
  type PaymentPayload,
  type PaymentRequirements,
  type PaymentResult,
} from "@tachi-hack/agent-sdk";
import { settledPayments, claimedTxRefs, paymentHistory } from "./world.js";
import { tachi, network } from "./routes/daemon.js";

/** Older simulated-only header (`x-tachi-payment: <sim txRef>`), still used by demo/run.ts. */
const LEGACY_HEADER = "x-tachi-payment";

type PriceResolver = (req: Request) => { priceSats: number; payToPubkey: string } | null;

function requirements(resource: string, priceSats: number, payTo: string): PaymentRequirements[] {
  const base = { maxAmountRequired: String(priceSats), resource, description: resource, mimeType: "application/json", payTo, maxTimeoutSeconds: 120, asset: "sats" as const };
  return [
    {
      ...base,
      scheme: "exact",
      network: `tachi-${network.name}`,
      extra: { settlement: "Signed Tachi VTXO TRANSFER to payTo; X-PAYMENT payload { txRef, payer, resource, signature }" },
    },
    { ...base, scheme: "simulated", network: "simulated", extra: { howToPay: "POST /pay { fromPubkey, toPubkey, amountSats, resource }" } },
  ];
}

/** Looks the transfer up on Tachi: committed, signed by the payer, paying `payTo` at least `priceSats`. */
export async function verifyOnChain(p: PaymentPayload["payload"], payTo: string, priceSats: number): Promise<PaymentResult> {
  const tx = await tachi.getTransaction(p.txRef);
  if (tx.state !== "committed") throw new Error(`the transaction is ${tx.state}, not committed`);
  if (tx.type !== "transfer") throw new Error(`the transaction is a ${tx.type}, not a transfer`);
  const decoded = await tachi.decodeTransaction(tx.hex);
  if (decoded.pubkey !== p.payer) throw new Error("the transaction was not signed by the payer");
  const paid = decoded.vout.filter((o) => o.owner === payTo).reduce((s, o) => s + o.amount, 0);
  if (paid < priceSats) throw new Error(`it pays ${paid} sats to the payee; ${priceSats} are required`);
  return { txRef: p.txRef, amountSats: paid, fromPubkey: p.payer, toPubkey: payTo, settledAt: tx.time, mode: network.name, resource: p.resource };
}

/**
 * x402 middleware (x402Version 1). Without a payment: 402 with `accepts` — a Tachi "exact" option
 * and a simulated one. With `X-PAYMENT`: verifies the claim and serves, adding `X-PAYMENT-RESPONSE`.
 * Price/payee are resolved per request (null -> 404). Sets res.locals.payer and res.locals.txRef.
 */
export function requirePayment(resolve: PriceResolver) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const resolved = resolve(req);
    if (!resolved) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const { priceSats, payToPubkey: payTo } = resolved;
    // Canonical id for this exact endpoint; every proof is bound to it.
    const resource = `${req.method} ${req.baseUrl}${req.path}`;
    const reject = (error: string, extra: Record<string, unknown> = {}) =>
      // Top-level priceSats/payTo/resource are a convenience for simple clients; `accepts` is the spec.
      res.status(402).json({ x402Version: X402_VERSION, error, accepts: requirements(resource, priceSats, payTo), priceSats, payTo, resource, ...extra });

    const header = req.header(PAYMENT_HEADER);
    const legacy = req.header(LEGACY_HEADER);
    if (!header && !legacy) return reject("Payment Required");

    let p: PaymentPayload;
    try {
      p = legacy
        ? { x402Version: X402_VERSION, scheme: "simulated", network: "simulated", payload: { txRef: legacy, payer: "", resource } }
        : decodeHeader<PaymentPayload>(header!);
    } catch {
      return reject("The X-PAYMENT header is not valid base64 JSON");
    }
    if (p.payload?.resource !== resource) return reject("This payment is bound to a different resource", { boundTo: p.payload?.resource ?? null });

    if (p.scheme === "simulated") {
      const payment = settledPayments.get(p.payload.txRef);
      if (!payment) return reject("Unknown payment reference");
      if (payment.toPubkey !== payTo || payment.amountSats < priceSats) return reject("Payment does not cover this request", { required: priceSats, got: payment.amountSats });
      if (payment.resource !== resource) return reject("This payment is bound to a different resource", { boundTo: payment.resource ?? null });
      settledPayments.delete(p.payload.txRef); // single use
      res.locals.payer = payment.fromPubkey;
      res.locals.txRef = p.payload.txRef;
      res.setHeader(PAYMENT_RESPONSE_HEADER, encodePaymentResponse({ success: true, transaction: p.payload.txRef, network: "simulated", payer: payment.fromPubkey }));
      return next();
    }

    if (p.scheme !== "exact" || p.network !== `tachi-${network.name}`) return reject(`Unsupported payment: ${p.scheme} on ${p.network}`);
    // Only the payer can claim: a txRef seen on the explorer is useless without the payer's key.
    if (!verifyClaim(p.payload)) return reject("The payment claim isn't signed by the payer");
    const ref = p.payload.txRef.toLowerCase();
    if (claimedTxRefs.has(ref)) return reject("This payment was already used");
    claimedTxRefs.add(ref); // before the async check, so two concurrent claims can't both pass
    try {
      const result = await verifyOnChain({ ...p.payload, txRef: ref }, payTo, priceSats);
      paymentHistory.push(result);
      res.locals.payer = p.payload.payer;
      res.locals.txRef = ref;
      res.setHeader(PAYMENT_RESPONSE_HEADER, encodePaymentResponse({ success: true, transaction: ref, network: p.network, payer: p.payload.payer }));
      next();
    } catch (err) {
      claimedTxRefs.delete(ref); // e.g. not committed yet: the payer may retry
      reject(`The payment couldn't be verified: ${(err as Error).message}`);
    }
  };
}
