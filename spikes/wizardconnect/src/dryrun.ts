// PRE-HACKATHON SPIKE — NOT PART OF THE SUBMISSION
// MAINNET SIGN-ONLY DRY RUN (11 Nov): A/B/C are built on FAKE UTXOs (random txids, nothing on chain)
// and only sent to the wallet for signing. Nothing can be broadcast:
//  - this provider never talks to a server, and sendRawTransaction always throws;
//  - the page never calls sendRawTransaction in dry-run mode;
//  - the request asks the wallet not to broadcast (broadcast: false);
//  - even if a signed tx leaked, its inputs don't exist, so every node would reject it.
import { randomUtxo, type NetworkProvider, type SpendableUtxo, type Utxo, type Artifact } from 'cashscript';
import { binToHex, cashAddressToLockingBytecode, hash160, utf8ToBin } from '@bitauth/libauth';
import { AMOUNTS, commit, makeContract, p2pkh, type User } from './txs.js';
import artifactJson from './RoyaltyVault.artifact.json';

export const DRY_RUN_ERROR = 'DRY RUN: broadcasting is disabled';

export class DryRunProvider implements NetworkProvider {
  network = 'mainnet' as const;
  private byLock = new Map<string, SpendableUtxo[]>();
  private key(addressOrLock: string | Uint8Array) {
    if (typeof addressOrLock !== 'string') return binToHex(addressOrLock);
    const r = cashAddressToLockingBytecode(addressOrLock);
    return typeof r === 'string' ? addressOrLock : binToHex(r.bytecode);
  }
  add(address: string, utxo: Utxo) {
    const k = this.key(address);
    this.byLock.set(k, [...(this.byLock.get(k) ?? []), { ...utxo, lockingBytecode: k }]);
  }
  async getUtxos(address: string) { return this.byLock.get(this.key(address)) ?? []; }
  async getUtxosForLockingBytecode(lb: Uint8Array | string) {
    return this.byLock.get(typeof lb === 'string' ? lb : binToHex(lb)) ?? [];
  }
  async getBlockHeight() { return 0; }
  async getRawTransaction(): Promise<string> { throw new Error('DRY RUN: no chain access'); }
  async sendRawTransaction(): Promise<string> { throw new Error(DRY_RUN_ERROR); }
}

export type DryRunEnv = ReturnType<typeof makeDryRun>;

// Fake chain state: user receive/0 holds 20 000 sats (fake), NFT-B listed by a fake artisan,
// NFT-C owned by the user's receive/0 (as planned for C).
export function makeDryRun(user: User) {
  const provider = new DryRunProvider();
  const artisanPkh = hash160(utf8ToBin('ta-spike-dry-run-artisan')) as Uint8Array;
  const artisanLock = p2pkh(artisanPkh);
  const contract = makeContract({
    artifact: artifactJson as unknown as Artifact, artisanLock: binToHex(artisanLock),
    royaltyBps: String(AMOUNTS.ROYALTY_BPS), minRoyalty: String(AMOUNTS.MIN_ROYALTY),
  }, provider);

  provider.add(user.address, randomUtxo({ satoshis: 20_000n }));
  const nft = (owner: Uint8Array, price: bigint) => {
    const category = binToHex(crypto.getRandomValues(new Uint8Array(32)));
    provider.add(contract.address, {
      ...randomUtxo({ satoshis: AMOUNTS.VAULT_SATS }),
      token: { category, amount: 0n, nft: { capability: 'mutable', commitment: commit(owner, price, 0n) } },
    });
    return category;
  };
  return {
    provider, contract, artisanLock,
    catB: nft(artisanPkh, AMOUNTS.PRICE_B),
    catC: nft(user.pkh, 0n),
    returnAddress: user.address, // A sends to the user's own address
  };
}
