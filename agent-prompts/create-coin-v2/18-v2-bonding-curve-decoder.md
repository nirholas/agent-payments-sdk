# Task 18 — Fix and complete the v2 bonding curve decoder

You are a senior TypeScript engineer. Complete this task end-to-end — write production-quality code, fetch real on-chain data for test fixtures, and make all tests pass.

## Goal

Create `src/solana/bondingCurveDecoder.ts` in `/workspaces/agent-payments-sdk` that correctly decodes both the legacy 49-byte v1 bonding curve account format and the new 115-byte v2 format from pump.fun's bonding curve program (`6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`).

Then write tests in `src/solana/bondingCurveDecoder.test.ts` using real hex fixtures fetched from mainnet.

## Files to read first

1. `/workspaces/agent-payments-sdk/src/solana/index.ts` — check existing exports to know what to re-export
2. `/workspaces/agent-payments-sdk/src/solana/PumpAgentOffline.ts` — see how `decodeBondingCurveQuoteMint` works today
3. `/workspaces/agent-payments-sdk/src/solana/constants.ts` — check USDC_MINT and other constants
4. `/workspaces/agent-payments-sdk/src/solana/pdas.ts` — see `getBondingCurvePDA` helper
5. `/workspaces/agent-payments-sdk/src/solana/PumpAgent.test.ts` — see how tests are structured
6. `/workspaces/agent-payments-sdk/package.json` — check test runner (likely vitest or jest)
7. `/workspaces/agent-payments-sdk/swap/node_modules/@pump-fun/pump-sdk/` — check if `PUMP_SDK.decodeBondingCurve` is exported

## Bonding curve account layout

### v1 format (49 bytes)
```
Offset  Size  Field
0       8     discriminator (anchor account discriminator)
8       8     virtualTokenReserves (u64, little-endian)
16      8     virtualSolReserves (u64, little-endian)
24      8     realTokenReserves (u64, little-endian)
32      8     realSolReserves (u64, little-endian)
40      8     tokenTotalSupply (u64, little-endian)
48      1     complete (bool)
Total = 49 bytes
```

### v2 format (115 bytes)
```
Offset  Size  Field
0       8     discriminator
8       8     virtualTokenReserves (u64)
16      8     virtualSolReserves (u64)
24      8     realTokenReserves (u64)
32      8     realSolReserves (u64)
40      8     tokenTotalSupply (u64)
48      1     complete (bool)
49      32    creator (PublicKey)
81      1     isMayhemMode (bool)
82      1     isCashbackCoin (bool)
83      32    quoteMint (PublicKey)
Total = 115 bytes
```

Note: v2 may also include `virtualQuoteReserves` and `realQuoteReserves` fields — check by fetching a real v2 account and inspecting the raw bytes. If the account is larger than 115 bytes, there are additional fields. Decode what you find.

## Implementation

### Create `src/solana/bondingCurveDecoder.ts`

