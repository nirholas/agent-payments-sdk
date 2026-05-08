# Task: Verify the full build of @nirholas/agent-payments-sdk

## Repo location
`/workspaces/agent-payments-sdk`

This task assumes the DTS errors (prompt 01) and package.json (prompt 02) have already been fixed. Your job is to verify everything is correct and fix any remaining issues before publishing.

---

## Step 1: Clean build from scratch

```bash
cd /workspaces/agent-payments-sdk && npm run clean && npm run build 2>&1
```

Must exit 0. If it doesn't, read the errors carefully and fix them before proceeding.

---

## Step 2: Verify all dist files exist

Check every expected output file:

```bash
# Root entry point
ls -la /workspaces/agent-payments-sdk/dist/index.js
ls -la /workspaces/agent-payments-sdk/dist/index.cjs
ls -la /workspaces/agent-payments-sdk/dist/index.d.ts

# EVM entry point
ls -la /workspaces/agent-payments-sdk/dist/evm/index.js
ls -la /workspaces/agent-payments-sdk/dist/evm/index.cjs
ls -la /workspaces/agent-payments-sdk/dist/evm/index.d.ts

# Solana entry point
ls -la /workspaces/agent-payments-sdk/dist/solana/index.js
ls -la /workspaces/agent-payments-sdk/dist/solana/index.cjs
ls -la /workspaces/agent-payments-sdk/dist/solana/index.d.ts

# Legacy agent payments
ls -la /workspaces/agent-payments-sdk/dist/solana/legacy-agent-payments/index.js
ls -la /workspaces/agent-payments-sdk/dist/solana/legacy-agent-payments/index.cjs
ls -la /workspaces/agent-payments-sdk/dist/solana/legacy-agent-payments/index.d.ts

# Solana agent kit plugin
ls -la /workspaces/agent-payments-sdk/dist/solana/solana-agent-kit/index.js
ls -la /workspaces/agent-payments-sdk/dist/solana/solana-agent-kit/index.cjs
ls -la /workspaces/agent-payments-sdk/dist/solana/solana-agent-kit/index.d.ts

# x402
ls -la /workspaces/agent-payments-sdk/dist/x402/index.js
ls -la /workspaces/agent-payments-sdk/dist/x402/index.cjs
ls -la /workspaces/agent-payments-sdk/dist/x402/index.d.ts
```

If any file is missing, the build has failed or tsup.config.ts entry points are misconfigured. Fix the issue.

---

## Step 3: Smoke-test ESM imports

For each entry point, dynamically import the ESM build and print 3 exported names. This verifies the JS is valid and exports are accessible.

```bash
# Root index
node --input-type=module <<'EOF'
import('/workspaces/agent-payments-sdk/dist/index.js').then(m => {
  const keys = Object.keys(m).slice(0, 5);
  console.log('index exports:', keys);
  if (keys.length === 0) process.exit(1);
}).catch(e => { console.error('index FAILED:', e.message); process.exit(1); });
EOF

# EVM
node --input-type=module <<'EOF'
import('/workspaces/agent-payments-sdk/dist/evm/index.js').then(m => {
  const keys = Object.keys(m).slice(0, 5);
  console.log('evm exports:', keys);
  if (keys.length === 0) process.exit(1);
}).catch(e => { console.error('evm FAILED:', e.message); process.exit(1); });
EOF

# Solana
node --input-type=module <<'EOF'
import('/workspaces/agent-payments-sdk/dist/solana/index.js').then(m => {
  const keys = Object.keys(m).slice(0, 5);
  console.log('solana exports:', keys);
  if (keys.length === 0) process.exit(1);
}).catch(e => { console.error('solana FAILED:', e.message); process.exit(1); });
EOF

# x402
node --input-type=module <<'EOF'
import('/workspaces/agent-payments-sdk/dist/x402/index.js').then(m => {
  const keys = Object.keys(m).slice(0, 5);
  console.log('x402 exports:', keys);
  if (keys.length === 0) process.exit(1);
}).catch(e => { console.error('x402 FAILED:', e.message); process.exit(1); });
EOF

# Solana legacy agent payments
node --input-type=module <<'EOF'
import('/workspaces/agent-payments-sdk/dist/solana/legacy-agent-payments/index.js').then(m => {
  const keys = Object.keys(m).slice(0, 5);
  console.log('legacy-agent-payments exports:', keys);
  if (keys.length === 0) process.exit(1);
}).catch(e => { console.error('legacy-agent-payments FAILED:', e.message); process.exit(1); });
EOF

# Solana agent kit plugin
node --input-type=module <<'EOF'
import('/workspaces/agent-payments-sdk/dist/solana/solana-agent-kit/index.js').then(m => {
  const keys = Object.keys(m).slice(0, 5);
  console.log('solana-agent-kit exports:', keys);
  if (keys.length === 0) process.exit(1);
}).catch(e => { console.error('solana-agent-kit FAILED:', e.message); process.exit(1); });
EOF
```

