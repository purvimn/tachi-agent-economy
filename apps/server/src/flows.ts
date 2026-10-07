// Demo flows, driven through the server's own HTTP API exactly as an outside agent would call it.
// Used by the dashboard (routes/demo.ts) and the CLI scripts in demo/.
import { createHash } from "node:crypto";
import {
  AgentIdentity,
  Budget,
  TachiPaymentProvider,
  x402Fetch,
  encodePaymentHeader,
  signClaim,
  PAYMENT_HEADER,
  X402_VERSION,
  openDelivery,
  NostrRelays,
  anchorKey,
  type TachiNetwork,
} from "@tachi-hack/agent-sdk";

type Step = (msg: string) => void;

export function client(base: string) {
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const publish = (a: AgentIdentity, kind: string, content: unknown) =>
    post("/events", { event: a.sign({ kind: 1, content: JSON.stringify(content), tags: [], created_at: Math.floor(Date.now() / 1000) }), kind });
  return { post, publish };
}

/** Registers demo agents and runs simulated x402 purchases, a vault deposit, and marketplace listings. */
export async function seedDemo(base: string, onStep: Step = () => {}) {
  const { post, publish } = client(base);

  const paidCall = async (buyer: AgentIdentity, seller: AgentIdentity, path: string) => {
    let r = await fetch(`${base}${path}`);
    if (r.status === 402) {
      const info = await r.json();
      const pay = await (await post("/pay", { fromPubkey: buyer.pubkey, toPubkey: seller.pubkey, amountSats: info.priceSats, resource: info.resource })).json();
      await publish(buyer, "payment_sent", { toPubkey: seller.pubkey, amountSats: info.priceSats, txRef: pay.txRef });
      await publish(seller, "payment_received", { fromPubkey: buyer.pubkey, amountSats: info.priceSats, txRef: pay.txRef });
      r = await fetch(`${base}${path}`, { headers: { "x-tachi-payment": pay.txRef } });
    }
    if (!r.ok) throw new Error(`${path} returned ${r.status}`);
    await publish(buyer, "job_completed", { service: path });
  };

  const research = new AgentIdentity("ResearchBot");
  const dataAgent = new AgentIdentity("BTCDataAgent");
  const inferAgent = new AgentIdentity("InferenceAgent");
  const depositor = new AgentIdentity("YieldDepositor");
  const shop = new AgentIdentity("CoffeeShop");

  onStep("Registering five agents");
  await Promise.all([research, dataAgent, inferAgent, depositor, shop].map((a) => post("/agents/register", { pubkey: a.pubkey, name: a.name })));

  onStep("ResearchBot is buying BTC data and inference");
  await paidCall(research, dataAgent, `/services/btc-data/${dataAgent.pubkey}`);
  await paidCall(research, inferAgent, `/services/inference/${inferAgent.pubkey}`);

  onStep("YieldDepositor is depositing into the vault");
  await post("/yield/deposit", { pubkey: depositor.pubkey, amountSats: 500_000 });
  await post("/yield/rebalance", { maxRiskScore: 40, elapsedSeconds: 0 });
  await post("/yield/rebalance", { maxRiskScore: 40, elapsedSeconds: 30 * 24 * 3600 });

  onStep("Listing a dataset and a product");
  await post("/datasets", {
    providerPubkey: dataAgent.pubkey,
    title: "BTC OHLCV Sample",
    description: "Two hourly candles for demo purposes",
    priceSats: 300,
    content: "timestamp,open,high,low,close\n1,100,110,90,105\n2,105,120,100,118",
  });
  const product = await (
    await post("/products", {
      merchantPubkey: shop.pubkey,
      title: "Espresso voucher",
      description: "One espresso, redeemable in store",
      priceSats: 250,
      fulfillment: "REDEEM-CODE-ESPRESSO-001",
    })
  ).json();
  await post(`/agents/${research.pubkey}/budget`, { totalSats: 5_000, maxPerRequestSats: 1_000 });

  onStep("ResearchBot is buying the espresso voucher");
  await paidCall(research, shop, `/products/${product.id}/checkout`);
}

