# Task 15 — Build a robust IPFS metadata upload endpoint for pump.fun

You are a senior Node.js engineer. Complete this task end-to-end in a single session — real API calls to pump.fun's IPFS gateway, no mocks, production-quality code.

## Goal

Create `/workspaces/three.ws/api/pump/upload-metadata.js` — a POST endpoint that accepts coin metadata + optional image, uploads to pump.fun's IPFS gateway (`https://pump.fun/api/ipfs`), and returns the resulting metadata URI.

## Files to read first

1. `/workspaces/three.ws/api/pump/[action].js` — read the imports at the top to understand what helpers are available (e.g., `cors`, `error`, `json`, `readJson`, `limits`, `clientIp`)
2. `/workspaces/three.ws/vercel.json` (if it exists) — check routing config; you may need to add the new endpoint
3. `/workspaces/three.ws/package.json` — check which HTTP/form-data packages are available (node-fetch, form-data, etc.)

## What pump.fun/api/ipfs expects

The endpoint accepts `multipart/form-data` with these fields:
- `name` (string, required)
- `symbol` (string, required)
- `description` (string, required)
- `showName` (string, `"true"` or `"false"`)
- `twitter` (string, optional URL)
- `telegram` (string, optional URL)
- `website` (string, optional URL)
- `file` (binary, the coin image — PNG/JPG/GIF/SVG)

It returns JSON: `{ metadataUri: "https://ipfs.io/ipfs/Qm...", image: "https://ipfs.io/ipfs/Qm..." }`

## Implementation

Create `/workspaces/three.ws/api/pump/upload-metadata.js` with the following structure:

### Imports

Use whatever is already available in the three.ws project. Common candidates:
- `node-fetch` or native `fetch` (Node 18+)
- `form-data` npm package for building multipart bodies
- `sharp` if available for image processing (optional)

Check `package.json` first before importing.

### Rate limiting

Use the same `limits` helper as `[action].js`:
```js
const rl = await limits.authIp(clientIp(req));
if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');
```

Additionally, add a stricter per-IP upload limit (5 uploads/minute) using a simple in-memory Map:
```js
const uploadCounts = new Map(); // ip -> { count, resetAt }
function checkUploadLimit(ip) {
  const now = Date.now();
  const entry = uploadCounts.get(ip) || { count: 0, resetAt: now + 60_000 };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + 60_000; }
  entry.count++;
  uploadCounts.set(ip, entry);
  return entry.count <= 5;
}
```

### Input validation

Accept JSON body with this shape:
```js
{
  name: string,           // 1-32 chars, required
  symbol: string,         // 2-10 chars, required
  description: string,    // max 500 chars, required
  showName?: boolean,     // default true
  twitter?: string,       // optional, must start with https:// if provided
  telegram?: string,      // optional
  website?: string,       // optional
  imageUrl?: string,      // optional — fetch this URL server-side
  imageBase64?: string,   // optional — base64-encoded image data
  imageMimeType?: string, // optional — MIME type for base64 image (default image/png)
}
```

Validate with your own checks (no extra zod import needed — just plain conditionals):
```js
if (!name || name.length < 1 || name.length > 32) return error(res, 400, 'validation_error', 'name must be 1-32 chars');
if (!symbol || symbol.length < 2 || symbol.length > 10) return error(res, 400, 'validation_error', 'symbol must be 2-10 chars');
if (!description || description.length > 500) return error(res, 400, 'validation_error', 'description max 500 chars');
if (twitter && !twitter.startsWith('https://')) return error(res, 400, 'validation_error', 'twitter must be https URL');
```

### Image acquisition

Priority order:
1. If `imageBase64` is provided: decode with `Buffer.from(imageBase64, 'base64')`
2. If `imageUrl` is provided: fetch it server-side with a 10-second timeout
3. If neither: generate a placeholder SVG

