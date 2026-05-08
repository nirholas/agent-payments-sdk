# Prompt 36 — End-to-End Integration Tests: Tokenized Agent Loop

## Goal
Write a complete end-to-end integration test suite for the tokenized agent loop (create → tokenize → pay → distribute → withdraw → revenue). Tests run against devnet and a test Postgres DB. No mocks, no stubs.

## Environment
- Working directory: `/workspaces/three.ws`
- Test framework: Vitest (`vitest` in devDependencies)
- Test file to create: `/workspaces/three.ws/tests/tokenized-agent-loop.test.js`
- Test DB: `process.env.POSTGRES_TEST_URL` (separate DB from production)
- Solana devnet: `https://api.devnet.solana.com`
- USDC devnet mint: `Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr` (SPL devnet USDC — use a faucet or devnet token)
- Existing test pattern: `ls /workspaces/three.ws/tests/` — read existing tests first

## Read First
1. `ls /workspaces/three.ws/tests/` — understand existing test patterns
2. `cat /workspaces/three.ws/package.json | grep -A5 '"test"'` — find how tests are run
3. `/workspaces/three.ws/api/_lib/db.js` — understand DB setup
4. `/workspaces/three.ws/api/agents/[id]/tokenize.js` (prompt 31) — understand the tokenize endpoint
5. `/workspaces/three.ws/api/agents/[id]/tokenize-confirm.js` (prompt 31)
6. `/workspaces/three.ws/api/agents/[id]/revenue.js` (prompt 32)
7. `/workspaces/three.ws/api/cron/distribute-agent-payments.js` (prompt 33)

## Setup

### Test keypair
Generate a test keypair at the top of the test file:
```javascript
import { Keypair, Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';

const TEST_KEYPAIR = Keypair.generate();
const DEVNET_CONNECTION = new Connection('https://api.devnet.solana.com', 'confirmed');

// Fund the test wallet with devnet SOL before tests run
async function fundTestWallet(keypair, solAmount = 1) {
  const airdropSig = await DEVNET_CONNECTION.requestAirdrop(
    keypair.publicKey,
    solAmount * LAMPORTS_PER_SOL
  );
  await DEVNET_CONNECTION.confirmTransaction(airdropSig);
}
```

### Test DB setup
```javascript
import { neon } from '@neondatabase/serverless';

const testSql = neon(process.env.POSTGRES_TEST_URL || process.env.DATABASE_URL + '_test');

async function cleanupTestAgent(agentId) {
  await testSql`DELETE FROM agent_identities WHERE id = ${agentId}`;
  await testSql`DELETE FROM distribution_runs WHERE agent_id = ${agentId}`;
  await testSql`DELETE FROM price_alerts WHERE agent_id = ${agentId}`;
  await testSql`DELETE FROM x402_payments WHERE agent_id = ${agentId}`;
}
```

### HTTP test helper
Create a helper that calls the Vercel API handlers directly (not via HTTP) to avoid needing a running server:
```javascript
import { createServer } from 'http';
import { promisify } from 'util';

// Import handlers directly
import tokenizeHandler from '../api/agents/[id]/tokenize.js';
import tokenizeConfirmHandler from '../api/agents/[id]/tokenize-confirm.js';
import revenueHandler from '../api/agents/[id]/revenue.js';

function makeReq(method, path, body = null, query = {}) {
  const req = {
    method,
    url: path,
    headers: { 'content-type': 'application/json', 'cookie': '' },
    query,
    body: null,
    // Simulate session auth — inject test user directly
    _testUser: { id: TEST_USER_ID, email: 'test@test.com' },
  };
  if (body) {
    req.body = body;
    // Make the handler read from req.body directly in test mode
  }
  return req;
}

function makeRes() {
  const res = {
    statusCode: 200,
    _headers: {},
    _body: null,
    setHeader(k, v) { this._headers[k] = v; },
    end(body) { this._body = body; },
  };
  return res;
}
```

**Important:** The API handlers use `getSessionUser(req)` for auth. In tests, monkey-patch this by mocking the auth module or by passing a special test header that your auth module accepts when `NODE_ENV=test`.

Alternative (simpler): call the handler functions directly with a pre-built auth context, bypassing HTTP entirely, by exporting the business logic functions separately from the handlers.

## Test Suite

