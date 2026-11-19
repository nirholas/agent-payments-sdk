// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
// All rights reserved.

import { describe, expect, it } from "vitest";

import {
  allActions,
  buildPaymentInstructionsAction,
  pumpBuyAction,
  pumpSellAction,
  validateInvoiceAction,
} from "./actions";

const MINT = "So11111111111111111111111111111111111111112";

describe("agent-kit action schemas", () => {
  it.each(allActions.map((a) => [a.name, a] as const))(
    "%s: every example input satisfies the schema",
    (_name, action) => {
      for (const group of action.examples) {
        for (const example of group) {
          const input = Object.fromEntries(
            Object.entries(example.input).map(([k, v]) => [k, v === "<coin mint>" ? MINT : v]),
          );
          expect(action.schema.safeParse(input).success).toBe(true);
        }
      }
    },
  );

  it.each(["-5", "1.5", "1e9", "", "abc", "18446744073709551616"])(
    "rejects amount %j before it reaches an instruction builder",
    (amount) => {
      expect(buildPaymentInstructionsAction.schema.safeParse({ mint: MINT, user: MINT, amount }).success).toBe(false);
      expect(pumpBuyAction.schema.safeParse({ mint: MINT, quoteAmount: amount }).success).toBe(false);
      expect(pumpSellAction.schema.safeParse({ mint: MINT, baseAmount: amount }).success).toBe(false);
    },
  );

  it("rejects a zero trade amount and slippage outside 0-100", () => {
    expect(pumpBuyAction.schema.safeParse({ mint: MINT, quoteAmount: "0" }).success).toBe(false);
    expect(pumpSellAction.schema.safeParse({ mint: MINT, baseAmount: "1", slippagePct: 101 }).success).toBe(false);
    expect(pumpSellAction.schema.safeParse({ mint: MINT, baseAmount: "1", slippagePct: -1 }).success).toBe(false);
  });

  it("accepts u64 memos above 2^53 for invoice validation", () => {
    const parsed = validateInvoiceAction.schema.safeParse({
      mint: MINT,
      user: MINT,
      currencyMint: MINT,
      amount: "1000000",
      memo: "17636123456789000123",
      startTime: "1700000000",
      endTime: "1700000300",
    });
    expect(parsed.success).toBe(true);
  });
});
