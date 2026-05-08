// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
// All rights reserved.

/**
 * Tool definitions and handler implementations for the Claude EVM x402 agent.
 *
 * Each tool is typed end-to-end: input interface → handler → typed result.
 * No `any` types.
 */

import Anthropic from "@anthropic-ai/sdk";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Chain,
} from "viem";
import { mainnet, base, arbitrum, polygon, bsc, avalanche } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import type { SupportedEvmChainId } from "../../../../src/types.js";
import { SUPPORTED_CHAIN_IDS, getChain } from "../../../../src/chains.js";
import { ERC20_ABI } from "../../../../src/constants.js";
import {
  createEvmX402Fetch,
  type EvmX402PaymentRequirements,
  type EvmWalletClient,
} from "../../../../src/x402/evm-client.js";
import { getQuote } from "../../../../src/evm/quote.js";

// ── Viem chain map ─────────────────────────────────────────────────────────

const VIEM_CHAINS: Record<SupportedEvmChainId, Chain> = {
  1: mainnet,
  8453: base,
  42161: arbitrum,
  137: polygon,
  56: bsc,
  43114: avalanche,
};

// ── Tool input types ───────────────────────────────────────────────────────

export interface CheckEvmBalanceInput {
  chainId?: SupportedEvmChainId;
}

export interface Inspect402Input {
  url: string;
}

export interface FetchResourceInput {
  url: string;
  method?: "GET" | "POST";
  body?: string;
  chainId?: SupportedEvmChainId;
}

export interface GetBridgeQuoteInput {
  fromChainId: SupportedEvmChainId;
  amountUsdc: string;
  agentMint: string;
}

// ── Tool definitions ───────────────────────────────────────────────────────

export const TOOLS: Anthropic.Tool[] = [
  {
    name: "check_evm_balance",
    description:
      "Check USDC balance on one or all supported EVM chains. Returns balance in human-readable USDC.",
    input_schema: {
      type: "object",
      properties: {
        chainId: {
          type: "number",
          description:
            "Chain ID (1=Ethereum, 8453=Base, 42161=Arbitrum, 137=Polygon, 56=BSC, 43114=Avalanche). Omit to check all chains.",
          enum: [1, 8453, 42161, 137, 56, 43114],
        },
      },
      required: [],
    },
  },
  {
    name: "inspect_402",
    description:
      "Inspect the payment requirements of an HTTP 402 endpoint without paying. Returns the decoded X-Payment-Required payload.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to inspect" },
      },
      required: ["url"],
    },
  },
  {
    name: "fetch_resource",
    description:
      "Fetch an HTTP resource. Automatically handles EVM x402 USDC payment if the server returns 402. Pays from the configured EVM chain using the bridge. Refuses if amount exceeds the configured maximum.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string" },
        method: { type: "string", enum: ["GET", "POST"], default: "GET" },
        body: { type: "string", description: "JSON body for POST" },
        chainId: {
          type: "number",
          description: "EVM chain to pay from. Omit to use default.",
          enum: [1, 8453, 42161, 137, 56, 43114],
        },
      },
      required: ["url"],
    },
  },
  {
    name: "get_bridge_quote",
    description:
      "Get a bridge quote for sending USDC from an EVM chain to a Solana agent. Returns fee estimate and net amount.",
    input_schema: {
      type: "object",
      properties: {
        fromChainId: {
          type: "number",
          enum: [1, 8453, 42161, 137, 56, 43114],
        },
        amountUsdc: {
          type: "string",
          description: "Amount in decimal USDC, e.g. '1.5'",
        },
        agentMint: { type: "string" },
      },
      required: ["fromChainId", "amountUsdc", "agentMint"],
    },
  },
];

// ── Handler config ─────────────────────────────────────────────────────────

export interface ToolHandlerConfig {
  privateKey: `0x${string}`;
  defaultChainId: SupportedEvmChainId;
  /** Per-chain RPC URL overrides. Falls back to public RPCs from chain config. */
  rpcUrls: Partial<Record<SupportedEvmChainId, string>>;
  maxPaymentUsdc: number;
}

// ── Result types ───────────────────────────────────────────────────────────

export interface BalanceResult {
  chainId: SupportedEvmChainId;
  chainName: string;
  balanceUsdc: string;
  usdcAddress: string;
}

export type Inspect402Result =
  | (EvmX402PaymentRequirements & { maxAmountUsdc: string })
  | { status: number; message: string };

export interface FetchResourceResult {
  status: number;
  body: string;
  paymentMade:
    | { txHash: string; chainId: SupportedEvmChainId; amountUsdc: string }
    | false;
}

export interface FetchResourceError {
  error: string;
  required: string;
  limit: string;
}

export interface BridgeQuoteResult {
  quoteId: string;
  fromChainId: SupportedEvmChainId;
  fromChainName: string;
  estimatedFeeUsdc: string;
  netAmountUsdc: string;
  expiresIn: number;
}

// ── Factory ────────────────────────────────────────────────────────────────

