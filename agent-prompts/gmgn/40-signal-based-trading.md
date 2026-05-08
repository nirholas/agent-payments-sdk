# Prompt 40 — Signal-Based Automated Trading

## Goal
Build signal-based automated trading for three.ws agents: copy-trade skill registration, a cron job that executes trades when smart wallets make moves, stop-loss automation, and DB tracking.

## Environment
- Working directory: `/workspaces/three.ws`
- GMGN client: `/workspaces/three.ws/api/_lib/gmgn.js` (prompt 37)
- Agent skills: `/workspaces/three.ws/src/agent-skills-pumpfun.js` — read for skill registration pattern
- Agent skills framework: `/workspaces/three.ws/src/agent-skills.js` — understand `skills.register()`
- pump API: `/workspaces/three.ws/api/pump/[action].js` — find buy-prep + buy-confirm handlers
- DB: `/workspaces/three.ws/api/_lib/db.js`
- Hot wallet: `/workspaces/three.ws/api/_lib/cron-wallet.js` (prompt 34) → `loadHotWallet()`
- HTTP helpers: `/workspaces/three.ws/api/_lib/http.js`
- USDC mint: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`

## Read First
1. `/workspaces/three.ws/src/agent-skills.js` — understand how skills are registered
2. `/workspaces/three.ws/src/agent-skills-pumpfun.js` — find a trade skill (pumpfun-buy) for the pattern
3. `/workspaces/three.ws/api/pump/[action].js` `handleBuyPrep` — how buy txs are built server-side
4. `/workspaces/three.ws/api/_lib/solana-wallet.js` — how the agent hot wallet is loaded
5. Search for existing agent hot wallet usage: `grep -r 'agent.*hot.*wallet\|hot.*wallet\|agent.*keypair' /workspaces/three.ws/api/ --include='*.js'`

## Task 1 — DB Migration

Create `/workspaces/three.ws/migrations/gmgn_trades.sql`:

```sql
-- Tracks all GMGN signal-driven trades
create table if not exists gmgn_trades (
  id              text primary key default gen_random_uuid()::text,
  agent_id        text not null,
  mint            text not null,
  signal_wallet   text not null,    -- the smart wallet we copied
  trade_type      text not null check (trade_type in ('buy', 'sell', 'stop_loss')),
  amount_usdc     numeric(20, 6),   -- USD value at time of trade
  amount_sol      numeric(20, 9),   -- SOL spent/received
  tx_signature    text,
  status          text not null default 'pending'
                  check (status in ('pending', 'success', 'failed', 'skipped')),
  error_message   text,
  entry_price_usd numeric(30, 12),
  exit_price_usd  numeric(30, 12),
  pnl_usdc        numeric(20, 6),   -- populated on sell
  created_at      timestamptz default now(),
  confirmed_at    timestamptz
);

create index if not exists gmgn_trades_agent_idx  on gmgn_trades(agent_id, created_at desc);
create index if not exists gmgn_trades_mint_idx   on gmgn_trades(agent_id, mint, trade_type);
create index if not exists gmgn_trades_status_idx on gmgn_trades(status, created_at);
```

## Task 2 — Agent Skills for GMGN Copy Trading

Create `/workspaces/three.ws/src/agent-skills-gmgn-trading.js`:

```javascript
/**
 * GMGN Copy-Trading Skills
 * -------------------------
 * Registers agent skills for enabling/disabling/monitoring copy trades
 * based on GMGN smart wallet signals.
 *
 * Skills:
 *   gmgn-copy-trade-enable   — configure copy trading for an agent
 *   gmgn-copy-trade-disable  — turn off copy trading
 *   gmgn-copy-trade-status   — view current positions and P&L
 *   gmgn-check-signals       — check current signals for a token
 */

import { getGmgnClient } from '../api/_lib/gmgn.js';
import { processSmartMoneySignal, rankSignals } from './kol/smart-money-processor.js';
import { sql } from '../api/_lib/db.js';

