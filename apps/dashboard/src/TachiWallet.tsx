import { useEffect, useRef, useState } from "react";

/**
 * Connect the TAURUS Vault browser extension (window.tachi, injected at document_start into the MAIN
 * world) and make a transaction with it. The API below is the extension's own provider contract
 * (v0.2.0): connect/getAccountInfo return the account, signVtxoTransfer signs a cooperative VTXO
 * transfer on Tachi. signPsbt exists but the extension reports it "not yet wired", so it's not used here.
 * Store listing: https://chromewebstore.google.com/detail/jelaccmjgipfegedpbdlgmmhikjhmnlo
 */
interface TachiAccount {
  fingerprint: string;
  accountPath: string;
  accountXpub: string;
  addressType: "p2wpkh";
  network: string; // "signet" | "regtest"
  address: string; // L1 payment address
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

/** Resolves window.tachi once the extension has injected it, or null if it never shows up. */
function waitForTachi(timeoutMs = 1500): Promise<TachiProvider | null> {
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

export default function TachiWallet() {
  const [provider, setProvider] = useState<TachiProvider | null | undefined>(undefined); // undefined = detecting
  const [account, setAccount] = useState<TachiAccount | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [to, setTo] = useState("");
  const [sats, setSats] = useState("");
  const [result, setResult] = useState<unknown>(null);
  const once = useRef(false);

  useEffect(() => {
    if (once.current) return;
    once.current = true;
    waitForTachi().then((p) => setProvider(p));
  }, []);

  async function connect() {
    if (!provider) return;
    setError("");
    setBusy(true);
    try {
      setAccount(await provider.connect());
    } catch (e) {
      setError(err(e));
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    if (!provider || !account) return;
    setError("");
    setResult(null);
    if (!to.trim()) return setError("Enter a destination address");
    if (!/^\d+$/.test(sats) || BigInt(sats) <= 0n) return setError("Amount must be a whole number of sats");
    setBusy(true);
    try {
      // Shape matches the extension's validator: outputs[].valueSats and feeSats are integer strings.
      const r = await provider.signVtxoTransfer({ transfer: { outputs: [{ address: to.trim(), valueSats: sats }], feeSats: "0" } });
      setResult(r);
    } catch (e) {
      setError(err(e));
    } finally {
      setBusy(false);
    }
  }

  if (provider === undefined) return null; // still detecting; render nothing to avoid a flash

  return (
    <div className="mb-14 border-y border-ink py-6">
      <h2 className="text-lg font-semibold">Your TAURUS Vault wallet</h2>
      {provider === null ? (
        <p className="mt-2 max-w-[62ch] text-sm leading-relaxed text-ink-2">
          The TAURUS Vault browser extension isn't detected.{" "}
          <a href={STORE_URL} target="_blank" rel="noreferrer" className="text-ink underline decoration-rule underline-offset-[3px]">
            Install it
          </a>{" "}
          and reload to connect your own vault and sign transactions here.
        </p>
      ) : !account ? (
        <>
          <p className="mt-2 max-w-[62ch] text-sm leading-relaxed text-ink-2">
            Connect the TAURUS Vault extension (v{provider.version}) to use your own keys. Signing happens inside the extension — this page
            never sees your seed.
          </p>
          <button
            onClick={connect}
            disabled={busy}
            className="mt-3 rounded-[3px] bg-btc px-5 py-2.5 font-semibold text-ink transition-colors hover:bg-[#bc0000] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "Check the extension…" : "Connect TAURUS Vault"}
          </button>
        </>
      ) : (
        <div className="mt-3 grid gap-6 lg:grid-cols-12">
          <dl className="space-y-1 text-sm lg:col-span-5">
            <Row label="Network" value={account.network} />
            <Row label="Address" value={account.address} href={`${explorer(account.network)}/address?address=${account.publicKeyHex}`} mono />
            <Row label="Vault" value={account.vaultAddress} mono />
            <Row label="Fingerprint" value={account.fingerprint} mono />
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
              <button onClick={send} disabled={busy} className="rounded-[3px] bg-ink px-4 py-1.5 font-semibold text-paper disabled:opacity-40">
                {busy ? "Confirm in the extension…" : "Sign & send"}
              </button>
            </div>
            <p className="mt-2 text-xs text-ink-2">The extension pops up to confirm and sign; approve it there.</p>
            {result != null && (
              <pre className="mt-3 max-w-full overflow-x-auto rounded-[3px] border border-rule bg-paper-2 p-3 text-xs text-ink">{typeof result === "string" ? result : JSON.stringify(result, null, 2)}</pre>
            )}
          </div>
        </div>
      )}
      {error && <p className="mt-3 border-l-4 border-red-600 pl-3 text-sm">{error}</p>}
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
