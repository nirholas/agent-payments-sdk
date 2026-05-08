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

// V2_HEX: full 151-byte bonding curve for the TEST coin (SOL-quoted, not
// complete, isMayhemMode=false, isCashbackCoin=false, quoteMint=all-zeros).
// Fetched 2026-05-08 from mainnet PDA 82eTMebeCahzmRNMgRdTWsA7eVBSbJT9iFAfiBF1wpxY.
const V2_HEX =
  "17b7f83760d8ac607d4c4a6b4ebb030007e9a922070000007db4371fbdbc0200073d8626000000000080c6a47e8d030000c86bbd4049112bd98b89b8d9c7a8eadf2ffafe593c40c953c442eb771f11a39400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";

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

    it("virtualQuoteReserves is BN (extended fields present)", () => {
      // 151 bytes >= 131, so extended fields are decoded
      expect(bc.virtualQuoteReserves).not.toBeNull();
    });

    it("realQuoteReserves is BN (extended fields present)", () => {
      expect(bc.realQuoteReserves).not.toBeNull();
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

    it("v2 from 115-byte buffer has null extended fields", () => {
      const bc = decodeBondingCurve(Buffer.alloc(115)) as BondingCurveV2;
      expect(bc.virtualQuoteReserves).toBeNull();
      expect(bc.realQuoteReserves).toBeNull();
    });

    it("v2 from 131-byte buffer has non-null extended fields", () => {
      const bc = decodeBondingCurve(Buffer.alloc(131)) as BondingCurveV2;
      expect(bc.virtualQuoteReserves).not.toBeNull();
      expect(bc.realQuoteReserves).not.toBeNull();
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
