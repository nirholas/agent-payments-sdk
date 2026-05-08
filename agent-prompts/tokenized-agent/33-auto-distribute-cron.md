# Prompt 33 — Auto-Distribute Cron Job

## Goal
Build an auto-distribute cron job that automatically distributes accumulated USDC payments for all tokenized agents every hour, with DB tracking, a manual trigger endpoint, and proper hot-wallet fee management.

## Environment
- Working directory: `/workspaces/three.ws`
- DB: `/workspaces/three.ws/api/_lib/db.js` → `sql`
- Auth: `/workspaces/three.ws/api/_lib/auth.js`
- HTTP helpers: `/workspaces/three.ws/api/_lib/http.js`
- pump agent: `/workspaces/three.ws/api/_lib/pump.js` → `getPumpAgent`, `getPumpAgentOffline`, `getConnection`
- Existing cron: `/workspaces/three.ws/api/cron/[name].js` — read for pattern
- vercel.json: `/workspaces/three.ws/vercel.json` — must add cron config
- USDC mint: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`

## Read First
1. Read `/workspaces/three.ws/api/cron/[name].js` to understand cron handler patterns
2. Read `/workspaces/three.ws/src/agent-skills-agent-payments.js` — find `agent-payments-distribute` to understand the distribute flow
3. Read `/workspaces/three.ws/api/_lib/solana-wallet.js` — understand hot wallet loading pattern
4. Read `/workspaces/three.ws/vercel.json` — understand how to add crons

## Task 1 — DB Migration

Create `/workspaces/three.ws/migrations/distribution_runs.sql`:

```sql
-- Tracks each auto-distribution run per agent
create table if not exists distribution_runs (
  id              text primary key default gen_random_uuid()::text,
  agent_id        text not null,
  mint            text not null,
  amount_usdc     numeric(20, 6) not null,   -- USDC distributed (human-readable)
  tx_signature    text,
  status          text not null default 'pending'
                  check (status in ('pending', 'success', 'failed', 'skipped')),
  error_message   text,
  ran_at          timestamptz default now(),
  confirmed_at    timestamptz
);

create index if not exists distribution_runs_agent_idx
  on distribution_runs(agent_id, ran_at desc);

create index if not exists distribution_runs_ran_at_idx
  on distribution_runs(ran_at desc);
```

## Task 2 — Cron Handler

Create `/workspaces/three.ws/api/cron/distribute-agent-payments.js`:

```javascript
// Auto-distribute cron: runs every hour
// Distributes accumulated USDC from payment vault → buyback + withdraw vaults
// for all tokenized agents with balance > 1 USDC.
//
// Hot wallet: DISTRIBUTION_WALLET_PRIVATE_KEY (base58 Keypair)
//   - Only needs SOL for tx fees (~0.000005 SOL per tx)
//   - Keep ~0.01 SOL loaded at all times; set up a low-balance alert
//   - NEVER store USDC on the hot wallet — it only pays fees
//   - The wallet is pre-authorized as distributor in the AgentPayments program
//
// Called by: Vercel cron "0 * * * *" (every hour)
// Also callable manually via POST /api/agents/[id]/trigger-distribute

