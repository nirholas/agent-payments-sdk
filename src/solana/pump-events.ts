// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
// All rights reserved.

/**
 * Typed event parser and live subscriber for the pump.fun bonding-curve
 * program (`6EF8rrec...`).
 *
 * Intentionally separate from `./events.ts` which targets the
 * `agent-payments` program. Both programs emit Anchor `emit_cpi!` events
 * but their IDLs are completely different.
 *
 * Field names are the snake_case names in the IDL (e.g. `is_buy`,
 * `sol_amount`), so the interfaces below match the runtime values exactly.
 *
 * IDL source: pump-public-docs/idl/pump.json (the October 2026 layout),
 * vendored as ./idl/pump.json.
 *
 * Length tolerance: every program upgrade appends fields to existing events
 * (the October 2026 upgrade added `holder_rewards_bps`, `holder_rewards` and
 * `creator_fee_unclaimed` to `TradeEvent`, and `creator_fee_bps`,
 * `is_holder_reward` and `depth` to `CreateEvent`). Anchor's
 * `BorshEventCoder` decodes a whole struct at once and throws a RangeError on
 * an event logged before a field existed, so historical transactions would
 * fail to parse against the current IDL. This module decodes field by field
 * instead: fields the bytes do not reach get a zero value (see
 * `absentFieldValue`) and are listed in `ParsedPumpEvent.absentFields`, and
 * bytes past the last known field (a future upgrade) are ignored. Events the
 * program no longer emits but that exist in history are kept in
 * `RETIRED_EVENTS` so old logs still decode.
 */

