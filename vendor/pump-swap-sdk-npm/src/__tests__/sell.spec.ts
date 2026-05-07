import { expect } from "chai";
import BN from "bn.js";
import { clusterApiUrl, Connection, PublicKey } from "@solana/web3.js";
import { RawMint } from "@solana/spl-token";
import { sellBaseInput } from "../sdk/sell";
import { createFeeConfigFromGlobalConfig } from "./utils";
import { GlobalConfig, Pool } from "../types/sdk";
import { OnlinePumpAmmSdk } from "../sdk/onlinePumpAmm";
import { PUMP_AMM_SDK } from "../sdk/offlinePumpAmm";

describe("sellBaseInput", () => {
  const connection = new Connection(clusterApiUrl("devnet"), "confirmed");
  const sdk = new OnlinePumpAmmSdk(connection);
  const user = new PublicKey("4kBH5H5p9oRkZPGLSx8R4WKoDsmXnEpmzsgkebkKvzSg");

  const baseMintAccount: RawMint = {
    mintAuthorityOption: 0,
    mintAuthority: PublicKey.unique(),
    supply: BigInt(1),
    decimals: 9,
    isInitialized: false,
    freezeAuthorityOption: 0,
    freezeAuthority: PublicKey.unique(),
  };

  const pool: Pool = {
    poolBump: 1,
    index: 0,
    creator: PublicKey.unique(),
    baseMint: PublicKey.unique(),
    quoteMint: PublicKey.unique(),
    lpMint: PublicKey.unique(),
    poolBaseTokenAccount: PublicKey.unique(),
    poolQuoteTokenAccount: PublicKey.unique(),
    lpSupply: new BN(0),
    coinCreator: PublicKey.default,
    isMayhemMode: false,
    isCashbackCoin: false,
  };

  const globalConfig: GlobalConfig = {
    admin: PublicKey.unique(),
    lpFeeBasisPoints: new BN(30),
    protocolFeeBasisPoints: new BN(20),
    disableFlags: 0,
    protocolFeeRecipients: [],
    coinCreatorFeeBasisPoints: new BN(0),
    adminSetCoinCreatorAuthority: PublicKey.unique(),
    whitelistPda: PublicKey.unique(),
    reservedFeeRecipient: PublicKey.unique(),
    mayhemModeEnabled: false,
    reservedFeeRecipients: [],
  };

  const feeConfig = createFeeConfigFromGlobalConfig(globalConfig);

  it("should compute final quote and minQuote correctly with typical inputs", () => {
    // Example pool reserves
    const baseReserve = new BN(1_000_000); // base tokens in pool
    const quoteReserve = new BN(2_000_000); // quote tokens in pool

    // The user wants to sell 50,000 base tokens
    const base = new BN(50_000);

    // Slippage = 1% => the user will accept at least 99% of finalQuote
    const slippage = 1;

    const result = sellBaseInput({
      base,
      slippage,
      baseReserve,
      quoteReserve,
      globalConfig,
      baseMintAccount,
      baseMint: pool.baseMint,
      coinCreator: pool.coinCreator,
      creator: pool.creator,
      feeConfig,
    });

    console.log("Final quote received:", result.uiQuote.toString());
    console.log("Min quote after slippage:", result.minQuote.toString());

    // Replace these placeholder values with the actual results once you confirm them offline:
    // For example, if you do the math manually or from a reference, set them here:
    const expectedFinalQuote = new BN(94761); // Example placeholder
    const expectedMinQuote = new BN(93813); // Example placeholder

    expect(result.uiQuote.toString()).to.equal(
      expectedFinalQuote.toString(),
      "Incorrect final quote"
    );
    expect(result.minQuote.toString()).to.equal(
      expectedMinQuote.toString(),
      "Incorrect min quote"
    );
  });

  it("should throw an error if 'baseReserve' or 'quoteReserve' is zero", () => {
    const slippage = 1;
    // baseReserve = 0
    expect(() =>
      sellBaseInput({
        base: new BN(1000),
        slippage,
        baseReserve: new BN(0),
        quoteReserve: new BN(2_000_000),
        globalConfig,
        baseMintAccount,
        baseMint: pool.baseMint,
        coinCreator: pool.coinCreator,
        creator: pool.creator,
        feeConfig,
      })
    ).to.throw(
      "Invalid input: 'baseReserve' or 'quoteReserve' cannot be zero."
    );

    // quoteReserve = 0
    expect(() =>
      sellBaseInput({
        base: new BN(1000),
        slippage,
        baseReserve: new BN(1_000_000),
        quoteReserve: new BN(0),
        globalConfig,
        baseMintAccount,
        baseMint: pool.baseMint,
        coinCreator: pool.coinCreator,
        creator: pool.creator,
        feeConfig,
      })
    ).to.throw(
      "Invalid input: 'baseReserve' or 'quoteReserve' cannot be zero."
    );
  });

  it("should throw an error if fees exceed total output (finalQuote negative)", () => {
    // We want quoteAmountOut > 0 but finalQuote < 0 after subtracting fees.
    const base = new BN(1);
    const baseReserve = new BN(1);
    const quoteReserve = new BN(2);
    const slippage = 1;

    const highFeeGlobalConfig: GlobalConfig = {
      admin: PublicKey.unique(),
      lpFeeBasisPoints: new BN(9000),
      protocolFeeBasisPoints: new BN(2000),
      disableFlags: 0,
      protocolFeeRecipients: [],
      coinCreatorFeeBasisPoints: new BN(0),
      adminSetCoinCreatorAuthority: PublicKey.unique(),
      whitelistPda: PublicKey.unique(),
      reservedFeeRecipient: PublicKey.unique(),
      mayhemModeEnabled: false,
      reservedFeeRecipients: [],
    };

    const highFeeConfig = createFeeConfigFromGlobalConfig(highFeeGlobalConfig);

    expect(() =>
      sellBaseInput({
        base,
        slippage,
        baseReserve,
        quoteReserve,
        globalConfig,
        baseMintAccount,
        baseMint: pool.baseMint,
        coinCreator: pool.coinCreator,
        creator: pool.creator,
        feeConfig: highFeeConfig,
      })
    ).to.throw("Fees exceed total output; final quote is negative.");
  });

  it("should build the instruction successfully", async () => {
    const pool = new PublicKey("Fzrac7XDX29dYBfMeoPBG18zB2BYFxR5v9fV9zFH7fnV");

    expect(async () => {
      return await PUMP_AMM_SDK.sellBaseInput(
        await sdk.swapSolanaState(pool, user),
        new BN(10),
        10
      );
    }).to.not.throw();
  });
});
