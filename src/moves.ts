/**
 * Semantic cut/paste ("move") extension for quill-style deltas.
 *
 * Two additional operation types express moving content without buffering it:
 *
 *     { cut:   { ref: 'r', length: 10 } }
 *     { paste: { ref: 'r', start: 0, length: 10 }, attributes: {...} }
 *
 * `cut` consumes `length` characters of its input — like a delete — and
 * remembers the removed span under `ref`.  `paste` produces `length`
 * characters starting at `start` *within that remembered span*, optionally
 * applying an attribute patch (retain semantics: `null` removes a key) on
 * top of whatever attributes the content carries.  A paste of a single embed
 * may also carry `change`, a retain-style embed patch applied to the
 * underlying payload at apply time — the embed analogue of `attributes`.
 *
 * Because a paste addresses its source by position instead of by value,
 * deltas stay base-free and closed under composition:
 *
 * - an insert into a pasted span splits the window:
 *   `paste(r, 0, 10)` -> `paste(r, 0, 2) . insert('x') . paste(r, 2, 8)`
 * - a delete inside a pasted span shrinks or splits the window,
 * - a format over a pasted span becomes the paste's attribute patch,
 * - cutting a region an earlier delta edited sends those edits along:
 *   inserts reappear literally between paste windows, formats become paste
 *   attribute patches, and deleted characters are cut but never pasted.
 *
 * Invariants (see `check`): a ref has exactly one cut; every paste window
 * fits inside its cut; windows of one ref are pairwise disjoint (move, not
 * copy); and every public cut has a paste consumer.  A zipper may
 * transiently produce an orphan cut, but normalization degrades that
 * internal fragment to a plain delete before returning it.
 *
 * All offsets and lengths count UTF-16 code units, the native JavaScript
 * string unit: astral characters (most emoji) count 2, and a boundary may
 * fall inside a surrogate pair — the lone halves re-pair into the real
 * character when pushed back together.
 *
 * Inverting keeps the semantic: each paste window inverts to a cut of the
 * pasted span, and the source position pastes everything back.
 *
 * Transform convention: concurrent edits *to moved content* (formats and
 * deletes) follow the content to its paste site; concurrent inserts *at a
 * position* inside the moved region stay at the source position.
 *
 * Cuts split when they must stay contiguous: composing a cut over a region
 * containing an earlier cut, or transforming one against a concurrent
 * insert into its source, yields parts `r`, `r:1`, ... with the paste
 * windows renumbered across them.
 *
 * Concurrent moves transform by rebasing: the priority side keeps contested
 * content and its cut re-targets the other side's paste windows (the content
 * is re-cut from wherever the loser put it); the losing side keeps only the
 * parts of its move that were never contested, while its deletions (window
 * gaps), formats (window attributes) and embed patches (window changes)
 * still apply to the content.
 *
 * Moves also cross sequence levels, recursively: a cut inside an embed's
 * child sequence (a table cell — or a cell inside a cell, to any depth)
 * may pair with a paste at root, in a sibling, or levels deeper, sharing
 * one ref namespace per delta.  Handlers that carry child sequences opt in
 * by declaring their structural `streamPaths` and forwarding the explicit
 * operation context when they recurse through `Delta`. Captures, window
 * renumbering and routed edits consequently flow between levels without
 * ambient state. Routed edits whose
 * destination window lives inside embeds are composed back in as minimal
 * embed changes nested along the destination's hop chain, following the
 * embeds if they were themselves moved.
 *
 * A paste may also ride a *newly inserted* embed's child sequence, at any
 * depth — moving existing content into a table the same delta creates.
 * The insert carries the window: compose expands it in place (splitting
 * it around earlier edits like any other window), concurrent formats and
 * deletes route into the inserted payload, and the inverse restores the
 * moved span at its source from `base` — the pasted copy simply dies
 * with the insert's inverse delete.
 *
 * Deleting an embed that still *sources* a live move is handled with a
 * trash bin, in the spirit of tree-OT deleted-subtree buffers (Davis, Sun
 * & Lu 2002) — except no buffer is needed, because a cut already *is* one:
 * captured-but-never-pasted content stays positionally addressable.  The
 * deletion becomes a trash cut of the embed, and the orphaned pastes read
 * through the capture by coordinate:
 *
 *     { paste: { ref: 'trash', unit: 0, path: ['ops'],
 *                start: 2, length: 5 } }
 *
 * i.e. characters [2, 7) of the child sequence at `path` inside the
 * embed captured at offset `unit` of cut `trash`.  Inverting restores
 * the embed whole from the base, so trash-read copies invert to deletes.
 * Transform emits the same reads when a move's winning contested content
 * sits in an embed the concurrent delta deletes, and rebases moves and
 * formats racing an existing read onto the surviving copy.  A read racing
 * a concurrent claim on its source follows the delete-beats-move rule,
 * under either priority: a concurrent cut that re-homes the unit leaves
 * the salvage standing (only the read's own trash deletes it), while one
 * that gap-drops the unit is a deletion, and the copy dies with the
 * content.  Compose, transform and invert are total up to one precise
 * refusal: the list-shaped-payload case noted below.
 *
 * Out of scope, deliberately: `diff` never emits moves (move detection is
 * a separate concern); `Delta.length()` counts a move twice (its cut and
 * its paste — use `changeLength` for the net effect); transform cannot
 * rebuild a minimal embed patch whose destination path crosses a raw JSON
 * array (`{ rows: [{ ops: ... }] }`) — arrays are handler-opaque, so the
 * core can neither rebase their indices through concurrent mutations nor
 * encode an element-addressed patch, and routed edits into such windows
 * throw.  Model ordered collections as child *sequences* instead (an
 * `ops` list of row embeds): sequence units rebase like any other
 * position, routed patches address them by retain hops, and moving a row
 * becomes an ordinary unit move.  And, as in the upstream quill algebra, a
 * delta that consumes more than its document is garbage in, garbage out.
 */
import cloneDeep = require('lodash.clonedeep');
import AttributeMap from './AttributeMap';
import Op, { CutSpec, PasteSpec } from './Op';
import OpIterator from './OpIterator';
import Delta from './Delta';

export type Payload = Record<string, unknown>; // an embed's value or embed-change patch
export type PathPart = string | number;

export interface ComposeContext {
  readonly kind: 'compose';
}

export interface TransformContext {
  readonly kind: 'transform';
}

export interface InvertContext {
  readonly kind: 'invert';
}

export interface DiffContext {
  readonly kind: 'diff';
}

export interface EmbedHandler<Value, Change = Value> {
  streamPaths?(value: Value | Change): Iterable<readonly PathPart[]>;
  apply(value: Value, change: Change, context: ComposeContext): Value;
  compose(
    first: Change,
    second: Change,
    context: ComposeContext,
  ): Change | null | undefined;
  diff(
    base: Value,
    target: Value,
    context: DiffContext,
  ): Change | null | undefined;
  invert(
    change: Change,
    base: Value,
    context: InvertContext,
  ): Change | null | undefined;
  transform(
    first: Change,
    second: Change,
    priority: boolean,
    context: TransformContext,
  ): Change | null | undefined;
}

export const handlers: {
  [embedType: string]: EmbedHandler<unknown, unknown>;
} = {};

export function registerEmbed<Value, Change = Value>(
  embedType: string,
  handler: EmbedHandler<Value, Change>,
): void {
  handlers[embedType] = handler as EmbedHandler<unknown, unknown>;
}

export function unregisterEmbed(embedType: string): void {
  delete handlers[embedType];
}

export function getHandler(embedType: string): EmbedHandler<unknown, unknown> {
  const handler = handlers[embedType];
  if (!handler) {
    throw new Error(`no handlers for embed type "${embedType}"`);
  }
  return handler;
}

export const getEmbedTypeAndData = (
  a: Op['insert'] | Op['retain'],
  b: Op['insert'] | Op['retain'],
): [string, unknown, unknown] => {
  if (typeof a !== 'object' || a === null) {
    throw new Error(`cannot retain a ${typeof a}`);
  }
  if (typeof b !== 'object' || b === null) {
    throw new Error(`cannot retain a ${typeof b}`);
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== 1 || bKeys.length !== 1) {
    throw new Error('embed values must contain exactly one type');
  }
  const embedType = aKeys[0];
  if (!embedType || embedType !== bKeys[0]) {
    throw new Error(`embed types not matched: ${embedType} != ${bKeys[0]}`);
  }
  return [embedType, a[embedType], b[embedType]];
};

// ── small utilities ──

