import cloneDeep = require('lodash.clonedeep');
import isEqual = require('lodash.isequal');
import AttributeMap from './AttributeMap';
import Op from './Op';
import OpIterator from './OpIterator';
import {
  EmbedHandler,
  ComposeContext,
  DiffContext,
  InvertContext,
  TransformContext,
  composeDelta,
  diffContext,
  transformDelta,
  invertDelta,
  lowerDelta,
  registerEmbed,
  unregisterEmbed,
  getHandler,
  inputLength,
  outputLength,
  check,
  hasMoves,
} from './moves';
import { snapshotDiff, snapshotDiffAt } from './diff';

const NULL_CHARACTER = String.fromCharCode(0); // Placeholder char for embed in diff()

class Delta {
  static Op = Op;
  static OpIterator = OpIterator;
  static AttributeMap = AttributeMap;

  static registerEmbed<Value, Change = Value>(
    embedType: string,
    handler: EmbedHandler<Value, Change>,
  ): void {
    registerEmbed(embedType, handler);
  }

  static unregisterEmbed(embedType: string): void {
    unregisterEmbed(embedType);
  }

  static getHandler(embedType: string): EmbedHandler<unknown> {
    return getHandler(embedType);
  }

  static check<T extends { ops: Op[] }>(delta: T): T {
    return check(delta);
  }

  static hasMoves(delta: { ops: Op[] }): boolean {
    return hasMoves(delta);
  }

  /** @internal Transfer an operation list that has no external owner. */
  static _fromOwnedOps(ops: Op[]): Delta {
    const delta = new Delta();
    delta.ops = ops;
    return delta;
  }

  ops: Op[];
  constructor(ops?: Op[] | { ops: Op[] }) {
    if (Array.isArray(ops)) {
      this.ops = cloneDeep(ops);
    } else if (ops != null && Array.isArray(ops.ops)) {
      this.ops = cloneDeep(ops.ops);
    } else {
      this.ops = [];
    }
  }

  insert(
    arg: string | Record<string, unknown>,
    attributes?: AttributeMap | null,
  ): this {
    const newOp: Op = {};
    if (typeof arg === 'string' && arg.length === 0) {
      return this;
    }
    newOp.insert = arg;
    if (
      attributes != null &&
      typeof attributes === 'object' &&
      Object.keys(attributes).length > 0
    ) {
      newOp.attributes = attributes;
    }
    return this.push(newOp);
  }

  delete(length: number): this {
    if (length <= 0) {
      return this;
    }
    return this.push({ delete: length });
  }

  retain(
    length: number | Record<string, unknown>,
    attributes?: AttributeMap | null,
  ): this {
    if (typeof length === 'number' && length <= 0) {
      return this;
    }
    const newOp: Op = { retain: length };
    if (
      attributes != null &&
      typeof attributes === 'object' &&
      Object.keys(attributes).length > 0
    ) {
      newOp.attributes = attributes;
    }
    return this.push(newOp);
  }

  cut(ref: string, length: number): this {
    if (length <= 0) {
      return this;
    }
    return this.push({ cut: { ref, length } });
  }

  paste(
    ref: string,
    start: number,
    length: number,
    change?: Record<string, unknown> | null,
    attributes?: AttributeMap | null,
  ): this {
    if (length <= 0) {
      return this;
    }
    const newOp: Op = { paste: { ref, start, length } };
    if (change != null) {
      if (length !== 1) {
        throw new Error('a paste change must address one embed');
      }
      newOp.paste!.change = change;
    }
    if (
      attributes != null &&
      typeof attributes === 'object' &&
      Object.keys(attributes).length > 0
    ) {
      newOp.attributes = attributes;
    }
    return this.push(newOp);
  }

