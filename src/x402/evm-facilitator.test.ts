// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
// All rights reserved.

import { afterEach, describe, expect, it, vi } from "vitest";

import { PUMP_CROSSCHAIN_API } from "../constants.js";
import { decodePaymentHeader, verifyEvmPayment, type EvmPaymentProof } from "./evm-facilitator.js";
import { createEvmX402Fetch } from "./evm-client.js";

const AGENT_MINT = "So11111111111111111111111111111111111111112";
const TX_HASH = `0x${"ab".repeat(32)}` as const;

function proof(overrides: Partial<EvmPaymentProof> = {}): EvmPaymentProof {
  return { scheme: "pump-agent-evm", chainId: 8453, txHash: TX_HASH, quoteId: "q", memo: "42", ...overrides };
}

function stubDeposit(record: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(record), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const params = (p: EvmPaymentProof = proof()) => ({
  proof: p,
  expectedMemo: "42",
  minAmountUsdc: 1_000_000n,
  agentMint: AGENT_MINT,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("verifyEvmPayment", () => {
  it("accepts a deposit for this agent, memo and amount", async () => {
    const fetchMock = stubDeposit({ depositId: "d1", amountUsdc: "1000000", agentMint: AGENT_MINT, memo: "42" });
    await expect(verifyEvmPayment(params())).resolves.toEqual({ valid: true, depositId: "d1" });
    expect(fetchMock).toHaveBeenCalledWith(
      `${PUMP_CROSSCHAIN_API}/deposit?txHash=${TX_HASH}&chainId=8453`,
    );
  });

  it("rejects a deposit made for a different agent or memo", async () => {
    stubDeposit({ depositId: "d1", amountUsdc: "5000000", agentMint: "other", memo: "42" });
    expect((await verifyEvmPayment(params())).valid).toBe(false);
    stubDeposit({ depositId: "d1", amountUsdc: "5000000", agentMint: AGENT_MINT, memo: "7" });
    expect((await verifyEvmPayment(params())).valid).toBe(false);
  });

  it("rejects an insufficient or malformed deposit record", async () => {
    stubDeposit({ depositId: "d1", amountUsdc: "999999", agentMint: AGENT_MINT, memo: "42" });
    expect((await verifyEvmPayment(params())).valid).toBe(false);
    stubDeposit({ depositId: "d1", amountUsdc: "1e9", agentMint: AGENT_MINT, memo: "42" });
    expect((await verifyEvmPayment(params())).valid).toBe(false);
  });

  it("refuses to put an unvalidated txHash into the lookup URL", async () => {
    const fetchMock = stubDeposit({});
    const injected = proof({ txHash: `${TX_HASH}&chainId=1` as `0x${string}` });
    await expect(verifyEvmPayment(params(injected))).resolves.toMatchObject({
      valid: false,
      error: "Malformed payment proof",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("decodePaymentHeader", () => {
  it("returns null for proofs with malformed fields", () => {
    expect(decodePaymentHeader(btoa(JSON.stringify(proof())))).toEqual(proof());
    expect(decodePaymentHeader(btoa(JSON.stringify(proof({ txHash: "0x1" as `0x${string}` }))))).toBeNull();
    expect(decodePaymentHeader(btoa(JSON.stringify({ ...proof(), chainId: 999 })))).toBeNull();
    expect(decodePaymentHeader("%%%")).toBeNull();
  });
});

describe("createEvmX402Fetch", () => {
  it("does not send anything for malformed requirements", async () => {
    const header = btoa(JSON.stringify({
      scheme: "pump-agent-evm",
      agentMint: AGENT_MINT,
      maxAmountRequired: "-1",
      payTo: "x",
      memo: "1",
    }));
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response("", { status: 402, headers: { "X-Payment-Required": header } }),
    ));
    const sendTransaction = vi.fn(async () => TX_HASH);
    const x402Fetch = createEvmX402Fetch({
      walletClient: { chainId: 8453, address: "0x0000000000000000000000000000000000000001", sendTransaction },
    });
    expect((await x402Fetch("https://agent.example/")).status).toBe(402);
    expect(sendTransaction).not.toHaveBeenCalled();
  });
});
