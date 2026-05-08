# Task 16 — Build pumpfunCreateCoin and pumpfunSetupPayments chat tools

You are a senior JavaScript engineer. Complete this task end-to-end in a single session — working browser-side chat tools that call real APIs, no mocks, production-quality code.

## Goal

Add two new tools to `/workspaces/three.ws/chat/src/tools.js`:
1. `pumpfunCreateCoin` — uploads metadata, calls launch-prep v2, signs and sends create + buy txs
2. `pumpfunSetupPayments` — registers the coin with agent payments on-chain

Both tools must live inside `pumpTradingToolSchema` and follow the existing prep → sign → confirm pattern established by `pumpfunBuy`.

## Files to read first

1. `/workspaces/three.ws/chat/src/tools.js` — read in full, especially:
   - The `_pumpTx` helper function
   - The `pumpTradingToolSchema` export (line ~1465)
   - The existing `LaunchPumpToken` tool body (line ~381) for the signing pattern
   - The `agentPaymentsToolSchema` tools for the payments flow pattern
2. `/workspaces/three.ws/api/pump/[action].js` — read `handleLaunchPrep` (after your Task 14 update) to understand the v2 response shape
3. `/workspaces/agent-payments-sdk/agent-prompts/create-coin-v2/14-launch-prep-v2.md` — the v2 response shape

## Tool 1: `pumpfunCreateCoin`

### Arguments

```js
arguments: [
  { name: 'name', type: 'string', description: 'Token name (1-32 chars)' },
  { name: 'symbol', type: 'string', description: 'Token symbol (2-10 chars)' },
  { name: 'description', type: 'string', description: 'Coin description (max 500 chars)' },
  { name: 'imageUrl', type: 'string', description: 'Optional image URL for the coin' },
  { name: 'twitter', type: 'string', description: 'Optional Twitter/X URL' },
  { name: 'website', type: 'string', description: 'Optional website URL' },
  { name: 'initialBuySol', type: 'number', description: 'Initial creator buy in SOL (default 0.001)' },
  { name: 'slippageBps', type: 'number', description: 'Slippage in bps (default 500)' },
  { name: 'agentId', type: 'string', description: 'Agent identity UUID to bind this coin to' },
]
```

### Body (client-side JavaScript executed in browser)

