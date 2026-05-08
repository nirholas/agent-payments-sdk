# Prompt 41 — GMGN Chat Tools

## Goal
Add a complete GMGN smart money tool pack to the three.ws chat so Claude can query signals, analyze wallets, and enable copy trading directly from conversation.

## Environment
- Working directory: `/workspaces/three.ws`
- Chat tools file: `/workspaces/three.ws/chat/src/tools.js`
- GMGN API routes: `/workspaces/three.ws/api/gmgn/smart-money.js` (prompt 38)
- Agent skills invoke: `/workspaces/three.ws/api/agents/{agentId}/skills/invoke` or similar endpoint
- App.svelte: `/workspaces/three.ws/chat/src/App.svelte`

## Read First
1. Read `/workspaces/three.ws/chat/src/tools.js` fully — understand how `curatedToolPacks` and `gmgnToolSchema` should be exported and integrated
2. Find the pattern for tool packs: look for `pumpTradingToolSchema` or similar named exports
3. Read `/workspaces/three.ws/chat/src/App.svelte` — find where tool schemas are registered/initialized
4. Check for existing agent skill invocation endpoint: `grep -r 'skills/invoke' /workspaces/three.ws/api/ --include='*.js'`

## Task 1 — GMGN Tool Pack

Add a new export `gmgnToolSchema` to `/workspaces/three.ws/chat/src/tools.js`.

Follow the exact same schema format as existing tool packs (read the file first). Each tool entry has:
- `type: 'function'`
- `function: { name, description, parameters }`
- `clientDefinition: { id, name, description, arguments: [...], body: "..." }`

```javascript
export const gmgnToolSchema = [
```

### Tool 1: `gmgnTrending`

```javascript
{
  type: 'function',
  function: {
    name: 'gmgnTrending',
    description: 'Get the top 10 tokens that smart money (profitable on-chain traders) is buying right now, ranked by inflow volume.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  clientDefinition: {
    id: 'gmgn-trending-001',
    name: 'gmgnTrending',
    description: 'Show top tokens with smart money buying activity',
    arguments: [],
    body: `
