# Task: Publish @nirholas/agent-payments-sdk@0.2.0 to npm

## Context

Package location: `/workspaces/agent-payments-sdk`
npm account: `nirholas`
Target version: `0.2.0`
Scope: `@nirholas` (public scoped package)

This task assumes:
- DTS errors have been fixed (prompt 01)
- package.json is production-ready (prompt 02)
- Build has been verified (prompt 03)

---

## Step 1: Check npm authentication

```bash
npm whoami
```

**If logged in:** output will be `nirholas`. Proceed to Step 2.

**If not logged in:** output will be an error like `ENEEDAUTH`. Two options:

### Option A: NPM_TOKEN environment variable (preferred for CI/automated)
```bash
# The user must provide their npm token. Stop here and output this message:
echo "Please set NPM_TOKEN environment variable before running this task:"
echo "  export NPM_TOKEN=<your_npm_token>"
echo "Then re-run this task."
```
If `NPM_TOKEN` is set:
```bash
npm config set //registry.npmjs.org/:_authToken "${NPM_TOKEN}"
npm whoami
```

### Option B: Interactive login
```bash
npm login
# Follow the prompts (username: nirholas, password, email, OTP)
```

**IMPORTANT:** Do not proceed past Step 1 if `npm whoami` does not return `nirholas`. Output clear instructions for the user and stop.

---

## Step 2: Final build

Ensure the dist/ is fresh and the build is clean:

```bash
cd /workspaces/agent-payments-sdk && npm run clean && npm run build 2>&1
```

Must exit 0. If it fails, stop and report the error.

Verify the version in package.json is `0.2.0`:
```bash
node -e "const p = JSON.parse(require('fs').readFileSync('/workspaces/agent-payments-sdk/package.json', 'utf8')); console.log('version:', p.version); if (p.version !== '0.2.0') process.exit(1);"
```

---

## Step 3: Dry-run pack and inspect file list

```bash
cd /workspaces/agent-payments-sdk && npm pack --dry-run 2>&1
```

Review the file list in the output. Confirm:
- `dist/` files are present
- `package.json` is present
- `src/` files are NOT present
- No test files are present

If `src/` files appear, the `files` array in package.json is misconfigured. Fix it before continuing.

---

## Step 4: Publish

```bash
cd /workspaces/agent-payments-sdk && npm publish --access public 2>&1
```

Expected output includes:
```
npm notice Publishing to https://registry.npmjs.org/ with tag latest and public access
+ @nirholas/agent-payments-sdk@0.2.0
```

**If the version already exists** (E403 "You cannot publish over the previously published version"):
```bash
# Bump to a patch version
cd /workspaces/agent-payments-sdk
node -e "
const fs = require('fs');
const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const [maj, min, patch] = p.version.split('.').map(Number);
p.version = \`\${maj}.\${min}.\${patch + 1}\`;
fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');
console.log('bumped to', p.version);
"
npm run build && npm publish --access public 2>&1
```

---

## Step 5: Verify the publish

Wait ~30 seconds for the registry to propagate, then verify:

```bash
npm show @nirholas/agent-payments-sdk 2>&1
```

Expected output includes `version: '0.2.0'` and `dist-tags: { latest: '0.2.0' }`.

Also verify the dist-tags:
```bash
npm dist-tag ls @nirholas/agent-payments-sdk 2>&1
```

---

## Step 6: End-to-end import verification

Test that the published package can be imported. Create a temporary directory:

```bash
TMPDIR=$(mktemp -d) && cd "$TMPDIR" && cat > package.json <<'EOF'
{"name":"test","version":"1.0.0","type":"module"}
EOF
npm install @nirholas/agent-payments-sdk 2>&1
node --input-type=module <<'VERIFY'
import('@nirholas/agent-payments-sdk').then(m => {
  const keys = Object.keys(m).slice(0, 5);
  console.log('Published package exports:', keys);
  if (keys.length === 0) { console.error('ERROR: no exports'); process.exit(1); }
  console.log('SUCCESS: package is live and importable');
}).catch(e => { console.error('FAILED:', e.message); process.exit(1); });
VERIFY
```

---

## Notes on scoped packages

`@nirholas/agent-payments-sdk` is a scoped package. Scoped packages are private by default on npm. The `--access public` flag (or `"publishConfig": { "access": "public" }` in package.json) is required.

The package.json already has:
```json
"publishConfig": {
  "access": "public"
}
```

So `npm publish` (without `--access public`) will also work, but adding the flag is safe.

---

## Success criteria

```
✔ npm whoami returns nirholas
✔ npm run build exits 0
✔ npm publish exits 0 with "+ @nirholas/agent-payments-sdk@0.2.0"
✔ npm show @nirholas/agent-payments-sdk shows version 0.2.0
✔ Published package can be imported in a fresh node project
```
