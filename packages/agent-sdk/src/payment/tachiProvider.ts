import { TachiClient } from "@tachibtc/tachi-sdk-ts";
import { schnorr } from "@noble/curves/secp256k1.js";
import type { PaymentProvider, PaymentResult } from "./types.js";
import type { TachiNetworkName } from "../network.js";
import { signClaim } from "../x402.js";
import { encodeTx, signTx, txHash, hex, unhex, TX_TRANSFER, type TachiTx } from "./tachiTx.js";

const EMPTY = new Uint8Array();
// Change-making: a VTXO above BIG_VTXO is split into small CHANGE_VTXOs before small payments.
const BIG_VTXO = 100_000n;
const CHANGE_VTXO = 2_000n;
const CHANGE_COUNT = 50;

type Vtxo = { id: string; amount: number };

/** Polls until `hash` is committed on the Tachi chain; throws if it fails or times out. */
export async function waitForCommit(client: TachiClient, hash: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tx = await client.getTransaction(hash).catch(() => null);
    if (tx?.state === "committed") return;
    if (tx?.state === "failed") throw new Error(`tachi tx ${hash} failed: ${tx.status?.log ?? "unknown"}`);
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`tachi tx ${hash} not committed within ${timeoutMs}ms`);
}

/** Broadcasts a signed TachiTx; throws with the daemon's CheckTx log on rejection. */
export async function broadcast(client: TachiClient, tx: TachiTx): Promise<string> {
  const res = (await client.broadcastTxSync(hex(encodeTx(tx)))) as { result: { code: number; log: string } };
  if (res.result.code !== 0) throw new Error(`tachi CheckTx rejected (code ${res.result.code}): ${res.result.log}`);
  return hex(txHash(tx));
}

/** A TachiClient that sends `X-Api-Key`, giving this client its own daemon rate-limit budget. */
export function tachiClient(baseUrl: string, apiKey?: string) {
  const keyed: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    if (apiKey) headers.set("X-Api-Key", apiKey);
    return fetch(input, { ...init, headers });
  };
  return new TachiClient({ baseUrl, fetch: keyed });
}

/**
 * Real settlement on the Tachi L2: the paying agent signs a VTXO TRANSFER with its own Nostr key
 * (Nostr keys are BIP-340 keys, so agents own VTXOs directly) and the validator quorum co-signs
 * and commits it. Non-custodial: the server never sees the secret key, only the committed txRef.
 *
 * Safe to call pay() concurrently: each payment reserves the VTXOs it spends, so parallel
 * payments use different coins and commit together in the same blocks.
 */
export class TachiPaymentProvider implements PaymentProvider {
  readonly pubkey: string;
  readonly client: TachiClient;
  private reserved = new Set<string>();
  private splitting: Promise<void> | null = null;

  constructor(
    private readonly secretKey: Uint8Array,
    baseUrl: string,
    readonly network: TachiNetworkName = "regtest",
    apiKey?: string,
    private readonly feeSats = 10n,
  ) {
    this.pubkey = hex(schnorr.getPublicKey(secretKey));
    this.client = tachiClient(baseUrl, apiKey);
  }

  private async spendable(): Promise<Vtxo[]> {
    const { vtxos } = await this.client.getAddressVtxos(this.pubkey);
    return vtxos.filter((v) => !v.locked && !v.spent && !this.reserved.has(v.id)).sort((a, b) => a.amount - b.amount);
  }

  async balanceSats(): Promise<number> {
    const { vtxos } = await this.client.getAddressVtxos(this.pubkey);
    return vtxos.filter((v) => !v.locked && !v.spent).reduce((s, v) => s + v.amount, 0);
  }

  /** Signs a payment claim for x402 (see x402.ts) without exposing the key. */
  signClaim(txRef: string, resource: string) {
    return signClaim(this.secretKey, txRef, resource);
  }