import { sql } from '../_lib/db.js';
import { json, error, cors } from '../_lib/http.js';
import { getPumpAgent, getPumpAgentOffline, getConnection } from '../_lib/pump.js';
import { loadWallet } from '../_lib/solana-wallet.js';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MIN_DISTRIBUTE_USDC = 1.0;  // 1 USDC minimum before distributing
const MAX_AGENTS_PER_RUN = 10;
const DELAY_BETWEEN_AGENTS_MS = 1000;
```

### Core Logic

```javascript
export default async function handler(req, res) {
  cors(req, res);

  // Verify cron invocation (Vercel sets this header, or allow from internal)
  const cronSecret = req.headers['x-cron-secret'] || req.headers['authorization'];
  if (process.env.CRON_SECRET && cronSecret !== `Bearer ${process.env.CRON_SECRET}`) {
    return error(res, 401, 'unauthorized', 'Invalid cron secret');
  }

  const results = { distributed: 0, skipped: 0, failed: 0, agents: [] };
  
  // 1. Load hot wallet (fee payer only)
  let hotWallet;
  try {
    hotWallet = await loadHotWallet();
  } catch (err) {
    return error(res, 500, 'wallet_error', `Hot wallet not configured: ${err.message}`);
  }

  // 2. Query all tokenized agents
  const agents = await sql`
    SELECT id, owner_id, meta
    FROM agent_identities
    WHERE (meta->>'payments')::jsonb->>'configured' = 'true'
      AND meta->'token'->>'mint' IS NOT NULL
    ORDER BY id
    LIMIT ${MAX_AGENTS_PER_RUN}
  `;

  // 3. Process each agent
  for (const agent of agents) {
    const mint = agent.meta?.token?.mint;
    if (!mint) continue;

    await sleep(DELAY_BETWEEN_AGENTS_MS);
    
    const runRecord = await sql`
      INSERT INTO distribution_runs (agent_id, mint, amount_usdc, status)
      VALUES (${agent.id}, ${mint}, 0, 'pending')
      RETURNING id
    `;
    const runId = runRecord[0].id;

    try {
      // Check payment vault balance
      const { agent: pumpAgent } = await getPumpAgent({ network: 'mainnet', mint });
      const balances = await pumpAgent.getBalances(USDC_MINT);
      const paymentBalance = Number(balances.paymentVault?.balance || 0) / 1e6;

      if (paymentBalance < MIN_DISTRIBUTE_USDC) {
        await sql`UPDATE distribution_runs SET status='skipped', error_message='balance below threshold' WHERE id=${runId}`;
        results.skipped++;
        results.agents.push({ agentId: agent.id, mint, status: 'skipped', balance: paymentBalance });
        continue;
      }

      // Build distribute tx
      const { offline } = await getPumpAgentOffline({ network: 'mainnet', mint });
      const connection = getConnection({ network: 'mainnet' });
      
      // distributePayments instruction: splits payment vault → buyback + withdraw
      const distributeIxs = await offline.distributePaymentsInstructions({
        payer: hotWallet.publicKey,
        currencyMint: USDC_MINT,
      });

      // Build, sign, and send tx
      const sig = await buildAndSendTx({ connection, wallet: hotWallet, instructions: distributeIxs });

      await sql`
        UPDATE distribution_runs 
        SET status='success', tx_signature=${sig}, amount_usdc=${paymentBalance}, confirmed_at=now()
        WHERE id=${runId}
      `;
      results.distributed++;
      results.agents.push({ agentId: agent.id, mint, status: 'success', sig, amount: paymentBalance });

    } catch (err) {
      console.error(`[distribute] Agent ${agent.id} failed:`, err.message);
      await sql`UPDATE distribution_runs SET status='failed', error_message=${err.message} WHERE id=${runId}`;
      results.failed++;
      results.agents.push({ agentId: agent.id, mint, status: 'failed', error: err.message });
    }
  }

  return json(res, 200, { ...results, ranAt: new Date().toISOString() });
}
```

### Hot Wallet Loader
```javascript
async function loadHotWallet() {
  const privateKeyBase58 = process.env.DISTRIBUTION_WALLET_PRIVATE_KEY;
  if (!privateKeyBase58) throw new Error('DISTRIBUTION_WALLET_PRIVATE_KEY env var not set');
  
  // Use existing loadWallet utility if it accepts base58 keys
  // Otherwise: decode base58 → Keypair
  const { Keypair } = await import('@solana/web3.js');
  const bs58 = await import('bs58');
  const secretKey = bs58.default.decode(privateKeyBase58);
  return Keypair.fromSecretKey(secretKey);
}
```

Check `/workspaces/three.ws/api/_lib/solana-wallet.js` — if it has a function that loads a Keypair from an env var, use that instead.

### TX Builder
```javascript
async function buildAndSendTx({ connection, wallet, instructions }) {
  const { TransactionMessage, VersionedTransaction } = await import('@solana/web3.js');
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([wallet]);
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  return sig;
}
```

### Utility
```javascript
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
```

## Task 3 — Manual Trigger Endpoint

Create `/workspaces/three.ws/api/agents/[id]/trigger-distribute.js`:

```javascript
// POST /api/agents/{id}/trigger-distribute
// Owner-only: manually trigger distribution for a specific agent.
// Returns the distribution result immediately (synchronous).

export default wrap(async (req, res) => {
  cors(req, res);
  method(req, 'POST');

  const auth = await resolveAuth(req);
  if (!auth) return error(res, 401, 'unauthorized', 'Login required');

  const agentId = req.query?.id;
  const [agent] = await sql`
    SELECT * FROM agent_identities
    WHERE id = ${agentId} AND owner_id = ${auth.userId}
  `;
  if (!agent) return error(res, 404, 'not_found', 'Agent not found');

  const mint = agent.meta?.token?.mint;
  if (!mint) return error(res, 400, 'not_tokenized', 'Agent is not tokenized');

  // Delegate to the same logic as the cron job but for a single agent
  // Forward to the cron handler with the specific agent
  // ... (inline the same logic from the cron, but for only this one agent)
  
  return json(res, 200, { triggered: true, agentId, mint });
});
```

Extract the per-agent distribution logic into a shared function `distributeForAgent(agentId, mint)` that both the cron and the manual trigger call.

## Task 4 — Add Cron to vercel.json

Read `/workspaces/three.ws/vercel.json`. Find the `crons` array (or add it). Add:
```json
{
  "path": "/api/cron/distribute-agent-payments",
  "schedule": "0 * * * *"
}
```

## File Checklist
- [ ] `/workspaces/three.ws/migrations/distribution_runs.sql`
- [ ] `/workspaces/three.ws/api/cron/distribute-agent-payments.js`
- [ ] `/workspaces/three.ws/api/agents/[id]/trigger-distribute.js`
- [ ] `/workspaces/three.ws/vercel.json` — cron entry added

## Hot Wallet Setup Documentation (inline comments in the cron file)
Add a block comment at the top of `distribute-agent-payments.js`:
```javascript
/**
 * HOT WALLET SETUP:
 * 1. Generate: solana-keygen new --outfile /tmp/distributor.json
 * 2. Fund with ~0.01 SOL for fees: solana transfer <pubkey> 0.01
 * 3. Export base58: node -e "const k=require('./tmp/distributor.json'); const bs58=require('bs58'); console.log(bs58.encode(Buffer.from(k)))"
 * 4. Set env: DISTRIBUTION_WALLET_PRIVATE_KEY=<base58>
 * 5. Pre-authorize this wallet in AgentPayments program as distributor authority
 *    (one-time setup via agent-payments-register skill with distributor: hotWalletPubkey)
 * 6. Monitor SOL balance: set up alert if < 0.005 SOL
 * 7. Refill manually — the hot wallet ONLY holds SOL for fees, never USDC
 */
```

## Verification
1. `grep -n 'distribute-agent-payments' /workspaces/three.ws/vercel.json`
2. `node -e "import('./api/cron/distribute-agent-payments.js').then(m => console.log(typeof m.default))"` from `/workspaces/three.ws`
3. `ls /workspaces/three.ws/migrations/distribution_runs.sql`
