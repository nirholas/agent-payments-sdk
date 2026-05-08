# Prompt 42 — GMGN Smart Money Alert Notifications

## Goal
Build a system for users to watch specific smart wallets and get notified (Telegram + in-chat) when those wallets make significant moves on pump.fun.

## Environment
- Working directory: `/workspaces/three.ws`
- GMGN client: `/workspaces/three.ws/api/_lib/gmgn.js` (prompt 37)
- Signal processor: `/workspaces/three.ws/src/kol/smart-money-processor.js` (prompt 38)
- DB: `/workspaces/three.ws/api/_lib/db.js`
- Auth: `/workspaces/three.ws/api/_lib/auth.js`
- HTTP helpers: `/workspaces/three.ws/api/_lib/http.js`
- Rate limiting: `/workspaces/three.ws/api/_lib/rate-limit.js`
- Telegram delivery: `/workspaces/three.ws/src/pump/telegram-delivery.js`
- Cron pattern: `/workspaces/three.ws/api/cron/distribute-agent-payments.js` (prompt 33)
- Chat tools: `/workspaces/three.ws/chat/src/tools.js`

## Read First
1. `/workspaces/three.ws/src/pump/telegram-delivery.js` — understand `sendTelegramMessage` signature
2. `/workspaces/three.ws/api/cron/distribute-agent-payments.js` — cron pattern
3. `/workspaces/three.ws/api/alerts/[action].js` (prompt 27) — follow the same REST action-routing pattern
4. Check if a user-linked Telegram chat ID is stored in the DB: `grep -r 'telegram_chat_id\|telegram' /workspaces/three.ws/api/ --include='*.js' | head -10`

## Task 1 — DB Migration

Create `/workspaces/three.ws/migrations/gmgn_watched_wallets.sql`:

```sql
-- Wallets that users want to watch for smart money activity
create table if not exists gmgn_watched_wallets (
  id              text primary key default gen_random_uuid()::text,
  user_id         text not null,
  wallet_address  text not null,
  label           text,                         -- optional human-readable label
  min_amount_usd  numeric(12, 2) default 100,   -- only notify for trades above this
  active          boolean default true,
  last_checked_at timestamptz,
  last_trade_at   timestamptz,                  -- timestamp of last seen trade
  created_at      timestamptz default now(),
  
  unique(user_id, wallet_address)
);

create index if not exists gmgn_watched_user_idx   on gmgn_watched_wallets(user_id, active);
create index if not exists gmgn_watched_active_idx on gmgn_watched_wallets(active, last_checked_at);

-- Recent notifications sent to users
create table if not exists gmgn_wallet_notifications (
  id              text primary key default gen_random_uuid()::text,
  user_id         text not null,
  wallet_address  text not null,
  mint            text,
  trade_type      text,
  amount_usd      numeric(12, 2),
  notified_via    text[],                       -- ['telegram', 'chat']
  notified_at     timestamptz default now()
);

create index if not exists gmgn_notif_user_idx on gmgn_wallet_notifications(user_id, notified_at desc);
```

## Task 2 — Watch Wallet REST API

Create `/workspaces/three.ws/api/gmgn/watch-wallet.js`:

Route by `req.query.action`:
- `POST ?action=add` — add wallet to watch list
- `GET ?action=list` — list watched wallets
- `DELETE ?action=remove&id=...` — stop watching

