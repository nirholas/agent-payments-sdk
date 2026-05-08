# Task: Write integration tests for the x402 payment-gated chat flow in three.ws

## Context

- three.ws repo: `/workspaces/three.ws`
- Test runner: vitest (already configured, `npm test` in `/workspaces/three.ws`)
- Test pattern: see `/workspaces/three.ws/tests/agent-monetization.test.js` and `/workspaces/three.ws/tests/_helpers/monetization.js`
- All tests use mocked DB (vi.mock) and mocked auth — no real DB connection needed
- The x402 flow under test:
  1. `checkX402Payment` from `api/_lib/x402-middleware.js`
  2. Agent with `meta.x402` enabled/disabled
  3. Free message counting via mocked `x402_message_counts` table
  4. Payment verification via mocked facilitator fetch
  5. Idempotency via mocked `x402_payments` table

---

## Step 1: Read all relevant files before writing tests

```
/workspaces/three.ws/tests/agent-monetization.test.js      (pattern reference)
/workspaces/three.ws/tests/_helpers/monetization.js        (helper functions)
/workspaces/three.ws/api/_lib/x402-middleware.js            (module under test)
/workspaces/three.ws/api/_lib/x402-pricing.js              (module under test)
/workspaces/three.ws/api/_lib/x402.js                      (existing x402 helpers)
/workspaces/three.ws/vitest.config.js                      (test config)
```

---

## Step 2: Create test helpers

Add x402-specific helpers to `/workspaces/three.ws/tests/_helpers/x402.js`:

```js
// tests/_helpers/x402.js — helpers for x402 payment flow tests

import { Readable } from 'node:stream';

let counter = 0;

/**
 * Create a test agent with x402 config.
 */
export function createX402Agent({
  enabled = true,
  priceUsdc = 0.10,
  freeMessages = 5,
  description = 'Test agent',
  payTo = 'So11111111111111111111111111111111111111112',
} = {}) {
  const id = ++counter;
  const userId = `user-x402-${id}`;
  const agentId = `agent-x402-${id}-0000-0000-000000000000`;
  const agent = {
    id: agentId,
    user_id: userId,
    name: `X402 Test Agent ${id}`,
    wallet_address: payTo,
    meta: {
      x402: { enabled, priceUsdc, freeMessages, description, payTo },
    },
  };
  return { agent, userId, agentId };
}

/**
 * Create a minimal Vercel-style IncomingMessage.
 */
export function makeReq({ method = 'GET', url = '/api/chat', headers = {}, body = null } = {}) {
  const base = body
    ? Readable.from([Buffer.from(JSON.stringify(body))])
    : Readable.from([]);
  base.method = method;
  base.url = url;
  base.headers = {
    host: 'localhost',
    'x-forwarded-proto': 'https',
    ...(body ? { 'content-type': 'application/json' } : {}),
    ...headers,
  };
  return base;
}

/**
 * Create a minimal ServerResponse mock.
 */
export function makeRes() {
  const res = {
    statusCode: 200,
    _headers: {},
    _body: null,
    setHeader(name, value) {
      this._headers[name.toLowerCase()] = value;
    },
    getHeader(name) {
      return this._headers[name.toLowerCase()];
    },
    end(body) {
      this._body = body;
    },
    get body() {
      try { return JSON.parse(this._body); } catch { return this._body; }
    },
  };
  return res;
}

/**
 * Build a valid X-PAYMENT header for a given tx signature.
 * This is the base64 JSON format expected by the middleware.
 */
export function buildPaymentHeader({ txSignature, network = 'solana-mainnet', payTo, amount = '100000', asset = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' } = {}) {
  const payload = {
    x402Version: 1,
    scheme: 'exact',
    network,
    payload: {
      signature: txSignature || `sig_test_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      payTo,
      amount,
      asset,
    },
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

