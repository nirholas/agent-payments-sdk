// agent-payments-sdk
// Copyright (c) 2026 Nicholas | x.com/nichxbt | github.com/nirholas
// All rights reserved.

import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import bs58 from "bs58";
import {
  createX402Fetch,
  getPaymentRequiredFromResponse,
  getPaymentResponseFromResponse,
  USDC_MAINNET,
  SOLANA_MAINNET,
  type PaymentRequirements,
} from "../../../../src/solana/x402";

const USDC_DECIMALS = 6;

// Hoisted so the outer catch can print it on confirmation timeout
let lastPaymentSig: string | null = null;

function toHumanUsdc(minorUnits: string | bigint | number): string {
  return (Number(minorUnits) / 10 ** USDC_DECIMALS).toFixed(USDC_DECIMALS);
}

function loadKeypair(raw: string): Keypair {
  const value = raw.trim();

  if (value.startsWith("[")) {
    let arr: number[];
    try {
      arr = JSON.parse(value) as number[];
    } catch {
      throw new Error("SOLANA_PRIVATE_KEY: JSON array is malformed");
    }
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }

  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(value);
  } catch {
    throw new Error(
      "SOLANA_PRIVATE_KEY is malformed: expected a base58-encoded keypair or a JSON number array",
    );
  }
  return Keypair.fromSecretKey(decoded);
}

async function checkUsdcBalance(
  connection: Connection,
  payer: PublicKey,
): Promise<void> {
  const ata = getAssociatedTokenAddressSync(new PublicKey(USDC_MAINNET), payer);
  try {
    const { value } = await connection.getTokenAccountBalance(ata);
    const ui = value.uiAmount ?? 0;
    if (ui === 0) {
      console.warn(
        "[x402] WARNING: USDC balance is 0 — payment will fail if the endpoint charges a fee",
      );
    } else {
      console.log(`[x402] USDC balance: ${ui} USDC`);
    }
  } catch {
    console.warn(
      `[x402] WARNING: USDC ATA not found for ${payer.toBase58()} — account may not exist or holds no USDC`,
    );
  }
}

function selectRequirement(
  accepts: PaymentRequirements[],
): PaymentRequirements | null {
  return (
    accepts.find(
      (r) => r.scheme === "pump-agent" && r.network === SOLANA_MAINNET,
    ) ??
    accepts.find((r) => r.scheme === "exact" && r.network === SOLANA_MAINNET) ??
    null
  );
}

async function main(): Promise<void> {
  const [, , url, jsonBody] = process.argv;

  if (!url) {
    console.error("Usage: node index.js <URL> [JSON_BODY]");
    process.exit(1);
  }

  // ── Wallet ──────────────────────────────────────────────────────────────────
  const privateKeyEnv = process.env.SOLANA_PRIVATE_KEY;
  if (!privateKeyEnv) {
    throw new Error(
      "SOLANA_PRIVATE_KEY env var is required (base58-encoded keypair or JSON number array)",
    );
  }
  const keypair = loadKeypair(privateKeyEnv);
  console.log(`[x402] payer:  ${keypair.publicKey.toBase58()}`);

  // ── RPC ─────────────────────────────────────────────────────────────────────
  const rpcUrl =
    process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
  const connection = new Connection(rpcUrl, "confirmed");
  console.log(`[x402] rpc:    ${rpcUrl}`);

  // ── Pre-flight balance check ─────────────────────────────────────────────────
  await checkUsdcBalance(connection, keypair.publicKey);

  // ── x402 fetch wiring ────────────────────────────────────────────────────────
  const x402fetch = createX402Fetch({
    payer: keypair.publicKey.toBase58(),
    connection,
    signTransaction: async (txBase64: string): Promise<string> => {
      const tx = Transaction.from(Buffer.from(txBase64, "base64"));
      tx.partialSign(keypair);
      return Buffer.from(
        tx.serialize({ requireAllSignatures: false }),
      ).toString("base64");
    },
    sendTransaction: async (signedTxBase64: string): Promise<string> => {
      const raw = Buffer.from(signedTxBase64, "base64");
      const sig = await connection.sendRawTransaction(raw, {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });
      lastPaymentSig = sig; // capture before awaiting — allows timeout logging
      await connection.confirmTransaction(sig, "confirmed");
      return sig;
    },
    confirmationTimeoutMs: 60_000,
  });

  // ── Request init ─────────────────────────────────────────────────────────────
  const init: RequestInit = jsonBody
    ? {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: jsonBody,
      }
    : { method: "GET" };

  console.log(`[x402] ${init.method} ${url}`);

  // ── Pre-probe: capture PaymentRequired info before x402fetch consumes it ─────
  //    createX402Fetch makes its own initial fetch internally, so we probe here
  //    to capture scheme / asset / amount for the payment log line.
  const probe = await fetch(url, init);
  let capturedScheme: string | null = null;
  let capturedAsset: string | null = null;
  let capturedAmount: string | null = null;

  if (probe.status === 402) {
    const pr = getPaymentRequiredFromResponse(probe);
    if (pr) {
      const req = selectRequirement(pr.accepts);
      if (req) {
        capturedScheme = req.scheme;
        capturedAsset = req.asset;
        capturedAmount = req.amount;
        console.log(
          `[x402] 402 received — will pay ${toHumanUsdc(req.amount)} USDC via ${req.scheme}`,
        );
      }
    }
  }

  // ── Execute via x402 fetch (402 detection → payment → retry) ────────────────
  const response = await x402fetch(url, init);

  // ── PAYMENT-RESPONSE header (always log when present) ───────────────────────
  const paymentResponse = getPaymentResponseFromResponse(response);
  if (paymentResponse) {
    console.log(
      `[x402] PAYMENT-RESPONSE: ${JSON.stringify(paymentResponse, null, 2)}`,
    );

    if (
      paymentResponse.success &&
      capturedScheme &&
      capturedAsset &&
      capturedAmount
    ) {
      const sig = paymentResponse.transaction ?? lastPaymentSig ?? "unknown";
      console.log(
        `[x402] paid | scheme=${capturedScheme} | asset=${capturedAsset} | amount=${toHumanUsdc(capturedAmount)} USDC | sig=${sig} | resource=${url}`,
      );
    }
  }

  // ── Response handling ────────────────────────────────────────────────────────
  if (response.ok) {
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const data: unknown = await response.json();
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(await response.text());
    }
    return;
  }

  if (response.status === 402) {
    console.error(
      "[x402] Payment failed — server still returned 402 after payment attempt",
    );
    const pr = getPaymentRequiredFromResponse(response);
    if (pr) console.error(JSON.stringify(pr, null, 2));
    process.exit(1);
  }

  // Other non-2xx
  const errorBody = await response.text();
  console.error(`[x402] Error ${response.status}: ${errorBody}`);
  process.exit(1);
}

main().catch((err: unknown) => {
  if (err instanceof Error) {
    if (err.message.toLowerCase().includes("timed out") && lastPaymentSig) {
      console.error(
        `[x402] Transaction confirmation timed out. Partial signature: ${lastPaymentSig}`,
      );
      console.error(
        `       Look it up: https://solscan.io/tx/${lastPaymentSig}`,
      );
    }
    console.error(err.message);
    if (err.stack) console.error(err.stack);
  } else {
    console.error(String(err));
  }
  process.exit(1);
});
