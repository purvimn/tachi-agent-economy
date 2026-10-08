# OP_Freedom submission — Tachi Agent Economy

Copy each field into the form.

## Project Name

Tachi Agent Economy

## Tag Line

AI agents that find each other on Nostr, pay over x402, borrow from a BTC yield vault, and settle in bitcoin on Tachi.

## Description

Tachi Agent Economy is a working economy of AI agents that discover each other, buy services and
data from each other, and pay in native sats on Tachi.

x402 on Bitcoin (#6): paid endpoints answer HTTP 402 in the x402 v1 format, with a Tachi payment
option. Agents use one SDK call, x402Fetch(), which pays with a VTXO transfer the agent signs
itself and retries with an X-PAYMENT proof. The proof is signed by the payer's key, so a
transaction seen on the explorer can't be claimed by anyone else; each proof works once, for one
endpoint, and the server checks the transaction on chain before serving. Payments run in
parallel from separate VTXOs: 25 paid requests settle in about seven seconds.

Training-data marketplace (#7): sellers list datasets; buyers pay on Tachi and receive the data
sealed to their own Nostr key (NIP-44), so the server never hands out plaintext. The buyer checks
the content hash, and only buyers who paid can rate, which gives every dataset a quality score.

Nostr agents and auditable logs (#8): every agent is a Nostr key with a profile on public relays.
Sellers publish NIP-89 service offers; buyers discover them on the relays and negotiate in NIP-17
encrypted messages. Every action is a signed event, reputation is computed from them, and the
event log's hash chain is anchored on Tachi, so any later edit is detectable. An inspector shows
each agent's identity, publications, payments and every signature, re-verified.

Yield primitives (#3): a BTC vault whose yield comes from agents. A deposit is a Tachi transfer to
the vault key, verified on chain before shares are minted; a withdrawal is a request the depositor
signs, paid back on Tachi. The vault lends depositors' sats to agents as working capital: an agent
borrows, spends the loan on x402 calls, earns by selling its own service, and repays with a fee
priced by its reputation. That fee raises the share price, so every sat of yield is a committed
transfer from an agent's real revenue. Credit needs a depositor's vouch, and that sponsor's
shares take any default first, so fresh keys can't borrow against the vault. At most 80% is lent
out; the rest stays liquid for withdrawals. The dashboard shows what the vault owes next to what
it holds on chain, yield earned, share price, utilization and write-offs, with a public ledger
that has a Tachi transaction on every line and replays to the same books.

It all runs from one dashboard, on Tachi regtest or signet. The vault was also run on signet: a
[loan](https://signet.tachibtcscan.com/tx/d7c207b1b0a9e3acde6c1294a7fd67bf5c0fa988477c749487adaca30c247ef5)
and its [repayment with fee](https://signet.tachibtcscan.com/tx/85421d09a5ad11c8ef9fea43d9be91a01b0c956b5fb58b26822422e4dc5a8f09).

## Tracks

- #6 x402 on Bitcoin
- #7 BTC-Settled AI Training Data Marketplace
- #8 Nostr-based Agents, Identity, and Auditable Logs
- #3 Yield Primitives

(#6, #7 and #8 are in the AI track; #3 is in the Institutional Bitcoin track. If the form allows
only one track per entry, check with the organizers before listing #3.)

## Team Members

_[fill in, comma separated]_

## Github Repo URL

https://github.com/purvimn/tachi-agent-economy — the README maps each bounty requirement to the
code and explains how to run it.

## Demo Video URL

Upload `Tachi-Agent-Economy-Demo-Walkthrough.mp4` to YouTube (unlisted works) and paste the
youtu.be link. In YouTube Studio → Subtitles, upload `Tachi-Agent-Economy-Demo-Walkthrough.srt`
as English captions.

`Tachi-Agent-Economy-Preview-40s.mp4` is the short silent teaser.

## Screenshots (12)

Upload the files in `screenshots/`, in order:

1. `01-high-frequency-payments.png` — 25 paid requests settled on Tachi in seconds (#6)
2. `02-payment-graph.png` — who paid whom; orange = settled on Tachi
3. `03-real-payment-in-progress.png` — an x402 payment, step by step (#6)
4. `04-nostr-discovery-and-private-messages.png` — offer found on relays, NIP-17 conversation (#8)
5. `05-dataset-sealed-delivery.png` — dataset bought, delivered sealed, hash-verified, rated (#7)
6. `06-agent-inspector.png` — an agent's identity, publications, payments and signatures (#8)
7. `07-offers-on-nostr.png` — service offers read from public relays (#8)
8. `08-dataset-marketplace.png` — datasets with buyer ratings and sales (#7)
9. `09-audit-log-anchored.png` — the signed event log, matching its Tachi anchor (#8)
10. `10-explorer-confirmed.png` — the anchor transaction on the Tachi explorer
11. `11-agent-loan-repaid.png` — an agent borrows from the vault, earns over x402, repays with a fee (#3)
12. `12-yield-vault.png` — the vault: owed vs. on chain, yield, share price, ledger (#3)

## Deployed Link

**https://tachi-agent-economy.up.railway.app** — live on Tachi signet. One service serves the API and
the dashboard; the run buttons make real signet payments and vault loans (signet sats, so safe to
click). It also runs locally (`npm install`, `npm run build`, `npm run server`, open localhost:4402).

Known limits for #3: the yield vault's pooled deposits sit under a server-held key, and
lending to agents is the only yield source so far. Self-custody is proven separately with a real
TAURUS vault on regtest (`npm run taurus`): the owner + 5-of-7 validator quorum cooperative path, and
a unilateral exit the owner signs alone, which bitcoind accepts only after the 144-block delay.
