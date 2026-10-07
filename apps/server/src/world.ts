import { EventLog, AgentDirectory, SimulatedPaymentProvider, YieldVault, DEFAULT_STRATEGIES, Budget, type PaymentResult } from "@tachi-hack/agent-sdk";

/**
 * Shared server-side state: the signed event log, agent directory, payment ledger, and yield
 * vault. A real deployment would split this across services; one process is enough for a demo.
 */
export const eventLog = new EventLog();
export const directory = new AgentDirectory(eventLog);
export const paymentProvider = new SimulatedPaymentProvider();
export const yieldVault = new YieldVault(DEFAULT_STRATEGIES);

/** txRef -> settled payment, used by x402 middleware to verify a client's payment proof. */
export const settledPayments = new Map<string, PaymentResult>();

/** pubkey -> spending policy. Agents without one are uncapped. */
export const budgets = new Map<string, Budget>();

/** Tachi txRefs ever registered via /pay — a chain payment can back exactly one request. */
export const claimedTxRefs = new Set<string>();

/** What agents published to Nostr relays (verified signed events), for the agent inspector. */
export const nostrPublished: { pubkey: string; kind: number; label: string; eventId: string; relays: string[]; at: number }[] = [];

/** Event-log roots anchored on Tachi (see routes/audit.ts). */
export const anchors: { root: string; count: number; txRef: string; at: number }[] = [];

/** Every payment accepted by /pay, oldest first — the dashboard's settlement history. */
export const paymentHistory: PaymentResult[] = [];
