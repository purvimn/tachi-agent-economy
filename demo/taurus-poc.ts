// Proof of concept: a self-custodial TAURUS vault on Tachi regtest or signet (TACHI_NETWORK).
//   npm run taurus           regtest
//   npm run taurus:signet    signet
// 1. Owner seed (TAURUS_MNEMONIC in .env, created on first run — back it up). Same seed on both networks.
// 2. Fund the owner's SegWit wallet: from the node's miner wallet on regtest; on signet the script
//    prints the address, you send it signet BTC (e.g. from a faucet), then rerun.
// 3. createVault (owner + validator quorum, unilateral exit after EXIT_DELAY blocks) and deposit.
// 4. Register the vault on Tachi (TxVaultOpen), paid from a coin the treasury sends the owner.
// 5. Build, sign and verify the owner's unilateral exit, and show bitcoind refuses it until the delay
//    has passed: no daemon or validator is involved in getting the money back.
// Progress is saved to data/taurus-poc-<network>.json, so a rerun resumes instead of re-depositing.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as bip39 from "bip39";
import { BIP32Factory } from "bip32";
import * as ecc from "@bitcoinerlab/secp256k1";
import { BitcoinCoreRpcClient, WalletAggregator } from "@tachibtc/taurus-wallet-aggregator";
import {
  createVault,
  depositToVault,
  verifyVaultP2tr,
  registerVault,
  buildUnilateralExitPsbt,
  signUnilateralExitPsbtAsUser,
  verifyUnilateralExitPsbt,
  finalizeUnilateralExitPsbt,
} from "@tachibtc/taurus-vault-core";
import { tachiNetwork, tachiClient, TachiPaymentProvider, tachiTx } from "@tachi-hack/agent-sdk";

const EXIT_DELAY = 144; // blocks, ~1 day: Tachi's current exit delay
const DEPOSIT_SATS = 100_000n;
const EXIT_FEE_SATS = 1_000n;
const OPEN_FEE_SATS = 10n;

const net = tachiNetwork();
const STATE = path.resolve(`data/taurus-poc-${net.name}.json`);
type State = { vaultAddress?: string; depositTxid?: string; vaultVout?: number; registeredVaultId?: string; registerTxRef?: string };
const state: State = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
const save = () => (mkdirSync(path.dirname(STATE), { recursive: true }), writeFileSync(STATE, JSON.stringify(state, null, 1)));
const step = (m: string) => console.log(`\n▸ ${m}`);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const headers = net.apiKey ? { "X-Api-Key": net.apiKey } : undefined;
// Explorer links. Regtest's L1 chain is private, so it has no L1 explorer.
const l1Link = (kind: "tx" | "address", id: string) => (net.l1ExplorerUrl ? `${net.l1ExplorerUrl}/${kind}/${id}` : `(${net.name} L1 has no public explorer) ${id}`);
const tachiTxLink = (ref: string) => `${net.explorerUrl}/tx/${ref}`;
const keyedFetch: typeof fetch = (input, init) => fetch(input, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), ...headers } });

const rpc = new BitcoinCoreRpcClient({ url: net.btcRpc.url!, username: net.btcRpc.username, password: net.btcRpc.password });