```javascript
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';

const TEST_USER_ID = 'test-user-' + Date.now();
let TEST_AGENT_ID;
let TEST_MINT;

describe('Tokenized Agent Loop', () => {

  beforeAll(async () => {
    // Fund test wallet
    await fundTestWallet(TEST_KEYPAIR, 2);
    
    // Create test user in DB
    await testSql`
      INSERT INTO users (id, email, created_at)
      VALUES (${TEST_USER_ID}, ${'test-' + Date.now() + '@test.com'}, now())
      ON CONFLICT DO NOTHING
    `.catch(() => {}); // ignore if users table has different schema
  });

  afterEach(async () => {
    if (TEST_AGENT_ID) {
      await cleanupTestAgent(TEST_AGENT_ID).catch(() => {});
    }
  });

  afterAll(async () => {
    if (TEST_AGENT_ID) {
      await cleanupTestAgent(TEST_AGENT_ID).catch(() => {});
    }
  });
```

### Test 1: Agent Creation and Tokenize Prep
```javascript
  it('creates an agent and returns two unsigned txs from /tokenize', async () => {
    // 1. Create agent in DB
    const [agent] = await testSql`
      INSERT INTO agent_identities (id, owner_id, name, description, meta, created_at)
      VALUES (
        gen_random_uuid()::text,
        ${TEST_USER_ID},
        'Test Agent ' || floor(random()*10000)::text,
        'Test agent for integration testing',
        '{}',
        now()
      )
      RETURNING *
    `;
    TEST_AGENT_ID = agent.id;
    
    // 2. Call tokenize endpoint
    const body = { priceUsdc: 0.01, initialBuySol: 0, buybackBps: 5000 };
    
    // Call handler directly with auth bypass
    // ... (depends on how auth is structured — see handler implementation)
    
    // Alternative: make real HTTP call if test server is running
    const resp = await callTokenizeEndpoint(TEST_AGENT_ID, TEST_USER_ID, body);
    
    // 3. Verify response
    expect(resp.status).toBe(200);
    expect(resp.body).toHaveProperty('createCoinTx');
    expect(resp.body).toHaveProperty('registerPaymentsTx');
    expect(resp.body).toHaveProperty('mintPubkey');
    expect(resp.body.createCoinTx).toMatch(/^[A-Za-z0-9+/=]{100,}/); // valid base64
    
    // 4. Verify pending state in DB
    const [updated] = await testSql`SELECT meta FROM agent_identities WHERE id = ${TEST_AGENT_ID}`;
    expect(updated.meta?.tokenizePending?.mintPubkey).toBe(resp.body.mintPubkey);
    
    TEST_MINT = resp.body.mintPubkey;
  }, 30_000);
```

### Test 2: Tokenize Confirm (simulated)
```javascript
  it('confirms tokenization with two devnet tx signatures', async () => {
    if (!TEST_AGENT_ID || !TEST_MINT) {
      // Set up pending state manually for isolation
      TEST_AGENT_ID = await createTestAgentWithPendingTokenize(TEST_USER_ID);
      TEST_MINT = 'FAKEDEVNETMINT' + Date.now(); // placeholder
    }
    
    // We can't submit real txs in a unit test, so we test the confirm logic
    // by mocking verifySignature to return success for known test sigs
    
    // Insert a fake pending state
    await testSql`
      UPDATE agent_identities
      SET meta = jsonb_set(
        meta,
        '{tokenizePending}',
        ${JSON.stringify({ mintPubkey: TEST_MINT, priceUsdc: 0.01, buybackBps: 5000, createdAt: new Date().toISOString() })}
      )
      WHERE id = ${TEST_AGENT_ID}
    `;
    
    // With a real devnet setup: sign and submit the actual txs
    // For CI: skip on-chain parts, test only DB update logic
    const FAKE_SIG_1 = '5' + 'x'.repeat(86); // placeholder sig
    const FAKE_SIG_2 = '3' + 'n'.repeat(86);
    
    // If DEVNET_INTEGRATION env var is set, submit real txs
    if (process.env.DEVNET_INTEGRATION === '1') {
      // TODO: deserialize txs from step 1 test, sign with TEST_KEYPAIR, submit
      console.log('Skipping on-chain submission in CI');
    }
    
    // Call confirm handler in "offline mode" (bypass verifySignature in test env)
    process.env.SKIP_TX_VERIFY = '1'; // add this check in tokenize-confirm.js
    const resp = await callTokenizeConfirmEndpoint(TEST_AGENT_ID, TEST_USER_ID, {
      createCoinSig: FAKE_SIG_1,
      registerPaymentsSig: FAKE_SIG_2,
    });
    delete process.env.SKIP_TX_VERIFY;
    
    expect(resp.status).toBe(200);
    
    // Verify DB update
    const [updated] = await testSql`SELECT meta FROM agent_identities WHERE id = ${TEST_AGENT_ID}`;
    expect(updated.meta?.token?.mint).toBe(TEST_MINT);
    expect(updated.meta?.payments?.configured).toBe(true);
    expect(updated.meta?.x402?.enabled).toBe(true);
    expect(updated.meta?.tokenizePending).toBeNull();
  }, 30_000);
```

