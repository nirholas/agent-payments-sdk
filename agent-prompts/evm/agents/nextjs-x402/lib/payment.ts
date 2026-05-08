import { buildPaymentRequiredHeader } from "@nirholas/agent-payments-sdk/x402";
import type { Address } from "viem";
import type { PaymentChallenge } from "./types";

// In-memory memo store keyed by memo → expiry timestamp (ms).
// CAVEAT: Not suitable for multi-replica deployments. Replace with Redis or
// Upstash for horizontal scaling — memos issued by replica A won't be visible
// to replica B, causing false "Unknown or expired memo" errors.
const memoStore = new Map<string, number>();

const MEMO_TTL_MS = 5 * 60 * 1_000; // 5 minutes

export function buildChallenge(resource: string, description: string): PaymentChallenge {
  const memo = `${Date.now()}${Math.floor(Math.random() * 999999)
    .toString()
    .padStart(6, "0")}`;
  const expiresAt = Date.now() + MEMO_TTL_MS;
  memoStore.set(memo, expiresAt);

  const header = buildPaymentRequiredHeader({
    agentMint: process.env.AGENT_MINT!,
    maxAmountUsdc: BigInt(process.env.PRICE_USDC_MINOR ?? "500000"),
    resource,
    description,
    // AGENT_PAYMENT_VAULT is a Solana base58 address; cast because the SDK
    // serialises it into JSON as a plain string (not used as an EVM address).
    payTo: process.env.AGENT_PAYMENT_VAULT as Address,
    memo,
  });

  return { header, memo, expiresAt };
}

/**
 * Atomically validate and consume a memo.
 * Returns true and removes the memo if it exists and has not expired.
 * Always removes it on the first call — replays are rejected even if the
 * original verification failed downstream.
 */
export function consumeMemo(memo: string): boolean {
  const expiry = memoStore.get(memo);
  if (expiry === undefined) return false;
  memoStore.delete(memo);
  return Date.now() <= expiry;
}
