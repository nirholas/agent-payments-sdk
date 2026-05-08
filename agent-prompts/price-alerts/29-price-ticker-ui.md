# Prompt 29 — Real-Time Price Ticker UI Components

## Goal
Add three Svelte UI components to the three.ws chat:
1. `PriceTicker.svelte` — scrolling live price ticker bar
2. `PriceAlertBell.svelte` — alert bell with badge and dropdown
3. Wire both into `App.svelte`

## Environment
- Working directory: `/workspaces/three.ws/chat/src/`
- Framework: Svelte (read existing `.svelte` files for patterns before writing)
- Alert API: `/api/alerts/list`, `/api/alerts/delete`
- Price stream: `/api/pump/price-stream?mints=...` (SSE, from prompt 28)
- Existing components to reference: `NotificationBell.svelte`, `Notifications.svelte`, `App.svelte`, `stores.js`
- CSS: read `app.pcss` for design tokens (colors, fonts, spacing)

## Before You Start
Read these files to understand conventions:
1. `/workspaces/three.ws/chat/src/App.svelte` — understand layout, where header/input are
2. `/workspaces/three.ws/chat/src/NotificationBell.svelte` — pattern for bell + dropdown
3. `/workspaces/three.ws/chat/src/stores.js` — understand reactive stores
4. `/workspaces/three.ws/chat/src/app.pcss` — CSS variables and utilities

## Task 1 — PriceTicker.svelte

Create `/workspaces/three.ws/chat/src/PriceTicker.svelte`.

### Behavior
- On mount: fetch `/api/alerts/list?active=true` to get the user's alert mints
- Open an `EventSource` to `/api/pump/price-stream?mints=MINT1,MINT2,...`
- Show a horizontal scrolling ticker of coin prices
- Only render if there is at least one active alert / subscription
- Auto-reconnect if EventSource disconnects (use exponential backoff, 1s → 60s)
- On unmount: close EventSource

### UI Design
```
┌────────────────────────────────────────────────────────────────────┐
│  ● LIVE  │  ABC...1234 $0.000123 (+12.3%)  │  XYZ...5678 $0.0045 (-2.1%)  │ ...
└────────────────────────────────────────────────────────────────────┘
```
- Red dot "● LIVE" indicator on the left (blinking animation)
- Each coin: `{MINT_SHORT} ${price} ({change%})` — MINT_SHORT = first 4 + "..." + last 4 chars
- Positive change: text-green-400; negative: text-red-400; zero: text-gray-400
- CSS marquee scroll: use `@keyframes marquee` with `transform: translateX`
- Total ticker width: 100% of container; font-size: 12px; height: 28px
- Click on any coin entry: dispatch a `selectCoin` custom Svelte event with `{ mint }` so App.svelte can inject "Tell me about {mint}" into the chat input

### Svelte Component Structure
```svelte
<script>
  import { onMount, onDestroy } from 'svelte';
  import { createEventDispatcher } from 'svelte';
  
  const dispatch = createEventDispatcher();
  
  let coins = [];      // [{ mint, symbol, priceUsd, change, complete }]
  let connected = false;
  let es = null;
  let retryTimer = null;
  
  async function loadAlerts() { ... }
  function connect(mints) { ... }   // opens EventSource
  function disconnect() { ... }     // closes EventSource
  
  onMount(async () => {
    const mints = await loadAlerts();
    if (mints.length > 0) connect(mints);
  });
  
  onDestroy(() => disconnect());
  
  function handleCoinClick(mint) {
    dispatch('selectCoin', { mint });
  }
</script>
```

