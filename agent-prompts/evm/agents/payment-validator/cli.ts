#!/usr/bin/env node
/**
 * EVM Payment Proof Validator CLI
 *
 * Usage:
 *   npx tsx cli.ts decode <base64_header>
 *   npx tsx cli.ts verify <base64_header> --memo=<memo> --min=<usdc_decimal> --agent=<agent_mint> [--wait]
 *   npx tsx cli.ts challenge --agent=<mint> --amount=<usdc> --resource=<url> --pay-to=<solana_addr> [--window=<seconds>]
 *   npx tsx cli.ts supported-chains
 */

import {
  decodeAndValidateHeader,
  validatePayment,
  buildChallenge,
  isExpired,
  EVM_CHAINS,
  SUPPORTED_CHAIN_IDS,
  InvalidSchemeError,
} from "./validator.js";

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (const arg of argv) {
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx >= 0) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else {
        flags[arg.slice(2)] = true;
      }
    } else {
      positionals.push(arg);
    }
  }

  return { positionals, flags };
}

function requireFlag(flags: Record<string, string | boolean>, name: string): string {
  const val = flags[name];
  if (typeof val !== "string" || !val) {
    console.error(`Error: --${name} is required`);
    process.exit(1);
  }
  return val;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdDecode(base64Header: string): void {
  let proof;
  try {
    proof = decodeAndValidateHeader(base64Header);
  } catch (err) {
    if (err instanceof InvalidSchemeError) {
      console.error(`✗ ${err.message}`);
    } else {
      console.error(`✗ Failed to decode: ${(err as Error).message}`);
    }
    process.exit(1);
  }

  if (!proof) {
    console.error("✗ Header is missing or malformed");
    process.exit(1);
  }

  console.log("\n✔ Decoded EvmPaymentProof:");
  console.log(`  scheme   : ${proof.scheme}`);
  console.log(`  chainId  : ${proof.chainId}`);
  console.log(`  txHash   : ${proof.txHash}`);
  console.log(`  quoteId  : ${proof.quoteId}`);
  console.log(`  memo     : ${proof.memo}`);
  console.log();
}

async function cmdVerify(
  base64Header: string,
  flags: Record<string, string | boolean>
): Promise<void> {
  const memo = requireFlag(flags, "memo");
  const minStr = requireFlag(flags, "min");
  const agentMint = requireFlag(flags, "agent");
  const waitForSolana = flags["wait"] === true;

  const minAmountUsdcMinor = BigInt(Math.round(parseFloat(minStr) * 1_000_000));

  let proof;
  try {
    proof = decodeAndValidateHeader(base64Header);
  } catch (err) {
    console.error(`✗ ${(err as Error).message}`);
    process.exit(1);
  }

  if (!proof) {
    console.error("✗ Header is missing or malformed");
    process.exit(1);
  }

  console.log(`\nVerifying payment on chain ${proof.chainId}...`);
  if (waitForSolana) console.log("Waiting for Solana confirmation...");

  const result = await validatePayment({
    proof,
    expectedMemo: memo,
    minAmountUsdcMinor,
    agentMint,
    waitForSolana,
  });

  if (result.valid) {
    console.log("\n✔ Payment valid");
    console.log(`  depositId          : ${result.depositId}`);
    console.log(`  confirmedAmount    : ${result.confirmedAmountUsdc} USDC`);
    console.log(`  chain              : ${result.chainName} (${result.chainId})`);
    if (result.solanaSignature) {
      console.log(`  solanaSignature    : ${result.solanaSignature}`);
    }
    console.log(`  verifiedAt         : ${result.verifiedAt?.toISOString()}`);
  } else {
    console.error(`\n✗ Payment invalid: ${result.error}`);
    if (result.depositId) console.error(`  depositId: ${result.depositId}`);
    process.exit(1);
  }
}

function cmdChallenge(flags: Record<string, string | boolean>): void {
  const agentMint = requireFlag(flags, "agent");
  const amountStr = requireFlag(flags, "amount");
  const resource = requireFlag(flags, "resource");
  const payTo = requireFlag(flags, "pay-to");
  const windowSeconds = flags["window"] ? parseInt(flags["window"] as string, 10) : 300;

  const minAmountUsdc = parseFloat(amountStr);
  if (isNaN(minAmountUsdc) || minAmountUsdc <= 0) {
    console.error("Error: --amount must be a positive decimal number (e.g. 1.5)");
    process.exit(1);
  }

  const { header, memo, expiresAt } = buildChallenge({
    agentMint,
    minAmountUsdc,
    resource,
    description: `Payment required for ${resource}`,
    payTo,
    windowSeconds,
  });

  console.log("\nX-Payment-Required header value:");
  console.log(header);
  console.log(`\nMemo (store this to validate the response): ${memo}`);
  console.log(`Expires at: ${expiresAt.toISOString()}`);
  console.log(`Expired now: ${isExpired(expiresAt)}`);
}

function cmdSupportedChains(): void {
  console.log("\nSupported EVM chains:\n");
  const chains = EVM_CHAINS as Record<number, { id: number; name: string; usdc: string; blockExplorer: string }>;
  for (const chainId of SUPPORTED_CHAIN_IDS) {
    const c = chains[chainId];
    if (!c) continue;
    console.log(`  ${String(chainId).padEnd(6)} ${c.name}`);
    console.log(`         USDC: ${c.usdc}`);
    console.log(`         Explorer: ${c.blockExplorer}`);
    console.log();
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  const [command, ...rest] = positionals;

  if (!command || command === "help" || command === "--help") {
    console.log(
      [
        "",
        "Usage:",
        "  npx tsx cli.ts decode <base64_header>",
        "  npx tsx cli.ts verify <base64_header> --memo=<memo> --min=<usdc_decimal> --agent=<mint> [--wait]",
        "  npx tsx cli.ts challenge --agent=<mint> --amount=<usdc> --resource=<url> --pay-to=<solana_addr> [--window=<seconds>]",
        "  npx tsx cli.ts supported-chains",
        "",
      ].join("\n")
    );
    return;
  }

  switch (command) {
    case "decode":
      if (!rest[0]) {
        console.error("Error: provide a base64 header value");
        process.exit(1);
      }
      cmdDecode(rest[0]);
      break;

    case "verify":
      if (!rest[0]) {
        console.error("Error: provide a base64 header value");
        process.exit(1);
      }
      await cmdVerify(rest[0], flags);
      break;

    case "challenge":
      cmdChallenge(flags);
      break;

    case "supported-chains":
      cmdSupportedChains();
      break;

    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
