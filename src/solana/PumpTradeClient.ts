// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
// All rights reserved.

/**
 * PumpTradeClient: bonding-curve buy / sell / exact-quote / cashback (v2 and
 * v3), multi-hop swaps, and the fee sweeps v3 trades require.
 *
 * All curve build* methods batch Global + FeeConfig + bondingCurve (+ userAta
 * and the curve's base ATA for buys) into a SINGLE getMultipleAccountsInfo
 * call. No sequential RPC.
 *
 * Routing: reads bondingCurve.quoteMint on-chain, so SOL-, USDC- and
 * pump-coin-quoted coins are handled identically.
 *
 * v2 vs v3: same prices and fees. v3 instructions take 17 accounts (smaller
 * transactions) and leave the protocol and creator fees on the curve until
 * `sweep_protocol_fee` / `sweep_creator_fee` pay them out; v3 refuses
 * cashback coins (6094), which keep trading through v2.
 */

import { BN } from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  type AccountInfo,
  type AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  GLOBAL_PDA,
  GLOBAL_VOLUME_ACCUMULATOR_PDA,
  OnlinePumpSdk,
  PUMP_EVENT_AUTHORITY_PDA,
  PUMP_FEE_CONFIG_PDA,
  PUMP_FEE_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  PUMP_SDK,
  bondingCurveMarketCap,
  bondingCurvePda,
  creatorVaultPda,
  feeSharingConfigPda,
  getBuySolAmountFromTokenAmount,
  getBuyTokenAmountFromSolAmount,
  getBuyV3QuoteAmountFromTokenAmount,
  getBuyV3TokenAmountFromQuoteAmount,
  getFeeRecipient,
  getPumpProgram,
  getSellSolAmountFromTokenAmount,
  multiHopRouteEnds,
  userVolumeAccumulatorPda,
} from "@pump-fun/pump-sdk";
import { pickBuybackFeeRecipient, pickFeeRecipient } from "./constants.js";
import type {
  BuyQuote,
  BuyResult,
  BuyV3Result,
  ExactQuoteResult,
  MultiHopSwapResult,
  SellQuote,
  SellResult,
  SellV3Result,
  SweepCurveFeesResult,
} from "./types.js";

// ─── Errors ───────────────────────────────────────────────────────────────────

/** Coin has graduated (bondingCurve.complete === true). Use AMM. */
export class CoinGraduatedError extends Error {
  constructor(mint: PublicKey) {
    super(
      `Bonding curve for mint ${mint.toBase58()} is complete: use AMM instead.`,
    );
    this.name = "CoinGraduatedError";
  }
}

/** v3 trades need the pump-fees `FeeConfig` account, which was not found. */
export class FeeConfigNotFoundError extends Error {
  constructor() {
    super("pump-fees FeeConfig account not found: v3 trades cannot be priced on this network.");
    this.name = "FeeConfigNotFoundError";
  }
}

/** No bonding curve account exists for the mint. */
export class CoinNotFoundError extends Error {
  constructor(mint: PublicKey) {
    super(`Bonding curve account not found for mint ${mint.toBase58()}.`);
    this.name = "CoinNotFoundError";
  }
}

/** Requested amount exceeds available reserves. */
export class InsufficientLiquidityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InsufficientLiquidityError";
  }
}

