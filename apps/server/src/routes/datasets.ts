import { randomUUID, randomBytes, createHash, createCipheriv, createDecipheriv } from "node:crypto";
import { Router } from "express";
import { AgentIdentity, sealFor } from "@tachi-hack/agent-sdk";
import { requirePayment } from "../x402.js";
import { directory, eventLog } from "../world.js";

export const datasetsRouter = Router();

interface DatasetRecord {
  id: string;
  providerPubkey: string;
  title: string;
  description: string;
  priceSats: number;
  sizeBytes: number;
  contentHash: string;
  encrypted: Buffer;
  iv: Buffer;
  authTag: Buffer;
  key: Buffer;
  createdAt: number;
}

// ponytail: in-memory marketplace, same lifetime tradeoff as the rest of world.ts state.
const datasets = new Map<string, DatasetRecord>();
/** datasetId -> buyers whose payment was verified; only they can rate it. */
const buyers = new Map<string, Set<string>>();

interface DatasetRating {
  target: string;
  datasetId: string;
  stars: number;
  comment?: string;
}

/** Quality score from buyers' signed ratings in the event log (latest rating per buyer counts). */
function qualityOf(id: string) {
  const latest = new Map<string, number>();
  for (const e of eventLog.all()) {
    if (e.kind !== "rating") continue;
    const r = JSON.parse(e.content) as DatasetRating;
    if (r.datasetId === id) latest.set(e.agentPubkey, r.stars);
  }
  const stars = [...latest.values()];
  return { avg: stars.length ? stars.reduce((a, b) => a + b, 0) / stars.length : null, count: stars.length };
}

function toListing(d: DatasetRecord) {
  return {
    sold: buyers.get(d.id)?.size ?? 0,
    rating: qualityOf(d.id),
    id: d.id,
    providerPubkey: d.providerPubkey,
    title: d.title,
    description: d.description,
    priceSats: d.priceSats,
    sizeBytes: d.sizeBytes,
    contentHash: d.contentHash,
    createdAt: d.createdAt,
  };
}

/** Provider lists a dataset. Content is encrypted at rest; only released after a verified payment. */
datasetsRouter.post("/datasets", (req, res) => {
  const { providerPubkey, title, description, priceSats, content } = req.body ?? {};
  if (!providerPubkey || !title || !priceSats || typeof content !== "string") {
    res.status(400).json({ error: "providerPubkey, title, priceSats, content are required" });
    return;
  }

  const id = randomUUID();
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(content, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const contentHash = createHash("sha256").update(content, "utf8").digest("hex");

  const record: DatasetRecord = {
    id,
    providerPubkey,
    title,
    description: description ?? "",
    priceSats,
    sizeBytes: Buffer.byteLength(content, "utf8"),
    contentHash,
    encrypted,
    iv,
    authTag,
    key,
    createdAt: Math.floor(Date.now() / 1000),
  };
  datasets.set(id, record);

  // Also surface it through the general service directory so it's discoverable alongside other listings.
  directory.listService({ pubkey: providerPubkey, name: title, serviceId: `dataset:${id}`, priceSats, description: description ?? "" });

  res.json(toListing(record));
});

datasetsRouter.get("/datasets", (_req, res) => {
  res.json([...datasets.values()].map(toListing));
});

datasetsRouter.get("/datasets/:id", (req, res) => {
  const record = datasets.get(String(req.params.id));
  if (!record) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(toListing(record));
});

/**
 * x402-gated dataset delivery: price and payee resolved per listing. The content is sealed to the
 * verified payer's Nostr key (NIP-44), so only the buyer can read it; the hash lets them check it.
 */
datasetsRouter.get(
  "/datasets/:id/purchase",
  requirePayment((req) => {
    const record = datasets.get(String(req.params.id));
    return record ? { priceSats: record.priceSats, payToPubkey: record.providerPubkey } : null;
  }),
  (req, res) => {
    const record = datasets.get(String(req.params.id))!;
    const decipher = createDecipheriv("aes-256-gcm", record.key, record.iv);
    decipher.setAuthTag(record.authTag);
    const content = Buffer.concat([decipher.update(record.encrypted), decipher.final()]).toString("utf8");
    const payer = res.locals.payer as string;
    if (!buyers.has(record.id)) buyers.set(record.id, new Set());
    buyers.get(record.id)!.add(payer);
    res.json({ contentHash: record.contentHash, delivery: sealFor(payer, content) });
  },
);

/** A buyer rates a dataset with a signed Nostr event: content { target, datasetId, stars 1-5, comment? }. */
datasetsRouter.post("/datasets/:id/ratings", (req, res) => {
  const record = datasets.get(String(req.params.id));
  const event = req.body?.event;
  if (!record) {
    res.status(404).json({ error: "not found" });
    return;
  }
  if (!event || !AgentIdentity.verify(event)) {
    res.status(400).json({ error: "A rating must be a validly signed Nostr event" });
    return;
  }
  if (!buyers.get(record.id)?.has(event.pubkey)) {
    res.status(403).json({ error: "Only buyers who paid for this dataset can rate it" });
    return;
  }
  let r: DatasetRating;
  try {
    r = JSON.parse(event.content);
  } catch {
    res.status(400).json({ error: "Rating content must be JSON" });
    return;
  }
  if (r.datasetId !== record.id || r.target !== record.providerPubkey || !Number.isInteger(r.stars) || r.stars < 1 || r.stars > 5) {
    res.status(400).json({ error: "Rating needs this datasetId, the provider as target, and 1-5 stars" });
    return;
  }
  eventLog.append(event, "rating");
  res.json(qualityOf(record.id));
});
