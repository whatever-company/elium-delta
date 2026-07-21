import cloneDeep = require('lodash.clonedeep');
import isEqual = require('lodash.isequal');
import AttributeMap from '../src/AttributeMap';
import Delta from '../src/Delta';
import Op from '../src/Op';
import {
  ComposeContext,
  DiffContext,
  EmbedHandler,
  InvertContext,
  TransformContext,
} from '../src/moves';

// ─────────────────────────────────────────────────────────────────────────────
// Minimal block-move kernel (test-only).
//
// The table embed handler below expresses row/column reorders as whole-block
// moves over a fixed block set, serialized as `blockDelta` ops of the form
// [{ retain: n }, { move: { count, before } }].  This is example code for the
// fixtures — the library itself stays agnostic of the shape handlers choose.
// ─────────────────────────────────────────────────────────────────────────────

interface MovePayload {
  count: number;
  before: number;
}

interface BlockRetainOp {
  retain: number;
}

interface BlockMoveOp {
  move: MovePayload;
}

export type BlockOp = BlockRetainOp | BlockMoveOp;

interface ResolvedMove {
  index: number;
  count: number;
  before: number;
}

const isMoveOp = (op: BlockOp): op is BlockMoveOp => {
  return (op as BlockMoveOp).move != null;
};

const validateBlockCount = (blockCount: number): void => {
  if (!Number.isInteger(blockCount) || blockCount < 0) {
    throw new RangeError(`invalid block count: ${blockCount}`);
  }
};

const validateMove = (op: ResolvedMove, blockCount: number): void => {
  validateBlockCount(blockCount);
  if (!Number.isInteger(op.index) || op.index < 0) {
    throw new RangeError(`invalid move index: ${op.index}`);
  }
  if (!Number.isInteger(op.count) || op.count < 0) {
    throw new RangeError(`invalid move count: ${op.count}`);
  }
  if (!Number.isInteger(op.before) || op.before < 0) {
    throw new RangeError(`invalid move destination: ${op.before}`);
  }
  if (op.index + op.count > blockCount) {
    throw new RangeError(
      `move source out of range: ${op.index} + ${op.count} > ${blockCount}`,
    );
  }
  if (op.before > blockCount) {
    throw new RangeError(
      `move destination out of range: ${op.before} > ${blockCount}`,
    );
  }
};

const toOrdinals = (blockCount: number): number[] => {
  validateBlockCount(blockCount);
  return Array.from({ length: blockCount }, (_, index) => index);
};

const findAnchorIndex = <T>(items: T[], anchor: T): number => {
  const index = items.indexOf(anchor);
  if (index < 0) {
    throw new Error('anchor not found in current block order');
  }
  return index;
};

const assertSameItems = <T>(from: T[], to: T[]): void => {
  if (from.length !== to.length) {
    throw new Error('block orders must have the same length');
  }
  const remaining = new Set(from);
  if (remaining.size !== from.length || new Set(to).size !== to.length) {
    throw new Error('block orders must contain unique items');
  }
  to.forEach((item) => {
    if (!remaining.has(item)) {
      throw new Error('block orders must contain the same items');
    }
  });
};

const resolveMove = (
  index: number,
  count: number,
  before: number,
): ResolvedMove => ({
  index,
  count,
  before,
});

const normalizeMove = (
  op: ResolvedMove,
  blockCount: number,
): ResolvedMove | null => {
  validateMove(op, blockCount);
  if (op.count === 0) {
    return null;
  }
  if (op.before >= op.index && op.before <= op.index + op.count) {
    return null;
  }
  return { index: op.index, count: op.count, before: op.before };
};

const applyMove = <T>(blocks: T[], op: ResolvedMove): T[] => {
  const normalized = normalizeMove(op, blocks.length);
  if (normalized == null) {
    return blocks.slice();
  }
  const moved = blocks.slice(
    normalized.index,
    normalized.index + normalized.count,
  );
  const remaining = blocks
    .slice(0, normalized.index)
    .concat(blocks.slice(normalized.index + normalized.count));
  const insertAt =
    normalized.before < normalized.index
      ? normalized.before
      : normalized.before - normalized.count;
  return remaining.slice(0, insertAt).concat(moved, remaining.slice(insertAt));
};