import {
  PublicKey,
  type Commitment,
  type Connection,
  type Logs,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { IdlCoder } from "@coral-xyz/anchor/dist/cjs/coder/borsh/idl.js";
import type { IdlField, IdlType, IdlTypeDef } from "@coral-xyz/anchor/dist/cjs/idl.js";

import IDL_JSON from "./idl/pump.json";

// ─── Program constant ────────────────────────────────────────────────────────

/** The pump.fun bonding-curve program id. */
export const PUMP_BONDING_CURVE_PROGRAM_ID = new PublicKey(IDL_JSON.address);

// ─── Typed event data interfaces ─────────────────────────────────────────────
// Field names and types are derived from the vendored IDL (./idl/pump.json).
// Pubkey fields: PublicKey; u64/i64: BN; u8/u16: number; bool: boolean;
// string: string. A field an older event predates decodes to its zero value
// and is named in `ParsedPumpEvent.absentFields`.

export interface Shareholder {
  address: PublicKey;
  share_bps: number;
}

export interface AddQuoteControlMintEventData {
  quote_control: PublicKey;
  authority: PublicKey;
  quote_mint: PublicKey;
  initial_virtual_quote_reserves: BN;
  timestamp: BN;
}

export interface AdminCtoEventData {
  timestamp: BN;
  authority: PublicKey;
  mint: PublicKey;
  bonding_curve: PublicKey;
  old_creator: PublicKey;
  new_creator: PublicKey;
  is_holder_reward: boolean;
  is_cashback_coin: boolean;
  old_creator_fee_bps: BN;
  new_creator_fee_bps: BN;
  sharing_config_reset: boolean;
  swept_to_holder_vault: BN;
  pool_updated: boolean;
}

/** Retired: the program no longer emits it (see `RETIRED_EVENTS`). */
export interface AdminSetCreatorEventData {
  timestamp: BN;
  admin_set_creator_authority: PublicKey;
  mint: PublicKey;
  bonding_curve: PublicKey;
  old_creator: PublicKey;
  new_creator: PublicKey;
}

export interface AdminSetIdlAuthorityEventData {
  idl_authority: PublicKey;
}

export interface AdminUpdateTokenIncentivesEventData {
  start_time: BN;
  end_time: BN;
  day_number: BN;
  token_supply_per_day: BN;
  mint: PublicKey;
  seconds_in_a_day: BN;
  timestamp: BN;
}

export interface ClaimCashbackEventData {
  user: PublicKey;
  amount: BN;
  timestamp: BN;
  total_claimed: BN;
  total_cashback_earned: BN;
}

export interface ClaimTokenIncentivesEventData {
  user: PublicKey;
  mint: PublicKey;
  amount: BN;
  timestamp: BN;
  total_claimed_tokens: BN;
  current_sol_volume: BN;
}

export interface CloseUserVolumeAccumulatorEventData {
  user: PublicKey;
  timestamp: BN;
  total_unclaimed_tokens: BN;
  total_claimed_tokens: BN;
  current_sol_volume: BN;
  last_update_timestamp: BN;
}

export interface CollectCreatorFeeEventData {
  timestamp: BN;
  creator: PublicKey;
  creator_fee: BN;
  quote_mint: PublicKey;
}

export interface CompleteEventData {
  user: PublicKey;
  mint: PublicKey;
  bonding_curve: PublicKey;
  timestamp: BN;
  quote_mint: PublicKey;
}

export interface CompletePumpAmmMigrationEventData {
  user: PublicKey;
  mint: PublicKey;
  mint_amount: BN;
  sol_amount: BN;
  pool_migration_fee: BN;
  bonding_curve: PublicKey;
  timestamp: BN;
  pool: PublicKey;
  quote_mint: PublicKey;
}

export interface CreateEventData {
  name: string;
  symbol: string;
  uri: string;
  mint: PublicKey;
  bonding_curve: PublicKey;
  user: PublicKey;
  creator: PublicKey;
  timestamp: BN;
  virtual_token_reserves: BN;
  virtual_sol_reserves: BN;
  real_token_reserves: BN;
  token_total_supply: BN;
  token_program: PublicKey;
  is_mayhem_mode: boolean;
  is_cashback_enabled: boolean;
  quote_mint: PublicKey;
  virtual_quote_reserves: BN;
  /** Creator fee rate chosen at creation (configurable creator fees). */
  creator_fee_bps: BN;
  is_holder_reward: boolean;
  /** Quote-chain depth: 0 for SOL / listed quotes, 1+ for a pump-coin quote. */
  depth: number;
}

export interface DistributeCreatorFeesEventData {
  timestamp: BN;
  mint: PublicKey;
  bonding_curve: PublicKey;
  sharing_config: PublicKey;
  admin: PublicKey;
  shareholders: Shareholder[];
  distributed: BN;
  quote_mint: PublicKey;
}

export interface DistributeFeeToHoldersEventData {
  timestamp: BN;
  mint: PublicKey;
  quote_mint: PublicKey;
  recipients: BN;
  total: BN;
}

export interface ExtendAccountEventData {
  account: PublicKey;
  user: PublicKey;
  current_size: BN;
  new_size: BN;
  timestamp: BN;
}

export interface InitUserVolumeAccumulatorEventData {
  payer: PublicKey;
  user: PublicKey;
  timestamp: BN;
}

export interface MigrateBondingCurveCreatorEventData {
  timestamp: BN;
  mint: PublicKey;
  bonding_curve: PublicKey;
  sharing_config: PublicKey;
  old_creator: PublicKey;
  new_creator: PublicKey;
}

export interface MinimumDistributableFeeEventData {
  minimum_required: BN;
  distributable_fees: BN;
  can_distribute: boolean;
}

/**
 * Emitted after `CompleteEvent` when a v3 buy runs past the curve's remaining
 * supply: the rest of the buy is filled at the price of the pool the
 * migration will create (synthetic migration).
 */
export interface PostCompleteBuyEventData {
  user: PublicKey;
  mint: PublicKey;
  bonding_curve: PublicKey;
  quote_mint: PublicKey;
  timestamp: BN;
  base_out: BN;
  quote_in: BN;
  fee_basis_points: BN;
  fee: BN;
  creator_fee_basis_points: BN;
  creator_fee: BN;
  buyback_fee: BN;
  pool_base_reserves_before: BN;
  pool_quote_reserves_before: BN;
  pool_base_reserves_after: BN;
  pool_quote_reserves_after: BN;
}

export interface RemoveQuoteControlMintEventData {
  quote_control: PublicKey;
  authority: PublicKey;
  quote_mint: PublicKey;
  timestamp: BN;
}

export interface ReservedFeeRecipientsEventData {
  timestamp: BN;
  reserved_fee_recipient: PublicKey;
  reserved_fee_recipients: PublicKey[];
}

export interface SetCreatorEventData {
  timestamp: BN;
  mint: PublicKey;
  bonding_curve: PublicKey;
  creator: PublicKey;
}

export interface SetMetaplexCreatorEventData {
  timestamp: BN;
  mint: PublicKey;
  bonding_curve: PublicKey;
  metadata: PublicKey;
  creator: PublicKey;
}

export interface SetParamsEventData {
  initial_virtual_token_reserves: BN;
  initial_virtual_sol_reserves: BN;
  initial_real_token_reserves: BN;
  final_real_sol_reserves: BN;
  token_total_supply: BN;
  fee_basis_points: BN;
  withdraw_authority: PublicKey;
  enable_migrate: boolean;
  pool_migration_fee: BN;
  creator_fee_basis_points: BN;
  fee_recipients: PublicKey[];
  timestamp: BN;
  set_creator_authority: PublicKey;
  admin_set_creator_authority: PublicKey;
}

export interface SetQuoteControlAdminEventData {
  quote_control: PublicKey;
  authority: PublicKey;
  old_admin: PublicKey;
  new_admin: PublicKey;
  timestamp: BN;
}

export interface SetQuoteControlMintReservesEventData {
  quote_control: PublicKey;
  authority: PublicKey;
  quote_mint: PublicKey;
  old_initial_virtual_quote_reserves: BN;
  new_initial_virtual_quote_reserves: BN;
  timestamp: BN;
}

export interface SetQuoteControlReservesAdminEventData {
  quote_control: PublicKey;
  authority: PublicKey;
  old_reserves_admin: PublicKey;
  new_reserves_admin: PublicKey;
  timestamp: BN;
}

/** Fee bucket a `SweepBondingCurveFeeEvent` paid out. */
export const SWEEP_BUCKET = { protocol: 0, creator: 1 } as const;

/**
 * `sweep_protocol_fee` / `sweep_creator_fee`: fees v3 trades left on the
 * curve (`BondingCurve.protocol_fees` / `creator_fee`) paid to `recipient`.
 * `bucket` is `SWEEP_BUCKET.protocol` or `SWEEP_BUCKET.creator`.
 */
export interface SweepBondingCurveFeeEventData {
  timestamp: BN;
  mint: PublicKey;
  bonding_curve: PublicKey;
  quote_mint: PublicKey;
  recipient: PublicKey;
  amount: BN;
  bucket: number;
}

export interface SyncUserVolumeAccumulatorEventData {
  user: PublicKey;
  total_claimed_tokens_before: BN;
  total_claimed_tokens_after: BN;
  timestamp: BN;
}

export interface TradeEventData {
  mint: PublicKey;
  sol_amount: BN;
  token_amount: BN;
  is_buy: boolean;
  user: PublicKey;
  timestamp: BN;
  virtual_sol_reserves: BN;
  virtual_token_reserves: BN;
  real_sol_reserves: BN;
  real_token_reserves: BN;
  fee_recipient: PublicKey;
  fee_basis_points: BN;
  fee: BN;
  creator: PublicKey;
  creator_fee_basis_points: BN;
  creator_fee: BN;
  track_volume: boolean;
  total_unclaimed_tokens: BN;
  total_claimed_tokens: BN;
  current_sol_volume: BN;
  last_update_timestamp: BN;
  ix_name: string;
  mayhem_mode: boolean;
  cashback_fee_basis_points: BN;
  cashback: BN;
  buyback_fee_basis_points: BN;
  buyback_fee: BN;
  shareholders: Shareholder[];
  quote_mint: PublicKey;
  quote_amount: BN;
  virtual_quote_reserves: BN;
  real_quote_reserves: BN;
  holder_rewards_bps: BN;
  holder_rewards: BN;
  /**
   * Creator fee this trade left on the curve for a later `sweep_creator_fee`
   * (v3 trades). Zero on v1 / v2 trades, which pay the creator vault directly.
   */
  creator_fee_unclaimed: BN;
}

export interface UpdateCreatorFeeConfigEventData {
  timestamp: BN;
  authority: PublicKey;
  creator_fee_configurable: boolean;
  max_configurable_creator_fee_bps: BN;
}

export interface UpdateGlobalAuthorityEventData {
  global: PublicKey;
  authority: PublicKey;
  new_authority: PublicKey;
  timestamp: BN;
}

export interface UpdateMayhemVirtualParamsEventData {
  timestamp: BN;
  mint: PublicKey;
  virtual_token_reserves: BN;
  virtual_sol_reserves: BN;
  new_virtual_token_reserves: BN;
  new_virtual_sol_reserves: BN;
  real_token_reserves: BN;
  real_sol_reserves: BN;
}

// ─── Discriminated map ───────────────────────────────────────────────────────

export interface PumpEventDataMap {
  AddQuoteControlMintEvent: AddQuoteControlMintEventData;
  AdminCtoEvent: AdminCtoEventData;
  AdminSetCreatorEvent: AdminSetCreatorEventData;
  AdminSetIdlAuthorityEvent: AdminSetIdlAuthorityEventData;
  AdminUpdateTokenIncentivesEvent: AdminUpdateTokenIncentivesEventData;
  ClaimCashbackEvent: ClaimCashbackEventData;
  ClaimTokenIncentivesEvent: ClaimTokenIncentivesEventData;
  CloseUserVolumeAccumulatorEvent: CloseUserVolumeAccumulatorEventData;
  CollectCreatorFeeEvent: CollectCreatorFeeEventData;
  CompleteEvent: CompleteEventData;
  CompletePumpAmmMigrationEvent: CompletePumpAmmMigrationEventData;
  CreateEvent: CreateEventData;
  DistributeCreatorFeesEvent: DistributeCreatorFeesEventData;
  DistributeFeeToHoldersEvent: DistributeFeeToHoldersEventData;
  ExtendAccountEvent: ExtendAccountEventData;
  InitUserVolumeAccumulatorEvent: InitUserVolumeAccumulatorEventData;
  MigrateBondingCurveCreatorEvent: MigrateBondingCurveCreatorEventData;
  MinimumDistributableFeeEvent: MinimumDistributableFeeEventData;
  PostCompleteBuyEvent: PostCompleteBuyEventData;
  RemoveQuoteControlMintEvent: RemoveQuoteControlMintEventData;
  ReservedFeeRecipientsEvent: ReservedFeeRecipientsEventData;
  SetCreatorEvent: SetCreatorEventData;
  SetMetaplexCreatorEvent: SetMetaplexCreatorEventData;
  SetParamsEvent: SetParamsEventData;
  SetQuoteControlAdminEvent: SetQuoteControlAdminEventData;
  SetQuoteControlMintReservesEvent: SetQuoteControlMintReservesEventData;
  SetQuoteControlReservesAdminEvent: SetQuoteControlReservesAdminEventData;
  SweepBondingCurveFeeEvent: SweepBondingCurveFeeEventData;
  SyncUserVolumeAccumulatorEvent: SyncUserVolumeAccumulatorEventData;
  TradeEvent: TradeEventData;
  UpdateCreatorFeeConfigEvent: UpdateCreatorFeeConfigEventData;
  UpdateGlobalAuthorityEvent: UpdateGlobalAuthorityEventData;
  UpdateMayhemVirtualParamsEvent: UpdateMayhemVirtualParamsEventData;
}

export type PumpEventName = keyof PumpEventDataMap;

export interface ParsedPumpEvent<E extends PumpEventName = PumpEventName> {
  name: E;
  data: PumpEventDataMap[E];
  /**
   * Fields of the current layout this event's bytes did not reach because it
   * was logged before an upgrade added them. They hold zero values in `data`.
   * Empty for an event in the current layout.
   */
  absentFields: string[];
  signature?: string;
  slot?: number;
}

// ─── Event layouts ───────────────────────────────────────────────────────────

interface EventTypeDef {
  name: string;
  discriminator: readonly number[];
  typeDef: IdlTypeDef;
}

/**
 * Events the program emitted in the past that the current IDL no longer
 * lists. Historical transactions still carry them, so their layouts stay here
 * (copied from the pump IDL before the October 2026 upgrade).
 */
export const RETIRED_EVENTS: ReadonlyArray<EventTypeDef> = [
  {
    name: "AdminSetCreatorEvent",
    discriminator: [64, 69, 192, 104, 29, 30, 25, 107],
    typeDef: {
      name: "AdminSetCreatorEvent",
      type: {
        kind: "struct",
        fields: [
          { name: "timestamp", type: "i64" },
          { name: "admin_set_creator_authority", type: "pubkey" },
          { name: "mint", type: "pubkey" },
          { name: "bonding_curve", type: "pubkey" },
          { name: "old_creator", type: "pubkey" },
          { name: "new_creator", type: "pubkey" },
        ],
      },
    },
  },
];

type FieldLayout = ReturnType<typeof IdlCoder.fieldLayout>;

interface FieldDecoder {
  name: string;
  type: IdlType;
  layout: FieldLayout;
}

interface EventDecoder {
  name: PumpEventName;
  discriminator: Buffer;
  fields: FieldDecoder[];
}

const IDL_TYPES = IDL_JSON.types as unknown as IdlTypeDef[];

function currentEventTypeDefs(): EventTypeDef[] {
  return IDL_JSON.events.map((ev) => {
    const typeDef = IDL_TYPES.find((t) => t.name === ev.name);
    if (!typeDef) {
      throw new Error(`pump-events: IDL event ${ev.name} has no type definition`);
    }
    return { name: ev.name, discriminator: ev.discriminator, typeDef };
  });
}

function buildEventDecoder({ name, discriminator, typeDef }: EventTypeDef): EventDecoder {
  const ty = typeDef.type;
  if (ty.kind !== "struct" || !ty.fields || typeof ty.fields[0] === "string") {
    throw new Error(`pump-events: event ${name} is not a struct with named fields`);
  }
  const fields = (ty.fields as IdlField[]).map((field) => ({
    name: field.name,
    type: field.type,
    layout: IdlCoder.fieldLayout(field, IDL_TYPES),
  }));
  return {
    name: name as PumpEventName,
    discriminator: Buffer.from(discriminator),
    fields,
  };
}

const EVENT_DECODERS: EventDecoder[] = [
  ...currentEventTypeDefs(),
  ...RETIRED_EVENTS,
].map(buildEventDecoder);

// ─── Discriminator map ───────────────────────────────────────────────────────

/**
 * Maps each event name to its 8-byte discriminator Buffer: every event in
 * the IDL plus `RETIRED_EVENTS`.
 */
export const eventDiscriminatorMap: Map<PumpEventName, Buffer> = new Map(
  EVENT_DECODERS.map((d) => [d.name, d.discriminator]),
);

// Invariant: names and discriminators are unique. Fires at module load.
if (
  eventDiscriminatorMap.size !== EVENT_DECODERS.length ||
  new Set(EVENT_DECODERS.map((d) => d.discriminator.toString("hex"))).size !==
    EVENT_DECODERS.length
) {
  throw new Error(
    `pump-events: ${EVENT_DECODERS.length} event layouts but ` +
      `${eventDiscriminatorMap.size} distinct names: duplicate event in the IDL or RETIRED_EVENTS`,
  );
}

// ─── Length-tolerant decoding ────────────────────────────────────────────────

const ZERO_NUMBER_TYPES = new Set(["u8", "i8", "u16", "i16", "u32", "i32", "f32", "f64"]);
const ZERO_BN_TYPES = new Set(["u64", "i64", "u128", "i128", "u256", "i256"]);

/**
 * The value an event field gets when the event was logged before the field
 * existed: the type's zero (`0`, `BN(0)`, `false`, `PublicKey.default`, `""`,
 * empty vec / bytes), `null` for options and user-defined types.
 */
export function absentFieldValue(type: IdlType): unknown {
  if (typeof type === "string") {
    if (type === "bool") return false;
    if (ZERO_NUMBER_TYPES.has(type)) return 0;
    if (ZERO_BN_TYPES.has(type)) return new BN(0);
    if (type === "pubkey") return PublicKey.default;
    if (type === "string") return "";
    if (type === "bytes") return Buffer.alloc(0);
    return null;
  }
  if ("vec" in type) return [];
  if ("array" in type) {
    const [inner, len] = type.array;
    return typeof len === "number"
      ? Array.from({ length: len }, () => absentFieldValue(inner))
      : [];
  }
  return null;
}

export interface DecodedPumpEvent<E extends PumpEventName = PumpEventName> {
  name: E;
  data: PumpEventDataMap[E];
  absentFields: string[];
}

/**
 * Decode the fields of `body` (event bytes after the discriminator) in IDL
 * order. Fields past the end of `body` get `absentFieldValue`; bytes past the
 * last known field are ignored. Returns `null` when `body` ends inside a
 * field, which no program version ever logs (the bytes are corrupt).
 */
function decodeFields(
  decoder: EventDecoder,
  body: Buffer,
): { data: Record<string, unknown>; absentFields: string[] } | null {
  const data: Record<string, unknown> = {};
  const absentFields: string[] = [];
  let offset = 0;
  for (const field of decoder.fields) {
    if (offset >= body.length) {
      data[field.name] = absentFieldValue(field.type);
      absentFields.push(field.name);
      continue;
    }
    let span: number;
    try {
      span = field.layout.getSpan(body, offset);
      if (offset + span > body.length) return null;
      data[field.name] = field.layout.decode(body, offset);
    } catch (err) {
      if (err instanceof RangeError) return null;
      throw err;
    }
    offset += span;
  }
  return { data, absentFields };
}

/**
 * Decode one pump event from its raw bytes (8-byte discriminator followed by
 * the Borsh body), whatever program version logged it. Returns `null` for an
 * unknown discriminator or corrupt bytes.
 */
export function decodePumpEvent(bytes: Uint8Array): DecodedPumpEvent | null {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length < 8) return null;
  const disc = buf.subarray(0, 8);
  const decoder = EVENT_DECODERS.find((d) => d.discriminator.equals(disc));
  if (!decoder) return null;
  const decoded = decodeFields(decoder, buf.subarray(8));
  if (!decoded) return null;
  return {
    name: decoder.name,
    data: decoded.data as unknown as PumpEventDataMap[PumpEventName],
    absentFields: decoded.absentFields,
  };
}

