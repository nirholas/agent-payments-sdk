// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
// All rights reserved.

import { BN } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  TransactionInstruction,
  type Connection,
} from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { buy, sell, exact, claim, getWhitelist } = vi.hoisted(() => ({
  buy: vi.fn(),
  sell: vi.fn(),
  exact: vi.fn(),
  claim: vi.fn(),
  getWhitelist: vi.fn(),
}));

vi.mock("../PumpTradeClient.js", () => ({
  PumpTradeClient: class {
    buildBuyInstructions = buy;
    buildSellInstructions = sell;
    buildBuyExactQuoteInInstructions = exact;
    buildClaimCashbackInstructions = claim;
  },
}));

vi.mock("../WhitelistMonitor.js", () => ({
  WhitelistMonitor: { getCurrentWhitelist: getWhitelist },
}));

import {
  allActions,
  pumpBuyAction,
  pumpBuyExactQuoteInAction,
  pumpCheckUsdcWhitelistAction,
  pumpClaimCashbackAction,
  pumpSellAction,
} from "./actions.js";
import type { SolanaAgentKitLike } from "./types.js";

const SOL = new PublicKey("So11111111111111111111111111111111111111112");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const MINT = Keypair.generate().publicKey;
const WALLET = Keypair.generate().publicKey;

const connection = {} as Connection;
const kit: SolanaAgentKitLike = {
  connection,
  wallet: Keypair.generate(),
  wallet_address: WALLET,
};

function ix(): TransactionInstruction {
  return new TransactionInstruction({
    programId: MINT,
    keys: [{ pubkey: WALLET, isSigner: true, isWritable: true }],
    data: Buffer.from([1, 2, 3]),
  });
}

beforeEach(() => vi.resetAllMocks());

describe("pump trade actions", () => {
  it("registers every trade action on the plugin action list", () => {
    const names = allActions.map((a) => a.name);
    for (const n of [
      "pump_buy",
      "pump_sell",
      "pump_buy_exact_quote_in",
      "pump_claim_cashback",
      "pump_check_usdc_whitelist",
    ]) {
      expect(names).toContain(n);
    }
    expect(new Set(names).size).toBe(names.length);
  });

  it("pump_buy passes the wallet as user and serializes the instructions", async () => {
    buy.mockResolvedValue({
      instructions: [ix()],
      quoteMint: USDC,
      expectedBaseTokens: new BN(42),
    });
    const input = pumpBuyAction.schema.parse({
      mint: MINT.toBase58(),
      quoteAmount: "1000000",
    });
    const out = await pumpBuyAction.handler(kit, input);

    expect(buy).toHaveBeenCalledWith({
      mint: MINT,
      user: WALLET,
      quoteAmount: new BN("1000000"),
      slippagePct: 5,
    });
    expect(out.quoteMint).toBe(USDC.toBase58());
    expect(out.expectedBaseTokens).toBe("42");
    expect(out.instructions[0].data).toBe(Buffer.from([1, 2, 3]).toString("base64"));
    expect(out.instructions[0].keys[0]).toEqual({
      pubkey: WALLET.toBase58(),
      isSigner: true,
      isWritable: true,
    });
  });

  it("pump_sell returns the expected quote out", async () => {
    sell.mockResolvedValue({
      instructions: [ix()],
      quoteMint: SOL,
      expectedQuoteOut: new BN(7),
    });
    const out = await pumpSellAction.handler(
      kit,
      pumpSellAction.schema.parse({
        mint: MINT.toBase58(),
        baseAmount: "500",
        slippagePct: 1,
      }),
    );
    expect(sell).toHaveBeenCalledWith({
      mint: MINT,
      user: WALLET,
      baseAmount: new BN(500),
      slippagePct: 1,
    });
    expect(out.expectedQuoteOut).toBe("7");
    expect(out.quoteMint).toBe(SOL.toBase58());
  });

  it("pump_buy_exact_quote_in forwards spend and floor", async () => {
    exact.mockResolvedValue({ instructions: [ix()], quoteMint: SOL });
    const out = await pumpBuyExactQuoteInAction.handler(kit, {
      mint: MINT.toBase58(),
      spendableQuoteIn: "900",
      minBaseOut: "10",
    });
    expect(exact).toHaveBeenCalledWith({
      mint: MINT,
      user: WALLET,
      spendableQuoteIn: new BN(900),
      minBaseOut: new BN(10),
    });
    expect(out.instructions).toHaveLength(1);
  });

  it("pump_claim_cashback discovers mints by default and honours an explicit one", async () => {
    claim.mockResolvedValue([ix(), ix()]);
    const all = await pumpClaimCashbackAction.handler(kit, {});
    expect(claim).toHaveBeenLastCalledWith({ user: WALLET, quoteMints: undefined });
    expect(all.instructions).toHaveLength(2);

    await pumpClaimCashbackAction.handler(kit, { quoteMint: USDC.toBase58() });
    expect(claim).toHaveBeenLastCalledWith({ user: WALLET, quoteMints: [USDC] });
  });

  it("pump_check_usdc_whitelist reports membership of the live whitelist", async () => {
    getWhitelist.mockResolvedValueOnce([SOL, USDC]);
    expect(await pumpCheckUsdcWhitelistAction.handler(kit, {})).toEqual({
      whitelisted: true,
      currentWhitelist: [SOL.toBase58(), USDC.toBase58()],
    });

    getWhitelist.mockResolvedValueOnce([PublicKey.default]);
    const out = await pumpCheckUsdcWhitelistAction.handler(kit, {});
    expect(out.whitelisted).toBe(false);
  });

  it("surfaces trade-client failures to the caller", async () => {
    buy.mockRejectedValue(new Error("coin graduated"));
    await expect(
      pumpBuyAction.handler(kit, { mint: MINT.toBase58(), quoteAmount: "1", slippagePct: 5 }),
    ).rejects.toThrow("coin graduated");
  });
});
