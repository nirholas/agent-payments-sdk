# Task: Implement x402 payment-required middleware for three.ws chat API

## Context

- three.ws repo: `/workspaces/three.ws`
- Chat API: `/workspaces/three.ws/api/chat.js` (382 lines, Vercel Node handler)
- Existing x402 infrastructure:
  - `/workspaces/three.ws/api/_lib/x402.js` — "agent-skill" flavor (old pump.fun invoice flow)
  - `/workspaces/three.ws/api/_lib/x402-spec.js` — "standard x402 spec" flavor (coinbase/x402 wire protocol, used by MCP)
  - `/workspaces/three.ws/api/x402-status.js` — health endpoint for x402 wiring
- SDK at `/workspaces/agent-payments-sdk/src/solana/x402/` for reference
- USDC mint (mainnet): `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`
- DB: Neon Postgres via `/workspaces/three.ws/api/_lib/db.js` (tagged template `sql`)

The three.ws x402 stack follows the **coinbase/x402 v1 wire protocol** (as seen in `x402-spec.js`): standard `x402Version`, `accepts` array, `X-PAYMENT` request header containing base64 JSON, and a facilitator service for verify+settle.

---

## Step 1: Read all relevant files

Read every file before writing anything:

```
/workspaces/three.ws/api/chat.js
/workspaces/three.ws/api/_lib/x402-spec.js
/workspaces/three.ws/api/_lib/x402.js
/workspaces/three.ws/api/_lib/db.js
/workspaces/three.ws/api/_lib/http.js
/workspaces/three.ws/api/_lib/auth.js
/workspaces/three.ws/api/_lib/env.js
/workspaces/three.ws/api/agents.js
/workspaces/agent-payments-sdk/src/solana/x402/types.ts
/workspaces/agent-payments-sdk/src/solana/x402/headers.ts
/workspaces/agent-payments-sdk/src/solana/x402/facilitator.ts
/workspaces/three.ws/api/_lib/migrations/2026-04-30-agent-monetization.sql
```

Also find the agent_identities table schema:
```bash
grep -r 'create table.*agent_identities' /workspaces/three.ws/api/_lib/migrations/ | head -3
grep -A 20 'create table if not exists agent_identities' /workspaces/three.ws/api/_lib/migrations/*.sql | head -40
```

---

## Step 2: Create the x402 middleware

Create `/workspaces/three.ws/api/_lib/x402-middleware.js`.

This module sits between existing x402 code. It wraps the **per-agent** x402 flow for chat messages specifically — the per-agent payment PDA is derived from the agent's Solana wallet/mint address, and pricing is stored in `agent.meta.x402`.

**Full implementation:**

