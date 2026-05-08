#!/usr/bin/env node
/**
 * EVM→Solana USDC Bridge Payment Agent
 *
 * Executes a complete EVM→Solana USDC cross-chain payment end-to-end:
 *   1. Fetch a bridge quote from the Pump.fun cross-chain API
 *   2. Build EVM approval + bridge transactions via buildEvmPaymentTransaction
 *   3. Submit them with a viem WalletClient
 *   4. Poll PUMP_CROSSCHAIN_API until a depositId is assigned
 *   5. Poll getPaymentStatus until USDC arrives on Solana
 *   6. Verify the PumpAgent payment vault balance increased
 *
 * Commands:
 *   node agent.ts quote                  Show bridge quote only
 *   node agent.ts send                   Execute full EVM→Solana bridge payment
 *   node agent.ts status <depositId>     Poll an existing deposit
 *
 * Environment variables:
 *   EVM_PRIVATE_KEY        EVM private key (hex, 0x-prefixed)
 *   EVM_CHAIN_ID           Source chain ID (default: 8453 = Base)
 *   EVM_RPC_URL            RPC endpoint for the source chain
 *   SOLANA_RPC_URL         Solana mainnet RPC endpoint
 *   AGENT_MINT             Pump agent token mint (base58)
 *   DEST_SOLANA_WALLET     Solana wallet to credit with USDC
 *   MEMO                   Invoice memo string (16-char numeric)
 *   AMOUNT_USDC            Decimal USDC amount to bridge (e.g. "1.0")
 */

import { parseArgs } from "node:util";
import {
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  http,
  type Address,
  type Chain,
  type Hash,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Connection, PublicKey } from "@solana/web3.js";

import { getChain } from "../../../../src/chains.js";
import { getQuote } from "../../../../src/evm/quote.js";
import { buildEvmPaymentTransaction } from "../../../../src/evm/transaction.js";
import { getPaymentStatus } from "../../../../src/evm/validate.js";
import {
  ERC20_ABI,
  PUMP_CROSSCHAIN_API,
  USDC_SOLANA_MINT,
} from "../../../../src/constants.js";
import type { CrossChainQuote, SupportedEvmChainId } from "../../../../src/types.js";
import { PumpAgent } from "../../../../src/solana/PumpAgent.js";

// ── Utilities ─────────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function getEnvInt(name: string, defaultVal: number): number {
  const v = process.env[name];
  return v ? parseInt(v, 10) : defaultVal;
}

