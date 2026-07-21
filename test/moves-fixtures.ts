import * as fs from 'fs';
import * as path from 'path';
import cloneDeep = require('lodash.clonedeep');
import Delta from '../src/Delta';
import Op from '../src/Op';
import { transformCoordinate } from '../src/coords';
import { EmbedHandler } from '../src/moves';

// Golden fixtures generated from the Python reference implementation:
// expected values are exact op arrays, asserted with deep equality.

interface FixtureCase {
  handlers?: string[];
  [key: string]: unknown;
}

const load = (name: string): FixtureCase[] =>
  JSON.parse(
    fs.readFileSync(
      path.join(__dirname, 'fixtures', 'moves', `${name}.json`),
      'utf8',
    ),
  ).tests;

// The reference cell handler: an embed whose payload carries a child
// `ops` sequence run through the move-aware Delta, joining the
// enclosing compose/transform/invert transaction at any depth.
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
      ops: new Delta(a.ops).transform(new Delta(b.ops), priority, context).ops,
    };
  },
  invert(change, base, context): CellPayload {
    return {
      ops: new Delta(change.ops).invert(new Delta(base.ops), context).ops,
    };
  },
};

const run = (test: FixtureCase, body: () => void): void => {
  const needsCell = (test.handlers || []).indexOf('cell') !== -1;
  if (needsCell) {
    Delta.registerEmbed('cell', CellHandler);
  }
  try {
    body();
  } finally {
    if (needsCell) {
      Delta.unregisterEmbed('cell');
    }
  }
};

describe('move fixtures', () => {
  describe('apply (document compose)', () => {
    load('moves-apply').forEach((test, index) => {
      it(`case ${index}`, () => {
        run(test, () => {
          const doc = new Delta(cloneDeep(test.doc) as Op[]);
          const delta = new Delta(cloneDeep(test.delta) as Op[]);
          expect(doc.compose(delta).ops).toEqual(test.expected as Op[]);
        });
      });
    });
  });

  describe('compose', () => {
    load('moves-compose').forEach((test, index) => {
      it(`case ${index}`, () => {
        run(test, () => {
          const first = new Delta(cloneDeep(test.first) as Op[]);
          const second = new Delta(cloneDeep(test.second) as Op[]);
          expect(first.compose(second).ops).toEqual(test.expected as Op[]);
        });
      });
    });
  });

  describe('transform', () => {
    load('moves-transform').forEach((test, index) => {
      it(`case ${index}`, () => {
        run(test, () => {
          const left = new Delta(cloneDeep(test.left) as Op[]);
          const right = new Delta(cloneDeep(test.right) as Op[]);
          expect(left.transform(right, test.priority as boolean).ops).toEqual(
            test.expected as Op[],
          );
        });
      });
    });
  });

  describe('invert', () => {
    load('moves-invert').forEach((test, index) => {
      it(`case ${index}`, () => {
        run(test, () => {
          const delta = new Delta(cloneDeep(test.delta) as Op[]);
          const base = new Delta(cloneDeep(test.base) as Op[]);
          expect(delta.invert(base).ops).toEqual(test.expected as Op[]);
        });
      });
    });
  });

  describe('transformPosition', () => {
    load('moves-transform-position').forEach((test, index) => {
      it(`case ${index}`, () => {
        run(test, () => {
          const delta = new Delta(cloneDeep(test.delta) as Op[]);
          expect(
            delta.transformPosition(
              test.position as number,
              test.priority as boolean,
            ),
          ).toEqual(test.expected as number);
        });
      });
    });
  });

  describe('coordinates', () => {
    load('moves-coordinates').forEach((test, index) => {
      it(`case ${index}`, () => {
        run(test, () => {
          const delta = new Delta(cloneDeep(test.delta) as Op[]);
          const result = transformCoordinate(
            delta,
            test.coordinate as (string | number)[],
          );
          expect(result).toEqual(test.expected as (string | number)[] | null);
        });
      });
    });
  });
});