```js
// 1. Ensure Solana wallet connected
const wallet = window.phantom?.solana || window.solana || window.backpack?.solana || window.solflare;
if (!wallet) throw new Error('No Solana wallet found. Install Phantom to continue.');
if (!wallet.isConnected) await wallet.connect();
const pubkey = wallet.publicKey.toBase58();

// 2. Validate inputs
const name = String(args.name || '').trim();
const symbol = String(args.symbol || '').trim();
const description = String(args.description || '').trim();
const agentId = String(args.agentId || '').trim();
if (!name) throw new Error('name required');
if (!symbol) throw new Error('symbol required');
if (!description) throw new Error('description required');
if (!agentId) throw new Error('agentId required — create an agent identity first');

const initialBuySol = Number(args.initialBuySol ?? 0.001);
const slippageBps = Number(args.slippageBps ?? 500);

// 3. Upload metadata to pump.fun IPFS
const metaRes = await fetch('/api/pump/upload-metadata', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  credentials: 'include',
  body: JSON.stringify({
    name, symbol, description,
    imageUrl: args.imageUrl || undefined,
    twitter: args.twitter || undefined,
    website: args.website || undefined,
  }),
});
if (!metaRes.ok) throw new Error('Metadata upload failed: ' + await metaRes.text());
const { metadataUri } = await metaRes.json();
if (!metadataUri) throw new Error('No metadataUri returned from upload');

// 4. Call launch-prep v2
const prepRes = await fetch('/api/pump/launch-prep', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  credentials: 'include',
  body: JSON.stringify({
    agent_id: agentId,
    wallet_address: pubkey,
    name,
    symbol,
    uri: metadataUri,
    network: 'mainnet',
    sol_buy_in: initialBuySol,
    slippage_bps: slippageBps,
  }),
});
if (!prepRes.ok) throw new Error('launch-prep failed: ' + prepRes.status + ' ' + await prepRes.text());
const prep = await prepRes.json();
const { prep_id, mint, mint_secret_key_b64, split, tx_base64, create_tx_base64, buy_tx_base64 } = prep;
if (!prep_id || !mint) throw new Error('launch-prep returned incomplete data');

// 5. Import web3.js
const web3 = await import('https://esm.sh/@solana/web3.js@1');
const { VersionedTransaction, Keypair, Connection } = web3;

// Helper: deserialize and optionally co-sign with mint keypair
function deserializeAndCoSign(base64, mintKp) {
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  let tx;
  try { tx = VersionedTransaction.deserialize(bytes); }
  catch { tx = web3.Transaction.from(bytes); }
  if (mintKp) tx.sign([mintKp]);
  return tx;
}

// Helper: sign with user wallet and send
async function signAndSend(tx, conn) {
  const signed = await wallet.signTransaction(tx);
  const sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false, maxRetries: 3 });
  await conn.confirmTransaction(sig, 'confirmed');
  return sig;
}

const mintKp = mint_secret_key_b64
  ? Keypair.fromSecretKey(Uint8Array.from(atob(mint_secret_key_b64), c => c.charCodeAt(0)))
  : null;

const conn = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');

let createSig, buySig;

if (split) {
  // Split flow: send create tx first, then buy tx
  if (!create_tx_base64) throw new Error('Expected create_tx_base64 in split response');
  const createTx = deserializeAndCoSign(create_tx_base64, mintKp);
  createSig = await signAndSend(createTx, conn);

  if (buy_tx_base64) {
    // Brief wait to ensure create is confirmed before buy
    await new Promise(r => setTimeout(r, 2000));
    const buyTx = deserializeAndCoSign(buy_tx_base64, null); // mint co-sign not needed for buy
    buySig = await signAndSend(buyTx, conn);
  }
} else {
  // Combined tx
  if (!tx_base64) throw new Error('Expected tx_base64 in combined response');
  const tx = deserializeAndCoSign(tx_base64, mintKp);
  createSig = await signAndSend(tx, conn);
  buySig = createSig;
}

// 6. Confirm with server
const confirmRes = await fetch('/api/pump/launch-confirm', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  credentials: 'include',
  body: JSON.stringify({
    prep_id,
    tx_signature: createSig,
    buy_tx_signature: buySig !== createSig ? buySig : undefined,
  }),
});
if (!confirmRes.ok) throw new Error('launch-confirm failed: ' + confirmRes.status + ' ' + await confirmRes.text());
const confirmed = await confirmRes.json();

return {
  mint,
  metadataUri,
  createSignature: createSig,
  buySignature: buySig || null,
  split,
  pumpUrl: 'https://pump.fun/coin/' + mint,
  message: `Coin created! Mint: ${mint}\nView on pump.fun: https://pump.fun/coin/${mint}`,
};
```

### Claude-facing function definition

```js
{
  type: 'function',
  function: {
    name: 'pumpfunCreateCoin',
    description: 'Create a new pump.fun v2 coin. Uploads metadata to IPFS, builds the create transaction, optionally includes an initial buy, signs with the user wallet, and confirms on-chain. Returns the mint address and pump.fun URL. After creating, use pumpfunSetupPayments to enable agent payment collection on this coin.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Token name (1-32 chars)' },
        symbol: { type: 'string', description: 'Token symbol (2-10 chars, uppercase recommended)' },
        description: { type: 'string', description: 'Coin description (max 500 chars)' },
        agentId: { type: 'string', description: 'UUID of the agent identity to bind this coin to' },
        imageUrl: { type: 'string', description: 'Optional image URL (PNG/JPG). If omitted, a placeholder is generated.' },
        twitter: { type: 'string', description: 'Optional Twitter/X profile URL' },
        website: { type: 'string', description: 'Optional website URL' },
        initialBuySol: { type: 'number', description: 'Initial creator buy in SOL (default 0.001, max 50)' },
        slippageBps: { type: 'integer', description: 'Slippage tolerance in bps (default 500 = 5%)' },
      },
      required: ['name', 'symbol', 'description', 'agentId'],
    },
  },
}
```

## Tool 2: `pumpfunSetupPayments`

This tool registers an already-created pump.fun coin with the agent payments program so it can receive and distribute payments.

### Arguments

```js
arguments: [
  { name: 'mint', type: 'string', description: 'The coin mint address returned by pumpfunCreateCoin' },
  { name: 'buybackBps', type: 'number', description: 'Buyback basis points 0-10000 (default 5000 = 50%)' },
]
```

### Body

```js
const wallet = window.phantom?.solana || window.solana || window.backpack?.solana || window.solflare;
if (!wallet) throw new Error('No Solana wallet found.');
if (!wallet.isConnected) await wallet.connect();
const pubkey = wallet.publicKey.toBase58();

const mint = String(args.mint || '').trim();
if (!mint) throw new Error('mint required');
const buybackBps = Number(args.buybackBps ?? 5000);
if (buybackBps < 0 || buybackBps > 10000) throw new Error('buybackBps must be 0-10000');

