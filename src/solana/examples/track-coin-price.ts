/**
 * Live coin price tracker — subscribes to a bonding curve and prints
 * price, market cap, and graduation runway on every trade.
 *
 * Usage:
 *   MINT=<pubkey> SOLANA_RPC_URL=<wss://...> npx tsx \
 *     src/solana/examples/track-coin-price.ts
 */
import { Connection, PublicKey } from "@solana/web3.js";
import BN from "bn.js";

import {
  type BondingCurveMarketData,
  PumpMarketData,
  estimatePriceImpact,
  humanReadablePrice,
  quoteToGraduation,
} from "../PumpMarketData.js";

async function main(): Promise<void> {
  const mintArg = process.env.MINT;
  const rpcUrl = process.env.SOLANA_RPC_URL;
  if (!mintArg) throw new Error("MINT env var is required");
  if (!rpcUrl) throw new Error("SOLANA_RPC_URL env var is required");

  const mint = new PublicKey(mintArg);
  const connection = new Connection(rpcUrl, "confirmed");
  const market = new PumpMarketData(connection);

  const initial = await market.getBondingCurveData(mint);
  const tokenSymbol = mint.toBase58().slice(0, 8);
  // 0.1 SOL or 1 USDC, scaled to base units of the quote currency
  const probeAmount =
    initial.quoteSymbol === "USDC"
      ? new BN(1_000_000)
      : new BN(100_000_000);

  printSnapshot(initial, tokenSymbol, probeAmount);

  const stop = market.subscribeToPriceUpdates(mint, (data) => {
    printSnapshot(data, tokenSymbol, probeAmount);
  });

  const shutdown = async () => {
    await stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function printSnapshot(
  data: BondingCurveMarketData,
  tokenSymbol: string,
  probeAmount: BN,
): void {
  const ts = new Date().toISOString();
  const price = humanReadablePrice(
    data.pricePerTokenInQuote,
    data.quoteDecimals,
  );
  const impact = estimatePriceImpact(data, probeAmount);
  const remaining = quoteToGraduation(data);
  const probeLabel = data.quoteSymbol === "USDC" ? "1 USDC" : "0.1 SOL";

  console.log(
    `[${ts}] ${tokenSymbol}/${data.quoteSymbol} price: ${price}\n` +
      `  market cap: ${data.marketCapInQuote.toString()} ${data.quoteSymbol}\n` +
      `  price impact for ${probeLabel} buy: ${impact.toFixed(4)}%\n` +
      `  to graduation: ${
        remaining ? remaining.toString() : "complete"
      } ${data.quoteSymbol}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
