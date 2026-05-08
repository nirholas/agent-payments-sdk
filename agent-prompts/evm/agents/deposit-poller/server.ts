// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
// All rights reserved.

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import {
  registerDeposit,
  getAllDeposits,
  getDeposit,
  deleteDeposit,
  getSummary,
  getPendingDeposits,
} from "./db.js";

const CHAIN_NAMES: Record<number, string> = {
  1: "Ethereum",
  8453: "Base",
  42161: "Arbitrum One",
  137: "Polygon",
  56: "BNB Smart Chain",
  43114: "Avalanche",
};

export function buildApp(dbPath: string, pollIntervalMs: number): Hono {
  const app = new Hono();

  // ── GET /health ──────────────────────────────────────────────────────────────
  app.get("/health", (c) => {
    const pending = getPendingDeposits();
    return c.json({
      status: "ok",
      dbPath,
      pollIntervalMs,
      pendingDeposits: pending.length,
    });
  });

  // ── GET /summary ─────────────────────────────────────────────────────────────
  app.get("/summary", (c) => {
    return c.json(getSummary());
  });

  // ── GET /deposits ─────────────────────────────────────────────────────────────
  app.get("/deposits", (c) => {
    const statusFilter = c.req.query("status");
    const rows = getAllDeposits(statusFilter);
    return c.json(rows.map(rowToJson));
  });

  // ── GET /deposits/:depositId ──────────────────────────────────────────────────
  app.get("/deposits/:depositId", (c) => {
    const row = getDeposit(c.req.param("depositId"));
    if (!row) return c.json({ error: "Not found" }, 404);
    return c.json(rowToJson(row));
  });

  // ── POST /deposits ────────────────────────────────────────────────────────────
  app.post("/deposits", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const { depositId, txHash, chainId, amountUsdc, agentMint, memo } =
      body as Record<string, unknown>;

    if (typeof depositId !== "string" || !depositId.trim()) {
      return c.json({ error: "depositId is required (string)" }, 400);
    }
    if (typeof txHash !== "string" || !txHash.trim()) {
      return c.json({ error: "txHash is required (string)" }, 400);
    }
    if (typeof chainId !== "number" || !Number.isInteger(chainId)) {
      return c.json({ error: "chainId is required (integer)" }, 400);
    }
    if (amountUsdc !== undefined && typeof amountUsdc !== "string") {
      return c.json({ error: "amountUsdc must be a string if provided" }, 400);
    }
    if (agentMint !== undefined && typeof agentMint !== "string") {
      return c.json({ error: "agentMint must be a string if provided" }, 400);
    }
    if (memo !== undefined && typeof memo !== "string") {
      return c.json({ error: "memo must be a string if provided" }, 400);
    }

    const chainName = CHAIN_NAMES[chainId] ?? `Chain ${chainId}`;

    const row = registerDeposit({
      depositId: depositId.trim(),
      txHash: txHash.trim(),
      chainId,
      chainName,
      amountUsdc: amountUsdc as string | undefined,
      agentMint: agentMint as string | undefined,
      memo: memo as string | undefined,
    });

    return c.json(rowToJson(row), 201);
  });

  // ── DELETE /deposits/:depositId ───────────────────────────────────────────────
  app.delete("/deposits/:depositId", (c) => {
    const deleted = deleteDeposit(c.req.param("depositId"));
    if (!deleted) return c.json({ error: "Not found" }, 404);
    return new Response(null, { status: 204 });
  });

  return app;
}

export function startServer(
  app: Hono,
  port: number
): Promise<Server> {
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port }, () => {
      console.log(`[server] listening on http://0.0.0.0:${port}`);
      resolve(server as unknown as Server);
    });
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function rowToJson(row: ReturnType<typeof getDeposit>) {
  if (!row) return null;
  return {
    depositId: row.deposit_id,
    txHash: row.tx_hash,
    chainId: row.chain_id,
    chainName: row.chain_name,
    amountUsdc: row.amount_usdc,
    agentMint: row.agent_mint,
    memo: row.memo,
    status: row.status,
    solanaSignature: row.solana_signature,
    confirmedAmountUsdc: row.confirmed_amount_usdc,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    arrivedAt: row.arrived_at,
  };
}
