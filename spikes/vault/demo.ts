// PRE-HACKATHON SPIKE — NOT PART OF THE SUBMISSION
// RoyaltyVault demo on CHIPNET ONLY.
//   npx tsx demo.ts --mock    local simulated chain (no faucet needed)
//   npx tsx demo.ts           chipnet
//   npx tsx demo.ts --small   chipnet with smaller amounts (needs less from the faucet)
// Re-runnable: each run reads the vault NFT state from chain and continues from there.
import { Contract, TransactionBuilder, type Utxo, type Output } from 'cashscript';
import { compileFile } from 'cashc';
import { binToHex, hexToBin, bigIntToBinUint64LE, binToBigIntUint64LE } from '@bitauth/libauth';
import {
  MOCK, SMALL, EXPLORER, DUST, W, type Wallet, p2pkh, ownerName, provider,
  bchUtxos, balance, max, loadState, expectFail, summary, run,
} from './lib.js';

// ---- demo parameters (sats) ----
// Scenario: artisan sells at FIRST -> buyer1 tries a wash relist at WASH (rejected) -> buyer1 relists at RESALE
// -> buyer2 buys (royalty indexed on FIRST) -> buyer2 lists at FLOOR_LIST, where only the floor applies.
const P = SMALL
  ? { FIRST: 20_000n, WASH: 2_000n, RESALE: 3_000n, FLOOR_LIST: 2_000n, MIN_ROYALTY: 600n, FUND: { artisan: 4_000n, buyer1: 22_000n, buyer2: 5_000n } }
  : { FIRST: 50_000n, WASH: 2_000n, RESALE: 6_000n, FLOOR_LIST: 2_000n, MIN_ROYALTY: 1_000n, FUND: { artisan: 4_000n, buyer1: 52_000n, buyer2: 8_000n } };
const ROYALTY_BPS = 1000n;   // 10 %
const VAULT_SATS = 1000n;    // BCH carried by the NFT UTXO

// Deploy-time check the contract cannot do itself
if (P.MIN_ROYALTY < DUST) throw new Error(`minRoyaltySats (${P.MIN_ROYALTY}) must be >= dust (${DUST})`);

const artifact = compileFile(new URL('./RoyaltyVault.cash', import.meta.url));
const contract = new Contract(artifact, [p2pkh(W.artisan.pkh), ROYALTY_BPS, P.MIN_ROYALTY], { provider });
const { state, save, send } = loadState<{ category?: string; txs: { label: string; txid: string }[] }>('state', { txs: [] });

// ---------------------------------------------------------------- helpers
const commit = (pkh: Uint8Array, price: bigint, last: bigint) =>
  binToHex(new Uint8Array([...pkh, ...bigIntToBinUint64LE(price), ...bigIntToBinUint64LE(last)]));
const royaltyFor = (price: bigint, last: bigint) => max(price * ROYALTY_BPS / 10000n, last * ROYALTY_BPS / 10000n, P.MIN_ROYALTY);

function decode(u: Utxo) {
  const c = hexToBin(u.token!.nft!.commitment);
  return { ownerPkh: c.slice(0, 20), price: binToBigIntUint64LE(c.slice(20, 28)), last: binToBigIntUint64LE(c.slice(28, 36)) };
}
async function getVault(): Promise<Utxo | undefined> {
  return (await contract.getUtxos()).find((u) => u.token?.category === state.category && u.token?.nft);
}
const vaultOutput = (category: string, commitment: string, to: string = contract.tokenAddress): Output => ({
  to, amount: VAULT_SATS, token: { amount: 0n, category, nft: { capability: 'mutable', commitment } },
});
function payOutputs(ownerPkh: Uint8Array, price: bigint, last: bigint): Output[] {
  const artisanLock = p2pkh(W.artisan.pkh);
  if (binToHex(ownerPkh) === binToHex(W.artisan.pkh)) return [{ to: artisanLock, amount: price }];
  const royalty = royaltyFor(price, last);
  return [{ to: p2pkh(ownerPkh), amount: price - royalty }, { to: artisanLock, amount: royalty }];
}

// ---------------------------------------------------------------- tx builders
type PayFn = (owner: Uint8Array, price: bigint, last: bigint) => Output[];
type BuyOpts = { nftTo?: string; pay?: PayFn };
async function buildBuy(buyer: Wallet, o: BuyOpts = {}) {
  const vault = (await getVault())!;
  const { ownerPkh, price, last } = decode(vault);
  return new TransactionBuilder({ provider })
    .addInput(vault, contract.unlock.buy(buyer.pkh))
    .addInputs(await bchUtxos(buyer), buyer.tpl.unlockP2PKH())
    .addOutput(vaultOutput(state.category!, commit(buyer.pkh, 0n, price), o.nftTo))
    .addOutputs((o.pay ?? payOutputs)(ownerPkh, price, last))
    .addBchChangeOutputIfNeeded({ to: buyer.address, feeRate: 1 });
}

