import { Router } from "express";
import { Budget } from "@tachi-hack/agent-sdk";
import { directory, budgets } from "../world.js";

export const agentsRouter = Router();

agentsRouter.post("/agents/register", (req, res) => {
  const { pubkey, name } = req.body ?? {};
  if (!pubkey || !name) {
    res.status(400).json({ error: "pubkey and name are required" });
    return;
  }
  directory.register({ pubkey, name } as any);
  res.json({ ok: true });
});

agentsRouter.post("/agents/:pubkey/services", (req, res) => {
  const { name, serviceId, priceSats, description } = req.body ?? {};
  directory.listService({ pubkey: req.params.pubkey, name, serviceId, priceSats, description });
  res.json({ ok: true });
});

agentsRouter.get("/agents", (_req, res) => {
  res.json(directory.all());
});

agentsRouter.get("/services", (req, res) => {
  res.json(directory.findServices(req.query.serviceId as string | undefined));
});

agentsRouter.get("/agents/:pubkey/reputation", (req, res) => {
  res.json(directory.reputationOf(req.params.pubkey));
});

/** Set an agent's spending policy; `/pay` enforces it. `allowedServices` are x402 resource strings. */
agentsRouter.post("/agents/:pubkey/budget", (req, res) => {
  const { totalSats, maxPerRequestSats, allowedServices } = req.body ?? {};
  if (!(totalSats > 0) || !(maxPerRequestSats > 0)) {
    res.status(400).json({ error: "totalSats and maxPerRequestSats must be positive" });
    return;
  }
  budgets.set(req.params.pubkey, new Budget(totalSats, maxPerRequestSats, allowedServices ? new Set(allowedServices) : undefined));
  res.json({ ok: true });
});

agentsRouter.get("/agents/:pubkey/budget", (req, res) => {
  const b = budgets.get(req.params.pubkey);
  if (!b) {
    res.status(404).json({ error: "no budget set" });
    return;
  }
  res.json({ totalSats: b.totalSats, maxPerRequestSats: b.maxPerRequestSats, remainingSats: b.remainingSats });
});
