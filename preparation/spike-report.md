# Spike report (pre-hackathon, 9 Nov 2026)

Two throwaway spikes on **chipnet only**: `RoyaltyVault` (one NFT per mask, resale royalty) and `PatronDispenser`
(fungible "Patron" tokens sold for a fixed price). Both work end to end on chipnet, and all bypass tests are rejected.
Code: `spikes/vault/` (`RoyaltyVault.cash`, `PatronDispenser.cash`, `demo.ts`, `patron.ts`, `lib.ts`).

## Versions

| Tool | Version |
|------|---------|
| Node | 22.14.0 (Windows 10, PowerShell) |
| cashscript / cashc | 0.14.0 (pragma `^0.14.0`) |
| @bitauth/libauth | 3.0.0 (keys, addresses, commitment encoding) |
| tsx | 4.23.15 |
| dotenv | 18.0.10 |
| Network | `ElectrumNetworkProvider('chipnet')` with default servers; `MockNetworkProvider` for the simulated runs |

mainnet-js was not used: cashscript's `TransactionBuilder` plus libauth covered wallets, minting and spending.

## What works

### RoyaltyVault (spec: `contract-spec.md`, decisions D1–D4)

- One contract per artisan (`artisanLockingBytecode`, `royaltyBps`, `minRoyaltySats`): 281 bytes, 149 opcodes.
- The NFT is minted already listed (owner = artisan). The first sale pays 100 % to the artisan, in one output.
- Resale: the royalty is `max(10 % × price, 10 % × lastSalePrice, floor)`, and the commitment records the new owner and the last sale price.
- 14 bypass tests are rejected. Each one changes one thing in an otherwise valid tx, and the contract line that rejects it is logged:
  - non-owner `list()` (2 variants);
  - transfer to buyer2 without `buy()` (2 variants);
  - `lastSalePrice` reset;
  - wash relist at 2 000 after a 50 000 sale;
  - `buy()` while not listed;
  - no artisan payment;
  - royalty sent to the buyer;
  - NFT taken out of the contract;
  - royalty not indexed on the last sale;
  - royalty 1 sat short;
  - seller underpaid by 1 sat;
  - floor-only case (10 % = 600 < floor 1 000).