function isObject(value: unknown): value is Payload {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstKey(value: Payload): string {
  return Object.keys(value)[0];
}

// Python-style truthiness: empty objects and arrays are falsy.
function truthy(value: unknown): boolean {
  if (value == null || value === false || value === 0 || value === '') {
    return false;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === 'object') {
    return Object.keys(value as object).length > 0;
  }
  return true;
}

function getOrSet<K, V>(map: Map<K, V>, key: K, fallback: V): V {
  let value = map.get(key);
  if (value === undefined) {
    value = fallback;
    map.set(key, value);
  }
  return value;
}

const EMPTY_SET: ReadonlySet<string> = new Set();

function pairKey(ref: string, second: number): string {
  return JSON.stringify([ref, second]);
}

function readKeyOf(
  ref: string,
  unit: number,
  path: PathPart[],
  start: number,
): string {
  return JSON.stringify([ref, unit, path, start]);
}

// ── transaction state ──
// Cross-level moves (a cut in an embed's child sequence paired with a
// paste at root, or vice versa) share one transaction per outermost call.
// Handlers that carry child sequences join it by composing/transforming/
// inverting them through the move-aware Delta, exactly like the fixtures'
// cell handler.

/**
 * One paste window of a cut: the [start, start+length) slice of the
 * captured span, with the inline patch and embed change it applies.
 *
 * `location` is where the window pastes: `['root', outPosition]` or
 * `['child', hops, prefix]` for a window inside embed payloads — one
 * `[unit, embedType, keys]` hop per nesting level.  Invert collects
 * location-less windows (it only needs the source ordering).
 */
export type Hop = [number, string, PathPart[]?];
type Location = ['root', number] | ['child', Hop[], number];

export class Window {
  constructor(
    public start: number,
    public length: number,
    public attributes: AttributeMap | undefined,
    public change: Payload | undefined,
    public location?: Location,
  ) {}
}

type TableSegment =
  | { span: number; kind: 'insert' | 'chain'; op: Op }
  | {
      span: number;
      kind: 'base';
      ref: string;
      offset: number;
      attributes?: AttributeMap;
      change?: Payload;
    };

interface TrashSite {
  ref: string;
  unit: number;
  path: PathPart[];
  offset: number;
}

interface MappingSegment {
  span: number;
  ref: string | null;
  offset: number;
  attributes: AttributeMap | undefined;
  change: Payload | undefined;
}

interface Mapping {
  segments: MappingSegment[];
  parts: number;
  current: string | null;
}

interface Read {
  unit: number;
  path: PathPart[];
  start: number;
  length: number;
  attributes?: AttributeMap;
  key?: string;
}

type Routed = Op | ['rewrite', Op];
type RoutedEntry = [number, Routed];

interface BucketGroup {
  ref: string;
  index: number;
  entries: RoutedEntry[];
}

type Marker = ['window', string, number, number] | ['read', string, number];
type OutItem = Op | Marker;

/** One compose transaction, shared by every nesting level. */
class ComposeState {
  readonly kind = 'compose' as const;
  retry = false;
  constructor(
    public tables: Map<string, TableSegment[]>, // ref -> segments its cut consumed
    public taken: Set<string>, // every ref in the transaction (part allocation)
    public cuts: Set<string>, // other's cut refs (paste-before-cut retry gate)
    public trash: Map<string, TrashSite>, // trash sites for deleted sourcing embeds
    // refs of paste destinations nested below a root operation: their
    // cuts must emit fresh part refs so the owner's recursive payload
    // expansion can never mistake generated output for an input window
    public nestedPastes: Set<string> = new Set(),
  ) {}
}

/** One transform transaction, shared by every nesting level. */
class TransformState {
  readonly kind = 'transform' as const;
  // other's refs -> how their cut sources fared
  state: Map<string, Mapping> = new Map();
  // (our ref, index) -> edits routed to a root window
  buckets: Map<string, BucketGroup> = new Map();
  // (our ref, index) -> edits routed into an embed
  overlays: Map<string, BucketGroup> = new Map();
  // read key -> edits routed into a trash-read output (owner pass only)
  readBuckets: Map<string, RoutedEntry[]> = new Map();
  constructor(
    public selfWindows: Map<string, Window[]>,
    public otherWindows: Map<string, Window[]>,
    public otherReads: Map<string, Read[]>,
    public taken: Set<string>,
  ) {}
}

/** One invert transaction, shared by every nesting level. */
class InvertState {
  readonly kind = 'invert' as const;
  constructor(
    public windows: Map<string, Window[]>,
    public inverseRefs: Map<string, string>,
  ) {}
}

export class DiffState implements DiffContext {
  readonly kind = 'diff' as const;
}

function checkedContext<State>(
  context: unknown,
  StateClass: new (...args: never[]) => State,
  operation: string,
): State | undefined {
  if (context !== undefined && !(context instanceof StateClass)) {
    throw new TypeError(`${operation} received an invalid handler context`);
  }
  return context as State | undefined;
}

export function diffContext(context?: DiffContext): DiffState {
  return checkedContext(context, DiffState, 'diff') ?? new DiffState();
}

function* childStreams(payload: Payload): Generator<[PathPart[], Op[]]> {
  const keys = Object.keys(payload);
  if (keys.length !== 1) {
    return;
  }
  const embedType = keys[0];
  const data = payload[embedType];
  const paths = handlers[embedType]?.streamPaths?.(data);
  if (paths === undefined) {
    return;
  }
  for (const declared of paths) {
    const path = [...declared];
    let value: unknown = data;
    for (const step of path) {
      if (Array.isArray(value) && typeof step === 'number') {
        value = value[step];
      } else if (isObject(value)) {
        value = value[step];
      } else {
        throw new TypeError(
          `'${embedType}' handler stream path ${JSON.stringify(path)} ` +
            `cannot traverse ${JSON.stringify(value)}`,
        );
      }
    }
    if (!Array.isArray(value)) {
      throw new TypeError(
        `'${embedType}' handler stream path ${JSON.stringify(path)} ` +
          'does not address an operation list',
      );
    }
    yield [path, value as Op[]];
  }
}

function replaced(
  value: unknown,
  path: PathPart[],
  replacement: unknown,
): unknown {
  if (!path.length) {
    return replacement;
  }
  const [step, ...rest] = path;
  if (Array.isArray(value) && typeof step === 'number') {
    const result = value.slice();
    result[step] = replaced(result[step], rest, replacement);
    return result;
  }
  if (isObject(value)) {
    return { ...value, [step]: replaced(value[step], rest, replacement) };
  }
  throw new TypeError(
    `stream path ${JSON.stringify(path)} cannot traverse value`,
  );
}

function mapStreams(
  payload: Payload,
  transform: (ops: Op[]) => Op[] | null,
): Payload | null {
  const keys = Object.keys(payload);
  if (keys.length !== 1) {
    return null;
  }
  const embedType = keys[0];
  const original = payload[embedType];
  let updated = original;
  for (const [path] of childStreams(payload)) {
    let current = updated;
    for (const step of path) {
      current = Array.isArray(current)
        ? current[step as number]
        : (current as Payload)[step];
    }
    const replacement = transform(current as Op[]);
    if (replacement !== null) {
      updated = replaced(updated, path, replacement);
    }
  }
  return updated === original ? null : { [embedType]: updated };
}

/**
 * Yield op-shaped objects carrying a cut or paste, however deeply nested
 * inside embed-change payloads.  `skipInserts` leaves out move halves
 * riding inserted payloads — content that vanishes wholesale when the
 * insert is undone.
 */
function* walkMoveOps(value: unknown, skipInserts = false): Generator<Payload> {
  if (Array.isArray(value)) {
    for (const raw of value) {
      if (!isObject(raw)) {
        continue;
      }
      if (isObject(raw.cut) || isObject(raw.paste)) {
        yield raw;
      }
      for (const carrier of ['insert', 'retain'] as const) {
        if (skipInserts && carrier === 'insert') {
          continue;
        }
        const payload = raw[carrier];
        if (isObject(payload)) {
          yield* walkMoveOps(payload, skipInserts);
        }
      }
      const paste = raw.paste;
      if (isObject(paste) && isObject(paste.change)) {
        yield* walkMoveOps(paste.change, skipInserts);
      }
    }
  } else if (isObject(value)) {
    for (const [, ops] of childStreams(value)) {
      yield* walkMoveOps(ops, skipInserts);
    }
  }
}

export function firstMoveOp(value: unknown): Payload | null {
  for (const operation of walkMoveOps(value)) {
    return operation;
  }
  return null;
}

export function hasMoves(delta: { ops: Op[] }): boolean {
  return firstMoveOp(delta.ops) !== null;
}

/**
 * Validate the move invariants of a delta, transaction-wide: cut and
 * paste halves may live at root or inside embed-change payloads.
 */
export function check<T extends { ops: Op[] }>(delta: T): T {
  const cuts = new Map<string, number>();
  const windows = new Map<string, [number, number][]>();
  const pathed = new Set<string>();
  for (const operation of walkMoveOps(delta.ops)) {
    const cut = operation.cut as CutSpec | undefined;
    if (isObject(cut)) {
      if (typeof cut.ref !== 'string') {
        throw new Error('a cut needs a string reference');
      }
      if (!Number.isInteger(cut.length) || cut.length <= 0) {
        throw new Error('a cut needs a positive integer length');
      }
      if (cuts.has(cut.ref)) {
        throw new Error(`duplicate cut reference '${cut.ref}'`);
      }
      cuts.set(cut.ref, cut.length);
    }
    const paste = operation.paste as PasteSpec | undefined;
    if (isObject(paste)) {
      if (typeof paste.ref !== 'string') {
        throw new Error('a paste needs a string reference');
      }
      if (
        !Number.isInteger(paste.start) ||
        paste.start < 0 ||
        !Number.isInteger(paste.length) ||
        paste.length <= 0
      ) {
        throw new Error(
          'a paste needs a non-negative integer start ' +
            'and a positive integer length',
        );
      }
      if (paste.change != null && paste.length !== 1) {
        throw new Error('a paste change must address one embed');
      }
      if ('path' in paste) {
        // reads through a trashed embed: no flat span
        pathed.add(paste.ref);
      } else {
        getOrSet(windows, paste.ref, []).push([paste.start, paste.length]);
      }
    }
  }
  for (const ref of pathed) {
    if (!cuts.has(ref)) {
      throw new Error(`paste '${ref}' has no cut`);
    }
  }
  for (const ref of cuts.keys()) {
    if (!windows.has(ref) && !pathed.has(ref)) {
      throw new Error(`cut '${ref}' has no paste`);
    }
  }
  for (const [ref, spans] of windows) {
    if (!cuts.has(ref)) {
      throw new Error(`paste '${ref}' has no cut`);
    }
    let position = 0;
    const sorted = spans.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (const [start, length] of sorted) {
      if (start < position) {
        throw new Error(`paste windows for '${ref}' overlap`);
      }
      position = start + length;
    }
    if (position > cuts.get(ref)!) {
      throw new Error(`paste window for '${ref}' exceeds its cut`);
    }
  }
  return delta;
}

function refsOf(ops: Op[]): Set<string> {
  const refs = new Set<string>();
  for (const operation of walkMoveOps(ops)) {
    for (const key of ['cut', 'paste']) {
      const spec = operation[key];
      if (isObject(spec) && typeof spec.ref === 'string') {
        refs.add(spec.ref as string);
      }
    }
  }
  return refs;
}

function refsOfType(ops: Op[], type: 'cut' | 'paste'): Set<string> {
  const refs = new Set<string>();
  for (const operation of walkMoveOps(ops)) {
    const spec = operation[type];
    if (isObject(spec) && typeof spec.ref === 'string') {
      refs.add(spec.ref);
    }
  }
  return refs;
}

/** Rename refs of `ops` that collide with `firstRefs`. */
function renamed(firstRefs: Set<string>, ops: Op[]): Op[] {
  const collisions = [...refsOf(ops)].filter((ref) => firstRefs.has(ref));
  if (!collisions.length) {
    return ops.slice();
  }
  const taken = new Set([...firstRefs, ...refsOf(ops)]);
  const renames = new Map<string, string>();
  for (const ref of collisions.sort()) {
    let index = 2;
    while (taken.has(`${ref}~${index}`)) {
      index += 1;
    }
    renames.set(ref, `${ref}~${index}`);
    taken.add(`${ref}~${index}`);
  }
  const result = cloneDeep(ops);
  for (const operation of walkMoveOps(result)) {
    for (const key of ['cut', 'paste']) {
      const spec = operation[key] as Payload | undefined;
      if (isObject(spec) && renames.has(spec.ref as string)) {
        spec.ref = renames.get(spec.ref as string)!;
      }
    }
  }
  return result;
}

/** Claim a ref name, decorating it until it is unused. */
function freshRef(ref: string, taken: Set<string>): string {
  while (taken.has(ref)) {
    ref += ':1';
  }
  taken.add(ref);
  return ref;
}

/** Compose two retain-style embed changes into one. */
function composeEmbedChange(
  first: Payload | undefined,
  second: Payload | undefined,
  context: ComposeState,
): Payload | undefined {
  if (first == null) {
    return second;
  }
  if (second == null) {
    return first;
  }
  const [embedType, firstData, secondData] = getEmbedTypeAndData(first, second);
  return {
    [embedType]: getHandler(embedType).compose(firstData, secondData, context),
  };
}

/** Apply a retain-style embed change to an embed insert payload. */
function applyEmbedChange(
  insert: Op['insert'],
  change: Payload | undefined,
  context: ComposeState,
): Op['insert'] {
  if (change == null) {
    return insert;
  }
  const [embedType, insertData, changeData] = getEmbedTypeAndData(
    insert,
    change,
  );
  return {
    [embedType]: getHandler(embedType).apply(insertData, changeData, context),
  };
}

function invertEmbedChange(
  change: Payload,
  baseInsert: Op['insert'],
  context: InvertState,
): Payload | undefined {
  const [embedType, changeData, baseData] = getEmbedTypeAndData(
    change,
    baseInsert,
  );
  const payload = getHandler(embedType).invert(changeData, baseData, context);
  return truthy(payload) ? { [embedType]: payload } : undefined;
}

/** Transform an embed change against a concurrently applied one. */
function transformEmbedChange(
  applied: Payload | undefined,
  other: Payload | undefined,
  priority: boolean,
  context: TransformState,
): Payload | undefined {
  if (other == null) {
    return undefined;
  }
  if (applied == null) {
    return other;
  }
  const embedType = firstKey(applied);
  if (embedType !== firstKey(other)) {
    return other;
  }
  const payload = getHandler(embedType).transform(
    applied[embedType],
    other[embedType],
    priority,
    context,
  );
  return truthy(payload) ? { [embedType]: payload } : undefined;
}

export function inputLength(operation: Op): number {
  const kind = Op.type(operation);
  return kind === 'insert' || kind === 'paste' ? 0 : Op.length(operation);
}

export function outputLength(operation: Op): number {
  const kind = Op.type(operation);
  return kind === 'delete' || kind === 'cut' ? 0 : Op.length(operation);
}

/**
 * Consume the region a later cut covers, recording what it was made of.
 *
 * Base-backed characters become the composed cut (deleted spans are
 * absorbed: they are cut but never pasted), earlier inserts and earlier
 * paste windows are remembered so the paste sites can replay them.  An
 * earlier cut inside the region passes through and splits the composed
 * cut into parts, since the base spans around it stay contiguous.
 */
function consumeCut(
  spec: CutSpec,
  selfIt: OpIterator,
  out: Op[],
  shared: ComposeState,
  nested: boolean,
): void {
  let remaining = spec.length;
  const taken = shared.taken;
  const segments: TableSegment[] = []; // over the cut-local coordinate line
  let current: Op | null = null; // cut op of the open part, extended in place
  let parts = 0;

  const openPart = (): CutSpec => {
    if (current === null) {
      parts += 1;
      let ref = spec.ref;
      if (nested || shared.nestedPastes.has(ref)) {
        // a nested destination means the owner's recursive payload
        // expansion will see the emitted pieces: fresh refs keep them
        // distinct from the capture-table key
        ref = freshRef(`${ref}:${parts}`, taken);
      } else if (parts > 1) {
        ref = freshRef(`${ref}:${parts - 1}`, taken);
      }
      current = { cut: { ref, length: 0 } };
      out.push(current);
    }
    return current.cut!;
  };

  while (remaining > 0) {
    const selfType = selfIt.peekType();
    if (selfType === 'delete') {
      openPart().length += selfIt.next().delete!;
      continue;
    }
    if (selfType === 'cut') {
      out.push(selfIt.next()); // the earlier cut passes through whole
      current = null; // and splits this cut into a new part
      continue;
    }
    const length = Math.min(remaining, selfIt.peekLength());
    const piece =
      selfIt.peek() != null ? selfIt.next(length) : { retain: length };
    const pieceType = Op.type(piece);
    if (pieceType === 'insert') {
      segments.push({ span: length, kind: 'insert', op: piece });
    } else if (pieceType === 'paste') {
      segments.push({ span: length, kind: 'chain', op: piece });
    } else {
      const change = isObject(piece.retain) ? piece.retain : undefined;
      const part = openPart();
      if (change !== undefined) {
        for (const [ref, path, innerOffset] of payloadCutSites(change)) {
          // if no window keeps this embed, its pending moves
          // re-target through the outer cut by path
          shared.trash.set(ref, {
            ref: part.ref,
            unit: part.length,
            path: path.slice(),
            offset: innerOffset,
          });
        }
      }
      segments.push({
        span: length,
        kind: 'base',
        ref: part.ref,
        offset: part.length,
        attributes: piece.attributes,
        change,
      });
      part.length += length;
    }
    remaining -= length;
  }
  shared.tables.set(spec.ref, segments);
}

/**
 * Resolve a paste that reads through a trashed embed: locate the
 * captured unit, then extract the addressed child span.
 */
function expandPathed(
  operation: Op,
  segments: TableSegment[],
  context: ComposeState,
): Op[] | null {
  const spec = operation.paste!;
  let position = 0;
  for (const segment of segments) {
    const span = segment.span;
    const offset = (spec.unit ?? 0) - position;
    if (0 <= offset && offset < span) {
      if (segment.kind === 'chain') {
        const inner = segment.op.paste!;
        const piece = cloneDeep(operation);
        piece.paste!.ref = inner.ref;
        piece.paste!.unit = inner.start + offset;
        return [piece];
      }
      if (segment.kind === 'base') {
        // symbolic, but re-targeted at the composed cut part so
        // the unit survives absorbed inserts and deletes
        const piece = cloneDeep(operation);
        piece.paste!.ref = segment.ref;
        piece.paste!.unit = segment.offset + offset;
        return [piece];
      }
      const insert = segment.op.insert;
      if (!isObject(insert)) {
        return null;
      }
      const value = navigatePayload(insert[firstKey(insert)], spec.path!);
      if (!Array.isArray(value)) {
        return null;
      }
      const pieces: Op[] = [];
      const child = new Delta(cloneDeep(value) as Op[]);
      for (const piece of child.slice(spec.start, spec.start + spec.length)
        .ops) {
        const newOp: Op = {
          insert: applyEmbedChange(piece.insert, spec.change, context),
        };
        const attributes = AttributeMap.compose(
          piece.attributes,
          operation.attributes,
          false,
        );
        if (attributes) {
          newOp.attributes = attributes;
        }
        pieces.push(newOp);
      }
      return pieces;
    }
    position += span;
  }
  return null;
}

/** Replay one paste window over the segments its cut consumed. */
function expandPaste(
  operation: Op,
  tables: Map<string, TableSegment[]>,
  context: ComposeState,
): Op[] | null {
  const spec = operation.paste!;
  if ('path' in spec) {
    return expandPathed(operation, tables.get(spec.ref)!, context);
  }
  const patch = operation.attributes;
  const ownChange = spec.change;
  const pieces: Op[] = [];
  let position = 0;
  for (const segment of tables.get(spec.ref)!) {
    const span = segment.span;
    const low = Math.max(spec.start, position);
    const high = Math.min(spec.start + spec.length, position + span);
    if (low < high) {
      const offset = low - position;
      const size = high - low;
      let piece: Op;
      let attributes: AttributeMap | undefined;
      if (segment.kind === 'base') {
        const pieceSpec: PasteSpec = {
          ref: segment.ref,
          start: segment.offset + offset,
          length: size,
        };
        const change = composeEmbedChange(segment.change, ownChange, context);
        if (change != null) {
          pieceSpec.change = change;
        }
        piece = { paste: pieceSpec };
        attributes = AttributeMap.compose(segment.attributes, patch, true);
      } else if (segment.kind === 'insert') {
        const source = segment.op;
        const insert = source.insert;
        if (typeof insert === 'string') {
          piece = { insert: insert.slice(offset, offset + size) };
        } else {
          piece = { insert: applyEmbedChange(insert, ownChange, context) };
        }
        attributes = AttributeMap.compose(source.attributes, patch, false);
      } else {
        const inner = segment.op.paste!;
        const pieceSpec: PasteSpec = {
          ...inner,
          start: inner.start + offset,
          length: size,
        };
        const change = composeEmbedChange(inner.change, ownChange, context);
        if (change != null) {
          pieceSpec.change = change;
        }
        piece = { paste: pieceSpec };
        attributes = AttributeMap.compose(segment.op.attributes, patch, true);
      }
      if (attributes) {
        piece.attributes = attributes;
      }
      pieces.push(piece);
    }
    position += span;
  }
  return pieces;
}

/**
 * Expand paste windows carried inside a freshly inserted embed's child
 * sequences against the transaction's capture tables.  Returns the
 * rewritten value, or null when nothing needed expanding.
 */
function expandedPayload(
  value: Payload,
  tables: Map<string, TableSegment[]>,
  shared: ComposeState,
): Payload | null {
  return mapStreams(value, (sequence) => {
    let changed = false;
    const merged = new Delta();
    for (const original of sequence) {
      let operation = original;
      let spec = operation.paste;
      const originalChange = spec?.change;
      if (spec !== undefined && isObject(originalChange)) {
        const change = expandedPayload(originalChange, tables, shared);
        if (change !== null) {
          operation = { ...operation, paste: { ...spec, change } };
          spec = operation.paste;
          changed = true;
        }
      }
      for (const carrier of ['insert', 'retain'] as const) {
        const payload = operation[carrier];
        if (isObject(payload)) {
          const replacement = expandedPayload(payload, tables, shared);
          if (replacement !== null) {
            operation = { ...operation, [carrier]: replacement };
            changed = true;
          }
        }
      }
      if (spec !== undefined) {
        const ref = spec.ref;
        if (tables.has(ref)) {
          for (const piece of expandPaste(operation, tables, shared)!) {
            merged.push(piece);
          }
          changed = true;
          continue;
        }
        if (shared.cuts.has(ref)) {
          shared.retry = true;
        }
      }
      merged.push(operation);
    }
    return changed ? merged.ops : null;
  });
}

/**
 * Refs of paste operations occurring below a root operation — in embed
 * payloads, child sequences, or a paste's change.
 */
function nestedPasteRefs(ops: Op[]): Set<string> {
  const refs = new Set<string>();
  for (const operation of ops) {
    if (!isObject(operation)) {
      continue;
    }
    const payloads: unknown[] = [operation.insert, operation.retain];
    const spec = operation.paste;
    if (isObject(spec)) {
      payloads.push(spec.change);
    }
    for (const payload of payloads) {
      if (!isObject(payload)) {
        continue;
      }
      for (const nested of walkMoveOps(payload)) {
        const inner = nested.paste as PasteSpec | undefined;
        if (isObject(inner) && typeof inner.ref === 'string') {
          refs.add(inner.ref);
        }
      }
    }
  }
  return refs;
}

/** Compose one retain pairing. */
function composedRetain(
  selfOp: Op,
  otherOp: Op,
  length: number,
  context: ComposeState,
): Op {
  if (Op.type(selfOp) === 'paste') {
    const spec: PasteSpec = { ...selfOp.paste! };
    if (isObject(otherOp.retain)) {
      spec.change = composeEmbedChange(spec.change, otherOp.retain, context);
    }
    const newOp: Op = { paste: spec };
    const attributes = AttributeMap.compose(
      selfOp.attributes,
      otherOp.attributes,
      true,
    );
    if (attributes) {
      newOp.attributes = attributes;
    }
    return newOp;
  }

  const newOp: Op = {};
  if (typeof selfOp.retain === 'number') {
    newOp.retain = typeof otherOp.retain === 'number' ? length : otherOp.retain;
  } else if (typeof otherOp.retain === 'number') {
    if (selfOp.retain == null) {
      newOp.insert = selfOp.insert;
    } else {
      newOp.retain = selfOp.retain;
    }
  } else {
    const action = selfOp.retain == null ? 'insert' : 'retain';
    const [embedType, selfData, otherData] = getEmbedTypeAndData(
      selfOp[action],
      otherOp.retain,
    );
    const handler = getHandler(embedType);
    newOp[action] = {
      [embedType]:
        action === 'retain'
          ? handler.compose(selfData, otherData, context)
          : handler.apply(selfData, otherData, context),
    };
  }
  const attributes = AttributeMap.compose(
    selfOp.attributes,
    otherOp.attributes,
    typeof selfOp.retain === 'number',
  );
  if (attributes) {
    newOp.attributes = attributes;
  }
  return newOp;
}

function transformedRetain(
  selfOp: Op,
  otherOp: Op,
  length: number,
  priority: boolean,
  context: TransformState,
): Op {
  const selfData = selfOp.retain;
  const otherData = otherOp.retain;
  let transformedData: Op['retain'] = isObject(otherData) ? otherData : length;
  if (isObject(selfData) && isObject(otherData)) {
    const embedType = firstKey(selfData);
    if (embedType === firstKey(otherData)) {
      const handler = getHandler(embedType);
      if (handler) {
        transformedData = {
          [embedType]: handler.transform(
            selfData[embedType],
            otherData[embedType],
            priority,
            context,
          ),
        };
      }
    }
  }
  const newOp: Op = { retain: transformedData };
  const attributes = AttributeMap.transform(
    selfOp.attributes,
    otherOp.attributes,
    priority,
  );
  if (attributes) {
    newOp.attributes = attributes;
  }
  return newOp;
}

/** Intersections of [low, high) with a ref's sorted paste windows. */
function coveredRuns(
  windows: Window[],
  low: number,
  high: number,
): [number, number, number][] {
  const runs: [number, number, number][] = [];
  windows.forEach((window, index) => {
    const runLow = Math.max(low, window.start);
    const runHigh = Math.min(high, window.start + window.length);
    if (runLow < runHigh) {
      runs.push([index, runLow, runHigh]);
    }
  });
  return runs;
}

/**
 * Transaction-wide paste windows: ref -> sorted [{start, length,
 * attributes, change, location}].  A location is coordinate-shaped:
 * `['root', output position]` for a root window, or `['child', hops,
 * prefix]` for a window inside embed changes, where each hop is
 * `[unit position, embed type, keys to the child sequence]` — one hop
 * per nesting level — and `prefix` is the paste's output offset inside
 * the innermost sequence.
 */
export function collectWindows(ops: Op[]): Map<string, Window[]> {
  const windows = new Map<string, Window[]>();
  let position = 0;
  for (const operation of ops) {
    if (Op.type(operation) === 'paste') {
      const spec = operation.paste!;
      if (!('path' in spec)) {
        // trash reads are opaque to routing
        getOrSet(windows, spec.ref, []).push(
          new Window(
            spec.start,
            spec.length,
            operation.attributes,
            spec.change,
            ['root', position],
          ),
        );
      }
      collectChangeWindows(spec, position, windows);
    } else if (isObject(operation.retain)) {
      const embedType = firstKey(operation.retain);
      collectChildWindows(operation.retain, [[position, embedType]], windows);
    } else if (isObject(operation.insert)) {
      const embedType = firstKey(operation.insert);
      collectChildWindows(operation.insert, [[position, embedType]], windows);
    }
    position += outputLength(operation);
  }
  for (const spans of windows.values()) {
    spans.sort((a, b) => a.start - b.start);
  }
  return windows;
}

/**
 * Moves may ride a paste's embed change; anchor them at the pasted
 * embed's destination.
 */
function collectChangeWindows(
  spec: PasteSpec,
  position: number,
  windows: Map<string, Window[]>,
  hops: Hop[] = [],
): void {
  const change = spec.change;
  if (isObject(change) && Object.keys(change).length) {
    const changeType = firstKey(change);
    collectChildWindows(change, [...hops, [position, changeType]], windows);
  }
}

function collectChildWindows(
  payload: Payload,
  hops: Hop[],
  windows: Map<string, Window[]>,
): void {
  for (const [path, sequence] of childStreams(payload)) {
    const [unit, embedType] = hops[hops.length - 1];
    const here: Hop[] = [...hops.slice(0, -1), [unit, embedType, path]];
    let prefix = 0;
    for (const childOp of sequence) {
      const spec = childOp.paste;
      if (spec !== undefined) {
        if (!('path' in spec)) {
          getOrSet(windows, spec.ref, []).push(
            new Window(
              spec.start,
              spec.length,
              childOp.attributes,
              spec.change,
              ['child', here, prefix],
            ),
          );
        }
        collectChangeWindows(spec, prefix, windows, here);
      } else if (isObject(childOp.retain)) {
        const innerType = firstKey(childOp.retain);
        collectChildWindows(
          childOp.retain,
          [...here, [prefix, innerType]],
          windows,
        );
      } else if (isObject(childOp.insert)) {
        const innerType = firstKey(childOp.insert);
        collectChildWindows(
          childOp.insert,
          [...here, [prefix, innerType]],
          windows,
        );
      }
      prefix += outputLength(childOp);
    }
  }
}

/**
 * The embed patch a delta applies to the unit at input `unit`: an
 * embed-change payload, or the change riding its covering paste.
 */
export function unitPatch(
  delta: Delta,
  unit: number,
  windows?: Map<string, Window[]>,
): unknown {
  if (windows === undefined) {
    windows = collectWindows(delta.ops);
  }
  let inputPosition = 0;
  for (const operation of delta.ops) {
    const length = inputLength(operation);
    if (inputPosition <= unit && unit < inputPosition + length) {
      if (isObject(operation.retain)) {
        const data = operation.retain;
        return data[firstKey(data)];
      }
      if (Op.type(operation) === 'cut') {
        const offset = unit - inputPosition;
        const ref = operation.cut!.ref;
        for (const window of windows.get(ref) ?? []) {
          if (window.start <= offset && offset < window.start + window.length) {
            for (const candidate of delta.ops) {
              if (Op.type(candidate) !== 'paste') {
                continue;
              }
              const spec = candidate.paste!;
              if (
                spec.ref === ref &&
                spec.start === window.start &&
                spec.change != null
              ) {
                const change = spec.change;
                return change[firstKey(change)];
              }
            }
            return null;
          }
        }
      }
      return null;
    }
    inputPosition += length;
  }
  return null;
}

/**
 * File a routed edit under its window.  Windows expanding in the
 * routing sequence itself (root windows, or same-sequence child moves)
 * lay out in stream; windows in other sequences become destination
 * overlays composed at the end.
 */
function deposit(
  shared: TransformState,
  ref: string,
  windows: Window[],
  index: number,
  offset: number,
  routed: Routed,
  localPastes: ReadonlySet<string> = EMPTY_SET,
): void {
  const window = windows[index];
  const inStream =
    window.location![0] === 'root' ||
    localPastes.has(pairKey(ref, window.start));
  const target = inStream ? shared.buckets : shared.overlays;
  getOrSet(target, pairKey(ref, index), {
    ref,
    index,
    entries: [],
  }).entries.push([offset, routed]);
}

/** Route a deletion of our moved content into our paste windows. */
function routeDelete(
  shared: TransformState,
  ref: string,
  windows: Window[],
  low: number,
  high: number,
  localPastes: ReadonlySet<string> = EMPTY_SET,
): void {
  for (const [index, runLow, runHigh] of coveredRuns(windows, low, high)) {
    deposit(
      shared,
      ref,
      windows,
      index,
      runLow - windows[index].start,
      { delete: runHigh - runLow },
      localPastes,
    );
  }
}

function payloadHasPastes(payload: unknown): boolean {
  for (const operation of walkMoveOps(payload)) {
    if (isObject(operation.paste)) {
      return true;
    }
  }
  return false;
}

/**
 * The other side's embed was deleted under it: its cut sources are
 * gone, so its windows renumber to nothing — except moves already
 * rebased onto a trash read of the same content.
 */
function dropOtherEmbed(
  payload: unknown,
  state: Map<string, Mapping>,
  rebased: ReadonlySet<string> = EMPTY_SET,
): void {
  for (const operation of walkMoveOps(payload)) {
    const spec = operation.cut as CutSpec | undefined;
    if (isObject(spec) && !rebased.has(spec.ref)) {
      const mapping = mappingOf(state, spec.ref);
      mapping.current = null;
      mapping.segments.push({
        span: spec.length,
        ref: null,
        offset: 0,
        attributes: undefined,
        change: undefined,
      });
    }
  }
}

/**
 * Our embed was deleted by the other side: a delete beats a move, so
 * content we moved out of it dies at our windows — except sub-ranges
 * the other side's trash reads rescue, whose moves get rebased onto the
 * surviving copies and whose read attributes still format the content.
 * (Windows *inside* the embed need no marking — their destination unit
 * maps to nothing, which the overlay pass detects.)
 */
function dropSelfEmbed(
  payload: Payload,
  shared: TransformState,
  reads: Read[] = [],
): void {
  for (const [ref, path, offset, length] of payloadCutSites(payload)) {
    const spans = shared.selfWindows.get(ref) ?? [];
    const rescued: [number, number, AttributeMap | undefined][] = [];
    for (const read of reads) {
      if (JSON.stringify(read.path) !== JSON.stringify(path)) {
        continue;
      }
      const low = Math.max(read.start, offset) - offset;
      const high = Math.min(read.start + read.length, offset + length) - offset;
      if (low < high) {
        rescued.push([low, high, read.attributes]);
      }
    }
    rescued.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    spans.forEach((span, index) => {
      const windowLow = span.start;
      const windowLength = span.length;
      let cursor = windowLow;
      for (const [rescuedLow, rescuedHigh, attributes] of rescued) {
        const low = Math.max(rescuedLow, windowLow);
        const high = Math.min(rescuedHigh, windowLow + windowLength);
        if (low < high) {
          if (low > cursor) {
            deposit(shared, ref, spans, index, cursor - windowLow, {
              delete: low - cursor,
            });
          }
          const trimmed = AttributeMap.transform(
            span.attributes,
            attributes,
            true,
          );
          if (trimmed) {
            deposit(shared, ref, spans, index, low - windowLow, {
              retain: high - low,
              attributes: trimmed,
            });
          }
          cursor = high;
        }
      }
      if (cursor < windowLow + windowLength) {
        deposit(shared, ref, spans, index, cursor - windowLow, {
          delete: windowLow + windowLength - cursor,
        });
      }
    });
  }
}

/**
 * Rebuild a minimal embed patch nesting a child ops list along the
 * JSON path where the destination sequence was found.
 */
function childPatch(path: PathPart[], sequence: unknown): Payload {
  let value: unknown = sequence;
  for (const part of path.slice().reverse()) {
    if (typeof part !== 'string') {
      throw new Error('cannot rebuild a list-indexed child sequence patch');
    }
    value = { [part]: value };
  }
  return value as Payload;
}

/**
 * Wrap innermost child ops outward through a hop chain into the
 * level-one child ops list of the outermost embed.
 */
function wrapHops(hops: Hop[], childOps: Op[]): Op[] {
  for (const [unit, embedType, keys] of hops.slice(1).reverse()) {
    const inner: Op[] = [
      { retain: { [embedType]: childPatch(keys!, childOps) } },
    ];
    childOps = unit ? [{ retain: unit }, ...inner] : inner;
  }
  return childOps;
}

/**
 * A hop chain as a trash-read path: keys with integer unit offsets
 * marking each descent into a deeper sequence.
 */
function flattenHops(hops: Hop[]): PathPart[] {
  const path: PathPart[] = hops[0][2]!.slice();
  for (const [unit, , keys] of hops.slice(1)) {
    path.push(unit);
    path.push(...keys!);
  }
  return path;
}

/**
 * Renumber paste windows inside an embed payload the transform loop
 * passed through untouched.
 */
function rewritePayload(
  value: Payload,
  state: Map<string, Mapping>,
  priority: boolean,
  context: TransformState,
): Payload | null {
  return mapStreams(value, (sequence) => {
    const rebuilt: Op[] = [];
    let changed = false;
    for (const original of sequence) {
      const spec = original.paste;
      if (spec !== undefined && state.has(spec.ref)) {
        const pieces = renumber(original, state, priority, context);
        if (pieces !== null) {
          rebuilt.push(...pieces);
          changed = true;
          continue;
        }
      }
      let operation = original;
      for (const carrier of ['retain', 'insert'] as const) {
        const payload = operation[carrier];
        if (isObject(payload)) {
          const replacement = rewritePayload(payload, state, priority, context);
          if (replacement !== null) {
            operation = { ...operation, [carrier]: replacement };
            changed = true;
          }
        }
      }
      const change = operation.paste?.change;
      if (isObject(change)) {
        const replacement = rewritePayload(change, state, priority, context);
        if (replacement !== null) {
          operation = {
            ...operation,
            paste: { ...operation.paste!, change: replacement },
          };
          changed = true;
        }
      }
      rebuilt.push(operation);
    }
    if (!changed) {
      return null;
    }
    const merged = new Delta();
    for (const operation of rebuilt) {
      merged.push(operation);
    }
    return merged.ops;
  });
}

/** Allocate the next split-part ref: r, r:1, r:2, ... */
function newPart(mapping: Mapping, ref: string, taken: Set<string>): string {
  mapping.parts += 1;
  if (mapping.parts === 1) {
    return ref;
  }
  return freshRef(`${ref}:${mapping.parts - 1}`, taken);
}

function mappingOf(state: Map<string, Mapping>, ref: string): Mapping {
  return getOrSet(state, ref, { segments: [], parts: 0, current: null });
}

/**
 * Where the input unit at `index` lives after the delta: an integer
 * root output position, `['nested', hops, offset]` when a move carried
 * it inside embed payloads, or null when it no longer exists.
 */
function unitCoordinate(
  delta: Delta,
  index: number,
): number | ['nested', Hop[], number] | null {
  let inputPosition = 0;
  for (const operation of delta.ops) {
    const kind = Op.type(operation);
    const offset = index - inputPosition;
    if (kind === 'cut' && 0 <= offset && offset < operation.cut!.length) {
      const windows = collectWindows(delta.ops);
      for (const window of windows.get(operation.cut!.ref) ?? []) {
        const start = window.start;
        const location = window.location!;
        if (start <= offset && offset < start + window.length) {
          if (location[0] === 'root') {
            return location[1] + offset - start;
          }
          const [, hops, prefix] = location;
          return ['nested', hops, prefix + offset - start];
        }
      }
      return null; // cut but never pasted
    }
    if (kind === 'delete' && 0 <= offset && offset < operation.delete!) {
      return null;
    }
    inputPosition += inputLength(operation);
  }
  return delta.transformPosition(index);
}

/**
 * Map one input *unit* through a delta: unlike a caret, a unit at a
 * window's first offset belongs to the window and follows the move.
 * Returns null when the unit no longer exists at root after the delta.
 */
export function unitPosition(delta: Delta, index: number): number | null {
  const located = unitCoordinate(delta, index);
  return typeof located === 'number' ? located : null;
}

/**
 * Output runs holding the surviving images of child input [start, end)
 * after a concurrent child patch: retained content maps across, inserts
 * strictly inside join, and content a concurrent move or delete claims
 * leaves the span.
 */
function readSpans(
  editOps: unknown[],
  start: number,
  end: number,
): [number, number][] {
  const runs: [number, number][] = [];
  let inputPosition = 0;
  let outputPosition = 0;
  for (const childOp of editOps) {
    if (!isObject(childOp)) {
      continue;
    }
    const kind = Op.type(childOp as Op);
    const opInputLength = inputLength(childOp as Op);
    const opOutputLength = outputLength(childOp as Op);
    if (kind === 'retain') {
      const low = Math.max(inputPosition, start);
      const high = Math.min(inputPosition + opInputLength, end);
      if (low < high) {
        runs.push([outputPosition + low - inputPosition, high - low]);
      }
    } else if (
      kind === 'insert' &&
      start < inputPosition &&
      inputPosition < end
    ) {
      runs.push([outputPosition, opOutputLength]);
    }
    inputPosition += opInputLength;
    outputPosition += opOutputLength;
  }
  if (inputPosition < end) {
    // the implicit tail retain
    const low = Math.max(inputPosition, start);
    runs.push([outputPosition + low - inputPosition, end - low]);
  }
  runs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const [low, length] of runs) {
    if (length <= 0) {
      continue;
    }
    if (
      merged.length &&
      merged[merged.length - 1][0] + merged[merged.length - 1][1] === low
    ) {
      merged[merged.length - 1][1] += length;
    } else {
      merged.push([low, length]);
    }
  }
  return merged;
}