function formatUsdc(minor: bigint): string {
  const s = minor.toString().padStart(7, "0");
  return `${s.slice(0, -6)}.${s.slice(-6)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Viem client setup ─────────────────────────────────────────────────────────

function buildClients(chainId: SupportedEvmChainId, rpcUrl: string) {
  const cfg = getChain(chainId);
  const chain: Chain = {
    id: cfg.id,
    name: cfg.name,
    nativeCurrency: cfg.nativeCurrency,
    rpcUrls: { default: { http: [rpcUrl] } },
    blockExplorers: { default: { name: cfg.name, url: cfg.blockExplorer } },
  };
  const privateKey = requireEnv("EVM_PRIVATE_KEY");
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });
  return { publicClient, walletClient, account };
}

// ── 1. Quote Fetch ────────────────────────────────────────────────────────────

async function fetchQuote(
  chainId: SupportedEvmChainId,
  amountUsdc: string,
  agentMint: string
): Promise<CrossChainQuote> {
  const chain = getChain(chainId);
  const fromAmount = BigInt(Math.round(parseFloat(amountUsdc) * 1_000_000));
  const fromToken = chain.usdc as Address;

  const quote = await getQuote({
    fromChainId: chainId,
    fromToken,
    fromAmount,
    agentMint,
  });

  const feeMinor = BigInt(Math.round(quote.bridgeFeeUsd * 1_000_000));

  console.log(`[quote] chainId=${chainId} (${chain.name})`);
  console.log(`[quote] fromToken=${fromToken}  amount=${formatUsdc(fromAmount)} USDC`);
  console.log(`[quote] quoteId=${quote.quoteId}`);
  console.log(`[quote] estimatedFee=${formatUsdc(feeMinor)} USDC`);
  console.log(`[quote] netReceived=${formatUsdc(quote.toAmountUsdc)} USDC`);
  console.log(`[quote] expires=${new Date(quote.expiresAt * 1000).toISOString()}`);

  return quote;
}

// ── 2. Transaction Building ───────────────────────────────────────────────────

async function buildTxs(
  quote: CrossChainQuote,
  walletAddress: Address,
  agentMint: string,
  destSolanaWallet: string,
  memo: string
) {
  const txs = await buildEvmPaymentTransaction({
    quote,
    agentMint,
    destinationSolanaWallet: destSolanaWallet,
    memo,
    sender: walletAddress,
  });

  if (txs.approval) {
    console.log("[build] approval tx required (ERC-20 allowance needed)");
  } else {
    console.log("[build] no approval required");
  }

  return txs;
}

// ── 3. Approval Transaction ───────────────────────────────────────────────────

async function sendApprovalIfNeeded(
  approval: { to: Address; data: `0x${string}`; value: bigint },
  quote: CrossChainQuote,
  publicClient: ReturnType<typeof createPublicClient>,
  walletClient: ReturnType<typeof createWalletClient>,
  account: ReturnType<typeof privateKeyToAccount>
): Promise<string> {
  // Decode the bridge spender address from approve(spender, amount) calldata
  const decoded = decodeFunctionData({ abi: ERC20_ABI, data: approval.data });
  const spender = decoded.args[0] as Address;

  const allowanceBefore = (await publicClient.readContract({
    address: approval.to,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [account.address, spender],
  })) as bigint;

  if (allowanceBefore >= quote.fromAmount) {
    console.log(
      `[approval] allowance sufficient (${formatUsdc(allowanceBefore)} USDC), skipping`
    );
    return "skipped";
  }

  const hash = await walletClient.sendTransaction({
    account,
    chain: walletClient.chain!,
    to: approval.to,
    data: approval.data,
    value: approval.value,
  });

  await publicClient.waitForTransactionReceipt({ hash });

  const allowanceAfter = (await publicClient.readContract({
    address: approval.to,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [account.address, spender],
  })) as bigint;

  console.log(
    `[approval] hash=${hash} allowance_before=${formatUsdc(allowanceBefore)} allowance_after=${formatUsdc(allowanceAfter)}`
  );

  return hash;
}

// ── 4. Bridge Transaction ─────────────────────────────────────────────────────

async function sendBridgeTx(
  bridge: { to: Address; data: `0x${string}`; value: bigint },
  publicClient: ReturnType<typeof createPublicClient>,
  walletClient: ReturnType<typeof createWalletClient>,
  account: ReturnType<typeof privateKeyToAccount>
): Promise<{ hash: Hash; receipt: Awaited<ReturnType<typeof publicClient.waitForTransactionReceipt>> }> {
  const estimatedGas = await publicClient.estimateGas({
    account: account.address,
    to: bridge.to,
    data: bridge.data,
    value: bridge.value,
  });

  const gas = (estimatedGas * 110n) / 100n;
  console.log(`[bridge] estimatedGas=${estimatedGas} gas=${gas} (+10% buffer)`);

  const hash = await walletClient.sendTransaction({
    account,
    chain: walletClient.chain!,
    to: bridge.to,
    data: bridge.data,
    value: bridge.value,
    gas,
  });

  console.log(`[bridge] submitted txHash=${hash}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
  console.log(`[bridge] confirmed block=${receipt.blockNumber} status=${receipt.status}`);

  return { hash, receipt };
}

// ── 5. Deposit Lookup ─────────────────────────────────────────────────────────

async function lookupDeposit(
  bridgeTxHash: Hash,
  chainId: SupportedEvmChainId
): Promise<{ depositId: string; amountUsdc: bigint }> {
  const timeoutMs = 60_000;
  const pollInterval = 5_000;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(
        `${PUMP_CROSSCHAIN_API}/deposit?txHash=${bridgeTxHash}&chainId=${chainId}`
      );
      if (res.ok) {
        const data = (await res.json()) as { depositId?: string; amountUsdc?: string };
        if (data.depositId) {
          console.log(`[deposit] found depositId=${data.depositId}`);
          return {
            depositId: data.depositId,
            amountUsdc: data.amountUsdc ? BigInt(data.amountUsdc) : 0n,
          };
        }
      }
    } catch {
      // Retry on transient network errors
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    console.log(`[deposit] waiting for txHash=${bridgeTxHash} elapsed=${elapsed}s`);
    await sleep(pollInterval);
  }

  throw new Error(
    `Deposit not found for txHash=${bridgeTxHash} after ${timeoutMs / 1000}s`
  );
}

// ── 6. Solana Arrival Polling ─────────────────────────────────────────────────

async function waitForSolanaArrival(
  depositId: string
): Promise<{ solanaSignature: string; status: string }> {
  const timeoutMs = 120_000;
  const pollInterval = 5_000;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const result = await getPaymentStatus(depositId);
    const elapsed = Math.floor((Date.now() - start) / 1000);

    console.log(`[bridge] depositId=${depositId} status=${result.status} elapsed=${elapsed}s`);

    if (result.status === "arrived_on_solana" && result.solanaSignature) {
      return { solanaSignature: result.solanaSignature, status: result.status };
    }

    if (result.status === "failed") {
      throw new Error(`Bridge payment failed: ${result.error ?? result.status}`);
    }

    await sleep(pollInterval);
  }

  throw new Error(`Payment ${depositId} did not arrive within ${timeoutMs / 1000}s`);
}

// ── 7. Vault Verification ─────────────────────────────────────────────────────

