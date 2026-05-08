# Task: Add per-agent x402 pricing configuration to three.ws

## Context

- three.ws repo: `/workspaces/three.ws`
- Agent identities are stored in the `agent_identities` table with a `meta jsonb` column
- Agent API: `/workspaces/three.ws/api/agents.js` (handles GET/POST/PUT/DELETE /api/agents)
- The `meta` column already stores payment config at `meta.payments` (old pump.fun flow)
- Goal: add `meta.x402` sub-object for per-message pricing configuration

---

## Step 1: Read relevant files

```
/workspaces/three.ws/api/agents.js
/workspaces/three.ws/api/_lib/db.js
/workspaces/three.ws/api/_lib/http.js
/workspaces/three.ws/api/_lib/auth.js
/workspaces/three.ws/api/_lib/x402-middleware.js  (created in prompt 06)
```

Also find how the agents API handles PUT/PATCH:
```bash
grep -n 'PUT\|PATCH\|update\|meta' /workspaces/three.ws/api/agents.js | head -40
```

And check what columns `agent_identities` has:
```bash
grep -r 'create table.*agent_identities\|agent_identities' /workspaces/three.ws/api/_lib/migrations/*.sql | grep -v index | head -10
```

---

## Step 2: Define the x402 pricing schema

The `meta.x402` object stored in `agent_identities.meta`:

```json
{
  "x402": {
    "enabled": true,
    "priceUsdc": 0.10,
    "freeMessages": 5,
    "description": "Ask me anything about DeFi",
    "payTo": "<agent_solana_wallet_address_or_payment_pda>"
  }
}
```

Field constraints:
- `enabled`: boolean, default `false`
- `priceUsdc`: number, min 0.01, max 100.00, 2 decimal places
- `freeMessages`: integer, min 0, max 100, default 5
- `description`: string, max 100 chars, optional
- `payTo`: base58 Solana address, required when `enabled === true`

---

## Step 3: Create the x402-pricing library

Create `/workspaces/three.ws/api/_lib/x402-pricing.js`:

