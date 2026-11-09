// PRE-HACKATHON SPIKE — NOT PART OF THE SUBMISSION
// PatronDispenser demo on CHIPNET ONLY.
//   npx tsx patron.ts --mock   local simulated chain
//   npx tsx patron.ts          chipnet (uses the funder wallet's remaining balance)
import { Contract, TransactionBuilder, type Utxo, type Output } from 'cashscript';
import { compileFile } from 'cashc';
import { hexToBin } from '@bitauth/libauth';
import {
  MOCK, EXPLORER, DUST, W, type Wallet, p2pkh, provider, bchUtxos, balance,
  loadState, expectFail, summary, run, waitForTx,
} from './lib.js';

const PATRON_PRICE = 1000n;
const STOCKS = [10n, 10n, 10n, 10n, 1n]; // 5 UTXOs; the last one is emptied by the demo
const DISPENSER_SATS = 1000n;           // BCH carried by each stock UTXO
const TOKEN_OUT_SATS = 1000n;           // BCH carried by the claimed token output
const FAKE_SUPPLY = 100n;               // attacker's own fungible tokens, for the category test
const FUND = { artisan: 8_000n, buyer1: 9_000n, buyer2: 6_000n };

if (PATRON_PRICE < DUST) throw new Error(`patronPriceSats (${PATRON_PRICE}) must be >= dust (${DUST})`);

type S = { category?: string; fakeCategory?: string; txs: { label: string; txid: string }[] };
const { state, save, send } = loadState<S>('state.patron', { txs: [] });
const artifact = compileFile(new URL('./PatronDispenser.cash', import.meta.url));

// The category is only known after the funding tx, so the contract is built lazily.
// VM introspection returns the category in internal byte order = reversed display txid.
let dispenser: Contract;
const makeDispenser = (category: string) =>
  new Contract(artifact, [p2pkh(W.artisan.pkh), PATRON_PRICE, hexToBin(category).reverse()], { provider });

const stockUtxos = async () =>
  (await dispenser.getUtxos()).filter((u) => u.token?.category === state.category && !u.token?.nft);
const fakeUtxo = async () =>
  (await provider.getUtxos(W.buyer1.tokenAddress)).find((u) => u.token?.category === state.fakeCategory);

type ClaimOpts = {
  returnTo?: string; returnAmount?: bigint; returnCategory?: string;
  artisanTo?: Uint8Array; artisanAmount?: bigint; tokenAmount?: bigint;
  extraInputs?: Utxo[]; extraOutputs?: Output[];
};
async function buildClaim(claimer: Wallet, utxo: Utxo, o: ClaimOpts = {}) {
  const stock = utxo.token!.amount;
  const tb = new TransactionBuilder({ provider })
    .addInput(utxo, dispenser.unlock.claim())
    .addInputs(await bchUtxos(claimer), claimer.tpl.unlockP2PKH());
  if (o.extraInputs) tb.addInputs(o.extraInputs, claimer.tpl.unlockP2PKH());
  if (stock > 1n) {
    tb.addOutput({
      to: o.returnTo ?? dispenser.tokenAddress, amount: utxo.satoshis,
      token: { amount: o.returnAmount ?? stock - 1n, category: o.returnCategory ?? state.category! },
    });
  }
  const artisanDue = stock > 1n ? PATRON_PRICE : PATRON_PRICE + utxo.satoshis;
  tb.addOutput({ to: o.artisanTo ?? p2pkh(W.artisan.pkh), amount: o.artisanAmount ?? artisanDue });
  tb.addOutput({ to: claimer.tokenAddress, amount: TOKEN_OUT_SATS, token: { amount: o.tokenAmount ?? 1n, category: state.category! } });
  if (o.extraOutputs) tb.addOutputs(o.extraOutputs);
  return tb.addBchChangeOutputIfNeeded({ to: claimer.address, feeRate: 1 });
}

async function printStock(title: string) {
  const us = await stockUtxos();
  console.log(`\n${title}: ${us.length} UTXOs, ${us.reduce((s, u) => s + u.token!.amount, 0n)} tokens`);
  for (const u of us) console.log(`  ${u.txid.slice(0, 12)}…:${u.vout}  ${u.token!.amount} tokens  ${u.satoshis} sats`);
}