```typescript
import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';

export interface BondingCurveV1 {
  virtualTokenReserves: BN;
  virtualSolReserves: BN;
  realTokenReserves: BN;
  realSolReserves: BN;
  tokenTotalSupply: BN;
  complete: boolean;
  version: 1;
}

export interface BondingCurveV2 extends Omit<BondingCurveV1, 'version'> {
  creator: PublicKey;
  isMayhemMode: boolean;
  isCashbackCoin: boolean;
  quoteMint: PublicKey;
  /** For non-SOL quote mints (e.g. USDC), the virtual quote reserve */
  virtualQuoteReserves: BN | null;
  /** For non-SOL quote mints, the real quote reserve */
  realQuoteReserves: BN | null;
  version: 2;
}

export type BondingCurve = BondingCurveV1 | BondingCurveV2;

const DISCRIMINATOR_SIZE = 8;
const V1_SIZE = 49; // 8 + 8*5 + 1
const V2_MIN_SIZE = 115; // V1_SIZE + 32 + 1 + 1 + 32

function readU64(buf: Buffer, offset: number): BN {
  // u64 little-endian
  return new BN(buf.slice(offset, offset + 8), 'le');
}

function readPublicKey(buf: Buffer, offset: number): PublicKey {
  return new PublicKey(buf.slice(offset, offset + 32));
}

export function decodeBondingCurve(data: Buffer): BondingCurve {
  if (data.length < V1_SIZE) {
    throw new Error(`Bonding curve account too small: ${data.length} bytes (expected at least ${V1_SIZE})`);
  }

  // Skip 8-byte discriminator
  let offset = DISCRIMINATOR_SIZE;

  const virtualTokenReserves = readU64(data, offset); offset += 8;
  const virtualSolReserves = readU64(data, offset); offset += 8;
  const realTokenReserves = readU64(data, offset); offset += 8;
  const realSolReserves = readU64(data, offset); offset += 8;
  const tokenTotalSupply = readU64(data, offset); offset += 8;
  const complete = data[offset] !== 0; offset += 1;

  if (data.length < V2_MIN_SIZE) {
    // v1 format
    return {
      virtualTokenReserves,
      virtualSolReserves,
      realTokenReserves,
      realSolReserves,
      tokenTotalSupply,
      complete,
      version: 1,
    };
  }

  // v2 additional fields
  const creator = readPublicKey(data, offset); offset += 32;
  const isMayhemMode = data[offset] !== 0; offset += 1;
  const isCashbackCoin = data[offset] !== 0; offset += 1;
  const quoteMint = readPublicKey(data, offset); offset += 32;

  // Optional extended fields if account is larger
  let virtualQuoteReserves: BN | null = null;
  let realQuoteReserves: BN | null = null;
  if (data.length >= offset + 16) {
    virtualQuoteReserves = readU64(data, offset); offset += 8;
    realQuoteReserves = readU64(data, offset); offset += 8;
  }

  return {
    virtualTokenReserves,
    virtualSolReserves,
    realTokenReserves,
    realSolReserves,
    tokenTotalSupply,
    complete,
    creator,
    isMayhemMode,
    isCashbackCoin,
    quoteMint,
    virtualQuoteReserves,
    realQuoteReserves,
    version: 2,
  };
}

export function isV2BondingCurve(bc: BondingCurve): bc is BondingCurveV2 {
  return bc.version === 2;
}

const USDC_MINT_ADDRESS = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const NATIVE_MINT_ADDRESS = 'So11111111111111111111111111111111111111112';

export function isUsdcQuoted(bc: BondingCurve): boolean {
  if (!isV2BondingCurve(bc)) return false;
  return bc.quoteMint.toBase58() === USDC_MINT_ADDRESS;
}

export function isSolQuoted(bc: BondingCurve): boolean {
  if (!isV2BondingCurve(bc)) return true; // v1 is always SOL-quoted
  const q = bc.quoteMint.toBase58();
  return q === NATIVE_MINT_ADDRESS || q === '11111111111111111111111111111111'; // system program = native
}

export function getQuoteMintAddress(bc: BondingCurve): string {
  if (!isV2BondingCurve(bc)) return NATIVE_MINT_ADDRESS;
  return bc.quoteMint.toBase58();
}
```

### Export from `src/solana/index.ts`

Add to the existing exports in `src/solana/index.ts`:

```typescript
export {
  decodeBondingCurve,
  isV2BondingCurve,
  isUsdcQuoted,
  isSolQuoted,
  getQuoteMintAddress,
} from './bondingCurveDecoder';
export type {
  BondingCurve,
  BondingCurveV1,
  BondingCurveV2,
} from './bondingCurveDecoder';
```

## Test fixtures — fetch from mainnet

Before writing tests, fetch the real account data from mainnet RPC to build accurate hex fixtures.

Run this script to get the raw bytes:

```bash
node -e "
const { Connection, PublicKey } = require('@solana/web3.js');
const conn = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');

// v2 TEST coin bonding curve
const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const TEST_MINT = '7DU5iH56AjEgbjmGJ21i1GiyxPxxGVLJwnPdar8ZmDrv';

// Derive bonding curve PDA: seeds = [Buffer.from('bonding-curve'), mint]
const [bcPDA] = PublicKey.findProgramAddressSync(
  [Buffer.from('bonding-curve'), new PublicKey(TEST_MINT).toBuffer()],
  new PublicKey(PUMP_PROGRAM)
);
console.log('Bonding curve PDA:', bcPDA.toBase58());
conn.getAccountInfo(bcPDA).then(info => {
  if (!info) { console.log('Account not found'); return; }
  console.log('Data length:', info.data.length);
  console.log('Hex:', info.data.toString('hex'));
});
"
```