```javascript
// @ts-check
import { sql } from '../_lib/db.js';
import { json, error, readJson, cors } from '../_lib/http.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { limits, clientIp } from '../_lib/rate-limit.js';

async function resolveAuth(req) {
  const session = await getSessionUser(req);
  if (session) return { userId: session.id };
  const bearer = await authenticateBearer(extractBearer(req));
  if (bearer) return { userId: bearer.userId };
  return null;
}

export default async function handler(req, res) {
  cors(req, res);

  const auth = await resolveAuth(req);
  if (!auth) return error(res, 401, 'unauthorized', 'Login required');

  const action = req.query?.action;

  // Rate limit: 60/min per user
  const allowed = await limits.check(`gmgn-watch:${auth.userId}`, 60, 60).catch(() => true);
  if (!allowed) return error(res, 429, 'rate_limited', 'Too many requests');

  switch (action) {
    case 'add':    return handleAdd(req, res, auth);
    case 'list':   return handleList(req, res, auth);
    case 'remove': return handleRemove(req, res, auth);
    default: return error(res, 400, 'bad_request', 'action must be add|list|remove');
  }
}

async function handleAdd(req, res, auth) {
  const body = await readJson(req);
  const { walletAddress, label, minAmountUsd = 100 } = body;
  
  if (!walletAddress || typeof walletAddress !== 'string') {
    return error(res, 400, 'invalid_input', 'walletAddress required');
  }
  if (walletAddress.length < 32 || walletAddress.length > 44) {
    return error(res, 400, 'invalid_address', 'Invalid Solana address');
  }

  // Cap: max 20 watched wallets per user
  const count = await sql`
    SELECT count(*) as n FROM gmgn_watched_wallets
    WHERE user_id = ${auth.userId} AND active = true
  `.then(r => Number(r[0]?.n || 0));
  if (count >= 20) return error(res, 400, 'limit_reached', 'Maximum 20 watched wallets');

  const [row] = await sql`
    INSERT INTO gmgn_watched_wallets (user_id, wallet_address, label, min_amount_usd)
    VALUES (${auth.userId}, ${walletAddress}, ${label || null}, ${minAmountUsd})
    ON CONFLICT (user_id, wallet_address)
    DO UPDATE SET active = true, min_amount_usd = EXCLUDED.min_amount_usd, label = COALESCE(EXCLUDED.label, gmgn_watched_wallets.label)
    RETURNING *
  `;
  return json(res, 200, { watching: true, wallet: row });
}

async function handleList(req, res, auth) {
  const rows = await sql`
    SELECT id, wallet_address, label, min_amount_usd, last_checked_at, last_trade_at, created_at
    FROM gmgn_watched_wallets
    WHERE user_id = ${auth.userId} AND active = true
    ORDER BY created_at DESC
  `;
  return json(res, 200, { wallets: rows });
}

async function handleRemove(req, res, auth) {
  const id = req.query?.id;
  if (!id) return error(res, 400, 'missing_id', 'id query param required');
  
  const result = await sql`
    UPDATE gmgn_watched_wallets
    SET active = false
    WHERE id = ${id} AND user_id = ${auth.userId}
    RETURNING id
  `;
  if (result.length === 0) return error(res, 404, 'not_found', 'Watched wallet not found');
  return json(res, 200, { removed: true, id });
}
```

## Task 3 — Wallet Watcher Cron

Create `/workspaces/three.ws/api/cron/gmgn-wallet-watcher.js`:

