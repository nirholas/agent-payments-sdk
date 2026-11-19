// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
// All rights reserved.

/**
 * x402 v2 Facilitator & Resource Server
 *
 * Implements the coinbase/x402 3-party architecture:
 *   Client → Resource Server → Facilitator (verify / settle)
 *
 * Provides:
 *   - PumpAgentFacilitator: FacilitatorClient that verifies & settles
 *     "pump-agent" scheme payments against the confirmed on-chain
 *     transaction the client submitted.
 *   - createResourceServer: framework-agnostic Request/Response middleware
 *     that returns 402s with fresh invoices, verifies payment via a
 *     facilitator, and settles.
 */

import { PublicKey, type Connection } from "@solana/web3.js";
import { getInvoiceIdPDA } from "../pdas";
import { parseAgentEvents, type AgentAcceptPaymentEvent } from "../events";
import { toI64BN, toU64BN } from "../integers";
import {
  decodePaymentPayload,
  encodePaymentRequired,
  encodePaymentResponse,
} from "./headers";
import type {
  FacilitatorClient,
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  PaymentResponse,
  PumpAgentPaymentRequirements,
  ResourceServerConfig,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "./types";
import {
  X402_VERSION,
  X402_HEADER_PAYMENT_REQUIRED,
  X402_HEADER_PAYMENT_SIGNATURE,
  X402_HEADER_PAYMENT_RESPONSE,
  SOLANA_MAINNET,
  SOLANA_DEVNET,
  USDC_MAINNET,
  USDC_DEVNET,
} from "./types";

// ─── Settlement Store ───────────────────────────────────────────────────────

/**
 * Records settled invoices so each on-chain payment unlocks at most one
 * request.
 *
 * The default {@link InMemorySettlementStore} only protects a single process.
 * When several server instances share a facilitator role, supply a store
 * backed by shared storage whose `claim` is atomic (for example Redis
 * `SET key 1 NX PXAT expiresAtMs`).
 */
export interface SettlementStore {
  /** True while `key` is recorded as settled. */
  has(key: string): boolean | Promise<boolean>;
  /**
   * Atomically record `key` until `expiresAtMs` (unix ms). Resolve `true` if
   * this call recorded it, `false` if it was already recorded.
   */
  claim(key: string, expiresAtMs: number): boolean | Promise<boolean>;
}

/** Process-local {@link SettlementStore}. Expired entries are pruned on write. */
export class InMemorySettlementStore implements SettlementStore {
  private readonly entries = new Map<string, number>();

  has(key: string): boolean {
    const expiresAt = this.entries.get(key);
    if (expiresAt === undefined) return false;
    if (Date.now() >= expiresAt) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  claim(key: string, expiresAtMs: number): boolean {
    if (this.has(key)) return false;
    this.prune();
    this.entries.set(key, expiresAtMs);
    return true;
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, expiresAt] of this.entries) {
      if (now >= expiresAt) this.entries.delete(key);
    }
  }
}

/**
 * Extra time a settled invoice stays recorded after it stops being
 * acceptable, to absorb clock skew between instances sharing a store.
 */
const SETTLEMENT_RETENTION_MARGIN_MS = 60_000;

/** Tolerated clock skew when checking that an invoice was not issued in the future. */
const CLOCK_SKEW_SECONDS = 30;

const BASE58_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

// ─── Invoice validation ─────────────────────────────────────────────────────

interface ParsedInvoice {
  agentMint: PublicKey;
  asset: PublicKey;
  amount: bigint;
  memo: bigint;
  startTime: number;
  endTime: number;
  maxTimeoutSeconds: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePublicKey(value: unknown): PublicKey | null {
  if (typeof value !== "string") return null;
  try {
    return new PublicKey(value);
  } catch {
    return null;
  }
}

function parseU64String(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^\d{1,20}$/.test(value)) return null;
  try {
    return BigInt(toU64BN(value, "value").toString());
  } catch {
    return null;
  }
}

