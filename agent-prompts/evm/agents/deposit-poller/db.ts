// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
// All rights reserved.

import Database from "better-sqlite3";
import type { CrossChainPaymentStatus } from "../../../../src/types.js";

export interface DepositRow {
  deposit_id: string;
  tx_hash: string;
  chain_id: number;
  chain_name: string;
  amount_usdc: string | null;
  agent_mint: string | null;
  memo: string | null;
  status: string;
  solana_signature: string | null;
  confirmed_amount_usdc: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  arrived_at: number | null;
}

export interface RegisterDepositParams {
  depositId: string;
  txHash: string;
  chainId: number;
  chainName: string;
  amountUsdc?: string;
  agentMint?: string;
  memo?: string;
}

export interface UpdateDepositParams {
  depositId: string;
  status: CrossChainPaymentStatus;
  solanaSignature?: string;
  confirmedAmountUsdc?: string;
  error?: string;
}

const TERMINAL_STATUSES = new Set(["arrived_on_solana", "failed"]);

let _db: Database.Database | null = null;

export function openDb(dbPath: string): Database.Database {
  _db = new Database(dbPath);
  _db.pragma("journal_mode = WAL");
  _db.exec(`
    CREATE TABLE IF NOT EXISTS deposits (
      deposit_id            TEXT PRIMARY KEY,
      tx_hash               TEXT NOT NULL,
      chain_id              INTEGER NOT NULL,
      chain_name            TEXT NOT NULL,
      amount_usdc           TEXT,
      agent_mint            TEXT,
      memo                  TEXT,
      status                TEXT NOT NULL DEFAULT 'pending',
      solana_signature      TEXT,
      confirmed_amount_usdc TEXT,
      error                 TEXT,
      created_at            INTEGER NOT NULL,
      updated_at            INTEGER NOT NULL,
      arrived_at            INTEGER
    );
  `);
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

function db(): Database.Database {
  if (!_db) throw new Error("Database not initialised — call openDb() first");
  return _db;
}

export function registerDeposit(params: RegisterDepositParams): DepositRow {
  const now = Date.now();
  db()
    .prepare(
      `INSERT OR IGNORE INTO deposits
        (deposit_id, tx_hash, chain_id, chain_name, amount_usdc, agent_mint, memo,
         status, created_at, updated_at)
       VALUES
        (@depositId, @txHash, @chainId, @chainName, @amountUsdc, @agentMint, @memo,
         'pending', @now, @now)`
    )
    .run({
      depositId: params.depositId,
      txHash: params.txHash,
      chainId: params.chainId,
      chainName: params.chainName,
      amountUsdc: params.amountUsdc ?? null,
      agentMint: params.agentMint ?? null,
      memo: params.memo ?? null,
      now,
    });
  return getDeposit(params.depositId)!;
}

export function updateDeposit(params: UpdateDepositParams): void {
  const now = Date.now();
  const arrivedAt =
    params.status === "arrived_on_solana" ? now : null;

  db()
    .prepare(
      `UPDATE deposits SET
         status                = @status,
         solana_signature      = COALESCE(@solanaSignature, solana_signature),
         confirmed_amount_usdc = COALESCE(@confirmedAmountUsdc, confirmed_amount_usdc),
         error                 = COALESCE(@error, error),
         arrived_at            = COALESCE(@arrivedAt, arrived_at),
         updated_at            = @now
       WHERE deposit_id = @depositId`
    )
    .run({
      depositId: params.depositId,
      status: params.status,
      solanaSignature: params.solanaSignature ?? null,
      confirmedAmountUsdc: params.confirmedAmountUsdc ?? null,
      error: params.error ?? null,
      arrivedAt,
      now,
    });
}

export function getPendingDeposits(): DepositRow[] {
  return db()
    .prepare(
      `SELECT * FROM deposits WHERE status NOT IN ('arrived_on_solana', 'failed')`
    )
    .all() as DepositRow[];
}

export function getAllDeposits(statusFilter?: string): DepositRow[] {
  if (statusFilter) {
    return db()
      .prepare(
        `SELECT * FROM deposits WHERE status = ? ORDER BY created_at DESC`
      )
      .all(statusFilter) as DepositRow[];
  }
  return db()
    .prepare(`SELECT * FROM deposits ORDER BY created_at DESC`)
    .all() as DepositRow[];
}

export function getDeposit(depositId: string): DepositRow | null {
  return (
    (db()
      .prepare(`SELECT * FROM deposits WHERE deposit_id = ?`)
      .get(depositId) as DepositRow | undefined) ?? null
  );
}

export function deleteDeposit(depositId: string): boolean {
  const result = db()
    .prepare(`DELETE FROM deposits WHERE deposit_id = ?`)
    .run(depositId);
  return result.changes > 0;
}

export interface SummaryStats {
  total: number;
  pending: number;
  arrived: number;
  failed: number;
  totalUsdcBridged: string;
  avgArrivalTimeSeconds: number | null;
  oldestPending: { depositId: string; ageSeconds: number } | null;
}

export function getSummary(): SummaryStats {
  const d = db();

  const counts = d
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status NOT IN ('arrived_on_solana','failed') THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN status = 'arrived_on_solana' THEN 1 ELSE 0 END) AS arrived,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM deposits`
    )
    .get() as { total: number; pending: number; arrived: number; failed: number };

  // Sum USDC for arrived deposits
  const usdcRow = d
    .prepare(
      `SELECT COALESCE(SUM(CAST(confirmed_amount_usdc AS REAL)), 0) AS total
       FROM deposits WHERE status = 'arrived_on_solana'`
    )
    .get() as { total: number };

  const totalUsdc = usdcRow.total.toFixed(6);

  // Average seconds from created_at to arrived_at
  const avgRow = d
    .prepare(
      `SELECT AVG((arrived_at - created_at) / 1000.0) AS avg_s
       FROM deposits WHERE status = 'arrived_on_solana' AND arrived_at IS NOT NULL`
    )
    .get() as { avg_s: number | null };

  // Oldest still-pending deposit
  const now = Date.now();
  const oldestRow = d
    .prepare(
      `SELECT deposit_id, created_at FROM deposits
       WHERE status NOT IN ('arrived_on_solana','failed')
       ORDER BY created_at ASC LIMIT 1`
    )
    .get() as { deposit_id: string; created_at: number } | undefined;

  return {
    total: counts.total,
    pending: counts.pending,
    arrived: counts.arrived,
    failed: counts.failed,
    totalUsdcBridged: totalUsdc,
    avgArrivalTimeSeconds: avgRow.avg_s != null ? Math.round(avgRow.avg_s * 10) / 10 : null,
    oldestPending: oldestRow
      ? {
          depositId: oldestRow.deposit_id,
          ageSeconds: Math.floor((now - oldestRow.created_at) / 1000),
        }
      : null,
  };
}
