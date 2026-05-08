# PumpMarketData — Quote-Normalized Price & Market Cap

## Goal
Build a `PumpMarketData` class in @nirholas/agent-payments-sdk that provides real-time price and market cap for both SOL-quoted and USDC-quoted pump.fun coins, normalized to USD.

## Context
- Repo: /workspaces/agent-payments-sdk
- @pump-fun/pump-sdk@1.35.0: PUMP_SDK.decodeBondingCurve, bondingCurvePda, OnlinePumpSdk, isLegacyQuoteMint
- v2 bonding curves: 115 bytes, have virtualQuoteReserves, quoteMint fields
- v1 bonding curves: 49 bytes, virtualSolReserves = quote reserves
- Price formula: price = virtualQuoteReserves / virtualTokenReserves (adjusted for decimals)
- SOL price: fetch from CoinGecko https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd
- USDC price: always $1.00

## Implementation

### Create src/solana/PumpMarketData.ts

```typescript
export interface CoinPrice {
  mint: PublicKey;
  priceQuote: number;       // price in quote currency (SOL or USDC)
  priceUsd: number;         // USD equivalent
  marketCapUsd: number;
  quoteMint: PublicKey;     // SOL or USDC
  quoteSymbol: 'SOL' | 'USDC' | string;
  isV2: boolean;
  complete: boolean;        // graduated to AMM
  graduationProgressPct: number; // 0-100
  virtualTokenReserves: BN;
  virtualQuoteReserves: BN;
}

export class PumpMarketData {
  constructor(connection: Connection)
  
  async getPrice(mint: PublicKey): Promise<CoinPrice>
  async getPrices(mints: PublicKey[]): Promise<Map<string, CoinPrice>>
  async getSolPrice(): Promise<number>   // cached 60s
  
  // Real-time subscription
  subscribe(mint: PublicKey, callback: (price: CoinPrice) => void): () => void
  subscribeMultiple(mints: PublicKey[], callback: (prices: Map<string, CoinPrice>) => void): () => void
}
```

Requirements:
1. Handle both v1 (49-byte) and v2 (115-byte) bonding curves
2. Auto-detect SOL vs USDC quote from quoteMint field (v2) or default SOL (v1)
3. Graduation progress: realQuoteReserves / GRADUATION_THRESHOLD * 100 (85 SOL threshold)
4. Batch RPC calls: getMultipleAccountsInfo for all mints at once
5. SOL price cache: 60 second TTL, falls back to last known on error
6. WebSocket subscriptions via connection.onAccountChange
7. Export from src/solana/index.ts

### Create src/solana/PumpMarketData.test.ts

Tests:
1. getPrice on the TEST coin (7DU5iH56AjEgbjmGJ21i1GiyxPxxGVLJwnPdar8ZmDrv) — real mainnet RPC call
2. getPrices on multiple coins simultaneously
3. Correct USD calculation for SOL-quoted coin
4. USDC-quoted coin price = directly in USD (no SOL conversion needed)
5. Graduation progress calculation

Run: npm test

## Deliverables
- src/solana/PumpMarketData.ts
- src/solana/PumpMarketData.test.ts
- Updated src/solana/index.ts exports
