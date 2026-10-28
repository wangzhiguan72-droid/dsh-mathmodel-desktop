import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tasks } from './deepseek-code-tasks.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));

function repairTask(id, publicTest, hiddenTest) {
  const original = tasks.find(task => task.id === id);
  if (!original) throw new Error(`Unknown repair task: ${id}`);
  return {
    id,
    spec: original.spec,
    starter: fs.readFileSync(path.join(root, '..', 'tests', 'fixtures',
      'deepseek-regressions', `${id}.original.cjs`), 'utf8'),
    publicTest,
    hiddenTest,
    reference: original.reference,
  };
}

const csvPublic = String.raw`const assert = require('node:assert/strict');
const { parseCsv } = require('./solution.cjs');

function check(label, text, expected) {
  assert.deepEqual(parseCsv(text), expected, label);
}
check('basic rows', 'a,b\n1,2', [['a','b'], ['1','2']]);
check('empty input', '', []);
check('empty line is a row', '\n', [['']]);
check('multiple empty lines', 'a\n\n\nb', [['a'], [''], [''], ['b']]);
check('CRLF empty row and final terminator', 'a\r\n\r\nb\r\n', [['a'], [''], ['b']]);
check('quoted bare CR remains data', '"a\rb",c', [['a\rb', 'c']]);
check('quoted comma and escaped quote', '"a,b","x""y"', [['a,b', 'x"y']]);
check('empty last field before final terminator', 'a,\n', [['a', '']]);
assert.throws(() => parseCsv('a\rb'), Error, 'bare CR outside a quote');
assert.throws(() => parseCsv('"a"x'), Error, 'stray data after quote');
`;

const csvHidden = String.raw`const assert = require('node:assert/strict');
const { parseCsv } = require('./solution.cjs');

// This serializer and seed stay outside the model workspace.
function serialize(rows, endings, finalTerminator) {
  const encoded = rows.map(row => row.map(field =>
    field === '' || /[,"\r\n]/.test(field) ? '"' + field.replaceAll('"', '""') + '"' : field).join(','));
  let text = '';
  for (let i = 0; i < encoded.length; i++) {
    text += encoded[i];
    if (i < encoded.length - 1 || finalTerminator) text += endings[i % endings.length];
  }
  return text;
}
let seed = 0x4e24d19b;
function random() {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
  return seed >>> 0;
}
const atoms = ['', 'a', 'Z', '汉', '🙂', ',', '"', '\r', '\n', '\r\n', ' x '];
for (let trial = 0; trial < 120; trial++) {
  const rows = Array.from({ length: 1 + random() % 7 }, () =>
    Array.from({ length: 1 + random() % 5 }, () => {
      let field = '';
      for (let i = random() % 6; i > 0; i--) field += atoms[random() % atoms.length];
      return field;
    }));
  const text = serialize(rows, ['\r\n', '\n'], trial % 2 === 0);
  assert.deepEqual(parseCsv(text), rows, 'CSV serializer roundtrip trial ' + trial);
}
assert.deepEqual(parseCsv('\r\n\n\r\n'), [[''], [''], ['']], 'three blank rows');
assert.deepEqual(parseCsv('"\r",\n'), [['\r', '']], 'quoted bare CR with trailing separator');
for (const bad of ['a\rb', '"unterminated', 'a"b', '"ok"x', '"a"\r']) {
  assert.throws(() => parseCsv(bad), Error, 'malformed CSV: ' + JSON.stringify(bad));
}
assert.throws(() => parseCsv(undefined), TypeError, 'non-string input');
`;

