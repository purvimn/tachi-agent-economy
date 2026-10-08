import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router, type Response } from "express";
import { AgentIdentity, TachiPaymentProvider, VaultBook, feeBpsFor, MAX_UTILIZATION, type VaultEntry } from "@tachi-hack/agent-sdk";
import type { Event } from "nostr-tools";
import { network } from "./daemon.js";
import { directory } from "../world.js";
import { verifyOnChain } from "../x402.js";

/**
 * The real BTC vault: every sat it owes is either in the vault's own Tachi key or lent to an agent.
 * - Deposit: a committed Tachi TRANSFER to the vault key, verified on chain before shares are minted.
 * - Withdraw / borrow: a Nostr event signed by the agent; the vault pays out with its own TRANSFER.
 * - Vouch: a depositor signs that it underwrites an agent up to an amount. Only vouched agents can
 *   borrow, and the sponsor's shares take any default first (reputation is self-signed, so it only
 *   sets the fee; it can't unlock credit).
 * - Repay: a TRANSFER back to the vault key. The loan fee raises the share price: that's the yield,
 *   and every sat of it is a committed transfer from an agent that earned it over x402.
 * The ledger is saved per network and replayed on start (VaultBook), so restarts keep positions.
 *
 * ponytail: the server holds the vault key (derived from the treasury key). Upgrade path for real
 * self-custody: a TAURUS vault / timelocked exit, with the ledger as the claim record.
 */
export const vaultRouter = Router();

const NETWORK_FEE_SATS = 10; // TachiPaymentProvider's default fee, taken out of each payout
const MAX_REQUEST_AGE_S = 120;
export const LOAN_TERM_S = 3600;

const LEDGER_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), `../../../../data/vault-${network.name}.json`);
const book = new VaultBook(existsSync(LEDGER_FILE) ? (JSON.parse(readFileSync(LEDGER_FILE, "utf8")) as VaultEntry[]) : []);
// ponytail: whole-file rewrite on every entry; fine for a demo-sized ledger, append-only log if it grows.
function save() {
  mkdirSync(path.dirname(LEDGER_FILE), { recursive: true });
  writeFileSync(LEDGER_FILE, JSON.stringify(book.entries, null, 1));
}
function sweepDefaults() {
  if (book.sweepDefaults(Math.floor(Date.now() / 1000)).length) save();
}

