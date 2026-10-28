// Opt-in diagnostic preload. Records lifecycle durations, never plugin config.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getCompileCacheDir, flushCompileCache } from 'node:module';

if (process.env.DSH_STARTUP_TIMING_FILE && process.argv.some(value => /[\\/]dsh[\\/]lib[\\/]bin\.js$/.test(value))) {
  const out = process.env.DSH_STARTUP_TIMING_FILE;
  const started = performance.now();
  const log = value => fs.appendFileSync(out, JSON.stringify({ elapsedMs: Math.round(performance.now() - started), ...value }) + '\n');
  log({ event: 'node-start', pid: process.pid, compileCache: getCompileCacheDir() ?? null });
  const flushTimer = setInterval(() => flushCompileCache(), 3000);
  flushTimer.unref();
  const cordisPath = path.join(process.env.LOCALAPPDATA, 'Programs/dsh-mathmodel-desktop/resources/runtime/host/node_modules/@deepseek-ai/cordis/lib/index.js');
  const { Fiber } = await import(pathToFileURL(cordisPath).href);
  const reload = Fiber.prototype._reload;
  Fiber.prototype._reload = async function (...args) {
    const at = performance.now();
    const name = this.name;
    log({ event: 'plugin-start', name, uid: this.uid });
    try { return await reload.apply(this, args); }
    finally { log({ event: 'plugin-end', name, uid: this.uid, durationMs: Math.round(performance.now() - at), failed: Boolean(this._error) }); }
  };
  process.on('exit', () => log({ event: 'node-exit' }));
}
