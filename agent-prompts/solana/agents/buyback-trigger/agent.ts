// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
// All rights reserved.

import fs from "node:fs";
import readline from "node:readline";
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  AddressLookupTableAccount,
  AccountMeta,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import bs58 from "bs58";
import {
  PumpAgent,
  USDC_MINT,
  getBuybackAuthorityPDA,
} from "@nirholas/agent-payments-sdk/solana";

// ── Config ──────────────────────────────────────────────────────────────────
const RPC_URL = process.env.SOLANA_RPC_URL;
const BUYBACK_AUTHORITY_KEY_RAW = process.env.BUYBACK_AUTHORITY_KEY;
const AGENT_MINT_RAW = process.env.AGENT_MINT;
const THRESHOLD_USDC = parseFloat(process.env.BUYBACK_THRESHOLD_USDC ?? "5.0");
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? "30000", 10);
const SLIPPAGE_BPS = parseInt(process.env.SLIPPAGE_BPS ?? "100", 10);
const AUTO_MODE = process.argv.includes("--auto");
const LOG_FILE = "buyback-log.jsonl";

const JUPITER_PROGRAM_ID = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QDFwhXzz");
const JUPITER_API_BASE = "https://quote-api.jup.ag/v6";
const USDC_DECIMALS = 6;

// ── Startup validation ───────────────────────────────────────────────────────
if (!RPC_URL) throw new Error("SOLANA_RPC_URL is required");
if (!BUYBACK_AUTHORITY_KEY_RAW) throw new Error("BUYBACK_AUTHORITY_KEY is required");
if (!AGENT_MINT_RAW) throw new Error("AGENT_MINT is required");

// ── Keypair parsing (base58 or JSON uint8 array) ─────────────────────────────
function parseKeypair(raw: string): Keypair {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(trimmed)));
  }
  return Keypair.fromSecretKey(bs58.decode(trimmed));
}

// ── Formatting helper ────────────────────────────────────────────────────────
function usdcStr(minor: bigint): string {
  const whole = minor / 1_000_000n;
  const frac = (minor % 1_000_000n).toString().padStart(6, "0");
  return `${whole}.${frac}`;
}

// ── Infra ────────────────────────────────────────────────────────────────────
const connection = new Connection(RPC_URL!, "confirmed");
const authorityKeypair = parseKeypair(BUYBACK_AUTHORITY_KEY_RAW!);
const agentMint = new PublicKey(AGENT_MINT_RAW!);
const thresholdMinor = BigInt(Math.round(THRESHOLD_USDC * 10 ** USDC_DECIMALS));
const [buybackAuthorityPda] = getBuybackAuthorityPDA(agentMint);
const agent = new PumpAgent(agentMint, "mainnet", connection);

// ── Jupiter API types ────────────────────────────────────────────────────────
interface JupiterQuote {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  priceImpactPct: string;
  [key: string]: unknown;
}

interface JupiterAccountMeta {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}

interface JupiterInstruction {
  programId: string;
  accounts: JupiterAccountMeta[];
  data: string; // base64-encoded
}

interface JupiterSwapInstructionsResponse {
  swapInstruction: JupiterInstruction;
  addressLookupTableAddresses: string[];
  [key: string]: unknown;
}

// ── Step 1: Vault Balance Check ──────────────────────────────────────────────
async function checkBuybackVault(): Promise<{
  balance: bigint;
  balanceUsdc: string;
  aboveThreshold: boolean;
}> {
  const balances = await agent.getBalances(USDC_MINT);
  const balance = balances.buybackVault.balance;
  const balanceUsdc = usdcStr(balance);
  const aboveThreshold = balance >= thresholdMinor;
  console.log(
    `[buyback] vault=${balanceUsdc} USDC  threshold=${THRESHOLD_USDC} USDC  above=${aboveThreshold}`,
  );
  return { balance, balanceUsdc, aboveThreshold };
}

