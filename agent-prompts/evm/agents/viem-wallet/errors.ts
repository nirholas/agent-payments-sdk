// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
// All rights reserved.

function fmt6(raw: bigint): string {
  const whole = raw / 1_000_000n;
  const frac = (raw % 1_000_000n).toString().padStart(6, "0");
  return `${whole}.${frac}`;
}

export class InsufficientUsdcError extends Error {
  constructor(
    public readonly available: bigint,
    public readonly required: bigint,
  ) {
    super(
      `Insufficient USDC: have ${fmt6(available)} USDC, need ${fmt6(required)} USDC`,
    );
    this.name = "InsufficientUsdcError";
  }
}

export class UnsupportedChainError extends Error {
  constructor(chainId: number) {
    super(`Unsupported chain ID: ${chainId}`);
    this.name = "UnsupportedChainError";
  }
}

export class TransactionRevertedError extends Error {
  constructor(
    public readonly hash: string,
    reason?: string,
  ) {
    super(
      reason
        ? `Transaction ${hash} reverted: ${reason}`
        : `Transaction ${hash} reverted`,
    );
    this.name = "TransactionRevertedError";
  }
}
