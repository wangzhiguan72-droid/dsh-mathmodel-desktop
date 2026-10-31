import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import Schema from '@deepseek-ai/schemastery';

export const ROLES = Object.freeze(['explore', 'implement', 'review', 'escalate']);
export const WRITE_ROLES = new Set(['implement', 'escalate']);
const REQUIRED = ['role', 'title', 'goal', 'context', 'constraints', 'done_when'];
const ROLE_LABEL = { explore: '探查', implement: '实现', review: '验收', escalate: '升级重做' };

export const pathKey = (p, cwd) => {
  const full = resolve(cwd, String(p));
  return process.platform === 'win32' ? full.toLowerCase() : full;
};
export const samePath = (a, b, cwd) => pathKey(a, cwd) === pathKey(b, cwd);

const text = value => typeof value === 'string' ? value.trim() : '';

export function validateBrief(args) {
  const input = args && typeof args === 'object' ? args : {};
  const brief = {};
  for (const key of [...REQUIRED, 'escalates']) brief[key] = text(input[key]);
  brief.files = Array.isArray(input.files) ? input.files.map(text).filter(Boolean) : [];
  const missing = REQUIRED.filter(key => !brief[key]);
  const errors = [];
  if (brief.role && !ROLES.includes(brief.role)) errors.push(`未知角色 ${brief.role}，可选：${ROLES.join(' / ')}`);
  if (WRITE_ROLES.has(brief.role) && !brief.files.length) missing.push('files');
  if (brief.role === 'escalate' && !brief.escalates) missing.push('escalates');
  if (!brief.escalates) delete brief.escalates;
  return missing.length || errors.length ? { ok: false, missing, errors } : { ok: true, brief };
}

export function renderBrief(brief, { id }) {
  const write = WRITE_ROLES.has(brief.role);
  return [
    `你是一个子代理，角色：${brief.role}（${ROLE_LABEL[brief.role]}），交接编号 ${id}。`,
    '你看不到主对话，下面的交接单就是你知道的全部背景。不清楚的地方写进回执的 open_questions，不要猜。',
    '',
    `## 目标\n${brief.goal}`,
    `## 已知背景\n${brief.context}`,
    `## 相关文件\n${brief.files.length ? brief.files.map(f => `- ${f}`).join('\n') : '（未指定）'}`,
    `## 约束\n${brief.constraints}`,
    `## 完成标准\n${brief.done_when}`,
    '',
    write
      ? `你只能修改以下文件：${brief.files.join('、')}。其他文件一律不改，包括用终端改。`
      : '你不得修改文件（包括用终端改），只读代码、跑只读命令。',
    '结束时按要求的 JSON 格式交回执：每条结论附证据（文件:行号，或命令加输出摘录）；没验证到的写进 not_verified；没把握就把 status 设为 unsure。',
  ].join('\n');
}

const strings = { type: 'array', items: { type: 'string' } };
export function receiptSchema(role) {
  const review = role === 'review';
  const finding = {
    type: 'object', additionalProperties: false,
    required: ['claim', 'evidence', ...(review ? ['level'] : [])],
    properties: {
      claim: { type: 'string' }, evidence: { type: 'string' },
      ...(review ? { level: { type: 'string', enum: ['blocker', 'major', 'minor'] } } : {}),
    },
  };
  const properties = {
    status: { type: 'string', enum: ['done', 'partial', 'blocked', 'unsure'] },
    ...(review ? { verdict: { type: 'string', enum: ['pass', 'fail'] } } : {}),
    summary: { type: 'string' },
    findings: { type: 'array', items: finding },
    files_changed: strings,
    commands_run: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['command', 'exit_code', 'result'],
      properties: { command: { type: 'string' }, exit_code: { type: 'integer' }, result: { type: 'string' } } } },
    not_verified: strings,
    open_questions: strings,
  };
  return { type: 'object', additionalProperties: false, required: Object.keys(properties), properties };
}

