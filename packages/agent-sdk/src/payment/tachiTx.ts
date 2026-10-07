import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";

/**
 * TachiTx wire format, mirrored byte-for-byte from the daemon (daemon/types/types.go EncodeTx,
 * SigHash; daemon/types/deposit.go). All integers big-endian.
 */
export const TX_TRANSFER = 0x01;
export const TX_DEPOSIT = 0x04;

export interface TxInput {
  vtxoId: Uint8Array; // 32
  txid: Uint8Array; // 32, L1 funding txid (zeros for pure-L2 VTXOs)
  vout: number;
  valueSats: bigint;
  sigScript: Uint8Array;
}
export interface TxOutput {
  owner: Uint8Array; // 32-byte BIP-340 x-only key
  amount: bigint;
  script: Uint8Array;
}
export interface TachiTx {
  version: number;
  type: number;
  inputs: TxInput[];
  outputs: TxOutput[];
  fee: bigint;
  nonce: bigint;
  pubKey: Uint8Array;
  signature: Uint8Array;
  psbtPayload: Uint8Array;
  depositProof: Uint8Array; // empty unless TX_DEPOSIT
}

const sha256 = (...parts: Uint8Array[]) => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
};

class Writer {
  private chunks: Buffer[] = [];
  bytes(b: Uint8Array) { this.chunks.push(Buffer.from(b)); }
  u8(v: number) { this.chunks.push(Buffer.from([v])); }
  u16(v: number) { const b = Buffer.alloc(2); b.writeUInt16BE(v); this.chunks.push(b); }
  u32(v: number) { const b = Buffer.alloc(4); b.writeUInt32BE(v); this.chunks.push(b); }
  u64(v: bigint) { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt.asUintN(64, v)); this.chunks.push(b); }
  lp16(b: Uint8Array) { this.u16(b.length); this.bytes(b); }
  done() { return new Uint8Array(Buffer.concat(this.chunks)); }
}

export function encodeTx(tx: TachiTx): Uint8Array {
  const w = new Writer();
  w.u8(tx.version);
  w.u8(tx.type);
  w.u16(tx.inputs.length);
  for (const i of tx.inputs) {
    w.bytes(i.vtxoId);
    w.bytes(i.txid);
    w.u32(i.vout);
    w.u64(i.valueSats);
    w.lp16(i.sigScript);
  }
  w.u16(tx.outputs.length);
  for (const o of tx.outputs) {
    w.lp16(o.owner);
    w.u64(o.amount);
    w.lp16(o.script);
  }
  w.u64(tx.fee);
  w.u64(tx.nonce);
  w.lp16(tx.pubKey);
  w.lp16(tx.signature);
  w.u32(tx.psbtPayload.length);
  w.bytes(tx.psbtPayload);
  if (tx.depositProof.length > 0) w.lp16(tx.depositProof);
  return w.done();
}

export const txHash = (tx: TachiTx) => sha256(encodeTx(tx));

/** Digest the sender signs: signature, PSBT, and every input field except vtxoId blanked. */
export function sigHash(tx: TachiTx): Uint8Array {
  return txHash({
    ...tx,
    signature: new Uint8Array(),
    psbtPayload: new Uint8Array(),
    inputs: tx.inputs.map((i) => ({ vtxoId: i.vtxoId, txid: new Uint8Array(32), vout: 0, valueSats: 0n, sigScript: new Uint8Array() })),
  });
}

export function signTx(tx: TachiTx, secretKey: Uint8Array): TachiTx {
  const pubKey = schnorr.getPublicKey(secretKey);
  const unsigned = { ...tx, pubKey };
  return { ...unsigned, signature: schnorr.sign(sigHash(unsigned), secretKey) };
}

/**
 * 44-byte deposit claim. `btcTxidHex` is the display (RPC) txid; the daemon stores it in
 * internal byte order (chainhash), so it is reversed here.
 */
export function encodeDepositProof(btcTxidHex: string, vout: number, height: number, timestamp: number): Uint8Array {
  const w = new Writer();
  w.bytes(Buffer.from(btcTxidHex, "hex").reverse());
  w.u32(vout);
  w.u32(height);
  w.u32(timestamp);
  return w.done();
}

export const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
export const unhex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));
