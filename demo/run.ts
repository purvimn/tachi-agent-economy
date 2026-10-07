import { spawn, type ChildProcess } from "node:child_process";
import { AgentIdentity, openDelivery } from "@tachi-hack/agent-sdk";
import { client } from "../apps/server/src/flows.js";

const BASE = "http://localhost:4402";
const { post, publish } = client(BASE);
const postJson = async (path: string, body: unknown) => (await post(path, body)).json();

function startServer(): ChildProcess {
  return spawn("npx", ["tsx", "apps/server/src/index.ts"], { stdio: "inherit" });
}

async function waitForHealth(timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch {
      // server not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("server did not become healthy in time");
}

const register = (agent: AgentIdentity) => post("/agents/register", { pubkey: agent.pubkey, name: agent.name });

/** Full x402 round-trip: call a paid endpoint, on 402 pay and publish signed events, then retry. */
async function callPaidService(buyer: AgentIdentity, seller: AgentIdentity, path: string): Promise<unknown> {
  const url = `${BASE}${path}`;
  let r = await fetch(url);
  if (r.status === 402) {
    const info = await r.json();
    const payment = await postJson("/pay", { fromPubkey: buyer.pubkey, toPubkey: seller.pubkey, amountSats: info.priceSats, resource: info.resource });
    await publish(buyer, "payment_sent", { toPubkey: seller.pubkey, amountSats: info.priceSats, txRef: payment.txRef });
    await publish(seller, "payment_received", { fromPubkey: buyer.pubkey, amountSats: info.priceSats, txRef: payment.txRef });
    r = await fetch(url, { headers: { "x-tachi-payment": payment.txRef } });
  }
  if (!r.ok) throw new Error(`service call failed: ${r.status} ${await r.text()}`);
  await publish(buyer, "job_completed", { service: path });
  return r.json();
}

async function main() {
  console.log("Starting server...");
  const server = startServer();
  try {
    await waitForHealth();
    console.log("Server healthy. Running Agent Economy demo.\n");

    const research = new AgentIdentity("ResearchBot");
    const dataProvider = new AgentIdentity("BTCDataAgent");
    const inferenceProvider = new AgentIdentity("InferenceAgent");
    await Promise.all([research, dataProvider, inferenceProvider].map(register));

    console.log(`ResearchBot   npub: ${research.pubkey}`);
    console.log(`BTCDataAgent  npub: ${dataProvider.pubkey}`);
    console.log(`InferenceAgent npub: ${inferenceProvider.pubkey}\n`);

    const data = await callPaidService(research, dataProvider, `/services/btc-data/${dataProvider.pubkey}`);
    console.log("BTC data purchased:", data);

    const inference = await callPaidService(research, inferenceProvider, `/services/inference/${inferenceProvider.pubkey}`);
    console.log("Inference purchased:", inference);

    const history = await (await fetch(`${BASE}/events/${research.pubkey}`)).json();
    console.log(`\nVerified action history for ResearchBot (${history.length} signed events):`);
    for (const e of history) console.log(`  [${e.kind}] ${e.content}`);

    const reputation = await (await fetch(`${BASE}/agents/${research.pubkey}/reputation`)).json();
    console.log("\nResearchBot reputation:", reputation);

    console.log("\n--- Yield Agent ---");
    const depositor = new AgentIdentity("YieldDepositor");
    await register(depositor);
    const dep = await await postJson("/yield/deposit", { pubkey: depositor.pubkey, amountSats: 500_000 });
    console.log("Deposited 500,000 sats:", dep);

    // First rebalance call just allocates a strategy (no elapsed time to accrue against yet).
    await post("/yield/rebalance", { maxRiskScore: 40, elapsedSeconds: 0 });

    const rebalance = await await postJson("/yield/rebalance", { maxRiskScore: 40, elapsedSeconds: 30 * 24 * 3600 });
    console.log("Rebalanced (max risk 40, 30 days elapsed):", rebalance);

    const balance = await (await fetch(`${BASE}/yield/balance/${depositor.pubkey}`)).json();
    console.log("Balance after accrual:", balance);

    console.log("\n--- Data Marketplace ---");
    const dataSeller = new AgentIdentity("DatasetSeller");
    const dataBuyer = new AgentIdentity("DatasetBuyer");
    await Promise.all([register(dataSeller), register(dataBuyer)]);

    const datasetContent = "timestamp,open,high,low,close\n1,100,110,90,105\n2,105,120,100,118";
    const listing = await await postJson("/datasets", {
          providerPubkey: dataSeller.pubkey,
          title: "BTC OHLCV Sample",
          description: "Two hourly candles for demo purposes",
          priceSats: 300,
          content: datasetContent,
        });
    console.log("Listed dataset:", listing);

    const gate = await fetch(`${BASE}/datasets/${listing.id}/purchase`);
    if (gate.status !== 402) throw new Error(`expected 402 before payment, got ${gate.status}`);
    const gateInfo = await gate.json();

    const datasetPay = await await postJson("/pay", { fromPubkey: dataBuyer.pubkey, toPubkey: dataSeller.pubkey, amountSats: 300, resource: gateInfo.resource });
    const purchase = await (
      await fetch(`${BASE}/datasets/${listing.id}/purchase`, { headers: { "x-tachi-payment": datasetPay.txRef } })
    ).json();
    const opened = openDelivery(purchase.delivery, dataBuyer.secretKeyBytes());
    console.log("Purchased dataset (sealed to the buyer's key, opened locally):", opened);

    console.log("\n--- Merchant Payments ---");
    const merchant = new AgentIdentity("CoffeeShop");
    const shopper = new AgentIdentity("Shopper");
    await Promise.all([register(merchant), register(shopper)]);
    // Shopper is capped at 300 sats total — enough for one 250-sat purchase, not two.
    await post(`/agents/${shopper.pubkey}/budget`, { totalSats: 300, maxPerRequestSats: 300 });

    const product = await await postJson("/products", {
          merchantPubkey: merchant.pubkey,
          title: "Espresso",
          description: "A double shot",
          priceSats: 250,
          fulfillment: "REDEEM-CODE-ESPRESSO-001",
        });
    console.log("Listed product:", product);

    const shopGate = await fetch(`${BASE}/products/${product.id}/checkout`);
    if (shopGate.status !== 402) throw new Error(`expected 402 before payment, got ${shopGate.status}`);
    const shopInfo = await shopGate.json();

    const shopPay = await await postJson("/pay", { fromPubkey: shopper.pubkey, toPubkey: merchant.pubkey, amountSats: 250, resource: shopInfo.resource });
    const checkout = await (
      await fetch(`${BASE}/products/${product.id}/checkout`, { headers: { "x-tachi-payment": shopPay.txRef } })
    ).json();
    console.log("Checked out:", checkout);

    const overBudget = await post("/pay", { fromPubkey: shopper.pubkey, toPubkey: merchant.pubkey, amountSats: 250, resource: shopInfo.resource });
    console.log(`Over-budget payment rejected: ${overBudget.status} (expected 400)`);

    // A payment proof minted for one resource must not be spendable on another.
    const replayPay = await await postJson("/pay", {
          fromPubkey: research.pubkey,
          toPubkey: dataProvider.pubkey,
          amountSats: 50,
          resource: `GET /services/inference/${dataProvider.pubkey}`,
        });
    const replay = await fetch(`${BASE}/services/btc-data/${dataProvider.pubkey}`, {
      headers: { "x-tachi-payment": replayPay.txRef },
    });
    console.log(`Cross-resource replay blocked: ${replay.status} (expected 402)`);

    // --- self-check assertions ---
    if (replay.status !== 402) throw new Error(`x402 proof was replayable across resources (got ${replay.status})`);
    if (history.length < 4) throw new Error(`expected >=4 logged events, got ${history.length}`);
    if (reputation.completedJobs !== 2) throw new Error(`expected 2 completed jobs, got ${reputation.completedJobs}`);
    if (balance.balanceSats <= 500_000) throw new Error("expected yield accrual to increase balance");
    if (opened !== datasetContent) throw new Error("opened dataset content did not match original");
    if (JSON.stringify(purchase).includes("timestamp,open")) throw new Error("dataset plaintext leaked in the delivery");
    if (purchase.contentHash !== listing.contentHash) throw new Error("dataset content hash mismatch");
    if (checkout.fulfillment !== "REDEEM-CODE-ESPRESSO-001") throw new Error("merchant fulfillment not released after payment");
    if (product.fulfillment !== undefined) throw new Error("merchant fulfillment leaked in public listing");
    if (checkout.receipt.txRef !== shopPay.txRef) throw new Error("merchant receipt txRef mismatch");
    if (overBudget.status !== 400) throw new Error(`budget did not block overspend (got ${overBudget.status})`);
    console.log("\nSelf-check passed.");
  } finally {
    server.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
