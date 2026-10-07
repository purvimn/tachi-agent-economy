import { useEffect, useRef, useState, type ReactNode } from "react";

interface Reputation {
  completedJobs: number;
  totalSatsSent: number;
  totalSatsReceived: number;
  score: number;
}
interface AgentEntry {
  agent: { pubkey: string; name: string };
  reputation: Reputation;
}
interface LoggedEvent {
  id: string;
  agentPubkey: string;
  kind: string;
  content: string;
  createdAt: number;
}
interface YieldSummary {
  totalAssetsSats: number;
  depositorCount: number;
  allocatedStrategy: { name: string; aprBps: number; riskScore: number } | null;
}
interface Listing {
  id: string;
  title: string;
  description: string;
  priceSats: number;
  providerPubkey?: string;
  merchantPubkey?: string;
  sizeBytes?: number;
  unitsSold?: number;
  sold?: number;
  rating?: { avg: number | null; count: number };
}
interface Offer {
  pubkey: string;
  npub: string;
  name: string;
  about: string;
  priceSats: number;
  resource: string;
  network: string;
  createdAt: number;
}
interface Anchor {
  root: string;
  count: number;
  txRef: string;
  at: number;
  matchesLog: boolean;
  explorerUrl: string;
}
interface Inspection {
  npub: string;
  name: string | null;
  nostrProfileUrl: string;
  events: { id: string; kind: string; content: string; createdAt: number; signatureValid: boolean }[];
  payments: Payment[];
  published: { label: string; eventId: string; relays: string[] }[];
}