/**
 * Route one concurrent child patch over trash reads of the same
 * sequence into the reads' output: formats and deletes apply to the
 * surviving copies, inserts strictly inside join them, and a concurrent
 * move whose destination survives elsewhere re-cuts its claim out of
 * the copy.  Moves confined to the dying content lose it, like the rest
 * of the trash.  Returns the refs of moves rebased onto the reads.
 */
function routeIntoReads(
  editOps: unknown[],
  reads: Read[],
  readBuckets: Map<string, RoutedEntry[]>,
  state: Map<string, Mapping>,
  taken: Set<string>,
  aliveRefs: ReadonlySet<string> = EMPTY_SET,
): Set<string> {
  reads = reads.slice().sort((a, b) => a.start - b.start);
  const rebased = new Set<string>();
  let position = 0;
  for (const childOp of editOps) {
    if (!isObject(childOp)) {
      continue;
    }
    const kind = Op.type(childOp as Op);
    if (kind === 'insert') {
      for (const read of reads) {
        if (read.start < position && position < read.start + read.length) {
          const joined: Op = { ...(childOp as Op) };
          const attributes = AttributeMap.compose(
            (childOp as Op).attributes,
            read.attributes,
            false,
          );
          delete joined.attributes;
          if (attributes) {
            joined.attributes = attributes;
          }
          readBuckets.get(read.key!)!.push([position - read.start, joined]);
        }
      }
      continue;
    }
    if (kind === 'paste') {
      continue; // its content dies with the cell or was re-cut
    }
    const length = inputLength(childOp as Op);
    if (kind === 'cut' && aliveRefs.has((childOp as Op).cut!.ref)) {
      const innerRef = (childOp as Op).cut!.ref;
      rebased.add(innerRef);
      const mapping = mappingOf(state, innerRef);
      mapping.current = null;
      let cursor = position;
      for (const read of reads) {
        const low = Math.max(position, read.start);
        const high = Math.min(position + length, read.start + read.length);
        if (low >= high) {
          continue;
        }
        if (low > cursor) {
          mapping.segments.push({
            span: low - cursor,
            ref: null,
            offset: 0,
            attributes: undefined,
            change: undefined,
          });
        }
        const part = newPart(mapping, innerRef, taken);
        readBuckets
          .get(read.key!)!
          .push([low - read.start, { cut: { ref: part, length: high - low } }]);
        mapping.segments.push({
          span: high - low,
          ref: part,
          offset: 0,
          attributes: undefined,
          change: undefined,
        });
        cursor = high;
      }
      if (cursor < position + length) {
        mapping.segments.push({
          span: position + length - cursor,
          ref: null,
          offset: 0,
          attributes: undefined,
          change: undefined,
        });
      }
    } else if (kind === 'cut') {
      // a move confined to the dying content loses it entirely
      for (const read of reads) {
        const low = Math.max(position, read.start);
        const high = Math.min(position + length, read.start + read.length);
        if (low < high) {
          readBuckets
            .get(read.key!)!
            .push([low - read.start, { delete: high - low }]);
        }
      }
    } else {
      for (const read of reads) {
        const low = Math.max(position, read.start);
        const high = Math.min(position + length, read.start + read.length);
        if (low >= high) {
          continue;
        }
        if (kind === 'delete') {
          readBuckets
            .get(read.key!)!
            .push([low - read.start, { delete: high - low }]);
        } else if (
          kind === 'retain' &&
          ((childOp as Op).attributes || isObject((childOp as Op).retain))
        ) {
          const routed: Op = isObject((childOp as Op).retain)
            ? { retain: (childOp as Op).retain }
            : { retain: high - low };
          if ((childOp as Op).attributes) {
            routed.attributes = (childOp as Op).attributes;
          }
          readBuckets.get(read.key!)!.push([low - read.start, routed]);
        }
      }
    }
    position += length;
  }
  return rebased;
}

