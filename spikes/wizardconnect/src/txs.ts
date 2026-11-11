// PRE-HACKATHON SPIKE — NOT PART OF THE SUBMISSION
// Transaction builders for cases A, B, C. Shared by the browser page and scripts/preflight.ts,
// so what the preflight proves is exactly what gets sent to the wallet.
//
// user.local set   -> inputs are signed locally (preflight only)
// user.local unset -> placeholders; the wallet signs via WizardConnect inputPaths
import {
  Contract, TransactionBuilder, SignatureTemplate, placeholderP2PKHUnlocker, placeholderPublicKey,
  placeholderSignature, type NetworkProvider, type Utxo, type Output, type Artifact,
} from 'cashscript';
import { binToHex, hexToBin, bigIntToBinUint64LE, binToBigIntUint64LE, hash160, encodeCashAddress, decodeCashAddress } from '@bitauth/libauth';

// All amounts in sats (chipnet)
export const AMOUNTS = {
  SEND_A: 1_000n,     // A: user -> spike funder address
  PRICE_B: 2_000n,    // B: listing price of NFT-B (first sale, 100 % to artisan)
  LIST_C: 5_000n,     // C: new price the owner sets on NFT-C via list()
  VAULT_SATS: 1_000n, // BCH carried by each vault NFT UTXO
  ROYALTY_BPS: 1_000n,
  MIN_ROYALTY: 600n,
  FEE_MARGIN: 1_000n, // extra the user must hold on top of what the tx sends, for fees
};
export const FEE_RATE = 1;
export const PATH_NAME = 'receive';
export const ADDRESS_INDEX = 0;

export type Network = 'chipnet' | 'mainnet';
export type InputPath = [number, string, number];

// pk is unknown when the user is identified only by a pasted address (manual override)
export type User = { address: string; tokenAddress: string; pk?: Uint8Array; pkh: Uint8Array; local?: SignatureTemplate };
const userFromPkh = (pkh: Uint8Array, network: Network) => {
  const prefix = network === 'chipnet' ? 'bchtest' : 'bitcoincash';
  return {
    pkh,
    address: encodeCashAddress({ prefix, type: 'p2pkh', payload: pkh }).address,
    tokenAddress: encodeCashAddress({ prefix, type: 'p2pkhWithTokens', payload: pkh }).address,
  };
};
export function userFromPubkey(pk: Uint8Array, network: Network, local?: SignatureTemplate): User {
  return { ...userFromPkh(hash160(pk) as Uint8Array, network), pk, local };
}
export function userFromAddress(address: string): { user: User; network: Network } {
  const d = decodeCashAddress(address.trim());
  if (typeof d === 'string') throw new Error(`bad address: ${d}`);
  if (d.type !== 'p2pkh') throw new Error('expected a P2PKH address (Selene receive/0)');
  const network: Network = d.prefix === 'bitcoincash' ? 'mainnet' : 'chipnet';
  return { user: userFromPkh(d.payload, network), network };
}

// Written by scripts/setup.ts to public/deploy.json
export type Deploy = {
  network: Network;
  artifact: Artifact;
  artisanLock: string;   // hex P2PKH locking bytecode
  royaltyBps: string;
  minRoyalty: string;
  returnAddress: string; // where case A sends to (spike funder)
  seleneAddress: string; // the receive/0 address NFT-C was minted for
  nftB: { category: string };
  nftC: { category: string };
  txs: { label: string; txid: string }[];
};

export const makeContract = (d: Pick<Deploy, 'artifact' | 'artisanLock' | 'royaltyBps' | 'minRoyalty'>, provider: NetworkProvider) =>
  new Contract(d.artifact, [hexToBin(d.artisanLock), BigInt(d.royaltyBps), BigInt(d.minRoyalty)], { provider });

export const p2pkh = (pkh: Uint8Array) => hexToBin('76a914' + binToHex(pkh) + '88ac');
export const commit = (pkh: Uint8Array, price: bigint, last: bigint) =>
  binToHex(new Uint8Array([...pkh, ...bigIntToBinUint64LE(price), ...bigIntToBinUint64LE(last)]));
export function decode(u: Utxo) {
  const c = hexToBin(u.token!.nft!.commitment);
  return { ownerPkh: c.slice(0, 20), price: binToBigIntUint64LE(c.slice(20, 28)), last: binToBigIntUint64LE(c.slice(28, 36)) };
}
const max = (...xs: bigint[]) => xs.reduce((a, b) => (a > b ? a : b));

export async function findVault(contract: Contract, category: string) {
  const u = (await contract.getUtxos()).find((x) => x.token?.category === category && x.token?.nft);
  if (!u) throw new Error(`vault NFT ${category.slice(0, 12)}… not found at ${contract.address} (spent or not minted yet)`);
  return u;
}
const vaultOutput = (contract: Contract, category: string, commitment: string): Output => ({
  to: contract.tokenAddress, amount: AMOUNTS.VAULT_SATS, token: { amount: 0n, category, nft: { capability: 'mutable', commitment } },
});

