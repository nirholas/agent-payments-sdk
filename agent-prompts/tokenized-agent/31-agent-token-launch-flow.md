# Prompt 31 — Tokenized Agent Creation Flow

## Goal
Build the complete "Tokenize Agent" flow in three.ws: API endpoints to create a pump.fun v2 coin and register agent payments, plus the `TokenizeAgentModal.svelte` UI component wired into agent settings.

## Environment
- Working directory: `/workspaces/three.ws`
- Agent table: `agent_identities` in Neon Postgres
- DB: `/workspaces/three.ws/api/_lib/db.js` → `sql`
- Auth: `/workspaces/three.ws/api/_lib/auth.js` → `getSessionUser`, `authenticateBearer`, `extractBearer`
- HTTP helpers: `/workspaces/three.ws/api/_lib/http.js` → `json`, `error`, `readJson`, `wrap`, `cors`, `method`
- pump API lib: `/workspaces/three.ws/api/_lib/pump.js` → `getPumpSdkV2`, `getPumpAgentOffline`, `getConnection`, `buildUnsignedTxBase64`, `solanaPubkey`
- Existing agent endpoints: `/workspaces/three.ws/api/agents/[id]/` — read existing files there for patterns
- pump.fun launch prep: `/workspaces/three.ws/api/pump/[action].js` `handleLaunchPrep` — study this handler before building tokenize-prep
- Svelte chat app: `/workspaces/three.ws/chat/src/`
- AgentSettingsModal: `/workspaces/three.ws/chat/src/AgentSettingsModal.svelte`
- IPFS/metadata upload: look for existing IPFS upload in `/workspaces/three.ws/src/ipfs.js` or similar

## Read First
Before writing any code, read these files:
1. `/workspaces/three.ws/api/agents/REGISTER_FLOW.md` — understand the agent registration flow
2. `/workspaces/three.ws/api/agents/[id].js` — pattern for agent endpoint handlers
3. `/workspaces/three.ws/api/pump/[action].js` — find and read `handleLaunchPrep` to understand how unsigned launch txs are built
4. `/workspaces/three.ws/chat/src/AgentSettingsModal.svelte` — where to wire the new button
5. `/workspaces/three.ws/src/ipfs.js` or search for IPFS/metadata upload utilities

## Task 1 — POST /api/agents/[id]/tokenize

Create `/workspaces/three.ws/api/agents/[id]/tokenize.js`:

### Request
```json
POST /api/agents/{id}/tokenize
Authorization: Bearer ... | session cookie

Body: {
  "priceUsdc": 0.05,       // x402 price per message in USDC (default 0.05)
  "initialBuySol": 0.001,  // SOL to spend on initial buy (default 0)
  "buybackBps": 5000        // % of payments to buyback (default 5000 = 50%)
}
```

### Logic
1. Auth check — verify user owns the agent: `SELECT * FROM agent_identities WHERE id=$1 AND owner_id=$2`
2. Validate agent not already tokenized: `meta->>'token'` must be null/missing
3. Build the pump.fun v2 coin metadata:
   - name: `agent.name`
   - symbol: first 6 chars of agent name, uppercase, alphanumeric only
   - description: `agent.description || agent.bio || 'AI Agent on three.ws'`
   - image: use agent's avatar URL or a default image URL
4. Upload metadata to IPFS (use existing IPFS utility or pump.fun's metadata server):
   - Try `/workspaces/three.ws/src/ipfs.js` first
   - If no IPFS util: use pump.fun's IPFS upload endpoint `https://pump.fun/api/ipfs` with multipart form
   - Store the resulting `metadataUri`
5. Build unsigned `createCoin` tx using `getPumpSdkV2`:
   ```javascript
   const { PUMP_SDK, onlineSdk, bondingCurvePda, BN, web3 } = await getPumpSdkV2({ network: 'mainnet' });
   // Generate a new mint keypair (ephemeral, user will sign)
   const mintKeypair = web3.Keypair.generate();
   // Build create v2 instruction
   const createIx = await onlineSdk.createTokenInstructions({
     name, symbol, uri: metadataUri,
     creator: new web3.PublicKey(agent.solana_wallet || ownerWallet),
     mint: mintKeypair.publicKey,
     initialBuyAmount: new BN(Math.floor(initialBuySol * 1e9)),
   });
   ```
6. Build unsigned `registerPayments` tx using `getPumpAgentOffline`:
   ```javascript
   const { offline, web3: w } = await getPumpAgentOffline({ network: 'mainnet', mint: mintKeypair.publicKey.toBase58() });
   const registerIx = await offline.registerInstructions({
     payer: new w.PublicKey(ownerWallet),
     buybackBps: buybackBps,
   });
   ```
7. Serialize both txs to base64 using `buildUnsignedTxBase64`
8. Store pending state in `agent_identities.meta`:
   ```json
   { "tokenizePending": { "mintPubkey": "...", "createdAt": "...", "priceUsdc": 0.05, "buybackBps": 5000 } }
   ```
9. Return:
   ```json
   {
     "createCoinTx": "<base64>",
     "registerPaymentsTx": "<base64>",
     "mintPubkey": "<base58>",
     "symbol": "MYAGNT",
     "metadataUri": "ipfs://..."
   }
   ```

### Error Handling
- 400 if agent not found or not owned by user
- 400 if already tokenized
- 500 with message if IPFS upload fails (include fallback: skip IPFS and use a placeholder URI)

## Task 2 — POST /api/agents/[id]/tokenize-confirm

Create `/workspaces/three.ws/api/agents/[id]/tokenize-confirm.js`:

### Request
```json
POST /api/agents/{id}/tokenize-confirm
Body: {
  "createCoinSig": "5xKj...base58 tx signature",
  "registerPaymentsSig": "3nPq...base58 tx signature"
}
```

### Logic
1. Auth check — verify ownership
2. Read `meta.tokenizePending.mintPubkey` from agent row
3. Verify `createCoinSig` on-chain:
   ```javascript
   const { getConnection, verifySignature } = await import('../../../api/_lib/pump.js');
   const conn = getConnection({ network: 'mainnet' });
   // verifySignature throws if not confirmed or failed
   await verifySignature('mainnet', createCoinSig);
   await verifySignature('mainnet', registerPaymentsSig);
   ```
4. Update `agent_identities.meta` with confirmed state:
   ```javascript
   const updatedMeta = {
     ...agent.meta,
     token: {
       mint: mintPubkey,
       symbol: agent.meta.tokenizePending.symbol,
       pumpUrl: `https://pump.fun/coin/${mintPubkey}`,
       createSig: createCoinSig,
     },
     payments: {
       configured: true,
       registerSig: registerPaymentsSig,
       buybackBps: agent.meta.tokenizePending.buybackBps,
     },
     x402: {
       enabled: true,
       priceUsdc: agent.meta.tokenizePending.priceUsdc,
     },
     tokenizePending: null,  // clear pending state
   };
   await sql`UPDATE agent_identities SET meta=${JSON.stringify(updatedMeta)} WHERE id=${agentId}`;
   ```
5. Return:
   ```json
   {
     "success": true,
     "mint": "...",
     "pumpUrl": "https://pump.fun/coin/...",
     "x402Enabled": true,
     "priceUsdc": 0.05
   }
   ```

## Task 3 — TokenizeAgentModal.svelte

Create `/workspaces/three.ws/chat/src/TokenizeAgentModal.svelte`:

### Props
```svelte
<script>
  export let agentId;
  export let agentName;
  export let onClose = () => {};
  export let onSuccess = (result) => {};
