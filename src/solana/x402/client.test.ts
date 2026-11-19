// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
// All rights reserved.

import { describe, it, expect, vi, afterEach } from "vitest";
import { Keypair, PublicKey, Transaction, type Connection } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";

import IDL from "../idl/pump_agent_payments.json";
import { OFFLINE_PUMP_PROGRAM } from "../program";
import { getInvoiceIdPDA } from "../pdas";
import { createX402Fetch } from "./client";
import {
  PumpAgentFacilitator,
  buildPumpAgentRequirements,
  createResourceServer,
} from "./facilitator";
import { decodePaymentPayload, encodePaymentRequired } from "./headers";
import {
  X402_HEADER_PAYMENT_REQUIRED,
  X402_HEADER_PAYMENT_SIGNATURE,
  type PaymentRequired,
  type PumpAgentPaymentRequirements,
} from "./types";

const payer = Keypair.generate().publicKey;
const agentMint = Keypair.generate().publicKey;
const BLOCKHASH = Keypair.generate().publicKey.toBase58();
const ACCEPT_DISCRIMINATOR = IDL.events.find(
  (e) => e.name === "AgentAcceptPaymentEvent",
)!.discriminator;

function acceptPaymentLogs(req: PumpAgentPaymentRequirements, user: PublicKey): string[] {
  const programId = OFFLINE_PUMP_PROGRAM.programId.toBase58();
  const fields = {
    amount: new BN(req.amount),
    memo: new BN(req.extra.memo),
    startTime: new BN(req.extra.startTime),
    endTime: new BN(req.extra.endTime),
  };
  const mint = new PublicKey(req.extra.agentMint);
  const currency = new PublicKey(req.asset);
  const [invoiceId] = getInvoiceIdPDA(
    mint, currency, fields.amount, fields.memo, fields.startTime, fields.endTime,
  );
  const body = OFFLINE_PUMP_PROGRAM.coder.types.encode("agentAcceptPaymentEvent", {
    user,
    tokenizedAgentMint: mint,
    tokenAgentPayments: Keypair.generate().publicKey,
    currencyMint: currency,
    ...fields,
    invoiceId,
    agentPostBalance: new BN(0),
    timestamp: new BN(0),
  });
  return [
    `Program ${programId} invoke [1]`,
    `Program data: ${Buffer.concat([Buffer.from(ACCEPT_DISCRIMINATOR), body]).toString("base64")}`,
    `Program ${programId} success`,
  ];
}

/** A chain where every sent transaction confirms immediately. */
function fakeChain() {
  const txs = new Map<string, string[]>();
  const connection = {
    getLatestBlockhash: vi.fn(async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 100 })),
    getSignatureStatus: vi.fn(async () => ({ value: { confirmationStatus: "confirmed", err: null } })),
    getBlockHeight: vi.fn(async () => 1),
    getTransaction: vi.fn(async (sig: string) => {
      const logs = txs.get(sig);
      return logs ? { meta: { err: null, logMessages: logs } } : null;
    }),
  } as unknown as Connection;
  return { connection, txs };
}

