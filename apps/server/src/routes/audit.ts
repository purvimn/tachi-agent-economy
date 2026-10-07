import { Router } from "express";
import { logChainRoot, anchorKey } from "@tachi-hack/agent-sdk";
import { anchors, eventLog } from "../world.js";
import { tachi, network } from "./daemon.js";

/**
 * Tamper evidence for the event log: its hash-chain root is anchored on Tachi as a 1-sat output to
 * anchorKey(payer, root), a pay-to-contract key committing to the root. Re-computing the root over
 * the first `count` events must still give the anchored value.
 */
export const auditRouter = Router();

const rootOf = (count: number) => logChainRoot(eventLog.all().slice(0, count).map((e) => e.id));

auditRouter.get("/audit/root", (_req, res) => {
  const count = eventLog.all().length;
  res.json({ root: rootOf(count), count });
});

/** Records an anchor after checking the Tachi transaction really carries this root. */
auditRouter.post("/audit/anchors", async (req, res) => {
  const { root, count, txRef } = req.body ?? {};
  if (!/^[0-9a-f]{64}$/.test(String(root)) || !/^[0-9a-f]{64}$/.test(String(txRef)) || !Number.isInteger(count)) {
    res.status(400).json({ error: "root, txRef (64 hex) and count are required" });
    return;
  }
  if (count > eventLog.all().length || rootOf(count) !== root) {
    res.status(400).json({ error: "That root doesn't match the log" });
    return;
  }
  try {
    const tx = await tachi.getTransaction(txRef);
    if (tx.state !== "committed") throw new Error(`the transaction is ${tx.state}`);
    const decoded = await tachi.decodeTransaction(tx.hex);
    if (!decoded.vout.some((o) => o.owner === anchorKey(decoded.pubkey, root))) throw new Error("the transaction has no output committing to the root");
  } catch (err) {
    res.status(400).json({ error: `Anchor not verified: ${(err as Error).message}` });
    return;
  }
  anchors.push({ root, count, txRef, at: Math.floor(Date.now() / 1000) });
  res.json({ ok: true });
});

auditRouter.get("/audit/anchors", (_req, res) => {
  res.json(
    anchors
      .slice()
      .reverse()
      .map((a) => ({ ...a, matchesLog: rootOf(a.count) === a.root, explorerUrl: `${network.explorerUrl}/tx/${a.txRef}` })),
  );
});
