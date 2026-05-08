/**
 * Integration test script — run with:
 *   npx tsx test.ts
 *
 * Tests 1–3 work without a real bridge transaction.
 * Test 4 requires a valid EVM tx hash:
 *   TEST_TX_HASH=0x... TEST_CHAIN_ID=8453 TEST_AGENT_MINT=... TEST_MEMO=... npx tsx test.ts
 */

import {
  buildChallenge,
  decodeAndValidateHeader,
  validatePayment,
  isExpired,
  InvalidSchemeError,
} from "./validator.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✔ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${message}`);
    failed++;
  }
}

function assertThrows(fn: () => unknown, errorType: Function, message: string): void {
  try {
    fn();
    console.error(`  ✗ FAIL: ${message} (expected throw, got nothing)`);
    failed++;
  } catch (err) {
    if (err instanceof errorType) {
      console.log(`  ✔ ${message}`);
      passed++;
    } else {
      console.error(`  ✗ FAIL: ${message} (wrong error type: ${(err as Error).constructor.name})`);
      failed++;
    }
  }
}

// ---------------------------------------------------------------------------
// Test 1: buildChallenge produces a decodable header
// ---------------------------------------------------------------------------
console.log("\nTest 1: buildChallenge produces a decodable header");
{
  const { header, memo, expiresAt } = buildChallenge({
    agentMint: "AgentMintPublicKey11111111111111111111111111",
    minAmountUsdc: 1.5,
    resource: "https://api.example.com/data",
    description: "Pay to access data",
    payTo: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    windowSeconds: 300,
  });

  assert(typeof header === "string" && header.length > 0, "header is a non-empty string");
  assert(typeof memo === "string" && memo.length > 0, "memo is a non-empty string");
  assert(expiresAt instanceof Date, "expiresAt is a Date");
  assert(!isExpired(expiresAt), "fresh challenge is not expired");
  assert(isExpired(new Date(Date.now() - 1000)), "past date is expired");

  // The header should encode something decodable as JSON
  let decoded: unknown;
  try {
    decoded = JSON.parse(atob(header));
    assert(true, "header is valid base64-encoded JSON");
  } catch {
    assert(false, "header is valid base64-encoded JSON");
    decoded = null;
  }

  if (decoded && typeof decoded === "object") {
    const obj = decoded as Record<string, unknown>;
    assert(obj.scheme === "pump-agent-evm", "decoded scheme is pump-agent-evm");
    assert(obj.memo === memo, "decoded memo matches returned memo");
    assert(typeof obj.agentMint === "string", "decoded agentMint is present");
  }
}

// ---------------------------------------------------------------------------
// Test 2: decodeAndValidateHeader returns null / throws correctly
// ---------------------------------------------------------------------------
console.log("\nTest 2: decodeAndValidateHeader edge cases");
{
  assert(decodeAndValidateHeader(null) === null, "null header returns null");
  assert(decodeAndValidateHeader(undefined) === null, "undefined header returns null");
  assert(decodeAndValidateHeader("") === null, "empty string returns null");
  assert(decodeAndValidateHeader("not-base64!!!") === null, "malformed base64 returns null");

  // Valid base64 but wrong scheme → InvalidSchemeError
  const wrongScheme = btoa(JSON.stringify({ scheme: "some-other-scheme", memo: "x" }));
  assertThrows(
    () => decodeAndValidateHeader(wrongScheme),
    InvalidSchemeError,
    "wrong scheme throws InvalidSchemeError"
  );

  // Valid base64, missing scheme field → null (not a proof)
  const noScheme = btoa(JSON.stringify({ foo: "bar" }));
  assert(decodeAndValidateHeader(noScheme) === null, "no scheme field returns null");
}

// ---------------------------------------------------------------------------
// Test 3: validatePayment rejects memo mismatch without API calls
// ---------------------------------------------------------------------------
console.log("\nTest 3: validatePayment rejects memo mismatch");
{
  const fakeProof = {
    scheme: "pump-agent-evm" as const,
    chainId: 8453 as const,
    txHash: ("0x" + "a".repeat(64)) as `0x${string}`,
    quoteId: "test-quote-id",
    memo: "12345678",
  };

  const result = await validatePayment({
    proof: fakeProof,
    expectedMemo: "99999999",    // mismatch
    minAmountUsdcMinor: 1_000_000n,
    agentMint: "AgentMintPublicKey11111111111111111111111111",
  });

  assert(result.valid === false, "memo mismatch → valid: false");
  assert(
    typeof result.error === "string" && result.error.includes("Memo mismatch"),
    "error message mentions memo mismatch"
  );
  assert(result.chainId === 8453, "chainId preserved in result");
  assert(result.chainName === "Base", "chainName resolved correctly");
  assert(result.txHash === fakeProof.txHash, "txHash preserved in result");
  assert(result.depositId === undefined, "depositId absent (no API call made)");
}

// ---------------------------------------------------------------------------
// Test 4 (optional): End-to-end with a real bridge transaction
// ---------------------------------------------------------------------------
const testTxHash = process.env.TEST_TX_HASH;
const testChainId = process.env.TEST_CHAIN_ID;
const testAgentMint = process.env.TEST_AGENT_MINT;
const testMemo = process.env.TEST_MEMO;

if (testTxHash && testChainId && testAgentMint && testMemo) {
  console.log("\nTest 4: End-to-end with real bridge transaction");

  const chainId = parseInt(testChainId, 10) as 1 | 8453 | 42161 | 137 | 56 | 43114;
  const realProof = {
    scheme: "pump-agent-evm" as const,
    chainId,
    txHash: testTxHash as `0x${string}`,
    quoteId: "real-quote",
    memo: testMemo,
  };

  const result = await validatePayment({
    proof: realProof,
    expectedMemo: testMemo,
    minAmountUsdcMinor: 0n,    // accept any amount
    agentMint: testAgentMint,
    waitForSolana: false,
  });

  assert(result.valid === true, "real proof validates successfully");
  assert(typeof result.depositId === "string" && result.depositId.length > 0, "depositId present");
  assert(typeof result.confirmedAmountUsdc === "string", "confirmedAmountUsdc present");
  if (result.valid) {
    console.log(`  Deposit ID     : ${result.depositId}`);
    console.log(`  Confirmed USDC : ${result.confirmedAmountUsdc}`);
    console.log(`  Chain          : ${result.chainName} (${result.chainId})`);
  }
} else {
  console.log(
    "\nTest 4 skipped (set TEST_TX_HASH, TEST_CHAIN_ID, TEST_AGENT_MINT, TEST_MEMO to run)"
  );
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${"─".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("Some tests failed.");
  process.exit(1);
} else {
  console.log("All tests passed.");
}
