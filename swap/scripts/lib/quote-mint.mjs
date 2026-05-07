import { PublicKey } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { isLegacyQuoteMint } from "@pump-fun/pump-sdk";

/** Circle USDC mainnet mint. */
export const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

const KNOWN_TOKEN_PROGRAMS = new Set([
  TOKEN_PROGRAM_ID.toBase58(),
  TOKEN_2022_PROGRAM_ID.toBase58(),
]);

/**
 * Resolve the canonical quote mint for a coin, preferring the on-chain
 * bonding curve's `quoteMint` (set by `create_v2`). Legacy SOL coins store
 * `Pubkey::default()` on-chain — the v2 instructions still need wSOL passed
 * explicitly.
 *
 * @param {{ quoteMint?: import("@solana/web3.js").PublicKey } | null | undefined} bondingCurve
 * @param {import("@solana/web3.js").PublicKey | null | undefined} override
 * @returns {import("@solana/web3.js").PublicKey}
 */
export function resolveQuoteMint(bondingCurve, override) {
  if (override) return override;
  const onChain = bondingCurve?.quoteMint;
  if (!onChain || onChain.equals(PublicKey.default)) return NATIVE_MINT;
  return onChain;
}

/**
 * Look up the SPL token program owning a quote mint. wSOL is hard-coded to
 * the legacy SPL Token program (per pump-public-docs/instructions/BUY.md);
 * for any other mint we ask the chain.
 *
 * @param {import("@solana/web3.js").Connection} connection
 * @param {import("@solana/web3.js").PublicKey} quoteMint
 * @param {import("@solana/web3.js").Commitment} [commitment]
 * @returns {Promise<import("@solana/web3.js").PublicKey>}
 */
export async function quoteTokenProgramFromMint(
  connection,
  quoteMint,
  commitment = "confirmed",
) {
  if (quoteMint.equals(NATIVE_MINT)) return TOKEN_PROGRAM_ID;
  const info = await connection.getAccountInfo(quoteMint, commitment);
  if (!info) throw new Error(`Quote mint not found: ${quoteMint.toBase58()}`);
  if (!KNOWN_TOKEN_PROGRAMS.has(info.owner.toBase58())) {
    throw new Error(
      `Quote mint owner is not SPL Token or Token-2022: ${info.owner.toBase58()}`,
    );
  }
  return info.owner;
}

/**
 * Convenience: returns true when the quote mint is the legacy wSOL pair.
 * Re-exports the upstream SDK predicate for ergonomics.
 *
 * @param {import("@solana/web3.js").PublicKey} quoteMint
 */
export function isLegacyQuote(quoteMint) {
  return isLegacyQuoteMint(quoteMint);
}
