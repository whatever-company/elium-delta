import AttributeMap from './AttributeMap';

interface CutSpec {
  ref: string;
  length: number;
}

interface PasteSpec {
  ref: string;
  start: number;
  length: number;
  // a retain-style embed patch applied to a single pasted embed
  change?: Record<string, unknown>;
  // reads through a trashed embed: characters of the child sequence at
  // `path` inside the embed captured at offset `unit` of the cut
  unit?: number;
  path?: (string | number)[];
}

interface Op {
  // only one property out of {insert, delete, retain, cut, paste} will be present
  insert?: string | Record<string, unknown>;
  delete?: number;
  retain?: number | Record<string, unknown>;
  cut?: CutSpec;
  paste?: PasteSpec;

  attributes?: AttributeMap;
}

type OpType = 'insert' | 'delete' | 'retain' | 'cut' | 'paste';

// Malformed move specs deliberately fail these guards and fall back to
// the opaque length-1 insert path: length/type never throw on bad input.

namespace Op {
  export function isCut(op: Op): boolean {
    return (
      typeof op.cut === 'object' &&
      op.cut !== null &&
      Number.isInteger(op.cut.length)
    );
  }

  export function isPaste(op: Op): boolean {
    return (
      typeof op.paste === 'object' &&
      op.paste !== null &&
      Number.isInteger(op.paste.length) &&
      Number.isInteger(op.paste.start)
    );
  }

  export function length(op: Op): number {
    if (typeof op.delete === 'number') {
      return op.delete;
    } else if (typeof op.retain === 'number') {
      return op.retain;
    } else if (typeof op.retain === 'object' && op.retain !== null) {
      return 1;
    } else if (typeof op.insert === 'string') {
      return op.insert.length;
    } else if (isCut(op)) {
      return (op.cut as CutSpec).length;
    } else if (isPaste(op)) {
      return (op.paste as PasteSpec).length;
    } else {
      return 1;
    }
  }

  export function type(op: Op | null | undefined): OpType | null {
    if (!op) {
      return null;
    }
    if (typeof op.delete === 'number') {
      return 'delete';
    } else if (isCut(op)) {
      return 'cut';
    } else if (isPaste(op)) {
      return 'paste';
    } else if (typeof op.retain === 'number') {
      return 'retain';
    } else if (
      typeof op.retain === 'object' &&
      op.retain !== null &&
      Object.keys(op.retain).length > 0
    ) {
      return 'retain';
    } else {
      return 'insert';
    }
  }
}

export default Op;
export { CutSpec, PasteSpec, OpType };
