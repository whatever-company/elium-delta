import Delta from '../src/Delta';
import { EmbedHandler, hasMoves } from '../src/moves';

// Contract tests for the deterministic typed snapshot diff (src/diff.ts),
// ported from the Python reference battery (tests/test_snapshot_diff.py).

const GRINNING = '\u{1F600}';
const LETTERS = ['a', 'b', 'c', 'd', GRINNING];
const ATTRS: (Record<string, unknown> | null)[] = [
  null,
  { bold: true },
  { bold: true, i: 1 },
  { i: 2 },
];

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

const fig = (n: number): Record<string, unknown> => ({
  fig: { src: `${n}.png` },
});

const randomDoc = (rng: Rng): Delta => {
  const doc = new Delta();
  const count = rng.randint(0, 6);
  for (let index = 0; index < count; index += 1) {
    if (rng.random() < 0.25) {
      doc.insert(fig(rng.randint(1, 3)));
      continue;
    }
    let text = '';
    const size = rng.randint(1, 4);
    for (let unit = 0; unit < size; unit += 1) {
      text += rng.choice(LETTERS);
    }
    doc.insert(text, rng.choice(ATTRS) ?? undefined);
  }
  return doc;
};

type FigPayload = { src: string };

// A diff-capable embed handler that counts its diff calls.
class RecordingHandler implements EmbedHandler<FigPayload> {
  calls = 0;

  apply(_a: FigPayload, b: FigPayload): FigPayload {
    return b;
  }

  compose(_a: FigPayload, b: FigPayload): FigPayload {
    return b;
  }

  transform(_a: FigPayload, b: FigPayload): FigPayload {
    return b;
  }

  invert(_change: FigPayload, base: FigPayload): FigPayload {
    return base;
  }

  diff(_a: FigPayload, b: FigPayload): FigPayload | null | undefined {
    this.calls += 1;
    return { src: b.src };
  }
}

