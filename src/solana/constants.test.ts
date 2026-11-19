// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
// All rights reserved.

import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";

import { pickFeeRecipient } from "./constants.js";

describe("pickFeeRecipient", () => {
  it("never picks an empty (default-key) slot", () => {
    const real = Keypair.generate().publicKey;
    const global = {
      feeRecipient: real,
      feeRecipients: Array.from({ length: 7 }, () => PublicKey.default),
      reservedFeeRecipient: real,
      reservedFeeRecipients: [PublicKey.default],
    };
    for (let i = 0; i < 50; i++) {
      expect(pickFeeRecipient(global, false).equals(real)).toBe(true);
      expect(pickFeeRecipient(global, true).equals(real)).toBe(true);
    }
  });
});
