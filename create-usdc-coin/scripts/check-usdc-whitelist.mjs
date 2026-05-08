#!/usr/bin/env node
/**
 * Check whether USDC is currently whitelisted as a quote mint in the
 * pump.fun bonding-curve `Global` config. Exits 0 when whitelisted,
 * 1 when not — so it can be used as a polling primitive:
 *
 *   while ! node scripts/check-usdc-whitelist.mjs; do sleep 60; done
 *   echo "USDC IS LIVE — DEPLOY NOW"
 */
import { parseArgs } from "node:util";
import { Connection, PublicKey } from "@solana/web3.js";
import { OnlinePumpSdk } from "@pump-fun/pump-sdk";
import { exitWithHelp, printJson } from "./lib/args.mjs";

const USDC_MINT_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDC_MINT_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

const HELP = `Usage: node scripts/check-usdc-whitelist.mjs [options]

Reads pump.fun Global config from chain and reports whether USDC
is currently in global.whitelistedQuoteMints. Prints every whitelisted
quote mint so the user can see what is live.

Options:
  --network <mainnet|devnet>   Default: mainnet
  --rpc <url>                  RPC URL override (else uses SOLANA_RPC_URL
                               or NEXT_PUBLIC_SOLANA_RPC_URL, falling back
                               to api.mainnet-beta.solana.com)
  -h, --help

Exit codes:
  0  USDC is whitelisted
  1  USDC is not whitelisted (or fetch error)`;

function defaultRpcForNetwork(network) {
  return network === "devnet"
    ? "https://api.devnet.solana.com"
    : "https://api.mainnet-beta.solana.com";
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      network: { type: "string", default: "mainnet" },
      rpc: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) exitWithHelp("check-usdc-whitelist.mjs", HELP);

  const network = values.network === "devnet" ? "devnet" : "mainnet";
  const rpcUrl =
    values.rpc?.trim() ||
    process.env.SOLANA_RPC_URL?.trim() ||
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL?.trim() ||
    defaultRpcForNetwork(network);

  const usdcMint = new PublicKey(
    network === "devnet" ? USDC_MINT_DEVNET : USDC_MINT_MAINNET,
  );

  const connection = new Connection(rpcUrl, "confirmed");
  const onlineSdk = new OnlinePumpSdk(connection);

  const global = await onlineSdk.fetchGlobal();
  const rawList = Array.isArray(global.whitelistedQuoteMints)
    ? global.whitelistedQuoteMints
    : [];

  const ZERO = "11111111111111111111111111111111";
  const whitelistedMints = rawList
    .map((pk) => pk?.toBase58?.() ?? String(pk))
    .filter((b58) => b58 && b58 !== ZERO);
  const totalWhitelisted = whitelistedMints.length;
  const whitelisted = whitelistedMints.includes(usdcMint.toBase58());

  printJson({
    whitelisted,
    network,
    rpc: rpcUrl,
    usdcMint: usdcMint.toBase58(),
    whitelistedMints,
    totalWhitelisted,
    message: whitelisted
      ? "USDC creation is live."
      : "Not yet enabled. Check pump.fun announcements.",
    checkedAt: new Date().toISOString(),
  });

  process.exit(whitelisted ? 0 : 1);
}

main().catch((e) => {
  process.stderr.write(`${e?.message ?? e}\n`);
  process.exit(1);
});
