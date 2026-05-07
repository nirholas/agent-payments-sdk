import BN from "bn.js";
import {
  clusterApiUrl,
  Connection,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { PumpAmmAdminSdk } from "../../sdk/pumpAmmAdmin";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

const MAX_DAYS = 30;

describe("updateTokenIncentives", () => {
  let connection = new Connection(clusterApiUrl("devnet"), "confirmed");
  const sdk = new PumpAmmAdminSdk(connection);

  it("should build the instruction successfully", async () => {
    const now = new BN(Date.now() / 1000 + 500);
    const oneDayLater = new BN(Date.now() / 1000 + 86_400);
    const dayNumber = new BN(MAX_DAYS);
    const tokenSupplyPerDay = new BN(1_000_000_000); // 1 billion tokens
    const secondsInADay = new BN(86_400);
    const mint = new PublicKey("FbQGYrXEocg1o8AebVqxJoMNXtZks58bjsJigckPdXft");

    const instruction = await sdk.adminUpdateTokenIncentives(
      now,
      oneDayLater,
      dayNumber,
      tokenSupplyPerDay,
      secondsInADay,
      mint,
      TOKEN_PROGRAM_ID,
    );

    const blockhash = (await connection.getLatestBlockhash()).blockhash;

    console.log(
      await connection.simulateTransaction(
        new VersionedTransaction(
          new TransactionMessage({
            payerKey: new PublicKey(
              "4kBH5H5p9oRkZPGLSx8R4WKoDsmXnEpmzsgkebkKvzSg",
            ),
            recentBlockhash: blockhash,
            instructions: [instruction],
          }).compileToV0Message(),
        ),
      ),
    );
  });
});
