// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
// All rights reserved.

import {
  Connection,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
// @ts-ignore — bs58 types are available in the agent's own node_modules (v6)
import bs58 from "bs58";
import {
  PumpAgent,
  PumpAgentOffline,
  USDC_MINT,
  CurrencyNotSupportedError,
} from "@nirholas/agent-payments-sdk/solana";

// ---------------------------------------------------------------------------
// Config from environment
// ---------------------------------------------------------------------------

const RPC_URL = process.env.SOLANA_RPC_URL;
const PRIVATE_KEY_RAW = process.env.SOLANA_PRIVATE_KEY;
const AGENT_MINT_RAW = process.env.AGENT_MINT;

if (!RPC_URL) throw new Error("SOLANA_RPC_URL is required");
if (!PRIVATE_KEY_RAW) throw new Error("SOLANA_PRIVATE_KEY is required");
if (!AGENT_MINT_RAW) throw new Error("AGENT_MINT is required");

function loadKeypair(raw: string): Keypair {
  if (raw.trimStart().startsWith("[")) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  }
  return Keypair.fromSecretKey(bs58.decode(raw));
}

const authority = loadKeypair(PRIVATE_KEY_RAW);
const agentMint = new PublicKey(AGENT_MINT_RAW);
const connection = new Connection(RPC_URL, "confirmed");
const agent = new PumpAgent(agentMint, "mainnet", connection);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Invoice {
  memo: number;
  startTime: number;
  endTime: number;
  amount: number;
  agentMint: string;
  currencyMint: string;
}

interface PollResult {
  paid: boolean;
  checkedAt: Date;
  elapsed: number;
}

interface DistributeResult {
  signature: string;
  paymentVaultBefore: bigint;
  buybackVaultAfter: bigint;
  withdrawVaultAfter: bigint;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function usdcStr(minor: bigint): string {
  const whole = minor / 1_000_000n;
  const frac = (minor % 1_000_000n).toString().padStart(6, "0");
  return `${whole}.${frac}`;
}

// ---------------------------------------------------------------------------
// 1. Invoice Generation
// ---------------------------------------------------------------------------

function generateInvoice(amountUsdc: number, windowSeconds = 300): Invoice {
  const whole = Math.floor(amountUsdc);
  const frac = Math.round((amountUsdc - whole) * 1_000_000);
  const amountMinor = whole * 1_000_000 + frac;
  const memo = Number(String(Date.now()).padStart(16, "0"));
  const startTime = Math.floor(Date.now() / 1000);
  const endTime = startTime + windowSeconds;
  return {
    memo,
    startTime,
    endTime,
    amount: amountMinor,
    agentMint: agentMint.toBase58(),
    currencyMint: USDC_MINT.toBase58(),
  };
}

// ---------------------------------------------------------------------------
// 2. Invoice Polling
// ---------------------------------------------------------------------------

async function pollInvoicePayment(
  invoice: Invoice,
  payer: PublicKey,
  timeoutMs = 120_000,
): Promise<PollResult> {
  const start = Date.now();

  while (true) {
    const elapsed = Date.now() - start;
    if (elapsed >= timeoutMs) {
      return { paid: false, checkedAt: new Date(), elapsed };
    }

    const paid = await agent.validateInvoicePayment({
      user: payer,
      currencyMint: new PublicKey(invoice.currencyMint),
      amount: invoice.amount,
      memo: invoice.memo,
      startTime: invoice.startTime,
      endTime: invoice.endTime,
    });

    if (paid) {
      return { paid: true, checkedAt: new Date(), elapsed: Date.now() - start };
    }

    const remaining = timeoutMs - (Date.now() - start);
    if (remaining <= 0) {
      return { paid: false, checkedAt: new Date(), elapsed: Date.now() - start };
    }
    await new Promise((r) => setTimeout(r, Math.min(5_000, remaining)));
  }
}

// ---------------------------------------------------------------------------
// 3. Payment Acceptance Transaction Builder
// ---------------------------------------------------------------------------

async function buildAcceptPaymentTx(
  invoice: Invoice,
  payerPublicKey: PublicKey,
): Promise<string> {
  const offline = PumpAgentOffline.load(new PublicKey(invoice.agentMint));
  const instructions = await offline.buildAcceptPaymentInstructions({
    user: payerPublicKey,
    currencyMint: new PublicKey(invoice.currencyMint),
    amount: invoice.amount,
    memo: invoice.memo,
    startTime: invoice.startTime,
    endTime: invoice.endTime,
    computeUnitPrice: 1000,
  });

  const { blockhash } = await connection.getLatestBlockhash();
  const tx = new Transaction({
    recentBlockhash: blockhash,
    feePayer: payerPublicKey,
  });
  tx.add(...instructions);

  return tx.serialize({ requireAllSignatures: false }).toString("base64");
}

// ---------------------------------------------------------------------------
// 4. Distribution Trigger
// ---------------------------------------------------------------------------

async function triggerDistribution(): Promise<DistributeResult | null> {
  const balances = await agent.getBalances(USDC_MINT);
  const paymentVaultBefore = balances.paymentVault.balance;

  if (paymentVaultBefore === 0n) {
    console.log("Payment vault is empty — nothing to distribute.");
    return null;
  }

  let instructions: TransactionInstruction[];
  try {
    instructions = await agent.distributePayments({
      user: authority.publicKey,
      currencyMint: USDC_MINT,
    });
  } catch (err) {
    if (err instanceof CurrencyNotSupportedError) {
      const supported = await agent.getSupportedCurrencies();
      console.error("Currency not supported. Supported currencies:");
      for (const mint of supported) {
        console.error(`  ${mint.toBase58()}`);
      }
      process.exit(1);
    }
    throw err;
  }

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash();
  const tx = new Transaction({
    recentBlockhash: blockhash,
    feePayer: authority.publicKey,
  });
  tx.add(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }),
    ...instructions,
  );
  tx.sign(authority);

  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
  });
  await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    "confirmed",
  );

  const afterBalances = await agent.getBalances(USDC_MINT);

  return {
    signature,
    paymentVaultBefore,
    buybackVaultAfter: afterBalances.buybackVault.balance,
    withdrawVaultAfter: afterBalances.withdrawVault.balance,
  };
}