async function verifyVault(
  agentMint: string,
  solanaRpcUrl: string,
  solanaSignature: string
): Promise<bigint> {
  const connection = new Connection(solanaRpcUrl, "confirmed");
  const agent = new PumpAgent(new PublicKey(agentMint), "mainnet", connection);
  const usdcMint = new PublicKey(USDC_SOLANA_MINT);

  const balances = await agent.getBalances(usdcMint);

  if (balances.paymentVault.balance === 0n) {
    console.warn("[verify] warning: paymentVault balance is 0 (may still be settling)");
  } else {
    console.log(
      `[verify] paymentVault balance: ${formatUsdc(balances.paymentVault.balance)} USDC ✓`
    );
  }

  console.log(`[verify] solana tx: https://solscan.io/tx/${solanaSignature}`);
  return balances.paymentVault.balance;
}

// ── CLI commands ──────────────────────────────────────────────────────────────

async function cmdQuote() {
  const chainId = getEnvInt("EVM_CHAIN_ID", 8453) as SupportedEvmChainId;
  const agentMint = requireEnv("AGENT_MINT");
  const amountUsdc = requireEnv("AMOUNT_USDC");

  await fetchQuote(chainId, amountUsdc, agentMint);
}

async function cmdSend() {
  const start = Date.now();
  const chainId = getEnvInt("EVM_CHAIN_ID", 8453) as SupportedEvmChainId;
  const chain = getChain(chainId);
  const rpcUrl = process.env.EVM_RPC_URL ?? chain.rpcUrl;
  const agentMint = requireEnv("AGENT_MINT");
  const destSolanaWallet = requireEnv("DEST_SOLANA_WALLET");
  const memo = requireEnv("MEMO");
  const amountUsdc = requireEnv("AMOUNT_USDC");
  const solanaRpcUrl = requireEnv("SOLANA_RPC_URL");

  const { publicClient, walletClient, account } = buildClients(chainId, rpcUrl);

  // 1. Quote
  console.log("\n── Fetching quote ──");
  const quote = await fetchQuote(chainId, amountUsdc, agentMint);

  // 2. Build transactions
  console.log("\n── Building transactions ──");
  const txs = await buildTxs(quote, account.address, agentMint, destSolanaWallet, memo);

  // 3. Approval (skip if allowance is sufficient)
  let approvalHash = "skipped";
  if (txs.approval) {
    console.log("\n── Sending approval ──");
    approvalHash = await sendApprovalIfNeeded(
      txs.approval,
      quote,
      publicClient,
      walletClient,
      account
    );
  }

  // 4. Bridge transaction
  console.log("\n── Sending bridge transaction ──");
  const { hash: bridgeHash } = await sendBridgeTx(
    txs.bridge,
    publicClient,
    walletClient,
    account
  );

  // 5. Deposit lookup
  console.log("\n── Looking up deposit ──");
  const { depositId } = await lookupDeposit(bridgeHash, chainId);

  // 6. Solana arrival
  console.log("\n── Waiting for Solana arrival ──");
  const { solanaSignature } = await waitForSolanaArrival(depositId);

  // 7. Vault verification
  console.log("\n── Verifying vault balance ──");
  const vaultBalance = await verifyVault(agentMint, solanaRpcUrl, solanaSignature);

  // 8. Summary
  const elapsed = Math.floor((Date.now() - start) / 1000);
  const feeMinor = BigInt(Math.round(quote.bridgeFeeUsd * 1_000_000));

  console.log(`
════════════════════════════════════════════
  EVM→Solana Bridge Payment Complete
════════════════════════════════════════════
  Source:    ${chain.name} (${chainId})
  Amount:    ${formatUsdc(quote.fromAmount)} USDC
  Fee:       ${formatUsdc(feeMinor)} USDC
  Net:       ${formatUsdc(quote.toAmountUsdc)} USDC
  Approval:  ${approvalHash}
  Bridge tx: ${bridgeHash}
  DepositId: ${depositId}
  Solana tx: ${solanaSignature}
  Vault bal: ${formatUsdc(vaultBalance)} USDC
  Total time: ${elapsed}s
════════════════════════════════════════════`);
}

async function cmdStatus(depositId: string) {
  console.log(`[status] polling depositId=${depositId}...`);
  const { solanaSignature, status } = await waitForSolanaArrival(depositId);
  console.log(`[status] ${status}`);
  console.log(`[status] solana tx: https://solscan.io/tx/${solanaSignature}`);
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  const { positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {},
    allowPositionals: true,
  });

  const command = positionals[0];

  switch (command) {
    case "quote":
      await cmdQuote();
      break;

    case "send":
      await cmdSend();
      break;

    case "status": {
      const depositId = positionals[1];
      if (!depositId) throw new Error("Usage: agent.ts status <depositId>");
      await cmdStatus(depositId);
      break;
    }

    default:
      console.log(`Usage:
  node agent.ts quote                  Fetch and display bridge quote
  node agent.ts send                   Execute full EVM→Solana bridge payment
  node agent.ts status <depositId>     Poll an existing deposit until Solana arrival`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
