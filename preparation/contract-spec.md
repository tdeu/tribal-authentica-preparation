# RoyaltyVault — target spec

Status: validated by the pre-hackathon spike (see `spike-report.md`). To be rewritten cleanly after 14 Nov 2026.

## Model

- One **mutable** CashTokens NFT per mask, locked in the contract forever (see `decisions.md` D1).
- Commitment (36 bytes) = `ownerPkh` (20) || `price` (8 LE, 0 = not for sale) || `lastSalePrice` (8 LE).
- Contract parameters: `artisanLockingBytecode`, `royaltyBps`, `minRoyaltySats`.
  The deploy script refuses `minRoyaltySats < 546`.
- The vault input must be **input 0**, and the NFT always comes back as **output 0**.
- `royalty(price) = max(price × bps / 10000, lastSalePrice × bps / 10000, minRoyaltySats)` (see `decisions.md` D3).

## Mint (platform)

The genesis tx spends an outpoint with index 0. Its txid becomes the token category.
Output 0 goes to the contract's token address with commitment `hash160(artisanPk) || firstSalePrice || 0`, so the mask is listed from mint.

## `list(pubkey ownerPk, sig ownerSig, int newPrice)`

- `hash160(ownerPk) == ownerPkh` and `checkSig(ownerSig, ownerPk)`.
- `newPrice == 0` or `newPrice >= royalty(newPrice) + 546` (dust, D4).
- Output 0 has the same locking bytecode as input 0, the same `tokenCategory` (incl. the mutable capability byte), `tokenAmount == 0`, value >= input value, and commitment `ownerPkh || newPrice || lastSalePrice`.
- The owner and `lastSalePrice` cannot change. `newPrice = 0` delists.

## `buy(bytes20 buyerPkh)`

- `price > 0`.
- Output 0 has the same locking bytecode and category as above, and commitment `buyerPkh || 0 || price`.
- If `P2PKH(ownerPkh) == artisanLockingBytecode` (first sale, or the artisan reselling), output 1 goes to the artisan with value >= `price`.
- Otherwise:
  - output 1 goes to `P2PKH(ownerPkh)` with value >= `price - royalty(price)`;
  - output 2 goes to `artisanLockingBytecode` with value >= `royalty(price)`.

## Deviations from the first brief (validated 9 Nov)

| Brief | Spike | Why |
|-------|-------|-----|
| Output 0 locked to `this.activeBytecode` | Output 0 locked to `tx.inputs[this.activeInputIndex].lockingBytecode` | `activeBytecode` is the redeem script. An output's locking bytecode is the P2SH32 wrapper, so the two never compare equal. |
| Category read from `tx.inputs[this.activeInputIndex]` | `this.activeInputIndex == 0` is required, then `tx.inputs[0]` is used | With two vault UTXOs in one tx, both inputs would check the same output 0, and the second NFT could leave. Forcing index 0 allows only one vault input per tx. |
| First sale: two outputs to the artisan | One output to the artisan, >= price | Two outputs would also work, but one output is smaller and avoids two dust constraints. |

## Off-chain notes

- Any NFT sent to the contract address with a forged commitment is "valid" for the contract. The app must only trust the platform's category.
  Option for the final version: add the category as a contract parameter.
- The UI must show the minimum listing price (`royalty + 546`), because it can exceed what the owner expects after a high last sale.
