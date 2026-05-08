#!/usr/bin/env node
// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
// All rights reserved.
//
// solana-agent-kit v2 + PumpAgentPaymentsPlugin demo
//
// Usage:
//   npx tsx demo.ts balances           — fetch USDC + SOL vault balances
//   npx tsx demo.ts distribute         — distribute if payment vault > 0
//   npx tsx demo.ts all                — run all 9 direct action handlers
//   npx tsx demo.ts chat "<message>"   — LLM agent loop via Claude
//   npx tsx demo.ts validate-schemas   — test all 9 Zod schemas
//
// Required env vars:
//   SOLANA_RPC_URL       Mainnet RPC endpoint
//   SOLANA_PRIVATE_KEY   Base58-encoded agent operator keypair
//   AGENT_MINT           Pump token mint with agent-payments initialized
//   ANTHROPIC_API_KEY    Required only for "chat" mode

import process from "node:process";
import { Keypair, PublicKey } from "@solana/web3.js";
import { z } from "zod";
import bs58 from "bs58";

import { SolanaAgentKit, KeypairWallet } from "solana-agent-kit";

import {
  PumpAgentPaymentsPlugin,
  allActions,
  createAgentPaymentsAction,
  buildPaymentInstructionsAction,
  getBalancesAction,
  validateInvoiceAction,
  distributePaymentsAction,
  withdrawAction,
  getConfigAction,
  getPaymentStatsAction,
  updateBuybackBpsAction,
  type SolanaAgentKitLike,
} from "@nirholas/agent-payments-sdk/solana-agent-kit";

import { ChatAnthropic } from "@langchain/anthropic";
import { createToolCallingAgent, AgentExecutor } from "langchain/agents";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { ChatPromptTemplate } from "@langchain/core/prompts";

