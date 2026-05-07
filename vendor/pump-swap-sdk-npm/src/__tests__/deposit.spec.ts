import { expect } from "chai";
import BN from "bn.js";
import { depositToken0 } from "../sdk/deposit";

describe("deposit function", () => {
  it("should calculate maxInAmount, maxOutAmount, and lpTokenAmount correctly", () => {
    const token0 = new BN(1_000); // Example input token amount
    const slippage = 1;
    const token0Reserve = new BN(1_000_000); // Example input reserve in the pool
    const token1Reserve = new BN(2_000_000); // Example output reserve in the pool
    const totalLpTokens = new BN(50_000); // Example total LP token supply

    const result = depositToken0(
      token0,
      slippage,
      token0Reserve,
      token1Reserve,
      totalLpTokens,
    );

    expect(result.token1.toString()).eq("2000");
    expect(result.lpToken.toString()).eq("50");
    expect(result.maxToken0.toString()).eq("1010");
    expect(result.maxToken1.toString()).eq("2020");
  });
});
