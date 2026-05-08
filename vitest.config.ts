// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
// All rights reserved.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    coverage: {
      provider: "v8",
      include: ["src/solana/legacy-agent-payments/**/*.ts"],
      exclude: [
        "src/solana/legacy-agent-payments/**/*.test.ts",
        "src/solana/legacy-agent-payments/idl.ts",
        "src/solana/legacy-agent-payments/types.ts",
        "src/solana/legacy-agent-payments/index.ts",
        // RPC-bound class — out of scope per the test plan; only offline
        // surface gets unit tests.
        "src/solana/legacy-agent-payments/PumpAgent.ts",
      ],
      reporter: ["text", "json-summary"],
    },
  },
});
