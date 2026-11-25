#!/usr/bin/env node
import { ApiPromise, WsProvider } from '@polkadot/api';
import { Keyring } from '@polkadot/keyring';
import { cryptoWaitReady, mnemonicValidate } from '@polkadot/util-crypto';

let EXPECTED_ADDRESS = ''; // set via --address <YOUR_SS58_ADDRESS>
const EXPECTED_GENESIS = '0x918abd58fb16306b30ef3886514cfaebffecb4de43e82b6f8ec4795c43cfd800';
const FAUCET_BASE = 'https://faucet.flop.network';
const CLAIM_PATH = '/v1/testnet/agent-claims';
const RPC_URL = 'wss://testnet.flop.network/';
const DECIMALS = 18n;

function parseArgs(argv) {
  const args = { checkOnly: false, force: false, nonce: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check-only') {
      args.checkOnly = true;
    } else if (a === '--force') {
      args.force = true;
    } else if (a === '--address') {
      if (i + 1 >= argv.length) {
        throw new Error('Missing value for --address');
      }
      args.address = argv[++i];
    } else if (a === '--nonce') {
      if (i + 1 >= argv.length) {
        throw new Error('Missing value for --nonce');
      }
      args.nonce = argv[++i];
    } else if (a === '--help' || a === '-h') {
      console.log(`FLOP Testnet Agent Faucet Claim Script

Usage (always pass your own address):
  node claim.mjs --address <SS58>               Check faucet, prompt hidden mnemonic, sign & claim, check balance
  node claim.mjs --address <SS58> --check-only  Check faucet status and Testnet balance only (no mnemonic)
  ... --nonce <num>   Use a specific 1-19 digit decimal nonce (to reconcile an unknown result)
  ... --force         Submit claim even if /health reports indexer_unavailable
`);
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${a}`);
    }
  }
  return args;
}

function formatFlop(rawPlancks) {
  const base = 10n ** DECIMALS;
  const whole = rawPlancks / base;
  const frac = (rawPlancks % base).toString().padStart(Number(DECIMALS), '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

function readHiddenLine(promptText) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    stdout.write(promptText);

    if (!stdin.isTTY) {
      let data = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (chunk) => {
        data += chunk;
      });
      stdin.on('end', () => {
        stdout.write('\n');
        resolve(data.split(/\r?\n/)[0].trim().replace(/\s+/g, ' '));
      });
      stdin.on('error', reject);
      return;
    }

    let input = '';
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    const cleanup = () => {
      stdin.removeListener('data', onData);
      try {
        stdin.setRawMode(Boolean(wasRaw));
      } catch {
        // ignore
      }
      stdin.pause();
    };

    const onData = (chunk) => {
      for (const ch of chunk) {
        const code = ch.charCodeAt(0);
        if (ch === '\r' || ch === '\n') {
          cleanup();
          stdout.write('\n');
          resolve(input.trim().replace(/\s+/g, ' '));
          return;
        }
        if (code === 3) {
          // Ctrl+C
          cleanup();
          stdout.write('\nCancelled.\n');
          process.exit(130);
        }
        if (code === 8 || code === 127) {
          // Backspace / DEL
          if (input.length > 0) {
            input = input.slice(0, -1);
          }
          continue;
        }
        if (code >= 32) {
          input += ch;
        }
      }
    };

    stdin.on('data', onData);
  });
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
    ...options,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // non-JSON response
  }
  return { status: res.status, ok: res.ok, headers: res.headers, text, json };
}

async function checkFaucet() {
  console.log(`Checking faucet at ${FAUCET_BASE} ...`);

  const chainRes = await fetchJson(`${FAUCET_BASE}/chain`);
  if (!chainRes.ok || !chainRes.json) {
    throw new Error(`GET /chain failed: HTTP ${chainRes.status} ${chainRes.text}`);
  }
  const { network, genesisHash } = chainRes.json;
  if (network !== 'testnet' || String(genesisHash || '').toLowerCase() !== EXPECTED_GENESIS) {
    throw new Error(
      `Faucet /chain mismatch! Expected testnet (${EXPECTED_GENESIS}), got ${network} (${genesisHash}). Aborting.`
    );
  }
  console.log(`  /chain ok: ${chainRes.json.chain} (${network}), genesis verified.`);

  const limitsRes = await fetchJson(`${FAUCET_BASE}/limits`);
  if (!limitsRes.ok || !limitsRes.json) {
    throw new Error(`GET /limits failed: HTTP ${limitsRes.status} ${limitsRes.text}`);
  }
  const faucetLimits = limitsRes.json.faucet || {};
  const agentLimits = faucetLimits.agent || {};
  console.log(
    `  /limits ok: status=${faucetLimits.status}, agentGrant=${agentLimits.grantFlop} FLOP, claimPath=${agentLimits.claimPath}, dailyRemaining=${faucetLimits.dailyCap?.remainingFlop ?? '?'} FLOP`
  );
  if (faucetLimits.status !== 'open') {
    throw new Error(`Faucet is not open (status=${faucetLimits.status}).`);
  }
  if (agentLimits.claimPath !== CLAIM_PATH) {
    throw new Error(`Unexpected agent claimPath: ${agentLimits.claimPath}`);
  }

  const healthRes = await fetchJson(`${FAUCET_BASE}/health`);
  const healthStatus = healthRes.json?.status ?? `HTTP ${healthRes.status}`;
  const indexerDep = healthRes.json?.dependencies?.indexer;
  console.log(
    `  /health: HTTP ${healthRes.status}, status=${healthStatus}, ready=${healthRes.json?.ready}, indexerOk=${indexerDep?.ok}${indexerDep?.reason ? ` (${indexerDep.reason})` : ''}`
  );

  return { chain: chainRes.json, limits: limitsRes.json, health: healthRes };
}

async function connectRpc() {
  const provider = new WsProvider(RPC_URL, 5000);
  const api = await ApiPromise.create({ provider, noInitWarn: true });
  const rpcGenesis = api.genesisHash.toHex().toLowerCase();
  if (rpcGenesis !== EXPECTED_GENESIS) {
    await api.disconnect();
    throw new Error(`RPC genesis mismatch! Expected ${EXPECTED_GENESIS}, got ${rpcGenesis}`);
  }
  return api;
}

async function readAccountBalance(api, address) {
  const info = await api.query.system.account(address);
  const free = BigInt(info.data.free.toString());
  const reserved = BigInt(info.data.reserved.toString());
  const frozen = info.data.frozen ? BigInt(info.data.frozen.toString()) : 0n;
  return {
    nonce: Number(info.nonce.toString()),
    free,
    reserved,
    frozen,
  };
}

function printBalance(label, bal) {
  console.log(
    `${label}: free=${formatFlop(bal.free)} FLOP, reserved=${formatFlop(bal.reserved)} FLOP, frozen=${formatFlop(bal.frozen)} FLOP (txNonce=${bal.nonce})`
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.address) {
    throw new Error('Missing --address <YOUR_SS58_ADDRESS> (your Talisman Substrate address, starts with 5...).');
  }
  EXPECTED_ADDRESS = args.address.trim();
  const nonce = args.nonce ?? Date.now().toString();
  if (!/^(0|[1-9][0-9]{0,18})$/.test(nonce)) {
    throw new Error('Invalid nonce: must be a canonical decimal string of 1 to 19 digits.');
  }

  const { health } = await checkFaucet();

  if (args.checkOnly) {
    console.log(`\nChecking Testnet balance on ${RPC_URL} for ${EXPECTED_ADDRESS} ...`);
    const api = await connectRpc();
    try {
      const bal = await readAccountBalance(api, EXPECTED_ADDRESS);
      printBalance('Testnet balance', bal);
    } finally {
      await api.disconnect();
    }
    return;
  }

  if (health.json?.dependencies?.indexer?.ok === false && !args.force) {
    console.log(
      `\nFaucet indexer is currently unavailable (${health.json.dependencies.indexer.reason || 'indexer_unavailable'}).`
    );
    console.log('The server will likely return HTTP 503 right now. Wait and try again later, or pass --force to submit anyway.');
    process.exit(2);
  }

  await cryptoWaitReady();

  console.log(`\nTarget address: ${EXPECTED_ADDRESS}`);
  let mnemonic = await readHiddenLine('Enter Talisman 12/24-word mnemonic (hidden, local signing only): ');
  if (!mnemonic) {
    throw new Error('No mnemonic entered. Aborting.');
  }

  let pair;
  try {
    if (!mnemonicValidate(mnemonic)) {
      throw new Error('Invalid BIP-39 mnemonic phrase. Please check spelling and word count.');
    }
    const keyring = new Keyring({ type: 'sr25519', ss58Format: 42 });
    pair = keyring.addFromMnemonic(mnemonic);
  } finally {
    mnemonic = '';
  }

  if (pair.address !== EXPECTED_ADDRESS) {
    throw new Error(
      `Derived address mismatch!\n  Derived : ${pair.address}\n  Expected: ${EXPECTED_ADDRESS}\nAborting so wrong wallet is never used.`
    );
  }
  console.log(`Mnemonic verified locally -> matches ${pair.address} (sr25519).`);

  // Check balance before claim (also verifies RPC genesis before signing)
  console.log(`Connecting to ${RPC_URL} ...`);
  const api = await connectRpc();
  let balBefore;
  try {
    balBefore = await readAccountBalance(api, EXPECTED_ADDRESS);
    printBalance('Balance before', balBefore);

    const claimMessage = `flop-faucet-agent/v1|${EXPECTED_GENESIS}|${pair.address}|${nonce}`;
    const sigBytes = pair.sign(new TextEncoder().encode(claimMessage));
    const signature = '0x' + Buffer.from(sigBytes).toString('hex');

    console.log(`\nSubmitting signed claim (nonce=${nonce}) to ${FAUCET_BASE}${CLAIM_PATH} ...`);
    const claimRes = await fetchJson(`${FAUCET_BASE}${CLAIM_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        address: pair.address,
        nonce,
        signature,
      }),
    });

    console.log(`Response HTTP ${claimRes.status}:`);
    const retryAfter = claimRes.headers.get('retry-after');
    if (retryAfter) {
      console.log(`Retry-After: ${retryAfter}s`);
    }
    console.log(claimRes.json ? JSON.stringify(claimRes.json, null, 2) : claimRes.text);

    if (claimRes.ok && claimRes.json?.success) {
      console.log('\nClaim accepted! Polling Testnet balance for up to 20 seconds...');
      let balAfter = balBefore;
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        balAfter = await readAccountBalance(api, EXPECTED_ADDRESS);
        if (balAfter.free > balBefore.free) {
          break;
        }
      }
      printBalance('Balance after ', balAfter);
      if (balAfter.free === balBefore.free) {
        console.log(`Balance has not updated yet. To reconcile safely without double-claiming, keep nonce=${nonce}.`);
      }
    } else {
      if (claimRes.status >= 500 || claimRes.status === 408) {
        console.log(`\nIf retrying an ambiguous/5xx error later, you can reuse --nonce ${nonce} or generate a new one after confirmation.`);
      }
      const balAfter = await readAccountBalance(api, EXPECTED_ADDRESS);
      printBalance('Current balance', balAfter);
      process.exitCode = 1;
    }
  } finally {
    await api.disconnect();
  }
}

main().catch((err) => {
  console.error(`\nError: ${err?.message || err}`);
  process.exit(1);
});
