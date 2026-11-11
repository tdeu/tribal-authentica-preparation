// PRE-HACKATHON SPIKE — NOT PART OF THE SUBMISSION
// Two modes, chosen from the wallet's key prefix on connect:
//   tpub -> CHIPNET: real UTXOs (public/deploy.json), sign, verify, broadcast
//   xpub -> MAINNET SIGN-ONLY DRY RUN: fake UTXOs, sign, verify, NEVER broadcast
import QRCode from 'qrcode';
import { initiateDappRelay, type DappRelayResult, type RelayUpdatePayload } from '@wizardconnect/core';
import { DappConnectionManager } from '@wizardconnect/dapp';
import { ElectrumNetworkProvider, type Contract, type NetworkProvider } from 'cashscript';
import { binToHex, hexToBin, decodeHdPublicKey } from '@bitauth/libauth';
import {
  AMOUNTS, ADDRESS_INDEX, buildA, buildB, buildC, decode, findVault, makeContract, userFromPubkey, userFromAddress,
  type Built, type Deploy, type Network, type User,
} from './txs.js';
import { diagnose } from './verify.js';
import { makeDryRun, type DryRunEnv } from './dryrun.js';
import { toWire, type WireTransaction } from './wire.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const EXPLORER = 'https://chipnet.bch.ninja/tx/';
const RECEIVE = 0;

// ---------------------------------------------------------------- log
const REDACT = new Set(['secret', 'public_key', 'privateKey', 'walletPublicKey']);
function fmt(v: unknown): string {
  return JSON.stringify(v, (k, x) => {
    if (REDACT.has(k)) return '<redacted>';
    if (typeof x === 'bigint') return `${x}n`;
    if (x instanceof Uint8Array) { const h = binToHex(x); return h.length > 140 ? `${h.slice(0, 140)}…(${x.length} bytes)` : h; }
    if (typeof x === 'string' && x.length > 400) return `${x.slice(0, 400)}…(${x.length} chars)`;
    return x;
  }, 2);
}
function log(title: string, data?: unknown) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${title}${data === undefined ? '' : '\n' + (typeof data === 'string' ? data : fmt(data))}\n`;
  $('log').textContent = line + $('log').textContent;
  console.log(title, data ?? '');
}

// ---------------------------------------------------------------- state
const mgr = new DappConnectionManager('TA WizardConnect spike');
let relay: DappRelayResult | undefined;
let deploy: Deploy | undefined;
let user: User | undefined;
let network: Network | 'unknown' = 'unknown';
let dry: DryRunEnv | undefined; // set only in mainnet dry-run mode
let manual = false;                  // manual override: identity from a pasted address, no xpubs
let pending: AbortController | undefined;
const chipnet = new ElectrumNetworkProvider('chipnet'); // used only in chipnet mode
const SIGN_TIMEOUT_MS = 180_000;

// Stale-message guard. Message `time` is in seconds. A disconnect older than the latest wallet_ready
// (or than this page's relay session) is a replay from before a reconnect: ignore it.
let lastWalletReadyTime = 0;
let relayStartTime = 0;
const nowSec = () => Math.floor(Date.now() / 1000);
const internals = mgr as unknown as { handleRemoteDisconnect(msg: { time: number; reason: string; message?: string }): void };
const origHandleRemoteDisconnect = internals.handleRemoteDisconnect.bind(mgr);
internals.handleRemoteDisconnect = (msg) => {
  const cutoff = Math.max(lastWalletReadyTime, relayStartTime);
  if (msg.time < cutoff) {
    log(`IGNORED stale disconnect (time ${msg.time} < cutoff ${cutoff}: latest wallet_ready ${lastWalletReadyTime}, relay start ${relayStartTime})`, msg);
    return;
  }
  origHandleRemoteDisconnect(msg);
};

mgr.on('messagesent', (m) => log(`→ sent ${m.action}`, m));
mgr.on('messagereceived', (m) => {
  if (m.action === 'wallet_ready') lastWalletReadyTime = Math.max(lastWalletReadyTime, m.time);
  log(`← received ${m.action} (time ${m.time})`, m);
});
mgr.on('disconnect', (reason, message) => { log(`disconnect: ${reason}`, message); $('relayStatus').textContent = `disconnected (${reason})`; });
mgr.on('reconnecting', () => log('relay reconnecting…'));
mgr.on('walletready', () => { log(`wallet_ready from ${mgr.walletName}`); $('pairing').hidden = true; onWallet(); });

function showDappKey() {
  // Selene's approval dialog shows this key + relay; compare before clicking Connect
  $('dappKey').textContent = relay ? `dapp key (Selene's approval dialog should show the same): ${relay.credentials.publicKey}` : '';
}