async function main() {
  step("Owner seed");
  let mnemonic = process.env.TAURUS_MNEMONIC;
  if (!mnemonic) {
    mnemonic = bip39.generateMnemonic(256);
    appendFileSync(".env", `\n# TAURUS vault owner seed (proof of concept). Back it up: it controls the vault.\nTAURUS_MNEMONIC="${mnemonic}"\n`);
    console.log("  created a new seed and saved it to .env as TAURUS_MNEMONIC");
  }
  const wallet = WalletAggregator.fromMnemonic(mnemonic, { network: net.name, rpc }).addAccount({ addressType: "p2wpkh" });

  step("Vault: owner key + Tachi validator quorum, unilateral exit after the delay");
  const vault = await createVault({ network: net.name, userWallet: wallet, validators: { endpoint: `${net.daemonUrl}/tachi_validators`, fetchImpl: keyedFetch }, csvBlocks: EXIT_DELAY });
  verifyVaultP2tr(vault.p2tr);
  const owner = Buffer.from(vault.userKey.xOnly).toString("hex");
  console.log(`  address ${vault.p2tr.address}`);
  console.log(`  owner key ${owner} (${vault.userKey.derivationPath})`);
  console.log(`  quorum of ${vault.nodeKeys.length} validators; exit delay ${EXIT_DELAY} blocks`);
  if (state.vaultAddress && state.vaultAddress !== vault.p2tr.address) throw new Error("The rebuilt vault address differs from the saved one");
  state.vaultAddress = vault.p2tr.address;
  save();

  if (!state.depositTxid) {
    step(`Fund the owner's L1 wallet (${net.name})`);
    await wallet.sync();
    if (wallet.balance.confirmed < DEPOSIT_SATS + 10_000n) {
      if (net.name === "signet") {
        // The hosted signet node has no miner wallet to draw from: the owner funds it.
        console.log(`  balance ${wallet.balance.confirmed} sats; needs at least ${DEPOSIT_SATS + 10_000n} confirmed`);
        console.log(`  send signet BTC to ${wallet.receiveAddress}  ${net.l1ExplorerUrl}/address/${wallet.receiveAddress}`);
        console.log("  then rerun once it confirms: npm run taurus:signet");
        return;
      }
      const txid = await rpc.call<string>("sendtoaddress", [wallet.receiveAddress, 0.0015]);
      console.log(`  sent 0.0015 BTC to ${wallet.receiveAddress}: ${txid}`);
      await waitForConfirmation(txid);
      await wallet.sync();
    }
    step(`Deposit ${DEPOSIT_SATS} sats into the vault`);
    const deposit = await depositToVault({ vault, userWallet: wallet, rpc, amountSats: DEPOSIT_SATS, feeRateSatVb: 2 });
    state.depositTxid = deposit.txid;
    save();
    console.log(`  deposit ${deposit.txid} (fee ${deposit.feeSats} sats)  ${l1Link("tx", deposit.txid)}`);
  }
  const raw = await rpc.call<{ confirmations?: number; vout: { n: number; value: number; scriptPubKey: { address?: string; hex: string } }[] }>("getrawtransaction", [state.depositTxid, true]);
  const out = raw.vout.find((o) => o.scriptPubKey.address === vault.p2tr.address);
  if (!out) throw new Error("The deposit has no output to the vault address");
  state.vaultVout = out.n;
  save();
  if (!raw.confirmations) {
    step(`Waiting for the deposit to confirm (${net.name} mines a block about every 10 minutes)`);
    await waitForConfirmation(state.depositTxid!);
  }

  if (!state.registeredVaultId) {
    step("Register the vault on Tachi (TxVaultOpen)");
    const tachi = tachiClient(net.daemonUrl, net.apiKey);
    const freeCoin = async () => (await tachi.getAddressVtxos(owner)).vtxos.find((v) => !v.spent && !v.locked);
    let coin = await freeCoin();
    if (!coin) {
      const treasury = new TachiPaymentProvider(tachiTx.unhex(process.env.TACHI_AGENT_SECRET_KEY!), net.daemonUrl, net.name, net.apiKey);
      const paid = await treasury.pay({ toPubkey: owner, amountSats: 1_000, resource: "taurus-poc" });
      console.log(`  treasury sent the owner a 1,000-sat Tachi coin to pay for the open: ${tachiTxLink(paid.txRef)}`);
      coin = await freeCoin();
      if (!coin) throw new Error("The owner's coin hasn't appeared yet; rerun in a moment");
    }
    const reg = await registerVault({
      vault,
      outpoint: { fundingTxid: Buffer.from(state.depositTxid!, "hex").reverse(), fundingVout: out.n },
      userSigner: ownerSigner(mnemonic, vault.userKey.derivationPath!),
      inputs: [{ vtxoId: Buffer.from(coin.id, "hex"), valueSats: BigInt(coin.amount) }],
      // The daemon enforces a minimum fee on a vault open (0 is rejected: "fee below minimum").
      outputs: [{ owner: Buffer.from(owner, "hex"), amount: BigInt(coin.amount) - OPEN_FEE_SATS }],
      feeSats: OPEN_FEE_SATS,
      broadcast: { url: `${net.daemonUrl}/tachi_txBroadcastSync`, headers },
      account: { baseUrl: net.daemonUrl, headers },
      confirm: { baseUrl: net.daemonUrl, headers, overallTimeoutMs: 120_000 },
    });
    state.registeredVaultId = reg.vaultIdHex;
    state.registerTxRef = reg.broadcast.tendermintTxHash;
    save();
    console.log(`  registered: vault id ${reg.vaultIdHex}  ${tachiTxLink(state.registerTxRef)}`);
  }

  step("Unilateral exit: the owner alone, no daemon or validators");
  const valueSats = BigInt(Math.round(out.value * 1e8));
  const built = buildUnilateralExitPsbt({
    vault,
    funding: { txid: state.depositTxid!, vout: out.n, valueSats, scriptPubKey: out.scriptPubKey.hex },
    outputs: [{ address: wallet.receiveAddress, valueSats: valueSats - EXIT_FEE_SATS }],
    feeSats: EXIT_FEE_SATS,
  });
  const opts = { maxFeeSats: EXIT_FEE_SATS, minCsvBlocks: EXIT_DELAY };
  await signUnilateralExitPsbtAsUser(built.psbt, ownerSigner(mnemonic, vault.userKey.derivationPath!), vault, opts);
  const verifyOpts = { ...opts, expectedUserKey: vault.userKey.xOnly };
  verifyUnilateralExitPsbt(built.psbt, vault, verifyOpts);
  const exitHex = finalizeUnilateralExitPsbt(built.psbt, vault, verifyOpts);
  const [verdict] = await rpc.call<{ allowed: boolean; "reject-reason"?: string }[]>("testmempoolaccept", [[exitHex]]);
  const conf = (await rpc.call<{ confirmations?: number }>("getrawtransaction", [state.depositTxid, true])).confirmations ?? 0;
  const exitFile = path.resolve(`data/taurus-poc-exit-${net.name}.hex`);
  writeFileSync(exitFile, exitHex);
  console.log(`  signed an exit of ${valueSats - EXIT_FEE_SATS} sats back to the owner's wallet`);
  console.log(`  bitcoind now: ${verdict.allowed ? "accepted" : `refused (${verdict["reject-reason"]})`}; the deposit has ${conf} of ${EXIT_DELAY} confirmations`);
  console.log(`  saved to ${path.relative(process.cwd(), exitFile)}: broadcast it after ${Math.max(0, EXIT_DELAY - conf)} more blocks`);

  step("Verify on the explorers");
  console.log(`  vault address (L1)     ${l1Link("address", vault.p2tr.address)}`);
  console.log(`  vault deposit (L1)     ${l1Link("tx", state.depositTxid!)}`);
  if (state.registerTxRef) console.log(`  vault open (Tachi)     ${tachiTxLink(state.registerTxRef)}`);
  else if (state.registeredVaultId) console.log(`  vault open (Tachi)     vault id ${state.registeredVaultId} (registered before tx refs were saved)`);
  console.log(`  owner on Tachi         ${net.explorerUrl}/address?address=${owner}`);
}

/** The owner's key as a bitcoinjs Schnorr signer (the vault's exit and cooperative leaves use it untweaked). */
function ownerSigner(mnemonic: string, derivationPath: string) {
  return BIP32Factory(ecc).fromSeed(bip39.mnemonicToSeedSync(mnemonic)).derivePath(derivationPath);
}

async function waitForConfirmation(txid: string) {
  for (;;) {
    const tx = await rpc.call<{ confirmations?: number }>("getrawtransaction", [txid, true]).catch(() => null);
    if (tx?.confirmations) return console.log(" confirmed");
    process.stdout.write(".");
    await wait(30_000);
  }
}

main().catch((e) => {
  console.error("\n", e instanceof Error ? e.message : e);
  process.exit(1);
});
