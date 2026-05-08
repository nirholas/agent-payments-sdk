import { describe, it, expect, vi, beforeEach } from "vitest";
import { PublicKey, Connection, Keypair } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";

// vi.hoisted runs before vi.mock hoisting; use it to share mock fn refs
const {
  mockBuildBuyInstructions,
  mockBuildSellInstructions,
  mockBuildBuyExactQuoteInInstructions,
  mockBuildClaimCashbackInstructions,
  mockCreateV2AndBuyV2,
} = vi.hoisted(() => ({
  mockBuildBuyInstructions: vi.fn(),
  mockBuildSellInstructions: vi.fn(),
  mockBuildBuyExactQuoteInInstructions: vi.fn(),
  mockBuildClaimCashbackInstructions: vi.fn(),
  mockCreateV2AndBuyV2: vi.fn(),
}));

vi.mock("../PumpTradeClient.js", () => {
  const USDC_MINT = new PublicKey(
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  );
  class PumpTradeClientMock {
    buildBuyInstructions = mockBuildBuyInstructions;
    buildSellInstructions = mockBuildSellInstructions;
    buildBuyExactQuoteInInstructions = mockBuildBuyExactQuoteInInstructions;
    buildClaimCashbackInstructions = mockBuildClaimCashbackInstructions;
  }
  return {
    USDC_MINT,
    PumpTradeClient: PumpTradeClientMock,
    PUMP_SDK: { createV2AndBuyV2Instructions: mockCreateV2AndBuyV2 },
  };
});

vi.mock("../WhitelistMonitor.js", () => ({
  WhitelistMonitor: {
    isWhitelisted: vi.fn(),
    getCurrentWhitelist: vi.fn(),
  },
}));

import {
  pumpBuyV2Action,
  pumpSellV2Action,
  pumpCheckUsdcWhitelistAction,
  pumpCreateUsdcCoinAction,
} from "./actions.js";
import { WhitelistMonitor } from "../WhitelistMonitor.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const USDC_MINT_ADDR = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TEST_MINT = "3DHMBKxDWR5jVmLv62qBHfhpPBhqGGqrJww8YkQcqJXf";
// 32 all-zero bytes encoded in base58 = 32 '1' chars; valid blockhash shape
const ZERO_BLOCKHASH = "11111111111111111111111111111111";

function fakeKit() {
  const wallet = Keypair.generate();
  const connection = {
    getLatestBlockhash: vi.fn().mockResolvedValue({
      blockhash: ZERO_BLOCKHASH,
      lastValidBlockHeight: 100,
    }),
  } as unknown as Connection;
  return { connection, wallet, wallet_address: wallet.publicKey };
}

// ─── pumpBuyV2 ────────────────────────────────────────────────────────────────

describe("pumpBuyV2Action", () => {
  beforeEach(() => vi.clearAllMocks());

  it("calls buildBuyInstructions with correctly parsed params", async () => {
    const kit = fakeKit();
    mockBuildBuyInstructions.mockResolvedValue({
      instructions: [],
      quoteMint: SOL_MINT,
      expectedBaseTokens: new BN(42),
    });

    await pumpBuyV2Action.handler(kit, {
      mint: TEST_MINT,
      quoteAmount: "500000",
      slippagePct: 3,
    });

    expect(mockBuildBuyInstructions).toHaveBeenCalledWith({
      mint: new PublicKey(TEST_MINT),
      quoteAmount: new BN(500000),
      slippagePct: 3,
    });
  });

  it("returns a base64 string with quoteMint and expectedBaseTokens", async () => {
    const kit = fakeKit();
    mockBuildBuyInstructions.mockResolvedValue({
      instructions: [],
      quoteMint: SOL_MINT,
      expectedBaseTokens: new BN(99),
    });

    const result = await pumpBuyV2Action.handler(kit, {
      mint: TEST_MINT,
      quoteAmount: "1000000",
      slippagePct: 5,
    });

    expect(typeof result.tx).toBe("string");
    expect(Buffer.from(result.tx as string, "base64").length).toBeGreaterThan(0);
    expect(result.quoteMint).toBe(SOL_MINT.toBase58());
    expect(result.expectedBaseTokens).toBe("99");
  });
});

// ─── pumpSellV2 ──────────────────────────────────────────────────────────────

