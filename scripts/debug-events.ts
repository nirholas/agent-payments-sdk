/** Debug: dump first 20 events (any name) with isBuy field if present. */
import { Connection } from "@solana/web3.js";
import { PUMP_BONDING_CURVE_PROGRAM_ID, createPumpEventParser } from "../src/solana/pump-events.js";

async function main() {
  const rpc = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
  const conn = new Connection(rpc, "confirmed");
  const parser = createPumpEventParser();
  let count = 0;
  const buySigs: string[] = [];

  const subId = conn.onLogs(PUMP_BONDING_CURVE_PROGRAM_ID, (info, ctx) => {
    if (info.err) return;
    const evts = parser.parseLogs(info.logs);
    for (const e of evts) {
      if (count < 30) {
        const isBuy = (e.data as Record<string, unknown>).isBuy;
        console.log(`[${ctx.slot}] ${e.name}${isBuy !== undefined ? ` isBuy=${isBuy}` : ""} sig=${info.signature.slice(0, 12)}…`);
        count++;
      }
      if (e.name === "TradeEvent" && (e.data as { isBuy: boolean }).isBuy) {
        buySigs.push(info.signature);
        console.log("  *** BUY! sig=", info.signature);
      }
    }
  }, "confirmed");

  await new Promise((r) => setTimeout(r, 60_000));
  await conn.removeOnLogsListener(subId);
  console.log("buys found:", buySigs.length);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