function parseInvoice(req: PumpAgentPaymentRequirements): ParsedInvoice | string {
  const extra: unknown = req.extra;
  if (!isRecord(extra)) return "Missing pump-agent invoice details";

  const agentMint = parsePublicKey(extra.agentMint);
  if (!agentMint) return "Invalid agentMint";
  const asset = parsePublicKey(req.asset);
  if (!asset) return "Invalid asset";
  const amount = parseU64String(req.amount);
  if (amount === null || amount === 0n) return "Invalid amount";
  const memo = parseU64String(extra.memo);
  if (memo === null) return "Invalid memo";

  const { startTime, endTime } = extra;
  if (
    typeof startTime !== "number" ||
    typeof endTime !== "number" ||
    !Number.isSafeInteger(startTime) ||
    !Number.isSafeInteger(endTime) ||
    endTime <= startTime
  ) {
    return "Invalid invoice window";
  }
  const { maxTimeoutSeconds } = req;
  if (!Number.isSafeInteger(maxTimeoutSeconds) || maxTimeoutSeconds < 0) {
    return "Invalid maxTimeoutSeconds";
  }

  return { agentMint, asset, amount, memo, startTime, endTime, maxTimeoutSeconds };
}

function sameInvoice(a: PaymentRequirements, b: PumpAgentPaymentRequirements): boolean {
  if (a.scheme !== "pump-agent") return false;
  const extra: unknown = a.extra;
  return (
    a.network === b.network &&
    a.asset === b.asset &&
    a.amount === b.amount &&
    a.payTo === b.payTo &&
    isRecord(extra) &&
    extra.agentMint === b.extra.agentMint &&
    extra.memo === b.extra.memo &&
    extra.startTime === b.extra.startTime &&
    extra.endTime === b.extra.endTime
  );
}

function invoiceKey(invoice: ParsedInvoice): string {
  const [invoiceId] = getInvoiceIdPDA(
    invoice.agentMint,
    invoice.asset,
    toU64BN(invoice.amount, "amount"),
    toU64BN(invoice.memo, "memo"),
    toI64BN(invoice.startTime, "startTime"),
    toI64BN(invoice.endTime, "endTime"),
  );
  return invoiceId.toBase58();
}

// ─── Invoice Memo Generation ────────────────────────────────────────────────

/** Random u64 memo, so concurrent servers never issue the same invoice. */
function generateMemo(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  let memo = 0n;
  for (const byte of bytes) memo = (memo << 8n) | BigInt(byte);
  return memo.toString();
}

// ─── Pump Agent Facilitator ─────────────────────────────────────────────────

export interface PumpAgentFacilitatorConfig {
  /** Solana RPC connection for the cluster named by `network` */
  connection: Connection;
  /** CAIP-2 network (default: SOLANA_MAINNET). Requirements for any other network are rejected. */
  network?: string;
  /**
   * Where settled invoices are recorded (default: a process-local
   * {@link InMemorySettlementStore}). Share one store across instances to
   * stop the same payment unlocking a request on each of them.
   */
  settlementStore?: SettlementStore;
}

/**
 * FacilitatorClient implementation for the "pump-agent" scheme.
 *
 * `verify` checks that the payload is for exactly the given invoice, that the
 * invoice is still inside its acceptance window (`endTime +
 * maxTimeoutSeconds`), and that the transaction named by the payload's
 * `signature` is confirmed, succeeded, and emitted an `AgentAcceptPaymentEvent`
 * from the agent payments program for that invoice and payer.
 *
 * `settle` repeats the verification and then claims the invoice in the
 * settlement store, so a paid invoice unlocks one request. Invoice IDs are
 * unique on-chain, so a single payment can never satisfy two invoices.
 *
 * The payment proof is public once it lands on-chain. Whoever presents it
 * first is served, so keep invoice windows short.
 */
export class PumpAgentFacilitator implements FacilitatorClient {
  private readonly connection: Connection;
  private readonly network: string;
  private readonly store: SettlementStore;

