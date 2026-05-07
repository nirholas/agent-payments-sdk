import BN from "bn.js";
import { Connection, PublicKey } from "@solana/web3.js";
import { AnchorProvider, Program } from "@coral-xyz/anchor";
import pumpAmmIdl from "../idl/pump_amm.json";
import { PumpAmm } from "../types/pump_amm";
import { pumpPoolAuthorityPda } from "./pda";

export function ceilDiv(a: BN, b: BN): BN {
  if (b.isZero()) {
    throw new Error("Cannot divide by zero.");
  }
  return a.add(b).subn(1).div(b);
}

export function fee(amount: BN, basisPoints: BN): BN {
  return ceilDiv(amount.mul(basisPoints), new BN(10_000));
}

export function getPumpAmmProgram(connection: Connection): Program<PumpAmm> {
  return new Program(
    pumpAmmIdl as PumpAmm,
    new AnchorProvider(connection, null as any, {}),
  );
}

export function isPumpPool(
  baseMint: PublicKey,
  poolCreator: PublicKey,
): boolean {
  return pumpPoolAuthorityPda(baseMint).equals(poolCreator);
}

export function poolMarketCap({
  baseMintSupply,
  baseReserve,
  quoteReserve,
}: {
  baseMintSupply: BN;
  baseReserve: BN;
  quoteReserve: BN;
}): BN {
  if (baseReserve.isZero()) {
    throw new Error(
      "Division by zero: pool base token reserves cannot be zero",
    );
  }
  return quoteReserve.mul(baseMintSupply).div(baseReserve);
}
