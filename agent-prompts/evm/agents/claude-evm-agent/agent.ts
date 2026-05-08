#!/usr/bin/env tsx
// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
// All rights reserved.

/**
 * Claude-powered EVM x402 AI Agent
 *
 * Uses the Anthropic SDK with tool use and prompt caching to autonomously:
 *   1. Check USDC balances across 6 EVM chains
 *   2. Inspect x402 payment requirements without paying
 *   3. Fetch HTTP resources, automatically bridging USDC when a 402 is hit
 *   4. Get bridge quotes from EVM chains to Solana agents
 *
 * Usage:
 *   node agent.ts "<prompt>"
 *   node agent.ts --chain=42161 "<prompt>"
 *
 * Environment variables:
 *   ANTHROPIC_API_KEY   Anthropic API key (required)
 *   EVM_PRIVATE_KEY     EVM private key, hex with or without 0x (required)
 *   EVM_CHAIN_ID        Default chain ID, default 8453 (Base)
 *   EVM_RPC_URL         RPC override for the default chain
 *   MAX_PAYMENT_USDC    Hard ceiling per fetch_resource call, default 5.0
 *   AGENT_MINT          Pump agent token mint for bridge context
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageParam,
  ToolUseBlock,
  ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages.js";

// SDK v0.30 does not yet expose cache_control on TextBlockParam or cache token
// counts on Usage in its TypeScript types — these interfaces extend the SDK types
// with the fields the API already supports at runtime.
interface CachedTextBlock {
  type: "text";
  text: string;
  cache_control: { type: "ephemeral" };
}

interface ExtendedUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}
import {
  TOOLS,
  createToolHandlers,
  type CheckEvmBalanceInput,
  type Inspect402Input,
  type FetchResourceInput,
  type GetBridgeQuoteInput,
  type BalanceResult,
  type Inspect402Result,
  type FetchResourceResult,
  type FetchResourceError,
  type BridgeQuoteResult,
} from "./tools.js";
import type { SupportedEvmChainId } from "../../../../src/types.js";

// ── Environment ────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

const ANTHROPIC_API_KEY = requireEnv("ANTHROPIC_API_KEY");

const rawKey = requireEnv("EVM_PRIVATE_KEY");
const EVM_PRIVATE_KEY: `0x${string}` = rawKey.startsWith("0x")
  ? (rawKey as `0x${string}`)
  : (`0x${rawKey}` as `0x${string}`);

const EVM_CHAIN_ID = (parseInt(
  process.env.EVM_CHAIN_ID ?? "8453",
  10
) as SupportedEvmChainId);

const EVM_RPC_URL = process.env.EVM_RPC_URL;
const MAX_PAYMENT_USDC = parseFloat(process.env.MAX_PAYMENT_USDC ?? "5.0");

// ── CLI parsing ────────────────────────────────────────────────────────────

interface CliArgs {
  chainId: SupportedEvmChainId | null;
  prompt: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  let chainId: SupportedEvmChainId | null = null;
  const promptParts: string[] = [];

  for (const arg of args) {
    if (arg.startsWith("--chain=")) {
      chainId = parseInt(arg.slice("--chain=".length), 10) as SupportedEvmChainId;
    } else {
      promptParts.push(arg);
    }
  }

  return { chainId, prompt: promptParts.join(" ") };
}

// ── System prompt ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  "You are an autonomous EVM payment agent. You operate a wallet on Ethereum, Base, " +
  "Arbitrum, Polygon, BSC, and Avalanche. You can fetch HTTP resources and automatically " +
  "pay for them in USDC by bridging from any EVM chain to Solana when required.\n\n" +
  "Before making any payment: (1) check your USDC balance on the relevant chain, " +
  "(2) inspect the 402 requirements to see the exact price, (3) confirm the price is " +
  "within your limit. Never pay more than the configured maximum. Always report the " +
  "transaction hash after paying. Always prefer Base (chain 8453) unless the user " +
  "specifies otherwise.\n\n" +
  "If a resource is free (no 402), fetch it directly without checking balances first.";

// ── Tool trace ─────────────────────────────────────────────────────────────

interface ToolTraceEntry {
  name: string;
  summary: string;
}

function formatToolSummary(name: string, result: unknown): string {
  if (name === "check_evm_balance") {
    const balances = result as BalanceResult[];
    return balances
      .filter((b) => parseFloat(b.balanceUsdc) > 0 || balances.length === 1)
      .map((b) => `${b.chainName}: ${b.balanceUsdc} USDC`)
      .join(", ") || "all balances: 0";
  }

  if (name === "inspect_402") {
    const r = result as Inspect402Result;
    if ("message" in r) return r.message;
    return `scheme=${r.scheme} amount=${r.maxAmountUsdc} USDC chain=${r.network}`;
  }

  if (name === "fetch_resource") {
    const r = result as FetchResourceResult | FetchResourceError;
    if ("error" in r) {
      return `blocked: ${r.error} (required=${r.required} limit=${r.limit})`;
    }
    if (r.paymentMade) {
      const p = r.paymentMade;
      return `paid ${p.amountUsdc} USDC from chain=${p.chainId} tx=${p.txHash.slice(0, 10)}...`;
    }
    return `status=${r.status} (no payment required)`;
  }

  if (name === "get_bridge_quote") {
    const q = result as BridgeQuoteResult;
    return (
      `${q.fromChainName} → net=${q.netAmountUsdc} USDC ` +
      `fee=${q.estimatedFeeUsdc} USDC expires=${q.expiresIn}s`
    );
  }

  return JSON.stringify(result).slice(0, 100);
}

// ── Tool dispatch ──────────────────────────────────────────────────────────

type ToolHandlers = ReturnType<typeof createToolHandlers>;

async function dispatchTool(
  name: string,
  input: unknown,
  handlers: ToolHandlers
): Promise<unknown> {
  switch (name) {
    case "check_evm_balance":
      return handlers.check_evm_balance(input as CheckEvmBalanceInput);
    case "inspect_402":
      return handlers.inspect_402(input as Inspect402Input);
    case "fetch_resource":
      return handlers.fetch_resource(input as FetchResourceInput);
    case "get_bridge_quote":
      return handlers.get_bridge_quote(input as GetBridgeQuoteInput);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── Agent loop ─────────────────────────────────────────────────────────────

async function runAgent(
  userPrompt: string,
  overrideChainId: SupportedEvmChainId | null
): Promise<void> {
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const effectiveChainId = overrideChainId ?? EVM_CHAIN_ID;

  const rpcUrls: Partial<Record<SupportedEvmChainId, string>> = EVM_RPC_URL
    ? { [effectiveChainId]: EVM_RPC_URL }
    : {};

  const handlers = createToolHandlers({
    privateKey: EVM_PRIVATE_KEY,
    defaultChainId: effectiveChainId,
    rpcUrls,
    maxPaymentUsdc: MAX_PAYMENT_USDC,
  });

  const messages: MessageParam[] = [{ role: "user", content: userPrompt }];

  const toolTrace: ToolTraceEntry[] = [];
  let cumulativeCacheRead = 0;
  let cumulativeCacheWrite = 0;

  // System prompt with ephemeral cache so it is cached after the first call.
  // Cast required because SDK v0.30 types don't include cache_control yet.
  const systemPrompt = [
    { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
  ] as unknown as Anthropic.Messages.TextBlockParam[];

  for (let i = 0; i < 15; i++) {
    const resp = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      system: systemPrompt,
      tools: TOOLS,
      messages,
    });

    // Cache metrics — SDK v0.30 types omit these fields; cast to access them.
    const usage = resp.usage as ExtendedUsage;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const cacheWrite = usage.cache_creation_input_tokens ?? 0;
    cumulativeCacheRead += cacheRead;
    cumulativeCacheWrite += cacheWrite;
    process.stderr.write(`[cache] read=${cacheRead} write=${cacheWrite}\n`);

    if (resp.stop_reason === "end_turn") {
      // Print compact tool trace
      if (toolTrace.length > 0) {
        const maxNameLen = Math.max(...toolTrace.map((t) => t.name.length));
        process.stdout.write("[tools]\n");
        for (const entry of toolTrace) {
          const pad = " ".repeat(maxNameLen - entry.name.length);
          process.stdout.write(`  ${entry.name}${pad} → ${entry.summary}\n`);
        }
      }

      // Print Claude's final text
      for (const block of resp.content) {
        if (block.type === "text") {
          process.stdout.write(block.text + "\n");
        }
      }
      break;
    }

    if (resp.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: resp.content });

      const toolResults: ToolResultBlockParam[] = [];

      for (const block of resp.content) {
        if (block.type !== "tool_use") continue;
        const toolBlock = block as ToolUseBlock;

        let result: unknown;
        try {
          result = await dispatchTool(toolBlock.name, toolBlock.input, handlers);
        } catch (err) {
          result = { error: err instanceof Error ? err.message : String(err) };
        }

        toolTrace.push({
          name: toolBlock.name,
          summary: formatToolSummary(toolBlock.name, result),
        });

        toolResults.push({
          type: "tool_result",
          tool_use_id: toolBlock.id,
          content: JSON.stringify(result),
        });
      }

      messages.push({ role: "user", content: toolResults });
    }
  }

  // Cumulative cache savings summary
  process.stderr.write(
    `[cache] cumulative read=${cumulativeCacheRead} write=${cumulativeCacheWrite}` +
      ` saved≈${Math.round(cumulativeCacheRead * 0.9)} tokens\n`
  );
}

// ── Main ───────────────────────────────────────────────────────────────────

const { chainId, prompt } = parseArgs(process.argv);

if (!prompt.trim()) {
  process.stderr.write('Usage: node agent.ts "<prompt>"\n');
  process.stderr.write('       node agent.ts --chain=42161 "<prompt>"\n');
  process.exit(1);
}

runAgent(prompt, chainId).catch((err: unknown) => {
  process.stderr.write(
    `Agent error: ${err instanceof Error ? err.message : String(err)}\n`
  );
  process.exit(1);
});