const resp = await fetch('/api/gmgn/smart-money?action=trending', { credentials: 'include' });
if (!resp.ok) return { error: 'GMGN unavailable — Cloudflare blocks datacenter IPs. Use locally or with residential proxy.', tokens: [] };
const data = await resp.json();
const tokens = (data.tokens || []).slice(0, 10);
if (tokens.length === 0) return { tokens: [], summary: 'No smart money signals available right now.' };
const summary = tokens.map((t, i) => 
  \`\${i+1}. \${t.symbol || t.mint?.slice(0,8)+'...'} | buy_vol: $\${(t.buyVolume||t.amountUsd||0).toFixed(0)} | conf: \${((t.confidence||0)*100).toFixed(0)}%\`
).join('\\n');
return { tokens, summary: \`Top smart money tokens (1h):\\n\${summary}\` };
`.trim(),
  },
},
```

### Tool 2: `gmgnWalletAnalysis`

```javascript
{
  type: 'function',
  function: {
    name: 'gmgnWalletAnalysis',
    description: 'Analyze a specific Solana wallet\'s trading history and performance using GMGN smart money data. Shows win rate, total profit, holdings, and recent trades.',
    parameters: {
      type: 'object',
      properties: {
        address: {
          type: 'string',
          description: 'Solana wallet address (base58)',
        },
      },
      required: ['address'],
    },
  },
  clientDefinition: {
    id: 'gmgn-wallet-001',
    name: 'gmgnWalletAnalysis',
    description: 'Analyze a smart money wallet',
    arguments: [
      { name: 'address', type: 'string', description: 'Solana wallet address' },
    ],
    body: `
const resp = await fetch(\`/api/gmgn/smart-money?action=wallet&address=\${encodeURIComponent(args.address)}\`, { credentials: 'include' });
if (!resp.ok) return { error: \`GMGN API error: \${resp.status}\`, address: args.address };
const data = await resp.json();

const trades = data.trades || [];
const holdings = data.holdings || [];
const buys = trades.filter(t => t.type === 'buy');
const sells = trades.filter(t => t.type === 'sell');
const totalBuyVol = buys.reduce((s, t) => s + (t.amountUsd || 0), 0);
const totalSellVol = sells.reduce((s, t) => s + (t.amountUsd || 0), 0);

const recentTrades = trades.slice(0, 5).map(t =>
  \`  \${t.type.toUpperCase()} \${t.symbol || t.mint?.slice(0,8)+'...'} $\${(t.amountUsd||0).toFixed(0)} @ \${new Date(t.timestamp).toLocaleDateString()}\`
).join('\\n');

return {
  address: args.address,
  shortAddress: args.address.slice(0,6) + '...' + args.address.slice(-4),
  tradeCount: trades.length,
  buyCount: buys.length,
  sellCount: sells.length,
  totalBuyVolume: totalBuyVol,
  totalSellVolume: totalSellVol,
  holdingsCount: holdings.length,
  recentTrades: trades.slice(0, 5),
  summary: \`Wallet \${args.address.slice(0,8)}...: \${trades.length} recent trades (\${buys.length} buys / \${sells.length} sells)\\nBuy vol: $\${totalBuyVol.toFixed(0)} | Sell vol: $\${totalSellVol.toFixed(0)}\\nTop recent trades:\\n\${recentTrades}\`,
};
`.trim(),
  },
},
```

### Tool 3: `gmgnTokenSignals`

```javascript
{
  type: 'function',
  function: {
    name: 'gmgnTokenSignals',
    description: 'Get smart money buy/sell signals for a specific pump.fun token. Shows who is buying/selling, signal strength, and net sentiment.',
    parameters: {
      type: 'object',
      properties: {
        mint: {
          type: 'string',
          description: 'Token mint address (base58)',
        },
      },
      required: ['mint'],
    },
  },
  clientDefinition: {
    id: 'gmgn-token-001',
    name: 'gmgnTokenSignals',
    description: 'Get smart money signals for a token',
    arguments: [
      { name: 'mint', type: 'string', description: 'Token mint address' },
    ],
    body: `
const resp = await fetch(\`/api/gmgn/smart-money?action=token&mint=\${encodeURIComponent(args.mint)}\`, { credentials: 'include' });
if (!resp.ok) return { error: \`GMGN API error: \${resp.status}\`, mint: args.mint };
const data = await resp.json();

const signals = data.signals || [];
const buys = signals.filter(s => s.type === 'buy');
const sells = signals.filter(s => s.type === 'sell');
const buyVol = buys.reduce((s, x) => s + (x.amountUsd || 0), 0);
const sellVol = sells.reduce((s, x) => s + (x.amountUsd || 0), 0);
const sentiment = buyVol > sellVol * 1.5 ? 'BULLISH' : sellVol > buyVol * 1.5 ? 'BEARISH' : 'NEUTRAL';
const score = (buyVol - sellVol) / (buyVol + sellVol + 0.01);

return {
  mint: args.mint,
  sentiment,
  score: +score.toFixed(3),
  buyVolume: +buyVol.toFixed(2),
  sellVolume: +sellVol.toFixed(2),
  signalCount: signals.length,
  topBuyers: buys.slice(0, 3).map(s => ({ wallet: s.wallet?.slice(0,8)+'...', amount: s.amountUsd, confidence: s.confidence })),
  topSellers: sells.slice(0, 3).map(s => ({ wallet: s.wallet?.slice(0,8)+'...', amount: s.amountUsd, confidence: s.confidence })),
  summary: \`Smart money on \${args.mint.slice(0,8)}...: \${sentiment} (score \${score.toFixed(2)})\\n\${signals.length} signals | Buy $\${buyVol.toFixed(0)} vs Sell $\${sellVol.toFixed(0)}\`,
};
`.trim(),
  },
},
```

### Tool 4: `gmgnCopyTradeEnable`

```javascript
{
  type: 'function',
  function: {
    name: 'gmgnCopyTradeEnable',
    description: 'Enable copy trading: automatically buys tokens when a specified smart wallet makes a trade. Uses the agent\'s hot wallet.',
    parameters: {
      type: 'object',
      properties: {
        walletAddress: {
          type: 'string',
          description: 'The smart wallet address to copy-trade',
        },
        maxBuyUsd: {
          type: 'number',
          description: 'Maximum USD to spend per copy trade (default: $10)',
          default: 10,
        },
        minConfidence: {
          type: 'number',
          description: 'Minimum signal confidence 0-1 to execute (default: 0.7)',
          default: 0.7,
        },
      },
      required: ['walletAddress'],
    },
  },
  clientDefinition: {
    id: 'gmgn-copytrade-001',
    name: 'gmgnCopyTradeEnable',
    description: 'Enable copy trading from a smart wallet',
    arguments: [
      { name: 'walletAddress', type: 'string', description: 'Smart wallet to copy' },
      { name: 'maxBuyUsd', type: 'number', description: 'Max USD per trade' },
      { name: 'minConfidence', type: 'number', description: 'Min confidence (0-1)' },
    ],
    body: `
// Get current agent ID from app state
const agentId = window.__currentAgentId || window.agentId;
if (!agentId) return { error: 'No agent selected. Open an agent first.' };

const resp = await fetch(\`/api/agents/\${agentId}/skills/invoke\`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  credentials: 'include',
  body: JSON.stringify({
    skill: 'gmgn-copy-trade-enable',
    args: {
      walletToCopy: args.walletAddress,
      maxBuyUsd: args.maxBuyUsd || 10,
      minConfidence: args.minConfidence || 0.7,
    },
  }),
});

if (!resp.ok) {
  const err = await resp.json().catch(() => ({}));
  return { error: err.error_description || \`Failed: \${resp.status}\`, enabled: false };
}

const result = await resp.json();
return { enabled: true, config: result.config, message: result.message };
`.trim(),
  },
},
```

### Tool 5: `gmgnCopyTradeStatus`

```javascript
{
  type: 'function',
  function: {
    name: 'gmgnCopyTradeStatus',
    description: 'Show the current copy trading configuration, open positions, P&L, and recent trades.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  clientDefinition: {
    id: 'gmgn-copytrade-status-001',
    name: 'gmgnCopyTradeStatus',
    description: 'Show copy trading status and P&L',
    arguments: [],
    body: `
const agentId = window.__currentAgentId || window.agentId;
if (!agentId) return { error: 'No agent selected.' };

const resp = await fetch(\`/api/agents/\${agentId}/skills/invoke\`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  credentials: 'include',
  body: JSON.stringify({ skill: 'gmgn-copy-trade-status', args: {} }),
});

if (!resp.ok) return { error: \`Status fetch failed: \${resp.status}\` };
const data = await resp.json();

const config = data.config;
const trades = data.recentTrades || [];

const tradeSummary = trades.slice(0, 5).map(t =>
  \`  [\${t.status}] \${t.trade_type.toUpperCase()} \${t.mint?.slice(0,8)+'...'} $\${Number(t.amount_usdc||0).toFixed(2)} \${t.pnl_usdc ? '(P&L: $'+Number(t.pnl_usdc).toFixed(2)+')' : ''}\`
).join('\\n');

return {
  ...data,
  summary: config?.enabled
    ? \`Copy trading ACTIVE\\nCopying: \${config.walletToCopy?.slice(0,8)+'...'}\\nMax per trade: $\${config.maxBuyUsd} | Min confidence: \${config.minConfidence}\\nTotal P&L: $\${data.totalPnl?.toFixed(4)}\\nRecent trades:\\n\${tradeSummary || '  (none yet)'}\`
    : 'Copy trading is disabled.',
};
`.trim(),
  },
},

]; // end gmgnToolSchema
```

## Task 2 — Add Tool Pack to curatedToolPacks

In `tools.js`, add `gmgnToolSchema` to the `curatedToolPacks` export array:

```javascript
curatedToolPacks.push({
  id: 'gmgn-smart-money',
  name: 'GMGN Smart Money',
  description: 'Query GMGN smart money signals: trending tokens, wallet analysis, copy trading, and signal-based insights.',
  schema: gmgnToolSchema,
});
```

Or add it directly in the array literal if that is how the file is structured.

## Task 3 — Wire into App.svelte

Read `/workspaces/three.ws/chat/src/App.svelte`. Find where tool packs are initialized or passed to the chat component.

Add:
```javascript
import { gmgnToolSchema } from './tools.js';
```

And include `gmgnToolSchema` wherever other tool schemas are registered with the chat session.

## Task 4 — Agent Skill Invoke Endpoint

The `gmgnCopyTradeEnable` and `gmgnCopyTradeStatus` tools need a `/api/agents/{agentId}/skills/invoke` endpoint.

Check if this endpoint already exists:
```bash
find /workspaces/three.ws/api/agents -name '*.js' | xargs grep -l 'invoke\|skill' 2>/dev/null
```

If it does not exist, create `/workspaces/three.ws/api/agents/[id]/skill-invoke.js`:

```javascript
// POST /api/agents/{id}/skill-invoke (or skills/invoke based on Vercel routing)
// Invokes an agent skill by name with args.
// This is how the chat UI calls agent skills from client-side tool bodies.