  constructor(config: PumpAgentFacilitatorConfig) {
    this.connection = config.connection;
    this.network = config.network ?? SOLANA_MAINNET;
    this.store = config.settlementStore ?? new InMemorySettlementStore();
  }

  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const checked = await this.check(payload, requirements);
    if (typeof checked === "string") {
      return { isValid: false, invalidReason: checked };
    }
    return { isValid: true, payer: checked.payer };
  }

  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const checked = await this.check(payload, requirements);
    if (typeof checked === "string") {
      return { success: false, errorReason: checked };
    }

    const { invoice, key, payer, signature } = checked;
    const expiresAtMs =
      (invoice.endTime + invoice.maxTimeoutSeconds) * 1000 +
      SETTLEMENT_RETENTION_MARGIN_MS;
    if (!(await this.store.claim(key, expiresAtMs))) {
      return { success: false, errorReason: "Invoice already settled", payer };
    }

    return {
      success: true,
      payer,
      transaction: signature,
      network: this.network,
    };
  }

  async getSupported(): Promise<SupportedResponse> {
    return {
      kinds: [
        {
          scheme: "pump-agent",
          network: this.network,
          asset: this.network === SOLANA_DEVNET ? USDC_DEVNET : USDC_MAINNET,
        },
      ],
    };
  }

  private async check(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<
    | string
    | { invoice: ParsedInvoice; key: string; payer: string; signature: string }
  > {
    if (requirements.scheme !== "pump-agent") return "Unsupported scheme";
    if (requirements.network !== this.network) {
      return `Facilitator is configured for ${this.network}, not ${requirements.network}`;
    }
    if (!isRecord(payload) || payload.x402Version !== X402_VERSION) {
      return `Expected x402Version ${X402_VERSION}`;
    }

    const invoice = parseInvoice(requirements);
    if (typeof invoice === "string") return invoice;

    if (!isRecord(payload.accepted) || !sameInvoice(payload.accepted, requirements)) {
      return "Payload does not match the payment requirements";
    }

    const proof: unknown = payload.payload;
    if (!isRecord(proof)) return "Missing payment proof";
    const { signature, payer } = proof;
    if (typeof signature !== "string" || !BASE58_SIGNATURE.test(signature)) {
      return "Missing or malformed transaction signature";
    }
    const payerKey = parsePublicKey(payer);
    if (!payerKey) return "Missing or malformed payer";

    const nowSeconds = Math.floor(Date.now() / 1000);
    if (nowSeconds > invoice.endTime + invoice.maxTimeoutSeconds) {
      return "Invoice expired";
    }

    const key = invoiceKey(invoice);
    if (await this.store.has(key)) return "Invoice already settled";

    let paid: boolean;
    try {
      paid = await this.transactionPaysInvoice(signature, payerKey, invoice, key);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `Verification error: ${message}`;
    }
    if (!paid) return "Transaction does not pay this invoice";

    return { invoice, key, payer: payerKey.toBase58(), signature };
  }

  private async transactionPaysInvoice(
    signature: string,
    payer: PublicKey,
    invoice: ParsedInvoice,
    invoiceId: string,
  ): Promise<boolean> {
    const tx = await this.connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 1,
    });
    if (!tx?.meta || tx.meta.err !== null || !tx.meta.logMessages) return false;

    const amount = toU64BN(invoice.amount, "amount");
    const memo = toU64BN(invoice.memo, "memo");
    const startTime = toI64BN(invoice.startTime, "startTime");
    const endTime = toI64BN(invoice.endTime, "endTime");

    return parseAgentEvents(tx.meta.logMessages).some((event) => {
      if (event.name !== "agentAcceptPaymentEvent") return false;
      const data = event.data as AgentAcceptPaymentEvent;
      return (
        data.user.equals(payer) &&
        data.tokenizedAgentMint.equals(invoice.agentMint) &&
        data.currencyMint.equals(invoice.asset) &&
        data.invoiceId.toBase58() === invoiceId &&
        data.amount.eq(amount) &&
        data.memo.eq(memo) &&
        data.startTime.eq(startTime) &&
        data.endTime.eq(endTime)
      );
    });
  }
}

// ─── Payment Requirements Builder ───────────────────────────────────────────