// RelayStatusCallback shape per @wizardconnect/core relay-handler.d.ts: ({ client, status: RelayStatus })
const onRelay = ({ client, status }: RelayUpdatePayload) => {
  mgr.updateConnection(client, status);
  $('relayStatus').textContent = `relay: ${status.status}${status.error ? ' — ' + status.error : ''}`;
  log(`relay status: ${status.status}`, status.error ?? undefined);
};

async function connect() {
  relay?.cleanup();
  mgr.clearStoredSession();
  relayStartTime = nowSec(); lastWalletReadyTime = 0;
  relay = initiateDappRelay(onRelay);
  mgr.attachRelay(relay);
  showDappKey();
  $('uri').textContent = relay.uri;
  await QRCode.toCanvas($<HTMLCanvasElement>('qr'), relay.qrUri, { width: 260, margin: 1 });
  $('pairing').hidden = false;
  log('pairing URI created', relay.uri);
}

function restore() {
  const s = mgr.loadStoredSession();
  if (!s?.walletPublicKey) return;
  log(`restoring stored session with ${s.walletName ?? 'wallet'}`);
  relayStartTime = nowSec();
  relay = initiateDappRelay(onRelay, { existingCredentials: { privateKey: s.privateKey, secret: s.secret, walletPublicKey: s.walletPublicKey } });
  mgr.attachRelay(relay);
  showDappKey();
  if (mgr.hasPath(RECEIVE)) onWallet();
}

async function forget() {
  try { await mgr.sendDisconnect('spike page reset'); } catch { /* not connected */ }
  relay?.cleanup(); relay = undefined;
  mgr.clearStoredSession();
  user = undefined; network = 'unknown'; dry = undefined; manual = false;
  $('wallet').innerHTML = ''; $('pairing').hidden = true; $('relayStatus').textContent = 'forgotten'; $('dappKey').textContent = '';
  $('modeBanner').hidden = true;
  setButtons();
}

// ---------------------------------------------------------------- wallet info + mode
function onWallet() {
  const paths = mgr.getSessionPaths();
  if (paths.length === 0) {
    // Selene (patched @wizardconnect/wallet) sends wallet_ready with paths [] until the user approves
    // the connection in its "Connect with WizardConnect" dialog, then sends a 2nd wallet_ready with xpubs.
    // It also silently drops sign requests until approved.
    log('wallet_ready has NO xpub paths — waiting for connection approval in Selene');
    if (manual) return; // keep the manual dry-run identity
    network = 'unknown'; user = undefined; dry = undefined;
    $('wallet').innerHTML = [
      `wallet: ${mgr.walletName ?? '?'}  protocol: ${mgr.protocol ?? '?'}`,
      '<span class="warn">wallet_ready arrived with paths = [] → Selene is waiting for you to APPROVE this connection.</span>',
      'In Selene: dialog "Connect with WizardConnect — TA WizardConnect spike" → check the dapp key below → Connect.',
      'The xpubs arrive in a second wallet_ready right after; this page updates by itself.',
      'Until approved, Selene silently ignores sign requests.',
    ].join('<br>');
    setButtons();
    return;
  }
  if (manual) { manual = false; log('xpubs arrived — leaving manual override'); }
  const info = paths.map((p) => {
    const d = decodeHdPublicKey(p.xpub);
    const net = typeof d === 'string' ? `decode error: ${d}` : d.network;
    return `${p.name.padEnd(8)} prefix ${p.xpub.slice(0, 4)}  libauth network: ${net}`;
  });
  const recv = paths.find((p) => p.name === 'receive');
  const d = recv ? decodeHdPublicKey(recv.xpub) : 'no receive path';
  network = typeof d === 'string' ? 'unknown' : d.network === 'testnet' ? 'chipnet' : 'mainnet';
  const pk = mgr.getPubkey(RECEIVE, BigInt(ADDRESS_INDEX));
  user = pk && network !== 'unknown' ? userFromPubkey(pk, network) : undefined;
  dry = user && network === 'mainnet' ? makeDryRun(user) : undefined;

  const netLine = network === 'chipnet'
    ? '<span class="ok">TESTNET keys (tpub) → chipnet mode: real chipnet UTXOs, broadcast after checks.</span>'
    : network === 'mainnet'
      ? '<span class="warn">MAINNET keys (xpub) → SIGN-ONLY DRY RUN: fake UTXOs, broadcasting disabled.</span>'
      : '<span class="warn">Network unknown — buttons disabled.</span>';
  $('wallet').innerHTML = [
    `wallet: ${mgr.walletName ?? '?'}  protocol: ${mgr.protocol ?? '(restored)'}`,
    ...info, netLine,
    user ? `receive/0 address: ${user.address}` : '',
    user ? `receive/0 pkh:     ${binToHex(user.pkh)}` : '',
    user && network === 'chipnet' ? `setup command (run in spikes/wizardconnect):\n  npm run setup -- --selene ${user.address}` : '',
  ].filter(Boolean).join('\n').replace(/\n/g, '<br>');
  document.body.dataset.mode = dry ? 'dryrun' : network;
  $('modeBanner').hidden = !dry;
  log('wallet info', { network, mode: dry ? 'mainnet sign-only dry run' : network, paths: info, address: user?.address });
  refresh();
}