```js
// x402-pricing.js — per-agent x402 message pricing helpers.
//
// Pricing is stored in agent_identities.meta.x402 as a JSONB sub-object.
// Free message tracking is in x402_message_counts (created by migration in prompt 06).

import { sql } from './db.js';

const PRICE_MIN = 0.01;
const PRICE_MAX = 100.00;
const FREE_MSG_MIN = 0;
const FREE_MSG_MAX = 100;

/**
 * Parse and validate x402 pricing input from a client PUT/POST request.
 *
 * @param {object} input  Raw JSON body field
 * @returns {{ enabled: boolean, priceUsdc: number, freeMessages: number, description: string, payTo: string }}
 * @throws {Error} with .status and .code if validation fails
 */
export function validateX402PricingInput(input) {
  if (!input || typeof input !== 'object') {
    const err = new Error('x402 pricing must be an object');
    err.status = 400; err.code = 'invalid_x402_pricing';
    throw err;
  }

  const enabled = Boolean(input.enabled);

  const priceUsdc = Number(input.priceUsdc);
  if (!Number.isFinite(priceUsdc) || priceUsdc < PRICE_MIN || priceUsdc > PRICE_MAX) {
    const err = new Error(`priceUsdc must be between ${PRICE_MIN} and ${PRICE_MAX}`);
    err.status = 400; err.code = 'invalid_price';
    throw err;
  }

  const freeMessages = Math.round(Number(input.freeMessages ?? 5));
  if (!Number.isInteger(freeMessages) || freeMessages < FREE_MSG_MIN || freeMessages > FREE_MSG_MAX) {
    const err = new Error(`freeMessages must be an integer between ${FREE_MSG_MIN} and ${FREE_MSG_MAX}`);
    err.status = 400; err.code = 'invalid_free_messages';
    throw err;
  }

  const description = String(input.description || '').slice(0, 100);

  const payTo = String(input.payTo || '').trim();
  if (enabled && !payTo) {
    const err = new Error('payTo (Solana wallet address) is required when x402 is enabled');
    err.status = 400; err.code = 'missing_pay_to';
    throw err;
  }
  if (payTo && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(payTo)) {
    const err = new Error('payTo must be a valid base58 Solana address');
    err.status = 400; err.code = 'invalid_pay_to';
    throw err;
  }

  return { enabled, priceUsdc: Math.round(priceUsdc * 100) / 100, freeMessages, description, payTo };
}

/**
 * Get the x402 pricing config for an agent.
 *
 * @param {string} agentId
 * @returns {Promise<object|null>}
 */
export async function getAgentX402Pricing(agentId) {
  const [row] = await sql`
    select meta->'x402' as x402
    from agent_identities
    where id = ${agentId} and deleted_at is null
    limit 1
  `;
  if (!row) return null;
  return row.x402 || { enabled: false, priceUsdc: 0.10, freeMessages: 5, description: '', payTo: '' };
}

/**
 * Update the x402 pricing config for an agent (owner-only, caller must verify ownership).
 *
 * @param {string} agentId
 * @param {object} pricing  Validated pricing object from validateX402PricingInput()
 */
export async function setAgentX402Pricing(agentId, pricing) {
  await sql`
    update agent_identities
    set meta = jsonb_set(
      coalesce(meta, '{}'),
      '{x402}',
      ${JSON.stringify(pricing)}::jsonb,
      true
    ),
    updated_at = now()
    where id = ${agentId} and deleted_at is null
  `;
}

/**
 * Check if payment is required for a user+agent combination.
 * Returns true if the user has exhausted their free messages or if freeMessages is 0.
 *
 * @param {string} agentId
 * @param {string|null} userId
 * @param {number} freeMessages  From agent.meta.x402.freeMessages
 * @returns {Promise<boolean>}
 */
export async function shouldChargeForMessage(agentId, userId, freeMessages) {
  if (freeMessages <= 0) return true;
  if (!userId) return true;  // anonymous users always pay

  const [row] = await sql`
    select message_count from x402_message_counts
    where agent_id = ${agentId} and user_id = ${userId}
    limit 1
  `;
  const count = row?.message_count ?? 0;
  return count >= freeMessages;
}

/**
 * Increment the free-message counter (called when a free message is served).
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
 * Reset the free-message counter for a user+agent pair.
 * Used in tests or if the agent owner grants extra free messages.
 *
 * @param {string} agentId
 * @param {string} userId
 */
export async function resetFreeMessages(agentId, userId) {
  await sql`
    delete from x402_message_counts
    where agent_id = ${agentId} and user_id = ${userId}
  `;
}

/**
 * Get total earnings summary for an agent.
 *
 * @param {string} agentId
 * @returns {Promise<{ totalUsdc: number, paymentCount: number }>}
 */
export async function getAgentEarnings(agentId) {
  const [row] = await sql`
    select
      coalesce(sum(amount_usdc), 0)::float as total_usdc,
      count(*)::int as payment_count
    from x402_payments
    where agent_id = ${agentId}
  `;
  return {
    totalUsdc: row?.total_usdc ?? 0,
    paymentCount: row?.payment_count ?? 0,
  };
}
```

---

## Step 4: Create the x402-pricing API endpoint

Create `/workspaces/three.ws/api/agents/[id]/x402-pricing.js`:

Note: Three.ws uses Vercel file-system routing. The `[id]` dynamic segment is already used for other agent sub-routes. Check if there's already a `[id]` directory:

```bash
ls /workspaces/three.ws/api/agents/ 2>/dev/null || echo "no agents/ subdir"
find /workspaces/three.ws/api -name "[id]*" -o -name "*\[id\]*" 2>/dev/null | grep -v node_modules | head -10
```

If Vercel uses `/api/agents/[id].js` pattern (single file), add the route as a new handler within the existing agents.js routing logic instead. Check:

```bash
grep -n 'x402\|pathname\|route\|split' /workspaces/three.ws/api/agents.js | head -30
```

