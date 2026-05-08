// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
//
// Shared types for the Solana USDC agent-to-agent payment protocol.
// Used by both Agent B (server) and Agent A (client/orchestrator).

/** A single capability that Agent B sells. */
export interface AgentCapability {
  /** Server path, e.g. "/compute/sha256" */
  path: string;
  /** Human-readable description */
  description: string;
  /** Price in human-readable USDC (e.g. "0.1") */
  priceUsdc: string;
  /** Price in USDC minor units (6 decimals) as a string (e.g. "100000") */
  priceMinorUnits: string;
}

/**
 * Capability manifest returned by Agent B's /.well-known/agent-payments endpoint.
 * Agent A fetches this to discover what Agent B sells and at what price.
 */
export interface AgentCapabilityManifest {
  /** Agent B's pump token mint (base58) */
  agentMint: string;
  /** Human-readable name */
  name: string;
  /** Available paid endpoints */
  capabilities: AgentCapability[];
  /** CAIP-2 network identifier */
  network: string;
  /** Currency asset mint (base58) — USDC */
  asset: string;
}

/**
 * Cryptographic service delivery proof attached by Agent B after settlement.
 * Transmitted as a base64-encoded JSON in the X-SERVICE-PROOF response header.
 */
export interface ServiceProof {
  /** Agent B's pump token mint (base58) */
  agentMint: string;
  /** Invoice memo used for the on-chain payment */
  invoiceMemo: string;
  /** ISO 8601 timestamp when the service was rendered */
  servedAt: string;
  /** On-chain transaction signature confirming the USDC transfer */
  paymentSignature: string;
}

/**
 * Result returned by Agent A's callAgentB() — the compute result paired with
 * the server's service proof and the invoice memo Agent A actually paid for.
 */
export interface CallResult<T = unknown> {
  result: T;
  serviceProof: ServiceProof;
  /** The invoice memo from the payment requirements (used for proof validation) */
  invoiceMemo: string;
}

/** Result of validating a ServiceProof against the known payment details. */
export interface ProofValidation {
  valid: boolean;
  reason?: string;
}
