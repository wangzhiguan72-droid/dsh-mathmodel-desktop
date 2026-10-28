'use strict';

/**
 * Topological wave scheduling.
 *
 * @param {Object<string, string[]>} graph task ID -> dependency task IDs
 * @returns {string[][]} waves of runnable tasks, each wave sorted lexicographically
 */
function dependencyWaves(graph) {
  if (graph === null || typeof graph !== 'object' || Array.isArray(graph)) {
    throw new Error('graph must be a plain object');
  }

  const ids = Object.keys(graph);
  if (ids.length === 0) return [];

  const idSet = new Set(ids);
  const deps = new Map();

  for (const id of ids) {
    const value = graph[id];
    if (!Array.isArray(value)) {
      throw new Error(`dependencies of "${id}" must be an array`);
    }
    const unique = new Set();
    for (const dep of value) {
      if (typeof dep !== 'string') {
        throw new Error(`dependency of "${id}" must be a string`);
      }
      if (!idSet.has(dep)) {
        throw new Error(`unknown dependency "${dep}" of "${id}"`);
      }
      unique.add(dep);
    }
    deps.set(id, unique);
  }

  const remaining = new Map();
  for (const id of ids) {
    let count = 0;
    for (const dep of deps.get(id)) {
      if (dep !== id) count += 1;
    }
    remaining.set(id, count);
  }

  // Reverse adjacency: dependency -> dependents that list it (excluding self-loops,
  // which are unresolvable and therefore reported as a cycle instead).
  const dependents = new Map();
  for (const id of ids) dependents.set(id, []);
  for (const id of ids) {
    for (const dep of deps.get(id)) {
      if (dep !== id) dependents.get(dep).push(id);
    }
  }

  const waves = [];
  const placed = new Set();
  let ready = ids.filter((id) => remaining.get(id) === 0).sort();

  while (ready.length > 0) {
    waves.push(ready);
    for (const id of ready) placed.add(id);

    const candidates = new Set();
    for (const id of ready) {
      for (const dependent of dependents.get(id)) {
        if (placed.has(dependent)) continue;
        const count = remaining.get(dependent) - 1;
        remaining.set(dependent, count);
        if (count === 0) candidates.add(dependent);
      }
    }
    ready = Array.from(candidates).sort();
  }

  if (placed.size !== ids.length) {
    throw new Error('graph contains a cycle');
  }

  return waves;
}

module.exports = { dependencyWaves };
