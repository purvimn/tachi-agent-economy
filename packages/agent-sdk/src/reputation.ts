import type { EventLog } from "./eventLog.js";

export interface ReputationSummary {
  pubkey: string;
  completedJobs: number;
  paymentsSent: number;
  paymentsReceived: number;
  totalSatsSent: number;
  totalSatsReceived: number;
  avgRating: number | null;
  score: number;
}

interface PaymentContent {
  amountSats: number;
}
interface RatingContent {
  target: string;
  stars: number;
}

/** Reputation is a derived view over the signed event log, never separately stored — the log is the source of truth. */
export function computeReputation(log: EventLog, pubkey: string): ReputationSummary {
  const events = log.forAgent(pubkey);

  let completedJobs = 0;
  let paymentsSent = 0;
  let paymentsReceived = 0;
  let totalSatsSent = 0;
  let totalSatsReceived = 0;
  const ratings: number[] = [];

  for (const e of events) {
    if (e.kind === "job_completed") completedJobs++;
    if (e.kind === "payment_sent") {
      paymentsSent++;
      totalSatsSent += (JSON.parse(e.content) as PaymentContent).amountSats;
    }
    if (e.kind === "payment_received") {
      paymentsReceived++;
      totalSatsReceived += (JSON.parse(e.content) as PaymentContent).amountSats;
    }
  }
  // Ratings are signed by the rater and name the rated agent in `target`.
  for (const e of log.all()) {
    if (e.kind !== "rating") continue;
    const r = JSON.parse(e.content) as RatingContent;
    if (r.target === pubkey && e.agentPubkey !== pubkey) ratings.push(r.stars);
  }

  const avgRating = ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : null;

  // ponytail: reputation score is a simple weighted heuristic (jobs + rating), not a fraud-resistant
  // trust model. Upgrade to stake-weighted / decay-weighted scoring if the demo needs it to resist gaming.
  const score = Math.min(100, completedJobs * 2 + (avgRating ?? 3) * 15);

  return { pubkey, completedJobs, paymentsSent, paymentsReceived, totalSatsSent, totalSatsReceived, avgRating, score };
}
