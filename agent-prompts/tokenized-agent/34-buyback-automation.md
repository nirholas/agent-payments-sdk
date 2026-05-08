# Prompt 34 — Buyback Automation

## Goal
Build the buyback automation flow: a Jupiter v6 swap builder that gets swap instructions for USDC → agent token, a cron job that triggers buybacks for all eligible agents, and a manual trigger endpoint.

## Environment
- Working directory: `/workspaces/three.ws`
- DB: `/workspaces/three.ws/api/_lib/db.js` → `sql`
- HTTP helpers: `/workspaces/three.ws/api/_lib/http.js`
- Auth: `/workspaces/three.ws/api/_lib/auth.js`
- pump agent: `/workspaces/three.ws/api/_lib/pump.js` → `getPumpAgent`, `getPumpAgentOffline`, `getConnection`
- Existing cron pattern: see prompt 33 distribute cron for template
- USDC mint: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`
- Jupiter v6 API: `https://quote-api.jup.ag/v6`

## Read First
1. `/workspaces/three.ws/src/agent-skills-agent-payments.js` — find `agent-payments-buyback` skill to understand `PumpAgentOffline.buybackTrigger` signature
2. `/workspaces/three.ws/api/cron/distribute-agent-payments.js` (from prompt 33) — follow same pattern
3. `/workspaces/three.ws/api/_lib/pump.js` — understand `getPumpAgentOffline` return value

## Task 1 — Buyback Swap Builder

Create `/workspaces/three.ws/src/pump/buyback-builder.js`:

```javascript
// @ts-check
/**
 * buildBuybackSwapData — Get Jupiter v6 swap instructions for USDC → agent token buyback.
 *
 * This is the data needed by PumpAgentOffline.buybackTrigger:
 *   - swapInstructionData: the serialized swap instruction bytes from Jupiter
 *   - remainingAccounts: the accounts Jupiter needs for the swap
 *
 * Jupiter v6 API flow:
 *   1. POST /quote — get quote for currencyMint → mint swap
 *   2. POST /swap-instructions — get the actual instruction data
 */

const JUPITER_QUOTE_API = 'https://quote-api.jup.ag/v6';

/**
 * @param {object} opts
 * @param {string} opts.mint           — agent token mint (output token)
 * @param {string} opts.currencyMint   — USDC (input token)
 * @param {number|bigint} opts.amount  — input amount in raw atoms (USDC atoms = amount * 1e6)
 * @param {number} [opts.slippageBps]  — default 300 (3%)
 * @param {string} opts.payerPublicKey — public key of the fee payer / authority
 * @param {import('@solana/web3.js').Connection} opts.connection
 * @returns {Promise<{ swapInstructionData: Buffer, remainingAccounts: AccountMeta[], quote: object }>}
 */
export async function buildBuybackSwapData({ mint, currencyMint, amount, slippageBps = 300, payerPublicKey, connection }) {
  // Step 1: Get quote from Jupiter
  const quoteParams = new URLSearchParams({
    inputMint: currencyMint,
    outputMint: mint,
    amount: String(amount),
    slippageBps: String(slippageBps),
    onlyDirectRoutes: 'false',
    asLegacyTransaction: 'false',
  });
  
  const quoteResp = await fetch(`${JUPITER_QUOTE_API}/quote?${quoteParams}`);
  if (!quoteResp.ok) {
    const body = await quoteResp.text();
    throw new Error(`Jupiter quote failed (${quoteResp.status}): ${body}`);
  }
  const quote = await quoteResp.json();

  // Step 2: Get swap instructions from Jupiter
  const swapInstrResp = await fetch(`${JUPITER_QUOTE_API}/swap-instructions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: payerPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    }),
  });
  if (!swapInstrResp.ok) {
    const body = await swapInstrResp.text();
    throw new Error(`Jupiter swap-instructions failed (${swapInstrResp.status}): ${body}`);
  }
  const swapData = await swapInstrResp.json();

  // Extract the swap instruction data
  // swapData.swapInstruction: { programId, accounts: [...], data: base64 }
  const swapInstr = swapData.swapInstruction;
  if (!swapInstr) throw new Error('Jupiter returned no swapInstruction');
  
  const swapInstructionData = Buffer.from(swapInstr.data, 'base64');
  
  // Map accounts to AccountMeta format expected by Anchor/Solana
  const { PublicKey } = await import('@solana/web3.js');
  const remainingAccounts = swapInstr.accounts.map(acc => ({
    pubkey: new PublicKey(acc.pubkey),
    isSigner: acc.isSigner,
    isWritable: acc.isWritable,
  }));

  return { swapInstructionData, remainingAccounts, quote };
}
```

### Error Cases to Handle
- Jupiter 429 rate limit: retry once after 2 seconds
- Jupiter returns no routes: throw `Error('No Jupiter route found for ${currencyMint} → ${mint}')`
- Amount too small (< 100 USDC atoms): throw `Error('Amount too small for buyback')`

## Task 2 — Buyback Cron

Create `/workspaces/three.ws/api/cron/trigger-buybacks.js`:

```javascript
// Buyback cron: runs every hour (or on-demand)
// Triggers USDC buybacks for all agents with sufficient buyback vault balance.
//
// AUTHORITY SETUP (required before this cron works):
//   The hot wallet (DISTRIBUTION_WALLET_PRIVATE_KEY) must be set as the global
//   buyback authority in the AgentPayments program. This is a one-time setup:
//   1. Deploy/configure the AgentPayments program with `globalBuybackAuthority = hotWalletPubkey`
//   2. OR: call `PumpAgentOffline.setGlobalBuybackAuthority(hotWalletPubkey)` once at deployment
//   3. The authority wallet signs buybackTrigger instructions
//   4. It ONLY needs SOL for fees — USDC flows from buyback vault directly
//
// Rate: max 10 agents per run, 1 per second delay

