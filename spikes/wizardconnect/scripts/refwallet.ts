// PRE-HACKATHON SPIKE — NOT PART OF THE SUBMISSION
// Reference "wallet" for the preflight: fills a WC transaction object the way the CashScript guide
// describes (P2PKH placeholder inputs signed; zero sig/pubkey pushes in contract inputs replaced).
// Uses a throwaway in-memory key. Never used against a real wallet.
import { SignatureTemplate, type WcTransactionObject } from 'cashscript';
import { binToHex, hexToBin, encodeTransaction, generateSigningSerializationBCH, hash256, type Output } from '@bitauth/libauth';
import type { InputPath } from '../src/txs.js';

const SIGHASH_ALL_UTXOS_FORKID = 0x61;
const push = (d: Uint8Array) => Uint8Array.from([d.length, ...d]); // valid for 33 and 65 byte pushes

export type RefMode = 'correct' | 'ignore-contract-placeholders' | 'wrong-key';

export function refSign(wc: WcTransactionObject, inputPaths: InputPath[], key: SignatureTemplate, mode: RefMode = 'correct', wrongKey?: SignatureTemplate): string {
  const tx = structuredClone(wc.transaction);
  const src = wc.sourceOutputs as unknown as Output[];
  for (const [i] of inputPaths) {
    const k = mode === 'wrong-key' && wrongKey ? wrongKey : key;
    const contract = wc.sourceOutputs[i].contract;
    const covered = contract ? contract.redeemScript : src[i].lockingBytecode;
    const preimage = generateSigningSerializationBCH(
      { inputIndex: i, sourceOutputs: src, transaction: tx },
      { coveredBytecode: covered, signingSerializationType: Uint8Array.of(SIGHASH_ALL_UTXOS_FORKID) },
    );
    const sig = Uint8Array.from([...k.signMessageHash(hash256(preimage)), SIGHASH_ALL_UTXOS_FORKID]);
    if (contract) {
      if (mode === 'ignore-contract-placeholders') continue;
      let hex = binToHex(tx.inputs[i].unlockingBytecode);
      hex = hex.replace(binToHex(push(new Uint8Array(65))), binToHex(push(sig)));
      hex = hex.replace(binToHex(push(new Uint8Array(33))), binToHex(push(k.publicKey)));
      tx.inputs[i].unlockingBytecode = hexToBin(hex);
    } else {
      tx.inputs[i].unlockingBytecode = Uint8Array.from([...push(sig), ...push(k.publicKey)]);
    }
  }
  return binToHex(encodeTransaction(tx));
}
