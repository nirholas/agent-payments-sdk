#!/usr/bin/env node
/**
 * EVM Multi-Chain USDC Payment Router
 *
 * Selects the cheapest EVM chain for a USDC→Solana bridge payment by comparing
 * bridge fees across Ethereum, Base, Arbitrum, Polygon, BSC, and Avalanche.
 *
 * Commands:
 *   balances                   Show USDC balances on all 6 chains
 *   quotes                     Show bridge quotes for all chains
 *   pay [--chain=<id>] [--dry-run]   Execute (or simulate) the optimal payment
 *   status <depositId>         Poll a bridge deposit until it arrives on Solana
 */

import { parseArgs } from "node:util";
import { privateKeyToAccount } from "viem/accounts";
import { type Address } from "viem";

import { getChain, SUPPORTED_CHAIN_IDS } from "../../src/chains.js";
import { getQuote } from "../../src/evm/quote.js";
import { buildEvmPaymentTransaction } from "../../src/evm/transaction.js";
import { ERC20_ABI, PUMP_CROSSCHAIN_API } from "../../src/constants.js";
import type { CrossChainQuote, SupportedEvmChainId } from "../../src/types.js";
import { buildPublicClient, buildWalletClient } from "./chains.js";

// ── Env helpers ────────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function getAmountMinor(amountUsdc: string): bigint {
  // USDC has 6 decimals
  const [whole, frac = ""] = amountUsdc.split(".");
  const fracPadded = frac.slice(0, 6).padEnd(6, "0");
  return BigInt(whole) * 1_000_000n + BigInt(fracPadded);
}

function formatUsdc(minor: bigint): string {
  const s = minor.toString().padStart(7, "0");
  return `${s.slice(0, -6)}.${s.slice(-6).replace(/0+$/, "") || "0"}`;
}

// ── Types ──────────────────────────────────────────────────────────────────────

interface ChainBalance {
  chainId: SupportedEvmChainId;
  chainName: string;
  balance: bigint;
  balanceUsdc: string;
  hasEnough: boolean;
}

type ChainQuoteResult =
  | { chainId: SupportedEvmChainId; chainName: string; available: true; quote: CrossChainQuote; estimatedFeeUsdc: string; netAmountUsdc: string }
  | { chainId: SupportedEvmChainId; chainName: string; available: false; error: string };

interface TxParams {
  to: Address;
  data: `0x${string}`;
  value: bigint;
}

// ── 1. Balance Discovery ───────────────────────────────────────────────────────

export async function getAllUsdcBalances(
  address: Address,
  amountMinor: bigint
): Promise<ChainBalance[]> {
  const results = await Promise.allSettled(
    SUPPORTED_CHAIN_IDS.map(async (chainId: SupportedEvmChainId) => {
      const chain = getChain(chainId);
      const client = buildPublicClient(chainId);
      const balance = await client.readContract({
        address: chain.usdc as Address,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [address],
      }) as bigint;
      return {
        chainId,
        chainName: chain.name,
        balance,
        balanceUsdc: formatUsdc(balance),
        hasEnough: balance >= amountMinor,
      };
    })
  );

  const balances: ChainBalance[] = results.map(
    (r: PromiseSettledResult<ChainBalance>, i: number) => {
    const chainId = SUPPORTED_CHAIN_IDS[i];
    if (r.status === "fulfilled") return r.value;
    return {
      chainId,
      chainName: getChain(chainId).name,
      balance: 0n,
      balanceUsdc: "0.0",
      hasEnough: false,
    };
  });

  return balances.sort((a, b) => (b.balance > a.balance ? 1 : -1));
}

// ── 2. Quote Fetching ──────────────────────────────────────────────────────────

