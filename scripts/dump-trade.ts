/** Dump the first 3 TradeEvents in full. */
import { Connection, PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { PUMP_BONDING_CURVE_PROGRAM_ID, createPumpEventParser } from "../src/solana/pump-events.js";

function replacer(_k: string, v: unknown) {
  if (v instanceof BN) return `BN(${v.toString()})`;
  if (v instanceof PublicKey) return v.toBase58();
  return v;
}

async function main() {
  const rpc = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
  const conn = new Connection(rpc, "confirmed");
  const parser = createPumpEventParser();
  let seen = 0;

  const subId = conn.onLogs(PUMP_BONDING_CURVE_PROGRAM_ID, (info) => {
    if (info.err || seen >= 3) return;
    const evts = parser.parseLogs(info.logs);
    for (const e of evts) {
      if (e.name !== "TradeEvent") continue;
      console.log(JSON.stringify(e.data, replacer, 2));
      seen++;
      if (seen >= 3) break;
    }
  }, "confirmed");

  await new Promise((r) => setTimeout(r, 30_000));
  await conn.removeOnLogsListener(subId);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