/**
 * Unwrap a deferred routed edit, renumbering payload windows now that
 * the transaction state is complete.
 */
function routedEntry(
  routed: Routed,
  state: Map<string, Mapping>,
  priority: boolean,
  context: TransformState,
): Op {
  if (Array.isArray(routed)) {
    const rewritten = cloneDeep(routed[1]);
    if (isObject(rewritten.retain)) {
      const replacement = rewritePayload(
        rewritten.retain,
        state,
        priority,
        context,
      );
      if (replacement !== null) {
        rewritten.retain = replacement;
      }
    }
    return rewritten;
  }
  return routed;
}

/**
 * The capture holding the deleted unit at input `position` of `result`,
 * minting a trash cut out of a plain delete if needed.  Returns
 * [result, ref, unit] or null.
 */
function captureTrash(
  result: Delta,
  position: number,
): [Delta, string, number] | null {
  let inputPosition = 0;
  for (let index = 0; index < result.ops.length; index++) {
    const operation = result.ops[index];
    const length = inputLength(operation);
    if (inputPosition <= position && position < inputPosition + length) {
      const offset = position - inputPosition;
      if (Op.type(operation) === 'cut') {
        return [result, operation.cut!.ref, offset];
      }
      if (Op.type(operation) === 'delete') {
        const trashRef = freshRef('trash', refsOf(result.ops));
        const ops = result.ops.slice();
        const replacement: Op[] = [];
        if (offset) {
          replacement.push({ delete: offset });
        }
        replacement.push({ cut: { ref: trashRef, length: 1 } });
        if (length - offset - 1) {
          replacement.push({ delete: length - offset - 1 });
        }
        ops.splice(index, 1, ...replacement);
        return [new Delta(ops), trashRef, 0];
      }
      return null;
    }
    inputPosition += length;
  }
  return null;
}

