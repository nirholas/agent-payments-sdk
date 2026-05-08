# Task 14 — Replace handleLaunchPrep with v2 pump.fun coin launch

You are a senior TypeScript/Node.js engineer. Complete this task end-to-end in a single session — no mocks, no stubs, real API calls, production-quality code.

## Goal

Replace the current `handleLaunchPrep` in `/workspaces/three.ws/api/pump/[action].js` with a full v2 implementation that uses `@pump-fun/pump-sdk@1.35.0`'s `createV2AndBuyV2Instructions`. The updated flow must handle the 1232-byte Solana transaction size limit by splitting into a create tx and a buy tx when necessary.

## Files to read first

1. `/workspaces/three.ws/api/pump/[action].js` — read the entire file, especially:
   - `handleLaunchPrep` (line ~493)
   - `handleLaunchConfirm` (line ~627)
   - The `getPumpSdk` helper and existing imports at the top of the file
   - The `buildUnsignedTxBase64` helper
   - The `launchPrepSchema` zod schema (line ~479)

2. `/workspaces/agent-payments-sdk/swap/node_modules/@pump-fun/pump-sdk/` — check what's exported, specifically:
   - `PUMP_SDK.createV2AndBuyV2Instructions`
   - `PUMP_SDK.createV2Instruction`
   - `OnlinePumpSdk`
   - `getBuyTokenAmountFromSolAmount`
   - `bondingCurvePda`
   - `isLegacyQuoteMint`

## Background knowledge

- v2 pump.fun coins use `TOKEN_2022_PROGRAM_ID` as the token program (not the classic SPL token program)
- v2 bonding curve accounts are 115 bytes (vs 49 bytes for v1) — they include a `quoteMint` field
- `bondingCurvePda(mint, programId)` returns the same PDA seeds as v1 but the account has the extended 115-byte layout
- For standard wSOL-quoted coins, `quoteMint = NATIVE_MINT` (`So11111111111111111111111111111111111111112`)
- Solana transactions have a hard 1232-byte size limit; create + initial buy instructions often exceed this, requiring two separate transactions
- `createV2AndBuyV2Instructions` returns `{ createInstructions, buyInstructions }` — each is an array of `TransactionInstruction`

## Implementation steps

### Step 1 — Update `launchPrepSchema`

Add an optional `quote_mint` field (string, default `'So11111111111111111111111111111111111111112'`). This allows future USDC support without a breaking change.

```js
quote_mint: z.string().min(32).max(44).default('So11111111111111111111111111111111111111112'),
```

### Step 2 — Rewrite `handleLaunchPrep`

Replace the existing instruction-building block (the `if (body.sol_buy_in > 0 && sdk.createAndBuyInstructions)` block) with the following logic:

```js
// Dynamically import pump-sdk v2 helpers
const pumpSdk = await import('@pump-fun/pump-sdk');
const { PUMP_SDK, OnlinePumpSdk, getBuyTokenAmountFromSolAmount } = pumpSdk;
const { TOKEN_2022_PROGRAM_ID } = await import('@solana/spl-token');
const { PublicKey: PK } = await import('@solana/web3.js');

const NATIVE_MINT = new PK('So11111111111111111111111111111111111111112');
const quoteMint = new PK(body.quote_mint);
const conn = getConnection(body.network); // use existing connection helper

const onlineSdk = new OnlinePumpSdk(conn);
const global = await onlineSdk.fetchGlobal();
const feeConfig = await onlineSdk.fetchFeeConfig().catch(() => null); // optional

const solAmount = new BN(Math.floor(body.sol_buy_in * 1_000_000_000));

let createInstructions, buyInstructions;

if (body.sol_buy_in > 0) {
  const tokenAmount = getBuyTokenAmountFromSolAmount(global, null, solAmount);
  const result = await PUMP_SDK.createV2AndBuyV2Instructions({
    global,
    feeConfig,
    mint: mint.publicKey ?? mint,
    name: body.name,
    symbol: body.symbol,
    uri: body.uri,
    creator,
    user: creator,
    solAmount,
    amount: tokenAmount,
    quoteMint,
    tokenProgram: TOKEN_2022_PROGRAM_ID,
  });
  createInstructions = result.createInstructions;
  buyInstructions = result.buyInstructions;
} else {
  const result = await PUMP_SDK.createV2Instruction({
    global,
    feeConfig,
    mint: mint.publicKey ?? mint,
    name: body.name,
    symbol: body.symbol,
    uri: body.uri,
    creator,
    quoteMint,
    tokenProgram: TOKEN_2022_PROGRAM_ID,
  });
  createInstructions = Array.isArray(result) ? result : [result];
  buyInstructions = [];
}
```

After building instructions, optionally append the `PumpAgent.create` instruction (for `buyback_bps > 0`) to `createInstructions`.

### Step 3 — Transaction size splitting

After assembling `createInstructions` and `buyInstructions`, measure the combined transaction size. If it exceeds 1232 bytes, split into two transactions:

```js
async function buildAndMeasureTx(network, payer, instructions) {
  const base64 = await buildUnsignedTxBase64({ network, payer, instructions });
  const bytes = Buffer.from(base64, 'base64');
  return { base64, size: bytes.length };
}

const SOLANA_TX_MAX_BYTES = 1232;

const combinedInstructions = [...createInstructions, ...buyInstructions];
const combined = await buildAndMeasureTx(body.network, creator, combinedInstructions);

let responseTxs;
if (combined.size <= SOLANA_TX_MAX_BYTES) {
  // Fits in one tx — mint keypair must sign both create + buy
  responseTxs = {
    tx_base64: combined.base64,
    create_tx_base64: null,
    buy_tx_base64: null,
    split: false,
  };
} else {
  // Must split: create tx + buy tx
  const createTx = await buildAndMeasureTx(body.network, creator, createInstructions);
  const buyTx = buyInstructions.length > 0
    ? await buildAndMeasureTx(body.network, creator, buyInstructions)
    : null;
  responseTxs = {
    tx_base64: null,
    create_tx_base64: createTx.base64,
    buy_tx_base64: buyTx?.base64 ?? null,
    split: true,
  };
}
```

Important: the mint keypair must co-sign the create tx in both split and combined flows. The response must include `mint_secret_key_b64` when the server generated the mint.

### Step 4 — Update `handleLaunchPrep` response

Return the split-aware response:

```js
return json(res, 201, {
  prep_id: prepId,
  mint: mint.toBase58(),
  mint_secret_key_b64: mintKeypair ? Buffer.from(mintKeypair.secretKey).toString('base64') : null,
  client_supplied_mint: !mintKeypair,
  // If split === false, use tx_base64; if split === true, use create_tx_base64 + buy_tx_base64
  tx_base64: responseTxs.tx_base64,
  create_tx_base64: responseTxs.create_tx_base64,
  buy_tx_base64: responseTxs.buy_tx_base64,
  split: responseTxs.split,
  route: 'v2',
  network: body.network,
  buyback_bps: body.buyback_bps,
  expires_at: expiresAt.toISOString(),
  quote_mint: body.quote_mint,
  instructions: responseTxs.split
    ? 'v2 split flow: sign and send create_tx_base64 (mint keypair + user wallet), wait for confirmation, then sign and send buy_tx_base64 (user wallet only).'
    : 'v2 combined flow: decode tx_base64, sign with mint keypair (if provided) + user wallet, then POST to launch-confirm.',
});
```

### Step 5 — Update `handleLaunchConfirm`

`handleLaunchConfirm` currently expects a single `tx_signature`. Update the schema to accept an optional `buy_tx_signature` for the split flow:

```js
const launchConfirmSchema = z.object({
  prep_id: z.string().min(8),
  tx_signature: z.string().min(80).max(100),          // create tx (or combined)
  buy_tx_signature: z.string().min(80).max(100).optional(), // buy tx (split flow only)
});
```

The confirm handler must:
1. Verify `tx_signature` (the create tx) is confirmed on-chain
2. If `buy_tx_signature` is provided, also verify it
3. Check that the mint address appears in the create tx's account keys
4. Proceed with DB insert as before

### Step 6 — Simulation check

Before returning the response from `handleLaunchPrep`, run a simulation on the create transaction to catch instruction errors early:

```js
try {
  const simConn = getConnection(body.network);
  // Use simulateTransaction with the VersionedTransaction built from create_tx_base64 or tx_base64
  const txBytes = Buffer.from(responseTxs.create_tx_base64 ?? responseTxs.tx_base64, 'base64');
  const { VersionedTransaction } = await import('@solana/web3.js');
  const simTx = VersionedTransaction.deserialize(txBytes);
  const simResult = await simConn.simulateTransaction(simTx, { sigVerify: false });
  if (simResult.value.err) {
    console.error('[launch-prep] simulation error:', simResult.value.err, simResult.value.logs);
    // Do NOT fail the request — simulation may fail due to missing signers; log and continue
  }
} catch (simErr) {
  console.warn('[launch-prep] simulation threw:', simErr.message);
}
```

## Checklist

- [ ] Read the entire `[action].js` file before making any changes
- [ ] Identify all existing imports and helpers to reuse
- [ ] Update `launchPrepSchema` with `quote_mint` field
- [ ] Replace the instruction-building block in `handleLaunchPrep`
- [ ] Implement `buildAndMeasureTx` size-check logic
- [ ] Update the JSON response shape
- [ ] Update `launchConfirmSchema` and `handleLaunchConfirm` for split flow
- [ ] Add simulation logging
- [ ] Manually test with a dry-run: call `handleLaunchPrep` with a test body and log the response size + route
- [ ] Ensure backward compatibility: if `sol_buy_in === 0`, still returns a valid single tx

## Do not

- Do not change the database schema or SQL queries
- Do not modify any other handlers in `[action].js`
- Do not change the rate limiting or auth logic
- Do not send any actual on-chain transactions during implementation (simulation only)
- Do not rename existing exports from the file
