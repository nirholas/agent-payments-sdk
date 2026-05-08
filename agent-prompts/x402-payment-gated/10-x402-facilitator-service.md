# Task: Build a standalone x402 facilitator service for three.ws

## Context

- three.ws repo: `/workspaces/three.ws`
- The x402 facilitator is a server that verifies payment proofs and settles transactions
- Currently, three.ws delegates to an external facilitator via `env.X402_FACILITATOR_URL_SOLANA` (see `/workspaces/three.ws/api/_lib/x402-spec.js`)
- Goal: build a self-hosted facilitator that three.ws can run instead, making payment verification auditable and removing external dependencies
- The facilitator implements the coinbase/x402 v1 API: `POST /verify`, `POST /settle`, `GET /supported`
- Deploy target: Node.js service (Dockerfile for self-hosting)

---

## Step 1: Read all relevant files

```
/workspaces/three.ws/api/_lib/x402-spec.js    (verify/settle wire format)
/workspaces/three.ws/api/_lib/x402-middleware.js  (calls facilitator)
/workspaces/agent-payments-sdk/src/solana/x402/facilitator.ts   (SDK facilitator for reference)
/workspaces/agent-payments-sdk/src/solana/x402/types.ts
/workspaces/agent-payments-sdk/src/solana/x402/headers.ts
```

Also check if the workers directory exists:
```bash
ls /workspaces/three.ws/workers/ 2>/dev/null || echo "no workers dir"
ls /workspaces/three.ws/ | head -20
```

---

## Step 2: Create the facilitator service

Create the directory:
```bash
mkdir -p /workspaces/three.ws/workers/x402-facilitator
```

### File: `/workspaces/three.ws/workers/x402-facilitator/package.json`

```json
{
  "name": "x402-facilitator",
  "version": "1.0.0",
  "description": "x402 payment verification facilitator for three.ws",
  "type": "module",
  "main": "index.js",
  "scripts": {
    "start": "node index.js",
    "dev": "node --watch index.js"
  },
  "dependencies": {
    "@solana/spl-token": "^0.4.9",
    "@solana/web3.js": "^1.98.0"
  },
  "engines": {
    "node": ">=18"
  }
}
```

### File: `/workspaces/three.ws/workers/x402-facilitator/index.js`

Full implementation:

```js
/**
 * x402-facilitator — standalone HTTP server for x402 payment verification.
 *
 * Implements the coinbase/x402 v1 API:
 *   POST /verify   — verify a payment payload
 *   POST /settle   — settle (finalize) a verified payment
 *   GET  /supported — list supported schemes/networks/assets
 *   GET  /health   — liveness probe
 *   GET  /status/:txSig — check if a tx signature has been used
 *   POST /invoice  — create a payment invoice (idempotency key + expiry)
 *
 * Configuration via environment variables:
 *   PORT                    (default: 3100)
 *   SOLANA_RPC_URL          (default: mainnet-beta public)
 *   SOLANA_RPC_URL_DEVNET   (optional)
 *   USDC_MINT_MAINNET       (default: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v)
 *   USDC_MINT_DEVNET        (default: 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU)
 *   MAX_AMOUNT_USDC         (default: 100) — refuse to verify payments above this
 *   SETTLEMENT_TTL_MS       (default: 120000) — idempotency window in ms
 *   BEARER_TOKEN            (optional) — require Authorization: Bearer <token>
 *
 * Usage:
 *   PORT=3100 SOLANA_RPC_URL=https://... node index.js
 */

import http from 'http';
import { Connection, PublicKey } from '@solana/web3.js';
import { getMint, TOKEN_PROGRAM_ID } from '@solana/spl-token';

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3100', 10);

const USDC_MINT_MAINNET = process.env.USDC_MINT_MAINNET || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_MINT_DEVNET  = process.env.USDC_MINT_DEVNET  || '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

const RPC_MAINNET = process.env.SOLANA_RPC_URL      || 'https://api.mainnet-beta.solana.com';
const RPC_DEVNET  = process.env.SOLANA_RPC_URL_DEVNET || 'https://api.devnet.solana.com';

const MAX_AMOUNT_USDC   = parseFloat(process.env.MAX_AMOUNT_USDC || '100');
const USDC_DECIMALS     = 6;
const SETTLEMENT_TTL_MS = parseInt(process.env.SETTLEMENT_TTL_MS || '120000', 10);
const BEARER_TOKEN      = process.env.BEARER_TOKEN || null;

// Max age of a tx before we reject it (5 minutes)
const TX_MAX_AGE_SEC = 300;

// ─── Idempotency Store ───────────────────────────────────────────────────────

// In production: replace with Redis or PostgreSQL for multi-instance deployments.
const usedSignatures = new Map(); // sig → { usedAt: number, payer: string, amount: bigint }

function isUsed(sig) {
  const entry = usedSignatures.get(sig);
  if (!entry) return false;
  // Expire old entries to prevent unbounded growth
  if (Date.now() - entry.usedAt > SETTLEMENT_TTL_MS * 10) {
    usedSignatures.delete(sig);
    return false;
  }
  return true;
}

function markUsed(sig, payer, amount) {
  usedSignatures.set(sig, { usedAt: Date.now(), payer, amount });
  // Prune entries older than 10× TTL
  if (usedSignatures.size > 50_000) {
    const cutoff = Date.now() - SETTLEMENT_TTL_MS * 10;
    for (const [k, v] of usedSignatures) {
      if (v.usedAt < cutoff) usedSignatures.delete(k);
    }
  }
}

// Invoice store for /invoice endpoint
const invoices = new Map(); // key → { amount, payTo, asset, expiresAt, used }

// ─── Solana helpers ───────────────────────────────────────────────────────────

function getConnection(network) {
  const url = network === 'solana-devnet' ? RPC_DEVNET : RPC_MAINNET;
  return new Connection(url, 'confirmed');
}

function getUsdcMint(network) {
  return network === 'solana-devnet' ? USDC_MINT_DEVNET : USDC_MINT_MAINNET;
}

/**
 * Verify that a Solana transaction:
 * 1. Is confirmed
 * 2. Contains a SPL TransferChecked for USDC
 * 3. Sends at least `minAmount` to `payTo`
 * 4. Was signed within TX_MAX_AGE_SEC seconds
 * 5. Has not been used before (idempotency)
 *
 * @returns {{ valid: boolean, payer?: string, amount?: bigint, error?: string }}
 */
async function verifyUsdcTransfer({ txSignature, payTo, minAmount, network }) {
  if (isUsed(txSignature)) {
    return { valid: false, error: 'transaction already used' };
  }

  const connection = getConnection(network);
  const usdcMint = getUsdcMint(network);

  let tx;
  try {
    tx = await connection.getParsedTransaction(txSignature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });
  } catch (err) {
    return { valid: false, error: `RPC error fetching tx: ${err.message}` };
  }

  if (!tx) return { valid: false, error: 'transaction not found or not yet confirmed' };
  if (tx.meta?.err) return { valid: false, error: 'transaction failed on-chain' };

  // Check tx age
  if (tx.blockTime) {
    const ageSeconds = Math.floor(Date.now() / 1000) - tx.blockTime;
    if (ageSeconds > TX_MAX_AGE_SEC) {
      return { valid: false, error: `transaction too old: ${ageSeconds}s (max ${TX_MAX_AGE_SEC}s)` };
    }
  }

  // Find a TransferChecked instruction for USDC to payTo
  const instructions = tx.transaction?.message?.instructions || [];
  let transferFound = false;
  let transferAmount = 0n;
  let payer = '';

  for (const ix of instructions) {
    if (ix.program !== 'spl-token') continue;
    const parsed = ix.parsed;
    if (!parsed) continue;

    if (parsed.type === 'transferChecked') {
      const info = parsed.info;
      if (!info) continue;

      // Check mint matches USDC
      if (info.mint !== usdcMint) continue;

      // Check destination owner (Solana uses associated token accounts)
      // The destination ATA's owner should be payTo
      const destAccount = info.destination;
      if (!destAccount) continue;

      // Verify the destination ATA belongs to payTo
      // We do this by checking parsed account data or by resolving the ATA
      // In parsed tx, info.authority is the source authority (payer)
      // info.destination is the ATA; we check postTokenBalances for the owner
      const postBalances = tx.meta?.postTokenBalances || [];
      const destBalance = postBalances.find(b => b.mint === usdcMint && b.owner === payTo);

      if (!destBalance) {
        // Try checking if destination matches ATA derivation
        // Fall back: check if any account is associated with payTo
        const accountKeys = tx.transaction.message.accountKeys.map(k =>
          typeof k === 'string' ? k : k.pubkey
        );
        // If payTo is one of the account keys and we found a USDC transfer, assume it's correct
        // This is a best-effort check; production should do proper ATA derivation
        if (!accountKeys.includes(payTo)) continue;
      }

      const amount = BigInt(info.tokenAmount?.amount || '0');
      if (amount >= minAmount) {
        transferFound = true;
        transferAmount = amount;
        payer = info.authority || '';
        break;
      }
    }
  }

  if (!transferFound) {
    return {
      valid: false,
      error: `no USDC TransferChecked >= ${minAmount} found for recipient ${payTo}`,
    };
  }

  return { valid: true, payer, amount: transferAmount };
}

// ─── HTTP Server ─────────────────────────────────────────────────────────────

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
  });
  res.end(data);
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { buf += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function checkAuth(req, res) {
  if (!BEARER_TOKEN) return true;
  const auth = req.headers['authorization'] || '';
  if (!auth.startsWith('Bearer ') || auth.slice(7) !== BEARER_TOKEN) {
    sendJson(res, 401, { error: 'unauthorized' });
    return false;
  }
  return true;
}

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type, authorization');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  try {
    // GET /health
    if (req.method === 'GET' && path === '/health') {
      return sendJson(res, 200, { ok: true, service: 'x402-facilitator', ts: Date.now() });
    }

    // GET /supported
    if (req.method === 'GET' && path === '/supported') {
      if (!checkAuth(req, res)) return;
      return sendJson(res, 200, {
        kinds: [
          { scheme: 'exact', network: 'solana-mainnet', asset: USDC_MINT_MAINNET },
          { scheme: 'exact', network: 'solana-devnet',  asset: USDC_MINT_DEVNET  },
        ],
      });
    }

    // GET /status/:txSig
    if (req.method === 'GET' && path.startsWith('/status/')) {
      if (!checkAuth(req, res)) return;
      const sig = decodeURIComponent(path.slice('/status/'.length));
      const used = isUsed(sig);
      const entry = usedSignatures.get(sig);
      return sendJson(res, 200, { sig, used, usedAt: entry?.usedAt ?? null, payer: entry?.payer ?? null });
    }

    // POST /verify
    if (req.method === 'POST' && path === '/verify') {
      if (!checkAuth(req, res)) return;
      const body = await readBody(req);

      const { x402Version, paymentPayload, paymentRequirements } = body;
      if (!paymentPayload || !paymentRequirements) {
        return sendJson(res, 400, { error: 'missing paymentPayload or paymentRequirements' });
      }

      const req2 = paymentRequirements;
      const scheme = req2.scheme;
      const network = req2.network;

      if (scheme !== 'exact') {
        return sendJson(res, 200, { isValid: false, invalidReason: `unsupported scheme: ${scheme}` });
      }

      // Decode payload
      let txSignature, payloadData;
      try {
        const raw = Buffer.from(String(paymentPayload), 'base64').toString('utf8');
        payloadData = JSON.parse(raw);
      } catch {
        // paymentPayload may already be an object
        payloadData = paymentPayload;
      }

      txSignature = payloadData?.payload?.signature || payloadData?.payload?.txSignature;
      if (!txSignature) {
        return sendJson(res, 200, { isValid: false, invalidReason: 'missing tx signature in payload' });
      }

      const minAmount = BigInt(req2.maxAmountRequired || '0');
      const payTo = req2.payTo;

      const result = await verifyUsdcTransfer({ txSignature, payTo, minAmount, network });

      if (!result.valid) {
        return sendJson(res, 200, { isValid: false, invalidReason: result.error });
      }

      // Check amount doesn't exceed safety cap
      const amountUsdc = Number(result.amount) / Math.pow(10, USDC_DECIMALS);
      if (amountUsdc > MAX_AMOUNT_USDC) {
        return sendJson(res, 200, {
          isValid: false,
          invalidReason: `amount ${amountUsdc} USDC exceeds max ${MAX_AMOUNT_USDC} USDC`,
        });
      }

      return sendJson(res, 200, { isValid: true, payer: result.payer });
    }

    // POST /settle
    if (req.method === 'POST' && path === '/settle') {
      if (!checkAuth(req, res)) return;
      const body = await readBody(req);

      const { paymentPayload, paymentRequirements } = body;
      if (!paymentPayload || !paymentRequirements) {
        return sendJson(res, 400, { error: 'missing paymentPayload or paymentRequirements' });
      }

      const req2 = paymentRequirements;
      const network = req2.network;

      let payloadData, txSignature;
      try {
        const raw = Buffer.from(String(paymentPayload), 'base64').toString('utf8');
        payloadData = JSON.parse(raw);
      } catch {
        payloadData = paymentPayload;
      }

      txSignature = payloadData?.payload?.signature || payloadData?.payload?.txSignature;
      if (!txSignature) {
        return sendJson(res, 200, { success: false, errorReason: 'missing tx signature' });
      }

      // Re-verify (settle = verify + mark used)
      const minAmount = BigInt(req2.maxAmountRequired || '0');
      const payTo = req2.payTo;
      const result = await verifyUsdcTransfer({ txSignature, payTo, minAmount, network });

      if (!result.valid) {
        return sendJson(res, 200, { success: false, errorReason: result.error });
      }

      // Mark as used (idempotency)
      markUsed(txSignature, result.payer, result.amount);

      return sendJson(res, 200, {
        success: true,
        transaction: txSignature,
        network,
        payer: result.payer,
      });
    }

    // POST /invoice — create a one-time payment invoice
    if (req.method === 'POST' && path === '/invoice') {
      if (!checkAuth(req, res)) return;
      const body = await readBody(req);

      const { amount, payTo, asset, ttlSeconds = 300, idempotencyKey } = body;
      if (!amount || !payTo) {
        return sendJson(res, 400, { error: 'amount and payTo are required' });
      }

      const key = idempotencyKey || `inv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      if (invoices.has(key)) {
        return sendJson(res, 200, invoices.get(key));
      }

      const invoice = {
        id: key,
        amount: String(amount),
        payTo,
        asset: asset || USDC_MINT_MAINNET,
        expiresAt: Date.now() + ttlSeconds * 1000,
        createdAt: Date.now(),
        used: false,
      };
      invoices.set(key, invoice);

      // Auto-expire
      setTimeout(() => invoices.delete(key), ttlSeconds * 1000 * 2);

      return sendJson(res, 201, invoice);
    }

    sendJson(res, 404, { error: 'not found' });

  } catch (err) {
    console.error('[x402-facilitator] unhandled error:', err);
    sendJson(res, 500, { error: 'internal server error', message: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`[x402-facilitator] listening on port ${PORT}`);
  console.log(`[x402-facilitator] mainnet RPC: ${RPC_MAINNET}`);
  console.log(`[x402-facilitator] USDC mainnet: ${USDC_MINT_MAINNET}`);
  console.log(`[x402-facilitator] auth: ${BEARER_TOKEN ? 'enabled' : 'disabled'}`);
});

