import { randomUUID } from "node:crypto";
import { Router } from "express";
import { requirePayment } from "../x402.js";
import { directory } from "../world.js";

export const merchantsRouter = Router();

interface ProductRecord {
  id: string;
  merchantPubkey: string;
  title: string;
  description: string;
  priceSats: number;
  /** Held back until an x402-verified payment; the thing the buyer is actually paying for. */
  fulfillment: string;
  unitsSold: number;
  createdAt: number;
}

// ponytail: in-memory catalog, same lifetime tradeoff as the rest of world.ts state.
const products = new Map<string, ProductRecord>();

function toListing(p: ProductRecord) {
  const { fulfillment, ...pub } = p;
  return pub;
}

/** Merchant lists a product. `fulfillment` is withheld until payment clears. */
merchantsRouter.post("/products", (req, res) => {
  const { merchantPubkey, title, description, priceSats, fulfillment } = req.body ?? {};
  if (!merchantPubkey || !title || !priceSats || typeof fulfillment !== "string") {
    res.status(400).json({ error: "merchantPubkey, title, priceSats, fulfillment are required" });
    return;
  }

  const id = randomUUID();
  const record: ProductRecord = {
    id,
    merchantPubkey,
    title,
    description: description ?? "",
    priceSats,
    fulfillment,
    unitsSold: 0,
    createdAt: Math.floor(Date.now() / 1000),
  };
  products.set(id, record);

  // Surface it through the shared directory so agents discover products alongside services/datasets.
  directory.listService({ pubkey: merchantPubkey, name: title, serviceId: `product:${id}`, priceSats, description: description ?? "" });

  res.json(toListing(record));
});

merchantsRouter.get("/products", (_req, res) => {
  res.json([...products.values()].map(toListing));
});

merchantsRouter.get("/products/:id", (req, res) => {
  const record = products.get(String(req.params.id));
  if (!record) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(toListing(record));
});

/** x402-gated checkout: price and payee resolved per product; returns a receipt + the fulfillment payload. */
merchantsRouter.get(
  "/products/:id/checkout",
  requirePayment((req) => {
    const record = products.get(String(req.params.id));
    return record ? { priceSats: record.priceSats, payToPubkey: record.merchantPubkey } : null;
  }),
  (req, res) => {
    const record = products.get(String(req.params.id))!;
    record.unitsSold += 1;
    res.json({
      receipt: {
        productId: record.id,
        merchantPubkey: record.merchantPubkey,
        priceSats: record.priceSats,
        txRef: res.locals.txRef as string,
        paidAt: Math.floor(Date.now() / 1000),
      },
      fulfillment: record.fulfillment,
    });
  },
);
