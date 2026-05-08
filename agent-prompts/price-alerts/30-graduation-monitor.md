# Prompt 30 — Graduation Monitor

## Goal
Build a graduation monitor that detects when pump.fun bonding curve coins complete (`complete = true`) and route subsequent trades through the AMM. Includes DB migration, server-side monitor, graduation feed API, chat announcement, and updated buy routing.

## Environment
- Working directory: `/workspaces/three.ws`
- BondingCurveFeed: `/workspaces/three.ws/src/pump/bonding-curve-feed.js` (prompt 26)
- AlertEngine: `/workspaces/three.ws/src/pump/alert-engine.js` (prompt 27)
- pump SDK: `@pump-fun/pump-sdk`, `@pump-fun/pump-swap-sdk`
- DB: `/workspaces/three.ws/api/_lib/db.js` → `sql`
- pump API: `/workspaces/three.ws/api/pump/[action].js`
- pump skills: `/workspaces/three.ws/src/agent-skills-pumpfun.js`
- HTTP helpers: `/workspaces/three.ws/api/_lib/http.js`
- Auth: `/workspaces/three.ws/api/_lib/auth.js`

## Task 1 — DB Migration

Create `/workspaces/three.ws/migrations/pump_tokens_graduation.sql`:

```sql
-- Add graduation tracking to pump_tokens (create table if it doesn't exist)
create table if not exists pump_tokens (
  mint              text primary key,
  symbol            text,
  name              text,
  creator           text,
  bonding_curve_pda text,
  created_at        timestamptz default now(),
  graduated_at      timestamptz,
  amm_pool          text          -- AMM pool PDA after graduation
);

-- If the table already exists (common case), just add the columns
alter table pump_tokens
  add column if not exists graduated_at timestamptz,
  add column if not exists amm_pool     text;

create index if not exists pump_tokens_graduated_idx
  on pump_tokens(graduated_at) where graduated_at is not null;
```

## Task 2 — GraduationMonitor Class

Create `/workspaces/three.ws/src/pump/graduation-monitor.js`:

```javascript
// @ts-check
/**
 * GraduationMonitor
 * Watches bonding curve accounts for complete=true and records graduation events.
 */

import { globalFeed } from './bonding-curve-feed.js';
import { sql } from '../../api/_lib/db.js';

export class GraduationMonitor {
  /**
   * @param {import('./bonding-curve-feed.js').BondingCurveFeed} feed
   */
  constructor(feed = globalFeed)

  /**
   * Register a callback invoked on every graduation event.
   * @param {(event: GraduationEvent) => void} callback
   */
  onGraduation(callback)

  /**
   * Start watching a mint for graduation.
   * @param {string} mint
   */
  watch(mint)

  /**
   * Start watching multiple mints.
   * @param {string[]} mints
   */
  watchMany(mints)

  /**
   * Stop watching a mint.
   * @param {string} mint
   */
  unwatch(mint)

  /** Stop all watchers. */
  stop()
}

/**
 * @typedef {Object} GraduationEvent
 * @property {string} mint
 * @property {string} bondingCurvePda
 * @property {string|null} ammPool       — AMM pool PDA (derived via canonicalPumpPoolPda)
 * @property {Date}   graduatedAt
 */
```

### Graduation Logic

In the `watch(mint)` method:
1. Subscribe to `globalFeed.subscribe(mint, handler)`
2. In `handler(update)`: if `update.complete === true` and mint not already recorded as graduated:
   a. Compute AMM pool PDA using `canonicalPumpPoolPda` from `@pump-fun/pump-swap-sdk`
   b. Upsert into `pump_tokens`: `UPDATE pump_tokens SET graduated_at = now(), amm_pool = $2 WHERE mint = $1`; if 0 rows updated, insert
   c. Emit `GraduationEvent` to all `onGraduation` callbacks
   d. Keep a module-level `Set<string> _graduated` so we only emit once per mint per process lifetime

### AMM Pool Derivation
```javascript
import('@pump-fun/pump-swap-sdk').then(({ canonicalPumpPoolPda }) => {
  const { PublicKey } = await import('@solana/web3.js');
  const mintPk = new PublicKey(mint);
  const poolPda = canonicalPumpPoolPda(mintPk);
  ammPool = poolPda.toBase58();
});
```

### Singleton Export
```javascript
export const globalGraduationMonitor = new GraduationMonitor();
```

## Task 3 — Integrate with Alert Engine

In `/workspaces/three.ws/src/pump/alert-engine.js` (from prompt 27), graduation alerts of type `graduation` are already triggered when `complete === true` in the price update. Verify this works correctly by checking the alert evaluation logic.

