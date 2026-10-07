import test from "node:test";
import assert from "node:assert/strict";
import { AgentIdentity } from "./identity.js";
import { EventLog } from "./eventLog.js";
import { computeReputation } from "./reputation.js";
import { YieldVault, DEFAULT_STRATEGIES } from "./yield.js";
import { Budget } from "./budget.js";

test("AgentIdentity signs events that verify, and tampering breaks verification", () => {
  const agent = new AgentIdentity("Tester");
  const event = agent.sign({ kind: 1, content: "hello", tags: [], created_at: Math.floor(Date.now() / 1000) });
  assert.equal(AgentIdentity.verify(event), true);
  // Rebuild a plain object (no nostr-tools verified-cache symbol) with a forged signature — must not verify.
  const forged = {
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags,
    content: event.content,
    sig: event.sig.replace(/^.{4}/, "dead"),
  };
  assert.equal(AgentIdentity.verify(forged), false);
});

test("reputation is derived from the signed event log", () => {
  const log = new EventLog();
  const agent = new AgentIdentity("Worker");
  const now = Math.floor(Date.now() / 1000);
  const sign = (content: unknown) => agent.sign({ kind: 1, content: JSON.stringify(content), tags: [], created_at: now });

  log.append(sign({ amountSats: 200 }), "payment_sent");
  log.append(sign({ service: "/x" }), "job_completed");
  log.append(sign({ service: "/y" }), "job_completed");

  const rep = computeReputation(log, agent.pubkey);
  assert.equal(rep.completedJobs, 2);
  assert.equal(rep.paymentsSent, 1);
  assert.equal(rep.totalSatsSent, 200);
  assert.equal(rep.score, 2 * 2 + 3 * 15); // 2 jobs + default rating (3) * 15
});

test("YieldVault: deposits mint shares 1:1 until yield accrues, then balance grows", () => {
  const vault = new YieldVault(DEFAULT_STRATEGIES);
  const shares = vault.deposit("alice", 500_000);
  assert.equal(shares, 500_000);
  assert.equal(vault.balanceOf("alice"), 500_000);

  vault.rebalance(40, 0); // allocate a strategy, no time elapsed
  const { accruedSats } = vault.rebalance(40, 365 * 24 * 3600); // one full year
  assert.ok(accruedSats > 0, "a year of the 6.70% strategy should accrue yield");
  assert.ok(vault.balanceOf("alice") > 500_000, "alice's balance reflects accrued yield via share price");
});

test("YieldVault: strategy selection respects the risk cap; overdraw is rejected", () => {
  const vault = new YieldVault(DEFAULT_STRATEGIES);
  assert.equal(vault.selectStrategy(40).id, "balanced-lp"); // highest APR within risk <= 40
  assert.equal(vault.selectStrategy(100).id, "aggressive-yield");
  assert.throws(() => vault.selectStrategy(10), /no strategy available/);

  vault.deposit("bob", 1000);
  assert.throws(() => vault.withdraw("bob", 5000), /insufficient shares/);
});

test("Budget enforces per-request cap, total cap, and service allowlist", () => {
  const b = new Budget(300, 200, new Set(["GET /a"]));
  assert.throws(() => b.authorize(250, "GET /a"), /per-request cap/);
  assert.throws(() => b.authorize(100, "GET /b"), /allowed-services/);
  b.authorize(200, "GET /a");
  b.record(200);
  assert.equal(b.remainingSats, 100);
  assert.throws(() => b.authorize(150, "GET /a"), /remaining budget/);
});

