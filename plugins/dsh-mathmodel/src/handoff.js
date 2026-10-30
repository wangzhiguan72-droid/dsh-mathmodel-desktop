import { resolve } from 'node:path';

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

// ponytail: 终端不受守卫，子代理可用 pwsh 改文件；回执违规检查兜底，需要时再加命令审查。
export function childGuard(exec) {
  const child = exec.agent ? children.get(exec.agent.id) : undefined;
  if (!child) return undefined;
  if (exec.name === 'delegate') return '子代理不能再派交接；请自己完成这一块，或在回执里交回给主代理。';
  if (!FILE_TOOLS.has(exec.name)) return undefined;
  if (!WRITE_ROLES.has(child.role)) return '只读角色不能修改文件；把需要的改动写进回执交给主代理。';
  const target = exec.arguments?.file_path;
  if (typeof target !== 'string' || !child.files.has(pathKey(target, child.cwd))) return '该文件不在本次交接的 files 里，不能修改。';
  return undefined;
}