/** Quote mint is not in the pump.fun whitelist. */
export class UnsupportedQuoteMintError extends Error {
  constructor(quoteMint: PublicKey) {
    super(
      `Quote mint ${quoteMint.toBase58()} is not owned by TOKEN_PROGRAM_ID or TOKEN_2022_PROGRAM_ID.`,
    );
    this.name = "UnsupportedQuoteMintError";
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

const KNOWN_TOKEN_PROGRAMS = new Set([
  TOKEN_PROGRAM_ID.toBase58(),
  TOKEN_2022_PROGRAM_ID.toBase58(),
]);

function resolveQuoteMintFromCurve(quoteMintOnChain: PublicKey): PublicKey {
  if (!quoteMintOnChain || quoteMintOnChain.equals(PublicKey.default)) {
    return NATIVE_MINT;
  }
  return quoteMintOnChain;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** SPL / Token-2022 token account `amount` (u64 LE at byte 64); 0 when the account is missing. */
function tokenAccountAmount(info: AccountInfo<Buffer> | null): BN {
  if (!info || info.data.length < 72) return new BN(0);
  return new BN(info.data.subarray(64, 72), "le");
}

/** `amount` less `slippagePct` percent, in integer math (basis points). */
function lessSlippage(amount: BN, slippagePct: number): BN {
  const bps = Math.round(clamp(slippagePct, 0, 100) * 100);
  return amount.muln(10_000 - bps).divn(10_000);
}

/** Pick a buyback wallet from the live `Global.buybackFeeRecipients` list. */
function pickGlobalBuybackFeeRecipient(global: {
  buybackFeeRecipients: PublicKey[];
}): PublicKey {
  const listed = global.buybackFeeRecipients.filter(
    (k) => !k.equals(PublicKey.default),
  );
  if (listed.length === 0) return pickBuybackFeeRecipient();
  return listed[Math.floor(Math.random() * listed.length)]!;
}

/** Compute units for a multi-hop swap: ~200k per hop plus ATA setup, capped at the 1.4M max. */
const MULTI_HOP_CU_PER_HOP = 200_000;
const MULTI_HOP_CU_BASE = 100_000;
const MAX_COMPUTE_UNITS = 1_400_000;

function computePriceImpactPct(quoteAmount: BN, marketCap: BN): number {
  if (marketCap.isZero()) return 0;
  return clamp((quoteAmount.toNumber() / marketCap.toNumber()) * 100, 0, 100);
}

// ─── PumpTradeClient ──────────────────────────────────────────────────────────

export class PumpTradeClient {
  /** quoteMint never changes once a coin is created: safe to cache forever. */
  private readonly quoteMintCache = new Map<string, PublicKey>();
  /** Token program for a quote mint (also stable after mint creation). */
  private readonly tokenProgramCache = new Map<string, PublicKey>();

  constructor(private readonly connection: Connection) {}

  // ── resolveQuoteMint ────────────────────────────────────────────────────────

  /** Read bondingCurve.quoteMint from chain, normalize default → NATIVE_MINT. Caches. */
  async resolveQuoteMint(mint: PublicKey): Promise<PublicKey> {
    const key = mint.toBase58();
    const cached = this.quoteMintCache.get(key);
    if (cached) return cached;

    const info = await this.connection.getAccountInfo(bondingCurvePda(mint));
    if (!info) throw new CoinNotFoundError(mint);

    const curve = PUMP_SDK.decodeBondingCurve(info);
    const resolved = resolveQuoteMintFromCurve(curve.quoteMint);
    this.quoteMintCache.set(key, resolved);
    return resolved;
  }

  // ── quoteForBuy ─────────────────────────────────────────────────────────────

  async quoteForBuy(params: {
    mint: PublicKey;
    quoteAmount: BN;
    slippagePct?: number;
  }): Promise<BuyQuote> {
    const { mint, quoteAmount } = params;
    const slippage = params.slippagePct ?? 5;

    const {
      global,
      feeConfig,
      bondingCurve,
      quoteMint,
      quoteTokenProgram,
    } = await this._fetchAndDecode(mint);

    const mintSupply = bondingCurve.tokenTotalSupply;

    const expectedBaseTokens = getBuyTokenAmountFromSolAmount({
      global, feeConfig, mintSupply, bondingCurve, amount: quoteAmount, quoteMint,
    });

    const preciseQuoteAmount = getBuySolAmountFromTokenAmount({
      global, feeConfig, mintSupply, bondingCurve, amount: expectedBaseTokens, quoteMint,
    });

    const maxQuoteCost = new BN(
      Math.ceil(preciseQuoteAmount.toNumber() * (1 + slippage / 100)),
    );

    const marketCap = bondingCurveMarketCap({
      mintSupply,
      virtualQuoteReserves: bondingCurve.virtualQuoteReserves,
      virtualTokenReserves: bondingCurve.virtualTokenReserves,
    });

    return {
      quoteMint,
      quoteTokenProgram,
      quoteAmount,
      expectedBaseTokens,
      preciseQuoteAmount,
      maxQuoteCost,
      slippagePct: slippage,
      priceImpactPct: computePriceImpactPct(quoteAmount, marketCap),
    };
  }

  // ── quoteForSell ────────────────────────────────────────────────────────────

  async quoteForSell(params: {
    mint: PublicKey;
    baseAmount: BN;
    slippagePct?: number;
  }): Promise<SellQuote> {
    const { mint, baseAmount } = params;
    const slippage = params.slippagePct ?? 5;

    const {
      global,
      feeConfig,
      bondingCurve,
      quoteMint,
      quoteTokenProgram,
    } = await this._fetchAndDecode(mint);

    const mintSupply = bondingCurve.tokenTotalSupply;

    const expectedQuoteOut = getSellSolAmountFromTokenAmount({
      global, feeConfig, mintSupply, bondingCurve, amount: baseAmount,
    });

    const minQuoteOut = new BN(
      Math.max(0, Math.floor(expectedQuoteOut.toNumber() * (1 - slippage / 100))),
    );

    const marketCap = bondingCurveMarketCap({
      mintSupply,
      virtualQuoteReserves: bondingCurve.virtualQuoteReserves,
      virtualTokenReserves: bondingCurve.virtualTokenReserves,
    });

    return {
      quoteMint,
      quoteTokenProgram,
      baseAmount,
      expectedQuoteOut,
      minQuoteOut,
      slippagePct: slippage,
      priceImpactPct: computePriceImpactPct(expectedQuoteOut, marketCap),
    };
  }

  // ── buildBuyInstructions ────────────────────────────────────────────────────

  async buildBuyInstructions(params: {
    mint: PublicKey;
    user: PublicKey;
    quoteAmount: BN;
    slippagePct?: number;
  }): Promise<BuyResult> {
    const { mint, user, quoteAmount } = params;
    const slippage = params.slippagePct ?? 5;

    const baseTokenProgram = await this._baseTokenProgram(mint);
    const userAta = getAssociatedTokenAddressSync(mint, user, true, baseTokenProgram);

    // Single batch RPC: Global + FeeConfig + bondingCurve + userAta
    const bcAddr = bondingCurvePda(mint);
    const [globalInfo, feeConfigInfo, bcInfo, userAtaInfo] =
      await this.connection.getMultipleAccountsInfo([
        GLOBAL_PDA, PUMP_FEE_CONFIG_PDA, bcAddr, userAta,
      ]);

    if (!globalInfo) throw new Error("Global account not found: wrong network?");
    if (!bcInfo) throw new CoinNotFoundError(mint);

    const global = PUMP_SDK.decodeGlobal(globalInfo);
    const feeConfig = feeConfigInfo ? PUMP_SDK.decodeFeeConfig(feeConfigInfo) : null;
    const bondingCurve = PUMP_SDK.decodeBondingCurve(bcInfo);

    if (bondingCurve.complete) throw new CoinGraduatedError(mint);

    const quoteMint = resolveQuoteMintFromCurve(bondingCurve.quoteMint);
    this.quoteMintCache.set(mint.toBase58(), quoteMint);
    const quoteTokenProgram = await this._quoteTokenProgram(quoteMint);

    const mintSupply = bondingCurve.tokenTotalSupply;

    const expectedBaseTokens = getBuyTokenAmountFromSolAmount({
      global, feeConfig, mintSupply, bondingCurve, amount: quoteAmount, quoteMint,
    });

    if (expectedBaseTokens.lte(new BN(0))) {
      throw new InsufficientLiquidityError(
        "Computed token amount is zero: amount too small or reserves exhausted.",
      );
    }

    const preciseQuoteAmount = getBuySolAmountFromTokenAmount({
      global, feeConfig, mintSupply, bondingCurve, amount: expectedBaseTokens, quoteMint,
    });

    const mayhemMode = bondingCurve.isMayhemMode ?? false;
    const feeRecipient = pickFeeRecipient(global, mayhemMode);
    const buybackFeeRecipient = pickBuybackFeeRecipient();

    const instructions = await PUMP_SDK.buyV2Instructions({
      global,
      bondingCurveAccountInfo: bcInfo,
      bondingCurve,
      associatedUserAccountInfo: userAtaInfo ?? null,
      mint,
      user,
      amount: expectedBaseTokens,
      quoteAmount: preciseQuoteAmount,
      slippage,
      tokenProgram: baseTokenProgram,
      quoteTokenProgram,
    });

    return {
      instructions,
      quoteMint,
      quoteTokenProgram,
      expectedBaseTokens,
      preciseQuoteAmount,
      feeRecipient,
      buybackFeeRecipient,
    };
  }

  // ── buildSellInstructions ───────────────────────────────────────────────────

  async buildSellInstructions(params: {
    mint: PublicKey;
    user: PublicKey;
    baseAmount: BN;
    slippagePct?: number;
  }): Promise<SellResult> {
    const { mint, user, baseAmount } = params;
    const slippage = params.slippagePct ?? 5;

    const baseTokenProgram = await this._baseTokenProgram(mint);

    // Single batch RPC: Global + FeeConfig + bondingCurve
    const bcAddr = bondingCurvePda(mint);
    const [globalInfo, feeConfigInfo, bcInfo] =
      await this.connection.getMultipleAccountsInfo([
        GLOBAL_PDA, PUMP_FEE_CONFIG_PDA, bcAddr,
      ]);

    if (!globalInfo) throw new Error("Global account not found: wrong network?");
    if (!bcInfo) throw new CoinNotFoundError(mint);

    const global = PUMP_SDK.decodeGlobal(globalInfo);
    const feeConfig = feeConfigInfo ? PUMP_SDK.decodeFeeConfig(feeConfigInfo) : null;
    const bondingCurve = PUMP_SDK.decodeBondingCurve(bcInfo);

    if (bondingCurve.complete) throw new CoinGraduatedError(mint);

    const quoteMint = resolveQuoteMintFromCurve(bondingCurve.quoteMint);
    this.quoteMintCache.set(mint.toBase58(), quoteMint);
    const quoteTokenProgram = await this._quoteTokenProgram(quoteMint);

    const mintSupply = bondingCurve.tokenTotalSupply;

    const expectedQuoteOut = getSellSolAmountFromTokenAmount({
      global, feeConfig, mintSupply, bondingCurve, amount: baseAmount,
    });

    const instructions = await PUMP_SDK.sellV2Instructions({
      global,
      bondingCurveAccountInfo: bcInfo,
      bondingCurve,
      mint,
      user,
      amount: baseAmount,
      quoteAmount: expectedQuoteOut,
      slippage,
      tokenProgram: baseTokenProgram,
      quoteTokenProgram,
    });

    return { instructions, quoteMint, quoteTokenProgram, expectedQuoteOut };
  }

  // ── buildBuyExactQuoteInInstructions ────────────────────────────────────────

  /**
   * Build buy_exact_quote_in_v2. Drives the Anchor program directly because
   * the SDK has no JS helper for this instruction. Mirrors
   * swap/scripts/build-buy-exact-quote-in-v2-tx.mjs exactly.
   */
  async buildBuyExactQuoteInInstructions(params: {
    mint: PublicKey;
    user: PublicKey;
    spendableQuoteIn: BN;
    minBaseOut: BN;
  }): Promise<ExactQuoteResult> {
    const { mint, user, spendableQuoteIn, minBaseOut } = params;

    const baseTokenProgram = await this._baseTokenProgram(mint);

    // Single batch RPC: Global + FeeConfig + bondingCurve
    const bcAddr = bondingCurvePda(mint);
    const [globalInfo, feeConfigInfo, bcInfo] =
      await this.connection.getMultipleAccountsInfo([
        GLOBAL_PDA, PUMP_FEE_CONFIG_PDA, bcAddr,
      ]);

    if (!globalInfo) throw new Error("Global account not found: wrong network?");
    if (!bcInfo) throw new CoinNotFoundError(mint);

    const global = PUMP_SDK.decodeGlobal(globalInfo);
    const bondingCurve = PUMP_SDK.decodeBondingCurve(bcInfo);

    if (bondingCurve.complete) throw new CoinGraduatedError(mint);

    const quoteMint = resolveQuoteMintFromCurve(bondingCurve.quoteMint);
    this.quoteMintCache.set(mint.toBase58(), quoteMint);
    const quoteTokenProgram = await this._quoteTokenProgram(quoteMint);

    const creator = bondingCurve.creator;
    const mayhemMode = bondingCurve.isMayhemMode ?? false;

    const feeRecipient = pickFeeRecipient(global, mayhemMode);
    const buybackFeeRecipient = pickBuybackFeeRecipient();

    const ata = (owner: PublicKey, tkProg: PublicKey) =>
      getAssociatedTokenAddressSync(quoteMint, owner, true, tkProg);

    const associatedQuoteFeeRecipient = ata(feeRecipient, quoteTokenProgram);
    const associatedQuoteBuybackFeeRecipient = ata(buybackFeeRecipient, quoteTokenProgram);
    const associatedBaseBondingCurve = getAssociatedTokenAddressSync(
      mint, bcAddr, true, baseTokenProgram,
    );
    const associatedQuoteBondingCurve = ata(bcAddr, quoteTokenProgram);
    const associatedBaseUser = getAssociatedTokenAddressSync(
      mint, user, true, baseTokenProgram,
    );
    const associatedQuoteUser = ata(user, quoteTokenProgram);
    const creatorVault = creatorVaultPda(creator);
    const associatedCreatorVault = ata(creatorVault, quoteTokenProgram);
    const userVolAcc = userVolumeAccumulatorPda(user);
    const associatedUserVolumeAccumulator = ata(userVolAcc, quoteTokenProgram);

    const program = getPumpProgram(this.connection);
    const buyExactIx = await program.methods
      .buyExactQuoteInV2(spendableQuoteIn, minBaseOut, { 0: false })
      .accountsPartial({
        global: GLOBAL_PDA,
        baseMint: mint,
        quoteMint,
        baseTokenProgram,
        quoteTokenProgram,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        feeRecipient,
        associatedQuoteFeeRecipient,
        buybackFeeRecipient,
        associatedQuoteBuybackFeeRecipient,
        bondingCurve: bcAddr,
        associatedBaseBondingCurve,
        associatedQuoteBondingCurve,
        user,
        associatedBaseUser,
        associatedQuoteUser,
        creatorVault,
        associatedCreatorVault,
        sharingConfig: feeSharingConfigPda(mint),
        globalVolumeAccumulator: GLOBAL_VOLUME_ACCUMULATOR_PDA,
        userVolumeAccumulator: userVolAcc,
        associatedUserVolumeAccumulator,
        feeConfig: PUMP_FEE_CONFIG_PDA,
        feeProgram: PUMP_FEE_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        eventAuthority: PUMP_EVENT_AUTHORITY_PDA,
        program: PUMP_PROGRAM_ID,
      })
      .instruction();

    const isNative = quoteMint.equals(NATIVE_MINT);
    const ataIxs: TransactionInstruction[] = [
      createAssociatedTokenAccountIdempotentInstruction(
        user, associatedBaseUser, user, mint, baseTokenProgram,
      ),
      ...(isNative
        ? []
        : [
            createAssociatedTokenAccountIdempotentInstruction(
              user, associatedQuoteUser, user, quoteMint, quoteTokenProgram,
            ),
          ]),
    ];

    return {
      instructions: [...ataIxs, buyExactIx],
      quoteMint,
      quoteTokenProgram,
    };
  }

  // ── buildBuyV3Instructions ──────────────────────────────────────────────────

  /**
   * Build `buy_v3`: spend about `quoteAmount` (fees included) on the curve.
   * Same price and fees as `buildBuyInstructions` (buy_v2) with a 17-account
   * instruction; the protocol and creator fees stay on the curve until swept.
   *
   * A buy larger than the curve's remaining supply completes the curve and
   * buys the rest at the future pool's price (`completesCurve` in the
   * result). `partialFill` matters only on a mayhem curve, which has no such
   * leg: set, the buy stops at the remaining supply; unset, it fails with
   * 6021 `NotEnoughTokensToBuy`.
   *
   * @throws CashbackCoinNotSupportedError (from @pump-fun/pump-sdk) for a
   *   cashback coin; use `buildBuyInstructions` for those.
   */
  async buildBuyV3Instructions(params: {
    mint: PublicKey;
    user: PublicKey;
    quoteAmount: BN;
    slippagePct?: number;
    partialFill?: boolean;
  }): Promise<BuyV3Result> {
    const { mint, user, quoteAmount } = params;
    const slippage = params.slippagePct ?? 5;
    const state = await this._fetchV3BuyState(mint, user);
    const { global, feeConfig, bondingCurve, curveBaseTokenBalance } = state;
    const mintSupply = bondingCurve.tokenTotalSupply;

    const expectedBaseTokens = getBuyV3TokenAmountFromQuoteAmount({
      global, feeConfig, mintSupply, bondingCurve, amount: quoteAmount, curveBaseTokenBalance,
    });
    if (expectedBaseTokens.lte(new BN(0))) {
      throw new InsufficientLiquidityError(
        "Computed token amount is zero: amount too small or reserves exhausted.",
      );
    }
    const preciseQuoteAmount = getBuyV3QuoteAmountFromTokenAmount({
      global, feeConfig, mintSupply, bondingCurve, amount: expectedBaseTokens, curveBaseTokenBalance,
    });

    const buybackFeeRecipient = pickGlobalBuybackFeeRecipient(global);
    const instructions = await PUMP_SDK.buyV3Instructions({
      bondingCurve,
      associatedUserAccountInfo: state.userAtaInfo,
      mint,
      user,
      amount: expectedBaseTokens,
      quoteAmount: preciseQuoteAmount,
      slippage,
      tokenProgram: state.baseTokenProgram,
      quoteTokenProgram: state.quoteTokenProgram,
      partialFill: params.partialFill,
      buybackFeeRecipient,
    });

    return {
      instructions,
      quoteMint: state.quoteMint,
      quoteTokenProgram: state.quoteTokenProgram,
      expectedBaseTokens,
      preciseQuoteAmount,
      buybackFeeRecipient,
      completesCurve: expectedBaseTokens.gt(bondingCurve.realTokenReserves),
    };
  }

  // ── buildBuyExactQuoteInV3Instructions ──────────────────────────────────────

  /**
   * Build `buy_exact_quote_in_v3`: spend exactly up to `spendableQuoteIn`
   * (fees included) and require at least the quoted tokens less
   * `slippagePct`. Fees and the curve-completing behaviour are as in
   * `buildBuyV3Instructions`.
   *
   * @throws CashbackCoinNotSupportedError (from @pump-fun/pump-sdk) for a
   *   cashback coin; use `buildBuyExactQuoteInInstructions` for those.
   */
  async buildBuyExactQuoteInV3Instructions(params: {
    mint: PublicKey;
    user: PublicKey;
    spendableQuoteIn: BN;
    slippagePct?: number;
    partialFill?: boolean;
  }): Promise<BuyV3Result> {
    const { mint, user, spendableQuoteIn } = params;
    const slippage = params.slippagePct ?? 5;
    const state = await this._fetchV3BuyState(mint, user);
    const { global, feeConfig, bondingCurve, curveBaseTokenBalance } = state;

    const expectedBaseTokens = getBuyV3TokenAmountFromQuoteAmount({
      global,
      feeConfig,
      mintSupply: bondingCurve.tokenTotalSupply,
      bondingCurve,
      amount: spendableQuoteIn,
      curveBaseTokenBalance,
    });
    if (expectedBaseTokens.lte(new BN(0))) {
      throw new InsufficientLiquidityError(
        "Computed token amount is zero: amount too small or reserves exhausted.",
      );
    }

    const buybackFeeRecipient = pickGlobalBuybackFeeRecipient(global);
    const instructions = await PUMP_SDK.buyExactQuoteInV3Instructions({
      bondingCurve,
      associatedUserAccountInfo: state.userAtaInfo,
      mint,
      user,
      amount: expectedBaseTokens,
      quoteAmount: spendableQuoteIn,
      slippage,
      tokenProgram: state.baseTokenProgram,
      quoteTokenProgram: state.quoteTokenProgram,
      partialFill: params.partialFill,
      buybackFeeRecipient,
    });

    return {
      instructions,
      quoteMint: state.quoteMint,
      quoteTokenProgram: state.quoteTokenProgram,
      expectedBaseTokens,
      preciseQuoteAmount: spendableQuoteIn,
      buybackFeeRecipient,
      completesCurve: expectedBaseTokens.gt(bondingCurve.realTokenReserves),
    };
  }

  // ── buildSellV3Instructions ─────────────────────────────────────────────────

  /**
   * Build `sell_v3`: sell `baseAmount` for at least the quoted output less
   * `slippagePct`. Same price and fees as `buildSellInstructions` (sell_v2).
   *
   * @throws CashbackCoinNotSupportedError (from @pump-fun/pump-sdk) for a
   *   cashback coin; use `buildSellInstructions` for those.
   */
  async buildSellV3Instructions(params: {
    mint: PublicKey;
    user: PublicKey;
    baseAmount: BN;
    slippagePct?: number;
  }): Promise<SellV3Result> {
    const { mint, user, baseAmount } = params;
    const slippage = params.slippagePct ?? 5;

    const baseTokenProgram = await this._baseTokenProgram(mint);
    const { global, feeConfig, bondingCurve, quoteMint, quoteTokenProgram } =
      await this._fetchAndDecode(mint);

    const expectedQuoteOut = getSellSolAmountFromTokenAmount({
      global,
      feeConfig,
      mintSupply: bondingCurve.tokenTotalSupply,
      bondingCurve,
      amount: baseAmount,
    });

    const buybackFeeRecipient = pickGlobalBuybackFeeRecipient(global);
    const instructions = await PUMP_SDK.sellV3Instructions({
      bondingCurve,
      mint,
      user,
      amount: baseAmount,
      quoteAmount: expectedQuoteOut,
      slippage,
      tokenProgram: baseTokenProgram,
      quoteTokenProgram,
      buybackFeeRecipient,
    });

    return {
      instructions,
      quoteMint,
      quoteTokenProgram,
      expectedQuoteOut,
      buybackFeeRecipient,
    };
  }

  // ── buildMultiHopSwapInstructions ───────────────────────────────────────────

  /**
   * Build a PumpSwap `multi_hop_swap` along `path` (mints in trade order):
   * a buy climbs a quote chain (`[SOL, A, B]`: A quoted in SOL, B quoted in
   * A), a sell walks it down (`[B, A, SOL]`). Each hop uses the coin's
   * bonding curve while it trades, else its canonical pool. No intermediate
   * token account is created and fees are charged once, not per hop.
   *
   * The route is simulated for `user` (who must hold `amountIn` of the
   * input) to quote `expectedAmountOut`; `minAmountOut` is that less
   * `slippagePct`. The instructions start with a compute-unit limit sized
   * for the route, create the token accounts, and wrap / unwrap SOL. Routes
   * longer than three hops need a v0 transaction with `addressLookupTables`.
   *
   * Throws when a hop has no tradable venue, a hop is in mayhem mode (6108),
   * or a cashback coin sits on the creator-fee leg.
   */
  async buildMultiHopSwapInstructions(params: {
    user: PublicKey;
    path: PublicKey[];
    side: "buy" | "sell";
    amountIn: BN;
    slippagePct?: number;
    addressLookupTables?: AddressLookupTableAccount[];
  }): Promise<MultiHopSwapResult> {
    const { user, path, side, amountIn } = params;
    const slippage = params.slippagePct ?? 5;
    if (path.length < 2) {
      throw new Error("multi-hop path needs at least two mints (input and output).");
    }

    const online = new OnlinePumpSdk(this.connection);
    const hops = await online.resolveMultiHopRoute(path, side);
    const expectedAmountOut = await online.simulateMultiHopSwap({
      user,
      hops,
      side,
      amountIn,
      addressLookupTables: params.addressLookupTables,
    });
    if (expectedAmountOut.lte(new BN(0))) {
      throw new InsufficientLiquidityError(
        "Simulated multi-hop output is zero: amount too small for the route.",
      );
    }
    const minAmountOut = lessSlippage(expectedAmountOut, slippage);

    const swapIxs = await PUMP_SDK.multiHopSwapInstructions({
      user,
      hops,
      side,
      amountIn,
      minAmountOut,
    });
    const units = Math.min(
      MAX_COMPUTE_UNITS,
      MULTI_HOP_CU_BASE + MULTI_HOP_CU_PER_HOP * hops.length,
    );
    const ends = multiHopRouteEnds(hops, side);

    return {
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units }), ...swapIxs],
      hops: [...hops],
      side,
      inputMint: ends.input.mint,
      outputMint: ends.output.mint,
      expectedAmountOut,
      minAmountOut,
    };
  }

