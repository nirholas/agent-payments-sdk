// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
// All rights reserved.

import { describe, it, expect, beforeAll } from "vitest";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  decodeBondingCurve,
  isV2BondingCurve,
  isUsdcQuoted,
  isSolQuoted,
  getQuoteMintAddress,
  type BondingCurveV1,
  type BondingCurveV2,
  BONDING_CURVE_ACCOUNT_SIZE,
} from "./bondingCurveDecoder";

// ── Fixtures ──────────────────────────────────────────────────────────────────
//
// V1_HEX: synthetic 49-byte fixture built from the first 49 bytes of the
// TEST coin's live bonding curve account.  All reserve values are real
// mainnet data; only the trailing v2 fields are omitted.
//
// TEST coin mint: 7DU5iH56AjEgbjmGJ21i1GiyxPxxGVLJwnPdar8ZmDrv
// bonding curve PDA: 82eTMebeCahzmRNMgRdTWsA7eVBSbJT9iFAfiBF1wpxY
// Fetched 2026-05-08 (mainnet).
const V1_HEX =
  "17b7f83760d8ac607d4c4a6b4ebb030007e9a922070000007db4371fbdbc0200073d8626000000000080c6a47e8d030000";

// V2_HEX: pre-upgrade 151-byte bonding curve for the TEST coin (SOL-quoted, not
// complete, isMayhemMode=false, isCashbackCoin=false, quoteMint=all-zeros).
// Fetched 2026-05-08 from mainnet PDA 82eTMebeCahzmRNMgRdTWsA7eVBSbJT9iFAfiBF1wpxY.
const V2_HEX =
  "17b7f83760d8ac607d4c4a6b4ebb030007e9a922070000007db4371fbdbc0200073d8626000000000080c6a47e8d030000c86bbd4049112bd98b89b8d9c7a8eadf2ffafe593c40c953c442eb771f11a39400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";

