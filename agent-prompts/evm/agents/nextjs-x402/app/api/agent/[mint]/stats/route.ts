import { type NextRequest } from "next/server";
import {
  verifyEvmPayment,
  decodePaymentHeader,
} from "@nirholas/agent-payments-sdk/x402";
import { buildChallenge, consumeMemo } from "@/lib/payment";

// Solana base58 alphabet — 1-9, A-H, J-N, P-Z, a-k, m-z (no 0, I, O, l)
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function GET(
  req: NextRequest,
  { params }: { params: { mint: string } }
) {
  const { mint } = params;

  if (!BASE58_RE.test(mint)) {
    return Response.json(
      { error: `Invalid mint address: must be a base58 string (32-44 chars)` },
      { status: 400 }
    );
  }

  const paymentHeader = req.headers.get("x-payment");

  if (!paymentHeader) {
    const challenge = buildChallenge(
      req.url,
      `On-chain stats for pump.fun agent ${mint}`
    );
    return Response.json(
      { error: "Payment required" },
      {
        status: 402,
        headers: {
          "X-Payment-Required": challenge.header,
          "X-Payment-Memo": challenge.memo,
        },
      }
    );
  }

  const proof = decodePaymentHeader(paymentHeader);
  if (!proof) {
    return Response.json({ error: "Invalid payment header" }, { status: 400 });
  }

  const memo = req.headers.get("x-payment-memo") ?? "";
  if (!consumeMemo(memo)) {
    return Response.json({ error: "Unknown or expired memo" }, { status: 402 });
  }

  const result = await verifyEvmPayment({
    proof,
    expectedMemo: memo,
    minAmountUsdc: BigInt(process.env.PRICE_USDC_MINOR ?? "500000"),
    agentMint: process.env.AGENT_MINT!,
    waitForSolana: process.env.WAIT_FOR_SOLANA === "true",
  });

  if (!result.valid) {
    return Response.json({ error: result.error }, { status: 402 });
  }

  const upstream = await fetch(
    `https://fun-block.pump.fun/agents/${mint}/stats`,
    { headers: { Accept: "application/json" } }
  );

  if (!upstream.ok) {
    return Response.json(
      { error: `Pump.fun error: ${upstream.status}` },
      { status: upstream.status === 404 ? 404 : 502 }
    );
  }

  const stats: unknown = await upstream.json();

  return Response.json({
    mint,
    stats,
    depositId: result.depositId,
    solanaSignature: result.solanaSignature,
  });
}