/**
 * Re-target routed cut parts whose destination window died: their
 * windows read the content out of the capture that swallowed the host
 * embed.  Other routed edits die with it.
 */
function readFromTrash(
  result: Delta,
  position: number,
  path: PathPart[],
  entries: RoutedEntry[],
): Delta {
  const trashMap = new Map<string, TrashSite>();
  for (const [offset, rawRouted] of entries) {
    const routed = Array.isArray(rawRouted) ? rawRouted[1] : rawRouted;
    if (!isObject(routed.cut)) {
      continue;
    }
    const found = captureTrash(result, position);
    if (found === null) {
      throw new Error(
        'concurrent deletion of an embed that still sources ' +
          'a move is not representable',
      );
    }
    let trashRef: string;
    let unit: number;
    [result, trashRef, unit] = found;
    trashMap.set(routed.cut!.ref, {
      ref: trashRef,
      unit,
      path: path.slice(),
      offset,
    });
  }
  return trashMap.size ? retargetTrashed(result, trashMap) : result;
}

/**
 * The child ops list at `path` inside the patch the delta applies to
 * the unit at input `position` — whether the patch sits in an embed
 * change or rides the unit's covering paste.
 */
function sequenceAt(
  delta: Delta,
  position: number,
  path: PathPart[],
): unknown[] | null {
  let value = unitPatch(delta, position);
  for (const part of path) {
    if (!isObject(value) || typeof part !== 'string' || !(part in value)) {
      return null;
    }
    value = value[part];
  }
  return Array.isArray(value) ? value : null;
}

/**
 * Navigate a change payload along a trash-read path: string parts are
 * payload keys, integer parts descend through the retain covering that
 * input offset of a child patch.
 */
function navigatePatch(value: unknown, path: PathPart[]): unknown {
  for (const part of path) {
    if (typeof part === 'number') {
      if (!Array.isArray(value)) {
        return null;
      }
      let cursor = 0;
      let found: unknown = null;
      for (const childOp of value) {
        if (!isObject(childOp)) {
          return null;
        }
        const size = inputLength(childOp as Op);
        if (cursor <= part && part < cursor + size) {
          if (isObject((childOp as Op).retain)) {
            found = (childOp as Op).retain;
          }
          break;
        }
        cursor += size;
      }
      if (!isObject(found)) {
        return null;
      }
      value = found[firstKey(found)];
    } else if (isObject(value) && part in value) {
      value = value[part];
    } else {
      return null;
    }
  }
  return value;
}

/**
 * Navigate content along a trash-read path: string parts are payload
 * keys, integer parts descend into the unit at that offset of a child
 * snapshot.
 */
function navigatePayload(value: unknown, path: PathPart[]): unknown {
  for (const part of path) {
    if (typeof part === 'number') {
      if (!Array.isArray(value)) {
        return null;
      }
      let cursor = 0;
      let unit: unknown = null;
      for (const childOp of value) {
        if (!isObject(childOp)) {
          return null;
        }
        const size = outputLength(childOp as Op);
        if (cursor <= part && part < cursor + size) {
          unit = (childOp as Op).insert;
          break;
        }
        cursor += size;
      }
      if (!isObject(unit)) {
        return null;
      }
      value = unit[firstKey(unit)];
    } else if (isObject(value) && part in value) {
      value = value[part];
    } else {
      return null;
    }
  }
  return value;
}

/**
 * Compose routed edits whose destination windows live inside embed
 * payloads onto the transformed delta, as minimal embed changes.  When
 * the destination embed itself moved, the patch rides its window; when
 * the transformed delta already patches the destination sequence, the
 * overlay is rebased through that patch first.
 */
function applyOverlays(
  result: Delta,
  shared: TransformState,
  priority: boolean,
): Delta {
  const grouped = new Map<string, { hops: Hop[]; entries: RoutedEntry[] }>();
  for (const { ref, index, entries } of shared.overlays.values()) {
    const window = shared.selfWindows.get(ref)![index];
    const [, hops, prefix] = window.location as ['child', Hop[], number];
    const bucket = getOrSet(grouped, JSON.stringify(hops), {
      hops,
      entries: [],
    });
    for (const [offset, routed] of entries) {
      bucket.entries.push([prefix + offset, routed]);
    }
  }
  const items: [Hop[], Op[]][] = [];
  for (const { hops, entries } of grouped.values()) {
    const [childOps] = laidOut(entries, (routed) =>
      routedEntry(routed, shared.state, priority, shared),
    );
    items.push([hops, childOps]);
  }
  items.sort((a, b) => a[0][0][0] - b[0][0][0]);
  for (let [hops, childOps] of items) {
    const located = unitCoordinate(result, hops[0][0]);
    if (located === null) {
      // the destination embed no longer exists
      const offsets: RoutedEntry[] = [];
      let cursor = 0;
      for (const childOp of childOps) {
        offsets.push([cursor, childOp]);
        cursor += Op.length(childOp);
      }
      result = readFromTrash(result, hops[0][0], flattenHops(hops), offsets);
      continue;
    }
    let mapped: number;
    let existing: unknown[] | null;
    if (Array.isArray(located)) {
      // the destination embed itself moved inside another embed:
      // extend the chain through its new host, whose anchor op sits
      // at a root output position of the result
      const [, hostHops, offset] = located;
      hops = [...hostHops, [offset, hops[0][1], hops[0][2]], ...hops.slice(1)];
      mapped = hostHops[0][0];
      existing = null; // the host anchor is the mover's own op
    } else {
      mapped = located;
      existing = sequenceAt(result, hops[0][0], hops[0][2]!);
    }
    const [, embedType, path] = hops[0];
    childOps = wrapHops(hops, childOps);
    if (existing !== null) {
      // rebase through their own edits there
      childOps = transformTransaction(
        new Delta(cloneDeep(existing) as Op[]),
        new Delta(childOps),
        false,
      ).ops;
      if (!childOps.length) {
        continue;
      }
    }
    const overlay = new Delta().retain(mapped);
    overlay.push({
      retain: { [embedType]: childPatch(path!, childOps.slice()) },
    });
    result = composeUnchecked(result, overlay);
  }
  return result;
}

/**
 * Route the other side's edits on our cut region to its paste windows.
 *
 * Formats and deletes address the moved content and follow it; inserts
 * address a position and stay at the source.  A concurrent cut of the
 * same content is contested: with priority our move keeps it (their
 * windows shrink), without it their cut is rebased — re-targeted at our
 * paste windows, split into parts per window.
 */
