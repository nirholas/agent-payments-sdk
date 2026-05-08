import type { IncomingMessage, ServerResponse } from "node:http";
import type { RequestHandler } from "express";
import { decodeAndValidateHeader, validatePayment } from "./validator.js";
import type { ValidationResult } from "./validator.js";

export type { ValidationResult };

export interface EvmPaymentMiddlewareOpts {
  agentMint: string;
  minAmountUsdcMinor: bigint;
  waitForSolana: boolean;
  /**
   * Return the expected memo for the incoming request, or null if no memo is
   * found (e.g. the invoice has expired or doesn't exist).
   * Keep this decoupled from any specific storage — look up by request path,
   * user ID, session, etc.
   */
  getMemo: (req: IncomingMessage) => Promise<string | null>;
  /**
   * Called after successful payment validation, before next().
   * Use this to persist the proof, update invoice state, etc.
   */
  onValid?: (req: IncomingMessage, result: ValidationResult) => void;
}

/** Attached to req by the middleware after successful validation. */
declare module "http" {
  interface IncomingMessage {
    paymentProof?: ValidationResult;
  }
}

/**
 * Express 4.x / Node.js http middleware that enforces EVM x402 payment.
 *
 * Usage:
 *   app.use("/api/paid", createEvmPaymentMiddleware({
 *     agentMint: "...",
 *     minAmountUsdcMinor: 1_000_000n,  // 1 USDC
 *     waitForSolana: false,
 *     getMemo: async (req) => invoiceStore.get(req.url),
 *   }));
 */
export function createEvmPaymentMiddleware(
  opts: EvmPaymentMiddlewareOpts
): RequestHandler {
  const { agentMint, minAmountUsdcMinor, waitForSolana, getMemo, onValid } = opts;

  return async (req, res, next) => {
    const headerValue =
      typeof req.headers["x-payment"] === "string"
        ? req.headers["x-payment"]
        : null;

    // Decode header
    let proof;
    try {
      proof = decodeAndValidateHeader(headerValue);
    } catch (err) {
      sendPaymentRequired(res, (err as Error).message);
      return;
    }

    if (!proof) {
      sendPaymentRequired(res, "Missing or malformed X-Payment header");
      return;
    }

    // Resolve expected memo from caller-supplied store
    const expectedMemo = await getMemo(req).catch(() => null);
    if (!expectedMemo) {
      sendPaymentRequired(res, "No active invoice found for this request");
      return;
    }

    // Full validation
    const result = await validatePayment({
      proof,
      expectedMemo,
      minAmountUsdcMinor,
      agentMint,
      waitForSolana,
    });

    if (!result.valid) {
      sendPaymentRequired(res, result.error ?? "Payment validation failed");
      return;
    }

    onValid?.(req, result);
    (req as IncomingMessage).paymentProof = result;
    next();
  };
}

function sendPaymentRequired(res: ServerResponse, error: string): void {
  const body = JSON.stringify({ status: 402, error });
  res.writeHead(402, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}
