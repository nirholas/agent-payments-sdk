// agent-payments-sdk — x402 facilitator middleware
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
// All rights reserved.

import type { Context, Next } from "hono";
import type { Address } from "viem";
import {
  decodePaymentHeader,
  verifyEvmPayment,
  buildPaymentRequiredHeader,
  type EvmPaymentVerificationResult,
} from "../../../../src/x402/evm-facilitator.js";

const MEMO_TTL_MS = 10 * 60 * 1_000;
const DEPOSIT_TTL_MS = 24 * 60 * 60 * 1_000;

interface MemoEntry {
  createdAt: number;
  path: string;
}

// Active payment challenges: memo → entry
const memoStore = new Map<string, MemoEntry>();

// Replay protection: depositId → expiry timestamp
const usedDeposits = new Map<string, number>();

export type AppVariables = {
  paymentProof: EvmPaymentVerificationResult;
};

export function newMemo(): string {
  return `${Date.now()}${Math.floor(Math.random() * 1_000_000)
    .toString()
    .padStart(6, "0")}`;
}

function storeMemo(memo: string, path: string): void {
  const now = Date.now();
  for (const [m, entry] of memoStore) {
    if (now - entry.createdAt > MEMO_TTL_MS) memoStore.delete(m);
  }
  memoStore.set(memo, { createdAt: now, path });
}

function purgeExpiredDeposits(): void {
  const now = Date.now();
  for (const [id, expiry] of usedDeposits) {
    if (now > expiry) usedDeposits.delete(id);
  }
}

export interface MiddlewareOptions {
  minAmountUsdc: bigint;
  agentMint: string;
  payTo: Address;
  waitForSolana: boolean;
  description: string;
}

/**
 * Hono middleware factory for x402 EVM payment verification.
 *
 * - No X-Payment header → generates a fresh memo, returns 402 with X-Payment-Required.
 * - Malformed / expired memo → 402 with error detail.
 * - Valid payment → calls next(), then attaches X-Payment-Receipt.
 */
export function createVerifyPaymentMiddleware(opts: MiddlewareOptions) {
  return async function verifyPaymentMiddleware(
    c: Context<{ Variables: AppVariables }>,
    next: Next
  ): Promise<Response | void> {
    const paymentHeader = c.req.header("X-Payment");
    const proof = decodePaymentHeader(paymentHeader);

    if (!proof) {
      const memo = newMemo();
      storeMemo(memo, c.req.path);
      const reqHeader = buildPaymentRequiredHeader({
        agentMint: opts.agentMint,
        maxAmountUsdc: opts.minAmountUsdc,
        resource: c.req.url,
        description: opts.description,
        payTo: opts.payTo,
        memo,
      });
      c.header("X-Payment-Required", reqHeader);
      return c.json({ error: "Payment required" }, 402);
    }

    // Validate memo exists and hasn't expired
    const now = Date.now();
    const memoEntry = memoStore.get(proof.memo);
    if (!memoEntry || now - memoEntry.createdAt > MEMO_TTL_MS) {
      memoStore.delete(proof.memo);
      return c.json({ error: "Unknown or expired memo" }, 402);
    }

    // Verify the EVM payment on-chain and optionally wait for Solana arrival
    const result = await verifyEvmPayment({
      proof,
      expectedMemo: proof.memo,
      minAmountUsdc: opts.minAmountUsdc,
      agentMint: opts.agentMint,
      waitForSolana: opts.waitForSolana,
    });

    if (!result.valid) {
      return c.json({ error: result.error ?? "Payment verification failed" }, 402);
    }

    // Replay protection — must happen after verification so we have a real depositId
    if (result.depositId) {
      purgeExpiredDeposits();
      if (usedDeposits.has(result.depositId)) {
        return c.json({ error: "Deposit already used" }, 402);
      }
      usedDeposits.set(result.depositId, Date.now() + DEPOSIT_TTL_MS);
    }

    // Consume the memo so it cannot be reused
    memoStore.delete(proof.memo);

    c.set("paymentProof", result);
    await next();

    // Attach receipt header after the route handler has built its response
    const receipt = btoa(
      JSON.stringify({
        depositId: result.depositId ?? null,
        solanaSignature: result.solanaSignature ?? null,
        confirmedAmountUsdc: result.confirmedAmountUsdc?.toString() ?? null,
        servedAt: new Date().toISOString(),
      })
    );
    c.header("X-Payment-Receipt", receipt);
  };
}
