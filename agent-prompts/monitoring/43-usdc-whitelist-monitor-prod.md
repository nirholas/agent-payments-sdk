# USDC Whitelist Monitor — Production Deployment

## Goal
Deploy the USDC whitelist watcher as a persistent background process that automatically creates a USDC-quoted pump.fun coin the instant pump.fun whitelists USDC — zero manual intervention required.

## Context
- Working repo: /workspaces/agent-payments-sdk
- Wallet: /workspaces/agent-payments-sdk/.wallet.json (EVMpqJEYoWHKhAnDZEa2mT4GyBoMTWGXkSdV1zQB9v8B)
- Wallet balance: ~0.137 SOL + 4.36 USDC
- pump.fun Global PDA: 4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf
- USDC mint: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
- @pump-fun/pump-sdk@1.35.0 installed in /workspaces/agent-payments-sdk/swap/node_modules/
- Metadata pre-uploaded: https://ipfs.io/ipfs/QmfTCrSFAp7GQG9aByvgwfaCwkzE9KpTXB5tMmFjnAEc89 (TEST coin, symbol TEST, creator nirholas)

## Implementation

### 1. Create /workspaces/agent-payments-sdk/scripts/usdc-whitelist-monitor.mjs

Full production-grade watcher:

```javascript
#!/usr/bin/env node
/**
 * USDC Whitelist Monitor
 * Polls pump.fun Global account every 15s.
 * The instant USDC appears in whitelistedQuoteMints, fires create_v2 tx.
 */
```

Requirements:
- Load wallet from .wallet.json
- Use WebSocket subscription (connection.onAccountChange) for instant detection — do NOT poll only
- Also poll every 15s as a backup in case WebSocket misses the update
- On USDC detected:
  1. Log timestamp + block height of detection
  2. Generate new mint keypair, save to .usdc-coin-mint.json
  3. Build createV2Instruction with quoteMint = USDC_MINT
  4. Add ComputeBudgetProgram.setComputeUnitLimit(200_000) + setComputeUnitPrice(500_000) (high priority)
  5. Simulate first — if simulation fails, log error and retry in 5s
  6. Send transaction with skipPreflight: true (speed matters)
  7. Wait for confirmation (max 60s)
  8. Write result to .usdc-coin-result.json: { mint, txSignature, pumpUrl, detectedAt, createdAt }
  9. Log loudly to console: pump.fun/{mint}
- Use Helius RPC if HELIUS_RPC_URL env var set, fallback to mainnet-beta
- Graceful shutdown on SIGINT/SIGTERM

### 2. Create /workspaces/agent-payments-sdk/scripts/check-whitelist.mjs

Quick one-shot check:
```
node scripts/check-whitelist.mjs
# Output: USDC: NOT whitelisted | Whitelist: [pubkey1, pubkey2]
# Or:     USDC: LIVE ✅ | Added at block: XXXXXXXX
```

### 3. Add npm script to package.json
```json
"scripts": {
  "watch:usdc": "node scripts/usdc-whitelist-monitor.mjs",
  "check:whitelist": "node scripts/check-whitelist.mjs"
}
```

### 4. Verify
- Run `npm run check:whitelist` — must output current whitelist state
- Run `npm run watch:usdc -- --dry-run` — must subscribe and log "Watching for USDC..."
- The dry-run flag skips the actual tx send but does the simulation

## Deliverables
- /workspaces/agent-payments-sdk/scripts/usdc-whitelist-monitor.mjs
- /workspaces/agent-payments-sdk/scripts/check-whitelist.mjs
- Updated package.json scripts
