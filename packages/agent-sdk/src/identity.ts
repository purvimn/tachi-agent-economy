import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent, type Event, type EventTemplate } from "nostr-tools";

/** A Tachi agent's Nostr-based identity. Every action the agent takes is signed with this key. */
export class AgentIdentity {
  readonly name: string;
  readonly pubkey: string;
  private readonly secretKey: Uint8Array;

  constructor(name: string, secretKey: Uint8Array = generateSecretKey()) {
    this.name = name;
    this.secretKey = secretKey;
    this.pubkey = getPublicKey(secretKey);
  }

  secretKeyBytes(): Uint8Array {
    return this.secretKey;
  }

  /** Sign an event template (kind + content + tags) as this agent. */
  sign(template: EventTemplate): Event {
    return finalizeEvent(template, this.secretKey);
  }

  static verify(event: Event): boolean {
    return verifyEvent(event);
  }
}
