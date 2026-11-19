// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
// All rights reserved.

import { describe, it, expect } from "vitest";
import { BN } from "@coral-xyz/anchor";

import { toBigIntStrict, toI64BN, toU64BN } from "./integers";

describe("toBigIntStrict", () => {
  it("accepts bigint, safe numbers, decimal strings and BN", () => {
    expect(toBigIntStrict(5n, "x")).toBe(5n);
    expect(toBigIntStrict(42, "x")).toBe(42n);
    expect(toBigIntStrict(" 17636123456789000123 ", "x")).toBe(17636123456789000123n);
    expect(toBigIntStrict(new BN("9007199254740993"), "x")).toBe(9007199254740993n);
  });

  it("rejects numbers that would silently lose precision", () => {
    expect(() => toBigIntStrict(9007199254740993, "memo")).toThrow(RangeError);
    expect(() => toBigIntStrict(1.5, "amount")).toThrow(RangeError);
    expect(() => toBigIntStrict(Number.NaN, "amount")).toThrow(RangeError);
  });

  it("rejects non-integer strings instead of parsing a prefix", () => {
    for (const bad of ["", "abc", "1.5", "1e9", "0x10", "12abc"]) {
      expect(() => toBigIntStrict(bad, "amount")).toThrow(TypeError);
    }
  });
});

describe("toU64BN / toI64BN", () => {
  it("keeps u64 values above 2^53 exact", () => {
    expect(toU64BN("18446744073709551615", "memo").toString()).toBe("18446744073709551615");
  });

  it("rejects negative and overflowing u64 values", () => {
    expect(() => toU64BN("-5", "amount")).toThrow(RangeError);
    expect(() => toU64BN("18446744073709551616", "amount")).toThrow(RangeError);
  });

  it("accepts the full i64 range and nothing outside it", () => {
    expect(toI64BN(-1, "startTime").toString()).toBe("-1");
    expect(() => toI64BN("9223372036854775808", "endTime")).toThrow(RangeError);
  });
});
