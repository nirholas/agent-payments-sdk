# Task: Add x402 payment settings to the agent edit UI in three.ws chat

## Context

- three.ws chat: `/workspaces/three.ws/chat/src/`
- Agent settings modal: `/workspaces/three.ws/chat/src/AgentSettingsModal.svelte`
- The x402 pricing API: `POST /api/agents/:id/x402-pricing` (built in prompt 07)
- Payment history API: `GET /api/agents/:id/payment-history` (built in prompt 09)
- Payment history component: `/workspaces/three.ws/chat/src/PaymentHistory.svelte` (built in prompt 09)
- Design system: Tailwind CSS, slate/indigo color palette, same style as existing components

---

## Step 1: Read all relevant files

Read every file before writing:

```
/workspaces/three.ws/chat/src/AgentSettingsModal.svelte   (full file)
/workspaces/three.ws/chat/src/Modal.svelte                 (full file)
/workspaces/three.ws/chat/src/Button.svelte                (full file)
/workspaces/three.ws/chat/src/stores.js                    (activeAgent, currentUser)
/workspaces/three.ws/chat/src/TxApprovalModal.svelte       (style reference)
```

Also read PaymentHistory.svelte if it was created in prompt 09:
```
/workspaces/three.ws/chat/src/PaymentHistory.svelte
```

---

## Step 2: Understand current AgentSettingsModal structure

Note:
- What inputs currently exist (system prompt, greeting, temperature, etc.)
- Whether there are any tabs or sections
- The exact CSS classes used (to match the design)
- How `onSave` works and how the modal is closed

The existing AgentSettingsModal has these sections:
- System Prompt (textarea)
- Opening Message (textarea)
- Temperature (slider)
- Max Tokens (input)
- Tools (checkboxes)

---

## Step 3: Plan the additions

Add a new "Monetization" section to the modal with:

1. **Section header:** "Monetization" with a toggle
2. **Toggle:** "Charge for messages" (on/off)
3. When toggled on, show:
   - **Price per message:** USDC amount input (0.01 – 100, step 0.01)
   - **Free messages:** integer input (0 – 100, default 5)
   - **Description:** text input (max 100 chars, shown to payers)
   - **Payment address (payTo):** text input — defaults to `$activeAgent.wallet_address` if available
   - **Preview text:** "This agent charges $X.XX per message after Y free messages"
4. **Earnings summary:** shows totalEarnedUsdc and totalPayments (loaded from payment history API)
5. **View History button:** opens PaymentHistory panel (or links to it)

---

## Step 4: Edit AgentSettingsModal.svelte

Read the full file first, then make the following targeted additions.

### 4a. Add imports (in `<script>` block):

```js
import PaymentHistory from './PaymentHistory.svelte';
```

### 4b. Add reactive state (in `<script>` block):

```js
// x402 monetization state
let x402Draft = {
  enabled: false,
  priceUsdc: 0.10,
  freeMessages: 5,
  description: '',
  payTo: '',
};
let x402Loading = false;
let x402Error = '';
let x402Earnings = null;
let showPaymentHistory = false;

// Load x402 config when modal opens
$: if (open && $activeAgent?.id && !$activeAgent.id.startsWith('lib:')) {
  loadX402Config();
}

async function loadX402Config() {
  if (!$activeAgent?.id) return;
  x402Error = '';
  x402Loading = true;
  try {
    const res = await fetch(`/api/agents/${$activeAgent.id}/x402-pricing`, {
      credentials: 'include',
    });
    if (res.ok) {
      const data = await res.json();
      x402Draft = {
        enabled: data.x402?.enabled ?? false,
        priceUsdc: data.x402?.priceUsdc ?? 0.10,
        freeMessages: data.x402?.freeMessages ?? 5,
        description: data.x402?.description ?? '',
        payTo: data.x402?.payTo ?? ($activeAgent?.wallet_address || ''),
      };
      // Load earnings
      const earnRes = await fetch(`/api/agents/${$activeAgent.id}/payment-history?limit=1`, {
        credentials: 'include',
      });
      if (earnRes.ok) {
        const earnData = await earnRes.json();
        x402Earnings = earnData.stats;
      }
    }
  } catch (err) {
    x402Error = err.message;
  } finally {
    x402Loading = false;
  }
}

async function saveX402Pricing() {
  if (!$activeAgent?.id) return;
  x402Error = '';
  x402Loading = true;
  try {
    const res = await fetch(`/api/agents/${$activeAgent.id}/x402-pricing`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ x402: x402Draft }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error_description || `HTTP ${res.status}`);
    }
    const data = await res.json();
    if (data.earnings) x402Earnings = data.earnings;
  } catch (err) {
    x402Error = err.message;
  } finally {
    x402Loading = false;
  }
}

// Price preview string
$: pricePreview = x402Draft.enabled
  ? `This agent charges $${Number(x402Draft.priceUsdc).toFixed(2)} per message${
      x402Draft.freeMessages > 0
        ? ` after ${x402Draft.freeMessages} free message${x402Draft.freeMessages !== 1 ? 's' : ''}`
        : ''
    }`
  : 'Chat is free for all users';
```

### 4c. Add the Monetization section to the template

Find a good place to insert it in the template — after the Tools section, before the Save button. Add:

```svelte
<!-- Monetization / x402 section -->
<div class="border-t border-slate-200 pt-4">
  <div class="flex items-center justify-between mb-3">
    <span class="text-[12px] font-semibold text-slate-700">Monetization</span>
    {#if x402Earnings}
      <span class="text-[11px] text-slate-500">
        Earned: <span class="font-medium text-slate-700">${x402Earnings.totalEarnedUsdc?.toFixed(2)}</span>
        ({x402Earnings.totalPayments} payments)
      </span>
    {/if}
  </div>

  <!-- Enable toggle -->
  <label class="flex items-center gap-2 cursor-pointer mb-3">
    <input
      type="checkbox"
      bind:checked={x402Draft.enabled}
      class="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
    />
    <span class="text-[12px] text-slate-700">Charge for messages (x402)</span>
  </label>

  {#if x402Draft.enabled}
    <div class="flex flex-col gap-3 pl-6">
      <!-- Price per message -->
      <label class="flex flex-col gap-1 text-[12px] font-medium text-slate-600">
        Price per message (USDC)
        <div class="flex items-center gap-1">
          <span class="text-slate-400">$</span>
          <input
            type="number"
            bind:value={x402Draft.priceUsdc}
            min="0.01"
            max="100"
            step="0.01"
            class="w-28 rounded-lg border border-slate-200 px-3 py-1.5 text-[13px] text-slate-800 outline-none focus:border-indigo-400"
          />
        </div>
      </label>

      <!-- Free messages -->
      <label class="flex flex-col gap-1 text-[12px] font-medium text-slate-600">
        Free messages per user
        <input
          type="number"
          bind:value={x402Draft.freeMessages}
          min="0"
          max="100"
          step="1"
          class="w-28 rounded-lg border border-slate-200 px-3 py-1.5 text-[13px] text-slate-800 outline-none focus:border-indigo-400"
        />
        <span class="text-[11px] text-slate-400 font-normal">0 = payment required immediately</span>
      </label>

      <!-- Description -->
      <label class="flex flex-col gap-1 text-[12px] font-medium text-slate-600">
        Payment description (shown to payers)
        <input
          type="text"
          bind:value={x402Draft.description}
          maxlength="100"
          placeholder="Ask me anything about DeFi"
          class="rounded-lg border border-slate-200 px-3 py-1.5 text-[13px] text-slate-800 outline-none focus:border-indigo-400"
        />
      </label>

      <!-- Payment address -->
      <label class="flex flex-col gap-1 text-[12px] font-medium text-slate-600">
        Payment address (Solana)
        <input
          type="text"
          bind:value={x402Draft.payTo}
          placeholder="Your Solana wallet address"
          class="rounded-lg border border-slate-200 px-3 py-1.5 text-[13px] font-mono text-slate-800 outline-none focus:border-indigo-400"
        />
        <span class="text-[11px] text-slate-400 font-normal">USDC payments are sent to this address</span>
      </label>

      <!-- Preview -->
      <div class="rounded-lg bg-indigo-50 border border-indigo-100 px-3 py-2 text-[12px] text-indigo-700">
        {pricePreview}
      </div>

      {#if x402Error}
        <div class="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-[12px] text-red-600">
          {x402Error}
        </div>
      {/if}

      <!-- Save x402 settings button -->
      <div class="flex gap-2">
        <button
          on:click={saveX402Pricing}
          disabled={x402Loading}
          class="rounded-lg bg-indigo-600 px-4 py-1.5 text-[12px] font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {x402Loading ? 'Saving…' : 'Save Pricing'}
        </button>

        {#if x402Earnings?.totalPayments > 0}
          <button
            on:click={() => { showPaymentHistory = !showPaymentHistory; }}
            class="rounded-lg border border-slate-200 px-4 py-1.5 text-[12px] font-medium text-slate-600 hover:border-slate-300"
          >
            {showPaymentHistory ? 'Hide History' : 'View History'}
          </button>
        {/if}
      </div>

      <!-- Inline payment history -->
      {#if showPaymentHistory && $activeAgent?.id}
        <div class="rounded-lg bg-slate-50 border border-slate-200 p-3 max-h-64 overflow-y-auto">
          <PaymentHistory agentId={$activeAgent.id} agentName={$activeAgent.name} />
        </div>
      {/if}

    </div>
  {:else}
    <p class="pl-6 text-[12px] text-slate-400">{pricePreview}</p>
  {/if}
</div>
```

### 4d. Update the `save()` function

The existing `save()` function saves system_prompt and greeting. Make it also save x402 pricing if x402Draft.enabled:

```js
async function save() {
  const updated = { ...$activeAgent, ...draft };
  activeAgent.set(updated);
  onSave?.(updated);
  if (updated.id && !updated.id.startsWith('lib:')) {
    try {
      await fetch(`/api/agents/${updated.id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          system_prompt: updated.system_prompt,
          greeting: updated.greeting,
        }),
      });
      // Also save x402 pricing (non-blocking if it fails)
      if (x402Draft.enabled || x402Draft.payTo) {
        await saveX402Pricing().catch(() => {});
      }
    } catch {}
  }
  open = false;
}
```

---

## Step 5: Build verification

```bash
cd /workspaces/three.ws/chat && npx vite build 2>&1 | tail -30
```

The build must succeed. Fix any Svelte compilation errors.

Common issues:
- `{#if}` blocks must have matching `{/if}`
- Svelte doesn't allow `async` in reactive statements directly — ensure async calls are in functions
- `bind:value` on number inputs in Svelte requires the variable to be declared as a `let`

---

## Success criteria

```
✔ AgentSettingsModal.svelte updated with Monetization section
✔ Toggle shows/hides the pricing form
✔ Price input: 0.01–100 USDC, step 0.01
✔ Free messages: 0–100 integer
✔ Description: max 100 chars
✔ payTo: defaults to agent wallet_address when available
✔ Preview text updates reactively as inputs change
✔ "Save Pricing" calls POST /api/agents/:id/x402-pricing
✔ Earnings summary displayed when x402 is enabled
✔ "View History" shows PaymentHistory component inline
✔ vite build succeeds
```