// ---------------------------------------------------------------- chain state
async function loadDeploy() {
  try {
    const r = await fetch(`/deploy.json?t=${Date.now()}`);
    deploy = r.ok ? await r.json() : undefined;
  } catch { deploy = undefined; }
}
const ownerLabel = (pkh: Uint8Array, artisanLockHex: string) =>
  user && binToHex(pkh) === binToHex(user.pkh) ? 'Selene receive/0' : binToHex(pkh) === artisanLockHex.slice(6, 46) ? 'artisan' : binToHex(pkh);

async function nftLines(provider: NetworkProvider, contract: Contract, artisanLockHex: string, cats: [string, string][]) {
  const lines = [`vault ${contract.tokenAddress}`];
  for (const [k, cat] of cats) {
    try {
      const o = decode(await findVault(contract, cat));
      lines.push(`${k} ${cat.slice(0, 10)}…  owner=${ownerLabel(o.ownerPkh, artisanLockHex)} price=${o.price} lastSale=${o.last}`);
    } catch (e: any) { lines.push(`${k}: ${e.message}`); }
  }
  if (user) {
    const utxos = (await provider.getUtxos(user.address)).filter((u) => !u.token);
    lines.push(`Selene receive/0 BCH: ${utxos.reduce((s, u) => s + u.satoshis, 0n)} sats in ${utxos.length} UTXO(s)`);
  }
  return lines;
}

async function refresh() {
  let lines: string[];
  if (dry) {
    lines = ['FAKE chain state (dry run — none of these UTXOs exist on mainnet):',
      ...await nftLines(dry.provider, dry.contract, binToHex(dry.artisanLock), [['NFT-B', dry.catB], ['NFT-C', dry.catC]])];
  } else {
    await loadDeploy();
    if (!deploy) lines = ['No public/deploy.json yet — connect, then run the setup command shown above.'];
    else {
      lines = [];
      if (user && deploy.seleneAddress !== user.address) lines.push(`⚠ deploy.json was made for ${deploy.seleneAddress}, not this wallet — rerun setup.`);
      lines.push(...await nftLines(chipnet, makeContract(deploy, chipnet), deploy.artisanLock, [['NFT-B', deploy.nftB.category], ['NFT-C', deploy.nftC.category]]));
    }
  }
  $('state').innerHTML = lines.join('<br>');
  setButtons();
}

// ---------------------------------------------------------------- cases
function setButtons() {
  const chipnetReady = network === 'chipnet' && !!deploy && deploy.network === 'chipnet';
  const ready = !!user && !pending && (!!dry || chipnetReady);
  for (const id of ['A', 'B', 'C']) $<HTMLButtonElement>(`run${id}`).disabled = !ready;
  $<HTMLButtonElement>('cancel').disabled = !pending;
}
$('descA').textContent = `${AMOUNTS.SEND_A} sats; inputPaths on P2PKH inputs`;
$('descB').textContent = `buy NFT-B at ${AMOUNTS.PRICE_B} sats (100 % to artisan); vault input unsigned`;
$('descC').textContent = `list NFT-C at ${AMOUNTS.LIST_C}; inputPaths entry on the vault input 0`;

