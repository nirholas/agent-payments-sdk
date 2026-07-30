// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
// All rights reserved.

import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import {
  EVM_CHAINS,
  SUPPORTED_CHAIN_IDS,
  UNDEPLOYED_AGENT_PAYMENTS,
  isAgentPaymentsDeployed,
  resolveAgentPaymentsAddress,
} from "./addresses.js";
import { EvmAgentOffline } from "./EvmAgentOffline.js";

const DEPLOYMENT = "0x1111111111111111111111111111111111111111" as Address;

describe("resolveAgentPaymentsAddress", () => {
  it("returns the override untouched", () => {
    for (const chainId of SUPPORTED_CHAIN_IDS) {
      expect(resolveAgentPaymentsAddress(chainId, DEPLOYMENT)).toBe(DEPLOYMENT);
    }
  });

  it("throws instead of returning the zero address for undeployed chains", () => {
    for (const chainId of SUPPORTED_CHAIN_IDS) {
      if (isAgentPaymentsDeployed(chainId)) continue;
      expect(() => resolveAgentPaymentsAddress(chainId)).toThrow(
        /no recorded deployment/i,
      );
    }
  });

  it("never resolves to the zero address", () => {
    for (const chainId of SUPPORTED_CHAIN_IDS) {
      let resolved: Address | null = null;
      try {
        resolved = resolveAgentPaymentsAddress(chainId);
      } catch {
        resolved = null;
      }
      expect(resolved).not.toBe(UNDEPLOYED_AGENT_PAYMENTS);
    }
  });

  it("rejects an unsupported chain", () => {
    expect(() =>
      resolveAgentPaymentsAddress(999 as never),
    ).toThrow(/Unsupported EVM chain/);
  });
});

describe("isAgentPaymentsDeployed", () => {
  it("agrees with the address table", () => {
    for (const chainId of SUPPORTED_CHAIN_IDS) {
      const expected =
        EVM_CHAINS[chainId].agentPayments !== UNDEPLOYED_AGENT_PAYMENTS;
      expect(isAgentPaymentsDeployed(chainId)).toBe(expected);
    }
  });
});

describe("EvmAgentOffline construction", () => {
  const agentToken = "0x4200000000000000000000000000000000000006" as Address;

  it("refuses to build against an undeployed chain", () => {
    expect(() => new EvmAgentOffline(agentToken, 8453)).toThrow(
      /no recorded deployment/i,
    );
  });

  it("accepts an explicit deployment address", () => {
    const agent = new EvmAgentOffline(agentToken, 8453, DEPLOYMENT);
    expect(agent.contractAddress).toBe(DEPLOYMENT);
    expect(agent.chainId).toBe(8453);
  });

  it("targets the explicit deployment in built transactions", () => {
    const agent = new EvmAgentOffline(agentToken, 8453, DEPLOYMENT);
    const bundle = agent.buildAcceptPaymentTx(
      {
        agentToken,
        currencyToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address,
        amount: 1_000_000n,
        memo: 1n,
        startTime: 0n,
        endTime: 600n,
      },
      "0x0000000000000000000000000000000000000001" as Address,
    );
    expect(bundle.tx.to).toBe(DEPLOYMENT);
    expect(bundle.approval?.data).toContain(DEPLOYMENT.slice(2).toLowerCase());
  });
});