// Adds the user's BCH-only UTXOs (largest first) until `need` is covered. Returns the input indices used.
async function addUserFunds(tb: TransactionBuilder, provider: NetworkProvider, user: User, need: bigint, firstIndex: number) {
  const utxos = (await provider.getUtxos(user.address)).filter((u) => !u.token).sort((a, b) => (b.satoshis > a.satoshis ? 1 : -1));
  const unlocker = user.local ? user.local.unlockP2PKH() : placeholderP2PKHUnlocker(user.address);
  const indices: number[] = [];
  let sum = 0n;
  for (const u of utxos) {
    if (sum >= need) break;
    tb.addInput(u, unlocker);
    indices.push(firstIndex + indices.length);
    sum += u.satoshis;
  }
  if (sum < need) throw new Error(`not enough BCH at ${user.address}: need ${need} sats, have ${sum}`);
  return indices;
}

export type Built = { tb: TransactionBuilder; inputPaths: InputPath[]; describe: string[] };
const pathsFor = (indices: number[]): InputPath[] => indices.map((i) => [i, PATH_NAME, ADDRESS_INDEX]);

// A. Plain send from the user's P2PKH inputs.
export async function buildA(provider: NetworkProvider, user: User, to: string): Promise<Built> {
  const tb = new TransactionBuilder({ provider });
  const idx = await addUserFunds(tb, provider, user, AMOUNTS.SEND_A + AMOUNTS.FEE_MARGIN, 0);
  tb.addOutput({ to, amount: AMOUNTS.SEND_A }).addBchChangeOutputIfNeeded({ to: user.address, feeRate: FEE_RATE });
  return {
    tb, inputPaths: pathsFor(idx),
    describe: [`inputs 0..${idx.length - 1}: user P2PKH`, `out 0: ${AMOUNTS.SEND_A} -> ${to}`, 'out 1: change -> user'],
  };
}

// B. buy(): vault input (no signature) + user P2PKH inputs paying the seller/artisan.
export async function buildB(provider: NetworkProvider, contract: Contract, artisanLock: Uint8Array, user: User, category: string): Promise<Built> {
  const vault = await findVault(contract, category);
  const { ownerPkh, price, last } = decode(vault);
  if (price === 0n) throw new Error('NFT-B is not listed (price 0). Already bought? Run setup again to mint a fresh one.');
  const sellerLock = p2pkh(ownerPkh);
  const pay: Output[] = binToHex(sellerLock) === binToHex(artisanLock)
    ? [{ to: artisanLock, amount: price }]
    : (() => {
        const royalty = max(price * AMOUNTS.ROYALTY_BPS / 10000n, last * AMOUNTS.ROYALTY_BPS / 10000n, AMOUNTS.MIN_ROYALTY);
        return [{ to: sellerLock, amount: price - royalty }, { to: artisanLock, amount: royalty }];
      })();

  const tb = new TransactionBuilder({ provider }).addInput(vault, contract.unlock.buy(user.pkh));
  const idx = await addUserFunds(tb, provider, user, price + AMOUNTS.FEE_MARGIN, 1);
  tb.addOutput(vaultOutput(contract, category, commit(user.pkh, 0n, price)))
    .addOutputs(pay)
    .addBchChangeOutputIfNeeded({ to: user.address, feeRate: FEE_RATE });
  return {
    tb, inputPaths: pathsFor(idx), // vault input 0 needs no wallet signature -> no inputPaths entry
    describe: [
      'input 0: vault buy(buyerPkh) — no signature', `inputs ${idx[0]}..${idx.at(-1)}: user P2PKH`,
      `out 0: NFT back to vault, owner = user, price 0, lastSale ${price}`,
      ...pay.map((o, i) => `out ${i + 1}: ${o.amount} -> ${i === pay.length - 1 ? 'artisan' : 'seller'}`), 'last out: change -> user',
    ],
  };
}

// C. list(ownerPk, ownerSig, newPrice): the CONTRACT input needs the user's pubkey + signature.
export async function buildC(provider: NetworkProvider, contract: Contract, user: User, category: string, newPrice: bigint): Promise<Built> {
  const vault = await findVault(contract, category);
  const { ownerPkh, last } = decode(vault);
  if (binToHex(ownerPkh) !== binToHex(user.pkh))
    throw new Error(`NFT-C owner pkh is ${binToHex(ownerPkh)}, but this wallet's receive/0 pkh is ${binToHex(user.pkh)}`);

  const unlocker = user.local
    ? contract.unlock.list(user.local.publicKey, user.local, newPrice)
    : contract.unlock.list(placeholderPublicKey(), placeholderSignature(), newPrice);
  const tb = new TransactionBuilder({ provider }).addInput(vault, unlocker);
  // The vault output must keep >= the vault input value, so the fee comes from a user input
  const idx = await addUserFunds(tb, provider, user, AMOUNTS.FEE_MARGIN, 1);
  tb.addOutput(vaultOutput(contract, category, commit(ownerPkh, newPrice, last)))
    .addBchChangeOutputIfNeeded({ to: user.address, feeRate: FEE_RATE });
  return {
    tb, inputPaths: [[0, PATH_NAME, ADDRESS_INDEX], ...pathsFor(idx)],
    describe: [
      'input 0: vault list(ownerPk=PLACEHOLDER, ownerSig=PLACEHOLDER, newPrice) — wallet must fill both',
      `inputs ${idx[0]}..${idx.at(-1)}: user P2PKH (fee)`, `out 0: NFT back to vault, owner unchanged, price ${newPrice}`, 'out 1: change -> user',
    ],
  };
}