function routeCut(
  spec: CutSpec,
  otherIt: OpIterator,
  shared: TransformState,
  out: OutItem[],
  priority: boolean,
  localPastes: ReadonlySet<string>,
  localReads?: Map<string, Read[]>,
  readBuckets?: Map<string, RoutedEntry[]>,
): void {
  const ref = spec.ref;
  const windows = shared.selfWindows.get(ref) ?? [];
  const state = shared.state;
  const length = spec.length;
  let offset = 0;
  while (offset < length) {
    const otherType = otherIt.peekType();
    if (otherType === 'insert' || otherType === 'paste') {
      out.push(otherIt.next()); // stays at the source position
      continue;
    }
    const pieceLength = Math.min(length - offset, otherIt.peekLength());
    const piece =
      otherIt.peek() != null
        ? otherIt.next(pieceLength)
        : { retain: pieceLength };
    const pieceType = Op.type(piece);
    const low = offset;
    const high = offset + pieceLength;
    if (pieceType === 'cut') {
      const mapping = mappingOf(state, piece.cut!.ref);
      mapping.current = null;
      if (priority) {
        // Our move wins: their claim on this run drops — but their
        // window gaps are deletions and their window attributes
        // are formats, and both still apply to the content, so
        // they land on our paste windows.  Units their trash
        // reads address survive as re-cuts the reads re-anchor to.
        const theirRef = piece.cut!.ref;
        const runStart = mapping.segments.reduce(
          (sum, segment) => sum + segment.span,
          0,
        );
        const theirs = shared.otherWindows.get(theirRef) ?? [];
        const readUnits = [
          ...new Set(
            (shared.otherReads.get(theirRef) ?? []).map((read) => read.unit),
          ),
        ].sort((a, b) => a - b);

        const killReads = (ourLow: number, ourHigh: number): void => {
          // their gap-delete follows the content into copies
          // our reads salvage: the copies die with it
          if (!localReads || !localReads.size) {
            return;
          }
          for (const read of localReads.get(ref) ?? []) {
            if (ourLow <= read.unit && read.unit < ourHigh) {
              readBuckets!.get(read.key!)!.push([0, { delete: read.length }]);
            }
          }
        };

        const dropRun = (theirLow: number, theirHigh: number): void => {
          let cursor = theirLow;
          for (const unit of readUnits) {
            if (!(theirLow <= unit && unit < theirHigh)) {
              continue;
            }
            const ourUnit = low + unit - runStart;
            if (unit > cursor) {
              mapping.segments.push({
                span: unit - cursor,
                ref: null,
                offset: 0,
                attributes: undefined,
                change: undefined,
              });
              routeDelete(
                shared,
                ref,
                windows,
                low + cursor - runStart,
                ourUnit,
                localPastes,
              );
              killReads(low + cursor - runStart, ourUnit);
            }
            const covering = coveredRuns(windows, ourUnit, ourUnit + 1);
            if (covering.length) {
              const part = newPart(mapping, theirRef, shared.taken);
              for (const [index, runLow] of covering) {
                deposit(
                  shared,
                  ref,
                  windows,
                  index,
                  runLow - windows[index].start,
                  { cut: { ref: part, length: 1 } },
                  localPastes,
                );
              }
              mapping.segments.push({
                span: 1,
                ref: part,
                offset: 0,
                attributes: undefined,
                change: undefined,
              });
            } else {
              // both sides dropped the unit and we win:
              // their read loses it with everything else
              mapping.segments.push({
                span: 1,
                ref: null,
                offset: 0,
                attributes: undefined,
                change: undefined,
              });
            }
            cursor = unit + 1;
          }
          if (cursor < theirHigh) {
            mapping.segments.push({
              span: theirHigh - cursor,
              ref: null,
              offset: 0,
              attributes: undefined,
              change: undefined,
            });
            routeDelete(
              shared,
              ref,
              windows,
              low + cursor - runStart,
              low + theirHigh - runStart,
              localPastes,
            );
            killReads(low + cursor - runStart, low + theirHigh - runStart);
          }
        };

        let position = runStart;
        for (const [theirIndex, covLow, covHigh] of coveredRuns(
          theirs,
          runStart,
          runStart + pieceLength,
        )) {
          if (covLow > position) {
            dropRun(position, covLow);
          }
          const theirWindow = theirs[theirIndex];
          if (theirWindow.attributes || theirWindow.change) {
            for (const [index, runLow, runHigh] of coveredRuns(
              windows,
              low + covLow - runStart,
              low + covHigh - runStart,
            )) {
              const attributes = AttributeMap.transform(
                windows[index].attributes,
                theirs[theirIndex].attributes,
                priority,
              );
              const change = transformEmbedChange(
                windows[index].change,
                theirs[theirIndex].change,
                priority,
                shared,
              );
              let routed: Op;
              if (change != null) {
                routed = { retain: change };
              } else if (attributes) {
                routed = { retain: runHigh - runLow };
              } else {
                continue;
              }
              if (attributes) {
                routed.attributes = attributes;
              }
              deposit(
                shared,
                ref,
                windows,
                index,
                runLow - windows[index].start,
                routed,
                localPastes,
              );
            }
          }
          mapping.segments.push({
            span: covHigh - covLow,
            ref: null,
            offset: 0,
            attributes: undefined,
            change: undefined,
          });
          position = covHigh;
        }
        if (position < runStart + pieceLength) {
          dropRun(position, runStart + pieceLength);
        }
      } else {
        // their move wins: re-cut from our paste windows
        const theirRef = piece.cut!.ref;
        const runStart = mapping.segments.reduce(
          (sum, segment) => sum + segment.span,
          0,
        );

        const lostRun = (ourLow: number, ourHigh: number): void => {
          const theirLow = runStart + ourLow - low;
          const theirHigh = runStart + ourHigh - low;
          // a read addressing units in this run dies with the
          // content: a copy out of trash never survives a
          // concurrent claim on its source
          mapping.segments.push({
            span: theirHigh - theirLow,
            ref: null,
            offset: 0,
            attributes: undefined,
            change: undefined,
          });
        };

        let position = low;
        for (const [index, runLow, runHigh] of coveredRuns(
          windows,
          low,
          high,
        )) {
          if (runLow > position) {
            lostRun(position, runLow);
          }
          const partRef = newPart(mapping, theirRef, shared.taken);
          deposit(
            shared,
            ref,
            windows,
            index,
            runLow - windows[index].start,
            { cut: { ref: partRef, length: runHigh - runLow } },
            localPastes,
          );
          mapping.segments.push({
            span: runHigh - runLow,
            ref: partRef,
            offset: 0,
            attributes: undefined,
            change: undefined,
          });
          position = runHigh;
        }
        if (position < high) {
          lostRun(position, high);
        }
        if (localReads && localReads.size) {
          // their winning claim covers units our reads salvage:
          // if their windows re-home a unit, only our own trash
          // deletes it and the salvage stands; if they gap-drop
          // it, their deletion beats the read and the copy dies
          for (const read of localReads.get(ref) ?? []) {
            if (!(low <= read.unit && read.unit < high)) {
              continue;
            }
            const theirUnit = runStart + read.unit - low;
            if (
              coveredRuns(
                shared.otherWindows.get(theirRef) ?? [],
                theirUnit,
                theirUnit + 1,
              ).length
            ) {
              continue;
            }
            readBuckets!.get(read.key!)!.push([0, { delete: read.length }]);
          }
        }
      }
    } else if (pieceType === 'delete') {
      routeDelete(shared, ref, windows, low, high, localPastes);
      if (localReads && localReads.size) {
        // deleting a trashed unit kills its reads
        for (const read of localReads.get(ref) ?? []) {
          if (low <= read.unit && read.unit < high) {
            readBuckets!.get(read.key!)!.push([0, { delete: read.length }]);
          }
        }
      }
    } else if (piece.attributes || isObject(piece.retain)) {
      let rebased: Set<string> = new Set();
      if (isObject(piece.retain) && localReads && localReads.size) {
        // trash reads of this unit route the concurrent patch of
        // their addressed content into the surviving copies; a
        // concurrent move only keeps its claim if any of its
        // windows survive outside the dying payload
        const payloadWindows = new Set<string>();
        for (const nested of walkMoveOps(piece.retain)) {
          const nestedSpec = nested.paste as PasteSpec | undefined;
          if (isObject(nestedSpec) && !('path' in nestedSpec)) {
            payloadWindows.add(
              JSON.stringify([
                nestedSpec.ref,
                nestedSpec.start,
                nestedSpec.length,
              ]),
            );
          }
        }
        const alive = new Set<string>();
        for (const nested of walkMoveOps(piece.retain)) {
          const nestedSpec = nested.cut as CutSpec | undefined;
          if (!isObject(nestedSpec)) {
            continue;
          }
          for (const window of shared.otherWindows.get(nestedSpec.ref) ?? []) {
            if (
              !payloadWindows.has(
                JSON.stringify([nestedSpec.ref, window.start, window.length]),
              )
            ) {
              alive.add(nestedSpec.ref);
            }
          }
        }
        const groups = new Map<string, { path: PathPart[]; group: Read[] }>();
        for (const read of localReads.get(ref) ?? []) {
          if (read.unit === low) {
            getOrSet(groups, JSON.stringify(read.path), {
              path: read.path,
              group: [],
            }).group.push(read);
          }
        }
        for (const { path, group } of groups.values()) {
          const data = piece.retain[firstKey(piece.retain)];
          const edited = navigatePatch(data, path.slice());
          if (Array.isArray(edited)) {
            rebased = new Set([
              ...rebased,
              ...routeIntoReads(
                edited,
                group,
                readBuckets!,
                state,
                shared.taken,
                alive,
              ),
            ]);
          }
        }
      }
      const covered = coveredRuns(windows, low, high);
      if (isObject(piece.retain) && !covered.length) {
        // the embed fell in a window gap: it is deleted, and any
        // moves it still sourced lose their content
        dropOtherEmbed(piece.retain, state, rebased);
      }
      for (const [index, runLow, runHigh] of covered) {
        const window = windows[index];
        const attributes = AttributeMap.transform(
          window.attributes,
          piece.attributes,
          priority,
        );
        let routed: Routed;
        if (isObject(piece.retain)) {
          const change = transformEmbedChange(
            window.change,
            piece.retain,
            priority,
            shared,
          );
          if (change == null && !attributes) {
            continue;
          }
          routed = { retain: change != null ? change : runHigh - runLow };
        } else {
          if (!attributes) {
            continue;
          }
          routed = { retain: runHigh - runLow };
        }
        if (attributes) {
          routed.attributes = attributes;
        }
        if (isObject(routed.retain) && payloadHasPastes(routed.retain)) {
          routed = ['rewrite', routed]; // renumber at expansion
        }
        deposit(
          shared,
          ref,
          windows,
          index,
          runLow - window.start,
          routed,
          localPastes,
        );
      }
    }
    offset += pieceLength;
  }
}

/**
 * Record one transformed slice of a cut, splitting refs when the
 * concurrent delta inserted inside the source region.
 */
function cutPiece(
  out: OutItem[],
  shared: TransformState,
  spec: CutSpec,
  deleted: boolean,
  attributes: AttributeMap | undefined,
  change?: Payload,
): void {
  const ref = spec.ref;
  const state = shared.state;
  const taken = shared.taken;
  const mapping = mappingOf(state, ref);
  if (change != null && firstMoveOp(change) !== null) {
    // our embed rides inside their cut; if their windows drop it, the
    // moves it hosts lose their content and windows — unless their
    // trash reads rescue the addressed spans
    const runStart = mapping.segments.reduce(
      (sum, segment) => sum + segment.span,
      0,
    );
    if (
      !coveredRuns(
        shared.otherWindows.get(ref) ?? [],
        runStart,
        runStart + spec.length,
      ).length
    ) {
      const reads = (shared.otherReads.get(ref) ?? []).filter(
        (read) => read.unit === runStart,
      );
      dropSelfEmbed(change, shared, reads);
    }
  }
  if (deleted) {
    mapping.segments.push({
      span: spec.length,
      ref: null,
      offset: 0,
      attributes: undefined,
      change: undefined,
    });
    return;
  }
  const last = out.length ? out[out.length - 1] : null;
  let offset: number;
  if (
    last !== null &&
    !Array.isArray(last) &&
    Op.type(last) === 'cut' &&
    last.cut!.ref === mapping.current
  ) {
    offset = last.cut!.length;
    last.cut!.length += spec.length;
  } else {
    mapping.current = newPart(mapping, ref, taken);
    offset = 0;
    out.push({ cut: { ref: mapping.current, length: spec.length } });
  }
  mapping.segments.push({
    span: spec.length,
    ref: mapping.current,
    offset,
    attributes,
    change,
  });
}

/**
 * Map one paste window through what happened to its cut source.
 * Returns null when the paste needs no rewriting.
 */