// ── Step 2: Jupiter Quote ────────────────────────────────────────────────────
async function fetchJupiterQuote(inputAmountUsdc: bigint): Promise<JupiterQuote> {
  const url =
    `${JUPITER_API_BASE}/quote` +
    `?inputMint=${USDC_MINT.toBase58()}` +
    `&outputMint=${agentMint.toBase58()}` +
    `&amount=${inputAmountUsdc.toString()}` +
    `&slippageBps=${SLIPPAGE_BPS}` +
    `&swapMode=ExactIn`;

  const resp = await fetch(url);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Jupiter quote failed ${resp.status}: ${text}`);
  }
  const quote = (await resp.json()) as JupiterQuote;

  const inUsdc = usdcStr(BigInt(quote.inAmount));
  const priceImpact = parseFloat(quote.priceImpactPct).toFixed(4);
  const shortMint = agentMint.toBase58().slice(0, 8) + "…";
  console.log(
    `[jupiter] in=${inUsdc} USDC  out=${quote.outAmount} ${shortMint}  price_impact=${priceImpact}%`,
  );
  return quote;
}

// ── Step 3: Jupiter Swap Instructions ────────────────────────────────────────
async function fetchJupiterSwapInstructions(
  quote: JupiterQuote,
  userPublicKey: string,
): Promise<JupiterSwapInstructionsResponse> {
  const resp = await fetch(`${JUPITER_API_BASE}/swap-instructions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey,
      wrapAndUnwrapSol: false,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 1000,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Jupiter swap-instructions failed ${resp.status}: ${text}`);
  }
  const data = (await resp.json()) as JupiterSwapInstructionsResponse;
  if (!data.swapInstruction) {
    throw new Error("Jupiter swap-instructions response is missing swapInstruction");
  }
  return data;
}

// ── Step 4: ALT Resolution ───────────────────────────────────────────────────
async function resolveAddressLookupTables(
  altAddresses: string[],
): Promise<AddressLookupTableAccount[]> {
  const results = await Promise.all(
    altAddresses.map(async (addr) => {
      const result = await connection.getAddressLookupTable(new PublicKey(addr));
      if (!result.value) throw new Error(`Address lookup table not found: ${addr}`);
      return result.value;
    }),
  );
  return results;
}

// ── Step 5: Buyback Transaction Construction ─────────────────────────────────
async function buildBuybackTransaction(
  quote: JupiterQuote,
  swapInstructionsResp: JupiterSwapInstructionsResponse,
  globalBuybackAuthority: PublicKey,
): Promise<{
  tx: VersionedTransaction;
  latestBlockhash: { blockhash: string; lastValidBlockHeight: number };
}> {
  const { swapInstruction, addressLookupTableAddresses } = swapInstructionsResp;

  // Resolve ALTs required by the Jupiter swap
  const alts = await resolveAddressLookupTables(addressLookupTableAddresses);

  // Map Jupiter accounts to AccountMeta for the program's remainingAccounts
  const remainingAccounts: AccountMeta[] = swapInstruction.accounts.map((acc) => ({
    pubkey: new PublicKey(acc.pubkey),
    isSigner: acc.isSigner,
    isWritable: acc.isWritable,
  }));

  // Raw swap instruction data passed to the program for CPI into Jupiter
  const swapInstructionData = Buffer.from(swapInstruction.data, "base64");

  // Build the on-chain buyback instruction
  const buybackIx = await agent.buybackTrigger({
    globalBuybackAuthority,
    currencyMint: USDC_MINT,
    swapProgramToInvoke: JUPITER_PROGRAM_ID,
    swapInstructionData,
    remainingAccounts,
    tokenProgramCurrency: TOKEN_PROGRAM_ID,
    tokenProgram: TOKEN_PROGRAM_ID,
  });

  const cuLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
  const cuPriceIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 });

  const latestBlockhash = await connection.getLatestBlockhash();

  const message = new TransactionMessage({
    payerKey: authorityKeypair.publicKey,
    recentBlockhash: latestBlockhash.blockhash,
    instructions: [cuLimitIx, cuPriceIx, buybackIx],
  }).compileToV0Message(alts);

  const tx = new VersionedTransaction(message);
  tx.sign([authorityKeypair]);

  return { tx, latestBlockhash };
}

// ── Step 6: Confirmation Gate ────────────────────────────────────────────────
function promptConfirmation(): Promise<void> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.once("line", () => {
      rl.close();
      resolve();
    });
  });
}

// ── Step 7: Buyback Log ──────────────────────────────────────────────────────
function appendLog(entry: {
  timestamp: string;
  vaultBalanceBefore: string;
  jupiterQuoteOut: string;
  signature: string;
  agentMintBurned: string;
}): void {
  fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n", "utf8");
}

// ── Step 8: Single Buyback Cycle ─────────────────────────────────────────────
let triggerInFlight = false;

async function runBuybackCycle(): Promise<void> {
  if (triggerInFlight) return;

  const { balance, balanceUsdc, aboveThreshold } = await checkBuybackVault();
  if (!aboveThreshold) return;

  triggerInFlight = true;
  try {
    // Global buyback authority comes from the on-chain protocol config
    const globalConfig = await agent.getGlobalConfig();
    const globalBuybackAuthority: PublicKey = globalConfig.buybackAuthority as PublicKey;

    if (!globalBuybackAuthority.equals(authorityKeypair.publicKey)) {
      console.warn(
        `[buyback] WARN: BUYBACK_AUTHORITY_KEY pubkey (${authorityKeypair.publicKey.toBase58()}) ` +
          `does not match GlobalConfig.buybackAuthority (${globalBuybackAuthority.toBase58()}) — ` +
          `transaction will likely fail`,
      );
    }

    // Fetch Jupiter quote for the full vault balance
    const quote = await fetchJupiterQuote(balance);

    // Fetch Jupiter swap instructions — user is the per-agent buyback PDA
    const swapInstructionsResp = await fetchJupiterSwapInstructions(
      quote,
      buybackAuthorityPda.toBase58(),
    );

    const inUsdc = usdcStr(BigInt(quote.inAmount));
    const details =
      `\n[buyback] ── Proposed buyback ──────────────────────────────\n` +
      `  Vault balance : ${balanceUsdc} USDC\n` +
      `  Swap in       : ${inUsdc} USDC\n` +
      `  Swap out      : ${quote.outAmount} agent tokens (to be burned)\n` +
      `  Price impact  : ${parseFloat(quote.priceImpactPct).toFixed(4)}%\n` +
      `  Agent mint    : ${agentMint.toBase58()}\n` +
      `  Authority     : ${authorityKeypair.publicKey.toBase58()}\n` +
      `────────────────────────────────────────────────────────`;

    if (AUTO_MODE) {
      console.log(details);
      console.log("[buyback] --auto flag set, proceeding immediately");
    } else {
      process.stdout.write(details + "\n\nPress ENTER to confirm or Ctrl+C to abort: ");
      await promptConfirmation();
    }

    // Build and sign the versioned transaction
    const { tx, latestBlockhash } = await buildBuybackTransaction(
      quote,
      swapInstructionsResp,
      globalBuybackAuthority,
    );

    // Submit
    const signature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
    console.log(`[buyback] submitted: ${signature}`);

    await connection.confirmTransaction(
      { signature, ...latestBlockhash },
      "confirmed",
    );
    console.log(`[buyback] confirmed! https://solscan.io/tx/${signature}`);

    appendLog({
      timestamp: new Date().toISOString(),
      vaultBalanceBefore: balanceUsdc,
      jupiterQuoteOut: quote.outAmount,
      signature,
      agentMintBurned: agentMint.toBase58(),
    });
  } finally {
    triggerInFlight = false;
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log(`[buyback] Solana USDC Buyback Trigger Agent`);
  console.log(`[buyback] agent mint   : ${agentMint.toBase58()}`);
  console.log(`[buyback] authority    : ${authorityKeypair.publicKey.toBase58()}`);
  console.log(`[buyback] buyback PDA  : ${buybackAuthorityPda.toBase58()}`);
  console.log(`[buyback] threshold    : ${THRESHOLD_USDC} USDC`);
  console.log(`[buyback] poll interval: ${POLL_INTERVAL_MS}ms`);
  console.log(`[buyback] auto mode    : ${AUTO_MODE}`);
  console.log(`[buyback] log file     : ${LOG_FILE}`);
  console.log();

  // Run immediately on start, then on the polling interval
  await runBuybackCycle().catch((err) =>
    console.error("[buyback] cycle error:", (err as Error).message),
  );

  const intervalId = setInterval(async () => {
    await runBuybackCycle().catch((err) =>
      console.error("[buyback] cycle error:", (err as Error).message),
    );
  }, POLL_INTERVAL_MS);

  const shutdown = (): void => {
    console.log("\n[buyback] shutting down…");
    clearInterval(intervalId);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[buyback] fatal:", (err as Error).message);
  process.exit(1);
});