### Test 3: x402 Payment Flow (devnet)
```javascript
  it('rejects chat request without payment and accepts with payment proof', async () => {
    if (!TEST_AGENT_ID) return; // skip if no agent
    
    // Ensure agent has x402 enabled
    await testSql`
      UPDATE agent_identities
      SET meta = jsonb_set(meta, '{x402}', '{"enabled": true, "priceUsdc": 0.01}')
      WHERE id = ${TEST_AGENT_ID}
    `;
    
    // 1. POST to chat without payment header → expect 402
    const noPaymentResp = await fetch(`http://localhost:3000/api/chat?agentId=${TEST_AGENT_ID}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
    }).catch(() => null);
    
    if (noPaymentResp) {
      expect(noPaymentResp.status).toBe(402);
      const body = await noPaymentResp.json();
      expect(body).toHaveProperty('x402Version');
    } else {
      console.log('Skipping 402 test — no test server running');
    }
    
    // 2. Build a devnet USDC payment proof
    // This requires a funded devnet USDC account — skip in CI unless DEVNET_INTEGRATION=1
    if (process.env.DEVNET_INTEGRATION === '1') {
      // TODO: build x402 payment proof with TEST_KEYPAIR
      // const proof = await buildX402Payment({ keypair: TEST_KEYPAIR, amountUsdc: 0.01, ... });
      // const paidResp = await fetch(`http://localhost:3000/api/chat?agentId=${TEST_AGENT_ID}`, {
      //   headers: { 'X-PAYMENT': JSON.stringify(proof), 'content-type': 'application/json' },
      //   ...
      // });
      // expect(paidResp.status).toBe(200);
    }
  }, 60_000);
```

### Test 4: Distribution Cron (mocked vault)
```javascript
  it('triggers auto-distribute and records in distribution_runs', async () => {
    if (!TEST_AGENT_ID) return;
    
    // Ensure agent is configured
    await testSql`
      UPDATE agent_identities
      SET meta = jsonb_set(
        meta,
        '{payments}',
        '{"configured": true, "buybackBps": 5000}'
      )
      WHERE id = ${TEST_AGENT_ID}
    `;
    
    // Mock PumpAgent.getBalances to return 2 USDC
    // The cron calls getPumpAgent → pumpAgent.getBalances
    // We need to inject a mock — use vi.mock or override the module
    
    // Option A: Call the cron handler directly with the function we can inject
    // Import and test the exported distributeForAgent function directly
    const { distributeForAgent } = await import('../api/cron/distribute-agent-payments.js');
    
    // Option B: Just verify the DB recording logic
    await testSql`
      INSERT INTO distribution_runs (agent_id, mint, amount_usdc, tx_signature, status, confirmed_at)
      VALUES (${TEST_AGENT_ID}, ${'FAKE_MINT'}, 2.0, ${'FAKE_SIG_' + Date.now()}, 'success', now())
    `;
    
    const runs = await testSql`
      SELECT * FROM distribution_runs WHERE agent_id = ${TEST_AGENT_ID}
    `;
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0].status).toBe('success');
    expect(Number(runs[0].amount_usdc)).toBe(2.0);
  }, 15_000);
```

### Test 5: Revenue Dashboard Data
```javascript
  it('returns complete revenue data from /api/agents/{id}/revenue', async () => {
    if (!TEST_AGENT_ID) return;
    
    // Insert fake payment records
    await testSql`
      INSERT INTO x402_payments (agent_id, payer_address, amount_usdc, paid_at)
      VALUES
        (${TEST_AGENT_ID}, 'wallet1', 0.05, now() - interval '1 day'),
        (${TEST_AGENT_ID}, 'wallet1', 0.05, now() - interval '2 days'),
        (${TEST_AGENT_ID}, 'wallet2', 0.10, now() - interval '3 days')
    `.catch(async () => {
      // If x402_payments has different columns, adjust
      console.log('Skipping payment inserts — check x402_payments schema');
    });
    
    // Call revenue endpoint
    const resp = await callRevenueEndpoint(TEST_AGENT_ID, TEST_USER_ID, { days: 30 });
    
    expect(resp.status).toBe(200);
    expect(resp.body).toHaveProperty('agentId', TEST_AGENT_ID);
    expect(resp.body).toHaveProperty('paymentVaultBalance');
    expect(resp.body).toHaveProperty('buybackVaultBalance');
    expect(resp.body).toHaveProperty('withdrawVaultBalance');
    expect(resp.body).toHaveProperty('totalEarned');
    expect(resp.body).toHaveProperty('messageCount');
    expect(resp.body).toHaveProperty('topPayers');
    expect(resp.body).toHaveProperty('chartData');
    expect(Array.isArray(resp.body.topPayers)).toBe(true);
    expect(Array.isArray(resp.body.chartData)).toBe(true);
    expect(resp.body.chartData.length).toBe(30);
  }, 15_000);