const applyMoves = <T>(blocks: T[], ops: ResolvedMove[]): T[] => {
  return ops.reduce((current, op) => applyMove(current, op), blocks.slice());
};

const nextMoveCursor = (op: ResolvedMove): number => {
  const insertAt = op.before < op.index ? op.before : op.before - op.count;
  return insertAt + op.count;
};

interface MoveIntent<T> {
  moved: T[];
  // Semantic destination anchor resolved from the pre-op block order.
  // `null` means append at the end of the current order.
  beforeBlock: T | null;
}

const resolveMoveIntent = <T>(
  base: T[],
  op: ResolvedMove,
): MoveIntent<T> | null => {
  const normalized = normalizeMove(op, base.length);
  if (normalized == null) {
    return null;
  }
  return {
    moved: base.slice(normalized.index, normalized.index + normalized.count),
    beforeBlock:
      normalized.before === base.length ? null : base[normalized.before],
  };
};

const applyMoveIntent = <T>(current: T[], intent: MoveIntent<T>): T[] => {
  const sourceSet = new Set(intent.moved);
  const remaining = current.filter((block) => !sourceSet.has(block));
  if (intent.beforeBlock == null) {
    return remaining.concat(intent.moved);
  }
  const insertAt = findAnchorIndex(remaining, intent.beforeBlock);
  return remaining
    .slice(0, insertAt)
    .concat(intent.moved, remaining.slice(insertAt));
};

// Deterministic canonicalizer:
// scan the target order from left to right and, at each mismatch, extract the
// next maximal contiguous run from the current order that matches the target.
const diffToMoves = <T>(from: T[], to: T[]): ResolvedMove[] => {
  assertSameItems(from, to);
  const working = from.slice();
  const ops: ResolvedMove[] = [];
  for (let targetIndex = 0; targetIndex < to.length; targetIndex += 1) {
    if (working[targetIndex] === to[targetIndex]) {
      continue;
    }
    const sourceIndex = working.indexOf(to[targetIndex], targetIndex);
    if (sourceIndex < 0) {
      throw new Error('target block not found in current block order');
    }
    let count = 1;
    while (
      targetIndex + count < to.length &&
      sourceIndex + count < working.length &&
      working[sourceIndex + count] === to[targetIndex + count]
    ) {
      count += 1;
    }
    const op = normalizeMove(
      resolveMove(sourceIndex, count, targetIndex),
      working.length,
    );
    if (op == null) {
      continue;
    }
    ops.push(op);
    const next = applyMove(working, op);
    working.splice(0, working.length, ...next);
  }
  return ops;
};

interface ResolvedMoveEntry<T> {
  resolved: ResolvedMove;
  intent: MoveIntent<T>;
}

const resolveBlockOps = (
  ops: BlockOp[],
  blockCount: number,
): ResolvedMoveEntry<number>[] => {
  validateBlockCount(blockCount);
  const entries: ResolvedMoveEntry<number>[] = [];
  let cursor = 0;
  let current = toOrdinals(blockCount);
  ops.forEach((op) => {
    if (isMoveOp(op)) {
      const resolved = normalizeMove(
        resolveMove(cursor, op.move.count, op.move.before),
        current.length,
      );
      if (resolved == null) {
        return;
      }
      const intent = resolveMoveIntent(current, resolved);
      if (intent == null) {
        return;
      }
      entries.push({
        resolved,
        intent,
      });
      current = applyMoveIntent(current, intent);
      cursor = nextMoveCursor(resolved);
      return;
    }
    if (!Number.isInteger(op.retain) || op.retain < 0) {
      throw new RangeError(`invalid block retain: ${op.retain}`);
    }
    cursor += op.retain;
    if (cursor > current.length) {
      throw new RangeError(
        `block cursor out of range: ${cursor} > ${current.length}`,
      );
    }
  });
  return entries;
};

const replayMoveEntries = <T>(
  current: T[],
  entries: ResolvedMoveEntry<T>[],
): T[] => {
  return entries.reduce(
    (working, entry) => applyMoveIntent(working, entry.intent),
    current.slice(),
  );
};

