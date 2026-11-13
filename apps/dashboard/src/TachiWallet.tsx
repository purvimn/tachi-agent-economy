import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Connect the TAURUS Vault browser extension (window.tachi, injected at document_start into the MAIN
 * world) and make a transaction with it. The API is the extension's own provider contract (v0.2.0):
 * connect/getAccountInfo return the account, signVtxoTransfer signs a cooperative VTXO transfer.
 * State lives in TachiWalletProvider so the header's Connect button and the body panel share it.
 * Store: https://chromewebstore.google.com/detail/jelaccmjgipfegedpbdlgmmhikjhmnlo
 */
interface TachiAccount {
  fingerprint: string;
  accountPath: string;
  accountXpub: string;
  addressType: "p2wpkh";
  network: string;
  address: string;
  publicKeyHex: string;
  vaultAddress: string;
}
interface VtxoTransfer {
  transfer: { outputs: { address: string; valueSats: string }[]; feeSats?: string };
}
interface TachiProvider {
  isTachi: true;
  version: string;
  connect(opts?: Record<string, unknown>): Promise<TachiAccount>;
  getAccountInfo(): Promise<TachiAccount>;
  signMessage(p: { message: string }): Promise<{ signature: string; protocol: string }>;
  signVtxoTransfer(p: VtxoTransfer): Promise<unknown>;
  signVtxoDeposit(p: { amountSats: string; feeSats?: string }): Promise<unknown>;
}
declare global {
  interface Window {
    tachi?: TachiProvider;
  }
}

function waitForTachi(timeoutMs = 2000): Promise<TachiProvider | null> {
  if (window.tachi?.isTachi) return Promise.resolve(window.tachi);
  return new Promise((resolve) => {
    const done = (v: TachiProvider | null) => {
      window.removeEventListener("tachi#initialized", onInit);
      clearTimeout(timer);
      resolve(v);
    };
    const onInit = () => done(window.tachi ?? null);
    window.addEventListener("tachi#initialized", onInit);
    const timer = setTimeout(() => done(window.tachi ?? null), timeoutMs);
  });
}

const STORE_URL = "https://chromewebstore.google.com/detail/jelaccmjgipfegedpbdlgmmhikjhmnlo";
const err = (e: unknown) => (e && typeof e === "object" && "message" in e ? String((e as Error).message) : String(e));
const explorer = (net: string) => (net === "regtest" ? "https://regtest.tachibtcscan.com" : "https://signet.tachibtcscan.com");
const short = (s: string) => (s.length > 16 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s);

interface WalletCtx {
  account: TachiAccount | null;
  detected: boolean | null; // null = still checking
  busy: boolean;
  error: string;
  connect: () => Promise<void>;
  disconnect: () => void;
  send: (to: string, sats: string) => Promise<unknown>;
}
const Ctx = createContext<WalletCtx | null>(null);
function useWallet() {
  const c = useContext(Ctx);
  if (!c) throw new Error("TachiWalletProvider missing");
  return c;
}

