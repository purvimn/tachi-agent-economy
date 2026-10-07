import { Router } from "express";
import { requirePayment } from "../x402.js";

export const servicesRouter = Router();

// Example paid services agents can call — each is gated by the x402 middleware.
// payToPubkey values are placeholders for demo service-provider agents created in demo/run.ts.

servicesRouter.get("/services/btc-data/:providerPubkey", requirePaymentFromParam(50), (req, res) => {
  res.json({
    btc_price: 112430,
    volume: 184230,
    source: req.params.providerPubkey,
    fetchedAt: new Date().toISOString(),
  });
});

servicesRouter.get("/services/search/:providerPubkey", requirePaymentFromParam(20), (req, res) => {
  res.json({ results: ["result A", "result B", "result C"], source: req.params.providerPubkey });
});

servicesRouter.get("/services/inference/:providerPubkey", requirePaymentFromParam(150), (req, res) => {
  res.json({ output: "inference result", source: req.params.providerPubkey });
});

function requirePaymentFromParam(priceSats: number) {
  return requirePayment((req) => ({ priceSats, payToPubkey: String(req.params.providerPubkey) }));
}