export class BlockDelta {
  ops: BlockOp[];

  constructor(ops?: BlockOp[] | { ops: BlockOp[] }) {
    if (Array.isArray(ops)) {
      this.ops = ops;
    } else if (ops != null && Array.isArray(ops.ops)) {
      this.ops = ops.ops;
    } else {
      this.ops = [];
    }
  }

  static fromMoves(moves: ResolvedMove[]): BlockDelta {
    const delta = new BlockDelta();
    let cursor = 0;
    moves.forEach((move) => {
      if (move.index < cursor) {
        throw new Error(
          `move sequence is not representable from the current cursor: ${move.index} < ${cursor}`,
        );
      }
      delta.retain(move.index - cursor).move(move.count, move.before);
      cursor = nextMoveCursor(move);
    });
    return delta.chop();
  }

  retain(length: number): this {
    if (length <= 0) {
      return this;
    }
    return this.push({ retain: length });
  }

  move(count: number, before: number): this {
    if (count <= 0) {
      return this;
    }
    return this.push({ move: { count, before } });
  }

  push(newOp: BlockOp): this {
    const op = cloneDeep(newOp);
    const lastOp = this.ops[this.ops.length - 1];
    if (
      lastOp != null &&
      !isMoveOp(lastOp) &&
      !isMoveOp(op) &&
      typeof lastOp.retain === 'number' &&
      typeof op.retain === 'number'
    ) {
      lastOp.retain += op.retain;
      return this;
    }
    this.ops.push(op);
    return this;
  }

  chop(): this {
    const lastOp = this.ops[this.ops.length - 1];
    if (lastOp != null && !isMoveOp(lastOp) && lastOp.retain > 0) {
      this.ops.pop();
    }
    return this;
  }

  resolve(blockCount: number): ResolvedMove[] {
    return resolveBlockOps(this.ops, blockCount).map((entry) => entry.resolved);
  }

  apply<T>(blocks: T[]): T[] {
    return applyMoves(blocks, this.resolve(blocks.length));
  }

  transform(
    other: BlockDelta,
    blockCount: number,
    priority = false,
  ): BlockDelta {
    const base = toOrdinals(blockCount);
    const thisApplied = this.apply(base);
    const otherApplied = other.apply(base);
    const thisEntries = resolveBlockOps(this.ops, blockCount);
    const otherEntries = resolveBlockOps(other.ops, blockCount);
    const final = priority
      ? replayMoveEntries(thisApplied, otherEntries)
      : replayMoveEntries(otherApplied, thisEntries);
    return BlockDelta.fromMoves(diffToMoves(thisApplied, final));
  }
}

// A change pairs an inline delta with whole-block moves.  The delta applies
// first; block moves address the post-delta block order.
export interface Change {
  delta: Delta;
  blockDelta: BlockDelta;
}

// Split a canonical document (every line newline-terminated) into one Delta
// per line, each keeping its newline and line attributes.
const splitLineBlocks = (document: Delta, newline = '\n'): Delta[] => {
  const blocks: Delta[] = [];
  document.eachLine((line, attributes) => {
    const block = new Delta(cloneDeep(line.ops));
    block.insert(
      newline,
      Object.keys(attributes).length > 0 ? attributes : undefined,
    );
    blocks.push(block);
  }, newline);
  return blocks;
};

export const applyChange = (
  document: Delta,
  change: Change,
  newline = '\n',
  context?: ComposeContext,
): Delta => {
  const afterDelta = document.compose(change.delta, context);
  if (change.blockDelta.ops.length === 0) {
    return afterDelta;
  }
  return change.blockDelta
    .apply(splitLineBlocks(afterDelta, newline))
    .reduce((doc, block) => doc.concat(block), new Delta());
};

