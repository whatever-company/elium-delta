import * as fs from 'fs';
import * as path from 'path';
import Delta from '../src/Delta';
import { registerEmbedHandler, unregisterEmbedHandler } from './embedHandlers';

// ── helpers ──

function loadFixture<T>(name: string): T {
  const filePath = path.join(__dirname, 'fixtures', name);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function deltaFromOps(ops: any[]): Delta {
  return new Delta(ops);
}

function embedFixtureGroups(fixture: any): any[] {
  if (Array.isArray(fixture.embedFixtures)) {
    return fixture.embedFixtures;
  }
  if (fixture.embedHandler) {
    return [fixture];
  }
  return [];
}

// ── Delta compose ──

export function runDeltaComposeEmbedFixtures(): void {
  const embedFixture = loadFixture<any>('delta-compose-embed.json');

  describe('compose() (fixtures)', () => {
    for (const group of embedFixtureGroups(embedFixture)) {
      describe(`${group.embedHandler} custom embed handler`, () => {
        beforeEach(() => registerEmbedHandler(group.embedHandler));
        afterEach(() => unregisterEmbedHandler(group.embedHandler));

        for (const test of group.tests || []) {
          it(test.name, () => {
            const a = deltaFromOps(test.a);
            const b = deltaFromOps(test.b);
            const expected = deltaFromOps(test.expected);
            expect(a.compose(b)).toEqual(expected);
          });
        }

        for (const test of group.errorTests || []) {
          it(test.name, () => {
            const a = deltaFromOps(test.a);
            const b = deltaFromOps(test.b);
            expect(() => a.compose(b)).toThrowError(test.error);
          });
        }
      });
    }

    for (const group of embedFixtureGroups(embedFixture)) {
      for (const test of group.errorTestsNoHandler || []) {
        it(test.name, () => {
          const a = deltaFromOps(test.a);
          const b = deltaFromOps(test.b);
          expect(() => a.compose(b)).toThrowError(test.error);
        });
      }
    }
  });
}

// ── Delta diff ──

export function runDeltaDiffFixtures(): void {
  const fixture = loadFixture<any>('delta-diff.json');
  const embedFixture = loadFixture<any>('delta-diff-embed.json');

  describe('diff() (fixtures)', () => {
    for (const test of fixture.tests) {
      it(test.name, () => {
        const a = deltaFromOps(test.a);
        const b = deltaFromOps(test.b);
        const expected = deltaFromOps(test.expected);
        expect(a.diff(b)).toEqual(expected);
      });
    }

    if (fixture.errorTests) {
      for (const test of fixture.errorTests) {
        it(test.name, () => {
          const a = deltaFromOps(test.a);
          const b = deltaFromOps(test.b);
          expect(() => a.diff(b)).toThrow();
        });
      }
    }

    for (const group of embedFixtureGroups(embedFixture)) {
      describe(`${group.embedHandler} custom embed handler`, () => {
        beforeEach(() => registerEmbedHandler(group.embedHandler));
        afterEach(() => unregisterEmbedHandler(group.embedHandler));

        for (const test of group.tests || []) {
          it(test.name, () => {
            const a = deltaFromOps(test.a);
            const b = deltaFromOps(test.b);
            const expected = deltaFromOps(test.expected);
            const actual = a.diff(b);
            expect(actual).toEqual(expected);
            if (test.verifyCompose !== false) {
              expect(a.compose(actual)).toEqual(b);
            }
          });
        }
      });
    }
  });
}

// ── Delta transform ──

export function runDeltaTransformEmbedFixtures(): void {
  const embedFixture = loadFixture<any>('delta-transform-embed.json');

  describe('transform() (fixtures)', () => {
    for (const group of embedFixtureGroups(embedFixture)) {
      describe(`${group.embedHandler} custom embed handler`, () => {
        beforeEach(() => registerEmbedHandler(group.embedHandler));
        afterEach(() => unregisterEmbedHandler(group.embedHandler));

        for (const test of group.tests || []) {
          it(test.name, () => {
            const a = deltaFromOps(test.a);
            const b = deltaFromOps(test.b);
            const expected = deltaFromOps(test.expected);
            expect(a.transform(b, test.priority)).toEqual(expected);
          });
        }
      });
    }
  });
}

// ── Delta invert ──

export function runDeltaInvertEmbedFixtures(): void {
  const embedFixture = loadFixture<any>('delta-invert-embed.json');

  describe('invert() (fixtures)', () => {
    for (const group of embedFixtureGroups(embedFixture)) {
      describe(`${group.embedHandler} custom embed handler`, () => {
        beforeEach(() => registerEmbedHandler(group.embedHandler));
        afterEach(() => unregisterEmbedHandler(group.embedHandler));

        for (const test of group.tests || []) {
          it(test.name, () => {
            const delta = deltaFromOps(test.delta);
            const base = deltaFromOps(test.base);
            const expected = deltaFromOps(test.expected);
            const inverted = delta.invert(base);
            expect(inverted).toEqual(expected);
            if (test.verifyRoundTrip) {
              expect(base.compose(delta).compose(inverted)).toEqual(base);
            }
          });
        }

        for (const test of group.errorTests || []) {
          it(test.name, () => {
            const delta = deltaFromOps(test.delta);
            const base = deltaFromOps(test.base);
            expect(() => delta.invert(base)).toThrowError(test.error);
          });
        }
      });
    }
  });
}
