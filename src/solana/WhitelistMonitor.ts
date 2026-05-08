/**
 * WhitelistMonitor — reads `Global.whitelistedQuoteMints` from the on-chain
 * pump program to determine which quote mints (e.g. USDC) are currently
 * eligible for `create_v2`.
 *
 * NOTE: Stub surface — the full reader implementation lands via the
 * companion PR ("Prompt A"). The shape here is sufficient for the v2
 * solana-agent-kit actions to compile and to be unit-tested via mocks.
 */
import { Connection, PublicKey } from "@solana/web3.js";

export class WhitelistMonitor {
  static async isWhitelisted(
    _connection: Connection,
    _quoteMint: PublicKey,
  ): Promise<boolean> {
    throw new Error(
      "WhitelistMonitor.isWhitelisted is a stub — companion PR (Prompt A) provides the implementation.",
    );
  }

  static async getCurrentWhitelist(
    _connection: Connection,
  ): Promise<PublicKey[]> {
    throw new Error(
      "WhitelistMonitor.getCurrentWhitelist is a stub — companion PR (Prompt A) provides the implementation.",
    );
  }
}