// CURRENT_HEX: a full 166-byte curve written by the October 2026 program,
// with a non-SOL quote mint, a 300 bps configured creator fee and unswept
// creator/protocol fees sitting on the curve after v3 trades.
// Fetched 2026-10-09 (slot 454741295) from mainnet PDA
// 5Y4diJAetE97pWAcCfc4EtNRoubvYU2uGMyLt8ePkkDA.
const CURRENT_HEX =
  "17b7f83760d8ac60f717605d09c40200fde9ba98bd000000f77f4d1178c501004f7fd709340000000080c6a47e8d030000fa903cdd42260fd519c07393c74eebb3b00f939ee68d19a7dfbe3faf24f125b600000c45f7df8d9e72956284933f6d98b757032e83df84604fb5e117fff61d5b12f92c0100000000000000005f415bb300000000058966b30100000000ae6ae38e8900000000000000000000000000000000000000";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("decodeBondingCurve", () => {
  describe("v1 format (49 bytes)", () => {
    let bc: BondingCurveV1;

    beforeAll(() => {
      const buf = Buffer.from(V1_HEX, "hex");
      expect(buf.length).toBe(49);
      bc = decodeBondingCurve(buf) as BondingCurveV1;
    });

    it("returns version 1", () => {
      expect(bc.version).toBe(1);
    });

    it("isV2BondingCurve returns false", () => {
      expect(isV2BondingCurve(bc)).toBe(false);
    });

    it("has positive virtualTokenReserves", () => {
      expect(bc.virtualTokenReserves.gtn(0)).toBe(true);
    });

    it("has positive virtualSolReserves", () => {
      expect(bc.virtualSolReserves.gtn(0)).toBe(true);
    });

    it("complete is a boolean", () => {
      expect(typeof bc.complete).toBe("boolean");
    });

    it("isUsdcQuoted returns false for v1", () => {
      expect(isUsdcQuoted(bc)).toBe(false);
    });

    it("isSolQuoted returns true for v1", () => {
      expect(isSolQuoted(bc)).toBe(true);
    });

    it("getQuoteMintAddress returns wSOL for v1", () => {
      expect(getQuoteMintAddress(bc)).toBe(
        "So11111111111111111111111111111111111111112",
      );
    });
  });

  describe("v2 format (151 bytes, SOL-quoted TEST coin)", () => {
    let bc: BondingCurveV2;

    beforeAll(() => {
      const buf = Buffer.from(V2_HEX, "hex");
      expect(buf.length).toBeGreaterThanOrEqual(115);
      bc = decodeBondingCurve(buf) as BondingCurveV2;
    });

    it("returns version 2", () => {
      expect(bc.version).toBe(2);
    });

    it("isV2BondingCurve returns true", () => {
      expect(isV2BondingCurve(bc)).toBe(true);
    });

    it("has a creator PublicKey (44 chars base58)", () => {
      expect(bc.creator).toBeInstanceOf(PublicKey);
      expect(bc.creator.toBase58()).toHaveLength(44);
    });

    it("creator matches expected address", () => {
      expect(bc.creator.toBase58()).toBe(
        "EVMpqJEYoWHKhAnDZEa2mT4GyBoMTWGXkSdV1zQB9v8B",
      );
    });

    it("has a quoteMint PublicKey", () => {
      expect(bc.quoteMint).toBeInstanceOf(PublicKey);
    });

    it("isMayhemMode is false", () => {
      expect(bc.isMayhemMode).toBe(false);
    });

    it("isCashbackCoin is false", () => {
      expect(bc.isCashbackCoin).toBe(false);
    });

    it("complete is false", () => {
      expect(bc.complete).toBe(false);
    });

    it("has positive tokenTotalSupply", () => {
      expect(bc.tokenTotalSupply.gtn(0)).toBe(true);
    });

    it("has positive virtualTokenReserves", () => {
      expect(bc.virtualTokenReserves.gtn(0)).toBe(true);
    });

    it("has positive virtualSolReserves", () => {
      expect(bc.virtualSolReserves.gtn(0)).toBe(true);
    });

    it("quoteMint is all-zeros (SOL-quoted coin)", () => {
      expect(bc.quoteMint.toBase58()).toBe(
        "11111111111111111111111111111111",
      );
    });

    it("isUsdcQuoted returns false (SOL-quoted coin)", () => {
      expect(isUsdcQuoted(bc)).toBe(false);
    });

    it("isSolQuoted returns true (quoteMint = system program)", () => {
      expect(isSolQuoted(bc)).toBe(true);
    });

    it("getQuoteMintAddress returns wSOL address for system-program quoteMint", () => {
      expect(getQuoteMintAddress(bc)).toBe(
        "So11111111111111111111111111111111111111112",
      );
    });

    it("virtualQuoteReserves reads the same bytes as virtualSolReserves", () => {
      expect(bc.virtualQuoteReserves.eq(bc.virtualSolReserves)).toBe(true);
      expect(bc.realQuoteReserves.eq(bc.realSolReserves)).toBe(true);
    });

    it("zero-fills the synthetic-migration fields a 151-byte curve predates", () => {
      expect(bc.absentFields).toEqual([
        "post_complete_base_out",
        "post_complete_quote_in",
      ]);
      expect(bc.postCompleteBaseOut.isZero()).toBe(true);
      expect(bc.postCompleteQuoteIn.isZero()).toBe(true);
    });
  });

  describe("current format (166 bytes, after the October 2026 upgrade)", () => {
    let bc: BondingCurveV2;

    beforeAll(() => {
      const buf = Buffer.from(CURRENT_HEX, "hex");
      expect(buf.length).toBe(BONDING_CURVE_ACCOUNT_SIZE);
      bc = decodeBondingCurve(buf) as BondingCurveV2;
    });

    it("decodes every field", () => {
      expect(bc.version).toBe(2);
      expect(bc.absentFields).toEqual([]);
    });

    it("reads the quote reserves at offsets 16 and 32", () => {
      expect(bc.virtualQuoteReserves.toString()).toBe("814311205373");
      expect(bc.realQuoteReserves.toString()).toBe("223503417167");
      expect(bc.initialVirtualQuoteReserves.toString()).toBe("590807788206");
    });

    it("reads the non-SOL quote mint", () => {
      expect(getQuoteMintAddress(bc)).toBe(
        "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn",
      );
      expect(isSolQuoted(bc)).toBe(false);
      expect(isUsdcQuoted(bc)).toBe(false);
    });

    it("reads the configured creator fee and the unswept fee buckets", () => {
      expect(bc.creatorFeeBps.toNumber()).toBe(300);
      expect(bc.creatorFee.toString()).toBe("3009102175");
      expect(bc.protocolFees.toString()).toBe("7304808709");
      expect(bc.canEditCreatorFee).toBe(false);
      expect(bc.isHolderReward).toBe(false);
      expect(bc.depth).toBe(0);
    });

    it("ignores bytes past the last known field", () => {
      const longer = Buffer.concat([
        Buffer.from(CURRENT_HEX, "hex"),
        Buffer.alloc(16, 0xff),
      ]);
      const extended = decodeBondingCurve(longer) as BondingCurveV2;
      expect(extended.absentFields).toEqual([]);
      expect(extended.postCompleteQuoteIn.eq(bc.postCompleteQuoteIn)).toBe(true);
      expect(extended.creatorFee.eq(bc.creatorFee)).toBe(true);
    });
  });

  describe("error handling", () => {
    it("throws on too-small buffer", () => {
      expect(() => decodeBondingCurve(Buffer.alloc(10))).toThrow(/too small/);
    });

    it("handles exactly 49 bytes as v1", () => {
      const buf = Buffer.alloc(49);
      buf.writeUInt8(1, 48); // complete = true
      const bc = decodeBondingCurve(buf);
      expect(bc.version).toBe(1);
      expect(bc.complete).toBe(true);
    });

    it("handles exactly 115 bytes as v2", () => {
      const buf = Buffer.alloc(115);
      const bc = decodeBondingCurve(buf);
      expect(bc.version).toBe(2);
    });

    it("v2 from a 115-byte buffer lists every later field as absent", () => {
      const bc = decodeBondingCurve(Buffer.alloc(115)) as BondingCurveV2;
      expect(bc.absentFields).toEqual([
        "creator_fee_bps",
        "can_edit_creator_fee",
        "is_holder_reward",
        "creator_fee",
        "protocol_fees",
        "depth",
        "initial_virtual_quote_reserves",
        "post_complete_base_out",
        "post_complete_quote_in",
      ]);
      expect(bc.creatorFee.isZero()).toBe(true);
    });

    it("treats a field cut short by the buffer end as absent", () => {
      // 129 bytes: creator_fee (125..133) does not fit.
      const buf = Buffer.alloc(129);
      buf.writeUInt8(1, 124); // is_holder_reward
      const bc = decodeBondingCurve(buf) as BondingCurveV2;
      expect(bc.isHolderReward).toBe(true);
      expect(bc.absentFields[0]).toBe("creator_fee");
      expect(bc.creatorFee.isZero()).toBe(true);
    });

    it("handles 50-byte buffer (between v1 and v2) as v1", () => {
      const buf = Buffer.alloc(50);
      const bc = decodeBondingCurve(buf);
      expect(bc.version).toBe(1);
    });
  });

  describe("live mainnet fetch (integration, requires TEST_LIVE=1)", () => {
    const skip = !process.env.TEST_LIVE;

    it("fetches and decodes TEST coin v2 bonding curve from mainnet", async () => {
      if (skip) return;
      const TEST_MINT = "7DU5iH56AjEgbjmGJ21i1GiyxPxxGVLJwnPdar8ZmDrv";
      const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
      const conn = new Connection(
        "https://api.mainnet-beta.solana.com",
        "confirmed",
      );
      const [bcPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from("bonding-curve"), new PublicKey(TEST_MINT).toBuffer()],
        new PublicKey(PUMP_PROGRAM),
      );
      const info = await conn.getAccountInfo(bcPDA);
      expect(info).not.toBeNull();
      const bc = decodeBondingCurve(Buffer.from(info!.data));
      expect(isV2BondingCurve(bc)).toBe(true);
      if (isV2BondingCurve(bc)) {
        console.log("TEST coin quoteMint:", bc.quoteMint.toBase58());
        console.log("creator:", bc.creator.toBase58());
      }
    });
  });
});
