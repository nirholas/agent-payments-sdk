// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
// All rights reserved.

import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { x402 } from "@nirholas/agent-payments-sdk/solana";
import type Anthropic from "@anthropic-ai/sdk";

const USDC_DECIMALS = 6;

export function toHumanUsdc(minorUnits: string | bigint | number): string {
  return (Number(minorUnits) / 10 ** USDC_DECIMALS).toFixed(USDC_DECIMALS);
}

// ─── Tool definitions (Anthropic API format) ──────────────────────────────────

export const TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: "check_usdc_balance",
    description:
      "Check the agent wallet's USDC balance on Solana mainnet",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "fetch_resource",
    description:
      "Fetch a URL. If the server requires payment (HTTP 402), automatically pay in USDC up to the configured maximum and retry. Returns the response body and payment details if a payment was made.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to fetch" },
        method: {
          type: "string",
          enum: ["GET", "POST"],
          description: "HTTP method (default: GET)",
        },
        body: {
          type: "string",
          description: "JSON string body for POST requests",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "inspect_402",
    description:
      "Inspect the payment requirements of an HTTP 402 endpoint without paying",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to inspect" },
      },
      required: ["url"],
    },
  },
];

// ─── Agent tool config ─────────────────────────────────────────────────────────

export interface AgentToolConfig {
  connection: Connection;
  keypair: Keypair;
  maxPaymentUsdc: number;
}

// ─── Tool result types ─────────────────────────────────────────────────────────

export interface BalanceResult {
  balance: string;
  balanceUsdc: string;
  address: string;
}

export interface PaymentInfo {
  signature: string;
  amountUsdc: string;
  scheme: string;
}

export interface FetchResult {
  status: number;
  body?: string;
  paymentMade?: false | PaymentInfo;
  error?: string;
  required?: string;
  limit?: string;
}

// ─── check_usdc_balance handler ───────────────────────────────────────────────

export async function handleCheckUsdcBalance(
  connection: Connection,
  payer: PublicKey,
): Promise<BalanceResult> {
  const ata = getAssociatedTokenAddressSync(
    new PublicKey(x402.USDC_MAINNET),
    payer,
  );
  try {
    const { value } = await connection.getTokenAccountBalance(ata);
    return {
      balance: value.amount,
      balanceUsdc: (value.uiAmount ?? 0).toFixed(USDC_DECIMALS),
      address: payer.toBase58(),
    };
  } catch {
    return {
      balance: "0",
      balanceUsdc: "0.000000",
      address: payer.toBase58(),
    };
  }
}

// ─── inspect_402 handler ──────────────────────────────────────────────────────

export async function handleInspect402(url: string): Promise<unknown> {
  const response = await fetch(url, { method: "GET" });
  if (response.status !== 402) {
    return { status: response.status, message: "Not an x402 endpoint" };
  }
  const pr = x402.getPaymentRequiredFromResponse(response);
  if (!pr) {
    return {
      status: 402,
      message: "402 response but no PAYMENT-REQUIRED header",
    };
  }
  return pr;
}

// ─── fetch_resource handler ───────────────────────────────────────────────────

export async function handleFetchResource(
  url: string,
  method: "GET" | "POST" = "GET",
  body: string | undefined,
  config: AgentToolConfig,
): Promise<FetchResult> {
  const { connection, keypair, maxPaymentUsdc } = config;

  // 1. Probe with GET to check payment requirements before committing
  const probe = await fetch(url, { method: "GET" });
  let capturedAmountUsdc: string | null = null;
  let capturedScheme: string | null = null;

  if (probe.status === 402) {
    const pr = x402.getPaymentRequiredFromResponse(probe);
    if (pr) {
      const req =
        pr.accepts.find(
          (r) => r.scheme === "pump-agent" && r.network === x402.SOLANA_MAINNET,
        ) ??
        pr.accepts.find(
          (r) => r.scheme === "exact" && r.network === x402.SOLANA_MAINNET,
        ) ??
        null;

      if (req) {
        const amountUsdc = Number(req.amount) / 10 ** USDC_DECIMALS;
        if (amountUsdc > maxPaymentUsdc) {
          return {
            status: 402,
            error: "Payment exceeds limit",
            required: `${amountUsdc.toFixed(USDC_DECIMALS)} USDC`,
            limit: `${maxPaymentUsdc.toFixed(USDC_DECIMALS)} USDC`,
          };
        }
        capturedAmountUsdc = toHumanUsdc(req.amount);
        capturedScheme = req.scheme;
      }
    }
  }

  // 2. Track the signature emitted during payment
  let lastSig: string | null = null;

  // 3. Create x402fetch instance with signing + sending callbacks
  const x402fetch = x402.createX402Fetch({
    payer: keypair.publicKey.toBase58(),
    connection,
    signTransaction: async (txBase64: string): Promise<string> => {
      const tx = Transaction.from(Buffer.from(txBase64, "base64"));
      tx.partialSign(keypair);
      return Buffer.from(
        tx.serialize({ requireAllSignatures: false }),
      ).toString("base64");
    },
    sendTransaction: async (signedTxBase64: string): Promise<string> => {
      const raw = Buffer.from(signedTxBase64, "base64");
      const sig = await connection.sendRawTransaction(raw, {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });
      lastSig = sig;
      await connection.confirmTransaction(sig, "confirmed");
      return sig;
    },
    confirmationTimeoutMs: 60_000,
  });

  // 4. Build request init
  const init: RequestInit = { method };
  if (method === "POST" && body) {
    init.headers = { "Content-Type": "application/json" };
    init.body = body;
  }

  // 5. Execute — x402fetch handles 402 detection, payment, and retry
  const response = await x402fetch(url, init);

  // 6. Check server-reported payment result from PAYMENT-RESPONSE header
  const paymentResponse = x402.getPaymentResponseFromResponse(response);

  if (response.ok) {
    const responseBody = await response.text();

    let paymentMade: false | PaymentInfo = false;

    if (lastSig) {
      paymentMade = {
        signature: lastSig,
        amountUsdc: capturedAmountUsdc ?? "unknown",
        scheme: capturedScheme ?? "unknown",
      };
    } else if (paymentResponse?.success && paymentResponse.transaction) {
      paymentMade = {
        signature: paymentResponse.transaction,
        amountUsdc: capturedAmountUsdc ?? "unknown",
        scheme: capturedScheme ?? "unknown",
      };
    }

    return { status: response.status, body: responseBody, paymentMade };
  }

  if (response.status === 402) {
    return { status: 402, error: "Payment failed" };
  }

  return { status: response.status, error: await response.text() };
}

// ─── Tool dispatcher ───────────────────────────────────────────────────────────

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  config: AgentToolConfig,
): Promise<unknown> {
  switch (name) {
    case "check_usdc_balance":
      return handleCheckUsdcBalance(config.connection, config.keypair.publicKey);

    case "inspect_402": {
      const url = input.url as string;
      return handleInspect402(url);
    }

    case "fetch_resource": {
      const url = input.url as string;
      const method = (input.method as "GET" | "POST" | undefined) ?? "GET";
      const body = input.body as string | undefined;
      return handleFetchResource(url, method, body, config);
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}
