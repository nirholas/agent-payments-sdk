# Task: Fix all TypeScript DTS build errors in @nirholas/agent-payments-sdk

## Repo location
`/workspaces/agent-payments-sdk`

Published as `@nirholas/agent-payments-sdk` (TypeScript SDK for pump.fun agent payments on Solana + EVM).

## Build command
```bash
cd /workspaces/agent-payments-sdk && npm run build
```

The build uses `tsup` (see `tsup.config.ts`). It must exit 0 with zero DTS errors.

---

## Known DTS errors to fix

### 1. `src/solana/pdas.ts` — TS7016 on `import type BN from "bn.js"`

**File:** `/workspaces/agent-payments-sdk/src/solana/pdas.ts`

**Current (line 7):**
```ts
import type { BN } from "@coral-xyz/anchor";
```

This file currently imports `BN` correctly. However, if the build emits TS7016 ("Could not find declaration file for module 'bn.js'") from any file that does `import type BN from "bn.js"` (bare default import), the fix is to ensure all `BN` usage comes from `@coral-xyz/anchor`:
```ts
import { BN } from "@coral-xyz/anchor";
```

Read the file first, check if the import is already correct, and if any file in `src/` uses `import ... from "bn.js"` directly — change those to use `@coral-xyz/anchor`.

Search:
```bash
grep -r 'from "bn.js"' /workspaces/agent-payments-sdk/src/
grep -r "from 'bn.js'" /workspaces/agent-payments-sdk/src/
```

For each hit: replace with `import { BN } from "@coral-xyz/anchor"` (or `import type { BN } from "@coral-xyz/anchor"` if only used as a type).

### 2. `src/solana/solana-agent-kit/actions.ts` — `zod` not a runtime dependency

**File:** `/workspaces/agent-payments-sdk/src/solana/solana-agent-kit/actions.ts`

The file imports `z` from `"zod"`. Check:
```bash
grep -n 'from "zod"' /workspaces/agent-payments-sdk/src/solana/solana-agent-kit/actions.ts
```

`zod` is already in `dependencies` in `/workspaces/agent-payments-sdk/package.json`. However it is also listed as an optional `peerDependency`, which can confuse tsup's DTS bundler. The fix:

1. Read `/workspaces/agent-payments-sdk/package.json`.
2. Ensure `"zod": "^3.23.0"` is under `dependencies` (not only peerDependencies).
3. Remove zod from `peerDependencies` if its presence there causes DTS resolution to fail during build. Alternatively keep it in both but ensure the version range in peerDependencies matches.

If DTS still fails due to zod types not resolving: add `"@types/zod"` is not needed (zod ships its own types). Instead ensure `skipLibCheck` is not hiding the real error — read `tsconfig.json`:
```bash
cat /workspaces/agent-payments-sdk/tsconfig.json
```

### 3. `src/solana/PumpTradeClient.ts` — `@pump-fun/pump-sdk` TS2307

**File:** `/workspaces/agent-payments-sdk/src/solana/PumpTradeClient.ts`

Check the import:
```bash
head -30 /workspaces/agent-payments-sdk/src/solana/PumpTradeClient.ts
```

`@pump-fun/pump-sdk` must be in `dependencies` so its types are available during DTS emit. Check:
```bash
cat /workspaces/agent-payments-sdk/package.json | grep pump-sdk
```

If it is only in `devDependencies`, move it to `dependencies`:
```json
"dependencies": {
  "@pump-fun/pump-sdk": "^1.35.0",
  ...
}
```

### 4. `tsup.config.ts` — DTS build "error occurred in dts build"

**File:** `/workspaces/agent-payments-sdk/tsup.config.ts`

If the DTS phase fails with a generic "error occurred in dts build", the standard fix is to add `dts: { resolve: true }` so tsup resolves type-only imports into the bundle, and to explicitly point at the tsconfig:

```ts
export default defineConfig({
  entry: {
    index: "src/index.ts",
    "evm/index": "src/evm/index.ts",
    "solana/index": "src/solana/index.ts",
    "solana/legacy-agent-payments/index": "src/solana/legacy-agent-payments/index.ts",
    "solana/solana-agent-kit/index": "src/solana/solana-agent-kit/index.ts",
    "x402/index": "src/x402/index.ts",
  },
  format: ["esm", "cjs"],
  dts: { resolve: true },
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
});
```

Also check if `tsconfig.json` has `"composite": true` or `"incremental": true` — these can interfere with tsup's `dts` flag. If present, remove them or set `"incremental": false`.

---

## Step-by-step instructions

1. **Read every relevant file before editing:**
   - `/workspaces/agent-payments-sdk/tsconfig.json`
   - `/workspaces/agent-payments-sdk/tsup.config.ts`
   - `/workspaces/agent-payments-sdk/package.json`
   - `/workspaces/agent-payments-sdk/src/solana/pdas.ts`
   - `/workspaces/agent-payments-sdk/src/solana/PumpTradeClient.ts`
   - `/workspaces/agent-payments-sdk/src/solana/solana-agent-kit/actions.ts`
   - `/workspaces/agent-payments-sdk/src/solana/solana-agent-kit/index.ts`
   - `/workspaces/agent-payments-sdk/src/x402/index.ts`
   - `/workspaces/agent-payments-sdk/src/x402/evm-client.ts`
   - `/workspaces/agent-payments-sdk/src/x402/evm-facilitator.ts`

2. **Run the build to see the actual errors:**
   ```bash
   cd /workspaces/agent-payments-sdk && npm run build 2>&1
   ```
   Capture all error lines before making changes.

3. **Fix each error** using the Edit tool. Do not use `// @ts-ignore`. Fix the root cause.

4. **Run the build again:**
   ```bash
   cd /workspaces/agent-payments-sdk && npm run build 2>&1
   ```
   Repeat until exit code is 0 and no DTS errors appear in stdout/stderr.

5. **Verify dist files were created:**
   ```bash
   ls /workspaces/agent-payments-sdk/dist/
   ls /workspaces/agent-payments-sdk/dist/solana/
   ls /workspaces/agent-payments-sdk/dist/x402/
   ```

6. **Run typecheck separately for extra confidence:**
   ```bash
   cd /workspaces/agent-payments-sdk && npm run typecheck 2>&1
   ```

---

## Constraints

- Do NOT add `// @ts-ignore` or `// @ts-expect-error` comments.
- Do NOT change the public API signatures of any exported function/class.
- Do NOT add mock implementations. All code must be real.
- The ESM and CJS builds must still pass (not just DTS).
- All existing tests must still pass: `npm test` in `/workspaces/agent-payments-sdk`.

---

## Success criteria

```
✔ Build exits 0
✔ No DTS errors in output
✔ dist/index.d.ts exists and is non-empty
✔ dist/solana/index.d.ts exists and is non-empty
✔ dist/x402/index.d.ts exists and is non-empty
✔ npm test passes
```