/** One agent, opened from the directory: identity, what it published, paid, and signed. */
function Inspector({ pubkey, who, txUrl, onClose }: { pubkey: string; who: (pk: string) => string; txUrl: (h: string) => string; onClose: () => void }) {
  const [data, setData] = useState<Inspection | null>(null);
  useEffect(() => {
    const load = () => getJson(`/agents/${pubkey}/inspect`).then(setData, () => {});
    load();
    const id = setInterval(load, 4000);
    return () => clearInterval(id);
  }, [pubkey]);
  if (!data) return <p className="mt-6 text-ink-2">Loading {who(pubkey)}…</p>;
  const valid = data.events.filter((e) => e.signatureValid).length;
  return (
    <div className="mt-6 border-l-4 border-ink bg-paper-2 px-5 py-4">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h3 className="text-lg font-bold">{data.name ?? "Unregistered agent"}</h3>
        <a href={data.nostrProfileUrl} target="_blank" rel="noreferrer" className="font-mono text-[13px] text-ink-2">
          {short(data.npub, 24)}
        </a>
        <button onClick={onClose} className="ml-auto text-sm text-ink-2 underline decoration-rule underline-offset-[3px] hover:text-ink">
          Close
        </button>
      </div>
      <p className="mt-2 text-sm">
        {data.events.length === 0 ? "No signed events yet." : `${valid} of ${data.events.length} signed events verify against this key.`}{" "}
        {data.published.length > 0 &&
          `Published on Nostr: ${data.published.map((p) => `${p.label} (${p.relays.length} relay${p.relays.length === 1 ? "" : "s"})`).join(", ")}.`}
      </p>
      {data.payments.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm">
          {data.payments.length > 5 && <li className="text-ink-2">Latest 5 of {data.payments.length} payments:</li>}
          {data.payments.slice(-5).reverse().map((p) => (
            <li key={p.txRef}>
              {who(p.fromPubkey)} paid {who(p.toPubkey)} {fmt(p.amountSats)} sats{" "}
              {p.mode !== "simulated" ? (
                <a href={txUrl(p.txRef)} target="_blank" rel="noreferrer" className="font-mono text-[12px] text-btc-ink">
                  {short(p.txRef, 10)}
                </a>
              ) : (
                <span className="text-ink-2">(simulated)</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {data.events.length > 0 && (
        <table className="ledger mt-4">
          <thead>
            <tr>
              <th>Action</th>
              <th>Details</th>
              <th>Signature</th>
            </tr>
          </thead>
          <tbody>
            {data.events
              .slice()
              .reverse()
              .map((e) => {
                let text = e.content;
                try {
                  const c = JSON.parse(e.content);
                  if (c.text) text = `${c.to ? `to ${who(c.to)}` : `from ${who(c.from)}`}: "${c.text}"`;
                } catch {
                  // plain text
                }
                return (
                  <tr key={e.id}>
                    <td className="whitespace-nowrap">{e.kind.replace(/_/g, " ")}</td>
                    <td className="max-w-[44ch] truncate text-sm text-ink-2">{text}</td>
                    <td className={e.signatureValid ? "text-ok" : "text-red-700"}>{e.signatureValid ? "Valid" : "Invalid"}</td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      )}
    </div>
  );
}
interface Payment {
  txRef: string;
  amountSats: number;
  fromPubkey: string;
  toPubkey: string;
  settledAt: number;
  mode: "simulated" | "regtest" | "signet";
  resource?: string;
  explorerUrl?: string;
}
interface Vtxo {
  id: string;
  owner: string;
  amount: number;
  spent: boolean;
  height: number;
}

const fmt = (n: number) => Math.round(n).toLocaleString();
const short = (s: string, n = 8) => (s.length > n + 2 ? `${s.slice(0, n)}…` : s);
const isTxHash = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const getJson = (path: string) => fetch(path).then((r) => (r.ok ? r.json() : Promise.reject(new Error(path))));

/* ---------- payment graph: the one loud element on the page ---------- */

const W = 640;
const H = 440;

function AgentGraph({ pubkeys, names, payments }: { pubkeys: string[]; names: Map<string, string>; payments: Payment[] }) {
  const pos = new Map<string, { x: number; y: number; ux: number; uy: number }>();
  pubkeys.forEach((pk, i) => {
    const a = -Math.PI / 2 + (i / Math.max(pubkeys.length, 1)) * Math.PI * 2;
    const ux = Math.cos(a);
    const uy = Math.sin(a);
    pos.set(pk, { x: W / 2 + ux * 180, y: H / 2 + uy * 165, ux, uy });
  });

  const edges = new Map<string, { from: string; to: string; sats: number; onChain: boolean }>();
  const volume = new Map<string, number>();
  for (const p of payments) {
    const key = `${p.fromPubkey}>${p.toPubkey}`;
    const e = edges.get(key) ?? { from: p.fromPubkey, to: p.toPubkey, sats: 0, onChain: false };
    e.sats += p.amountSats;
    e.onChain ||= p.mode !== "simulated";
    edges.set(key, e);
    volume.set(p.fromPubkey, (volume.get(p.fromPubkey) ?? 0) + p.amountSats);
    volume.set(p.toPubkey, (volume.get(p.toPubkey) ?? 0) + p.amountSats);
  }

  // Bend each edge to the right of its direction so A→B and B→A never overlap.
  const pathFor = (from: string, to: string) => {
    const a = pos.get(from);
    const b = pos.get(to);
    if (!a || !b) return null;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const bend = 34;
    return `M${a.x},${a.y} Q${mx - (dy / len) * bend},${my + (dx / len) * bend} ${b.x},${b.y}`;
  };

  // One travelling dot per *new* payment. The first load is history, not news.
  const seen = useRef<Set<string> | null>(null);
  const [pulses, setPulses] = useState<{ id: string; d: string; onChain: boolean }[]>([]);
  useEffect(() => {
    if (!seen.current) {
      // Wait for the first real response before deciding what counts as history.
      if (payments.length > 0) seen.current = new Set(payments.map((p) => p.txRef));
      return;
    }
    const fresh = payments.filter((p) => !seen.current!.has(p.txRef));
    fresh.forEach((p) => seen.current!.add(p.txRef));
    if (!fresh.length || reducedMotion()) return;
    const add = fresh.flatMap((p) => {
      const d = pathFor(p.fromPubkey, p.toPubkey);
      return d ? [{ id: p.txRef, d, onChain: p.mode !== "simulated" }] : [];
    });
    setPulses((cur) => [...cur, ...add]);
    // Not cleared on re-render: the 3s poll would otherwise cancel it and strand the dot.
    setTimeout(() => setPulses((cur) => cur.filter((x) => !add.includes(x))), 1800);
  }, [payments]); // eslint-disable-line react-hooks/exhaustive-deps

  if (pubkeys.length === 0) {
    return (
      <div className="flex aspect-[16/11] items-center justify-center border border-dashed border-rule text-ink-2">
        No agents yet. Use Add demo agents above.
      </div>
    );
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Payments between agents">
      <defs>
        <marker id="tip-btc" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto">
          <path d="M0,0 L10,5 L0,10 z" fill="var(--color-btc)" />
        </marker>
        <marker id="tip-sim" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto">
          <path d="M0,0 L10,5 L0,10 z" fill="var(--color-ink-2)" />
        </marker>
      </defs>

      {[...edges.values()].map((e) => {
        const d = pathFor(e.from, e.to);
        if (!d) return null;
        return (
          <path
            key={`${e.from}>${e.to}`}
            d={d}
            fill="none"
            stroke={e.onChain ? "var(--color-btc)" : "var(--color-ink-2)"}
            strokeOpacity={e.onChain ? 1 : 0.55}
            strokeWidth={1.25 + Math.log10(e.sats + 1)}
            strokeDasharray={e.onChain ? undefined : "5 5"}
            markerEnd={`url(#${e.onChain ? "tip-btc" : "tip-sim"})`}
          >
            <title>
              {names.get(e.from) ?? short(e.from)} paid {names.get(e.to) ?? short(e.to)} {fmt(e.sats)} sats
            </title>
          </path>
        );
      })}

      {pulses.map((p) => (
        <circle key={p.id} r="5" fill={p.onChain ? "var(--color-btc)" : "var(--color-ink)"}>
          <animateMotion ref={(el) => (el as SVGAnimationElement | null)?.beginElement()} begin="indefinite" dur="1.4s" fill="freeze" path={p.d} />
        </circle>
      ))}

      {pubkeys.map((pk) => {
        const p = pos.get(pk)!;
        const r = Math.min(16, 6 + Math.sqrt(volume.get(pk) ?? 0) / 3);
        const anchor = Math.abs(p.ux) < 0.25 ? "middle" : p.ux > 0 ? "start" : "end";
        return (
          <g key={pk}>
            <circle cx={p.x} cy={p.y} r={r} fill="var(--color-paper-2)" stroke="var(--color-ink)" strokeWidth="1.5" />
            <text
              x={p.x + p.ux * (r + 10)}
              y={p.y + p.uy * (r + 10) + (Math.abs(p.ux) < 0.25 ? (p.uy > 0 ? 10 : -2) : 5)}
              textAnchor={anchor}
              className="fill-ink text-[15px] font-semibold"
            >
              {names.get(pk) ?? short(pk)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/* ---------- small pieces ---------- */

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="grid gap-4 border-t border-ink pt-6 md:grid-cols-12 md:gap-8">
      <div className="md:col-span-3">
        <h2 className="text-xl font-bold tracking-tight">{title}</h2>
        {aside && <p className="mt-2 max-w-[28ch] text-sm leading-relaxed text-ink-2">{aside}</p>}
      </div>
      <div className="min-w-0 overflow-x-auto md:col-span-9">{children}</div>
    </section>
  );
}

function Settlement({ p, txUrl }: { p: Payment; txUrl: (h: string) => string }) {
  if (p.mode === "simulated") return <span className="text-sm text-ink-2">simulated</span>;
  return (
    <a href={p.explorerUrl ?? txUrl(p.txRef)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 font-mono text-[13px] text-btc-ink">
      <span aria-hidden className="inline-block size-2 bg-btc" />
      {short(p.txRef, 10)}
    </a>
  );
}

/* ---------- run panel: everything the CLI did, from the page ---------- */

interface Treasury {
  network: string;
  configured: boolean;
  pubkey?: string;
  l1Address?: string;
  balanceSats?: number | null;
  explorerUrl: string;
  l1ExplorerUrl: string | null;
}
type Action = "seed" | "pay" | "burst" | "dataset" | "nostr" | "anchor" | "fund";
interface Job {
  action: Action;
  status: "running" | "done" | "failed";
  steps: string[];
  error?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result?: Record<string, any>;
}

/** What a finished action proved, in a sentence or two. */
function JobResult({ job }: { job: Job }) {
  const r = job.result ?? {};
  const tx = r.explorerUrl && (
    <a href={r.explorerUrl} target="_blank" rel="noreferrer" className="font-normal text-ink">
      View the transaction
    </a>
  );
  switch (job.action) {
    case "seed":
      return <>Demo agents added.</>;
    case "pay":
      return (
        <>
          Payment settled and verified.{" "}
          <span className="font-normal text-ink-2">
            {r.replayRejected && r.theftRejected ? "Replaying the proof and a stranger's claim on it were both rejected. " : ""}
          </span>
          {tx}
        </>
      );
    case "burst":
      return (
        <>
          {r.served} of {r.count} paid requests served in {Number(r.seconds).toFixed(1)}s.{" "}
          <span className="font-normal text-ink-2">
            That's {Number(r.perSecond).toFixed(1)} payments a second, {fmt(r.satsPaid)} sats plus {fmt(r.feesSats)} sats in fees, each one a
            real Tachi transfer.
          </span>
        </>
      );
    case "dataset":
      return (
        <>
          Dataset bought and verified.{" "}
          <span className="font-normal text-ink-2">
            Delivered sealed to TreasuryBot's key, opened, and its {r.rows} rows match the hash. Rated {r.quality?.avg} out of 5.{" "}
          </span>
          {tx}
        </>
      );
    case "nostr":
      return (
        <>
          Found DataVendor on Nostr and agreed terms privately.
          <span className="mt-2 block space-y-1 font-normal text-ink">
            {(r.conversation ?? []).map((m: { from: string; text: string }, i: number) => (
              <span key={i} className="block">
                <span className="font-semibold">{m.from}:</span> {m.text}
              </span>
            ))}
          </span>
        </>
      );
    case "anchor":
      return (
        <>
          Anchored {r.count} events on Tachi. {tx}
        </>
      );
    default:
      return (
        <>
          Deposit committed. {tx}
        </>
      );
  }
}

const MIN_BALANCE = 100;

function RunPanel({ onChange }: { onChange: () => void }) {
  const [treasury, setTreasury] = useState<Treasury | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [txid, setTxid] = useState("");
  const [formError, setFormError] = useState("");
  const [copied, setCopied] = useState(false);
  const running = job?.status === "running";

  const loadTreasury = () => getJson("/demo/treasury").then(setTreasury, () => {});
  useEffect(() => {
    loadTreasury();
    getJson("/demo/job").then(setJob, () => {});
    const id = setInterval(loadTreasury, 5000);
    return () => clearInterval(id);
  }, []);

  // Poll the job quickly while it runs; refresh everything once it finishes.
  useEffect(() => {
    if (!running) return;
    const id = setInterval(async () => {
      const j: Job = await getJson("/demo/job");
      setJob(j);
      if (j.status !== "running") {
        loadTreasury();
        onChange();
      }
    }, 1000);
    return () => clearInterval(id);
  }, [running]); // eslint-disable-line react-hooks/exhaustive-deps

  async function run(path: string, body?: unknown) {
    setFormError("");
    const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
    if (!r.ok) {
      setFormError((await r.json()).error ?? `Request failed (${r.status})`);
      return;
    }
    setJob({ action: path.split("/").pop() as Action, status: "running", steps: [] });
  }

  async function createTreasury() {
    await fetch("/demo/treasury", { method: "POST" });
    loadTreasury();
  }

  const funded = (treasury?.balanceSats ?? 0) >= MIN_BALANCE;
  const net = treasury?.network ?? "regtest";

  return (
    <div className="mb-14 grid gap-8 border-y border-ink py-6 lg:grid-cols-12">
      <div className="lg:col-span-7">
        <div className="flex flex-wrap gap-3">
          <button
            disabled={running || !funded}
            onClick={() => run("/demo/pay")}
            className="rounded-[3px] bg-btc px-5 py-2.5 font-semibold text-ink transition-colors hover:bg-[#d4760a] disabled:cursor-not-allowed disabled:opacity-40"
          >
            Make a real payment
          </button>
          {(
            [
              ["/demo/nostr", "Find a seller on Nostr", false],
              ["/demo/dataset", "Buy a dataset", true],
              ["/demo/burst", "Run 25 paid requests", true],
              ["/demo/anchor", "Anchor the log on Tachi", true],
              ["/demo/seed", "Add demo agents", false],
            ] as const
          ).map(([path, label, needsFunds]) => (
            <button
              key={path}
              disabled={running || (needsFunds && !funded)}
              onClick={() => run(path, path.endsWith("burst") ? { count: 25 } : undefined)}
              className="rounded-[3px] border border-ink px-4 py-2.5 font-semibold hover:bg-paper-2 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {label}
            </button>
          ))}
        </div>
        <p className="mt-3 max-w-[62ch] text-sm leading-relaxed text-ink-2">
          Everything except demo agents runs as TreasuryBot and settles on Tachi {net}. Sellers are found on public Nostr relays;
          demo agents trade with each other in simulation.
        </p>
        {formError && <p className="mt-3 border-l-4 border-red-600 pl-3 text-sm">{formError}</p>}
        {job && (
          <div className="mt-4 text-sm" aria-live="polite">
            <ol className="space-y-1">
              {job.steps.map((s, i) => (
                <li key={i} className={i === job.steps.length - 1 && running ? "text-ink" : "text-ink-2"}>
                  <span className="mr-2 inline-block w-4 text-right tabular-nums text-ink-2">{i + 1}</span>
                  {s}
                  {i === job.steps.length - 1 && running && <span className="ml-1 animate-pulse">…</span>}
                </li>
              ))}
              {running && job.steps.length === 0 && <li className="text-ink-2">Starting…</li>}
            </ol>
            {job.status === "done" && (
              <p className="mt-2 max-w-[64ch] font-semibold text-ok">
                <JobResult job={job} />
              </p>
            )}
            {job.status === "failed" && <p className="mt-2 border-l-4 border-red-600 pl-3">{job.error}</p>}
          </div>
        )}
      </div>

      <div className="lg:col-span-5">
        {!treasury ? (
          <p className="text-ink-2">Checking the treasury…</p>
        ) : !treasury.configured ? (
          <>
            <p className="mb-3">There's no treasury yet. TreasuryBot needs one to make real payments.</p>
            <button onClick={createTreasury} className="rounded-[3px] border border-ink px-4 py-2 font-semibold hover:bg-paper-2">
              Create treasury
            </button>
          </>
        ) : (
          <>
            <p className="text-lg leading-snug">
              TreasuryBot holds{" "}
              <span className="font-bold">{treasury.balanceSats == null ? "an unknown amount of" : fmt(treasury.balanceSats)}</span> sats on Tachi{" "}
              {net}.
            </p>
            <details className="mt-3" open={!funded}>
              <summary className="cursor-pointer text-sm text-ink-2 select-none hover:text-ink">Add funds from Bitcoin {net}</summary>
              <div className="mt-3 space-y-3 text-sm">
                <p className="text-ink-2">Send {net} BTC to this address, then paste the transaction ID.</p>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 truncate bg-paper-2 px-2 py-1.5 font-mono text-[13px]">{treasury.l1Address}</code>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(treasury.l1Address!);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    }}
                    className="shrink-0 rounded-[3px] border border-rule px-2 py-1 hover:border-ink"
                  >
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
                {treasury.l1ExplorerUrl && (
                  <a href={`${treasury.l1ExplorerUrl}/address/${treasury.l1Address}`} target="_blank" rel="noreferrer">
                    See this address on mempool.space
                  </a>
                )}
                <form
                  className="flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    run("/demo/fund", { txid });
                  }}
                >
                  <label className="sr-only" htmlFor="txid">Transaction ID</label>
                  <input
                    id="txid"
                    value={txid}
                    onChange={(e) => setTxid(e.target.value)}
                    placeholder="Transaction ID"
                    spellCheck={false}
                    className="min-w-0 flex-1 rounded-[3px] border border-rule bg-paper-2 px-2 py-1.5 font-mono text-[13px] focus:border-ink"
                  />
                  <button disabled={running || !txid.trim()} className="rounded-[3px] bg-ink px-4 py-1.5 font-semibold text-paper disabled:opacity-40">
                    Deposit
                  </button>
                </form>
              </div>
            </details>
          </>
        )}
      </div>
    </div>
  );
}

/* ---------- page ---------- */

export default function App() {
  const [agents, setAgents] = useState<AgentEntry[]>([]);
  const [events, setEvents] = useState<LoggedEvent[]>([]);
  const [vault, setVault] = useState<YieldSummary | null>(null);
  const [datasets, setDatasets] = useState<Listing[]>([]);
  const [products, setProducts] = useState<Listing[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [vtxos, setVtxos] = useState<{ vtxos: Vtxo[]; total: number } | "error" | null>(null);
  const [health, setHealth] = useState<"ok" | "error" | null>(null);
  const [cfg, setCfg] = useState({ network: "regtest", explorerUrl: "https://regtest.tachibtcscan.com" });
  const [serverDown, setServerDown] = useState(false);
  const [offers, setOffers] = useState<{ relays: string[]; offers: Offer[] } | null>(null);
  const [anchors, setAnchors] = useState<Anchor[]>([]);
  const [inspecting, setInspecting] = useState<string | null>(null);

  async function refresh() {
    try {
      const [a, e, y, d, p, pay] = await Promise.all(["/agents", "/events", "/yield/summary", "/datasets", "/products", "/payments"].map(getJson));
      setAgents(a);
      setEvents(e.slice().reverse());
      setVault(y);
      setDatasets(d);
      setProducts(p);
      setPayments(pay);
      setServerDown(false);
    } catch {
      setServerDown(true);
    }
    // A single failed poll keeps the last good data; only show an error if there's nothing to show.
    getJson("/daemon/health").then(() => setHealth("ok"), () => setHealth((h) => h ?? "error"));
    getJson("/daemon/vtxos").then(setVtxos, () => setVtxos((v) => (v && v !== "error" ? v : "error")));
    getJson("/nostr/services").then(setOffers, () => {});
    getJson("/audit/anchors").then(setAnchors, () => {});
  }

  useEffect(() => {
    getJson("/config").then((c) => setCfg((cur) => ({ ...cur, ...c })), () => {});
    refresh();
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, []);

  const names = new Map(agents.map(({ agent }) => [agent.pubkey, agent.name]));
  const txUrl = (h: string) => `${cfg.explorerUrl}/tx/${h}`;
  const addrUrl = (pk: string) => `${cfg.explorerUrl}/address?address=${pk}`;
  const who = (pk: string) => names.get(pk) ?? short(pk, 10);

  const graphKeys = [...new Set([...agents.map((a) => a.agent.pubkey), ...payments.flatMap((p) => [p.fromPubkey, p.toPubkey])])];
  const total = payments.reduce((s, p) => s + p.amountSats, 0);
  const onChain = payments.filter((p) => p.mode !== "simulated");
  const onChainSats = onChain.reduce((s, p) => s + p.amountSats, 0);

  return (
    <div className="mx-auto max-w-[1240px] px-4 pb-24 sm:px-8">
      <header className="flex flex-wrap items-baseline gap-x-6 gap-y-1 py-5">
        <span className="text-[17px] font-extrabold tracking-tight">Tachi Agent Economy</span>
        <span className="flex items-center gap-2 text-sm text-ink-2">
          <span aria-hidden className={`inline-block size-2 rounded-full ${health === "error" ? "bg-red-600" : "bg-ok"}`} />
          {health === "error" ? `Can't reach Tachi ${cfg.network}` : `Connected to Tachi ${cfg.network}`}
        </span>
        <a href={cfg.explorerUrl} target="_blank" rel="noreferrer" className="ml-auto text-sm">
          Open explorer
        </a>
      </header>

      {serverDown && (
        <p className="mb-6 border-l-4 border-red-600 bg-paper-2 px-4 py-3 text-sm">
          The dashboard can't reach its server. Start it with <code className="font-mono">npm run server</code>; this page retries every 3 seconds.
        </p>
      )}

      <h1 className="max-w-[24ch] pt-6 pb-10 text-[clamp(2rem,4.6vw,3.6rem)] leading-[1.04] font-bold tracking-[-0.025em] text-balance">
        {payments.length === 0 ? (
          <>No agent has paid another yet. </>
        ) : (
          <>{agents.length} agents have paid each other {fmt(total)} sats. </>
        )}
        {payments.length === 0 ? null : onChain.length > 0 ? (
          <span className="text-ink-2">
            {fmt(onChainSats)} of it settled on Tachi {cfg.network}.
          </span>
        ) : (
          <span className="text-ink-2">None has settled on chain yet.</span>
        )}
      </h1>

      <RunPanel onChange={refresh} />

      <div className="grid gap-10 pb-14 lg:grid-cols-12">
        <figure className="lg:col-span-7">
          <AgentGraph pubkeys={graphKeys} names={names} payments={payments} />
          <figcaption className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-ink-2">
            <span className="flex items-center gap-2">
              <svg width="28" height="6" aria-hidden><line x1="0" y1="3" x2="28" y2="3" stroke="var(--color-btc)" strokeWidth="3" /></svg>
              Settled on Tachi
            </span>
            <span className="flex items-center gap-2">
              <svg width="28" height="6" aria-hidden><line x1="0" y1="3" x2="28" y2="3" stroke="var(--color-ink-2)" strokeWidth="2" strokeDasharray="5 5" /></svg>
              Simulated
            </span>
            <span>Line weight grows with sats paid.</span>
          </figcaption>
        </figure>

        <div className="lg:col-span-5">
          <h2 className="border-b border-ink pb-2 text-xl font-bold tracking-tight">Payments</h2>
          {payments.length === 0 && (
            <p className="py-6 text-ink-2">
              No payments yet. Make a real payment above, or add demo agents.
            </p>
          )}
          <ol className="max-h-[440px] overflow-y-auto">
            {payments.map((p) => (
              <li key={p.txRef} className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 border-b border-rule py-3">
                <span className="font-semibold">
                  <a href={addrUrl(p.fromPubkey)} target="_blank" rel="noreferrer">{who(p.fromPubkey)}</a>
                  <span className="px-1.5 font-normal text-ink-2">paid</span>
                  <a href={addrUrl(p.toPubkey)} target="_blank" rel="noreferrer">{who(p.toPubkey)}</a>
                </span>
                <span className={`text-right font-semibold tabular-nums ${p.mode !== "simulated" ? "text-btc-ink" : ""}`}>{fmt(p.amountSats)} sats</span>
                <span className="truncate text-sm text-ink-2">{p.resource?.replace(/[0-9a-f]{20,}/g, (h) => short(h, 6)) ?? ""}</span>
                <span className="text-right">
                  <Settlement p={p} txUrl={txUrl} />
                </span>
              </li>
            ))}
          </ol>
        </div>
      </div>

      <div className="space-y-14">
        <Section title="Agents" aside="Reputation is computed from signed events, not stored. Select an agent to inspect it.">
          <table className="ledger">
            <thead>
              <tr>
                <th>Agent</th>
                <th className="num">Jobs done</th>
                <th className="num">Paid</th>
                <th className="num">Earned</th>
                <th className="num">Reputation</th>
              </tr>
            </thead>
            <tbody>
              {agents.map(({ agent, reputation }) => (
                <tr key={agent.pubkey}>
                  <td>
                    <button
                      onClick={() => setInspecting(inspecting === agent.pubkey ? null : agent.pubkey)}
                      className="font-semibold underline decoration-rule underline-offset-[3px] hover:decoration-ink"
                      aria-expanded={inspecting === agent.pubkey}
                    >
                      {agent.name}
                    </button>
                    <a href={addrUrl(agent.pubkey)} target="_blank" rel="noreferrer" className="block font-mono text-[12px] text-ink-2">
                      {short(agent.pubkey, 16)}
                    </a>
                  </td>
                  <td className="num">{reputation.completedJobs}</td>
                  <td className="num">{fmt(reputation.totalSatsSent)}</td>
                  <td className="num">{fmt(reputation.totalSatsReceived)}</td>
                  <td className="num font-semibold">{reputation.score}</td>
                </tr>
              ))}
              {agents.length === 0 && (
                <tr>
                  <td colSpan={5} className="text-ink-2">No agents registered yet.</td>
                </tr>
              )}
            </tbody>
          </table>
          {inspecting && <Inspector pubkey={inspecting} who={who} txUrl={txUrl} onClose={() => setInspecting(null)} />}
        </Section>

        <Section
          title="On Nostr"
          aside={`Service offers agents published to public relays${offers ? ` (${offers.relays.map((r) => r.replace("wss://", "")).join(", ")})` : ""}. Agents discover each other here.`}
        >
          {!offers || offers.offers.length === 0 ? (
            <p className="text-ink-2">No offers found on the relays yet. Find a seller on Nostr above to publish one.</p>
          ) : (
            <table className="ledger">
              <thead>
                <tr>
                  <th>Offer</th>
                  <th>Agent</th>
                  <th>Network</th>
                  <th className="num">Price</th>
                </tr>
              </thead>
              <tbody>
                {offers.offers.map((o) => (
                  <tr key={`${o.pubkey}:${o.resource}`}>
                    <td>
                      <div className="font-semibold">{o.name}</div>
                      <div className="text-sm text-ink-2">{o.about}</div>
                    </td>
                    <td>
                      <a href={`https://njump.me/${o.npub}`} target="_blank" rel="noreferrer">
                        {names.get(o.pubkey) ?? short(o.npub, 14)}
                      </a>
                    </td>
                    <td className="text-ink-2">{o.network}</td>
                    <td className="num">{fmt(o.priceSats)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>

        <Section title="Yield vault" aside="Agents pool idle sats and the vault picks the best strategy under a risk cap.">
          {vault ? (
            <p className="max-w-[56ch] text-2xl leading-snug font-medium">
              {fmt(vault.totalAssetsSats)} sats from {vault.depositorCount} depositor{vault.depositorCount === 1 ? "" : "s"}
              {vault.allocatedStrategy ? (
                <>
                  , allocated to {vault.allocatedStrategy.name} at {(vault.allocatedStrategy.aprBps / 100).toFixed(2)}% APR with a risk score of{" "}
                  {vault.allocatedStrategy.riskScore}.
                </>
              ) : (
                <>, not yet allocated to a strategy.</>
              )}
            </p>
          ) : (
            <p className="text-ink-2">Loading the vault…</p>
          )}
        </Section>

        <Section title="For sale" aside="Datasets are delivered sealed to the buyer's Nostr key; only buyers who paid can rate them.">
          <div className="grid gap-10 xl:grid-cols-2">
            <table className="ledger">
              <thead>
                <tr>
                  <th>Dataset</th>
                  <th>Seller</th>
                  <th className="num">Rating</th>
                  <th className="num">Sold</th>
                  <th className="num">Price</th>
                </tr>
              </thead>
              <tbody>
                {datasets.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <div className="font-semibold">{d.title}</div>
                      <div className="text-sm text-ink-2">{d.description} ({d.sizeBytes} bytes, encrypted)</div>
                    </td>
                    <td>{who(d.providerPubkey!)}</td>
                    <td className="num">{d.rating?.avg != null ? `${d.rating.avg.toFixed(1)} (${d.rating.count})` : "—"}</td>
                    <td className="num">{d.sold ?? 0}</td>
                    <td className="num">{fmt(d.priceSats)}</td>
                  </tr>
                ))}
                {datasets.length === 0 && (
                  <tr>
                    <td colSpan={5} className="text-ink-2">No datasets listed.</td>
                  </tr>
                )}
              </tbody>
            </table>
            <table className="ledger">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Merchant</th>
                  <th className="num">Sold</th>
                  <th className="num">Price</th>
                </tr>
              </thead>
              <tbody>
                {products.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <div className="font-semibold">{p.title}</div>
                      <div className="text-sm text-ink-2">{p.description}</div>
                    </td>
                    <td>{who(p.merchantPubkey!)}</td>
                    <td className="num">{p.unitsSold}</td>
                    <td className="num">{fmt(p.priceSats)}</td>
                  </tr>
                ))}
                {products.length === 0 && (
                  <tr>
                    <td colSpan={4} className="text-ink-2">No products listed.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Section>

        <Section
          title="On chain"
          aside={
            vtxos && vtxos !== "error"
              ? `The latest ${vtxos.vtxos.length} of ${fmt(vtxos.total)} vTXOs on Tachi ${cfg.network}.`
              : `vTXOs on Tachi ${cfg.network}.`
          }
        >
          {vtxos === "error" && <p className="text-ink-2">Can't reach the Tachi {cfg.network} daemon. vTXOs will appear when it's back.</p>}
          {vtxos && vtxos !== "error" && (
            <table className="ledger">
              <thead>
                <tr>
                  <th>vTXO</th>
                  <th>Owner</th>
                  <th className="num">Amount</th>
                  <th className="num">Block</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {vtxos.vtxos.map((v) => (
                  <tr key={v.id}>
                    <td>
                      <a href={`${cfg.explorerUrl}/vtxo/${v.id}`} target="_blank" rel="noreferrer" className="font-mono text-[13px]">
                        {short(v.id, 14)}
                      </a>
                    </td>
                    <td>
                      {names.has(v.owner) ? (
                        <a href={addrUrl(v.owner)} target="_blank" rel="noreferrer">{names.get(v.owner)}</a>
                      ) : (
                        <a href={addrUrl(v.owner)} target="_blank" rel="noreferrer" className="font-mono text-[13px] text-ink-2">
                          {short(v.owner, 12)}
                        </a>
                      )}
                    </td>
                    <td className="num">{fmt(v.amount)}</td>
                    <td className="num">{v.height}</td>
                    <td className={v.spent ? "text-ink-2" : "text-ok"}>{v.spent ? "Spent" : "Unspent"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>

        <Section title="Signed events" aside="Every action is a Nostr event signed by the agent. Anchoring the log on Tachi makes any later edit detectable.">
          {anchors.length > 0 && (
            <ul className="mb-5 space-y-1">
              {anchors.map((a) => (
                <li key={a.txRef} className="text-sm">
                  <span className={a.matchesLog ? "font-semibold text-ok" : "font-semibold text-red-700"}>
                    {a.matchesLog ? "Log matches its anchor" : "Log no longer matches its anchor"}
                  </span>
                  <span className="text-ink-2">
                    {" "}
                    — first {a.count} events, root <span className="font-mono text-[12px]">{short(a.root, 12)}</span>, anchored{" "}
                  </span>
                  <a href={a.explorerUrl} target="_blank" rel="noreferrer" className="font-mono text-[12px] text-btc-ink">
                    {short(a.txRef, 10)}
                  </a>
                </li>
              ))}
            </ul>
          )}
          <details className="group">
            <summary className="cursor-pointer text-ink-2 select-none hover:text-ink">
              <span className="group-open:hidden">Show all {events.length} events</span>
              <span className="hidden group-open:inline">Hide events</span>
            </summary>
            <table className="ledger mt-4">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Agent</th>
                  <th>Action</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => {
                  let txRef: unknown;
                  try {
                    txRef = JSON.parse(e.content).txRef;
                  } catch {
                    // plain-text content
                  }
                  return (
                    <tr key={e.id}>
                      <td className="whitespace-nowrap text-ink-2">{new Date(e.createdAt * 1000).toLocaleTimeString()}</td>
                      <td>{who(e.agentPubkey)}</td>
                      <td className="whitespace-nowrap">{e.kind.replace(/_/g, " ")}</td>
                      <td className="max-w-[40ch] truncate text-sm text-ink-2">
                        {isTxHash(txRef) ? (
                          <a href={txUrl(txRef)} target="_blank" rel="noreferrer" className="font-mono text-[13px] text-btc-ink">
                            {short(txRef, 14)}
                          </a>
                        ) : (
                          e.content
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </details>
        </Section>
      </div>
    </div>
  );
}
