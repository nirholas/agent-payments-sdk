import BN from "bn.js";
import { expect } from "chai";
import { withdraw } from "../sdk/withdraw";
import { WithdrawResult } from "../types/sdk";

describe("withdraw", () => {
  it("should correctly calculate withdrawal amounts without slippage", () => {
    const lpAmount = new BN(500); // User withdraws 500 LP tokens
    const baseReserve = new BN(1000); // Total base tokens in the pool
    const quoteReserve = new BN(2000); // Total quote tokens in the pool
    const totalLpTokens = new BN(1000); // Total LP tokens
    const slippage = 0; // No slippage

    const result: WithdrawResult = withdraw(
      lpAmount,
      slippage,
      baseReserve,
      quoteReserve,
      totalLpTokens,
    );

    expect(result.base.toString()).eq("500"); // Half of baseReserve
    expect(result.quote.toString()).eq("1000"); // Half of quoteReserve
    expect(result.minBase.toString()).eq("500"); // Same as base without slippage
    expect(result.minQuote.toString()).eq("1000"); // Same as quote without slippage
  });

  it("should correctly calculate minimum withdrawal amounts with slippage", () => {
    const lpAmount = new BN(500); // User withdraws 500 LP tokens
    const baseReserve = new BN(1000); // Total base tokens in the pool
    const quoteReserve = new BN(2000); // Total quote tokens in the pool
    const totalLpTokens = new BN(1000); // Total LP tokens
    const slippage = 1; // 1% slippage

    const result: WithdrawResult = withdraw(
      lpAmount,
      slippage,
      baseReserve,
      quoteReserve,
      totalLpTokens,
    );

    expect(result.base.toString()).eq("500"); // Half of baseReserve
    expect(result.quote.toString()).eq("1000"); // Half of quoteReserve
    expect(result.minBase.toString()).eq("495"); // 1% slippage applied
    expect(result.minQuote.toString()).eq("990"); // 1% slippage applied
  });

  it("should throw an error if lpAmount is zero", () => {
    const lpAmount = new BN(0); // Zero LP tokens
    const baseReserve = new BN(1000);
    const quoteReserve = new BN(2000);
    const totalLpTokens = new BN(1000);
    const slippage = 1;

    expect(() =>
      withdraw(lpAmount, slippage, baseReserve, quoteReserve, totalLpTokens),
    ).throws("LP amount or total LP tokens cannot be zero.");
  });

  it("should throw an error if totalLpTokens is zero", () => {
    const lpAmount = new BN(500);
    const baseReserve = new BN(1000);
    const quoteReserve = new BN(2000);
    const totalLpTokens = new BN(0); // Total LP tokens is zero
    const slippage = 1;

    expect(() =>
      withdraw(lpAmount, slippage, baseReserve, quoteReserve, totalLpTokens),
    ).throws("LP amount or total LP tokens cannot be zero.");
  });

  it("should handle edge case with slippage reducing amounts to zero", () => {
    const lpAmount = new BN(1);
    const baseReserve = new BN(1);
    const quoteReserve = new BN(1);
    const totalLpTokens = new BN(1000);
    const slippage = 99.9; // Very high slippage

    const result: WithdrawResult = withdraw(
      lpAmount,
      slippage,
      baseReserve,
      quoteReserve,
      totalLpTokens,
    );

    expect(result.base.toString()).eq("0"); // Rounded down
    expect(result.quote.toString()).eq("0"); // Rounded down
    expect(result.minBase.toString()).eq("0"); // After applying slippage
    expect(result.minQuote.toString()).eq("0"); // After applying slippage
  });
});
