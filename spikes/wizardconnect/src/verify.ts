// PRE-HACKATHON SPIKE — NOT PART OF THE SUBMISSION
// Diagnose a transaction returned by the wallet: did the WALLET do its job (filled placeholders,
// right key, valid signatures, tx unchanged), and if so, does the full BCH VM accept it?
// If every wallet-side check passes but the VM rejects -> our construction is wrong.
import {
  binToHex, hexToBin, decodeTransaction, decodeAuthenticationInstructions, createVirtualMachineBCH,
  generateSigningSerializationBCH, hash160, hash256, secp256k1, type TransactionCommon, type Output,
} from '@bitauth/libauth';
import type { WcTransactionObject } from 'cashscript';
import type { InputPath } from './txs.js';

export type Verdict = 'valid' | 'wallet' | 'ours';
export type Diagnosis = { verdict: Verdict; lines: string[]; issues: string[]; vm?: true | string; signed?: TransactionCommon };

const isZero = (b: Uint8Array) => b.every((x) => x === 0);
const pushes = (bytecode: Uint8Array) =>
  decodeAuthenticationInstructions(bytecode).map((i) => ('data' in i ? (i.data as Uint8Array) : undefined));
const outputKey = (o: Output) =>
  binToHex(o.lockingBytecode) + ':' + o.valueSatoshis + ':' + (o.token ? `${binToHex(o.token.category)}/${o.token.amount}/${o.token.nft ? binToHex(o.token.nft.commitment) + o.token.nft.capability : ''}` : '');

function checkSig(tx: TransactionCommon, sourceOutputs: Output[], inputIndex: number, covered: Uint8Array, sig: Uint8Array, pk: Uint8Array) {
  if (sig.length !== 65) return `signature is ${sig.length} bytes (expected 65-byte Schnorr)`;
  const preimage = generateSigningSerializationBCH(
    { inputIndex, sourceOutputs, transaction: tx },
    { coveredBytecode: covered, signingSerializationType: sig.slice(64) },
  );
  return secp256k1.verifySignatureSchnorr(sig.slice(0, 64), pk, hash256(preimage))
    ? undefined
    : `signature does not verify (sighash type 0x${binToHex(sig.slice(64))})`;
}

// expectedPkh = hash160 of the receive/0 pubkey (works when only the address is known)
export function diagnose(unsigned: WcTransactionObject, inputPaths: InputPath[], signedHex: string, expectedPkh: Uint8Array): Diagnosis {
  const isExpected = (pk: Uint8Array) => binToHex(hash160(pk) as Uint8Array) === binToHex(expectedPkh);
  const lines: string[] = [];
  const walletIssues: string[] = [];
  const decoded = decodeTransaction(hexToBin(signedHex));
  if (typeof decoded === 'string') return { verdict: 'wallet', lines: [`wallet returned an undecodable tx: ${decoded}`], issues: ['undecodable tx'] };
  const tx = decoded;
  const src = unsigned.sourceOutputs as unknown as Output[];

  // 1. The wallet must not change inputs/outputs
  const u = unsigned.transaction;
  const sameInputs = u.inputs.length === tx.inputs.length &&
    u.inputs.every((x, i) => binToHex(x.outpointTransactionHash) === binToHex(tx.inputs[i].outpointTransactionHash) && x.outpointIndex === tx.inputs[i].outpointIndex);
  const sameOutputs = u.outputs.length === tx.outputs.length && u.outputs.every((o, i) => outputKey(o) === outputKey(tx.outputs[i]));
  if (!sameInputs) walletIssues.push('wallet changed the inputs');
  if (!sameOutputs) walletIssues.push('wallet changed the outputs');
  if (u.version !== tx.version || u.locktime !== tx.locktime) walletIssues.push('wallet changed version/locktime');
  lines.push(`structure: inputs ${sameInputs ? 'unchanged' : 'CHANGED'}, outputs ${sameOutputs ? 'unchanged' : 'CHANGED'}`);

  // 2. Per signed input
  const signedIdx = new Set(inputPaths.map(([i]) => i));
  for (let i = 0; i < tx.inputs.length; i++) {
    const ub = tx.inputs[i].unlockingBytecode;
    const contract = unsigned.sourceOutputs[i]?.contract;
    if (!signedIdx.has(i)) {
      const same = binToHex(ub) === binToHex(u.inputs[i].unlockingBytecode);
      lines.push(`input ${i}: not for the wallet — ${same ? 'left untouched (ok)' : 'MODIFIED by wallet'}`);
      if (!same) walletIssues.push(`wallet modified input ${i} which it was not asked to sign`);
      continue;
    }
    const data = pushes(ub);
    if (contract) {
      const sig = data.find((d) => d?.length === 65);
      const pk = data.find((d) => d?.length === 33);
      const redeem = contract.redeemScript;
      const label = `input ${i} (contract ${contract.abiFunction.name})`;
      if (!sig || !pk) { walletIssues.push(`${label}: no 65-byte sig / 33-byte pubkey push found`); lines.push(`${label}: sig/pubkey pushes missing`); continue; }
      const sigFilled = !isZero(sig), pkFilled = !isZero(pk);
      lines.push(`${label}: sig placeholder ${sigFilled ? 'FILLED' : 'NOT filled (still zeros)'}, pubkey placeholder ${pkFilled ? 'FILLED' : 'NOT filled (still zeros)'}`);
      if (!sigFilled || !pkFilled) { walletIssues.push(`${label}: wallet ignored the placeholders`); continue; }
      if (!isExpected(pk)) walletIssues.push(`${label}: wallet used pubkey ${binToHex(pk)}, whose hash160 is not the receive/0 pkh ${binToHex(expectedPkh)}`);
      const e = checkSig(tx, src, i, redeem, sig, pk);
      lines.push(`${label}: signature ${e ?? 'valid'} (covered bytecode = redeem script)`);
      if (e) walletIssues.push(`${label}: ${e}`);
    } else {
      const label = `input ${i} (P2PKH)`;
      if (ub.length === 0) { walletIssues.push(`${label}: wallet left it unsigned`); lines.push(`${label}: NOT signed`); continue; }
      const [sig, pk] = data;
      if (!sig || !pk) { walletIssues.push(`${label}: malformed unlocking bytecode`); continue; }
      if (!isExpected(pk)) walletIssues.push(`${label}: signed with pubkey ${binToHex(pk)}, not the receive/0 key`);
      const e = checkSig(tx, src, i, src[i].lockingBytecode, sig, pk);
      lines.push(`${label}: signed, signature ${e ?? 'valid'}`);
      if (e) walletIssues.push(`${label}: ${e}`);
    }
  }

  // 3. Full VM check (standard rules)
  const vm = createVirtualMachineBCH(true);
  const res = vm.verify({ sourceOutputs: src, transaction: tx });
  lines.push(`BCH VM (standard): ${res === true ? 'ACCEPTS' : 'REJECTS — ' + res}`);

  const base = { issues: walletIssues, vm: res, signed: tx };
  if (res === true) return { verdict: 'valid', lines, ...base };
  if (walletIssues.length) return { verdict: 'wallet', lines: [...lines, ...walletIssues.map((w) => 'WALLET: ' + w)], ...base };
  return { verdict: 'ours', lines: [...lines, 'All wallet-side checks pass, VM still rejects -> our tx construction is wrong'], ...base };
}
