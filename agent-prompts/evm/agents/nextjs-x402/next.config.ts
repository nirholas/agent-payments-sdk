import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep the SDK in the Node.js runtime; prevents bundler from trying to
  // tree-shake ES module internals that require the Node crypto/buffer APIs.
  serverExternalPackages: ["@nirholas/agent-payments-sdk"],
};

export default nextConfig;
