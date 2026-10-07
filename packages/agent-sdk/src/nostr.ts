import { SimplePool, useWebSocketImplementation } from "nostr-tools/pool";
import * as nip17 from "nostr-tools/nip17";
import type { Event, EventTemplate, Filter } from "nostr-tools";
import WebSocket from "ws";
import type { AgentIdentity } from "./identity.js";

// Node's built-in WebSocket sends nostr-tools 2.25 into infinite recursion when a relay connection
// fails; the `ws` implementation fails cleanly.
useWebSocketImplementation(WebSocket);

export const DEFAULT_RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"];
/** Tag on every service offer, so agents of this economy can find each other on public relays. */
export const APP_TAG = "tachi-agent-economy";

let guarded = false;
/**
 * `ws` still throws one uncatchable error when a relay drops before connecting. Swallow exactly
 * that, so one flaky relay can't take a server down; everything else still crashes as usual.
 */
function guardRelayDrops() {
  if (guarded) return;
  guarded = true;
  process.on("uncaughtException", (err) => {
    if (/WebSocket was closed before the connection was established/.test(err?.message)) {
      console.warn(`[nostr] a relay connection dropped: ${err.message}`);
      return;
    }
    throw err;
  });
}

export interface ServiceOffer {
  pubkey: string;
  serviceId: string;
  name: string;
  about: string;
  priceSats: number;
  /** x402 resource, e.g. "GET /services/btc-data/<pubkey>". */
  resource: string;
  network: string;
  eventId: string;
  createdAt: number;
}

export class NostrRelays {
  readonly pool = new SimplePool();

  constructor(readonly relays: string[] = process.env.NOSTR_RELAYS?.split(",").filter(Boolean) ?? DEFAULT_RELAYS) {
    guardRelayDrops();
  }

  /** Publishes to every relay; returns the relays that accepted it. */
  async publish(event: Event): Promise<string[]> {
    const results = await Promise.allSettled(this.pool.publish(this.relays, event));
    return this.relays.filter((_, i) => results[i].status === "fulfilled");
  }

  private async publishSigned(agent: AgentIdentity, t: EventTemplate) {
    const event = agent.sign(t);
    return { event, relays: await this.publish(event) };
  }

  query(filter: Filter, maxWait = 4000): Promise<Event[]> {
    return this.pool.querySync(this.relays, filter, { maxWait });
  }

  /** Kind 0 profile, so the agent shows up by name in any Nostr client. */
  publishProfile(agent: AgentIdentity, about: string) {
    return this.publishSigned(agent, template(0, JSON.stringify({ name: agent.name, about }), [["t", APP_TAG]]));
  }

  /** NIP-89 handler information (kind 31990, replaceable per serviceId): what the agent sells and where. */
  publishOffer(agent: AgentIdentity, offer: Omit<ServiceOffer, "pubkey" | "eventId" | "createdAt">) {
    const content = JSON.stringify({ name: offer.name, about: offer.about, priceSats: offer.priceSats, resource: offer.resource, network: offer.network });
    return this.publishSigned(agent, template(31990, content, [["d", offer.serviceId], ["t", APP_TAG], ["price", String(offer.priceSats), "sats"]]));
  }

  /** Service offers from this economy's agents, newest per (agent, service). */
  async findOffers(): Promise<ServiceOffer[]> {
    const events = await this.query({ kinds: [31990], "#t": [APP_TAG], limit: 100 });
    const latest = new Map<string, ServiceOffer>();
    for (const e of events) {
      try {
        const c = JSON.parse(e.content);
        const serviceId = e.tags.find((t) => t[0] === "d")?.[1] ?? "";
        const key = `${e.pubkey}:${serviceId}`;
        if ((latest.get(key)?.createdAt ?? 0) >= e.created_at) continue;
        latest.set(key, { pubkey: e.pubkey, serviceId, name: c.name, about: c.about, priceSats: c.priceSats, resource: c.resource, network: c.network, eventId: e.id, createdAt: e.created_at });
      } catch {
        // not one of ours
      }
    }
    return [...latest.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  /** NIP-17 private message (gift-wrapped, kind 1059). Returns the wrap id and accepting relays. */
  async sendMessage(from: AgentIdentity, toPubkey: string, text: string) {
    const wrap = nip17.wrapEvent(from.secretKeyBytes(), { publicKey: toPubkey }, text);
    return { wrapId: wrap.id, relays: await this.publish(wrap) };
  }

  /** NIP-17 messages addressed to `me`, opened with its key. */
  async readMessages(me: AgentIdentity): Promise<{ wrapId: string; from: string; text: string; createdAt: number }[]> {
    const wraps = await this.query({ kinds: [1059], "#p": [me.pubkey], limit: 50 });
    return wraps.flatMap((w) => {
      try {
        const rumor = nip17.unwrapEvent(w, me.secretKeyBytes());
        return [{ wrapId: w.id, from: rumor.pubkey, text: rumor.content, createdAt: rumor.created_at }];
      } catch {
        return [];
      }
    });
  }

  close() {
    this.pool.close(this.relays);
  }
}

const template = (kind: number, content: string, tags: string[][]): EventTemplate => ({ kind, content, tags, created_at: Math.floor(Date.now() / 1000) });
