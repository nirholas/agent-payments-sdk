// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
// All rights reserved.

/**
 * PumpTradeClient v3 / sweep / multi-hop tests against real mainnet state.
 *
 * Unlike PumpTradeClient.test.ts, nothing in @pump-fun/pump-sdk is mocked:
 * the real PUMP_SDK builders run over account snapshots taken from mainnet
 * (fixtures/pump-accounts/sol-curve.json: Global, FeeConfig, a SOL-quoted
 * bonding curve with nonzero v3 fee buckets, its Token-2022 mint and the
 * curve's base ATA). The Connection only serves those bytes by address.
 *
 * multi_hop_swap needs a live simulation, so only the two OnlinePumpSdk
 * RPC-bound calls (resolveMultiHopRoute, simulateMultiHopSwap) are stubbed;
 * the instruction itself is still built by the real SDK.
 */

import { BN } from "@coral-xyz/anchor";
import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  AccountInfo,
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  OnlinePumpSdk,
  PUMP_AMM_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  type MultiHopHop,
} from "@pump-fun/pump-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import pumpIdl from "./idl/pump.json";
import ammIdl from "../../pump-public-docs/idl/pump_amm.json";
import solCurve from "./fixtures/pump-accounts/sol-curve.json";
import {
  CoinNotFoundError,
  FeeConfigNotFoundError,
  PumpTradeClient,
} from "./PumpTradeClient";

// ─── Fixture-backed Connection ───────────────────────────────────────────────

type FixtureAccount = { address: string; owner: string; lamports: number; data: string };

function toAccountInfo(a: FixtureAccount): AccountInfo<Buffer> {
  return {
    data: Buffer.from(a.data, "base64"),
    executable: false,
    lamports: a.lamports,
    owner: new PublicKey(a.owner),
    rentEpoch: 0,
  };
}

function fixtureConnection(omit: string[] = []): Connection {
  const byAddress = new Map<string, AccountInfo<Buffer>>();
  for (const [name, account] of Object.entries(solCurve.accounts)) {
    if (omit.includes(name)) continue;
    byAddress.set(account.address, toAccountInfo(account));
  }
  const lookup = (k: PublicKey) => byAddress.get(k.toBase58()) ?? null;
  return {
    getAccountInfo: async (k: PublicKey) => lookup(k),
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map(lookup),
  } as unknown as Connection;
}

const MINT = new PublicKey(solCurve.accounts.mint.address);
const CURVE = new PublicKey(solCurve.accounts.bondingCurve.address);
const USER = new PublicKey("DRiP2Pn2K6fuMLKQmt5rZWyHiUZ6WK3GChEySUpHSS4");

function idlDisc(idl: { instructions: { name: string; discriminator: number[] }[] }, name: string) {
  const ix = idl.instructions.find((i) => i.name === name);
  if (!ix) throw new Error(`IDL has no instruction ${name}`);
  return Buffer.from(ix.discriminator);
}

