/**
 * Viem chain objects for all 6 supported EVM chains.
 * Chain configs (RPC, USDC address) are sourced from src/chains.ts at runtime.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  type Chain,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getChain, SUPPORTED_CHAIN_IDS } from "../../src/chains.js";
import type { SupportedEvmChainId } from "../../src/types.js";

// Minimal viem Chain descriptors (only what viem requires to build a client)
const VIEM_CHAINS: Record<SupportedEvmChainId, Chain> = {
  1: {
    id: 1,
    name: "Ethereum",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: ["https://eth.llamarpc.com"] } },
    blockExplorers: { default: { name: "Etherscan", url: "https://etherscan.io" } },
  },
  8453: {
    id: 8453,
    name: "Base",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: ["https://mainnet.base.org"] } },
    blockExplorers: { default: { name: "Basescan", url: "https://basescan.org" } },
  },
  42161: {
    id: 42161,
    name: "Arbitrum One",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: ["https://arb1.arbitrum.io/rpc"] } },
    blockExplorers: { default: { name: "Arbiscan", url: "https://arbiscan.io" } },
  },
  137: {
    id: 137,
    name: "Polygon",
    nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
    rpcUrls: { default: { http: ["https://polygon-rpc.com"] } },
    blockExplorers: { default: { name: "Polygonscan", url: "https://polygonscan.com" } },
  },
  56: {
    id: 56,
    name: "BNB Smart Chain",
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    rpcUrls: { default: { http: ["https://bsc-dataseed.binance.org"] } },
    blockExplorers: { default: { name: "BscScan", url: "https://bscscan.com" } },
  },
  43114: {
    id: 43114,
    name: "Avalanche",
    nativeCurrency: { name: "AVAX", symbol: "AVAX", decimals: 18 },
    rpcUrls: { default: { http: ["https://api.avax.network/ext/bc/C/rpc"] } },
    blockExplorers: { default: { name: "Snowtrace", url: "https://snowtrace.io" } },
  },
};

/** Returns the env-var RPC URL for a chain, falling back to the public URL from chains.ts */
export function getRpcUrl(chainId: SupportedEvmChainId): string {
  const envVar = `RPC_URL_${chainId}`;
  return process.env[envVar] ?? getChain(chainId).rpcUrl;
}

/** Create a viem PublicClient for the given chain, using env RPC if available. */
export function buildPublicClient(chainId: SupportedEvmChainId): PublicClient {
  const rpcUrl = getRpcUrl(chainId);
  const viemChain = {
    ...VIEM_CHAINS[chainId],
    rpcUrls: { default: { http: [rpcUrl] } },
  };
  return createPublicClient({ chain: viemChain, transport: http(rpcUrl) });
}

/** Create a viem WalletClient for the given chain using the EVM_PRIVATE_KEY env var. */
export function buildWalletClient(chainId: SupportedEvmChainId): WalletClient {
  const privateKey = process.env.EVM_PRIVATE_KEY;
  if (!privateKey) throw new Error("EVM_PRIVATE_KEY env var is required");
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const rpcUrl = getRpcUrl(chainId);
  const viemChain = {
    ...VIEM_CHAINS[chainId],
    rpcUrls: { default: { http: [rpcUrl] } },
  };
  return createWalletClient({ account, chain: viemChain, transport: http(rpcUrl) });
}

export { SUPPORTED_CHAIN_IDS };
