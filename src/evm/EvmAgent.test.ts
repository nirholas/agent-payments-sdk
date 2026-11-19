// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
// All rights reserved.

import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, type Address } from "viem";

import { EvmAgent } from "./EvmAgent.js";

const AGENT_TOKEN = "0x4200000000000000000000000000000000000006" as Address;
const DEPLOYMENT = "0x1111111111111111111111111111111111111111" as Address;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const PAYER = "0x2222222222222222222222222222222222222222" as Address;

/** JSON-RPC endpoint where isInvoicePaid is true and no PaymentAccepted logs exist. */
function stubRpc() {
  const methods: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: number; method: string };
    methods.push(body.method);
    const result =
      body.method === "eth_call"
        ? encodeAbiParameters([{ type: "bool" }], [true])
        : body.method === "eth_getLogs"
          ? []
          : null;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
      headers: { "Content-Type": "application/json" },
    });
  }));
  return methods;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("EvmAgent.validateInvoicePayment", () => {
  const invoice = { currencyToken: USDC, amount: 1_000_000n, memo: 1n, startTime: 0n, endTime: 600n };

  it("trusts the isInvoicePaid mapping when no payer is required", async () => {
    stubRpc();
    const agent = new EvmAgent(AGENT_TOKEN, 8453, "https://rpc.example", DEPLOYMENT);
    await expect(agent.validateInvoicePayment(invoice)).resolves.toMatchObject({ paid: true });
  });

  it("requires a PaymentAccepted event from the payer when one is given", async () => {
    const methods = stubRpc();
    const agent = new EvmAgent(AGENT_TOKEN, 8453, "https://rpc.example", DEPLOYMENT);
    await expect(
      agent.validateInvoicePayment({ ...invoice, payer: PAYER }),
    ).resolves.toMatchObject({ paid: false });
    expect(methods).toContain("eth_getLogs");
  });
});
