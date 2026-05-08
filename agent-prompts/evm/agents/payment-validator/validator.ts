import {
  decodePaymentHeader,
  buildPaymentRequiredHeader,
} from "@nirholas/agent-payments-sdk/x402";
import type { EvmPaymentProof } from "@nirholas/agent-payments-sdk/x402";
import {
  EVM_CHAINS,
  SUPPORTED_CHAIN_IDS,
  generateMemo,
  buildInvoiceWindow,
} from "@nirholas/agent-payments-sdk/evm";

export type { EvmPaymentProof };

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class InvalidSchemeError extends Error {
  constructor(scheme: string) {
    super(`Invalid payment scheme: "${scheme}". Expected "pump-agent-evm"`);
    this.name = "InvalidSchemeError";
  }
}

export class MemoMismatchError extends Error {
  constructor(got: string, expected: string) {
    super(`Memo mismatch: got "${got}", expected "${expected}"`);
    this.name = "MemoMismatchError";
  }
}

export class InsufficientAmountError extends Error {
  constructor(got: bigint, required: bigint) {
    super(`Insufficient amount: got ${got} minor units, required ${required}`);
    this.name = "InsufficientAmountError";
  }
}

export class DepositNotFoundError extends Error {
  constructor(txHash: string) {
    super(`Deposit not found for txHash: ${txHash}`);
    this.name = "DepositNotFoundError";
  }
}

