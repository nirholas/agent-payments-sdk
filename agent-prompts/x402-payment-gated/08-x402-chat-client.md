# Task: Implement x402 client-side payment flow in three.ws chat frontend

## Context

- three.ws chat frontend: `/workspaces/three.ws/chat/src/`
- Framework: Svelte 4, Vite 5, Tailwind CSS
- When the chat API returns HTTP 402, the frontend must:
  1. Parse payment details from the 402 JSON body
  2. Show a payment confirmation modal
  3. Build and sign a USDC transfer transaction using the connected Solana wallet
  4. Encode payment proof as `X-PAYMENT` header (base64 JSON)
  5. Retry the original chat request with the payment header
  6. Resume the chat stream on success
- Solana wallet access: `window.solana` (Phantom / standard wallet adapter)
- Existing modal pattern: see `/workspaces/three.ws/chat/src/TxApprovalModal.svelte` and `Modal.svelte`
- Existing design system: Tailwind, slate color palette, Button.svelte component

---

## Step 1: Read all relevant files

```
/workspaces/three.ws/chat/src/App.svelte          (find where fetch/streaming happens)
/workspaces/three.ws/chat/src/convo.js             (complete() function)
/workspaces/three.ws/chat/src/TxApprovalModal.svelte
/workspaces/three.ws/chat/src/Modal.svelte
/workspaces/three.ws/chat/src/Button.svelte
/workspaces/three.ws/chat/src/stores.js            (wallet/user stores)
/workspaces/three.ws/chat/src/walletAuth.js        (Solana wallet patterns)
```

---

## Step 2: Create x402-client.js

Create `/workspaces/three.ws/chat/src/x402-client.js`:

```js
// x402-client.js — browser-side x402 payment flow for chat.
//
// Usage:
//   import { handle402Response } from './x402-client.js';
//   const retryResponse = await handle402Response(response, originalFetch, wallet);

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_DECIMALS = 6;

// We load @solana/web3.js and @solana/spl-token from esm.sh CDN at runtime,
// since these are heavy deps that the Vite build doesn't include.
// The CDN URLs are pinned to specific versions for reproducibility.
const WEB3_ESM = 'https://esm.sh/@solana/web3.js@1.98.0';
const SPL_TOKEN_ESM = 'https://esm.sh/@solana/spl-token@0.4.9';

let _web3 = null;
let _splToken = null;

async function loadSolanaLibs() {
  if (!_web3) _web3 = await import(/* @vite-ignore */ WEB3_ESM);
  if (!_splToken) _splToken = await import(/* @vite-ignore */ SPL_TOKEN_ESM);
  return { web3: _web3, splToken: _splToken };
}

/**
 * Decode a 402 response body into payment requirements.
 *
 * @param {Response} response
 * @returns {Promise<{ x402Version: number, accepts: Array, error: string }|null>}
 */
export async function decode402Body(response) {
  if (response.status !== 402) return null;
  try {
    const body = await response.clone().json();
    if (!body.accepts || !Array.isArray(body.accepts)) return null;
    return body;
  } catch {
    return null;
  }
}

/**
 * Select the best payment requirement from the accepts array.
 * Prefers solana-mainnet exact scheme.
 *
 * @param {Array} accepts
 * @returns {object|null}
 */
export function selectPaymentRequirement(accepts) {
  if (!accepts?.length) return null;
  // Prefer mainnet exact, then devnet exact, then any
  return (
    accepts.find(a => a.scheme === 'exact' && a.network === 'solana-mainnet') ||
    accepts.find(a => a.scheme === 'exact' && a.network === 'solana-devnet') ||
    accepts.find(a => a.scheme === 'exact') ||
    accepts[0]
  );
}

/**
 * Build, sign, and submit a USDC transfer transaction for x402 payment.
 *
 * @param {object} opts
 * @param {string} opts.payTo         Recipient base58 address
 * @param {string} opts.amountMinor   Amount in minor units (e.g. "100000" = 0.10 USDC)
 * @param {string} opts.network       "solana-mainnet" or "solana-devnet"
 * @param {object} opts.wallet        window.solana (Phantom-compatible)
 * @returns {Promise<{ signature: string, payerAddress: string }>}
 */
export async function buildSolanaPayment({ payTo, amountMinor, network, wallet }) {
  const { web3, splToken } = await loadSolanaLibs();
  const { Connection, PublicKey, Transaction } = web3;
  const {
    getAssociatedTokenAddressSync,
    createAssociatedTokenAccountIdempotentInstruction,
    createTransferCheckedInstruction,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  } = splToken;

  const rpcUrl = network === 'solana-devnet'
    ? 'https://api.devnet.solana.com'
    : 'https://api.mainnet-beta.solana.com';

  const connection = new Connection(rpcUrl, 'confirmed');

  if (!wallet.isConnected || !wallet.publicKey) {
    await wallet.connect();
  }

  const payerPk = wallet.publicKey;
  const recipientPk = new PublicKey(payTo);
  const usdcMint = new PublicKey(USDC_MINT);

  const payerAta = getAssociatedTokenAddressSync(
    usdcMint, payerPk, false,
    TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const recipientAta = getAssociatedTokenAddressSync(
    usdcMint, recipientPk, false,
    TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: payerPk });

  // Create recipient ATA if needed (idempotent)
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      payerPk, recipientAta, recipientPk, usdcMint,
      TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
    )
  );

  // USDC TransferChecked
  tx.add(
    createTransferCheckedInstruction(
      payerAta, usdcMint, recipientAta, payerPk,
      BigInt(amountMinor), USDC_DECIMALS,
      [], TOKEN_PROGRAM_ID
    )
  );

  // Sign via wallet adapter (Phantom etc.)
  const signed = await wallet.signTransaction(tx);
  const rawTx = signed.serialize();

  // Send and confirm
  const signature = await connection.sendRawTransaction(rawTx, {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });

  await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');

  return { signature, payerAddress: payerPk.toBase58() };
}

/**
 * Encode the payment proof as base64 JSON for the X-PAYMENT header.
 *
 * @param {object} opts
 * @param {string} opts.txSignature
 * @param {string} opts.network
 * @param {string} opts.payTo
 * @param {string} opts.amountMinor
 * @param {string} opts.asset
 * @returns {string}  base64-encoded JSON
 */
export function encodePaymentHeader({ txSignature, network, payTo, amountMinor, asset }) {
  const payload = {
    x402Version: 1,
    scheme: 'exact',
    network,
    payload: {
      signature: txSignature,
      payTo,
      amount: amountMinor,
      asset,
    },
  };
  return btoa(JSON.stringify(payload));
}

/**
 * Retry the original fetch request with the payment header attached.
 *
 * @param {RequestInfo|URL} input   Original request URL
 * @param {RequestInit} init        Original request init
 * @param {string} paymentHeader    base64-encoded payment payload
 * @returns {Promise<Response>}
 */
export async function retryWithPayment(input, init, paymentHeader) {
  const headers = new Headers(init?.headers || {});
  headers.set('X-Payment', paymentHeader);
  return fetch(input, { ...init, headers });
}

/**
 * Full x402 payment flow. Called when a fetch returns 402.
 *
 * This function is pure (no UI side effects). The caller is responsible
 * for showing a payment modal before calling this.
 *
 * @param {Response}       response        The 402 response
 * @param {RequestInfo}    originalInput   The original fetch input
 * @param {RequestInit}    originalInit    The original fetch init
 * @param {object}         wallet          window.solana
 * @returns {Promise<{ response: Response, requirement: object } | { error: string }>}
 */
export async function handle402Response(response, originalInput, originalInit, wallet) {
  const body = await decode402Body(response);
  if (!body) return { error: 'invalid 402 response body' };

  const requirement = selectPaymentRequirement(body.accepts);
  if (!requirement) return { error: 'no supported payment scheme found' };

  try {
    const { signature, payerAddress } = await buildSolanaPayment({
      payTo: requirement.payTo,
      amountMinor: requirement.maxAmountRequired,
      network: requirement.network,
      wallet,
    });

    const paymentHeader = encodePaymentHeader({
      txSignature: signature,
      network: requirement.network,
      payTo: requirement.payTo,
      amountMinor: requirement.maxAmountRequired,
      asset: requirement.asset,
    });

    const retried = await retryWithPayment(originalInput, originalInit, paymentHeader);
    return { response: retried, requirement, signature, payerAddress };
  } catch (err) {
    return { error: err.message || 'payment failed' };
  }
}

/**
 * Format USDC minor units as a human-readable string.
 * e.g. "100000" → "$0.10"
 */
export function formatUsdcPrice(minorUnits, symbol = '$') {
  const usdc = Number(minorUnits) / Math.pow(10, USDC_DECIMALS);
  return `${symbol}${usdc.toFixed(2)}`;
}
```

---

## Step 3: Create PaymentRequiredModal.svelte

Create `/workspaces/three.ws/chat/src/PaymentRequiredModal.svelte`:

Model it on `TxApprovalModal.svelte` (same dark overlay + centered card pattern). Read that file first.