import { sql } from '../_lib/db.js';
import { json, error, cors } from '../_lib/http.js';
import { getPumpAgent, getPumpAgentOffline, getConnection } from '../_lib/pump.js';
import { buildBuybackSwapData } from '../../src/pump/buyback-builder.js';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MIN_BUYBACK_USDC = 1.0;      // 1 USDC minimum buyback
const MAX_AGENTS_PER_RUN = 10;
const BUYBACK_SLIPPAGE_BPS = 300;  // 3% slippage

export default async function handler(req, res) {
  cors(req, res);

  const cronSecret = req.headers['x-cron-secret'] || req.headers['authorization'];
  if (process.env.CRON_SECRET && cronSecret !== `Bearer ${process.env.CRON_SECRET}`) {
    return error(res, 401, 'unauthorized', 'Invalid cron secret');
  }

  const results = { triggered: 0, skipped: 0, failed: 0, agents: [] };

  // Load hot wallet
  let hotWallet;
  try {
    hotWallet = await loadHotWallet();
  } catch (err) {
    return error(res, 500, 'wallet_error', `Hot wallet not configured: ${err.message}`);
  }

  // Query all tokenized agents with payments.configured
  const agents = await sql`
    SELECT id, meta
    FROM agent_identities
    WHERE (meta->'payments'->>'configured')::boolean = true
      AND meta->'token'->>'mint' IS NOT NULL
    ORDER BY id
    LIMIT ${MAX_AGENTS_PER_RUN}
  `;

  for (const agent of agents) {
    const mint = agent.meta?.token?.mint;
    if (!mint) continue;

    await sleep(1000);

    try {
      // Check buyback vault balance
      const { agent: pumpAgent } = await getPumpAgent({ network: 'mainnet', mint });
      const balances = await pumpAgent.getBalances(USDC_MINT);
      const buybackBalance = Number(balances.buybackVault?.balance || 0) / 1e6;

      if (buybackBalance < MIN_BUYBACK_USDC) {
        results.skipped++;
        results.agents.push({ agentId: agent.id, mint, status: 'skipped', balance: buybackBalance });
        continue;
      }

      // Build Jupiter swap data
      const connection = getConnection({ network: 'mainnet' });
      const amountAtoms = BigInt(Math.floor(buybackBalance * 1e6));
      
      const { swapInstructionData, remainingAccounts, quote } = await buildBuybackSwapData({
        mint,
        currencyMint: USDC_MINT,
        amount: amountAtoms,
        slippageBps: BUYBACK_SLIPPAGE_BPS,
        payerPublicKey: hotWallet.publicKey.toBase58(),
        connection,
      });

      // Build buybackTrigger instruction
      const { offline } = await getPumpAgentOffline({ network: 'mainnet', mint });
      const buybackIxs = await offline.buybackTriggerInstructions({
        payer: hotWallet.publicKey,
        currencyMint: USDC_MINT,
        swapInstructionData,
        remainingAccounts,
      });

      // Send tx
      const sig = await buildAndSendTx({ connection, wallet: hotWallet, instructions: buybackIxs });

      // Record in DB
      await sql`
        INSERT INTO distribution_runs (agent_id, mint, amount_usdc, tx_signature, status, confirmed_at)
        VALUES (${agent.id}, ${mint}, ${buybackBalance}, ${sig}, 'success', now())
      `;

      results.triggered++;
      results.agents.push({
        agentId: agent.id, mint, status: 'success', sig, amount: buybackBalance,
        expectedTokensOut: quote.outAmount,
      });

    } catch (err) {
      console.error(`[buyback] Agent ${agent.id} failed:`, err.message);
      await sql`
        INSERT INTO distribution_runs (agent_id, mint, amount_usdc, status, error_message)
        VALUES (${agent.id}, ${mint}, 0, 'failed', ${err.message})
      `.catch(() => {});
      results.failed++;
      results.agents.push({ agentId: agent.id, mint, status: 'failed', error: err.message });
    }
  }

  return json(res, 200, { ...results, ranAt: new Date().toISOString() });
}
```

Add `loadHotWallet()`, `buildAndSendTx()`, and `sleep()` helpers — same implementation as in prompt 33's cron file. To avoid duplication, create a shared utility at `/workspaces/three.ws/api/_lib/cron-wallet.js` and import from both crons.

## Task 3 — Shared Cron Wallet Utility

Create `/workspaces/three.ws/api/_lib/cron-wallet.js`:

```javascript
// Shared hot wallet utilities for cron jobs.
// The hot wallet is a fee-paying Keypair only — never holds tokens.

