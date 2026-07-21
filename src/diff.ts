/**
 * Deterministic typed snapshot diff between two documents.
 *
 * `snapshotDiff(base, target)` returns a normalized change satisfying
 * `base.compose(base.diff(target)) == target`, built from retains,
 * inserts, deletes and typed embed-retain patches only — never cut/paste
 * (explicit move intent is composed separately by the caller).
 *
 * Documents are normalized into *atoms* — one UTF-16 code unit per text
 * atom, one unit per embed — and aligned in two deterministic stages:
 * first the maximum number of *exact* matches (value and attributes),
 * then, inside each unmatched gap, the maximum number of *compatible*
 * matches (same text unit ignoring attributes; same embed type ignoring
 * payload).  Ties break by the canonical Myers ordering, so output never
 * depends on elapsed time, object key ordering, or how the input text was
 * chunked into ops.  Exact-first alignment keeps an unchanged embed
 * retained verbatim rather than patching its repeated siblings pairwise.
 *
 * Globally smallest wire output is *not* a goal: a slightly larger but
 * stable delta is preferred over heuristic cleanup.
 */
import isEqual = require('lodash.isequal');
import AttributeMap from './AttributeMap';
import Op from './Op';
import OpIterator from './OpIterator';
import { DiffContext, firstMoveOp, handlers, Payload } from './moves';
import type Delta from './Delta';

/**
 * A stable equality key: canonical JSON, independent of object key
 * insertion order; lone surrogates survive via ASCII escapes.
 */
function freeze(value: unknown): string {
  return value === undefined ? 'null' : JSON.stringify(sorted(value));
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sorted);
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      copy[key] = sorted(record[key]);
    }
    return copy;
  }
  return value;
}

/** One document unit: a UTF-16 code unit of text, or an embed. */
interface Atom {
  kind: 'text' | 'embed';
  value: string | Payload; // the code unit, or the embed's {type: payload}
  attributes: AttributeMap | undefined;
  frozenValue: string;
  exact: string; // value + attributes
  compat: string; // value ignoring attributes / embed type only
}

function atomize(delta: Delta): Atom[] {
  const atoms: Atom[] = [];
  for (const operation of delta.ops) {
    const insert = operation.insert;
    if (insert == null) {
      throw new Error('diff() called on non-document');
    }
    const attributes = operation.attributes;
    const frozenAttrs = freeze(attributes);
    if (typeof insert === 'string') {
      for (let index = 0; index < insert.length; index += 1) {
        const unit = insert[index];
        const frozen = freeze(unit);
        atoms.push({
          kind: 'text',
          value: unit,
          attributes,
          frozenValue: frozen,
          exact: `text:${frozen}:${frozenAttrs}`,
          compat: `text:${frozen}`,
        });
      }
    } else {
      const embedType = Object.keys(insert)[0];
      const frozen = freeze(insert);
      atoms.push({
        kind: 'embed',
        value: insert,
        attributes,
        frozenValue: frozen,
        exact: `embed:${frozen}:${frozenAttrs}`,
        compat: `embed:${embedType}`,
      });
    }
  }
  return atoms;
}

