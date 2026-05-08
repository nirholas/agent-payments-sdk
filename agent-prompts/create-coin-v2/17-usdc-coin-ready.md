# Task 17 — USDC coin watcher: fire when pump.fun whitelists USDC

You are a senior TypeScript/Node.js engineer. Complete this task end-to-end — create a production-quality script that monitors pump.fun's Global account and instantly creates a USDC-quoted v2 coin the moment USDC is whitelisted.

## Goal

Create `/workspaces/agent-payments-sdk/scripts/usdc-coin-watcher.mjs` — a Node.js script that:
1. Polls the pump.fun Global account every 15 seconds
2. Detects when USDC appears in `whitelistedQuoteMints`
3. Immediately creates a v2 pump.fun coin with `quoteMint = USDC`
4. Saves the result and optionally sends a desktop notification

## Files to read first

1. `/workspaces/agent-payments-sdk/.wallet.json` — the signer wallet (array of numbers = Uint8Array keypair)
2. `/workspaces/agent-payments-sdk/swap/node_modules/@pump-fun/pump-sdk/` — check exports:
   - `OnlinePumpSdk` — has `.fetchGlobal()`, `.fetchFeeConfig()`
   - `PUMP_SDK.createV2Instruction`
   - `bondingCurvePda`
   - `isLegacyQuoteMint`
3. `/workspaces/agent-payments-sdk/src/solana/PumpAgentOffline.ts` — see how it uses the SDK
4. `/workspaces/agent-payments-sdk/package.json` — check available dependencies

## Constants

```js
const PUMP_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const METADATA_URI = 'https://ipfs.io/ipfs/QmfTCrSFAp7GQG9aByvgwfaCwkzE9KpTXB5tMmFjnAEc89';
const COIN_NAME = 'Agent Payments';
const COIN_SYMBOL = 'AGNT';
const RESULT_FILE = '/workspaces/agent-payments-sdk/.usdc-coin-result.json';
const MINT_FILE = '/workspaces/agent-payments-sdk/.usdc-coin-mint.json';
const POLL_INTERVAL_MS = 15_000;
const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
```

## CLI flags

Parse `process.argv` manually (no commander needed):
- `--dry-run` — build and simulate the transaction but do not send
- `--notify-only` — poll and log when USDC is detected, but do not create a coin
- `--once` — check once and exit (useful for cron jobs)

## Full script structure

```js
#!/usr/bin/env node
// usdc-coin-watcher.mjs
// Run: node scripts/usdc-coin-watcher.mjs [--dry-run] [--notify-only] [--once]

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Parse flags
const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const NOTIFY_ONLY = argv.includes('--notify-only');
const ONCE = argv.includes('--once');
```

## Loading the wallet

```js
function loadWallet() {
  const walletPath = path.join(__dirname, '../.wallet.json');
  if (!existsSync(walletPath)) {
    console.error('ERROR: .wallet.json not found at', walletPath);
    console.error('Create it with: node -e "const k=require(\'@solana/web3.js\').Keypair.generate(); require(\'fs\').writeFileSync(\'.wallet.json\', JSON.stringify(Array.from(k.secretKey)));"');
    process.exit(1);
  }
  const { Keypair } = require('@solana/web3.js');
  const secretKey = Uint8Array.from(JSON.parse(readFileSync(walletPath, 'utf8')));
  return Keypair.fromSecretKey(secretKey);
}
```

## Checking for USDC whitelist

Use `OnlinePumpSdk.fetchGlobal()` to fetch the current global config and check `whitelistedQuoteMints`:

```js
async function checkUsdcWhitelisted(onlineSdk) {
  try {
    const global = await onlineSdk.fetchGlobal();
    const mints = global.whitelistedQuoteMints || [];
    const mintStrings = mints.map(m => m.toBase58 ? m.toBase58() : String(m));
    return {
      isWhitelisted: mintStrings.includes(USDC_MINT),
      whitelistedMints: mintStrings,
      global,
    };
  } catch (err) {
    console.warn('[poll] fetchGlobal error:', err.message);
    return { isWhitelisted: false, whitelistedMints: [], global: null };
  }
}
```

## Creating the USDC coin

When USDC is detected:

```js
async function createUsdcCoin(wallet, connection, global, feeConfig) {
  const { Keypair, PublicKey, VersionedTransaction, TransactionMessage, Connection } = require('@solana/web3.js');
  const { PUMP_SDK, OnlinePumpSdk } = require('@pump-fun/pump-sdk');
  const { TOKEN_2022_PROGRAM_ID } = require('@solana/spl-token');

  // Generate or load mint keypair
  let mintKp;
  if (existsSync(MINT_FILE)) {
    console.log('[create] Loading existing mint keypair from', MINT_FILE);
    mintKp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(MINT_FILE, 'utf8'))));
  } else {
    mintKp = Keypair.generate();
    writeFileSync(MINT_FILE, JSON.stringify(Array.from(mintKp.secretKey)));
    console.log('[create] Generated new mint keypair:', mintKp.publicKey.toBase58());
  }

  const USDC_PUBKEY = new PublicKey(USDC_MINT);

  // Build createV2Instruction
  const ixResult = await PUMP_SDK.createV2Instruction({
    global,
    feeConfig,
    mint: mintKp.publicKey,
    name: COIN_NAME,
    symbol: COIN_SYMBOL,
    uri: METADATA_URI,
    creator: wallet.publicKey,
    quoteMint: USDC_PUBKEY,
    tokenProgram: TOKEN_2022_PROGRAM_ID,
  });
  const instructions = Array.isArray(ixResult) ? ixResult : [ixResult];

  // Get latest blockhash
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

  // Build VersionedTransaction
  const message = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([wallet, mintKp]);

  if (DRY_RUN) {
    console.log('[dry-run] Simulating transaction...');
    const sim = await connection.simulateTransaction(tx, { sigVerify: false });
    console.log('[dry-run] Simulation result:', JSON.stringify(sim.value, null, 2));
    return {
      dryRun: true,
      mint: mintKp.publicKey.toBase58(),
      simulationLogs: sim.value.logs,
      simulationError: sim.value.err,
    };
  }

  // Send
  console.log('[create] Sending transaction...');
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  console.log('[create] Sent:', sig);

  // Confirm
  const conf = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  if (conf.value.err) throw new Error('Transaction confirmed with error: ' + JSON.stringify(conf.value.err));

  const mint = mintKp.publicKey.toBase58();
  const pumpUrl = `https://pump.fun/coin/${mint}`;
  console.log('[create] SUCCESS!');
  console.log('[create] Mint:', mint);
  console.log('[create] Tx:', sig);
  console.log('[create] pump.fun:', pumpUrl);

  return { mint, sig, pumpUrl, dryRun: false };
}
```

## Notification

```js
async function sendNotification(title, message) {
  // Try node-notifier first
  try {
    const notifier = require('node-notifier');
    notifier.notify({ title, message, sound: true });
    return;
  } catch {}

  // Fallback: terminal bell + loud log
  process.stdout.write('\x07'); // bell
  console.log('\n' + '='.repeat(60));
  console.log(`NOTIFICATION: ${title}`);
  console.log(message);
  console.log('='.repeat(60) + '\n');
}
```

## Main poll loop

```js
async function main() {
  console.log('[usdc-coin-watcher] Starting...');
  console.log('[usdc-coin-watcher] Flags: DRY_RUN=%s NOTIFY_ONLY=%s ONCE=%s', DRY_RUN, NOTIFY_ONLY, ONCE);

  const { Connection, PublicKey } = require('@solana/web3.js');
  const { OnlinePumpSdk } = require('@pump-fun/pump-sdk');

  const connection = new Connection(RPC_URL, 'confirmed');
  const onlineSdk = new OnlinePumpSdk(connection);
  const wallet = loadWallet();

  console.log('[usdc-coin-watcher] Wallet:', wallet.publicKey.toBase58());
  console.log('[usdc-coin-watcher] Polling every', POLL_INTERVAL_MS / 1000, 'seconds...');

  // Check if already completed
  if (existsSync(RESULT_FILE)) {
    const result = JSON.parse(readFileSync(RESULT_FILE, 'utf8'));
    console.log('[usdc-coin-watcher] Already completed. Result:', result);
    if (!DRY_RUN) {
      console.log('[usdc-coin-watcher] Delete', RESULT_FILE, 'to re-run.');
      process.exit(0);
    }
  }

  let attempts = 0;
  while (true) {
    attempts++;
    console.log(`[poll] Check #${attempts} at ${new Date().toISOString()}`);

    const { isWhitelisted, whitelistedMints, global } = await checkUsdcWhitelisted(onlineSdk);

    if (!isWhitelisted) {
      console.log('[poll] USDC not yet whitelisted. Current mints:', whitelistedMints.join(', ') || '(none)');
      if (ONCE) { console.log('[once] Exiting.'); process.exit(0); }
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      continue;
    }

    // USDC detected!
    console.log('[poll] USDC IS WHITELISTED! Mints:', whitelistedMints);
    await sendNotification('pump.fun USDC Live!', 'USDC is now whitelisted on pump.fun v2 bonding curves.');

    if (NOTIFY_ONLY) {
      console.log('[notify-only] Detected USDC. Exiting without creating coin.');
      process.exit(0);
    }

    // Fetch fee config
    let feeConfig = null;
    try { feeConfig = await onlineSdk.fetchFeeConfig(); } catch {}

    let result;
    let retries = 0;
    while (retries < 3) {
      try {
        result = await createUsdcCoin(wallet, connection, global, feeConfig);
        break;
      } catch (err) {
        retries++;
        console.error(`[create] Attempt ${retries} failed:`, err.message);
        if (retries < 3) await new Promise(r => setTimeout(r, 5000));
      }
    }
    if (!result) {
      console.error('[create] All retries failed. Exiting.');
      process.exit(1);
    }

    const finalResult = {
      ...result,
      timestamp: new Date().toISOString(),
      walletPubkey: wallet.publicKey.toBase58(),
    };

    if (!DRY_RUN) {
      writeFileSync(RESULT_FILE, JSON.stringify(finalResult, null, 2));
      console.log('[result] Saved to', RESULT_FILE);
      await sendNotification('Coin Created!', `Mint: ${result.mint}\n${result.pumpUrl}`);
    }

    console.log('[done]', JSON.stringify(finalResult, null, 2));
    process.exit(0);
  }
}

