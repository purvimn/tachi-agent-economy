import { schnorr } from "@noble/curves/secp256k1.js";
import { bech32m } from "@scure/base";
import type { TachiNetwork } from "../network.js";
import { TachiPaymentProvider, waitForCommit, broadcast } from "./tachiProvider.js";
import { hex, unhex, signTx, encodeDepositProof, TX_DEPOSIT } from "./tachiTx.js";

const DEPOSIT_FEE = 10n;

/** BIP-86 key-path P2TR address for an x-only key (no script tree). */
export function p2trAddress(xOnlyHex: string, hrp: string): string {
  const xOnly = unhex(xOnlyHex);
  const P = schnorr.utils.lift_x(BigInt("0x" + xOnlyHex));
  const t = BigInt("0x" + hex(schnorr.utils.taggedHash("TapTweak", xOnly)));
  const Q = P.add(schnorr.Point.BASE.multiply(t)).toBytes(true).slice(1);
  return bech32m.encode(hrp, [1, ...bech32m.toWords(Q)]);
}

async function btc<T>(net: TachiNetwork, method: string, params: unknown[]): Promise<T> {
  const { url, username, password } = net.btcRpc;
  if (!url) throw new Error(`No ${net.name} bitcoind RPC URL is configured in .env`);
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "text/plain", authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` },
    body: JSON.stringify({ jsonrpc: "1.0", id: 1, method, params }),
  });
  const body = (await r.json()) as { result: T; error: { message: string } | null };
  if (body.error) throw new Error(`bitcoind ${method}: ${body.error.message}`);
  return body.result;
}

interface RawTx {
  blockhash?: string;
  vout: { n: number; value: number; scriptPubKey: { address?: string } }[];
}

/**
 * L1 BTC -> Tachi DEPOSIT -> VTXO owned by `secretKey`'s pubkey. Waits for the L1 tx to be mined
 * (ponytail: one block stands in for L1 finality until confirmation depth is wired), then waits for
 * the validators to attest and commit. Returns the DEPOSIT tx hash.
 */
export async function depositFromL1(net: TachiNetwork, secretKey: Uint8Array, txid: string, onStep: (msg: string) => void = () => {}): Promise<string> {
  const provider = new TachiPaymentProvider(secretKey, net.daemonUrl, net.name, net.apiKey);
  const address = p2trAddress(provider.pubkey, net.hrp);

  let tx = await btc<RawTx>(net, "getrawtransaction", [txid, true]);
  const out = tx.vout.find((o) => o.scriptPubKey.address === address);
  if (!out) throw new Error(`L1 tx ${txid} doesn't pay the treasury address ${address}`);

  onStep("Waiting for the L1 transaction to be mined");
  while (!tx.blockhash) {
    await new Promise((r) => setTimeout(r, 10_000));
    tx = await btc<RawTx>(net, "getrawtransaction", [txid, true]);
  }
  const header = await btc<{ height: number; time: number }>(net, "getblockheader", [tx.blockhash]);
  const valueSats = BigInt(Math.round(out.value * 1e8));
  onStep(`Mined in block ${header.height}, paying ${valueSats} sats`);

  const deposit = signTx(
    {
      version: 1,
      type: TX_DEPOSIT,
      inputs: [],
      outputs: [{ owner: unhex(provider.pubkey), amount: valueSats - DEPOSIT_FEE, script: new Uint8Array() }],
      fee: DEPOSIT_FEE, // daemon requires outputs + fee == L1 amount exactly
      nonce: 0n,
      pubKey: new Uint8Array(),
      signature: new Uint8Array(),
      psbtPayload: new Uint8Array(),
      depositProof: encodeDepositProof(txid, out.n, header.height, header.time),
    },
    secretKey,
  );
  const ref = await broadcast(provider.client, deposit);
  onStep("Deposit sent; waiting for Tachi validators to commit it");
  await waitForCommit(provider.client, ref, 180_000);
  return ref;
}