export function registerGmgnTradingSkills(skills) {

  // ── gmgn-copy-trade-enable ────────────────────────────────────────────────
  skills.register({
    name: 'gmgn-copy-trade-enable',
    description: 'Enable copy trading: automatically buys tokens when a target smart wallet buys them',
    schema: {
      type: 'object',
      properties: {
        walletToCopy: {
          type: 'string',
          description: 'Solana wallet address of the smart trader to copy',
        },
        maxBuyUsd: {
          type: 'number',
          description: 'Maximum USD value per copy trade (default: $10)',
          default: 10,
        },
        slippageBps: {
          type: 'number',
          description: 'Slippage tolerance in basis points (default: 300 = 3%)',
          default: 300,
        },
        minConfidence: {
          type: 'number',
          description: 'Minimum signal confidence 0-1 to execute a trade (default: 0.7)',
          default: 0.7,
        },
      },
      required: ['walletToCopy'],
    },
    async execute({ agentId, args }) {
      const { walletToCopy, maxBuyUsd = 10, slippageBps = 300, minConfidence = 0.7 } = args;

      // Validate the wallet exists on GMGN
      try {
        const client = getGmgnClient();
        await client.getWalletTrades(walletToCopy, { limit: 1 });
      } catch (err) {
        if (err.status === 404) throw new Error(`Wallet ${walletToCopy} not found on GMGN`);
        // Ignore other errors — GMGN may be unavailable but the config is still valid
      }

      // Save to agent meta
      const config = { enabled: true, walletToCopy, maxBuyUsd, slippageBps, minConfidence, enabledAt: new Date().toISOString() };
      await sql`
        UPDATE agent_identities
        SET meta = jsonb_set(
          COALESCE(meta, '{}'),
          '{gmgn,copyTrade}',
          ${JSON.stringify(config)}
        )
        WHERE id = ${agentId}
      `;

      return {
        enabled: true,
        config,
        message: `Copy trading enabled: will follow ${walletToCopy.slice(0,8)}... up to $${maxBuyUsd} per trade with ${minConfidence * 100}% min confidence`,
      };
    },
  });

  // ── gmgn-copy-trade-disable ───────────────────────────────────────────────
  skills.register({
    name: 'gmgn-copy-trade-disable',
    description: 'Disable GMGN copy trading for this agent',
    schema: { type: 'object', properties: {} },
    async execute({ agentId }) {
      await sql`
        UPDATE agent_identities
        SET meta = jsonb_set(
          COALESCE(meta, '{}'),
          '{gmgn,copyTrade,enabled}',
          'false'
        )
        WHERE id = ${agentId}
      `;
      return { enabled: false, message: 'Copy trading disabled' };
    },
  });

  // ── gmgn-copy-trade-status ────────────────────────────────────────────────
  skills.register({
    name: 'gmgn-copy-trade-status',
    description: 'Show current copy trade configuration, positions, and recent P&L',
    schema: { type: 'object', properties: {} },
    async execute({ agentId }) {
      const [agent] = await sql`SELECT meta FROM agent_identities WHERE id = ${agentId}`;
      const config = agent?.meta?.gmgn?.copyTrade || null;

      const trades = await sql`
        SELECT mint, trade_type, amount_usdc, pnl_usdc, status, created_at, tx_signature
        FROM gmgn_trades
        WHERE agent_id = ${agentId}
        ORDER BY created_at DESC
        LIMIT 20
      `.catch(() => []);

      const totalPnl = trades
        .filter(t => t.pnl_usdc != null)
        .reduce((s, t) => s + Number(t.pnl_usdc || 0), 0);

      return {
        config,
        recentTrades: trades,
        totalPnl: +totalPnl.toFixed(4),
        tradeCount: trades.length,
      };
    },
  });

  // ── gmgn-check-signals ────────────────────────────────────────────────────
  skills.register({
    name: 'gmgn-check-signals',
    description: 'Check GMGN smart money signals for a specific token',
    schema: {
      type: 'object',
      properties: {
        mint: { type: 'string', description: 'Token mint address' },
      },
      required: ['mint'],
    },
    async execute({ args }) {
      const client = getGmgnClient();
      const raw = await client.getTokenSignals(args.mint, { chain: 'sol' });
      const signals = (raw?.data || []).map(processSmartMoneySignal).filter(Boolean);
      const ranked = rankSignals(signals).slice(0, 10);
      return { mint: args.mint, signals: ranked, signalCount: signals.length };
    },
  });
}
```

## Task 3 — Signal Trader Cron

Create `/workspaces/three.ws/api/cron/gmgn-signal-trader.js`:

```javascript
/**
 * GMGN Signal Trader Cron — runs every 5 minutes
 * For each agent with gmgn.copyTrade.enabled:
 *   1. Fetch latest trades by walletToCopy from GMGN
 *   2. For each new buy signal above minConfidence: execute a buy
 *   3. Stop-loss: for open positions down >30%, auto-sell
 *
 * Hot wallet: DISTRIBUTION_WALLET_PRIVATE_KEY (same as distribute cron)
 * The hot wallet must have sufficient SOL for fees.
 */

