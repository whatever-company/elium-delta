# elium-delta

This is [Whatever SA](https://github.com/whatever-company)'s fork of
[quill-delta](https://github.com/quilljs/delta), extended with **semantic
cut/paste moves**: two operation types that express _moving_ content
without buffering it.

```js
{ cut:   { ref: 'r', length: 10 } }
{ paste: { ref: 'r', start: 0, length: 10 } }
```

A paste addresses its cut span positionally, so deltas stay closed under
composition: an insert into a moved region splits the window, a delete
shrinks it, a format becomes the paste's attribute patch, and the inverse
of a move is the opposite move. Moves cross embed nesting levels
recursively, may target freshly inserted embeds, and deleting an embed
that still sources a move degrades to a trash-bin read. Nested-document
coordinates transform through moves via `transformCoordinate`. See the
`src/moves.ts` module documentation for the complete semantics.

Behavior is locked to the Python reference implementation
([elium-delta-py](https://github.com/whatever-company/elium-delta-py))
by 1,264 golden cases under `test/fixtures/moves/`.

Deltas are a simple, yet expressive format that can be used to describe contents and changes. The format is JSON based, and is human readable, yet easily parsible by machines. Deltas can describe any rich text document, includes all text and formatting information, without the ambiguity and complexity of HTML.

A Delta is made up of an [Array](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array) of Operations, which describe changes to a document. They can be an [`insert`](#insert-operation), [`delete`](#delete-operation) or [`retain`](#retain-operation). Note operations do not take an index. They always describe the change at the current index. Use retains to "keep" or "skip" certain parts of the document.

Don’t be confused by its name Delta&mdash;Deltas represents both documents and changes to documents. If you think of Deltas as the instructions from going from one document to another, the way Deltas represent a document is by expressing the instructions starting from an empty document.

## Quick Example

```js
// Document with text "Gandalf the Grey"
// with "Gandalf" bolded, and "Grey" in grey
const delta = new Delta([
  { insert: 'Gandalf', attributes: { bold: true } },
  { insert: ' the ' },
  { insert: 'Grey', attributes: { color: '#ccc' } },
]);

// Change intended to be applied to above:
// Keep the first 12 characters, insert a white 'White'
// and delete the next four characters ('Grey')
const death = new Delta()
  .retain(12)
  .insert('White', { color: '#fff' })
  .delete(4);
// {
//   ops: [
//     { retain: 12 },
//     { insert: 'White', attributes: { color: '#fff' } },
//     { delete: 4 }
//   ]
// }

// Applying the above:
const restored = delta.compose(death);
// {
//   ops: [
//     { insert: 'Gandalf', attributes: { bold: true } },
//     { insert: ' the ' },
//     { insert: 'White', attributes: { color: '#fff' } }
//   ]
// }
```

This README describes Deltas in its general form and API functionality. Additional information on the way Quill specifically uses Deltas can be found on its own [Delta docs](http://quilljs.com/docs/delta/). A walkthough of the motivation and design thinking behind Deltas are on [Designing the Delta Format](http://quilljs.com/guides/designing-the-delta-format/).

This format is suitable for [Operational Transform](https://en.wikipedia.org/wiki/Operational_transformation) and defines several functions to support this use case.

## Contents

#### Operations

- [`insert`](#insert-operation)
- [`delete`](#delete-operation)
- [`retain`](#retain-operation)
- [`cut`](#cut-operation)
- [`paste`](#paste-operation)

#### Construction

- [`constructor`](#constructor)
- [`insert`](#insert)
- [`delete`](#delete)
- [`retain`](#retain)
- [`cut`](#cut)
- [`paste`](#paste)

#### Documents

These methods called on or with non-document Deltas will result in undefined behavior.

- [`concat`](#concat)
- [`diff`](#diff)
- [`eachLine`](#eachline)
- [`invert`](#invert)

#### Utility

- [`filter`](#filter)
- [`forEach`](#foreach)
- [`length`](#length)
- [`map`](#map)
- [`partition`](#partition)
- [`reduce`](#reduce)
- [`slice`](#slice)

#### Operational Transform

- [`compose`](#compose)
- [`transform`](#transform)
- [`transformPosition`](#transformposition)
- [`transformCoordinate`](#transformcoordinate)

## Operations

### Insert Operation

Insert operations have an `insert` key defined. A String value represents inserting text. Any other type represents inserting an embed (however only one level of object comparison will be performed for equality).

In both cases of text and embeds, an optional `attributes` key can be defined with an Object to describe additonal formatting information. Formats can be changed by the [retain](#retain) operation.

```js
// Insert a bolded "Text"
{ insert: "Text", attributes: { bold: true } }

// Insert a link
{ insert: "Google", attributes: { link: 'https://www.google.com' } }

// Insert an embed
{
  insert: { image: 'https://octodex.github.com/images/labtocat.png' },
  attributes: { alt: "Lab Octocat" }
}

// Insert another embed
{
  insert: { video: 'https://www.youtube.com/watch?v=dMH0bHeiRNg' },
  attributes: {
    width: 420,
    height: 315
  }
}
```

### Delete Operation

Delete operations have a Number `delete` key defined representing the number of characters to delete. All embeds have a length of 1.

```js
// Delete the next 10 characters
{ delete: 10 }
```

### Retain Operation

Retain operations have a Number `retain` key defined representing the number of characters to keep (other libraries might use the name keep or skip). An optional `attributes` key can be defined with an Object to describe formatting changes to the character range. A value of `null` in the `attributes` Object represents removal of that key.

_Note: It is not necessary to retain the last characters of a document as this is implied._

```js
// Keep the next 5 characters
{ retain: 5 }

// Keep and bold the next 5 characters
{ retain: 5, attributes: { bold: true } }

// Keep and unbold the next 5 characters
// More specifically, remove the bold key in the attributes Object
// in the next 5 characters
{ retain: 5, attributes: { bold: null } }
```

### Cut Operation

Cut operations consume `length` characters of the document — like a
delete — and remember the removed span under a transaction-local `ref`.
Every ref has exactly one cut, and a cut whose ref is never pasted
degrades to a plain delete.

```js
// Cut the next 10 characters, remembering them as 'r'
{ cut: { ref: 'r', length: 10 } }
```

### Paste Operation

Paste operations produce `length` characters starting at `start`
_within the span remembered by `ref`_ — a window into the cut. Windows
of one ref must be pairwise disjoint (a move, not a copy) and fit
inside their cut. An optional `attributes` key applies a retain-style
patch on top of whatever formatting the content carries, and a paste of
a single embed may carry `change`, an embed patch applied at paste time.

Because a paste addresses its source positionally, deltas stay closed
under composition: an insert into a pasted span splits the window, a
delete shrinks it, and a format becomes the paste's attribute patch.

```js
// Paste the full span remembered as 'r'
{ paste: { ref: 'r', start: 0, length: 10 } }

// Paste it in two windows around an insertion, bolding the second
{ paste: { ref: 'r', start: 0, length: 2 } }
{ insert: 'x' }
{ paste: { ref: 'r', start: 2, length: 8 }, attributes: { bold: true } }
```

## Construction

### constructor

Creates a new Delta object.

#### Methods

- `new Delta()`
- `new Delta(ops)`
- `new Delta(delta)`

#### Parameters

- `ops` - Array of operations
- `delta` - Object with an `ops` key set to an array of operations

No validity check is performed by the constructor. It does deep-copy the
operation tree, however, so later mutation of the source array, an operation,
or a nested embed value cannot mutate the Delta. Algebra methods likewise do
not run move validation automatically; call `Delta.check(delta)` explicitly
at an untrusted boundary.

#### Example

```js
const delta = new Delta([
  { insert: 'Hello World' },
  { insert: '!', attributes: { bold: true } },
]);

const packet = JSON.stringify(delta);

const other = new Delta(JSON.parse(packet));

const chained = new Delta().insert('Hello World').insert('!', { bold: true });
```

---

### insert()

Appends an insert operation. Returns `this` for chainability.

#### Methods

- `insert(text, attributes)`
- `insert(embed, attributes)`

#### Parameters

- `text` - String representing text to insert
- `embed` - Object representing embed type to insert
- `attributes` - Optional attributes to apply

#### Example

```js
delta.insert('Text', { bold: true, color: '#ccc' });
delta.insert({ image: 'https://octodex.github.com/images/labtocat.png' });
```

---

### delete()

Appends a delete operation. Returns `this` for chainability.

#### Methods

- `delete(length)`

#### Parameters

- `length` - Number of characters to delete

#### Example

```js
delta.delete(5);
```

---

### retain()

Appends a retain operation. Returns `this` for chainability.

#### Methods

- `retain(length, attributes)`

#### Parameters

- `length` - Number of characters to retain
- `attributes` - Optional attributes to apply

#### Example

```js
delta.retain(4).retain(5, { color: '#0c6' });
```

---

### cut()

Appends a cut operation. Returns `this` for chainability.

#### Methods

- `cut(ref, length)`

#### Parameters

- `ref` - Transaction-local name for the cut span
- `length` - Number of characters to cut

#### Example

```js
delta.cut('r', 6);
```

---

### paste()

Appends a paste operation. Returns `this` for chainability.

#### Methods

- `paste(ref, start, length, change, attributes)`

#### Parameters

- `ref` - Name of the cut to paste from
- `start` - Offset of the window inside the cut span
- `length` - Number of characters to paste
- `change` - Optional retain-style change applied to a length-one embed
- `attributes` - Optional attributes to apply to the pasted content

#### Example

```js
// Move "Hello " to the end of "Hello World"
new Delta().cut('m', 6).retain(5).paste('m', 0, 6);
```

### registerEmbed()

Registers the structural algebra for one anonymous embed type. Value and
change types may differ. A handler implements five distinct operations:

```ts
interface EmbedHandler<Value, Change> {
  streamPaths?(value: Value | Change): Iterable<readonly (string | number)[]>;
  apply(value: Value, change: Change, context: ComposeContext): Value;
  compose(first: Change, second: Change, context: ComposeContext): Change;
  transform(
    first: Change,
    second: Change,
    priority: boolean,
    context: TransformContext,
  ): Change;
  invert(change: Change, base: Value, context: InvertContext): Change;
  diff(base: Value, target: Value, context: DiffContext): Change;
}
```

`streamPaths` declares operation lists structurally owned by the embed. Paths
are relative to the embed payload; `[]` means the payload itself is a Delta
operation list. The move walker visits only declared paths, leaving arbitrary
JSON metadata opaque.

When a handler recursively calls `compose`, `transform`, `invert`, or `diff`
on a child Delta, it must forward the context it received. That explicit,
operation-specific context lets one cut/paste transaction cross cells and
nesting levels without ambient state or persistent embed IDs.

## Documents

### concat()

Returns a new Delta representing the concatenation of this and another document Delta's operations.

#### Methods

- `concat(other)`

#### Parameters

- `other` - Document Delta to concatenate

#### Returns

- `Delta` - Concatenated document Delta

#### Example

```js
const a = new Delta().insert('Hello');
const b = new Delta().insert('!', { bold: true });

// {
//   ops: [
//     { insert: 'Hello' },
//     { insert: '!', attributes: { bold: true } }
//   ]
// }
const concat = a.concat(b);
```

---

### diff()

Returns a Delta representing the difference between two documents. Optionally, accepts a suggested index where change took place, often representing a cursor position _before_ change.

#### Methods

- `diff(other)`
- `diff(other, index)`

#### Parameters

- `other` - Document Delta to diff against
- `index` - Suggested index where change took place

#### Returns

- `Delta` - difference between the two documents

#### Example

```js
const a = new Delta().insert('Hello');
const b = new Delta().insert('Hello!');

const diff = a.diff(b); // { ops: [{ retain: 5 }, { insert: '!' }] }
// a.compose(diff) == b
```

---

### eachLine()

Iterates through document Delta, calling a given function with a Delta and attributes object, representing the line segment.

#### Methods

- `eachLine(predicate, newline)`

#### Parameters

- `predicate` - function to call on each line group
- `newline` - newline character, defaults to `\n`

#### Example

```js
const delta = new Delta()
  .insert('Hello\n\n')
  .insert('World')
  .insert({ image: 'octocat.png' })
  .insert('\n', { align: 'right' })
  .insert('!');

delta.eachLine((line, attributes, i) => {
  console.log(line, attributes, i);
  // Can return false to exit loop early
});
// Should log:
// { ops: [{ insert: 'Hello' }] }, {}, 0
// { ops: [] }, {}, 1
// { ops: [{ insert: 'World' }, { insert: { image: 'octocat.png' } }] }, { align: 'right' }, 2
// { ops: [{ insert: '!' }] }, {}, 3
```

---

### invert()

Returned an inverted delta that has the opposite effect of against a base document delta. That is `base.compose(delta).compose(inverted) === base`.

#### Methods

- `invert(base)`

#### Parameters

- `base` - Document delta to invert against

#### Returns

- `Delta` - inverted delta against the base delta

#### Example

```js
const base = new Delta().insert('Hello\n').insert('World');
const delta = new Delta().retain(6, { bold: true }).insert('!').delete(5);

const inverted = delta.invert(base); // { ops: [
//   { retain: 6, attributes: { bold: null } },
//   { insert: 'World' },
//   { delete: 1 }
// ]}
// base.compose(delta).compose(inverted) === base
```

## Utility

### filter()

Returns an array of operations that passes a given function.

#### Methods

- `filter(predicate)`

#### Parameters

- `predicate` - Function to test each operation against. Return `true` to keep the operation, `false` otherwise.

#### Returns

- `Array` - Filtered resulting array

#### Example

```js
const delta = new Delta()
  .insert('Hello', { bold: true })
  .insert({ image: 'https://octodex.github.com/images/labtocat.png' })
  .insert('World!');

const text = delta
  .filter((op) => typeof op.insert === 'string')
  .map((op) => op.insert)
  .join('');
```

---

### forEach()

Iterates through operations, calling the provided function for each operation.

#### Methods

- `forEach(predicate)`

#### Parameters

- `predicate` - Function to call during iteration, passing in the current operation.

#### Example

```js
delta.forEach((op) => {
  console.log(op);
});
```

---

### length()

Returns length of a Delta, which is the sum of the lengths of its operations.

#### Methods

- `length()`

#### Example

```js
new Delta().insert('Hello').length(); // Returns 5

new Delta().insert('A').retain(2).delete(1).length(); // Returns 4
```

---

### map()

Returns a new array with the results of calling provided function on each operation.

#### Methods

- `map(predicate)`

#### Parameters

- `predicate` - Function to call, passing in the current operation, returning an element of the new array to be returned

#### Returns

- `Array` - A new array with each element being the result of the given function.

#### Example

```js
const delta = new Delta()
  .insert('Hello', { bold: true })
  .insert({ image: 'https://octodex.github.com/images/labtocat.png' })
  .insert('World!');

const text = delta
  .map((op) => {
    if (typeof op.insert === 'string') {
      return op.insert;
    } else {
      return '';
    }
  })
  .join('');
```

---

### partition()

Create an array of two arrays, the first with operations that pass the given function, the other that failed.

#### Methods

- `partition(predicate)`

#### Parameters

- `predicate` - Function to call, passing in the current operation, returning whether that operation passed

#### Returns

- `Array` - A new array of two Arrays, the first with passed operations, the other with failed operations

#### Example

```js
const delta = new Delta()
  .insert('Hello', { bold: true })
  .insert({ image: 'https://octodex.github.com/images/labtocat.png' })
  .insert('World!');

const results = delta.partition((op) => typeof op.insert === 'string');
const passed = results[0]; // [{ insert: 'Hello', attributes: { bold: true }},
//  { insert: 'World'}]
const failed = results[1]; // [{ insert: { image: 'https://octodex.github.com/images/labtocat.png' }}]
```

---

### reduce()

Applies given function against an accumulator and each operation to reduce to a single value.

#### Methods

- `reduce(predicate, initialValue)`

#### Parameters

- `predicate` - Function to call per iteration, returning an accumulated value
- `initialValue` - Initial value to pass to first call to predicate

#### Returns

- `any` - the accumulated value

#### Example

```js
const delta = new Delta().insert('Hello', { bold: true })
                         .insert({ image: 'https://octodex.github.com/images/labtocat.png' })
                         .insert('World!');

const length = delta.reduce((length, op) => (
  length + (op.insert.length || 1);
), 0);
```

---

### slice()

Returns copy of delta with subset of operations.

#### Methods

- `slice()`
- `slice(start)`
- `slice(start, end)`

#### Parameters

- `start` - Start index of subset, defaults to 0
- `end` - End index of subset, defaults to rest of operations

#### Example

```js
const delta = new Delta().insert('Hello', { bold: true }).insert(' World');

// {
//   ops: [
//     { insert: 'Hello', attributes: { bold: true } },
//     { insert: ' World' }
//   ]
// }
const copy = delta.slice();

// { ops: [{ insert: 'World' }] }
const world = delta.slice(6);

// { ops: [{ insert: ' ' }] }
const space = delta.slice(5, 6);
```

## Operational Transform

### compose()

Returns a Delta that is equivalent to applying the operations of own Delta, followed by another Delta.

#### Methods

- `compose(other)`

#### Parameters

- `other` - Delta to compose

#### Example

```js
const a = new Delta().insert('abc');
const b = new Delta().retain(1).delete(1);

const composed = a.compose(b); // composed == new Delta().insert('ac');
```

---

### transform()

Transform given Delta against own operations.

#### Methods

- `transform(other, priority = false)`
- `transform(index, priority = false)` - Alias for [`transformPosition`](#tranformposition)

#### Parameters

- `other` - Delta to transform
- `priority` - Boolean used to break ties. If `true`, then `this` takes priority
  over `other`, that is, its actions are considered to happen "first."

#### Returns

- `Delta` - transformed Delta

#### Example

```js
const a = new Delta().insert('a');
const b = new Delta().insert('b').retain(5).insert('c');

a.transform(b, true); // new Delta().retain(1).insert('b').retain(5).insert('c');
a.transform(b, false); // new Delta().insert('b').retain(6).insert('c');
```

---

### transformPosition()

Transform an index against the delta. Useful for representing cursor/selection positions.

#### Methods

- `transformPosition(index, priority = false)`

#### Parameters

- `index` - index to transform

#### Returns

- `Number` - transformed index

#### Example

```js
const delta = new Delta().retain(5).insert('a');
delta.transformPosition(4); // 4
delta.transformPosition(5); // 6
```

---

### transformCoordinate()

Transform a nested-document coordinate against a delta. A coordinate
addresses a position through embed levels — `[5]` is a caret at root
offset 5, `[2, 'ops', 3]` a caret at offset 3 inside the child sequence
at payload key `ops` of the embed at position 2. Carets shift with
inserts and deletes, follow content that a move relocates — across
sequence levels, in either direction, including trash reads — and
collapse to the removal point when their span is deleted. Embed units
return `null` when the unit was deleted.

#### Methods

- `transformCoordinate(delta, coordinate, priority = false)`

#### Parameters

- `delta` - the delta to transform through
- `coordinate` - array of offsets and payload keys

#### Returns

- transformed coordinate array, or `null` for a deleted unit

#### Example

```js
import { transformCoordinate } from 'elium-delta';

const move = new Delta().cut('m', 5).retain(6).paste('m', 0, 5);
transformCoordinate(move, [2]); // caret follows the moved content
```
