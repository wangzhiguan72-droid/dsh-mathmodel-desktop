import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { symbols } from '@deepseek-ai/cordis';
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { HostMutationGate, hasStartedTaskBoundary, installPluginManagerFreeze } from './host-freeze-policy.js';
import { TaskToolSwitchController, taskToolSwitchProjection, taskToolWireProjection, assertTaskIdle } from './task-tool-switches.js';

export const TASK_PRESET = 'task';
export const HOST_GROUPS = Object.freeze([
  ['fusion', 'Fusion', /dsh-model-fusion/i],
  ['teams', 'Teams', /agent-team/i],
  ['auto', 'Auto', /auto-review/i],
  ['mcp', 'MCP 外部服务', /dsh-mcp-client/i],
  ['taskBoard', '任务板', /task[-_]board/i],
]);
const relevant = value => HOST_GROUPS.some(([, , pattern]) => pattern.test(value ?? '')) || /mathmodel/.test(value ?? '') || value === 'preset-task';
function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]));
  return value;
}
export const capabilityDigest = value => createHash('sha256').update(JSON.stringify(sorted(value))).digest('hex');
// Official external-event compatibility marker; the bundled append bridge forwards it.
// Managed presets still reject execution when this Host guard is unavailable.
const appendCapabilityEvent = (session, type, data) => session.append(type, data, { ignorable: true });
const snapshotSchema = z.object({ schema: z.literal(1), preset: z.string(), hostHash: z.string(), globalToolsHash: z.string(), confirmedAt: z.string(), inventory: z.array(z.unknown()), inheritedFrom: z.string().optional(), blockedReason: z.string().optional() });
export const capabilityProjection = {
  key: 'mathmodelCapabilities', stateSchema: snapshotSchema.nullable(), init: () => null,
  apply: (state, event) => event.type === 'mathmodel/capabilities-confirmed' ? snapshotSchema.parse(event.data)
    : event.type === 'mathmodel/capabilities-blocked' && state ? { ...state, blockedReason: String(event.data.reason) }
    : event.type === 'mathmodel/capabilities-restored' && state ? { ...state, blockedReason: undefined } : state,
  wire: { viewSchema: snapshotSchema.nullable(), view: state => state }, stateVersion: 1,
};

export function hostInventory(bundles, plugins, globalNames = [], mcpEntries = []) {
  return HOST_GROUPS.map(([id, label, pattern]) => {
    const declarations = bundles.filter(row => pattern.test(row.name));
    const entries = plugins.filter(row => pattern.test(row.moduleName));
    const enabled = declarations.some(row => row.enabled) || entries.some(row => row.enabled);
    const enabledEntries = entries.filter(row => row.enabled);
    const state = !enabled ? (declarations.length || entries.length ? 'disabled' : 'not-installed')
      : declarations.some(row => row.enabled && row.error) || enabledEntries.some(row => row.fiberPhase === 'failed') ? 'failed'
      : enabledEntries.length && enabledEntries.every(row => row.fiberPhase === 'active') ? 'active' : 'loading';
    return { id, label, enabled, state,
      entries: entries.map(({ entryId, moduleName, enabled, fiberPhase }) => ({ entryId, moduleName, enabled, fiberPhase })),
      ...(id === 'mcp' ? {
        connection: globalNames.some(name => name.startsWith('mcp__')) ? 'tools-published' : 'unverified',
        publishedTools: globalNames.filter(name => name.startsWith('mcp__')).length,
        servers: mcpEntries.map(({ entryId, serverName }) => {
          const prefix = `mcp__${serverName.replace(/[^A-Za-z0-9_-]/g, '_')}__`;
          const tools = globalNames.filter(name => name.startsWith(prefix));
          const entry = entries.find(row => row.entryId === entryId);
          return { entryId, serverName, enabled: entry?.enabled === true, state: entry?.fiberPhase ?? 'disabled', tools, publishedTools: tools.length };
        }),
      } : {}),
      ...(id === 'taskBoard' ? { publishedTools: globalNames.filter(name => name.startsWith('task_board_')).length } : {}),
    };
  });
}

