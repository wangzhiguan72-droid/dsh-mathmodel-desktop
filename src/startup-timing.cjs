'use strict';

const { performance } = require('node:perf_hooks');

function createStartupTiming({ now = () => performance.now(), iso = () => new Date().toISOString() } = {}) {
  const started = now();
  let previous = started;

  function milliseconds(value) {
    return Math.max(0, Math.round(value));
  }

  return {
    annotate(line) {
      // Host output includes a tokenized URL parsed by an anchored expression.
      // Keep every host line byte-for-byte intact.
      if (!line.startsWith('[desktop] ')) return line;
      return `${line} [startup +${milliseconds(now() - started)}ms ${iso()}]`;
    },
    stage(name) {
      const current = now();
      const duration = milliseconds(current - previous);
      previous = current;
      return `[desktop] startup ${name}: ${duration}ms since previous stage`;
    },
  };
}

function configureHostCompileCache(args, env, { hostBin, preloadPath, cacheDir, preloadExists }) {
  const launchArgs = [...args];
  const launchEnv = { ...env };
  if (launchEnv.NODE_DISABLE_COMPILE_CACHE) return { args: launchArgs, env: launchEnv };
  if (!Object.hasOwn(launchEnv, 'NODE_COMPILE_CACHE')) launchEnv.NODE_COMPILE_CACHE = cacheDir;
  if (preloadExists(preloadPath)) {
    const entrypoint = launchArgs.indexOf(hostBin);
    if (entrypoint < 0) throw new Error('Host entrypoint is missing from launch arguments');
    launchArgs.splice(entrypoint, 0, '--require', preloadPath);
  }
  return { args: launchArgs, env: launchEnv };
}

module.exports = { createStartupTiming, configureHostCompileCache };
