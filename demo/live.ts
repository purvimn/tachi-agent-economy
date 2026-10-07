// Live x402 round-trip settled on Tachi (needs a funded treasury: see demo/fund.ts).
// Same flow as the dashboard's "Make a real payment"; reuses a running server or starts one.
import { spawn } from "node:child_process";
import { tachiNetwork } from "@tachi-hack/agent-sdk";
import { payOnChain } from "../apps/server/src/flows.js";

const BASE = "http://localhost:4402";
const up = () => fetch(`${BASE}/health`).then((r) => r.ok, () => false);

async function main() {
  const secret = process.env.TACHI_AGENT_SECRET_KEY;
  if (!secret) throw new Error("TACHI_AGENT_SECRET_KEY not set — run `npm run fund` first");
  const net = tachiNetwork();
  const server = (await up()) ? null : spawn("npx", ["tsx", "--env-file=.env", "apps/server/src/index.ts"], { stdio: "inherit", env: { ...process.env, TACHI_NETWORK: net.name } });
  try {
    for (let i = 0; i < 50 && !(await up()); i++) await new Promise((r) => setTimeout(r, 300));
    const r = await payOnChain(BASE, net, secret, (m) => console.log(m));
    console.log(`Committed: ${r.explorerUrl}`);
    console.log("Service response:", r.response);
    console.log(`Replaying the proof: ${r.replayRejected ? "rejected" : "ACCEPTED"}`);
    console.log(`A stranger claiming the txRef: ${r.theftRejected ? "rejected" : "ACCEPTED"}`);
    if (!r.replayRejected) throw new Error("on-chain payment could be claimed twice");
    if (!r.theftRejected) throw new Error("someone other than the payer could claim the payment");
    console.log("\nLive self-check passed.");
  } finally {
    server?.kill();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
