# Task: Build x402 payment history API and UI for three.ws

## Context

- three.ws repo: `/workspaces/three.ws`
- `x402_payments` table exists (created by migration in prompt 06): agent_id, payer_address, amount_usdc, tx_signature, message_preview, created_at
- Agent API: `/workspaces/three.ws/api/agents.js`
- Users API: find it at `/workspaces/three.ws/api/`
- Chat frontend: `/workspaces/three.ws/chat/src/`
- AgentSettingsModal is at `/workspaces/three.ws/chat/src/AgentSettingsModal.svelte`

---

## Step 1: Read all relevant files

```
/workspaces/three.ws/api/agents.js
/workspaces/three.ws/api/_lib/db.js
/workspaces/three.ws/api/_lib/http.js
/workspaces/three.ws/api/_lib/auth.js
/workspaces/three.ws/api/_lib/x402-pricing.js     (from prompt 07)
/workspaces/three.ws/chat/src/AgentSettingsModal.svelte
/workspaces/three.ws/chat/src/Modal.svelte
```

Also check if there's an existing user payments/history endpoint:
```bash
find /workspaces/three.ws/api -name "payment*" -o -name "history*" | grep -v node_modules | head -10
grep -r 'payment.*history\|revenue\|earnings' /workspaces/three.ws/api/*.js --include="*.js" -l | head -5
```

---

## Step 2: Create the agent payment history API endpoint

Determine the routing pattern by reading how other agent sub-routes are structured:
```bash
find /workspaces/three.ws/api/agents -type f | head -20
ls /workspaces/three.ws/api/agents/ 2>/dev/null
```

Create `/workspaces/three.ws/api/agents/[id]/payment-history.js` (or add to existing routing):

```js
// GET /api/agents/:id/payment-history
//
// Returns paginated x402 payment receipts for a given agent.
// Requires authentication as the agent owner.
//
// Query params:
//   page    (default 1)
//   limit   (default 20, max 100)
//   since   (ISO timestamp, optional — filter to payments after this date)

import { getSessionUser, authenticateBearer, extractBearer } from '../../_lib/auth.js';
import { cors, json, method, wrap, error } from '../../_lib/http.js';
import { sql } from '../../_lib/db.js';

export default wrap(async (req, res) => {
  if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
  if (!method(req, res, ['GET'])) return;

  // Auth
  const session = await getSessionUser(req);
  const bearer = session ? null : await authenticateBearer(extractBearer(req));
  const userId = session?.id ?? bearer?.userId;
  if (!userId) return error(res, 401, 'unauthorized', 'authentication required');

  // Extract agentId from URL path
  const url = new URL(req.url, 'http://x');
  const segments = url.pathname.split('/').filter(Boolean);
  // /api/agents/<id>/payment-history → segments[2] = id
  const agentId = segments[2];
  if (!agentId) return error(res, 400, 'bad_request', 'missing agent id');

  // Verify ownership
  const [agent] = await sql`
    select id, user_id, name from agent_identities
    where id = ${agentId} and deleted_at is null limit 1
  `;
  if (!agent) return error(res, 404, 'not_found', 'agent not found');
  if (agent.user_id !== userId) return error(res, 403, 'forbidden', 'not your agent');

  // Parse query params
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '20', 10)));
  const offset = (page - 1) * limit;
  const since = url.searchParams.get('since');

  // Fetch payments
  let payments;
  let total;

  if (since) {
    const sinceDate = new Date(since);
    if (isNaN(sinceDate.getTime())) return error(res, 400, 'bad_request', 'invalid "since" date');

    [payments, [{ count: total }]] = await Promise.all([
      sql`
        select id, payer_address, amount_usdc, tx_signature, message_preview, created_at
        from x402_payments
        where agent_id = ${agentId} and created_at >= ${sinceDate.toISOString()}
        order by created_at desc
        limit ${limit} offset ${offset}
      `,
      sql`
        select count(*)::int as count from x402_payments
        where agent_id = ${agentId} and created_at >= ${sinceDate.toISOString()}
      `,
    ]);
  } else {
    [payments, [{ count: total }]] = await Promise.all([
      sql`
        select id, payer_address, amount_usdc, tx_signature, message_preview, created_at
        from x402_payments
        where agent_id = ${agentId}
        order by created_at desc
        limit ${limit} offset ${offset}
      `,
      sql`select count(*)::int as count from x402_payments where agent_id = ${agentId}`,
    ]);
  }

  // Aggregate stats
  const [stats] = await sql`
    select
      coalesce(sum(amount_usdc), 0)::float   as total_earned_usdc,
      count(*)::int                           as total_payments,
      count(distinct payer_address)::int      as unique_payers
    from x402_payments
    where agent_id = ${agentId}
  `;

  return json(res, 200, {
    agentId,
    agentName: agent.name,
    stats: {
      totalEarnedUsdc: stats.total_earned_usdc ?? 0,
      totalPayments: stats.total_payments ?? 0,
      uniquePayers: stats.unique_payers ?? 0,
    },
    pagination: {
      page,
      limit,
      total: total ?? 0,
      hasMore: offset + payments.length < (total ?? 0),
    },
    payments: payments.map(p => ({
      id: p.id,
      payerAddress: p.payer_address,
      amountUsdc: parseFloat(p.amount_usdc),
      txSignature: p.tx_signature,
      messagePreview: p.message_preview,
      createdAt: p.created_at,
    })),
  });
});
```

