// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
// All rights reserved.

import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "coverage/**", "src/solana/idl/**", "src/solana/legacy-agent-payments/idl.ts"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Unawaited promises were the source of real unhandled rejections here.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    // Mirrors solana-agent-kit's Action interface, which is typed with `any`.
    files: ["src/solana/solana-agent-kit/types.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  {
    // vi.fn() mocks are untyped, so async mock implementations look like
    // promises passed where void is expected.
    files: ["src/**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: false }],
    },
  },
);
