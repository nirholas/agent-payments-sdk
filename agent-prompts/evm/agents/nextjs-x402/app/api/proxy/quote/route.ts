import { type NextRequest } from "next/server";

const PUMP_CROSSCHAIN_API = "https://api.pump.fun/crosschain";

/**
 * GET /api/proxy/quote
 * Forwards quote requests to the Pump.fun crosschain API, avoiding browser CORS.
 * Query params: fromChainId, fromToken, fromAmount, toNetwork, toToken, agentMint, fromNetwork
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const upstream = await fetch(
    `${PUMP_CROSSCHAIN_API}/quote?${searchParams.toString()}`,
    { headers: { "Content-Type": "application/json" } }
  );

  const body: unknown = await upstream.json();
  return Response.json(body, { status: upstream.status });
}
