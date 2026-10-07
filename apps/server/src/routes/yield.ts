import { Router } from "express";
import { yieldVault } from "../world.js";

export const yieldRouter = Router();

yieldRouter.post("/yield/deposit", (req, res) => {
  const { pubkey, amountSats } = req.body ?? {};
  try {
    const shares = yieldVault.deposit(pubkey, amountSats);
    res.json({ shares, balanceSats: yieldVault.balanceOf(pubkey) });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

yieldRouter.post("/yield/withdraw", (req, res) => {
  const { pubkey, amountSats } = req.body ?? {};
  try {
    yieldVault.withdraw(pubkey, amountSats);
    res.json({ balanceSats: yieldVault.balanceOf(pubkey) });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

yieldRouter.post("/yield/rebalance", (req, res) => {
  const { maxRiskScore, elapsedSeconds } = req.body ?? {};
  try {
    const result = yieldVault.rebalance(maxRiskScore ?? 40, elapsedSeconds ?? 86400);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

yieldRouter.get("/yield/balance/:pubkey", (req, res) => {
  res.json({ balanceSats: yieldVault.balanceOf(req.params.pubkey) });
});

yieldRouter.get("/yield/summary", (_req, res) => {
  res.json(yieldVault.summary());
});