type ListOpts = { pk?: Uint8Array; newOwnerPkh?: Uint8Array; nftTo?: string; last?: bigint };
async function buildList(signer: Wallet, newPrice: bigint, o: ListOpts = {}) {
  const vault = (await getVault())!;
  const { ownerPkh, last } = decode(vault);
  return new TransactionBuilder({ provider })
    .addInput(vault, contract.unlock.list(o.pk ?? signer.pk, signer.tpl, newPrice))
    .addInputs(await bchUtxos(signer), signer.tpl.unlockP2PKH())
    .addOutput(vaultOutput(state.category!, commit(o.newOwnerPkh ?? ownerPkh, newPrice, o.last ?? last), o.nftTo))
    .addBchChangeOutputIfNeeded({ to: signer.address, feeRate: 1 });
}
const payArtisan = (amount: bigint): PayFn => (o, p) =>
  [{ to: p2pkh(o), amount: p - amount }, { to: p2pkh(W.artisan.pkh), amount }];

// ---------------------------------------------------------------- main
run(async () => {
  console.log(MOCK ? 'RoyaltyVault spike — MOCK NETWORK (local simulation, links are fake)' : 'RoyaltyVault spike — CHIPNET');
  console.log(`contract ${contract.address}  (${contract.bytesize} bytes, ${contract.opcount} ops)`);
  console.log(`params: royalty ${ROYALTY_BPS} bps, floor ${P.MIN_ROYALTY}, first ${P.FIRST}, wash ${P.WASH}, resale ${P.RESALE}, floor-test list ${P.FLOOR_LIST}\n`);

  // 1. funding
  if (!state.category) {
    const funderBal = await balance(W.funder);
    const need = P.FUND.artisan + P.FUND.buyer1 + P.FUND.buyer2 + 1000n;
    if (funderBal < need) {
      console.log(`Fund this chipnet address via https://tbch.googol.cash (need >= ${need} sats, has ${funderBal}):\n`);
      console.log(`  funder  ${W.funder.address}\n`);
      return;
    }
    console.log('1. Distribute faucet funds');
    // artisan output MUST be vout 0: a CashTokens genesis spends an outpoint with index 0
    const tb = new TransactionBuilder({ provider })
      .addInputs(await bchUtxos(W.funder), W.funder.tpl.unlockP2PKH())
      .addOutputs([
        { to: W.artisan.address, amount: P.FUND.artisan },
        { to: W.buyer1.address, amount: P.FUND.buyer1 },
        { to: W.buyer2.address, amount: P.FUND.buyer2 },
      ])
      .addBchChangeOutputIfNeeded({ to: W.funder.address, feeRate: 1 });
    const fundTxid = await send('funding', tb, W.artisan.address);

    // 2. mint, already listed: owner = artisan, price = first-sale price, lastSalePrice = 0
    console.log('2. Mint mutable NFT into the vault (owner = artisan, listed)');
    const genesis = (await bchUtxos(W.artisan)).find((u) => u.txid === fundTxid && u.vout === 0)!;
    state.category = genesis.txid;
    save();
    const mint = new TransactionBuilder({ provider })
      .addInput(genesis, W.artisan.tpl.unlockP2PKH())
      .addOutput(vaultOutput(state.category, commit(W.artisan.pkh, P.FIRST, 0n)))
      .addBchChangeOutputIfNeeded({ to: W.artisan.address, feeRate: 1 });
    await send('mint', mint, contract.tokenAddress);
  }

  const before = { artisan: await balance(W.artisan), buyer1: await balance(W.buyer1), buyer2: await balance(W.buyer2) };
  console.log(`\ncategory ${state.category}`);

  for (;;) {
    const vault = await getVault();
    if (!vault) throw new Error('vault NFT not found at contract address');
    const { ownerPkh, price, last } = decode(vault);
    const owner = ownerName(ownerPkh);
    console.log(`\nvault state: owner=${owner} price=${price} lastSalePrice=${last}`);

    if (owner === 'artisan' && price > 0n) {
      console.log(`3. buyer1 buys at ${price} (first sale, 100 % to artisan)`);
      await send('buy #1 (buyer1)', await buildBuy(W.buyer1), contract.tokenAddress);
    } else if (owner === 'buyer1' && price === 0n) {
      const minRoyalty = royaltyFor(P.WASH, last);
      console.log('Bypass tests (owner=buyer1, not listed) — must all be rejected:');
      await expectFail('list() signed by non-owner (buyer2 key + buyer2 sig)', () => buildList(W.buyer2, P.RESALE));
      await expectFail("list() with owner's pubkey but buyer2's signature", () => buildList(W.buyer2, P.RESALE, { pk: W.buyer1.pk }));
      await expectFail('buyer1 gives NFT to buyer2 via list() (owner changed in commitment)', () =>
        buildList(W.buyer1, 0n, { newOwnerPkh: W.buyer2.pkh }));
      await expectFail("buyer1 sends NFT to buyer2's wallet via list()", () =>
        buildList(W.buyer1, 0n, { nftTo: W.buyer2.tokenAddress }));
      await expectFail('list() resetting lastSalePrice to 0', () => buildList(W.buyer1, P.RESALE, { last: 0n }));
      await expectFail(`wash relist at ${P.WASH} after a ${last} sale (needs >= ${minRoyalty} + ${DUST})`, () =>
        buildList(W.buyer1, P.WASH));
      await expectFail('buy() while not listed (price = 0)', () => buildBuy(W.buyer2, { pay: () => [] }));
      console.log(`4. buyer1 lists for resale at ${P.RESALE}`);
      await send(`list (buyer1, ${P.RESALE} sats)`, await buildList(W.buyer1, P.RESALE), contract.tokenAddress);
    } else if (owner === 'buyer1' && price > 0n) {
      const royalty = royaltyFor(price, last);
      const unindexed = max(price * ROYALTY_BPS / 10000n, P.MIN_ROYALTY);
      console.log(`Bypass tests (owner=buyer1, listed at ${price}, royalty due ${royalty}) — must all be rejected:`);
      await expectFail('buy without paying the artisan', () =>
        buildBuy(W.buyer2, { pay: (o, p, l) => payOutputs(o, p, l).slice(0, 1) }));
      await expectFail("buy with royalty sent to buyer's own address", () =>
        buildBuy(W.buyer2, { pay: (o, p, l) => { const out = payOutputs(o, p, l); out[1] = { ...out[1], to: p2pkh(W.buyer2.pkh) }; return out; } }));
      await expectFail('buy taking NFT out of the contract (to buyer wallet)', () =>
        buildBuy(W.buyer2, { nftTo: W.buyer2.tokenAddress }));
      await expectFail(`royalty not indexed on last sale: artisan gets max(10 % of price, floor) = ${unindexed}`, () =>
        buildBuy(W.buyer2, { pay: payArtisan(unindexed) }));
      await expectFail(`royalty 1 sat short (${royalty - 1n})`, () => buildBuy(W.buyer2, { pay: payArtisan(royalty - 1n) }));
      await expectFail('seller underpaid by 1 sat', () =>
        buildBuy(W.buyer2, { pay: (o, p, l) => { const out = payOutputs(o, p, l); out[0] = { ...out[0], amount: out[0].amount - 1n }; return out; } }));
      console.log(`5. buyer2 buys at ${price} (buyer1 gets ${price - royalty}, artisan gets ${royalty})`);
      await send('buy #2 (buyer2)', await buildBuy(W.buyer2), contract.tokenAddress);
    } else if (owner === 'buyer2' && price === 0n) {
      console.log(`6. buyer2 lists at ${P.FLOOR_LIST}: 10 % of price and of last sale are both under the floor`);
      await send(`list (buyer2, ${P.FLOOR_LIST} sats)`, await buildList(W.buyer2, P.FLOOR_LIST), contract.tokenAddress);
    } else if (owner === 'buyer2' && price > 0n) {
      const pct = max(price * ROYALTY_BPS / 10000n, last * ROYALTY_BPS / 10000n);
      console.log(`Floor-only test (listed at ${price}, last sale ${last}, 10 % = ${pct} < floor ${P.MIN_ROYALTY}):`);
      // funder plays the buyer here: it is the only wallet with enough BCH left
      await expectFail(`artisan paid the % royalty (${pct}) instead of the floor (${P.MIN_ROYALTY})`, () =>
        buildBuy(W.funder, { pay: payArtisan(pct) }));
      console.log('  (mask stays listed by buyer2; no buy needed for the test)');
      break;
    } else {
      break;
    }
  }

  const after = { artisan: await balance(W.artisan), buyer1: await balance(W.buyer1), buyer2: await balance(W.buyer2) };
  console.log('\nBalances (sats, BCH only, this run):');
  for (const k of ['artisan', 'buyer1', 'buyer2'] as const)
    console.log(`  ${k.padEnd(7)} ${String(before[k]).padStart(6)} -> ${String(after[k]).padStart(6)}  (${after[k] - before[k] >= 0n ? '+' : ''}${after[k] - before[k]})`);
  console.log('\nAll transactions:');
  for (const t of state.txs) console.log(`  ${t.label.padEnd(26)} ${EXPLORER}${t.txid}`);
  summary();
});