function renumber(
  operation: Op,
  state: Map<string, Mapping>,
  priority: boolean,
  context: TransformState,
): Op[] | null {
  const spec = operation.paste!;
  const mapping = state.get(spec.ref);
  if (mapping === undefined) {
    return null;
  }
  if ('path' in spec) {
    // a trash read follows its captured unit through the rows, and
    // its window through any concurrent patch of the trashed content
    const unit = spec.unit ?? 0;
    let position = 0;
    for (const { span, ref: partRef, offset, change } of mapping.segments) {
      if (position <= unit && unit < position + span) {
        if (partRef === null) {
          return []; // the capture itself was deleted
        }
        const piece = cloneDeep(operation);
        piece.paste!.ref = partRef;
        piece.paste!.unit = offset + unit - position;
        if (change != null) {
          const edited = navigatePatch(change[firstKey(change)], spec.path!);
          if (Array.isArray(edited)) {
            const pieces: Op[] = [];
            for (const [start, length] of readSpans(
              edited,
              spec.start,
              spec.start + spec.length,
            )) {
              const fragment = cloneDeep(piece);
              fragment.paste!.start = start;
              fragment.paste!.length = length;
              pieces.push(fragment);
            }
            return pieces;
          }
        }
        return [piece];
      }
      position += span;
    }
    return null; // beyond the recorded rows: untouched
  }
  const pieces: Op[] = [];
  let position = 0;
  for (const {
    span,
    ref: partRef,
    offset,
    attributes,
    change,
  } of mapping.segments) {
    const low = Math.max(spec.start, position);
    const high = Math.min(spec.start + spec.length, position + span);
    if (low < high && partRef !== null) {
      const pieceSpec: PasteSpec = {
        ref: partRef,
        start: offset + low - position,
        length: high - low,
      };
      const transformedChange = transformEmbedChange(
        change,
        spec.change,
        priority,
        context,
      );
      if (transformedChange != null) {
        pieceSpec.change = transformedChange;
      }
      const piece: Op = { paste: pieceSpec };
      const transformed = AttributeMap.transform(
        attributes,
        operation.attributes,
        priority,
      );
      if (transformed) {
        piece.attributes = transformed;
      }
      pieces.push(piece);
    }
    position += span;
  }
  return pieces;
}

/**
 * Lay routed entries over their span, sorted, with retain gaps.
 * Joined inserts consume none of the span, so the cursor advances by
 * input length.
 */
function laidOut(
  entries: RoutedEntry[],
  unwrap: (routed: Routed) => Op,
): [Op[], number] {
  const output: Op[] = [];
  let cursor = 0;
  const sorted = entries.slice().sort((a, b) => a[0] - b[0]);
  for (const [offset, rawPiece] of sorted) {
    const piece = unwrap(rawPiece);
    if (offset > cursor) {
      output.push({ retain: offset - cursor });
    }
    output.push(piece);
    cursor = offset + inputLength(piece);
  }
  return [output, cursor];
}

/**
 * Lay one paste window's routed edits over its span.  Without an
 * `unwrap`, deferred payload rewrites surface raw for a later pass.
 */
function expandWindow(
  size: number,
  entries: RoutedEntry[],
  unwrap?: (routed: Routed) => Op,
): Op[] {
  if (unwrap === undefined) {
    unwrap = (piece) => (Array.isArray(piece) ? piece[1] : piece);
  }
  const [output, cursor] = laidOut(entries, unwrap);
  if (cursor < size) {
    output.push({ retain: size - cursor });
  }
  return output;
}

/**
 * Renumber every paste — root or inside embed payloads — through what
 * happened to its cut source, once the whole transaction settled.
 * Runs over the raw item list so marker tuples pass through and can be
 * expanded afterwards, catching any edits the renumbering itself
 * routes into them.
 */
function renumberList(
  items: OutItem[],
  state: Map<string, Mapping>,
  priority: boolean,
  context: TransformState,
): OutItem[] {
  if (!state.size) {
    return items;
  }
  const result: OutItem[] = [];
  for (const item of items) {
    if (Array.isArray(item)) {
      result.push(item);
      continue;
    }
    const operation = cloneDeep(item);
    const spec = operation.paste;
    if (isObject(spec) && state.has(spec.ref)) {
      const pieces = renumber(operation, state, priority, context);
      if (pieces !== null) {
        result.push(...pieces);
        continue;
      }
    }
    if (isObject(operation.retain)) {
      const replacement = rewritePayload(
        operation.retain,
        state,
        priority,
        context,
      );
      if (replacement !== null) {
        operation.retain = replacement;
      }
    }
    if (isObject(operation.insert)) {
      const replacement = rewritePayload(
        operation.insert,
        state,
        priority,
        context,
      );
      if (replacement !== null) {
        operation.insert = replacement;
      }
    }
    result.push(operation);
  }
  return result;
}

/**
 * Expand window and read markers.  The owner passes the settled state
 * so deferred payload rewrites happen right here; children leave them
 * raw for the owner's renumbering pass to catch inside payloads.
 */
function expandMarkers(
  out: OutItem[],
  buckets: Map<string, BucketGroup>,
  readBuckets: Map<string, RoutedEntry[]>,
  state?: Map<string, Mapping>,
  priority = false,
  context?: TransformState,
): Delta {
  let unwrap: ((routed: Routed) => Op) | undefined;
  if (state !== undefined && context !== undefined) {
    unwrap = (piece) => routedEntry(piece, state, priority, context);
  }

  const expand = (item: OutItem): Op[] | null => {
    if (Array.isArray(item)) {
      if (item[0] === 'read') {
        return expandWindow(item[2], readBuckets.get(item[1]) ?? [], unwrap);
      }
      return expandWindow(
        item[3],
        buckets.get(pairKey(item[1], item[2]))?.entries ?? [],
        unwrap,
      );
    }
    return null;
  };
  return assemble(out, expand);
}

/**
 * Expand pending items and merge; orphan cuts are normalized by the
 * transaction owner once every level has settled.
 */
function assemble(
  out: OutItem[],
  expand: (item: OutItem) => Op[] | null,
): Delta {
  const expanded: Op[] = [];
  for (const item of out) {
    const pieces = expand(item);
    if (pieces === null) {
      expanded.push(item as Op);
    } else {
      expanded.push(...pieces);
    }
  }
  const delta = new Delta();
  for (const operation of expanded) {
    delta.push(operation);
  }
  return delta.chop();
}

/**
 * [ref, path, offset, length] for each cut in the child sequences of an
 * embed change whose windows live *outside* the payload: a cut only
 * ever consumes input, so its offset in the underlying content is the
 * sum of the input lengths before it.
 */
function payloadCutSites(
  retain: Payload,
): [string, PathPart[], number, number][] {
  const sites: [string, PathPart[], number, number][] = [];
  for (const [path, sequence] of childStreams(retain)) {
    let offset = 0;
    for (const child of sequence) {
      if (child.cut !== undefined) {
        sites.push([child.cut.ref, path, offset, child.cut.length]);
      }
      if (isObject(child.retain)) {
        for (const [ref, innerPath, innerOffset, length] of payloadCutSites(
          child.retain,
        )) {
          sites.push([
            ref,
            [...path, offset, ...innerPath],
            innerOffset,
            length,
          ]);
        }
      }
      offset += inputLength(child);
    }
  }
  return sites;
}

/**
 * Turn the deletion of a move-sourcing embed into a trash cut: the
 * embed is captured (never pasted whole), and the moves it sourced will
 * re-target through it by path.
 */
function trashEmbed(retain: Payload, shared: ComposeState, out: Op[]): boolean {
  const sites = payloadCutSites(retain);
  if (!sites.length) {
    return false;
  }
  const trashRef = freshRef('trash', shared.taken);
  out.push({ cut: { ref: trashRef, length: 1 } });
  for (const [ref, path, offset] of sites) {
    shared.trash.set(ref, {
      ref: trashRef,
      unit: 0,
      path: path.slice(),
      offset,
    });
  }
  return true;
}

/**
 * Rewrite pastes whose cut vanished into a trashed embed so they read
 * through the capture by path.
 */
function retargetTrashed(delta: Delta, trash: Map<string, TrashSite>): Delta {
  if (!trash.size) {
    return delta;
  }
  const cuts = new Set<string>();
  for (const operation of walkMoveOps(delta.ops)) {
    if (isObject(operation.cut)) {
      cuts.add((operation.cut as unknown as CutSpec).ref);
    }
  }
  const ops = cloneDeep(delta.ops);
  for (const operation of [...walkMoveOps(ops)]) {
    const spec = operation.paste as PasteSpec | undefined;
    if (
      isObject(spec) &&
      !cuts.has(spec.ref) &&
      trash.has(spec.ref) &&
      !('path' in spec)
    ) {
      const site = trash.get(spec.ref)!;
      spec.ref = site.ref;
      spec.unit = site.unit;
      spec.path = site.path.slice();
      spec.start = site.offset + spec.start;
    }
  }
  const result = new Delta();
  for (const operation of ops) {
    result.push(operation);
  }
  return result.chop();
}

/**
 * Reject a composed delta whose paste lost its cut — the source embed
 * of a still-referenced move was deleted along the way.
 */
function sourced(delta: Delta): Delta {
  const cuts = new Set<string>();
  for (const operation of walkMoveOps(delta.ops)) {
    if (isObject(operation.cut)) {
      cuts.add((operation.cut as unknown as CutSpec).ref);
    }
  }
  for (const operation of walkMoveOps(delta.ops)) {
    const spec = operation.paste as PasteSpec | undefined;
    if (isObject(spec) && !cuts.has(spec.ref)) {
      throw new Error(
        'cannot compose the deletion of an embed that still sources a move',
      );
    }
  }
  return delta;
}

/**
 * Degrade cuts whose ref is pasted nowhere — root or any child
 * sequence — into plain deletes.
 */
function normalizeOrphans(delta: Delta): Delta {
  const pasted = new Set<string>();
  const cutRefs = new Set<string>();
  for (const operation of walkMoveOps(delta.ops)) {
    const paste = operation.paste as PasteSpec | undefined;
    if (isObject(paste)) {
      pasted.add(paste.ref);
    }
    const cut = operation.cut as CutSpec | undefined;
    if (isObject(cut)) {
      cutRefs.add(cut.ref);
    }
  }
  if ([...cutRefs].every((ref) => pasted.has(ref))) {
    return delta;
  }
  const ops = cloneDeep(delta.ops);
  for (const operation of [...walkMoveOps(ops)]) {
    const cut = operation.cut as CutSpec | undefined;
    if (isObject(cut) && !pasted.has(cut.ref)) {
      const length = cut.length;
      for (const key of Object.keys(operation)) {
        delete operation[key];
      }
      operation.delete = length;
    }
  }
  const result = new Delta();
  for (const operation of ops) {
    result.push(operation);
  }
  return result.chop();
}

// ── the three transactions ──

export function composeDelta(
  self: Delta,
  other: Delta,
  context?: ComposeContext,
): Delta {
  const shared = checkedContext(context, ComposeState, 'compose');
  if (shared !== undefined) {
    return composeWithMoves(self, other.ops.slice(), shared, true);
  }
  return sourced(
    composeTransaction(self, renamed(refsOf(self.ops), other.ops)),
  );
}

/**
 * Compose an internally generated fragment whose move halves may
 * deliberately share refs with `self` and span the two operands.
 */
function composeUnchecked(self: Delta, other: Delta): Delta {
  return composeTransaction(self, other.ops.slice());
}

function composeTransaction(self: Delta, otherOps: Op[]): Delta {
  const refs = new Set([...refsOf(self.ops), ...refsOf(otherOps)]);
  const otherCuts = refsOfType(otherOps, 'cut');
  const nested = new Set([
    ...nestedPasteRefs(self.ops),
    ...nestedPasteRefs(otherOps),
  ]);
  let tables = new Map<string, TableSegment[]>();
  const trash = new Map<string, TrashSite>();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const shared = new ComposeState(
      tables,
      new Set(refs),
      otherCuts,
      trash,
      nested,
    );
    const result = composeWithMoves(self, otherOps, shared, false);
    if (shared.retry) {
      const resultCuts = refsOfType(result.ops, 'cut');
      const unresolved = refsOfType(result.ops, 'paste');
      shared.retry = [...unresolved].some(
        (ref) => otherCuts.has(ref) && !resultCuts.has(ref),
      );
    }
    if (!shared.retry) {
      return normalizeOrphans(retargetTrashed(result, trash));
    }
    // A child paste preceded its cut's consumption; the second pass
    // sees the transaction-wide capture tables completed by siblings.
    tables = new Map(shared.tables);
  }
  throw new Error('compose remained unresolved after retry');
}

