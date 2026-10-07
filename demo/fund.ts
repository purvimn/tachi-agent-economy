// Funds the treasury agent on Tachi: L1 BTC -> DEPOSIT -> treasury-owned VTXO. The dashboard does the same.
// Network from TACHI_NETWORK (regtest default; `npm run fund:signet` for signet). Same key on both.
//   npm run fund              print the treasury's L1 address + Tachi balance (creates the key if missing)
//   npm run fund -- <txid>    after sending BTC to that address: wait for it to be mined, then deposit
import { appendFileSync } from "node:fs";
import { schnorr } from "@noble/curves/secp256k1.js";
import { TachiPaymentProvider, tachiNetwork, p2trAddress, depositFromL1, tachiTx } from "@tachi-hack/agent-sdk";

const net = tachiNetwork();

function treasuryKey(): Uint8Array {
  if (process.env.TACHI_AGENT_SECRET_KEY) return tachiTx.unhex(process.env.TACHI_AGENT_SECRET_KEY);
  const sk = schnorr.utils.randomSecretKey();
  appendFileSync(".env", `\nTACHI_AGENT_SECRET_KEY=${tachiTx.hex(sk)}\n`);
  console.log("Generated a new treasury key and saved it to .env (TACHI_AGENT_SECRET_KEY).");
  return sk;
}

async function main() {
  const sk = treasuryKey();
  const wallet = new TachiPaymentProvider(sk, net.daemonUrl, net.name, net.apiKey);
  const address = p2trAddress(wallet.pubkey, net.hrp);
  const txid = process.argv[2];

  if (!txid) {
    const cmd = net.name === "signet" ? "npm run fund:signet" : "npm run fund";
    console.log(`Network: Tachi ${net.name}`);
    console.log(`Treasury Tachi pubkey: ${wallet.pubkey}  ${net.explorerUrl}/address?address=${wallet.pubkey}`);
    console.log(`Treasury L1 address: ${address}${net.l1ExplorerUrl ? `  ${net.l1ExplorerUrl}/address/${address}` : ""}`);
    console.log(`Tachi balance: ${await wallet.balanceSats()} sats`);
    console.log(`\nSend ${net.name} BTC to the L1 address above, then: ${cmd} -- <txid>`);
    return;
  }

  if (net.l1ExplorerUrl) console.log(`L1 tx: ${net.l1ExplorerUrl}/tx/${txid}`);
  const ref = await depositFromL1(net, sk, txid, (m) => console.log(m));
  console.log(`Committed: ${net.explorerUrl}/tx/${ref}\nTachi balance: ${await wallet.balanceSats()} sats`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
