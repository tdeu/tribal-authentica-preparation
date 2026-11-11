// PRE-HACKATHON SPIKE — NOT PART OF THE SUBMISSION
// Convert CashScript's WC transaction object into what goes over the WizardConnect relay.
// The relay client does a plain JSON.stringify, so no BigInt / Uint8Array may remain.
//
// Format Selene expects (its src/kernel/bch/WizardConnectService.tsx, prepareTransaction +
// normalizeWizardSourceOutputs, read 11 Nov):
//   transaction            -> HEX STRING only ("WizardConnect transaction must be hex encoded")
//   sourceOutputs bytes    -> hex or "<Uint8Array: 0x…>"           (relayBytes)
//   valueSatoshis, amount  -> bigint | numeric string | safe number | "<bigint: Xn>" (toBigInt)
//   outpointIndex, sequenceNumber -> plain numbers
//   contract.redeemScript  -> bytes as above; contract.artifact.contractName must be set
// libauth's stringify produces exactly the "<Uint8Array: 0x…>" / "<bigint: Xn>" strings
// (the CashScript WalletConnect guide does JSON.parse(stringify(wcTransactionObj))).
import { binToHex, encodeTransaction, stringify } from '@bitauth/libauth';
import type { WcTransactionObject } from 'cashscript';

export type WireTransaction = {
  transaction: string;
  sourceOutputs: Record<string, unknown>[];
  broadcast?: boolean;
  userPrompt?: string;
};

export function toWire(wc: WcTransactionObject): WireTransaction {
  const { transaction, sourceOutputs, ...rest } = wc;
  // Selene only reads artifact.contractName; drop the bulky source/debug info to keep relay messages small
  const slim = sourceOutputs.map((o) => o.contract
    ? { ...o, contract: { ...o.contract, artifact: { ...o.contract.artifact, source: undefined, debug: undefined } } }
    : o);
  return {
    ...rest,
    transaction: binToHex(encodeTransaction(transaction)),
    sourceOutputs: JSON.parse(stringify(slim)),
  };
}
