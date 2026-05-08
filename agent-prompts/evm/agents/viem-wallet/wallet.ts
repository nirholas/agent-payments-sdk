#!/usr/bin/env node
// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
// All rights reserved.
//
// Multi-chain EVM USDC wallet agent — balance, approve, transfer, bridge to Solana.
//
// Usage:
//   node wallet.ts balances
//   node wallet.ts native
//   node wallet.ts allowance <chainId> <spender>
//   node wallet.ts approve   <chainId> <spender> <amount>
//   node wallet.ts transfer  <chainId> <to>      <amount>
//   node wallet.ts bridge    <chainId> <agentMint> <solanaWallet> <amount> <memo>
//
// All <amount> params are decimal USDC strings, e.g. "1.5"
//
// Required env:
//   EVM_PRIVATE_KEY   — hex private key (with 0x prefix)
//
// Optional env (per chain, falls back to public RPCs):
//   RPC_URL_1         RPC_URL_8453     RPC_URL_42161
//   RPC_URL_137       RPC_URL_56       RPC_URL_43114

import {
  createWalletClient,
  createPublicClient,
  http,
  decodeFunctionData,
  type Address,
  type Hash,
  type Chain,
  type WalletClient,
  type PublicClient,
  type TransactionReceipt,
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

import { EVM_CHAINS, SUPPORTED_CHAIN_IDS, getChain } from "../../../../src/chains.js";
import type { SupportedEvmChainId } from "../../../../src/types.js";
import { getQuote } from "../../../../src/evm/quote.js";
import { buildEvmPaymentTransaction } from "../../../../src/evm/transaction.js";

import { erc20Abi } from "./erc20.js";
import {
  InsufficientUsdcError,
  UnsupportedChainError,
  TransactionRevertedError,
} from "./errors.js";

// ── Viem chain objects ────────────────────────────────────────────────────────

const VIEM_CHAINS: Record<SupportedEvmChainId, Chain> = {
  1: mainnet,
  8453: base,
  42161: arbitrum,
  137: polygon,
  56: bsc,
  43114: avalanche,
};

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BalanceRow {
  chainId: SupportedEvmChainId;
  chainName: string;
  usdcAddress: string;
  balance: { raw: bigint; human: string };
}

export interface NativeBalanceRow {
  chainId: SupportedEvmChainId;
  chainName: string;
  balance: { raw: bigint; human: string; symbol: string };
}

export interface BridgeResult {
  approvalHash: Hash | null;
  bridgeHash: Hash;
  quoteId: string;
  estimatedNetUsdc: string;
}

export interface BridgeParams {
  fromChainId: SupportedEvmChainId;
  amountMinor: bigint;
  agentMint: string;
  destinationSolanaWallet: string;
  memo: string;
}

// ── Module-level account (set by main before any operation) ───────────────────

let account!: ReturnType<typeof privateKeyToAccount>;

// ── Client factory (cached per chain) ─────────────────────────────────────────

interface Clients {
  walletClient: WalletClient;
  publicClient: PublicClient;
}

const clientCache = new Map<SupportedEvmChainId, Clients>();

function buildClients(chainId: SupportedEvmChainId): Clients {
  if (!clientCache.has(chainId)) {
    const viemChain = VIEM_CHAINS[chainId];
    if (!viemChain) throw new UnsupportedChainError(chainId);

    const rpcUrl = process.env[`RPC_URL_${chainId}`] ?? EVM_CHAINS[chainId].rpcUrl;
    const transport = http(rpcUrl);

    const walletClient = createWalletClient({
      account,
      chain: viemChain,
      transport,
    });

    const publicClient = createPublicClient({
      chain: viemChain,
      transport,
    });

    clientCache.set(chainId, { walletClient, publicClient });
  }

  return clientCache.get(chainId)!;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Format a USDC minor-unit bigint to a 6-decimal string. */
function formatUsdc(raw: bigint): string {
  const whole = raw / 1_000_000n;
  const frac = (raw % 1_000_000n).toString().padStart(6, "0");
  return `${whole}.${frac}`;
}

/** Parse a decimal USDC string (e.g. "1.5") to minor units (bigint). */
function parseAmount(s: string): bigint {
  const [wholeStr, fracStr = ""] = s.split(".");
  const frac = fracStr.slice(0, 6).padEnd(6, "0");
  return BigInt(wholeStr) * 1_000_000n + BigInt(frac);
}

/** Validate and coerce a CLI chain ID argument. */
function parseChainId(raw: string): SupportedEvmChainId {
  const n = Number(raw);
  if (!(n in VIEM_CHAINS)) throw new UnsupportedChainError(n);
  return n as SupportedEvmChainId;
}

/** Validate EVM address format (basic guard). */
function asAddress(raw: string): Address {
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    throw new Error(`Invalid address: ${raw}`);
  }
  return raw as Address;
}

/** Extract a revert reason from a viem error where possible. */
function extractRevertReason(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  const m =
    err.message.match(/execution reverted[:\s]+([^\n]+)/i) ??
    err.message.match(/revert reason:\s*([^\n]+)/i) ??
    err.message.match(/revert\s+([^\n]+)/i);
  return m ? m[1].trim() : undefined;
}

/** Log a transaction summary after it lands. */
function logTx(
  chainId: SupportedEvmChainId,
  fn: string,
  hash: Hash,
  receipt: TransactionReceipt,
): void {
  const chainName = EVM_CHAINS[chainId].name;
  console.log(
    `[tx] chain=${chainName} (${chainId}) fn=${fn} hash=${hash} status=${receipt.status} gas=${receipt.gasUsed}`,
  );
}

// ── Balance operations ────────────────────────────────────────────────────────

export async function getUsdcBalance(
  chainId: SupportedEvmChainId,
): Promise<{ raw: bigint; human: string }> {
  const { publicClient } = buildClients(chainId);
  const chain = getChain(chainId);

  const raw = await publicClient.readContract({
    address: chain.usdc as Address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address],
  });

  return { raw, human: formatUsdc(raw) };
}

