import { Router } from "express";
import { nip19 } from "nostr-tools";
import { AgentIdentity, NostrRelays, type ServiceOffer } from "@tachi-hack/agent-sdk";
import { directory, eventLog, nostrPublished, paymentHistory } from "../world.js";
import { network } from "./daemon.js";

export const nostrRouter = Router();
const relays = new NostrRelays();

/** Agents report what they published to relays; only their own signed events are accepted. */
nostrRouter.post("/nostr/published", (req, res) => {
  const { event, relays: accepted, label } = req.body ?? {};
  if (!event || !AgentIdentity.verify(event)) {
    res.status(400).json({ error: "A validly signed Nostr event is required" });
    return;
  }
  nostrPublished.push({ pubkey: event.pubkey, kind: event.kind, label: String(label ?? event.kind), eventId: event.id, relays: Array.isArray(accepted) ? accepted : [], at: event.created_at });
  res.json({ ok: true });
});

// ponytail: 10s cache so the dashboard's polling doesn't hammer public relays.
let cache: { at: number; offers: ServiceOffer[] } | null = null;
nostrRouter.get("/nostr/services", async (_req, res) => {
  if (!cache || Date.now() - cache.at > 10_000) {
    try {
      cache = { at: Date.now(), offers: await relays.findOffers() };
    } catch (err) {
      res.status(502).json({ error: `Couldn't query the relays: ${(err as Error).message}` });
      return;
    }
  }
  res.json({ relays: relays.relays, offers: cache.offers.map((o) => ({ ...o, npub: nip19.npubEncode(o.pubkey) })) });
});

/** Everything about one agent, with every signature re-checked as it's read. */
nostrRouter.get("/agents/:pubkey/inspect", (req, res) => {
  const pubkey = req.params.pubkey;
  if (!/^[0-9a-f]{64}$/.test(pubkey)) {
    res.status(400).json({ error: "pubkey must be 64 hex characters" });
    return;
  }
  const npub = nip19.npubEncode(pubkey);
  const agent = directory.all().find((a) => a.agent.pubkey === pubkey);
  res.json({
    pubkey,
    npub,
    name: agent?.agent.name ?? null,
    nostrProfileUrl: `https://njump.me/${npub}`,
    reputation: directory.reputationOf(pubkey),
    events: eventLog.forAgent(pubkey).map((e) => ({
      id: e.id,
      kind: e.kind,
      content: e.content,
      createdAt: e.createdAt,
      signatureValid: AgentIdentity.verify(JSON.parse(JSON.stringify(e.raw))),
    })),
    payments: paymentHistory
      .filter((p) => p.fromPubkey === pubkey || p.toPubkey === pubkey)
      .map((p) => ({ ...p, explorerUrl: p.mode !== "simulated" ? `${network.explorerUrl}/tx/${p.txRef}` : undefined })),
    published: nostrPublished.filter((p) => p.pubkey === pubkey),
  });
});
