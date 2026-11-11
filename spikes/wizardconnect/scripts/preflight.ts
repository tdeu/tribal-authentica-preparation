// PRE-HACKATHON SPIKE — NOT PART OF THE SUBMISSION
// Offline check (MockNetworkProvider, throwaway keys) that the A/B/C transactions we send to the
// wallet are correct, and that src/verify.ts classifies wallet failures correctly.
//   npm run preflight
import { MockNetworkProvider, SignatureTemplate, randomUtxo } from 'cashscript';
import { compileFile } from 'cashc';
import { generatePrivateKey, binToHex } from '@bitauth/libauth';
import { AMOUNTS, buildA, buildB, buildC, makeContract, userFromPubkey, p2pkh, commit, type Built, type User } from '../src/txs.js';
import { diagnose, type Verdict } from '../src/verify.js';
import { refSign, type RefMode } from './refwallet.js';
import { makeDryRun, DRY_RUN_ERROR } from '../src/dryrun.js';
import { toWire } from '../src/wire.js';
import { seleneAccepts } from './selene-compat.js';
import type { WcTransactionObject } from 'cashscript';
import type { InputPath } from '../src/txs.js';

const artifact = compileFile(new URL('../../vault/RoyaltyVault.cash', import.meta.url));
const provider = new MockNetworkProvider();
const key = () => new SignatureTemplate(generatePrivateKey());
const seleneKey = key(), artisanKey = key(), strangerKey = key();
const artisanLock = p2pkh(userFromPubkey(artisanKey.publicKey, 'chipnet').pkh);
const contract = makeContract({ artifact, artisanLock: binToHex(artisanLock), royaltyBps: String(AMOUNTS.ROYALTY_BPS), minRoyalty: String(AMOUNTS.MIN_ROYALTY) }, provider);

const local: User = userFromPubkey(seleneKey.publicKey, 'chipnet', seleneKey);
const remote: User = { ...local, local: undefined }; // same key, placeholder mode (what the page does)
const returnAddr = userFromPubkey(strangerKey.publicKey, 'chipnet').address;

provider.addUtxo(local.address, randomUtxo({ satoshis: 20_000n }));
provider.addUtxo(local.address, randomUtxo({ satoshis: 3_000n }));
const nft = (owner: Uint8Array, price: bigint) => {
  const u = randomUtxo({ satoshis: AMOUNTS.VAULT_SATS });
  const category = binToHex(crypto.getRandomValues(new Uint8Array(32)));
  provider.addUtxo(contract.address, { ...u, token: { category, amount: 0n, nft: { capability: 'mutable', commitment: commit(owner, price, 0n) } } });
  return category;
};
const catB = nft(userFromPubkey(artisanKey.publicKey, 'chipnet').pkh, AMOUNTS.PRICE_B);
const catC = nft(local.pkh, 0n);

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`);
};

async function caseRun(label: string, build: (u: User) => Promise<Built>) {
  console.log(`\n${label}`);
  // 1. Same tx, signed locally by CashScript -> proves the tx itself is valid
  try { (await build(local)).tb.debug(); check('locally-signed version passes the VM', true); }
  catch (e: any) { check('locally-signed version passes the VM', false, String(e.message).split('\n')[0]); }

  // 2. Placeholder version -> WC object -> reference wallet -> diagnose
  const b = await build(remote);
  const wc = b.tb.generateWcTransactionObject({ broadcast: false });
  console.log(`        inputPaths ${JSON.stringify(b.inputPaths)}`);
  const expect: [RefMode, Verdict][] = [['correct', 'valid'], ['wrong-key', 'wallet']];
  if (b.inputPaths.some(([i]) => wc.sourceOutputs[i].contract)) expect.push(['ignore-contract-placeholders', 'wallet']);
  for (const [mode, want] of expect) {
    const d = diagnose(wc, b.inputPaths, refSign(wc, b.inputPaths, seleneKey, mode, strangerKey), local.pkh);
    check(`ref wallet "${mode}" -> diagnosis "${d.verdict}" (want "${want}")`, d.verdict === want, d.verdict !== want ? d.lines.join('\n        ') : '');
  }
  wireChecks('', wc, b.inputPaths);
}

// The request must survive the relay's plain JSON.stringify and pass Selene's request checks.
function wireChecks(prefix: string, wc: WcTransactionObject, inputPaths: InputPath[]) {
  let rawThrows = false;
  try { JSON.stringify({ transaction: wc, inputPaths }); } catch { rawThrows = true; }
  check(`${prefix}raw CashScript WC object is NOT JSON-safe (the bug we fixed)`, rawThrows);
  const wire = toWire(wc);
  // Same shape as the SignTransactionRequest the dapp library sends
  const request = { action: 'sign_transaction_request', time: 0, sequence: 1, transaction: wire, inputPaths };
  let json = '';
  try { json = JSON.stringify(request); check(`${prefix}converted request survives JSON.stringify (${json.length} chars)`, true); }
  catch (e: any) { check(`${prefix}converted request survives JSON.stringify`, false, e.message); return; }
  check(`${prefix}transaction is a hex string`, typeof wire.transaction === 'string' && /^[0-9a-f]+$/.test(wire.transaction));
  try {
    const parsed = JSON.parse(json);
    const view = seleneAccepts(parsed.transaction, parsed.inputPaths);
    const sameValues = view.sourceOutputs.every((o, i) => o.valueSatoshis === (wc.sourceOutputs[i] as any).valueSatoshis);
    check(`${prefix}after JSON round-trip, passes Selene's request checks (amounts intact: ${sameValues})`, sameValues);
  } catch (e: any) { check(`${prefix}after JSON round-trip, passes Selene's request checks`, false, e.message); }
}