---

## Step 3: Create the user payment history API endpoint

Create `/workspaces/three.ws/api/users/payment-history.js` (or add to existing users route):

```js
// GET /api/users/payment-history
//
// Returns all x402 payments made by the current user across all agents.
// Requires authentication.
//
// Query params:
//   page  (default 1)
//   limit (default 20, max 100)

import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { cors, json, method, wrap, error } from '../_lib/http.js';
import { sql } from '../_lib/db.js';

export default wrap(async (req, res) => {
  if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
  if (!method(req, res, ['GET'])) return;

  const session = await getSessionUser(req);
  const bearer = session ? null : await authenticateBearer(extractBearer(req));
  const userId = session?.id ?? bearer?.userId;
  if (!userId) return error(res, 401, 'unauthorized', 'authentication required');

  const url = new URL(req.url, 'http://x');
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '20', 10)));
  const offset = (page - 1) * limit;

  // Look up payer address from user's wallet
  const [user] = await sql`
    select wallet_address from users where id = ${userId} limit 1
  `;
  if (!user?.wallet_address) {
    return json(res, 200, {
      payments: [],
      stats: { totalSpentUsdc: 0, totalPayments: 0 },
      pagination: { page, limit, total: 0, hasMore: false },
    });
  }

  const payerAddress = user.wallet_address;

  const [payments, [{ count: total }], [stats]] = await Promise.all([
    sql`
      select
        p.id,
        p.agent_id,
        a.name as agent_name,
        p.amount_usdc,
        p.tx_signature,
        p.message_preview,
        p.created_at
      from x402_payments p
      join agent_identities a on a.id = p.agent_id
      where p.payer_address = ${payerAddress}
      order by p.created_at desc
      limit ${limit} offset ${offset}
    `,
    sql`
      select count(*)::int as count
      from x402_payments
      where payer_address = ${payerAddress}
    `,
    sql`
      select
        coalesce(sum(amount_usdc), 0)::float as total_spent_usdc,
        count(*)::int as total_payments
      from x402_payments
      where payer_address = ${payerAddress}
    `,
  ]);

  return json(res, 200, {
    walletAddress: payerAddress,
    stats: {
      totalSpentUsdc: stats?.total_spent_usdc ?? 0,
      totalPayments: stats?.total_payments ?? 0,
    },
    pagination: {
      page,
      limit,
      total: total ?? 0,
      hasMore: offset + payments.length < (total ?? 0),
    },
    payments: payments.map(p => ({
      id: p.id,
      agentId: p.agent_id,
      agentName: p.agent_name,
      amountUsdc: parseFloat(p.amount_usdc),
      txSignature: p.tx_signature,
      messagePreview: p.message_preview,
      createdAt: p.created_at,
    })),
  });
});
```

---

## Step 4: Create PaymentHistory.svelte component

Create `/workspaces/three.ws/chat/src/PaymentHistory.svelte`:

Read `AgentSettingsModal.svelte` to understand the design system being used (tailwind classes, color palette).

```svelte
<!-- PaymentHistory.svelte — shows x402 payment receipts for an agent -->
<script>
  import { onMount } from 'svelte';

  /** Agent ID to fetch history for */
  export let agentId;
  /** Agent name for display */
  export let agentName = 'Agent';

  let loading = true;
  let error = null;
  let data = null;

  onMount(async () => {
    await loadHistory();
  });

  async function loadHistory(page = 1) {
    loading = true;
    error = null;
    try {
      const res = await fetch(`/api/agents/${agentId}/payment-history?page=${page}&limit=10`, {
        credentials: 'include',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error_description || `HTTP ${res.status}`);
      }
      data = await res.json();
    } catch (err) {
      error = err.message;
    } finally {
      loading = false;
    }
  }

  function truncateAddr(addr) {
    if (!addr || addr.length <= 12) return addr;
    return addr.slice(0, 6) + '…' + addr.slice(-4);
  }

  function formatUsdc(amount) {
    return '$' + Number(amount).toFixed(2);
  }

  function formatDate(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }

  function solscanUrl(sig) {
    return `https://solscan.io/tx/${sig}`;
  }
</script>

