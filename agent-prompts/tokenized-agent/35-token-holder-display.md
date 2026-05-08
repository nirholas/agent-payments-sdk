# Prompt 35 — Token Holder & Shareholder Display

## Goal
Build a token holder leaderboard: a REST API endpoint that fetches top holders of an agent's pump.fun Token-2022 token, and a `TokenHoldersList.svelte` component that renders it in the revenue dashboard.

## Environment
- Working directory: `/workspaces/three.ws`
- DB: `/workspaces/three.ws/api/_lib/db.js` → `sql`
- Auth: `/workspaces/three.ws/api/_lib/auth.js`
- HTTP helpers: `/workspaces/three.ws/api/_lib/http.js`
- Existing agent endpoints: `/workspaces/three.ws/api/agents/[id]/` — follow patterns
- Revenue dashboard: `/workspaces/three.ws/chat/src/AgentRevenueDashboard.svelte` (from prompt 32)
- Helius API key: `process.env.HELIUS_API_KEY`
- Solana RPC: `process.env.SOLANA_RPC_URL` or `https://api.mainnet-beta.solana.com`
- Token 2022 program: `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`
- SPL token program: `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`

## Read First
1. `/workspaces/three.ws/api/agents/[id]/revenue.js` (prompt 32) — understand agent endpoint auth pattern
2. `/workspaces/three.ws/chat/src/AgentRevenueDashboard.svelte` (prompt 32) — where this component will be embedded
3. Search for Helius usage: `grep -r 'helius' /workspaces/three.ws/api/ --include='*.js' -l`
4. Check if there's an existing token holder lookup: `grep -r 'getTokenLargestAccounts\|getLargestAccounts\|helius.*token' /workspaces/three.ws/api/ --include='*.js'`

## Task 1 — Token Holders API Endpoint

Create `/workspaces/three.ws/api/agents/[id]/token-holders.js`:

### Request
```
GET /api/agents/{id}/token-holders
Optional: no auth required (public data)
```

### Logic

**Strategy A: Helius Digital Asset API (preferred)**
```javascript
async function fetchHoldersViaHelius(mint) {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) throw new Error('HELIUS_API_KEY not configured');
  
  // Use Helius getTokenAccounts RPC method
  const resp = await fetch(`https://mainnet.helius-rpc.com/?api-key=${apiKey}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'token-holders',
      method: 'getTokenAccounts',
      params: {
        mint,
        limit: 20,
        options: { showZeroBalance: false },
      },
    }),
  });
  if (!resp.ok) throw new Error(`Helius error: ${resp.status}`);
  const data = await resp.json();
  
  if (data.error) throw new Error(`Helius RPC error: ${data.error.message}`);
  
  // data.result.token_accounts: [{ address, owner, mint, amount, decimals }]
  const accounts = data.result?.token_accounts || [];
  return accounts.map(acc => ({
    owner: acc.owner,
    tokenAccount: acc.address,
    balance: Number(acc.amount),
    decimals: acc.decimals,
  }));
}
```

**Strategy B: Standard RPC fallback (when no Helius)**
```javascript
async function fetchHoldersViaRpc(mint, connection) {
  const { PublicKey } = await import('@solana/web3.js');
  const mintPk = new PublicKey(mint);
  
  // Try Token-2022 program first, fall back to SPL Token
  const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
  const SPL_TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  
  let accounts = [];
  for (const program of [TOKEN_2022, SPL_TOKEN]) {
    try {
      const result = await connection.getTokenLargestAccounts(mintPk, 'confirmed');
      if (result.value?.length > 0) {
        accounts = result.value;
        break;
      }
    } catch { /* try next */ }
  }
  
  // Resolve owner addresses from token accounts
  const resolved = await Promise.allSettled(
    accounts.map(async (acc) => {
      const info = await connection.getParsedAccountInfo(acc.address, 'confirmed');
      const owner = info.value?.data?.parsed?.info?.owner;
      return {
        owner: owner || acc.address.toBase58(),
        tokenAccount: acc.address.toBase58(),
        balance: Number(acc.amount),
        decimals: acc.decimals,
      };
    })
  );
  
  return resolved.filter(r => r.status === 'fulfilled').map(r => r.value);
}
```

**Main handler:**
```javascript
export default wrap(async (req, res) => {
  cors(req, res);
  method(req, 'GET');

  const agentId = req.query?.id;

  // Load agent (public endpoint — no auth required)
  const [agent] = await sql`
    SELECT id, owner_id, meta FROM agent_identities WHERE id = ${agentId}
  `;
  if (!agent) return error(res, 404, 'not_found', 'Agent not found');

  const mint = agent.meta?.token?.mint;
  if (!mint) return error(res, 400, 'not_tokenized', 'Agent is not tokenized');

  // Cache check (60-second cache in memory; use a Map with TTL)
  const cached = holderCache.get(mint);
  if (cached && Date.now() - cached.fetchedAt < 60_000) {
    return json(res, 200, cached.data);
  }

  // Fetch holders
  let rawHolders;
  try {
    rawHolders = await fetchHoldersViaHelius(mint);
  } catch (heliusErr) {
    console.warn('[token-holders] Helius failed, trying RPC:', heliusErr.message);
    const { getConnection } = await import('../../_lib/pump.js');
    const conn = getConnection({ network: 'mainnet' });
    rawHolders = await fetchHoldersViaRpc(mint, conn);
  }

  // Get total supply for percentage calculation
  let totalSupply = 1_000_000_000; // default 1B for pump.fun tokens
  try {
    const { getConnection } = await import('../../_lib/pump.js');
    const conn = getConnection({ network: 'mainnet' });
    const { PublicKey } = await import('@solana/web3.js');
    const supplyInfo = await conn.getTokenSupply(new PublicKey(mint), 'confirmed');
    totalSupply = Number(supplyInfo.value.uiAmount || totalSupply);
  } catch { /* use default */ }

  // Enrich with metadata
  const holders = rawHolders
    .sort((a, b) => b.balance - a.balance)
    .slice(0, 20)
    .map((h, i) => ({
      rank: i + 1,
      address: h.owner,
      tokenAccount: h.tokenAccount,
      balance: h.balance,
      balanceUi: h.decimals > 0 ? h.balance / Math.pow(10, h.decimals) : h.balance,
      percentage: totalSupply > 0 ? (h.balance / (totalSupply * Math.pow(10, h.decimals || 6)) * 100) : 0,
      isCreator: h.owner === agent.meta?.token?.creatorAddress,
    }));

  const data = {
    mint,
    agentId,
    totalHolders: holders.length,  // approximate from top 20
    holders,
    fetchedAt: new Date().toISOString(),
  };

  holderCache.set(mint, { data, fetchedAt: Date.now() });
  return json(res, 200, data);
});