export default wrap(async (req, res) => {
  cors(req, res);
  method(req, 'POST');
  
  const auth = await resolveAuth(req);
  if (!auth) return error(res, 401, 'unauthorized', 'Login required');
  
  const agentId = req.query?.id;
  const [agent] = await sql`SELECT * FROM agent_identities WHERE id=${agentId}`;
  if (!agent) return error(res, 404, 'not_found', 'Agent not found');
  
  // Only the agent owner can invoke skills
  if (agent.owner_id !== auth.userId) return error(res, 403, 'forbidden', 'Not your agent');
  
  const { skill: skillName, args = {} } = await readJson(req);
  
  // Load skill registry and execute
  const { getSkillRegistry } = await import('../../../src/agent-skills.js');
  const registry = getSkillRegistry();
  const skill = registry.get(skillName);
  if (!skill) return error(res, 404, 'skill_not_found', \`Unknown skill: \${skillName}\`);
  
  try {
    const result = await skill.execute({ agentId, userId: auth.userId, args });
    return json(res, 200, result);
  } catch (err) {
    return error(res, 400, 'skill_error', err.message);
  }
});
```

If a skill invoke endpoint already exists, use that instead.

## File Checklist
- [ ] `/workspaces/three.ws/chat/src/tools.js` — `gmgnToolSchema` added with 5 tools
- [ ] `gmgnToolSchema` registered in `curatedToolPacks`
- [ ] `/workspaces/three.ws/chat/src/App.svelte` — gmgn tool schema wired
- [ ] `/workspaces/three.ws/api/agents/[id]/skill-invoke.js` (if doesn't exist)

## Verification
1. `grep -n 'gmgnTrending\|gmgnWalletAnalysis\|gmgnTokenSignals\|gmgnCopyTradeEnable\|gmgnCopyTradeStatus' /workspaces/three.ws/chat/src/tools.js` — should find all 5 tools
2. `grep -n 'gmgn-smart-money\|gmgnToolSchema' /workspaces/three.ws/chat/src/tools.js`
3. `grep -n 'gmgnToolSchema' /workspaces/three.ws/chat/src/App.svelte`