// Well-known devnet tx fixture (not a real tx — used for mocking only)
export const DEVNET_TX_FIXTURE = {
  signature: 'devnet_fixture_sig_abcdef1234567890abcdef1234567890abcdef1234567890ab',
  payer: 'Fx123TestPayer111111111111111111111111111111',
  amount: '100000',
};
```

---

## Step 3: Create the test file

Create `/workspaces/three.ws/tests/x402-payment-flow.test.js`:

```js
/**
 * x402 payment-gated chat flow — integration tests.
 *
 * Tests the full middleware flow:
 * 1. 402 returned when agent has x402 enabled and no payment header
 * 2. Free messages work correctly
 * 3. Valid payment accepted
 * 4. Replay attack prevention
 * 5. x402 disabled agent passes through freely
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createX402Agent,
  makeReq,
  makeRes,
  buildPaymentHeader,
  DEVNET_TX_FIXTURE,
} from './_helpers/x402.js';

// ── Module-level mock state ───────────────────────────────────────────────────

// DB mock: controls what sql`...` returns
const sqlMockState = {
  // Map of "sequence index" to return value.
  // Each call to sql() pops from this array.
  returns: [],
  calls: [],
};

// Facilitator fetch mock state
const fetchMockState = {
  responses: [],
};

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../api/_lib/db.js', () => ({
  sql: vi.fn(async (strings, ...values) => {
    sqlMockState.calls.push({ strings, values });
    return sqlMockState.returns.length ? sqlMockState.returns.shift() : [];
  }),
}));

vi.mock('../api/_lib/env.js', () => ({
  env: {
    X402_FACILITATOR_URL_SOLANA: 'http://mock-facilitator',
    X402_FACILITATOR_TOKEN_SOLANA: '',
    APP_ORIGIN: 'https://three.ws',
    SOLANA_CLUSTER: 'mainnet',
  },
}));

// Replace global fetch for facilitator calls
const originalFetch = global.fetch;
beforeEach(() => {
  global.fetch = vi.fn(async (url, opts) => {
    if (fetchMockState.responses.length) {
      const mockResp = fetchMockState.responses.shift();
      return {
        ok: mockResp.ok ?? true,
        status: mockResp.status ?? 200,
        json: async () => mockResp.body,
      };
    }
    // Default: facilitator says valid
    return {
      ok: true,
      status: 200,
      json: async () => ({ isValid: true, payer: 'mock_payer_address' }),
    };
  });
});

// ── Import module under test (after mocks) ────────────────────────────────────

const {
  checkX402Payment,
  send402ForAgent,
  verifyAgentPayment,
  buildPaymentRequirements,
  getAgentX402Config,
  isPaymentRequired,
} = await import('../api/_lib/x402-middleware.js');

// ── Reset between tests ───────────────────────────────────────────────────────

beforeEach(() => {
  sqlMockState.returns = [];
  sqlMockState.calls = [];
  fetchMockState.responses = [];
  vi.clearAllMocks();
});

// ── Test Suite 1: 402 returned correctly ─────────────────────────────────────

describe('402 response format', () => {
  it('returns 402 with correct x402 body when agent has x402 enabled', async () => {
    const { agent } = createX402Agent({ enabled: true, priceUsdc: 0.10, freeMessages: 0 });
    const req = makeReq({ method: 'POST', url: '/api/chat' });
    const res = makeRes();
    const userId = 'user-test-001';

    // isPaymentRequired will query x402_message_counts — return empty
    sqlMockState.returns.push([]);

    const result = await checkX402Payment(req, res, agent, userId, 'test message');

    expect(result).toBe(false);
    expect(res.statusCode).toBe(402);
    expect(res._headers['content-type']).toMatch('application/json');

    const body = res.body;
    expect(body.x402Version).toBe(1);
    expect(body.error).toBe('payment required');
    expect(Array.isArray(body.accepts)).toBe(true);
    expect(body.accepts.length).toBeGreaterThan(0);

    const accept = body.accepts[0];
    expect(accept.scheme).toBe('exact');
    expect(accept.network).toMatch(/solana/);
    expect(accept.payTo).toBe(agent.meta.x402.payTo);
    expect(accept.asset).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(accept.maxTimeoutSeconds).toBe(300);
    expect(accept.extra).toMatchObject({ name: 'USDC', decimals: 6 });
  });

  it('payTo matches agent meta.x402.payTo exactly', async () => {
    const payTo = 'AgentWallet1111111111111111111111111111111';
    const { agent } = createX402Agent({ payTo, freeMessages: 0 });
    const req = makeReq();
    const res = makeRes();

    sqlMockState.returns.push([]);
    await checkX402Payment(req, res, agent, 'user-1', '');

    const body = res.body;
    expect(body.accepts[0].payTo).toBe(payTo);
  });

  it('maxAmountRequired matches priceUsdc × 1e6', async () => {
    const { agent } = createX402Agent({ priceUsdc: 0.25, freeMessages: 0 });
    const req = makeReq();
    const res = makeRes();

    sqlMockState.returns.push([]);
    await checkX402Payment(req, res, agent, 'user-1', '');

    const body = res.body;
    // $0.25 = 250000 minor units
    expect(body.accepts[0].maxAmountRequired).toBe('250000');
  });
});

// ── Test Suite 2: Free messages ───────────────────────────────────────────────

describe('free messages', () => {
  it('allows requests within free message limit', async () => {
    const { agent } = createX402Agent({ enabled: true, priceUsdc: 0.10, freeMessages: 5 });
    const req = makeReq();
    const res = makeRes();
    const userId = 'user-free-test';

    // message_count is 3 (below freeMessages=5) → not required
    sqlMockState.returns.push([{ message_count: 3 }]);
    // recordFreeMessage inserts — return empty
    sqlMockState.returns.push([]);

    const result = await checkX402Payment(req, res, agent, userId, '');

    expect(result).toBe(true);
    expect(res.statusCode).toBe(200);  // unmodified
  });

  it('returns 402 when free messages are exhausted', async () => {
    const { agent } = createX402Agent({ enabled: true, priceUsdc: 0.10, freeMessages: 5 });
    const req = makeReq();
    const res = makeRes();
    const userId = 'user-free-exhausted';

    // message_count is exactly freeMessages — payment now required
    sqlMockState.returns.push([{ message_count: 5 }]);

    const result = await checkX402Payment(req, res, agent, userId, '');

    expect(result).toBe(false);
    expect(res.statusCode).toBe(402);
  });

  it('anonymous users always pay (no free messages)', async () => {
    const { agent } = createX402Agent({ enabled: true, freeMessages: 10 });
    const req = makeReq();
    const res = makeRes();

    // null userId = anonymous
    const result = await checkX402Payment(req, res, agent, null, '');

    expect(result).toBe(false);
    expect(res.statusCode).toBe(402);
  });

  it('first 5 requests are free, 6th requires payment', async () => {
    const { agent } = createX402Agent({ enabled: true, freeMessages: 5 });
    const userId = 'user-free-cycle';

    for (let i = 0; i < 5; i++) {
      const req = makeReq();
      const res = makeRes();
      sqlMockState.returns.push([{ message_count: i }]);  // i < 5 → free
      sqlMockState.returns.push([]);  // recordFreeMessage
      const result = await checkX402Payment(req, res, agent, userId, '');
      expect(result).toBe(true, `request ${i + 1} should be free`);
    }

    // 6th request: message_count = 5 = freeMessages → payment required
    const req6 = makeReq();
    const res6 = makeRes();
    sqlMockState.returns.push([{ message_count: 5 }]);
    const result6 = await checkX402Payment(req6, res6, agent, userId, '');
    expect(result6).toBe(false);
    expect(res6.statusCode).toBe(402);
  });
});

// ── Test Suite 3: Valid payment accepted ──────────────────────────────────────

describe('valid payment accepted', () => {
  it('accepts a valid X-PAYMENT header and returns true', async () => {
    const payTo = 'AgentWallet1111111111111111111111111111111';
    const { agent } = createX402Agent({ payTo, freeMessages: 0 });
    const userId = 'user-paying';
    const txSig = `valid_sig_${Date.now()}`;

    const paymentHeader = buildPaymentHeader({
      txSignature: txSig,
      payTo,
      amount: '100000',
    });

    const req = makeReq({
      headers: { 'x-payment': paymentHeader },
    });
    const res = makeRes();

    // isPaymentRequired → message_count query → exhausted (payment required)
    sqlMockState.returns.push([{ message_count: 99 }]);
    // Idempotency check: tx not in x402_payments
    sqlMockState.returns.push([]);
    // Facilitator verify → success (default mock returns isValid: true)
    // Record payment in x402_payments
    sqlMockState.returns.push([]);

    const result = await checkX402Payment(req, res, agent, userId, 'hello agent');

    expect(result).toBe(true);
    expect(res.statusCode).toBe(200);  // not modified to 402
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/verify'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('records the payment in x402_payments on success', async () => {
    const { agent } = createX402Agent({ freeMessages: 0 });
    const userId = 'user-record-test';
    const txSig = `record_sig_${Date.now()}`;

    sqlMockState.returns.push([{ message_count: 99 }]);  // isPaymentRequired
    sqlMockState.returns.push([]);   // idempotency check
    sqlMockState.returns.push([]);   // record insert

    const paymentHeader = buildPaymentHeader({ txSignature: txSig, payTo: agent.meta.x402.payTo });
    const req = makeReq({ headers: { 'x-payment': paymentHeader } });
    const res = makeRes();

    await checkX402Payment(req, res, agent, userId, 'recorded message');

    // Verify the DB insert was called
    const insertCall = sqlMockState.calls.find(c =>
      c.strings.join('').includes('insert into x402_payments')
    );
    expect(insertCall).toBeDefined();
  });
});

// ── Test Suite 4: Replay attack prevention ────────────────────────────────────

describe('replay attack prevention', () => {
  it('rejects a payment header with an already-used tx signature', async () => {
    const { agent } = createX402Agent({ freeMessages: 0 });
    const userId = 'user-replay';
    const txSig = 'already_used_signature_12345';

    const paymentHeader = buildPaymentHeader({ txSignature: txSig, payTo: agent.meta.x402.payTo });
    const req = makeReq({ headers: { 'x-payment': paymentHeader } });
    const res = makeRes();

    // isPaymentRequired → payment required
    sqlMockState.returns.push([{ message_count: 99 }]);
    // Idempotency check: tx IS in x402_payments (replay!)
    sqlMockState.returns.push([{ id: 'existing_payment_id' }]);

    const result = await checkX402Payment(req, res, agent, userId, '');

    expect(result).toBe(false);
    expect(res.statusCode).toBe(402);

    const body = res.body;
    expect(body.error).toMatch(/already used/i);

    // Facilitator should NOT have been called (idempotency check happened first)
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('rejects when facilitator returns invalid', async () => {
    const { agent } = createX402Agent({ freeMessages: 0 });
    const userId = 'user-invalid';

    const paymentHeader = buildPaymentHeader({ payTo: agent.meta.x402.payTo });
    const req = makeReq({ headers: { 'x-payment': paymentHeader } });
    const res = makeRes();

    sqlMockState.returns.push([{ message_count: 99 }]);  // isPaymentRequired
    sqlMockState.returns.push([]);   // idempotency check (not used)

    // Facilitator returns invalid
    fetchMockState.responses.push({
      ok: true,
      status: 200,
      body: { isValid: false, invalidReason: 'insufficient amount' },
    });

    const result = await checkX402Payment(req, res, agent, userId, '');

    expect(result).toBe(false);
    expect(res.statusCode).toBe(402);
    const body = res.body;
    expect(body.error).toMatch(/insufficient amount/i);
  });
});

// ── Test Suite 5: Agent without x402 ─────────────────────────────────────────

describe('agent without x402 enabled', () => {
  it('passes through when agent.meta.x402 is absent', async () => {
    const agent = {
      id: 'agent-no-x402',
      user_id: 'user-1',
      name: 'Free Agent',
      meta: {},  // no x402
    };
    const req = makeReq();
    const res = makeRes();

    const result = await checkX402Payment(req, res, agent, 'user-1', '');

    expect(result).toBe(true);
    expect(res.statusCode).toBe(200);
    // No DB calls should have been made
    expect(sqlMockState.calls.length).toBe(0);
  });

  it('passes through when agent.meta.x402.enabled is false', async () => {
    const { agent } = createX402Agent({ enabled: false });
    const req = makeReq();
    const res = makeRes();

    const result = await checkX402Payment(req, res, agent, 'user-1', '');

    expect(result).toBe(true);
    expect(res.statusCode).toBe(200);
  });
});

// ── Test Suite 6: buildPaymentRequirements ────────────────────────────────────

describe('buildPaymentRequirements', () => {
  it('builds correct requirements object', () => {
    const { agent } = createX402Agent({ priceUsdc: 1.00, payTo: 'TestPayTo111111111111111111111111111111' });
    const reqs = buildPaymentRequirements({ agent, resourceUrl: 'https://three.ws/api/chat' });

    expect(reqs).toHaveLength(1);
    const req = reqs[0];
    expect(req.scheme).toBe('exact');
    expect(req.maxAmountRequired).toBe('1000000');  // $1.00 = 1_000_000 minor
    expect(req.payTo).toBe('TestPayTo111111111111111111111111111111');
    expect(req.resource).toBe('https://three.ws/api/chat');
    expect(req.maxTimeoutSeconds).toBe(300);
  });

  it('throws if agent has no x402 config', () => {
    const agent = { id: 'x', name: 'x', meta: {} };
    expect(() => buildPaymentRequirements({ agent, resourceUrl: 'http://x' })).toThrow();
  });
});
```

---

## Step 4: Run the tests

```bash
cd /workspaces/three.ws && npm test -- --reporter=verbose 2>&1 | grep -A 5 'x402-payment-flow\|PASS\|FAIL'
```

Or run just the x402 tests:
```bash
cd /workspaces/three.ws && npx vitest run tests/x402-payment-flow.test.js --reporter=verbose 2>&1
```

---

## Step 5: Fix any failures

Common issues and fixes:

**Issue: `Cannot find module '../api/_lib/x402-middleware.js'`**
The module doesn't exist yet — it must be created in prompt 06 first. If you're running this test in isolation, you'll need to create a stub for the middleware.

**Issue: Import is not mocked in time**
Vitest's `vi.mock` hoisting should handle this. If not, move the import below the `vi.mock` calls using a dynamic import:
```js
const { checkX402Payment } = await import('../api/_lib/x402-middleware.js');
```
(Already done in the test template above.)

**Issue: `env` module not found or has different structure**
Read `/workspaces/three.ws/api/_lib/env.js` and adjust the mock to match the actual exported shape.

**Issue: Tests pass but coverage is incomplete**
Add more edge cases. Check the middleware implementation for branches not yet covered.

---

## Success criteria

```
✔ /workspaces/three.ws/tests/x402-payment-flow.test.js created
✔ /workspaces/three.ws/tests/_helpers/x402.js created
✔ All 16+ test cases pass
✔ No external network calls are made (all fetch mocked)
✔ npm test in three.ws passes (all existing tests still pass)
✔ Tests cover: 402 format, free messages, valid payment, replay prevention, disabled agent
```