  // ── buildSweepCurveFeesInstructions ─────────────────────────────────────────

  /**
   * Build the permissionless sweeps for the fees v3 trades left on a curve:
   * `sweep_protocol_fee` (to a `Global` fee recipient) and `sweep_creator_fee`
   * (to the creator vault of `bondingCurve.creator`). Only nonzero buckets
   * get an instruction; `buckets` limits which are considered.
   *
   * Put the creator sweep first, in the same transaction, in front of every
   * creator-fee claim or distribution, `admin_cto` and fee-sharing change:
   * those fail with 6095 `CreatorFeesNotSwept` while the bucket is nonzero.
   * Works on complete and migrated curves.
   */
  async buildSweepCurveFeesInstructions(params: {
    payer: PublicKey;
    mint: PublicKey;
    buckets?: ReadonlyArray<"protocol" | "creator">;
  }): Promise<SweepCurveFeesResult> {
    const { payer, mint } = params;
    const buckets = new Set(params.buckets ?? ["protocol", "creator"]);

    const [globalInfo, bcInfo] = await this.connection.getMultipleAccountsInfo([
      GLOBAL_PDA, bondingCurvePda(mint),
    ]);
    if (!globalInfo) throw new Error("Global account not found: wrong network?");
    if (!bcInfo) throw new CoinNotFoundError(mint);

    const global = PUMP_SDK.decodeGlobal(globalInfo);
    const bondingCurve = PUMP_SDK.decodeBondingCurve(bcInfo);
    const quoteMint = resolveQuoteMintFromCurve(bondingCurve.quoteMint);
    this.quoteMintCache.set(mint.toBase58(), quoteMint);
    const quoteTokenProgram = await this._quoteTokenProgram(quoteMint);

    const instructions: TransactionInstruction[] = [];
    if (buckets.has("protocol") && !bondingCurve.protocolFees.isZero()) {
      instructions.push(
        await PUMP_SDK.sweepProtocolFeeInstruction({
          payer,
          mint,
          recipient: getFeeRecipient(global, bondingCurve.isMayhemMode),
          quoteMint,
          quoteTokenProgram,
        }),
      );
    }
    if (buckets.has("creator") && !bondingCurve.creatorFee.isZero()) {
      instructions.push(
        await PUMP_SDK.sweepCreatorFeeInstruction({
          payer,
          mint,
          creator: bondingCurve.creator,
          quoteMint,
          quoteTokenProgram,
        }),
      );
    }

    return {
      instructions,
      quoteMint,
      quoteTokenProgram,
      protocolFees: bondingCurve.protocolFees,
      creatorFee: bondingCurve.creatorFee,
      creator: bondingCurve.creator,
    };
  }