describe("pumpSellV2Action", () => {
  beforeEach(() => vi.clearAllMocks());

  it("calls buildSellInstructions with correctly parsed params", async () => {
    const kit = fakeKit();
    mockBuildSellInstructions.mockResolvedValue({
      instructions: [],
      quoteMint: SOL_MINT,
      expectedQuoteOut: new BN(10),
    });

    await pumpSellV2Action.handler(kit, {
      mint: TEST_MINT,
      baseAmount: "8000000",
      slippagePct: 2,
    });

    expect(mockBuildSellInstructions).toHaveBeenCalledWith({
      mint: new PublicKey(TEST_MINT),
      baseAmount: new BN(8000000),
      slippagePct: 2,
    });
  });

  it("returns a base64 tx string", async () => {
    const kit = fakeKit();
    mockBuildSellInstructions.mockResolvedValue({
      instructions: [],
      quoteMint: SOL_MINT,
      expectedQuoteOut: new BN(777),
    });

    const result = await pumpSellV2Action.handler(kit, {
      mint: TEST_MINT,
      baseAmount: "1000",
      slippagePct: 5,
    });

    expect(typeof result.tx).toBe("string");
    expect(result.quoteMint).toBe(SOL_MINT.toBase58());
    expect(result.expectedQuoteOut).toBe("777");
  });
});

// ─── pumpCheckUsdcWhitelist ───────────────────────────────────────────────────

describe("pumpCheckUsdcWhitelistAction", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns whitelisted=true and currentWhitelist when enabled", async () => {
    const kit = fakeKit();
    vi.mocked(WhitelistMonitor.isWhitelisted).mockResolvedValue(true);
    vi.mocked(WhitelistMonitor.getCurrentWhitelist).mockResolvedValue([
      new PublicKey(USDC_MINT_ADDR),
    ]);

    const result = await pumpCheckUsdcWhitelistAction.handler(kit, {});

    expect(result.whitelisted).toBe(true);
    expect(result.currentWhitelist).toEqual([USDC_MINT_ADDR]);
  });

  it("returns whitelisted=false and empty list when disabled", async () => {
    const kit = fakeKit();
    vi.mocked(WhitelistMonitor.isWhitelisted).mockResolvedValue(false);
    vi.mocked(WhitelistMonitor.getCurrentWhitelist).mockResolvedValue([]);

    const result = await pumpCheckUsdcWhitelistAction.handler(kit, {});

    expect(result.whitelisted).toBe(false);
    expect(result.currentWhitelist).toEqual([]);
  });
});

// ─── pumpCreateUsdcCoin ───────────────────────────────────────────────────────

describe("pumpCreateUsdcCoinAction", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws with 'USDC not whitelisted' when whitelist check returns false", async () => {
    const kit = fakeKit();
    vi.mocked(WhitelistMonitor.isWhitelisted).mockResolvedValue(false);

    await expect(
      pumpCreateUsdcCoinAction.handler(kit, {
        name: "TestCoin",
        symbol: "TC",
        metadataUri: "https://example.com/meta.json",
        usdcAmount: "1000000",
        mayhemMode: false,
        cashback: false,
      }),
    ).rejects.toThrow("USDC not whitelisted");
  });

  it("returns mintPublicKey when whitelist returns true", async () => {
    const kit = fakeKit();
    vi.mocked(WhitelistMonitor.isWhitelisted).mockResolvedValue(true);
    mockCreateV2AndBuyV2.mockResolvedValue([]);

    const result = await pumpCreateUsdcCoinAction.handler(kit, {
      name: "TestCoin",
      symbol: "TC",
      metadataUri: "https://example.com/meta.json",
      usdcAmount: "1000000",
      mayhemMode: false,
      cashback: false,
    });

    expect(mockCreateV2AndBuyV2).toHaveBeenCalledOnce();
    const call = mockCreateV2AndBuyV2.mock.calls[0][0];
    expect(call.name).toBe("TestCoin");
    expect(call.symbol).toBe("TC");
    expect(call.quoteMint.toBase58()).toBe(USDC_MINT_ADDR);
    expect(call.quoteAmount.toNumber()).toBe(1000000);

    expect(typeof result.mintPublicKey).toBe("string");
    expect(() => new PublicKey(result.mintPublicKey as string)).not.toThrow();
    expect(typeof result.tx).toBe("string");
  });
});