| Step | Txid (chipnet) | Size |
|------|----------------|------|
| Funding | [85874c53…](https://chipnet.bch.ninja/tx/85874c532f785ccb7161245ca28f2a40594fa64ba6d945cf0e872c13853a6688) | 287 B |
| Mint (owner = artisan, listed at 50 000) | [f5dc5541…](https://chipnet.bch.ninja/tx/f5dc5541807132a4483106436f89e138a9fbc725cd52a65d423318011e1650db) | 300 B |
| buyer1 buys at 50 000 (artisan +50 000) | [dd295fa2…](https://chipnet.bch.ninja/tx/dd295fa2a8d1c29ebdf354c64825b234962feb840337128a81609b44fd1d08cf) | 683 B |
| buyer1 lists at 6 000 | [994c52c6…](https://chipnet.bch.ninja/tx/994c52c6f53f3f967b8a5104abea3d4737078c66a5da473504e2fa2627e11b6e) | 731 B |
| buyer2 buys at 6 000 (buyer1 +1 000, artisan +5 000) | [5e3df621…](https://chipnet.bch.ninja/tx/5e3df621fd827e9830c98c2213b0f992f4291c8f4ff1a4cbdaf9a40a646fd522) | 717 B |
| buyer2 lists at 2 000 (floor-only test) | [05ecb5d1…](https://chipnet.bch.ninja/tx/05ecb5d1a7db5acb39942492713ba5577ff3c2631f91698c87e5a63e13c3e615) | 731 B |

NFT category: `85874c532f785ccb7161245ca28f2a40594fa64ba6d945cf0e872c13853a6688`.

### PatronDispenser

- Parameters: `artisanLockingBytecode`, `patronPriceSats`, `patronCategory` (bytes32). The contract is 76 bytes before its parameters and 138 bytes once deployed, with 53 opcodes.
- `claim()` gives exactly 1 token for >= price paid to the artisan. The rest of the stock returns to the contract with the same category.
- **Emptying a UTXO:** when the stock is 1, there is no return output. The artisan gets price + the BCH that UTXO held.
  Chipnet confirms 0 outputs left at the contract and no empty or dust UTXO.
- **Parallel claims:** two claims on two different stock UTXOs were broadcast at the same time and both were accepted.
- 6 bypass tests are rejected:
  - take 2 tokens;
  - no artisan payment;
  - pay 999 instead of 1 000;
  - stock sent to the claimer;
  - category swap (fake tokens returned to the contract, real stock kept);
  - claim on a non-Patron UTXO.

| Step | Txid (chipnet) | Size |
|------|----------------|------|
| Funding A (artisan at vout 0) | [bbf20675…](https://chipnet.bch.ninja/tx/bbf20675d324153bfbc4e447a60c96e0e1a38f718fdbefc130a748136473f9bb) | 253 B |
| Funding B (attacker at vout 0) | [4fe9c806…](https://chipnet.bch.ninja/tx/4fe9c806a6cf6b88648df3c8642837aa917e129772c6b102d90306dce6c3f2c4) | 219 B |
| Patron genesis: 41 tokens over 5 UTXOs (10/10/10/10/1) | [cdcfb2a7…](https://chipnet.bch.ninja/tx/cdcfb2a79d7ef0af19f8fc2668731610c67c5b428d2394d3e8947c4dba65b84d) | 580 B |
| Fake token genesis (attacker) | [0aa10cf9…](https://chipnet.bch.ninja/tx/0aa10cf94cfff89f87cbcd5f1c408bde996ad5c83c43ec3b146465660d2cbb25) | 254 B |
| Parallel claim (buyer1) | [39ef44e6…](https://chipnet.bch.ninja/tx/39ef44e628e4705a11acd0447645ae5c55aa11cba14db746b47ce621b9292063) | 830 B |
| Parallel claim (buyer2) | [8a5cb001…](https://chipnet.bch.ninja/tx/8a5cb001bf809082818e2ab5ff93f975c7428a472abad6b9216f35c16a8c9d28) | 689 B |
| Emptying claim (stock 1 → 0) | [b7cb7256…](https://chipnet.bch.ninja/tx/b7cb725689565dd5a2de7dabb9fd5f9dbddf7defb79abeabd158516714ec21de) | 469 B |

Patron category: `bbf20675d324153bfbc4e447a60c96e0e1a38f718fdbefc130a748136473f9bb`. The artisan received +4 000 sats, as expected.

## What got stuck, and the fixes

| Problem | Fix |
|---------|-----|
| The brief locked the NFT to `this.activeBytecode`. That is the redeem script, never equal to an output's P2SH32 locking bytecode. | Compare with `tx.inputs[this.activeInputIndex].lockingBytecode`. |
| Two vault UTXOs in one tx could both "use" output 0, so the second NFT could leave. | The contract must be input 0, which allows one vault input per tx. The same rule applies to PatronDispenser. |
| A royalty under 546 sats can't even be built: the SDK refuses dust outputs before the contract runs. | `minRoyaltySats >= 546` is checked by the deploy script. `list()` requires price >= royalty + 546. |
| `bytes32` category parameter: the VM sees the category in reverse byte order compared with the txid shown by explorers. | Pass `hexToBin(txid).reverse()`. |
| Genesis must spend an outpoint with index 0. | Funding txs put the minter at vout 0. Only one genesis per funding tx. |
| `ElectrumNetworkProvider.disconnect()` throws ("Manual connection management is disabled"). | End the script with `process.exit()`. |
| The demo starts sending as soon as the funder has funds. A run meant only to print the funding needs started the chipnet scenario, and it was cut mid-way by output truncation. It resumed fine because the state is read from chain. | Lesson: the real deploy scripts need a dry-run by default and an explicit `--broadcast` flag. |

## Limits found

- **Commitment size:** the vault uses 36 bytes, under the 40-byte limit of the original CashTokens rules.
  I did not check whether the May 2026 upgrade changed this limit. Check before adding a field such as a metadata hash.
- **Fees:** at 1 sat/byte, a vault `buy` or `list` costs about 700 sats, because the 281-byte contract is in every spend. A Patron claim costs 470–830 sats, depending on how many UTXOs the claimer spends.
  This is negligible on mainnet, but buyers need price + about 1 000 sats.
- **Dust:** 546 sats for P2PKH. Token outputs were given 1 000 sats in the spikes, and the exact minimum was not measured.
- **Concurrency:**
  - Vault: one UTXO per mask, so two buyers of the same mask collide and the second gets a mempool conflict. Different masks never collide.
  - Patron: parallelism = number of stock UTXOs (5 here). Two claims on the same UTXO collide, so the client should pick a random UTXO and retry on another if it conflicts.
  - Each claim recreates its UTXO, so the number of UTXOs only drops when one is emptied. Unconfirmed chains (0-conf) worked throughout.
- **Ratchet effect of `lastSalePrice`:** after a 50 000 sale, the mask can't be listed below 5 546 even if its market value falls (D3).
- **Patron output layout has two shapes:** 3 outputs normally, 2 when the last token leaves. The client must handle both.
- **Forged NFTs at the vault address:** anyone can send an NFT with a fake commitment to the vault. Only the platform category counts.
  The vault doesn't take the category as a parameter yet; Patron does.
- **Test coverage:** bypass tests are checked by the local VM (`debug()`) and are never broadcast. The network's own rules on those txs are not tested, but none was accepted by the VM.

## To rewrite cleanly from 14 Nov (nothing from `spikes/` is copied)

1. **Contracts:** rewrite `RoyaltyVault` and `PatronDispenser` from `contract-spec.md`. Add the platform category as a vault parameter.
   Decide whether the vault is one contract per artisan, as in the spike, or one shared contract with the artisan in the commitment.
2. **Minting:** the platform holds a minting baton (one category for all masks) instead of one genesis per mask.
   Include the metadata hash: in an OP_RETURN, or in the commitment if the size allows.
3. **Signing:** use WizardConnect / XO wallet signing instead of WIFs in `.env`. Build buy, list and claim txs in the app for the user's wallet to sign.
4. **UTXO selection and fees:** select coins properly instead of "spend all wallet UTXOs". Pick a random Patron UTXO and retry on conflict.
5. **Deploy script:** dry-run by default. Check `minRoyaltySats >= 546` and `patronPriceSats >= 546`. Mainnet only after the chipnet suite passes.
6. **Tests:** turn the demo bypass tests into a vitest suite with `MockNetworkProvider` and `cashscript/vitest` matchers (`toFailRequire`).
7. **Indexer:** build the ownership timeline from the history of commitments on the NFT (owner, price, last sale).
8. **UI rules:** show the minimum listing price (`royalty + 546`) and the full cost (price + fees). Explain that the mask lives in the contract, not in the wallet.
