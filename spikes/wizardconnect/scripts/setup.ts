// PRE-HACKATHON SPIKE — NOT PART OF THE SUBMISSION
// CHIPNET ONLY. Mints the two vault NFTs used by the page and funds Selene's receive/0 address,
// using the chipnet spike keys in ../vault/.env (never printed).
//   npm run setup -- --selene bchtest:q...      (address shown on the page after connecting)
//   add --remint to mint fresh NFTs even if the current ones are still usable
//
// NFT-B: owner = artisan, listed at PRICE_B  -> case B (Selene buys it)
// NFT-C: owner = Selene receive/0, price 0   -> case C (Selene lists it, needs her contract sig)
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { ElectrumNetworkProvider, SignatureTemplate, TransactionBuilder } from 'cashscript';
import { compileFile } from 'cashc';
import { binToHex, decodeCashAddress } from '@bitauth/libauth';
import { AMOUNTS, FEE_RATE, makeContract, userFromPubkey, p2pkh, commit, decode, findVault, type Deploy } from '../src/txs.js';

const EXPLORER = 'https://chipnet.bch.ninja/tx/';
const OUT = fileURLToPath(new URL('../public/deploy.json', import.meta.url));
const SELENE_MIN = 8_000n, SELENE_TOPUP = 15_000n, GENESIS_SATS = 2_500n;

const arg = (n: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
const seleneAddress = arg('--selene');
const remint = process.argv.includes('--remint');
if (!seleneAddress) throw new Error('usage: npm run setup -- --selene bchtest:q...');
const dec = decodeCashAddress(seleneAddress);
if (typeof dec === 'string') throw new Error(`bad address: ${dec}`);
if (dec.prefix !== 'bchtest') throw new Error('refusing: this script is CHIPNET ONLY and the address is not bchtest:');
if (dec.type !== 'p2pkh') throw new Error('expected a P2PKH address (receive/0)');
const selenePkh = dec.payload;

dotenv.config({ path: fileURLToPath(new URL('../../vault/.env', import.meta.url)), quiet: true });
if (!process.env.FUNDER_WIF || !process.env.ARTISAN_WIF) throw new Error('FUNDER_WIF / ARTISAN_WIF missing in spikes/vault/.env');
const funderKey = new SignatureTemplate(process.env.FUNDER_WIF);
const funder = userFromPubkey(funderKey.publicKey, 'chipnet', funderKey);
const artisan = userFromPubkey(new SignatureTemplate(process.env.ARTISAN_WIF).publicKey, 'chipnet');

const provider = new ElectrumNetworkProvider('chipnet');
const artifact = compileFile(new URL('../../vault/RoyaltyVault.cash', import.meta.url));
const params = { artifact, artisanLock: binToHex(p2pkh(artisan.pkh)), royaltyBps: String(AMOUNTS.ROYALTY_BPS), minRoyalty: String(AMOUNTS.MIN_ROYALTY) };
const contract = makeContract(params, provider);

const prev: Deploy | undefined = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : undefined;
const txs: Deploy['txs'] = prev?.txs ?? [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const bal = async (a: string) => (await provider.getUtxos(a)).filter((u) => !u.token).reduce((s, u) => s + u.satoshis, 0n);

async function send(label: string, tb: TransactionBuilder, watch: string) {
  const { txid } = await tb.send();
  txs.push({ label, txid });
  console.log(`  ✔ ${label}\n    ${EXPLORER}${txid}`);
  for (let i = 0; i < 60; i++) {
    if ((await provider.getUtxos(watch)).some((u) => u.txid === txid)) return txid;
    await sleep(1000);
  }
  throw new Error(`tx ${txid} not seen after 60 s`);
}
const funderUtxos = async () => (await provider.getUtxos(funder.address)).filter((u) => !u.token);

async function mint(label: string, ownerPkh: Uint8Array, price: bigint) {
  // A CashTokens genesis must spend an outpoint with index 0
  const prep = new TransactionBuilder({ provider })
    .addInputs(await funderUtxos(), funderKey.unlockP2PKH())
    .addOutput({ to: funder.address, amount: GENESIS_SATS })
    .addBchChangeOutputIfNeeded({ to: funder.address, feeRate: FEE_RATE });
  const prepTxid = await send(`${label} genesis prep`, prep, funder.address);
  const genesis = (await funderUtxos()).find((u) => u.txid === prepTxid && u.vout === 0)!;
  const tb = new TransactionBuilder({ provider })
    .addInput(genesis, funderKey.unlockP2PKH())
    .addOutput({ to: contract.tokenAddress, amount: AMOUNTS.VAULT_SATS, token: { amount: 0n, category: genesis.txid, nft: { capability: 'mutable', commitment: commit(ownerPkh, price, 0n) } } })
    .addBchChangeOutputIfNeeded({ to: funder.address, feeRate: FEE_RATE });
  await send(`${label} mint`, tb, contract.tokenAddress);
  return genesis.txid;
}
async function usable(category: string | undefined, ok: (o: ReturnType<typeof decode>) => boolean) {
  if (!category || remint) return false;
  try { return ok(decode(await findVault(contract, category))); } catch { return false; }
}

console.log(`CHIPNET setup\n  vault contract ${contract.tokenAddress}\n  funder ${funder.address} (${await bal(funder.address)} sats)\n  selene receive/0 ${seleneAddress}\n`);
const sameSelene = prev?.seleneAddress === seleneAddress;

let catB = prev?.nftB.category;
if (await usable(catB, (o) => o.price > 0n)) console.log(`NFT-B ${catB} still listed — reused`);
else { console.log(`Minting NFT-B (owner artisan, listed at ${AMOUNTS.PRICE_B})`); catB = await mint('NFT-B', artisan.pkh, AMOUNTS.PRICE_B); }

let catC = prev?.nftC.category;
if (sameSelene && await usable(catC, (o) => binToHex(o.ownerPkh) === binToHex(selenePkh))) console.log(`NFT-C ${catC} still owned by Selene — reused`);
else { console.log('Minting NFT-C (owner = Selene receive/0, not listed)'); catC = await mint('NFT-C', selenePkh, 0n); }

const sb = await bal(seleneAddress);
if (sb < SELENE_MIN) {
  console.log(`Selene receive/0 has ${sb} sats -> sending ${SELENE_TOPUP}`);
  const tb = new TransactionBuilder({ provider })
    .addInputs(await funderUtxos(), funderKey.unlockP2PKH())
    .addOutput({ to: seleneAddress, amount: SELENE_TOPUP })
    .addBchChangeOutputIfNeeded({ to: funder.address, feeRate: FEE_RATE });
  await send('fund Selene receive/0', tb, seleneAddress);
} else console.log(`Selene receive/0 has ${sb} sats — no top-up needed`);

const deploy: Deploy = {
  network: 'chipnet', ...params, returnAddress: funder.address, seleneAddress,
  nftB: { category: catB! }, nftC: { category: catC! }, txs,
};
fs.mkdirSync(fileURLToPath(new URL('../public', import.meta.url)), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(deploy, null, 2));
console.log(`\nWrote public/deploy.json — reload the page.`);
process.exit(0);