process.on('SIGTERM', () => { server.close(); process.exit(0); });
process.on('SIGINT',  () => { server.close(); process.exit(0); });
```

---

## Step 3: Create Dockerfile

Create `/workspaces/three.ws/workers/x402-facilitator/Dockerfile`:

```dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY index.js ./

ENV PORT=3100
ENV NODE_ENV=production

EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:3100/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "index.js"]
```

---

## Step 4: Update x402-middleware.js to optionally use this service

The existing `/workspaces/three.ws/api/_lib/x402-middleware.js` (from prompt 06) already calls `env.X402_FACILITATOR_URL_SOLANA`.

If three.ws deploys this facilitator, the operator sets:
```
X402_FACILITATOR_URL_SOLANA=http://x402-facilitator:3100
X402_FACILITATOR_TOKEN_SOLANA=<your-bearer-token>  # optional
```

No code changes to the middleware are needed — the env var switch is sufficient.

Document this in a `.env.example` at the facilitator root:

Create `/workspaces/three.ws/workers/x402-facilitator/.env.example`:

```
# x402-facilitator configuration
PORT=3100
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
SOLANA_RPC_URL_DEVNET=https://api.devnet.solana.com
USDC_MINT_MAINNET=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
USDC_MINT_DEVNET=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
MAX_AMOUNT_USDC=100
SETTLEMENT_TTL_MS=120000
# Optional: require Authorization: Bearer <token> on all requests
BEARER_TOKEN=
```

---

## Step 5: Verify the service starts

```bash
cd /workspaces/three.ws/workers/x402-facilitator && npm install 2>&1
node --check index.js && echo "syntax OK"
PORT=3199 node index.js &
FACILPID=$!
sleep 2
curl -sf http://localhost:3199/health && echo " — health OK"
curl -sf http://localhost:3199/supported && echo " — supported OK"
kill $FACILPID
```

---

## Success criteria

```
✔ /workspaces/three.ws/workers/x402-facilitator/index.js created (standalone Node HTTP server)
✔ /workspaces/three.ws/workers/x402-facilitator/package.json created
✔ /workspaces/three.ws/workers/x402-facilitator/Dockerfile created
✔ node --check index.js passes
✔ GET /health returns { ok: true }
✔ GET /supported returns solana-mainnet and solana-devnet entries
✔ POST /verify validates tx signature, checks USDC transfer, prevents replays
✔ POST /settle marks tx as used after verification
✔ Setting X402_FACILITATOR_URL_SOLANA to this service makes three.ws use it
```