// Module-level cache (lives for duration of serverless function warm instance)
const holderCache = new Map();
```

## Task 2 — TokenHoldersList.svelte

Create `/workspaces/three.ws/chat/src/TokenHoldersList.svelte`:

### Props
```svelte
<script>
  export let agentId;
  export let mint = null;
  export let pumpUrl = null;
</script>
```

### UI Layout
```
┌─────────────────────────────────────────────────────────┐
│  Top Token Holders             [Refresh]  [View on pump.fun ↗] │
├─────────────────────────────────────────────────────────┤
│  #   Address            Balance         %      Badge    │
│  1   9xKj...3nPq        1,234,567       12.3%  👑 Creator│
│  2   ABCD...1234          987,654        9.8%           │
│  3   WXYZ...5678          543,210        5.4%           │
│  ...                                                    │
├─────────────────────────────────────────────────────────┤
│  📋 {totalHolders}+ unique holders                     │
└─────────────────────────────────────────────────────────┘
```

### Implementation Details

**Address truncation:** `${addr.slice(0, 4)}...${addr.slice(-4)}`

**Copy button:** on click, `navigator.clipboard.writeText(fullAddress)`; show a brief "✓" confirmation

**Percentage bar:** inline SVG or CSS `width: ${percentage}%` bar, max-width 100px, color `#4ade80`

**Svelte component:**
```svelte
<script>
  import { onMount } from 'svelte';
  
  export let agentId;
  export let mint = null;
  export let pumpUrl = null;
  
  let holders = [];
  let totalHolders = 0;
  let loading = false;
  let error = null;
  let copiedAddr = null;
  
  async function fetchHolders() {
    loading = true;
    error = null;
    try {
      const resp = await fetch(`/api/agents/${agentId}/token-holders`, { credentials: 'include' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      holders = data.holders || [];
      totalHolders = data.totalHolders || holders.length;
    } catch (err) {
      error = err.message;
    } finally {
      loading = false;
    }
  }
  
  function copyAddress(addr) {
    navigator.clipboard.writeText(addr).catch(() => {});
    copiedAddr = addr;
    setTimeout(() => { copiedAddr = null; }, 2000);
  }
  
  onMount(fetchHolders);
</script>
```

