# Prompt 38 — Smart Money Scanner API

## Goal
Build a smart money scanner: API routes that expose GMGN smart wallet data, a signal processor/normalizer, and new MCP tools for the pump.fun MCP server.

## Environment
- Working directory: `/workspaces/three.ws`
- GMGN client: `/workspaces/three.ws/api/_lib/gmgn.js` (prompt 37) → `getGmgnClient()`
- GMGN parser: `/workspaces/three.ws/src/kol/gmgn-parser.js` — already parses wallet lists
- KOL wallets: `/workspaces/three.ws/src/kol/wallets.js` — existing wallet list
- HTTP helpers: `/workspaces/three.ws/api/_lib/http.js`
- Auth: `/workspaces/three.ws/api/_lib/auth.js`
- Rate limiting: `/workspaces/three.ws/api/_lib/rate-limit.js`
- pump.fun MCP server: find with `ls /workspaces/three.ws/workers/` and `ls /workspaces/three.ws/api/_mcp/`

## Read First
1. `ls /workspaces/three.ws/workers/` or `ls /workspaces/three.ws/api/_mcp/` — find the MCP server files
2. `/workspaces/three.ws/src/pump/mcp-tools.js` — understand existing pump MCP tool registration
3. `/workspaces/three.ws/src/kol/gmgn-parser.js` — understand existing normalization
4. `/workspaces/three.ws/api/_lib/rate-limit.js` — understand rate limit helpers
5. Check if `/workspaces/three.ws/api/kol/` or `/workspaces/three.ws/api/gmgn/` exist already

## Task 1 — Smart Money API Routes

Create `/workspaces/three.ws/api/gmgn/smart-money.js`:

```javascript
// Smart money API — proxies GMGN data with caching and normalization.
// Routes (via [action] pattern):
//   GET /api/gmgn/trending               — top tokens by smart money inflow
//   GET /api/gmgn/wallet/{address}        — analyze a specific wallet
//   GET /api/gmgn/token/{mint}            — smart money signals for a token
//
// CF note: GMGN blocks datacenters. Responses are cached aggressively.
// If GMGN calls fail, return cached data or a graceful empty response.

import { getGmgnClient } from '../_lib/gmgn.js';
import { json, error, cors, method } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { processSmartMoneySignal, rankSignals } from '../../src/kol/smart-money-processor.js';

// In-memory cache: Map<cacheKey, { data, fetchedAt }>
const cache = new Map();

function getCached(key, ttlMs) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.fetchedAt < ttlMs) return entry.data;
  return null;
}

function setCached(key, data) {
  cache.set(key, { data, fetchedAt: Date.now() });
}

export default async function handler(req, res) {
  cors(req, res);
  
  // Rate limit: 30/min per IP
  const ip = clientIp(req);
  const allowed = await limits.check(`gmgn:${ip}`, 30, 60);
  if (!allowed) return error(res, 429, 'rate_limited', 'Too many requests');

  const action = req.query?.action;
  const address = req.query?.address;
  const mint = req.query?.mint;

  if (action === 'trending' || (!action && !address && !mint)) {
    return handleTrending(req, res);
  }
  if (action === 'wallet' && address) {
    return handleWallet(req, res, address);
  }
  if (action === 'token' && mint) {
    return handleToken(req, res, mint);
  }
  return error(res, 400, 'bad_request', 'Use ?action=trending|wallet|token with address/mint');
}
```

Route this via the URL pattern `/api/gmgn/[action].js` or a single file with query routing. Create the file at `/workspaces/three.ws/api/gmgn/smart-money.js` and use Vercel routing.

**Trending handler:**
```javascript
async function handleTrending(req, res) {
  method(req, 'GET');
  const cacheKey = 'gmgn:trending';
  
  const cached = getCached(cacheKey, 60_000); // 60s TTL
  if (cached) return json(res, 200, cached);

  try {
    const client = getGmgnClient();
    const raw = await client.getTrendingTokens({ chain: 'sol', window: '1h', limit: 20 });
    const signals = (raw?.data || raw || []).map(processSmartMoneySignal).filter(Boolean);
    const ranked = rankSignals(signals);
    const result = { tokens: ranked, fetchedAt: new Date().toISOString(), source: 'gmgn' };
    setCached(cacheKey, result);
    return json(res, 200, result);
  } catch (err) {
    console.warn('[gmgn/trending]', err.message);
    // Return empty gracefully — don't fail the request
    return json(res, 200, { tokens: [], fetchedAt: new Date().toISOString(), error: err.message });
  }
}
```