export interface PumpAgentRequirementsConfig {
  /** Agent token mint (base58) */
  agentMint: string;
  /** Currency / asset mint (base58). Defaults to USDC mainnet */
  asset?: string;
  /**
   * Shown to clients as the recipient. Pump-agent payments always land in the
   * agent's payment vault derived from `agentMint`; this field does not
   * redirect funds.
   */
  payTo: string;
  /** Price in minor units of `asset`, as a decimal string */
  amount: string;
  /** CAIP-2 network (default: SOLANA_MAINNET) */
  network?: string;
  /** Invoice window in seconds (default: 300) */
  invoiceWindowSeconds?: number;
  /** Seconds after the window closes that a payment proof is still accepted (default: 60) */
  maxTimeoutSeconds?: number;
}

/**
 * Build fresh PumpAgentPaymentRequirements with a random u64 invoice memo.
 */
export function buildPumpAgentRequirements(
  config: PumpAgentRequirementsConfig,
): PumpAgentPaymentRequirements {
  const windowSec = config.invoiceWindowSeconds ?? 300;
  if (!Number.isSafeInteger(windowSec) || windowSec <= 0) {
    throw new RangeError("invoiceWindowSeconds must be a positive integer");
  }
  const maxTimeoutSeconds = config.maxTimeoutSeconds ?? 60;
  if (!Number.isSafeInteger(maxTimeoutSeconds) || maxTimeoutSeconds < 0) {
    throw new RangeError("maxTimeoutSeconds must be a non-negative integer");
  }
  const amount = parseU64String(config.amount);
  if (amount === null || amount === 0n) {
    throw new RangeError("amount must be a positive u64 decimal string");
  }
  if (!parsePublicKey(config.agentMint)) {
    throw new TypeError("agentMint must be a base58 public key");
  }
  const asset = config.asset ?? USDC_MAINNET;
  if (!parsePublicKey(asset)) {
    throw new TypeError("asset must be a base58 public key");
  }

  const now = Math.floor(Date.now() / 1000);
  return {
    scheme: "pump-agent",
    network: config.network ?? SOLANA_MAINNET,
    asset,
    amount: config.amount,
    payTo: config.payTo,
    maxTimeoutSeconds,
    extra: {
      agentMint: config.agentMint,
      memo: generateMemo(),
      startTime: now,
      endTime: now + windowSec,
    },
  };
}

// ─── Resource Server Middleware ──────────────────────────────────────────────

/** Copy a pump-agent template with a new memo and a window starting now. */
function issueInvoice(
  template: PumpAgentPaymentRequirements,
  nowSeconds: number,
): PumpAgentPaymentRequirements {
  const windowSec = template.extra.endTime - template.extra.startTime;
  return {
    ...template,
    extra: {
      ...template.extra,
      memo: generateMemo(),
      startTime: nowSeconds,
      endTime: nowSeconds + windowSec,
    },
  };
}

/**
 * Find the configured requirement the client paid against.
 *
 * Every price field must equal the configured one. For pump-agent the memo
 * and window come from the client, because each 402 issues a fresh invoice
 * without storing it; they are accepted only if the window has the configured
 * length and did not start in the future. Picking its own memo gains a client
 * nothing: every invoice still needs its own on-chain payment of the full
 * amount, and the facilitator settles each invoice once.
 */
function resolveAccepted(
  templates: PaymentRequirements[],
  accepted: PaymentRequirements,
  nowSeconds: number,
): PaymentRequirements | null {
  for (const template of templates) {
    if (
      template.scheme !== accepted.scheme ||
      template.network !== accepted.network ||
      template.asset !== accepted.asset ||
      template.amount !== accepted.amount ||
      template.payTo !== accepted.payTo ||
      template.maxTimeoutSeconds !== accepted.maxTimeoutSeconds
    ) {
      continue;
    }
    if (template.scheme !== "pump-agent") return template;

    const extra: unknown = accepted.extra;
    if (!isRecord(extra) || extra.agentMint !== template.extra.agentMint) continue;
    const { memo, startTime, endTime } = extra;
    const windowSec = template.extra.endTime - template.extra.startTime;
    if (
      parseU64String(memo) === null ||
      typeof startTime !== "number" ||
      typeof endTime !== "number" ||
      !Number.isSafeInteger(startTime) ||
      endTime - startTime !== windowSec ||
      startTime > nowSeconds + CLOCK_SKEW_SECONDS
    ) {
      continue;
    }
    return {
      ...template,
      extra: { agentMint: template.extra.agentMint, memo: memo as string, startTime, endTime },
    };
  }
  return null;
}

