import Delta from '../src/Delta';
import Op from '../src/Op';
import { check, EmbedHandler, hasMoves } from '../src/moves';
import { transformCoordinate } from '../src/coords';

// A representative subset of the Python reference's hand-written tests
// (tests/test_moves.py); the full behavior is pinned by the golden
// fixtures in moves-fixtures.ts.

const apply = (doc: Delta, delta: Delta): Delta =>
  new Delta(doc.ops.slice()).compose(delta);

const doc = (text: string): Delta => new Delta().insert(text);

// A tiny mulberry32-style seeded PRNG: deterministic across runs, like
// the Python reference's random.Random(seed).
class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed | 0;
  }

  random(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // both bounds inclusive, like Python's randint
  randint(low: number, high: number): number {
    return low + Math.floor(this.random() * (high - low + 1));
  }

  choice<T>(items: T[]): T {
    return items[this.randint(0, items.length - 1)];
  }
}

describe('moves', () => {
  describe('builders and normalization', () => {
    it('builders', () => {
      const delta = new Delta()
        .cut('r', 3)
        .retain(2)
        .paste('r', 0, 3, undefined, { bold: true });
      expect(delta.ops).toEqual([
        { cut: { ref: 'r', length: 3 } },
        { retain: 2 },
        {
          paste: { ref: 'r', start: 0, length: 3 },
          attributes: { bold: true },
        },
      ]);

      const change = { cell: { ops: [{ delete: 2 }] } };
      const changed = new Delta().cut('e', 1).paste('e', 0, 1, change);
      expect(changed.ops).toEqual([
        { cut: { ref: 'e', length: 1 } },
        { paste: { ref: 'e', start: 0, length: 1, change } },
      ]);
    });

    it('rejects a multi-unit paste change', () => {
      expect(() =>
        new Delta().paste('e', 0, 2, { cell: { ops: [] } }),
      ).toThrowError(/must address one embed/);
    });

    it('push merges adjacent paste windows', () => {
      const delta = new Delta().paste('r', 0, 2).paste('r', 2, 8);
      expect(delta.ops).toEqual([
        { paste: { ref: 'r', start: 0, length: 10 } },
      ]);
    });

    it('push keeps non-adjacent windows', () => {
      const delta = new Delta().paste('r', 0, 2).paste('r', 5, 3);
      expect(delta.ops.length).toEqual(2);
    });

    it('owns constructor, push, and concat operations', () => {
      const source: Op[] = [{ insert: 'A' }];
      const constructed = new Delta(source).insert('B');
      source[0].insert = 'changed';
      expect(constructed.ops).toEqual([{ insert: 'AB' }]);

      const change = { cell: { ops: [] as Op[] } };
      const pushed = new Delta().paste('r', 0, 1, change);
      change.cell.ops.push({ insert: 'later' });
      expect(pushed.ops[0].paste!.change).toEqual({ cell: { ops: [] } });

      const tail = new Delta().insert('B').insert({ image: 'one.png' });
      const combined = new Delta().insert('A').concat(tail);
      (tail.ops[1].insert as { image: string }).image = 'two.png';
      expect(combined.ops[1].insert).toEqual({ image: 'one.png' });
    });

    it('changeLength counts the net effect of a move', () => {
      const delta = new Delta().cut('r', 10).retain(3).paste('r', 0, 4);
      expect(delta.changeLength()).toEqual(-6);
      expect(hasMoves(delta)).toBe(true);
    });

    it('check rejects invalid moves', () => {
      expect(() =>
        check(new Delta().cut('r', 3).retain(1).cut('r', 2).paste('r', 0, 3)),
      ).toThrow();
      expect(() => check(new Delta().paste('r', 0, 3))).toThrow();
      expect(() =>
        check(new Delta().cut('r', 3).paste('r', 0, 2).paste('r', 1, 2)),
      ).toThrow();
      expect(() => check(new Delta().cut('r', 3).paste('r', 2, 2))).toThrow();
      expect(() => check(new Delta().cut('r', 3))).toThrowError(/has no paste/);
      expect(() =>
        check(
          new Delta([
            { cut: { ref: 3 as unknown as string, length: 1 } },
            { paste: { ref: 3 as unknown as string, start: 0, length: 1 } },
          ]),
        ),
      ).toThrowError(/string reference/);
    });

    it('ignores moves hidden in opaque embed data', () => {
      const opaque = new Delta().insert({
        opaque: {
          ops: [
            { cut: { ref: 'not-a-move', length: 1 } },
            { paste: { ref: 'not-a-move', start: 0, length: 1 } },
          ],
        },
      });
      expect(hasMoves(opaque)).toBe(false);
      expect(check(opaque)).toBe(opaque);
      expect(opaque.lower(new Delta()).ops).toEqual(opaque.ops);
      expect(new Delta().transform(opaque).ops).toEqual(opaque.ops);
    });

    it('does not alpha-rename refs in opaque embed data', () => {
      const first = new Delta().cut('same', 1).paste('same', 0, 1);
      const opaque = {
        opaque: {
          ops: [{ paste: { ref: 'same', start: 0, length: 1 } }],
        },
      };
      const composed = first.compose(new Delta().retain(1).insert(opaque));
      expect(composed.ops[composed.ops.length - 1].insert).toEqual(opaque);
    });
  });

  describe('apply (compose with a document)', () => {
    it('moves content right', () => {
      const move = new Delta().cut('r', 10).retain(3).paste('r', 0, 10);
      expect(apply(doc('ABCDEFGHIJxyz'), move).document()).toEqual(
        'xyzABCDEFGHIJ',
      );
    });

    it('moves content left', () => {
      const move = new Delta().retain(3).paste('r', 0, 3).retain(4).cut('r', 3);
      expect(apply(doc('xxxyyyyABC'), move).document()).toEqual('xxxABCyyyy');
    });

    it('partial windows drop the gap', () => {
      const move = new Delta()
        .cut('r', 4)
        .retain(2)
        .paste('r', 0, 1)
        .paste('r', 3, 1);
      expect(apply(doc('ABCDxx'), move).document()).toEqual('xxAD');
    });

    it('paste attributes patch the content', () => {
      const base = new Delta().insert('AB', { bold: true }).insert('xx');
      const move = new Delta()
        .cut('r', 2)
        .retain(2)
        .paste('r', 0, 2, undefined, { bold: null, i: true });
      expect(apply(base, move).ops).toEqual([
        { insert: 'xx' },
        { insert: 'AB', attributes: { i: true } },
      ]);
    });

    it('moves embeds', () => {
      const base = new Delta().insert({ image: 'a.png' }).insert('xy');
      const move = new Delta().cut('r', 1).retain(2).paste('r', 0, 1);
      expect(apply(base, move).ops).toEqual([
        { insert: 'xy' },
        { insert: { image: 'a.png' } },
      ]);
    });
  });

  describe('compose', () => {
    it('keeps handler apply separate and contexts operation-specific', () => {
      type Fig = Record<string, number | null>;
      const calls = new Set<string>();
      const handler: EmbedHandler<Fig> = {
        apply: (value, change, context) => {
          calls.add(context.kind);
          const result = { ...value, ...change };
          Object.keys(result).forEach((key) => {
            if (result[key] == null) {
              delete result[key];
            }
          });
          return result;
        },
        compose: (first, second, context) => {
          calls.add(context.kind);
          return { ...first, ...second };
        },
        diff: (_base, target, context) => {
          calls.add(context.kind);
          return target;
        },
        transform: (_first, second, _priority, context) => {
          calls.add(context.kind);
          return second;
        },
        invert: (_change, base, context) => {
          calls.add(context.kind);
          return base;
        },
      };
      Delta.registerEmbed('fig', handler);
      try {
        const base = new Delta().insert({ fig: { keep: 1, drop: 2 } });
        expect(
          base.compose(new Delta().retain({ fig: { drop: null } })).ops,
        ).toEqual([{ insert: { fig: { keep: 1 } } }]);
        expect(
          new Delta()
            .retain({ fig: { drop: null } })
            .compose(new Delta().retain({ fig: { add: 3 } })).ops,
        ).toEqual([{ retain: { fig: { drop: null, add: 3 } } }]);
        new Delta()
          .insert({ fig: { keep: 1 } })
          .diff(new Delta().insert({ fig: { keep: 2 } }));
        new Delta()
          .retain({ fig: { keep: 1 } })
          .transform(new Delta().retain({ fig: { keep: 2 } }));
        new Delta()
          .retain({ fig: { keep: 2 } })
          .invert(new Delta().insert({ fig: { keep: 1 } }));
        expect([...calls].sort()).toEqual([
          'compose',
          'diff',
          'invert',
          'transform',
        ]);

        expect(() =>
          new Delta().compose(new Delta(), { kind: 'wrong' } as never),
        ).toThrowError(/compose/);
        expect(() =>
          new Delta().transform(new Delta(), false, { kind: 'wrong' } as never),
        ).toThrowError(/transform/);
        expect(() =>
          new Delta().invert(new Delta(), { kind: 'wrong' } as never),
        ).toThrowError(/invert/);
        expect(() =>
          new Delta().diff(new Delta(), undefined, { kind: 'wrong' } as never),
        ).toThrowError(/diff/);
      } finally {
        Delta.unregisterEmbed('fig');
      }
    });

    it('a later insert splits the paste window', () => {
      const move = new Delta().cut('r', 10).retain(3).paste('r', 0, 10);
      const edit = new Delta().retain(5).insert('test');
      const composed = move.compose(edit);
      expect(composed.ops).toEqual([
        { cut: { ref: 'r', length: 10 } },
        { retain: 3 },
        { paste: { ref: 'r', start: 0, length: 2 } },
        { insert: 'test' },
        { paste: { ref: 'r', start: 2, length: 8 } },
      ]);
      const base = doc('ABCDEFGHIJxyz');
      expect(apply(base, composed).ops).toEqual(
        apply(base, move).compose(edit).ops,
      );
    });

    it('a later delete splits the paste window', () => {
      const move = new Delta().cut('r', 10).retain(3).paste('r', 0, 10);
      const edit = new Delta().retain(4).delete(3);
      const composed = move.compose(edit);
      expect(composed.ops).toEqual([
        { cut: { ref: 'r', length: 10 } },
        { retain: 3 },
        { paste: { ref: 'r', start: 0, length: 1 } },
        { paste: { ref: 'r', start: 4, length: 6 } },
      ]);
    });

    it('a later format lands on the paste attributes', () => {
      const move = new Delta().cut('r', 10).retain(3).paste('r', 0, 10);
      const edit = new Delta().retain(3).retain(2, { bold: true });
      const composed = move.compose(edit);
      expect(composed.ops).toEqual([
        { cut: { ref: 'r', length: 10 } },
        { retain: 3 },
        {
          paste: { ref: 'r', start: 0, length: 2 },
          attributes: { bold: true },
        },
        { paste: { ref: 'r', start: 2, length: 8 } },
      ]);
    });

    it('deleting every window degrades the cut to a delete', () => {
      const move = new Delta().cut('r', 3).retain(3).paste('r', 0, 3);
      const edit = new Delta().retain(3).delete(3);
      expect(move.compose(edit).ops).toEqual([{ delete: 3 }]);
    });

    it('a cut carries an earlier insert to the paste site', () => {
      const first = new Delta().retain(2).insert('X');
      const second = new Delta()
        .retain(1)
        .cut('m', 4)
        .retain(2)
        .paste('m', 0, 4);
      const composed = first.compose(second);
      expect(composed.ops).toEqual([
        { retain: 1 },
        { cut: { ref: 'm', length: 3 } },
        { retain: 2 },
        { paste: { ref: 'm', start: 0, length: 1 } },
        { insert: 'X' },
        { paste: { ref: 'm', start: 1, length: 2 } },
      ]);
      expect(apply(doc('ABCDEF'), composed).document()).toEqual('AEFBXCD');
    });

    it('a cut absorbs an earlier delete', () => {
      const first = new Delta().retain(1).delete(2);
      const second = new Delta().cut('m', 2).retain(2).paste('m', 0, 2);
      const composed = first.compose(second);
      // the cut spans the deleted base characters, the windows skip them
      expect(composed.ops).toEqual([
        { cut: { ref: 'm', length: 4 } },
        { retain: 2 },
        { paste: { ref: 'm', start: 0, length: 1 } },
        { paste: { ref: 'm', start: 3, length: 1 } },
      ]);
    });

    it('a cut over a cut splits the later cut', () => {
      const first = new Delta()
        .retain(1)
        .cut('a', 2)
        .retain(1)
        .paste('a', 0, 2);
      const second = new Delta().cut('b', 4).retain(2).paste('b', 0, 4);
      const composed = first.compose(second);
      expect(composed.ops).toEqual([
        { cut: { ref: 'b', length: 1 } },
        { cut: { ref: 'a', length: 2 } },
        { cut: { ref: 'b:1', length: 1 } },
        { retain: 2 },
        { paste: { ref: 'b', start: 0, length: 1 } },
        { paste: { ref: 'b:1', start: 0, length: 1 } },
        { paste: { ref: 'a', start: 0, length: 2 } },
      ]);
      expect(apply(doc('ABCDEF'), composed).document()).toEqual('EFADBC');
    });

    it('a move of a pure insert needs no cut', () => {
      const first = new Delta().insert('XY');
      const second = new Delta().retain(1).cut('m', 1).paste('m', 0, 1);
      const composed = first.compose(second);
      expect(hasMoves(composed)).toBe(false);
      expect(composed.ops).toEqual([{ insert: 'XY' }]);
    });
  });

  describe('lower and invert', () => {
    it('lower matches move application', () => {
      const base = doc('ABCDEFGHIJxyz');
      const move = new Delta()
        .cut('r', 10)
        .retain(3)
        .paste('r', 0, 10, undefined, { bold: true });
      const lowered = move.lower(base);
      expect(hasMoves(lowered)).toBe(false);
      expect(apply(base, move).ops).toEqual(apply(base, lowered).ops);
    });

    it('invert is semantic', () => {
      const base = doc('ABCDEF');
      const move = new Delta().cut('r', 3).retain(3).paste('r', 0, 3);
      const inverted = move.invert(base);
      // the inverse is the opposite move, not a materialized delete/insert
      expect(inverted.ops).toEqual([
        { paste: { ref: 'r', start: 0, length: 3 } },
        { retain: 3 },
        { cut: { ref: 'r', length: 3 } },
      ]);
      expect(apply(base, move).compose(inverted).ops).toEqual(base.ops);
    });

    it('invert preserves an empty-attribute retain position', () => {
      const base = doc('ABC');
      const change = new Delta([
        { retain: 2, attributes: {} },
        { insert: 'x' },
      ]);
      const inverse = change.invert(base);
      expect(inverse.ops).toEqual([{ retain: 2 }, { delete: 1 }]);
      expect(apply(base, change).compose(inverse).ops).toEqual(base.ops);
    });

    it('invert restores dropped gaps and splits refs', () => {
      const base = doc('ABCDEFxx');
      const move = new Delta()
        .cut('r', 4)
        .retain(2)
        .paste('r', 0, 1)
        .retain(2)
        .paste('r', 3, 1);
      const inverted = move.invert(base);
      expect(hasMoves(inverted)).toBe(true);
      // the never-pasted middle 'BC' comes back as a literal insert
      expect(
        inverted.ops.some((op) => JSON.stringify(op) === '{"insert":"BC"}'),
      ).toBe(true);
      expect(apply(base, move).compose(inverted).ops).toEqual(base.ops);
    });

    it('invert reverts paste attribute patches', () => {
      const base = new Delta().insert('AB', { bold: true }).insert('xx');
      const move = new Delta()
        .cut('r', 2)
        .retain(2)
        .paste('r', 0, 2, undefined, { bold: null, i: true });
      const inverted = move.invert(base);
      expect(inverted.ops).toEqual([
        {
          paste: { ref: 'r', start: 0, length: 2 },
          attributes: { bold: true, i: null },
        },
        { retain: 2 },
        { cut: { ref: 'r', length: 2 } },
      ]);
      expect(apply(base, move).compose(inverted).ops).toEqual(base.ops);
    });
  });

  describe('transform', () => {
    it('routes a format to the paste site', () => {
      const move = new Delta().cut('r', 3).retain(3).paste('r', 0, 3);
      const edit = new Delta().retain(1).retain(1, { bold: true });
      expect(move.transform(edit, true).ops).toEqual([
        { retain: 4 },
        { retain: 1, attributes: { bold: true } },
      ]);
    });

    it('routes a delete to the paste site', () => {
      const move = new Delta().cut('r', 3).retain(3).paste('r', 0, 3);
      const edit = new Delta().retain(1).delete(1);
      expect(move.transform(edit, true).ops).toEqual([
        { retain: 4 },
        { delete: 1 },
      ]);
    });

    it('an insert in the source stays at the source', () => {
      const move = new Delta().cut('r', 3).retain(3).paste('r', 0, 3);
      const edit = new Delta().retain(1).insert('x');
      expect(move.transform(edit, true).ops).toEqual([{ insert: 'x' }]);
    });

    it('shrinks windows when the source is deleted', () => {
      const move = new Delta().cut('r', 3).retain(3).paste('r', 0, 3);
      const edit = new Delta().retain(1).delete(1);
      expect(edit.transform(move, false).ops).toEqual([
        { cut: { ref: 'r', length: 2 } },
        { retain: 3 },
        { paste: { ref: 'r', start: 0, length: 2 } },
      ]);
    });

    it('splits the cut around a concurrent insert', () => {
      const move = new Delta().cut('r', 3).retain(3).paste('r', 0, 3);
      const edit = new Delta().retain(1).insert('x');
      expect(edit.transform(move, false).ops).toEqual([
        { cut: { ref: 'r', length: 1 } },
        { retain: 1 },
        { cut: { ref: 'r:1', length: 2 } },
        { retain: 3 },
        { paste: { ref: 'r', start: 0, length: 1 } },
        { paste: { ref: 'r:1', start: 0, length: 2 } },
      ]);
    });

    it('concurrent same-source moves rebase', () => {
      const base = doc('ABCDEF');
      // both move BC: winner to the end, loser to the front
      const winner = new Delta()
        .retain(1)
        .cut('a', 2)
        .retain(3)
        .paste('a', 0, 2);
      const loser = new Delta().retain(1).paste('b', 0, 2).cut('b', 2);

      const loserPrime = winner.transform(loser, true);
      const winnerPrime = loser.transform(winner, false);
      // the loser's claim drops entirely
      expect(loserPrime.ops).toEqual([]);
      // the winner is rebased: it re-cuts BC out of the loser's paste site
      expect(winnerPrime.ops).toEqual([
        { retain: 1 },
        { cut: { ref: 'a', length: 2 } },
        { retain: 3 },
        { paste: { ref: 'a', start: 0, length: 2 } },
      ]);
      const one = apply(base, winner).compose(loserPrime);
      const two = apply(base, loser).compose(winnerPrime);
      expect(one.ops).toEqual(two.ops);
      expect(one.document()).toEqual('ADEFBC');
    });
  });

  describe('transformPosition', () => {
    it('follows moved content', () => {
      const move = new Delta().cut('r', 3).retain(3).paste('r', 0, 3); // ABCDEF -> DEFABC
      expect(move.transformPosition(1)).toEqual(4); // inside the moved span: follows
      expect(move.transformPosition(0)).toEqual(0); // at the region start: stays
      expect(move.transformPosition(4)).toEqual(1); // after the cut: shifts left
    });

    it('dropped content collapses', () => {
      const move = new Delta()
        .cut('r', 3)
        .retain(3)
        .paste('r', 0, 1)
        .paste('r', 2, 1);
      expect(move.transformPosition(1)).toEqual(0); // in the dropped gap
      expect(move.transformPosition(2)).toEqual(4); // in the second window
    });
  });

  describe('cross-level moves (cell embeds)', () => {
    interface CellPayload {
      ops: Op[];
    }

    const CellHandler: EmbedHandler<CellPayload> = {
      streamPaths: () => [['ops']],
      apply(a, b, context): CellPayload {
        return {
          ops: new Delta(a.ops).compose(new Delta(b.ops), context).ops,
        };
      },
      compose(a, b, context): CellPayload {
        return {
          ops: new Delta(a.ops).compose(new Delta(b.ops), context).ops,
        };
      },
      diff(a, b, context): CellPayload {
        return {
          ops: new Delta(a.ops).diff(new Delta(b.ops), undefined, context).ops,
        };
      },
      transform(a, b, priority, context): CellPayload {
        return {
          ops: new Delta(a.ops).transform(new Delta(b.ops), priority, context)
            .ops,
        };
      },
      invert(change, base, context): CellPayload {
        return {
          ops: new Delta(change.ops).invert(new Delta(base.ops), context).ops,
        };
      },
    };

    beforeEach(() => {
      Delta.registerEmbed('cell', CellHandler);
    });

    afterEach(() => {
      Delta.unregisterEmbed('cell');
    });

    const cell = (text: string): Record<string, unknown> => ({
      cell: { ops: [{ insert: text }] },
    });

    const cellPatch = (...ops: Op[]): Op => ({
      retain: { cell: { ops } },
    });

    it('applies a cell-to-root move', () => {
      const base = new Delta().insert('AB').insert(cell('Hello')).insert('CD');
      const move = new Delta([
        { retain: 2 },
        cellPatch({ cut: { ref: 'm', length: 5 } }),
        { retain: 1 },
        { paste: { ref: 'm', start: 0, length: 5 } },
      ]);
      expect(apply(base, move).ops).toEqual([
        { insert: 'AB' },
        { insert: { cell: { ops: [] } } },
        { insert: 'CHelloD' },
      ]);
      // same move with the paste ahead of the cut exercises the rerun
      const leftward = new Delta([
        { paste: { ref: 'm', start: 0, length: 5 } },
        { retain: 2 },
        cellPatch({ cut: { ref: 'm', length: 5 } }),
      ]);
      expect(apply(base, leftward).ops).toEqual([
        { insert: 'HelloAB' },
        { insert: { cell: { ops: [] } } },
        { insert: 'CD' },
      ]);
    });

    it('applies a root-to-cell move', () => {
      const base = new Delta().insert('AB').insert(cell('Hello')).insert('CD');
      const move = new Delta([
        { cut: { ref: 'm', length: 2 } },
        cellPatch({ retain: 5 }, { paste: { ref: 'm', start: 0, length: 2 } }),
      ]);
      expect(apply(base, move).ops).toEqual([
        { insert: { cell: { ops: [{ insert: 'HelloAB' }] } } },
        { insert: 'CD' },
      ]);
    });

    it('a later edit splits a cross-level paste', () => {
      const base = new Delta().insert('AB').insert(cell('Hello')).insert('CD');
      const move = new Delta([
        { retain: 2 },
        cellPatch({ cut: { ref: 'm', length: 5 } }),
        { retain: 1 },
        { paste: { ref: 'm', start: 0, length: 5 } },
      ]);
      const later = new Delta().retain(6).insert('X');
      const composed = move.compose(later);
      expect(composed.ops).toEqual([
        { retain: 2 },
        cellPatch({ cut: { ref: 'm', length: 5 } }),
        { retain: 1 },
        { paste: { ref: 'm', start: 0, length: 2 } },
        { insert: 'X' },
        { paste: { ref: 'm', start: 2, length: 3 } },
      ]);
      expect(apply(base, composed).ops).toEqual(
        apply(base, move).compose(later).ops,
      );
    });

    it('an earlier edit splits a window carried by a typed retain', () => {
      const base = new Delta()
        .insert('Hello ')
        .insert(cell('x'))
        .insert('World');
      const pre = new Delta().retain(2).insert('ZZ');
      const move = new Delta([
        { cut: { ref: 'm', length: 5 } },
        { retain: 3 },
        cellPatch({ retain: 1 }, { paste: { ref: 'm', start: 0, length: 5 } }),
      ]);
      const combo = pre.compose(move);
      expect(apply(apply(base, pre), move).ops).toEqual(apply(base, combo).ops);
      const payload = (
        combo.ops[combo.ops.length - 1].retain as { cell: { ops: Op[] } }
      ).cell.ops;
      expect(payload).toContain({ insert: 'ZZ' });
    });

    it('expands a nested child move exactly once', () => {
      const base = new Delta().insert({
        cell: { ops: [{ insert: cell('AB') }, { insert: 'x' }] },
      });
      const axisMove: Op[] = [
        { paste: { ref: 'axis', start: 0, length: 1 } },
        { retain: 1 },
        { cut: { ref: 'axis', length: 1 } },
      ];
      const first = new Delta([cellPatch(cellPatch(...axisMove))]);
      const second = new Delta([
        cellPatch(
          { cut: { ref: 'block', length: 1 } },
          { retain: 1 },
          { paste: { ref: 'block', start: 0, length: 1 } },
        ),
      ]);

      const composed = first.compose(second);

      check(composed);
      const content = (composed.ops[0].retain as { cell: { ops: Op[] } }).cell
        .ops;
      const carried = content[2].paste!.change as { cell: { ops: Op[] } };
      expect(carried.cell.ops).toEqual(axisMove);
      expect(apply(base, composed).ops).toEqual(
        apply(apply(base, first), second).ops,
      );
    });

    it('expands a window riding a paste change', () => {
      // B moves content into a cell that A itself moves: B's window
      // rides the change payload of A's paste and must re-slice through
      // B's cut
      const base = new Delta().insert('eg').insert(cell('cd')).insert('cb');
      const A = new Delta([
        { paste: { ref: 'a', start: 0, length: 2 } },
        { retain: 2 },
        { cut: { ref: 'a', length: 3 } },
        { paste: { ref: 'a', start: 2, length: 1 } },
      ]);
      const B = new Delta([
        cellPatch({ retain: 1 }, { paste: { ref: 'b', start: 0, length: 1 } }),
        { cut: { ref: 'b', length: 1 } },
      ]);
      const AB = A.compose(B);
      check(AB);
      expect(apply(base, AB).ops).toEqual(apply(apply(base, A), B).ops);
    });

    it('discovers a cut riding another paste change', () => {
      const base = new Delta().insert('AB').insert(cell('Hello')).insert('CD');
      const outer = new Delta()
        .retain(2)
        .cut('c', 1)
        .retain(2)
        .paste('c', 0, 1);
      const inner = new Delta([
        { paste: { ref: 'm', start: 0, length: 2 } },
        { retain: 4 },
        cellPatch({ cut: { ref: 'm', length: 2 } }),
      ]);
      const combo = outer.compose(inner);
      for (const priority of [true, false]) {
        expect(combo.transform(new Delta(), priority).ops).toEqual([]);
        const edit = new Delta([
          { retain: 2 },
          cellPatch({ retain: 1, attributes: { bold: true } }),
        ]);
        const editPrime = combo.transform(edit, priority);
        const comboPrime = edit.transform(combo, !priority);
        expect(apply(base, combo).compose(editPrime).ops).toEqual(
          apply(base, edit).compose(comboPrime).ops,
        );
      }

      const intoChange = new Delta([
        { cut: { ref: 'm', length: 2 } },
        { retain: 2 },
        cellPatch({ retain: 5 }, { paste: { ref: 'm', start: 0, length: 2 } }),
      ]);
      const nested = outer.compose(intoChange);
      const format = new Delta().retain(1, { bold: true });
      for (const priority of [true, false]) {
        const formatPrime = nested.transform(format, priority);
        const nestedPrime = format.transform(nested, !priority);
        expect(apply(base, nested).compose(formatPrime).ops).toEqual(
          apply(base, format).compose(nestedPrime).ops,
        );
      }
    });

    it('visits only handler-declared child streams', () => {
      const nested = new Delta().insert({
        cell: {
          ops: [
            { cut: { ref: 'real', length: 1 } },
            { paste: { ref: 'real', start: 0, length: 1 } },
          ],
          metadata: {
            ops: [{ cut: { ref: 'opaque', length: 1 } }],
          },
        },
      });
      expect(hasMoves(nested)).toBe(true);
      expect(check(nested)).toBe(nested);
    });

    it('never expands handler-composed windows twice', () => {
      // A moves a unit out of the cell; B moves root content (including
      // A's window) back in.  The cell patches compose through the
      // handler, which already expands B's window — the assemble pass
      // must treat that payload as sealed
      const base = new Delta().insert('cg').insert(cell('bbb')).insert('ga');
      const A = new Delta([
        { retain: 2 },
        cellPatch({ retain: 2 }, { cut: { ref: 'a', length: 1 } }),
        { paste: { ref: 'a', start: 0, length: 1 } },
      ]);
      const B = new Delta([
        { retain: 2 },
        cellPatch({ retain: 1 }, { paste: { ref: 'b', start: 0, length: 3 } }),
        { cut: { ref: 'b', length: 3 } },
      ]);
      const AB = A.compose(B);
      check(AB);
      expect(apply(base, AB).ops).toEqual(apply(apply(base, A), B).ops);
    });

    it('expands a passed-through sibling window', () => {
      // A handler may compose one child lane and pass a sibling through
      // verbatim: the owner's recursive expansion must still reach the
      // passed-through lane (regression from a real 104-revision
      // history chain; fixture by codex)
      interface Lanes {
        left?: { ops: Op[] };
        right?: { ops: Op[] };
      }
      const combineLanes = (
        a: Lanes,
        b: Lanes,
        context: Parameters<EmbedHandler<Lanes>['compose']>[2],
      ): Lanes => {
        const result: Lanes = {};
        for (const lane of ['left', 'right'] as const) {
          const aLane = a[lane];
          const bLane = b[lane];
          if (aLane && bLane) {
            result[lane] = {
              ops: new Delta(aLane.ops.slice()).compose(
                new Delta(bLane.ops.slice()),
                context,
              ).ops,
            };
          } else if (bLane) {
            result[lane] = bLane;
          } else if (aLane) {
            result[lane] = aLane;
          }
        }
        return result;
      };
      const LanesHandler: EmbedHandler<Lanes> = {
        streamPaths: (value) =>
          (['left', 'right'] as const)
            .filter((lane) => value[lane] != null)
            .map((lane) => [lane, 'ops']),
        apply: combineLanes,
        compose: combineLanes,
        diff(): Lanes {
          throw new Error('not used in this test');
        },
        transform(): Lanes {
          throw new Error('not used in this test');
        },
        invert(): Lanes {
          throw new Error('not used in this test');
        },
      };

      Delta.registerEmbed('lanes', LanesHandler);
      try {
        const base = new Delta().insert({
          lanes: {
            left: { ops: [{ insert: 'A' }] },
            right: { ops: [{ insert: 'B' }] },
          },
        });
        const first = new Delta([
          {
            retain: {
              lanes: { right: { ops: [{ insert: 'X' }, { delete: 1 }] } },
            },
          },
        ]);
        const second = new Delta([
          {
            retain: {
              lanes: {
                left: {
                  ops: [
                    { paste: { ref: 'm', start: 0, length: 1 } },
                    { delete: 1 },
                  ],
                },
                right: { ops: [{ cut: { ref: 'm', length: 1 } }] },
              },
            },
          },
        ]);

        const composed = first.compose(second);

        check(composed);
        expect(hasMoves(composed)).toBe(false);
        expect(apply(base, composed).ops).toEqual(
          apply(base, first).compose(second).ops,
        );
      } finally {
        Delta.unregisterEmbed('lanes');
      }
    });

    it('fuzz: symbolic outputs stay valid', () => {
      // check() every symbolic compose, composed-inverse (undo) and
      // transform output — the class of bug where each step applies but
      // a nested window gets expanded twice along the way
      const rng = new Rng(91);
      const LETTERS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
      const FUZZ_ATTRS: (Record<string, unknown> | null)[] = [
        null,
        null,
        { bold: true },
        { bold: null },
        { italic: true },
      ];
      const text = (low: number, high: number): string =>
        Array.from({ length: rng.randint(low, high) }, () =>
          rng.choice(LETTERS),
        ).join('');
      const twoCellBase = (): Delta =>
        new Delta()
          .insert(text(1, 3))
          .insert(cell(text(2, 5)))
          .insert(text(1, 3))
          .insert(cell(text(2, 5)))
          .insert(text(1, 3));

      // (root position, content length) of every cell in the document
      const cellSites = (document: Delta): [number, number][] => {
        const sites: [number, number][] = [];
        let position = 0;
        for (const operation of document.ops) {
          const insert = operation.insert;
          if (
            typeof insert === 'object' &&
            insert !== null &&
            'cell' in insert
          ) {
            const ops = (insert as { cell: { ops: Op[] } }).cell.ops;
            sites.push([
              position,
              ops.reduce(
                (sum, o) =>
                  sum + (typeof o.insert === 'string' ? o.insert.length : 1),
                0,
              ),
            ]);
          }
          position += Op.length(operation);
        }
        return sites;
      };

      // cut in one cell's child sequence, paste in a sibling cell's
      const randomCellToCellMove = (
        document: Delta,
        ref: string,
      ): Delta | null => {
        const sites = cellSites(document);
        if (sites.length < 2) {
          return null;
        }
        const src = rng.randint(0, sites.length - 1);
        let dst = rng.randint(0, sites.length - 2);
        if (dst >= src) {
          dst += 1;
        }
        const [srcPos, srcLen] = sites[src];
        const [dstPos, dstLen] = sites[dst];
        if (srcLen < 1) {
          return null;
        }
        const size = rng.randint(1, Math.min(3, srcLen));
        const offset = rng.randint(0, srcLen - size);
        const target = rng.randint(0, dstLen);
        const attrs = rng.choice(FUZZ_ATTRS);
        const cutOp = cellPatch(...(offset ? [{ retain: offset }] : []), {
          cut: { ref, length: size },
        });
        let pasteInner: Op = { paste: { ref, start: 0, length: size } };
        if (attrs) {
          pasteInner = { ...pasteInner, attributes: { ...attrs } };
        }
        const pasteOp = cellPatch(
          ...(target ? [{ retain: target }] : []),
          pasteInner,
        );
        const pair: [number, Op][] = [
          [srcPos, cutOp],
          [dstPos, pasteOp],
        ];
        pair.sort((a, b) => a[0] - b[0]);
        const [[firstPos, first], [secondPos, second]] = pair;
        return new Delta()
          .retain(firstPos)
          .push(first)
          .retain(secondPos - firstPos - 1)
          .push(second);
      };

      const randomOrdinary = (length: number): Delta => {
        const delta = new Delta();
        let position = 0;
        while (position < length) {
          const choice = rng.random();
          const span = rng.randint(1, Math.min(3, length - position));
          if (choice < 0.3) {
            delta.retain(span);
          } else if (choice < 0.55) {
            delta.retain(span, rng.choice(FUZZ_ATTRS.slice(2)));
          } else if (choice < 0.8) {
            delta.delete(span);
          } else {
            delta.insert('X'.repeat(rng.randint(1, 2)));
            continue;
          }
          position += span;
        }
        if (rng.random() < 0.4) {
          delta.insert('Z');
        }
        return delta;
      };

      // ordinary edits inside each cell; root text is retained
      const randomTwoCellEdit = (document: Delta): Delta => {
        const delta = new Delta();
        for (const operation of document.ops) {
          const insert = operation.insert;
          if (typeof insert === 'object' && insert !== null) {
            const ops = (insert as { cell: { ops: Op[] } }).cell.ops;
            const inner = ops.reduce(
              (sum, o) =>
                sum + (typeof o.insert === 'string' ? o.insert.length : 1),
              0,
            );
            if (rng.random() < 0.6 && inner) {
              const child = randomOrdinary(inner);
              delta.push({ retain: { cell: { ops: child.ops } } });
            } else {
              delta.retain(1);
            }
          } else {
            delta.retain(Op.length(operation));
          }
        }
        return delta;
      };

      for (let iteration = 0; iteration < 100; iteration++) {
        const base = twoCellBase();
        const A = randomCellToCellMove(base, 'a')!;
        const afterA = apply(base, A);
        const B = randomCellToCellMove(afterA, 'b');
        if (B === null) {
          continue;
        }
        const AB = A.compose(B);
        check(AB);
        expect(apply(base, AB).ops).toEqual(apply(afterA, B).ops);
        const undo = B.invert(afterA).compose(A.invert(base));
        check(undo);
        expect(apply(apply(base, AB), undo).ops).toEqual(base.ops);
        const edit = randomTwoCellEdit(base);
        for (const priority of [true, false]) {
          const aPrime = edit.transform(A, !priority) as Delta;
          const ePrime = A.transform(edit, priority) as Delta;
          check(aPrime);
          check(ePrime);
        }
      }
    });

    it('moves between two sibling cells and follows source edits', () => {
      const base = new Delta().insert(cell('one')).insert(cell('two'));
      const move = new Delta([
        cellPatch({ cut: { ref: 'x', length: 3 } }),
        cellPatch({ retain: 3 }, { paste: { ref: 'x', start: 0, length: 3 } }),
      ]);
      expect(apply(base, move).ops).toEqual([
        { insert: { cell: { ops: [] } } },
        { insert: { cell: { ops: [{ insert: 'twoone' }] } } },
      ]);
      const edit = new Delta([
        cellPatch({ retain: 3, attributes: { bold: true } }),
      ]);
      for (const priority of [true, false]) {
        const movePrime = edit.transform(move, !priority);
        const editPrime = move.transform(edit, priority);
        const left = apply(apply(base, move), editPrime as Delta);
        const right = apply(apply(base, edit), movePrime as Delta);
        expect(left.ops).toEqual(right.ops);
        expect(left.ops).toEqual([
          { insert: { cell: { ops: [] } } },
          {
            insert: {
              cell: {
                ops: [
                  { insert: 'two' },
                  { insert: 'one', attributes: { bold: true } },
                ],
              },
            },
          },
        ]);
      }
    });

    it('a cell-to-cell move inverts to a move', () => {
      const base = new Delta().insert(cell('one')).insert(cell('two'));
      const move = new Delta([
        cellPatch({ cut: { ref: 'x', length: 3 } }),
        cellPatch({ retain: 3 }, { paste: { ref: 'x', start: 0, length: 3 } }),
      ]);
      const inverse = move.invert(base);
      expect(apply(base, move).compose(inverse).ops).toEqual(base.ops);
      expect(hasMoves(inverse)).toBe(true);
    });

    it('a later edit splits a cell-to-cell paste', () => {
      const base = new Delta().insert(cell('one')).insert(cell('two'));
      const move = new Delta([
        cellPatch({ cut: { ref: 'x', length: 3 } }),
        cellPatch({ retain: 3 }, { paste: { ref: 'x', start: 0, length: 3 } }),
      ]);
      const later = new Delta([
        { retain: 1 },
        cellPatch({ retain: 4 }, { insert: '!' }),
      ]);
      const composed = move.compose(later);
      expect(apply(base, composed).ops).toEqual(
        apply(base, move).compose(later).ops,
      );
      const payload = (
        composed.ops[composed.ops.length - 1].retain as {
          cell: { ops: Op[] };
        }
      ).cell.ops;
      expect(payload).toContain({ insert: '!' });
    });

    it('deleting a sourcing embed composes into a trash read', () => {
      const base = new Delta().insert('AB').insert(cell('Hello')).insert('CD');
      const move = new Delta([
        { retain: 2 },
        cellPatch({ retain: 1 }, { cut: { ref: 'm', length: 3 } }),
        { retain: 1 },
        { paste: { ref: 'm', start: 0, length: 3 } },
      ]);
      const later = new Delta().retain(2).delete(1); // delete the emptied cell
      const composed = move.compose(later);
      // the deletion became a trash cut; the paste reads through it by path
      expect(composed.ops).toEqual([
        { retain: 2 },
        { cut: { ref: 'trash', length: 1 } },
        { retain: 1 },
        {
          paste: {
            ref: 'trash',
            unit: 0,
            path: ['ops'],
            start: 1,
            length: 3,
          },
        },
      ]);
      const after = apply(base, move).compose(later);
      expect(after.ops).toEqual(apply(base, composed).ops);
      expect(after.document()).toEqual('ABCellD');
      // and the trashed composition still inverts
      expect(apply(base, composed).compose(composed.invert(base)).ops).toEqual(
        base.ops,
      );
    });

    it('avoids a user ref when minting a trash cut', () => {
      const base = new Delta().insert('QX').insert(cell('AB')).insert('Y');
      const first = new Delta([
        { cut: { ref: 'trash', length: 1 } },
        { paste: { ref: 'trash', start: 0, length: 1 } },
        { retain: 1 },
        cellPatch({ cut: { ref: 'm', length: 2 } }),
        { retain: 1 },
        { paste: { ref: 'm', start: 0, length: 2 } },
      ]);
      const later = new Delta().retain(2).delete(1);
      const composed = first.compose(later);
      const refs = composed.ops
        .filter((operation) => operation.cut != null)
        .map((operation) => operation.cut!.ref);
      expect(new Set(refs).size).toEqual(refs.length);
      expect(apply(base, composed).ops).toEqual(
        apply(base, first).compose(later).ops,
      );
      expect(() => check(composed)).not.toThrow();
    });

    it('preserves a move source inside a retained embed', () => {
      const base = new Delta().insert('X').insert(cell('AB')).insert('Y');
      const first = new Delta([
        { retain: 1 },
        cellPatch({ cut: { ref: 'm', length: 2 } }),
        { retain: 1 },
        { paste: { ref: 'm', start: 0, length: 2 } },
      ]);
      const later = new Delta().cut('b', 3).retain(2).paste('b', 0, 1);
      const composed = first.compose(later);
      expect(apply(base, composed).ops).toEqual(
        apply(base, first).compose(later).ops,
      );
      expect(apply(base, composed).document()).toEqual('ABX');
      expect(
        composed.ops.some(
          (operation) =>
            operation.paste?.path &&
            JSON.stringify(operation.paste.path) === '["ops"]',
        ),
      ).toBe(true);
      expect(() => check(composed)).not.toThrow();
    });

    it('rejects deleting an inserted embed that still sources a move', () => {
      const first = new Delta([
        {
          insert: {
            cell: { ops: [{ cut: { ref: 'm', length: 1 } }] },
          },
        },
        { paste: { ref: 'm', start: 0, length: 1 } },
      ]);
      expect(() => first.compose(new Delta().delete(1))).toThrowError(
        /deletion of an embed that still sources a move/,
      );
    });

    it('uses stream offsets, not array indexes, in nested trash paths', () => {
      const inner = cell('AB');
      const outer = {
        cell: {
          ops: [{ insert: 'abc' }, { insert: inner }, { insert: 'Y' }],
        },
      };
      const base = new Delta().insert('X').insert(outer).insert('Z');
      const read = new Delta([
        { cut: { ref: 'b', length: 3 } },
        {
          paste: {
            ref: 'b',
            start: 0,
            length: 2,
            unit: 1,
            path: ['ops', 3, 'ops'],
          },
        },
        { paste: { ref: 'b', start: 0, length: 1 } },
      ]);
      const edit = new Delta([
        { retain: 1 },
        cellPatch(
          { retain: 3 },
          cellPatch({ retain: 1, attributes: { bold: true } }),
        ),
      ]);
      expect(apply(base, read).document()).toEqual('ABX');
      for (const priority of [true, false]) {
        const editPrime = read.transform(edit, priority);
        const readPrime = edit.transform(read, !priority);
        expect(apply(base, read).compose(editPrime).ops).toEqual(
          apply(base, edit).compose(readPrime).ops,
        );
      }
    });

    it('a cell edit routes to the root paste site', () => {
      const move = new Delta([
        { retain: 2 },
        cellPatch({ cut: { ref: 'm', length: 5 } }),
        { retain: 1 },
        { paste: { ref: 'm', start: 0, length: 5 } },
      ]);
      const edit = new Delta([
        { retain: 2 },
        cellPatch({ retain: 1 }, { retain: 2, attributes: { bold: true } }),
      ]);
      const routed = move.transform(edit, true);
      // the format lands at the root paste site (position 5 after the move),
      // not inside the emptied cell; the cell patch itself becomes a no-op
      expect(routed.ops).toEqual([
        { retain: 2 },
        { retain: { cell: { ops: [] } } },
        { retain: 2 },
        { retain: 2, attributes: { bold: true } },
      ]);
    });
  });

  describe('coordinates', () => {
    it('maps through a paste change built by the public API', () => {
      const move = new Delta()
        .retain(2)
        .cut('e', 1)
        .retain(1)
        .paste('e', 0, 1, { cell: { ops: [{ delete: 2 }] } });
      expect(transformCoordinate(move, [2, 'ops', 3])).toEqual([3, 'ops', 1]);
    });

    it('a root caret matches transformPosition', () => {
      const move = new Delta().cut('r', 3).retain(3).paste('r', 0, 3);
      for (let index = 0; index < 7; index++) {
        expect(transformCoordinate(move, [index])).toEqual([
          move.transformPosition(index),
        ]);
      }
    });

    it('an embed unit follows a root move', () => {
      // embed at position 2 moves to the front
      const move = new Delta().paste('r', 0, 1).retain(2).cut('r', 1);
      expect(transformCoordinate(move, [2, 'ops', 1])).toEqual([0, 'ops', 1]);
    });

    it('a unit dies with its embed', () => {
      expect(
        transformCoordinate(new Delta().retain(2).delete(1), [2, 'ops', 1]),
      ).toBeNull();
      const dropped = new Delta().retain(2).cut('r', 2).paste('r', 1, 1);
      expect(transformCoordinate(dropped, [2, 'ops', 1])).toBeNull();
      // while a caret merely collapses
      expect(transformCoordinate(new Delta().retain(2).delete(3), [4])).toEqual(
        [2],
      );
    });
  });
});
