import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";

/**
 * Hash chain over event ids in append order: h0 = 32 zero bytes, h(i+1) = sha256(h(i) || id(i)).
 * Anchoring the root on Tachi pins the whole history up to that point: changing, dropping or
 * reordering any earlier event changes the root.
 */
export function logChainRoot(eventIds: string[]): string {
  let h = Buffer.alloc(32);
  for (const id of eventIds) h = createHash("sha256").update(h).update(Buffer.from(id, "hex")).digest();
  return h.toString("hex");
}

/**
 * The key an anchor pays to: pay-to-contract on the payer's key, P + H(P || root)·G. Always a valid
 * x-only key (unlike the raw root), and anyone with the payer's pubkey and the root can recompute it.
 */
export function anchorKey(payerXOnlyHex: string, rootHex: string): string {
  const P = schnorr.utils.lift_x(BigInt("0x" + payerXOnlyHex));
  const t = BigInt("0x" + Buffer.from(schnorr.utils.taggedHash("TachiAgentEconomy/anchor", Buffer.from(payerXOnlyHex, "hex"), Buffer.from(rootHex, "hex"))).toString("hex"));
  return Buffer.from(P.add(schnorr.Point.BASE.multiply(t)).toBytes(true).slice(1)).toString("hex");
}