If the agents.js already handles sub-routes by inspecting `req.url`, add the x402-pricing route there. Otherwise, create a new file at the appropriate path.

**Endpoint logic** (adapt to the routing pattern you find):

```js
// GET  /api/agents/:id/x402-pricing  — return current pricing (public)
// POST /api/agents/:id/x402-pricing  — update pricing (owner only)

import { getSessionUser, authenticateBearer, extractBearer } from '../../_lib/auth.js';
import { cors, json, method, readJson, wrap, error } from '../../_lib/http.js';
import { sql } from '../../_lib/db.js';
import { validateX402PricingInput, getAgentX402Pricing, setAgentX402Pricing, getAgentEarnings } from '../../_lib/x402-pricing.js';

export default wrap(async (req, res) => {
  if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;

  // Extract agentId from path: /api/agents/<id>/x402-pricing
  const segments = req.url.split('/').filter(Boolean);
  // segments: ['api', 'agents', '<id>', 'x402-pricing']
  const agentId = segments[2];
  if (!agentId) return error(res, 400, 'bad_request', 'missing agent id');

  if (req.method === 'GET') {
    const pricing = await getAgentX402Pricing(agentId);
    if (!pricing) return error(res, 404, 'not_found', 'agent not found');

    // Return public fields (redact internal fields if needed)
    return json(res, 200, {
      agentId,
      x402: pricing,
    });
  }

  if (req.method === 'POST' || req.method === 'PUT') {
    // Require auth
    const session = await getSessionUser(req);
    const bearer = session ? null : await authenticateBearer(extractBearer(req));
    const userId = session?.id ?? bearer?.userId;
    if (!userId) return error(res, 401, 'unauthorized', 'authentication required');

    // Verify ownership
    const [agent] = await sql`
      select id, user_id from agent_identities
      where id = ${agentId} and deleted_at is null limit 1
    `;
    if (!agent) return error(res, 404, 'not_found', 'agent not found');
    if (agent.user_id !== userId) return error(res, 403, 'forbidden', 'not your agent');

    const body = await readJson(req);

    let pricing;
    try {
      pricing = validateX402PricingInput(body.x402 ?? body);
    } catch (err) {
      return error(res, err.status || 400, err.code || 'validation_error', err.message);
    }

    await setAgentX402Pricing(agentId, pricing);

    // Return updated state with earnings
    const earnings = await getAgentEarnings(agentId);
    return json(res, 200, {
      agentId,
      x402: pricing,
      earnings,
    });
  }

  return error(res, 405, 'method_not_allowed', 'use GET or POST');
});
```

---

## Step 5: Wire x402-pricing into chat.js

Now that `x402-pricing.js` exists, update `/workspaces/three.ws/api/_lib/x402-middleware.js` (from prompt 06) to import `shouldChargeForMessage` and `recordFreeMessage` from `x402-pricing.js` rather than duplicating the logic.

If prompt 06 was already implemented with its own inline versions of those functions, replace them:

```js
// In x402-middleware.js, replace inline shouldChargeForMessage / recordFreeMessage with:
import { shouldChargeForMessage, recordFreeMessage } from './x402-pricing.js';
```

This deduplicates the logic.

---

## Step 6: Syntax check all new files

```bash
node --check /workspaces/three.ws/api/_lib/x402-pricing.js && echo "OK: x402-pricing.js"
```

Check the pricing endpoint file you created.

---

## Success criteria

```
✔ /workspaces/three.ws/api/_lib/x402-pricing.js created with all functions
✔ x402-pricing API endpoint created (either new file or added to existing agents.js)
✔ GET returns pricing config for any agent
✔ POST updates pricing (owner only, validation enforced)
✔ priceUsdc validated: min 0.01, max 100
✔ freeMessages validated: integer, min 0, max 100
✔ payTo validated: base58 Solana address format
✔ shouldChargeForMessage correctly counts free messages from x402_message_counts
✔ getAgentEarnings reads from x402_payments
✔ node --check passes on all new files
```