describe('snapshot diff', () => {
  let figHandler: RecordingHandler;

  beforeEach(() => {
    figHandler = new RecordingHandler();
    Delta.registerEmbed('fig', figHandler);
  });

  afterEach(() => {
    Delta.unregisterEmbed('fig');
  });

  it('fuzz reconstruction', () => {
    const rng = new Rng(70);
    for (let round = 0; round < 500; round += 1) {
      const a = randomDoc(rng);
      const b = randomDoc(rng);
      expect(a.compose(a.diff(b))).toEqual(b);
    }
  });

  it('equal documents yield an empty delta', () => {
    const doc = new Delta()
      .insert('a', { bold: true })
      .insert(fig(1))
      .insert('b');
    const same = new Delta()
      .insert('a', { bold: true })
      .insert(fig(1))
      .insert('b');
    expect(doc.diff(same)).toEqual(new Delta());
    expect(figHandler.calls).toEqual(0);
  });

  it('deterministic repeated runs', () => {
    const rng = new Rng(71);
    for (let round = 0; round < 100; round += 1) {
      const a = randomDoc(rng);
      const b = randomDoc(rng);
      const first = a.diff(b);
      for (let again = 0; again < 3; again += 1) {
        expect(a.diff(b)).toEqual(first);
      }
    }
  });

  it('chunking independence', () => {
    const whole = new Delta([{ insert: 'hello world' }]);
    const chunked = new Delta([
      { insert: 'hel' },
      { insert: 'lo wo' },
      { insert: 'rld' },
    ]);
    const target = new Delta().insert('hello brave world');
    expect(whole.diff(target)).toEqual(chunked.diff(target));
    expect(chunked.compose(chunked.diff(target))).toEqual(target);
  });

  it('object key order independence', () => {
    const a = new Delta([{ insert: { fig: { x: 1, y: 2 } } }]);
    const b = new Delta([{ insert: { fig: { y: 2, x: 1 } } }]);
    expect(a.diff(b)).toEqual(new Delta());
  });

  it('NUL text never aligns with an embed', () => {
    const a = new Delta().insert('\0');
    const b = new Delta().insert(fig(1));
    const d = a.diff(b);
    expect(d).toEqual(new Delta().insert(fig(1)).delete(1));
    expect(a.compose(d)).toEqual(b);
  });

  it('formatting one surrogate half', () => {
    const doc = new Delta().insert(GRINNING);
    const half = doc.compose(new Delta().retain(1, { bold: true }));
    const d = doc.diff(half);
    expect(doc.compose(d)).toEqual(half);
    expect(half.compose(half.diff(doc))).toEqual(doc);
  });

  it('unchanged embed never calls the handler', () => {
    const a = new Delta().insert('x').insert(fig(1)).insert('y');
    const b = new Delta().insert('xx').insert(fig(1));
    a.diff(b);
    expect(figHandler.calls).toEqual(0);
  });

  it('changed embed calls the handler once', () => {
    const a = new Delta().insert(fig(1));
    const b = new Delta().insert(fig(2));
    const d = a.diff(b);
    expect(figHandler.calls).toEqual(1);
    expect(d.ops).toEqual([{ retain: { fig: { src: '2.png' } } }]);
  });

  it('embed attribute patch rides the retain', () => {
    const a = new Delta().insert(fig(1), { bold: true });
    const b = new Delta().insert(fig(2));
    const d = a.diff(b);
    expect(d.ops).toEqual([
      { retain: { fig: { src: '2.png' } }, attributes: { bold: null } },
    ]);
  });

  it('different embed types replace', () => {
    const a = new Delta().insert({ image: '1.png' });
    const b = new Delta().insert({ video: '1.mp4' });
    const d = a.diff(b);
    expect(d).toEqual(new Delta().insert({ video: '1.mp4' }).delete(1));
  });

  it('missing handler replaces', () => {
    const a = new Delta().insert({ image: '1.png' });
    const b = new Delta().insert({ image: '2.png' });
    const d = a.diff(b);
    expect(d).toEqual(new Delta().insert({ image: '2.png' }).delete(1));
  });

  it('handler null for unequal is an error', () => {
    class NoneHandler extends RecordingHandler {
      diff(): null {
        return null;
      }
    }
    Delta.registerEmbed('fig', new NoneHandler());
    expect(() =>
      new Delta().insert(fig(1)).diff(new Delta().insert(fig(2))),
    ).toThrowError(/equality only/);
  });

  it('handler undefined requests replacement', () => {
    class OptOutHandler extends RecordingHandler {
      diff(): undefined {
        return undefined;
      }
    }
    Delta.registerEmbed('fig', new OptOutHandler());
    const d = new Delta().insert(fig(1)).diff(new Delta().insert(fig(2)));
    expect(d).toEqual(new Delta().insert(fig(2)).delete(1));
  });

  it('handler patch with moves is an error', () => {
    class MovingHandler extends RecordingHandler {
      streamPaths(value: FigPayload): string[][] {
        return Array.isArray((value as unknown as { ops?: unknown }).ops)
          ? [['ops']]
          : [];
      }

      diff(): FigPayload {
        return {
          ops: [
            { cut: { ref: 'r', length: 1 } },
            { paste: { ref: 'r', start: 0, length: 1 } },
          ],
        } as unknown as FigPayload;
      }
    }
    Delta.registerEmbed('fig', new MovingHandler());
    expect(() =>
      new Delta().insert(fig(1)).diff(new Delta().insert(fig(2))),
    ).toThrowError(/cut or paste/);
  });

  it('diff never emits moves', () => {
    const rng = new Rng(72);
    for (let round = 0; round < 200; round += 1) {
      const a = randomDoc(rng);
      const b = randomDoc(rng);
      expect(hasMoves(a.diff(b))).toBe(false);
    }
  });

  it('repeated embeds retain the exact match', () => {
    const a = new Delta().insert(fig(1)).insert(fig(2));
    const b = new Delta().insert(fig(2)).insert(fig(3));
    const d = a.diff(b);
    // the exact fig(2) is retained; never patch 1->2 and 2->3
    expect(d.ops).toEqual([{ delete: 1 }, { retain: 1 }, { insert: fig(3) }]);
    expect(figHandler.calls).toEqual(0);
    expect(a.compose(d)).toEqual(b);
  });

  it('ambiguous repeated text reconstructs deterministically', () => {
    const a = new Delta().insert('aaaa');
    const b = new Delta().insert('aaa');
    const first = a.diff(b);
    expect(a.compose(first)).toEqual(b);
    expect(a.diff(b)).toEqual(first);
  });

  // ── cursor hint ──

  it('cursor anchors an ambiguous insert', () => {
    const a = new Delta().insert('xaaay');
    const b = new Delta().insert('xaaaay');
    expect(a.diff(b).ops).toEqual([{ retain: 4 }, { insert: 'a' }]);
    for (const cursor of [1, 2, 3, 4]) {
      const d = a.diff(b, cursor);
      expect(d.ops).toEqual([{ retain: cursor }, { insert: 'a' }]);
      expect(a.compose(d)).toEqual(b);
    }
  });

  it('cursor anchors an ambiguous delete', () => {
    const a = new Delta().insert('xaaaay');
    const b = new Delta().insert('xaaay');
    for (const cursor of [1, 2, 3, 4]) {
      const d = a.diff(b, cursor);
      expect(d.ops).toEqual([{ retain: cursor }, { delete: 1 }]);
      expect(a.compose(d)).toEqual(b);
    }
  });

  it('cursor blocked by a format boundary', () => {
    const a = new Delta().insert('xa').insert('a', { bold: true }).insert('ay');
    const b = new Delta()
      .insert('xa')
      .insert('a', { bold: true })
      .insert('aay');
    const d = a.diff(b, 1);
    expect(d.ops[0].retain).toEqual(4); // canonical placement kept
    expect(a.compose(d)).toEqual(b);
  });

  it('cursor anchors within an emoji run', () => {
    const a = new Delta().insert(GRINNING.repeat(2));
    const b = new Delta().insert(GRINNING.repeat(3));
    const d = a.diff(b, 2); // a valid pair boundary
    expect(d.ops).toEqual([{ retain: 2 }, { insert: GRINNING }]);
    // a cursor inside a surrogate pair cannot anchor: canonical stays
    const mid = a.diff(b, 1);
    expect(a.compose(mid)).toEqual(b);
    expect(mid.ops[0].retain).toEqual(4);
  });

  it('cursor anchors past a typed embed retain', () => {
    // a typed embed patch before the edit consumes one unit, not a dict
    const a = new Delta().insert(fig(1)).insert('xaaay');
    const b = new Delta().insert(fig(2)).insert('xaaaay');
    for (const cursor of [2, 3, 4, 5]) {
      const d = a.diff(b, cursor);
      expect(a.compose(d)).toEqual(b);
      expect(d.ops[1]).toEqual({ retain: cursor - 1 });
    }
  });

  it('fuzz cursor hint preserves the law', () => {
    const rng = new Rng(74);
    for (let round = 0; round < 300; round += 1) {
      let x = '';
      let y = '';
      const xSize = rng.randint(0, 8);
      for (let unit = 0; unit < xSize; unit += 1) {
        x += rng.choice(LETTERS);
      }
      const ySize = rng.randint(0, 8);
      for (let unit = 0; unit < ySize; unit += 1) {
        y += rng.choice(LETTERS);
      }
      const a = x ? new Delta().insert(x) : new Delta();
      const b = y ? new Delta().insert(y) : new Delta();
      const cursor = rng.randint(0, a.length() + 1);
      const d = a.diff(b, cursor);
      expect(a.compose(d)).toEqual(b);
      expect(a.diff(b, cursor)).toEqual(d);
    }
  });
});