If any of these print "FAILED", investigate the dist file content and fix.

**Note:** Some modules depend on `@solana/web3.js`, `@coral-xyz/anchor`, etc. If those are not installed in the workspace, the dynamic import will throw. In that case, run `npm install` first:
```bash
cd /workspaces/agent-payments-sdk && npm install
```

---

## Step 4: Verify DTS files have actual content

The `.d.ts` files must not be empty and must contain real type definitions:

```bash
# Check root index.d.ts
wc -l /workspaces/agent-payments-sdk/dist/index.d.ts
head -20 /workspaces/agent-payments-sdk/dist/index.d.ts

# Check solana index.d.ts
wc -l /workspaces/agent-payments-sdk/dist/solana/index.d.ts
head -20 /workspaces/agent-payments-sdk/dist/solana/index.d.ts

# Check x402 index.d.ts
wc -l /workspaces/agent-payments-sdk/dist/x402/index.d.ts
head -20 /workspaces/agent-payments-sdk/dist/x402/index.d.ts

# Check evm index.d.ts
wc -l /workspaces/agent-payments-sdk/dist/evm/index.d.ts
head -20 /workspaces/agent-payments-sdk/dist/evm/index.d.ts
```

If any `.d.ts` is empty or only contains `export {};`, the DTS build failed silently. In that case:
1. Check if `dts: { resolve: true }` is in `tsup.config.ts`.
2. Run `npx tsc --noEmit` to see TypeScript errors directly.
3. Fix the underlying type errors, then rebuild.

---

## Step 5: npm pack dry run

```bash
cd /workspaces/agent-payments-sdk && npm pack --dry-run 2>&1
```

Inspect the output. It must:
- Include `dist/` files
- Include `package.json`
- Include `README.md` (if exists)
- NOT include `src/` files
- NOT include test files (`*.test.ts`)
- NOT include node_modules

Total packed size should be reasonable (under 2MB unpacked).

---

## Step 6: Run tests

```bash
cd /workspaces/agent-payments-sdk && npm test 2>&1
```

All tests must pass. If any test fails due to a build change, investigate and fix.

---

## Fixing common issues

### Issue: `Cannot find module '@pump-fun/pump-sdk'`
The package is already in `dependencies`. Run `npm install` to ensure it's installed:
```bash
cd /workspaces/agent-payments-sdk && npm install
```

### Issue: `dts build failed` with no useful message
Add `--verbose` to tsup and check:
```bash
cd /workspaces/agent-payments-sdk && npx tsup --verbose 2>&1 | head -100
```

### Issue: ESM smoke test fails with `ERR_REQUIRE_ESM`
You're using `require()` on an ESM file. Use `node --input-type=module` as shown above.

### Issue: dist file exists but exports are empty `{}`
The entry point file exports nothing. Read the source file and ensure it has actual exports:
```bash
cat /workspaces/agent-payments-sdk/src/index.ts
```

---

## Success criteria

```
✔ npm run build exits 0, no errors
✔ All 18 dist files exist (.js, .cjs, .d.ts for each of 6 entry points)
✔ Each ESM smoke test prints at least 3 export names
✔ Each .d.ts file has >10 lines of content
✔ npm pack --dry-run output contains only dist/ + package.json + README.md
✔ npm test passes
```
