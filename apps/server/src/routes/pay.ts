import { Router } from "express";
import { AgentIdentity, type EventKind } from "@tachi-hack/agent-sdk";
import { network } from "./daemon.js";
import { paymentProvider, settledPayments, eventLog, budgets, paymentHistory } from "../world.js";

export const payRouter = Router();

/**
 * Simulated settlement: the server mints a single-use proof bound to `resource`, which the agent
 * sends back in X-PAYMENT (scheme "simulated"). Real payments skip this route entirely — the agent
 * pays on Tachi and sends a signed claim in X-PAYMENT (see x402.ts).
 */
payRouter.post("/pay", async (req, res) => {
  const { fromPubkey, toPubkey, amountSats, resource } = req.body ?? {};
  if (!fromPubkey || !toPubkey || !amountSats) {
    res.status(400).json({ error: "fromPubkey, toPubkey, amountSats are required" });
    return;
  }
  // On-chain payers enforce their own budget in x402Fetch; this gates server-settled payments.
  const budget = budgets.get(fromPubkey);
  try {
    // Policy check runs before the provider so a rejected payment never settles.
    budget?.authorize(amountSats, resource);
    // `resource` (from the 402 body) binds this proof to one endpoint so it can't be replayed elsewhere.
    const result = await paymentProvider.pay({ fromPubkey, toPubkey, amountSats, resource });
    budget?.record(amountSats);
    settledPayments.set(result.txRef, result);
    paymentHistory.push(result);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** Agents sign events client-side (they hold the private key) and publish them here for the audit trail. */
payRouter.post("/events", (req, res) => {
  const { event, kind } = req.body ?? {};
  if (!event || !kind) {
    res.status(400).json({ error: "event and kind are required" });
    return;
  }
  if (!AgentIdentity.verify(event)) {
    res.status(400).json({ error: "invalid signature" });
    return;
  }
  const logged = eventLog.append(event, kind as EventKind);
  res.json(logged);
});

payRouter.get("/config", (_req, res) => {
  res.json({ network: network.name, explorerUrl: network.explorerUrl, l1ExplorerUrl: network.l1ExplorerUrl });
});

payRouter.get("/payments", (_req, res) => {
  res.json(
    paymentHistory
      .slice()
      .reverse()
      .map((p) => ({ ...p, explorerUrl: p.mode !== "simulated" ? `${network.explorerUrl}/tx/${p.txRef}` : undefined })),
  );
});

payRouter.get("/events", (_req, res) => {
  res.json(eventLog.all());
});

payRouter.get("/events/:pubkey", (req, res) => {
  res.json(eventLog.forAgent(req.params.pubkey));
});