export class HostCapabilityController {
  constructor({ manager, agents, projections, presets, tools, gate, readConfiguration }) {
    Object.assign(this, { manager, agents, projections, presets, tools, gate, readConfiguration });
  }
  agent(sessionId) {
    const agent = this.agents.get(sessionId);
    if (!agent) throw new RemoteError('capabilities/session-unavailable', '请打开当前任务后再配置能力。', {});
    return agent;
  }
  boundary(agent) { return { id: agent.id, boundary: this.projections.stateOf(agent.session, 'turnBoundary') }; }
  async current() {
    const [bundles, plugins, configuration] = await Promise.all([this.manager.listBundles(), this.manager.listPlugins(), this.readConfiguration()]);
    if (!Array.isArray(bundles) || !Array.isArray(plugins)) throw new Error('Host inventory shape is unsupported');
    const globalSchemas = this.tools.wireSchemas().schemas;
    const inventory = hostInventory(bundles, plugins, globalSchemas.map(row => row.name));
    const fingerprint = {
      bundles: bundles.map(({ name, version, enabled, error }) => ({ name, version, enabled, error })).sort((a, b) => a.name.localeCompare(b.name)),
      plugins: plugins.filter(row => relevant(row.moduleName)).map(({ entryId, moduleName, enabled }) => ({ entryId, moduleName, enabled })).sort((a, b) => a.entryId.localeCompare(b.entryId)),
      configuration,
      globalSchemas,
    };
    return { hostHash: capabilityDigest(fingerprint), globalToolsHash: capabilityDigest(globalSchemas), inventory };
  }
  describe(sessionId) {
    return this.gate.read(async () => {
      const agent = this.agent(sessionId), current = await this.current();
      const confirmed = this.projections.stateOf(agent.session, 'mathmodelCapabilities');
      return { ...current, locked: hasStartedTaskBoundary(this.boundary(agent)), confirmed,
        matches: Boolean(confirmed && confirmed.hostHash === current.hostHash && confirmed.globalToolsHash === current.globalToolsHash) };
    });
  }
  confirm(sessionId, preset, hostHash) {
    return this.gate.read(async () => {
      if (preset !== TASK_PRESET) throw new RemoteError('capabilities/invalid-preset', '无效的任务预设。', {});
      const agent = this.agent(sessionId);
      if (hasStartedTaskBoundary(this.boundary(agent))) throw new RemoteError('agent-preset/locked', '任务已开始，不能修改能力组合。', {});
      const current = await this.current();
      if (hostHash !== current.hostHash) throw new RemoteError('capabilities/host-changed', 'Host 状态已变化，请刷新能力面板后重新确认。', {});
      if (current.inventory.some(row => row.enabled && row.state !== 'active')) throw new RemoteError('capabilities/host-unsettled', '所选 Host 扩展尚未激活或加载失败，请先处理插件状态。', {});
      await this.presets.select(agent, preset);
      // select owns its own race check. If a first turn wins afterwards, its pre-step waits for this gate.
      const snapshot = { schema: 1, preset, ...current, confirmedAt: new Date().toISOString() };
      appendCapabilityEvent(agent.session, 'mathmodel/capabilities-confirmed', snapshotSchema.parse(snapshot));
      return snapshot;
    });
  }
  async verify(agent) {
    if (this.projections.stateOf(agent.session, 'agentPreset') !== TASK_PRESET) return null;
    const confirmed = this.projections.stateOf(agent.session, 'mathmodelCapabilities');
    if (!confirmed) return '请先在「能力组合」面板确认 Host 状态；本任务尚未发送模型请求。';
    const current = await this.current();
    if (confirmed.preset !== this.projections.stateOf(agent.session, 'agentPreset') || confirmed.hostHash !== current.hostHash || confirmed.globalToolsHash !== current.globalToolsHash) {
      return 'Host 能力或配置与任务确认快照不一致，任务已暂停。恢复原配置后重试，或新建任务重新确认。';
    }
    if (current.inventory.some(row => row.enabled && row.state !== 'active')) return '任务依赖的 Host 扩展未激活，任务已暂停。';
    return null;
  }
  async inheritChild(agent, parent) {
    if (this.projections.stateOf(agent.session, 'mathmodelCapabilities')) return;
    if (!parent || this.agents.get(parent.id) !== parent || agent.session.header.origin !== 'subagent'
      || agent.session.header.parentSession !== parent.id || !this.agents.isOwnedBy(agent.id, parent)) return;
    const preset = this.projections.stateOf(parent.session, 'agentPreset');
    const snapshot = this.projections.stateOf(parent.session, 'mathmodelCapabilities');
    if (!snapshot || snapshot.preset !== preset || agent.session.header.agentPreset !== preset
      || this.projections.stateOf(agent.session, 'agentPreset') !== preset || await this.verify(parent)) return;
    const { blockedReason, ...inherited } = snapshot;
    appendCapabilityEvent(agent.session, 'mathmodel/capabilities-confirmed', { ...inherited, inheritedFrom: parent.id });
  }
}