export function createToolHandlers(config: ToolHandlerConfig) {
  const account = privateKeyToAccount(config.privateKey);
  const walletAddress = account.address;

  function getRpcUrl(chainId: SupportedEvmChainId): string {
    return config.rpcUrls[chainId] ?? getChain(chainId).rpcUrl;
  }

  function makeEvmWalletClient(chainId: SupportedEvmChainId): EvmWalletClient {
    const viemChain = VIEM_CHAINS[chainId];
    const viemClient = createWalletClient({
      account,
      chain: viemChain,
      transport: http(getRpcUrl(chainId)),
    });

    return {
      chainId,
      address: walletAddress,
      sendTransaction: async (tx) => {
        return viemClient.sendTransaction({
          to: tx.to,
          data: tx.data,
          value: tx.value,
          chain: viemChain,
        });
      },
    };
  }

  async function getSingleBalance(
    chainId: SupportedEvmChainId
  ): Promise<BalanceResult> {
    const chain = getChain(chainId);
    const publicClient = createPublicClient({
      chain: VIEM_CHAINS[chainId],
      transport: http(getRpcUrl(chainId)),
    });

    const balance = (await publicClient.readContract({
      address: chain.usdc,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [walletAddress],
    })) as bigint;

    return {
      chainId,
      chainName: chain.name,
      balanceUsdc: (Number(balance) / 1_000_000).toFixed(6),
      usdcAddress: chain.usdc,
    };
  }

  async function doInspect402(url: string): Promise<Inspect402Result> {
    const res = await fetch(url);

    if (res.status !== 402) {
      return { status: res.status, message: "Not an x402 endpoint" };
    }

    const header = res.headers.get("X-Payment-Required");
    if (!header) {
      return { status: 402, message: "Missing X-Payment-Required header" };
    }

    let requirements: EvmX402PaymentRequirements;
    try {
      requirements = JSON.parse(atob(header)) as EvmX402PaymentRequirements;
    } catch {
      return { status: 402, message: "Failed to decode X-Payment-Required header" };
    }

    return {
      ...requirements,
      maxAmountUsdc: (Number(requirements.maxAmountRequired) / 1_000_000).toFixed(6),
    };
  }

  return {
    async check_evm_balance(input: CheckEvmBalanceInput): Promise<BalanceResult[]> {
      if (input.chainId !== undefined) {
        return [await getSingleBalance(input.chainId)];
      }
      return Promise.all(SUPPORTED_CHAIN_IDS.map(getSingleBalance));
    },

    async inspect_402(input: Inspect402Input): Promise<Inspect402Result> {
      return doInspect402(input.url);
    },

    async fetch_resource(
      input: FetchResourceInput
    ): Promise<FetchResourceResult | FetchResourceError> {
      const chainId = input.chainId ?? config.defaultChainId;

      // Inspect payment requirements before committing to pay
      const requirements = await doInspect402(input.url);

      if ("maxAmountRequired" in requirements) {
        const maxAmountUsdc = Number(requirements.maxAmountRequired) / 1_000_000;
        if (maxAmountUsdc > config.maxPaymentUsdc) {
          return {
            error: "Payment exceeds limit",
            required: maxAmountUsdc.toFixed(6),
            limit: config.maxPaymentUsdc.toFixed(6),
          };
        }
      }

      // Use an object reference so TypeScript does not narrow the captured value
      // to `never` via control-flow analysis of the async callback.
      const paymentCapture: {
        value: { txHash: `0x${string}`; depositId: string } | null;
      } = { value: null };

      const walletClient = makeEvmWalletClient(chainId);
      const x402Fetch = createEvmX402Fetch({
        walletClient,
        onPaymentSubmitted: (txHash, depositId) => {
          paymentCapture.value = { txHash, depositId };
        },
      });

      const fetchInit: RequestInit = { method: input.method ?? "GET" };
      if (input.body) {
        fetchInit.body = input.body;
        fetchInit.headers = { "Content-Type": "application/json" };
      }

      const res = await x402Fetch(input.url, fetchInit);
      const body = await res.text();

      const amountUsdc =
        "maxAmountRequired" in requirements
          ? (Number(requirements.maxAmountRequired) / 1_000_000).toFixed(6)
          : "0.000000";

      const captured = paymentCapture.value;
      return {
        status: res.status,
        body,
        paymentMade: captured
          ? { txHash: captured.txHash, chainId, amountUsdc }
          : false,
      };
    },

    async get_bridge_quote(input: GetBridgeQuoteInput): Promise<BridgeQuoteResult> {
      const chain = getChain(input.fromChainId);
      const fromAmount = BigInt(Math.round(parseFloat(input.amountUsdc) * 1_000_000));

      const quote = await getQuote({
        fromChainId: input.fromChainId,
        fromToken: chain.usdc,
        fromAmount,
        agentMint: input.agentMint,
      });

      const nowSeconds = Math.floor(Date.now() / 1000);
      return {
        quoteId: quote.quoteId,
        fromChainId: quote.fromChainId,
        fromChainName: chain.name,
        estimatedFeeUsdc: quote.bridgeFeeUsd.toFixed(6),
        netAmountUsdc: (Number(quote.toAmountUsdc) / 1_000_000).toFixed(6),
        expiresIn: Math.max(0, quote.expiresAt - nowSeconds),
      };
    },
  };
}
