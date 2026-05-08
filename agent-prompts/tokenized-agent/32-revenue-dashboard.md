# Prompt 32 — Agent Revenue Dashboard

## Goal
Build a revenue dashboard for tokenized agents in three.ws: a REST API endpoint that aggregates on-chain vault balances and DB payment history, and an `AgentRevenueDashboard.svelte` component that renders it.

## Environment
- Working directory: `/workspaces/three.ws`
- DB: `/workspaces/three.ws/api/_lib/db.js` → `sql`
- Auth: `/workspaces/three.ws/api/_lib/auth.js`
- HTTP helpers: `/workspaces/three.ws/api/_lib/http.js`
- pump agent: `/workspaces/three.ws/api/_lib/pump.js` → `getPumpAgent`, `getConnection`
- Agent payments SDK: `@pump-fun/agent-payments-sdk` → `PumpAgent`
- Existing agent skills: `/workspaces/three.ws/src/agent-skills-agent-payments.js` — read for `agent-payments-balances` pattern
- pump.fun MCP tools: `/workspaces/three.ws/src/pump/mcp-tools.js` — find `getBondingCurve` usage
- Svelte app: `/workspaces/three.ws/chat/src/`
- USDC mint: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`

## Read First
1. `/workspaces/three.ws/src/agent-skills-agent-payments.js` — read the `agent-payments-balances` skill to understand how `PumpAgent.getBalances` is called
2. `/workspaces/three.ws/api/agents/[id].js` — understand existing agent endpoint pattern
3. `/workspaces/three.ws/api/pump/[action].js` — find `handleBalances` for balance fetch pattern
4. Search for `x402_payments` table usage: `grep -r 'x402_payments' /workspaces/three.ws/api/` to understand the DB schema

## Task 1 — Revenue API Endpoint

Create `/workspaces/three.ws/api/agents/[id]/revenue.js`:

### Request
```
GET /api/agents/{agentId}/revenue?network=mainnet&days=30
Authorization: session | bearer
```

### Logic

```javascript
export default wrap(async (req, res) => {
  cors(req, res);
  method(req, 'GET');

  const auth = await resolveAuth(req);
  if (!auth) return error(res, 401, 'unauthorized', 'Login required');

  const agentId = req.query?.id;  // Vercel passes [id] as req.query.id
  const network = req.query?.network || 'mainnet';
  const days = Math.min(365, parseInt(req.query?.days || '30', 10));

  // 1. Load agent, verify ownership
  const [agent] = await sql`SELECT * FROM agent_identities WHERE id = ${agentId} AND owner_id = ${auth.userId}`;
  if (!agent) return error(res, 404, 'not_found', 'Agent not found');

  const mint = agent.meta?.token?.mint;
  if (!mint) return error(res, 400, 'not_tokenized', 'Agent is not tokenized');

  // 2. Fetch on-chain vault balances
  let vaultBalances = { paymentVaultBalance: 0, buybackVaultBalance: 0, withdrawVaultBalance: 0 };
  try {
    const { agent: pumpAgent } = await getPumpAgent({ network, mint });
    const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const balances = await pumpAgent.getBalances(USDC_MINT);
    // getBalances returns { paymentVault, buybackVault, withdrawVault } each with .balance (u64 in USDC atoms)
    vaultBalances = {
      paymentVaultBalance: Number(balances.paymentVault?.balance || 0) / 1e6,   // USDC has 6 decimals
      buybackVaultBalance: Number(balances.buybackVault?.balance || 0) / 1e6,
      withdrawVaultBalance: Number(balances.withdrawVault?.balance || 0) / 1e6,
    };
  } catch (err) {
    console.warn('[revenue] getBalances failed:', err.message);
    // Continue with zeros — dashboard still shows DB data
  }

  // 3. Query x402_payments history from DB
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const payments = await sql`
    SELECT payer_address, amount_usdc, paid_at
    FROM x402_payments
    WHERE agent_id = ${agentId}
      AND paid_at >= ${since}
    ORDER BY paid_at DESC
    LIMIT 500
  `.catch(() => []);

  const totalEarned = payments.reduce((sum, p) => sum + Number(p.amount_usdc || 0), 0);
  const messageCount = payments.length;

  // Top payers: aggregate by payer_address
  const payerMap = new Map();
  for (const p of payments) {
    const addr = p.payer_address;
    if (!payerMap.has(addr)) payerMap.set(addr, { address: addr, totalPaid: 0, messageCount: 0 });
    const entry = payerMap.get(addr);
    entry.totalPaid += Number(p.amount_usdc || 0);
    entry.messageCount++;
  }
  const topPayers = [...payerMap.values()]
    .sort((a, b) => b.totalPaid - a.totalPaid)
    .slice(0, 10);

  // Recent payments (last 20)
  const recentPayments = payments.slice(0, 20).map(p => ({
    payerAddress: p.payer_address,
    amountUsdc: Number(p.amount_usdc || 0),
    paidAt: p.paid_at,
  }));

  // 4. Daily chart data (sum by day)
  const chartData = [];
  for (let d = days - 1; d >= 0; d--) {
    const dayStart = new Date(Date.now() - d * 24 * 60 * 60 * 1000);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
    const dayPayments = payments.filter(p => {
      const t = new Date(p.paid_at).getTime();
      return t >= dayStart.getTime() && t < dayEnd.getTime();
    });
    chartData.push({
      date: dayStart.toISOString().slice(0, 10),
      earned: dayPayments.reduce((s, p) => s + Number(p.amount_usdc || 0), 0),
      messages: dayPayments.length,
    });
  }

  return json(res, 200, {
    agentId,
    mint,
    ...vaultBalances,
    totalEarned,
    messageCount,
    topPayers,
    recentPayments,
    chartData,
    periodDays: days,
  });
});
```

## Task 2 — AgentRevenueDashboard.svelte

Create `/workspaces/three.ws/chat/src/AgentRevenueDashboard.svelte`:

### Props
```svelte
<script>
  export let agentId;
  export let mint = null;       // from agent.meta.token.mint
  export let pumpUrl = null;    // from agent.meta.token.pumpUrl