```js
async function fetchImageBuffer(imageUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(imageUrl, { signal: controller.signal });
    if (!res.ok) throw new Error(`image fetch failed: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const ct = res.headers.get('content-type') || 'image/png';
    return { buffer: buf, mimeType: ct.split(';')[0].trim() };
  } finally {
    clearTimeout(timeout);
  }
}
```

### Placeholder image generator

When no image is provided, generate a minimal SVG with:
- A solid background color derived from the symbol (deterministic, e.g., hash the symbol to pick from 8 colors)
- The symbol text centered in white, bold, large font

```js
function generatePlaceholderSvg(symbol) {
  const colors = ['#6366f1','#8b5cf6','#ec4899','#f97316','#06b6d4','#10b981','#f59e0b','#ef4444'];
  const colorIdx = symbol.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0) % colors.length;
  const bg = colors[colorIdx];
  const text = symbol.slice(0, 4).toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="256" fill="${bg}"/>
  <text x="256" y="320" font-family="Arial,sans-serif" font-size="180" font-weight="bold"
        fill="white" text-anchor="middle">${text}</text>
</svg>`;
  return Buffer.from(svg, 'utf8');
}
```

### Forwarding to pump.fun/api/ipfs

Use the `form-data` package to build the multipart body:

```js
const FormData = require('form-data');
const form = new FormData();
form.append('name', name);
form.append('symbol', symbol);
form.append('description', description);
form.append('showName', showName ? 'true' : 'false');
if (twitter) form.append('twitter', twitter);
if (telegram) form.append('telegram', telegram);
if (website) form.append('website', website);
form.append('file', imageBuffer, {
  filename: `${symbol.toLowerCase()}.${mimeToExt(imageMimeType)}`,
  contentType: imageMimeType,
});

const upstream = await fetch('https://pump.fun/api/ipfs', {
  method: 'POST',
  body: form,
  headers: form.getHeaders(),
  signal: AbortSignal.timeout(30_000),
});
if (!upstream.ok) {
  const errBody = await upstream.text();
  console.error('[upload-metadata] pump.fun/api/ipfs error:', upstream.status, errBody);
  return error(res, 502, 'upstream_error', `pump.fun IPFS returned ${upstream.status}`);
}
const data = await upstream.json();
```

### Response

```js
return json(res, 200, {
  metadataUri: data.metadataUri,
  imageUri: data.image,
  name,
  symbol,
});
```

### Full handler skeleton

```js
import cors from '...';     // same cors helper as [action].js
import { error, json, readJson } from '...';  // same helpers
import { limits, clientIp } from '...';       // same rate limiter

export default async function handler(req, res) {
  if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
  if (req.method !== 'POST') return error(res, 405, 'method_not_allowed', 'POST only');

  const ip = clientIp(req);
  const rl = await limits.authIp(ip);
  if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');
  if (!checkUploadLimit(ip)) return error(res, 429, 'upload_limit', 'max 5 uploads per minute');

  const body = await readJson(req);
  // ... validate ...
  // ... get image ...
  // ... forward to pump.fun ...
  // ... return response ...
}
```

## Routing

After creating the file, check whether `/workspaces/three.ws/vercel.json` has explicit route mappings. If it does, add:
```json
{ "src": "/api/pump/upload-metadata", "dest": "/api/pump/upload-metadata.js" }
```

If routing is handled by the filesystem (Next.js-style or Vercel auto-discovery), no change needed.

## Testing

After implementation, test the endpoint by calling it from Node with a real HTTP request:

```js
// test-upload.mjs
const res = await fetch('http://localhost:3000/api/pump/upload-metadata', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    name: 'TestCoin',
    symbol: 'TEST',
    description: 'A test coin for upload verification.',
    // No image — will use placeholder
  }),
});
console.log(res.status, await res.json());
```

Run the dev server first (`npm run dev` or `vercel dev`) and execute the test. Verify:
- Response status 200
- `metadataUri` starts with `https://ipfs.io/ipfs/`
- `imageUri` is a valid IPFS URL

## Checklist

- [ ] Read `[action].js` imports and helpers before starting
- [ ] Check `package.json` for available dependencies
- [ ] Create `/workspaces/three.ws/api/pump/upload-metadata.js`
- [ ] Implement all three image paths (base64, URL fetch, placeholder SVG)
- [ ] Implement rate limiting (global + per-IP upload limit)
- [ ] Validate all input fields
- [ ] Forward to pump.fun/api/ipfs as multipart
- [ ] Return `{ metadataUri, imageUri, name, symbol }`
- [ ] Add routing if needed
- [ ] Run a real test call against the live pump.fun IPFS endpoint

## Do not

- Do not install new npm packages without first checking if a suitable one exists in package.json
- Do not use fs.writeFile to store images locally
- Do not hardcode any API keys
- Do not skip the real pump.fun API call — the test must hit the live endpoint