export function TachiWalletProvider({ children }: { children: ReactNode }) {
  const [provider, setProvider] = useState<TachiProvider | null | undefined>(undefined);
  const [account, setAccount] = useState<TachiAccount | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const once = useRef(false);

  useEffect(() => {
    if (once.current) return;
    once.current = true;
    waitForTachi().then(setProvider);
  }, []);

  async function connect() {
    setError("");
    // Read window.tachi live: by click time the extension has injected it even if passive detection missed it.
    const p = window.tachi ?? provider ?? null;
    if (!p?.isTachi) {
      setError("TAURUS Vault extension not detected in this browser. Install it, enable it for this site, then reload.");
      return;
    }
    setBusy(true);
    try {
      setProvider(p);
      setAccount(await p.connect());
    } catch (e) {
      setError(err(e));
    } finally {
      setBusy(false);
    }
  }

  function disconnect() {
    setAccount(null);
    setError("");
  }

  async function send(to: string, sats: string) {
    const p = window.tachi ?? provider;
    if (!p?.isTachi) throw new Error("Wallet not connected");
    // Shape matches the extension's validator: outputs[].valueSats and feeSats are integer strings.
    return p.signVtxoTransfer({ transfer: { outputs: [{ address: to, valueSats: sats }], feeSats: "0" } });
  }

  const value: WalletCtx = { account, detected: provider === undefined ? null : provider !== null, busy, error, connect, disconnect, send };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Header control: "Connect Wallet", or the connected address (click to disconnect). */
export function ConnectWalletButton() {
  const w = useWallet();
  if (w.account) {
    return (
      <button
        onClick={w.disconnect}
        title={`Connected: ${w.account.address} — click to disconnect`}
        className="rounded-[3px] border border-ok px-3 py-1 text-sm font-semibold text-ok hover:bg-paper-2"
      >
        {short(w.account.address)}
      </button>
    );
  }
  return (
    <button
      onClick={w.connect}
      disabled={w.busy}
      className="rounded-[3px] bg-btc px-3 py-1 text-sm font-semibold text-ink transition-colors hover:bg-[#bc0000] disabled:cursor-not-allowed disabled:opacity-40"
    >
      {w.busy ? "Connecting…" : "Connect Wallet"}
    </button>
  );
}

/** Body panel: the connected account and a send form. Renders nothing until connected (the
 *  Connect button lives in the header now). */
export function TachiWalletPanel() {
  const w = useWallet();
  const [to, setTo] = useState("");
  const [sats, setSats] = useState("");
  const [result, setResult] = useState<unknown>(null);
  const [sendErr, setSendErr] = useState("");
  const [busy, setBusy] = useState(false);

  if (!w.account) {
    return w.error ? <p className="mb-6 border-l-4 border-red-600 pl-3 text-sm">{w.error}</p> : null;
  }
  const a = w.account;

  async function doSend() {
    setSendErr("");
    setResult(null);
    if (!to.trim()) return setSendErr("Enter a destination address");
    if (!/^\d+$/.test(sats) || BigInt(sats) <= 0n) return setSendErr("Amount must be a whole number of sats");
    setBusy(true);
    try {
      setResult(await w.send(to.trim(), sats));
    } catch (e) {
      setSendErr(err(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-14 border-y border-ink py-6">
      <h2 className="text-lg font-semibold">Your TAURUS Vault wallet</h2>
      <div className="mt-3 grid gap-6 lg:grid-cols-12">
        <dl className="space-y-1 text-sm lg:col-span-5">
          <Row label="Network" value={a.network} />
          <Row label="Address" value={a.address} href={`${explorer(a.network)}/address?address=${a.publicKeyHex}`} mono />
          <Row label="Vault" value={a.vaultAddress} mono />
          <Row label="Fingerprint" value={a.fingerprint} mono />
        </dl>
        <div className="lg:col-span-7">
          <p className="text-sm font-semibold">Make a transaction — cooperative VTXO transfer</p>
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <label className="text-sm">
              <span className="block text-ink-2">To (Tachi address)</span>
              <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="tb1p… / bcrt1p…" className="mt-1 w-72 rounded-[3px] border border-ink bg-paper px-2 py-1.5 font-mono text-xs" />
            </label>
            <label className="text-sm">
              <span className="block text-ink-2">Sats</span>
              <input value={sats} onChange={(e) => setSats(e.target.value.replace(/[^\d]/g, ""))} placeholder="1000" inputMode="numeric" className="mt-1 w-28 rounded-[3px] border border-ink bg-paper px-2 py-1.5 tabular-nums" />
            </label>
            <button onClick={doSend} disabled={busy} className="rounded-[3px] bg-ink px-4 py-1.5 font-semibold text-paper disabled:opacity-40">
              {busy ? "Confirm in the extension…" : "Sign & send"}
            </button>
          </div>
          <p className="mt-2 text-xs text-ink-2">The extension pops up to confirm and sign; approve it there.</p>
          {result != null && (
            <pre className="mt-3 max-w-full overflow-x-auto rounded-[3px] border border-rule bg-paper-2 p-3 text-xs text-ink">{typeof result === "string" ? result : JSON.stringify(result, null, 2)}</pre>
          )}
          {sendErr && <p className="mt-3 border-l-4 border-red-600 pl-3 text-sm">{sendErr}</p>}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, href, mono }: { label: string; value: string; href?: string; mono?: boolean }) {
  const text = <span className={mono ? "break-all font-mono text-xs" : ""}>{value}</span>;
  return (
    <div className="flex gap-2">
      <dt className="w-24 shrink-0 text-ink-2">{label}</dt>
      <dd className="min-w-0">{href ? <a href={href} target="_blank" rel="noreferrer" className="text-ink underline decoration-rule underline-offset-[3px]">{text}</a> : text}</dd>
    </div>
  );
}
