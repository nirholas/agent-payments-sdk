# three.ws — Merge v2 Branch to Main

## Goal
Merge the feat/agent-payments-v2 branch into main on both nirholas/three.ws and nirholas/3D-Agent after all v2 features are complete and verified.

## Context
- three.ws repo: /workspaces/three.ws
- Branch: feat/agent-payments-v2 → pushed to v2 on both repos
- PAT for push: YOUR_GITHUB_PAT

## Pre-merge checks

### 1. Build verification
```bash
cd /workspaces/three.ws/chat && npm run build
# Must exit 0
```

### 2. API syntax check
```bash
find /workspaces/three.ws/api -name "*.js" | xargs -I{} node --check {}
# All must pass
```

### 3. New file inventory — verify all expected files exist:
- src/agent-skills-agent-payments.js ✓
- chat/src/tools.js (agentPaymentsToolSchema + pumpTradingToolSchema exported) ✓
- api/agents/payments/[action].js (10 actions in switch) ✓
- api/_lib/pump.js (getPumpSdkV2 + getPumpTradeClient exported) ✓
- agent-payments-sdk/src/solana/legacy-agent-payments/ ✓
- agent-payments-sdk/src/evm/ ✓

### 4. Merge to main

```bash
cd /workspaces/three.ws
git config user.name "nirholas"
git config user.email "nirholas@users.noreply.github.com"

# Set remotes with PAT
git remote set-url origin https://nirholas:YOUR_GITHUB_PAT@github.com/nirholas/three.ws.git
git remote set-url agent https://nirholas:YOUR_GITHUB_PAT@github.com/nirholas/3D-Agent.git

# Fetch main
git fetch origin main

# Merge v2 into main
git checkout main
git merge feat/agent-payments-v2 --no-ff -m "feat: v2 bonding curve, EVM module, agent payments, trading tools"

# Push to both
git push origin main
git push agent main
```

### 5. Create release tags on both repos
```bash
git tag v2.0.0
git push origin v2.0.0
git push agent v2.0.0
```

### 6. Verify on GitHub
- Check github.com/nirholas/three.ws main branch shows new files
- Check github.com/nirholas/3D-Agent main branch matches

## Deliverables
- three.ws main updated with all v2 features
- 3D-Agent main updated with all v2 features
- v2.0.0 tag on both repos