main().catch(err => {
  console.error('[fatal]', err);
  process.exit(1);
});
```

## Module resolution

The script uses `createRequire` to call `require()` from an ESM module. The pump-sdk is in `/workspaces/agent-payments-sdk/swap/node_modules/`. To ensure the require resolves correctly:

```js
const require = createRequire(
  new URL('../swap/node_modules/', import.meta.url)
);
```

Or set `NODE_PATH` before running. Test the import resolution before finalizing.

Alternatively, use dynamic `import()` for everything:
```js
const { OnlinePumpSdk, PUMP_SDK } = await import('/workspaces/agent-payments-sdk/swap/node_modules/@pump-fun/pump-sdk/dist/index.js');
```

Pick whichever works with the installed package format (check if it has `dist/index.js` or `dist/index.cjs`).

## Testing

After writing the script, test with:

```bash
# Dry run — should simulate without sending
node scripts/usdc-coin-watcher.mjs --dry-run --once

# Notify only — should check and exit
node scripts/usdc-coin-watcher.mjs --notify-only --once
```

Verify:
- `--once --notify-only` exits after one poll
- `--dry-run --once` either completes a simulation (if USDC is live) or exits cleanly (if not)
- No crashes on missing `.wallet.json` (should print instructions)

## Checklist

- [ ] Read `.wallet.json` to understand the key format
- [ ] Check pump-sdk module exports and resolution path
- [ ] Create `/workspaces/agent-payments-sdk/scripts/usdc-coin-watcher.mjs`
- [ ] Implement wallet loading with clear error if missing
- [ ] Implement `checkUsdcWhitelisted` using `OnlinePumpSdk.fetchGlobal()`
- [ ] Implement `createUsdcCoin` with `PUMP_SDK.createV2Instruction`
- [ ] Implement `sendNotification` with node-notifier fallback
- [ ] Implement `--dry-run`, `--notify-only`, `--once` flags
- [ ] Save result to `.usdc-coin-result.json`
- [ ] Save mint keypair to `.usdc-coin-mint.json`
- [ ] Skip if result file already exists (idempotent)
- [ ] Test `--dry-run --once` succeeds without errors
- [ ] Test `--notify-only --once` exits cleanly

## Do not

- Do not hardcode private keys
- Do not send transactions during testing (`--dry-run` only)
- Do not install new packages without checking package.json first
- Do not modify any SDK source files
- Do not create any files outside of `scripts/` and the root `.` directory
