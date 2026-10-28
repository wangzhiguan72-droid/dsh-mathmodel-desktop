#!/usr/bin/env node
// Verify the authenticated installed Host's published preset declarations.
// --create-sessions additionally creates three blank sessions; it never prompts a model.
import os from 'node:os';
import path from 'node:path';
import { statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createInstalledHostClient } from './installed-host-client.mjs';
import { restoreSpecializedPresets } from './restore-specialized-presets.mjs';

const expectedIds = ['mathmodel', 'imagegen', 'editable-ppt'];
const defaultRuntimeRoot = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'Programs', 'dsh-mathmodel-desktop', 'resources', 'runtime', 'host', 'node_modules');
const defaultWorkspace = path.resolve(fileURLToPath(new URL('../dist/fusion-installed-verification/workspace', import.meta.url)));

function argumentsFrom(argv) {
  const result = { runtimeRoot: defaultRuntimeRoot, workspace: defaultWorkspace, createSessions: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--create-sessions') result.createSessions = true;
    else if (argv[i] === '--runtime-root' || argv[i] === '--log' || argv[i] === '--workspace') {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`${argv[i]} needs a path`);
      result[argv[i] === '--log' ? 'logFile' : argv[i] === '--workspace' ? 'workspace' : 'runtimeRoot'] = path.resolve(argv[++i]);
    } else throw new Error(`Unknown option: ${argv[i]}`);
  }
  return result;
}

function parseComposition(yaml, source, label) {
  const document = yaml.parseDocument(source, {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => ({ jsExpression: value }) }],
  });
  if (document.errors.length) throw new Error(`${label} is invalid YAML`);
  return document.toJS();
}

export async function verifyInstalledSpecializedPresets(options = {}) {
  const runtimeRoot = path.resolve(options.runtimeRoot || defaultRuntimeRoot);
  const workspace = path.resolve(options.workspace || defaultWorkspace);
  if (options.createSessions && !statSync(workspace).isDirectory()) throw new Error('Session verification workspace is not a directory');
  const yaml = createRequire(path.join(runtimeRoot, '__preset_verifier__.cjs'))('yaml');
  const expected = parseComposition(yaml, restoreSpecializedPresets({ runtimeRoot }).yaml, 'generated preset patch')
    .map(row => row.insert?.[0]);
  if (expected.length !== expectedIds.length || expected.some((row, index) => row?.config?.id !== expectedIds[index])) {
    throw new Error('Generated preset declarations are incomplete');
  }
  const client = options.client || await createInstalledHostClient({ logFile: options.logFile });
  const roster = await client.rpc('agentPresets', 'list');
  if (!Array.isArray(roster?.presets)) throw new Error('Host preset roster has an unexpected shape');
  const rows = [];
  for (const wanted of expected) {
    const id = wanted.config.id;
    const matches = roster.presets.filter(row => row.id === id);
    if (matches.length !== 1 || matches[0].broken || matches[0].order !== wanted.config.order) {
      throw new Error(`Host preset ${id} is missing, duplicated, broken, or out of order`);
    }
    const document = await client.rpc('agentPresets', 'read', { agentPreset: id });
    if (document?.agentPreset !== id || typeof document.content !== 'string') {
      throw new Error(`Host preset ${id} document has an unexpected shape`);
    }
    const plugins = parseComposition(yaml, document.content, `Host preset ${id}`);
    if (!Array.isArray(plugins)) throw new Error(`Host preset ${id} is not a plugin list`);
    const duplicateIds = plugins.map(plugin => plugin.id).filter((pluginId, index, ids) => ids.indexOf(pluginId) !== index);
    const personaMatches = isDeepStrictEqual(plugins.find(plugin => plugin.id === 'persona'),
      wanted.config.plugins.find(plugin => plugin.id === 'persona'));
    const pluginRosterMatches = isDeepStrictEqual(plugins.map(plugin => [plugin.id, plugin.name]),
      wanted.config.plugins.map(plugin => [plugin.id, plugin.name]));
    const declarationMatches = isDeepStrictEqual(plugins, wanted.config.plugins);
    if (duplicateIds.length || !personaMatches || !pluginRosterMatches || !declarationMatches) {
      throw new Error(`Host preset ${id} differs from the expected declaration`);
    }
    const result = { id, order: matches[0].order, broken: false, pluginRows: plugins.length,
      duplicatePluginIds: duplicateIds, personaMatches, pluginRosterMatches, declarationMatches };
    if (options.createSessions) {
      const created = await client.rpc('session', 'create', { request: { agentPreset: id, cwd: workspace } });
      if (created?.agentPreset !== id || typeof created.sessionId !== 'string') {
        throw new Error(`Blank session did not select preset ${id}`);
      }
      const projection = await client.rpc('session', 'projections', { request: { sessionId: created.sessionId } });
      if (projection?.values?.agentPreset !== id || projection?.values?.sessionListMetadata?.blank !== true) {
        throw new Error(`Blank session projection does not confirm preset ${id}`);
      }
      const listing = await client.rpc('session', 'list', { _request: {} });
      const item = listing?.items?.find(row => row.sessionId === created.sessionId);
      const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
      if (!item || typeof item.cwd !== 'string' || normalize(item.cwd) !== normalize(workspace) ||
          item.blank !== true) {
        throw new Error(`Blank session ${id} did not retain the verification workspace`);
      }
      result.blankSession = { sessionId: created.sessionId, selectedPreset: id, blank: true,
        cwd: item.cwd, workspaceCwdVerified: true };
    }
    rows.push(result);
  }
  return { schema: 'dsh.installed-specialized-presets-verification/v1', ok: true,
    observedAt: new Date().toISOString(), rosterCount: roster.presets.length,
    proof: options.createSessions ? 'registry-declarations-and-blank-session-selection' : 'registry-declarations',
    mountedToolCatalogObserved: false, modelPromptSent: false,
    presets: rows };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await verifyInstalledSpecializedPresets(argumentsFrom(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`Specialized preset verification failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
