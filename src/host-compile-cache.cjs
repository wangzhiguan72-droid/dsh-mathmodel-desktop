'use strict';

// Node normally flushes its compile cache at orderly exit. Windows process-tree
// shutdown can skip that exit, so save the startup graph while the Host is alive.
function installCompileCacheFlush({ modules = require('node:module'), schedule = setTimeout, cancel = clearTimeout } = {}) {
  if (typeof modules.getCompileCacheDir !== 'function' || !modules.getCompileCacheDir()
      || typeof modules.flushCompileCache !== 'function') return () => {};
  const timers = [3000, 10000, 30000].map(delay => {
    const timer = schedule(() => {
      try { modules.flushCompileCache(); } catch { /* Cache is an optional optimization. */ }
    }, delay);
    timer.unref?.();
    return timer;
  });
  return () => timers.forEach(cancel);
}

module.exports = { installCompileCacheFlush };
if (process.env.NODE_COMPILE_CACHE && !process.env.NODE_DISABLE_COMPILE_CACHE) installCompileCacheFlush();