**Wallet handler:**
```javascript
async function handleWallet(req, res, address) {
  method(req, 'GET');
  const cacheKey = `gmgn:wallet:${address}`;
  
  const cached = getCached(cacheKey, 60_000);
  if (cached) return json(res, 200, cached);

  try {
    const client = getGmgnClient();
    const [trades, holdings] = await Promise.allSettled([
      client.getWalletTrades(address, { chain: 'sol', limit: 50 }),
      client.getWalletHoldings(address, { chain: 'sol' }),
    ]);

    const tradesData = trades.status === 'fulfilled' ? trades.value : null;
    const holdingsData = holdings.status === 'fulfilled' ? holdings.value : null;

    // Normalize trades
    const tradeList = (tradesData?.data || []).map(t => ({
      type: t.event_type === 'buy' ? 'buy' : 'sell',
      mint: t.token_address,
      symbol: t.token_symbol,
      amountUsd: Number(t.cost_usd || 0),
      timestamp: new Date(t.timestamp * 1000).toISOString(),
    }));

    const result = {
      address,
      trades: tradeList,
      holdings: holdingsData?.data || [],
      fetchedAt: new Date().toISOString(),
    };
    setCached(cacheKey, result);
    return json(res, 200, result);
  } catch (err) {
    console.warn('[gmgn/wallet]', err.message);
    return json(res, 200, { address, trades: [], holdings: [], error: err.message });
  }
}
```

**Token handler:**
```javascript
async function handleToken(req, res, mint) {
  method(req, 'GET');
  const cacheKey = `gmgn:token:${mint}`;
  
  const cached = getCached(cacheKey, 60_000);
  if (cached) return json(res, 200, cached);

  try {
    const client = getGmgnClient();
    const raw = await client.getTokenSignals(mint, { chain: 'sol' });
    const signals = (raw?.data || []).map(processSmartMoneySignal).filter(Boolean);
    const ranked = rankSignals(signals);
    const result = { mint, signals: ranked, fetchedAt: new Date().toISOString() };
    setCached(cacheKey, result);
    return json(res, 200, result);
  } catch (err) {
    console.warn('[gmgn/token]', err.message);
    return json(res, 200, { mint, signals: [], error: err.message });
  }
}
```

## Task 2 — Signal Processor

Create `/workspaces/three.ws/src/kol/smart-money-processor.js`:

```javascript
// @ts-check
/**
 * Normalize and rank GMGN smart money signals.
 * Raw GMGN data varies by endpoint; this module produces a consistent format.
 */

/**
 * @typedef {Object} SmartMoneySignal
 * @property {'buy'|'sell'} type
 * @property {string}  mint        — token mint address
 * @property {string}  [symbol]    — token symbol if known
 * @property {string}  wallet      — wallet address
 * @property {number}  amountUsd
 * @property {number}  confidence  — 0 to 1, based on wallet reputation + recency
 * @property {number}  timestamp   — unix ms
 * @property {string}  source      — 'gmgn'
 */

/**
 * Normalize a raw GMGN API entry into a SmartMoneySignal.
 * Handles multiple response shapes from different endpoints.
 * @param {object} raw
 * @returns {SmartMoneySignal|null}
 */
export function processSmartMoneySignal(raw) {
  if (!raw) return null;

  // Detect event type
  const type = raw.event_type === 'buy' || raw.side === 'buy' || raw.type === 'buy'
    ? 'buy'
    : raw.event_type === 'sell' || raw.side === 'sell' || raw.type === 'sell'
    ? 'sell'
    : null;
  if (!type) return null;

  const mint = raw.token_address || raw.mint || raw.contract_address;
  if (!mint) return null;

  const wallet = raw.maker || raw.wallet_address || raw.address || raw.user_address;
  const amountUsd = Number(raw.cost_usd || raw.value_usd || raw.usd_amount || 0);
  const timestamp = raw.timestamp
    ? (raw.timestamp > 1e12 ? raw.timestamp : raw.timestamp * 1000)
    : Date.now();

  // Confidence: higher for bigger trades and more recent events
  const ageMinutes = (Date.now() - timestamp) / 60_000;
  const recencyScore = Math.max(0, 1 - ageMinutes / (60 * 24)); // decays over 24h
  const sizeScore = Math.min(1, amountUsd / 10_000);             // maxes at $10k
  const confidence = +(recencyScore * 0.6 + sizeScore * 0.4).toFixed(4);

  return {
    type,
    mint,
    symbol: raw.token_symbol || raw.symbol,
    wallet: wallet || 'unknown',
    amountUsd,
    confidence,
    timestamp,
    source: 'gmgn',
  };
}

/**
 * Sort signals by confidence × recency, descending.
 * @param {SmartMoneySignal[]} signals
 * @returns {SmartMoneySignal[]}
 */
export function rankSignals(signals) {
  return [...signals].sort((a, b) => b.confidence - a.confidence);
}

/**
 * Aggregate multiple signals for one token into a net score.
 * Returns positive score for net buying pressure, negative for selling.
 * @param {SmartMoneySignal[]} signals — all signals for one mint
 * @returns {{ mint: string, score: number, buyVolume: number, sellVolume: number, signalCount: number }}
 */
export function aggregateTokenSignals(signals) {
  if (!signals.length) return { mint: '', score: 0, buyVolume: 0, sellVolume: 0, signalCount: 0 };
  
  const mint = signals[0].mint;
  let buyVolume = 0, sellVolume = 0;
  
  for (const s of signals) {
    if (s.type === 'buy') buyVolume += s.amountUsd * s.confidence;
    else sellVolume += s.amountUsd * s.confidence;
  }
  
  const total = buyVolume + sellVolume;
  const score = total > 0 ? (buyVolume - sellVolume) / total : 0;
  
  return {
    mint,
    score: +score.toFixed(4),
    buyVolume: +buyVolume.toFixed(2),
    sellVolume: +sellVolume.toFixed(2),
    signalCount: signals.length,
  };
}
```