  // ── buildClaimCashbackInstructions ──────────────────────────────────────────

  /**
   * Auto-discovers claimable quote mints by calling getTokenAccountsByOwner on
   * the UserVolumeAccumulator PDA. Any non-zero ATA → claimable cashback.
   * Pass quoteMints to skip discovery.
   */
  async buildClaimCashbackInstructions(params: {
    user: PublicKey;
    quoteMints?: PublicKey[];
  }): Promise<TransactionInstruction[]> {
    const { user } = params;
    let quoteMints = params.quoteMints;

    if (!quoteMints) {
      quoteMints = await this._discoverCashbackMints(user);
    }

    const ixs: TransactionInstruction[] = [];
    for (const quoteMint of quoteMints) {
      const quoteTokenProgram = await this._quoteTokenProgram(quoteMint);
      ixs.push(
        await PUMP_SDK.claimCashbackV2Instruction({
          user,
          quoteMint,
          quoteTokenProgram,
        }),
      );
    }
    return ixs;
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private async _discoverCashbackMints(user: PublicKey): Promise<PublicKey[]> {
    const userVolAcc = userVolumeAccumulatorPda(user);
    const [splResult, t22Result] = await Promise.all([
      this.connection.getTokenAccountsByOwner(userVolAcc, {
        programId: TOKEN_PROGRAM_ID,
      }),
      this.connection.getTokenAccountsByOwner(userVolAcc, {
        programId: TOKEN_2022_PROGRAM_ID,
      }),
    ]);

    const mints: PublicKey[] = [];
    for (const { account } of [...splResult.value, ...t22Result.value]) {
      // SPL token account layout: mint = bytes 0..31, amount = bytes 64..71 (LE u64)
      const mintPk = new PublicKey(account.data.slice(0, 32));
      const amount = account.data.readBigUInt64LE(64);
      if (amount > 0n) mints.push(mintPk);
    }
    return mints;
  }

  private async _baseTokenProgram(mint: PublicKey): Promise<PublicKey> {
    const cacheKey = `base:${mint.toBase58()}`;
    const cached = this.tokenProgramCache.get(cacheKey);
    if (cached) return cached;
    const info = await this.connection.getAccountInfo(mint);
    if (!info) throw new Error(`Mint account not found: ${mint.toBase58()}`);
    const program = KNOWN_TOKEN_PROGRAMS.has(info.owner.toBase58())
      ? info.owner
      : TOKEN_PROGRAM_ID;
    this.tokenProgramCache.set(cacheKey, program);
    return program;
  }

  private async _quoteTokenProgram(quoteMint: PublicKey): Promise<PublicKey> {
    if (quoteMint.equals(NATIVE_MINT)) return TOKEN_PROGRAM_ID;
    const key = quoteMint.toBase58();
    const cached = this.tokenProgramCache.get(key);
    if (cached) return cached;
    const info = await this.connection.getAccountInfo(quoteMint, "confirmed");
    if (!info) throw new Error(`Quote mint not found: ${quoteMint.toBase58()}`);
    if (!KNOWN_TOKEN_PROGRAMS.has(info.owner.toBase58())) {
      throw new UnsupportedQuoteMintError(quoteMint);
    }
    this.tokenProgramCache.set(key, info.owner);
    return info.owner;
  }

  /**
   * State for a v3 buy in one batch: Global, FeeConfig (required by v3),
   * the curve, the user's base ATA and the curve's base ATA, whose balance
   * prices the post-completion leg.
   */
  private async _fetchV3BuyState(mint: PublicKey, user: PublicKey) {
    const baseTokenProgram = await this._baseTokenProgram(mint);
    const bcAddr = bondingCurvePda(mint);
    const userAta = getAssociatedTokenAddressSync(mint, user, true, baseTokenProgram);
    const curveBaseAta = getAssociatedTokenAddressSync(mint, bcAddr, true, baseTokenProgram);

    const [globalInfo, feeConfigInfo, bcInfo, userAtaInfo, curveBaseAtaInfo] =
      await this.connection.getMultipleAccountsInfo([
        GLOBAL_PDA, PUMP_FEE_CONFIG_PDA, bcAddr, userAta, curveBaseAta,
      ]);

    if (!globalInfo) throw new Error("Global account not found: wrong network?");
    if (!feeConfigInfo) throw new FeeConfigNotFoundError();
    if (!bcInfo) throw new CoinNotFoundError(mint);

    const global = PUMP_SDK.decodeGlobal(globalInfo);
    const feeConfig = PUMP_SDK.decodeFeeConfig(feeConfigInfo);
    const bondingCurve = PUMP_SDK.decodeBondingCurve(bcInfo);
    if (bondingCurve.complete) throw new CoinGraduatedError(mint);

    const quoteMint = resolveQuoteMintFromCurve(bondingCurve.quoteMint);
    this.quoteMintCache.set(mint.toBase58(), quoteMint);
    const quoteTokenProgram = await this._quoteTokenProgram(quoteMint);

    return {
      global,
      feeConfig,
      bondingCurve,
      baseTokenProgram,
      quoteMint,
      quoteTokenProgram,
      userAtaInfo: userAtaInfo ?? null,
      curveBaseTokenBalance: tokenAccountAmount(curveBaseAtaInfo ?? null),
    };
  }

  /**
   * Convenience: fetch + decode + throw in one call for quote methods.
   * Does NOT batch with userAta (quote methods don't need it).
   */
  private async _fetchAndDecode(mint: PublicKey) {
    const bcAddr = bondingCurvePda(mint);
    const [globalInfo, feeConfigInfo, bcInfo] =
      await this.connection.getMultipleAccountsInfo([
        GLOBAL_PDA, PUMP_FEE_CONFIG_PDA, bcAddr,
      ]);

    if (!globalInfo) throw new Error("Global account not found: wrong network?");
    if (!bcInfo) throw new CoinNotFoundError(mint);

    const global = PUMP_SDK.decodeGlobal(globalInfo);
    const feeConfig = feeConfigInfo ? PUMP_SDK.decodeFeeConfig(feeConfigInfo) : null;
    const bondingCurve = PUMP_SDK.decodeBondingCurve(bcInfo);

    if (bondingCurve.complete) throw new CoinGraduatedError(mint);

    const quoteMint = resolveQuoteMintFromCurve(bondingCurve.quoteMint);
    this.quoteMintCache.set(mint.toBase58(), quoteMint);
    const quoteTokenProgram = await this._quoteTokenProgram(quoteMint);

    return { global, feeConfig, bondingCurve, quoteMint, quoteTokenProgram };
  }

  /** Exported for convenience; USDC mainnet address. */
  static readonly USDC_MINT = USDC_MINT;
}
