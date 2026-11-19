// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
// All rights reserved.

import type { Address } from "viem";
import type { CrossChainPaymentStatusResult, SupportedEvmChainId } from "../types.js";
import { getPaymentStatus } from "../evm/validate.js";
import { PUMP_CROSSCHAIN_API } from "../constants.js";
import { isSupported } from "../chains.js";

export interface EvmPaymentProof {
  scheme: "pump-agent-evm";
  chainId: SupportedEvmChainId;
  txHash: `0x${string}`;
  quoteId: string;
  memo: string;
}

export interface VerifyEvmPaymentParams {
  /** Decoded proof from the X-Payment header (re-validated here) */
  proof: EvmPaymentProof;
  /** Expected memo / invoice ID */
  expectedMemo: string;
  /** Minimum USDC amount that must arrive on Solana (6 decimals) */
  minAmountUsdc: bigint;
  /** Solana agent mint for this agent */
  agentMint: string;
  /**
   * Whether to wait for Solana arrival before returning.
   * Set to false if you want to verify the EVM tx only and handle
   * Solana arrival asynchronously (webhook / queue).
   */
  waitForSolana?: boolean;
}

export interface EvmPaymentVerificationResult {
  valid: boolean;
  /** Deposit ID for status polling */
  depositId?: string;
  /** Solana tx signature (only when waitForSolana: true and arrived) */
  solanaSignature?: string;
  /** Amount confirmed on Solana (6-decimal USDC) */
  confirmedAmountUsdc?: bigint;
  error?: string;
}

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL = /^\d+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEvmPaymentProof(value: unknown): value is EvmPaymentProof {
  return (
    isRecord(value) &&
    value.scheme === "pump-agent-evm" &&
    typeof value.chainId === "number" &&
    isSupported(value.chainId) &&
    typeof value.txHash === "string" &&
    TX_HASH.test(value.txHash) &&
    typeof value.quoteId === "string" &&
    typeof value.memo === "string"
  );
}

/**
 * Server-side facilitator: verify an EVM payment proof from the X-Payment header.
 *
 * The deposit is looked up on the Pump.fun cross-chain API
 * ({@link PUMP_CROSSCHAIN_API}), which is not live: every lookup currently
 * fails and this function returns `valid: false`.
 *
 * A proof is accepted only when the deposit record names this `agentMint` and
 * `expectedMemo` and carries at least `minAmountUsdc`. This function keeps no
 * state: record each accepted `proof.txHash` and refuse it the next time, or
 * the same deposit unlocks unlimited requests.
 *
 * Call this from your API route after decoding the X-Payment header:
 *
 *   const proof = decodePaymentHeader(req.headers.get("x-payment"))
 *   if (!proof) return res.status(402).end()
 *   const result = await verifyEvmPayment({ proof, expectedMemo, minAmountUsdc, agentMint })
 *   if (!result.valid) return res.status(402).json({ error: result.error })
 */
export async function verifyEvmPayment(
  params: VerifyEvmPaymentParams
): Promise<EvmPaymentVerificationResult> {
  const { proof, expectedMemo, minAmountUsdc, agentMint } = params;

  if (!isEvmPaymentProof(proof)) {
    return { valid: false, error: "Malformed payment proof" };
  }

  if (proof.memo !== expectedMemo) {
    return { valid: false, error: "Memo mismatch" };
  }

  // Fetch the deposit record from Pump.fun API using the txHash
  let depositId: string;
  try {
    const query = new URLSearchParams({
      txHash: proof.txHash,
      chainId: String(proof.chainId),
    });
    const res = await fetch(`${PUMP_CROSSCHAIN_API}/deposit?${query}`);
    if (!res.ok) throw new Error(`Deposit lookup failed (${res.status})`);
    const data: unknown = await res.json();
    if (
      !isRecord(data) ||
      typeof data.depositId !== "string" ||
      typeof data.amountUsdc !== "string" ||
      !DECIMAL.test(data.amountUsdc)
    ) {
      throw new Error("Deposit lookup returned a malformed record");
    }
    depositId = data.depositId;

    if (data.agentMint !== agentMint || data.memo !== expectedMemo) {
      return {
        valid: false,
        depositId,
        error: "Deposit is not for this agent and memo",
      };
    }

    const confirmedAmount = BigInt(data.amountUsdc);
    if (confirmedAmount < minAmountUsdc) {
      return {
        valid: false,
        depositId,
        error: `Insufficient amount: got ${confirmedAmount}, need ${minAmountUsdc}`,
      };
    }
  } catch (err) {
    return {
      valid: false,
      error: `EVM tx verification failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!params.waitForSolana) {
    return { valid: true, depositId };
  }

  // Wait for Solana arrival
  try {
    const status: CrossChainPaymentStatusResult = await waitWithTimeout(depositId);

    if (status.status === "arrived_on_solana") {
      return {
        valid: true,
        depositId,
        solanaSignature: status.solanaSignature,
      };
    }

    return {
      valid: false,
      depositId,
      error: `Payment failed in transit: ${status.error ?? status.status}`,
    };
  } catch (err) {
    return {
      valid: false,
      depositId,
      error: `Solana arrival timeout: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function waitWithTimeout(
  depositId: string,
  maxMs = 60_000
): Promise<CrossChainPaymentStatusResult> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const status = await getPaymentStatus(depositId);
    if (status.status === "arrived_on_solana" || status.status === "failed") {
      return status;
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  throw new Error(`Timed out waiting for Solana arrival (${maxMs}ms)`);
}

/**
 * Decode and validate the X-Payment header from an incoming request.
 * Returns null if the header is missing or malformed.
 */
export function decodePaymentHeader(
  headerValue: string | null | undefined
): EvmPaymentProof | null {
  if (!headerValue) return null;
  try {
    const decoded: unknown = JSON.parse(atob(headerValue));
    return isEvmPaymentProof(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

/**
 * Build the X-Payment-Required header value for an agent API endpoint.
 * Include this in HTTP 402 responses so EVM clients know how to pay.
 */
export function buildPaymentRequiredHeader(opts: {
  agentMint: string;
  maxAmountUsdc: bigint;
  resource: string;
  description: string;
  payTo: Address;
  memo: string;
}): string {
  return btoa(
    JSON.stringify({
      scheme: "pump-agent-evm",
      agentMint: opts.agentMint,
      maxAmountRequired: opts.maxAmountUsdc.toString(),
      resource: opts.resource,
      description: opts.description,
      payTo: opts.payTo,
      memo: opts.memo,
    })
  );
}
