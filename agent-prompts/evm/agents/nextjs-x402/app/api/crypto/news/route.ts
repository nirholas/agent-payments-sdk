import { type NextRequest } from "next/server";
import {
  verifyEvmPayment,
  decodePaymentHeader,
} from "@nirholas/agent-payments-sdk/x402";
import { buildChallenge, consumeMemo } from "@/lib/payment";

const COINGECKO_NEWS_URL = "https://api.coingecko.com/api/v3/news";

interface CoinGeckoNewsItem {
  title: string;
  description: string;
  url: string;
  published_at: string;
}

interface CoinGeckoNewsResponse {
  data: CoinGeckoNewsItem[];
}

export async function GET(req: NextRequest) {
  const paymentHeader = req.headers.get("x-payment");

  if (!paymentHeader) {
    const challenge = buildChallenge(
      req.url,
      "Latest 5 crypto news headlines from CoinGecko"
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

  const upstream = await fetch(COINGECKO_NEWS_URL, {
    headers: { Accept: "application/json" },
    next: { revalidate: 60 },
  });

  if (!upstream.ok) {
    return Response.json(
      { error: `CoinGecko error: ${upstream.status}` },
      { status: 502 }
    );
  }

  const body: CoinGeckoNewsResponse = await upstream.json();
  const headlines = body.data.slice(0, 5).map((item) => ({
    title: item.title,
    description: item.description,
    url: item.url,
    published_at: item.published_at,
  }));

  return Response.json({
    headlines,
    depositId: result.depositId,
    solanaSignature: result.solanaSignature,
  });
}
