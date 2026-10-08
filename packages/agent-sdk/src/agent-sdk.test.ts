import test from "node:test";
import assert from "node:assert/strict";
import { AgentIdentity } from "./identity.js";
import { EventLog } from "./eventLog.js";
import { computeReputation } from "./reputation.js";
import { Budget } from "./budget.js";
import { VaultBook, feeBpsFor } from "./vaultBook.js";
import { YieldVault } from "./yield.js";

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

test("YieldVault: overdraw is rejected", () => {
  const vault = new YieldVault();
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

test("VaultBook: a repaid loan's fee is depositors' yield; the ledger replays to the same books", () => {
  const t = (n: number) => n.toString(16).padStart(64, "0");
  const book = new VaultBook();
  book.apply({ type: "deposit", pubkey: "alice", amountSats: 6_000, txRef: t(1), at: 1 });
  book.apply({ type: "deposit", pubkey: "bob", amountSats: 4_000, txRef: t(2), at: 1 });
  assert.throws(() => book.apply({ type: "deposit", pubkey: "bob", amountSats: 4_000, txRef: t(2), at: 1 }), /already credited/);

  // Lending moves sats to a receivable: what depositors are owed doesn't change.
  book.apply({ type: "vouch", pubkey: "alice", borrower: "agent", amountSats: 3_000, at: 2, requestId: "v1" });
  book.apply({ type: "borrow", pubkey: "agent", sponsor: "alice", amountSats: 2_000, feeSats: 100, dueAt: 100, txRef: t(3), at: 2, requestId: "r1" });
  assert.equal(book.owedSats(), 10_000);
  assert.equal(book.outstandingSats(), 2_000);
  assert.throws(() => book.checkUtilization(6_001), /utilization cap/); // 80% of 10,000 minus 2,000 out
  book.checkUtilization(6_000);
  // The sponsor's cover is locked while the loan is open.
  assert.throws(() => book.apply({ type: "withdraw", pubkey: "alice", amountSats: 4_001, txRef: t(9), at: 2 }), /free/);

  // Partial repayment keeps the loan open; the full amount closes it and the fee becomes yield.
  book.apply({ type: "repay", pubkey: "agent", amountSats: 1_000, txRef: t(4), at: 3 });
  assert.equal(book.realizedYieldSats, 0);
  book.apply({ type: "repay", pubkey: "agent", amountSats: 1_100, txRef: t(5), at: 4 });
  assert.equal(book.loans.size, 0);
  assert.equal(book.realizedYieldSats, 100);
  assert.equal(Math.round(book.vault.balanceOf("alice")), 6_060); // yield split pro rata by shares
  assert.equal(Math.round(book.vault.balanceOf("bob")), 4_040);

  // Withdrawing a whole balance works despite float share math; a request id pays once.
  book.apply({ type: "withdraw", pubkey: "bob", amountSats: Math.floor(book.vault.balanceOf("bob")), txRef: t(8), at: 11, requestId: "r3" });
  assert.throws(() => book.apply({ type: "withdraw", pubkey: "bob", amountSats: 1, txRef: t(10), at: 12, requestId: "r3" }), /already used/);
  const replayed = new VaultBook(book.entries.map((e) => ({ ...e })));
  assert.equal(replayed.owedSats(), book.owedSats());
  assert.equal(replayed.vault.balanceOf("alice"), book.vault.balanceOf("alice"));
  assert.equal(replayed.realizedYieldSats, 100);
});

test("VaultBook: fresh keys can't borrow; a default is taken from the sponsor's shares first", () => {
  const t = (n: number) => n.toString(16).padStart(64, "0");
  const book = new VaultBook();
  book.apply({ type: "deposit", pubkey: "alice", amountSats: 6_000, txRef: t(1), at: 1 });
  book.apply({ type: "deposit", pubkey: "bob", amountSats: 4_000, txRef: t(2), at: 1 });
  const borrow = (pubkey: string, sponsor: string, amountSats: number, n: number) =>
    book.apply({ type: "borrow", pubkey, sponsor, amountSats, feeSats: 10, dueAt: 10, txRef: t(n), at: 2 });

  assert.throws(() => borrow("sybil", "alice", 100, 3), /No depositor has vouched/);
  assert.throws(() => book.apply({ type: "vouch", pubkey: "sybil", borrower: "sybil2", amountSats: 100, at: 2 }), /Only a depositor/);
  book.apply({ type: "vouch", pubkey: "bob", borrower: "agent", amountSats: 1_000, at: 2 });
  assert.throws(() => borrow("agent", "alice", 500, 4), /No depositor has vouched/); // wrong sponsor named
  assert.throws(() => borrow("agent", "bob", 1_001, 5), /up to 1000/);

  // Bob vouched for 1,000; the agent borrows 1,000, repays 300, and defaults: bob loses 700, alice nothing.
  borrow("agent", "bob", 1_000, 6);
  book.apply({ type: "repay", pubkey: "agent", amountSats: 300, txRef: t(7), at: 3 });
  assert.equal(book.sweepDefaults(9).length, 0);
  assert.equal(book.sweepDefaults(10).length, 1);
  assert.equal(book.writtenOffSats, 700);
  assert.equal(book.sponsorCoveredSats, 700);
  assert.equal(Math.round(book.vault.balanceOf("alice")), 6_000);
  assert.equal(Math.round(book.vault.balanceOf("bob")), 3_300);
  assert.equal(Math.round(book.owedSats()), 9_300);
});

test("feeBpsFor: better reputation, cheaper credit (but never more of it)", () => {
  assert.equal(feeBpsFor(45), 210);
  assert.equal(feeBpsFor(100), 100);
  assert.equal(feeBpsFor(-5), 300);
});
