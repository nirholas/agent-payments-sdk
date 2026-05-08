# Prompt 28 — Chat Alert Tools & Price Stream WebSocket

## Goal
1. Add four new pump.fun price-alert tools to the three.ws chat (`tools.js`).
2. Create a real-time price ticker WebSocket endpoint `/api/pump/price-stream.js`.

## Environment
- Working directory: `/workspaces/three.ws`
- Chat tools file: `/workspaces/three.ws/chat/src/tools.js`
- Pump API file: `/workspaces/three.ws/api/pump/[action].js`
- Alert API: `/workspaces/three.ws/api/alerts/[action].js` (created in prompt 27)
- BondingCurveFeed: `/workspaces/three.ws/src/pump/bonding-curve-feed.js` (prompt 26)
- HTTP helpers: `/workspaces/three.ws/api/_lib/http.js`
- Auth: `/workspaces/three.ws/api/_lib/auth.js`

## Task 1 — Read tools.js and understand the schema format

Before editing, read `/workspaces/three.ws/chat/src/tools.js`. Understand:
- How `curatedToolPacks` is structured (array of `{ id, name, description, schema }`)
- How `schema` entries work: each is `{ type: 'function', function: { name, description, parameters }, clientDefinition?: {...} }`
- Where the pumpfun tool pack is defined (search for `pumpfunBuy` or `pump`)

## Task 2 — Add pumpfun alert/price tools

Find the pump.fun tool pack in `tools.js`. Add four new entries to its `schema` array:

### Tool 1: `pumpfunSetAlert`
```json
{
  "type": "function",
  "function": {
    "name": "pumpfunSetAlert",
    "description": "Set a price alert for a pump.fun coin. Alerts trigger when the coin hits the specified price target, percent gain/loss, or graduates to AMM.",
    "parameters": {
      "type": "object",
      "properties": {
        "mint": {
          "type": "string",
          "description": "The pump.fun coin mint address (base58)"
        },
        "alertType": {
          "type": "string",
          "enum": ["price_above", "price_below", "gain_pct", "loss_pct", "graduation"],
          "description": "Type of alert: price_above/price_below use absolute USD price, gain_pct/loss_pct use % from current price, graduation fires when coin completes bonding curve"
        },
        "threshold": {
          "type": "number",
          "description": "Target price in USD (for price_above/price_below) or percent (for gain_pct/loss_pct). Not required for graduation."
        },
        "notifyTelegram": {
          "type": "boolean",
          "description": "If true, send a Telegram notification when triggered (requires user's Telegram to be linked)"
        }
      },
      "required": ["mint", "alertType"]
    }
  }
}
```

**Client-side execution body** (`clientDefinition.body`):
```javascript
const body = { mint: args.mint, alertType: args.alertType };
if (args.threshold != null) body.threshold = args.threshold;
if (args.notifyTelegram != null) body.notifyTelegram = args.notifyTelegram;
const resp = await fetch('/api/alerts/create', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  credentials: 'include',
  body: JSON.stringify(body),
});
if (!resp.ok) {
  const err = await resp.json().catch(() => ({}));
  throw new Error(err.error_description || `Alert creation failed: ${resp.status}`);
}
const data = await resp.json();
const condMap = {
  price_above: `reaches $${args.threshold}`,
  price_below: `drops to $${args.threshold}`,
  gain_pct: `gains ${args.threshold}%`,
  loss_pct: `loses ${args.threshold}%`,
  graduation: 'graduates to AMM',
};
return { alertId: data.id, message: `Alert set: notify when ${args.mint.slice(0,8)}... ${condMap[args.alertType] || args.alertType}` };
```

### Tool 2: `pumpfunListAlerts`
```json
{
  "type": "function",
  "function": {
    "name": "pumpfunListAlerts",
    "description": "List all active price alerts for the current user.",
    "parameters": {
      "type": "object",
      "properties": {}
    }
  }
}
```

**Client-side execution body:**
```javascript
const resp = await fetch('/api/alerts/list?active=true', { credentials: 'include' });
if (!resp.ok) throw new Error(`Failed to fetch alerts: ${resp.status}`);
const { alerts } = await resp.json();
if (!alerts || alerts.length === 0) return { alerts: [], summary: 'No active alerts.' };
const rows = alerts.map(a => {
  const cond = a.alert_type === 'graduation'
    ? 'graduation'
    : `${a.alert_type} ${a.threshold}`;
  return `• ${a.mint.slice(0,8)}... | ${cond} | set ${new Date(a.created_at).toLocaleDateString()}`;
});
return { alerts, summary: `${alerts.length} active alert(s):\n${rows.join('\n')}` };
```

### Tool 3: `pumpfunCancelAlert`
```json
{
  "type": "function",
  "function": {
    "name": "pumpfunCancelAlert",
    "description": "Cancel (deactivate) a price alert by its ID.",
    "parameters": {
      "type": "object",
      "properties": {
        "alertId": {
          "type": "string",
          "description": "The alert ID returned by pumpfunSetAlert or pumpfunListAlerts"
        }
      },
      "required": ["alertId"]
    }
  }
}
```

**Client-side execution body:**
```javascript
const resp = await fetch(`/api/alerts/delete?id=${encodeURIComponent(args.alertId)}`, {
  method: 'DELETE',
  credentials: 'include',
});
if (!resp.ok) {
  const err = await resp.json().catch(() => ({}));
  throw new Error(err.error_description || `Cancel failed: ${resp.status}`);
}
return { cancelled: true, alertId: args.alertId };
```

