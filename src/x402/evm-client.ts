// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
// All rights reserved.

import type { Address } from "viem";
import type { SupportedEvmChainId } from "../types.js";
import { getChain } from "../chains.js";

/**
 * x402 payment header encoding for EVM-originated payments.
 *
 * When an agent API returns HTTP 402 with an X-Payment-Required header,
 * this client handles quoting and attaches the payment proof header
 * (X-Payment) to the retry request.
 *
 * Quoting and bridging go through the Pump.fun cross-chain API
 * (PUMP_CROSSCHAIN_API), which is not live, so a paid retry currently fails
 * before anything is sent. The amount and destination come from the server:
 * pass `onPaymentRequired` to approve or refuse each payment.
 *
 * Usage:
 *   const fetcher = createEvmX402Fetch({ chainId: 8453, walletClient })
 *   const res = await fetcher("https://agent.example/api/chat", { method: "POST", ... })
 */

export interface EvmX402PaymentRequirements {
  scheme: "pump-agent-evm";
  network: string;
  agentMint: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: Address;
  memo: string;
  quoteId?: string;
}

export interface EvmWalletClient {
  chainId: SupportedEvmChainId;
  address: Address;
  sendTransaction: (tx: {
    to: Address;
    data: `0x${string}`;
    value: bigint;
    chainId: number;
  }) => Promise<`0x${string}`>;
}

export interface EvmX402FetchOptions {
  walletClient: EvmWalletClient;
  /**
   * Called before anything is sent, with requirements chosen by the server.
   * Resolve `false` to refuse; without this hook every 402 is paid.
   */
  onPaymentRequired?: (requirements: EvmX402PaymentRequirements) => Promise<boolean>;
  /** Called after the bridge tx is submitted with the tx hash */
  onPaymentSubmitted?: (txHash: `0x${string}`, depositId: string) => void;
}

/**
 * Returns a fetch-compatible function that automatically handles HTTP 402
 * responses by paying via EVM cross-chain and retrying the request.
 */
function isPayableRequirements(value: unknown): value is EvmX402PaymentRequirements {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    r.scheme === "pump-agent-evm" &&
    typeof r.maxAmountRequired === "string" &&
    /^\d+$/.test(r.maxAmountRequired) &&
    BigInt(r.maxAmountRequired) > 0n &&
    typeof r.agentMint === "string" &&
    r.agentMint.length > 0 &&
    typeof r.payTo === "string" &&
    r.payTo.length > 0 &&
    typeof r.memo === "string" &&
    /^\d+$/.test(r.memo)
  );
}

export function createEvmX402Fetch(opts: EvmX402FetchOptions) {
  return async function x402Fetch(
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    // A Request body can only be read once; keep a copy for the paid retry.
    const retryInput = input instanceof Request ? input.clone() : input;
    const firstRes = await fetch(input, init);

    if (firstRes.status !== 402) return firstRes;

    const requirementsHeader = firstRes.headers.get("X-Payment-Required");
    if (!requirementsHeader) return firstRes;

    let requirements: unknown;
    try {
      requirements = JSON.parse(atob(requirementsHeader));
    } catch {
      return firstRes;
    }

    if (!isPayableRequirements(requirements)) return firstRes;

    // Let the UI confirm before signing
    if (opts.onPaymentRequired) {
      const confirmed = await opts.onPaymentRequired(requirements);
      if (!confirmed) return firstRes;
    }

    const chain = getChain(opts.walletClient.chainId);

    // Build and send the bridge payment
    const { getQuote } = await import("../evm/quote.js");
    const { buildEvmPaymentTransaction } = await import("../evm/transaction.js");

    const quote = await getQuote({
      fromChainId: opts.walletClient.chainId,
      fromToken: chain.usdc,
      fromAmount: BigInt(requirements.maxAmountRequired),
      agentMint: requirements.agentMint,
    });

    const txs = await buildEvmPaymentTransaction({
      quote,
      agentMint: requirements.agentMint,
      destinationSolanaWallet: requirements.payTo,
      memo: requirements.memo,
      sender: opts.walletClient.address,
    });

    // Send approval if needed
    if (txs.approval) {
      await opts.walletClient.sendTransaction({
        to: txs.approval.to,
        data: txs.approval.data,
        value: txs.approval.value,
        chainId: opts.walletClient.chainId,
      });
    }

    // Send bridge tx
    const bridgeTxHash = await opts.walletClient.sendTransaction({
      to: txs.bridge.to,
      data: txs.bridge.data,
      value: txs.bridge.value,
      chainId: txs.bridge.chainId,
    });

    // Build payment proof header
    const paymentProof = btoa(
      JSON.stringify({
        scheme: "pump-agent-evm",
        chainId: opts.walletClient.chainId,
        txHash: bridgeTxHash,
        quoteId: quote.quoteId,
        memo: requirements.memo,
      })
    );

    if (opts.onPaymentSubmitted) {
      opts.onPaymentSubmitted(bridgeTxHash, quote.quoteId);
    }

    // Retry the original request with payment proof. Headers in `init`
    // replace a Request's own headers, so start from whichever applies.
    await firstRes.body?.cancel();
    const retryHeaders = new Headers(
      init?.headers ?? (retryInput instanceof Request ? retryInput.headers : undefined)
    );
    retryHeaders.set("X-Payment", paymentProof);

    return fetch(retryInput, { ...init, headers: retryHeaders });
  };
}