function findByDisc(ixs: TransactionInstruction[], programId: PublicKey, disc: Buffer) {
  return ixs.filter(
    (ix) => ix.programId.equals(programId) && ix.data.subarray(0, 8).equals(disc),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── buy_v3 / buy_exact_quote_in_v3 / sell_v3 ────────────────────────────────

describe("PumpTradeClient v3 trades (real SDK, mainnet snapshot)", () => {
  it("buildBuyV3Instructions emits one 17-account buy_v3 with a listed buyback wallet", async () => {
    const client = new PumpTradeClient(fixtureConnection());
    const res = await client.buildBuyV3Instructions({
      mint: MINT,
      user: USER,
      quoteAmount: new BN(10_000_000), // 0.01 SOL
      slippagePct: 2,
    });

    const buys = findByDisc(res.instructions, PUMP_PROGRAM_ID, idlDisc(pumpIdl, "buy_v3"));
    expect(buys).toHaveLength(1);
    expect(buys[0]!.keys).toHaveLength(17);
    expect(buys[0]!.keys.some((k) => k.pubkey.equals(CURVE))).toBe(true);

    expect(res.quoteMint.equals(NATIVE_MINT)).toBe(true);
    expect(res.quoteTokenProgram.equals(TOKEN_PROGRAM_ID)).toBe(true);
    expect(res.expectedBaseTokens.gt(new BN(0))).toBe(true);
    expect(res.preciseQuoteAmount.gt(new BN(0))).toBe(true);
    expect(res.preciseQuoteAmount.lte(new BN(10_000_000))).toBe(true);
    expect(res.completesCurve).toBe(false);
    expect(
      buys[0]!.keys.some((k) => k.pubkey.equals(res.buybackFeeRecipient)),
    ).toBe(true);
  });

  it("buildBuyExactQuoteInV3Instructions spends exactly the given quote", async () => {
    const client = new PumpTradeClient(fixtureConnection());
    const spend = new BN(25_000_000);
    const res = await client.buildBuyExactQuoteInV3Instructions({
      mint: MINT,
      user: USER,
      spendableQuoteIn: spend,
    });

    const ixs = findByDisc(
      res.instructions,
      PUMP_PROGRAM_ID,
      idlDisc(pumpIdl, "buy_exact_quote_in_v3"),
    );
    expect(ixs).toHaveLength(1);
    expect(ixs[0]!.keys).toHaveLength(17);
    // args: spendable_quote_in u64 at byte 8.
    expect(new BN(ixs[0]!.data.subarray(8, 16), "le").eq(spend)).toBe(true);
    expect(res.preciseQuoteAmount.eq(spend)).toBe(true);
    expect(res.expectedBaseTokens.gt(new BN(0))).toBe(true);
  });

  it("buildSellV3Instructions emits one 17-account sell_v3 for a Token-2022 coin", async () => {
    const client = new PumpTradeClient(fixtureConnection());
    const res = await client.buildSellV3Instructions({
      mint: MINT,
      user: USER,
      baseAmount: new BN(1_000_000_000_000), // 1M tokens (6 decimals)
    });

    const sells = findByDisc(res.instructions, PUMP_PROGRAM_ID, idlDisc(pumpIdl, "sell_v3"));
    expect(sells).toHaveLength(1);
    expect(sells[0]!.keys).toHaveLength(17);
    expect(sells[0]!.keys.some((k) => k.pubkey.equals(TOKEN_2022_PROGRAM_ID))).toBe(true);
    expect(res.expectedQuoteOut.gt(new BN(0))).toBe(true);
  });

  it("throws FeeConfigNotFoundError when the fee config is missing", async () => {
    const client = new PumpTradeClient(fixtureConnection(["feeConfig"]));
    await expect(
      client.buildBuyV3Instructions({ mint: MINT, user: USER, quoteAmount: new BN(1_000_000) }),
    ).rejects.toBeInstanceOf(FeeConfigNotFoundError);
  });

  it("throws CoinNotFoundError when the bonding curve is missing", async () => {
    const client = new PumpTradeClient(fixtureConnection(["bondingCurve"]));
    await expect(
      client.buildBuyV3Instructions({ mint: MINT, user: USER, quoteAmount: new BN(1_000_000) }),
    ).rejects.toBeInstanceOf(CoinNotFoundError);
  });
});

// ─── sweep_protocol_fee / sweep_creator_fee ──────────────────────────────────

describe("PumpTradeClient.buildSweepCurveFeesInstructions", () => {
  it("sweeps both nonzero buckets, protocol first", async () => {
    const client = new PumpTradeClient(fixtureConnection());
    const res = await client.buildSweepCurveFeesInstructions({ payer: USER, mint: MINT });

    expect(res.protocolFees.gt(new BN(0))).toBe(true);
    expect(res.creatorFee.gt(new BN(0))).toBe(true);
    expect(res.instructions).toHaveLength(2);
    expect(
      res.instructions[0]!.data.subarray(0, 8).equals(idlDisc(pumpIdl, "sweep_protocol_fee")),
    ).toBe(true);
    expect(
      res.instructions[1]!.data.subarray(0, 8).equals(idlDisc(pumpIdl, "sweep_creator_fee")),
    ).toBe(true);
    for (const ix of res.instructions) {
      expect(ix.programId.equals(PUMP_PROGRAM_ID)).toBe(true);
      expect(ix.keys.some((k) => k.pubkey.equals(CURVE))).toBe(true);
    }
  });

  it("honours the buckets filter", async () => {
    const client = new PumpTradeClient(fixtureConnection());
    const res = await client.buildSweepCurveFeesInstructions({
      payer: USER,
      mint: MINT,
      buckets: ["creator"],
    });
    expect(res.instructions).toHaveLength(1);
    expect(
      res.instructions[0]!.data.subarray(0, 8).equals(idlDisc(pumpIdl, "sweep_creator_fee")),
    ).toBe(true);
  });
});

// ─── multi_hop_swap ──────────────────────────────────────────────────────────

describe("PumpTradeClient.buildMultiHopSwapInstructions", () => {
  const hop: MultiHopHop = {
    venue: "curve",
    baseMint: MINT,
    quoteMint: NATIVE_MINT,
    baseTokenProgram: TOKEN_2022_PROGRAM_ID,
    quoteTokenProgram: TOKEN_PROGRAM_ID,
  };

  it("builds a CU-budgeted multi_hop_swap with minAmountOut = simulated out less slippage", async () => {
    const resolve = vi
      .spyOn(OnlinePumpSdk.prototype, "resolveMultiHopRoute")
      .mockResolvedValue([hop]);
    vi.spyOn(OnlinePumpSdk.prototype, "simulateMultiHopSwap").mockResolvedValue(
      new BN(1_000_000_000),
    );

    const client = new PumpTradeClient(fixtureConnection());
    const res = await client.buildMultiHopSwapInstructions({
      user: USER,
      path: [NATIVE_MINT, MINT],
      side: "buy",
      amountIn: new BN(10_000_000),
      slippagePct: 1.5,
    });

    expect(resolve).toHaveBeenCalledWith([NATIVE_MINT, MINT], "buy");
    expect(res.expectedAmountOut.eq(new BN(1_000_000_000))).toBe(true);
    expect(res.minAmountOut.eq(new BN(985_000_000))).toBe(true);
    expect(res.inputMint.equals(NATIVE_MINT)).toBe(true);
    expect(res.outputMint.equals(MINT)).toBe(true);

    const first = res.instructions[0]!;
    expect(first.programId.equals(ComputeBudgetProgram.programId)).toBe(true);
    // SetComputeUnitLimit: [2, u32 units]; 100k base + 200k for one hop.
    expect(first.data[0]).toBe(2);
    expect(first.data.readUInt32LE(1)).toBe(300_000);

    const swaps = findByDisc(
      res.instructions,
      PUMP_AMM_PROGRAM_ID,
      idlDisc(ammIdl, "multi_hop_swap"),
    );
    expect(swaps).toHaveLength(1);
    // 16 fixed accounts plus 5 per hop.
    expect(swaps[0]!.keys).toHaveLength(21);
  });

  it("rejects a path shorter than two mints before touching RPC", async () => {
    const resolve = vi.spyOn(OnlinePumpSdk.prototype, "resolveMultiHopRoute");
    const client = new PumpTradeClient(fixtureConnection());
    await expect(
      client.buildMultiHopSwapInstructions({
        user: USER,
        path: [MINT],
        side: "sell",
        amountIn: new BN(1),
      }),
    ).rejects.toThrow(/at least two mints/);
    expect(resolve).not.toHaveBeenCalled();
  });
});
