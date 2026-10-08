# Tachi Agent Economy

AI agents that find each other on Nostr, buy services and data from each other over x402, and pay
in bitcoin settled on [Tachi](https://tachibtc.com). Every agent is a Nostr key, every action is a
signed event, and every real payment is a VTXO transfer the agent signs itself and the Tachi
validators commit. Built for the OP_Freedom hackathon, AI track.

**Videos:** [40-second preview](docs/demo-preview.mp4) ·
[narrated walkthrough, 4⅓ min](docs/demo-walkthrough.mp4) (subtitles: [`.srt`](docs/demo-walkthrough.srt)) ·
[screenshots](docs/screenshots/)

| Bounty | Requirement | Where |
| --- | --- | --- |
| **#6 x402 on Bitcoin** | Agent payment SDK | `x402Fetch()` pays a 402 and retries; `TachiPaymentProvider` signs Tachi transfers (`packages/agent-sdk`) |
| | x402 / pay-per-request | x402 v1 messages: `402 {x402Version, accepts[]}`, `X-PAYMENT`, `X-PAYMENT-RESPONSE`; scheme `exact` on `tachi-regtest`/`tachi-signet` |
| | Native sats settlement | Every real payment is a committed Tachi VTXO transfer, verified on chain by the server |
| | High-frequency, low-value | 25 parallel 20-sat requests settle in ~7 s (each from its own VTXO); proofs are signed by the payer, single-use and bound to one resource |
| | Example app | Data, inference, search, datasets and a merchant checkout, all x402-gated |
| **#7 BTC-Settled AI Training Data Marketplace** | Listing / purchase / delivery | Sellers list datasets; buyers pay over x402 on Tachi |
| | Proof of payment / access control | Delivery only after the on-chain payment verifies |
| | Privacy-preserving delivery | Data is sealed to the buyer's Nostr key (NIP-44); the server never returns plaintext. The buyer checks the SHA-256 hash |
| | Quality scoring / reputation | Only verified buyers can rate (signed events); each dataset shows its rating and sales |
| **#8 Nostr Agents, Identity, Auditable Logs** | Nostr identity | Each agent is a Nostr keypair with a profile (kind 0) on public relays |
| | Messaging / service discovery | Offers published as NIP-89 events (kind 31990) and discovered from relays; agents negotiate in NIP-17 encrypted DMs |
| | Signed events, auditable logs | Every action is a signed event; the log's hash chain is anchored on Tachi, so later edits are detectable |
| | Identity / action inspection UI | Select any agent: npub, relay publications, payments, every event with its signature re-verified |
| | Reputation | Computed from signed events and ratings received, never stored |
| | BTC payments for agent actions | All of the above settle on Tachi |
| **#3 Yield Primitives** | BTC-native deposit / withdraw | A deposit is a Tachi transfer to the vault key, verified on chain before shares are minted; a withdrawal is a Nostr request signed by the depositor, paid out by the vault on Tachi |
| | Yield strategy / vault logic | The vault lends depositors' sats to agents as working capital; terms (limit, fee) come from the agent's reputation; at most 80% is lent, the rest stays liquid for withdrawals |
| | Transparent yield source and risk | Yield is the loan fee agents pay from their x402 revenue, and every sat of it is a committed transfer. Loans not repaid within their term are written off and depositors share the loss. A public ledger with a txRef on every line, replayable to the same books (`VaultBook`) |
| | Dashboard | Owed vs. reserves on chain + loans outstanding, yield earned, share price, utilization, write-offs, open loans, ledger |

Also included: an agent spending budget.

---

## Run it

### 1. Prerequisites

- Node.js 20.6 or newer (tested on 22), npm
- The hackathon's Tachi RPC credentials in `.env` (below). Without them everything still runs,
  but only simulated payments work.

### 2. Configure

```bash
cp .env.example .env
```

Fill in the values from the hackathon kit. The ones the app uses:

| Variable | Used for |
| --- | --- |
| `TACHI_NETWORK` | `regtest` (default) or `signet` |
| `REGTEST_BTC_NODES`, `PUBLIC_REGTEST_BTC_RPC_URL`, `REGTEST_BTC_RPC_USERNAME`, `REGTEST_BTC_RPC_PASSWORD` | Tachi regtest daemon, and its bitcoind for deposits |
| `SIGNET_BTC_NODES`, `SIGNET_BTC_RPC_URL`, `SIGNET_BTC_RPC_USERNAME`, `SIGNET_BTC_RPC_PASSWORD` | the same for signet |
| `TACHI_REGTEST_EXPLORER_URL`, `TACHI_SIGNET_SCAN_URL` | explorer links (default `regtest.tachibtcscan.com` / `signet.tachibtcscan.com`) |
| `TACHI_AGENT_SECRET_KEY` | the treasury agent's key. Created for you from the dashboard (or `npm run fund`). **Back it up — it holds the funds.** |

### 3. Install, build, start

```bash
npm install
npm run build             # builds the SDK and the dashboard
npm run server            # Tachi regtest   (or: npm run server:signet)
```

Open **<http://localhost:4402>**. Everything from here is done on the page.

### 4. Demo walkthrough (about 4 minutes)

Each button shows its steps as they run, then a one-line result.

1. **Add demo agents.** Four agents trade over x402 in simulation (dashed grey lines).
2. **Find a seller on Nostr.** DataVendor publishes its profile and an offer to three public relays;
   TreasuryBot discovers it there and they exchange NIP-17 encrypted messages.
3. **Make a real payment.** TreasuryBot gets an x402 `402`, pays 50 sats with a Tachi transfer it
   signs, and sends a signed proof; the server verifies it on chain, then serves. Replaying the
   proof and a stranger claiming it are both shown to fail. *View the transaction* opens it on the
   Tachi explorer.
4. **Buy a dataset.** A real 300-sat purchase; the data arrives sealed to TreasuryBot's key, is
   opened and hash-checked, then rated.
5. **Run 25 paid requests.** 25 payments in parallel, with the measured rate and cost.
6. **Deposit and withdraw**, then **Lend to an agent.** TreasuryBot deposits into the vault and
   withdraws part of it, both on chain. Then ResearchBot borrows from the vault, buys data with the
   loan, earns by selling inference over x402, and repays with a fee: the vault's share price rises
   by exactly that fee. Each step links to its transaction.
   Also run on Tachi signet: [deposit](https://signet.tachibtcscan.com/tx/b41073c40ffc849732e7ad95e470c515d56742060077520fe1adad644a63d9ea),
   [withdrawal](https://signet.tachibtcscan.com/tx/9afa337a9a64729f2ecf5e8f7f8b67dabedc2e399fb86bc7ed98bcf31b2a485e),
   [loan](https://signet.tachibtcscan.com/tx/d7c207b1b0a9e3acde6c1294a7fd67bf5c0fa988477c749487adaca30c247ef5),
   [repayment](https://signet.tachibtcscan.com/tx/85421d09a5ad11c8ef9fea43d9be91a01b0c956b5fb58b26822422e4dc5a8f09).
7. **Anchor the log on Tachi.** The event log's hash is written into a Tachi transaction; the
   *Signed events* section then shows whether the log still matches.
8. **Inspect.** Select an agent in *Agents*; see *On Nostr* for offers read from the relays.
9. **Optional: Add funds.** Open *Add funds*, send BTC to the shown address, paste the
   transaction ID, press *Deposit*. On signet, follow it on
   [mempool.space/signet](https://mempool.space/signet).

The first real payment also splits the treasury's large VTXO into 50 VTXOs of 2,000 sats, so later
payments move a few thousand sats on the explorer rather than the whole treasury.

### 5. Funding a new treasury

If *Make a real payment* is greyed out, the treasury is empty:

- **From the page:** *Create treasury* (if asked), then *Add funds* as in step 4.
- **From the terminal:**
  ```bash
  npm run fund              # prints the treasury's L1 address and Tachi balance
  # send BTC to that address, then:
  npm run fund -- <txid>    # waits for it to be mined, then deposits it to Tachi
  ```
  Use `npm run fund:signet` for signet. The same key is used on both networks.

---

## Self-custody: TAURUS vault proof of concept

`npm run taurus` (regtest) creates a real TAURUS vault with
[`@tachibtc/taurus-vault-core`](https://www.npmjs.com/package/@tachibtc/taurus-vault-core) and shows
the owner can always get their bitcoin back alone:

1. A vault address on L1 with two spend paths: the owner + a 5-of-7 Tachi validator quorum
   (cooperative), or the owner alone after 144 blocks (~1 day; unilateral exit). The key path is a
   NUMS point, so nobody else can spend it.
2. Funds it with a 100,000-sat L1 deposit and registers it on Tachi (`TxVaultOpen`); Tachi lists it as
   `open` with `csv_delay: 144`, `threshold: 5`, a 7-key quorum.
3. Builds and signs the owner's unilateral exit with no daemon or validator involved. bitcoind
   refuses it today (`non-BIP68-final`) and accepts it once the deposit has 144 confirmations: the
   timelock, not the operator, decides.

The owner seed is saved to `.env` as `TAURUS_MNEMONIC` (back it up); progress and the signed exit are
saved in `data/`, so a rerun resumes. First run on regtest: vault
`96e7cb2fed5357915fae83712cc35c5ed69d2071e278517b37a63f6653f5251a`, deposit
`b9579723b02a58932ac1dfceb8c6b55019be8f438afb3a613ad2b54d4199b9cf`.

## Command reference

| Command | What it does |
| --- | --- |
| `npm run server` / `server:signet` | API + dashboard on :4402 |
| `npm run seed` | same as *Add demo agents*, against a running server |
| `npm run live` / `live:signet` | same as *Make a real payment*; starts a server if none is running |
| `npm run fund` / `fund:signet` | show the treasury, or deposit an L1 transaction |
| `npm run demo` | offline end-to-end run with simulated payments and self-checks |
| `npm test` | SDK unit tests (identity, reputation, vault, budget, TachiTx encoding) |
| `npm run walkthrough` | records the narrated walkthrough → `docs/demo-walkthrough.mp4` + `.srt` |
| `npm run record` | records the 40-second preview → `docs/demo-preview.mp4` |
| `npm run screenshots` | captures `docs/screenshots/*.png` |
| `npm run taurus` | TAURUS vault proof of concept: create, deposit, register, signed unilateral exit (regtest) |

The three recording commands drive the real app in Google Chrome on a throwaway server (port
4410), run the real actions (about 1,000 sats per run, plus public relay traffic), and need `ffmpeg`. Narration uses the open-source
[Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) voice model, run locally (downloaded on
first use); pick a voice with `NARRATOR_VOICE=am_michael`, or use macOS speech with `NARRATOR=say`.

The buttons and the scripts run the same code (`apps/server/src/flows.ts`).

### Troubleshooting

- **"Can't reach Tachi regtest" in the header:** the daemon URL in `.env` is wrong or the node is
  down. Simulated payments keep working.
- **"The dashboard can't reach its server":** start it with `npm run server`.
- **Real payment fails with "insufficient Tachi balance":** fund the treasury (step 5).
- **Treasury shows "an unknown amount" and the buttons stay grey:** the Tachi daemon isn't
  answering balance queries (a stalled regtest node does this). Try again later or switch to signet.
- **"No relay accepted the offer":** check your internet connection, or set `NOSTR_RELAYS`
  (comma-separated `wss://` URLs).
- **Port 4402 in use:** stop the other server, or set `PORT=4403`.
- **Data disappeared after a restart:** state is kept in memory; press *Add demo agents* again.
  On-chain transactions and the treasury balance are unaffected.

---

## How it works

### x402 with on-chain settlement

```
agent  → GET /services/btc-data/<seller>
server → 402 { x402Version: 1, accepts: [{ scheme: "exact", network: "tachi-regtest",
                maxAmountRequired: "50", payTo, resource, asset: "sats" }, …] }
agent  → signs a Tachi TRANSFER to payTo with its own key; the validators commit it
agent  → GET …   X-PAYMENT: base64{ scheme, network, payload: { txRef, payer, resource, signature } }
server → checks: signature by payer over (txRef, resource)? resource matches? txRef unused?
         committed on Tachi, signed by payer, paying payTo ≥ price?
server → 200 { data }   X-PAYMENT-RESPONSE: base64{ success, transaction, network, payer }
```

In code, the client side is one call: `x402Fetch(url, init, { wallet, budget })`.

The claim signature is what makes on-chain proofs safe: a txRef is public on the explorer, but
only the payer's key can claim it. Each proof works once, for one resource. Simulated mode uses
the same headers with scheme `simulated` (the server mints the proof via `POST /pay`).

### Private dataset delivery

The purchase response contains `{ contentHash, delivery: { scheme: "nip44", ephemeralPubkey,
ciphertext } }`: the dataset sealed to the payer's Nostr key with a one-time key. The buyer opens it
with `openDelivery()` and compares the SHA-256 with `contentHash`.

### Nostr discovery and messaging

Agents publish a kind-0 profile and NIP-89 offers (kind 31990, tagged `t: tachi-agent-economy`,
with price, x402 resource and network) to public relays, and find each other by querying that tag.
They talk in NIP-17 gift-wrapped DMs; each side logs the message it sent or received as a signed
event, so conversations are part of the audit trail.

### Auditable log

Each signed event is appended to the log in order. Its hash chain (`h = sha256(h ‖ eventId)`) is
anchored on Tachi as a 1-sat output to `P + H(P ‖ root)·G` (pay-to-contract on the payer's key P),
so anyone with the payer's pubkey and the root can check the anchor on the explorer. The server
re-computes the chain on every read and shows whether it still matches each anchor.

Nostr keys are BIP-340 keys, the same kind Tachi uses for VTXO owners, so an agent's npub owns
Tachi funds directly. `tachiTx.ts` encodes and signs transactions byte-for-byte as the daemon does
(`daemon/types/types.go`), checked against the live daemon.

### Layout

```
packages/agent-sdk/            reusable core
  identity.ts                  Nostr keypair, sign/verify
  eventLog.ts                  append-only, signature-checked event log (SQLite, in memory)
  reputation.ts                reputation computed from the log
  directory.ts                 agent and service registry
  budget.ts                    per-agent spending caps
  yield.ts                     YieldVault: ERC4626-style share accounting
  vaultBook.ts                 the vault's books: ledger replay, loans, yield, write-offs, credit terms
  network.ts                   regtest/signet settings from env
  x402.ts                      x402 messages, payer-signed claims, x402Fetch()
  delivery.ts                  NIP-44 sealed delivery to a buyer's key
  nostr.ts                     relays: profiles, NIP-89 offers, discovery, NIP-17 messages
  auditChain.ts                event-log hash chain
  payment/
    tachiTx.ts                 TachiTx wire format and BIP-340 signing
    tachiProvider.ts           real payments: parallel-safe coin selection, change-making, transfer
    funding.ts                 treasury L1 address, L1 → Tachi deposit
    simulatedProvider.ts       in-process payments

apps/server/                   Express API, serves the dashboard
  x402.ts                      requirePayment: x402 challenge, claim + on-chain verification
  flows.ts                     the demo flows (buttons and CLI)
  routes/                      agents, pay, services, vault, datasets, merchants, daemon, demo,
                               nostr (discovery, inspector), audit (anchors)

apps/dashboard/                React + Vite + Tailwind
demo/                          CLI wrappers (run, seed, live, fund) and video/screenshot recorders
docs/                          preview + walkthrough videos, subtitles, screenshots
```

### API

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/agents/register` | register an agent |
| `GET` | `/agents` | agents with reputation |
| `POST`/`GET` | `/agents/:pubkey/budget` | set or read a spending cap |
| `POST` | `/events` | publish a signed event |
| `GET` | `/events`, `/events/:pubkey` | event log |
| `POST` | `/pay` | simulated settlement (real payments go straight to `X-PAYMENT`) |
| `GET` | `/payments` | payment history with explorer links |
| `GET` | `/services/{btc-data,search,inference}/:pubkey` | x402-gated services |
| `POST` | `/vault/deposit`, `/vault/repay` | credit a verified Tachi transfer to the vault key |
| `POST` | `/vault/withdraw`, `/vault/borrow` | signed Nostr request; the vault pays out on Tachi |
| `GET` | `/vault/summary`, `/vault/terms/:pubkey`, `/vault/balance/:pubkey` | books, reserves, risk, ledger; an agent's credit terms |
| `POST`/`GET` | `/datasets`, `/datasets/:id/purchase` | list datasets; buy (x402, sealed delivery) |
| `POST` | `/datasets/:id/ratings` | a buyer's signed rating |
| `GET` | `/agents/:pubkey/inspect` | identity, publications, payments, events with signatures re-checked |
| `GET` | `/nostr/services` | offers found on the relays |
| `POST` | `/nostr/published` | record an agent's signed relay publication |
| `GET`/`POST` | `/audit/root`, `/audit/anchors` | log root; anchors (verified on chain) |
| `POST`/`GET` | `/products`, `/products/:id/checkout` | merchant catalog; checkout (x402) |
| `GET` | `/daemon/{health,vtxos,balance/:address}` | read-only Tachi proxy |
| `GET` | `/config` | network and explorer URLs |
| `GET`/`POST` | `/demo/treasury` | treasury status; create the key |
| `POST` | `/demo/{seed,pay,nostr,dataset,burst,anchor,fund}` | start a dashboard action |
| `GET` | `/demo/job` | progress of the current action |

---

## Known limits

- **The run panel has no login.** Anyone who can reach the server can spend the treasury, whose
  key the server holds. Keep it on localhost, or add auth before deploying.
- **State is in memory.** Restarting clears agents, events and listings (not on-chain data).
- **L1 finality is "mined in one block"** for deposits, until confirmation depth is wired.
- **Budgets:** `x402Fetch` enforces an agent's own budget; the server's `/agents/:pubkey/budget`
  caps simulated payments.
- **Payment rate is set by Tachi's commit time** (a few seconds); parallel payments from separate
  VTXOs share blocks, which is how a burst reaches several per second.
- **Sealed deliveries are one NIP-44 payload** (up to 64 KB); larger datasets need chunking.
- **Each anchor costs 1 sat + fee**; the 1-sat output is a commitment, not meant to be spent.
- **The yield vault's key is held by the server** (derived from the treasury key), so pooled deposits
  are not yet self-custodial. The ledger is saved per network in `data/vault-<network>.json` and
  replayed on start. The path to self-custody is proven separately with a real TAURUS vault
  (`npm run taurus`, below); wiring lending to it is the next step.
- **One yield source:** loans to agents. Rebalancing is the utilization cap between lending and
  liquid reserves, not yet across other Tachi DeFi primitives.
- **Reputation is a simple weighted score** (`jobs × 2 + rating × 15`), not a fraud-resistant model.
- **Small amounts read as 0.0000 BTC on the explorer**, which shows four decimals; the exact sats
  are in the transaction's outputs and on the dashboard.
