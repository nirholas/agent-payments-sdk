// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
// All rights reserved.

import type { Connection, Keypair, PublicKey } from "@solana/web3.js";
import type { z } from "zod";

// The `any`s below mirror solana-agent-kit's own Action interface, so these
// actions stay assignable to it and handlers can read schema-parsed input.

/**
 * Minimal structural interface compatible with solana-agent-kit's SolanaAgentKit.
 * Uses structural typing so consumers don't need to import SolanaAgentKit directly.
 */
export interface SolanaAgentKitLike {
  connection: Connection;
  wallet: Keypair;
  wallet_address: PublicKey;
}

export type ActionHandler = (
  agent: SolanaAgentKitLike,
  input: Record<string, any>,
) => Promise<Record<string, any>>;

export interface ActionExample {
  /** Example input; values match the action's schema types. */
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  explanation: string;
}

export interface Action {
  name: string;
  similes: string[];
  description: string;
  examples: ActionExample[][];
  schema: z.ZodType<any>;
  handler: ActionHandler;
}

export interface Plugin {
  name: string;
  methods: Record<string, (...args: any[]) => any>;
  actions: Action[];
}