// 1. Prep: build the agent payments create tx
const prepRes = await fetch('/api/agents/payments/create-prep', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  credentials: 'include',
  body: JSON.stringify({ mint, wallet_address: pubkey, buyback_bps: buybackBps }),
});
if (!prepRes.ok) throw new Error('create-prep failed: ' + prepRes.status + ' ' + await prepRes.text());
const { prep_id, tx_base64 } = await prepRes.json();
if (!prep_id || !tx_base64) throw new Error('create-prep returned incomplete data');

// 2. Sign and send
const web3 = await import('https://esm.sh/@solana/web3.js@1');
const txBytes = Uint8Array.from(atob(tx_base64), c => c.charCodeAt(0));
let tx;
try { tx = web3.VersionedTransaction.deserialize(txBytes); }
catch { tx = web3.Transaction.from(txBytes); }
const signed = await wallet.signTransaction(tx);
const conn = new web3.Connection('https://api.mainnet-beta.solana.com', 'confirmed');
const sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false });
await conn.confirmTransaction(sig, 'confirmed');

// 3. Confirm with server
const confirmRes = await fetch('/api/agents/payments/create-confirm', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  credentials: 'include',
  body: JSON.stringify({ prep_id, tx_signature: sig }),
});
if (!confirmRes.ok) throw new Error('create-confirm failed: ' + confirmRes.status + ' ' + await confirmRes.text());
const confirmed = await confirmRes.json();

return {
  ...confirmed,
  mint,
  buybackBps,
  txSignature: sig,
  agentPaymentPda: confirmed.agent_payment_pda || confirmed.pda,
  configured: true,
  message: `Agent payments configured for ${mint}. Buyback: ${buybackBps} bps. Tx: ${sig}`,
};
```

### Claude-facing function definition

```js
{
  type: 'function',
  function: {
    name: 'pumpfunSetupPayments',
    description: 'Register a pump.fun coin with the agent payments program. Run this after pumpfunCreateCoin to enable payment collection, automatic buyback, and revenue withdrawal for the coin. Requires the coin mint address from the previous step.',
    parameters: {
      type: 'object',
      properties: {
        mint: { type: 'string', description: 'Coin mint address returned by pumpfunCreateCoin' },
        buybackBps: { type: 'integer', description: 'Percentage of payments used for token buybacks in basis points (default 5000 = 50%)' },
      },
      required: ['mint'],
    },
  },
}
```

## Where to insert the tools

Add both tools to `pumpTradingToolSchema.schema` array in `/workspaces/three.ws/chat/src/tools.js`. Place them after the last existing tool in the array (before the closing `]`).

The final export should look like:
```js
export const pumpTradingToolSchema = {
  name: 'Pump.fun Trading',
  schema: [
    // ... existing tools (Buy, Sell, Quote, SellAll, Portfolio) ...
    // NEW:
    { clientDefinition: { id: 'pump-create-coin-006', name: 'pumpfunCreateCoin', ... }, type: 'function', function: { ... } },
    { clientDefinition: { id: 'pump-setup-payments-007', name: 'pumpfunSetupPayments', ... }, type: 'function', function: { ... } },
  ],
};
```

## System prompt update

After adding the tools, verify the Claude system prompt (if there is one in the codebase) mentions that `pumpfunCreateCoin` and `pumpfunSetupPayments` work best as a two-step chain: create the coin first, then immediately set up payments.

## Checklist

- [ ] Read tools.js in full before editing
- [ ] Add `pumpfunCreateCoin` to `pumpTradingToolSchema.schema`
- [ ] Add `pumpfunSetupPayments` to `pumpTradingToolSchema.schema`
- [ ] Ensure tool bodies reference the correct API endpoints: `/api/pump/upload-metadata`, `/api/pump/launch-prep`, `/api/pump/launch-confirm`, `/api/agents/payments/create-prep`, `/api/agents/payments/create-confirm`
- [ ] Verify the split-tx flow handles the case where `buy_tx_base64` is null (create-only)
- [ ] Verify the tools use the correct wallet connection pattern (matches existing tools)
- [ ] Assign unique `id` strings: `'pump-create-coin-006'` and `'pump-setup-payments-007'`
- [ ] No duplicate tool names in the schema

## Do not

- Do not modify existing tool bodies in `pumpTradingToolSchema`
- Do not change the `agentPaymentsToolSchema`
- Do not add any server-side code in this task (that was Task 14 and 15)
- Do not use `window.ethereum` — these are Solana tools