run(async () => {
  console.log(MOCK ? 'PatronDispenser spike — MOCK NETWORK (local simulation, links are fake)' : 'PatronDispenser spike — CHIPNET');

  if (!state.category) {
    const need = FUND.artisan + FUND.buyer1 + FUND.buyer2 + 2000n;
    const funderBal = await balance(W.funder);
    if (funderBal < need) {
      console.log(`Fund ${W.funder.address} via https://tbch.googol.cash (need >= ${need} sats, has ${funderBal})`);
      return;
    }
    console.log('1. Funding (artisan at vout 0 for the Patron genesis, buyer1 at vout 0 of a 2nd tx for the fake tokens)');
    const fundA = await send('funding A', new TransactionBuilder({ provider })
      .addInputs(await bchUtxos(W.funder), W.funder.tpl.unlockP2PKH())
      .addOutputs([{ to: W.artisan.address, amount: FUND.artisan }, { to: W.buyer2.address, amount: FUND.buyer2 }])
      .addBchChangeOutputIfNeeded({ to: W.funder.address, feeRate: 1 }), W.funder.address);
    const fundB = await send('funding B', new TransactionBuilder({ provider })
      .addInputs(await bchUtxos(W.funder), W.funder.tpl.unlockP2PKH())
      .addOutput({ to: W.buyer1.address, amount: FUND.buyer1 })
      .addBchChangeOutputIfNeeded({ to: W.funder.address, feeRate: 1 }), W.buyer1.address);

    console.log(`2. Genesis: ${STOCKS.reduce((a, b) => a + b)} Patron tokens split over ${STOCKS.length} dispenser UTXOs`);
    state.category = fundA;
    dispenser = makeDispenser(fundA);
    const g = (await bchUtxos(W.artisan)).find((u) => u.txid === fundA && u.vout === 0)!;
    await send('patron genesis', new TransactionBuilder({ provider })
      .addInput(g, W.artisan.tpl.unlockP2PKH())
      .addOutputs(STOCKS.map((amount) => ({ to: dispenser.tokenAddress, amount: DISPENSER_SATS, token: { amount, category: fundA } })))
      .addBchChangeOutputIfNeeded({ to: W.artisan.address, feeRate: 1 }), dispenser.tokenAddress);

    console.log('3. Attacker (buyer1) mints its own fake fungible tokens');
    state.fakeCategory = fundB;
    const f = (await bchUtxos(W.buyer1)).find((u) => u.txid === fundB && u.vout === 0)!;
    await send('fake token genesis', new TransactionBuilder({ provider })
      .addInput(f, W.buyer1.tpl.unlockP2PKH())
      .addOutput({ to: W.buyer1.tokenAddress, amount: TOKEN_OUT_SATS, token: { amount: FAKE_SUPPLY, category: fundB } })
      .addBchChangeOutputIfNeeded({ to: W.buyer1.address, feeRate: 1 }), W.buyer1.tokenAddress);
    save();
  }
  dispenser ??= makeDispenser(state.category);
  console.log(`\ndispenser ${dispenser.tokenAddress}  (${dispenser.bytesize} bytes, ${dispenser.opcount} ops)`);
  console.log(`category ${state.category}`);
  await printStock('Stock');

  // ---- bypass tests on a big UTXO
  const big = (await stockUtxos()).find((u) => u.token!.amount > 2n)!;
  const stock = big.token!.amount;
  console.log(`\nBypass tests on a ${stock}-token UTXO — must all be rejected:`);
  await expectFail('take 2 tokens (stock - 2 returned)', () =>
    buildClaim(W.buyer2, big, { returnAmount: stock - 2n, tokenAmount: 2n }));
  await expectFail('do not pay the artisan (payment to claimer)', () =>
    buildClaim(W.buyer2, big, { artisanTo: p2pkh(W.buyer2.pkh) }));
  await expectFail(`pay under the price (${PATRON_PRICE - 1n})`, () =>
    buildClaim(W.buyer2, big, { artisanAmount: PATRON_PRICE - 1n }));
  await expectFail('send the rest of the stock to the claimer instead of the contract', () =>
    buildClaim(W.buyer2, big, { returnTo: W.buyer2.tokenAddress }));
  await expectFail('swap category: return fake tokens to the contract, keep the real stock', async () => {
    const fake = (await fakeUtxo())!;
    return buildClaim(W.buyer1, big, {
      extraInputs: [fake],
      returnCategory: state.fakeCategory, returnAmount: stock - 1n,
      extraOutputs: [
        { to: W.buyer1.tokenAddress, amount: TOKEN_OUT_SATS, token: { amount: stock - 1n, category: state.category! } },
        { to: W.buyer1.tokenAddress, amount: TOKEN_OUT_SATS, token: { amount: fake.token!.amount - (stock - 1n), category: state.fakeCategory! } },
      ],
    });
  });
  await expectFail('claim a UTXO that does not hold Patron tokens (fake tokens sent to the contract)', async () => {
    // Simulates a fake-category UTXO at the dispenser address without actually sending one
    const fake = (await fakeUtxo())!;
    const asIfAtContract: Utxo = { ...fake, lockingBytecode: dispenser.lockingBytecode } as Utxo;
    return new TransactionBuilder({ provider })
      .addInput(asIfAtContract, dispenser.unlock.claim())
      .addInputs(await bchUtxos(W.buyer2), W.buyer2.tpl.unlockP2PKH())
      .addOutput({ to: dispenser.tokenAddress, amount: fake.satoshis, token: { amount: fake.token!.amount - 1n, category: state.fakeCategory! } })
      .addOutput({ to: p2pkh(W.artisan.pkh), amount: PATRON_PRICE })
      .addOutput({ to: W.buyer2.tokenAddress, amount: TOKEN_OUT_SATS, token: { amount: 1n, category: state.fakeCategory! } })
      .addBchChangeOutputIfNeeded({ to: W.buyer2.address, feeRate: 1 });
  });

  // ---- 2 claims in parallel on 2 different UTXOs
  const artisanBefore = await balance(W.artisan);
  const [u1, u2] = (await stockUtxos()).filter((u) => u.token!.amount > 1n);
  console.log(`\n4. Two claims in parallel (buyer1 on ${u1.txid.slice(0, 8)}…:${u1.vout}, buyer2 on ${u2.txid.slice(0, 8)}…:${u2.vout})`);
  const [tb1, tb2] = await Promise.all([buildClaim(W.buyer1, u1), buildClaim(W.buyer2, u2)]);
  const t0 = Date.now();
  const [r1, r2] = await Promise.allSettled([tb1.send(), tb2.send()]);
  for (const [who, r] of [['buyer1', r1], ['buyer2', r2]] as const) {
    if (r.status === 'fulfilled') {
      state.txs.push({ label: `parallel claim (${who})`, txid: r.value.txid });
      console.log(`  ✔ ${who} claim accepted\n    ${EXPLORER}${r.value.txid}`);
    } else console.log(`  ✘ ${who} claim rejected: ${String(r.reason?.message ?? r.reason).split('\n')[0]}`);
  }
  save();
  console.log(`  both broadcast in ${Date.now() - t0} ms`);
  for (const r of [r1, r2]) if (r.status === 'fulfilled') await waitForTx(dispenser.tokenAddress, r.value.txid);

  // ---- claim that empties a UTXO
  const last = (await stockUtxos()).find((u) => u.token!.amount === 1n);
  if (last) {
    console.log(`\n5. Claim the last token of ${last.txid.slice(0, 8)}…:${last.vout} (stock 1 -> 0)`);
    const txid = await send('emptying claim (buyer2)', await buildClaim(W.buyer2, last), W.buyer2.tokenAddress);
    const leftovers = (await provider.getUtxos(dispenser.tokenAddress))
      .filter((u) => u.txid === txid);
    console.log(`  outputs of that tx left at the contract: ${leftovers.length} (expected 0: no empty/dust UTXO)`);
  }

  await printStock('Stock after');
  const artisanAfter = await balance(W.artisan);
  console.log(`\nartisan BCH: ${artisanBefore} -> ${artisanAfter} (+${artisanAfter - artisanBefore}; expected +${3n * PATRON_PRICE + DISPENSER_SATS})`);
  const mine = async (w: Wallet) => (await provider.getUtxos(w.tokenAddress))
    .filter((u) => u.token?.category === state.category).reduce((s, u) => s + u.token!.amount, 0n);
  console.log(`Patron tokens held: buyer1 ${await mine(W.buyer1)}, buyer2 ${await mine(W.buyer2)}`);
  console.log('\nAll transactions:');
  for (const t of state.txs) console.log(`  ${t.label.padEnd(26)} ${EXPLORER}${t.txid}`);
  summary();
});