If the alert engine does not already handle graduation type via the price update complete flag, add explicit graduation event handling:
- The `GraduationMonitor` should call `globalAlertEngine._checkGraduationAlerts(mint)` when a graduation fires
- `_checkGraduationAlerts` queries `price_alerts WHERE mint=$1 AND alert_type='graduation' AND active=true`, triggers each

## Task 4 — Graduation Feed API

Add a new action to `/workspaces/three.ws/api/pump/[action].js`:

```
case 'graduation-feed': return handleGraduationFeed(req, res);
```

```javascript
// GET /api/pump/graduation-feed?since=<ISO8601>&limit=<n>
async function handleGraduationFeed(req, res) {
  const since = req.query?.since ? new Date(req.query.since) : new Date(Date.now() - 24 * 60 * 60 * 1000);
  const limit = Math.min(100, parseInt(req.query?.limit || '20', 10));
  const rows = await sql`
    SELECT mint, symbol, name, bonding_curve_pda, graduated_at, amm_pool
    FROM pump_tokens
    WHERE graduated_at >= ${since}
    ORDER BY graduated_at DESC
    LIMIT ${limit}
  `;
  return json(res, 200, { graduations: rows });
}
```

## Task 5 — Chat Announcement

In `/workspaces/three.ws/src/agent-skills-pumpfun.js` (or the appropriate location where the agent processes incoming skill results), add a graduation announcement hook.

Find where agent notifications are sent (look for the `agent-notifier.js` import or similar). Add:

```javascript
// Wire graduation monitor to agent announcement
import { globalGraduationMonitor } from './pump/graduation-monitor.js';

globalGraduationMonitor.onGraduation(async (event) => {
  // Check if any active agent holds this token
  const holders = await sql`
    SELECT DISTINCT agent_id FROM agent_token_holdings 
    WHERE mint = ${event.mint} AND active = true
  `.catch(() => []);
  
  for (const { agent_id } of holders) {
    await notifyAgent(agent_id, {
      type: 'graduation',
      message: `🎓 Your token ${event.mint.slice(0,8)}... just graduated to AMM! You can now trade with lower slippage at pool ${event.ammPool}.`,
    });
  }
});
```

If `agent_token_holdings` table doesn't exist, skip the holder lookup and just log the graduation event.

## Task 6 — Route pumpfunBuy to AMM on Graduation

In `/workspaces/three.ws/src/agent-skills-pumpfun.js`, find the `pumpfun-buy` skill handler. Before building a bonding curve buy transaction, check if the token has graduated:

```javascript
// At start of pumpfun-buy handler:
const { rows: [tokenRow] } = await sql`
  SELECT graduated_at, amm_pool FROM pump_tokens WHERE mint = ${args.mint}
`.catch(() => ({ rows: [] }));

if (tokenRow?.graduated_at && tokenRow?.amm_pool) {
  // Route to AMM instead
  // Use pumpfun-amm-buy skill logic
  console.log(`[pumpfun-buy] ${args.mint} graduated → routing to AMM pool ${tokenRow.amm_pool}`);
  return handleAmmBuy(args, context); // call the AMM buy handler
}
// Otherwise proceed with bonding curve buy as normal
```

Also do this check in the pump API handler for `buy-prep` action in `/workspaces/three.ws/api/pump/[action].js`.

## Task 7 — Update vercel.json Cron (Optional)
If a graduation-watcher cron is desired, add to `vercel.json`:
```json
{
  "crons": [
    { "path": "/api/cron/graduation-feed-refresh", "schedule": "*/5 * * * *" }
  ]
}
```

Create `/workspaces/three.ws/api/cron/graduation-feed-refresh.js` that:
- Fetches the 100 newest pump tokens from DB that don't have `graduated_at` set
- Calls `globalGraduationMonitor.watchMany(mints)` to start watching them
- Returns `{ watched: count }`

## File Checklist
- [ ] `/workspaces/three.ws/migrations/pump_tokens_graduation.sql`
- [ ] `/workspaces/three.ws/src/pump/graduation-monitor.js`
- [ ] `/workspaces/three.ws/api/pump/[action].js` — graduation-feed action added
- [ ] `/workspaces/three.ws/src/agent-skills-pumpfun.js` — AMM routing on graduation
- [ ] `/workspaces/three.ws/api/cron/graduation-feed-refresh.js` (optional)

## Verification
1. `node -e "import('./src/pump/graduation-monitor.js').then(m => console.log(Object.keys(m)))"` from `/workspaces/three.ws`
2. `grep -n 'graduation-feed' /workspaces/three.ws/api/pump/[action].js`
3. `grep -n 'graduated_at' /workspaces/three.ws/migrations/pump_tokens_graduation.sql`
