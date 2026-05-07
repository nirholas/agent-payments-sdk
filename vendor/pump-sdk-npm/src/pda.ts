import {
  poolPda,
  pumpFeePda,
  pumpPda,
  pumpAmmPda,
} from "@pump-fun/pump-swap-sdk";
import {
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey, PublicKeyInitData } from "@solana/web3.js";
import { Buffer } from "buffer";

import {
  MAYHEM_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  PUMP_AMM_PROGRAM_ID,
  PUMP_FEE_PROGRAM_ID,
} from "./sdk";

export const GLOBAL_PDA = pumpPda([Buffer.from("global")]);

export const AMM_GLOBAL_PDA = pumpAmmPda([Buffer.from("amm_global")]);

export const FEE_PROGRAM_GLOBAL_PDA = pumpFeePda([
  Buffer.from("fee-program-global"),
]);

export const PUMP_FEE_CONFIG_PDA = pumpFeePda([
  Buffer.from("fee_config"),
  PUMP_PROGRAM_ID.toBuffer(),
]);

export const GLOBAL_VOLUME_ACCUMULATOR_PDA = pumpPda([
  Buffer.from("global_volume_accumulator"),
]);

export const AMM_GLOBAL_VOLUME_ACCUMULATOR_PDA = pumpAmmPda([
  Buffer.from("global_volume_accumulator"),
]);

export const PUMP_EVENT_AUTHORITY_PDA = getEventAuthorityPda(PUMP_PROGRAM_ID);
export const PUMP_AMM_EVENT_AUTHORITY_PDA =
  getEventAuthorityPda(PUMP_AMM_PROGRAM_ID);
export const PUMP_FEE_EVENT_AUTHORITY_PDA =
  getEventAuthorityPda(PUMP_FEE_PROGRAM_ID);

export function getEventAuthorityPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    programId,
  )[0];
}

export function bondingCurvePda(mint: PublicKeyInitData): PublicKey {
  return pumpPda([
    Buffer.from("bonding-curve"),
    new PublicKey(mint).toBuffer(),
  ]);
}

export function bondingCurveV2Pda(mint: PublicKeyInitData): PublicKey {
  return pumpPda([
    Buffer.from("bonding-curve-v2"),
    new PublicKey(mint).toBuffer(),
  ]);
}

export function creatorVaultPda(creator: PublicKey) {
  return pumpPda([Buffer.from("creator-vault"), creator.toBuffer()]);
}

export function pumpPoolAuthorityPda(mint: PublicKey): PublicKey {
  return pumpPda([Buffer.from("pool-authority"), mint.toBuffer()]);
}

export const CANONICAL_POOL_INDEX = 0;

export function canonicalPumpPoolPda(mint: PublicKey): PublicKey {
  return poolPda(
    CANONICAL_POOL_INDEX,
    pumpPoolAuthorityPda(mint),
    mint,
    NATIVE_MINT,
  );
}

export function canonicalPumpPoolPdaWithQuote(
  mint: PublicKey,
  quoteMint: PublicKey,
): PublicKey {
  return poolPda(
    CANONICAL_POOL_INDEX,
    pumpPoolAuthorityPda(mint),
    mint,
    quoteMint,
  );
}

export function userVolumeAccumulatorPda(
  user: PublicKey,
  program = PUMP_PROGRAM_ID,
): PublicKey {
  if (program === PUMP_PROGRAM_ID) {
    return pumpPda([Buffer.from("user_volume_accumulator"), user.toBuffer()]);
  }
  return pumpAmmPda([Buffer.from("user_volume_accumulator"), user.toBuffer()]);
}

/// Mayhem mode pdas

export const getGlobalParamsPda = (): PublicKey => {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("global-params")],
    MAYHEM_PROGRAM_ID,
  )[0];
};

export const getMayhemStatePda = (mint: PublicKey): PublicKey => {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("mayhem-state"), mint.toBuffer()],
    MAYHEM_PROGRAM_ID,
  )[0];
};

export const getSolVaultPda = (): PublicKey => {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("sol-vault")],
    MAYHEM_PROGRAM_ID,
  )[0];
};

export const getTokenVaultPda = (mintPubkey: PublicKey): PublicKey => {
  return getAssociatedTokenAddressSync(
    mintPubkey,
    getSolVaultPda(),
    true,
    TOKEN_2022_PROGRAM_ID,
  );
};