Also fetch a v1 coin (any old pump.fun coin launched before v2). You can use any known v1 coin from pump.fun's token list. Example using a well-known early token (replace with a real v1 mint you know):

```bash
node -e "
const { Connection, PublicKey } = require('@solana/web3.js');
const conn = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
// Use a known v1 coin mint — find one from pump.fun that was created before v2 launch
// If a v1 coin has graduated (bonding curve complete), the account may be closed.
// Try: Ce7YaH4MBaZ9JxNkMqTqYGW4kqWcjP3d6fGfTCNspump (adjust to a real mint)
const V1_MINT = 'REPLACE_WITH_REAL_V1_MINT';
const [bcPDA] = PublicKey.findProgramAddressSync(
  [Buffer.from('bonding-curve'), new PublicKey(V1_MINT).toBuffer()],
  new PublicKey(PUMP_PROGRAM)
);
conn.getAccountInfo(bcPDA).then(info => {
  if (!info) { console.log('Not found — try another v1 mint'); return; }
  console.log('Data length:', info.data.length);
  console.log('Hex:', info.data.toString('hex'));
});
"
```

Find a real v1 mint by checking pump.fun's API or using a known early coin.

Once you have the hex strings, hardcode them in the test file.

## Tests `src/solana/bondingCurveDecoder.test.ts`

```typescript
import { describe, it, expect, beforeAll } from 'vitest'; // or jest
import { Connection, PublicKey } from '@solana/web3.js';
import {
  decodeBondingCurve,
  isV2BondingCurve,
  isUsdcQuoted,
  isSolQuoted,
  getQuoteMintAddress,
  BondingCurveV1,
  BondingCurveV2,
} from './bondingCurveDecoder';

// ── Fixtures ─────────────────────────────────────────────────────────────────
// Fetched from mainnet using the script above. Replace HEX strings with real data.

// v1: 49-byte format. Fetch a real v1 coin's bonding curve account.
// Replace this placeholder with the actual hex from mainnet:
const V1_HEX = 'REPLACE_WITH_REAL_V1_HEX_FROM_MAINNET';

// v2: 115+ byte format. TEST coin: 7DU5iH56AjEgbjmGJ21i1GiyxPxxGVLJwnPdar8ZmDrv
// Replace this placeholder with the actual hex from mainnet:
const V2_HEX = 'REPLACE_WITH_REAL_V2_HEX_FROM_MAINNET';

// ── Tests ─────────────────────────────────────────────────────────────────────
describe('decodeBondingCurve', () => {
  describe('v1 format (49 bytes)', () => {
    let bc: BondingCurveV1;
    beforeAll(() => {
      const buf = Buffer.from(V1_HEX, 'hex');
      expect(buf.length).toBe(49);
      bc = decodeBondingCurve(buf) as BondingCurveV1;
    });

    it('returns version 1', () => {
      expect(bc.version).toBe(1);
    });
    it('isV2BondingCurve returns false', () => {
      expect(isV2BondingCurve(bc)).toBe(false);
    });
    it('has positive virtualTokenReserves', () => {
      expect(bc.virtualTokenReserves.gtn(0)).toBe(true);
    });
    it('has positive virtualSolReserves', () => {
      expect(bc.virtualSolReserves.gtn(0)).toBe(true);
    });
    it('isUsdcQuoted returns false for v1', () => {
      expect(isUsdcQuoted(bc)).toBe(false);
    });
    it('isSolQuoted returns true for v1', () => {
      expect(isSolQuoted(bc)).toBe(true);
    });
    it('getQuoteMintAddress returns wSOL for v1', () => {
      expect(getQuoteMintAddress(bc)).toBe('So11111111111111111111111111111111111111112');
    });
  });

  describe('v2 format (115+ bytes)', () => {
    let bc: BondingCurveV2;
    beforeAll(() => {
      const buf = Buffer.from(V2_HEX, 'hex');
      expect(buf.length).toBeGreaterThanOrEqual(115);
      bc = decodeBondingCurve(buf) as BondingCurveV2;
    });

    it('returns version 2', () => {
      expect(bc.version).toBe(2);
    });
    it('isV2BondingCurve returns true', () => {
      expect(isV2BondingCurve(bc)).toBe(true);
    });
    it('has a creator PublicKey', () => {
      expect(bc.creator).toBeInstanceOf(PublicKey);
      expect(bc.creator.toBase58()).toHaveLength(44);
    });
    it('has a quoteMint PublicKey', () => {
      expect(bc.quoteMint).toBeInstanceOf(PublicKey);
    });
    it('isMayhemMode is a boolean', () => {
      expect(typeof bc.isMayhemMode).toBe('boolean');
    });
    it('isCashbackCoin is a boolean', () => {
      expect(typeof bc.isCashbackCoin).toBe('boolean');
    });
    it('has positive tokenTotalSupply', () => {
      expect(bc.tokenTotalSupply.gtn(0)).toBe(true);
    });
  });

  describe('error handling', () => {
    it('throws on too-small buffer', () => {
      expect(() => decodeBondingCurve(Buffer.alloc(10))).toThrow(/too small/);
    });
    it('handles exactly 49 bytes as v1', () => {
      const buf = Buffer.alloc(49);
      buf.writeUInt8(1, 48); // complete = true
      const bc = decodeBondingCurve(buf);
      expect(bc.version).toBe(1);
    });
    it('handles exactly 115 bytes as v2', () => {
      const buf = Buffer.alloc(115);
      const bc = decodeBondingCurve(buf);
      expect(bc.version).toBe(2);
    });
  });

  describe('live mainnet fetch (integration)', () => {
    // Skipped by default — run with TEST_LIVE=1 to enable
    const skip = !process.env.TEST_LIVE;

    it('fetches and decodes TEST coin v2 bonding curve from mainnet', async () => {
      if (skip) return;
      const TEST_MINT = '7DU5iH56AjEgbjmGJ21i1GiyxPxxGVLJwnPdar8ZmDrv';
      const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
      const conn = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
      const [bcPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from('bonding-curve'), new PublicKey(TEST_MINT).toBuffer()],
        new PublicKey(PUMP_PROGRAM),
      );
      const info = await conn.getAccountInfo(bcPDA);
      expect(info).not.toBeNull();
      const bc = decodeBondingCurve(Buffer.from(info!.data));
      expect(isV2BondingCurve(bc)).toBe(true);
      if (isV2BondingCurve(bc)) {
        console.log('TEST coin quoteMint:', bc.quoteMint.toBase58());
        console.log('creator:', bc.creator.toBase58());
      }
    });
  });
});
```