**Template:**
```svelte
{#if loading}
  <div class="loading">Loading holders...</div>
{:else if error}
  <div class="error">{error} <button on:click={fetchHolders}>Retry</button></div>
{:else}
  <div class="holders-container">
    <div class="holders-header">
      <span>Top Token Holders</span>
      <div class="header-actions">
        <button on:click={fetchHolders} class="btn-ghost">↻ Refresh</button>
        {#if pumpUrl}
          <a href={pumpUrl} target="_blank" rel="noopener" class="btn-ghost">View on pump.fun ↗</a>
        {/if}
      </div>
    </div>
    <table class="holders-table">
      <thead>
        <tr><th>#</th><th>Address</th><th>Balance</th><th>%</th><th></th></tr>
      </thead>
      <tbody>
        {#each holders as h}
          <tr class="holder-row">
            <td class="rank">{h.rank}</td>
            <td class="address">
              <span class="addr-short">{h.address.slice(0,4)}...{h.address.slice(-4)}</span>
              <button class="copy-btn" on:click={() => copyAddress(h.address)}>
                {copiedAddr === h.address ? '✓' : '📋'}
              </button>
              {#if h.isCreator}<span class="creator-badge">👑 Creator</span>{/if}
            </td>
            <td class="balance">{h.balanceUi.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
            <td class="percentage">
              <div class="pct-bar-wrap">
                <div class="pct-bar" style="width: {Math.min(100, h.percentage * 5)}%"></div>
                <span>{h.percentage.toFixed(1)}%</span>
              </div>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
    <div class="holders-footer">{totalHolders}+ unique holders</div>
  </div>
{/if}
```

**CSS (inline `<style>`):**
```css
.holders-container { font-size: 13px; }
.holders-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.holders-table { width: 100%; border-collapse: collapse; }
.holders-table th, .holders-table td { padding: 6px 8px; text-align: left; border-bottom: 1px solid var(--color-border, #333); }
.holders-table th { color: var(--color-text-muted, #888); font-weight: 500; }
.holder-row:hover { background: var(--color-bg-hover, rgba(255,255,255,0.04)); }
.addr-short { font-family: monospace; }
.copy-btn { background: none; border: none; cursor: pointer; padding: 0 4px; opacity: 0.6; }
.copy-btn:hover { opacity: 1; }
.creator-badge { font-size: 11px; background: #fbbf24; color: #000; padding: 1px 4px; border-radius: 4px; margin-left: 4px; }
.pct-bar-wrap { display: flex; align-items: center; gap: 6px; }
.pct-bar { height: 6px; background: #4ade80; border-radius: 3px; transition: width 0.3s; }
.holders-footer { margin-top: 8px; color: var(--color-text-muted, #888); font-size: 12px; }
.loading, .error { padding: 16px; text-align: center; color: var(--color-text-muted, #888); }
.btn-ghost { background: none; border: 1px solid var(--color-border, #333); color: inherit; padding: 3px 8px; border-radius: 4px; cursor: pointer; font-size: 12px; }
.btn-ghost:hover { background: var(--color-bg-hover, rgba(255,255,255,0.06)); }
```

## Task 3 — Wire into AgentRevenueDashboard.svelte

Read `/workspaces/three.ws/chat/src/AgentRevenueDashboard.svelte` (from prompt 32).

Add to the dashboard:
1. Import `TokenHoldersList`
2. Add a "Holders" section below the top payers section:
```svelte
<TokenHoldersList {agentId} {mint} {pumpUrl} />
```

## File Checklist
- [ ] `/workspaces/three.ws/api/agents/[id]/token-holders.js`
- [ ] `/workspaces/three.ws/chat/src/TokenHoldersList.svelte`
- [ ] `/workspaces/three.ws/chat/src/AgentRevenueDashboard.svelte` — TokenHoldersList added

## Verification
1. `node -e "import('./api/agents/[id]/token-holders.js').then(m => console.log(typeof m.default))"` from `/workspaces/three.ws`
2. `grep -n 'TokenHoldersList' /workspaces/three.ws/chat/src/AgentRevenueDashboard.svelte`
3. Test: `curl 'http://localhost:3000/api/agents/{id}/token-holders'` — should return JSON (even if mint not found, should return 400)
