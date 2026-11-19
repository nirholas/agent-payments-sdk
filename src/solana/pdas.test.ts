// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
// All rights reserved.

import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { feeSharingConfigPda } from "@pump-fun/pump-sdk";

import { getInvoiceIdPDA, getSharingConfigPDA, PROGRAM_ID, INVOICE_ID_SEED } from "./pdas";

describe("getSharingConfigPDA", () => {
  it("matches the Pump Fees program's sharing config address", () => {
    const mint = Keypair.generate().publicKey;
    expect(getSharingConfigPDA(mint)[0].equals(feeSharingConfigPda(mint))).toBe(true);
  });
});

describe("getInvoiceIdPDA", () => {
  it("seeds i64 times as two's complement, like the instruction data", () => {
    const mint = Keypair.generate().publicKey;
    const currency = Keypair.generate().publicKey;
    const seed = (n: bigint) => {
      const b = Buffer.alloc(8);
      b.writeBigInt64LE(n);
      return b;
    };
    const [expected] = PublicKey.findProgramAddressSync(
      [INVOICE_ID_SEED, mint.toBuffer(), currency.toBuffer(), seed(5n), seed(7n), seed(-1n), seed(10n)],
      PROGRAM_ID,
    );
    const [actual] = getInvoiceIdPDA(mint, currency, new BN(5), new BN(7), new BN(-1), new BN(10));
    expect(actual.equals(expected)).toBe(true);
  });
});