function composeWithMoves(
  self: Delta,
  otherOps: Op[],
  shared: ComposeState,
  nested: boolean,
): Delta {
  const selfIt = new OpIterator(self.ops);
  const otherIt = new OpIterator(otherOps);
  const out: Op[] = []; // ops, with pastes from `other` still unexpanded
  const tables = shared.tables;
  while (selfIt.hasNext() || otherIt.hasNext()) {
    if (!otherIt.hasNext()) {
      // the rest of self passes through unchanged
      out.push(...selfIt.rest());
      break;
    }
    const otherType = otherIt.peekType();
    if (otherType === 'insert' || otherType === 'paste') {
      out.push(otherIt.next());
      continue;
    }
    const selfType = selfIt.peekType();
    if (selfType === 'delete' || selfType === 'cut') {
      out.push(selfIt.next());
      continue;
    }
    if (otherType === 'cut') {
      consumeCut(otherIt.next().cut!, selfIt, out, shared, nested);
      continue;
    }
    const length = Math.min(selfIt.peekLength(), otherIt.peekLength());
    const selfOp = selfIt.next(length);
    const otherOp = otherIt.next(length);
    if (otherOp.retain != null) {
      out.push(composedRetain(selfOp, otherOp, length, shared));
    } else if (
      Op.type(otherOp) === 'delete' &&
      (typeof selfOp.retain === 'number' || isObject(selfOp.retain))
    ) {
      if (isObject(selfOp.retain) && trashEmbed(selfOp.retain, shared, out)) {
        continue; // deletion of a sourcing embed became a trash cut
      }
      out.push(otherOp);
    }
  }

  const expand = (operation: OutItem): Op[] | null => {
    for (const carrier of ['insert', 'retain'] as const) {
      // newly inserted embeds and typed retain payloads may both carry
      // paste windows in their child sequences; expand them against the
      // same tables.  Windows a child handler already expanded reference
      // refs outside the tables and pass through untouched.
      const carried = isObject(operation)
        ? (operation as Op)[carrier]
        : undefined;
      if (isObject(carried)) {
        const payload = expandedPayload(carried, tables, shared);
        if (payload !== null) {
          return [{ ...(operation as Op), [carrier]: payload as Payload }];
        }
        return null;
      }
    }
    if (Op.type(operation as Op) !== 'paste') {
      return null;
    }
    let pasteOp = operation as Op;
    const spec = pasteOp.paste!;
    let rewritten: Op[] | null = null;
    if (isObject(spec.change)) {
      // a window change is a payload too: pastes riding it (a move
      // into an embed that itself moved) expand alike
      const change = expandedPayload(spec.change, tables, shared);
      if (change !== null) {
        pasteOp = { ...pasteOp, paste: { ...spec, change: change as Payload } };
        rewritten = [pasteOp];
      }
    }
    const ref = pasteOp.paste!.ref;
    if (tables.has(ref)) {
      return expandPaste(pasteOp, tables, shared);
    }
    if (shared.cuts.has(ref)) {
      shared.retry = true; // cut consumed later in the walk
    }
    return rewritten;
  };

  return assemble(out, expand);
}

export function transformDelta(
  self: Delta,
  other: Delta,
  priority: boolean,
  context?: TransformContext,
): Delta {
  const shared = checkedContext(context, TransformState, 'transform');
  if (shared !== undefined) {
    return transformWithMoves(self, other, priority, shared) as Delta;
  }
  return normalizeOrphans(transformTransaction(self, other, priority));
}

function transformTransaction(
  self: Delta,
  other: Delta,
  priority: boolean,
): Delta {
  const otherReads = new Map<string, Read[]>();
  for (const operation of other.ops) {
    if (Op.type(operation) === 'paste' && 'path' in operation.paste!) {
      const spec = operation.paste!;
      getOrSet(otherReads, spec.ref, []).push({
        unit: spec.unit ?? 0,
        path: spec.path!,
        start: spec.start,
        length: spec.length,
        attributes: operation.attributes,
      });
    }
  }
  const shared = new TransformState(
    collectWindows(self.ops),
    collectWindows(other.ops),
    otherReads,
    refsOf(other.ops),
  );
  // Marker expansion is deferred past renumbering so edits it routes
  // into windows still land.
  let out = transformWithMoves(
    self,
    other,
    priority,
    shared,
    true,
  ) as OutItem[];
  out = renumberList(out, shared.state, priority, shared);
  const result = expandMarkers(
    out,
    shared.buckets,
    shared.readBuckets,
    shared.state,
    priority,
    shared,
  );
  return applyOverlays(result, shared, priority);
}

/**
 * Transform `other` against `self` when either contains moves.
 *
 * Our moves route the other side's edits — including its cuts, which
 * get rebased onto our paste windows when they lose the contested
 * content — and the other side's moves shrink, split and renumber
 * around our edits.  Windows and rebasing state are shared across the
 * transaction so child sequences participate.  With `raw` the owner
 * receives the unexpanded item list to renumber first.
 */
function transformWithMoves(
  self: Delta,
  other: Delta,
  priority: boolean,
  shared: TransformState,
  raw = false,
): Delta | OutItem[] {
  const state = shared.state;
  const localPastes = new Set<string>();
  for (const operation of self.ops) {
    if (Op.type(operation) === 'paste') {
      localPastes.add(pairKey(operation.paste!.ref, operation.paste!.start));
    }
  }
  const windowIndex = new Map<string, number>();
  for (const [ref, spans] of shared.selfWindows) {
    spans.forEach((span, index) => {
      windowIndex.set(pairKey(ref, span.start), index);
    });
  }
  const localReads = new Map<string, Read[]>(); // our trash reads, routable like windows
  const readBuckets = new Map<string, RoutedEntry[]>();
  for (const operation of self.ops) {
    if (Op.type(operation) === 'paste' && 'path' in operation.paste!) {
      const spec = operation.paste!;
      const key = readKeyOf(spec.ref, spec.unit ?? 0, spec.path!, spec.start);
      getOrSet(localReads, spec.ref, []).push({
        unit: spec.unit ?? 0,
        path: spec.path!,
        start: spec.start,
        length: spec.length,
        attributes: operation.attributes,
        key,
      });
      readBuckets.set(key, []);
    }
  }

  const selfIt = new OpIterator(self.ops);
  const otherIt = new OpIterator(other.ops);
  const out: OutItem[] = []; // ops, window/rewrite markers, unrenumbered pastes
  while (selfIt.hasNext() || otherIt.hasNext()) {
    const selfType = selfIt.peekType();
    const otherType = otherIt.peekType();
    if (
      (selfType === 'insert' || selfType === 'paste') &&
      (priority || (otherType !== 'insert' && otherType !== 'paste'))
    ) {
      if (selfType === 'insert') {
        out.push({ retain: Op.length(selfIt.next()) });
        continue;
      }
      const spec = selfIt.next().paste!;
      if ('path' in spec) {
        // a trash read hosts routed edits too
        out.push([
          'read',
          readKeyOf(spec.ref, spec.unit ?? 0, spec.path!, spec.start),
          spec.length,
        ]);
      } else {
        out.push([
          'window',
          spec.ref,
          windowIndex.get(pairKey(spec.ref, spec.start))!,
          spec.length,
        ]);
      }
      continue;
    }
    if (otherType === 'insert' || otherType === 'paste') {
      out.push(otherIt.next());
      continue;
    }
    if (selfType === 'cut') {
      routeCut(
        selfIt.next().cut!,
        otherIt,
        shared,
        out,
        priority,
        localPastes,
        localReads,
        readBuckets,
      );
      continue;
    }
    const length = Math.min(selfIt.peekLength(), otherIt.peekLength());
    const selfOp = selfIt.next(length);
    const otherOp = otherIt.next(length);
    if (Op.type(otherOp) === 'cut') {
      cutPiece(
        out,
        shared,
        otherOp.cut!,
        Boolean(selfOp.delete),
        selfOp.attributes,
        isObject(selfOp.retain) ? selfOp.retain : undefined,
      );
    } else if (selfOp.delete) {
      if (isObject(otherOp.retain)) {
        dropOtherEmbed(otherOp.retain, state);
      }
      continue;
    } else if (otherOp.delete) {
      if (isObject(selfOp.retain)) {
        dropSelfEmbed(selfOp.retain, shared);
      }
      out.push(otherOp);
    } else {
      out.push(transformedRetain(selfOp, otherOp, length, priority, shared));
    }
  }

  if (raw) {
    shared.readBuckets = readBuckets;
    return out;
  }
  return expandMarkers(out, shared.buckets, readBuckets);
}

/**
 * Rewrite moves as plain deletes, inserts and embed changes against a
 * concrete document, at every nesting level.
 */
export function lowerDelta(self: Delta, base: Delta): Delta {
  return base.diff(base.compose(self));
}

/**
 * Invert against `base`; moves invert semantically.
 *
 * Each paste window becomes a cut of the pasted span, and the original
 * cut position pastes those spans back in source order, restoring
 * never-pasted gaps from `base` and reverting any attribute patches
 * the pastes applied.
 */
export function invertDelta(
  self: Delta,
  base: Delta,
  context?: InvertContext,
): Delta {
  let shared = checkedContext(context, InvertState, 'invert');
  if (shared === undefined) {
    const windows = new Map<string, Window[]>(); // ref -> [{start, length, attributes, change}]
    // windows riding inserted payloads vanish with the insert's
    // inverse delete, so the cut restores their spans from base
    for (const operation of walkMoveOps(self.ops, true)) {
      const spec = operation.paste as PasteSpec | undefined;
      if (isObject(spec) && !('path' in spec)) {
        getOrSet(windows, spec.ref, []).push(
          new Window(
            spec.start,
            spec.length,
            operation.attributes as AttributeMap | undefined,
            spec.change,
          ),
        );
      }
    }
    const inverseRefs = new Map<string, string>();
    const taken = new Set<string>();
    for (const ref of [...windows.keys()].sort()) {
      const spans = windows.get(ref)!;
      spans.sort((a, b) => a.start - b.start);
      spans.forEach((window, index) => {
        inverseRefs.set(
          pairKey(ref, window.start),
          freshRef(index === 0 ? ref : `${ref}:${index}`, taken),
        );
      });
    }
    shared = new InvertState(windows, inverseRefs);
  }
  return invertWithMoves(self, base, shared);
}

function invertWithMoves(self: Delta, base: Delta, shared: InvertState): Delta {
  const windows = shared.windows;
  const inverseRefs = shared.inverseRefs;
  const inverted = new Delta();
  const baseIt = new OpIterator(base.ops);
  function* readBase(length: number): Generator<Op> {
    while (length > 0 && baseIt.hasNext()) {
      const piece = baseIt.next(Math.min(length, baseIt.peekLength()));
      length -= Op.length(piece);
      yield piece;
    }
  }
  for (const operator of self.ops) {
    const kind = Op.type(operator);
    if (kind === 'insert') {
      inverted.delete(Op.length(operator));
    } else if (kind === 'paste') {
      const spec = operator.paste!;
      if ('path' in spec) {
        // content read through a trashed embed: the inverse
        // restores the embed whole, so this copy just dies
        inverted.delete(spec.length);
      } else {
        inverted.push({
          cut: {
            ref: inverseRefs.get(pairKey(spec.ref, spec.start))!,
            length: spec.length,
          },
        });
      }
    } else if (kind === 'cut') {
      const spec = operator.cut!;
      let position = 0;
      for (const window of windows.get(spec.ref) ?? []) {
        const start = window.start;
        const length = window.length;
        const attributes = window.attributes;
        const change = window.change;
        for (const baseOp of readBase(start - position)) {
          inverted.push(baseOp); // dropped gap: restore content
        }
        const inverseRef = inverseRefs.get(pairKey(spec.ref, start))!;
        let offset = 0;
        for (const baseOp of readBase(length)) {
          const pieceLength = Op.length(baseOp);
          const pieceSpec: PasteSpec = {
            ref: inverseRef,
            start: offset,
            length: pieceLength,
          };
          if (change != null) {
            const revertChange = invertEmbedChange(
              change,
              baseOp.insert,
              shared,
            );
            if (revertChange != null) {
              pieceSpec.change = revertChange;
            }
          }
          const piece: Op = { paste: pieceSpec };
          const revert = attributes
            ? AttributeMap.invert(attributes, baseOp.attributes)
            : undefined;
          if (revert && Object.keys(revert).length) {
            piece.attributes = revert;
          }
          inverted.push(piece);
          offset += pieceLength;
        }
        position = start + length;
      }
      for (const baseOp of readBase(spec.length - position)) {
        inverted.push(baseOp);
      }
    } else if (
      typeof operator.retain === 'number' &&
      operator.attributes == null
    ) {
      inverted.retain(operator.retain);
      for (const baseOp of readBase(operator.retain)) {
        void baseOp; // advance the base iterator
      }
    } else if (kind === 'delete' || typeof operator.retain === 'number') {
      const length = (operator.delete ?? operator.retain) as number;
      for (const baseOp of readBase(length)) {
        if (kind === 'delete') {
          inverted.push(baseOp);
        } else {
          inverted.retain(
            Op.length(baseOp),
            AttributeMap.invert(operator.attributes, baseOp.attributes),
          );
        }
      }
    } else if (isObject(operator.retain)) {
      const baseOp = baseIt.next(1);
      const [embedType, opData, baseOpData] = getEmbedTypeAndData(
        operator.retain,
        baseOp.insert,
      );
      const handler = getHandler(embedType);
      const payload = handler.invert(opData, baseOpData, shared);
      inverted.retain(
        { [embedType]: payload },
        AttributeMap.invert(operator.attributes, baseOp.attributes),
      );
    }
  }
  return inverted.chop();
}
