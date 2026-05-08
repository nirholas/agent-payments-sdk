import { type NextRequest } from "next/server";
import {
  verifyEvmPayment,
  decodePaymentHeader,
} from "@nirholas/agent-payments-sdk/x402";
import { buildChallenge, consumeMemo } from "@/lib/payment";

const COINGECKO_PRICE_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd,btc";

export async function GET(req: NextRequest) {
  const paymentHeader = req.headers.get("x-payment");

  if (!paymentHeader) {
    const challenge = buildChallenge(
      req.url,
      "Real-time BTC, ETH, and SOL prices in USD and BTC"
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

  const upstream = await fetch(COINGECKO_PRICE_URL, {
    headers: { Accept: "application/json" },
    next: { revalidate: 30 },
  });

  if (!upstream.ok) {
    return Response.json(
      { error: `CoinGecko error: ${upstream.status}` },
      { status: 502 }
    );
  }

  const prices = await upstream.json();

  return Response.json({
    prices,
    depositId: result.depositId,
    solanaSignature: result.solanaSignature,
  });
}
