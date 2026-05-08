# Task: Update package.json for production npm publish

## Repo location
`/workspaces/agent-payments-sdk`

Published package name: `@nirholas/agent-payments-sdk`

---

## Goal

Make `/workspaces/agent-payments-sdk/package.json` production-ready for npm publish as `@nirholas/agent-payments-sdk@0.2.0`.

---

## Step-by-step instructions

### Step 1: Read current state

```bash
cat /workspaces/agent-payments-sdk/package.json
cat /workspaces/agent-payments-sdk/tsup.config.ts
```

### Step 2: Apply all required changes to package.json

Edit `/workspaces/agent-payments-sdk/package.json` to match the requirements below. Use the Edit tool — read the file first, then make targeted edits.

#### 2a. Version and name

```json
{
  "name": "@nirholas/agent-payments-sdk",
  "version": "0.2.0"
}
```

#### 2b. Complete exports map

The `tsup.config.ts` defines these entry points:
- `index: "src/index.ts"`
- `"evm/index": "src/evm/index.ts"`
- `"solana/index": "src/solana/index.ts"`
- `"solana/legacy-agent-payments/index": "src/solana/legacy-agent-payments/index.ts"`
- `"solana/solana-agent-kit/index": "src/solana/solana-agent-kit/index.ts"`
- `"x402/index": "src/x402/index.ts"`

The `exports` map must cover all of them:

```json
"exports": {
  ".": {
    "types": "./dist/index.d.ts",
    "import": "./dist/index.js",
    "require": "./dist/index.cjs"
  },
  "./evm": {
    "types": "./dist/evm/index.d.ts",
    "import": "./dist/evm/index.js",
    "require": "./dist/evm/index.cjs"
  },
  "./evm/index": {
    "types": "./dist/evm/index.d.ts",
    "import": "./dist/evm/index.js",
    "require": "./dist/evm/index.cjs"
  },
  "./solana": {
    "types": "./dist/solana/index.d.ts",
    "import": "./dist/solana/index.js",
    "require": "./dist/solana/index.cjs"
  },
  "./solana/index": {
    "types": "./dist/solana/index.d.ts",
    "import": "./dist/solana/index.js",
    "require": "./dist/solana/index.cjs"
  },
  "./solana/legacy-agent-payments": {
    "types": "./dist/solana/legacy-agent-payments/index.d.ts",
    "import": "./dist/solana/legacy-agent-payments/index.js",
    "require": "./dist/solana/legacy-agent-payments/index.cjs"
  },
  "./solana/legacy-agent-payments/index": {
    "types": "./dist/solana/legacy-agent-payments/index.d.ts",
    "import": "./dist/solana/legacy-agent-payments/index.js",
    "require": "./dist/solana/legacy-agent-payments/index.cjs"
  },
  "./solana/solana-agent-kit": {
    "types": "./dist/solana/solana-agent-kit/index.d.ts",
    "import": "./dist/solana/solana-agent-kit/index.js",
    "require": "./dist/solana/solana-agent-kit/index.cjs"
  },
  "./solana/solana-agent-kit/index": {
    "types": "./dist/solana/solana-agent-kit/index.d.ts",
    "import": "./dist/solana/solana-agent-kit/index.js",
    "require": "./dist/solana/solana-agent-kit/index.cjs"
  },
  "./x402": {
    "types": "./dist/x402/index.d.ts",
    "import": "./dist/x402/index.js",
    "require": "./dist/x402/index.cjs"
  },
  "./x402/index": {
    "types": "./dist/x402/index.d.ts",
    "import": "./dist/x402/index.js",
    "require": "./dist/x402/index.cjs"
  }
}
```

Note: the old `"./solana-agent-kit"` alias can be kept for backward compat but also add `"./solana/solana-agent-kit"`.

#### 2c. files array

Only dist/ and the root docs should be published. No src/, no tests:

```json
"files": [
  "dist",
  "README.md",
  "CHANGELOG.md"
]
```

#### 2d. Runtime dependencies

Ensure all of these are in `dependencies` (not just devDependencies):

```json
"dependencies": {
  "@coral-xyz/anchor": "^0.31.1",
  "@pump-fun/pump-sdk": "^1.35.0",
  "@solana/spl-token": "^0.4.9",
  "@solana/web3.js": "^1.98.0",
  "bn.js": "^5.2.3",
  "viem": "^2.21.0",
  "zod": "^3.23.0"
}
```

#### 2e. peerDependencies

```json
"peerDependencies": {
  "@coral-xyz/anchor": "^0.31.1",
  "@solana/web3.js": "^1.98.0",
  "zod": "^3.0.0"
},
"peerDependenciesMeta": {
  "@coral-xyz/anchor": { "optional": true },
  "@solana/web3.js": { "optional": true },
  "zod": { "optional": true }
}
```

#### 2f. engines

```json
"engines": {
  "node": ">=18"
}
```

#### 2g. repository, bugs, homepage

```json
"repository": {
  "type": "git",
  "url": "https://github.com/nirholas/agent-payments-sdk.git"
},
"bugs": {
  "url": "https://github.com/nirholas/agent-payments-sdk/issues"
},
"homepage": "https://github.com/nirholas/agent-payments-sdk#readme"
```

#### 2h. keywords

```json
"keywords": [
  "solana",
  "pump-fun",
  "agent-payments",
  "x402",
  "evm",
  "cross-chain",
  "sdk",
  "typescript"
]
```

### Step 3: Verify the build

```bash
cd /workspaces/agent-payments-sdk && npm run build 2>&1
```

Must exit 0.

### Step 4: Verify the dist structure

```bash
ls /workspaces/agent-payments-sdk/dist/
ls /workspaces/agent-payments-sdk/dist/evm/
ls /workspaces/agent-payments-sdk/dist/solana/
ls /workspaces/agent-payments-sdk/dist/solana/legacy-agent-payments/
ls /workspaces/agent-payments-sdk/dist/solana/solana-agent-kit/
ls /workspaces/agent-payments-sdk/dist/x402/
```

Each directory must contain `.js`, `.cjs`, and `.d.ts` files.

### Step 5: Dry-run pack to confirm files

```bash
cd /workspaces/agent-payments-sdk && npm pack --dry-run 2>&1
```

Output must show `dist/` files and package.json. Must NOT show `src/` files or test files.

---

## Constraints

- Do not change the public TypeScript API of any module.
- Do not remove any existing exports.
- Do not add any new source files in this task — only edit `package.json` and `tsup.config.ts`.
- All edits must be valid JSON / TypeScript syntax.

---

## Success criteria

```
✔ npm run build exits 0
✔ All dist/ subdirectories exist with .js, .cjs, .d.ts files
✔ npm pack --dry-run lists only dist/ + package.json + README.md
✔ version in package.json is 0.2.0
✔ exports map has all 6 entry points (., ./evm, ./solana, ./solana/legacy-agent-payments, ./solana/solana-agent-kit, ./x402) with types/import/require fields
```