## Task 3 — MCP Server Tools

Find the pump.fun MCP server. Check:
- `ls /workspaces/three.ws/workers/pump-fun-mcp/`
- `ls /workspaces/three.ws/src/pump/mcp-tools.js`
- `grep -r 'mcp' /workspaces/three.ws/api/_mcp/ --include='*.js' -l`

Read the MCP server file to understand tool registration format, then add two new tools:

**Tool 1: `getSmartMoneySignals`**
```javascript
{
  name: 'getSmartMoneySignals',
  description: 'Get smart money buy/sell signals for a pump.fun token, ranked by confidence',
  inputSchema: {
    type: 'object',
    properties: {
      mint: { type: 'string', description: 'Token mint address' },
      limit: { type: 'number', description: 'Max signals to return (default 10)' },
    },
    required: ['mint'],
  },
  handler: async ({ mint, limit = 10 }) => {
    // Fetch from GMGN
    const client = getGmgnClient();
    const raw = await client.getTokenSignals(mint, { chain: 'sol' });
    const signals = (raw?.data || []).map(processSmartMoneySignal).filter(Boolean);
    const ranked = rankSignals(signals).slice(0, limit);
    const aggregate = aggregateTokenSignals(signals);
    return { signals: ranked, aggregate, mint };
  },
}
```

**Tool 2: `getSmartWalletActivity`**
```javascript
{
  name: 'getSmartWalletActivity',
  description: 'Full analysis of a smart money wallet: recent trades, holdings, and performance',
  inputSchema: {
    type: 'object',
    properties: {
      address: { type: 'string', description: 'Solana wallet address' },
    },
    required: ['address'],
  },
  handler: async ({ address }) => {
    const client = getGmgnClient();
    const [trades, holdings] = await Promise.allSettled([
      client.getWalletTrades(address, { limit: 20 }),
      client.getWalletHoldings(address),
    ]);
    return {
      address,
      trades: trades.status === 'fulfilled' ? trades.value?.data || [] : [],
      holdings: holdings.status === 'fulfilled' ? holdings.value?.data || [] : [],
    };
  },
}
```

Add these to the MCP server's tool registry, following exactly how existing tools are registered.

## File Checklist
- [ ] `/workspaces/three.ws/api/gmgn/smart-money.js`
- [ ] `/workspaces/three.ws/src/kol/smart-money-processor.js`
- [ ] MCP server updated with 2 new tools (find the correct file first)

## Verification
1. `node -e "import('./src/kol/smart-money-processor.js').then(m => { const s = m.processSmartMoneySignal({event_type:'buy',token_address:'ABC',maker:'W',cost_usd:100,timestamp:Math.floor(Date.now()/1000)}); console.log(s); })"` from `/workspaces/three.ws`
2. `grep -n 'getSmartMoneySignals' /workspaces/three.ws/src/pump/mcp-tools.js` (or wherever MCP tools live)
3. `node -e "import('./api/gmgn/smart-money.js').then(m => console.log(typeof m.default))"` from `/workspaces/three.ws`
