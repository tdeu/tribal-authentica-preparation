// PRE-HACKATHON SPIKE — NOT PART OF THE SUBMISSION
// Shared helpers for the chipnet spikes (wallets, provider, send, bypass-test runner).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import {
  ElectrumNetworkProvider, MockNetworkProvider, SignatureTemplate, TransactionBuilder, randomUtxo,
  FailedTransactionError, FailedRequireError, type Utxo,
} from 'cashscript';
import { generatePrivateKey, encodePrivateKeyWif, hash160, encodeCashAddress, binToHex, hexToBin } from '@bitauth/libauth';

export const DIR = path.dirname(fileURLToPath(import.meta.url));
export const MOCK = process.argv.includes('--mock'); // local simulated chain, no faucet needed
export const SMALL = process.argv.includes('--small');
export const EXPLORER = 'https://chipnet.bch.ninja/tx/';
export const DUST = 546n;

// ---------------------------------------------------------------- wallets
export type Wallet = { name: string; tpl: SignatureTemplate; pk: Uint8Array; pkh: Uint8Array; address: string; tokenAddress: string };
const NAMES = ['funder', 'artisan', 'buyer1', 'buyer2'] as const;

function loadWallets(): Record<(typeof NAMES)[number], Wallet> {
  const env = path.join(DIR, '.env');
  if (fs.existsSync(env)) dotenv.config({ path: env, quiet: true });
  const missing = NAMES.filter((n) => !process.env[`${n.toUpperCase()}_WIF`]);
  if (missing.length) {
    const lines = missing.map((n) => `${n.toUpperCase()}_WIF=${encodePrivateKeyWif(generatePrivateKey(), 'testnet')}`);
    fs.appendFileSync(env, '# CHIPNET ONLY - never commit, never use on mainnet\n' + lines.join('\n') + '\n');
    dotenv.config({ path: env, override: true, quiet: true });
  }
  const make = (name: string): Wallet => {
    const tpl = new SignatureTemplate(process.env[`${name.toUpperCase()}_WIF`]!);
    const pk = tpl.publicKey;
    const pkh = hash160(pk) as Uint8Array;
    return {
      name, tpl, pk, pkh,
      address: encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: pkh }).address,
      tokenAddress: encodeCashAddress({ prefix: 'bchtest', type: 'p2pkhWithTokens', payload: pkh }).address,
    };
  };
  return Object.fromEntries(NAMES.map((n) => [n, make(n)])) as any;
}

export const W = loadWallets();
export const p2pkh = (pkh: Uint8Array) => hexToBin('76a914' + binToHex(pkh) + '88ac');
export const ownerName = (pkh: Uint8Array) =>
  Object.values(W).find((w) => binToHex(w.pkh) === binToHex(pkh))?.name ?? binToHex(pkh);

// ---------------------------------------------------------------- network
export const provider = MOCK ? new MockNetworkProvider() : new ElectrumNetworkProvider('chipnet');
if (MOCK) (provider as MockNetworkProvider).addUtxo(W.funder.address, { ...randomUtxo({ satoshis: 200_000n }) });

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const bchUtxos = async (w: Wallet) => (await provider.getUtxos(w.address)).filter((u) => !u.token);
export const balance = async (w: Wallet) => (await bchUtxos(w)).reduce((s, u) => s + u.satoshis, 0n);
export const max = (...xs: bigint[]) => xs.reduce((a, b) => (a > b ? a : b));

export async function waitForTx(address: string, txid: string) {
  for (let i = 0; i < 60; i++) {
    if ((await provider.getUtxos(address)).some((u: Utxo) => u.txid === txid)) return;
    await sleep(1000);
  }
  throw new Error(`tx ${txid} not seen at ${address} after 60 s`);
}

// ---------------------------------------------------------------- per-demo state (txid log)
export type TxLog = { label: string; txid: string }[];
export function loadState<T extends { txs: TxLog }>(name: string, init: T) {
  const file = path.join(DIR, MOCK ? `${name}.mock.json` : `${name}.json`);
  if (MOCK && fs.existsSync(file)) fs.unlinkSync(file);
  const state: T = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : init;
  const save = () => fs.writeFileSync(file, JSON.stringify(state, null, 2));
  async function send(label: string, tb: TransactionBuilder, watch?: string) {
    const { txid } = await tb.send();
    state.txs.push({ label, txid });
    save();
    console.log(`  ✔ ${label}\n    ${EXPLORER}${txid}`);
    if (watch) await waitForTx(watch, txid);
    return txid;
  }
  return { state, save, send };
}

// ---------------------------------------------------------------- bypass tests
// A bypass test must be rejected. It is never broadcast unless the local VM accepted it.
export const results: { name: string; ok: boolean; detail: string }[] = [];
export async function expectFail(name: string, build: () => Promise<TransactionBuilder>) {
  let detail: string;
  let ok = false;
  try {
    const tb = await build();
    try {
      tb.debug();
      try {
        const { txid } = await tb.send();
        detail = `ACCEPTED ON CHAIN ${EXPLORER}${txid}`;
      } catch (e: any) {
        ok = true;
        detail = `local VM accepted, network rejected: ${String(e.message).split('\n')[0]}`;
      }
    } catch (e: any) {
      if (e instanceof FailedRequireError) {
        ok = true;
        detail = `rejected at ${e.artifact.contractName}.cash:${e.requireStatement.line}`;
      } else if (e instanceof FailedTransactionError) {
        ok = true;
        detail = `rejected by VM: ${e.reason}`;
      } else throw e;
    }
  } catch (e: any) {
    detail = `INCONCLUSIVE (error while building): ${String(e.message).split('\n')[0]}`;
  }
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        ${detail}`);
}
export const summary = () =>
  results.length && console.log(`\nBypass tests this run: ${results.filter((r) => r.ok).length}/${results.length} PASS`);

export function run(main: () => Promise<void>) {
  main()
    .catch((e) => { console.error('\nERROR', e); process.exitCode = 1; })
    .finally(() => process.exit()); // the Electrum provider keeps a socket open
}
