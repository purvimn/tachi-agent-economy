import Database from "better-sqlite3";
import type { Event } from "nostr-tools";

export type EventKind = "service_call" | "payment_sent" | "payment_received" | "job_completed" | "rating" | "message";

export interface LoggedEvent {
  id: string;
  agentPubkey: string;
  kind: EventKind;
  content: string;
  sig: string;
  createdAt: number;
  raw: Event;
}

/**
 * Append-only, signature-verified log of every agent action. This is the "audit trail" —
 * reputation and payment history are both derived views over this log, never separate state.
 */
export class EventLog {
  private db: Database.Database;

  constructor(path: string = ":memory:") {
    this.db = new Database(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        agent_pubkey TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        sig TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        raw TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_agent ON events(agent_pubkey);
    `);
  }

  append(event: Event, kind: EventKind): LoggedEvent {
    this.db
      .prepare(
        `INSERT INTO events (id, agent_pubkey, kind, content, sig, created_at, raw)
         VALUES (@id, @agent_pubkey, @kind, @content, @sig, @created_at, @raw)`
      )
      .run({
        id: event.id,
        agent_pubkey: event.pubkey,
        kind,
        content: event.content,
        sig: event.sig,
        created_at: event.created_at,
        raw: JSON.stringify(event),
      });
    return this.toLoggedEvent(event, kind);
  }

  forAgent(pubkey: string): LoggedEvent[] {
    const rows = this.db
      .prepare(`SELECT raw, kind FROM events WHERE agent_pubkey = ? ORDER BY rowid ASC`)
      .all(pubkey) as { raw: string; kind: EventKind }[];
    return rows.map((r) => this.toLoggedEvent(JSON.parse(r.raw), r.kind));
  }

  all(): LoggedEvent[] {
    // Append order (rowid), not timestamps: the audit hash chain depends on a stable order.
    const rows = this.db.prepare(`SELECT raw, kind FROM events ORDER BY rowid ASC`).all() as {
      raw: string;
      kind: EventKind;
    }[];
    return rows.map((r) => this.toLoggedEvent(JSON.parse(r.raw), r.kind));
  }

  private toLoggedEvent(event: Event, kind: EventKind): LoggedEvent {
    return {
      id: event.id,
      agentPubkey: event.pubkey,
      kind,
      content: event.content,
      sig: event.sig,
      createdAt: event.created_at,
      raw: event,
    };
  }
}
