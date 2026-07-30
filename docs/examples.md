# agent-payments-sdk examples

Cross-chain payments SDK for Pump Agent — Solana-native + EVM cross-chain support

## Example 1

```bash
npm i github:nirholas/agent-payments-sdk
```

## Example 2

```bash
git clone https://github.com/nirholas/agent-payments-sdk
cd agent-payments-sdk && npm ci && npm run build
```

## Example 3

```bash
npm ci                 # install from the committed package-lock.json
npm run build          # tsup, dual ESM + CJS into dist/
npm run build:prod     # tsup --minify
npm run typecheck      # tsc --noEmit
npm test               # vitest run
npm run test:watch     # vitest
npm run test:coverage  # vitest run --coverage
npm run clean          # rm -rf dist
```


Every snippet above is taken from the [repository documentation](https://github.com/nirholas/agent-payments-sdk#readme).