// ─── Parser ──────────────────────────────────────────────────────────────────

const PROGRAM_DATA_PREFIX = "Program data: ";

export interface PumpEventParser {
  /**
   * Decode transaction log messages into typed pump events. Lines not
   * starting with `Program data: `, with an unknown discriminator, or with
   * corrupt bytes are skipped. Events logged by any past program version
   * decode (see the module comment on length tolerance).
   */
  parseLogs(logs: string[]): ParsedPumpEvent[];
}

export function createPumpEventParser(): PumpEventParser {
  return {
    parseLogs(logs: string[]): ParsedPumpEvent[] {
      const out: ParsedPumpEvent[] = [];
      for (const line of logs) {
        if (!line.startsWith(PROGRAM_DATA_PREFIX)) continue;
        const bytes = Buffer.from(line.slice(PROGRAM_DATA_PREFIX.length), "base64");
        const decoded = decodePumpEvent(bytes);
        if (decoded) out.push(decoded);
      }
      return out;
    },
  };
}

// ─── Subscription ────────────────────────────────────────────────────────────

export interface SubscribePumpEventsOptions {
  /** Filter events that carry a `mint` field matching this key. */
  mint?: PublicKey;
  /** Override the bonding-curve program id. */
  programId?: PublicKey;
  /** Commitment level (default: `confirmed`). */
  commitment?: Commitment;
}