### Tool 4: `pumpfunLivePrice`
```json
{
  "type": "function",
  "function": {
    "name": "pumpfunLivePrice",
    "description": "Get the current live price, market cap, and bonding curve info for a pump.fun coin.",
    "parameters": {
      "type": "object",
      "properties": {
        "mint": {
          "type": "string",
          "description": "The pump.fun coin mint address (base58)"
        }
      },
      "required": ["mint"]
    }
  }
}
```

**Client-side execution body:**
```javascript
const url = `/api/pump/quote?mint=${encodeURIComponent(args.mint)}&action=quote`;
const resp = await fetch(url, { credentials: 'include' });
if (!resp.ok) {
  // Fallback: try bonding curve direct
  const bcResp = await fetch(`/api/pump/curve?mint=${encodeURIComponent(args.mint)}`);
  if (!bcResp.ok) throw new Error(`Price fetch failed: ${resp.status}`);
  const bc = await bcResp.json();
  return bc;
}
const data = await resp.json();
return {
  mint: args.mint,
  price: data.price || data.amountOut,
  priceUsd: data.priceUsd || data.price,
  marketCap: data.marketCap,
  quoteMint: data.quoteMint,
  route: data.route,
  complete: data.complete,
};
```

## Task 3 — Price Stream WebSocket Endpoint

Create `/workspaces/three.ws/api/pump/price-stream.js`.

Vercel does not natively support WebSocket upgrades in serverless functions. Use this approach:
- Export a default handler that responds to regular HTTP with an SSE (Server-Sent Events) stream — this is what Vercel supports for real-time push.
- Clients connect with `EventSource('/api/pump/price-stream?mints=MINT1,MINT2')`.
- Server streams `data: {...}\n\n` JSON events.

```javascript
// /workspaces/three.ws/api/pump/price-stream.js
// SSE endpoint — streams bonding curve price updates.
//
// GET /api/pump/price-stream?mints=MINT1,MINT2,...
// Streams: data: { mint, price, priceUsd, change, complete, updatedAt }\n\n
// Max 20 mints per connection.

import { globalFeed } from '../../src/pump/bonding-curve-feed.js';
import { cors } from '../_lib/http.js';

const MAX_MINTS = 20;
const PING_INTERVAL_MS = 25_000;

export default function handler(req, res) {
  cors(req, res);

  const rawMints = String(req.query?.mints || '').trim();
  if (!rawMints) {
    res.statusCode = 400;
    res.end('mints query param required');
    return;
  }

  const mints = rawMints.split(',').map(s => s.trim()).filter(Boolean).slice(0, MAX_MINTS);
  if (mints.length === 0) {
    res.statusCode = 400;
    res.end('no valid mints');
    return;
  }

  // SSE headers
  res.statusCode = 200;
  res.setHeader('content-type', 'text/event-stream');
  res.setHeader('cache-control', 'no-cache, no-transform');
  res.setHeader('x-accel-buffering', 'no'); // disable nginx buffering
  res.setHeader('connection', 'keep-alive');

  // Send initial connected event
  res.write(`event: connected\ndata: ${JSON.stringify({ mints, ts: Date.now() })}\n\n`);

  // Price update handler
  const lastPrices = new Map();
  function onUpdate(update) {
    const prev = lastPrices.get(update.mint);
    const change = prev != null ? (update.priceUsd - prev) / prev * 100 : 0;
    lastPrices.set(update.mint, update.priceUsd);
    const payload = {
      mint: update.mint,
      price: update.price,
      priceUsd: update.priceUsd,
      change: +change.toFixed(4),
      complete: update.complete,
      updatedAt: update.updatedAt,
    };
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  // Subscribe to feed
  const unsubscribe = globalFeed.subscribeMultiple(mints, onUpdate);

  // Keep-alive ping
  const ping = setInterval(() => {
    res.write(`: ping ${Date.now()}\n\n`);
  }, PING_INTERVAL_MS);

  // Clean up on client disconnect
  req.on('close', () => {
    clearInterval(ping);
    unsubscribe();
  });
  req.on('error', () => {
    clearInterval(ping);
    unsubscribe();
  });
}
```

## Task 4 — Wire clientDefinitions into tools.js

Each new tool entry in tools.js must include a `clientDefinition` property alongside the `function` property, following the existing pattern in `curatedToolPacks`. The `clientDefinition` has:
```json
{
  "id": "pump-set-alert-001",
  "name": "pumpfunSetAlert",
  "description": "...",
  "arguments": [ { "name": "mint", "type": "string", "description": "..." }, ... ],
  "body": "... JS string ..."
}
```

Read the existing pump.fun tool pack to see exactly how other tools wire `clientDefinition` + `function`, then follow the same pattern.

## File Checklist
- [ ] `/workspaces/three.ws/chat/src/tools.js` — 4 new tools added to pumpfun pack
- [ ] `/workspaces/three.ws/api/pump/price-stream.js` — SSE price stream

## Verification
1. `grep -n 'pumpfunSetAlert' /workspaces/three.ws/chat/src/tools.js` — should find the new tool
2. `node -e "import('/workspaces/three.ws/api/pump/price-stream.js').then(m => console.log(typeof m.default))"` — should print `function`