import { sql } from '../_lib/db.js';
import { json, error, cors } from '../_lib/http.js';
import { getGmgnClient } from '../_lib/gmgn.js';
import { processSmartMoneySignal } from '../../src/kol/smart-money-processor.js';
import { loadHotWallet, buildAndSendTx, sleep } from '../_lib/cron-wallet.js';
import { getConnection, getPumpSdkV2 } from '../_lib/pump.js';
import { PublicKey } from '@solana/web3.js';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MAX_AGENTS = 20;
const STOP_LOSS_PCT = 30; // sell if down 30%

// Track last-seen trade timestamps per wallet to detect new trades
const _lastSeenTrade = new Map(); // walletAddress → ISO timestamp

export default async function handler(req, res) {
  cors(req, res);

  const cronSecret = req.headers['x-cron-secret'] || req.headers['authorization'];
  if (process.env.CRON_SECRET && cronSecret !== `Bearer ${process.env.CRON_SECRET}`) {
    return error(res, 401, 'unauthorized', 'Invalid cron secret');
  }

  const results = { executed: 0, stopped: 0, skipped: 0, errors: 0 };

  let hotWallet;
  try { hotWallet = await loadHotWallet(); }
  catch (err) { return error(res, 500, 'wallet_error', err.message); }

  // Load all agents with copy trading enabled
  const agents = await sql`
    SELECT id, meta
    FROM agent_identities
    WHERE (meta->'gmgn'->'copyTrade'->>'enabled')::boolean = true
    LIMIT ${MAX_AGENTS}
  `.catch(() => []);

  const gmgn = getGmgnClient();
  const connection = getConnection({ network: 'mainnet' });

  for (const agent of agents) {
    const cfg = agent.meta?.gmgn?.copyTrade;
    if (!cfg?.walletToCopy) continue;

    await sleep(500);

    try {
      // 1. Fetch recent trades by the watched wallet
      const rawTrades = await gmgn.getWalletTrades(cfg.walletToCopy, { chain: 'sol', limit: 10 });
      const trades = (rawTrades?.data || []).map(processSmartMoneySignal).filter(Boolean);

      // 2. Filter to new trades since last check
      const lastSeen = _lastSeenTrade.get(cfg.walletToCopy) || new Date(0).toISOString();
      const newTrades = trades.filter(t => new Date(t.timestamp) > new Date(lastSeen));

      if (newTrades.length > 0) {
        _lastSeenTrade.set(cfg.walletToCopy, new Date().toISOString());
      }

      // 3. Execute buys for qualifying signals
      for (const signal of newTrades) {
        if (signal.type !== 'buy') continue;
        if (signal.confidence < cfg.minConfidence) continue;
        if (signal.amountUsd < 50) continue; // ignore dust trades

        await executeCopyBuy({
          agentId: agent.id,
          mint: signal.mint,
          signalWallet: cfg.walletToCopy,
          maxBuyUsd: cfg.maxBuyUsd || 10,
          slippageBps: cfg.slippageBps || 300,
          hotWallet,
          connection,
          results,
        });
      }

      // 4. Check stop-losses for open positions
      await checkStopLosses({ agentId: agent.id, hotWallet, connection, results });

    } catch (err) {
      console.error(`[signal-trader] Agent ${agent.id}:`, err.message);
      results.errors++;
    }
  }

  return json(res, 200, { ...results, ranAt: new Date().toISOString() });
}