```javascript
/**
 * GMGN Wallet Watcher Cron — every 5 minutes
 * For each user's watched wallets:
 *   1. Fetch recent trades from GMGN
 *   2. Detect new trades since last_checked_at
 *   3. If trade > min_amount_usd: send Telegram + in-chat notification
 *   4. Update last_checked_at and last_trade_at
 */

import { sql } from '../_lib/db.js';
import { json, error, cors } from '../_lib/http.js';
import { getGmgnClient } from '../_lib/gmgn.js';
import { processSmartMoneySignal } from '../../src/kol/smart-money-processor.js';

const MAX_WALLETS_PER_RUN = 50;

export default async function handler(req, res) {
  cors(req, res);

  const cronSecret = req.headers['x-cron-secret'] || req.headers['authorization'];
  if (process.env.CRON_SECRET && cronSecret !== `Bearer ${process.env.CRON_SECRET}`) {
    return error(res, 401, 'unauthorized', 'Invalid cron secret');
  }

  const gmgn = getGmgnClient();
  const results = { checked: 0, notified: 0, errors: 0 };

  // Load wallets due for checking (least recently checked first)
  const wallets = await sql`
    SELECT DISTINCT ON (wallet_address)
      w.id, w.user_id, w.wallet_address, w.label, w.min_amount_usd, w.last_trade_at,
      u.telegram_chat_id
    FROM gmgn_watched_wallets w
    LEFT JOIN users u ON u.id = w.user_id
    WHERE w.active = true
    ORDER BY w.wallet_address, w.last_checked_at ASC NULLS FIRST
    LIMIT ${MAX_WALLETS_PER_RUN}
  `.catch(() => []);

  // Group wallets by address to batch GMGN calls
  const addressMap = new Map();
  for (const w of wallets) {
    if (!addressMap.has(w.wallet_address)) {
      addressMap.set(w.wallet_address, []);
    }
    addressMap.get(w.wallet_address).push(w);
  }

  for (const [address, watchers] of addressMap) {
    try {
      // Fetch recent trades
      const raw = await gmgn.getWalletTrades(address, { chain: 'sol', limit: 10 });
      const trades = (raw?.data || []).map(processSmartMoneySignal).filter(Boolean);

      // Find latest trade time across all watchers
      const latestTradeAt = trades.length > 0
        ? new Date(Math.max(...trades.map(t => t.timestamp)))
        : null;

      // Notify watchers with new trades
      for (const watcher of watchers) {
        const sinceTs = watcher.last_trade_at ? new Date(watcher.last_trade_at).getTime() : 0;
        const newTrades = trades.filter(t =>
          t.timestamp > sinceTs &&
          t.amountUsd >= Number(watcher.min_amount_usd || 100)
        );

        for (const trade of newTrades) {
          await notifyWatcher({ watcher, trade, results });
        }

        // Update last_checked_at (and last_trade_at if we saw new trades)
        await sql`
          UPDATE gmgn_watched_wallets
          SET
            last_checked_at = now(),
            last_trade_at = GREATEST(last_trade_at, ${latestTradeAt || sql`last_trade_at`}::timestamptz)
          WHERE id = ${watcher.id}
        `.catch(() => {});
      }

      results.checked++;
    } catch (err) {
      console.warn(`[wallet-watcher] ${address}:`, err.message);
      results.errors++;
    }

    // Small delay to avoid GMGN rate limits
    await new Promise(r => setTimeout(r, 300));
  }

  return json(res, 200, { ...results, ranAt: new Date().toISOString() });
}

async function notifyWatcher({ watcher, trade, results }) {
  const { user_id, telegram_chat_id, wallet_address, label, min_amount_usd } = watcher;
  const walletShort = wallet_address.slice(0, 6) + '...' + wallet_address.slice(-4);
  const labelStr = label ? `${label} (${walletShort})` : walletShort;
  const tradeEmoji = trade.type === 'buy' ? '🟢' : '🔴';
  const mintShort = trade.mint ? trade.mint.slice(0, 8) + '...' : 'unknown';

  const message = `${tradeEmoji} Whale Alert!\n` +
    `Smart wallet ${labelStr}\n` +
    `${trade.type.toUpperCase()} ${trade.symbol || mintShort}\n` +
    `Amount: $${trade.amountUsd.toFixed(0)}\n` +
    `Confidence: ${(trade.confidence * 100).toFixed(0)}%\n` +
    `Mint: ${trade.mint || 'unknown'}`;

  const notifiedVia = [];

  // Telegram notification
  if (telegram_chat_id && process.env.TELEGRAM_BOT_TOKEN) {
    try {
      await sendTelegramNotification(telegram_chat_id, message);
      notifiedVia.push('telegram');
    } catch (err) {
      console.warn('[wallet-watcher] Telegram failed:', err.message);
    }
  }

  // Record notification
  await sql`
    INSERT INTO gmgn_wallet_notifications
      (user_id, wallet_address, mint, trade_type, amount_usd, notified_via)
    VALUES
      (${user_id}, ${wallet_address}, ${trade.mint}, ${trade.type}, ${trade.amountUsd}, ${notifiedVia})
  `.catch(() => {});

  results.notified++;
}

async function sendTelegramNotification(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) return;
  
  // Try to use existing telegram-delivery.js
  try {
    const { sendTelegramMessage } = await import('../../src/pump/telegram-delivery.js');
    await sendTelegramMessage(chatId, text);
    return;
  } catch { /* fall through to direct API call */ }
  
  // Direct Telegram Bot API call
  const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Telegram API error ${resp.status}: ${body.slice(0, 100)}`);
  }
}
```

## Task 4 — Chat Tool: gmgnWatchWallet

Add to the `gmgnToolSchema` in `/workspaces/three.ws/chat/src/tools.js` (alongside tools from prompt 41):

```javascript
{
  type: 'function',
  function: {
    name: 'gmgnWatchWallet',
    description: 'Watch a smart money wallet for significant trades. Get notified when they buy or sell above a minimum amount.',
    parameters: {
      type: 'object',
      properties: {
        address: {
          type: 'string',
          description: 'Solana wallet address to watch',
        },
        minAmountUsd: {
          type: 'number',
          description: 'Minimum trade size in USD to trigger notification (default: $100)',
          default: 100,
        },
        label: {
          type: 'string',
          description: 'Optional label for this wallet (e.g. "Alpha Trader", "Whale #1")',
        },
      },
      required: ['address'],
    },
  },
  clientDefinition: {
    id: 'gmgn-watch-wallet-001',
    name: 'gmgnWatchWallet',
    description: 'Watch a smart wallet for trades',
    arguments: [
      { name: 'address', type: 'string', description: 'Wallet to watch' },
      { name: 'minAmountUsd', type: 'number', description: 'Min trade size USD' },
      { name: 'label', type: 'string', description: 'Friendly label' },
    ],
    body: `
const body = {
  walletAddress: args.address,
  minAmountUsd: args.minAmountUsd || 100,
};
if (args.label) body.label = args.label;

const resp = await fetch('/api/gmgn/watch-wallet?action=add', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  credentials: 'include',
  body: JSON.stringify(body),
});

if (!resp.ok) {
  const err = await resp.json().catch(() => ({}));
  return { error: err.error_description || \`Failed: \${resp.status}\`, watching: false };
}

const data = await resp.json();
return {
  watching: true,
  address: args.address,
  label: args.label,
  minAmountUsd: args.minAmountUsd || 100,
  message: \`Now watching \${args.label || args.address.slice(0,8)+'...'}. You'll be notified when they trade above $\${args.minAmountUsd || 100}.\`,
};
`.trim(),
  },
},
```

Also add a `gmgnListWatchedWallets` tool:

```javascript
{
  type: 'function',
  function: {
    name: 'gmgnListWatchedWallets',
    description: 'List all smart wallets you are currently watching.',
    parameters: { type: 'object', properties: {} },
  },
  clientDefinition: {
    id: 'gmgn-list-watched-001',
    name: 'gmgnListWatchedWallets',
    description: 'List watched smart wallets',
    arguments: [],
    body: `
const resp = await fetch('/api/gmgn/watch-wallet?action=list', { credentials: 'include' });
if (!resp.ok) return { error: \`Failed: \${resp.status}\`, wallets: [] };
const { wallets } = await resp.json();
if (!wallets?.length) return { wallets: [], summary: 'You are not watching any wallets.' };
const summary = wallets.map((w, i) =>
  \`\${i+1}. \${w.label || w.wallet_address.slice(0,8)+'...'} | min: $\${w.min_amount_usd}\`
).join('\\n');
return { wallets, summary: \`Watching \${wallets.length} wallet(s):\\n\${summary}\` };
`.trim(),
  },
},
```

## Task 5 — In-Chat Notification on Wallet Alert

When the wallet watcher cron fires, it should also be able to trigger a chat notification. This is an async process — the cron runs on a schedule, but if the user is currently chatting, they should see the alert.

The simplest approach: when the cron inserts a `gmgn_wallet_notifications` row, the chat UI polls this endpoint on a 30-second interval and announces new notifications.

Add to the wallet watcher cron: after `notifyWatcher`, also push to a `chat_notifications` table if it exists:
```javascript
await sql`
  INSERT INTO chat_notifications (user_id, type, payload, created_at)
  VALUES (${user_id}, 'gmgn_whale_alert', ${JSON.stringify({
    wallet: wallet_address, walletShort, trade, message
  })}, now())
`.catch(() => {});
```

In the Svelte app, if there is an existing polling mechanism for notifications, wire into it. If not, add a 30-second interval in `App.svelte` that calls `/api/notifications/pending` and injects whale alerts as chat messages.

## Task 6 — Add Cron to vercel.json

Add to `crons` in `/workspaces/three.ws/vercel.json`:
```json
{ "path": "/api/cron/gmgn-wallet-watcher", "schedule": "*/5 * * * *" }
```

## File Checklist
- [ ] `/workspaces/three.ws/migrations/gmgn_watched_wallets.sql`
- [ ] `/workspaces/three.ws/api/gmgn/watch-wallet.js`
- [ ] `/workspaces/three.ws/api/cron/gmgn-wallet-watcher.js`
- [ ] `/workspaces/three.ws/chat/src/tools.js` — `gmgnWatchWallet` + `gmgnListWatchedWallets` tools added
- [ ] `/workspaces/three.ws/vercel.json` — cron entry added

## Verification
1. `node -e "import('./api/gmgn/watch-wallet.js').then(m => console.log(typeof m.default))"` from `/workspaces/three.ws`
2. `grep -n 'gmgnWatchWallet' /workspaces/three.ws/chat/src/tools.js`
3. `grep -n 'gmgn-wallet-watcher' /workspaces/three.ws/vercel.json`
4. `ls /workspaces/three.ws/migrations/gmgn_watched_wallets.sql`