function textEdge(left: string, right: string, suffix = false): number {
  let high = Math.min(left.length, right.length);
  if (
    !high ||
    (suffix ? left.slice(-1) !== right.slice(-1) : left[0] !== right[0])
  ) {
    return 0;
  }
  let low = 1;
  while (low < high) {
    const middle = Math.floor((low + high + 1) / 2);
    const same = suffix
      ? left.slice(-middle) === right.slice(-middle)
      : left.slice(0, middle) === right.slice(0, middle);
    if (same) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
}

function commonPiece(
  left: Op['insert'],
  right: Op['insert'],
  leftAttributes: AttributeMap | undefined,
  rightAttributes: AttributeMap | undefined,
  suffix = false,
): number {
  if (freeze(leftAttributes) !== freeze(rightAttributes)) {
    return 0;
  }
  if (typeof left === 'string' && typeof right === 'string') {
    return textEdge(left, right, suffix);
  }
  return typeof left !== 'string' &&
    typeof right !== 'string' &&
    freeze(left) === freeze(right)
    ? 1
    : 0;
}

function insertOp(operation: Op | undefined): Op {
  if (operation?.insert == null) {
    throw new Error('diff() called on non-document');
  }
  return operation;
}

function commonPrefix(leftOps: Op[], rightOps: Op[]): number {
  const left = new OpIterator(leftOps);
  const right = new OpIterator(rightOps);
  let length = 0;
  while (left.hasNext() && right.hasNext()) {
    if (left.peekLength() === 0) {
      left.next();
      continue;
    }
    if (right.peekLength() === 0) {
      right.next();
      continue;
    }
    const leftRaw = insertOp(left.peek());
    const rightRaw = insertOp(right.peek());
    const size = Math.min(left.peekLength(), right.peekLength());
    const leftPiece = insertOp(left.next(size)).insert;
    const rightPiece = insertOp(right.next(size)).insert;
    const common = commonPiece(
      leftPiece,
      rightPiece,
      leftRaw.attributes,
      rightRaw.attributes,
    );
    length += common;
    if (common < size) {
      return length;
    }
  }
  return length;
}

function commonSuffix(leftOps: Op[], rightOps: Op[]): number {
  let leftIndex = leftOps.length - 1;
  let rightIndex = rightOps.length - 1;
  let leftOffset = 0;
  let rightOffset = 0;
  let length = 0;
  while (leftIndex >= 0 && rightIndex >= 0) {
    const left = insertOp(leftOps[leftIndex]);
    const right = insertOp(rightOps[rightIndex]);
    const leftSize = Op.length(left);
    const rightSize = Op.length(right);
    if (leftOffset === leftSize) {
      leftIndex -= 1;
      leftOffset = 0;
      continue;
    }
    if (rightOffset === rightSize) {
      rightIndex -= 1;
      rightOffset = 0;
      continue;
    }
    const size = Math.min(leftSize - leftOffset, rightSize - rightOffset);
    const leftPiece =
      typeof left.insert === 'string'
        ? left.insert.slice(leftSize - leftOffset - size, leftSize - leftOffset)
        : left.insert;
    const rightPiece =
      typeof right.insert === 'string'
        ? right.insert.slice(
            rightSize - rightOffset - size,
            rightSize - rightOffset,
          )
        : right.insert;
    const common = commonPiece(
      leftPiece,
      rightPiece,
      left.attributes,
      right.attributes,
      true,
    );
    length += common;
    if (common < size) {
      return length;
    }
    leftOffset += size;
    rightOffset += size;
  }
  return length;
}

function documentSlice(delta: Delta, start: number, stop = Infinity): Delta {
  const ops: Op[] = [];
  let position = 0;
  for (const operation of delta.ops) {
    const inserted = insertOp(operation);
    const size = Op.length(inserted);
    if (position >= stop) {
      break;
    }
    if (size && position + size > start) {
      if (typeof inserted.insert === 'string') {
        const low = Math.max(start - position, 0);
        const high = Math.min(stop - position, size);
        const piece: Op = { insert: inserted.insert.slice(low, high) };
        if ('attributes' in inserted) {
          piece.attributes = inserted.attributes;
        }
        ops.push(piece);
      } else {
        ops.push(inserted);
      }
    }
    position += size;
  }
  const DeltaClass = delta.constructor as new (ops?: Op[]) => Delta;
  return new DeltaClass(ops);
}

/** Linear-space, deterministic bidirectional Myers LCS. */
function matched(
  a: string[],
  b: string[],
  aStart = 0,
  aEnd = a.length,
  bStart = 0,
  bEnd = b.length,
): [number, number][] {
  const bisect = (
    aLow: number,
    aHigh: number,
    bLow: number,
    bHigh: number,
  ): [number, number] => {
    const n = aHigh - aLow;
    const m = bHigh - bLow;
    const maxDistance = Math.floor((n + m + 1) / 2);
    const offset = maxDistance + 1;
    const size = 2 * maxDistance + 3;
    const forward = new Array<number>(size).fill(-1);
    const backward = new Array<number>(size).fill(-1);
    forward[offset + 1] = backward[offset + 1] = 0;
    const delta = n - m;
    const frontOverlap = Math.abs(delta % 2) === 1;
    let frontStart = 0;
    let frontEnd = 0;
    let backStart = 0;
    let backEnd = 0;

    for (let distance = 0; distance <= maxDistance; distance += 1) {
      for (
        let diagonal = distance - frontEnd;
        diagonal >= -distance + frontStart;
        diagonal -= 2
      ) {
        const index = offset + diagonal;
        const down =
          diagonal === -distance ||
          (diagonal !== distance && forward[index - 1] < forward[index + 1]);
        let x = down ? forward[index + 1] : forward[index - 1] + 1;
        let y = x - diagonal;
        while (
          0 <= x &&
          x < n &&
          0 <= y &&
          y < m &&
          a[aLow + x] === b[bLow + y]
        ) {
          x += 1;
          y += 1;
        }
        forward[index] = x;
        if (x > n) {
          frontEnd += 2;
        } else if (y > m) {
          frontStart += 2;
        } else if (frontOverlap) {
          const reverseIndex = offset + delta - diagonal;
          if (
            0 <= reverseIndex &&
            reverseIndex < size &&
            backward[reverseIndex] !== -1 &&
            x >= n - backward[reverseIndex]
          ) {
            return [aLow + x, bLow + y];
          }
        }
      }

      for (
        let diagonal = -distance + backStart;
        diagonal <= distance - backEnd;
        diagonal += 2
      ) {
        const index = offset + diagonal;
        const down =
          diagonal === -distance ||
          (diagonal !== distance && backward[index - 1] < backward[index + 1]);
        let x = down ? backward[index + 1] : backward[index - 1] + 1;
        let y = x - diagonal;
        while (
          0 <= x &&
          x < n &&
          0 <= y &&
          y < m &&
          a[aHigh - x - 1] === b[bHigh - y - 1]
        ) {
          x += 1;
          y += 1;
        }
        backward[index] = x;
        if (x > n) {
          backEnd += 2;
        } else if (y > m) {
          backStart += 2;
        } else if (!frontOverlap) {
          const forwardDiagonal = delta - diagonal;
          const forwardIndex = offset + forwardDiagonal;
          if (
            0 <= forwardIndex &&
            forwardIndex < size &&
            forward[forwardIndex] !== -1 &&
            forward[forwardIndex] >= n - x
          ) {
            const forwardX = forward[forwardIndex];
            return [aLow + forwardX, bLow + forwardX - forwardDiagonal];
          }
        }
      }
    }
    throw new Error('Myers bisect found no overlap');
  };

  type Task = [number, number, number, number, boolean];
  const matches: [number, number][] = [];
  const stack: Task[] = [[aStart, aEnd, bStart, bEnd, false]];
  while (stack.length) {
    const task = stack.pop();
    if (task === undefined) {
      break;
    }
    let [aLow, aHigh, bLow, bHigh] = task;
    const emit = task[4];
    if (emit) {
      while (aLow < aHigh) {
        matches.push([aLow, bLow]);
        aLow += 1;
        bLow += 1;
      }
      continue;
    }
    while (aLow < aHigh && bLow < bHigh && a[aLow] === b[bLow]) {
      matches.push([aLow, bLow]);
      aLow += 1;
      bLow += 1;
    }
    if (aLow === aHigh || bLow === bHigh) {
      continue;
    }
    if (aHigh - aLow === 1) {
      for (let j = bLow; j < bHigh; j += 1) {
        if (a[aLow] === b[j]) {
          matches.push([aLow, j]);
          break;
        }
      }
      continue;
    }
    if (bHigh - bLow === 1) {
      for (let i = aLow; i < aHigh; i += 1) {
        if (a[i] === b[bLow]) {
          matches.push([i, bLow]);
          break;
        }
      }
      continue;
    }
    let suffix = 0;
    while (aLow < aHigh && bLow < bHigh && a[aHigh - 1] === b[bHigh - 1]) {
      aHigh -= 1;
      bHigh -= 1;
      suffix += 1;
    }
    if (suffix) {
      stack.push([aHigh, aHigh + suffix, bHigh, bHigh + suffix, true]);
      if (aLow < aHigh && bLow < bHigh) {
        stack.push([aLow, aHigh, bLow, bHigh, false]);
      }
      continue;
    }
    const [x, y] = bisect(aLow, aHigh, bLow, bHigh);
    if ((x === aLow && y === bLow) || (x === aHigh && y === bHigh)) {
      throw new Error('Myers bisect did not advance');
    }
    stack.push([x, aHigh, y, bHigh, false]);
    stack.push([aLow, x, bLow, y, false]);
  }
  return matches;
}

/**
 * (base index, target index, isExact) triples in document order:
 * maximum exact matches first, then compatible matches per gap.
 */
function aligned(base: Atom[], target: Atom[]): [number, number, boolean][] {
  const baseExact = base.map((atom) => atom.exact);
  const targetExact = target.map((atom) => atom.exact);
  const baseCompat = base.map((atom) => atom.compat);
  const targetCompat = target.map((atom) => atom.compat);
  const exact = matched(baseExact, targetExact);
  const pairs: [number, number, boolean][] = [];
  let previous: [number, number] = [-1, -1];
  for (const [low, high] of [
    ...exact,
    [base.length, target.length] as [number, number],
  ]) {
    for (const [i, j] of matched(
      baseCompat,
      targetCompat,
      previous[0] + 1,
      low,
      previous[1] + 1,
      high,
    )) {
      pairs.push([i, j, false]);
    }
    if (low < base.length) {
      pairs.push([low, high, true]);
    }
    previous = [low, high];
  }
  return pairs;
}

/**
 * Emit one aligned same-type embed pair: a retain, a handler patch, or
 * an explicit replacement.
 */
function embedPair(
  delta: Delta,
  ours: Atom,
  theirs: Atom,
  context: DiffContext,
): void {
  const attributes = AttributeMap.diff(ours.attributes, theirs.attributes);
  if (ours.frozenValue === theirs.frozenValue) {
    delta.retain(1, attributes);
    return;
  }
  const ourValue = ours.value as Payload;
  const theirValue = theirs.value as Payload;
  const embedType = Object.keys(ourValue)[0];
  const handler = handlers[embedType];
  const patch = handler?.diff(
    ourValue[embedType],
    theirValue[embedType],
    context,
  );
  if (patch === undefined) {
    replace(delta, theirs);
    return;
  }
  if (patch === null) {
    throw new Error(
      `'${embedType}' handler returned no diff for unequal ` +
        'snapshots (null means equality only)',
    );
  }
  if (firstMoveOp({ [embedType]: patch }) !== null) {
    throw new Error(
      `'${embedType}' handler diff produced a move: snapshot ` +
        'diffs must not contain cut or paste',
    );
  }
  const retain: Op = { retain: { [embedType]: patch } };
  if (attributes) {
    retain.attributes = attributes;
  }
  delta.push(retain);
}

function replace(delta: Delta, theirs: Atom): void {
  const insert: Op = { insert: theirs.value };
  if (theirs.attributes && Object.keys(theirs.attributes).length) {
    insert.attributes = theirs.attributes;
  }
  delta.push(insert);
  delta.delete(1);
}

function sameRun(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((key, index) => key === b[index]);
}

/**
 * Slide the first pure insert or delete toward `cursor` (a UTF-16
 * position in the base document) when the swept span is a uniform run
 * of identical units — the edit lands where the caret was instead of
 * at the canonical end of the run.  An unreachable cursor (blocked by
 * a differing unit or attributes) leaves the canonical placement.
 */
function anchored(delta: Delta, baseAtoms: Atom[], cursor: number): Delta {
  let position = 0;
  for (let index = 0; index < delta.ops.length; index += 1) {
    const operation = delta.ops[index];
    const kind = Op.type(operation);
    if (kind === 'retain') {
      const retained = operation.retain;
      // a typed embed patch retains exactly one unit
      position += typeof retained === 'number' ? retained : 1;
      continue;
    }
    if (kind !== 'insert' && kind !== 'delete') {
      return delta;
    }
    // only a lone edit between retains is slidable
    const neighborKind = Op.type(delta.ops[index + 1] ?? null);
    if (neighborKind === 'insert' || neighborKind === 'delete') {
      return delta;
    }
    const length = operation.delete ?? 0;
    const low = Math.min(cursor, position);
    const high = Math.max(cursor, position) + length;
    if (low < 0 || high > baseAtoms.length) {
      return delta;
    }
    const span = baseAtoms
      .slice(Math.min(cursor, position), Math.max(cursor, position))
      .map((atom) => atom.exact);
    if (kind === 'insert') {
      const insert = operation.insert;
      if (typeof insert !== 'string') {
        return delta;
      }
      const frozenAttrs = freeze(operation.attributes);
      const units: string[] = [];
      for (let i = 0; i < insert.length; i += 1) {
        units.push(`text:${freeze(insert[i])}:${frozenAttrs}`);
      }
      // sliding is sound iff the affected region reads the same
      // both ways: the swept run commutes with the insertion
      // (uniform and periodic runs alike, emoji pairs included)
      if (!sameRun([...span, ...units], [...units, ...span])) {
        return delta;
      }
    } else {
      // deleting [position, +L) vs [cursor, +L): sound iff the
      // swept run repeats itself L units later
      const start = Math.min(cursor, position);
      const shifted = baseAtoms
        .slice(start + length, Math.max(cursor, position) + length)
        .map((atom) => atom.exact);
      if (!sameRun(span, shifted)) {
        return delta;
      }
    }
    const move = cursor - position; // negative slides the edit left
    // the edit slides by trading units between its two neighboring
    // plain retains; an attributed retain pins a format boundary
    // and blocks the slide
    const previous = index ? delta.ops[index - 1] : null;
    const following =
      index + 1 < delta.ops.length ? delta.ops[index + 1] : null;
    const sides: [Op | null, number][] = [
      [previous, -move],
      [following, move],
    ];
    for (const [neighbor, needed] of sides) {
      if (needed <= 0) {
        continue; // this side only grows (or the tail is implicit)
      }
      if (neighbor === null && neighbor === following) {
        continue; // growing into the implicit trailing retain
      }
      if (
        neighbor === null ||
        typeof neighbor.retain !== 'number' ||
        (neighbor.attributes && Object.keys(neighbor.attributes).length) ||
        neighbor.retain < needed
      ) {
        return delta;
      }
    }
    // slide: the retain before the edit gains `move` units, the one
    // after loses them (absent retains are implicit tail)
    const rebuilt = new (delta.constructor as new () => Delta)();
    for (let i = 0; i < delta.ops.length; i += 1) {
      const other = delta.ops[i];
      if (
        i === index - 1 &&
        typeof other.retain === 'number' &&
        !(other.attributes && Object.keys(other.attributes).length)
      ) {
        rebuilt.retain(other.retain + move);
      } else if (i === index) {
        if (
          previous === null ||
          typeof previous.retain !== 'number' ||
          (previous.attributes && Object.keys(previous.attributes).length)
        ) {
          rebuilt.retain(move); // a new retain before the edit
        }
        rebuilt.push(other);
      } else if (
        i === index + 1 &&
        typeof other.retain === 'number' &&
        !(other.attributes && Object.keys(other.attributes).length)
      ) {
        rebuilt.retain(other.retain - move);
      } else if (i === index + 1 && move < 0) {
        rebuilt.retain(-move); // vacated run before a pinned op
        rebuilt.push(other);
      } else {
        rebuilt.push(other);
      }
    }
    if (move < 0 && following === null) {
      rebuilt.retain(-move); // implicit tail; chop drops it
    }
    return rebuilt.chop();
  }
  return delta;
}

function atomDiff(base: Delta, target: Delta, context: DiffContext): Delta {
  const DeltaClass = base.constructor as new () => Delta;
  const ours = atomize(base);
  const theirs = atomize(target);
  const delta = new DeltaClass();
  let cursor: [number, number] = [0, 0];
  for (const [i, j, isExact] of [
    ...aligned(ours, theirs),
    [ours.length, theirs.length, true] as [number, number, boolean],
  ]) {
    for (let deleted = cursor[0]; deleted < i; deleted += 1) {
      delta.delete(1);
    }
    for (const atom of theirs.slice(cursor[1], j)) {
      const insert: Op = { insert: atom.value };
      if (atom.attributes && Object.keys(atom.attributes).length) {
        insert.attributes = atom.attributes;
      }
      delta.push(insert);
    }
    if (i < ours.length) {
      const a = ours[i];
      const b = theirs[j];
      if (isExact) {
        delta.retain(1);
      } else if (a.kind === 'text') {
        delta.retain(1, AttributeMap.diff(a.attributes, b.attributes));
      } else {
        embedPair(delta, a, b, context);
      }
    }
    cursor = [i + 1, j + 1];
  }
  return delta.chop();
}

export function snapshotDiff(
  base: Delta,
  target: Delta,
  context: DiffContext,
): Delta {
  const DeltaClass = base.constructor as new () => Delta;
  if (base.ops === target.ops || isEqual(base.ops, target.ops)) {
    return new DeltaClass();
  }
  for (const operation of [...base.ops, ...target.ops]) {
    insertOp(operation);
  }
  const prefix = commonPrefix(base.ops, target.ops);
  let ours = prefix ? documentSlice(base, prefix) : base;
  let theirs = prefix ? documentSlice(target, prefix) : target;
  // Preserve the leftmost one-unit ambiguity before trimming a suffix.
  const suffix =
    Math.min(ours.length(), theirs.length()) > 1
      ? commonSuffix(ours.ops, theirs.ops)
      : 0;
  if (suffix) {
    ours = documentSlice(ours, 0, ours.length() - suffix);
    theirs = documentSlice(theirs, 0, theirs.length() - suffix);
  }
  const result = new DeltaClass().retain(prefix);
  for (const operation of atomDiff(ours, theirs, context).ops) {
    result.push(operation);
  }
  return result.chop();
}

/**
 * `snapshotDiff` with a caret hint: the base-document UTF-16 position
 * where the edit happened.  Within a uniform run — where several
 * placements produce the same document — the edit is anchored at the
 * caret instead of the canonical end of the run, so concurrent
 * transforms reorder around the position the editor actually used.
 * Same inputs always give the same output; an unreachable hint leaves
 * the canonical placement.
 */
export function snapshotDiffAt(
  base: Delta,
  target: Delta,
  cursor: number,
  context: DiffContext,
): Delta {
  const delta = snapshotDiff(base, target, context);
  if (!delta.ops.length) {
    return delta;
  }
  return anchored(delta, atomize(base), cursor);
}
