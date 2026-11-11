# Decisions

## D1 — The certificate NFT always lives in the contract (9 Nov 2026)

**Chosen:** one MUTABLE CashTokens NFT per mask, locked forever in the RoyaltyVault covenant.
Commitment = `ownerPkh (20 bytes) || price (8 bytes LE, 0 = not for sale)`. The artisan is a contract parameter.

**Dropped:** README v1 model (immutable NFT in the owner's wallet, locked into a listing covenant only while for sale).
**Why:** in v1 the owner holds the NFT and can transfer it outside the marketplace, which bypasses the royalty.
With the NFT stuck in the contract, the only way to change owner is `buy()`, which always pays the artisan.

**Consequences:**
- "Ownership" = the pkh in the commitment, not "holding the token in your wallet". Wallets won't show the mask as owned; the app must read it from the contract UTXO.
- Ownership timeline = history of commitments on that NFT.

## D2 — First sale pays 100 % to the artisan, no artisan signature needed (9 Nov 2026)

At mint, the commitment is directly `hash160(artisanPk) || firstSalePrice`: the mask is for sale from the start.
When `ownerPkh` is the artisan, `buy()` requires one output to the artisan >= price (instead of seller + royalty outputs).

## D3 — Royalty indexed on the last sale price (9 Nov 2026)

**Chosen:** the commitment also stores `lastSalePrice` (8 bytes), so it grows to 36 bytes. The royalty is
`max(price × bps, lastSalePrice × bps, minRoyaltySats)`. Each `buy()` writes `lastSalePrice = price`. At mint, `lastSalePrice = 0`.

**Why (anti wash-trade):** with a royalty based only on the current price, an owner who bought at 50 000 sats
can "resell" at 2 000 sats to an accomplice, pay a 200-sat royalty, and get the real payment off-chain.
With indexing, the artisan still gets at least 10 % of the last sale (5 000 sats).

**Limits accepted:**
- The protection works for one hop only. After a wash sale at 5 546, the next royalty is based on 5 546.
  Each hop still costs the cheater a full royalty on the previous price, so a wash is never cheaper than an honest sale.
- If the real market value falls, the owner cannot list below `10 % × lastSalePrice + 546`.
  For example, a mask bought at 50 000 cannot be relisted below 5 546. This is acceptable for hand-made masks, but it should be explained in the UI.

## D4 — Dust rules (9 Nov 2026)

- `list()` requires `newPrice == 0` or `newPrice >= minRoyalty + 546`, so the seller's share is never dust.
- `minRoyaltySats >= 546` is checked by the deploy script, since the contract cannot validate its constructor arguments.

## Wallet connection — spike 11 Nov

**Result:** a web page can get Selene to sign all three transaction shapes over WizardConnect,
including the resale case where the **contract** needs the owner's signature + pubkey.
Run as a **mainnet sign-only dry run** (fake inputs, nothing broadcast), all requests approved on Selene mobile:

| Case | What | Result |
|---|---|---|
| A | plain send, user P2PKH inputs (`placeholderP2PKHUnlocker` + `inputPaths`) | WORKS |
| B | `buy()`: user P2PKH inputs pay into the RoyaltyVault, vault input unsigned | WORKS |
| C | `list()`: vault input needs `ownerSig` + `ownerPk` (`placeholderSignature()` / `placeholderPublicKey()`, `inputPaths` entry on the vault input) | WORKS — Selene filled both placeholders, signature valid over the redeem script, BCH VM accepts |

Because C works, the fallback options (Paytaca for resale, BCH WalletConnect, redesigning `list()` around a P2PKH input) are not needed.

**Stack:** `@wizardconnect/core` 0.2.5 + `@wizardconnect/dapp` 0.2.2, `cashscript` 0.14.0 (`generateWcTransactionObject()` + hand-built `inputPaths`), `@bitauth/libauth` 3.0.0, Vite + TS, Selene mobile. Code: `spikes/wizardconnect/`.

**Findings:**
- **Approval, then xpubs.** Selene patches `@wizardconnect/wallet` 0.2.3: its first `wallet_ready` has `paths: []`. The xpubs come in a second `wallet_ready` only after the user approves the connection in Selene. Until then, sign requests are silently dropped. The dapp cannot request paths; the protocol has no such message. The network shows only in the xpub prefix (`xpub` mainnet / `tpub` testnet).
- **The transaction must be hex.** Selene rejects a decoded transaction object ("WizardConnect transaction must be hex encoded"). Send `binToHex(encodeTransaction(tx))`.
- **BigInt serialization.** The relay does a plain `JSON.stringify`, so CashScript's WC object throws "Do not know how to serialize a BigInt" before anything is sent. Convert `sourceOutputs` with `JSON.parse(stringify(...))` (libauth `stringify` → `<bigint: Xn>` / `<Uint8Array: 0x…>`, which Selene parses).
- **Placeholder filling confirmed.** In Selene's source, a contract input (`contract.artifact.contractName` + `redeemScript` present) skips the P2PKH ownership check. The 65-byte zero signature and 33-byte zero pubkey are replaced, signing over the redeem script with sighash `0x61` (ALL | UTXOS | FORKID; Selene refuses any other). Seen working in case C.
- **No chain lookups at signing time.** Selene validates request structure and P2PKH key ownership only, which is why fake inputs could be signed.
- **Chipnet not usable:** Selene web has no chipnet option (confirmed), so there was no chipnet run.

**Caveat:** inputs were fake and nothing was broadcast. Not yet proven: a real broadcast of A/B/C (needs real funds, or a Selene build with chipnet), and Selene's behaviour with real token UTXOs in its own wallet.

### Lessons for the real build

- **Sign requests can be re-sent on relay reconnect.** Case B went out twice with the same sequence. Dedupe by sequence and make submit idempotent.
- **Never rebuild a pending transaction on reconnect.** In the spike, fake state was rebuilt on reconnect. The real app must keep the exact tx it sent until it gets a response or a cancel.
- **The relay flaps every 10–30 s, and the tab must stay in front.** Handle reconnects (ignore stale `disconnect` messages older than the latest `wallet_ready`) and show the connection status to the user.
- **Demo with Selene mobile.** Selene web has no chipnet and can't paste `wiz://` links. Show a QR code plus a copy-link button.
- Tell the user to approve the connection in Selene first; until then nothing works and nothing errors.
- Time out sign requests and label failures by side: request not sent (ours), wallet error (Selene), no response.
