// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
// All rights reserved.

import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";

/**
 * Hand-written decoder for the pump bonding-curve account
 * (`6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`, seeds `["bonding-curve", mint]`).
 *
 * The account has grown several times and old curves keep their old size
 * until a trade extends them, so the decoder is length tolerant: it reads
 * every field that fits in the buffer, gives every later field its zero value
 * (`false`, `BN(0)`, `0`) and ignores bytes past the last known field. Layout
 * (offsets include the 8-byte discriminator), from the October 2026 IDL:
 *
 * ```
 *   8 virtual_token_reserves u64     83 quote_mint pubkey
 *  16 virtual_quote_reserves u64    115 creator_fee_bps u64
 *  24 real_token_reserves u64       123 can_edit_creator_fee bool (retired)
 *  32 real_quote_reserves u64       124 is_holder_reward bool
 *  40 token_total_supply u64        125 creator_fee u64
 *  48 complete bool                 133 protocol_fees u64
 *  49 creator pubkey                141 depth u8
 *  81 is_mayhem_mode bool           142 initial_virtual_quote_reserves u64
 *  82 is_cashback_coin bool         150 post_complete_base_out u64
 *                                   158 post_complete_quote_in u64 (end: 166)
 * ```
 *
 * The reserves at offsets 16 and 32 are denominated in the coin's quote mint
 * (lamports for SOL-quoted coins). Prefer `PUMP_SDK.decodeBondingCurve` from
 * `@pump-fun/pump-sdk` when the SDK is already loaded; this decoder exists for
 * callers that only have raw bytes and want no Anchor dependency.
 */

export interface BondingCurveV1 {
  virtualTokenReserves: BN;
  /** Virtual quote reserves (offset 16). Lamports on SOL-quoted coins. */
  virtualSolReserves: BN;
  realTokenReserves: BN;
  /** Real quote reserves (offset 32). Lamports on SOL-quoted coins. */
  realSolReserves: BN;
  tokenTotalSupply: BN;
  complete: boolean;
  version: 1;
}

export interface BondingCurveV2 extends Omit<BondingCurveV1, "version"> {
  creator: PublicKey;
  isMayhemMode: boolean;
  isCashbackCoin: boolean;
  /** All zeros (system program) on SOL-quoted curves created before quote mints existed. */
  quoteMint: PublicKey;
  /** Same bytes as `virtualSolReserves`, named for non-SOL quote mints. */
  virtualQuoteReserves: BN;
  /** Same bytes as `realSolReserves`, named for non-SOL quote mints. */
  realQuoteReserves: BN;
  /** The coin's own creator fee rate; zero means the pump-fees schedule applies. */
  creatorFeeBps: BN;
  /** Retired by the program; always `false` on curves it writes now. */
  canEditCreatorFee: boolean;
  isHolderReward: boolean;
  /**
   * Creator fee accrued on the curve by v3 trades and not yet swept to the
   * creator vault. A nonzero value blocks creator-fee claims until
   * `sweep_creator_fee` runs.
   */
  creatorFee: BN;
  /** Protocol fee accrued on the curve by v3 trades, swept by `sweep_protocol_fee`. */
  protocolFees: BN;
  /** 0 for a coin quoted in SOL/USDC; 1 + the quote coin's depth for a coin quoted in another pump coin. */
  depth: number;
  initialVirtualQuoteReserves: BN;
  /** Base tokens bought at the future pool price by the synthetic-migration buy. */
  postCompleteBaseOut: BN;
  /** Quote paid for `postCompleteBaseOut`. */
  postCompleteQuoteIn: BN;
  /**
   * Fields the account is too short to hold (it predates them); they carry
   * their zero value. Empty for a curve at the full 166-byte size.
   */
  absentFields: string[];
  version: 2;
}

export type BondingCurve = BondingCurveV1 | BondingCurveV2;

const DISCRIMINATOR_SIZE = 8;
const V1_SIZE = 49; // 8 + 5*8 + 1
const V2_MIN_SIZE = 115; // V1_SIZE + 32 + 1 + 1 + 32

/** Full size of a bonding curve account after the October 2026 upgrade. */
export const BONDING_CURVE_ACCOUNT_SIZE = 166;

class FieldReader {
  readonly absent: string[] = [];
  constructor(
    private readonly buf: Buffer,
    private offset: number,
  ) {}

  private take(name: string, size: number): Buffer | null {
    if (this.offset + size > this.buf.length) {
      this.absent.push(name);
      this.offset += size;
      return null;
    }
    const bytes = this.buf.subarray(this.offset, this.offset + size);
    this.offset += size;
    return bytes;
  }

  u64(name: string): BN {
    const b = this.take(name, 8);
    return b ? new BN(b, "le") : new BN(0);
  }

  u8(name: string): number {
    const b = this.take(name, 1);
    return b ? b[0] : 0;
  }

  bool(name: string): boolean {
    return this.u8(name) !== 0;
  }

  pubkey(name: string): PublicKey {
    const b = this.take(name, 32);
    return b ? new PublicKey(b) : PublicKey.default;
  }
}

export function decodeBondingCurve(data: Buffer): BondingCurve {
  if (data.length < V1_SIZE) {
    throw new Error(
      `Bonding curve account too small: ${data.length} bytes (expected at least ${V1_SIZE})`,
    );
  }

  const r = new FieldReader(data, DISCRIMINATOR_SIZE);
  const virtualTokenReserves = r.u64("virtual_token_reserves");
  const virtualSolReserves = r.u64("virtual_quote_reserves");
  const realTokenReserves = r.u64("real_token_reserves");
  const realSolReserves = r.u64("real_quote_reserves");
  const tokenTotalSupply = r.u64("token_total_supply");
  const complete = r.bool("complete");

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

  const creator = r.pubkey("creator");
  const isMayhemMode = r.bool("is_mayhem_mode");
  const isCashbackCoin = r.bool("is_cashback_coin");
  const quoteMint = r.pubkey("quote_mint");
  const creatorFeeBps = r.u64("creator_fee_bps");
  const canEditCreatorFee = r.bool("can_edit_creator_fee");
  const isHolderReward = r.bool("is_holder_reward");
  const creatorFee = r.u64("creator_fee");
  const protocolFees = r.u64("protocol_fees");
  const depth = r.u8("depth");
  const initialVirtualQuoteReserves = r.u64("initial_virtual_quote_reserves");
  const postCompleteBaseOut = r.u64("post_complete_base_out");
  const postCompleteQuoteIn = r.u64("post_complete_quote_in");

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
    virtualQuoteReserves: virtualSolReserves,
    realQuoteReserves: realSolReserves,
    creatorFeeBps,
    canEditCreatorFee,
    isHolderReward,
    creatorFee,
    protocolFees,
    depth,
    initialVirtualQuoteReserves,
    postCompleteBaseOut,
    postCompleteQuoteIn,
    absentFields: r.absent,
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