export async function hostConfiguration(ctx, readScope) {
  // The scope SDK is supplied by the bundled Host, as for the scoped capability plugin.
  const scopeOf = readScope ?? (await import('@deepseek-ai/dsh-scope')).scopeOf;
  const profile = ctx.profileContext;
  const source = await readFile(join(profile.dir, 'cordis.patch.yml'), 'utf8');
  const doc = YAML.parseDocument(source, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] });
  if (doc.errors.length) throw new Error('Host configuration cannot be verified');
  const pick = rows => rows.flatMap(row => {
    if (relevant(row.name) || relevant(row.id)) return [row];
    return [...(Array.isArray(row.insert) ? pick(row.insert) : []), ...(row.group && Array.isArray(row.config) ? pick(row.config) : [])];
  });
  const live = [...ctx.loader.entries()].filter(row => row.fiber && scopeOf(row.fiber.ctx) === undefined && (relevant(row.options?.name) || relevant(row.options?.id)));
  // Declarative default/bundle configuration is not always repeated in the user's patch.
  // Hash the resolved values without storing or returning configuration/credentials.
  const resolved = live.map(row => ({ id: row.id, name: row.options.name,
    config: JSON.parse(JSON.stringify(row.fiber.config ?? row.options.config ?? {})) })).sort((a, b) => a.id.localeCompare(b.id));
  const manifest = JSON.parse(await readFile(join(profile.dir, 'package.json'), 'utf8'));
  const config = { patch: pick(doc.toJS()), resolved, manifest: { dependencies: manifest.dependencies, profile: manifest.dsh?.profile }, fusion: null };
  const fusion = live.find(row => row.options?.name === 'dsh-model-fusion' && row.fiber?.config);
  const database = fusion?.fiber?.config?.databasePath;
  if (database) {
    if (!isAbsolute(database)) throw new Error('Fusion database path cannot be verified');
    if (existsSync(database)) {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(database, { readOnly: true });
      try { config.fusion = db.prepare("SELECT id, json FROM documents WHERE id IN ('settings:profile', 'settings:authorization') ORDER BY id").all(); }
      finally { db.close(); }
    }
  }
  return config;
}

export class MathmodelHostCapabilitiesGateway extends TypertRemoteService {
  constructor(ctx, controller, taskTools) {
    super(ctx, 'mathmodelHostCapabilities'); this.controller = controller; this.taskTools = taskTools; this.hostContext = ctx;
    for (const method of ['describe', 'confirm', 'describeTools', 'setTools', 'selectModel']) Remote(method)(MathmodelHostCapabilitiesGateway.prototype[method], {
      kind: 'method', name: method, static: false, private: false, addInitializer: initializer => initializer.call(this),
    });
  }
  describe(sessionId) { return this.controller.describe(sessionId); }
  confirm(sessionId, preset, hostHash) { return this.controller.confirm(sessionId, preset, hostHash); }
  async describeTools(sessionId) {
    const agent = this.controller.agent(sessionId);
    const view = this.taskTools.describe(sessionId);
    const schemas = this.hostContext.tools.wireSchemas().schemas;
    const plugins = await this.hostContext.pluginManager.listPlugins();
    const mcpEntries = [...this.hostContext.loader.entries()].flatMap(row => {
      if (!/dsh-mcp-client/i.test(row.options?.name ?? '')) return [];
      const config = row.fiber?.config ?? row.options?.config;
      if (typeof config?.serverName !== 'string') return [];
      const entryId = plugins.find(plugin => plugin.entryId === row.id || plugin.entryId === `include:${row.id}`)?.entryId ?? row.id;
      return [{ entryId, serverName: config.serverName }];
    });
    const inventory = hostInventory([], plugins, schemas.map(row => row.name), mcpEntries);
    const sandboxAuto = plugins.find(row => /dsh-auto-mode/i.test(row.moduleName));
    inventory.push({ id: 'sandboxAuto', label: 'Sandbox Auto 权限审查', enabled: sandboxAuto?.enabled === true,
      state: sandboxAuto?.enabled ? sandboxAuto.fiberPhase : 'disabled' });
    const catalog = await this.hostContext.sessionController.modelCatalog();
    const modelState = this.controller.projections.stateOf(agent.session, 'modelSelection');
    const model = modelState?.pending ?? modelState?.next ?? modelState?.lastUsed ?? catalog.default;
    return { ...view, inventory, model, modelGroups: catalog.groups,
      permissionPreset: this.hostContext.get('permissionPresets')?.current(agent.session),
      skillToolAvailable: agent.ctx.tools.get('skill', agent) !== undefined,
      toolCount: agent.ctx.tools.wireSchemas(agent).schemas.length };
  }
  async setTools(sessionId, selection) {
    this.taskTools.set(sessionId, selection);
    return this.describeTools(sessionId);
  }
  async selectModel(sessionId, provider, model) {
    const agent = this.controller.agent(sessionId);
    assertTaskIdle(agent, this.controller.boundary(agent).boundary);
    if (typeof provider !== 'string' || typeof model !== 'string' || !provider || !model) throw new Error('请选择一个模型。');
    await this.hostContext.sessionController.selectModel({ sessionId, provider, model });
    return this.describeTools(sessionId);
  }
}