let wallet: TachiPaymentProvider | null = null;
function vaultWallet() {
  const treasury = process.env.TACHI_AGENT_SECRET_KEY;
  if (!treasury) return null;
  wallet ??= new TachiPaymentProvider(createHash("sha256").update(`vault:${treasury}`).digest(), network.daemonUrl, network.name, network.apiKey);
  return wallet;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
const send = (res: Response, err: unknown) => res.status(err instanceof HttpError ? err.status : 400).json({ error: (err as Error).message });

function requireWallet() {
  const w = vaultWallet();
  if (!w) throw new HttpError(400, "No treasury configured, so there is no vault key");
  return w;
}

/** Checks a signed Nostr request {"action","vault","amountSats"} for this vault: signature, freshness, single use. */
function signedRequest(event: Event | undefined, action: string, vaultPubkey: string) {
  if (!event || !AgentIdentity.verify(event)) throw new HttpError(401, "The request must be a validly signed Nostr event");
  let body: { action?: string; vault?: string; amountSats?: number; borrower?: string };
  try {
    body = JSON.parse(event.content);
  } catch {
    throw new HttpError(400, "The event content is not JSON");
  }
  if (body.action !== action || body.vault !== vaultPubkey) throw new HttpError(400, `The event isn't a ${action} request for this vault`);
  if (Math.abs(Date.now() / 1000 - event.created_at) > MAX_REQUEST_AGE_S) throw new HttpError(400, "The request has expired; sign a new one");
  if (book.usedRequests.has(event.id)) throw new HttpError(409, "This request was already used");
  const amountSats = Number(body.amountSats);
  if (!Number.isInteger(amountSats) || amountSats <= NETWORK_FEE_SATS) throw new HttpError(400, `amountSats must be a whole number above the ${NETWORK_FEE_SATS}-sat network fee`);
  return { pubkey: event.pubkey, amountSats, requestId: event.id, body };
}

/** Verifies a committed transfer from `payer` to the vault key; returns the sats it paid. */
async function verifyTransferIn(body: { txRef?: string; payer?: string }, vaultPubkey: string) {
  const txRef = String(body?.txRef ?? "").toLowerCase();
  const payer = String(body?.payer ?? "");
  if (!/^[0-9a-f]{64}$/.test(txRef) || !/^[0-9a-f]{64}$/.test(payer)) throw new HttpError(400, "txRef and payer must be 64 hex characters");
  // The vault's own payouts carry change back to itself; never count those as money in.
  if (payer === vaultPubkey) throw new HttpError(400, "The vault can't pay itself");
  if (book.creditedTxRefs.has(txRef)) throw new HttpError(409, "This transaction was already credited");
  try {
    const paid = await verifyOnChain({ txRef, payer, resource: "vault" }, vaultPubkey, 1);
    return { txRef, payer, amountSats: paid.amountSats, at: paid.settledAt };
  } catch (err) {
    throw new HttpError(400, `The transfer couldn't be verified: ${(err as Error).message}`);
  }
}

/** Applies a withdraw/borrow entry first (so a second request can't spend the same sats), then pays it out. */
async function payOut(w: TachiPaymentProvider, entry: Extract<VaultEntry, { type: "withdraw" | "borrow" }>, payoutSats: number) {
  const reserves = await w.balanceSats();
  if (payoutSats + NETWORK_FEE_SATS > reserves) throw new HttpError(409, `The vault holds ${reserves} sats on chain right now; the rest is lent out`);
  book.apply(entry);
  try {
    const paid = await w.pay({ toPubkey: entry.pubkey, amountSats: payoutSats, resource: `vault-${entry.type}` });
    entry.txRef = paid.txRef;
    entry.at = paid.settledAt;
    save();
    return paid;
  } catch (err) {
    book.undoLast(); // ponytail: assumes no other entry landed while paying; per-entry undo if it ever matters
    throw new HttpError(502, `The payout failed and the books were restored: ${(err as Error).message}`);
  }
}

/** Body: { txRef, payer } — a committed transfer from `payer` to the vault key. Credits what it paid. */
vaultRouter.post("/vault/deposit", async (req, res) => {
  try {
    const w = requireWallet();
    const t = await verifyTransferIn(req.body, w.pubkey);
    book.apply({ type: "deposit", pubkey: t.payer, amountSats: t.amountSats, txRef: t.txRef, at: t.at });
    save();
    res.json({ amountSats: t.amountSats, balanceSats: book.vault.balanceOf(t.payer) });
  } catch (err) {
    send(res, err);
  }
});

/** Body: { event } signed by the depositor, content {"action":"vault-withdraw","vault","amountSats"}. Pays amount minus the fee. */
vaultRouter.post("/vault/withdraw", async (req, res) => {
  try {
    const w = requireWallet();
    const r = signedRequest(req.body?.event, "vault-withdraw", w.pubkey);
    if (r.amountSats > book.freeBalance(r.pubkey) + 1e-6) throw new HttpError(400, `Only ${Math.floor(book.freeBalance(r.pubkey))} sats are free to withdraw`);
    const paid = await payOut(w, { type: "withdraw", pubkey: r.pubkey, amountSats: r.amountSats, txRef: "", at: 0, requestId: r.requestId }, r.amountSats - NETWORK_FEE_SATS);
    res.json({ txRef: paid.txRef, paidSats: paid.amountSats, feeSats: NETWORK_FEE_SATS, balanceSats: book.vault.balanceOf(r.pubkey) });
  } catch (err) {
    send(res, err);
  }
});

/** The terms an agent would get right now: credit from its vouch, the fee from its reputation. */
function termsFor(pubkey: string) {
  const { score } = directory.reputationOf(pubkey);
  const vouch = book.vouches.get(pubkey) ?? null;
  return { score, feeBps: feeBpsFor(score), termSeconds: LOAN_TERM_S, vouch, limitSats: vouch?.limitSats ?? 0 };
}

/**
 * Body: { event } signed by a depositor, content {"action":"vault-vouch","vault","borrower","amountSats"}.
 * The depositor's shares become first-loss cover for that agent's loans, up to amountSats.
 */
vaultRouter.post("/vault/vouch", (req, res) => {
  try {
    const w = requireWallet();
    const r = signedRequest(req.body?.event, "vault-vouch", w.pubkey);
    const borrower = String(r.body.borrower ?? "");
    if (!/^[0-9a-f]{64}$/.test(borrower)) throw new HttpError(400, "borrower must be a 64-hex pubkey");
    book.apply({ type: "vouch", pubkey: r.pubkey, borrower, amountSats: r.amountSats, at: Math.floor(Date.now() / 1000), requestId: r.requestId });
    save();
    res.json(termsFor(borrower));
  } catch (err) {
    send(res, err);
  }
});

vaultRouter.get("/vault/terms/:pubkey", (req, res) => {
  res.json(termsFor(req.params.pubkey));
});

/**
 * Body: { event } signed by the borrowing agent, content {"action":"vault-borrow","vault","amountSats"}.
 * The vault pays the full amount; the agent owes amount + fee within the term.
 */
vaultRouter.post("/vault/borrow", async (req, res) => {
  try {
    const w = requireWallet();
    sweepDefaults();
    const r = signedRequest(req.body?.event, "vault-borrow", w.pubkey);
    if (book.loans.has(r.pubkey)) throw new HttpError(409, "This agent already has an open loan");
    const terms = termsFor(r.pubkey);
    if (!terms.vouch) throw new HttpError(403, "No depositor has vouched for this agent, so it can't borrow");
    // The borrower owes the network fee the vault spends sending the loan, so reserves + loans = owed.
    const principal = r.amountSats + NETWORK_FEE_SATS;
    if (principal > terms.limitSats) throw new HttpError(400, `The sponsor vouched for up to ${terms.limitSats} sats, network fee included`);
    book.checkUtilization(principal);
    const feeSats = Math.ceil((principal * terms.feeBps) / 10_000);
    const now = Math.floor(Date.now() / 1000);
    const entry = { type: "borrow" as const, pubkey: r.pubkey, sponsor: terms.vouch.sponsor, amountSats: principal, feeSats, dueAt: now + LOAN_TERM_S, txRef: "", at: 0, requestId: r.requestId };
    const paid = await payOut(w, entry, r.amountSats);
    res.json({ txRef: paid.txRef, receivedSats: r.amountSats, principalSats: principal, feeSats, repaySats: principal + feeSats, dueAt: entry.dueAt, terms });
  } catch (err) {
    send(res, err);
  }
});

/** Body: { txRef, payer } — a committed transfer from a borrower to the vault key, applied to its loan. */
vaultRouter.post("/vault/repay", async (req, res) => {
  try {
    const w = requireWallet();
    sweepDefaults();
    const payer = String(req.body?.payer ?? "");
    if (!book.loans.has(payer)) throw new HttpError(400, "This agent has no open loan");
    const t = await verifyTransferIn(req.body, w.pubkey);
    book.apply({ type: "repay", pubkey: t.payer, amountSats: t.amountSats, txRef: t.txRef, at: t.at });
    save();
    const loan = book.loans.get(t.payer);
    res.json({ amountSats: t.amountSats, closed: !loan, remainingSats: loan ? loan.principal + loan.feeSats - loan.repaid : 0 });
  } catch (err) {
    send(res, err);
  }
});

/** Liabilities next to reserves on chain and loans outstanding, the risk numbers, and the full ledger. */
vaultRouter.get("/vault/summary", async (_req, res) => {
  const w = vaultWallet();
  if (!w) return res.json({ configured: false });
  sweepDefaults();
  const owedSats = book.owedSats();
  const outstandingSats = book.outstandingSats();
  res.json({
    configured: true,
    vaultPubkey: w.pubkey,
    network: network.name,
    explorerUrl: network.explorerUrl,
    owedSats,
    reservesSats: await w.balanceSats().catch(() => null),
    outstandingSats,
    utilization: owedSats > 0 ? outstandingSats / owedSats : 0,
    maxUtilization: MAX_UTILIZATION,
    sharePrice: book.vault.sharePrice(),
    depositorCount: book.vault.summary().depositorCount,
    realizedYieldSats: book.realizedYieldSats,
    writtenOffSats: book.writtenOffSats,
    sponsorCoveredSats: book.sponsorCoveredSats,
    loans: [...book.loans].map(([pubkey, l]) => ({ pubkey, ...l })),
    ledger: book.entries.slice().reverse(),
  });
});

vaultRouter.get("/vault/balance/:pubkey", (req, res) => {
  res.json({ balanceSats: book.vault.balanceOf(req.params.pubkey) });
});