export function checkViolation(role, brief, receipt, cwd) {
  const changed = Array.isArray(receipt?.files_changed) ? receipt.files_changed : [];
  if (!WRITE_ROLES.has(role)) return changed.length ? [`只读角色报告改了文件：${changed.join('、')}`] : [];
  const allowed = new Set(brief.files.map(f => pathKey(f, cwd)));
  const outside = changed.filter(f => !allowed.has(pathKey(f, cwd)));
  return outside.length ? [`改动超出 files：${outside.join('、')}`] : [];
}

// ponytail: 进程内全局锁，重启即清空；运行中的子代理也不会跨重启继续写，所以够用。
export class WriteLocks {
  #held = new Map(); // pathKey -> handoffId
  acquire(handoffId, files, cwd) {
    const keys = files.map(file => [file, pathKey(file, cwd)]);
    const conflicts = keys.filter(([, key]) => this.#held.has(key) && this.#held.get(key) !== handoffId)
      .map(([file, key]) => ({ file, holder: this.#held.get(key) }));
    if (conflicts.length) return { ok: false, conflicts };
    for (const [, key] of keys) this.#held.set(key, handoffId);
    return { ok: true };
  }
  release(handoffId) {
    for (const [key, holder] of this.#held) if (holder === handoffId) this.#held.delete(key);
  }
}
export const writeLocks = new WriteLocks();

/** childId -> { role, files: Set<pathKey>, cwd } for running handoffs. */
export const children = new Map();
const FILE_TOOLS = new Set(['write', 'edit']);
// Children never touch gates, project state, schedules or plugins; the read-only mm_* stay open.
const CHILD_READ_MM = new Set(['mm_state', 'mm_skill_read', 'mm_check_deliverables']);
const childForbidden = name => (name.startsWith('mm_') && !CHILD_READ_MM.has(name)) || name.startsWith('schedule_') || name.startsWith('plugin_');

// ponytail: 终端不受守卫，子代理可用 pwsh 改文件；回执违规检查兜底，需要时再加命令审查。
export function childGuard(exec) {
  const child = exec.agent ? children.get(exec.agent.id) : undefined;
  if (!child) return undefined;
  if (exec.name === 'delegate') return '子代理不能再派交接；请自己完成这一块，或在回执里交回给主代理。';
  if (childForbidden(exec.name)) return '子代理不能改门禁、项目状态、定时任务或插件；把结论写进回执交给主代理。';
  if (!FILE_TOOLS.has(exec.name)) return undefined;
  if (!WRITE_ROLES.has(child.role)) return '只读角色不能修改文件；把需要的改动写进回执交给主代理。';
  const target = exec.arguments?.file_path;
  if (typeof target !== 'string' || !child.files.has(pathKey(target, child.cwd))) return '该文件不在本次交接的 files 里，不能修改。';
  return undefined;
}

export const name = 'dsh-handoff';
export const inject = ['tools', 'subagents', 'systemPrompt', 'workingDirectory'];
const FLASH = { provider: 'magpie', model: 'workbuddy-ai/deepseek-v4.1-flash' };
const ASTRA = { provider: 'wanzhao-astra', model: 'gpt-6-astra' };
export const DEFAULT_ROLES = Object.freeze({ explore: FLASH, implement: FLASH, review: ASTRA, escalate: ASTRA });
const Route = Schema.object({ provider: Schema.string().required(), model: Schema.string().required(), reasoningEffort: Schema.string() });
export const Config = Schema.object({
  roles: Schema.object(Object.fromEntries(ROLES.map(role => [role, Route.default(DEFAULT_ROLES[role])]))).default({}),
  ledgerDir: Schema.string().default('.dsh-handoff'),
});

export const RULES = [
  '## 交接子代理（delegate）',
  '1. 先自己看懂问题，再派活。交接单要能让一个没看过对话的人照着做。',
  '2. 互不依赖的只读交接放在同一条消息里一起发。',
  '3. 子代理的回执是报告，不是证据。告诉用户“完成”之前，自己看 diff 或跑 done_when 里写的检查。',
  '4. 每次 implement 完成后派一次 review。review 的交接单只写需求、相关文件和完成标准，不写自己的判断。',
  '5. 回执是 unsure / blocked，或者 review 没通过，用 escalate 换强模型重做这一块，或者自己做。不要让 Flash 在同一块上反复重试。',
].join('\n');

const defaultDeps = {
  // Child ids are session ids; match the kernel's own `session-<uuid>` form.
  randomUUID: () => `session-${randomUUID()}`,
  now: () => new Date().toISOString(),
  appendLine: async (file, row) => { await mkdir(dirname(file), { recursive: true }); await appendFile(file, `${JSON.stringify(row)}\n`, 'utf8'); },
  readLedger: async file => {
    try { return (await readFile(file, 'utf8')).split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  },
};
const anyObject = { type: 'object', additionalProperties: true };
const textOf = blocks => (Array.isArray(blocks) ? blocks : []).filter(block => block?.type === 'text').map(block => block.text).join('\n');

function renderResult(value) {
  const head = `[${value.role}] ${value.title} · ${value.status}${value.verdict ? ` · ${value.verdict}` : ''} · 改动 ${value.files_changed.length} 个文件`;
  const lines = [head, ...(value.violations.length ? [`⚠ 违规：${value.violations.join('；')}`] : []), JSON.stringify(value.receipt, null, 2)];
  return [{ type: 'text', text: lines.join('\n') }];
}

const DELEGATE_PARAMETERS = {
  type: 'object', additionalProperties: false,
  required: ['role', 'title', 'goal', 'context', 'files', 'constraints', 'done_when'],
  properties: {
    role: { type: 'string', enum: [...ROLES] },
    title: { type: 'string', description: '3 到 8 个字的显示名' },
    goal: { type: 'string', description: '这一块要达成什么，一两句话' },
    context: { type: 'string', description: '子代理需要知道的事实：已经确认的、已经排除的方向。它看不到主对话。' },
    files: { type: 'array', items: { type: 'string' }, description: '相关文件。implement / escalate 必填，并且只能改这些文件' },
    constraints: { type: 'string', description: '不能做的事' },
    done_when: { type: 'string', description: '可检查的完成标准' },
    escalates: { type: 'string', description: 'escalate 必填：被重做的那次交接的 id' },
  },
};

export function apply(ctx, config = {}, overrides = {}) {
  const deps = { ...defaultDeps, ...overrides };
  const roles = { ...DEFAULT_ROLES, ...config.roles };
  const ledgerFile = cwd => join(cwd, config.ledgerDir ?? '.dsh-handoff', 'ledger.jsonl');
  const record = async (cwd, row) => {
    try { await deps.appendLine(ledgerFile(cwd), { ...row, at: deps.now() }); }
    catch (error) { ctx.logger?.warn?.(`账本写入失败：${error.message}`); }
  };
  ctx.tools.guard(childGuard);

  async function delegate(args, exec) {
    const checked = validateBrief(args);
    if (!checked.ok) throw new Error(`交接单不完整：${[...checked.missing.map(key => `缺少 ${key}`), ...checked.errors].join('；')}`);
    const { brief } = checked;
    const route = roles[brief.role];
    if (!route?.provider || !route?.model) throw new Error(`角色 ${brief.role} 的模型路线没有配置`);
    const agentOptions = { provider: route.provider, model: route.model, ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}) };
    const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal);
    try { await ctx.get('llm')?.resolveCallConfig(agentOptions, exec.signal); }
    catch (error) { throw new Error(`角色 ${brief.role} 的模型路线 ${route.provider}/${route.model} 不可用：${error.message}`); }
    const id = deps.randomUUID();
    if (WRITE_ROLES.has(brief.role)) {
      const lock = writeLocks.acquire(id, brief.files, cwd);
      if (!lock.ok) throw new Error(`文件正被其他交接占用：${lock.conflicts.map(c => `${c.file}（交接 ${c.holder}）`).join('、')}。等它结束，或换一组文件。`);
    }
    children.set(id, { role: brief.role, files: new Set(brief.files.map(f => pathKey(f, cwd))), cwd });
    const end = { kind: 'end', id, status: 'blocked', files_changed: [], violations: [], stopReason: null };
    let onAbort;
    try {
      await record(cwd, { kind: 'start', id, parent: exec.agent?.id, role: brief.role, title: brief.title, brief });
      const activation = await ctx.subagents.startActivation({
        provider: 'spawn', label: brief.title, childId: id, signal: exec.signal, delivery: 'caller',
        request: { cwd, parent: exec.agent, prompt: [{ type: 'text', text: renderBrief(brief, { id }) }], agentOptions, outputSchema: receiptSchema(brief.role) },
      });
      // dispose may reject; an unhandled rejection is fatal in the Host.
      onAbort = () => { Promise.resolve().then(() => activation.dispose()).catch(() => {}); };
      exec.signal.addEventListener('abort', onAbort, { once: true });
      if (exec.signal.aborted) onAbort();
      const result = await activation.result;
      const receipt = result?.structured ?? null;
      Object.assign(end, {
        status: receipt?.status ?? 'blocked',
        ...(receipt?.verdict ? { verdict: receipt.verdict } : {}),
        files_changed: receipt?.files_changed ?? [],
        violations: receipt ? checkViolation(brief.role, brief, receipt, cwd) : ['回执缺失或不符合格式'],
        stopReason: result?.stopReason ?? null,
      });
      const { kind: _kind, ...summary } = end;
      return {
        ...summary, role: brief.role, title: brief.title, receipt,
        ...(receipt ? {} : { output: textOf(result?.output) }),
        ...(result?.diagnostic ? { diagnostic: result.diagnostic } : {}),
      };
    } catch (error) {
      end.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      if (onAbort) exec.signal.removeEventListener('abort', onAbort);
      writeLocks.release(id);
      children.delete(id);
      await record(cwd, end);
    }
  }

  ctx.tools.register({
    name: 'delegate',
    description: '把一块边界清楚的活交给子代理，等它结束后返回结构化回执。角色：explore 只读探查；implement 只改 files 里的文件；review 独立验收；escalate 用强模型重做之前失败或没把握的交接。互不依赖的交接放在同一条消息里并行发。',
    parameters: DELEGATE_PARAMETERS,
    output: { schema: anyObject, render: (_args, value) => renderResult(value) },
    isConcurrencySafe: () => true,
    execute: delegate,
  });

  ctx.tools.register({
    name: 'handoff_ledger',
    description: '列出本会话最近的交接（id、角色、标题、状态、违规数）。上下文压缩后用它接上进度。',
    parameters: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } } },
    output: { schema: anyObject, render: (_args, value) => [{ type: 'text', text: value.handoffs.length
      ? value.handoffs.map(h => `${h.id} [${h.role}] ${h.title} · ${h.status}${h.violations ? ` · ⚠ ${h.violations}` : ''}`).join('\n')
      : '本会话还没有交接。' }] },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal);
      const byId = new Map();
      for (const row of await deps.readLedger(ledgerFile(cwd))) {
        if (row.kind === 'start' && row.parent === exec.agent?.id) byId.set(row.id, { id: row.id, role: row.role, title: row.title, status: 'running', violations: 0 });
        else if (row.kind === 'end' && byId.has(row.id)) Object.assign(byId.get(row.id), { status: row.status, violations: row.violations?.length ?? 0 });
      }
      return { handoffs: [...byId.values()].slice(-(args?.limit ?? 20)) };
    },
  });

  ctx.systemPrompt.section({ name: 'tool:delegate', order: ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT'), text: () => RULES });
}