export function installHostCapabilities(ctx) {
  ctx.inject(['pluginManager', 'agents', 'sessionProjections', 'agentPresets', 'tools', 'loader', 'profileContext', 'sessionController', 'permissionPresets'], scope => {
    const gate = new HostMutationGate();
    const controller = new HostCapabilityController({ manager: scope.pluginManager, agents: scope.agents,
      projections: scope.sessionProjections, presets: scope.agentPresets, tools: scope.tools, gate,
      readConfiguration: () => hostConfiguration(scope) });
    scope.sessionProjections.register(capabilityProjection);
    scope.sessionProjections.register(taskToolSwitchProjection);
    scope.sessionProjections.register(taskToolWireProjection);
    const taskTools = new TaskToolSwitchController({ agents: scope.agents, projections: scope.sessionProjections });
    for (const agent of scope.agents.list()) taskTools.attach(agent, scope);
    scope.effect(() => () => taskTools.dispose(), 'mathmodel: task tool switches');
    const manager = scope.pluginManager[symbols.original] ?? scope.pluginManager;
    scope.effect(() => installPluginManagerFreeze(manager, gate, () => scope.agents.list().map(agent => controller.boundary(agent))), 'mathmodel: freeze Host mutation');
    new MathmodelHostCapabilitiesGateway(scope, controller, taskTools);
    scope.on('agent/created', ({ agent }) => taskTools.attach(agent, scope));
    scope.on('agent/disposed', ({ agent }) => taskTools.dispose(agent.id));
    scope.on('agent/created', payload => gate.read(() => controller.inheritChild(payload.agent, scope.agents.currentInitiator())));
    const refuse = (agent, reason) => {
      appendCapabilityEvent(agent.session, 'mathmodel/capabilities-blocked', { reason });
      scope.emit('mathmodel/capabilities-blocked', agent.id, reason);
    };
    scope.on('agent/pre-step', async (payload, next) => {
      const reason = await gate.read(() => controller.verify(payload.agent));
      if (reason) { refuse(payload.agent, reason); return { kind: 'reject' }; }
      if (scope.sessionProjections.stateOf(payload.agent.session, 'mathmodelCapabilities')?.blockedReason) appendCapabilityEvent(payload.agent.session, 'mathmodel/capabilities-restored', {});
      return next();
    }, { prepend: true });
    scope.on('agent/request', async (payload, next) => {
      const result = await next();
      const reason = await gate.read(() => controller.verify(payload.agent));
      if (reason) { refuse(payload.agent, reason); throw new RemoteError('capabilities/frozen', reason, {}); }
      return result;
    }, { prepend: true });
    scope.on('tools/pre-execute', async (exec, next) => {
      if (exec.agent) {
        const reason = await gate.read(() => controller.verify(exec.agent));
        if (reason) throw new RemoteError('capabilities/frozen', reason, {});
      }
      return next();
    }, { prepend: true });
  });
}
