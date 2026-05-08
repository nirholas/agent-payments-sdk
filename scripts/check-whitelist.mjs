#!/usr/bin/env node
/**
 * Quick one-shot check: is USDC whitelisted on pump.fun?
 * Usage: node scripts/check-whitelist.mjs
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { PUMP_SDK, GLOBAL_PDA } from "@pump-fun/pump-sdk";

const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

const rpcUrl = process.env.HELIUS_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const connection = new Connection(rpcUrl, "confirmed");

const accountInfo = await connection.getAccountInfo(GLOBAL_PDA, "confirmed");
if (!accountInfo) {
  console.error("ERROR: Could not fetch Global PDA:", GLOBAL_PDA.toBase58());
  process.exit(1);
}

const global = PUMP_SDK.decodeGlobal(accountInfo);
const whitelist = global.whitelistedQuoteMints ?? [];
const usdcLive = whitelist.some((m) => m.equals(USDC_MINT));

if (usdcLive) {
  const blockHeight = await connection.getBlockHeight("confirmed");
  console.log(`USDC: LIVE ✅ | Added at block: ${blockHeight}`);
} else {
  const mints = whitelist.map((m) => m.toBase58());
  console.log(`USDC: NOT whitelisted | Whitelist: [${mints.join(", ")}]`);
}
