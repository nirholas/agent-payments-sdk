// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
// All rights reserved.

import { BN } from "@coral-xyz/anchor";

/**
 * An integer supplied by a caller. Numbers must be safe integers; anything
 * above `Number.MAX_SAFE_INTEGER` (for example most u64 memos) has to be passed
 * as a `bigint`, a decimal string or a `BN`.
 */
export type IntegerInput = bigint | number | string | BN;

const U64_MAX = (1n << 64n) - 1n;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;
const DECIMAL_INTEGER = /^-?\d+$/;

/**
 * Convert an {@link IntegerInput} to a bigint without losing precision.
 * Throws instead of silently rounding, truncating or dropping a sign.
 */
export function toBigIntStrict(value: IntegerInput, field: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(
        `${field} must be a safe integer, got ${value}. ` +
          `Pass a bigint or a decimal string for values above 2^53 - 1.`,
      );
    }
    return BigInt(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!DECIMAL_INTEGER.test(trimmed)) {
      throw new TypeError(
        `${field} must be a decimal integer string, got ${JSON.stringify(value)}`,
      );
    }
    return BigInt(trimmed);
  }
  if (BN.isBN(value)) return BigInt(value.toString());
  throw new TypeError(`${field} must be a bigint, safe integer, decimal string or BN`);
}

/** Convert to a BN, throwing unless the value fits in an unsigned 64-bit integer. */
export function toU64BN(value: IntegerInput, field: string): BN {
  const v = toBigIntStrict(value, field);
  if (v < 0n || v > U64_MAX) {
    throw new RangeError(`${field} must be between 0 and ${U64_MAX}, got ${v}`);
  }
  return new BN(v.toString());
}

/** Convert to a BN, throwing unless the value fits in a signed 64-bit integer. */
export function toI64BN(value: IntegerInput, field: string): BN {
  const v = toBigIntStrict(value, field);
  if (v < I64_MIN || v > I64_MAX) {
    throw new RangeError(`${field} must be between ${I64_MIN} and ${I64_MAX}, got ${v}`);
  }
  return new BN(v.toString());
}