const wavesPublic = String.raw`const assert = require('node:assert/strict');
const { dependencyWaves } = require('./solution.cjs');

assert.deepEqual(dependencyWaves({ a:[], b:['a'], c:['a'] }), [['a'], ['b','c']], 'basic waves');
assert.deepEqual(dependencyWaves({}), [], 'empty graph');
assert.throws(() => dependencyWaves({ a:['a'] }), Error, 'single self-cycle');
assert.throws(() => dependencyWaves({ a:[], b:['a','b'], c:['a'] }), Error, 'self-cycle in otherwise runnable graph');
assert.deepEqual(dependencyWaves({ z:['a','a'], a:[], x:['z'], b:[] }),
  [['a','b'], ['z'], ['x']], 'duplicate dependency counts once');
assert.throws(() => dependencyWaves({ a:['b'], b:['a'] }), Error, 'two-node cycle');
assert.throws(() => dependencyWaves({ a:['missing'] }), Error, 'unknown dependency');
`;

const wavesHidden = String.raw`const assert = require('node:assert/strict');
const { dependencyWaves } = require('./solution.cjs');

// Independent, slow oracle: rescan the unfinished tasks after every wave.
function oracle(graph) {
  const ids = Object.keys(graph);
  const known = new Set(ids);
  for (const id of ids) {
    if (!Array.isArray(graph[id])) throw new Error('invalid list');
    for (const dep of graph[id]) {
      if (typeof dep !== 'string' || !known.has(dep)) throw new Error('invalid dependency');
    }
  }
  const done = new Set();
  const waves = [];
  while (done.size < ids.length) {
    const ready = ids.filter(id => !done.has(id) &&
      graph[id].every(dep => done.has(dep))).sort();
    if (ready.length === 0) throw new Error('cycle');
    waves.push(ready);
    for (const id of ready) done.add(id);
  }
  return waves;
}
let seed = 0x73c1e5a9;
function random() {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
  return seed >>> 0;
}
const names = ['a', 'Ω', '汉字', 'constructor', '__proto__', 'z', 'é', '02', '1'];
for (let trial = 0; trial < 160; trial++) {
  const count = 1 + random() % names.length;
  const ids = names.slice(0, count);
  const graph = Object.fromEntries(ids.map(id => [id, []]));
  for (let i = 0; i < count; i++) {
    for (let j = 0; j < i; j++) {
      if (random() % 4 === 0) {
        graph[ids[i]].push(ids[j]);
        if (random() % 3 === 0) graph[ids[i]].push(ids[j]);
      }
    }
  }
  const before = JSON.stringify(graph);
  assert.deepEqual(dependencyWaves(graph), oracle(graph), 'DAG trial ' + trial);
  assert.equal(JSON.stringify(graph), before, 'input mutation trial ' + trial);
  if (trial % 5 === 0) {
    graph[ids[0]].push(ids[0]);
    assert.throws(() => dependencyWaves(graph), Error, 'self-cycle trial ' + trial);
  }
  if (trial % 11 === 0 && count > 1) {
    const cycle = Object.fromEntries(ids.map(id => [id, []]));
    cycle[ids[0]].push(ids[1]);
    cycle[ids[1]].push(ids[0]);
    assert.throws(() => dependencyWaves(cycle), Error, 'two-node cycle trial ' + trial);
  }
  if (trial % 7 === 0) {
    const invalid = Object.fromEntries(ids.map(id => [id, []]));
    invalid[ids[0]].push('unknown-' + trial);
    assert.throws(() => dependencyWaves(invalid), Error, 'unknown dependency trial ' + trial);
  }
}
assert.throws(() => dependencyWaves({ a:[], b:['b'], c:['a'] }), Error, 'self-cycle with valid tasks');
assert.throws(() => dependencyWaves({ a:['b'], b:['c'], c:['a'] }), Error, 'three-node cycle');
assert.throws(() => dependencyWaves({ a:[42] }), Error, 'non-string dependency');
assert.throws(() => dependencyWaves({ a:'b' }), Error, 'non-array dependency list');
`;

export const repairTasks = [
  repairTask('csv-parser', csvPublic, csvHidden),
  repairTask('dependency-waves', wavesPublic, wavesHidden),
];
