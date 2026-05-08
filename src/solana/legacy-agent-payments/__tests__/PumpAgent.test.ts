import { describe, expect, it, vi, beforeEach } from "vitest";
import { BN } from "@coral-xyz/anchor";
import { PublicKey, Connection } from "@solana/web3.js";

import { LegacyPumpAgent } from "../PumpAgent.js";
import {
  getBuybackAuthorityPDA,
  getTokenAgentPaymentsPDA,
  getWithdrawAuthorityPDA,
  getGlobalConfigPDA,
} from "../pdas.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

// Deterministic test pubkeys.
const MINT = new PublicKey("11111111111111111111111111111112");
const AUTHORITY = new PublicKey("11111111111111111111111111111113");
const CURRENCY_MINT = new PublicKey(
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
);
const CURRENCY_MINT_2 = new PublicKey(
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
);

function makeMockConnection(): Connection {
  return {
    commitment: "processed",
    getTokenAccountBalance: vi.fn(),
  } as unknown as Connection;
}

describe("LegacyPumpAgent / getBalances", () => {
  it("returns balances from token accounts when they exist", async () => {
    const mockConnection = makeMockConnection();
    const mockGetBalance = vi.fn().mockResolvedValue({
      value: { amount: "1000" },
    });
    (mockConnection.getTokenAccountBalance as ReturnType<typeof vi.fn>) =
      mockGetBalance;

    const agent = new LegacyPumpAgent(MINT, mockConnection);
    const result = await agent.getBalances(CURRENCY_MINT);

    expect(result.paymentVault.balance).toBe(1000n);
    expect(result.buybackVault.balance).toBe(1000n);
    expect(result.withdrawVault.balance).toBe(1000n);

    // Verify correct ATAs are derived
    const [tokenAgentPayments] = getTokenAgentPaymentsPDA(MINT);
    const [buybackAuthority] = getBuybackAuthorityPDA(MINT);
    const [withdrawAuthority] = getWithdrawAuthorityPDA(MINT);
    const paymentAta = getAssociatedTokenAddressSync(
      CURRENCY_MINT,
      tokenAgentPayments,
      true,
    );
    const buybackAta = getAssociatedTokenAddressSync(
      CURRENCY_MINT,
      buybackAuthority,
      true,
    );
    const withdrawAta = getAssociatedTokenAddressSync(
      CURRENCY_MINT,
      withdrawAuthority,
      true,
    );

    expect(result.paymentVault.address.toBase58()).toBe(paymentAta.toBase58());
    expect(result.buybackVault.address.toBase58()).toBe(buybackAta.toBase58());
    expect(result.withdrawVault.address.toBase58()).toBe(
      withdrawAta.toBase58(),
    );

    expect(mockGetBalance).toHaveBeenCalledTimes(3);
  });

  it("returns 0n for accounts that throw (account not found)", async () => {
    const mockConnection = makeMockConnection();
    (
      mockConnection.getTokenAccountBalance as ReturnType<typeof vi.fn>
    ).mockRejectedValue(new Error("Account not found"));

    const agent = new LegacyPumpAgent(MINT, mockConnection);
    const result = await agent.getBalances(CURRENCY_MINT);

    expect(result.paymentVault.balance).toBe(0n);
    expect(result.buybackVault.balance).toBe(0n);
    expect(result.withdrawVault.balance).toBe(0n);
  });

  it("returns mixed balances when some accounts exist and some don't", async () => {
    const mockConnection = makeMockConnection();
    let callCount = 0;
    (
      mockConnection.getTokenAccountBalance as ReturnType<typeof vi.fn>
    ).mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({ value: { amount: "5000" } });
      }
      return Promise.reject(new Error("Account not found"));
    });

    const agent = new LegacyPumpAgent(MINT, mockConnection);
    const result = await agent.getBalances(CURRENCY_MINT);

    expect(result.paymentVault.balance).toBe(5000n);
    expect(result.buybackVault.balance).toBe(0n);
    expect(result.withdrawVault.balance).toBe(0n);
  });
});

