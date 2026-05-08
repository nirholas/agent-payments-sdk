import { type NextRequest } from "next/server";
import { encodeFunctionData, maxUint256, type Address } from "viem";
import type { BuiltPaymentTx } from "@/lib/types";

const PUMP_CROSSCHAIN_API = "https://api.pump.fun/crosschain";

const ERC20_ABI = [
  {
    name: "approve",
    type: "function" as const,
    stateMutability: "nonpayable" as const,
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

interface PumpBridgeTxResponse {
  to: string;
  data: string;
  value: string;
  approvalSpender?: string;
}

/**
 * POST /api/proxy/build-tx
 * Forwards build-tx to the Pump.fun crosschain API and attaches the ERC-20
 * approval transaction (server-side encoding via viem) when required.
 *
 * Body: { quoteId, fromChainId, fromToken, fromAmount, sender, agentMint,
 *         destinationSolanaWallet, memo }
 */
export async function POST(req: NextRequest) {
  const body: unknown = await req.json();

  const upstream = await fetch(`${PUMP_CROSSCHAIN_API}/build-tx`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => "");
    return Response.json(
      { error: `Bridge tx build failed (${upstream.status}): ${errText}` },
      { status: upstream.status }
    );
  }

  const raw: PumpBridgeTxResponse = await upstream.json();

  const payload = body as { fromToken?: string };
  const isNative =
    !payload.fromToken ||
    payload.fromToken.toLowerCase() ===
      "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

  const result: BuiltPaymentTx = {
    bridge: {
      to: raw.to,
      data: raw.data,
      value: raw.value,
      chainId: (body as { fromChainId: number }).fromChainId,
    },
  };

  if (!isNative && raw.approvalSpender) {
    const approvalData = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "approve",
      args: [raw.approvalSpender as Address, maxUint256],
    });

    result.approval = {
      to: payload.fromToken as string,
      data: approvalData,
      value: "0x0",
    };
  }

  return Response.json(result);
}