function paymentRequiredResponse(accepts: unknown[]): Response {
  const body = { x402Version: 2, resource: { url: "/" }, accepts } as PaymentRequired;
  return new Response("{}", {
    status: 402,
    headers: { [X402_HEADER_PAYMENT_REQUIRED]: encodePaymentRequired(body) },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createX402Fetch", () => {
  it("pays a pump-agent challenge that the resource server then accepts", async () => {
    const { connection, txs } = fakeChain();
    const gate = createResourceServer({
      facilitator: new PumpAgentFacilitator({ connection }),
      requirements: [
        buildPumpAgentRequirements({
          agentMint: agentMint.toBase58(),
          payTo: agentMint.toBase58(),
          amount: "250000",
        }),
      ],
      resource: { url: "https://agent.example/infer" },
    });
    const handler = vi.fn(() => new Response("answer"));
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      gate(new Request(input, init), handler),
    ));

    const issuedByMemo = new Map<string, PumpAgentPaymentRequirements>();
    let lastSigned = "";
    const x402fetch = createX402Fetch({
      connection,
      payer: payer.toBase58(),
      signTransaction: async (txBase64) => {
        lastSigned = txBase64;
        return txBase64;
      },
      sendTransaction: async () => {
        // Record the payment the program would log for the instructions we signed.
        const tx = Transaction.from(Buffer.from(lastSigned, "base64"));
        const accept = tx.instructions[tx.instructions.length - 1];
        expect(accept.programId.equals(OFFLINE_PUMP_PROGRAM.programId)).toBe(true);
        const memo = accept.data.readBigUInt64LE(16).toString();
        const sig = Keypair.generate().publicKey.toBase58() + Keypair.generate().publicKey.toBase58();
        const issued = issuedByMemo.get(memo)!;
        txs.set(sig, acceptPaymentLogs(issued, payer));
        return sig;
      },
      approvePayment: (req) => {
        const r = req as PumpAgentPaymentRequirements;
        issuedByMemo.set(r.extra.memo, r);
        return BigInt(req.amount) <= 1_000_000n;
      },
    });

    const res = await x402fetch("https://agent.example/infer", { method: "POST", body: "q" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("answer");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does not sign anything when approvePayment declines", async () => {
    const accepts = [
      buildPumpAgentRequirements({ agentMint: agentMint.toBase58(), payTo: agentMint.toBase58(), amount: "999999999" }),
    ];
    vi.stubGlobal("fetch", vi.fn(async () => paymentRequiredResponse(accepts)));
    const signTransaction = vi.fn(async (tx: string) => tx);
    const x402fetch = createX402Fetch({
      connection: fakeChain().connection,
      payer: payer.toBase58(),
      signTransaction,
      sendTransaction: vi.fn(async () => "sig"),
      approvePayment: (req) => BigInt(req.amount) <= 1_000_000n,
    });
    const res = await x402fetch("https://agent.example/");
    expect(res.status).toBe(402);
    expect(signTransaction).not.toHaveBeenCalled();
  });

  it("ignores malformed requirements instead of building a payment for them", async () => {
    const valid = buildPumpAgentRequirements({
      agentMint: agentMint.toBase58(),
      payTo: agentMint.toBase58(),
      amount: "1",
    });
    const accepts = [
      { ...valid, amount: "-1" },
      { ...valid, amount: "1.5" },
      { ...valid, asset: "not-a-key" },
      { ...valid, extra: { ...valid.extra, memo: "99999999999999999999999" } },
      { scheme: "exact", network: valid.network, asset: valid.asset, amount: "1", payTo: "bad" },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => paymentRequiredResponse(accepts)));
    const signTransaction = vi.fn(async (tx: string) => tx);
    const x402fetch = createX402Fetch({
      connection: fakeChain().connection,
      payer: payer.toBase58(),
      signTransaction,
      sendTransaction: vi.fn(async () => "sig"),
    });
    expect((await x402fetch("https://agent.example/")).status).toBe(402);
    expect(signTransaction).not.toHaveBeenCalled();
  });

  it("returns the 402 untouched when the challenge header is not decodable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response("{}", { status: 402, headers: { [X402_HEADER_PAYMENT_REQUIRED]: "%%%" } }),
    ));
    const x402fetch = createX402Fetch({
      connection: fakeChain().connection,
      payer: payer.toBase58(),
      signTransaction: vi.fn(async (tx: string) => tx),
      sendTransaction: vi.fn(async () => "sig"),
    });
    expect((await x402fetch("https://agent.example/")).status).toBe(402);
  });

  it("retries a Request input with its body and headers intact", async () => {
    const accepts = [
      buildPumpAgentRequirements({ agentMint: agentMint.toBase58(), payTo: agentMint.toBase58(), amount: "5" }),
    ];
    const seen: Request[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      seen.push(req);
      return seen.length === 1 ? paymentRequiredResponse(accepts) : new Response("ok");
    }));
    const x402fetch = createX402Fetch({
      connection: fakeChain().connection,
      payer: payer.toBase58(),
      signTransaction: async (tx) => tx,
      sendTransaction: async () => "5".repeat(88),
    });

    const res = await x402fetch(
      new Request("https://agent.example/infer", {
        method: "POST",
        body: "prompt",
        headers: { Authorization: "Bearer t" },
      }),
    );
    expect(res.status).toBe(200);
    const retry = seen[1];
    expect(retry.method).toBe("POST");
    expect(await retry.text()).toBe("prompt");
    expect(retry.headers.get("Authorization")).toBe("Bearer t");
    const payload = decodePaymentPayload(retry.headers.get(X402_HEADER_PAYMENT_SIGNATURE)!);
    expect(payload.payload).toMatchObject({ signature: "5".repeat(88), payer: payer.toBase58() });
  });
});
