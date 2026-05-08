# Prompt 26 — Real-Time Bonding Curve WebSocket Feed

## Goal
Build `/workspaces/three.ws/src/pump/bonding-curve-feed.js` — a production-grade real-time bonding curve price subscription service using Solana WebSocket account subscriptions. No mocks. Connects to live mainnet.

## Environment
- Working directory: `/workspaces/three.ws`
- Runtime: Node.js / Vercel serverless (ESM)
- Solana WSS: `process.env.SOLANA_WSS_URL` or `wss://api.mainnet-beta.solana.com`
- Solana HTTP RPC: `process.env.SOLANA_RPC_URL` or `https://api.mainnet-beta.solana.com`
- Existing libs: `@solana/web3.js`, `@pump-fun/pump-sdk`, `@pump-fun/pump-swap-sdk`, `bn.js`
- Existing util: `/workspaces/three.ws/api/_lib/pump.js` — `getConnection()`

## Bonding Curve PDA Derivation
```
programId = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P')
seeds = [Buffer.from('bonding-curve'), mint.toBuffer()]
[pda, bump] = PublicKey.findProgramAddressSync(seeds, programId)
```

## Account Data Layout

### v1 — 49 bytes (legacy SOL-quoted curves)
```
Offset  Size  Field
0       8     discriminator (ignore)
8       8     virtualTokenReserves  (u64, little-endian)
16      8     virtualQuoteReserves  (u64, little-endian)  — SOL lamports
24      8     realTokenReserves     (u64)
32      8     realQuoteReserves     (u64)
40      8     tokenTotalSupply      (u64)
48      1     complete              (bool)
```

### v2 — 115 bytes (USDC or SOL quoted)
```
Offset  Size  Field
0       8     discriminator (ignore)
8       8     virtualTokenReserves  (u64)
16      8     virtualQuoteReserves  (u64)
24      8     realTokenReserves     (u64)
32      8     realQuoteReserves     (u64)
40      8     tokenTotalSupply      (u64)
48      1     complete              (bool)
49      32    quoteMint             (PublicKey — 32 bytes)
81      8     quoteDecimals         (u64)  — decimals of quote token
89      8     tokenDecimals         (u64)  — decimals of base token
97      18    padding               (ignore)
```

USDC mint: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`
SOL (native quote): `So11111111111111111111111111111111111111112`

## Price Calculation
```
price_in_quote = virtualQuoteReserves / virtualTokenReserves
                 × 10^(tokenDecimals − quoteDecimals)

# For SOL-quoted: price_usd = price_in_quote × sol_usd_price
# For USDC-quoted: price_usd = price_in_quote  (already USD)
```

For v1 curves: tokenDecimals = 6, quoteDecimals = 9 (SOL lamports)

## SOL/USD Price
Fetch once per minute from CoinGecko (no API key needed for basic endpoint):
```
GET https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd
```
Cache the result in a module-level variable with a 60-second TTL.

## Implementation Requirements

### Class: `BondingCurveFeed`

```javascript
export class BondingCurveFeed {
  constructor(rpcWssUrl = process.env.SOLANA_WSS_URL || 'wss://api.mainnet-beta.solana.com')

  /**
   * Subscribe to real-time price updates for a single mint.
   * @param {string} mint  — base58 mint address
   * @param {function} callback — called with PriceUpdate on every change
   * @returns {function} unsubscribe — call to remove this subscription
   */
  subscribe(mint, callback)

  /**
   * Subscribe to multiple mints with one callback.
   * @param {string[]} mints
   * @param {function} callback — (PriceUpdate) => void
   * @returns {function} unsubscribeAll for this batch
   */
  subscribeMultiple(mints, callback)

  /** Unsubscribe all active subscriptions and close WebSocket. */
  unsubscribeAll()
}

