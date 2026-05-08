# Prompt 27 — Price Alert Engine

## Goal
Build a price alert system for three.ws: DB schema, REST API endpoints, and an `AlertEngine` class that monitors pump.fun coin prices using `BondingCurveFeed` (from prompt 26) and triggers user notifications.

## Environment
- Working directory: `/workspaces/three.ws`
- Runtime: Node.js / Vercel serverless (ESM)
- Database: Neon Postgres, `sql` tagged-template from `/workspaces/three.ws/api/_lib/db.js`
- Auth: `getSessionUser(req)` + `authenticateBearer(extractBearer(req))` from `/workspaces/three.ws/api/_lib/auth.js`
- HTTP helpers: `json`, `error`, `method`, `readJson`, `wrap`, `cors` from `/workspaces/three.ws/api/_lib/http.js`
- Rate limiting: `limits`, `clientIp` from `/workspaces/three.ws/api/_lib/rate-limit.js`
- BondingCurveFeed: `/workspaces/three.ws/src/pump/bonding-curve-feed.js` (created in prompt 26)
- Telegram delivery: `/workspaces/three.ws/src/pump/telegram-delivery.js` — inspect this file for the `sendTelegramMessage(chatId, text)` function signature before using it

## Task 1 — DB Migration

Create `/workspaces/three.ws/migrations/price_alerts.sql`:

```sql
-- price_alerts: user-configured price alert rules
create table if not exists price_alerts (
  id          text primary key default gen_random_uuid()::text,
  user_id     text not null,
  mint        text not null,
  alert_type  text not null check (
    alert_type in ('price_above', 'price_below', 'gain_pct', 'loss_pct', 'graduation')
  ),
  threshold       numeric(30, 12),        -- null for graduation type
  baseline_price  numeric(30, 12),        -- price at alert creation (for pct types)
  triggered_at    timestamptz,
  notified_at     timestamptz,
  created_at      timestamptz default now(),
  active          boolean default true,
  notify_telegram boolean default false,
  telegram_chat_id text                   -- optional; override per-alert
);

create index if not exists price_alerts_active_idx
  on price_alerts(mint, active) where active = true;

create index if not exists price_alerts_user_idx
  on price_alerts(user_id);
```

## Task 2 — REST API

Create `/workspaces/three.ws/api/alerts/[action].js` handling the following actions. Pattern follows `/workspaces/three.ws/api/pump/[action].js` exactly: use `wrap()`, `cors`, `method()`, auth check, `readJson`/query params, return `json()`.

### POST /api/alerts/create
Body:
```json
{
  "mint": "string (required)",
  "alertType": "price_above|price_below|gain_pct|loss_pct|graduation",
  "threshold": 0.00123,
  "notifyTelegram": false
}
```
- Require auth (session or bearer).
- Validate alertType enum; validate threshold required for non-graduation types.
- For `gain_pct` / `loss_pct`: fetch current price from bonding curve (or use `GET /api/pump/[action]?action=quote`) to record `baseline_price`.
- Insert row, return `{ id, mint, alertType, threshold, createdAt }`.

### GET /api/alerts/list
- Require auth.
- Optional query params: `?active=true|false|all` (default `active=true`), `?mint=<address>`.
- Return `{ alerts: [...] }` with all columns.

### DELETE /api/alerts/[id]  (action = delete, id in body or query)
Route: `DELETE /api/alerts/[action]` where action = the alert ID, OR a separate action=delete with `?id=` param.
Use this pattern: `action === 'delete'` → read `id` from `req.query.id` or body.
- Require auth; verify alert belongs to calling user before deleting.
- Soft-delete: `UPDATE price_alerts SET active = false WHERE id = $1 AND user_id = $2`.
- Return `{ cancelled: true, id }`.

### GET /api/alerts/[action]?action=get&id=...
- Return single alert by ID (must belong to calling user).

## Task 3 — Alert Engine

Create `/workspaces/three.ws/src/pump/alert-engine.js`:

```javascript
// @ts-check
import { globalFeed } from './bonding-curve-feed.js';
import { sql } from '../../api/_lib/db.js';

export class AlertEngine {
  constructor(feed = globalFeed)

  /** Register a callback invoked when any alert triggers. */
  onAlert(callback)  // callback: (AlertEvent) => void

  /**
   * Load all active alerts for a userId from DB, start watching their mints.
   * Safe to call multiple times — deduplicates by mint.
   */
  async watchUserAlerts(userId)

  /**
   * Load ALL active alerts from DB and start watching.
   * Used by the cron/server-side watcher process.
   */
  async watchAll()

  /** Stop watching and remove all subscriptions. */
  async stop()
}

/**
 * @typedef {Object} AlertEvent
 * @property {string}  alertId
 * @property {string}  userId
 * @property {string}  mint
 * @property {string}  alertType
 * @property {number}  threshold
 * @property {number}  triggerPrice   — the price that caused the trigger
 * @property {number}  priceUsd
 * @property {boolean} notifyTelegram
 * @property {string|null} telegramChatId
 * @property {Date}    triggeredAt
 */
```

### Alert Engine Logic

On each `PriceUpdate` from `BondingCurveFeed`:
1. Query `price_alerts` for all active alerts where `mint = $1` (cache this query per-mint for 5 seconds to reduce DB load).
2. For each alert, evaluate the trigger condition:
   - `price_above`: `priceUsd >= threshold`
   - `price_below`: `priceUsd <= threshold`
   - `gain_pct`: `(priceUsd - baselinePrice) / baselinePrice * 100 >= threshold`
   - `loss_pct`: `(baselinePrice - priceUsd) / baselinePrice * 100 >= threshold`
   - `graduation`: `complete === true`
3. When triggered:
   - `UPDATE price_alerts SET triggered_at = now(), active = false WHERE id = $1` (deactivate so it doesn't re-fire)
   - Emit `AlertEvent` to all registered `onAlert` handlers
   - If `notifyTelegram = true` and `telegramChatId` is set: send Telegram message
4. Telegram message format: `"Alert: {MINT_SHORT} hit your target!\nType: {alertType}\nPrice: $${priceUsd.toFixed(8)}\nThreshold: ${threshold}"`

### Telegram Integration
Read `TELEGRAM_BOT_TOKEN` from `process.env`. If the existing `/workspaces/three.ws/src/pump/telegram-delivery.js` exports a usable `sendTelegramMessage` function, use it. Otherwise implement directly:
```javascript
async function sendTelegramNotification(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
  });
}
```

### Singleton Export
```javascript
export const globalAlertEngine = new AlertEngine();
```

## Task 4 — Mint-to-Symbol Resolution (Optional but Recommended)
When formatting Telegram messages, try to fetch the token symbol from pump.fun for a friendlier name. Cache symbol lookups in a `Map<mint, symbol>` with 5-minute TTL.

## File Checklist
- [ ] `/workspaces/three.ws/migrations/price_alerts.sql`
- [ ] `/workspaces/three.ws/api/alerts/[action].js`
- [ ] `/workspaces/three.ws/src/pump/alert-engine.js`

## Verification Steps
1. Run `node --input-type=module <<'EOF'` to verify the migration SQL parses: `import { sql } from './api/_lib/db.js'; await sql\`SELECT 1\`; console.log('DB ok')`
2. Verify `/api/alerts/[action].js` exports a default function.
3. Verify `AlertEngine` and `globalAlertEngine` are exported from alert-engine.js.