```svelte
<!-- PaymentRequiredModal.svelte — shown when chat API returns 402 -->
<script>
  import { fade, scale } from 'svelte/transition';
  import { cubicIn } from 'svelte/easing';
  import Button from './Button.svelte';
  import { formatUsdcPrice } from './x402-client.js';

  /** The payment requirement object from the 402 body */
  export let requirement = null;
  /** Agent name to show in the UI */
  export let agentName = 'this agent';
  /** Called when user confirms — receives no arguments */
  export let onApprove = null;
  /** Called when user cancels */
  export let onCancel = null;

  let state = 'confirm';   // 'confirm' | 'paying' | 'error'
  let errorMessage = '';

  $: priceDisplay = requirement
    ? formatUsdcPrice(requirement.maxAmountRequired)
    : '$0.00';

  $: network = requirement?.network?.includes('devnet') ? 'devnet' : 'mainnet';

  async function handleApprove() {
    state = 'paying';
    errorMessage = '';
    try {
      await onApprove?.();
    } catch (err) {
      state = 'error';
      errorMessage = err?.message || 'Payment failed. Please try again.';
    }
  }

  function handleCancel() {
    onCancel?.();
  }

  function handleRetry() {
    state = 'confirm';
    errorMessage = '';
  }
</script>

<!-- Backdrop -->
<div
  transition:fade={{ duration: 200, easing: cubicIn }}
  aria-hidden="true"
  class="fixed inset-0 z-[200] bg-black/60"
/>

<!-- Modal card -->
<div
  role="dialog"
  aria-modal="true"
  aria-label="Payment Required"
  transition:scale={{ opacity: 0, start: 0.97, duration: 150, easing: cubicIn }}
  class="fixed left-1/2 top-1/2 z-[201] w-[95%] max-w-sm -translate-x-1/2 -translate-y-1/2
         rounded-xl border border-slate-700 bg-slate-900 p-6 shadow-2xl"
>
  {#if state === 'confirm'}
    <!-- Header -->
    <div class="mb-4 flex items-start justify-between">
      <div>
        <h2 class="text-lg font-semibold text-white">Message Payment</h2>
        <span class="mt-1 inline-block rounded-full bg-indigo-900/60 px-2.5 py-0.5 text-xs font-medium text-indigo-300">
          x402 · Solana {network}
        </span>
      </div>
      <div class="text-2xl font-bold text-white">{priceDisplay}</div>
    </div>

    <!-- Description -->
    <p class="mb-5 text-sm text-slate-400">
      <span class="font-medium text-slate-200">{agentName}</span>
      charges {priceDisplay} USDC per message. Your connected Solana wallet will be charged.
    </p>

    <!-- Payment details table -->
    <table class="mb-5 w-full text-sm">
      <tbody>
        <tr class="border-b border-slate-800">
          <td class="py-2 pr-4 text-slate-400">Amount</td>
          <td class="py-2 text-right font-mono text-slate-200">{priceDisplay} USDC</td>
        </tr>
        <tr class="border-b border-slate-800">
          <td class="py-2 pr-4 text-slate-400">Recipient</td>
          <td class="py-2 text-right font-mono text-xs text-slate-300 break-all">
            {requirement?.payTo?.slice(0, 8)}…{requirement?.payTo?.slice(-4)}
          </td>
        </tr>
        <tr>
          <td class="py-2 pr-4 text-slate-400">Est. network fee</td>
          <td class="py-2 text-right text-slate-400">~0.000005 SOL</td>
        </tr>
      </tbody>
    </table>

    <!-- Buttons -->
    <div class="flex gap-3">
      <Button
        variant="ghost"
        class="flex-1 border border-slate-700 text-slate-400 hover:text-white"
        on:click={handleCancel}
      >
        Cancel
      </Button>
      <Button
        class="flex-1 bg-indigo-600 text-white hover:bg-indigo-500"
        on:click={handleApprove}
      >
        Pay &amp; Send
      </Button>
    </div>

  {:else if state === 'paying'}
    <div class="flex flex-col items-center gap-4 py-4 text-center">
      <!-- Spinner -->
      <svg class="h-10 w-10 animate-spin text-indigo-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.4 0 0 5.4 0 12h4z"/>
      </svg>
      <p class="text-sm text-slate-300">Signing transaction…</p>
      <p class="text-xs text-slate-500">Approve the transaction in your wallet</p>
    </div>

  {:else if state === 'error'}
    <div class="flex flex-col gap-4">
      <div class="rounded-lg bg-red-900/40 border border-red-800 px-4 py-3">
        <p class="text-sm font-medium text-red-300">Payment failed</p>
        <p class="mt-1 text-xs text-red-400">{errorMessage}</p>
      </div>
      <div class="flex gap-3">
        <Button variant="ghost" class="flex-1 border border-slate-700 text-slate-400" on:click={handleCancel}>
          Cancel
        </Button>
        <Button class="flex-1 bg-indigo-600 text-white hover:bg-indigo-500" on:click={handleRetry}>
          Try Again
        </Button>
      </div>
    </div>
  {/if}
</div>
```

