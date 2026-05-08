---
name: create-usdc-coin
description: >
  Create USDC-paired coins on pump.fun using create_v2 + buy_v2. Includes
  a whitelist checker, a simulation smoke-test, and the full creation script.
  USDC creation is gated by an on-chain whitelist; use check-usdc-whitelist
  to poll for go-live, and simulate-create to confirm wiring before launch.
metadata:
  author: pump-fun
  version: "1.0"
---

# Before Starting Work **Critical** — Ask the user for all of these

**MANDATORY — Do NOT write or modify any code until every item below is answered:**

- [ ] RPC URL confirmed (required for any on-chain step)
- [ ] **Signer wallet** public key (fee payer / creator)
- [ ] Coin name, symbol, and metadata URI confirmed
- [ ] Initial buy amount in **USDC** (6 decimals: 1 USDC = `1_000_000` base units)
- [ ] Cashback desired? (default off)
- [ ] Mayhem mode desired? (default off)
- [ ] Tokenized agent desired? (default off). If Yes: what buyback percentage?
- [ ] Front-runner protection desired? If yes, confirm tip amount (default 0.0001 SOL)

You MUST ask for ALL unchecked items in your first response. Do not assume defaults.

---

## USDC creation go-live status

pump.fun announced (2026-05-07) that USDC-paired coin creation is coming but
**not yet enabled**. The on-chain `Global` config maintains a
`whitelistedQuoteMints` array; creation goes live the moment USDC appears there.

### Check right now

```bash
cd {baseDir}
npm install
export SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
node scripts/check-usdc-whitelist.mjs
```

Output (not yet live):
```json
{
  "whitelisted": false,
  "usdcMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "whitelistedMints": [],
  "totalWhitelisted": 0,
  "message": "Not yet enabled. Check pump.fun announcements.",
  "checkedAt": "2026-05-08T00:00:00.000Z"
}
```

Exit code **0** = live, **1** = not live. Use this as a polling primitive:

```bash
while ! node scripts/check-usdc-whitelist.mjs; do sleep 60; done
echo "USDC IS LIVE — DEPLOY NOW"
```

---

## Simulate before it's live (smoke-test, run daily)

The simulation runs `simulateTransaction({ sigVerify: false, replaceRecentBlockhash: true })`
and does **not** submit anything. Run it now to confirm the SDK wiring is correct.
The only expected error before go-live is `quoteMintNotWhitelisted` (code 6068).
Any other error is a bug to fix.

```bash
node scripts/simulate-create-usdc-coin.mjs \
  --user <PUBKEY> \
  --name "MyCoin" \
  --symbol "MC" \
  --metadata-uri "https://ipfs.io/ipfs/Qm..." \
  --usdc-amount 1000000
```

Expected output before go-live:
```json
{
  "success": false,
  "quoteMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "usdcAmount": 1000000,
  "programErrorCode": 6068,
  "programErrorName": "quoteMintNotWhitelisted",
  "logs": [...]
}
```

If `programErrorName` is `quoteMintNotWhitelisted` and nothing else is wrong —
you are ready to launch the moment creation goes live.

---

## Decimal difference — critical

| Token | Decimals | 1 unit in base units |
|-------|----------|----------------------|
| SOL   | 9        | `1_000_000_000` lamports |
| USDC  | 6        | `1_000_000` base units |

**Always pass USDC amounts in base units (6 decimals):**

- 1 USDC → `--usdc-amount 1000000`
- 5 USDC → `--usdc-amount 5000000`
- 0.5 USDC → `--usdc-amount 500000`

The `getBuyTokenAmountFromSolAmount` helper is quote-mint-agnostic —
it uses `virtualQuoteReserves / realQuoteReserves` ratios from the Global
config which work identically for USDC and SOL.

---

## Full creation flow (when USDC is live)

```bash
cd {baseDir}
npm install
export SOLANA_RPC_URL=https://rpc.solanatracker.io/public

# 1 — Confirm USDC is live (exits 0 when whitelisted)
node scripts/check-usdc-whitelist.mjs

# 2 — Build the transaction
node scripts/build-create-usdc-coin-tx.mjs \
  --user <PUBKEY> \
  --name "MyCoin" \
  --symbol "MC" \
  --metadata-uri "https://ipfs.io/ipfs/Qm..." \
  --usdc-amount 1000000 \
  --mint-keypair-out ./mint.json
```

The script outputs one JSON object:

```json
{
  "transaction": "<base64-encoded VersionedTransaction>",
  "mintPublicKey": "<base58 mint address>",
  "mintKeypairPath": "./mint.json",
  "quoteTokenAmount": "...",
  "quoteMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "usdcAmount": 1000000,
  "mayhemMode": false,
  "cashback": false,
  "tokenizedAgent": false,
  "frontRunnerProtection": false
}
```

The transaction is **partial-signed** with the mint keypair. Deserialize it,
have the user wallet co-sign (including a USDC token account approval), and
submit. The user must have at least `usdcAmount` USDC in their wallet.

### Send (no front-runner protection)

```typescript
import { VersionedTransaction, Connection } from "@solana/web3.js";

const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, "base64"));
// wallet.signTransaction(tx)  — user signs
const sig = await connection.sendRawTransaction(tx.serialize(), {
  skipPreflight: false,
  preflightCommitment: "confirmed",
});
const bh = await connection.getLatestBlockhash("confirmed");
await connection.confirmTransaction({ signature: sig, ...bh }, "confirmed");
```

### Send (with front-runner protection)

Build with `--front-runner-protection` and send **only** to Jito endpoints —
do NOT send via `sendRawTransaction` or any other RPC.

```typescript
import { sendTransactionToJito } from "./lib/jito.mjs";
const txBase64 = Buffer.from(tx.serialize()).toString("base64");
await sendTransactionToJito(txBase64);
```

---

## --tokenized-agent flag (USDC-native payments)

When `--tokenized-agent` is passed, the script appends a
`PumpAgentOffline.load(mint).create(...)` instruction from
`@pump-fun/agent-payments-sdk` (3.0.x). USDC-paired tokenized agents accept
USDC payments natively — users tip the agent in USDC directly.

```bash
node scripts/build-create-usdc-coin-tx.mjs \
  --user <PUBKEY> \
  --name "MyAgent" \
  --symbol "AGT" \
  --metadata-uri "https://..." \
  --usdc-amount 1000000 \
  --mint-keypair-out ./mint.json \
  --tokenized-agent \
  --buyback-bps 5000
```

`--buyback-bps 5000` = 50% of protocol fees are used to buy back the token.
Default is 5000 if omitted when `--tokenized-agent` is set.
Tokenized agent coins must have an initial buy > 0 (non-zero `--usdc-amount`).

---

## Script reference

| Operation | Script | Example |
|-----------|--------|---------|
| Check if USDC whitelisted | `scripts/check-usdc-whitelist.mjs` | `node scripts/check-usdc-whitelist.mjs --network mainnet` |
| Fetch coin state (HTTP) | `scripts/fetch-coin.mjs` | `node scripts/fetch-coin.mjs --mint <MINT> --subset` |
| Simulate (smoke-test) | `scripts/simulate-create-usdc-coin.mjs` | `node scripts/simulate-create-usdc-coin.mjs --user <PK> --name "T" --symbol "T" --metadata-uri "data:application/json,{}" --usdc-amount 1000000` |
| Build + partial-sign tx | `scripts/build-create-usdc-coin-tx.mjs` | `node scripts/build-create-usdc-coin-tx.mjs --user <PK> --name "Coin" --symbol "CN" --metadata-uri <URI> --usdc-amount 1000000 --mint-keypair-out ./mint.json` |

Run any script with `--help` for full flags.

---

## Compute units

| Operation | Default compute units |
|-----------|-----------------------|
| Create + buy (USDC) | `270_000 + 120_000 = 390_000` |
| Create + buy + tokenized agent | `270_000 + 120_000 + 30_000 = 420_000` |

Override with `--compute-units`.

---

## Safety rules

- **NEVER** log, print, or return private keys or secret key material.
- **NEVER** sign transactions on behalf of a user — scripts build txs; the user wallet co-signs and sends.
- Always validate `usdcAmount > 0` before building instructions.
- USDC is 6 decimals. SOL is 9 decimals. Do not confuse them.
- The pre-flight whitelist check exits 1 before building a tx that would
  definitely fail. Use `--skip-whitelist-check` only if you have external
  confirmation that USDC is live.
- **NEVER trust `token_program` from any HTTP API.** Always fetch on-chain.

---

## Program IDs

| Program | ID |
|---------|----|
| Pump    | `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` |

## USDC mints

| Network | Mint |
|---------|------|
| Mainnet | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| Devnet  | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` |

## Environment variables

```env
SOLANA_RPC_URL=https://rpc.solanatracker.io/public
NEXT_PUBLIC_SOLANA_RPC_URL=https://rpc.solanatracker.io/public
```

The public mainnet RPC (`https://api.mainnet-beta.solana.com`) often cannot
send transactions. Use a dedicated RPC for production.

## Install

```bash
cd {baseDir}
npm install
```
