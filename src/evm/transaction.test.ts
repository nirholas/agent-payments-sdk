// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
// All rights reserved.

import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, type Address } from "viem";

import { ERC20_ABI } from "../constants.js";
import type { CrossChainQuote } from "../types.js";
import { buildEvmPaymentTransaction, checkAllowance } from "./transaction.js";

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const SPENDER = "0x2222222222222222222222222222222222222222";

function quote(): CrossChainQuote {
  return {
    fromChainId: 8453,
    fromToken: USDC_BASE,
    fromAmount: 2_500_000n,
    toAmountUsdc: 2_400_000n,
    estimatedUsd: 2.5,
    bridgeFeeUsd: 0.1,
    estimatedTimeSeconds: 60,
    quoteId: "q1",
    expiresAt: Math.floor(Date.now() / 1000) + 600,
  };
}

const params = () => ({
  quote: quote(),
  agentMint: "11111111111111111111111111111111",
  destinationSolanaWallet: "11111111111111111111111111111111",
  memo: "1",
  sender: "0x0000000000000000000000000000000000000001" as Address,
});

function stubBridgeResponse(body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildEvmPaymentTransaction", () => {
  it("approves only the quoted amount for the API-supplied spender", async () => {
    stubBridgeResponse({ to: SPENDER, data: "0xdeadbeef", value: "0", approvalSpender: SPENDER });
    const txs = await buildEvmPaymentTransaction(params());
    const { functionName, args } = decodeFunctionData({ abi: ERC20_ABI, data: txs.approval!.data });
    expect(functionName).toBe("approve");
    expect(args).toEqual([SPENDER, 2_500_000n]);
    expect(txs.approval!.to).toBe(USDC_BASE);
  });

  it.each([
    ["a non-address target", { to: "evil", data: "0x", value: "0" }],
    ["non-hex calldata", { to: SPENDER, data: "zz", value: "0" }],
    ["a non-address spender", { to: SPENDER, data: "0x", value: "0", approvalSpender: "0x12" }],
    ["a negative value", { to: SPENDER, data: "0x", value: "-1" }],
  ])("rejects a bridge response with %s", async (_label, body) => {
    stubBridgeResponse(body);
    await expect(buildEvmPaymentTransaction(params())).rejects.toThrow(/malformed|negative/);
  });
});

describe("checkAllowance", () => {
  it("throws on a JSON-RPC error instead of a TypeError from BigInt", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "rate limited" } })),
    ));
    await expect(
      checkAllowance(USDC_BASE, SPENDER as Address, SPENDER as Address, 1n, "https://rpc.example"),
    ).rejects.toThrow(/rate limited/);
  });
});
