#!/usr/bin/env node
/**
 * EVM USDC x402 Autonomous Fetch Client
 *
 * Detects HTTP 402 responses, pays the required USDC amount via an EVM
 * cross-chain bridge, and retries the original request with the X-Payment
 * proof header.
 *
 * Usage:
 *   node index.ts <URL> [JSON_BODY]
 *
 * Environment variables:
 *   EVM_PRIVATE_KEY   EVM private key (hex, with or without 0x)
 *   EVM_CHAIN_ID      Source chain ID (default: 8453 = Base)
 *   EVM_RPC_URL       RPC URL for the chosen chain (optional, falls back to public)
 *   MAX_PAYMENT_USDC  Maximum USDC to pay per request (default: 2.0)
 */

import {
  createWalletClient,
  createPublicClient,
  http,
  type Chain,
  type Address,
} from "viem";
import {
  mainnet,
  base,
  arbitrum,
  polygon,
  bsc,
  avalanche,
} from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { createEvmX402Fetch } from "../../../../src/x402/evm-client.js";
import type {
  EvmWalletClient,
  EvmX402PaymentRequirements,
} from "../../../../src/x402/evm-client.js";
import type { SupportedEvmChainId } from "../../../../src/types.js";

// ── Constants ────────────────────────────────────────────────────────────────

const VIEM_CHAINS: Record<SupportedEvmChainId, Chain> = {
  1: mainnet,
  8453: base,
  42161: arbitrum,
  137: polygon,
  56: bsc,
  43114: avalanche,
};

const USDC_ADDRESSES: Record<SupportedEvmChainId, Address> = {
  1: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  8453: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  42161: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  137: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  56: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
  43114: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
};

const CHAIN_NAMES: Record<SupportedEvmChainId, string> = {
  1: "Ethereum",
  8453: "Base",
  42161: "Arbitrum One",
  137: "Polygon",
  56: "BNB Smart Chain",
  43114: "Avalanche",
};

// ERC-20 function selector for approve(address,uint256)
const APPROVE_SELECTOR = "0x095ea7b3";

const ERC20_BALANCE_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isSupportedChainId(id: number): id is SupportedEvmChainId {
  return id in VIEM_CHAINS;
}

function extractRevertReason(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  const msg = err.message;
  const m =
    msg.match(/reverted.*?reason:\s*(.+?)(?:\n|$)/i) ??
    msg.match(/execution reverted:\s*(.+?)(?:\n|$)/i) ??
    msg.match(/revert\s+(.+?)(?:\n|$)/i);
  return m ? m[1].trim() : null;
}