  push(newOp: Op): this {
    if (this.ops.length > 0) {
      const lastOp = this.ops[this.ops.length - 1];
      // adjacent windows of one paste merge back together
      if (Op.type(newOp) === 'paste' && Op.type(lastOp) === 'paste') {
        const last = lastOp.paste!;
        const next = newOp.paste!;
        if (
          last.ref === next.ref &&
          last.start + last.length === next.start &&
          !('change' in last) &&
          !('change' in next) &&
          isEqual(last.path, next.path) &&
          last.unit === next.unit &&
          isEqual(lastOp.attributes, newOp.attributes)
        ) {
          last.length += next.length;
          return this;
        }
      }
      if (
        Op.type(newOp) === 'cut' &&
        Op.type(lastOp) === 'cut' &&
        lastOp.cut!.ref === newOp.cut!.ref
      ) {
        lastOp.cut!.length += newOp.cut!.length;
        return this;
      }
    }
    let index = this.ops.length;
    let lastOp = this.ops[index - 1];
    newOp = cloneDeep(newOp);
    if (typeof lastOp === 'object') {
      if (
        typeof newOp.delete === 'number' &&
        typeof lastOp.delete === 'number'
      ) {
        this.ops[index - 1] = { delete: lastOp.delete + newOp.delete };
        return this;
      }
      // Since it does not matter if we insert before or after deleting at the same index,
      // always prefer to insert first
      if (typeof lastOp.delete === 'number' && newOp.insert != null) {
        index -= 1;
        lastOp = this.ops[index - 1];
        if (typeof lastOp !== 'object') {
          this.ops.unshift(newOp);
          return this;
        }
      }
      if (isEqual(newOp.attributes, lastOp.attributes)) {
        if (
          typeof newOp.insert === 'string' &&
          typeof lastOp.insert === 'string'
        ) {
          this.ops[index - 1] = { insert: lastOp.insert + newOp.insert };
          if (typeof newOp.attributes === 'object') {
            this.ops[index - 1].attributes = newOp.attributes;
          }
          return this;
        } else if (
          typeof newOp.retain === 'number' &&
          typeof lastOp.retain === 'number'
        ) {
          this.ops[index - 1] = { retain: lastOp.retain + newOp.retain };
          if (typeof newOp.attributes === 'object') {
            this.ops[index - 1].attributes = newOp.attributes;
          }
          return this;
        }
      }
    }
    if (index === this.ops.length) {
      this.ops.push(newOp);
    } else {
      this.ops.splice(index, 0, newOp);
    }
    return this;
  }

  chop(): this {
    const lastOp = this.ops[this.ops.length - 1];
    if (lastOp && typeof lastOp.retain === 'number' && !lastOp.attributes) {
      this.ops.pop();
    }
    return this;
  }

  filter(predicate: (op: Op, index: number) => boolean): Op[] {
    return this.ops.filter(predicate);
  }

  forEach(predicate: (op: Op, index: number) => void): void {
    this.ops.forEach(predicate);
  }

  map<T>(predicate: (op: Op, index: number) => T): T[] {
    return this.ops.map(predicate);
  }

  partition(predicate: (op: Op) => boolean): [Op[], Op[]] {
    const passed: Op[] = [];
    const failed: Op[] = [];
    this.forEach((op) => {
      const target = predicate(op) ? passed : failed;
      target.push(op);
    });
    return [passed, failed];
  }

  reduce<T>(
    predicate: (accum: T, curr: Op, index: number) => T,
    initialValue: T,
  ): T {
    return this.ops.reduce(predicate, initialValue);
  }

  // A move counts once: its cut and its paste cancel out.
  changeLength(): number {
    return this.reduce((length, elem) => {
      switch (Op.type(elem)) {
        case 'delete':
          return length - elem.delete!;
        case 'cut':
          return length - elem.cut!.length;
        case 'insert':
          return length + Op.length(elem);
        case 'paste':
          return length + elem.paste!.length;
        default:
          return length;
      }
    }, 0);
  }

  length(): number {
    return this.reduce((length, elem) => {
      return length + Op.length(elem);
    }, 0);
  }

  document(): string {
    return this.map((op) => {
      if (op.insert != null || op.insert === '') {
        return typeof op.insert === 'string' ? op.insert : NULL_CHARACTER;
      }
      throw new Error(
        'document() can only be called on Deltas that have only insert ops',
      );
    }).join('');
  }

  slice(start = 0, end = Infinity): Delta {
    const ops = [];
    const iter = new OpIterator(this.ops);
    let index = 0;
    while (index < end && iter.hasNext()) {
      let nextOp;
      if (index < start) {
        nextOp = iter.next(start - index);
      } else {
        nextOp = iter.next(end - index);
        ops.push(nextOp);
      }
      index += Op.length(nextOp);
    }
    return Delta._fromOwnedOps(ops);
  }

  compose(other: Delta, _context?: ComposeContext): Delta {
    return composeDelta(this, other, _context);
  }

  concat(other: Delta): Delta {
    const delta = Delta._fromOwnedOps(cloneDeep(this.ops));
    if (other.ops.length > 0) {
      delta.push(other.ops[0]);
      delta.ops = delta.ops.concat(cloneDeep(other.ops.slice(1)));
    }
    return delta;
  }

