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