export const transformChange = (
  left: Change,
  right: Change,
  document: Delta,
  priority = false,
  newline = '\n',
  context?: TransformContext,
): Change => {
  if (left.blockDelta.ops.length === 0 && right.blockDelta.ops.length === 0) {
    return {
      delta: left.delta.transform(right.delta, priority, context),
      blockDelta: new BlockDelta(),
    };
  }
  if (left.delta.ops.length === 0 && right.delta.ops.length === 0) {
    return {
      delta: new Delta(),
      blockDelta: left.blockDelta.transform(
        right.blockDelta,
        splitLineBlocks(document, newline).length,
        priority,
      ),
    };
  }
  throw new Error(
    'transformChange: mixed delta/blockDelta transforms are not supported by the test kernel',
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Table embed handler.
// ─────────────────────────────────────────────────────────────────────────────

type CellData = {
  content?: Delta['ops'];
  attributes?: Record<string, unknown>;
};

type TableRowColumnOp = Omit<Op, 'insert'> & {
  insert?: { id: string };
};

export type TableData = {
  rows?: TableRowColumnOp[];
  columns?: TableRowColumnOp[];
  cells?: Record<string, CellData>;
};

type ChangeSpec = {
  delta?: Op[];
  blockDelta?: BlockOp[];
};

type TableCellPatch = {
  change?: ChangeSpec;
  attributes?: Record<string, unknown>;
};

type TablePatch = {
  base: TableData;
  rows?: ChangeSpec;
  columns?: ChangeSpec;
  cells?: Record<string, TableCellPatch>;
};

type TableEmbedValue = TableData | TablePatch;

type TableAxisItem = {
  id: string;
  op: TableRowColumnOp;
};

const EMPTY_TABLE_LINE = '\n';

const isTablePatch = (value: TableEmbedValue): value is TablePatch => {
  return typeof value === 'object' && value !== null && 'base' in value;
};

const cloneTableData = (value: TableData): TableData =>
  JSON.parse(JSON.stringify(value));

const parseCellIdentity = (identity: string): [string, string] => {
  const separator = identity.indexOf(':');
  if (separator < 0) {
    throw new Error(`invalid table cell identity: ${identity}`);
  }
  return [identity.slice(0, separator), identity.slice(separator + 1)];
};

const axisItemsFromOps = (ops: TableRowColumnOp[]): TableAxisItem[] =>
  ops
    .filter((op): op is TableRowColumnOp & { insert: { id: string } } => {
      return op.insert != null && typeof op.insert === 'object';
    })
    .map((op) => ({
      id: op.insert!.id,
      op,
    }));

const axisDocFromOps = (ops: TableRowColumnOp[] = []): Delta => {
  const items = axisItemsFromOps(ops);
  if (items.length === 0) {
    return new Delta().insert(EMPTY_TABLE_LINE);
  }
  const doc = new Delta();
  items.forEach((item) => {
    doc.insert(item.id);
    doc.insert(
      EMPTY_TABLE_LINE,
      item.op.attributes as AttributeMap | undefined,
    );
  });
  return doc;
};

const axisOpsFromDoc = (doc: Delta): TableRowColumnOp[] => {
  const ops: TableRowColumnOp[] = [];
  doc.eachLine((line, attributes) => {
    const id = line.ops
      .map((op) => (typeof op.insert === 'string' ? op.insert : ''))
      .join('');
    if (id.length === 0) {
      return;
    }
    const op: TableRowColumnOp = {
      insert: { id },
    };
    if (attributes && Object.keys(attributes).length > 0) {
      op.attributes = attributes;
    }
    ops.push(op);
  });
  return ops;
};

const canonicalCellDoc = (ops: Delta['ops'] = []): Delta => {
  const doc = new Delta(cloneDeep(ops));
  const last = doc.ops[doc.ops.length - 1];
  if (
    last == null ||
    typeof last.insert !== 'string' ||
    !last.insert.endsWith(EMPTY_TABLE_LINE)
  ) {
    doc.insert(EMPTY_TABLE_LINE);
  }
  return doc;
};

const cellDocToOps = (doc: Delta): Delta['ops'] => {
  if (doc.length() === 0) {
    return [];
  }
  return doc.slice(0, Math.max(0, doc.length() - 1)).ops;
};

const compactCellData = ({
  content,
  attributes,
}: {
  content: Delta;
  attributes: AttributeMap | undefined;
}): CellData | null => {
  const data: CellData = {};
  const ops = cellDocToOps(content);
  if (ops.length > 0) {
    data.content = ops;
  }
  if (attributes && Object.keys(attributes).length > 0) {
    data.attributes = attributes;
  }
  return Object.keys(data).length > 0 ? data : null;
};

const compactTableData = ({
  rows,
  columns,
  cells,
}: {
  rows: TableRowColumnOp[];
  columns: TableRowColumnOp[];
  cells: Record<string, CellData>;
}): TableData => {
  const data: TableData = {};
  if (rows.length > 0) {
    data.rows = rows;
  }
  if (columns.length > 0) {
    data.columns = columns;
  }
  if (Object.keys(cells).length > 0) {
    data.cells = cells;
  }
  return data;
};

const changeFromSpec = (spec?: ChangeSpec): Change => ({
  delta: new Delta(cloneDeep(spec?.delta || [])),
  blockDelta: new BlockDelta(cloneDeep(spec?.blockDelta || [])),
});

const changeSpecFromChange = (change: Change): ChangeSpec | undefined => {
  if (change.delta.ops.length === 0 && change.blockDelta.ops.length === 0) {
    return undefined;
  }
  const spec: ChangeSpec = {};
  if (change.delta.ops.length > 0) {
    spec.delta = change.delta.ops;
  }
  if (change.blockDelta.ops.length > 0) {
    spec.blockDelta = change.blockDelta.ops;
  }
  return spec;
};

const applyAxisChange = (
  baseOps: TableRowColumnOp[],
  spec?: ChangeSpec,
  context?: ComposeContext,
): TableRowColumnOp[] => {
  if (!spec) {
    return axisItemsFromOps(baseOps).map(({ op }) => ({ ...op }));
  }
  const doc = applyChange(
    axisDocFromOps(baseOps),
    changeFromSpec(spec),
    '\n',
    context,
  );
  return axisOpsFromDoc(doc);
};

const applyCellPatch = (
  baseCell: CellData | undefined,
  patch: TableCellPatch | undefined,
  context?: ComposeContext,
): CellData | null => {
  const content = patch?.change
    ? applyChange(
        canonicalCellDoc(baseCell?.content || []),
        changeFromSpec(patch.change),
        '\n',
        context,
      )
    : canonicalCellDoc(baseCell?.content || []);
  const attributes = AttributeMap.compose(
    baseCell?.attributes as AttributeMap | undefined,
    patch?.attributes as AttributeMap | undefined,
    false,
  );
  return compactCellData({ content, attributes });
};

const diffCellPatch = (
  baseCell: CellData | undefined,
  targetCell: CellData | undefined,
  context?: DiffContext,
): TableCellPatch | null => {
  const contentChange = changeSpecFromChange({
    delta: canonicalCellDoc(baseCell?.content || []).diff(
      canonicalCellDoc(targetCell?.content || []),
      undefined,
      context,
    ),
    blockDelta: new BlockDelta(),
  });
  const attributes = AttributeMap.diff(
    baseCell?.attributes as AttributeMap | undefined,
    targetCell?.attributes as AttributeMap | undefined,
  );
  if (!contentChange && !attributes) {
    return null;
  }
  const patch: TableCellPatch = {};
  if (contentChange) {
    patch.change = contentChange;
  }
  if (attributes && Object.keys(attributes).length > 0) {
    patch.attributes = attributes;
  }
  return patch;
};

const hasUniqueAxisIds = (ops: TableRowColumnOp[]): boolean => {
  const ids = axisItemsFromOps(ops).map((item) => item.id);
  return new Set(ids).size === ids.length;
};

const sameAxisShape = (
  baseOps: TableRowColumnOp[],
  targetOps: TableRowColumnOp[],
): boolean => {
  const base = axisItemsFromOps(baseOps);
  const target = axisItemsFromOps(targetOps);
  if (base.length !== target.length) {
    return false;
  }
  const baseIds = base.map((item) => item.id);
  const targetIds = target.map((item) => item.id);
  if (
    new Set(baseIds).size !== baseIds.length ||
    new Set(targetIds).size !== targetIds.length
  ) {
    return false;
  }
  if (
    baseIds.slice().sort().join('\u0000') !==
    targetIds.slice().sort().join('\u0000')
  ) {
    return false;
  }
  const targetById = new Map(target.map((item) => [item.id, item.op]));
  return base.every((item) => {
    return isEqual(
      item.op.attributes || undefined,
      targetById.get(item.id)?.attributes,
    );
  });
};

const buildPostDeltaAxisOps = (
  baseOps: TableRowColumnOp[],
  targetOps: TableRowColumnOp[],
): TableRowColumnOp[] | null => {
  if (!hasUniqueAxisIds(baseOps) || !hasUniqueAxisIds(targetOps)) {
    return null;
  }
  const base = axisItemsFromOps(baseOps);
  const target = axisItemsFromOps(targetOps);
  const targetById = new Map(target.map((item) => [item.id, item.op]));
  const sharedIds = new Set(
    base.map((item) => item.id).filter((id) => targetById.has(id)),
  );
  const insertedBefore = new Map<string | null, TableRowColumnOp[]>();
  let pendingInserted: TableRowColumnOp[] = [];

  target.forEach((item) => {
    if (sharedIds.has(item.id)) {
      insertedBefore.set(
        item.id,
        (insertedBefore.get(item.id) || []).concat(pendingInserted),
      );
      pendingInserted = [];
      return;
    }
    pendingInserted.push(item.op);
  });
  insertedBefore.set(null, pendingInserted);

  const postDelta: TableRowColumnOp[] = [];
  base.forEach((item) => {
    if (!sharedIds.has(item.id)) {
      return;
    }
    postDelta.push(...(insertedBefore.get(item.id) || []));
    postDelta.push(targetById.get(item.id)!);
  });
  postDelta.push(...(insertedBefore.get(null) || []));
  return postDelta;
};

const diffAxisChange = (
  baseOps: TableRowColumnOp[],
  targetOps: TableRowColumnOp[],
  context?: DiffContext,
): ChangeSpec | undefined => {
  const base = axisItemsFromOps(baseOps);
  const target = axisItemsFromOps(targetOps);
  if (sameAxisShape(baseOps, targetOps)) {
    const moves = diffToMoves(
      base.map((item) => item.id),
      target.map((item) => item.id),
    );
    return changeSpecFromChange({
      delta: new Delta(),
      blockDelta: BlockDelta.fromMoves(moves),
    });
  }
  const postDeltaOps = buildPostDeltaAxisOps(baseOps, targetOps);
  if (postDeltaOps) {
    return changeSpecFromChange({
      delta: axisDocFromOps(baseOps).diff(
        axisDocFromOps(postDeltaOps),
        undefined,
        context,
      ),
      blockDelta: BlockDelta.fromMoves(
        diffToMoves(
          axisItemsFromOps(postDeltaOps).map((item) => item.id),
          target.map((item) => item.id),
        ),
      ),
    });
  }
  return changeSpecFromChange({
    delta: axisDocFromOps(baseOps).diff(
      axisDocFromOps(targetOps),
      undefined,
      context,
    ),
    blockDelta: new BlockDelta(),
  });
};

const filterCellsByAxes = (
  cells: Record<string, CellData>,
  rows: TableRowColumnOp[],
  columns: TableRowColumnOp[],
): Record<string, CellData> => {
  const rowIds = new Set(axisItemsFromOps(rows).map((item) => item.id));
  const columnIds = new Set(axisItemsFromOps(columns).map((item) => item.id));
  const filtered: Record<string, CellData> = {};
  Object.entries(cells).forEach(([identity, cell]) => {
    const [rowId, columnId] = parseCellIdentity(identity);
    if (rowIds.has(rowId) && columnIds.has(columnId)) {
      filtered[identity] = cell;
    }
  });
  return filtered;
};

const compactTablePatch = (patch: TablePatch): TablePatch => {
  const compact: TablePatch = { base: cloneTableData(patch.base) };
  if (patch.rows) {
    compact.rows = patch.rows;
  }
  if (patch.columns) {
    compact.columns = patch.columns;
  }
  if (patch.cells && Object.keys(patch.cells).length > 0) {
    compact.cells = patch.cells;
  }
  return compact;
};

const applyTablePatch = (
  base: TableData,
  patch: TablePatch,
  context?: ComposeContext,
): TableData => {
  const rows = applyAxisChange(base.rows || [], patch.rows, context);
  const columns = applyAxisChange(base.columns || [], patch.columns, context);
  const cells = filterCellsByAxes({ ...(base.cells || {}) }, rows, columns);
  Object.entries(patch.cells || {}).forEach(([identity, cellPatch]) => {
    const [rowId, columnId] = parseCellIdentity(identity);
    const validRows = new Set(axisItemsFromOps(rows).map((item) => item.id));
    const validColumns = new Set(
      axisItemsFromOps(columns).map((item) => item.id),
    );
    if (!validRows.has(rowId) || !validColumns.has(columnId)) {
      delete cells[identity];
      return;
    }
    const cell = applyCellPatch(
      (base.cells || {})[identity],
      cellPatch,
      context,
    );
    if (cell) {
      cells[identity] = cell;
    } else {
      delete cells[identity];
    }
  });
  return compactTableData({ rows, columns, cells });
};

const diffTable = (
  base: TableData,
  target: TableData,
  context?: DiffContext,
): TablePatch => {
  const rows = diffAxisChange(base.rows || [], target.rows || [], context);
  const columns = diffAxisChange(
    base.columns || [],
    target.columns || [],
    context,
  );
  const cells: Record<string, TableCellPatch> = {};
  const identities = new Set([
    ...Object.keys(base.cells || {}),
    ...Object.keys(target.cells || {}),
  ]);
  identities.forEach((identity) => {
    const patch = diffCellPatch(
      (base.cells || {})[identity],
      (target.cells || {})[identity],
      context,
    );
    if (patch) {
      cells[identity] = patch;
    }
  });
  return compactTablePatch({
    base,
    rows,
    columns,
    cells,
  });
};

const transformNestedChange = (
  left: ChangeSpec | undefined,
  right: ChangeSpec | undefined,
  document: Delta,
  priority: boolean,
  context: TransformContext,
): ChangeSpec | undefined => {
  if (!right) {
    return undefined;
  }
  if (!left) {
    return right;
  }
  return changeSpecFromChange(
    transformChange(
      changeFromSpec(left),
      changeFromSpec(right),
      document,
      priority,
      '\n',
      context,
    ),
  );
};

const transformCellAttributes = (
  left: Record<string, unknown> | undefined,
  right: Record<string, unknown> | undefined,
  priority: boolean,
): Record<string, unknown> | undefined => {
  return AttributeMap.transform(
    left as AttributeMap | undefined,
    right as AttributeMap | undefined,
    priority,
  ) as Record<string, unknown> | undefined;
};

const composeTablePatch = (
  left: TablePatch,
  right: TablePatch,
  context: ComposeContext,
): TablePatch => {
  const base = cloneTableData(left.base);
  const middle = applyTablePatch(base, left, context);
  const final = applyTablePatch(middle, right, context);
  return diffTable(base, final);
};

const transformTablePatch = (
  applied: TablePatch,
  other: TablePatch,
  priority: boolean,
  context: TransformContext,
): TablePatch => {
  const base = cloneTableData(applied.base);
  const baseAfterApplied = applyTablePatch(base, applied);

  const rowsPrime = transformNestedChange(
    applied.rows,
    other.rows,
    axisDocFromOps(base.rows || []),
    priority,
    context,
  );
  const columnsPrime = transformNestedChange(
    applied.columns,
    other.columns,
    axisDocFromOps(base.columns || []),
    priority,
    context,
  );
  const cells: Record<string, TableCellPatch> = {};
  const identities = new Set([
    ...Object.keys(base.cells || {}),
    ...Object.keys(applied.cells || {}),
    ...Object.keys(other.cells || {}),
  ]);

  identities.forEach((identity) => {
    const baseCell = (base.cells || {})[identity];
    const appliedPatch = (applied.cells || {})[identity];
    const otherPatch = (other.cells || {})[identity];
    const change = transformNestedChange(
      appliedPatch?.change,
      otherPatch?.change,
      canonicalCellDoc(baseCell?.content || []),
      priority,
      context,
    );
    const attributes = transformCellAttributes(
      appliedPatch?.attributes,
      otherPatch?.attributes,
      priority,
    );
    if (change || (attributes && Object.keys(attributes).length > 0)) {
      cells[identity] = {};
      if (change) {
        cells[identity].change = change;
      }
      if (attributes && Object.keys(attributes).length > 0) {
        cells[identity].attributes = attributes;
      }
    }
  });

  const final = applyTablePatch(
    baseAfterApplied,
    compactTablePatch({
      base: baseAfterApplied,
      rows: rowsPrime,
      columns: columnsPrime,
      cells,
    }),
  );
  return diffTable(baseAfterApplied, final);
};

const invertTablePatch = (
  change: TablePatch,
  base: TableData,
  _context: InvertContext,
): TablePatch => {
  const final = applyTablePatch(base, change);
  return diffTable(final, base);
};

const tableStreamPaths = function* (
  value: TableEmbedValue,
): Generator<readonly (string | number)[]> {
  for (const axis of ['rows', 'columns'] as const) {
    const spec = value[axis];
    if (Array.isArray(spec)) {
      yield [axis];
    } else if (spec && Array.isArray(spec.delta)) {
      yield [axis, 'delta'];
    }
  }
  for (const [identity, cell] of Object.entries(value.cells || {})) {
    if ('content' in cell && Array.isArray(cell.content)) {
      yield ['cells', identity, 'content'];
    }
    if ('change' in cell && cell.change && Array.isArray(cell.change.delta)) {
      yield ['cells', identity, 'change', 'delta'];
    }
  }
};

const tableHandler: EmbedHandler<TableData, TablePatch> = {
  streamPaths: tableStreamPaths,

  apply(value, change, context): TableData {
    if (isTablePatch(value) || !isTablePatch(change)) {
      throw new Error('table-embed apply expects a patch over a table value');
    }
    return applyTablePatch(value, change, context);
  },

  compose(a, b, context): TablePatch {
    if (!isTablePatch(a) || !isTablePatch(b)) {
      throw new Error('table-embed compose expects two table patches');
    }
    return composeTablePatch(a, b, context);
  },

  diff(a, b, context): TablePatch {
    return diffTable(a, b, context);
  },

  transform(a, b, priority, context): TablePatch {
    if (!isTablePatch(a) || !isTablePatch(b)) {
      throw new Error(
        'table-embed transform expects self-contained table patches',
      );
    }
    return transformTablePatch(a, b, priority, context);
  },

  invert(change, base, context): TablePatch {
    if (!isTablePatch(change) || isTablePatch(base)) {
      throw new Error(
        'table-embed invert expects change patch over a table document',
      );
    }
    return invertTablePatch(change, base, context);
  },
};

export const registerDeltaEmbed = (): void => {
  Delta.registerEmbed<Op[]>('delta', {
    streamPaths: () => [[]],
    apply: (a, b, context) => new Delta(a).compose(new Delta(b), context).ops,
    compose: (a, b, context) => new Delta(a).compose(new Delta(b), context).ops,
    diff: (a, b, context) =>
      new Delta(a).diff(new Delta(b), undefined, context).ops,
    transform: (a, b, priority, context) =>
      new Delta(a).transform(new Delta(b), priority, context).ops,
    invert: (a, b, context) => new Delta(a).invert(new Delta(b), context).ops,
  });
};

export const unregisterDeltaEmbed = (): void => {
  Delta.unregisterEmbed('delta');
};

export const registerTableEmbed = (): void => {
  Delta.registerEmbed<TableData, TablePatch>('table-embed', tableHandler);
};

export const unregisterTableEmbed = (): void => {
  Delta.unregisterEmbed('table-embed');
};

export const registerEmbedHandler = (name: string): void => {
  switch (name) {
    case 'delta':
      registerDeltaEmbed();
      return;
    case 'table-embed':
      registerTableEmbed();
      return;
    default:
      throw new Error(`unknown test embed handler: ${name}`);
  }
};

export const unregisterEmbedHandler = (name: string): void => {
  switch (name) {
    case 'delta':
      unregisterDeltaEmbed();
      return;
    case 'table-embed':
      unregisterTableEmbed();
      return;
    default:
      throw new Error(`unknown test embed handler: ${name}`);
  }
};