async function build(id: 'A' | 'B' | 'C', u: User): Promise<Built> {
  if (dry) {
    return id === 'A' ? buildA(dry.provider, u, dry.returnAddress)
      : id === 'B' ? buildB(dry.provider, dry.contract, dry.artisanLock, u, dry.catB)
        : buildC(dry.provider, dry.contract, u, dry.catC, AMOUNTS.LIST_C);
  }
  const contract = makeContract(deploy!, chipnet);
  return id === 'A' ? buildA(chipnet, u, deploy!.returnAddress)
    : id === 'B' ? buildB(chipnet, contract, hexToBin(deploy!.artisanLock), u, deploy!.nftB.category)
      : buildC(chipnet, contract, u, deploy!.nftC.category, AMOUNTS.LIST_C);
}

// Wallet errors that suggest it looked the inputs up in its own wallet and didn't find them
const LOOKS_LIKE_MISSING_INPUTS = /utxo|input|not found|unknown|missing|spent|does not exist|not in wallet|insufficient/i;

async function runCase(id: 'A' | 'B' | 'C') {
  const out = $(`res${id}`);
  const add = (html: string) => (out.innerHTML += html);
  if (!user) return;
  const mode = dry ? 'DRY RUN (mainnet, fake inputs, no broadcast)' : 'CHIPNET';
  out.innerHTML = `[${mode}] building…`;
  let built: Built;
  try { built = await build(id, user); }
  catch (e: any) {
    add(`\n<span class="bad">FAILS before signing (our side):</span> ${e.message}`);
    log(`case ${id} build error`, e.message);
    return;
  }
  const wc = built.tb.generateWcTransactionObject({ broadcast: false, userPrompt: `TA spike case ${id}${dry ? ' (dry run, do not broadcast)' : ''}` });
  const notSent = (what: string, e: any) => {
    add(`\n<span class="bad">FAILS — OUR side, request not sent:</span> ${what}: ${e?.message ?? e}`);
    log(`case ${id} not sent (${what})`, String(e?.message ?? e));
  };
  // Convert to the JSON-safe wire format (hex tx, "<bigint: Xn>" / "<Uint8Array: 0x…>" strings) and
  // prove it serializes before anything goes to the relay.
  let wire: WireTransaction;
  try {
    wire = toWire(wc);
    JSON.stringify({ transaction: wire, inputPaths: built.inputPaths });
  } catch (e: any) { notSent('could not serialize the request', e); return; }
  log(`case ${id} request [${mode}]`, { describe: built.describe, inputPaths: built.inputPaths, transactionHex: wire.transaction });
  out.innerHTML = `[${mode}]\n${built.describe.join('\n')}\ninputPaths ${JSON.stringify(built.inputPaths)}\n\nwaiting for Selene… approve in the wallet`;

  // Track how far the request got, to label failures by side
  let sentSeq: number | undefined;
  let walletResponse: { sequence: number; error?: string } | undefined;
  const onSent = (m: any) => { if (m.action === 'sign_transaction_request') sentSeq = m.sequence; };
  const onRecv = (m: any) => { if (m.action === 'sign_transaction_response' && m.sequence === sentSeq) walletResponse = m; };
  mgr.on('messagesent', onSent); mgr.on('messagereceived', onRecv);

  pending = new AbortController(); setButtons();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; pending?.abort(); }, SIGN_TIMEOUT_MS);
  let res;
  try {
    res = await mgr.signTransaction({ transaction: wire as any, inputPaths: built.inputPaths }, { signal: pending.signal });
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (sentSeq === undefined) {
      notSent('the relay did not accept it', e);
    } else if (walletResponse?.error !== undefined) {
      add(`\n<span class="bad">FAILS — WALLET side, Selene refused:</span> ${walletResponse.error}`);
      if (dry && LOOKS_LIKE_MISSING_INPUTS.test(walletResponse.error)) add('\n→ looks like Selene could not find the (fake) inputs in its wallet: real funds are needed for the full test');
      log(`case ${id} Selene error (exact)`, walletResponse.error);
    } else if (timedOut) {
      add(`\n<span class="bad">NO RESPONSE from Selene in ${SIGN_TIMEOUT_MS / 1000} s</span> (request sent, then cancelled).` +
        '\n→ If the connection was not approved in Selene, this is expected: Selene drops sign requests on unapproved connections.');
      log(`case ${id} timeout`, msg);
    } else {
      add(`\n<span class="bad">Request sent, no wallet response:</span> ${msg} (cancelled or connection lost — not a Selene verdict)`);
      log(`case ${id} sign error after sending`, msg);
    }
    return;
  } finally {
    clearTimeout(timer); pending = undefined; setButtons();
    mgr.off('messagesent', onSent); mgr.off('messagereceived', onRecv);
  }

  log(`case ${id} response`, res);
  // Exact, untruncated wallet output
  log(`case ${id} raw response (full)`, `error: ${res.error ?? '(none)'}\nsignedTransaction: ${res.signedTransaction ?? '(none)'}`);
  if (res.error || !res.signedTransaction) {
    const msg = res.error ?? '(empty signedTransaction)';
    add(`\n<span class="bad">FAILS — WALLET side, Selene returned:</span> ${msg}`);
    if (dry && LOOKS_LIKE_MISSING_INPUTS.test(msg)) add('\n→ looks like Selene could not find the (fake) inputs in its wallet: real funds are needed for the full test');
    return;
  }

  const d = diagnose(wc, built.inputPaths, res.signedTransaction, user.pkh);
  log(`case ${id} diagnosis: ${d.verdict}`, d.lines.join('\n'));
  const unfilled = d.lines.some((l) => /NOT filled|NOT signed/.test(l));
  const summary = [
    `Selene: ${unfilled ? '<span class="bad">signed, but returned placeholders UNFILLED</span>' : '<span class="ok">signed</span>'}`,
    `our signature checks: ${d.issues.length ? `<span class="bad">FAIL (${d.issues.length})</span>` : '<span class="ok">PASS</span>'}`,
    `BCH VM on the returned tx: ${d.vm === true ? '<span class="ok">ACCEPTS</span>' : `<span class="bad">REJECTS</span> ${d.vm ?? ''}`}`,
    `verdict: ${d.verdict === 'valid' ? '<span class="ok">WORKS (signature-wise)</span>' : d.verdict === 'wallet' ? '<span class="bad">FAILS — WALLET side (Selene)</span>' : '<span class="bad">FAILS — OUR tx construction</span>'}`,
  ];
  add(`\n\n--- diagnosis ---\n${d.lines.join('\n')}\n\n${summary.join('\n')}`);

  if (dry) {
    // No broadcast path exists in dry-run mode.
    add('\n<span class="muted">dry run: not broadcast (inputs are fake).</span>');
    return;
  }
  if (d.verdict !== 'valid') { add(`\nsigned hex: ${res.signedTransaction}`); return; }
  if (network !== 'chipnet') { add('\n<span class="bad">refusing to broadcast: not chipnet</span>'); return; }
  try {
    const txid = await chipnet.sendRawTransaction(res.signedTransaction);
    log(`case ${id} broadcast OK`, txid);
    add(`\n<span class="ok">broadcast OK</span> txid ${txid}\n<a href="${EXPLORER}${txid}" target="_blank" rel="noopener">${EXPLORER}${txid}</a>`);
    refresh();
  } catch (e: any) {
    log(`case ${id} broadcast error`, e.message);
    add(`\n<span class="bad">FAILS at broadcast (node rejected):</span> ${e.message}\nsigned hex: ${res.signedTransaction}`);
  }
}

