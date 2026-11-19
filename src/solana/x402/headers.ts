// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
// All rights reserved.

/**
 * x402 v2 Header encoding / decoding
 *
 * Standard headers (per coinbase/x402 v2 spec):
 *   PAYMENT-REQUIRED   – server → client (402 response)
 *   PAYMENT-SIGNATURE  – client → server (retry request)
 *   PAYMENT-RESPONSE   – server → client (200 after settlement)
 *
 * All values are base64-encoded UTF-8 JSON.
 */

import type {
  PaymentPayload,
  PaymentRequired,
  PaymentResponse,
} from "./types";
import {
  X402_HEADER_PAYMENT_REQUIRED,
  X402_HEADER_PAYMENT_SIGNATURE,
  X402_HEADER_PAYMENT_RESPONSE,
} from "./types";

// ─── Encode / Decode primitives ─────────────────────────────────────────────

/** Base64 of the UTF-8 bytes of `JSON.stringify(value)`; `btoa` alone throws on non-Latin-1 text. */
function encodeJsonBase64(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeJsonBase64(headerValue: string): unknown {
  const binary = atob(headerValue);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

export function encodePaymentRequired(pr: PaymentRequired): string {
  return encodeJsonBase64(pr);
}

/** Decodes the header. The result is untrusted input: validate before use. */
export function decodePaymentRequired(headerValue: string): PaymentRequired {
  return decodeJsonBase64(headerValue) as PaymentRequired;
}

export function encodePaymentPayload(payload: PaymentPayload): string {
  return encodeJsonBase64(payload);
}

/** Decodes the header. The result is untrusted input: validate before use. */
export function decodePaymentPayload(headerValue: string): PaymentPayload {
  return decodeJsonBase64(headerValue) as PaymentPayload;
}

export function encodePaymentResponse(pr: PaymentResponse): string {
  return encodeJsonBase64(pr);
}

/** Decodes the header. The result is untrusted input: validate before use. */
export function decodePaymentResponse(headerValue: string): PaymentResponse {
  return decodeJsonBase64(headerValue) as PaymentResponse;
}

// ─── Request / Response helpers ─────────────────────────────────────────────

/**
 * Extract PAYMENT-REQUIRED from a 402 Response.
 * Returns null if not a 402 or header is missing.
 */
export function getPaymentRequiredFromResponse(
  response: Response,
): PaymentRequired | null {
  if (response.status !== 402) return null;
  const raw = response.headers.get(X402_HEADER_PAYMENT_REQUIRED);
  if (!raw) return null;
  return decodePaymentRequired(raw);
}

/**
 * Extract PAYMENT-SIGNATURE from a Request.
 * Returns null if header is missing.
 */
export function getPaymentPayloadFromRequest(
  request: Request,
): PaymentPayload | null {
  const raw = request.headers.get(X402_HEADER_PAYMENT_SIGNATURE);
  if (!raw) return null;
  return decodePaymentPayload(raw);
}

/**
 * Extract PAYMENT-RESPONSE from a Response.
 * Returns null if header is missing.
 */
export function getPaymentResponseFromResponse(
  response: Response,
): PaymentResponse | null {
  const raw = response.headers.get(X402_HEADER_PAYMENT_RESPONSE);
  if (!raw) return null;
  return decodePaymentResponse(raw);
}
