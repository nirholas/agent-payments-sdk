# Prompt 39 — GMGN Smart Money Context Injection into LLM

## Goal
Inject GMGN smart money signals into the three.ws agent's LLM context so Claude can make informed, data-driven responses about pump.fun tokens. Signals are fetched per-request (cached 30s) and inserted as a structured section in the system prompt.

## Environment
- Working directory: `/workspaces/three.ws`
- GMGN client: `/workspaces/three.ws/api/_lib/gmgn.js` (prompt 37)
- Signal processor: `/workspaces/three.ws/src/kol/smart-money-processor.js` (prompt 38)
- Chat API: find with `ls /workspaces/three.ws/api/chat.js` or `ls /workspaces/three.ws/api/chat/`
- Tools: `/workspaces/three.ws/chat/src/tools.js`
- Agent identity: look for system prompt building in the chat API handler

## Read First (Critical)
1. Read the chat API handler to find where system prompts are built:
   ```bash
   cat /workspaces/three.ws/api/chat.js 2>/dev/null | head -100
   # OR
   ls /workspaces/three.ws/api/chat/
   ```
2. Find where `systemPrompt` or `system` is constructed — grep for it:
   ```bash
   grep -n 'systemPrompt\|system_prompt\|system:' /workspaces/three.ws/api/chat.js
   ```
3. Read `/workspaces/three.ws/src/kol/radar.js` — understand how existing market signals are fetched and used
4. Read `/workspaces/three.ws/api/_lib/llm.js` or similar LLM wrapper if it exists

## Task 1 — Context Builder

Create `/workspaces/three.ws/src/agent-context-gmgn.js`:

```javascript
// @ts-check
/**
 * buildGmgnContext — Build a GMGN market intelligence section for LLM system prompts.
 *
 * Injected as "[MARKET INTELLIGENCE]" block in the system prompt when:
 *   - User message mentions a token/mint
 *   - Always: top trending tokens by smart money (3 entries)
 *
 * Caching:
 *   - Per-token: 30 seconds
 *   - Trending: 60 seconds
 *   - All caching is module-level (in-process, per warm serverless instance)
 */

import { getGmgnClient } from '../api/_lib/gmgn.js';
import { processSmartMoneySignal, aggregateTokenSignals, rankSignals } from './kol/smart-money-processor.js';

// ── Cache ─────────────────────────────────────────────────────────────────────
const _tokenCache = new Map(); // mint → { data, ts }
const _trendingCache = { data: null, ts: 0 };

function tokenCached(mint) {
  const e = _tokenCache.get(mint);
  return e && Date.now() - e.ts < 30_000 ? e.data : null;
}
function setTokenCached(mint, data) {
  _tokenCache.set(mint, { data, ts: Date.now() });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Extract Solana mint addresses from a text string.
 * Solana addresses are 32-44 base58 characters.
 * @param {string} text
 * @returns {string[]}
 */
function extractMints(text) {
  const base58Pattern = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
  const candidates = text.match(base58Pattern) || [];
  // Filter out obviously wrong matches (too short words, URLs, etc.)
  return [...new Set(candidates.filter(c => c.length >= 32))];
}

/**
 * Fetch GMGN signals for a single mint.
 * Returns null on error (fail silently — don't break the chat pipeline).
 */
async function fetchTokenSignals(mint) {
  const cached = tokenCached(mint);
  if (cached) return cached;

  try {
    const client = getGmgnClient();
    const raw = await client.getTokenSignals(mint, { chain: 'sol' });
    const signals = (raw?.data || []).map(processSmartMoneySignal).filter(Boolean);
    const aggregate = aggregateTokenSignals(signals);
    const topBuyers = rankSignals(signals.filter(s => s.type === 'buy')).slice(0, 3);
    const topSellers = rankSignals(signals.filter(s => s.type === 'sell')).slice(0, 3);
    const data = { mint, aggregate, topBuyers, topSellers, signalCount: signals.length };
    setTokenCached(mint, data);
    return data;
  } catch {
    return null;
  }
}

/**
 * Fetch trending tokens by smart money inflow.
 */
async function fetchTrending() {
  if (_trendingCache.data && Date.now() - _trendingCache.ts < 60_000) {
    return _trendingCache.data;
  }
  try {
    const client = getGmgnClient();
    const raw = await client.getTrendingTokens({ chain: 'sol', window: '1h', limit: 3 });
    const tokens = (raw?.data || raw || []).slice(0, 3).map(t => ({
      mint: t.token_address || t.mint,
      symbol: t.symbol || t.token_symbol || 'UNKNOWN',
      smartMoneyVolume: Number(t.smart_money_volume || t.volume || 0),
      priceChange1h: Number(t.price_change_1h || 0),
    }));
    _trendingCache.data = tokens;
    _trendingCache.ts = Date.now();
    return tokens;
  } catch {
    return [];
  }
}

// ── Main Export ───────────────────────────────────────────────────────────────

/**
 * Build the GMGN market intelligence context string for injection into system prompt.
 *
 * @param {string} agentId   — agent ID (for future per-agent context customization)
 * @param {string} [userMessage]    — latest user message (to detect mentioned tokens)
 * @param {string[]} [conversationMints] — mints already discussed in conversation history
 * @returns {Promise<string>}  — context string, empty if nothing relevant
 */
export async function buildGmgnContext(agentId, userMessage = '', conversationMints = []) {
  const parts = [];

  // Fetch trending + per-token signals in parallel
  const mentionedMints = extractMints(userMessage);
  const allMints = [...new Set([...mentionedMints, ...conversationMints])].slice(0, 5);

  const [trending, ...tokenSignals] = await Promise.allSettled([
    fetchTrending(),
    ...allMints.map(fetchTokenSignals),
  ]);

  const trendingTokens = trending.status === 'fulfilled' ? trending.value : [];

  // Section 1: Trending tokens
  if (trendingTokens.length > 0) {
    parts.push('TRENDING (last 1h by smart money inflow):');
    for (const t of trendingTokens) {
      const changeStr = t.priceChange1h >= 0 ? `+${t.priceChange1h.toFixed(1)}%` : `${t.priceChange1h.toFixed(1)}%`;
      parts.push(`  - ${t.symbol} (${t.mint?.slice(0,8)}...) vol=$${t.smartMoneyVolume.toFixed(0)} ${changeStr}`);
    }
  }

  // Section 2: Per-token analysis for mentioned tokens
  for (let i = 0; i < allMints.length; i++) {
    const result = tokenSignals[i];
    if (result?.status !== 'fulfilled' || !result.value) continue;
    const { mint, aggregate, topBuyers, topSellers, signalCount } = result.value;

    if (signalCount === 0) continue;

    const sentiment = aggregate.score > 0.2 ? 'BULLISH' : aggregate.score < -0.2 ? 'BEARISH' : 'NEUTRAL';
    parts.push(`\nTOKEN ${mint.slice(0,8)}... smart money: ${sentiment} (score=${aggregate.score.toFixed(2)}, ${signalCount} signals)`);
    parts.push(`  buy_vol=$${aggregate.buyVolume.toFixed(0)} sell_vol=$${aggregate.sellVolume.toFixed(0)}`);

    if (topBuyers.length > 0) {
      parts.push(`  top buyers: ${topBuyers.map(s => `${s.wallet.slice(0,6)}... $${s.amountUsd.toFixed(0)}`).join(', ')}`);
    }
    if (topSellers.length > 0) {
      parts.push(`  top sellers: ${topSellers.map(s => `${s.wallet.slice(0,6)}... $${s.amountUsd.toFixed(0)}`).join(', ')}`);
    }
  }

  if (parts.length === 0) return '';

  return `\n[MARKET INTELLIGENCE - GMGN Smart Money Feed]\n${parts.join('\n')}\n[END MARKET INTELLIGENCE]`;
}
```

## Task 2 — Wire into Chat API System Prompt