export class SolanaArrivalTimeoutError extends Error {
  constructor(depositId: string) {
    super(`Timed out waiting for Solana arrival of deposit: ${depositId}`);
    this.name = "SolanaArrivalTimeoutError";
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ValidationResult {
  valid: boolean;
  depositId?: string;
  confirmedAmountUsdc?: string;   // human-readable, e.g. "1.5"
  confirmedAmountMinor?: bigint;  // 6-decimal USDC units
  solanaSignature?: string;
  chainId?: number;
  chainName?: string;
  txHash?: string;
  verifiedAt?: Date;
  error?: string;
}

export interface ValidatePaymentParams {
  proof: EvmPaymentProof;
  expectedMemo: string;
  minAmountUsdcMinor: bigint;
  agentMint: string;
  waitForSolana?: boolean;
  timeoutMs?: number;
}

export interface BuildChallengeOpts {
  agentMint: string;
  minAmountUsdc: number;    // decimal, e.g. 1.5
  resource: string;
  description: string;
  payTo: string;            // Solana wallet address
  windowSeconds?: number;   // default 300
}

// ---------------------------------------------------------------------------
// Pump API base URL — override via PUMP_CROSSCHAIN_API env var
// ---------------------------------------------------------------------------

const API_BASE =
  (typeof process !== "undefined" && process.env.PUMP_CROSSCHAIN_API) ||
  "https://api.pump.fun/crosschain";

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Decode an X-Payment header value into an EvmPaymentProof.
 * Returns null for missing or malformed headers.
 * Throws InvalidSchemeError if the scheme field is present but wrong.
 */
export function decodeAndValidateHeader(
  headerValue: string | null | undefined
): EvmPaymentProof | null {
  if (!headerValue) return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(atob(headerValue));
  } catch {
    return null;
  }

  if (!decoded || typeof decoded !== "object") return null;

  const obj = decoded as Record<string, unknown>;
  if (typeof obj.scheme !== "string") return null;

  if (obj.scheme !== "pump-agent-evm") {
    throw new InvalidSchemeError(obj.scheme);
  }

  // Re-use the SDK decoder for final normalisation
  return decodePaymentHeader(headerValue);
}

/**
 * Full payment validation: memo check, deposit lookup, amount check,
 * and optional Solana arrival wait.
 *
 * Does NOT throw — all failures are reflected in result.valid + result.error.
 */
export async function validatePayment(
  params: ValidatePaymentParams
): Promise<ValidationResult> {
  const {
    proof,
    expectedMemo,
    minAmountUsdcMinor,
    waitForSolana = false,
    timeoutMs = 60_000,
  } = params;

  const chainConfig = (EVM_CHAINS as Record<number, { name: string; usdc: string } | undefined>)[
    proof.chainId
  ];
  const context = {
    chainId: proof.chainId as number,
    chainName: chainConfig?.name,
    txHash: proof.txHash,
  };

  // 1. Memo check — fast path, no network calls
  if (proof.memo !== expectedMemo) {
    return {
      valid: false,
      ...context,
      error: `Memo mismatch: got "${proof.memo}", expected "${expectedMemo}"`,
    };
  }

  // 2. Deposit lookup
  let depositId: string;
  let confirmedMinor: bigint;

  try {
    const res = await fetch(
      `${API_BASE}/deposit?txHash=${encodeURIComponent(proof.txHash)}&chainId=${proof.chainId}`
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { valid: false, ...context, error: `Deposit lookup failed (${res.status}): ${body}` };
    }
    const data = (await res.json()) as { depositId: string; amountUsdc: string };
    depositId = data.depositId;
    confirmedMinor = BigInt(data.amountUsdc);
  } catch (err) {
    return {
      valid: false,
      ...context,
      error: `Deposit lookup error: ${(err as Error).message}`,
    };
  }

  // 3. Amount check
  if (confirmedMinor < minAmountUsdcMinor) {
    return {
      valid: false,
      ...context,
      depositId,
      confirmedAmountMinor: confirmedMinor,
      confirmedAmountUsdc: formatUsdc(confirmedMinor),
      error: `Insufficient amount: got ${confirmedMinor}, required ${minAmountUsdcMinor}`,
    };
  }

  // 4. Optional Solana arrival wait
  let solanaSignature: string | undefined;
  if (waitForSolana) {
    const waited = await waitForSolana_(depositId, timeoutMs);
    if (!waited.ok) {
      return {
        valid: false,
        ...context,
        depositId,
        confirmedAmountMinor: confirmedMinor,
        confirmedAmountUsdc: formatUsdc(confirmedMinor),
        error: waited.error,
      };
    }
    solanaSignature = waited.solanaSignature;
  }

  return {
    valid: true,
    depositId,
    confirmedAmountUsdc: formatUsdc(confirmedMinor),
    confirmedAmountMinor: confirmedMinor,
    solanaSignature,
    ...context,
    verifiedAt: new Date(),
  };
}

/**
 * Build an X-Payment-Required challenge header for a 402 response.
 * Returns the encoded header value, the raw memo string, and the expiry time.
 */
export function buildChallenge(opts: BuildChallengeOpts): {
  header: string;
  memo: string;
  expiresAt: Date;
} {
  const { windowSeconds = 300 } = opts;
  const memo = generateMemo().toString();
  const { endTime } = buildInvoiceWindow(windowSeconds);
  const expiresAt = new Date(Number(endTime) * 1000);
  const maxAmountUsdc = BigInt(Math.round(opts.minAmountUsdc * 1_000_000));

  const header = buildPaymentRequiredHeader({
    agentMint: opts.agentMint,
    maxAmountUsdc,
    resource: opts.resource,
    description: opts.description,
    // Solana addresses are passed as-is; the header is JSON, not EVM-validated
    payTo: opts.payTo as `0x${string}`,
    memo,
  });

  return { header, memo, expiresAt };
}

/** Returns true if the challenge window has passed. */
export function isExpired(expiresAt: Date): boolean {
  return Date.now() > expiresAt.getTime();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatUsdc(minor: bigint): string {
  if (minor === 0n) return "0";
  const s = minor.toString().padStart(7, "0");
  const intPart = s.slice(0, -6) || "0";
  const fracPart = s.slice(-6).replace(/0+$/, "");
  return fracPart ? `${intPart}.${fracPart}` : intPart;
}

async function waitForSolana_(
  depositId: string,
  maxMs: number
): Promise<{ ok: true; solanaSignature: string } | { ok: false; error: string }> {
  const deadline = Date.now() + maxMs;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${API_BASE}/status/${depositId}`);
      if (res.ok) {
        const data = (await res.json()) as {
          status: string;
          solanaSignature?: string;
          error?: string;
        };

        if (data.status === "completed" || data.status === "settled") {
          return { ok: true, solanaSignature: data.solanaSignature ?? "" };
        }
        if (data.status === "failed" || data.status === "expired" || data.status === "refunded") {
          return { ok: false, error: `Payment failed in transit: ${data.error ?? data.status}` };
        }
      }
    } catch {
      // transient network error — keep polling
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }

  return {
    ok: false,
    error: new SolanaArrivalTimeoutError(depositId).message,
  };
}

export { SUPPORTED_CHAIN_IDS, EVM_CHAINS };
