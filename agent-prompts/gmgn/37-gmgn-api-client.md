# Prompt 37 — GMGN API Client

## Goal
Build a complete GMGN API client for three.ws using Ed25519 request signing. The client handles authentication, request signing, response parsing, and all smart money endpoints.

## Credentials

Never hardcode these in the prompt, the client, or any committed file. Read them
from the environment at runtime:

- API key: `process.env.GMGN_API_KEY`
- Private key PEM: `process.env.GMGN_PRIVATE_KEY_PEM`, or a path in
  `process.env.GMGN_PRIVATE_KEY_PATH` (Ed25519 PKCS#8 PEM). Local key files are
  gitignored as `.gmgn_private.pem` / `.gmgn_public.pem`.

The PEM is a PKCS#8 Ed25519 private key of the form:

```
-----BEGIN PRIVATE KEY-----
<base64 body, 48 bytes DER, never commit this>
-----END PRIVATE KEY-----
```

Node.js `crypto.createPrivateKey()` accepts that PEM directly.

## Environment
- Working directory: `/workspaces/three.ws`
- Runtime: Node.js (ESM, Vercel serverless)
- Node.js `crypto` module: available natively — use `crypto.sign()` with `ed25519` algorithm
- Cloudflare notice: GMGN blocks datacenter IPs. The client is designed to work when:
  - Running locally during development
  - Deployed on a residential proxy or direct server (not Vercel edge)
  - Use `process.env.GMGN_PROXY_URL` for optional HTTP proxy routing

## GMGN Request Signing Format

```
Message = "${timestamp}\n${METHOD}\n${path}\n${bodyHash}"

Where:
  timestamp  = Unix seconds as string
  METHOD     = 'GET' or 'POST' (uppercase)
  path       = URL path + query string (e.g. /api/v1/smart-money/sol/swaps?limit=10)
  bodyHash   = hex(SHA-256(requestBodyString))   // empty string if no body

Signature = Ed25519(privateKey, Message)

Headers:
  X-API-KEY:   ${process.env.GMGN_API_KEY}
  X-TIMESTAMP: ${timestamp}
  X-SIGNATURE: ${base64(signature)}
```

## Task 1 — GmgnClient

Create `/workspaces/three.ws/src/kol/gmgn-client.js`:

```javascript
// @ts-check
/**
 * GMGN API client with Ed25519 request signing.
 * 
 * CLOUDFLARE NOTE: GMGN.ai uses Cloudflare Bot Management.
 * Direct calls from Vercel/AWS datacenters will be blocked with 403.
 * Solutions:
 *   1. Run from local dev environment
 *   2. Use a residential proxy: set GMGN_PROXY_URL=http://user:pass@proxy:port
 *   3. Use a browser-side fetch relay
 * 
 * This client will still function — it builds correct signed requests.
 * CF blocking is a deployment/infrastructure concern, not an API concern.
 */

import { createPrivateKey, createHash, sign } from 'crypto';
import { readFileSync } from 'fs';

const BASE_URL = 'https://gmgn.ai';

export class GmgnClient {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey
   * @param {string} opts.privateKeyPem  — PEM string of Ed25519 PKCS#8 key
   * @param {string} [opts.baseUrl]      — default: https://gmgn.ai
   * @param {string} [opts.proxyUrl]     — optional HTTP proxy URL
   */
  constructor({ apiKey, privateKeyPem, baseUrl = BASE_URL, proxyUrl }) {
    if (!apiKey) throw new Error('GmgnClient: apiKey required');
    if (!privateKeyPem) throw new Error('GmgnClient: privateKeyPem required');
    this.apiKey = apiKey;
    this.privateKey = createPrivateKey(privateKeyPem);
    this.baseUrl = baseUrl;
    this.proxyUrl = proxyUrl;
  }

  /**
   * Sign a request and return auth headers.
   * @param {string} method  — 'GET' | 'POST'
   * @param {string} path    — e.g. '/api/v1/smart-money/sol/swaps'
   * @param {string} [body]  — request body string (empty if GET)
   * @returns {{ 'X-API-KEY': string, 'X-TIMESTAMP': string, 'X-SIGNATURE': string }}
   */
  signRequest(method, path, body = '') {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const bodyHash = createHash('sha256').update(body).digest('hex');
    const message = `${timestamp}\n${method.toUpperCase()}\n${path}\n${bodyHash}`;
    const msgBuf = Buffer.from(message, 'utf8');
    const sigBuf = sign(null, msgBuf, this.privateKey);
    return {
      'X-API-KEY': this.apiKey,
      'X-TIMESTAMP': timestamp,
      'X-SIGNATURE': sigBuf.toString('base64'),
    };
  }

  /**
   * Make an authenticated GET request.
   * @param {string} path   — path without base URL
   * @param {Record<string,any>} [params] — query parameters
   * @returns {Promise<any>}
   */
  async get(path, params = {}) {
    const query = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])
    ).toString();
    const fullPath = query ? `${path}?${query}` : path;
    const headers = {
      ...this.signRequest('GET', fullPath),
      'accept': 'application/json',
      'user-agent': 'Mozilla/5.0 (compatible; three.ws/1.0)',
    };

    const url = `${this.baseUrl}${fullPath}`;
    const fetchOpts = { method: 'GET', headers };
    
    // Optional proxy support via node-fetch or undici
    const resp = await this._fetch(url, fetchOpts);
    return this._parseResponse(resp);
  }

  /**
   * Make an authenticated POST request.
   * @param {string} path
   * @param {object} body
   * @returns {Promise<any>}
   */
  async post(path, body = {}) {
    const bodyStr = JSON.stringify(body);
    const headers = {
      ...this.signRequest('POST', path, bodyStr),
      'accept': 'application/json',
      'content-type': 'application/json',
      'user-agent': 'Mozilla/5.0 (compatible; three.ws/1.0)',
    };

    const url = `${this.baseUrl}${path}`;
    const resp = await this._fetch(url, { method: 'POST', headers, body: bodyStr });
    return this._parseResponse(resp);
  }

  async _fetch(url, opts) {
    // Use node-fetch with proxy if configured
    // node-fetch v3 is ESM; use dynamic import
    if (this.proxyUrl) {
      const { HttpsProxyAgent } = await import('https-proxy-agent').catch(() => ({ HttpsProxyAgent: null }));
      if (HttpsProxyAgent) {
        opts.agent = new HttpsProxyAgent(this.proxyUrl);
      }
    }
    return fetch(url, opts);
  }

  async _parseResponse(resp) {
    const text = await resp.text();
    if (!resp.ok) {
      // Detect Cloudflare block
      if (resp.status === 403 && text.includes('Cloudflare')) {
        throw Object.assign(
          new Error('GMGN: Cloudflare blocked request. Use a residential proxy (set GMGN_PROXY_URL) or run locally.'),
          { status: 403, code: 'cloudflare_blocked' }
        );
      }
      let errBody;
      try { errBody = JSON.parse(text); } catch { errBody = { message: text }; }
      throw Object.assign(
        new Error(`GMGN API error ${resp.status}: ${errBody?.message || text.slice(0, 200)}`),
        { status: resp.status, body: errBody }
      );
    }
    try { return JSON.parse(text); }
    catch { return text; }
  }

  // ── Smart Money Endpoints ─────────────────────────────────────────────────

  /**
   * Get top smart money wallets.
   * @param {{ chain?: string, limit?: number, window?: '1h'|'4h'|'8h'|'24h'|'7d'|'30d' }} opts
   */
  async getSmartWallets({ chain = 'sol', limit = 20, window = '7d' } = {}) {
    return this.get(`/api/v1/smart-money/${chain}/wallets`, { limit, window });
  }

  /**
   * Get recent trades by a smart wallet.
   * @param {string} address  — Solana wallet address
   * @param {{ chain?: string, limit?: number }} opts
   */
  async getWalletTrades(address, { chain = 'sol', limit = 20 } = {}) {
    return this.get(`/api/v1/smart-money/${chain}/wallet_activity/${address}`, { limit });
  }

  /**
   * Get current token holdings for a wallet.
   * @param {string} address
   * @param {{ chain?: string }} opts
   */
  async getWalletHoldings(address, { chain = 'sol' } = {}) {
    return this.get(`/api/v1/smart-money/${chain}/wallet_holdings/${address}`);
  }

  /**
   * Get smart money signals for a specific token.
   * @param {string} mint  — token mint address
   * @param {{ chain?: string }} opts
   */
  async getTokenSignals(mint, { chain = 'sol' } = {}) {
    return this.get(`/api/v1/smart-money/${chain}/token_activity/${mint}`);
  }

  /**
   * Get newly created token pairs with minimum liquidity.
   * @param {{ chain?: string, minLiquidityUsd?: number, limit?: number }} opts
   */
  async getNewPairs({ chain = 'sol', minLiquidityUsd = 10000, limit = 20 } = {}) {
    return this.get(`/api/v1/${chain}/new_pairs`, { min_liquidity: minLiquidityUsd, limit });
  }

  /**
   * Get trending tokens ranked by smart money inflow.
   * @param {{ chain?: string, window?: string, limit?: number }} opts
   */
  async getTrendingTokens({ chain = 'sol', window = '1h', limit = 20 } = {}) {
    return this.get(`/api/v1/${chain}/trending`, { timeframe: window, limit });
  }
}
```

## Task 2 — Singleton Export for API Routes

Create `/workspaces/three.ws/api/_lib/gmgn.js`:

```javascript
// Singleton GmgnClient for use in Vercel API routes.
// Loaded once per warm instance.
//
// Required env vars:
//   GMGN_API_KEY             — your GMGN API key
//   GMGN_PRIVATE_KEY_PEM     — Ed25519 private key PEM (full content, newlines as \n)
//   GMGN_PROXY_URL           — optional residential proxy (http://user:pass@host:port)
//
// Alternative: if reading from file is preferred in dev:
//   GMGN_PRIVATE_KEY_PEM_PATH — absolute path to .pem file

import { GmgnClient } from '../../src/kol/gmgn-client.js';
import { readFileSync } from 'fs';

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`GmgnClient: missing required env var ${name}.`);
  }
  return value;
}

function loadPrivateKeyPem() {
  // Option 1: env var (production)
  if (process.env.GMGN_PRIVATE_KEY_PEM) {
    return process.env.GMGN_PRIVATE_KEY_PEM.replace(/\\n/g, '\n');
  }
  // Option 2: env var pointing to file path
  if (process.env.GMGN_PRIVATE_KEY_PEM_PATH) {
    return readFileSync(process.env.GMGN_PRIVATE_KEY_PEM_PATH, 'utf8');
  }
  // Option 3: default dev path (agent-payments-sdk repo next to three.ws)
  const devPath = '/workspaces/agent-payments-sdk/.gmgn_private.pem';
  try {
    return readFileSync(devPath, 'utf8');
  } catch {
    throw new Error('GmgnClient: no private key configured. Set GMGN_PRIVATE_KEY_PEM or GMGN_PRIVATE_KEY_PEM_PATH.');
  }
}

let _client;
export function getGmgnClient() {
  if (!_client) {
    _client = new GmgnClient({
      apiKey: requireEnv('GMGN_API_KEY'),
      privateKeyPem: loadPrivateKeyPem(),
      proxyUrl: process.env.GMGN_PROXY_URL,
    });
  }
  return _client;
}

// Named singleton (convenience)
export const gmgn = {
  get client() { return getGmgnClient(); },
};
```

## Task 3 — Smoke Test

Add a smoke test file `/workspaces/three.ws/src/kol/gmgn-client.test.js`:

```javascript
// Run with: node --test gmgn-client.test.js
// Tests signing only — no live network required

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GmgnClient } from './gmgn-client.js';
import { readFileSync } from 'fs';

const pem = readFileSync('/workspaces/agent-payments-sdk/.gmgn_private.pem', 'utf8');

test('GmgnClient: signRequest produces stable headers', () => {
  const client = new GmgnClient({ apiKey: 'test-key', privateKeyPem: pem });
  const headers = client.signRequest('GET', '/api/v1/test?limit=10');
  
  assert.equal(headers['X-API-KEY'], 'test-key');
  assert.ok(headers['X-TIMESTAMP']);
  assert.ok(headers['X-SIGNATURE']);
  
  // Signature should be base64
  const sigBytes = Buffer.from(headers['X-SIGNATURE'], 'base64');
  assert.equal(sigBytes.length, 64, 'Ed25519 signature must be 64 bytes');
});

test('GmgnClient: different requests produce different signatures', () => {
  const client = new GmgnClient({ apiKey: 'test-key', privateKeyPem: pem });
  const h1 = client.signRequest('GET', '/api/v1/path1');
  // Small delay to ensure timestamp differs
  const h2 = client.signRequest('GET', '/api/v1/path2');
  
  // Signatures should differ (different paths)
  assert.notEqual(h1['X-SIGNATURE'], h2['X-SIGNATURE']);
});

test('GmgnClient: POST body is included in signature', () => {
  const client = new GmgnClient({ apiKey: 'test-key', privateKeyPem: pem });
  const h1 = client.signRequest('POST', '/api/v1/path', '{"a":1}');
  const h2 = client.signRequest('POST', '/api/v1/path', '{"a":2}');
  assert.notEqual(h1['X-SIGNATURE'], h2['X-SIGNATURE']);
});
```

Run the test: `node --test /workspaces/three.ws/src/kol/gmgn-client.test.js`

## File Checklist
- [ ] `/workspaces/three.ws/src/kol/gmgn-client.js`
- [ ] `/workspaces/three.ws/api/_lib/gmgn.js`
- [ ] `/workspaces/three.ws/src/kol/gmgn-client.test.js`

## Verification
1. `node --test /workspaces/three.ws/src/kol/gmgn-client.test.js` — all 3 tests pass
2. `node -e "import('/workspaces/three.ws/api/_lib/gmgn.js').then(m => console.log(typeof m.getGmgnClient))"` — prints `function`
3. `node -e "import('/workspaces/three.ws/api/_lib/gmgn.js').then(m => { const c = m.getGmgnClient(); console.log('client ok', typeof c.getTrendingTokens); })"` — prints `client ok function`