---

## Step 4: Wire into App.svelte

Read `/workspaces/three.ws/chat/src/App.svelte` carefully. Find where `complete()` from `convo.js` is called, or where fetch calls to `/api/chat` happen.

Add the following to App.svelte:

### 4a. Import at the top of the `<script>` block:

```js
import PaymentRequiredModal from './PaymentRequiredModal.svelte';
import { decode402Body, selectPaymentRequirement, handle402Response } from './x402-client.js';
```

### 4b. Add reactive state variables:

```js
let payment402 = null;       // { requirement, agentName, resolve, reject }
let showPaymentModal = false;
```

### 4c. Create a payment-aware fetch wrapper:

The chat in three.ws calls the built-in Anthropic API via the `complete()` function in `convo.js`, or sometimes calls `/api/chat` directly for agent-gated chats. Find the exact pattern.

If `/api/chat` is called directly, wrap it:

```js
async function chatFetchWithX402(input, init) {
  const response = await fetch(input, init);
  if (response.status !== 402) return response;

  const body = await decode402Body(response);
  if (!body) return response;  // unexpected 402, pass through

  const requirement = selectPaymentRequirement(body.accepts);
  if (!requirement) return response;

  const agentName = $activeAgent?.name || 'this agent';

  // Show the payment modal and wait for user decision
  return new Promise((resolve, reject) => {
    payment402 = {
      requirement,
      agentName,
      originalInput: input,
      originalInit: init,
      resolve,
      reject,
    };
    showPaymentModal = true;
  });
}

async function handlePaymentApprove() {
  if (!payment402) return;
  const { requirement, originalInput, originalInit, resolve, reject } = payment402;

  const wallet = window.solana;
  if (!wallet) {
    reject(new Error('No Solana wallet found. Install Phantom or a compatible wallet.'));
    showPaymentModal = false;
    return;
  }

  const result = await handle402Response(
    // We need a minimal 402 Response-like object for handle402Response
    new Response(JSON.stringify({ x402Version: 1, accepts: [requirement] }), { status: 402 }),
    originalInput,
    originalInit,
    wallet,
  );

  showPaymentModal = false;
  payment402 = null;

  if (result.error) {
    reject(new Error(result.error));
  } else {
    resolve(result.response);
  }
}

function handlePaymentCancel() {
  if (payment402) {
    payment402.reject(new Error('Payment cancelled by user'));
    payment402 = null;
  }
  showPaymentModal = false;
}
```

### 4d. Add the modal to the template:

In the Svelte template section, add (alongside the existing `TxApprovalModal` or near the end of the body):

```svelte
{#if showPaymentModal && payment402}
  <PaymentRequiredModal
    requirement={payment402.requirement}
    agentName={payment402.agentName}
    onApprove={handlePaymentApprove}
    onCancel={handlePaymentCancel}
  />
{/if}
```

### 4e. Replace direct `/api/chat` fetch calls:

In the section of App.svelte or convo.js that calls `/api/chat`, replace `fetch(...)` with `chatFetchWithX402(...)`. If the fetch lives in `convo.js`, you have two options:

- Pass `chatFetchWithX402` as a parameter to `complete()`, OR
- Handle the 402 at the call site in App.svelte where `complete()` is called

Inspect the actual code to choose the right approach. The key constraint: 402 responses must trigger the modal, not be treated as errors.

---

## Step 5: Verify

```bash
cd /workspaces/three.ws/chat && npx vite build 2>&1 | tail -30
```

The build must succeed with no errors. Svelte compilation errors will appear here.

---

## Success criteria

```
✔ /workspaces/three.ws/chat/src/x402-client.js created with all functions
✔ /workspaces/three.ws/chat/src/PaymentRequiredModal.svelte created
✔ App.svelte imports PaymentRequiredModal and x402-client
✔ 402 responses trigger the payment modal (not console errors)
✔ Modal shows correct price from requirement.maxAmountRequired
✔ Cancel closes the modal without sending a message
✔ vite build succeeds
```
