// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
// All rights reserved.

import {
  encodeFunctionData,
  isAddress,
  isHex,
  type Address,
  type Hex,
} from "viem";
import type { EvmPaymentParams, EvmPaymentTransaction } from "../types.js";
import { getChain } from "../chains.js";
import { ERC20_ABI, PUMP_CROSSCHAIN_API } from "../constants.js";
import { assertQuoteValid } from "./quote.js";

interface PumpBridgeTxResponse {
  /** Address of the Pump/MoonPay bridge contract to call */
  to: string;
  /** Encoded calldata */
  data: string;
  /** Native value to send (hex string) */
  value: string;
  /** ERC-20 spender that needs approval (absent when paying with native) */
  approvalSpender?: string;
}

/**
 * Fetch the bridge transaction calldata from Pump.fun's cross-chain API
 * and wrap it with an optional ERC-20 approval transaction.
 *
 * The returned transactions should be sent in order:
 *   1. approval (if present) — wait for confirmation
 *   2. bridge
 */
export async function buildEvmPaymentTransaction(
  params: EvmPaymentParams,
  apiKey?: string
): Promise<EvmPaymentTransaction> {
  assertQuoteValid(params.quote);

  getChain(params.quote.fromChainId); // throws for an unsupported chain
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["x-api-key"] = apiKey;

  const res = await fetch(`${PUMP_CROSSCHAIN_API}/build-tx`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      quoteId: params.quote.quoteId,
      fromChainId: params.quote.fromChainId,
      fromToken:
        params.quote.fromToken === "native"
          ? "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"
          : params.quote.fromToken,
      fromAmount: params.quote.fromAmount.toString(),
      sender: params.sender,
      agentMint: params.agentMint,
      destinationSolanaWallet: params.destinationSolanaWallet,
      memo: params.memo,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Bridge tx build failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as Partial<PumpBridgeTxResponse>;
  if (
    typeof data.to !== "string" ||
    !isAddress(data.to) ||
    typeof data.data !== "string" ||
    !isHex(data.data) ||
    typeof data.value !== "string" ||
    (data.approvalSpender !== undefined &&
      (typeof data.approvalSpender !== "string" || !isAddress(data.approvalSpender)))
  ) {
    throw new Error("Bridge tx build returned a malformed transaction");
  }
  const value = BigInt(data.value);
  if (value < 0n) throw new Error("Bridge tx build returned a negative value");

  const bridge: EvmPaymentTransaction["bridge"] = {
    to: data.to,
    data: data.data,
    value,
    chainId: params.quote.fromChainId,
  };

  // ERC-20 approval required when not paying with native currency
  if (
    params.quote.fromToken !== "native" &&
    data.approvalSpender
  ) {
    // Approve exactly the quoted amount: the spender comes from an HTTP
    // response, so it must never receive an unlimited allowance.
    const approvalData = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "approve",
      args: [data.approvalSpender, params.quote.fromAmount],
    });

    return {
      approval: {
        to: params.quote.fromToken as Address,
        data: approvalData,
        value: 0n,
      },
      bridge,
    };
  }

  return { bridge };
}

/**
 * Check whether the sender already has sufficient ERC-20 allowance,
 * so the UI can skip showing an approval step.
 */
export async function checkAllowance(
  tokenAddress: Address,
  owner: Address,
  spender: Address,
  amount: bigint,
  rpcUrl: string
): Promise<boolean> {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "eth_call",
    params: [
      {
        to: tokenAddress,
        data: encodeFunctionData({
          abi: ERC20_ABI,
          functionName: "allowance",
          args: [owner, spender],
        }),
      },
      "latest",
    ],
  };

  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`Allowance check failed (${res.status})`);
  const json = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (typeof json.result !== "string" || !isHex(json.result)) {
    throw new Error(`Allowance check failed: ${json.error?.message ?? "no result"}`);
  }
  const allowance = BigInt(json.result);
  return allowance >= amount;
}
