// PRE-HACKATHON SPIKE — NOT PART OF THE SUBMISSION
// Port of the request checks in Selene's WizardConnectService.tsx (prepareTransaction,
// normalizeWizardSourceOutputs) and TransactionSummaryService.ts (validateSigningRequest),
// read from its source on 11 Nov. Used by the preflight to check our wire format, not the wallet itself.
// Key-ownership checks (need Selene's seed) are not ported.
import { decodeTransaction, hexToBin, binToHex, type Output } from '@bitauth/libauth';
import { toBigInt, toUint8Array } from '@wizardconnect/core';
import type { WireTransaction } from '../src/wire.js';
import type { InputPath } from '../src/txs.js';

const BYTES = /^(?:(?:[0-9a-fA-F]{2})*|<Uint8Array: 0x(?:[0-9a-f]{2})*>)$/u;
function relayBytes(v: unknown, field: string) {
  if (v instanceof Uint8Array) return v;
  if (typeof v !== 'string' || !BYTES.test(v)) throw new Error(`Invalid WizardConnect ${field}`);
  return toUint8Array(v);
}
function amount(v: unknown) {
  if (typeof v !== 'bigint' && typeof v !== 'string' && (typeof v !== 'number' || !Number.isSafeInteger(v)))
    throw new Error('Invalid WizardConnect amount');
  return toBigInt(v as string | number | bigint);
}
const eq = (a: Uint8Array, b: Uint8Array) => binToHex(a) === binToHex(b);

export type SeleneView = { sourceOutputs: (Output & { unlockingBytecode: Uint8Array; contract?: { redeemScript?: Uint8Array; artifact: { contractName?: string } } })[] };

export function seleneAccepts(wire: WireTransaction, inputPaths: InputPath[]): SeleneView {
  if (typeof wire.transaction !== 'string') throw new Error('WizardConnect transaction must be hex encoded');
  const tx = decodeTransaction(hexToBin(wire.transaction));
  if (typeof tx === 'string') throw new Error(`Failed to decode transaction: ${tx}`);
  if (!Array.isArray(wire.sourceOutputs)) throw new Error('Invalid WizardConnect source outputs');

  const so = wire.sourceOutputs.map((o: any, i) => ({
    outpointTransactionHash: relayBytes(o.outpointTransactionHash, `outpoint hash at index ${i}`),
    outpointIndex: o.outpointIndex as number,
    unlockingBytecode: relayBytes(o.unlockingBytecode, `unlocking bytecode at index ${i}`),
    sequenceNumber: o.sequenceNumber as number,
    valueSatoshis: amount(o.valueSatoshis),
    lockingBytecode: relayBytes(o.lockingBytecode, `locking bytecode at index ${i}`),
    ...(o.token !== undefined && {
      token: {
        category: relayBytes(o.token.category, `token category at index ${i}`),
        amount: amount(o.token.amount),
        ...(o.token.nft && { nft: { capability: o.token.nft.capability, commitment: relayBytes(o.token.nft.commitment, `NFT commitment at index ${i}`) } }),
      },
    }),
    ...(o.contract && {
      contract: {
        ...(o.contract.redeemScript !== undefined && { redeemScript: relayBytes(o.contract.redeemScript, `contract redeem script at index ${i}`) }),
        artifact: o.contract.artifact as { contractName?: string },
      },
    }),
  }));

  // validateSigningRequest
  if (tx.inputs.length !== so.length) throw new Error('Transaction input and source output counts do not match');
  tx.inputs.forEach((input, i) => {
    const s = so[i]; const t = s.token; const nft = t?.nft;
    if (s.outpointTransactionHash.length !== 32 || !eq(input.outpointTransactionHash, s.outpointTransactionHash) ||
      input.outpointIndex !== s.outpointIndex || input.sequenceNumber !== s.sequenceNumber ||
      !eq(input.unlockingBytecode, s.unlockingBytecode) || s.valueSatoshis < 0n || s.lockingBytecode.length === 0 ||
      (t && (t.category.length !== 32 || t.amount < 0n || (t.amount === 0n && !nft))) ||
      (nft && (!['none', 'mutable', 'minting'].includes(nft.capability) || nft.commitment.length > 40)))
      throw new Error(`Invalid signing source output at index ${i}`);
  });

  // inputPaths shape
  const seen = new Set<number>();
  for (const [i, name, idx] of inputPaths) {
    if (!['receive', 'change', 'defi'].includes(name) || !Number.isInteger(i) || i < 0 || i >= so.length ||
      !Number.isInteger(idx) || idx < 0 || idx > 0x7fffffff || seen.has(i)) throw new Error('Invalid WizardConnect input path');
    seen.add(i);
    // Contract inputs: Selene fills placeholders only with contractName + redeemScript present
    const c = so[i].contract;
    if (c) {
      if (!c.artifact?.contractName) throw new Error(`input ${i}: contract without artifact.contractName would be treated as P2PKH`);
      if (!c.redeemScript) throw new Error(`input ${i}: missing contract redeemScript`);
      const hex = binToHex(so[i].unlockingBytecode);
      if (!hex.includes('41' + '00'.repeat(65))) throw new Error(`input ${i}: no 65-byte zero signature placeholder`);
      if (!hex.includes('21' + '00'.repeat(33))) throw new Error(`input ${i}: no 33-byte zero pubkey placeholder`);
    }
  }
  return { sourceOutputs: so as SeleneView['sourceOutputs'] };
}