export const feeSharingConfigPda = (mint: PublicKey): PublicKey => {
  return pumpFeePda([Buffer.from("sharing-config"), mint.toBuffer()]);
};

export const isLegacyQuoteMint = (quoteMint: PublicKey): boolean =>
  quoteMint.equals(NATIVE_MINT) || quoteMint.equals(PublicKey.default);

export const quoteAta = (
  owner: PublicKey,
  quoteMint: PublicKey,
  quoteTokenProgram: PublicKey,
): PublicKey =>
  getAssociatedTokenAddressSync(quoteMint, owner, true, quoteTokenProgram);

export const ammCreatorVaultPda = (creator: PublicKey): PublicKey => {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("creator_vault"), creator.toBuffer()],
    PUMP_AMM_PROGRAM_ID,
  )[0];
};

export const socialFeePda = (userId: string, platform: number): PublicKey => {
  return pumpFeePda([
    Buffer.from("social-fee-pda"),
    Buffer.from(userId),
    Buffer.from([platform]),
  ]);
};

/**
 * The `DonationFeePda` for a given `(mint, configId)` pair.
 * This PDA is the on-chain donation escrow for a slice of the coin's creator
 * fees routed to a specific donate.gg `configId`.
 *
 * Seeds (must match `pump_fees::state::DONATION_FEE_PDA_SEED`):
 *   `[b"donation-fee-pda", mint, configId]`
 *
 * @param mint - The base mint of the coin whose creator fees are being routed.
 * @param configId - The donate.gg config id this PDA escrows for.
 */
export const donationFeePda = (
  mint: PublicKey,
  configId: PublicKey,
): PublicKey => {
  return pumpFeePda([
    Buffer.from("donation-fee-pda"),
    mint.toBuffer(),
    configId.toBuffer(),
  ]);
};

// -- donation_relay program -------------------------------------------------
// Constants and PDA helpers for the external Donation Relay program that
// pump-fees CPIs into during `crankDonationFeePda`. Mirrors the on-chain
// constants in `pump_fees::donation_relay`.
//
// The Donation Relay program is deployed at different addresses on mainnet
// and devnet, so callers must pass the appropriate `donationRelayProgramId`
// to every PDA helper below.

export const DONATION_RELAY_PROGRAM_ID_MAINNET = new PublicKey(
  "RLAYHr9TRFcKB2ubYQhspcnXiaGpaVzNQvHytt47RZu",
);

export const DONATION_RELAY_PROGRAM_ID_DEVNET = new PublicKey(
  "DRLYxueWz6iymdsaRCER6iv6v9zL7gFWANwDL2V5VUx1",
);

export const donationRelayPda = (
  seeds: (Buffer | Uint8Array)[],
  donationRelayProgramId: PublicKey,
): PublicKey => {
  return PublicKey.findProgramAddressSync(seeds, donationRelayProgramId)[0];
};

/**
 * Donation Relay epoch tracker PDA — accumulates per-`(configId, quoteMint)`
 * epoch state.
 */
export const donationRelayEpochTrackerPda = (
  configId: PublicKey,
  quoteMint: PublicKey,
  donationRelayProgramId: PublicKey,
): PublicKey => {
  return donationRelayPda(
    [
      Buffer.from("epoch_tracker_v1"),
      configId.toBuffer(),
      quoteMint.toBuffer(),
    ],
    donationRelayProgramId,
  );
};

/**
 * Donation Relay debouncer PDA — token escrow that accumulates per-`(configId,
 * quoteMint)` deposits between epoch closures.
 */
export const donationRelayDebouncerPda = (
  configId: PublicKey,
  quoteMint: PublicKey,
  donationRelayProgramId: PublicKey,
): PublicKey => {
  return donationRelayPda(
    [Buffer.from("debouncer_v1"), configId.toBuffer(), quoteMint.toBuffer()],
    donationRelayProgramId,
  );
};

export const donationRelayMintWhitelistPda = (
  donationRelayProgramId: PublicKey,
): PublicKey => {
  return donationRelayPda(
    [Buffer.from("mint_whitelist_v1")],
    donationRelayProgramId,
  );
};

export const donationRelayEventAuthorityPda = (
  donationRelayProgramId: PublicKey,
): PublicKey => {
  return getEventAuthorityPda(donationRelayProgramId);
};
