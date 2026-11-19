// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
// All rights reserved.

import { describe, it, expect, vi, afterEach } from "vitest";
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";

import IDL from "../idl/pump_agent_payments.json";
import { OFFLINE_PUMP_PROGRAM } from "../program";
import { getInvoiceIdPDA } from "../pdas";
import {
  PumpAgentFacilitator,
  buildPumpAgentRequirements,
  createResourceServer,
} from "./facilitator";
import {
  decodePaymentRequired,
  decodePaymentResponse,
  encodePaymentPayload,
  encodePaymentRequired,
} from "./headers";
import {
  SOLANA_DEVNET,
  SOLANA_MAINNET,
  USDC_MAINNET,
  X402_HEADER_PAYMENT_REQUIRED,
  X402_HEADER_PAYMENT_RESPONSE,
  X402_HEADER_PAYMENT_SIGNATURE,
  type PaymentPayload,
  type PaymentRequired,
  type PumpAgentPaymentRequirements,
} from "./types";

const AGENT_PROGRAM = OFFLINE_PUMP_PROGRAM.programId.toBase58();
const ACCEPT_DISCRIMINATOR = IDL.events.find(
  (e) => e.name === "AgentAcceptPaymentEvent",
)!.discriminator;

const agentMint = Keypair.generate().publicKey;
const payer = Keypair.generate().publicKey;
const usdc = new PublicKey(USDC_MAINNET);

function fakeSignature(): string {
  // 64 random bytes rendered in base58 alphabet characters is enough for the
  // format check; the mock connection keys transactions by this string.
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  return Array.from({ length: 88 }, () => alphabet[Math.floor(Math.random() * 58)]).join("");
}

function acceptPaymentLogs(
  req: PumpAgentPaymentRequirements,
  user: PublicKey,
  programId = AGENT_PROGRAM,
): string[] {
  const amount = new BN(req.amount);
  const memo = new BN(req.extra.memo);
  const startTime = new BN(req.extra.startTime);
  const endTime = new BN(req.extra.endTime);
  const mint = new PublicKey(req.extra.agentMint);
  const currency = new PublicKey(req.asset);
  const [invoiceId] = getInvoiceIdPDA(mint, currency, amount, memo, startTime, endTime);
  const body = OFFLINE_PUMP_PROGRAM.coder.types.encode("agentAcceptPaymentEvent", {
    user,
    tokenizedAgentMint: mint,
    tokenAgentPayments: Keypair.generate().publicKey,
    currencyMint: currency,
    amount,
    memo,
    startTime,
    endTime,
    invoiceId,
    agentPostBalance: new BN(0),
    timestamp: new BN(req.extra.startTime),
  });
  const data = Buffer.concat([Buffer.from(ACCEPT_DISCRIMINATOR), body]).toString("base64");
  return [
    `Program ${programId} invoke [1]`,
    `Program data: ${data}`,
    `Program ${programId} success`,
  ];
}

interface FakeTx {
  err?: unknown;
  logs: string[];
}

function fakeConnection(txs: Map<string, FakeTx>) {
  const getTransaction = vi.fn(async (signature: string) => {
    const tx = txs.get(signature);
    if (!tx) return null;
    return { meta: { err: tx.err ?? null, logMessages: tx.logs } };
  });
  return { connection: { getTransaction } as unknown as Connection, getTransaction };
}

function requirements(overrides: Partial<Parameters<typeof buildPumpAgentRequirements>[0]> = {}) {
  return buildPumpAgentRequirements({
    agentMint: agentMint.toBase58(),
    payTo: Keypair.generate().publicKey.toBase58(),
    amount: "1000000",
    ...overrides,
  });
}