function isPaymentPayload(value: unknown): value is PaymentPayload {
  return (
    isRecord(value) &&
    value.x402Version === X402_VERSION &&
    isRecord(value.accepted) &&
    typeof value.accepted.scheme === "string" &&
    isRecord(value.payload)
  );
}

/**
 * Creates a handler wrapper that implements the x402 Resource Server role.
 *
 * On requests without PAYMENT-SIGNATURE: returns 402 with PAYMENT-REQUIRED.
 * Every 402 carries a freshly issued invoice (new memo, window starting now)
 * for each pump-agent requirement, so `requirements` can be built once.
 * On requests with PAYMENT-SIGNATURE: matches the payload against the
 * configured requirements, verifies → settles → forwards to handler. Any
 * failure answers 402 with a new challenge and an `error` field.
 *
 * Works with any framework using the standard Request/Response API
 * (Hono, Next.js App Router, Cloudflare Workers, Bun, Deno, etc.).
 *
 * @example
 * ```ts
 * const gate = createResourceServer({
 *   facilitator: new PumpAgentFacilitator({ connection }),
 *   requirements: [buildPumpAgentRequirements({
 *     agentMint: "YourMint...",
 *     payTo: "PaymentVault...",
 *     amount: "1000000",
 *   })],
 *   resource: { url: "/api/inference", description: "AI call" },
 * });
 *
 * // Hono
 * app.get("/api/inference", (c) =>
 *   gate(c.req.raw, () => c.json({ result: "..." }))
 * );
 * ```
 */
export function createResourceServer(
  config: ResourceServerConfig,
): (
  request: Request,
  handler: () => Response | Promise<Response>,
) => Promise<Response> {
  const { facilitator, resource } = config;

  const paymentRequired = (error?: string): Response => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const body: PaymentRequired = {
      x402Version: X402_VERSION,
      ...(error ? { error } : {}),
      resource,
      accepts: config.requirements.map((r) =>
        r.scheme === "pump-agent" ? issueInvoice(r, nowSeconds) : r,
      ),
    };
    return new Response(JSON.stringify(body), {
      status: 402,
      statusText: "Payment Required",
      headers: {
        "Content-Type": "application/json",
        [X402_HEADER_PAYMENT_REQUIRED]: encodePaymentRequired(body),
      },
    });
  };

  return async (
    request: Request,
    handler: () => Response | Promise<Response>,
  ): Promise<Response> => {
    const paymentHeader = request.headers.get(X402_HEADER_PAYMENT_SIGNATURE);
    if (!paymentHeader) return paymentRequired();

    let paymentPayload: PaymentPayload;
    try {
      const decoded: unknown = decodePaymentPayload(paymentHeader);
      if (!isPaymentPayload(decoded)) throw new Error("malformed payload");
      paymentPayload = decoded;
    } catch {
      return new Response("Invalid PAYMENT-SIGNATURE header", { status: 400 });
    }

    const matchedReq = resolveAccepted(
      config.requirements,
      paymentPayload.accepted,
      Math.floor(Date.now() / 1000),
    );
    if (!matchedReq) return paymentRequired("No matching payment requirement");

    const verifyResult = await facilitator.verify(paymentPayload, matchedReq);
    if (!verifyResult.isValid) {
      return paymentRequired(verifyResult.invalidReason ?? "Payment verification failed");
    }

    const settleResult = await facilitator.settle(paymentPayload, matchedReq);
    if (!settleResult.success) {
      return paymentRequired(settleResult.errorReason ?? "Payment settlement failed");
    }

    const finalResponse = await handler();

    const paymentResponse: PaymentResponse = {
      success: true,
      transaction: settleResult.transaction,
      network: settleResult.network,
      payer: settleResult.payer,
    };

    // Rebuild the response so its headers are mutable.
    const outResponse = new Response(finalResponse.body, {
      status: finalResponse.status,
      statusText: finalResponse.statusText,
      headers: new Headers(finalResponse.headers),
    });
    outResponse.headers.set(
      X402_HEADER_PAYMENT_RESPONSE,
      encodePaymentResponse(paymentResponse),
    );

    return outResponse;
  };
}