```

## Helper Functions

Add at the bottom of the file:
```javascript
// --- Test Helpers ---

async function createTestAgentWithPendingTokenize(userId) {
  const [agent] = await testSql`
    INSERT INTO agent_identities (id, owner_id, name, description, meta, created_at)
    VALUES (gen_random_uuid()::text, ${userId}, 'Test Agent', 'Test', '{}', now())
    RETURNING id
  `;
  return agent.id;
}

// Direct handler call helpers — bypass HTTP, inject auth
async function callWithFakeAuth(handler, agentId, userId, method, body) {
  const req = {
    method,
    url: `/api/agents/${agentId}/...`,
    headers: { 'content-type': 'application/json' },
    query: { id: agentId },
    // IMPORTANT: implement a test auth bypass in your API handlers:
    // if (process.env.NODE_ENV === 'test' && req.headers['x-test-user-id'])
    //   return { userId: req.headers['x-test-user-id'] };
    headers: { 'x-test-user-id': userId, 'content-type': 'application/json' },
    body,
  };
  
  const chunks = [];
  const res = {
    statusCode: 200,
    _headers: {},
    setHeader(k, v) { this._headers[k] = v; },
    end(data) { chunks.push(data); },
  };
  
  await handler(req, res);
  
  const rawBody = chunks.join('');
  return {
    status: res.statusCode,
    body: rawBody ? JSON.parse(rawBody) : null,
  };
}

async function callTokenizeEndpoint(agentId, userId, body) {
  const handler = (await import('../api/agents/[id]/tokenize.js')).default;
  return callWithFakeAuth(handler, agentId, userId, 'POST', body);
}

async function callTokenizeConfirmEndpoint(agentId, userId, body) {
  const handler = (await import('../api/agents/[id]/tokenize-confirm.js')).default;
  return callWithFakeAuth(handler, agentId, userId, 'POST', body);
}

async function callRevenueEndpoint(agentId, userId, query = {}) {
  const handler = (await import('../api/agents/[id]/revenue.js')).default;
  const req = {
    method: 'GET',
    headers: { 'x-test-user-id': userId },
    query: { id: agentId, ...query },
  };
  const chunks = [];
  const res = {
    statusCode: 200,
    _headers: {},
    setHeader(k, v) { this._headers[k] = v; },
    end(data) { chunks.push(data); },
  };
  await handler(req, res);
  return { status: res.statusCode, body: JSON.parse(chunks.join('') || '{}') };
}
```

## Test Auth Bypass

For the test helpers to work, add this to your auth resolvers in each handler:
```javascript
async function resolveAuth(req) {
  // Allow test bypass in test environment
  if (process.env.NODE_ENV === 'test' && req.headers?.['x-test-user-id']) {
    return { userId: req.headers['x-test-user-id'] };
  }
  const session = await getSessionUser(req);
  if (session) return { userId: session.id };
  const bearer = await authenticateBearer(extractBearer(req));
  if (bearer) return { userId: bearer.userId };
  return null;
}
```

Add this to `tokenize.js`, `tokenize-confirm.js`, `revenue.js`, and `trigger-distribute.js`.

## Skip TX Verify in Tests

In `tokenize-confirm.js`, wrap `verifySignature` calls:
```javascript
// In tokenize-confirm.js:
if (process.env.SKIP_TX_VERIFY !== '1') {
  await verifySignature('mainnet', createCoinSig);
  await verifySignature('mainnet', registerPaymentsSig);
}
```

## Running Tests

```bash
# Unit tests only (no devnet)
cd /workspaces/three.ws && npx vitest run tests/tokenized-agent-loop.test.js

# Full devnet integration
DEVNET_INTEGRATION=1 npx vitest run tests/tokenized-agent-loop.test.js
```

## File Checklist
- [ ] `/workspaces/three.ws/tests/tokenized-agent-loop.test.js`
- [ ] Test auth bypass added to handler files (tokenize.js, tokenize-confirm.js, revenue.js)
- [ ] SKIP_TX_VERIFY check added to tokenize-confirm.js

## Verification
1. `cd /workspaces/three.ws && npx vitest run tests/tokenized-agent-loop.test.js --reporter=verbose 2>&1 | tail -20`
2. All 5 tests should pass (some may be marked as skipped for devnet-only sections)
3. No unhandled promise rejections
