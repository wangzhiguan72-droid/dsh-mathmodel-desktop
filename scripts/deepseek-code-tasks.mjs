// The runner writes only starter and publicTest into the model's workspace.
// Hidden tests and reference implementations stay in this local benchmark module.

export const tasks = [
  {
    id: 'csv-parser',
    spec: `Implement parseCsv(text) in solution.cjs and export it with module.exports = { parseCsv }.
Return an array of rows, each an array of strings. Empty input returns []. Commas separate fields; LF and CRLF separate rows. A final row terminator does not add a phantom empty row, but an empty line is one row containing an empty field. A quoted field may contain commas and line breaks. Inside a quoted field, two double quotes represent one literal double quote. A quote may start only at the beginning of a field; after its closing quote only a comma, a row terminator, or end of input is legal. Reject an unclosed quote, a quote inside an unquoted field, a stray character after a closing quote, and a bare CR outside quotes by throwing an Error. Reject a non-string argument with TypeError. Preserve field contents exactly; do not trim whitespace. Use only built-in Node.js modules.`,
    starter: `function parseCsv(text) {
  return text.split('\\n').map(line => line.split(','));
}
module.exports = { parseCsv };
`,
    publicTest: `const assert = require('node:assert/strict');
const { parseCsv } = require('./solution.cjs');
assert.deepEqual(parseCsv('a,b\\n1,2'), [['a','b'],['1','2']]);
assert.deepEqual(parseCsv('"a,b",c'), [['a,b','c']]);
assert.deepEqual(parseCsv(''), []);
`,
    hiddenTest: `const assert = require('node:assert/strict');
const { parseCsv } = require('./solution.cjs');
assert.deepEqual(parseCsv('a,b\\r\\n1,2\\r\\n'), [['a','b'],['1','2']]);
assert.deepEqual(parseCsv('a,,\\n'), [['a','','']]);
assert.deepEqual(parseCsv('\\n'), [['']]);
assert.deepEqual(parseCsv('"a""b",z'), [['a"b','z']]);
assert.deepEqual(parseCsv('"a\\r\\nb",z'), [['a\\r\\nb','z']]);
assert.deepEqual(parseCsv('"",x'), [['','x']]);
assert.deepEqual(parseCsv(' a , b '), [[' a ',' b ']]);
assert.deepEqual(parseCsv('a,\\n\\n'), [['a',''],['']]);
assert.throws(() => parseCsv('"unclosed'), Error);
assert.throws(() => parseCsv('a"b'), Error);
assert.throws(() => parseCsv('"a"x'), Error);
assert.throws(() => parseCsv('a\\rb'), Error);
assert.throws(() => parseCsv(null), TypeError);
`,
  },
  {
    id: 'interval-union',
    spec: `Implement mergeIntervals(intervals) in solution.cjs and export it with module.exports = { mergeIntervals }.
The input is an array of pairs [start, end] representing half-open numeric intervals [start, end). Endpoints must be finite numbers. Return a new array of new pairs, sorted by start and then end, forming the union. Drop empty intervals whose endpoints are equal. Merge overlapping intervals and touching intervals (the end of one equals the start of another). Negative endpoints are valid. Do not mutate the input array or any input pair. Throw TypeError for a non-array input, a non-pair entry, or a non-finite endpoint; throw RangeError when start exceeds end. Use only built-in Node.js modules.`,
    starter: `function mergeIntervals(intervals) {
  return intervals.sort((a, b) => a[0] - b[0]);
}
module.exports = { mergeIntervals };
`,
    publicTest: `const assert = require('node:assert/strict');
const { mergeIntervals } = require('./solution.cjs');
assert.deepEqual(mergeIntervals([[1,3],[2,5]]), [[1,5]]);
assert.deepEqual(mergeIntervals([[3,4],[1,2]]), [[1,2],[3,4]]);
assert.deepEqual(mergeIntervals([]), []);
`,
    hiddenTest: `const assert = require('node:assert/strict');
const { mergeIntervals } = require('./solution.cjs');
assert.deepEqual(mergeIntervals([[1,2],[2,4]]), [[1,4]]);
assert.deepEqual(mergeIntervals([[2,2],[1,3]]), [[1,3]]);
assert.deepEqual(mergeIntervals([[-5,-3],[-4,0],[3,4]]), [[-5,0],[3,4]]);
assert.deepEqual(mergeIntervals([[4,5],[1,10],[2,3]]), [[1,10]]);
assert.deepEqual(mergeIntervals([[1,1]]), []);
const input = [[3,5],[1,2]]; const copy = input.map(pair => pair.slice());
const output = mergeIntervals(input);
assert.deepEqual(input, copy);
assert.notStrictEqual(output, input);
assert.notStrictEqual(output[0], input[1]);
assert.throws(() => mergeIntervals([[3,2]]), RangeError);
assert.throws(() => mergeIntervals([[0,Infinity]]), TypeError);
assert.throws(() => mergeIntervals([[0]]), TypeError);
assert.throws(() => mergeIntervals(null), TypeError);
`,
  },
  {
    id: 'dependency-waves',
    spec: `Implement dependencyWaves(graph) in solution.cjs and export it with module.exports = { dependencyWaves }.
graph is a plain object whose own string keys are task IDs and whose values are arrays of dependency task IDs. Return an array of waves. Each wave contains every currently runnable task sorted in JavaScript's default lexicographic string order; all tasks in one wave may run in parallel, and tasks in the next wave may depend on those in earlier waves. A task can appear only once. Duplicate dependency names count as one edge. An empty graph returns []. Throw an Error if any dependency is unknown, if a dependency is not a string, if any value is not an array, or if the graph has a cycle (including a self-cycle). Do not mutate graph or its arrays. Use only built-in Node.js modules.`,
    starter: `function dependencyWaves(graph) {
  return [Object.keys(graph).sort()];
}
module.exports = { dependencyWaves };
`,
    publicTest: `const assert = require('node:assert/strict');
const { dependencyWaves } = require('./solution.cjs');
assert.deepEqual(dependencyWaves({ a:[], b:['a'], c:['a'] }), [['a'],['b','c']]);
assert.deepEqual(dependencyWaves({}), []);
`,
    hiddenTest: `const assert = require('node:assert/strict');
const { dependencyWaves } = require('./solution.cjs');
assert.deepEqual(dependencyWaves({ z:[], a:[], m:[] }), [['a','m','z']]);
assert.deepEqual(dependencyWaves({ a:[], b:['a','a'], c:['b'], d:['a'] }), [['a'],['b','d'],['c']]);
assert.deepEqual(dependencyWaves({ z:['a'], a:[], x:['z'], b:[] }), [['a','b'],['z'],['x']]);
const graph = { a:[], b:['a','a'] }; const snapshot = JSON.stringify(graph);
assert.deepEqual(dependencyWaves(graph), [['a'],['b']]);
assert.equal(JSON.stringify(graph), snapshot);
assert.throws(() => dependencyWaves({ a:['missing'] }), Error);
assert.throws(() => dependencyWaves({ a:['a'] }), Error);
assert.throws(() => dependencyWaves({ a:['b'], b:['a'] }), Error);
assert.throws(() => dependencyWaves({ a:[1] }), Error);
assert.throws(() => dependencyWaves({ a:'b' }), Error);
assert.throws(() => dependencyWaves(null), Error);
assert.deepEqual(dependencyWaves(Object.assign(Object.create(null), { a:[], b:['a'] })), [['a'],['b']]);
`,
  },
  {
    id: 'retry-schedule',
    spec: `Implement retryDelays(attempts, baseMs, maxMs) in solution.cjs and export it with module.exports = { retryDelays }.
attempts is the number of retry delays to produce. Return an array of exactly attempts nonnegative integer millisecond delays. For zero-based retry index i, delay is min(maxMs, baseMs * 2**i): exponential backoff with a cap, no jitter. All three inputs must be nonnegative safe integers; otherwise throw TypeError. A zero attempt count returns [] after validating all arguments. A base of zero produces zeros. Never emit Infinity, NaN, or an unsafe integer, even when multiplication would overflow: clamp to maxMs first. Use only built-in Node.js modules.`,
    starter: `function retryDelays(attempts, baseMs, maxMs) {
  return Array.from({ length: attempts }, (_, i) => baseMs * (i + 1));
}
module.exports = { retryDelays };
`,
    publicTest: `const assert = require('node:assert/strict');
const { retryDelays } = require('./solution.cjs');
assert.deepEqual(retryDelays(4, 100, 500), [100,200,400,500]);
assert.deepEqual(retryDelays(0, 100, 500), []);
`,
    hiddenTest: `const assert = require('node:assert/strict');
const { retryDelays } = require('./solution.cjs');
assert.deepEqual(retryDelays(5, 2, 100), [2,4,8,16,32]);
assert.deepEqual(retryDelays(4, 4, 4), [4,4,4,4]);
assert.deepEqual(retryDelays(3, 10, 3), [3,3,3]);
assert.deepEqual(retryDelays(3, 0, 10), [0,0,0]);
assert.deepEqual(retryDelays(1, 7, 8), [7]);
assert.deepEqual(retryDelays(4, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER), Array(4).fill(Number.MAX_SAFE_INTEGER));
assert.deepEqual(retryDelays(8, 1000000000000, Number.MAX_SAFE_INTEGER).slice(0,3), [1000000000000,2000000000000,4000000000000]);
assert.throws(() => retryDelays(-1, 1, 10), TypeError);
assert.throws(() => retryDelays(1.5, 1, 10), TypeError);
assert.throws(() => retryDelays(1, -1, 10), TypeError);
assert.throws(() => retryDelays(1, 1, Infinity), TypeError);
assert.throws(() => retryDelays(1, 1, Number.MAX_SAFE_INTEGER + 1), TypeError);
assert.throws(() => retryDelays(0, 1, -1), TypeError);
`,
  },
];

