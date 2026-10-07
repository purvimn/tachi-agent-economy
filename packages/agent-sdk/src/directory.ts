import type { AgentIdentity } from "./identity.js";
import type { EventLog } from "./eventLog.js";
import { computeReputation, type ReputationSummary } from "./reputation.js";

export interface ServiceListing {
  pubkey: string;
  name: string;
  serviceId: string;
  priceSats: number;
  description: string;
}

/** In-memory registry agents use to discover each other before hiring/paying. */
export class AgentDirectory {
  private agents = new Map<string, AgentIdentity>();
  private listings: ServiceListing[] = [];

  constructor(private log: EventLog) {}

  register(agent: AgentIdentity): void {
    this.agents.set(agent.pubkey, agent);
  }

  listService(listing: ServiceListing): void {
    this.listings.push(listing);
  }

  findServices(serviceId?: string): ServiceListing[] {
    return serviceId ? this.listings.filter((l) => l.serviceId === serviceId) : this.listings;
  }

  reputationOf(pubkey: string): ReputationSummary {
    return computeReputation(this.log, pubkey);
  }

  all(): { agent: AgentIdentity; reputation: ReputationSummary }[] {
    return [...this.agents.values()].map((agent) => ({ agent, reputation: this.reputationOf(agent.pubkey) }));
  }
}
