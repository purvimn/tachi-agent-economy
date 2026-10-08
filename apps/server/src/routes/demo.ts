import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import { schnorr } from "@noble/curves/secp256k1.js";
import { TachiPaymentProvider, p2trAddress, depositFromL1, tachiTx } from "@tachi-hack/agent-sdk";
import { network } from "./daemon.js";
import { seedDemo, payOnChain, payBurst, buyDataset, findSellerOnNostr, anchorLog, vaultRoundTrip, vaultLoan } from "../flows.js";

/**
 * Dashboard controls: run the demo flows and fund the treasury without the CLI.
 * ponytail: no auth and the server holds the treasury key — localhost demo only. Put this behind
 * auth (or drop the router) before exposing the server anywhere.
 */
export const demoRouter = Router();

const ENV_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../.env");
const self = () => `http://localhost:${process.env.PORT ?? 4402}`;

interface Job {
  action: "seed" | "pay" | "burst" | "dataset" | "nostr" | "anchor" | "vault" | "loan" | "fund";
  status: "running" | "done" | "failed";
  steps: string[];
  error?: string;
  result?: unknown;
}
// ponytail: one job at a time, in memory — enough for a single person driving a demo.
let job: Job | null = null;

function start(action: Job["action"], run: (step: (m: string) => void) => Promise<unknown>) {
  if (job?.status === "running") return false;
  const current: Job = { action, status: "running", steps: [] };
  job = current;
  run((m) => current.steps.push(m)).then(
    (result) => Object.assign(current, { status: "done", result }),
    (err: Error) => Object.assign(current, { status: "failed", error: err.message }),
  );
  return true;
}

const treasurySecret = () => process.env.TACHI_AGENT_SECRET_KEY;

demoRouter.get("/demo/treasury", async (_req, res) => {
  const secret = treasurySecret();
  const base = { network: network.name, explorerUrl: network.explorerUrl, l1ExplorerUrl: network.l1ExplorerUrl };
  if (!secret) {
    res.json({ ...base, configured: false });
    return;
  }
  const wallet = new TachiPaymentProvider(tachiTx.unhex(secret), network.daemonUrl, network.name, network.apiKey);
  const balanceSats = await wallet.balanceSats().catch(() => null);
  res.json({ ...base, configured: true, pubkey: wallet.pubkey, l1Address: p2trAddress(wallet.pubkey, network.hrp), balanceSats });
});

/** Creates the treasury key if there isn't one, saving it to .env so it survives restarts. */
demoRouter.post("/demo/treasury", (_req, res) => {
  if (!treasurySecret()) {
    const sk = tachiTx.hex(schnorr.utils.randomSecretKey());
    appendFileSync(ENV_FILE, `\nTACHI_AGENT_SECRET_KEY=${sk}\n`);
    process.env.TACHI_AGENT_SECRET_KEY = sk;
  }
  res.json({ ok: true });
});

demoRouter.post("/demo/seed", (_req, res) => {
  const ok = start("seed", (step) => seedDemo(self(), step));
  res.status(ok ? 202 : 409).json(ok ? { ok } : { error: "Another action is still running" });
});

demoRouter.post("/demo/pay", (_req, res) => {
  const secret = treasurySecret();
  if (!secret) {
    res.status(400).json({ error: "Create and fund a treasury first" });
    return;
  }
  const ok = start("pay", (step) => payOnChain(self(), network, secret, step));
  res.status(ok ? 202 : 409).json(ok ? { ok } : { error: "Another action is still running" });
});

/** Actions that run as the treasury agent: one route each. */
const treasuryActions = {
  dataset: buyDataset,
  nostr: findSellerOnNostr,
  anchor: anchorLog,
  vault: vaultRoundTrip,
  loan: vaultLoan,
} as const;
for (const [action, flow] of Object.entries(treasuryActions)) {
  demoRouter.post(`/demo/${action}`, (_req, res) => {
    const secret = treasurySecret();
    if (!secret) {
      res.status(400).json({ error: "Create and fund a treasury first" });
      return;
    }
    const ok = start(action as Job["action"], (step) => flow(self(), network, secret, step));
    res.status(ok ? 202 : 409).json(ok ? { ok } : { error: "Another action is still running" });
  });
}

demoRouter.post("/demo/burst", (req, res) => {
  const secret = treasurySecret();
  const count = Number(req.body?.count ?? 10);
  if (!secret) {
    res.status(400).json({ error: "Create and fund a treasury first" });
    return;
  }
  if (!Number.isInteger(count) || count < 1 || count > 25) {
    res.status(400).json({ error: "Choose between 1 and 25 requests" });
    return;
  }
  const ok = start("burst", (step) => payBurst(self(), network, secret, count, step));
  res.status(ok ? 202 : 409).json(ok ? { ok } : { error: "Another action is still running" });
});

demoRouter.post("/demo/fund", (req, res) => {
  const secret = treasurySecret();
  const txid = String(req.body?.txid ?? "").trim().toLowerCase();
  if (!secret) {
    res.status(400).json({ error: "Create a treasury first" });
    return;
  }
  if (!/^[0-9a-f]{64}$/.test(txid)) {
    res.status(400).json({ error: "A transaction ID is 64 hexadecimal characters" });
    return;
  }
  const ok = start("fund", async (step) => {
    const ref = await depositFromL1(network, tachiTx.unhex(secret), txid, step);
    return { txRef: ref, explorerUrl: `${network.explorerUrl}/tx/${ref}` };
  });
  res.status(ok ? 202 : 409).json(ok ? { ok } : { error: "Another action is still running" });
});

demoRouter.get("/demo/job", (_req, res) => {
  res.json(job);
});