await caseRun(`A. send ${AMOUNTS.SEND_A} sats`, (u) => buildA(provider, u, returnAddr));
await caseRun(`B. buy NFT-B at ${AMOUNTS.PRICE_B}`, (u) => buildB(provider, contract, artisanLock, u, catB));
await caseRun(`C. list NFT-C at ${AMOUNTS.LIST_C} (contract sig + pubkey placeholders)`, (u) => buildC(provider, contract, u, catC, AMOUNTS.LIST_C));

// ---------------------------------------------------------------- mainnet sign-only dry run env
console.log('\nDRY RUN env (mainnet addresses, fake UTXOs, DryRunProvider — what the page uses with an xpub wallet)');
const mainLocal = userFromPubkey(seleneKey.publicKey, 'mainnet', seleneKey);
const mainRemote: User = { ...mainLocal, local: undefined };
const env = makeDryRun(mainRemote);
check(`addresses are mainnet (${mainRemote.address.split(':')[0]}, vault ${env.contract.address.split(':')[0]})`,
  mainRemote.address.startsWith('bitcoincash:') && env.contract.address.startsWith('bitcoincash:'));
const dryBuilders: [string, (u: User) => Promise<Built>][] = [
  ['A', (u) => buildA(env.provider, u, env.returnAddress)],
  ['B', (u) => buildB(env.provider, env.contract, env.artisanLock, u, env.catB)],
  ['C', (u) => buildC(env.provider, env.contract, u, env.catC, AMOUNTS.LIST_C)],
];
for (const [id, b] of dryBuilders) {
  try { (await b(mainLocal)).tb.debug(); check(`${id}: locally-signed version passes the VM`, true); }
  catch (e: any) { check(`${id}: locally-signed version passes the VM`, false, String(e.message).split('\n')[0]); }
  const built = await b(mainRemote);
  const wc = built.tb.generateWcTransactionObject({ broadcast: false });
  const d = diagnose(wc, built.inputPaths, refSign(wc, built.inputPaths, seleneKey), mainRemote.pkh);
  check(`${id}: ref wallet "correct" -> "${d.verdict}"`, d.verdict === 'valid', d.verdict !== 'valid' ? d.lines.join('\n        ') : '');
  wireChecks(`${id}: `, wc, built.inputPaths);
}
try { await env.provider.sendRawTransaction(); check('DryRunProvider.sendRawTransaction throws', false); }
catch (e: any) { check(`DryRunProvider.sendRawTransaction throws ("${e.message}")`, e.message === DRY_RUN_ERROR); }

console.log(`\n${failures ? `${failures} FAILED` : 'All preflight checks PASS'}`);
process.exit(failures ? 1 : 0);