test("TachiTx: signature covers sigHash, which ignores witness-only input fields", async () => {
  const { schnorr } = await import("@noble/curves/secp256k1.js");
  const { signTx, sigHash, encodeTx, encodeDepositProof, TX_TRANSFER } = await import("./payment/tachiTx.js");
  const sk = new Uint8Array(32).fill(3);
  const input = { vtxoId: new Uint8Array(32).fill(7), txid: new Uint8Array(32), vout: 0, valueSats: 1000n, sigScript: new Uint8Array() };
  const tx = signTx({
    version: 1, type: TX_TRANSFER, inputs: [input], outputs: [{ owner: schnorr.getPublicKey(sk), amount: 990n, script: new Uint8Array() }],
    fee: 10n, nonce: 0n, pubKey: new Uint8Array(), signature: new Uint8Array(), psbtPayload: new Uint8Array(), depositProof: new Uint8Array(),
  }, sk);
  assert.ok(schnorr.verify(tx.signature, sigHash(tx), tx.pubKey));
  // Daemon SigHash keeps only vtxoId per input — changing valueSats must not invalidate the signature.
  assert.deepEqual(sigHash({ ...tx, inputs: [{ ...input, valueSats: 5n }] }), sigHash(tx));
  // 1+1+2 + (32+32+4+8+2) + 2 + (2+32+8+2) + 8+8 + (2+32) + (2+64) + 4 = 248, as the live daemon reports.
  assert.equal(encodeTx(tx).length, 248);
  const proof = encodeDepositProof("00".repeat(31) + "ff", 1, 2, 3);
  assert.equal(proof.length, 44);
  assert.equal(proof[0], 0xff, "txid is stored in internal (reversed) byte order");
});

test("x402 claims: only the payer's key can claim a payment, and only for the signed resource", async () => {
  const { signClaim, verifyClaim } = await import("./x402.js");
  const payer = new AgentIdentity("Payer");
  const stranger = new AgentIdentity("Stranger");
  const txRef = "ab".repeat(32);
  const resource = "GET /services/btc-data/x";
  const signature = signClaim(payer.secretKeyBytes(), txRef, resource);
  assert.equal(verifyClaim({ txRef, payer: payer.pubkey, resource, signature }), true);
  assert.equal(verifyClaim({ txRef, payer: payer.pubkey, resource: "GET /other", signature }), false, "bound to its resource");
  const forged = signClaim(stranger.secretKeyBytes(), txRef, resource);
  assert.equal(verifyClaim({ txRef, payer: payer.pubkey, resource, signature: forged }), false, "a stranger can't claim it");
});

test("sealed delivery: only the buyer's key opens it", async () => {
  const { sealFor, openDelivery } = await import("./delivery.js");
  const buyer = new AgentIdentity("Buyer");
  const sealed = sealFor(buyer.pubkey, "hour,fee\n0,4.2");
  assert.ok(!sealed.ciphertext.includes("fee"));
  assert.equal(openDelivery(sealed, buyer.secretKeyBytes()), "hour,fee\n0,4.2");
  assert.throws(() => openDelivery(sealed, new AgentIdentity("Other").secretKeyBytes()));
});

test("audit hash chain: any change to the history changes the root", async () => {
  const { logChainRoot } = await import("./auditChain.js");
  const ids = ["01", "02", "03"].map((b) => b.repeat(32));
  const root = logChainRoot(ids);
  assert.equal(logChainRoot(ids), root, "deterministic");
  assert.notEqual(logChainRoot([ids[1], ids[0], ids[2]]), root, "reordering");
  assert.notEqual(logChainRoot(ids.slice(0, 2)), root, "dropping");
});

test("reputation counts ratings others gave the agent, not ones it gave", () => {
  const log = new EventLog();
  const seller = new AgentIdentity("Seller");
  const buyer = new AgentIdentity("Buyer");
  const now = Math.floor(Date.now() / 1000);
  log.append(buyer.sign({ kind: 1, content: JSON.stringify({ target: seller.pubkey, stars: 5 }), tags: [], created_at: now }), "rating");
  assert.equal(computeReputation(log, seller.pubkey).avgRating, 5);
  assert.equal(computeReputation(log, buyer.pubkey).avgRating, null);
});

test("anchorKey: a valid x-only key that commits to the root", async () => {
  const { anchorKey } = await import("./auditChain.js");
  const { schnorr } = await import("@noble/curves/secp256k1.js");
  const payer = new AgentIdentity("Payer").pubkey;
  const k = anchorKey(payer, "aa".repeat(32));
  assert.match(k, /^[0-9a-f]{64}$/);
  assert.doesNotThrow(() => schnorr.utils.lift_x(BigInt("0x" + k)), "on the curve");
  assert.notEqual(anchorKey(payer, "bb".repeat(32)), k, "a different root gives a different key");
});
