import { z } from 'zod';
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';

const switchesSchema = z.object({
  skills: z.boolean(),
  mcp: z.boolean(),
  taskBoard: z.boolean(),
  // Added after 0.2.0; snapshots saved before then lack them and mean "on".
  web: z.boolean().default(true),
  delegate: z.boolean().default(true),
  images: z.boolean().default(true),
  disabledMcpServers: z.array(z.string()),
}).strict();

export const DEFAULT_TOOL_SWITCHES = Object.freeze({
  skills: true, mcp: true, taskBoard: true, web: true, delegate: true, images: true, disabledMcpServers: [],
});

export function normalizeToolSwitches(value) {
  if (value === null || value === undefined) return { ...DEFAULT_TOOL_SWITCHES, disabledMcpServers: [] };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('无效的任务工具开关');
  const selected = switchesSchema.parse({ ...DEFAULT_TOOL_SWITCHES, ...value });
  if (selected.disabledMcpServers.some(name => !/^[A-Za-z0-9_-]+$/.test(name))) throw new TypeError('无效的 MCP 服务名称');
  selected.disabledMcpServers = [...new Set(selected.disabledMcpServers)].sort();
  return selected;
}

export const taskToolSwitchProjection = {
  key: 'mathmodelToolSwitches',
  stateSchema: switchesSchema.nullable(),
  init: () => null,
  apply: (state, event) => event.type === 'mathmodel/tool-switches' ? normalizeToolSwitches(event.data) : state,
  wire: { viewSchema: switchesSchema.nullable(), view: state => state },
  stateVersion: 1,
};

// Schemas the model may see. Before the first turn it follows the selection; after it only widens,
// because removing an offered schema breaks the provider prefix cache. The guard still enforces the selection.
const widen = (wire, next) => ({
  skills: wire.skills || next.skills, mcp: wire.mcp || next.mcp, taskBoard: wire.taskBoard || next.taskBoard,
  web: wire.web || next.web, delegate: wire.delegate || next.delegate, images: wire.images || next.images,
  disabledMcpServers: wire.mcp && next.mcp ? wire.disabledMcpServers.filter(name => next.disabledMcpServers.includes(name))
    : wire.mcp ? wire.disabledMcpServers : next.disabledMcpServers,
});
const wireSchema = z.object({ selection: switchesSchema.nullable(), started: z.boolean() }).strict();
export const taskToolWireProjection = {
  key: 'mathmodelToolSwitchWire',
  stateSchema: wireSchema,
  init: () => ({ selection: null, started: false }),
  apply: (state, event) => {
    if (event.type === 'turn/start') return state.started ? state : { ...state, started: true };
    if (event.type !== 'mathmodel/tool-switches') return state;
    const next = normalizeToolSwitches(event.data);
    return { ...state, selection: state.started ? widen(normalizeToolSwitches(state.selection), next) : next };
  },
  wire: { viewSchema: wireSchema, view: state => state },
  stateVersion: 1,
};

const WEB_TOOLS = new Set(['web_fetch', 'web_search']);
const DELEGATE_TOOLS = new Set(['delegate', 'handoff_ledger']);
// Same names as IMAGE_TOOLS in capabilities.js, which imports a Host-only package.
const IMAGES = new Set(['vision_analyze', 'image_generate', 'editable_ppt_image']);
export function toolDenied(name, selection) {
  if (name === 'skill') return !selection.skills;
  if (name.startsWith('task_board_')) return !selection.taskBoard;
  if (WEB_TOOLS.has(name)) return !selection.web;
  if (DELEGATE_TOOLS.has(name)) return !selection.delegate;
  if (IMAGES.has(name)) return !selection.images;
  if (!name.startsWith('mcp__')) return false;
  if (!selection.mcp) return true;
  return selection.disabledMcpServers.some(server => name.startsWith(`mcp__${server}__`));
}

export function assertTaskIdle(agent, boundary) {
  if (agent?.status !== 'idle' || !boundary || boundary.openTurnStartSeq !== null
      || !Number.isInteger(boundary.lastTurn) || boundary.lastTurn < 0) {
    throw new RemoteError('capabilities/task-busy', '请等待任务空闲后再修改本任务的工具开关。', {});
  }
}

/** Changes only the calling Agent's inherited tool view. The guard also covers scoped shadows. */
export function installAgentToolSwitches(agent, readSelection, rootContext = agent.ctx, readWireSelection = readSelection) {
  const ctx = agent.ctx;
  if (!ctx?.tools?.restrict || !ctx?.tools?.view) throw new Error('Task tool switches require an Agent tool scope');
  let denySignature = '', disposeRestriction, refreshing = false, disposed = false;
  const disposeGuard = ctx.tools.guard(exec => {
    if (toolDenied(exec.name, normalizeToolSwitches(readSelection()))) return '当前任务已关闭此工具；可在能力组合中重新开启。';
  });
  const refresh = () => {
    if (disposed || refreshing) return;
    refreshing = true;
    try {
      const selected = normalizeToolSwitches(readWireSelection());
      const known = ctx.tools.view(agent).restrictableNames;
      const names = [...known].filter(name => toolDenied(name, selected)).sort();
      const nextSignature = names.join('\0');
      if (nextSignature === denySignature) return;
      const nextRestriction = names.length ? ctx.tools.restrict({ deny: names }) : undefined;
      const oldRestriction = disposeRestriction;
      disposeRestriction = nextRestriction;
      denySignature = nextSignature;
      oldRestriction?.();
    } finally { refreshing = false; }
  };
  const stopWatching = rootContext.on('tools/change', refresh);
  refresh();
  return {
    refresh,
    dispose() {
      if (disposed) return;
      disposed = true;
      stopWatching();
      disposeRestriction?.();
      disposeGuard();
    },
  };
}

