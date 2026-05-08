// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
// All rights reserved.

import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";

export interface BondingCurveV1 {
  virtualTokenReserves: BN;
  virtualSolReserves: BN;
  realTokenReserves: BN;
  realSolReserves: BN;
  tokenTotalSupply: BN;
  complete: boolean;
  version: 1;
}

export interface BondingCurveV2 extends Omit<BondingCurveV1, "version"> {
  creator: PublicKey;
  isMayhemMode: boolean;
  isCashbackCoin: boolean;
  quoteMint: PublicKey;
  /** Present when account is extended (>= 131 bytes). Non-SOL quote reserves. */
  virtualQuoteReserves: BN | null;
  /** Present when account is extended (>= 131 bytes). Non-SOL quote reserves. */
  realQuoteReserves: BN | null;
  version: 2;
}

export type BondingCurve = BondingCurveV1 | BondingCurveV2;

const DISCRIMINATOR_SIZE = 8;
const V1_SIZE = 49; // 8 + 5*8 + 1
const V2_MIN_SIZE = 115; // V1_SIZE + 32 + 1 + 1 + 32
const V2_EXTENDED_SIZE = 131; // V2_MIN_SIZE + 8 + 8

function readU64(buf: Buffer, offset: number): BN {
  return new BN(buf.subarray(offset, offset + 8), "le");
}

function readPublicKey(buf: Buffer, offset: number): PublicKey {
  return new PublicKey(buf.subarray(offset, offset + 32));
}

export function decodeBondingCurve(data: Buffer): BondingCurve {
  if (data.length < V1_SIZE) {
    throw new Error(
      `Bonding curve account too small: ${data.length} bytes (expected at least ${V1_SIZE})`,
    );
  }

  let offset = DISCRIMINATOR_SIZE;

  const virtualTokenReserves = readU64(data, offset); offset += 8;
  const virtualSolReserves   = readU64(data, offset); offset += 8;
  const realTokenReserves    = readU64(data, offset); offset += 8;
  const realSolReserves      = readU64(data, offset); offset += 8;
  const tokenTotalSupply     = readU64(data, offset); offset += 8;
  const complete             = data[offset] !== 0;    offset += 1;

  if (data.length < V2_MIN_SIZE) {
    return {
      virtualTokenReserves,
      virtualSolReserves,
      realTokenReserves,
      realSolReserves,
      tokenTotalSupply,
      complete,
      version: 1,
    };
  }

  const creator      = readPublicKey(data, offset); offset += 32;
  const isMayhemMode = data[offset] !== 0;         offset += 1;
  const isCashbackCoin = data[offset] !== 0;       offset += 1;
  const quoteMint    = readPublicKey(data, offset); offset += 32;

  let virtualQuoteReserves: BN | null = null;
  let realQuoteReserves: BN | null = null;
  if (data.length >= V2_EXTENDED_SIZE) {
    virtualQuoteReserves = readU64(data, offset); offset += 8;
    realQuoteReserves    = readU64(data, offset); offset += 8;
  }

  return {
    virtualTokenReserves,
    virtualSolReserves,
    realTokenReserves,
    realSolReserves,
    tokenTotalSupply,
    complete,
    creator,
    isMayhemMode,
    isCashbackCoin,
    quoteMint,
    virtualQuoteReserves,
    realQuoteReserves,
    version: 2,
  };
}

export function isV2BondingCurve(bc: BondingCurve): bc is BondingCurveV2 {
  return bc.version === 2;
}

const USDC_MINT_ADDRESS = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const NATIVE_MINT_ADDRESS = "So11111111111111111111111111111111111111112";
const SYSTEM_PROGRAM_ADDRESS = "11111111111111111111111111111111";

export function isUsdcQuoted(bc: BondingCurve): boolean {
  if (!isV2BondingCurve(bc)) return false;
  return bc.quoteMint.toBase58() === USDC_MINT_ADDRESS;
}

export function isSolQuoted(bc: BondingCurve): boolean {
  if (!isV2BondingCurve(bc)) return true;
  const q = bc.quoteMint.toBase58();
  return q === NATIVE_MINT_ADDRESS || q === SYSTEM_PROGRAM_ADDRESS;
}

export function getQuoteMintAddress(bc: BondingCurve): string {
  if (!isV2BondingCurve(bc)) return NATIVE_MINT_ADDRESS;
  const q = bc.quoteMint.toBase58();
  // Treat all-zeros (system program) as native SOL
  return q === SYSTEM_PROGRAM_ADDRESS ? NATIVE_MINT_ADDRESS : q;
}