<div class="flex flex-col gap-4">
  <!-- Stats bar -->
  {#if data?.stats}
    <div class="grid grid-cols-3 gap-2">
      <div class="rounded-lg bg-slate-800/60 p-3 text-center">
        <p class="text-lg font-bold text-white">{formatUsdc(data.stats.totalEarnedUsdc)}</p>
        <p class="text-[10px] text-slate-400 uppercase tracking-wide mt-0.5">Earned</p>
      </div>
      <div class="rounded-lg bg-slate-800/60 p-3 text-center">
        <p class="text-lg font-bold text-white">{data.stats.totalPayments}</p>
        <p class="text-[10px] text-slate-400 uppercase tracking-wide mt-0.5">Payments</p>
      </div>
      <div class="rounded-lg bg-slate-800/60 p-3 text-center">
        <p class="text-lg font-bold text-white">{data.stats.uniquePayers}</p>
        <p class="text-[10px] text-slate-400 uppercase tracking-wide mt-0.5">Payers</p>
      </div>
    </div>
  {/if}

  <!-- Content -->
  {#if loading}
    <div class="flex items-center justify-center py-8">
      <svg class="h-6 w-6 animate-spin text-indigo-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.4 0 0 5.4 0 12h4z"/>
      </svg>
    </div>

  {:else if error}
    <div class="rounded-lg bg-red-900/30 border border-red-800 px-4 py-3 text-sm text-red-300">
      {error}
    </div>

  {:else if !data?.payments?.length}
    <div class="py-8 text-center text-sm text-slate-500">
      No payments received yet.
    </div>

  {:else}
    <div class="divide-y divide-slate-800">
      {#each data.payments as payment (payment.id)}
        <div class="flex items-start justify-between gap-2 py-3">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="text-sm font-medium text-slate-200">{formatUsdc(payment.amountUsdc)}</span>
              <span class="text-xs text-slate-500">from {truncateAddr(payment.payerAddress)}</span>
            </div>
            {#if payment.messagePreview}
              <p class="mt-0.5 truncate text-xs text-slate-500">"{payment.messagePreview}"</p>
            {/if}
            <p class="mt-0.5 text-[10px] text-slate-600">{formatDate(payment.createdAt)}</p>
          </div>
          <a
            href={solscanUrl(payment.txSignature)}
            target="_blank"
            rel="noopener noreferrer"
            class="shrink-0 rounded-md bg-slate-800 px-2 py-1 text-[10px] font-medium text-slate-400 hover:text-white transition-colors"
          >
            Tx ↗
          </a>
        </div>
      {/each}
    </div>

    <!-- Pagination -->
    {#if data.pagination.total > data.pagination.limit}
      <div class="flex items-center justify-between text-xs text-slate-500">
        <span>{data.pagination.total} total</span>
        <div class="flex gap-2">
          {#if data.pagination.page > 1}
            <button
              class="rounded px-2 py-1 hover:text-white"
              on:click={() => loadHistory(data.pagination.page - 1)}
            >← Prev</button>
          {/if}
          {#if data.pagination.hasMore}
            <button
              class="rounded px-2 py-1 hover:text-white"
              on:click={() => loadHistory(data.pagination.page + 1)}
            >Next →</button>
          {/if}
        </div>
      </div>
    {/if}
  {/if}
</div>
```

---

## Step 5: Add PaymentHistory tab to AgentSettingsModal

Read `/workspaces/three.ws/chat/src/AgentSettingsModal.svelte` fully, then add a "Payments" section.

In the `<script>` block, add:
```js
import PaymentHistory from './PaymentHistory.svelte';
let activeTab = 'settings'; // 'settings' | 'payments'
```

In the template, add a tab bar and conditionally render `<PaymentHistory>` when `activeTab === 'payments'` and the agent has x402 enabled.

The exact insertion point depends on the current modal structure — read the file first.

---

## Step 6: Syntax check

```bash
node --check /workspaces/three.ws/api/agents/[id]/payment-history.js 2>/dev/null || \
node --check /workspaces/three.ws/api/agents/payment-history.js 2>/dev/null && echo "OK"
node --check /workspaces/three.ws/api/users/payment-history.js 2>/dev/null && echo "OK"
cd /workspaces/three.ws/chat && npx vite build 2>&1 | tail -20
```

---

## Success criteria

```
✔ GET /api/agents/:id/payment-history returns payments (owner-only, 403 for non-owner)
✔ GET /api/users/payment-history returns payments made by current user
✔ Both endpoints paginate correctly
✔ Stats (totalEarnedUsdc, totalPayments, uniquePayers) calculated from x402_payments
✔ PaymentHistory.svelte renders stats + paginated list + solscan links
✔ AgentSettingsModal shows PaymentHistory tab for x402-enabled agents
✔ vite build passes
```