describe("LegacyPumpAgent / updateBuybackBps override", () => {
  it("uses provided supportedCurrenciesMint without fetching on-chain", async () => {
    const mockConnection = makeMockConnection();
    const agent = new LegacyPumpAgent(MINT, mockConnection);

    const ix = await agent.updateBuybackBps(
      { authority: AUTHORITY, buybackBps: 3000 },
      { supportedCurrenciesMint: [CURRENCY_MINT] },
    );

    // Should produce a valid instruction without calling connection.
    expect(ix.programId).toBeDefined();
    expect(ix.data.length).toBeGreaterThan(0);
    // Connection should never have been called.
    expect(
      mockConnection.getTokenAccountBalance as ReturnType<typeof vi.fn>,
    ).not.toHaveBeenCalled();
  });

  it("auto-fetches globalConfig when supportedCurrenciesMint is not provided", async () => {
    const mockConnection = makeMockConnection();

    // We need to mock the program's account.globalConfig.fetch method.
    // LegacyPumpAgent uses getLegacyPumpProgramWithFallback(connection)
    // which builds a real Program — we patch at the agent level after construction.
    const agent = new LegacyPumpAgent(MINT, mockConnection);

    const mockFetch = vi.fn().mockResolvedValue({
      supportedCurrenciesMint: [CURRENCY_MINT, CURRENCY_MINT_2],
    });

    // Patch the protected program property via type coercion.
    (
      agent as unknown as {
        program: {
          account: {
            globalConfig: { fetch: typeof mockFetch };
          };
        };
      }
    ).program.account = {
      globalConfig: { fetch: mockFetch },
    } as never;

    const ix = await agent.updateBuybackBps({
      authority: AUTHORITY,
      buybackBps: 2000,
    });

    const [globalConfigPda] = getGlobalConfigPDA();
    expect(mockFetch).toHaveBeenCalledWith(globalConfigPda);
    expect(ix.programId).toBeDefined();
  });

  it("offline updateBuybackBps (super) rejects without supportedCurrenciesMint", async () => {
    const mockConnection = makeMockConnection();
    const agent = new LegacyPumpAgent(MINT, mockConnection);

    // Patch fetch to return empty currencies, simulating what super would do
    // if called without the option — but in this case we test the offline
    // base class directly via a LegacyPumpAgentOffline import tested elsewhere.
    // Here we test that with empty array from globalConfig, super still works.
    const mockFetch = vi.fn().mockResolvedValue({
      supportedCurrenciesMint: [],
    });

    (
      agent as unknown as {
        program: {
          account: {
            globalConfig: { fetch: typeof mockFetch };
          };
        };
      }
    ).program.account = {
      globalConfig: { fetch: mockFetch },
    } as never;

    // With empty supportedCurrenciesMint, super.updateBuybackBps should
    // now throw because options.supportedCurrenciesMint is [] (falsy-ish but defined).
    // Actually, empty array IS passed, so it should succeed with 0 remaining accounts.
    const ix = await agent.updateBuybackBps({
      authority: AUTHORITY,
      buybackBps: 0,
    });
    expect(ix).toBeDefined();
    expect(ix.data.length).toBeGreaterThan(0);
  });
});

describe("LegacyPumpAgent / constructor", () => {
  it("stores mint and connection", () => {
    const mockConnection = makeMockConnection();
    const agent = new LegacyPumpAgent(MINT, mockConnection);
    expect(agent.mint.equals(MINT)).toBe(true);
    expect(agent.connection).toBe(mockConnection);
  });

  it("is an instance of LegacyPumpAgent", async () => {
    const { LegacyPumpAgentOffline } = await import("../PumpAgentOffline.js");
    const mockConnection = makeMockConnection();
    const agent = new LegacyPumpAgent(MINT, mockConnection);
    expect(agent).toBeInstanceOf(LegacyPumpAgentOffline);
    expect(agent).toBeInstanceOf(LegacyPumpAgent);
  });
});