## Steps to get real fixtures

1. Run the Node.js snippet above to fetch the TEST coin v2 hex
2. Run the snippet for a v1 coin (search pump.fun for any early coin that hasn't graduated)
3. Copy the hex strings into the test file replacing the `REPLACE_WITH_REAL_*` placeholders
4. Adjust the `beforeAll` size expectations to match actual data lengths

## Running tests

```bash
cd /workspaces/agent-payments-sdk
npm test -- --testPathPattern bondingCurveDecoder
# or if vitest:
npx vitest run src/solana/bondingCurveDecoder.test.ts
```

All tests must pass (the `live mainnet fetch` test is skipped unless `TEST_LIVE=1`).

## Checklist

- [ ] Read `src/solana/index.ts` to understand existing structure
- [ ] Read `src/solana/PumpAgentOffline.ts` to see the existing `decodeBondingCurveQuoteMint`
- [ ] Create `src/solana/bondingCurveDecoder.ts` with all exported types and functions
- [ ] Export from `src/solana/index.ts`
- [ ] Run the mainnet fetch scripts to get real hex fixtures
- [ ] Create `src/solana/bondingCurveDecoder.test.ts` with real hex fixtures
- [ ] All unit tests pass (`npm test`)
- [ ] The decoder handles both 49-byte and 115-byte inputs correctly
- [ ] The decoder handles optional extended fields (>115 bytes) without crashing

## Do not

- Do not modify existing decoders in `src/solana/decoders.ts`
- Do not change the Anchor IDL or program definition
- Do not use `PUMP_SDK.decodeBondingCurve` as a dependency (implement manually so the library doesn't require the full pump-sdk at runtime)
- Do not hardcode public key bytes directly — always derive them via `PublicKey`