// ---------------------------------------------------------------------------
// 5. Status
// ---------------------------------------------------------------------------

async function printStatus(): Promise<void> {
  const [balances, stats] = await Promise.all([
    agent.getBalances(USDC_MINT),
    agent.getPaymentStats(USDC_MINT).catch(() => null),
  ]);

  console.log(`Agent:           ${agentMint.toBase58()}`);
  console.log(`Payment vault:   ${usdcStr(balances.paymentVault.balance)} USDC`);
  console.log(`Buyback vault:   ${usdcStr(balances.buybackVault.balance)} USDC`);
  console.log(`Withdraw vault:  ${usdcStr(balances.withdrawVault.balance)} USDC`);

  if (stats) {
    const totalInvoices = BigInt(stats.totalInvoicePaymentsMade.toString());
    const totalBuyback = BigInt(stats.totalBuyback.toString());
    console.log(`Total invoices:  ${totalInvoices}`);
    console.log(`Total bought:    ${usdcStr(totalBuyback)} USDC`);
  } else {
    console.log(`Total invoices:  0`);
    console.log(`Total bought:    0.000000 USDC`);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;

  switch (command) {
    case "generate": {
      const amountUsdc = parseFloat(args[0] ?? "0");
      if (!amountUsdc || amountUsdc <= 0) {
        console.error("Usage: node agent.js generate <amount_usdc>");
        process.exit(1);
      }
      const invoice = generateInvoice(amountUsdc);
      console.log(JSON.stringify(invoice, null, 2));
      break;
    }

    case "poll": {
      if (args.length < 4) {
        console.error(
          "Usage: node agent.js poll <memo> <startTime> <endTime> <amount_usdc> [<payer>]",
        );
        process.exit(1);
      }
      const [memoStr, startTimeStr, endTimeStr, amountUsdcStr, payerStr] = args;
      const invoice: Invoice = {
        memo: Number(memoStr),
        startTime: Number(startTimeStr),
        endTime: Number(endTimeStr),
        amount: Math.round(parseFloat(amountUsdcStr) * 1_000_000),
        agentMint: agentMint.toBase58(),
        currencyMint: USDC_MINT.toBase58(),
      };
      const payer = payerStr
        ? new PublicKey(payerStr)
        : authority.publicKey;

      if (!payerStr) {
        console.warn(
          "Warning: no <payer> provided — using authority key. " +
            "Pass the payer public key for accurate validation.",
        );
      }

      const nowEpoch = Math.floor(Date.now() / 1000);
      if (nowEpoch > invoice.endTime) {
        console.error("Invoice has expired (endTime is in the past).");
        process.exit(1);
      }

      const timeoutMs = (invoice.endTime - nowEpoch) * 1_000;
      console.log(
        `Polling for payment (timeout ${Math.round(timeoutMs / 1000)}s)…`,
      );

      const result = await pollInvoicePayment(invoice, payer, timeoutMs);
      console.log(JSON.stringify(result, null, 2));
      if (!result.paid) process.exit(1);
      break;
    }

    case "accept-tx": {
      if (args.length < 2) {
        console.error(
          "Usage: node agent.js accept-tx <invoice_json> <payer_pubkey>",
        );
        process.exit(1);
      }
      const invoice: Invoice = JSON.parse(args[0]);
      const payerPublicKey = new PublicKey(args[1]);
      const base64Tx = await buildAcceptPaymentTx(invoice, payerPublicKey);
      console.log(base64Tx);
      break;
    }

    case "distribute": {
      const result = await triggerDistribution();
      if (result) {
        console.log(
          `Distributed — signature: ${result.signature}`,
        );
        console.log(
          `https://solscan.io/tx/${result.signature}`,
        );
        console.log(
          `Payment vault before: ${usdcStr(result.paymentVaultBefore)} USDC`,
        );
        console.log(
          `Buyback vault after:  ${usdcStr(result.buybackVaultAfter)} USDC`,
        );
        console.log(
          `Withdraw vault after: ${usdcStr(result.withdrawVaultAfter)} USDC`,
        );
      }
      break;
    }

    case "status": {
      await printStatus();
      break;
    }

    default: {
      console.error(
        "Commands: generate <amount_usdc> | poll <memo> <startTime> <endTime> <amount_usdc> [<payer>] | accept-tx <invoice_json> <payer_pubkey> | distribute | status",
      );
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error((err as Error).message);
  console.error((err as Error).stack);
  process.exit(1);
});