```js
// x402-middleware.js — per-agent payment gating for chat messages.
//
// Wire format: coinbase/x402 v1 spec (same as x402-spec.js).
// This module handles the chat-specific flow where each agent has its
// own price and payTo address (their payment PDA on Solana).
//
// Usage:
//   const result = await checkX402Payment(req, res, agent);
//   if (result === false) return;  // 402 was sent, stop handler
//   // proceed with chat

import { sql } from './db.js';
import { json } from './http.js';
import { env } from './env.js';

const X402_VERSION = 1;
const USDC_MINT_MAINNET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_MINT_DEVNET  = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const USDC_DECIMALS     = 6;
const MAX_TIMEOUT_SEC   = 300;

/**
 * Get x402 pricing config from agent.meta.x402.
 * Returns null if the agent has not enabled x402 payments.
 *
 * @param {object} agent  Agent row with meta column
 * @returns {{ enabled: boolean, priceUsdc: number, freeMessages: number, description: string, payTo: string } | null}
 */
export function getAgentX402Config(agent) {
  const cfg = agent?.meta?.x402;
  if (!cfg?.enabled) return null;
  if (!cfg.payTo) return null;
  return {
    enabled: true,
    priceUsdc: Number(cfg.priceUsdc) || 0.10,
    freeMessages: Number(cfg.freeMessages) ?? 5,
    description: cfg.description || `Chat with ${agent.name}`,
    payTo: cfg.payTo,
  };
}

/**
 * Convert USDC amount (e.g. 0.10) to minor units string (e.g. "100000").
 */
export function usdcToMinorUnits(usdcAmount) {
  return String(Math.round(usdcAmount * Math.pow(10, USDC_DECIMALS)));
}

/**
 * Build the x402 PaymentRequirements array for a given agent.
 *
 * @param {{ agent: object, resourceUrl: string }} opts
 * @returns {Array<object>} accepts array for the 402 body
 */
export function buildPaymentRequirements({ agent, resourceUrl }) {
  const cfg = getAgentX402Config(agent);
  if (!cfg) throw new Error('agent has no x402 config');

  const isDevnet = env.SOLANA_CLUSTER === 'devnet';
  const asset = isDevnet ? USDC_MINT_DEVNET : USDC_MINT_MAINNET;
  const network = isDevnet ? 'solana-devnet' : 'solana-mainnet';
  const maxAmountRequired = usdcToMinorUnits(cfg.priceUsdc);

  return [
    {
      scheme: 'exact',
      network,
      maxAmountRequired,
      resource: resourceUrl,
      description: cfg.description,
      mimeType: 'application/json',
      payTo: cfg.payTo,
      maxTimeoutSeconds: MAX_TIMEOUT_SEC,
      asset,
      extra: {
        name: 'USDC',
        decimals: USDC_DECIMALS,
      },
    },
  ];
}

/**
 * Emit a 402 Payment Required response.
 *
 * @param {import('http').ServerResponse} res
 * @param {object} agent
 * @param {string} resourceUrl
 */
export function send402ForAgent(res, agent, resourceUrl) {
  const accepts = buildPaymentRequirements({ agent, resourceUrl });
  res.statusCode = 402;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(
    JSON.stringify({
      x402Version: X402_VERSION,
      error: 'payment required',
      accepts,
    }),
  );
}

/**
 * Verify an X-PAYMENT header for a specific agent and amount.
 *
 * Delegates to the configured external facilitator (same as x402-spec.js).
 * Records the payment in x402_payments if valid.
 *
 * @param {{ paymentHeader: string, agent: object, resourceUrl: string, userId: string, messagePreview: string }} opts
 * @returns {Promise<{ valid: boolean, payer?: string, error?: string }>}
 */
export async function verifyAgentPayment({ paymentHeader, agent, resourceUrl, userId, messagePreview = '' }) {
  if (!paymentHeader) return { valid: false, error: 'missing X-PAYMENT header' };

  const requirements = buildPaymentRequirements({ agent, resourceUrl });
  const primaryReq = requirements[0];

  // Decode header
  let paymentPayload;
  try {
    const decoded = Buffer.from(String(paymentHeader), 'base64').toString('utf8');
    paymentPayload = JSON.parse(decoded);
  } catch (err) {
    return { valid: false, error: `invalid X-PAYMENT encoding: ${err.message}` };
  }

  // Idempotency: check if this tx was already used
  const txSig = paymentPayload?.payload?.signature || paymentPayload?.payload?.txSignature;
  if (txSig) {
    const [existing] = await sql`
      select id from x402_payments where tx_signature = ${String(txSig)} limit 1
    `;
    if (existing) {
      return { valid: false, error: 'payment already used (replay attack prevented)' };
    }
  }

  // Verify with facilitator
  const facilitatorUrl = env.X402_FACILITATOR_URL_SOLANA;
  if (!facilitatorUrl) {
    return { valid: false, error: 'no Solana x402 facilitator configured' };
  }

  let verifyResult;
  try {
    const resp = await fetch(`${facilitatorUrl}/verify`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(env.X402_FACILITATOR_TOKEN_SOLANA
          ? { authorization: `Bearer ${env.X402_FACILITATOR_TOKEN_SOLANA}` }
          : {}),
      },
      body: JSON.stringify({
        x402Version: X402_VERSION,
        paymentPayload,
        paymentRequirements: primaryReq,
      }),
    });
    verifyResult = await resp.json();
  } catch (err) {
    return { valid: false, error: `facilitator unreachable: ${err.message}` };
  }

  if (!verifyResult.isValid) {
    return { valid: false, error: verifyResult.invalidReason || 'payment invalid' };
  }

  // Record in x402_payments for idempotency + history
  if (txSig) {
    try {
      const cfg = getAgentX402Config(agent);
      await sql`
        insert into x402_payments (
          id, agent_id, payer_address, amount_usdc, tx_signature, message_preview, created_at
        ) values (
          ${`x402_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`},
          ${agent.id},
          ${verifyResult.payer || 'unknown'},
          ${cfg ? cfg.priceUsdc : 0},
          ${String(txSig)},
          ${String(messagePreview).slice(0, 200)},
          now()
        )
        on conflict (tx_signature) do nothing
      `;
    } catch (dbErr) {
      // Non-fatal: log but don't reject payment due to DB write failure
      console.error('[x402-middleware] failed to record payment:', dbErr);
    }
  }

  return { valid: true, payer: verifyResult.payer };
}

/**
 * Resolve the canonical resource URL from a Vercel request.
 */
export function resolveResourceUrl(req, path = '/api/chat') {
  const proto = (req.headers['x-forwarded-proto'] || 'https').toString().split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').toString();
  if (host) return `${proto}://${host}${path}`;
  return `${env.APP_ORIGIN}${path}`;
}

