import { expect } from "chai";
import BN from "bn.js";
import { clusterApiUrl, Connection, PublicKey } from "@solana/web3.js";
import { getAccount, getMint, MintLayout, RawMint } from "@solana/spl-token";
import { buyBaseInput, buyQuoteInput } from "../sdk/buy";
import { createFeeConfigFromGlobalConfig } from "./utils";
import { GlobalConfig, Pool } from "../types/sdk";
import { OnlinePumpAmmSdk } from "../sdk/onlinePumpAmm";
import { PUMP_AMM_SDK } from "../sdk/offlinePumpAmm";

describe("buyBaseInput with fees", () => {
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

  it("should compute quote + fees + slippage correctly", () => {
    // Example pool reserves
    const baseReserve = new BN(1_000_000);
    const quoteReserve = new BN(2_000_000);

    // Request to buy 10,000 base tokens
    const base = new BN(10_000);

    // Slippage = 1% (slippage=1 => 1%)
    const slippage = 1;

    const result = buyBaseInput({
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

    console.log("quote =", result.uiQuote.toString());
    console.log("maxQuote =", result.maxQuote.toString());

    // You can calculate offline and replace these with your
    // actual expected values:
    const expectedQuote = new BN(20305); // Example only
    const expectedMaxQuote = new BN(20508); // Example only

    expect(result.uiQuote.toString()).eq(expectedQuote.toString());
    expect(result.maxQuote.toString()).eq(expectedMaxQuote.toString());
  });

  describe("debug quote errors", () => {
    // https://solscan.io/tx/2RvDKD7vfd5bGZ6TLBu4Xm1zhyjUxe1gmFLmHGoFSskssqTuGQk1hD7cvR6UWkqU96CBu5eYnpXodhz4PjVNThcX?cluster=devnet
    const poolKey = new PublicKey(
      "Eo7kU23fKzYbZux6tKcaosFyr7AfJucijzRpNwPrL9G6",
    );
    const baseReserve = new BN(1_000_000_000_000_000);
    const quoteReserve = new BN(1_381_503_388);
    const base = new BN(306_127_676_981_862);
    const quote = new BN(617_120_563);
    const slippage = 0;

    it("buyBaseInput should compute quote + fees + slippage correctly", async () => {
      const pool = await sdk.fetchPool(poolKey);

      const result = buyBaseInput({
        base,
        slippage,
        baseReserve,
        quoteReserve,
        globalConfig,
        baseMintAccount,
        baseMint: pool.baseMint,
        coinCreator: pool.coinCreator,
        creator: pool.creator,
        feeConfig: await sdk.fetchFeeConfigAccount(),
      });

      const expectedQuote = quote.addn(1).toString();
      expect(result.uiQuote.toString()).eq(expectedQuote);
      expect(result.maxQuote.toString()).eq(expectedQuote);
    });

    it("buyQuoteInput should compute quote + fees + slippage correctly", async () => {
      const pool = await sdk.fetchPool(poolKey);

      const result = buyQuoteInput({
        quote,
        slippage,
        baseReserve,
        quoteReserve,
        globalConfig,
        baseMintAccount,
        baseMint: pool.baseMint,
        coinCreator: pool.coinCreator,
        creator: pool.creator,
        feeConfig: await sdk.fetchFeeConfigAccount(),
      });

      expect(result.base.toString()).eq(base.toString());
    });
  });

  describe("debug quote errors2", () => {
    // https://solscan.io/tx/39xg5JpDUAhxPEQf1iyab5hRKLQeg3TAsQ5Tis1z2P4hzzS3b9vhbuTdiLBr4PAjn6XscUfj1CcQ6cmbRca6pCsd?cluster=devnet
    const poolKey = new PublicKey(
      "Eo7kU23fKzYbZux6tKcaosFyr7AfJucijzRpNwPrL9G6",
    );
    const baseReserve = new BN(1_000_000_000_000_000);
    const quoteReserve = new BN(1_381_908_988);
    const base = new BN(66_703_004_162_116);
    const quote = new BN(100_000_000);
    const slippage = 0;

    // AZhWzPYTxCgb6QcSRCSN8kBA57n3jvAneJoUbGmZpump

    function parseMint(data: Buffer): RawMint | null {
      try {
        return MintLayout.decode(new Uint8Array(data)) as RawMint;
      } catch (e) {
        console.warn("Failed to parse mint account", e);
        return null;
      }
    }

    // https://solscan.io/tx/5rYHFqLR5znTecBzPcYCErPEqv1gGT36URE81avB1WJSocvp9s7ADxH2wemQ7z26wvfHmBQmHwuQde7BtukakbKC?cluster=devnet#tokenBalanceChange
    it("buyBaseInput should compute quote + fees + slippage correctly", async () => {
      const pool = await sdk.fetchPool(poolKey);

      const baseMintAccount = parseMint(
        (await connection.getAccountInfo(pool.baseMint))!.data,
      )!;

      const result = buyBaseInput({
        base,
        slippage,
        baseReserve,
        quoteReserve,
        globalConfig: await sdk.fetchGlobalConfigAccount(),
        baseMintAccount,
        baseMint: pool.baseMint,
        coinCreator: pool.coinCreator,
        creator: pool.creator,
        feeConfig: await sdk.fetchFeeConfigAccount(),
      });

      const expectedQuote = quote.addn(2).toString();
      expect(result.uiQuote.toString()).eq(expectedQuote);
      expect(result.maxQuote.toString()).eq(expectedQuote);
    });

    it("buyQuoteInput should compute quote + fees + slippage correctly", async () => {
      const pool = await sdk.fetchPool(poolKey);

      const result = buyQuoteInput({
        quote,
        slippage,
        baseReserve,
        quoteReserve,
        globalConfig,
        baseMintAccount,
        baseMint: pool.baseMint,
        coinCreator: pool.coinCreator,
        creator: pool.creator,
        feeConfig: await sdk.fetchFeeConfigAccount(),
      });

      const expectedBase = base;
      expect(result.base.toString()).eq(expectedBase.toString());

      const result2 = buyBaseInput({
        base: expectedBase,
        slippage,
        baseReserve,
        quoteReserve,
        globalConfig,
        baseMintAccount,
        baseMint: pool.baseMint,
        coinCreator: pool.coinCreator,
        creator: pool.creator,
        feeConfig: await sdk.fetchFeeConfigAccount(),
      });

      const expectedQuote = quote.addn(2).toString();
      expect(result2.uiQuote.toString()).eq(expectedQuote);
      expect(result2.maxQuote.toString()).eq(expectedQuote);
    });
  });

  it("should fail if base > baseReserve", () => {
    const baseReserve = new BN(1_000_000);
    const quoteReserve = new BN(2_000_000);
    const base = new BN(2_000_000); // more than pool
    const slippage = 1;

    expect(() =>
      buyBaseInput({
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
      }),
    ).to.throw("Cannot buy more base tokens than the pool reserves.");
  });

  it("should build the instruction successfully", async () => {
    const pool = new PublicKey("Fzrac7XDX29dYBfMeoPBG18zB2BYFxR5v9fV9zFH7fnV");

    expect(async () => {
      return await PUMP_AMM_SDK.buyBaseInput(
        await sdk.swapSolanaState(pool, user),
        new BN(10),
        10,
      );
    }).to.not.throw();
  });
});