Read the chat API file carefully. Find the system prompt construction. Insert the GMGN context.

```javascript
// In the chat handler (wherever systemPrompt is built):
import { buildGmgnContext } from '../src/agent-context-gmgn.js';

// Inside the request handler, after resolving agent identity:
let marketContext = '';
try {
  // Extract mints already in conversation history
  const allMessages = messages.map(m => typeof m.content === 'string' ? m.content : '').join(' ');
  const userMsg = messages.filter(m => m.role === 'user').at(-1)?.content || '';
  const historyMints = allMessages.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) || [];
  marketContext = await buildGmgnContext(agentId, userMsg, historyMints);
} catch (err) {
  // Never let GMGN errors break the chat pipeline
  console.warn('[chat] GMGN context failed:', err.message);
}

// Append to system prompt
const finalSystemPrompt = systemPrompt + marketContext;
```

Important: this must never break the chat if GMGN is unavailable. All errors are caught and result in empty context.

## Task 3 — pumpfunSmartMoney Chat Tool

Add to `/workspaces/three.ws/chat/src/tools.js` — in the pumpfun tool pack, add:

```json
{
  "type": "function",
  "function": {
    "name": "pumpfunSmartMoney",
    "description": "Query GMGN smart money signals: trending tokens, whale analysis, or smart money activity for a specific token.",
    "parameters": {
      "type": "object",
      "properties": {
        "mint": {
          "type": "string",
          "description": "Token mint address to analyze (optional — if omitted, shows trending)"
        },
        "query": {
          "type": "string",
          "description": "Natural language query: 'trending', 'who is buying X', 'whale analysis for X'"
        }
      }
    }
  }
}
```

**Client-side execution body:**
```javascript
let url;
if (args.mint) {
  url = `/api/gmgn/smart-money?action=token&mint=${encodeURIComponent(args.mint)}`;
} else {
  url = `/api/gmgn/smart-money?action=trending`;
}

const resp = await fetch(url, { credentials: 'include' });
if (!resp.ok) return { error: `GMGN API unavailable (${resp.status})`, tokens: [] };
const data = await resp.json();

if (args.mint && data.signals) {
  const { signals, aggregate } = data;
  const sentiment = aggregate?.score > 0.2 ? 'BULLISH' : aggregate?.score < -0.2 ? 'BEARISH' : 'NEUTRAL';
  return {
    mint: args.mint,
    sentiment,
    score: aggregate?.score,
    buyVolume: aggregate?.buyVolume,
    sellVolume: aggregate?.sellVolume,
    signals: signals.slice(0, 5),
    summary: `Smart money is ${sentiment.toLowerCase()} on this token. Buy volume: $${(aggregate?.buyVolume||0).toFixed(0)}, Sell volume: $${(aggregate?.sellVolume||0).toFixed(0)}`,
  };
}

return {
  trending: (data.tokens || []).slice(0, 10),
  summary: `Top ${(data.tokens||[]).length} tokens by smart money inflow in the last 1 hour`,
};
```

## File Checklist
- [ ] `/workspaces/three.ws/src/agent-context-gmgn.js`
- [ ] Chat API file (`/workspaces/three.ws/api/chat.js` or similar) — GMGN context injected
- [ ] `/workspaces/three.ws/chat/src/tools.js` — `pumpfunSmartMoney` tool added

## Verification
1. `node -e "import('./src/agent-context-gmgn.js').then(m => console.log(typeof m.buildGmgnContext))"` from `/workspaces/three.ws` — prints `function`
2. `grep -n 'buildGmgnContext\|MARKET INTELLIGENCE' /workspaces/three.ws/api/chat.js` (or chat handler)
3. `grep -n 'pumpfunSmartMoney' /workspaces/three.ws/chat/src/tools.js`
4. Test context building: `node -e "import('./src/agent-context-gmgn.js').then(async m => { const ctx = await m.buildGmgnContext('test', 'what about EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'); console.log(ctx || '(empty — GMGN unavailable in this env)'); })"`
