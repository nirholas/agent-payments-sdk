import { PublicKey } from "@solana/web3.js";

/**
 * Buyback fee recipients pool. The canonical TypeScript list lives in
 * src/solana/constants.ts and is shared with the PumpTradeClient. This
 * file mirrors it for the standalone .mjs scripts (which can't import
 * .ts at runtime). Keep both in sync.
 *
 * Source: pump-public-docs/docs/FEE_RECIPIENTS.md and the SDK constant
 * CURRENT_FEE_RECIPIENTS_FOR_BUYBACK in @pump-fun/pump-sdk 1.35.0.
 */
const BUYBACK_FEE_RECIPIENTS = [
  "5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD",
  "9M4giFFMxmFGXtc3feFzRai56WbBqehoSeRE5GK7gf7",
  "GXPFM2caqTtQYC2cJ5yJRi9VDkpsYZXzYdwYpGnLmtDL",
  "3BpXnfJaUTiwXnJNe7Ej1rcbzqTTQUvLShZaWazebsVR",
  "5cjcW9wExnJJiqgLjq7DEG75Pm6JBgE1hNv4B2vHXUW6",
  "EHAAiTxcdDwQ3U4bU6YcMsQGaekdzLS3B5SmYo46kJtL",
  "5eHhjP8JaYkz83CWwvGU2uMUXefd3AazWGx4gpcuEEYD",
  "A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW",
].map((s) => new PublicKey(s));

/**
 * Pick a fee recipient. Mayhem coins draw from the reserved set; everyone
 * else draws from the regular set. Mirrors `getFeeRecipient` in the SDK.
 *
 * @param {{
 *   feeRecipient: import("@solana/web3.js").PublicKey,
 *   feeRecipients: import("@solana/web3.js").PublicKey[],
 *   reservedFeeRecipient: import("@solana/web3.js").PublicKey,
 *   reservedFeeRecipients: import("@solana/web3.js").PublicKey[],
 * }} global
 * @param {boolean} mayhemMode
 */
export function pickFeeRecipient(global, mayhemMode) {
  const pool = mayhemMode
    ? [global.reservedFeeRecipient, ...global.reservedFeeRecipients]
    : [global.feeRecipient, ...global.feeRecipients];
  return pool[Math.floor(Math.random() * pool.length)];
}

/** Pick a buyback fee recipient at random from the v1.35 static list. */
export function pickBuybackFeeRecipient() {
  return BUYBACK_FEE_RECIPIENTS[
    Math.floor(Math.random() * BUYBACK_FEE_RECIPIENTS.length)
  ];
}

export { BUYBACK_FEE_RECIPIENTS };