export class TaskToolSwitchController {
  #installed = new Map();
  constructor({ agents, projections }) { Object.assign(this, { agents, projections }); }
  agent(sessionId) {
    const agent = this.agents.get(sessionId);
    if (!agent) throw new RemoteError('capabilities/session-unavailable', '请打开当前任务后再配置能力。', {});
    return agent;
  }
  selection(agent) { return normalizeToolSwitches(this.projections.stateOf(agent.session, 'mathmodelToolSwitches')); }
  // An owned child also keeps its parent's offered schemas, so a fork can reuse the inherited prefix.
  wireSelection(agent) {
    const own = normalizeToolSwitches(this.projections.stateOf(agent.session, 'mathmodelToolSwitchWire')?.selection);
    const parent = this.ownerOf(agent);
    return parent ? widen(own, this.wireSelection(parent)) : own;
  }
  ownerOf(agent) {
    const header = agent.session.header;
    if (header?.origin !== 'subagent' || !header.parentSession) return null;
    const parent = this.agents.get(header.parentSession);
    return parent && this.agents.isOwnedBy?.(agent.id, parent) ? parent : null;
  }
  descendantsOf(agent) {
    if (typeof this.agents.list !== 'function') throw new RemoteError('capabilities/agents-unavailable', '无法核对运行中的子任务，工具开关未修改。', {});
    const all = this.agents.list();
    if (!Array.isArray(all)) throw new RemoteError('capabilities/agents-unavailable', '无法核对运行中的子任务，工具开关未修改。', {});
    const descendants = [], queue = [agent];
    const visited = new Set([agent.id]);
    while (queue.length) {
      const parent = queue.shift();
      for (const candidate of all) {
        if (visited.has(candidate.id) || candidate.session.header?.origin !== 'subagent'
            || candidate.session.header.parentSession !== parent.id
            || !this.agents.isOwnedBy?.(candidate.id, parent)) continue;
        visited.add(candidate.id);
        descendants.push(candidate);
        queue.push(candidate);
      }
    }
    return descendants;
  }
  track(agent, installed) {
    const previous = this.#installed.get(agent.id);
    if (previous?.agent === agent) { installed.dispose?.(); return; }
    previous?.dispose?.();
    this.#installed.set(agent.id, { ...installed, agent });
  }
  attach(agent, rootContext) {
    if (this.#installed.get(agent.id)?.agent === agent) return;
    const parent = this.ownerOf(agent);
    if (parent) {
      const inherited = this.selection(parent);
      if (JSON.stringify(this.selection(agent)) !== JSON.stringify(inherited)) {
        agent.session.append('mathmodel/tool-switches', inherited, { ignorable: true });
      }
    }
    this.track(agent, installAgentToolSwitches(agent, () => this.selection(agent), rootContext, () => this.wireSelection(agent)));
  }
  dispose(sessionId) {
    if (sessionId !== undefined) {
      this.#installed.get(sessionId)?.dispose?.(); this.#installed.delete(sessionId);
    } else {
      for (const installed of this.#installed.values()) installed.dispose?.();
      this.#installed.clear();
    }
  }
  describe(sessionId) {
    const agent = this.agent(sessionId);
    const boundary = this.projections.stateOf(agent.session, 'turnBoundary');
    let canEdit = true;
    try { assertTaskIdle(agent, boundary); } catch { canEdit = false; }
    const visible = agent.ctx?.tools?.view(agent)?.visible;
    return { selection: this.selection(agent), canEdit,
      effectiveToolNames: visible ? [...visible.keys()].sort() : [] };
  }
  set(sessionId, selection) {
    const agent = this.agent(sessionId);
    if (agent.session.header?.origin === 'subagent') throw new RemoteError('capabilities/child-inherits', '子任务沿用父任务的工具开关，请在父任务中修改。', {});
    assertTaskIdle(agent, this.projections.stateOf(agent.session, 'turnBoundary'));
    const descendants = this.descendantsOf(agent);
    for (const child of descendants) assertTaskIdle(child, this.projections.stateOf(child.session, 'turnBoundary'));
    const next = normalizeToolSwitches(selection);
    for (const child of descendants) {
      child.session.append('mathmodel/tool-switches', next, { ignorable: true });
      this.#installed.get(child.id)?.refresh();
    }
    agent.session.append('mathmodel/tool-switches', next, { ignorable: true });
    this.#installed.get(agent.id)?.refresh();
    return this.describe(sessionId);
  }
}
