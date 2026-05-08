# @nirholas/agent-payments-sdk — Final Pre-Release Checklist

## Goal
Complete all pre-release tasks for @nirholas/agent-payments-sdk@0.2.0 and publish to npm.

## Context
- Repo: /workspaces/agent-payments-sdk
- This is the final step after all other prompts complete
- npm account: nirholas
- GitHub: github.com/nirholas/agent-payments-sdk

## Implementation

### 1. Final build verification
```bash
cd /workspaces/agent-payments-sdk
npm run build
```
Must exit 0. Zero DTS errors. All entry points present in dist/.

### 2. Version check
- package.json version must be 0.2.0
- CHANGELOG.md must have [0.2.0] section
- Git tag: `git tag v0.2.0`

### 3. Run full test suite
```bash
npx vitest run
```
All tests pass.

### 4. npm pack dry run
```bash
npm pack --dry-run
```
Verify: only dist/, package.json, README.md, CHANGELOG.md in the package. No src/, no .env, no .wallet.json.

### 5. Publish
```bash
npm publish --access public
```
If NPM_TOKEN not set: exit with clear instructions for the user.

### 6. Post-publish verification
```bash
npm show @nirholas/agent-payments-sdk
# Verify version 0.2.0 is listed
```

Test install in a temp directory:
```bash
mkdir /tmp/test-install && cd /tmp/test-install
npm init -y
npm install @nirholas/agent-payments-sdk
node -e "const sdk = require('@nirholas/agent-payments-sdk'); console.log(Object.keys(sdk).slice(0, 10))"
```

### 7. Update three.ws to use published package
In /workspaces/three.ws:
- Remove agent-payments-sdk from workspaces
- Change `"@pump-fun/agent-payments-sdk": "^3.1.0"` to `"@nirholas/agent-payments-sdk": "^0.2.0"`
- Update all imports in three.ws from @pump-fun/agent-payments-sdk to @nirholas/agent-payments-sdk
- npm install
- Verify build still works

### 8. GitHub release
```bash
gh release create v0.2.0 \
  --title "v0.2.0 — v2 Bonding Curve + EVM + USDC" \
  --notes "See CHANGELOG.md for full notes" \
  --repo nirholas/agent-payments-sdk
```

### 9. Push final state
Push to main on agent-payments-sdk with the v0.2.0 tag.

## Deliverables
- @nirholas/agent-payments-sdk@0.2.0 live on npm
- GitHub release created
- three.ws updated to use published package