import { Keypair, TransactionMessage, VersionedTransaction } from '@solana/web3.js';

export async function loadHotWallet() {
  const privateKeyBase58 = process.env.DISTRIBUTION_WALLET_PRIVATE_KEY;
  if (!privateKeyBase58) {
    throw new Error(
      'DISTRIBUTION_WALLET_PRIVATE_KEY not set. ' +
      'Generate with: solana-keygen new --outfile /tmp/hot.json'
    );
  }
  const bs58 = await import('bs58');
  const secretKey = bs58.default.decode(privateKeyBase58);
  return Keypair.fromSecretKey(secretKey);
}

export async function buildAndSendTx({ connection, wallet, instructions, commitment = 'confirmed' }) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(commitment);
  const msg = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([wallet]);
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, commitment);
  return sig;
}

export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
```

Update `distribute-agent-payments.js` to import from this shared file.

## Task 4 — Manual Trigger Endpoint

Create `/workspaces/three.ws/api/agents/[id]/trigger-buyback.js`:

```javascript
// POST /api/agents/{id}/trigger-buyback
// Owner-only manual buyback trigger for a single agent.

export default wrap(async (req, res) => {
  // ... same auth/agent lookup pattern as trigger-distribute.js
  // Inline the per-agent buyback logic for immediate response
  // Return: { triggered: true, sig, amount, expectedTokensOut }
});
```

## Task 5 — Add Cron to vercel.json

Add to the `crons` array in `/workspaces/three.ws/vercel.json`:
```json
{ "path": "/api/cron/trigger-buybacks", "schedule": "30 * * * *" }
```
(offset 30 minutes from the distribute cron to avoid double load)

## File Checklist
- [ ] `/workspaces/three.ws/src/pump/buyback-builder.js`
- [ ] `/workspaces/three.ws/api/cron/trigger-buybacks.js`
- [ ] `/workspaces/three.ws/api/_lib/cron-wallet.js`
- [ ] `/workspaces/three.ws/api/agents/[id]/trigger-buyback.js`
- [ ] `/workspaces/three.ws/vercel.json` — cron entry added
- [ ] `/workspaces/three.ws/api/cron/distribute-agent-payments.js` — updated to import from cron-wallet.js

## Verification
1. `node -e "import('./src/pump/buyback-builder.js').then(m => console.log(typeof m.buildBuybackSwapData))"` from `/workspaces/three.ws`
2. `grep -n 'trigger-buybacks' /workspaces/three.ws/vercel.json`
3. `grep -n 'cron-wallet' /workspaces/three.ws/api/cron/trigger-buybacks.js`
