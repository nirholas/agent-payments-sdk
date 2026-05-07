import { expect } from "chai";
import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import { computeFeesBps } from "../sdk/fees";
import { Fees, FeeConfig, FeeTier, GlobalConfig } from "../types/sdk";
import { pumpPoolAuthorityPda } from "../sdk/pda";
import { poolMarketCap } from "../sdk/util";

describe("computeFeesBps", () => {
  const tier1Fees: FeeTier = {
    marketCapLamportsThreshold: new BN(100_000_000_000_000),
    fees: {
      lpFeeBps: new BN(15),
      protocolFeeBps: new BN(5),
      creatorFeeBps: new BN(5),
    },
  };

  const tier2Fees: FeeTier = {
    marketCapLamportsThreshold: new BN(500_000_000_000_000),
    fees: {
      lpFeeBps: new BN(20),
      protocolFeeBps: new BN(5),
      creatorFeeBps: new BN(5),
    },
  };

  const tier3Fees: FeeTier = {
    marketCapLamportsThreshold: new BN(2_500_000_000_000_000),
    fees: {
      lpFeeBps: new BN(15),
      protocolFeeBps: new BN(2),
      creatorFeeBps: new BN(3),
    },
  };

  const flatFees: Fees = {
    lpFeeBps: new BN(25),
    protocolFeeBps: new BN(5),
    creatorFeeBps: new BN(0),
  };

  const globalConfig: GlobalConfig = {
    admin: PublicKey.unique(),
    lpFeeBasisPoints: new BN(42),
    protocolFeeBasisPoints: new BN(42),
    disableFlags: 0,
    protocolFeeRecipients: [],
    coinCreatorFeeBasisPoints: new BN(42),
    adminSetCoinCreatorAuthority: PublicKey.unique(),
    whitelistPda: PublicKey.unique(),
    reservedFeeRecipient: PublicKey.unique(),
    mayhemModeEnabled: false,
    reservedFeeRecipients: [],
  };

  const feeConfig: FeeConfig = {
    admin: PublicKey.unique(),
    flatFees,
    feeTiers: [tier1Fees, tier2Fees, tier3Fees],
  };

  const baseMint = PublicKey.unique();
  const baseMintSupply = new BN(1_000_000);

  const pumpPool = {
    poolBump: 1,
    index: 0,
    creator: pumpPoolAuthorityPda(baseMint),
    baseMint,
    quoteMint: PublicKey.unique(),
    lpMint: PublicKey.unique(),
    poolBaseTokenAccount: PublicKey.unique(),
    poolQuoteTokenAccount: PublicKey.unique(),
    lpSupply: new BN(1_000_000),
    coinCreator: PublicKey.unique(),
  };

  const tradeSize = new BN(10_000);

  it("market cap should be correct", () => {
    let baseReserve = new BN(1_000_000);
    let quoteReserve = new BN(2_000_000);
    let marketCap = poolMarketCap({
      baseMintSupply,
      baseReserve,
      quoteReserve,
    });
    let expectedMarketCap = quoteReserve.mul(baseMintSupply).div(baseReserve);
    expect(marketCap.toString()).to.equal(expectedMarketCap.toString());

    quoteReserve = new BN(500_000_000_000_000);
    marketCap = poolMarketCap({
      baseMintSupply,
      baseReserve,
      quoteReserve,
    });
    expectedMarketCap = quoteReserve.mul(baseMintSupply).div(baseReserve);
    expect(marketCap.toString()).to.equal(expectedMarketCap.toString());

    baseReserve = new BN(1_000_000);
    quoteReserve = new BN(2_500_000_000_000_000);
    marketCap = poolMarketCap({
      baseMintSupply,
      baseReserve,
      quoteReserve,
    });
    expectedMarketCap = quoteReserve.mul(baseMintSupply).div(baseReserve);
    expect(marketCap.toString()).to.equal(expectedMarketCap.toString());
  });

  it("non pump pool should use flat fees", () => {
    const nonPumpPool = {
      ...pumpPool,
      creator: PublicKey.unique(),
    };

    const result = computeFeesBps({
      globalConfig,
      feeConfig,
      creator: nonPumpPool.creator,
      baseMintSupply,
      baseMint: nonPumpPool.baseMint,
      baseReserve: new BN(1_000_000),
      quoteReserve: new BN(2_000_000),
      tradeSize: new BN(10_000),
    });

    expectCalculatedFeesEqualFees(result, flatFees);
  });

  it("pump pool should use first tier when market cap is below first tier", () => {
    const result = computeFeesBps({
      globalConfig,
      feeConfig,
      creator: pumpPool.creator,
      baseMintSupply,
      baseMint: pumpPool.baseMint,
      baseReserve: new BN(1_000_000),
      quoteReserve: new BN(tier1Fees.marketCapLamportsThreshold).sub(new BN(1)),
      tradeSize,
    });
    expectCalculatedFeesEqualFees(result, tier1Fees.fees);
  });

  it("pump pool should use last tier when market cap is above last tier", () => {
    const result = computeFeesBps({
      globalConfig,
      feeConfig,
      creator: pumpPool.creator,
      baseMintSupply,
      baseMint: pumpPool.baseMint,
      baseReserve: new BN(1_000_000),
      quoteReserve: new BN(tier3Fees.marketCapLamportsThreshold).add(new BN(1)),
      tradeSize,
    });
    expectCalculatedFeesEqualFees(result, tier3Fees.fees);
  });

  it("should use global config fees when fee config is null", () => {
    const result = computeFeesBps({
      globalConfig,
      feeConfig: null,
      creator: pumpPool.creator,
      baseMintSupply,
      baseMint: pumpPool.baseMint,
      baseReserve: new BN(1_000_000),
      quoteReserve: new BN(2_000_000),
      tradeSize,
    });
    expectCalculatedFeesEqualFees(result, {
      lpFeeBps: globalConfig.lpFeeBasisPoints,
      protocolFeeBps: globalConfig.protocolFeeBasisPoints,
      creatorFeeBps: globalConfig.coinCreatorFeeBasisPoints,
    });
  });
});

function expectCalculatedFeesEqualFees(actual: Fees, expected: Fees) {
  expect(actual.creatorFeeBps.toString()).to.equal(
    expected.creatorFeeBps.toString()
  );
  expect(actual.lpFeeBps.toString()).to.equal(expected.lpFeeBps.toString());
  expect(actual.protocolFeeBps.toString()).to.equal(
    expected.protocolFeeBps.toString()
  );
}