function payloadFor(
  req: PumpAgentPaymentRequirements,
  signature: string,
  who: PublicKey = payer,
): PaymentPayload {
  return {
    x402Version: 2,
    accepted: req,
    payload: { signature, payer: who.toBase58() },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("buildPumpAgentRequirements", () => {
  it("issues random u64 memos", () => {
    const memos = new Set(Array.from({ length: 50 }, () => requirements().extra.memo));
    expect(memos.size).toBe(50);
    for (const memo of memos) {
      expect(memo).toMatch(/^\d+$/);
      expect(BigInt(memo) < 1n << 64n).toBe(true);
    }
  });

  it("rejects invalid prices and windows", () => {
    expect(() => requirements({ amount: "0" })).toThrow(RangeError);
    expect(() => requirements({ amount: "1.5" })).toThrow(RangeError);
    expect(() => requirements({ invoiceWindowSeconds: 0 })).toThrow(RangeError);
    expect(() => requirements({ agentMint: "not-a-key" })).toThrow(TypeError);
  });
});

describe("PumpAgentFacilitator", () => {
  it("verifies and settles a confirmed payment exactly once", async () => {
    const req = requirements();
    const sig = fakeSignature();
    const { connection } = fakeConnection(new Map([[sig, { logs: acceptPaymentLogs(req, payer) }]]));
    const facilitator = new PumpAgentFacilitator({ connection });

    await expect(facilitator.verify(payloadFor(req, sig), req)).resolves.toEqual({
      isValid: true,
      payer: payer.toBase58(),
    });
    const settled = await facilitator.settle(payloadFor(req, sig), req);
    expect(settled).toMatchObject({ success: true, transaction: sig, network: SOLANA_MAINNET });

    const replay = await facilitator.settle(payloadFor(req, fakeSignature()), req);
    expect(replay).toMatchObject({ success: false, errorReason: "Invoice already settled" });
    const reverify = await facilitator.verify(payloadFor(req, sig), req);
    expect(reverify).toMatchObject({ isValid: false, invalidReason: "Invoice already settled" });
  });

  it("settles only one of two concurrent attempts on the same invoice", async () => {
    const req = requirements();
    const sig = fakeSignature();
    const { connection } = fakeConnection(new Map([[sig, { logs: acceptPaymentLogs(req, payer) }]]));
    const facilitator = new PumpAgentFacilitator({ connection });

    const results = await Promise.all([
      facilitator.settle(payloadFor(req, sig), req),
      facilitator.settle(payloadFor(req, sig), req),
    ]);
    expect(results.filter((r) => r.success)).toHaveLength(1);
  });

  it("rejects a signature that is not on-chain", async () => {
    const req = requirements();
    const { connection } = fakeConnection(new Map());
    const facilitator = new PumpAgentFacilitator({ connection });
    const result = await facilitator.verify(payloadFor(req, fakeSignature()), req);
    expect(result).toMatchObject({ isValid: false, invalidReason: "Transaction does not pay this invoice" });
  });

  it("rejects a payer claim that does not match the paying wallet", async () => {
    const req = requirements();
    const sig = fakeSignature();
    const { connection } = fakeConnection(new Map([[sig, { logs: acceptPaymentLogs(req, payer) }]]));
    const facilitator = new PumpAgentFacilitator({ connection });
    const result = await facilitator.verify(payloadFor(req, sig, Keypair.generate().publicKey), req);
    expect(result.isValid).toBe(false);
  });

  it("rejects a transaction that paid a different invoice", async () => {
    const req = requirements();
    const other = requirements();
    const sig = fakeSignature();
    const { connection } = fakeConnection(new Map([[sig, { logs: acceptPaymentLogs(other, payer) }]]));
    const facilitator = new PumpAgentFacilitator({ connection });
    const result = await facilitator.verify(payloadFor(req, sig), req);
    expect(result.isValid).toBe(false);
  });

  it("rejects a failed transaction", async () => {
    const req = requirements();
    const sig = fakeSignature();
    const { connection } = fakeConnection(
      new Map([[sig, { err: { InstructionError: [0, "Custom"] }, logs: acceptPaymentLogs(req, payer) }]]),
    );
    const facilitator = new PumpAgentFacilitator({ connection });
    expect((await facilitator.verify(payloadFor(req, sig), req)).isValid).toBe(false);
  });

  it("ignores payment events logged by another program", async () => {
    const req = requirements();
    const sig = fakeSignature();
    const spoofer = Keypair.generate().publicKey.toBase58();
    const { connection } = fakeConnection(
      new Map([[sig, { logs: acceptPaymentLogs(req, payer, spoofer) }]]),
    );
    const facilitator = new PumpAgentFacilitator({ connection });
    expect((await facilitator.verify(payloadFor(req, sig), req)).isValid).toBe(false);
  });

  it("rejects a payload whose accepted terms differ from the requirements", async () => {
    const req = requirements();
    const sig = fakeSignature();
    const { connection, getTransaction } = fakeConnection(
      new Map([[sig, { logs: acceptPaymentLogs(req, payer) }]]),
    );
    const facilitator = new PumpAgentFacilitator({ connection });
    const tampered = payloadFor({ ...req, extra: { ...req.extra, memo: "1" } }, sig);
    const result = await facilitator.verify(tampered, req);
    expect(result).toMatchObject({
      isValid: false,
      invalidReason: "Payload does not match the payment requirements",
    });
    expect(getTransaction).not.toHaveBeenCalled();
  });

  it("rejects an invoice past its acceptance window", async () => {
    const req = requirements({ invoiceWindowSeconds: 60, maxTimeoutSeconds: 30 });
    const sig = fakeSignature();
    const { connection } = fakeConnection(new Map([[sig, { logs: acceptPaymentLogs(req, payer) }]]));
    const facilitator = new PumpAgentFacilitator({ connection });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime((req.extra.endTime + 31) * 1000);
    const result = await facilitator.verify(payloadFor(req, sig), req);
    expect(result).toMatchObject({ isValid: false, invalidReason: "Invoice expired" });
  });

  it("rejects requirements for another network", async () => {
    const req = requirements({ network: SOLANA_DEVNET });
    const { connection } = fakeConnection(new Map());
    const facilitator = new PumpAgentFacilitator({ connection });
    expect((await facilitator.verify(payloadFor(req, fakeSignature()), req)).isValid).toBe(false);
  });

  it("rejects malformed proofs", async () => {
    const req = requirements();
    const { connection } = fakeConnection(new Map());
    const facilitator = new PumpAgentFacilitator({ connection });
    for (const payload of [
      { signature: "short", payer: payer.toBase58() },
      { signature: fakeSignature(), payer: "nope" },
      {},
    ]) {
      const result = await facilitator.verify({ x402Version: 2, accepted: req, payload }, req);
      expect(result.isValid).toBe(false);
    }
  });

  it("uses a shared settlement store when one is supplied", async () => {
    const req = requirements();
    const sig = fakeSignature();
    const txs = new Map([[sig, { logs: acceptPaymentLogs(req, payer) }]]);
    const claimed = new Map<string, number>();
    const store = {
      has: (key: string) => claimed.has(key),
      claim: (key: string, expiresAtMs: number) => {
        if (claimed.has(key)) return false;
        claimed.set(key, expiresAtMs);
        return true;
      },
    };
    const a = new PumpAgentFacilitator({ connection: fakeConnection(txs).connection, settlementStore: store });
    const b = new PumpAgentFacilitator({ connection: fakeConnection(txs).connection, settlementStore: store });
    expect((await a.settle(payloadFor(req, sig), req)).success).toBe(true);
    expect((await b.settle(payloadFor(req, sig), req)).success).toBe(false);
    const [expiresAt] = claimed.values();
    expect(expiresAt).toBeGreaterThan((req.extra.endTime + req.maxTimeoutSeconds) * 1000);
  });
});

describe("createResourceServer", () => {
  function setup() {
    const txs = new Map<string, FakeTx>();
    const { connection } = fakeConnection(txs);
    const template = requirements();
    const gate = createResourceServer({
      facilitator: new PumpAgentFacilitator({ connection }),
      requirements: [template],
      resource: { url: "/api/inference", description: "Inference — one call" },
    });
    const handler = vi.fn(() => new Response("ok", { status: 200, headers: { "X-App": "1" } }));
    return { txs, template, gate, handler };
  }

  async function challenge(gate: ReturnType<typeof createResourceServer>): Promise<PaymentRequired> {
    const res = await gate(new Request("https://api.example/api/inference"), () => new Response("free"));
    expect(res.status).toBe(402);
    return decodePaymentRequired(res.headers.get(X402_HEADER_PAYMENT_REQUIRED)!);
  }

  function paidRequest(payload: PaymentPayload): Request {
    return new Request("https://api.example/api/inference", {
      headers: { [X402_HEADER_PAYMENT_SIGNATURE]: encodePaymentPayload(payload) },
    });
  }

  it("issues a fresh invoice on every challenge", async () => {
    const { gate } = setup();
    const a = (await challenge(gate)).accepts[0] as PumpAgentPaymentRequirements;
    const b = (await challenge(gate)).accepts[0] as PumpAgentPaymentRequirements;
    expect(a.extra.memo).not.toBe(b.extra.memo);
  });

  it("serves a paid request once and refuses to replay it", async () => {
    const { txs, gate, handler } = setup();
    const issued = (await challenge(gate)).accepts[0] as PumpAgentPaymentRequirements;
    const sig = fakeSignature();
    txs.set(sig, { logs: acceptPaymentLogs(issued, payer) });

    const ok = await gate(paidRequest(payloadFor(issued, sig)), handler);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("ok");
    expect(ok.headers.get("X-App")).toBe("1");
    expect(decodePaymentResponse(ok.headers.get(X402_HEADER_PAYMENT_RESPONSE)!)).toMatchObject({
      success: true,
      transaction: sig,
      payer: payer.toBase58(),
    });

    // Same proof again, and the same paid invoice with a different signature.
    for (const replay of [payloadFor(issued, sig), payloadFor(issued, fakeSignature())]) {
      const res = await gate(paidRequest(replay), handler);
      expect(res.status).toBe(402);
      expect(((await res.json()) as PaymentRequired).error).toBe("Invoice already settled");
    }
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("refuses a payload that lowers the price", async () => {
    const { txs, gate, handler } = setup();
    const issued = (await challenge(gate)).accepts[0] as PumpAgentPaymentRequirements;
    const cheap = { ...issued, amount: "1" };
    const sig = fakeSignature();
    txs.set(sig, { logs: acceptPaymentLogs(cheap, payer) });

    const res = await gate(paidRequest(payloadFor(cheap, sig)), handler);
    expect(res.status).toBe(402);
    expect(((await res.json()) as PaymentRequired).error).toBe("No matching payment requirement");
    expect(handler).not.toHaveBeenCalled();
  });

  it("refuses an invoice window longer than the configured one", async () => {
    const { txs, gate, handler } = setup();
    const issued = (await challenge(gate)).accepts[0] as PumpAgentPaymentRequirements;
    const longLived = { ...issued, extra: { ...issued.extra, endTime: issued.extra.endTime + 86_400 } };
    const sig = fakeSignature();
    txs.set(sig, { logs: acceptPaymentLogs(longLived, payer) });

    const res = await gate(paidRequest(payloadFor(longLived, sig)), handler);
    expect(res.status).toBe(402);
    expect(handler).not.toHaveBeenCalled();
  });

  it("answers 400 to a malformed payment header", async () => {
    const { gate, handler } = setup();
    for (const header of ["%%%", btoa("{}"), btoa(JSON.stringify({ x402Version: 2 }))]) {
      const res = await gate(
        new Request("https://api.example/", { headers: { [X402_HEADER_PAYMENT_SIGNATURE]: header } }),
        handler,
      );
      expect(res.status).toBe(400);
    }
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("x402 headers", () => {
  it("round-trips non-Latin-1 text", () => {
    const body: PaymentRequired = {
      x402Version: 2,
      resource: { url: "/", description: "Résumé — 🚀" },
      accepts: [],
    };
    expect(decodePaymentRequired(encodePaymentRequired(body))).toEqual(body);
  });
});