export interface PumpEventSubscription {
  /** Stop listening. Idempotent: safe to call multiple times. */
  unsubscribe: () => Promise<void>;
}

/** Narrow subset of `Connection` used here; makes unit-testing easy. */
export type LogsSubscriber = Pick<Connection, "onLogs" | "removeOnLogsListener">;

/**
 * Subscribe to real-time pump bonding-curve program events via WebSocket.
 *
 * @example
 * ```ts
 * const sub = subscribeToPumpEvents(connection, { mint }, (ev) => {
 *   if (ev.name === "TradeEvent") console.log(ev.data.sol_amount.toString());
 * });
 * await sub.unsubscribe();
 * ```
 */
export function subscribeToPumpEvents(
  connection: LogsSubscriber,
  options: SubscribePumpEventsOptions,
  onEvent: (event: ParsedPumpEvent) => void,
): PumpEventSubscription {
  const programId = options.programId ?? PUMP_BONDING_CURVE_PROGRAM_ID;
  const commitment = options.commitment ?? "confirmed";
  const parser = createPumpEventParser();

  const subId = connection.onLogs(
    programId,
    (logsCb: Logs, ctx: { slot: number }) => {
      if (logsCb.err) return;
      for (const ev of parser.parseLogs(logsCb.logs)) {
        if (options.mint) {
          const m = (ev.data as { mint?: PublicKey }).mint;
          if (!(m instanceof PublicKey) || !m.equals(options.mint)) continue;
        }
        ev.signature = logsCb.signature;
        ev.slot = ctx.slot;
        onEvent(ev);
      }
    },
    commitment,
  );

  let unsubscribed = false;
  return {
    async unsubscribe() {
      if (unsubscribed) return;
      unsubscribed = true;
      const id = await Promise.resolve(subId);
      await connection.removeOnLogsListener(id);
    },
  };
}
