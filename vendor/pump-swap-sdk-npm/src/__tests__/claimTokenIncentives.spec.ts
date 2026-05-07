import { expect } from "chai";
import { clusterApiUrl, Connection, PublicKey } from "@solana/web3.js";
import { OnlinePumpAmmSdk } from "../sdk/onlinePumpAmm";
import { PUMP_AMM_PROGRAM_ID } from "../sdk/pda";

describe("claimTokenIncentives", () => {
  const sdk = new OnlinePumpAmmSdk(
    new Connection(clusterApiUrl("devnet"), "confirmed"),
  );
  const testUser = new PublicKey(
    "4kBH5H5p9oRkZPGLSx8R4WKoDsmXnEpmzsgkebkKvzSg",
  );

  xit("should build the instruction successfully", async () => {
    const instruction = await sdk.claimTokenIncentives(testUser, testUser);
    expect(instruction[0].programId.toString()).to.equal(
      PUMP_AMM_PROGRAM_ID.toString(),
    );
  });

  it("getTotalUnclaimedTokens", async () => {
    const sdk = new OnlinePumpAmmSdk(
      new Connection(clusterApiUrl("devnet"), "confirmed"),
    );

    const currentDayTokens = await sdk.getTotalUnclaimedTokens(
      new PublicKey("4kBH5H5p9oRkZPGLSx8R4WKoDsmXnEpmzsgkebkKvzSg"),
    );

    console.log(currentDayTokens);
  });

  it("getCurrentDayTokens", async () => {
    const sdk = new OnlinePumpAmmSdk(
      new Connection(clusterApiUrl("devnet"), "confirmed"),
    );

    const currentDayTokens = await sdk.getCurrentDayTokens(
      new PublicKey("4kBH5H5p9oRkZPGLSx8R4WKoDsmXnEpmzsgkebkKvzSg"),
    );

    console.log(currentDayTokens);
  });
});