// ─── Constants ────────────────────────────────────────────────────────────────

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDC_DECIMALS = 1_000_000n;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function env(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing env var: ${key}`);
  return val;
}

function formatUsdc(raw: string | bigint | number): string {
  const n = BigInt(raw.toString());
  const whole = n / USDC_DECIMALS;
  const frac = n % USDC_DECIMALS;
  return `${whole}.${frac.toString().padStart(6, "0")} USDC`;
}

function hr(label: string) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(label);
  console.log("─".repeat(60));
}

// ─── Kit + adapter setup ──────────────────────────────────────────────────────
//
// SolanaAgentKit v2 uses BaseWallet (not Keypair) and exposes wallet.publicKey.
// Our plugin's SolanaAgentKitLike interface expects { connection, wallet: Keypair,
// wallet_address: PublicKey }. We construct a thin adapter so action handlers
// receive the right shape when called directly.
//
// PumpAgentPaymentsPlugin doesn't include the `initialize()` method that SAK v2
// requires on every plugin. We add a no-op so kit.use() can proceed.

function initKit() {
  const rpcUrl = env("SOLANA_RPC_URL");
  const keypair = Keypair.fromSecretKey(bs58.decode(env("SOLANA_PRIVATE_KEY")));
  const wallet = new KeypairWallet(keypair, rpcUrl);

  const kit = new SolanaAgentKit(wallet, rpcUrl, {}).use(
    { ...PumpAgentPaymentsPlugin, initialize: () => {} } as any,
  );

  const adapter: SolanaAgentKitLike = {
    connection: kit.connection,
    wallet: keypair,
    wallet_address: keypair.publicKey,
  };

  return { kit, adapter, keypair };
}

// ─── Mode: balances ───────────────────────────────────────────────────────────

async function runBalances() {
  const { adapter } = initKit();
  const agentMint = env("AGENT_MINT");

  console.log(`Agent mint: ${agentMint}\n`);

  const usdc = await getBalancesAction.handler(adapter, {
    mint: agentMint,
    currencyMint: USDC_MINT,
  });

  console.log("USDC balances:");
  console.log(`  payment  ${usdc.paymentVault.address}`);
  console.log(`           ${formatUsdc(usdc.paymentVault.balance)}`);
  console.log(`  buyback  ${usdc.buybackVault.address}`);
  console.log(`           ${formatUsdc(usdc.buybackVault.balance)}`);
  console.log(`  withdraw ${usdc.withdrawVault.address}`);
  console.log(`           ${formatUsdc(usdc.withdrawVault.balance)}`);

  const sol = await getBalancesAction.handler(adapter, { mint: agentMint });

  console.log("\nSOL (wrapped) balances (lamports):");
  console.log(`  payment  ${sol.paymentVault.balance}`);
  console.log(`  buyback  ${sol.buybackVault.balance}`);
  console.log(`  withdraw ${sol.withdrawVault.balance}`);
}

// ─── Mode: distribute ─────────────────────────────────────────────────────────

async function runDistribute() {
  const { adapter } = initKit();
  const agentMint = env("AGENT_MINT");

  const balances = await getBalancesAction.handler(adapter, {
    mint: agentMint,
    currencyMint: USDC_MINT,
  });

  const paymentBalance = BigInt(balances.paymentVault.balance);

  if (paymentBalance === 0n) {
    console.log("Payment vault is empty, nothing to distribute.");
    return;
  }

  console.log(`Payment vault has ${formatUsdc(paymentBalance)}. Building distribution...`);

  const result = await distributePaymentsAction.handler(adapter, {
    mint: agentMint,
    currencyMint: USDC_MINT,
  });

  console.log(`Built ${result.instructions.length} instruction(s).`);
  console.log(JSON.stringify(result, null, 2));
}

// ─── Mode: all (9 direct actions) ─────────────────────────────────────────────

async function runAll() {
  const { adapter } = initKit();
  const agentMint = env("AGENT_MINT");
  const now = Math.floor(Date.now() / 1000);

  // 1. pump_agent_balances
  hr("1. pump_agent_get_balances");
  const balances = await getBalancesAction.handler(adapter, {
    mint: agentMint,
    currencyMint: USDC_MINT,
  });
  console.log(`payment  ${formatUsdc(balances.paymentVault.balance)}`);
  console.log(`buyback  ${formatUsdc(balances.buybackVault.balance)}`);
  console.log(`withdraw ${formatUsdc(balances.withdrawVault.balance)}`);

  // 2. pump_agent_config
  hr("2. pump_agent_get_config");
  const config = await getConfigAction.handler(adapter, { mint: agentMint });
  console.log(`authority  ${config.authority}`);
  console.log(`buybackBps ${config.buybackBps}`);
  console.log(`mint       ${config.mint}`);

  // 3. pump_agent_stats
  hr("3. pump_agent_get_payment_stats  (USDC)");
  const stats = await getPaymentStatsAction.handler(adapter, {
    mint: agentMint,
    currencyMint: USDC_MINT,
  });
  for (const [k, v] of Object.entries(stats)) {
    console.log(`  ${k}: ${v}`);
  }

  // 4. pump_agent_validate_invoice
  hr("4. pump_agent_validate_invoice");
  const memo = Date.now();
  const validation = await validateInvoiceAction.handler(adapter, {
    mint: agentMint,
    user: adapter.wallet_address.toBase58(),
    currencyMint: USDC_MINT,
    amount: "1000000",
    memo: String(memo),
    startTime: String(now),
    endTime: String(now + 300),
  });
  // No real payment exists so valid is expected to be false
  console.log(`valid: ${validation.valid}  (expected false — no real payment with memo ${memo})`);

  // 5. pump_agent_distribute
  hr("5. pump_agent_distribute_payments  (USDC)");
  const paymentBalance = BigInt(balances.paymentVault.balance);
  if (paymentBalance === 0n) {
    console.log("Payment vault is empty, nothing to distribute.");
  } else {
    const dist = await distributePaymentsAction.handler(adapter, {
      mint: agentMint,
      currencyMint: USDC_MINT,
    });
    console.log(`Built ${dist.instructions.length} distribution instruction(s).`);
  }

  // 6. pump_agent_withdraw
  // Note: the action schema uses { mint, currencyMint, receiverAta? } — there
  // is no "amount" field. The on-chain program withdraws the full withdraw-vault
  // balance. We build the instruction here without submitting it.
  hr("6. pump_agent_withdraw  (USDC)");
  const withdrawResult = await withdrawAction.handler(adapter, {
    mint: agentMint,
    currencyMint: USDC_MINT,
  });
  console.log(`Built withdraw instruction`);
  console.log(`  programId: ${withdrawResult.instruction.programId}`);
  console.log(`  accounts:  ${withdrawResult.instruction.keys.length}`);

  // 7. pump_agent_update_buyback_bps
  hr("7. pump_agent_update_buyback_bps  (500 bps = 5%)");
  const updateResult = await updateBuybackBpsAction.handler(adapter, {
    mint: agentMint,
    buybackBps: 500,
  });
  console.log(`Built update-buyback-bps instruction`);
  console.log(`  programId: ${updateResult.instruction.programId}`);
  console.log(`  accounts:  ${updateResult.instruction.keys.length}`);

  // 8. pump_agent_build_payment_instructions
  hr("8. pump_agent_build_payment_instructions  (1 USDC)");
  const payIxs = await buildPaymentInstructionsAction.handler(adapter, {
    mint: agentMint,
    user: adapter.wallet_address.toBase58(),
    currencyMint: USDC_MINT,
    amount: "1000000",
    memo: String(memo),
    startTime: String(now),
    endTime: String(now + 300),
  });
  console.log(`Built ${payIxs.instructions.length} payment instruction(s).`);

  // 9. pump_agent_create
  // This builds the agentInitialize instruction. Submitting it to the chain
  // would fail with an Anchor error if the wallet is not the bonding-curve
  // creator. Here we catch that case and surface a readable message.
  hr("9. pump_agent_create  (instruction only — not submitted)");
  try {
    const createResult = await createAgentPaymentsAction.handler(adapter, {
      mint: agentMint,
      buybackBps: 500,
    });
    console.log(`Built create instruction`);
    console.log(`  programId: ${createResult.instruction.programId}`);
    console.log(`  accounts:  ${createResult.instruction.keys.length}`);
    console.log("  Note: submitting this instruction will fail on-chain if the");
    console.log("  wallet is not the bonding-curve creator.");
  } catch (err: any) {
    const msg: string = err.message ?? String(err);
    if (msg.includes("bonding") || msg.includes("creator") || msg.includes("Unauthorized") || msg.includes("6000") || msg.includes("0x1770")) {
      console.log("Caught expected Anchor error: caller is not the bonding-curve creator.");
      console.log(`Detail: ${msg}`);
    } else {
      throw err;
    }
  }

  console.log("\n✓ All 9 actions completed.");
}

// ─── Mode: chat ───────────────────────────────────────────────────────────────
//
// Builds LangChain tools from the plugin's action array, wiring them to the
// SolanaAgentKitLike adapter so handlers receive wallet_address and connection.
// Uses createToolCallingAgent so Claude's native tool-use capability drives the
// ReAct loop rather than a text-based scratchpad format.

async function runChat(message: string) {
  const { kit, adapter } = initKit();
  const agentMint = env("AGENT_MINT");

  // Verify the plugin mounted all 9 actions
  console.log(`\nPlugin mounted: ${kit.actions.length} action(s) registered`);
  console.log(`Actions: ${kit.actions.map(a => a.name).join(", ")}\n`);

  // Use allActions (typed with SolanaAgentKitLike) for tool wrappers so the
  // adapter satisfies the handler signature without a cast.
  const tools = allActions.map(
    (action) =>
      new DynamicStructuredTool({
        name: action.name,
        description: action.description,
        schema: action.schema as z.ZodObject<any>,
        func: async (input: Record<string, any>) => {
          if (!input.mint) input.mint = agentMint;
          try {
            const result = await action.handler(adapter, input);
            return JSON.stringify(result, null, 2);
          } catch (err: any) {
            return `Error: ${err.message ?? String(err)}`;
          }
        },
      }),
  );

  const llm = new ChatAnthropic({
    model: "claude-sonnet-4-6",
    apiKey: env("ANTHROPIC_API_KEY"),
  });

  const prompt = ChatPromptTemplate.fromMessages([
    [
      "system",
      `You are a Solana agent payments assistant. The agent mint is ${agentMint}.
Use the available tools to answer questions about on-chain USDC payment state.
Format USDC amounts with 6 decimal places (raw units ÷ 1,000,000).
Be concise and specific.`,
    ],
    ["human", "{input}"],
    ["placeholder", "{agent_scratchpad}"],
  ]);

  const agent = createToolCallingAgent({ llm, tools, prompt });
  const executor = new AgentExecutor({
    agent,
    tools,
    returnIntermediateSteps: true,
  });

  console.log(`User: ${message}\n`);

  const result = await executor.invoke({ input: message });

  if (result.intermediateSteps?.length) {
    console.log("─── Tool calls ───────────────────────────────────────");
    for (const step of result.intermediateSteps as any[]) {
      console.log(`\nTool:   ${step.action.tool}`);
      console.log(`Input:  ${JSON.stringify(step.action.toolInput)}`);
      console.log(`Output: ${step.observation}`);
    }
  }

  console.log("\n─── Answer ───────────────────────────────────────────");
  console.log(result.output);
}

// ─── Mode: validate-schemas ───────────────────────────────────────────────────

async function runValidateSchemas() {
  const mint = "So11111111111111111111111111111111111111112";
  const user = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

  const cases: Array<{
    action: (typeof allActions)[number];
    valid: Record<string, unknown>;
    invalid: Record<string, unknown>;
    invalidReason: string;
  }> = [
    {
      action: createAgentPaymentsAction,
      valid: { mint, buybackBps: 500 },
      invalid: { mint, buybackBps: 20000 },
      invalidReason: "buybackBps > 10000",
    },
    {
      action: buildPaymentInstructionsAction,
      valid: { mint, user, amount: "1000000" },
      invalid: { mint },
      invalidReason: "missing user and amount",
    },
    {
      action: getBalancesAction,
      valid: { mint },
      invalid: {},
      invalidReason: "missing mint",
    },
    {
      action: validateInvoiceAction,
      valid: {
        mint,
        user,
        currencyMint: USDC_MINT,
        amount: "1000000",
        memo: "1",
        startTime: "0",
        endTime: "0",
      },
      invalid: { mint, user },
      invalidReason: "missing currencyMint, amount, memo, startTime, endTime",
    },
    {
      action: distributePaymentsAction,
      valid: { mint },
      invalid: {},
      invalidReason: "missing mint",
    },
    {
      action: withdrawAction,
      valid: { mint, currencyMint: USDC_MINT },
      invalid: { mint },
      invalidReason: "missing currencyMint",
    },
    {
      action: getConfigAction,
      valid: { mint },
      invalid: {},
      invalidReason: "missing mint",
    },
    {
      action: getPaymentStatsAction,
      valid: { mint, currencyMint: USDC_MINT },
      invalid: { mint },
      invalidReason: "missing currencyMint",
    },
    {
      action: updateBuybackBpsAction,
      valid: { mint, buybackBps: 500 },
      invalid: { mint, buybackBps: -1 },
      invalidReason: "buybackBps < 0",
    },
  ];

  let passed = 0;
  let failed = 0;

  for (const { action, valid, invalid, invalidReason } of cases) {
    const validResult = action.schema.safeParse(valid);
    if (validResult.success) {
      console.log(`✓ ${action.name}  valid input accepted`);
      passed++;
    } else {
      const issue = validResult.error.issues[0];
      console.error(`✗ ${action.name}  valid input REJECTED: ${issue.message} at [${issue.path.join(".")}]`);
      failed++;
    }

    const invalidResult = action.schema.safeParse(invalid);
    if (!invalidResult.success) {
      const issue = invalidResult.error.issues[0];
      console.log(`✓ ${action.name}  invalid input rejected  (${issue.message} at [${issue.path.join(".")}])`);
      passed++;
    } else {
      console.error(`✗ ${action.name}  invalid input ACCEPTED — expected rejection for: ${invalidReason}`);
      failed++;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed out of ${cases.length * 2} total checks.`);
}

// ─── Entry point ──────────────────────────────────────────────────────────────

const [, , mode, ...args] = process.argv;

(async () => {
  switch (mode) {
    case "balances":
      await runBalances();
      break;
    case "distribute":
      await runDistribute();
      break;
    case "all":
      await runAll();
      break;
    case "chat": {
      const message =
        args.join(" ") ||
        "Check my agent USDC balance and tell me if there is anything ready to distribute.";
      await runChat(message);
      break;
    }
    case "validate-schemas":
      await runValidateSchemas();
      break;
    default:
      console.log([
        "Usage:",
        "  npx tsx demo.ts balances           Fetch USDC + SOL vault balances",
        "  npx tsx demo.ts distribute         Distribute USDC if payment vault > 0",
        "  npx tsx demo.ts all                Run all 9 direct action handlers",
        '  npx tsx demo.ts chat "<message>"   LLM agent loop via claude-sonnet-4-6',
        "  npx tsx demo.ts validate-schemas   Test all 9 Zod schemas (valid + invalid)",
      ].join("\n"));
      process.exit(1);
  }
})().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`\nFatal: ${msg}`);
  if (process.env.DEBUG) console.error(err);
  process.exit(1);
});