async function fetchWithRetry(
  fetcher: ReturnType<typeof createEvmX402Fetch>,
  url: string,
  init: RequestInit,
  retriesLeft = 2
): Promise<Response> {
  try {
    return await fetcher(url, init);
  } catch (err) {
    if (retriesLeft > 0) {
      console.error(
        `[network] error — retrying in 3 s... (${retriesLeft} attempt${retriesLeft > 1 ? "s" : ""} left)`
      );
      await sleep(3000);
      return fetchWithRetry(fetcher, url, init, retriesLeft - 1);
    }
    throw err;
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error("Usage: node index.ts <URL> [JSON_BODY]");
    process.exit(1);
  }

  const [url, jsonBody] = args;

  // ── Environment ──────────────────────────────────────────────────────────

  const rawKey = process.env.EVM_PRIVATE_KEY;
  if (!rawKey) {
    console.error("[config] EVM_PRIVATE_KEY is required");
    process.exit(1);
  }

  const rawChainId = Number(process.env.EVM_CHAIN_ID ?? "8453");
  if (!isSupportedChainId(rawChainId)) {
    console.error(
      `[config] Unsupported EVM_CHAIN_ID: ${rawChainId}. Supported: ${Object.keys(VIEM_CHAINS).join(", ")}`
    );
    process.exit(1);
  }
  const chainId: SupportedEvmChainId = rawChainId;

  const rpcUrl = process.env.EVM_RPC_URL;
  const maxPaymentUsdc = parseFloat(process.env.MAX_PAYMENT_USDC ?? "2.0");

  const chainName = CHAIN_NAMES[chainId];
  const viemChain = VIEM_CHAINS[chainId];
  const usdcAddress = USDC_ADDRESSES[chainId];
  const transport = http(rpcUrl ?? undefined);

  // ── Wallet setup ─────────────────────────────────────────────────────────

  const normalizedKey: `0x${string}` = rawKey.startsWith("0x")
    ? (rawKey as `0x${string}`)
    : `0x${rawKey}`;

  const account = privateKeyToAccount(normalizedKey);

  const walletClient = createWalletClient({
    account,
    chain: viemChain,
    transport,
  });

  const publicClient = createPublicClient({
    chain: viemChain,
    transport,
  });

  console.log(`[preflight] address: ${account.address}`);
  console.log(`[preflight] chain: ${chainName} (${chainId})`);

  // ── Pre-flight USDC balance check ─────────────────────────────────────────

  try {
    const rawBalance = await publicClient.readContract({
      address: usdcAddress,
      abi: ERC20_BALANCE_ABI,
      functionName: "balanceOf",
      args: [account.address],
    });
    const balanceUsdc = Number(rawBalance) / 1_000_000;
    console.log(
      `[preflight] USDC balance: ${balanceUsdc.toFixed(6)} USDC on ${chainName}`
    );
    if (rawBalance === 0n) {
      console.warn(
        `[preflight] WARNING: USDC balance is 0 on ${chainName} — payments will fail`
      );
    }
  } catch (err) {
    console.warn(
      `[preflight] Could not read USDC balance: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // ── EvmWalletClient adapter ───────────────────────────────────────────────
  //
  // Detects approval transactions by the ERC-20 approve() selector so they
  // can be logged separately from the bridge transaction.

  const evmWalletClient: EvmWalletClient = {
    chainId,
    address: account.address,

    sendTransaction: async ({ to, data, value, chainId: txChainId }) => {
      const isApproval = data.startsWith(APPROVE_SELECTOR);
      const txChain = isSupportedChainId(txChainId)
        ? VIEM_CHAINS[txChainId]
        : viemChain;

      let hash: `0x${string}`;
      try {
        hash = await walletClient.sendTransaction({ to, data, value, chain: txChain });
      } catch (err) {
        const reason = extractRevertReason(err);
        if (reason) {
          console.error(`[tx] reverted: ${reason}`);
        } else {
          console.error(
            `[tx] send failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
        throw err;
      }

      if (isApproval) {
        console.log(`[approval] sent approve tx: ${hash}`);
        await publicClient.waitForTransactionReceipt({ hash });
        console.log("[approval] confirmed");
      } else {
        await publicClient.waitForTransactionReceipt({ hash });
      }

      return hash;
    },
  };

  // ── x402 fetch client ─────────────────────────────────────────────────────

  const x402Fetch = createEvmX402Fetch({
    walletClient: evmWalletClient,

    onPaymentRequired: async (requirements: EvmX402PaymentRequirements) => {
      const amountUsdc = Number(BigInt(requirements.maxAmountRequired)) / 1_000_000;
      if (amountUsdc > maxPaymentUsdc) {
        console.error(
          `[x402] refused: ${amountUsdc} USDC exceeds limit ${maxPaymentUsdc} USDC`
        );
        return false;
      }
      console.log(`[x402] approving payment: ${amountUsdc} USDC`);
      return true;
    },

    onPaymentSubmitted: (txHash: `0x${string}`, depositId: string) => {
      console.log(
        `[x402] bridge tx submitted | hash=${txHash} | depositId=${depositId} | chain=${chainName}`
      );
    },
  });

  // ── Request ───────────────────────────────────────────────────────────────

  const init: RequestInit = jsonBody
    ? {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: jsonBody,
      }
    : { method: "GET" };

  let res: Response;
  try {
    res = await fetchWithRetry(x402Fetch, url, init);
  } catch (err) {
    const reason = extractRevertReason(err);
    if (reason) {
      console.error(`[error] transaction reverted: ${reason}`);
    } else {
      console.error(
        `[error] ${err instanceof Error ? err.message : String(err)}`
      );
    }
    process.exit(1);
  }

  // ── Response ──────────────────────────────────────────────────────────────

  console.log(`[response] status=${res.status}`);

  const paymentHeader = res.headers.get("X-Payment");
  if (paymentHeader) {
    try {
      const decoded = JSON.parse(atob(paymentHeader));
      console.log("[x402] X-Payment header:", JSON.stringify(decoded, null, 2));
    } catch {
      console.log("[x402] X-Payment header (raw):", paymentHeader);
    }
  }

  const body = await res.text();
  try {
    const json: unknown = JSON.parse(body);
    console.log(JSON.stringify(json, null, 2));
  } catch {
    console.log(body);
  }
}

main().catch((err) => {
  console.error("[fatal]", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