// ---------------------------------------------------------------- wire up
$('connect').onclick = () => connect().catch((e) => log('connect error', e.message));
$('forget').onclick = () => forget();
$('copy').onclick = () => navigator.clipboard.writeText($('uri').textContent ?? '');
$('refresh').onclick = () => refresh();
$('cancel').onclick = () => pending?.abort();
// Manual override: mainnet dry run with an identity from a pasted receive/0 address (no xpubs needed)
$('useOverride').onclick = () => {
  try {
    const r = userFromAddress($<HTMLInputElement>('overrideAddress').value);
    if (r.network !== 'mainnet') throw new Error('override is for the mainnet dry run: paste a bitcoincash: address');
    manual = true; network = 'mainnet'; user = r.user; dry = makeDryRun(r.user);
    $('modeBanner').hidden = false;
    $('wallet').innerHTML = [
      '<span class="warn">MANUAL OVERRIDE → mainnet SIGN-ONLY DRY RUN (fake UTXOs, broadcasting disabled)</span>',
      `identity from pasted address (no xpubs): ${r.user.address}`,
      `pkh: ${binToHex(r.user.pkh)}`,
      'Sign requests are only answered if the connection is approved in Selene.',
    ].join('<br>');
    log('manual override: mainnet dry run', { address: r.user.address });
    refresh();
  } catch (e: any) { log('override error', e.message); $('overrideMsg').textContent = e.message; }
};
for (const id of ['A', 'B', 'C'] as const) $(`run${id}`).onclick = () => runCase(id);
restore();
refresh();
