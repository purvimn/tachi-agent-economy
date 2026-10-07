import { Router } from "express";
import { tachiNetwork, tachiClient } from "@tachi-hack/agent-sdk";

export const daemonRouter = Router();

export const network = tachiNetwork();
export const tachi = tachiClient(network.daemonUrl, network.apiKey);

// ponytail: read-only daemon proxy, no auth on our side since it's a hackathon demo endpoint
daemonRouter.get("/daemon/health", async (_req, res) => {
  try {
    res.json(await tachi.getHealth());
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

daemonRouter.get("/daemon/vtxos", async (_req, res) => {
  try {
    res.json(await tachi.listVtxos({ page_size: 10 }));
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});
