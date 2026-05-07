import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import {
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { Buffer } from "buffer";

export const PUMP_PROGRAM_ID = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
);

export const PUMP_AMM_PROGRAM_ID = new PublicKey(
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
);

export const PUMP_FEE_PROGRAM_ID = new PublicKey(
  "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ",
);

export const PUMP_MINT = new PublicKey(
  "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn",
);

export const CANONICAL_POOL_INDEX = 0;

export function pumpPda(seeds: Array<Buffer | Uint8Array>) {
  return PublicKey.findProgramAddressSync(seeds, PUMP_PROGRAM_ID)[0];
}

export function pumpAmmPda(seeds: Array<Buffer | Uint8Array>) {
  return PublicKey.findProgramAddressSync(seeds, PUMP_AMM_PROGRAM_ID)[0];
}

export function pumpFeePda(seeds: Array<Buffer | Uint8Array>) {
  return PublicKey.findProgramAddressSync(seeds, PUMP_FEE_PROGRAM_ID)[0];
}

export const GLOBAL_CONFIG_PDA = pumpAmmPda([Buffer.from("global_config")]);

export const PUMP_AMM_EVENT_AUTHORITY_PDA = pumpAmmPda([
  Buffer.from("__event_authority"),
]);

export const GLOBAL_VOLUME_ACCUMULATOR_PDA = pumpAmmPda([
  Buffer.from("global_volume_accumulator"),
]);

export const PUMP_AMM_FEE_CONFIG_PDA = pumpFeePda([
  Buffer.from("fee_config"),
  PUMP_AMM_PROGRAM_ID.toBuffer(),
]);

export function poolPda(
  index: number,
  owner: PublicKey,
  baseMint: PublicKey,
  quoteMint: PublicKey,
): PublicKey {
  return pumpAmmPda([
    Buffer.from("pool"),
    new BN(index).toArrayLike(Buffer, "le", 2),
    owner.toBuffer(),
    baseMint.toBuffer(),
    quoteMint.toBuffer(),
  ]);
}

export function lpMintPda(pool: PublicKey): PublicKey {
  return pumpAmmPda([Buffer.from("pool_lp_mint"), pool.toBuffer()]);
}

export function lpMintAta(lpMint: PublicKey, owner: PublicKey) {
  return getAssociatedTokenAddressSync(
    lpMint,
    owner,
    true,
    TOKEN_2022_PROGRAM_ID,
  );
}

export function pumpPoolAuthorityPda(mint: PublicKey): PublicKey {
  return pumpPda([Buffer.from("pool-authority"), mint.toBuffer()]);
}

export function canonicalPumpPoolPda(mint: PublicKey): PublicKey {
  return poolPda(
    CANONICAL_POOL_INDEX,
    pumpPoolAuthorityPda(mint),
    mint,
    NATIVE_MINT,
  );
}

export function userVolumeAccumulatorPda(user: PublicKey): PublicKey {
  return pumpAmmPda([Buffer.from("user_volume_accumulator"), user.toBuffer()]);
}

export function coinCreatorVaultAuthorityPda(coinCreator: PublicKey) {
  return pumpAmmPda([Buffer.from("creator_vault"), coinCreator.toBuffer()]);
}

export function coinCreatorVaultAtaPda(
  coinCreatorVaultAuthority: PublicKey,
  quoteMint: PublicKey,
  quoteTokenProgram: PublicKey,
) {
  return getAssociatedTokenAddressSync(
    quoteMint,
    coinCreatorVaultAuthority,
    true,
    quoteTokenProgram,
  );
}

export function poolV2Pda(baseMint: PublicKey): PublicKey {
  return pumpAmmPda([Buffer.from("pool-v2"), baseMint.toBuffer()]);
}
