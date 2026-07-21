/**
 * Document coordinates that transform through move-aware deltas.
 *
 * A coordinate addresses a position in a nested document as an array:
 *
 *     [5]                     a caret at root offset 5
 *     [2, 'ops', 3]           a caret at offset 3 inside the child sequence
 *                             at payload key 'ops' of the embed at root
 *                             position 2
 *     [2, 'ops', 1, 'ops', 0] ... and so on, one embed unit per level
 *
 * `transformCoordinate(delta, coordinate)` maps a coordinate through a
 * delta.  Carets shift with inserts and deletes, follow content that a move
 * relocates — across sequence levels, in either direction, including trash
 * reads — and collapse to the removal point when their span is deleted.
 * Embed *units* (any element followed by more coordinate) return `null`
 * when the unit was deleted.
 *
 * Boundary conventions match the algebra: a caret exactly at the start of a
 * moved region stays at the source, like a concurrent insert there; a caret
 * strictly inside follows the content.
 */
import Delta from './Delta';
import Op, { PasteSpec } from './Op';
import {
  PathPart,
  Window,
  collectWindows,
  inputLength,
  outputLength,
  unitPatch,
  unitPosition,
} from './moves';

export type Coordinate = PathPart[];

type ReadSite = [PasteSpec, number];

export function transformCoordinate(
  delta: Delta,
  coordinate: Coordinate,
  priority = false,
): Coordinate | null {
  const reads: ReadSite[] = []; // trash reads carry addressed content to an output position
  let position = 0;
  for (const operation of delta.ops) {
    if (Op.type(operation) === 'paste' && 'path' in operation.paste!) {
      reads.push([operation.paste!, position]);
    }
    position += outputLength(operation);
  }
  return resolve(
    delta,
    coordinate.slice(),
    collectWindows(delta.ops),
    reads,
    priority,
    [],
  );
}

/**
 * Continue resolving `rest` through a child patch payload, or keep it
 * verbatim where the patch does not reach.
 */
function descend(
  patch: unknown,
  prefix: PathPart[],
  rest: PathPart[],
  windows: Map<string, Window[]>,
  reads: ReadSite[],
  priority: boolean,
): Coordinate | null {
  const keys: string[] = [];
  for (const part of rest) {
    if (typeof part !== 'string') {
      break;
    }
    keys.push(part);
  }
  const tail = rest.slice(keys.length);
  let childOps: unknown = patch;
  for (const key of keys) {
    childOps =
      typeof childOps === 'object' &&
      childOps !== null &&
      !Array.isArray(childOps)
        ? (childOps as Record<string, unknown>)[key]
        : undefined;
  }
  if (!tail.length || !Array.isArray(childOps)) {
    return [...prefix, ...rest];
  }
  return resolve(
    new Delta(childOps.slice() as Op[]),
    tail,
    windows,
    reads,
    priority,
    [...prefix, ...keys],
  );
}

/**
 * The coordinate's new home when a trash read carries the addressed
 * content to `outPosition`, or null when it is not covered.
 */
function throughRead(
  spec: PasteSpec,
  outPosition: number,
  local: number,
  coordinate: Coordinate,
): Coordinate | null {
  if ((spec.unit ?? 0) !== local) {
    return null;
  }
  const path = spec.path!;
  const tail = coordinate.slice(1);
  if (
    JSON.stringify(tail.slice(0, path.length)) !== JSON.stringify(path) ||
    tail.length <= path.length
  ) {
    return null;
  }
  const rest = tail.slice(path.length);
  const offset = rest[0];
  if (typeof offset !== 'number') {
    return null;
  }
  const start = spec.start;
  const end = spec.start + spec.length;
  const inside =
    rest.length > 1
      ? start <= offset && offset < end
      : start < offset && offset < end;
  if (!inside) {
    return null;
  }
  return [outPosition + offset - start, ...rest.slice(1)];
}

function resolve(
  delta: Delta,
  coordinate: Coordinate,
  windows: Map<string, Window[]>,
  reads: ReadSite[],
  priority: boolean,
  prefix: PathPart[],
): Coordinate | null {
  const target = coordinate[0] as number;
  const isUnit = coordinate.length > 1;

  // relocation: is the addressed position inside a moved region?
  let inputPosition = 0;
  for (const operation of delta.ops) {
    const kind = Op.type(operation);
    const length = inputLength(operation);
    const local = target - inputPosition;
    if (kind === 'cut' && 0 <= local && local < length) {
      if (isUnit || local > 0) {
        // boundary carets stay at the source
        const ref = operation.cut!.ref;
        for (const window of windows.get(ref) ?? []) {
          const start = window.start;
          const location = window.location!;
          if (start <= local && local < start + window.length) {
            let head: PathPart[];
            if (location[0] === 'root') {
              head = [location[1] + local - start];
            } else {
              const [, hops, childPrefix] = location;
              const flat: PathPart[] = [];
              for (const [unit, , keys] of hops) {
                flat.push(unit);
                flat.push(...keys!);
              }
              head = [...flat, childPrefix + local - start];
            }
            const rest = coordinate.slice(1);
            if (!rest.length || window.change == null) {
              return [...head, ...rest];
            }
            // the covering paste also patches the moved embed
            const change = window.change;
            return descend(
              change[Object.keys(change)[0]],
              head,
              rest,
              windows,
              reads,
              priority,
            );
          }
        }
        // a trash read may still carry the addressed content out
        for (const [spec, outPosition] of reads) {
          if (spec.ref !== ref) {
            continue;
          }
          const followed = throughRead(spec, outPosition, local, coordinate);
          if (followed !== null) {
            return followed;
          }
        }
        if (isUnit) {
          return null; // cut but never pasted: the unit is gone
        }
      }
      break;
    }
    if (kind === 'delete' && 0 <= local && local < length && isUnit) {
      return null;
    }
    inputPosition += length;
  }

  if (!isUnit) {
    return [...prefix, delta.transformPosition(target, priority)];
  }

  // descend into the embed unit
  const mapped = unitPosition(delta, target);
  if (mapped === null) {
    return null;
  }
  const patch = unitPatch(delta, target, windows);
  if (patch == null) {
    return [...prefix, mapped, ...coordinate.slice(1)]; // untouched inside
  }
  return descend(
    patch,
    [...prefix, mapped],
    coordinate.slice(1),
    windows,
    reads,
    priority,
  );
}