</script>
```

### States
- `idle` — initial state, shows the "what will happen" preview
- `signing` — waiting for user to sign txs
- `confirming` — waiting for on-chain confirmation
- `success` — show pump.fun link
- `error` — show error message with retry

### UI Flow
```
┌─────────────────────────────────────┐
│  🪙 Tokenize {agentName}            │
├─────────────────────────────────────┤
│  This will:                         │
│  • Create {SYMBOL} token on pump.fun│
│  • Enable payments via x402         │
│  • Set up buyback automation        │
│                                     │
│  Price per message: [$0.05] USDC    │
│  Initial buy:       [$0.001] SOL    │
│  Buyback split:     [50]%           │
│                                     │
│  [Cancel]         [Tokenize →]      │
└─────────────────────────────────────┘
```

On "Tokenize →" click:
1. POST to `/api/agents/{agentId}/tokenize` with form values
2. Get back `{ createCoinTx, registerPaymentsTx, mintPubkey }`
3. Use the injected Solana wallet (`window.solana` or Phantom) to sign both txs:
   ```javascript
   // Deserialize and sign
   const { Transaction, VersionedTransaction } = await import('@solana/web3.js');
   // Detect if VersionedTransaction or legacy Transaction, sign accordingly
   const signed1 = await window.solana.signTransaction(deserialize(createCoinTx));
   const signed2 = await window.solana.signTransaction(deserialize(registerPaymentsTx));
   // Send both
   const sig1 = await connection.sendRawTransaction(signed1.serialize());
   const sig2 = await connection.sendRawTransaction(signed2.serialize());
   ```
4. POST to `/api/agents/{agentId}/tokenize-confirm` with both signatures
5. On success: show "✓ Token launched!" with a link to `https://pump.fun/coin/{mint}`

### Wallet Detection
```javascript
async function getWallet() {
  if (window.solana?.isPhantom) return window.solana;
  if (window.backpack) return window.backpack;
  throw new Error('No Solana wallet detected. Please install Phantom.');
}
```

Use the existing wallet connection approach from other Svelte components — read `WalletConnect.svelte` and `walletAuth.js` for the pattern.

### CSS
Follow existing modal styling — read `Modal.svelte` for the base modal pattern and extend it.

## Task 4 — Wire into AgentSettingsModal.svelte

Read `/workspaces/three.ws/chat/src/AgentSettingsModal.svelte` before editing.

Find where agent settings/actions are shown. Add:
1. A "Tokenize Agent" button (only visible if agent is not yet tokenized — check `agent.meta?.token?.mint`)
2. If tokenized: show "✓ Tokenized" badge with link to pump.fun and current x402 price
3. Clicking the button opens `TokenizeAgentModal` (use existing modal open pattern in the file)

```svelte
{#if !agent?.meta?.token?.mint}
  <button class="btn-secondary" on:click={openTokenizeModal}>
    🪙 Tokenize Agent
  </button>
{:else}
  <span class="badge-success">✓ Tokenized</span>
  <a href={agent.meta.token.pumpUrl} target="_blank" rel="noopener">View on pump.fun ↗</a>
{/if}
```

## File Checklist
- [ ] `/workspaces/three.ws/api/agents/[id]/tokenize.js`
- [ ] `/workspaces/three.ws/api/agents/[id]/tokenize-confirm.js`
- [ ] `/workspaces/three.ws/chat/src/TokenizeAgentModal.svelte`
- [ ] `/workspaces/three.ws/chat/src/AgentSettingsModal.svelte` — wired

## Verification
1. `ls /workspaces/three.ws/api/agents/[id]/tokenize*.js`
2. `node -e "import('./api/agents/[id]/tokenize.js').then(m => console.log(typeof m.default))"` from `/workspaces/three.ws`
3. `grep -n 'TokenizeAgentModal' /workspaces/three.ws/chat/src/AgentSettingsModal.svelte`