### CSS (inline <style>)
```css
.ticker-bar {
  display: flex;
  align-items: center;
  overflow: hidden;
  background: var(--color-bg-secondary, #1a1a2e);
  border-top: 1px solid var(--color-border, #333);
  height: 28px;
  font-size: 12px;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  user-select: none;
}
.ticker-live {
  flex-shrink: 0;
  padding: 0 10px;
  color: #ff4444;
  font-weight: bold;
  display: flex;
  align-items: center;
  gap: 4px;
  border-right: 1px solid var(--color-border, #333);
}
.ticker-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #ff4444;
  animation: blink 1s infinite;
}
.ticker-track {
  flex: 1;
  overflow: hidden;
}
.ticker-inner {
  display: flex;
  gap: 32px;
  animation: marquee 30s linear infinite;
  white-space: nowrap;
}
.ticker-inner:hover { animation-play-state: paused; }
.coin-entry { cursor: pointer; padding: 0 4px; }
.coin-entry:hover { text-decoration: underline; }
.positive { color: #4ade80; }
.negative { color: #f87171; }
.neutral  { color: #9ca3af; }
@keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.2; } }
@keyframes marquee { 0% { transform: translateX(0); } 100% { transform: translateX(-50%); } }
```

## Task 2 — PriceAlertBell.svelte

Create `/workspaces/three.ws/chat/src/PriceAlertBell.svelte`.

Pattern: follow `NotificationBell.svelte` exactly for the dropdown mechanics; replace content.

### Behavior
- Fetch `/api/alerts/list?active=true` on mount and every 60 seconds
- Show bell icon with badge count of active (non-triggered) alerts
- Click: toggle dropdown open/closed
- Dropdown: list of active alerts, each row shows:
  - Mint (truncated), alert type, threshold, creation date
  - "× Delete" button → calls `DELETE /api/alerts/delete?id={id}`, removes from list
- At the bottom of the dropdown: "Set new alert" text that dispatches `openAlertWizard` event
- When an alert has `triggered_at` set, show it in green with "✓ Triggered" and allow dismissal

### Props
```svelte
<script>
  export let onSelectCoin = null;  // optional callback
</script>
```

### Alert display format per row:
```
ABCD...1234  |  above $0.0005  |  set 2026-05-01  [×]
WXYZ...9876  |  gain 50%       |  set 2026-05-03  [×]
```

## Task 3 — Wire into App.svelte

Read `/workspaces/three.ws/chat/src/App.svelte` carefully before editing.

### Add PriceTicker
- Import `PriceTicker` at the top
- Find the bottom of the chat layout (near the message input area)
- Add `{#if $hasActiveAlerts}<PriceTicker on:selectCoin={handleTickerCoinSelect} />{/if}` just above the input form
- Add a Svelte store `hasActiveAlerts` (writable boolean, default false) to `stores.js`, set to true when PriceAlertBell fetches ≥1 alert
- `handleTickerCoinSelect`: `function handleTickerCoinSelect(e) { inputText = "Tell me about " + e.detail.mint; inputEl?.focus(); }`

### Add PriceAlertBell
- Import `PriceAlertBell` at the top
- Find the header/toolbar area (look for where `NotificationBell` or the wallet connect button is rendered)
- Add `<PriceAlertBell />` in the same area, to the left of NotificationBell

### Alert Toast Notifications
When an alert triggers (detected via polling `/api/alerts/list?active=false&since=<timestamp>`):
- Show a toast notification using the existing `Notifications` component pattern
- Have Claude announce it by injecting a system message into the conversation: `"[ALERT TRIGGERED] Your price alert for {mint} fired: {condition}"` — this should be displayed as an assistant message in the chat thread

## Toast Implementation
Look for how toasts/notifications currently work in the app (search `Notifications.svelte` and `stores.js` for the notification store). Add an alert notification using that same pattern. Do not invent a new toast system if one already exists.

## File Checklist
- [ ] `/workspaces/three.ws/chat/src/PriceTicker.svelte`
- [ ] `/workspaces/three.ws/chat/src/PriceAlertBell.svelte`
- [ ] `/workspaces/three.ws/chat/src/App.svelte` — wired
- [ ] `/workspaces/three.ws/chat/src/stores.js` — `hasActiveAlerts` store added if needed

## Verification
1. `grep -n 'PriceTicker' /workspaces/three.ws/chat/src/App.svelte` — should find import and usage
2. `grep -n 'PriceAlertBell' /workspaces/three.ws/chat/src/App.svelte` — should find import and usage
3. `node -e "import('/workspaces/three.ws/chat/src/PriceTicker.svelte')"` — (Svelte files aren't directly node-importable but the file should exist and be valid Svelte syntax)