</script>
```

### Layout
```
┌─────────────────────────────────────────────────────────┐
│  Revenue Dashboard            [Refresh]  [30d ▼]         │
├──────────────┬──────────────┬──────────────────────────┤
│ Payment Vault│ Buyback Vault│ Withdraw Vault            │
│  $12.34 USDC │ $3.45 USDC  │ $8.89 USDC               │
├──────────────┴──────────────┴──────────────────────────┤
│ 📈 Earnings (last 30 days)  — sparkline bar chart       │
│ [bar bars bars bars ... ]                               │
│ Total: $24.68  |  Messages: 247                         │
├─────────────────────────────────────────────────────────┤
│ 💸 Top Payers                                           │
│  1. 9xKj...  $8.20  (82 msgs)                          │
│  2. 3nPq...  $4.50  (45 msgs)                          │
│  ...                                                    │
├─────────────────────────────────────────────────────────┤
│ [Distribute]  [Withdraw]  [Check USDC Whitelist]        │
│ [View on pump.fun ↗]                                    │
└─────────────────────────────────────────────────────────┘
```

### Sparkline Bar Chart
Use a simple SVG bar chart — no external chart library. Each day is a rectangle:
```svelte
<svg width="100%" height="60" viewBox={`0 0 ${chartData.length * 8} 60`} preserveAspectRatio="none">
  {#each chartData as day, i}
    {@const h = maxEarned > 0 ? (day.earned / maxEarned) * 55 : 1}
    <rect
      x={i * 8 + 1} y={60 - h} width={6} height={h}
      fill={day.earned > 0 ? '#4ade80' : '#374151'}
    />
  {/each}
</svg>
```

### Action Buttons
Each button calls the corresponding pump.fun agent skill via `POST /api/pump/[action]`:
- "Distribute" → `POST /api/pump/distribute-prep` then `POST /api/pump/distribute-confirm` (requires wallet signing)
- "Withdraw" → `POST /api/pump/withdraw-prep` then `POST /api/pump/withdraw-confirm`
- "Check USDC Whitelist" → `GET /api/pump/balances?mint={mint}&currency=USDC`

For wallet-signing flows, follow the existing pattern in other Svelte components (read `TxApprovalModal.svelte` for the sign-and-confirm pattern).

### Token Price Section
Add a "Token Price" section that fetches from the bonding curve:
```javascript
const priceResp = await fetch(`/api/pump/quote?action=quote&mint=${mint}`);
const { price, marketCap } = await priceResp.json();
```
Display: `Price: $0.000123 | Market Cap: $12,345`

### Reactive Updates
- `onMount`: fetch revenue data, fetch token price
- Period selector (7d / 30d / 90d): refetch with `?days=N`
- Refresh button: refetch all data
- Show loading spinner while fetching (use existing `Icon.svelte` or inline SVG spinner)

## Task 3 — Add Revenue Tab to Agent Detail Page

Find where the agent detail page is rendered in the chat app (search for AgentSettingsModal or agent detail components).

Add a "Revenue" tab/section that shows `AgentRevenueDashboard` when:
- `agent.meta?.token?.mint` exists (agent is tokenized)
- The viewing user is the agent owner

```svelte
{#if isOwner && agent?.meta?.token?.mint}
  <AgentRevenueDashboard agentId={agent.id} mint={agent.meta.token.mint} pumpUrl={agent.meta.token.pumpUrl} />
{/if}
```

## File Checklist
- [ ] `/workspaces/three.ws/api/agents/[id]/revenue.js`
- [ ] `/workspaces/three.ws/chat/src/AgentRevenueDashboard.svelte`
- [ ] Agent detail page wired with revenue tab

## Verification
1. `node -e "import('./api/agents/[id]/revenue.js').then(m => console.log(typeof m.default))"` from `/workspaces/three.ws`
2. `grep -n 'AgentRevenueDashboard' /workspaces/three.ws/chat/src/AgentSettingsModal.svelte` (or wherever agent detail is)
3. Test endpoint manually: `curl -H 'Cookie: ...' http://localhost:3000/api/agents/{id}/revenue`