/** TreasuryBot (the funded treasury key) and DataVendor (a stable seller derived from it), registered. */
async function realAgents(base: string, net: TachiNetwork, secretKeyHex: string) {
  const { post } = client(base);
  const secret = Buffer.from(secretKeyHex, "hex");
  const buyer = new AgentIdentity("TreasuryBot", secret);
  // Stable seller across runs (derived from the treasury key) so repeat demos reuse one agent.
  const seller = new AgentIdentity("DataVendor", createHash("sha256").update(`seller:${secretKeyHex}`).digest());
  const wallet = new TachiPaymentProvider(secret, net.daemonUrl, net.name, net.apiKey);
  await Promise.all([buyer, seller].map((a) => post("/agents/register", { pubkey: a.pubkey, name: a.name })));
  return { buyer, seller, wallet };
}

/**
 * TreasuryBot buys BTC data from DataVendor over x402 with a real Tachi transfer (x402Fetch), then
 * checks the two attacks the protocol must stop: replaying the proof, and someone else claiming it.
 */
export async function payOnChain(base: string, net: TachiNetwork, secretKeyHex: string, onStep: Step = () => {}) {
  const { publish } = client(base);
  const { buyer, seller, wallet } = await realAgents(base, net, secretKeyHex);
  const url = `${base}/services/btc-data/${seller.pubkey}`;

  onStep("Requesting BTC data from DataVendor");
  const { response, payment } = await x402Fetch(url, {}, { wallet, budget: new Budget(10_000, 1_000), onStep });
  if (!response.ok || !payment) throw new Error(`Paid request was not served (${response.status}): ${(await response.json()).error ?? ""}`);
  const data = await response.json();
  const { txRef, amountSats, requirements: req } = payment;
  await publish(buyer, "payment_sent", { toPubkey: seller.pubkey, amountSats, txRef });
  await publish(seller, "payment_received", { fromPubkey: buyer.pubkey, amountSats, txRef });
  await publish(buyer, "job_completed", { service: req.resource });

  const claim = (payer: string, signature: string) =>
    fetch(url, { headers: { [PAYMENT_HEADER]: encodePaymentHeader({ x402Version: X402_VERSION, scheme: "exact", network: req.network, payload: { txRef, payer, resource: req.resource, signature } }) } });
  const replay = await claim(buyer.pubkey, wallet.signClaim(txRef, req.resource));
  // A stranger who saw the txRef on the explorer claims it as the payer, signing with their own key.
  const theft = await claim(buyer.pubkey, signClaim(new AgentIdentity("Stranger").secretKeyBytes(), txRef, req.resource));
  const theftError = (await theft.json()).error as string;

  return {
    txRef,
    explorerUrl: `${net.explorerUrl}/tx/${txRef}`,
    response: data,
    replayRejected: replay.status === 402,
    theftRejected: theft.status === 402 && /signed by the payer/.test(theftError),
    sellerPubkey: seller.pubkey,
  };
}

/**
 * High-frequency, low-value payments: `count` paid requests to a 20-sat service at once. Each pays
 * from its own small VTXO, so the transfers commit together instead of one block each.
 */
export async function payBurst(base: string, net: TachiNetwork, secretKeyHex: string, count: number, onStep: Step = () => {}) {
  const { publish } = client(base);
  const { buyer, seller, wallet } = await realAgents(base, net, secretKeyHex);
  const url = `${base}/services/search/${seller.pubkey}`;

  onStep(`Making sure TreasuryBot has ${count} small coins to pay from`);
  await wallet.ensureChange(count);

  onStep(`Sending ${count} paid requests at once`);
  const started = Date.now();
  const results = await Promise.allSettled(
    Array.from({ length: count }, async () => {
      const { response, payment } = await x402Fetch(url, {}, { wallet });
      if (!response.ok || !payment) throw new Error(`request failed (${response.status})`);
      return payment;
    }),
  );
  const seconds = (Date.now() - started) / 1000;
  const paid = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  const failed = results.flatMap((r) => (r.status === "rejected" ? [String(r.reason?.message ?? r.reason)] : []));
  onStep(`${paid.length} of ${count} requests paid and served in ${seconds.toFixed(1)}s`);

  for (const p of paid) {
    await publish(buyer, "payment_sent", { toPubkey: seller.pubkey, amountSats: p.amountSats, txRef: p.txRef });
    await publish(seller, "payment_received", { fromPubkey: buyer.pubkey, amountSats: p.amountSats, txRef: p.txRef });
  }
  const sats = paid.reduce((s, p) => s + p.amountSats, 0);
  return {
    count,
    served: paid.length,
    failed,
    seconds,
    perSecond: paid.length / seconds,
    satsPaid: sats,
    feesSats: paid.length * 10,
    txRefs: paid.map((p) => p.txRef),
  };
}