/**
 * Check if a user has used up their free messages with this agent.
 *
 * @param {string} agentId
 * @param {string} userId
 * @param {number} freeMessages
 * @returns {Promise<boolean>} true if payment is required
 */
export async function isPaymentRequired(agentId, userId, freeMessages) {
  if (freeMessages <= 0) return true;
  if (!userId) return true;

  const [row] = await sql`
    select message_count from x402_message_counts
    where agent_id = ${agentId} and user_id = ${userId}
    limit 1
  `;
  const count = row?.message_count ?? 0;
  return count >= freeMessages;
}

/**
 * Increment the free-message counter for a user with this agent.
 *
 * @param {string} agentId
 * @param {string} userId
 */
export async function recordFreeMessage(agentId, userId) {
  await sql`
    insert into x402_message_counts (agent_id, user_id, message_count, updated_at)
    values (${agentId}, ${userId}, 1, now())
    on conflict (agent_id, user_id)
    do update set
      message_count = x402_message_counts.message_count + 1,
      updated_at = now()
  `;
}

/**
 * Main middleware function. Call at the top of a paid handler.
 *
 * Returns true if the request has a valid payment (or is free).
 * Returns false if a 402 was sent and the handler should stop.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {object} agent   Full agent row with meta column
 * @param {string} userId  Authenticated user ID (null for anonymous)
 * @param {string} [messagePreview]  First 200 chars of message for receipt
 * @returns {Promise<boolean>}
 */
export async function checkX402Payment(req, res, agent, userId, messagePreview = '') {
  const cfg = getAgentX402Config(agent);
  if (!cfg) return true; // agent has not enabled x402, allow through

  const resourceUrl = resolveResourceUrl(req, '/api/chat');
  const paymentRequired = await isPaymentRequired(agent.id, userId, cfg.freeMessages);

  if (!paymentRequired) {
    // Still within free tier — record usage and continue
    if (userId) await recordFreeMessage(agent.id, userId).catch(() => {});
    return true;
  }

  const paymentHeader = req.headers['x-payment'] || req.headers['X-Payment'];
  if (!paymentHeader) {
    send402ForAgent(res, agent, resourceUrl);
    return false;
  }

  const result = await verifyAgentPayment({
    paymentHeader: String(paymentHeader),
    agent,
    resourceUrl,
    userId: userId || 'anonymous',
    messagePreview,
  });

  if (!result.valid) {
    res.statusCode = 402;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify({
      x402Version: X402_VERSION,
      error: result.error || 'payment invalid',
      accepts: buildPaymentRequirements({ agent, resourceUrl }),
    }));
    return false;
  }

  return true;
}
```

### Important implementation notes:

1. The `payTo` address in `agent.meta.x402.payTo` is the agent's payment PDA or wallet address. It must be set when the agent enables x402 (see prompt 07). For an agent with a Solana wallet (from `agent.wallet_address`), use that address as `payTo` unless a separate PDA is configured.

2. The module uses `x402_payments` and `x402_message_counts` tables (created in Step 3).

3. The `facilitatorUrl` comes from `env.X402_FACILITATOR_URL_SOLANA` — the same env var already used by `x402-spec.js`.

---

## Step 3: Create DB migrations

### Migration A: x402_payments table

Create `/workspaces/three.ws/api/_lib/migrations/2026-05-08-x402-payments.sql`:

```sql
-- Migration: x402 per-agent payment receipts for chat.
-- Records every verified x402 payment to an agent, used for:
--   1. Idempotency / replay attack prevention (tx_signature unique)
--   2. Payment history dashboard
--   3. Revenue accounting