// Used by the fixture self-test only; never write this map into a model workspace.
export const referenceSolutions = {
  'csv-parser': `function parseCsv(text) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  if (text.length === 0) return [];
  const rows = []; let row = []; let field = ''; let state = 'start'; let open = false;
  const finishField = () => { row.push(field); field = ''; state = 'start'; };
  const finishRow = () => { finishField(); rows.push(row); row = []; open = false; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (state === 'quoted') {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else state = 'afterQuote';
      } else field += ch;
      continue;
    }
    if (ch === ',') { finishField(); open = true; continue; }
    if (ch === '\\n' || ch === '\\r') {
      if (ch === '\\r') {
        if (text[i + 1] !== '\\n') throw new Error('bare CR');
        i++;
      }
      finishRow(); continue;
    }
    if (state === 'afterQuote') throw new Error('character after closing quote');
    if (ch === '"') {
      if (state !== 'start') throw new Error('quote inside unquoted field');
      state = 'quoted'; open = true; continue;
    }
    field += ch; state = 'unquoted'; open = true;
  }
  if (state === 'quoted') throw new Error('unclosed quote');
  if (open) finishRow();
  return rows;
}
module.exports = { parseCsv };
`,
  'interval-union': `function mergeIntervals(intervals) {
  if (!Array.isArray(intervals)) throw new TypeError('intervals must be an array');
  const sorted = [];
  for (const pair of intervals) {
    if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(x => typeof x === 'number' && Number.isFinite(x))) throw new TypeError('invalid interval');
    const [start, end] = pair;
    if (start > end) throw new RangeError('reversed interval');
    if (start !== end) sorted.push([start, end]);
  }
  sorted.sort((a,b) => a[0] - b[0] || a[1] - b[1]);
  const result = [];
  for (const pair of sorted) {
    const last = result[result.length - 1];
    if (last && pair[0] <= last[1]) last[1] = Math.max(last[1], pair[1]);
    else result.push(pair);
  }
  return result;
}
module.exports = { mergeIntervals };
`,
  'dependency-waves': `function dependencyWaves(graph) {
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) throw new Error('invalid graph');
  const names = Object.keys(graph);
  const remaining = new Map(names.map(name => [name, new Set()]));
  for (const name of names) {
    if (!Array.isArray(graph[name])) throw new Error('invalid dependency list');
    for (const dep of graph[name]) {
      if (typeof dep !== 'string' || !remaining.has(dep)) throw new Error('unknown dependency');
      remaining.get(name).add(dep);
    }
  }
  const waves = [];
  while (remaining.size > 0) {
    const ready = [...remaining].filter(([,deps]) => deps.size === 0).map(([name]) => name).sort();
    if (ready.length === 0) throw new Error('dependency cycle');
    waves.push(ready);
    for (const name of ready) remaining.delete(name);
    for (const deps of remaining.values()) for (const name of ready) deps.delete(name);
  }
  return waves;
}
module.exports = { dependencyWaves };
`,
  'retry-schedule': `function retryDelays(attempts, baseMs, maxMs) {
  if (![attempts, baseMs, maxMs].every(x => Number.isSafeInteger(x) && x >= 0)) throw new TypeError('nonnegative safe integers required');
  const result = []; let delay = Math.min(baseMs, maxMs);
  for (let i = 0; i < attempts; i++) {
    result.push(delay);
    delay = delay >= maxMs / 2 ? maxMs : delay * 2;
  }
  return result;
}
module.exports = { retryDelays };
`,
};

for (const task of tasks) task.reference = referenceSolutions[task.id];
