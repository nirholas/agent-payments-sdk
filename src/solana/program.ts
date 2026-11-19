// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
// All rights reserved.

import { AnchorProvider, Program } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import type { PumpAgentPayments } from "./idl/pump_agent_payments";

// tsup inlines the JSON IDL into the bundle.
import IDL from "./idl/pump_agent_payments.json";

/**
 * Creates an Anchor Program instance for the Pump Agent Payments program.
 * Uses a dummy wallet since most operations only build instructions.
 */
export function getPumpProgram(
  connection: Connection,
): Program<PumpAgentPayments> {
  const dummyWallet = {
    publicKey: PublicKey.default,
    signTransaction: () => Promise.reject(),
    signAllTransactions: () => Promise.reject(),
  };
  return new Program(
    IDL as unknown as PumpAgentPayments,
    new AnchorProvider(connection, dummyWallet, {}),
  );
}

/**
 * Offline program instance (no connection required).
 * Useful for instruction building and account decoding without RPC.
 * It has no real connection: calling anything that needs RPC on it fails.
 */
export const OFFLINE_PUMP_PROGRAM: Program<PumpAgentPayments> = getPumpProgram(
  { commitment: "processed" } as unknown as Connection,
);

/**
 * Returns the program instance, falling back to the offline program
 * if no connection is provided.
 */
export function getPumpProgramWithFallback(
  connection?: Connection,
): Program<PumpAgentPayments> {
  return connection ? getPumpProgram(connection) : OFFLINE_PUMP_PROGRAM;
}

/**
 * Returns the offline program instance (alias for convenience).
 */
export function getOfflineProgram(): Program<PumpAgentPayments> {
  return OFFLINE_PUMP_PROGRAM;
}