export async function getAllBalances(): Promise<BalanceRow[]> {
  return Promise.all(
    SUPPORTED_CHAIN_IDS.map(async (chainId) => {
      const chain = EVM_CHAINS[chainId];
      const balance = await getUsdcBalance(chainId);
      return {
        chainId,
        chainName: chain.name,
        usdcAddress: chain.usdc,
        balance,
      };
    }),
  );
}

// ── Native balance ────────────────────────────────────────────────────────────

export async function getNativeBalance(
  chainId: SupportedEvmChainId,
): Promise<{ raw: bigint; human: string; symbol: string }> {
  const { publicClient } = buildClients(chainId);
  const viemChain = VIEM_CHAINS[chainId];

  const raw = await publicClient.getBalance({ address: account.address });
  const whole = raw / 10n ** 18n;
  const frac = ((raw % 10n ** 18n) * 10n ** 6n) / 10n ** 18n;
  const human = `${whole}.${frac.toString().padStart(6, "0")}`;

  return { raw, human, symbol: viemChain.nativeCurrency.symbol };
}

export async function getAllNativeBalances(): Promise<NativeBalanceRow[]> {
  return Promise.all(
    SUPPORTED_CHAIN_IDS.map(async (chainId) => {
      const chain = EVM_CHAINS[chainId];
      const balance = await getNativeBalance(chainId);
      return { chainId, chainName: chain.name, balance };
    }),
  );
}

// ── Approval operations ───────────────────────────────────────────────────────

export async function getUsdcAllowance(
  chainId: SupportedEvmChainId,
  spender: Address,
): Promise<bigint> {
  const { publicClient } = buildClients(chainId);
  const chain = getChain(chainId);

  return publicClient.readContract({
    address: chain.usdc as Address,
    abi: erc20Abi,
    functionName: "allowance",
    args: [account.address, spender],
  });
}

export async function approveUsdc(
  chainId: SupportedEvmChainId,
  spender: Address,
  amountMinor: bigint,
): Promise<Hash> {
  const { walletClient, publicClient } = buildClients(chainId);
  const chain = getChain(chainId);

  const currentAllowance = await getUsdcAllowance(chainId, spender);
  if (currentAllowance >= amountMinor) {
    console.log(
      `[approve] already approved, skipping (allowance=${formatUsdc(currentAllowance)} USDC >= required=${formatUsdc(amountMinor)} USDC)`,
    );
    return "0x" as Hash;
  }

  let hash: Hash;
  try {
    hash = await walletClient.writeContract({
      address: chain.usdc as Address,
      abi: erc20Abi,
      functionName: "approve",
      args: [spender, amountMinor],
      chain: VIEM_CHAINS[chainId],
      account,
    });
  } catch (err) {
    const reason = extractRevertReason(err);
    throw new TransactionRevertedError("(pending)", reason);
  }

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  logTx(chainId, "approve", hash, receipt);

  if (receipt.status !== "success") {
    throw new TransactionRevertedError(hash);
  }

  const newAllowance = await getUsdcAllowance(chainId, spender);
  console.log(`[approve] new allowance: ${formatUsdc(newAllowance)} USDC`);

  return hash;
}

