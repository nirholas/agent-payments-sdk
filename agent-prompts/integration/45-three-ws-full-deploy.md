# three.ws v2 Branch — Full Integration Verification

## Goal
Verify that the entire v2 branch of three.ws/3D-Agent builds cleanly, all new API endpoints respond correctly, and all new chat tools are properly registered.

## Context
- Repo: /workspaces/three.ws (branch: feat/agent-payments-v2, pushed to v2 on both nirholas/three.ws and nirholas/3D-Agent)
- New files added:
  - src/agent-skills-agent-payments.js — 8 agent payment skills
  - chat/src/tools.js — agentPaymentsToolSchema (4 tools) + pumpTradingToolSchema (5 tools)
  - api/agents/payments/[action].js — 5 new actions (balances, distribute-prep/confirm, withdraw-prep/confirm, check-whitelist)
  - api/_lib/pump.js — getPumpSdkV2(), getPumpTradeClient()
  - agent-payments-sdk/src/ — entire v3.1.0 source tree

## Implementation

### 1. Verify chat build
```bash
cd /workspaces/three.ws/chat
npm install
npm run build
```
Fix any build errors. Common issues:
- Missing imports in App.svelte
- Undefined exports from tools.js
- Svelte component syntax errors

### 2. Verify API syntax
Run node syntax check on all new/modified API files:
```bash
for f in api/agents/payments/[action].js api/_lib/pump.js; do
  node --check $f && echo "OK: $f" || echo "ERROR: $f"
done
```
Fix any syntax errors.

### 3. Verify agent-payments-sdk workspace build
```bash
cd /workspaces/three.ws/agent-payments-sdk
npm install
npm run build
```
Fix any DTS or ESM build errors.

### 4. Verify tool schema completeness
Write a small verification script:
```javascript
import { pumpTradingToolSchema, agentPaymentsToolSchema } from '/workspaces/three.ws/chat/src/tools.js'
// Verify all tools have: clientDefinition.body, type, function.name, function.parameters
```

### 5. Verify API endpoints (mock test — no real DB needed)
- Check all new action cases exist in the switch statement of [action].js
- Check all new handlers are defined

### 6. Commit all fixes and push
```bash
git add -A
git commit -m "fix: v2 branch build verification fixes"
git push origin feat/agent-payments-v2:v2 --force
```
Push to both nirholas/three.ws and nirholas/3D-Agent using PAT: YOUR_GITHUB_PAT

Set remote URLs:
```bash
git remote set-url origin https://nirholas:YOUR_GITHUB_PAT@github.com/nirholas/three.ws.git
git remote set-url agent https://nirholas:YOUR_GITHUB_PAT@github.com/nirholas/3D-Agent.git
```

## Deliverables
- Clean chat build (no errors)
- All API files pass node --check
- Both repos updated on v2 branch