/**
 * @typedef {Object} PriceUpdate
 * @property {string}  mint
 * @property {string}  bondingCurvePda  — base58
 * @property {number}  price            — price in quote token units (human-readable)
 * @property {number}  priceUsd         — price in USD
 * @property {number|null} priceChange24h — % change vs 24h ago (null if unknown)
 * @property {bigint}  reserveQuote     — raw virtualQuoteReserves
 * @property {bigint}  reserveTokens    — raw virtualTokenReserves
 * @property {number}  marketCapUsd
 * @property {boolean} complete         — true when graduated
 * @property {string}  quoteMint        — base58 quote mint
 * @property {number}  version          — 1 or 2
 * @property {number}  updatedAt        — unix ms
 */
```

### Subscription cap
Hard-limit at **100 concurrent mint subscriptions** (Solana RPC limit). If over limit, `subscribe()` must throw `Error('BondingCurveFeed: subscription cap reached (100)')`.

### Reconnection
Use exponential backoff starting at 1 s, max 60 s, with jitter (±20%). On reconnect, re-register all active subscriptions. Log reconnect attempts to `console.warn`.

### Price change tracking
Keep a 24-hour price history ring buffer per mint (max 1440 entries — one per minute). On each update, emit `priceChange24h` as percent change from the oldest entry. Only emit the callback if price actually changed (compare to last emitted price with at least 6-significant-figure precision).

### Singleton export
```javascript
export const globalFeed = new BondingCurveFeed(
  process.env.SOLANA_WSS_URL || 'wss://api.mainnet-beta.solana.com'
);
```

## File to Create
`/workspaces/three.ws/src/pump/bonding-curve-feed.js`

## Step-by-step Implementation Plan

1. **Module-level state:**
   - `_solUsdPrice`, `_solUsdFetchedAt` — SOL/USD cache
   - `_subscriptions = new Map<mint, Set<callback>>` — per-mint callbacks
   - `_subIds = new Map<mint, number>` — Solana subscription IDs from `onAccountChange`
   - `_priceHistory = new Map<mint, Array<{price, ts}>>` — ring buffers
   - `_lastPrice = new Map<mint, number>` — last emitted price per mint

2. **`_getSolUsd()`** — fetch or return cached SOL/USD price

3. **`_derivePda(mint)`** — compute bonding curve PDA deterministically

4. **`_decodeAccount(data)`** — detect v1/v2 by data.length, decode Buffer, return raw fields

5. **`_processAccountData(mint, data)`** — decode → calculate price → update history → emit if changed

6. **`_startWatching(mint)`** — call `connection.onAccountChange(pda, handler, 'processed')`

7. **`_stopWatching(mint)`** — call `connection.removeAccountChangeListener(subId)`

8. **`subscribe(mint, callback)`** — add to `_subscriptions`, call `_startWatching` if first subscriber

9. **`unsubscribe(mint, callback)`** — remove from set, stop watching if no more callbacks

10. **`subscribeMultiple(mints, callback)`** — subscribe each, return unsubscribe fn that removes all

11. **`unsubscribeAll()`** — iterate all, stop watching, clear maps

12. **Reconnection logic:** override the Connection's WebSocket with a custom WS that detects close/error and re-establishes

## Important Notes
- Use `connection.onAccountChange` not raw WebSocket — `@solana/web3.js` handles framing
- `Buffer.readBigUInt64LE(offset)` for u64 fields
- `data[48]` (byte) for the `complete` boolean
- For quoteMint in v2: `new PublicKey(data.slice(49, 81)).toBase58()`
- The Connection object re-subscribes on reconnect automatically when using `onAccountChange` on recent `@solana/web3.js`; verify this by testing disconnect and checking callbacks resume
- Add a `// @ts-check` comment at the top and use JSDoc types throughout
- Export both the class and the singleton

## Verification
After implementing, add a quick smoke-test at the bottom behind `if (import.meta.url === new URL(import.meta.url).href)` that subscribes to a known pump.fun mint (hardcode one for testing) and logs 3 updates then exits.
