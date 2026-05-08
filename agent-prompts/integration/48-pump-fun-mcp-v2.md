# pump.fun MCP Server — v2 Tools Update

## Goal
Update the pump.fun MCP server in three.ws to add v2 bonding curve tools: buy_v2, sell_v2, check_usdc_whitelist, get_bonding_curve_v2.

## Context
- MCP server: /workspaces/three.ws/workers/pump-fun-mcp/worker.js
- MCP server is a Cloudflare Worker that exposes pump.fun tools via MCP protocol
- Current tools: getTrendingTokens, getNewTokens, getKingOfTheHill, searchTokens, getTokenDetails, getBondingCurve, getTokenTrades, getTokenHolders, getWalletPortfolio
- @pump-fun/pump-sdk@1.35.0: PUMP_SDK, OnlinePumpSdk, bondingCurvePda, isLegacyQuoteMint

## Implementation

### 1. Read /workspaces/three.ws/workers/pump-fun-mcp/worker.js

### 2. Add these new MCP tools:

**getBondingCurveV2** — get v2 bonding curve data including quoteMint
```
input: { mint: string }
output: { mint, virtualQuoteReserves, virtualTokenReserves, quoteMint, quoteSymbol, priceQuote, priceUsd, marketCapUsd, complete, isV2, graduationProgressPct }
```

**checkUsdcWhitelist** — check if USDC is live
```
input: {}
output: { isUsdcLive, whitelistedQuoteMints, createV2Enabled }
```

**getSmartMoneyFlow** — get GMGN smart money signals (if GMGN_API_KEY in env)
```
input: { mint: string }
output: { signals: [{ type, wallet, amount, confidence }], netFlow, sentiment }
```

**getTokenV2Stats** — combined stats for v2 coin
```
input: { mint: string }
output: { ...getBondingCurveV2 output, ...getTokenDetails output, recentTrades: last 10 }
```

### 3. Update the MCP server's tool list and handler dispatch

### 4. Deploy check
- The worker should still pass `wrangler dev` (or equivalent local test)
- Verify all existing tools still work

### 5. Update pumpToolSchema in three.ws/chat/src/tools.js
Add the new MCP tools to pumpToolSchema so Claude can use them in chat:
- getBondingCurveV2 
- checkUsdcWhitelist (using pumpBody pattern)
- getTokenV2Stats

## Deliverables
- Updated /workspaces/three.ws/workers/pump-fun-mcp/worker.js
- Updated /workspaces/three.ws/chat/src/tools.js with new pump tools
- Push to v2 branch on both repos