  /**
   * Deterministic typed snapshot diff between two *documents* (Deltas
   * with only insert ops): retains, inserts, deletes and embed-retain
   * patches only — never cut/paste.  `cursor` is an optional caret hint
   * (a base-document UTF-16 position) anchoring an ambiguous edit where
   * the editor actually made it.  See src/diff.ts for the atom model
   * and alignment policy.
   */
  diff(other: Delta, cursor?: number, _context?: DiffContext): Delta {
    const context = diffContext(_context);
    if (cursor === undefined) {
      return snapshotDiff(this, other, context);
    }
    return snapshotDiffAt(this, other, cursor, context);
  }

  eachLine(
    predicate: (
      line: Delta,
      attributes: AttributeMap,
      index: number,
    ) => boolean | void,
    newline = '\n',
  ): void {
    const iter = new OpIterator(this.ops);
    let line = new Delta();
    let i = 0;
    while (iter.hasNext()) {
      if (iter.peekType() !== 'insert') {
        return;
      }
      const thisOp = iter.peek();
      const start = Op.length(thisOp) - iter.peekLength();
      const index =
        typeof thisOp.insert === 'string'
          ? thisOp.insert.indexOf(newline, start) - start
          : -1;
      if (index < 0) {
        line.push(iter.next());
      } else if (index > 0) {
        line.push(iter.next(index));
      } else {
        if (predicate(line, iter.next(1).attributes || {}, i) === false) {
          return;
        }
        i += 1;
        line = new Delta();
      }
    }
    if (line.length() > 0) {
      predicate(line, {}, i);
    }
  }

  invert(base: Delta, _context?: InvertContext): Delta {
    return invertDelta(this, base, _context);
  }

  /**
   * Rewrite moves as plain deletes, inserts and embed changes against a
   * concrete document, at every nesting level.
   */
  lower(base: Delta): Delta {
    return lowerDelta(this, base);
  }

  transform(index: number, priority?: boolean): number;
  transform(
    other: Delta,
    priority?: boolean,
    _context?: TransformContext,
  ): Delta;
  transform(
    arg: number | Delta,
    priority = false,
    _context?: TransformContext,
  ): typeof arg {
    priority = !!priority;
    if (typeof arg === 'number') {
      return this.transformPosition(arg, priority);
    }
    return transformDelta(this, arg, priority, _context);
  }

  /**
   * Map a position through this delta.
   *
   * A position strictly inside moved content follows it to the covering
   * paste window; a position at the region's start, or over content
   * that is cut but never pasted, stays at the source like a deletion.
   */
  transformPosition(index: number, priority = false): number {
    priority = !!priority;
    let inputPosition = 0;
    let followed: [string, number] | null = null;
    for (const operation of this.ops) {
      if (Op.type(operation) === 'cut') {
        const offset = index - inputPosition;
        if (0 < offset && offset < operation.cut!.length) {
          followed = [operation.cut!.ref, offset];
        }
      }
      inputPosition += inputLength(operation);
    }
    if (followed !== null) {
      const [ref, offset] = followed;
      let outputPosition = 0;
      for (const operation of this.ops) {
        if (Op.type(operation) === 'paste' && operation.paste!.ref === ref) {
          const spec = operation.paste!;
          if (spec.start <= offset && offset < spec.start + spec.length) {
            return outputPosition + offset - spec.start;
          }
        }
        outputPosition += outputLength(operation);
      }
    }
    let position = index;
    let passed = 0;
    for (const operation of this.ops) {
      if (passed > position) {
        break;
      }
      const kind = Op.type(operation);
      const length = Op.length(operation);
      if (kind === 'delete' || kind === 'cut') {
        position -= Math.min(length, position - passed);
      } else if (kind === 'insert' || kind === 'paste') {
        if (passed < position || !priority) {
          position += length;
        }
        passed += length;
      } else {
        passed += length;
      }
    }
    return position;
  }
}

export default Delta;

export { Op, OpIterator, AttributeMap, check, hasMoves };
export type {
  ComposeContext,
  DiffContext,
  EmbedHandler,
  InvertContext,
  TransformContext,
} from './moves';
// Re-exported last: coords imports Delta back, so its module must load
// only once Delta's exports are fully populated.
export { transformCoordinate } from './coords';

if (typeof module === 'object') {
  module.exports = Delta;
  module.exports.default = Delta;
  module.exports.check = check;
  module.exports.hasMoves = hasMoves;
  // `module.exports = Delta` replaces the named exports emitted by tsc. Keep
  // the public coordinate API available from the package entry point too.
  // The require is deliberately lazy: coords imports Delta back.
  module.exports.transformCoordinate =
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    (require('./coords') as typeof import('./coords')).transformCoordinate;
}