/** 48 hours of synthetic median mempool fee rates: a small, realistic training-data CSV. */
const FEE_HISTORY = ["hour,median_fee_sat_vb,mempool_tx_count"]
  .concat(Array.from({ length: 48 }, (_, h) => `${h},${(4 + 3 * Math.sin(h / 4) + (h % 7) / 3).toFixed(2)},${18000 + ((h * 7919) % 9000)}`))
  .join("\n");

/**
 * TreasuryBot buys a training dataset from DataVendor with a real Tachi payment. The data arrives
 * sealed to TreasuryBot's Nostr key; it opens it, checks the content hash, and rates the dataset.
 */
export async function buyDataset(base: string, net: TachiNetwork, secretKeyHex: string, onStep: Step = () => {}) {
  const { post, publish } = client(base);
  const { buyer, seller, wallet } = await realAgents(base, net, secretKeyHex);

  const listed = (await (await fetch(`${base}/datasets`)).json()) as { id: string; title: string; priceSats: number; providerPubkey: string }[];
  let ds = listed.find((d) => d.providerPubkey === seller.pubkey);
  if (!ds) {
    onStep("DataVendor lists a training dataset");
    ds = await (
      await post("/datasets", {
        providerPubkey: seller.pubkey,
        title: "BTC mempool fee history",
        description: "48 hours of median fee rates and mempool size, for fee-prediction models",
        priceSats: 300,
        content: FEE_HISTORY,
      })
    ).json();
  }

  onStep(`TreasuryBot buys "${ds!.title}" for ${ds!.priceSats} sats`);
  const { response, payment } = await x402Fetch(`${base}/datasets/${ds!.id}/purchase`, {}, { wallet, budget: new Budget(10_000, 1_000), onStep });
  if (!response.ok || !payment) throw new Error(`The purchase failed (${response.status}): ${(await response.json()).error ?? ""}`);
  const body = (await response.json()) as { contentHash: string; delivery: Parameters<typeof openDelivery>[0] };

  onStep("Delivered sealed to TreasuryBot's Nostr key; opening it locally");
  const content = openDelivery(body.delivery, buyer.secretKeyBytes());
  if (createHash("sha256").update(content).digest("hex") !== body.contentHash) throw new Error("The dataset doesn't match its content hash");
  const rows = content.split("\n").length - 1;

  onStep(`Hash verified (${rows} rows). TreasuryBot rates the dataset`);
  const rating = buyer.sign({
    kind: 1,
    content: JSON.stringify({ target: seller.pubkey, datasetId: ds!.id, stars: 5, comment: "Complete and matches its hash" }),
    tags: [],
    created_at: Math.floor(Date.now() / 1000),
  });
  const quality = await (await post(`/datasets/${ds!.id}/ratings`, { event: rating })).json();
  await publish(buyer, "payment_sent", { toPubkey: seller.pubkey, amountSats: payment.amountSats, txRef: payment.txRef });
  await publish(seller, "payment_received", { fromPubkey: buyer.pubkey, amountSats: payment.amountSats, txRef: payment.txRef });

  return { txRef: payment.txRef, explorerUrl: `${net.explorerUrl}/tx/${payment.txRef}`, title: ds!.title, rows, hashVerified: true, quality };
}

/**
 * Agents meet on public Nostr relays: DataVendor publishes its profile and BTC-data offer (NIP-89),
 * TreasuryBot discovers it, and they talk privately (NIP-17 gift-wrapped DMs). Each side logs the
 * messages it sent or received as signed events, so the conversation is part of the audit trail.
 */
