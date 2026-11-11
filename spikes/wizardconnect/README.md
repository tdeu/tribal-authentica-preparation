# PRE-HACKATHON SPIKE — NOT PART OF THE SUBMISSION

Can a web page get Selene Wallet to sign via WizardConnect? Chipnet only.

| Case | What | Wallet must sign |
|---|---|---|
| A | 1 000 sats from Selene receive/0 to the spike funder | P2PKH inputs (`placeholderP2PKHUnlocker`) |
| B | `buy()` NFT-B at 2 000 sats (100 % to artisan) | P2PKH inputs only; vault input has no sig |
| C | `list()` NFT-C at 5 000 sats | **contract input 0**: `placeholderSignature()` + `placeholderPublicKey()`, plus a P2PKH fee input |

## Run

```
npm install
npm run preflight            # offline: A/B/C valid + diagnosis logic, throwaway keys, no network
npx vite                     # http://localhost:5180
```

1. Selene on **chipnet**. Click **Connect**, paste the `wiz://` link into Selene (or scan the QR).
2. The page shows the key prefix: `tpub` = chipnet (go on), `xpub` = mainnet (buttons stay disabled).
3. Run the setup command the page prints (`npm run setup -- --selene bchtest:q...`). It mints NFT-B and NFT-C
   into the RoyaltyVault (`../vault/RoyaltyVault.cash`) and tops up Selene receive/0 from the chipnet
   spike funder (`../vault/.env`, never printed). Writes `public/deploy.json`.
4. Refresh, then run A, B, C. Each result says WORKS + txid, or FAILS + which side:
   - **WALLET side**: Selene returned an error, left placeholders as zeros, used a different key,
     produced a bad signature, or changed the tx.
   - **OUR side**: every wallet-side check passes but the BCH VM still rejects.

## Selene: approve the connection first

Selene patches `@wizardconnect/wallet` 0.2.3 (`patches/@wizardconnect__wallet@0.2.3.patch` in its repo):
the first `wallet_ready` carries `paths: []`, and the xpubs come in a second `wallet_ready` only after
the user clicks **Connect** in Selene's "Connect with WizardConnect" dialog. Until then Selene silently
drops sign requests (`if (!conn.isApproved) return;`), and rejecting the dialog sends a `disconnect`.
The dapp cannot request paths; the protocol has no such message. The page shows the dapp key to compare
with Selene's dialog, waits for the second `wallet_ready`, ignores `disconnect` messages older than the
latest `wallet_ready` / relay start, and times out sign requests after 180 s.
If the xpubs never arrive: "Manual override" → paste Selene's receive/0 `bitcoincash:` address.

## Mainnet sign-only dry run (Selene web has no chipnet)

If the wallet's keys are `xpub` (mainnet), the page switches to a dry run automatically:
A/B/C are built on **fake UTXOs** (random txids, `src/dryrun.ts`) with mainnet addresses, NFT-C owned
by Selene receive/0. Selene is asked to sign, the result goes through the same checks as the preflight,
and nothing is broadcast: the dry-run provider has no server and its `sendRawTransaction` throws, the
page returns before the broadcast step, and the fake inputs would be rejected by any node anyway.
No setup step is needed for the dry run.

The wallet never broadcasts (`broadcast: false`). The page verifies the signed tx locally and broadcasts
it itself, so node errors show verbatim.

Files: `src/txs.ts` (builders, shared with preflight), `src/verify.ts` (diagnosis),
`scripts/refwallet.ts` (reference signer used only by preflight), `scripts/setup.ts` (chipnet mint).