begin;

create table if not exists x402_payments (
  id              text primary key,
  agent_id        uuid not null references agent_identities(id) on delete cascade,
  payer_address   text not null,
  amount_usdc     numeric(12, 6) not null,
  tx_signature    text not null,
  message_preview text,
  created_at      timestamptz not null default now()
);

create unique index if not exists x402_payments_tx_sig
  on x402_payments (tx_signature);

create index if not exists x402_payments_agent_created
  on x402_payments (agent_id, created_at desc);

create index if not exists x402_payments_payer_created
  on x402_payments (payer_address, created_at desc);

commit;
```

### Migration B: x402_message_counts table

Create `/workspaces/three.ws/api/_lib/migrations/2026-05-08-x402-message-counts.sql`:

```sql
-- Migration: per-user free message counters for x402-gated agents.
-- Tracks how many free messages each user has consumed for each agent.

begin;

create table if not exists x402_message_counts (
  agent_id      uuid not null references agent_identities(id) on delete cascade,
  user_id       uuid not null references users(id) on delete cascade,
  message_count int not null default 0,
  updated_at    timestamptz not null default now(),
  primary key (agent_id, user_id)
);

create index if not exists x402_message_counts_user
  on x402_message_counts (user_id, updated_at desc);

commit;
```

---

## Step 4: Wire middleware into chat.js

Read `/workspaces/three.ws/api/chat.js` fully. Find the main handler function (the `wrap(async (req, res) => { ... })` call).

The chat handler already:
1. Checks auth
2. Reads + validates body (including `agentId`)
3. Resolves the agent if `agentId` is provided
4. Calls Anthropic API

Insert the x402 check **after** the agent is loaded but **before** the Anthropic call.

Find where the agent is fetched:
```bash
grep -n 'agentId\|agent_id\|agent\.' /workspaces/three.ws/api/chat.js | head -30
```

Add the import at the top of `chat.js`:
```js
import { checkX402Payment } from './_lib/x402-middleware.js';
```

Then after the agent row is fetched (after the `SELECT` from `agent_identities`), add:

```js
// x402 payment gate — only runs if agent has x402 enabled
if (agent) {
  const paid = await checkX402Payment(req, res, agent, auth?.userId, body.message.slice(0, 200));
  if (!paid) return;
}
```

**Important:** Only add the check when `agent` is truthy (i.e. `agentId` was provided and the agent row was found). Anonymous/generic chat (no agentId) remains free.

---

## Step 5: Verify the middleware works

Check for JavaScript syntax errors:

```bash
node --check /workspaces/three.ws/api/_lib/x402-middleware.js && echo "OK"
node --check /workspaces/three.ws/api/chat.js && echo "OK"
```

---

## Success criteria

```
✔ /workspaces/three.ws/api/_lib/x402-middleware.js created with full implementation
✔ /workspaces/three.ws/api/_lib/migrations/2026-05-08-x402-payments.sql created
✔ /workspaces/three.ws/api/_lib/migrations/2026-05-08-x402-message-counts.sql created
✔ chat.js imports and calls checkX402Payment
✔ node --check passes on both files
✔ 402 is only sent when agent.meta.x402.enabled === true
✔ Replay attacks prevented via tx_signature unique constraint
```
