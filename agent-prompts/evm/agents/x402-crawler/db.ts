// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
// All rights reserved.

import Database from "better-sqlite3";

export interface PageRow {
  url: string;
  status: number | null;
  payment_required: number; // 0 | 1
  payment_scheme: string | null;
  price_usdc: string | null;
  paid: number; // 0 | 1
  payment_tx_hash: string | null;
  content_type: string | null;
  body: string | null;
  discovered_at: number;
  paid_at: number | null;
  depth: number;
  parent_url: string | null;
}

export interface CrawlSessionRow {
  id: number;
  started_at: number;
  finished_at: number | null;
  total_spent_usdc: string;
  pages_discovered: number;
  pages_paid: number;
  seed_urls: string;
}

let _db: Database.Database | null = null;

export function openDb(dbPath: string): Database.Database {
  _db = new Database(dbPath);
  _db.pragma("journal_mode = WAL");
  _db.exec(`
    CREATE TABLE IF NOT EXISTS pages (
      url              TEXT PRIMARY KEY,
      status           INTEGER,
      payment_required INTEGER DEFAULT 0,
      payment_scheme   TEXT,
      price_usdc       TEXT,
      paid             INTEGER DEFAULT 0,
      payment_tx_hash  TEXT,
      content_type     TEXT,
      body             TEXT,
      discovered_at    INTEGER NOT NULL,
      paid_at          INTEGER,
      depth            INTEGER DEFAULT 0,
      parent_url       TEXT
    );

    CREATE TABLE IF NOT EXISTS crawl_sessions (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at        INTEGER NOT NULL,
      finished_at       INTEGER,
      total_spent_usdc  TEXT NOT NULL DEFAULT '0.000000',
      pages_discovered  INTEGER NOT NULL DEFAULT 0,
      pages_paid        INTEGER NOT NULL DEFAULT 0,
      seed_urls         TEXT NOT NULL
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

// ── Pages ────────────────────────────────────────────────────────────────────

export function upsertPage(row: Omit<PageRow, "paid" | "payment_tx_hash" | "body" | "paid_at"> & Partial<Pick<PageRow, "paid" | "payment_tx_hash" | "body" | "paid_at">>): void {
  db()
    .prepare(
      `INSERT INTO pages
         (url, status, payment_required, payment_scheme, price_usdc,
          paid, payment_tx_hash, content_type, body, discovered_at, paid_at, depth, parent_url)
       VALUES
         (@url, @status, @payment_required, @payment_scheme, @price_usdc,
          @paid, @payment_tx_hash, @content_type, @body, @discovered_at, @paid_at, @depth, @parent_url)
       ON CONFLICT(url) DO UPDATE SET
         status           = COALESCE(@status, status),
         payment_required = @payment_required,
         payment_scheme   = COALESCE(@payment_scheme, payment_scheme),
         price_usdc       = COALESCE(@price_usdc, price_usdc),
         content_type     = COALESCE(@content_type, content_type),
         body             = COALESCE(@body, body)`
    )
    .run({
      url: row.url,
      status: row.status ?? null,
      payment_required: row.payment_required,
      payment_scheme: row.payment_scheme ?? null,
      price_usdc: row.price_usdc ?? null,
      paid: row.paid ?? 0,
      payment_tx_hash: row.payment_tx_hash ?? null,
      content_type: row.content_type ?? null,
      body: row.body ?? null,
      discovered_at: row.discovered_at,
      paid_at: row.paid_at ?? null,
      depth: row.depth,
      parent_url: row.parent_url ?? null,
    });
}

export function markPaid(url: string, txHash: string, paidAt: number): void {
  db()
    .prepare(
      `UPDATE pages SET paid = 1, payment_tx_hash = ?, paid_at = ? WHERE url = ?`
    )
    .run(txHash, paidAt, url);
}

export function updateBody(url: string, body: string, contentType: string | null, status: number): void {
  db()
    .prepare(
      `UPDATE pages SET body = ?, content_type = ?, status = ? WHERE url = ?`
    )
    .run(body, contentType, status, url);
}

export function getPage(url: string): PageRow | null {
  return (db().prepare(`SELECT * FROM pages WHERE url = ?`).get(url) as PageRow | undefined) ?? null;
}

export function getPayablePages(): PageRow[] {
  return db()
    .prepare(
      `SELECT * FROM pages
       WHERE payment_required = 1 AND paid = 0 AND price_usdc IS NOT NULL
       ORDER BY CAST(price_usdc AS REAL) ASC`
    )
    .all() as PageRow[];
}

export function getAllPages(): PageRow[] {
  return db().prepare(`SELECT * FROM pages ORDER BY discovered_at ASC`).all() as PageRow[];
}

export function getPaidPages(): PageRow[] {
  return db().prepare(`SELECT * FROM pages WHERE paid = 1`).all() as PageRow[];
}

export function pageExists(url: string): boolean {
  const row = db().prepare(`SELECT 1 FROM pages WHERE url = ?`).get(url);
  return row != null;
}

export function purgePages(): void {
  db().prepare(`DELETE FROM pages`).run();
}

// ── Crawl sessions ────────────────────────────────────────────────────────────

export function startSession(seedUrls: string[]): number {
  const result = db()
    .prepare(
      `INSERT INTO crawl_sessions (started_at, seed_urls) VALUES (?, ?)`
    )
    .run(Date.now(), seedUrls.join(","));
  return result.lastInsertRowid as number;
}

export function finishSession(
  id: number,
  totalSpentUsdc: string,
  pagesDiscovered: number,
  pagesPaid: number
): void {
  db()
    .prepare(
      `UPDATE crawl_sessions SET
         finished_at      = ?,
         total_spent_usdc = ?,
         pages_discovered = ?,
         pages_paid       = ?
       WHERE id = ?`
    )
    .run(Date.now(), totalSpentUsdc, pagesDiscovered, pagesPaid, id);
}

export function getLastSession(): CrawlSessionRow | null {
  return (
    (db()
      .prepare(`SELECT * FROM crawl_sessions ORDER BY started_at DESC LIMIT 1`)
      .get() as CrawlSessionRow | undefined) ?? null
  );
}

export function getAllSessions(): CrawlSessionRow[] {
  return db()
    .prepare(`SELECT * FROM crawl_sessions ORDER BY started_at DESC`)
    .all() as CrawlSessionRow[];
}

export function purgeSessions(): void {
  db().prepare(`DELETE FROM crawl_sessions`).run();
}