async function executeCopyBuy({ agentId, mint, signalWallet, maxBuyUsd, slippageBps, hotWallet, connection, results }) {
  const tradeId = await sql`
    INSERT INTO gmgn_trades (agent_id, mint, signal_wallet, trade_type, amount_usdc, status)
    VALUES (${agentId}, ${mint}, ${signalWallet}, 'buy', ${maxBuyUsd}, 'pending')
    RETURNING id
  `.then(r => r[0]?.id);

  try {
    // Convert USD to SOL lamports (approximate: use 150 SOL/USD as floor)
    const solPrice = 150; // TODO: fetch live SOL price
    const solAmount = maxBuyUsd / solPrice;
    const lamports = Math.floor(solAmount * 1e9);

    // Build buy tx using pumpfun SDK
    const { PUMP_SDK, onlineSdk, BN } = await getPumpSdkV2({ network: 'mainnet' });
    
    const buyIxs = await onlineSdk.buyInstructions({
      mint: new PublicKey(mint),
      buyer: hotWallet.publicKey,
      solAmount: new BN(lamports),
      slippageBps,
    });

    const sig = await buildAndSendTx({ connection, wallet: hotWallet, instructions: buyIxs });

    await sql`
      UPDATE gmgn_trades
      SET status='success', tx_signature=${sig}, confirmed_at=now()
      WHERE id=${tradeId}
    `;
    results.executed++;
    console.log(`[signal-trader] Bought ${mint.slice(0,8)}... for agent ${agentId}: ${sig}`);
  } catch (err) {
    await sql`UPDATE gmgn_trades SET status='failed', error_message=${err.message} WHERE id=${tradeId}`;
    throw err;
  }
}

async function checkStopLosses({ agentId, hotWallet, connection, results }) {
  // Find open buy positions
  const positions = await sql`
    SELECT DISTINCT ON (mint)
      id, mint, entry_price_usd, amount_usdc
    FROM gmgn_trades
    WHERE agent_id = ${agentId}
      AND trade_type = 'buy'
      AND status = 'success'
      AND exit_price_usd IS NULL
    ORDER BY mint, created_at DESC
  `.catch(() => []);

  for (const pos of positions) {
    if (!pos.entry_price_usd) continue;

    // Fetch current price
    try {
      const { onlineSdk, bondingCurvePda } = await getPumpSdkV2({ network: 'mainnet' });
      const mintPk = new PublicKey(pos.mint);
      const bcPda = bondingCurvePda(mintPk);
      const bcAccount = await connection.getAccountInfo(bcPda);
      if (!bcAccount) continue;

      // Quick price decode (v1: 49 bytes, v2: 115 bytes)
      const data = bcAccount.data;
      const vTokenRes = data.readBigUInt64LE(8);
      const vQuoteRes  = data.readBigUInt64LE(16);
      const currentPrice = Number(vQuoteRes) / Number(vTokenRes) * 1e3; // approximate

      const entryPrice = Number(pos.entry_price_usd);
      const lossPercent = ((entryPrice - currentPrice) / entryPrice) * 100;

      if (lossPercent >= STOP_LOSS_PCT) {
        console.log(`[signal-trader] Stop-loss triggered for ${pos.mint.slice(0,8)}... (-${lossPercent.toFixed(1)}%)`);
        // TODO: execute sell — same pattern as buy but using sellInstructions
        results.stopped++;
      }
    } catch { /* skip price check errors */ }
  }
}
```

## Task 4 — Add Cron to vercel.json

Add to the `crons` array:
```json
{ "path": "/api/cron/gmgn-signal-trader", "schedule": "*/5 * * * *" }
```

## File Checklist
- [ ] `/workspaces/three.ws/migrations/gmgn_trades.sql`
- [ ] `/workspaces/three.ws/src/agent-skills-gmgn-trading.js`
- [ ] `/workspaces/three.ws/api/cron/gmgn-signal-trader.js`
- [ ] `/workspaces/three.ws/vercel.json` — cron entry added

## Integration
After creating the skills file, register the skills in the main agent skills loader. Find where other skills are registered:
```bash
grep -r 'registerAgentPaymentSkills\|registerPumpfunSkills' /workspaces/three.ws/src/ --include='*.js'
```
Then add:
```javascript
import { registerGmgnTradingSkills } from './agent-skills-gmgn-trading.js';
// In the skills registration block:
registerGmgnTradingSkills(skills);
```

## Verification
1. `node -e "import('./src/agent-skills-gmgn-trading.js').then(m => console.log(typeof m.registerGmgnTradingSkills))"` from `/workspaces/three.ws`
2. `grep -n 'gmgn-signal-trader' /workspaces/three.ws/vercel.json`
3. `ls /workspaces/three.ws/migrations/gmgn_trades.sql`