// ── USDC transfer ─────────────────────────────────────────────────────────────

export async function transferUsdc(
  chainId: SupportedEvmChainId,
  to: Address,
  amountMinor: bigint,
): Promise<Hash> {
  const { walletClient, publicClient } = buildClients(chainId);
  const chain = getChain(chainId);

  const { raw } = await getUsdcBalance(chainId);
  if (raw < amountMinor) {
    throw new InsufficientUsdcError(raw, amountMinor);
  }

  let hash: Hash;
  try {
    hash = await walletClient.writeContract({
      address: chain.usdc as Address,
      abi: erc20Abi,
      functionName: "transfer",
      args: [to, amountMinor],
      chain: VIEM_CHAINS[chainId],
      account,
    });
  } catch (err) {
    const reason = extractRevertReason(err);
    throw new TransactionRevertedError("(pending)", reason);
  }

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  logTx(chainId, "transfer", hash, receipt);

  if (receipt.status !== "success") {
    throw new TransactionRevertedError(hash);
  }

  return hash;
}

// ── Bridge to Solana ──────────────────────────────────────────────────────────

export async function bridgeToSolana(params: BridgeParams): Promise<BridgeResult> {
  const { fromChainId, amountMinor, agentMint, destinationSolanaWallet, memo } =
    params;
  const { walletClient, publicClient } = buildClients(fromChainId);
  const chain = getChain(fromChainId);

  console.log(
    `[bridge] quoting ${formatUsdc(amountMinor)} USDC from ${chain.name} → Solana`,
  );

  const quote = await getQuote({
    fromChainId,
    fromToken: chain.usdc as Address,
    fromAmount: amountMinor,
    agentMint,
  });

  console.log(
    `[bridge] quote=${quote.quoteId} estimatedNet=${formatUsdc(quote.toAmountUsdc)} USDC fee=$${quote.bridgeFeeUsd.toFixed(4)} est=${quote.estimatedTimeSeconds}s`,
  );

  const paymentTx = await buildEvmPaymentTransaction({
    quote,
    agentMint,
    destinationSolanaWallet,
    memo,
    sender: account.address,
  });

  // Approve bridge contract if the API indicates it's needed
  let approvalHash: Hash | null = null;
  if (paymentTx.approval) {
    const { args } = decodeFunctionData({
      abi: erc20Abi,
      data: paymentTx.approval.data as `0x${string}`,
    });
    // args[0] is the spender, args[1] is the value (maxUint256 from the API)
    const [spender] = args as [Address, bigint];
    console.log(`[bridge] approving bridge spender ${spender}`);
    approvalHash = await approveUsdc(fromChainId, spender, amountMinor);
  }

  // Send bridge transaction
  let bridgeHash: Hash;
  try {
    bridgeHash = await walletClient.sendTransaction({
      to: paymentTx.bridge.to,
      data: paymentTx.bridge.data,
      value: paymentTx.bridge.value,
      chain: VIEM_CHAINS[fromChainId],
      account,
    });
  } catch (err) {
    const reason = extractRevertReason(err);
    throw new TransactionRevertedError("(pending)", reason);
  }

  const receipt = await publicClient.waitForTransactionReceipt({ hash: bridgeHash });
  logTx(fromChainId, "bridge", bridgeHash, receipt);

  if (receipt.status !== "success") {
    throw new TransactionRevertedError(bridgeHash);
  }

  return {
    approvalHash,
    bridgeHash,
    quoteId: quote.quoteId,
    estimatedNetUsdc: formatUsdc(quote.toAmountUsdc),
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function printHelp(): void {
  console.log(`
viem-wallet — multi-chain EVM USDC agent

Usage:
  node wallet.ts balances
  node wallet.ts native
  node wallet.ts allowance <chainId> <spender>
  node wallet.ts approve   <chainId> <spender> <amount>
  node wallet.ts transfer  <chainId> <to>      <amount>
  node wallet.ts bridge    <chainId> <agentMint> <solanaWallet> <amount> <memo>

Supported chain IDs: ${SUPPORTED_CHAIN_IDS.join(", ")}
All <amount> values are decimal USDC (e.g. "1.5").
`.trim());
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === "--help" || cmd === "-h") {
    printHelp();
    process.exit(cmd ? 0 : 1);
  }

  const rawKey = process.env.EVM_PRIVATE_KEY;
  if (!rawKey) {
    console.error("[error] EVM_PRIVATE_KEY environment variable is required");
    process.exit(1);
  }

  const normalizedKey: `0x${string}` = rawKey.startsWith("0x")
    ? (rawKey as `0x${string}`)
    : `0x${rawKey}`;

  account = privateKeyToAccount(normalizedKey);
  console.log(`[wallet] address: ${account.address}`);

  try {
    switch (cmd) {
      // ── balances ──────────────────────────────────────────────────────────
      case "balances": {
        console.log("[balances] fetching USDC balances on all chains...");
        const rows = await getAllBalances();
        console.log("");
        for (const row of rows) {
          console.log(
            `  ${row.chainName.padEnd(18)} (${row.chainId}): ${row.balance.human} USDC`,
          );
        }
        console.log("");
        break;
      }

      // ── native ────────────────────────────────────────────────────────────
      case "native": {
        console.log("[native] fetching native balances on all chains...");
        const rows = await getAllNativeBalances();
        console.log("");
        for (const row of rows) {
          console.log(
            `  ${row.chainName.padEnd(18)} (${row.chainId}): ${row.balance.human} ${row.balance.symbol}`,
          );
        }
        console.log("");
        break;
      }

      // ── allowance ─────────────────────────────────────────────────────────
      case "allowance": {
        if (args.length < 3) {
          console.error("Usage: allowance <chainId> <spender>");
          process.exit(1);
        }
        const chainId = parseChainId(args[1]);
        const spender = asAddress(args[2]);
        const allowance = await getUsdcAllowance(chainId, spender);
        console.log(
          `[allowance] ${EVM_CHAINS[chainId].name}: ${formatUsdc(allowance)} USDC approved for ${spender}`,
        );
        break;
      }

      // ── approve ───────────────────────────────────────────────────────────
      case "approve": {
        if (args.length < 4) {
          console.error("Usage: approve <chainId> <spender> <amount>");
          process.exit(1);
        }
        const chainId = parseChainId(args[1]);
        const spender = asAddress(args[2]);
        const amountMinor = parseAmount(args[3]);
        const hash = await approveUsdc(chainId, spender, amountMinor);
        if (hash === "0x") {
          console.log("[approve] skipped — allowance already sufficient");
        } else {
          console.log(`[approve] done: ${hash}`);
        }
        break;
      }

      // ── transfer ──────────────────────────────────────────────────────────
      case "transfer": {
        if (args.length < 4) {
          console.error("Usage: transfer <chainId> <to> <amount>");
          process.exit(1);
        }
        const chainId = parseChainId(args[1]);
        const to = asAddress(args[2]);
        const amountMinor = parseAmount(args[3]);
        const hash = await transferUsdc(chainId, to, amountMinor);
        console.log(`[transfer] done: ${hash}`);
        break;
      }

      // ── bridge ────────────────────────────────────────────────────────────
      case "bridge": {
        if (args.length < 6) {
          console.error(
            "Usage: bridge <chainId> <agentMint> <solanaWallet> <amount> <memo>",
          );
          process.exit(1);
        }
        const fromChainId = parseChainId(args[1]);
        const agentMint = args[2];
        const destinationSolanaWallet = args[3];
        const amountMinor = parseAmount(args[4]);
        const memo = args[5];

        const result = await bridgeToSolana({
          fromChainId,
          amountMinor,
          agentMint,
          destinationSolanaWallet,
          memo,
        });

        console.log("");
        console.log("[bridge] complete");
        console.log(`  quoteId:          ${result.quoteId}`);
        console.log(`  bridgeHash:       ${result.bridgeHash}`);
        console.log(`  approvalHash:     ${result.approvalHash ?? "(not needed)"}`);
        console.log(`  estimatedNetUsdc: ${result.estimatedNetUsdc} USDC`);
        break;
      }

      default:
        console.error(`[error] unknown command: ${cmd}`);
        printHelp();
        process.exit(1);
    }
  } catch (err) {
    if (err instanceof InsufficientUsdcError) {
      console.error(`[error] ${err.message}`);
    } else if (err instanceof TransactionRevertedError) {
      console.error(`[error] ${err.message}`);
    } else if (err instanceof UnsupportedChainError) {
      console.error(`[error] ${err.message}`);
      console.error(`Supported chain IDs: ${SUPPORTED_CHAIN_IDS.join(", ")}`);
    } else {
      console.error(
        `[error] ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    process.exit(1);
  }
}

main();