export async function findSellerOnNostr(base: string, net: TachiNetwork, secretKeyHex: string, onStep: Step = () => {}) {
  const { post, publish } = client(base);
  const { buyer, seller } = await realAgents(base, net, secretKeyHex);
  const relays = new NostrRelays();
  const record = (r: { event: unknown; relays: string[] }, label: string) => post("/nostr/published", { event: r.event, relays: r.relays, label });
  try {
    onStep(`DataVendor publishes its profile and BTC-data offer to ${relays.relays.length} public Nostr relays`);
    const resource = `GET /services/btc-data/${seller.pubkey}`;
    await record(await relays.publishProfile(seller, "Sells BTC market data to AI agents over x402, paid in sats on Tachi."), "profile");
    const offerPub = await relays.publishOffer(seller, { serviceId: "btc-data", name: "BTC market data", about: "Latest BTC price and volume", priceSats: 50, resource, network: `tachi-${net.name}` });
    if (offerPub.relays.length === 0) throw new Error("No relay accepted the offer; check your internet connection");
    await record(offerPub, "service offer");
    await record(await relays.publishProfile(buyer, "Treasury agent: buys data and services for other agents, pays in sats on Tachi."), "profile");

    onStep("TreasuryBot searches the relays for BTC data sellers");
    let offer;
    let found = 0;
    for (let i = 0; i < 4 && !offer; i++) {
      const offers = await relays.findOffers();
      found = offers.length;
      offer = offers.find((o) => o.pubkey === seller.pubkey && o.serviceId === "btc-data");
      if (!offer) await new Promise((r) => setTimeout(r, 1500));
    }
    if (!offer) throw new Error("DataVendor's offer hasn't reached the relays yet; try again in a moment");
    onStep(`Found "${offer.name}" from DataVendor for ${offer.priceSats} sats (${found} offer${found === 1 ? "" : "s"} on the relays)`);

    const exchange = async (from: typeof buyer, to: typeof buyer, text: string) => {
      const sent = await relays.sendMessage(from, to.pubkey, text);
      await publish(from, "message", { to: to.pubkey, text, wrapId: sent.wrapId, relays: sent.relays });
      for (let i = 0; i < 5; i++) {
        const got = (await relays.readMessages(to)).find((m) => m.wrapId === sent.wrapId);
        if (got) {
          await publish(to, "message", { from: from.pubkey, text: got.text, wrapId: got.wrapId });
          return got.text;
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
      throw new Error(`${to.name} couldn't read the message from the relays yet`);
    };
    onStep("TreasuryBot messages DataVendor privately (NIP-17)");
    const question = "Hi DataVendor, is your BTC data endpoint live? I need hourly prices for a model.";
    await exchange(buyer, seller, question);
    onStep("DataVendor reads it from the relays and replies");
    const answer = `Yes: ${offer.priceSats} sats per request over x402 at ${resource}, settled on Tachi ${net.name}.`;
    await exchange(seller, buyer, answer);

    return { offer, offersFound: found, relays: relays.relays, conversation: [{ from: "TreasuryBot", text: question }, { from: "DataVendor", text: answer }] };
  } finally {
    relays.close();
  }
}

/** Anchors the event log's hash-chain root on Tachi: a 1-sat output to a key committing to it. */
export async function anchorLog(base: string, net: TachiNetwork, secretKeyHex: string, onStep: Step = () => {}) {
  const { post } = client(base);
  const { wallet } = await realAgents(base, net, secretKeyHex);
  const { root, count } = (await (await fetch(`${base}/audit/root`)).json()) as { root: string; count: number };
  if (count === 0) throw new Error("The event log is empty; there's nothing to anchor yet");
  onStep(`Hashing ${count} signed events into one root`);
  onStep(`Anchoring root ${root.slice(0, 12)}… on Tachi ${net.name}`);
  const paid = await wallet.pay({ toPubkey: anchorKey(wallet.pubkey, root), amountSats: 1, resource: "audit-anchor" });
  onStep("Server checks the anchor transaction on chain");
  const r = await post("/audit/anchors", { root, count, txRef: paid.txRef });
  if (!r.ok) throw new Error((await r.json()).error);
  return { root, count, txRef: paid.txRef, explorerUrl: `${net.explorerUrl}/tx/${paid.txRef}` };
}
