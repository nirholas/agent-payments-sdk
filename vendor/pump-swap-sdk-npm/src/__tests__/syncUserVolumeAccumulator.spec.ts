import {
  clusterApiUrl,
  Connection,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import BN from "bn.js";
import bs58 from "bs58";
import { OnlinePumpAmmSdk } from "../sdk/onlinePumpAmm";
import { PUMP_AMM_SDK } from "../sdk/offlinePumpAmm";

describe("syncUserVolumeAccumulator", () => {
  const connection = new Connection(clusterApiUrl("devnet"), "confirmed");
  const user = new PublicKey("4kBH5H5p9oRkZPGLSx8R4WKoDsmXnEpmzsgkebkKvzSg");

  it("should build the instruction successfully", async () => {
    console.log(
      await connection.simulateTransaction(
        new VersionedTransaction(
          new TransactionMessage({
            payerKey: user,
            recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
            instructions: [await PUMP_AMM_SDK.syncUserVolumeAccumulator(user)],
          }).compileToV0Message(),
        ),
      ),
    );
  });

  it("initUserVolumeAccumulator", async () => {
    console.log(
      await connection.simulateTransaction(
        new VersionedTransaction(
          new TransactionMessage({
            payerKey: user,
            recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
            instructions: [
              await PUMP_AMM_SDK.initUserVolumeAccumulator({
                payer: user,
                user,
              }),
            ],
          }).compileToV0Message(),
        ),
      ),
    );
  });

  it("closeUserVolumeAccumulator", async () => {
    console.log(
      await connection.simulateTransaction(
        new VersionedTransaction(
          new TransactionMessage({
            payerKey: user,
            recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
            instructions: [await PUMP_AMM_SDK.closeUserVolumeAccumulator(user)],
          }).compileToV0Message(),
        ),
      ),
    );
  });

  it("buyBaseInput", async () => {
    const connection = new Connection(
      clusterApiUrl("mainnet-beta"),
      "confirmed",
    );
    const sdk = new OnlinePumpAmmSdk(connection);

    const pool = new PublicKey("Gf7sXMoP8iRw4iiXmJ1nq4vxcRycbGXy5RL8a8LnTd3v");

    const swapSolanaState = await sdk.swapSolanaState(pool, user);
    const versionedTransaction = new VersionedTransaction(
      new TransactionMessage({
        payerKey: user,
        recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
        instructions: [
          ...(await PUMP_AMM_SDK.buyBaseInput(
            swapSolanaState,
            new BN(10),
            0.1,
          )),
          ...(await PUMP_AMM_SDK.sellBaseInput(
            swapSolanaState,
            new BN(10),
            0.1,
          )),
        ],
      }).compileToV0Message(),
    );

    console.log(bs58.encode(versionedTransaction.serialize()));
    console.log(await connection.simulateTransaction(versionedTransaction));
  });

  it("buyBaseInput", async () => {
    const connection = new Connection(
      clusterApiUrl("mainnet-beta"),
      "confirmed",
    );
    const sdk = new OnlinePumpAmmSdk(connection);
    const pool = new PublicKey("Gf7sXMoP8iRw4iiXmJ1nq4vxcRycbGXy5RL8a8LnTd3v");

    console.log(
      await connection.simulateTransaction(
        new VersionedTransaction(
          new TransactionMessage({
            payerKey: user,
            recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
            instructions: await PUMP_AMM_SDK.buyBaseInput(
              await sdk.swapSolanaState(pool, user),
              new BN(10),
              10,
            ),
          }).compileToV0Message(),
        ),
      ),
    );
  });
});