  /** Signs, broadcasts and waits for a TRANSFER spending `inputs`; returns its tx hash. */
  private async transfer(inputs: Vtxo[], outputs: { owner: Uint8Array; amount: bigint; script: Uint8Array }[]) {
    const tx = signTx(
      {
        version: 1,
        type: TX_TRANSFER,
        inputs: inputs.map((v) => ({ vtxoId: unhex(v.id), txid: new Uint8Array(32), vout: 0, valueSats: BigInt(v.amount), sigScript: EMPTY })),
        outputs,
        fee: this.feeSats,
        nonce: 0n, // only enforced for EVM txs (daemon mempool.ValidateNonce)
        pubKey: EMPTY,
        signature: EMPTY,
        psbtPayload: EMPTY,
        depositProof: EMPTY,
      },
      this.secretKey,
    );
    const txRef = await broadcast(this.client, tx);
    await waitForCommit(this.client, txRef);
    return txRef;
  }

  /**
   * Like L1 UTXOs, a VTXO is spent whole: paying 50 sats from a 5 BTC VTXO shows 5 BTC moving on
   * the explorer. Splits the largest VTXO into `count` small ones. One split at a time.
   */
  private split(count: number) {
    this.splitting ??= (async () => {
      const big = (await this.spendable()).at(-1);
      if (!big) throw new Error("No VTXO to make change from");
      // Small treasuries (e.g. a few thousand sats on signet) get smaller coins instead of failing.
      const coin = [CHANGE_VTXO, (BigInt(big.amount) - this.feeSats) / BigInt(count + 1)].reduce((a, b) => (a < b ? a : b));
      if (coin <= this.feeSats * 2n) throw new Error(`A ${big.amount}-sat VTXO is too small to split into ${count} coins`);
      this.reserved.add(big.id);
      try {
        await this.transfer([big], [
          ...Array.from({ length: count }, () => ({ owner: unhex(this.pubkey), amount: coin, script: EMPTY })),
          { owner: unhex(this.pubkey), amount: BigInt(big.amount) - coin * BigInt(count) - this.feeSats, script: EMPTY },
        ]);
      } finally {
        this.reserved.delete(big.id);
      }
    })().finally(() => (this.splitting = null));
    return this.splitting;
  }

  /** Makes sure at least `n` small VTXOs are free, so `n` payments can run in parallel. */
  async ensureChange(n: number) {
    const small = (await this.spendable()).filter((v) => BigInt(v.amount) <= CHANGE_VTXO && BigInt(v.amount) > this.feeSats * 2n);
    if (small.length < n) await this.split(Math.max(n - small.length, CHANGE_COUNT));
  }

  /** Picks and reserves coins: the smallest single VTXO that covers `need`, else largest-first. */
  private async reserve(need: bigint): Promise<Vtxo[]> {
    for (;;) {
      const free = await this.spendable(); // reservation below runs in the same tick: no races
      const single = free.find((v) => BigInt(v.amount) >= need);
      if (single && !(BigInt(single.amount) > BIG_VTXO && need <= CHANGE_VTXO)) {
        this.reserved.add(single.id);
        return [single];
      }
      if (single) {
        await this.split(CHANGE_COUNT); // only a big VTXO covers it: make change, then pick again
        continue;
      }
      const picked: Vtxo[] = [];
      let total = 0n;
      for (const v of [...free].reverse()) {
        if (total >= need) break;
        picked.push(v);
        total += BigInt(v.amount);
      }
      if (total < need) throw new Error(`insufficient Tachi balance: have ${total} sats free, need ${need}`);
      picked.forEach((v) => this.reserved.add(v.id));
      return picked;
    }
  }

  async pay(params: { toPubkey: string; amountSats: number; resource?: string }): Promise<PaymentResult> {
    if (params.amountSats <= 0) throw new Error("amountSats must be positive");
    const amount = BigInt(params.amountSats);
    const need = amount + this.feeSats;
    const picked = await this.reserve(need);
    try {
      const total = picked.reduce((s, v) => s + BigInt(v.amount), 0n);
      const outputs = [{ owner: unhex(params.toPubkey), amount, script: EMPTY }];
      if (total > need) outputs.push({ owner: unhex(this.pubkey), amount: total - need, script: EMPTY });
      const txRef = await this.transfer(picked, outputs);
      return {
        txRef,
        amountSats: params.amountSats,
        fromPubkey: this.pubkey,
        toPubkey: params.toPubkey,
        settledAt: Math.floor(Date.now() / 1000),
        mode: this.network,
        resource: params.resource,
      };
    } finally {
      picked.forEach((v) => this.reserved.delete(v.id));
    }
  }
}