export async function getQuoteForChain(
  chainId: SupportedEvmChainId,
  amountMinor: bigint,
  agentMint: string
): Promise<ChainQuoteResult> {
  const chain = getChain(chainId);
  try {
    const quote = await getQuote({
      fromChainId: chainId,
      fromToken: chain.usdc as Address,
      fromAmount: amountMinor,
      agentMint,
    });
    const feeMinor = BigInt(Math.round(quote.bridgeFeeUsd * 1_000_000));
    const netMinor = quote.toAmountUsdc;
    return {
      chainId,
      chainName: chain.name,
      available: true,
      quote,
      estimatedFeeUsdc: formatUsdc(feeMinor),
      netAmountUsdc: formatUsdc(netMinor),
    };
  } catch (err) {
    return {
      chainId,
      chainName: chain.name,
      available: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function getAllQuotes(
  amountMinor: bigint,
  agentMint: string
): Promise<ChainQuoteResult[]> {
  return Promise.all(
    SUPPORTED_CHAIN_IDS.map((id: SupportedEvmChainId) =>
      getQuoteForChain(id, amountMinor, agentMint)
    )
  );
}

// ── 3. Optimal Chain Selection ─────────────────────────────────────────────────

export function selectOptimalChain(
  quotes: ChainQuoteResult[],
  balances: ChainBalance[]
): { quote: ChainQuoteResult & { available: true }; balance: ChainBalance } | null {
  const balanceMap = new Map(balances.map((b) => [b.chainId, b]));

  const candidates = quotes
    .filter((q): q is ChainQuoteResult & { available: true } => q.available)
    .filter((q) => balanceMap.get(q.chainId)?.hasEnough === true)
    .sort((a, b) => {
      // Sort by estimatedFeeUsdc ascending (string comparison works because they're zero-padded floats)
      const fa = parseFloat(a.estimatedFeeUsdc);
      const fb = parseFloat(b.estimatedFeeUsdc);
      return fa - fb;
    });

  if (candidates.length === 0) return null;
  const best = candidates[0];
  return { quote: best, balance: balanceMap.get(best.chainId)! };
}

function printRankingTable(quotes: ChainQuoteResult[], balances: ChainBalance[]) {
  const balanceMap = new Map(balances.map((b) => [b.chainId, b]));
  const pad = (s: string, n: number) => s.padEnd(n);

  console.log(
    `\n${pad("Chain", 16)}${pad("Balance", 12)}${pad("Fee", 9)}${pad("Net", 10)}Available`
  );
  console.log("-".repeat(55));

  for (const q of quotes) {
    const bal = balanceMap.get(q.chainId);
    const balStr = bal ? `${bal.balanceUsdc} USDC` : "—";
    const canPay = bal?.hasEnough ?? false;
    if (q.available) {
      const mark = canPay ? "✓" : "✗ (insufficient balance)";
      console.log(
        `${pad(q.chainName, 16)}${pad(balStr, 12)}${pad(q.estimatedFeeUsdc, 9)}${pad(q.netAmountUsdc, 10)}${mark}`
      );
    } else {
      console.log(
        `${pad(q.chainName, 16)}${pad(balStr, 12)}${pad("—", 9)}${pad("—", 10)}✗ (quote unavailable)`
      );
    }
  }
  console.log();
}

// ── 4. Transaction Building ────────────────────────────────────────────────────

export async function buildPaymentTxs(
  quote: CrossChainQuote,
  walletAddress: Address
): Promise<{ approval: TxParams | null; bridge: TxParams }> {
  const agentMint = requireEnv("AGENT_MINT");
  const destSolanaWallet = requireEnv("DEST_SOLANA_WALLET");
  const memo = requireEnv("MEMO");

  const txs = await buildEvmPaymentTransaction({
    quote,
    agentMint,
    destinationSolanaWallet: destSolanaWallet,
    memo,
    sender: walletAddress,
  });

  return {
    approval: txs.approval
      ? { to: txs.approval.to, data: txs.approval.data, value: txs.approval.value }
      : null,
    bridge: { to: txs.bridge.to, data: txs.bridge.data, value: txs.bridge.value },
  };
}

// ── 5. Transaction Execution ───────────────────────────────────────────────────

export async function executePayment(
  chainId: SupportedEvmChainId,
  txs: { approval: TxParams | null; bridge: TxParams }
): Promise<{ approvalHash: string | null; bridgeHash: string; chainId: SupportedEvmChainId; chainName: string }> {
  const chain = getChain(chainId);
  const walletClient = buildWalletClient(chainId);
  const publicClient = buildPublicClient(chainId);
  const account = walletClient.account!;

  console.log(`[router] selected chain: ${chain.name} (${chainId})`);

  let approvalHash: string | null = null;

  if (txs.approval) {
    const hash = await walletClient.sendTransaction({
      account,
      chain: walletClient.chain,
      to: txs.approval.to,
      data: txs.approval.data,
      value: txs.approval.value,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    approvalHash = hash;
    console.log(`[router] approval tx: ${hash} (confirmed)`);
  }

  const bridgeHash = await walletClient.sendTransaction({
    account,
    chain: walletClient.chain,
    to: txs.bridge.to,
    data: txs.bridge.data,
    value: txs.bridge.value,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: bridgeHash });
  console.log(`[router] bridge tx:   ${bridgeHash} (confirmed)`);

  // Extract depositId from logs — the bridge emits an event with the MoonPay order ID
  const depositId = extractDepositId(receipt.logs);
  if (depositId) {
    console.log(`[router] depositId:   ${depositId}`);
  }

  return { approvalHash, bridgeHash, chainId, chainName: chain.name };
}

function extractDepositId(logs: readonly { topics: readonly string[]; data: string }[]): string | null {
  // MoonPay bridge emits a Transfer or DepositInitiated event; the depositId
  // is typically returned from the status API after the tx confirms, so we
  // surface the bridge tx hash as the tracking handle if no explicit ID exists.
  for (const log of logs) {
    if (log.topics.length > 0) {
      // Return the first non-zero topic as a best-effort deposit handle
      const id = log.topics.find((t) => t !== "0x" + "0".repeat(64));
      if (id) return id;
    }
  }
  return null;
}

// ── 6. Status Polling ─────────────────────────────────────────────────────────

export async function waitForSolanaArrival(
  depositId: string,
  timeoutMs = 120_000
): Promise<void> {
  const pollInterval = 5_000;
  const start = Date.now();

  while (true) {
    const elapsed = Math.floor((Date.now() - start) / 1000);
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timeout waiting for depositId=${depositId} after ${elapsed}s`);
    }

    let status: string;
    try {
      const res = await fetch(`${PUMP_CROSSCHAIN_API}/deposit?depositId=${depositId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: { status: string; error?: string } = await res.json();
      status = data.status;
      if (data.error || status === "failed") {
        throw new Error(`Bridge failed: ${data.error ?? status}`);
      }
    } catch (err) {
      console.error(`[status] poll error: ${err}`);
      await sleep(pollInterval);
      continue;
    }

    console.log(`[status] depositId=${depositId} status=${status} elapsed=${elapsed}s`);

    if (status === "arrived_on_solana") return;

    await sleep(pollInterval);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── 7 & 8. CLI ────────────────────────────────────────────────────────────────

async function cmdBalances() {
  const privateKey = requireEnv("EVM_PRIVATE_KEY");
  const amountUsdc = requireEnv("AMOUNT_USDC");
  const amountMinor = getAmountMinor(amountUsdc);
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const address = account.address;

  console.log(`\nFetching USDC balances for ${address}...`);
  const balances = await getAllUsdcBalances(address, amountMinor);

  console.log(`\n${"Chain".padEnd(20)}${"Balance".padEnd(15)}Sufficient`);
  console.log("-".repeat(42));
  for (const b of balances) {
    console.log(
      `${b.chainName.padEnd(20)}${(b.balanceUsdc + " USDC").padEnd(15)}${b.hasEnough ? "✓" : "✗"}`
    );
  }
}

async function cmdQuotes() {
  const agentMint = requireEnv("AGENT_MINT");
  const amountUsdc = requireEnv("AMOUNT_USDC");
  const amountMinor = getAmountMinor(amountUsdc);

  console.log(`\nFetching quotes for ${amountUsdc} USDC...`);
  const quotes = await getAllQuotes(amountMinor, agentMint);

  console.log(`\n${"Chain".padEnd(16)}${"Fee (USDC)".padEnd(12)}${"Net".padEnd(10)}Status`);
  console.log("-".repeat(50));
  for (const q of quotes) {
    if (q.available) {
      console.log(`${q.chainName.padEnd(16)}${q.estimatedFeeUsdc.padEnd(12)}${q.netAmountUsdc.padEnd(10)}available`);
    } else {
      console.log(`${q.chainName.padEnd(16)}${"—".padEnd(12)}${"—".padEnd(10)}unavailable`);
    }
  }
}

async function cmdPay(opts: { chainId?: SupportedEvmChainId; dryRun: boolean }) {
  const privateKey = requireEnv("EVM_PRIVATE_KEY");
  const agentMint = requireEnv("AGENT_MINT");
  const amountUsdc = requireEnv("AMOUNT_USDC");
  const amountMinor = getAmountMinor(amountUsdc);
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const address = account.address;

  console.log(`\nPreparing ${amountUsdc} USDC payment from ${address}...`);

  // Fetch balances and quotes concurrently
  const [balances, allQuotes] = await Promise.all([
    getAllUsdcBalances(address, amountMinor),
    getAllQuotes(amountMinor, agentMint),
  ]);

  // Order quotes to match balances table display (by balance desc)
  const quotesSorted = [...allQuotes].sort((a, b) => {
    const ba = balances.find((x) => x.chainId === a.chainId)?.balance ?? 0n;
    const bb = balances.find((x) => x.chainId === b.chainId)?.balance ?? 0n;
    return bb > ba ? 1 : -1;
  });

  printRankingTable(quotesSorted, balances);

  let selectedQuote: ChainQuoteResult & { available: true };

  if (opts.chainId !== undefined) {
    const forced = allQuotes.find((q) => q.chainId === opts.chainId);
    if (!forced || !forced.available) {
      throw new Error(`Quote unavailable for chain ${opts.chainId}`);
    }
    selectedQuote = forced as ChainQuoteResult & { available: true };
    console.log(`[router] forced chain: ${selectedQuote.chainName} (${opts.chainId})`);
  } else {
    const best = selectOptimalChain(allQuotes, balances);
    if (!best) throw new Error("No chain has sufficient USDC balance with an available quote");
    selectedQuote = best.quote;
  }

  console.log(
    `[router] optimal chain: ${selectedQuote.chainName} (${selectedQuote.chainId}), fee: ${selectedQuote.estimatedFeeUsdc} USDC, net: ${selectedQuote.netAmountUsdc} USDC`
  );

  if (opts.dryRun) {
    console.log("[router] --dry-run: no transactions submitted.");
    return;
  }

  const txs = await buildPaymentTxs(selectedQuote.quote, address);
  const result = await executePayment(selectedQuote.chainId, txs);

  console.log(`\n[router] payment submitted on ${result.chainName}`);
  if (result.approvalHash) console.log(`  approval: ${result.approvalHash}`);
  console.log(`  bridge:   ${result.bridgeHash}`);
}

async function cmdStatus(depositId: string) {
  console.log(`[status] polling depositId=${depositId}...`);
  await waitForSolanaArrival(depositId);
  console.log("[status] funds arrived on Solana!");
}

// ── Entry point ────────────────────────────────────────────────────────────────

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      chain: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  const command = positionals[0];

  switch (command) {
    case "balances":
      await cmdBalances();
      break;

    case "quotes":
      await cmdQuotes();
      break;

    case "pay": {
      let chainId: SupportedEvmChainId | undefined;
      if (values.chain) {
        const id: number = Number(values.chain);
        const supported: number[] = [1, 8453, 42161, 137, 56, 43114];
        if (!supported.includes(id)) {
          throw new Error(`Unknown chain ID: ${values.chain}. Supported: 1, 8453, 42161, 137, 56, 43114`);
        }
        chainId = id as SupportedEvmChainId;
      }
      await cmdPay({ chainId, dryRun: values["dry-run"] ?? false });
      break;
    }

    case "status": {
      const depositId = positionals[1];
      if (!depositId) throw new Error("Usage: router.ts status <depositId>");
      await cmdStatus(depositId);
      break;
    }

    default:
      console.log(`Usage:
  router.ts balances                Show USDC balances on all 6 chains
  router.ts quotes                  Show bridge quotes for all chains
  router.ts pay                     Execute optimal payment
  router.ts pay --chain=8453        Force a specific chain
  router.ts pay --dry-run           Simulate without submitting transactions
  router.ts status <depositId>      Poll a bridge deposit`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
