# 交接式子代理、Workbench 修复与模式合并 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `@deepseek-harness/dsh-mathmodel` 里加一个 `delegate` 交接工具（角色固定路线、交接单必填、结构化回执、写入互斥、账本），把 16 个 task 预设合并成一个“任务”预设，并让数学建模 Workbench 在 rc.5 上重新可用。

**Architecture:** 交接插件是包的新入口 `./handoff`，调用内核 `ctx.subagents.startActivation({ provider: 'spawn', delivery: 'caller', childId, request: { agentOptions, outputSchema, ... } })`，用预留的 `childId` 给子代理装执行守卫。“任务”预设由 `scripts/task-capabilities.mjs` 从 standard 生成，去掉原生 `delegation` 组、挂上 `./handoff`；能力开关沿用 `task-tool-switches.js` 的“首轮前删 schema、首轮后只守卫”。Workbench 移进包内作为 `./workbench`，预设放进单独的托管块。

**Tech Stack:** Node ≥22 ESM，Cordis 4.0.5，`@deepseek-ai/dsh` 0.2.1-rc.5，schemastery，zod，yaml，`node:test`。

**Spec:** `docs/superpowers/specs/2026-10-30-handoff-subagents-design.md`

## Global Constraints

- 内核 `@deepseek-ai/dsh` 0.2.1-rc.5，web-all 0.4.12，桌面 0.2.0。不改 `resources/runtime/host/node_modules` 下的任何内核包。
- `src/version.js` 的版本门白名单保持不变；新入口加进 `package.json` 的 `exports`、`scripts.check` 和 `scripts/build.mjs` 的 `files` 列表。
- 角色默认路线：`explore`、`implement` → provider `magpie`、model `workbuddy-ai/deepseek-v4.1-flash`；`review`、`escalate` → provider `magpie`、model `workbuddy-ai/gpt-6-astra`。
- 首轮之后不得移除任何工具 schema，只能用守卫拒绝（`docs/tool-switch-cache-2026-10-28.md`）。
- 托管块（BEGIN/END 之间）不能混进额外的行。
- 隔离测试必须同时设置 `DSH_HOME` 和 `DSH_DESKTOP_USER_DATA`。
- 不递归删除任何包含 `profiles/node_modules` junction 的目录。
- 改个人 profile 或安装目录前先备份；`standard`、`mathmodel`、`imagegen`、`editable-ppt` 四个预设不动。
- 所有面向用户的文字用中文。

## Review Focus

1. Windows 路径大小写与分隔符：`files` 里写 `src/A.js`，子代理用 `D:\Repo\SRC\a.js` 调 `write`，守卫和互斥表都必须认成同一个文件（Task 2 测试覆盖）。
2. 子代理异常结束：`result` 被拒绝（模型报错、schema 校验失败、用户中止），写锁必须释放、账本必须写结束行，工具返回错误而不是挂起（Task 3 测试覆盖）。
3. 角色路线在配置里缺失或 provider 不存在：`delegate` 返回写明角色名的错误，不启动子代理，插件本身仍能加载（Task 3 测试覆盖）。
4. 旧会话里残留 `task-00`～`task-0f` 引用：迁移停止且不改文件，桌面照常启动（Task 4 测试覆盖）。
5. 首轮后关闭“子代理”开关：`delegate` 的 schema 保留，调用被守卫拒绝（Task 5 测试覆盖）。

---

### Task 1: 交接单校验、首条消息、回执 schema、违规检查（纯函数）

**Files:**
- Create: `plugins/dsh-mathmodel/src/handoff.js`
- Test: `plugins/dsh-mathmodel/test/handoff-brief.test.mjs`

**Interfaces:**
- Produces（全部从 `src/handoff.js` 导出）：
  - `ROLES = ['explore', 'implement', 'review', 'escalate']`；`WRITE_ROLES = new Set(['implement', 'escalate'])`
  - `validateBrief(args: object): { ok: true, brief } | { ok: false, missing: string[], errors: string[] }`。`brief` 是去掉首尾空白后的副本，`files` 规整成字符串数组。
  - `renderBrief(brief, { id: string }): string` —— 子代理首条消息。
  - `receiptSchema(role): JsonSchema`（object 根，`additionalProperties: false`）
  - `checkViolation(role, brief, receipt, cwd): string[]` —— 空数组表示无违规。
  - `samePath(a: string, b: string, cwd: string): boolean` 与 `pathKey(p: string, cwd: string): string`（`resolve(cwd, p)`，win32 下再 `toLowerCase()`）

- [ ] **Step 1: 写失败测试**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBrief, renderBrief, receiptSchema, checkViolation, pathKey } from '../src/handoff.js';

const base = { role: 'explore', title: '查登录', goal: '找出登录失败原因', context: '已排除网络', files: [], constraints: '不改代码', done_when: '给出文件:行号' };

test('缺字段时列出全部缺失项', () => {
  const r = validateBrief({ role: 'explore', title: '查' });
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing.sort(), ['constraints', 'context', 'done_when', 'goal']);
});
test('implement 必须给 files，escalate 必须给 escalates', () => {
  assert.equal(validateBrief({ ...base, role: 'implement' }).ok, false);
  assert.deepEqual(validateBrief({ ...base, role: 'escalate', files: ['a.js'] }).missing, ['escalates']);
});
test('未知角色被拒绝', () => assert.equal(validateBrief({ ...base, role: 'boss' }).ok, false));
test('首条消息声明看不到主对话，并包含全部字段', () => {
  const text = renderBrief(validateBrief(base).brief, { id: 'h1' });
  assert.match(text, /看不到主对话/);
  for (const v of [base.goal, base.context, base.constraints, base.done_when]) assert.ok(text.includes(v));
  assert.match(text, /不得修改文件/);
});
test('review schema 要求 verdict 与 findings.level', () => {
  const s = receiptSchema('review');
  assert.ok(s.required.includes('verdict'));
  assert.deepEqual(s.properties.verdict.enum, ['pass', 'fail']);
  assert.deepEqual(s.properties.findings.items.properties.level.enum, ['blocker', 'major', 'minor']);
  assert.equal(receiptSchema('explore').properties.verdict, undefined);
});
test('只读角色报告改动、implement 越界都算违规', () => {
  const receipt = { files_changed: ['src/b.js'] };
  assert.equal(checkViolation('explore', validateBrief(base).brief, receipt, 'D:/r').length, 1);
  const impl = validateBrief({ ...base, role: 'implement', files: ['src/a.js'] }).brief;
  assert.equal(checkViolation('implement', impl, receipt, 'D:/r').length, 1);
  assert.equal(checkViolation('implement', impl, { files_changed: ['SRC\\A.js'] }, 'D:/r').length, process.platform === 'win32' ? 0 : 1);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd plugins/dsh-mathmodel && npm run build && node --test test/handoff-brief.test.mjs`
Expected: FAIL，`Cannot find module '../src/handoff.js'`。

- [ ] **Step 3: 实现上述导出，并把 `['src/handoff.js', 'lib/handoff.js']` 加进 `scripts/build.mjs` 的 `files`，`package.json` 加 `"./handoff": { "default": "./lib/handoff.js" }` 和 `node --check src/handoff.js`**

回执公共字段按 spec §4.4：`status` enum `done|partial|blocked|unsure`，`summary` string，`findings[{claim, evidence}]`，`files_changed: string[]`，`commands_run[{command, exit_code: integer, result}]`，`not_verified: string[]`，`open_questions: string[]`，全部 required。review 版在此基础上加 `verdict`、`findings.items` 加 `level`。首条消息措辞由实现者定，但必须包含“你看不到主对话”、角色名、全部字段，只读角色加“不得修改文件（包括用终端）”，写入角色加“只能修改以下文件”。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/handoff-brief.test.mjs`
Expected: PASS（6 项）

- [ ] **Step 5: Commit**

```bash
git add plugins/dsh-mathmodel/src/handoff.js plugins/dsh-mathmodel/test/handoff-brief.test.mjs plugins/dsh-mathmodel/scripts/build.mjs plugins/dsh-mathmodel/package.json
git commit -m "feat(handoff): 交接单校验、回执 schema 与违规检查"
```

### Task 2: 写入互斥表与子代理守卫

**Files:**
- Modify: `plugins/dsh-mathmodel/src/handoff.js`
- Test: `plugins/dsh-mathmodel/test/handoff-guard.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `pathKey`、`WRITE_ROLES`。
- Produces：
  - `class WriteLocks { acquire(handoffId, files, cwd): { ok: true } | { ok: false, conflicts: [{ file, holder }] }; release(handoffId): void }`。模块级单例 `writeLocks = new WriteLocks()`（整个 Host 进程共用，spec §4.5）。`acquire` 要么全部占用，要么一个都不占。
  - `children: Map<string /* childId */, { role, files: Set<pathKey>, cwd }>` 模块级。
  - `childGuard(exec): string | undefined` —— 守卫函数本体：`exec.agent?.id` 不在 `children` 里返回 `undefined`；在的话，`delegate` 一律拒绝；只读角色拒绝 `write`、`edit`；写入角色在 `pathKey(exec.arguments?.file_path, cwd)` 不在 `files` 时拒绝。
  - 插件 `apply` 里只注册一次 `ctx.tools.guard(childGuard)`。子代理沿用父预设，处在同一个预设作用域下，所以这一个守卫就能覆盖它们，不需要在 `agent/created` 里逐个装。
  - `pwsh` 不守卫，在 `childGuard` 上方写 `// ponytail: 终端不受守卫，子代理可用 pwsh 改文件；回执违规检查兜底，需要时再加命令审查`。

- [ ] **Step 1: 写失败测试**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { ToolRuntime } from '../../../resources/runtime/host/node_modules/@deepseek-ai/dsh-tools/lib/index.js';
import { WriteLocks, children, childGuard, pathKey } from '../src/handoff.js';

test('写锁重叠被拒绝并写明占用者，释放后可再占用', () => {
  const locks = new WriteLocks();
  assert.deepEqual(locks.acquire('h1', ['src/a.js', 'src/b.js'], 'D:/r'), { ok: true });
  const r = locks.acquire('h2', ['src/c.js', 'src/b.js'], 'D:/r');
  assert.equal(r.ok, false);
  assert.equal(r.conflicts[0].holder, 'h1');
  assert.deepEqual(locks.acquire('h3', ['src/c.js'], 'D:/r'), { ok: true }, '失败的 acquire 不占用 c.js');
  locks.release('h1');
  assert.deepEqual(locks.acquire('h2', ['src/b.js'], 'D:/r'), { ok: true });
});
test('Windows 下大小写与分隔符不同也算同一文件', { skip: process.platform !== 'win32' }, () => {
  const locks = new WriteLocks();
  locks.acquire('h1', ['src/a.js'], 'D:/r');
  assert.equal(locks.acquire('h2', ['D:\\R\\SRC\\A.js'], 'D:/r').ok, false);
});
test('子代理守卫：禁止再派、只读不能写、写入只能写 files', t => {
  t.after(() => children.clear());
  children.set('c-read', { role: 'explore', files: new Set(), cwd: 'D:/r' });
  children.set('c-impl', { role: 'implement', files: new Set([pathKey('src/a.js', 'D:/r')]), cwd: 'D:/r' });
  const g = (id, name, file_path) => childGuard({ agent: { id }, name, arguments: { file_path } });
  assert.match(g('c-read', 'delegate'), /不能再派/);
  assert.match(g('c-read', 'edit', 'src/a.js'), /只读/);
  assert.equal(g('c-impl', 'write', 'src/a.js'), undefined);
  assert.match(g('c-impl', 'write', 'src/z.js'), /files/);
  assert.equal(g('parent', 'write', 'src/z.js'), undefined, '主代理不受约束');
});
test('守卫经 ToolRuntime 生效', t => {
  const root = new Context();
  root.provide('systemPrompt', { tools: () => () => {} });
  new ToolRuntime(root, { mode: 'native' });
  t.after(root.tools.guard(childGuard));
  t.after(() => children.clear());
  children.set('c1', { role: 'review', files: new Set(), cwd: 'D:/r' });
  assert.match(root.tools.guardReason({ agent: { id: 'c1' }, name: 'write', arguments: { file_path: 'x' } }), /只读/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run build && node --test test/handoff-guard.test.mjs`
Expected: FAIL，`WriteLocks is not a constructor`（或导出不存在）

- [ ] **Step 3: 实现 `WriteLocks`、`children`、`childGuard`**

拒绝文案（测试按这些词匹配）：`子代理不能再派交接`、`只读角色不能修改文件`、`该文件不在本次交接的 files 里`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/handoff-guard.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add plugins/dsh-mathmodel/src/handoff.js plugins/dsh-mathmodel/test/handoff-guard.test.mjs
git commit -m "feat(handoff): 写入互斥与子代理守卫"
```

### Task 3: `delegate` / `handoff_ledger` 工具、账本、系统提示段、插件入口

**Files:**
- Modify: `plugins/dsh-mathmodel/src/handoff.js`
- Test: `plugins/dsh-mathmodel/test/handoff-delegate.test.mjs`

**Interfaces:**
- Consumes: Task 1 全部导出；Task 2 的 `writeLocks`、`children`、`childGuard`。
- 插件形状与 `src/capabilities.js` 一致：`export const name = 'dsh-handoff'`，`export const inject = ['tools', 'subagents', 'systemPrompt', 'workingDirectory']`，`export const Config`（schemastery），`export function apply(ctx, config)`。
- `Config`：`roles` 是 4 个角色各一项 `{ provider: string, model: string, reasoningEffort?: string }`，默认值见 Global Constraints；`ledgerDir` 默认 `'.dsh-handoff'`。
- 内部依赖注入：`apply(ctx, config, deps = { randomUUID, now: () => new Date().toISOString(), appendLine })`，测试用 deps 换掉 id、时间和文件写入。
- Produces（后续任务用到的）：
  - 工具名 `delegate`、`handoff_ledger`（Task 4 的预设、Task 5 的开关、Task 7 的 Workbench 都按这两个名字引用）。
  - `delegate` 返回值 `{ id, role, title, status, verdict?, files_changed, violations: string[], stopReason, receipt }`；`render` 输出首行 `[角色] 标题 · 状态[ · verdict] · 改动 N 个文件`，有违规时第二行 `⚠ 违规：…`，最后附完整 JSON。
  - 账本行：`{ kind: 'start', id, parent, role, title, brief, at }` 和 `{ kind: 'end', id, status, verdict?, files_changed, violations, stopReason, error?, at }`，写到 `join(cwd, config.ledgerDir, 'ledger.jsonl')`。
  - `handoff_ledger` 参数 `{ limit?: integer (1..100, 默认 20) }`，只返回当前主会话（`parent === exec.agent.id`）的交接，每条 `{ id, role, title, status, violations: number }`，最新在后。

**`delegate.execute(args, exec)` 的顺序**（这是本任务唯一需要固定的流程）：
1. `validateBrief(args)` 失败 → 直接返回工具错误，列出 `missing` 和 `errors`，不启动子代理。
2. 读 `config.roles[role]`；缺失 → 抛错 `角色 ${role} 的模型路线没有配置`。
3. `cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)`。
4. `await ctx.get('llm').resolveCallConfig({ provider, model, reasoningEffort }, exec.signal)`，失败 → 抛错并带上角色名和原因。（spec 写的是“加载时检查”；加载时 provider 可能还没注册，改在每次调用前检查，效果相同。）
5. `id = deps.randomUUID()`；写入角色先 `writeLocks.acquire(id, brief.files, cwd)`，冲突 → 抛错，写明冲突文件和占用它的交接 id。
6. `children.set(id, { role, files, cwd })`；写账本 start 行。
7. `ctx.subagents.startActivation({ provider: 'spawn', label: title, childId: id, signal: exec.signal, delivery: 'caller', request: { cwd, parent: exec.agent, prompt: [{ type: 'text', text: renderBrief(brief, { id }) }], agentOptions: { provider, model, reasoningEffort }, outputSchema: receiptSchema(role), maxDepth: 1 } })`。
8. `exec.signal` 中止时调用 activation 的 `dispose()`。
9. `await activation.result` 用 `try/finally`：无论成功失败都 `writeLocks.release(id)`、`children.delete(id)`、写账本 end 行。`result.structured` 缺失时状态记为 `blocked`，`violations` 加一条 `回执缺失或不符合格式`。
10. 工具标记 `isConcurrencySafe: () => true`。

**系统提示段**：`ctx.systemPrompt.section({ name: 'tool:delegate', order: ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT'), text: () => RULES })`，`RULES` 是固定字符串（不随状态变化，避免打断缓存），内容就是 spec §4.7 的五条，原文照抄。

- [ ] **Step 1: 写失败测试**

测试用一个假的 `subagents`：`startActivation(spec)` 记下 `spec`，返回 `{ childId: spec.childId, result: <可控的 Promise>, dispose }`；假的 `llm.resolveCallConfig` 对未知 provider 抛错；假的 `workingDirectory.ensure` 返回 `'D:/r'`；`deps.appendLine` 收集账本行。按 `test/task-tool-switches.test.mjs` 的方式搭 `Context` + `ToolRuntime`，再 `root.provide` 这些假服务后调用 `apply(root, config, deps)`，从 `root.tools.get('delegate')` 取出工具直接调 `execute`。

```js
test('缺字段不启动子代理', async () => {
  const r = await run({ role: 'explore', title: 't' });
  assert.equal(fake.started.length, 0);
  assert.match(String(r.error ?? r), /goal/);
});
test('按角色选路线并带上 outputSchema 与预留 childId', async () => {
  const p = run(brief('review')); fake.resolve({ structured: passReceipt, stopReason: 'end_turn' });
  await p;
  const spec = fake.started[0];
  assert.equal(spec.delivery, 'caller');
  assert.equal(spec.childId, 'id-1');
  assert.deepEqual(spec.request.agentOptions, { provider: 'magpie', model: 'workbuddy-ai/gpt-6-astra' });
  assert.ok(spec.request.outputSchema.required.includes('verdict'));
});
test('路线不存在时报角色名、不启动', async () => {
  await assert.rejects(runWith({ roles: { explore: { provider: 'nope', model: 'x' } } }, brief('explore')), /explore/);
  assert.equal(fake.started.length, 0);
});
test('两个 implement 争同一个文件，第二个被拒绝；第一个结束后释放', async () => {
  const first = run(brief('implement', ['src/a.js']));
  await assert.rejects(run(brief('implement', ['src/a.js'])), /src\/a\.js[\s\S]*id-1/);
  fake.resolve({ structured: doneReceipt(['src/a.js']), stopReason: 'end_turn' }); await first;
  await assert.doesNotReject(startOnly(brief('implement', ['src/a.js'])));
});
test('子代理失败也释放写锁并写 end 行', async () => {
  const p = run(brief('implement', ['src/a.js'])); fake.reject(new Error('model down'));
  await assert.rejects(p, /model down/);
  assert.equal(ledger.at(-1).kind, 'end');
  assert.equal(writeLocks.acquire('x', ['src/a.js'], 'D:/r').ok, true);
});
test('回执缺失记为 blocked 并标违规', async () => {
  const p = run(brief('explore')); fake.resolve({ output: 'hi', stopReason: 'end_turn' });
  const r = await p;
  assert.equal(r.status, 'blocked'); assert.equal(r.violations.length, 1);
});
test('只读角色报告改了文件，结果和账本都带违规', async () => {
  const p = run(brief('explore')); fake.resolve({ structured: doneReceipt(['src/b.js']), stopReason: 'end_turn' });
  const r = await p;
  assert.equal(r.violations.length, 1); assert.equal(ledger.at(-1).violations.length, 1);
});
test('中止调用会 dispose 子代理', async () => {
  const ac = new AbortController(); const p = run(brief('explore'), ac.signal); ac.abort();
  fake.reject(new Error('aborted')); await p.catch(() => {});
  assert.equal(fake.disposed, 1);
});
test('handoff_ledger 只列本会话，默认 20 条', async () => { /* 预先塞 25 条 parent=p1 和 3 条 parent=p2，断言返回 20 条且都是 p1 的最后 20 条 */ });
test('系统提示段是固定文本，包含“回执是报告，不是证据”', () => { /* 调两次 text()，断言相等且包含该句 */ });
```

（`run`、`brief`、`fake`、`ledger`、`doneReceipt`、`passReceipt` 是本测试文件里的小助手，由实现者写。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run build && node --test test/handoff-delegate.test.mjs`
Expected: FAIL，`apply is not a function` 或 `delegate` 工具不存在

- [ ] **Step 3: 按上面的顺序实现 `apply`、两个工具、账本、系统提示段**

账本读取（`handoff_ledger`）直接读 jsonl 全文后过滤；`appendLine` 默认实现用 `fs.promises.mkdir(recursive) + appendFile`，失败只 `ctx.logger.warn`。

- [ ] **Step 4: 跑全部交接测试**

Run: `node --test test/handoff-*.test.mjs`
Expected: PASS

- [ ] **Step 5: 跑整个包的测试**

Run: `npm test`
Expected: 全部 PASS（新文件不影响旧测试）

- [ ] **Step 6: Commit**

```bash
git add plugins/dsh-mathmodel/src/handoff.js plugins/dsh-mathmodel/test/handoff-delegate.test.mjs
git commit -m "feat(handoff): delegate 与 handoff_ledger 工具、账本、规则段"
```

### Task 4: 16 个 task 预设合并为一个“任务”预设，带迁移

**Files:**
- Modify: `scripts/task-capabilities.mjs`（整体重写生成与安装逻辑，保留原子写入与备份那一段）
- Modify: `src/main.cjs:295-300`（多传 `sessionsDir`，并把异常改为记日志后继续）
- Modify: `tests/task-capabilities.test.mjs`（16 个组合相关的测试改写）
- Modify: `scripts/verify-task-capabilities.mjs`（按单个预设核对）

**Interfaces:**
- Consumes: 工具名 `delegate`、`handoff_ledger`（Task 3），入口 `@deepseek-harness/dsh-mathmodel/handoff`。
- Produces：
  - 新标记 `# BEGIN DSH task capabilities v2` / `# END DSH task capabilities v2`。块里只有一行预设：`id: preset-task`，`config.id: task`，`name: 任务`，`order: 30`。
  - 组合方式：从 standard 克隆，**删掉 `delegation` 整组**，在原位置插入 `{ id: 'handoff', name: '@deepseek-harness/dsh-mathmodel/handoff' }`，末尾仍加 `{ id: 'task-capabilities', name: '@deepseek-harness/dsh-mathmodel/capabilities', config: { images: true } }`（视觉/生图改由 Task 5 的开关控制）。`tool-web`、`skill-filesystem`、`tool-skill` 都保留。
  - `taskCapabilityPresets({ runtimeRoot }) → { presets: [{ id: 'task' }], yaml }`
  - `installTaskCapabilityPresets({ runtimeRoot, profilePatch, sessionsDir, apply, io }) → { applied, changed, backup, migrated: boolean, skipped?: string }`
  - `findLegacyPresetSessions(sessionsDir): string[]` —— 返回引用 `task-00`～`task-0f` 的会话文件路径。按 zstd magic `28 b5 2f fd` 切帧逐帧 `zlib.zstdDecompressSync`，正则 `/"agentPreset":"task-0[0-9a-f]"/`。目录不存在返回 `[]`。

**安装逻辑（决定写死，不留给实现者）：**
- profile 里有 v2 块：与生成结果逐行比对，相同 → `changed: false`；不同 → 抛 `Task capability conflict: managed definitions differ`（与现状一致）。块尾的 Host 设置行（`isHostSettingsRow`）照旧容忍。
- profile 里有 v1 块：先 `findLegacyPresetSessions`，非空 → 返回 `{ applied: false, changed: false, skipped: '有 N 个会话引用旧 task 预设，未迁移' }`，**不改文件**；为空 → 备份后把 v1 块整段换成 v2 块，保留块尾的 Host 设置行，`migrated: true`。v1 块内容与已知的 16 行不一致（用户手改过）时同样 `skipped`，不抛错。
- 两种块都没有：追加 v2 块（与现状一致）。
- `main.cjs` 里调用处包 `try/catch`，失败只 `pushLogLine('[desktop] task preset migration skipped: ' + error.message)`；`skipped` 也记日志。

- [ ] **Step 1: 改写测试**

```js
test('只生成一个“任务”预设：没有 delegation 组，挂上 handoff', () => {
  const { presets, yaml } = taskCapabilityPresets({ runtimeRoot });
  assert.deepEqual(presets.map(p => p.id), ['task']);
  const row = parse(yaml)[0].insert[0];
  const ids = row.config.plugins.map(p => p.id);
  assert.equal(row.config.name, '任务');
  assert.ok(!ids.includes('delegation'));
  assert.ok(ids.includes('handoff') && ids.includes('tool-web') && ids.includes('tool-skill'));
  assert.equal(row.config.plugins.find(p => p.id === 'task-capabilities').config.images, true);
});
test('v1 十六行块迁移为 v2 单行块，保留用户行与 Host 设置行，留一份备份', () => { /* 用旧版生成器的输出做夹具（从 git 历史 01afd7c 的 scripts/task-capabilities.mjs 生成一次存进 tests/fixtures/task-capabilities-v1.yml） */ });
test('有会话引用旧预设时不迁移、不改文件', () => { /* 临时 sessionsDir 放一个 zstd 压缩的 {"agentPreset":"task-0f"} 行 */ });
test('v1 块被手改过时 skipped，不抛错', () => {});
test('v2 已存在时幂等；块内被改则报 managed definitions differ', () => {});
test('写临时文件失败时原文件与备份不变', () => {}); // 原测试保留，改用 v2
```

保留原有 `restart accepts only the Host-persisted mathmodel settings row` 测试，改成 v2 块。删除 `all sixteen combinations` 和 `known 0.1.6 managed presets migrate` 两个测试。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/task-capabilities.test.mjs`
Expected: FAIL（仍生成 16 个预设）

- [ ] **Step 3: 重写 `scripts/task-capabilities.mjs`，改 `src/main.cjs`**

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/task-capabilities.test.mjs tests/specialized-presets.test.mjs`
Expected: PASS（专用预设测试不受影响）

- [ ] **Step 5: 用真实 profile 的副本做一次干跑**

Run: `cp ~/.dsh-mathmodel/profiles/mathmodel/cordis.patch.yml "$TEMP/patch-dryrun.yml" && node scripts/task-capabilities.mjs --profile-patch "$TEMP/patch-dryrun.yml"`
Expected: 输出 JSON 里 `changed: true`、`applied: false`，没有报错；真实 profile 未被改动（`git diff --no-index` 对比副本前后为空）。

- [ ] **Step 6: Commit**

```bash
git add scripts/task-capabilities.mjs scripts/verify-task-capabilities.mjs src/main.cjs tests/task-capabilities.test.mjs tests/fixtures/task-capabilities-v1.yml
git commit -m "feat: 16 个 task 预设合并为“任务”，旧块按会话引用检查后迁移"
```

### Task 5: 能力面板加联网、子代理、视觉/生图开关，去掉组合复选框

**Files:**
- Modify: `plugins/dsh-mathmodel/src/task-tool-switches.js`
- Modify: `plugins/dsh-mathmodel/src/host-capabilities.js:19, 97, 112`
- Modify: `plugins/dsh-mathmodel/src/client-bundle.cjs:266-279`（`createTaskCapabilityActions.apply`）、`995-1035`（`TaskCapabilityPicker`）、`1071-1084`（`TaskExtensionSwitches` 的开关）
- Modify: `scripts/verify-task-tool-switches.mjs`
- Test: `plugins/dsh-mathmodel/test/task-tool-switches.test.mjs`、`test/host-capabilities.test.mjs`、`test/task-capabilities-client.test.mjs`

**Interfaces:**
- Consumes: `IMAGE_TOOLS`（`src/capabilities.js`）；工具名 `delegate`、`handoff_ledger`；预设 id `task`（Task 4）。
- Produces：
  - 开关对象新增三项：`web`、`delegate`、`images`，默认都是 `true`。`DEFAULT_TOOL_SWITCHES`、`switchesSchema`、`widen` 同步加上（`widen` 对这三项和 `skills` 一样取或）。
  - `toolDenied(name, selection)` 新增：`web_fetch`、`web_search` 看 `web`；`delegate`、`handoff_ledger` 看 `delegate`；`IMAGE_TOOLS` 看 `images`。
  - `host-capabilities.js`：`relevant` 里的 `/^preset-task-0[0-9a-f]$/` 改成 `/^preset-task$/`；`confirm` 和 `verify` 里的 `/^task-0[0-9a-f]$/` 改成 `=== 'task'`。`confirm` 仍调用 `presets.select(agent, 'task')`（空白会话从默认预设切到“任务”时需要它；已经是 `task` 时内核 select 是幂等的，Step 1 的测试确认这一点）。
  - 客户端 `actions.apply(sessionId, preview)`（去掉 `mask` 参数），内部固定 `confirm(sessionId, 'task', preview.hostHash)`。
  - `TaskCapabilityPicker` 删掉 `groups`/`mask` 复选框和 `selected` 解析；`TaskExtensionSwitches` 加三个 `toggle`：`toggle('web', '联网检索')`、`toggle('delegate', '子代理交接（delegate）')`、`toggle('images', '外部视觉与生图')`。“精简”按钮的 patch 改为 `{ skills: false, mcp: false, taskBoard: false, web: false, delegate: false, images: false }`，文案改成“精简：关闭全部扩展工具”。

- [ ] **Step 1: 写失败测试**

在 `task-tool-switches.test.mjs` 加：

```js
test('新开关：首轮前移除 schema，首轮后保留 schema 只守卫', async t => {
  // 同文件第二个测试的搭法；注册 web_fetch、delegate、image_generate、read_file
  // 首轮前 set {web:false, delegate:false, images:false} → schemas(a) 只剩 read_file
  // 回到全开 → 追加 turn/start → 再关 delegate → schemas(a) 仍含 delegate，guardReason(delegate) 匹配 /关闭/
});
test('toolDenied 覆盖三个新开关', () => {
  const off = normalizeToolSwitches({ web: false, delegate: false, images: false });
  for (const name of ['web_fetch', 'web_search', 'delegate', 'handoff_ledger', 'vision_analyze', 'image_generate', 'editable_ppt_image']) assert.equal(toolDenied(name, off), true, name);
  assert.equal(toolDenied('read_image', off), false);
});
test('旧会话里没有新字段的开关事件按默认全开处理', () => {
  assert.equal(normalizeToolSwitches({ skills: false, mcp: true, taskBoard: true, disabledMcpServers: [] }).delegate, true);
});
```

`host-capabilities.test.mjs`：把用到 `task-0f`/`task-03` 的地方改成 `task`，并加一条“`confirm` 传 `task-0f` 返回 `capabilities/invalid-preset`”。
`task-capabilities-client.test.mjs`：`apply(sessionId, 15, preview)` 改成 `apply(sessionId, preview)`，断言 `confirm` 收到 `'task'`。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd plugins/dsh-mathmodel && npm run build && node --test test/task-tool-switches.test.mjs test/host-capabilities.test.mjs test/task-capabilities-client.test.mjs`
Expected: FAIL

- [ ] **Step 3: 按 Interfaces 修改四个源文件**

- [ ] **Step 4: 跑包内全部测试**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add plugins/dsh-mathmodel/src plugins/dsh-mathmodel/test scripts/verify-task-tool-switches.mjs
git commit -m "feat: 能力面板加联网/子代理/视觉开关，去掉 16 组合复选框"
```

### Task 6: Workbench 移进包内并适配 rc.5

**Files:**
- Create: `plugins/dsh-mathmodel/src/workbench.js`（从 `~/.dsh-mathmodel/.agent-presets/math-modeling/plugins/math-modeling.js` 复制后修改；原文件不动）
- Modify: `plugins/dsh-mathmodel/scripts/build.mjs`、`package.json`（`"./workbench"` 导出、`check`）
- Test: `plugins/dsh-mathmodel/test/workbench.test.mjs`

**Interfaces:**
- Consumes: Task 3 的 `delegate` 返回值（review 角色）。
- Produces：
  - `export const name = 'math-modeling-workbench'`，`export const Config = Schema.object({ skillRoot: Schema.string().required() })`，`export async function apply(ctx, config)`。
  - 删除 `BUNDLED_SKILL_ROOT` 及 `import.meta.url` 推导；`mm_project_init` 不传 `skillRoot` 时用 `config.skillRoot`。内置 skill 注册也用 `config.skillRoot`。
  - `export function gateReceiptFromReview(review: DelegateResult, { scope, inputSnapshot }): MmGateReceipt`，映射规则照 spec §5.2 第 4 条：`verdict pass→PASS`、`fail→FAIL`；`status === 'blocked'` 优先映射成 `BLOCKED`；`findings` 每项转成 `{ level, text: claim }`；`evidence` 取各 finding 的 `evidence`；`rework` 取 `open_questions`。`mm_gate mode=record` 增加可选参数 `review`（`delegate` 的返回值），给了就用这个函数生成回执，不再要求主代理手抄。
  - 文案替换：`PHASE_TASKS`、`mm_gate` 的 `recordInstruction`、系统提示段第 4 条里的“派发独立只读 Subagent”“用主 Agent 的 subagent 工具”全部改成“用 `delegate role=review` 派发独立验收”。

- [ ] **Step 1: 写失败测试**

```js
test('review 回执映射成 mm_gate 回执', () => {
  const r = gateReceiptFromReview({ status: 'done', verdict: 'fail', receipt: { findings: [{ level: 'major', claim: '量纲错', evidence: 'model.md:12' }], open_questions: ['重算 Q2'] } }, { scope: 'M1', inputSnapshot: 'h' });
  assert.deepEqual(r, { scope: 'M1', inputSnapshot: 'h', status: 'FAIL', evidence: ['model.md:12'], findings: [{ level: 'major', text: '量纲错' }], rework: ['重算 Q2'] });
  assert.equal(gateReceiptFromReview({ status: 'blocked', verdict: 'pass', receipt: { findings: [], open_questions: [] } }, { scope: 'M1', inputSnapshot: 'h' }).status, 'BLOCKED');
});
test('在 rc.5 ToolRuntime 上注册全部 mm_* 工具', async () => {
  // 按 task-tool-switches.test.mjs 搭 root；再 provide 假的 fs/shell/agents/sandboxPolicy/settings/skills（只实现 workbench 用到的方法）
  // await apply(root, { skillRoot: <临时目录，内含 SKILL.md> })
  // 断言 root.tools.schemas() 含 mm_project_init、mm_state、mm_phase_enter、mm_skill_read、mm_gate、mm_check_deliverables、mm_complete、mm_log、mm_todo、mm_ui_toggle
});
test('文案里不再出现“subagent 工具”', () => { /* 读 src/workbench.js 源码，断言不含 '派发独立只读 Subagent' 和 'subagent 工具' */ });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run build && node --test test/workbench.test.mjs`
Expected: FAIL

- [ ] **Step 3: 复制并修改为 `src/workbench.js`**

注册失败（rc.5 拒绝某个 schema）时以 Step 2 的报错为准逐个修，常见的是参数里写了非子集关键字（`default`、`minimum` 之类以外的），参照 `dsh-tools/lib/index.js:206` 的子集清单删掉。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/workbench.test.mjs && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add plugins/dsh-mathmodel/src/workbench.js plugins/dsh-mathmodel/test/workbench.test.mjs plugins/dsh-mathmodel/scripts/build.mjs plugins/dsh-mathmodel/package.json
git commit -m "feat(workbench): 移入 dsh-mathmodel，适配 rc.5，门禁审查走 delegate"
```

### Task 7: `math-workbench` 预设的托管块与启动挂钩

**Files:**
- Create: `scripts/workbench-preset.mjs`
- Modify: `src/main.cjs`（紧接 Task 4 的调用之后）
- Test: `tests/workbench-preset.test.mjs`

**Interfaces:**
- Consumes: 入口 `@deepseek-harness/dsh-mathmodel/workbench`、`/handoff`。
- Produces：
  - 标记 `# BEGIN DSH math workbench v1` / `# END DSH math workbench v1`；块内一行预设：`id: preset-math-workbench`，`config.id: math-workbench`，`name: 数学建模 Workbench`，`order: 20`。
  - 组合：从 standard 克隆，删 `delegation` 组，加 `{ id: 'handoff', name: '@deepseek-harness/dsh-mathmodel/handoff' }` 和 `{ id: 'workbench', name: '@deepseek-harness/dsh-mathmodel/workbench', config: { skillRoot: "!!js dshHomePath('skills/math-modeling')" } }`。`skillRoot` 的写法照抄 profile 里现有 `mathmodel` 行的 `dshHomePath('skills')` 形式（`task-capabilities.mjs:79` 有同样的判断），Skills 两行保留。
  - `installWorkbenchPreset({ runtimeRoot, profilePatch, apply, io }) → { applied, changed, backup }`。逻辑与 Task 4 的 v2 分支相同：没有块就追加，有块就逐行比对，不同则抛错。备份文件名后缀 `.bak-workbench-<时间>`。
  - `main.cjs` 里 `try/catch` 包住，失败只记 `[desktop] workbench preset skipped: …`。

- [ ] **Step 1: 写失败测试**

```js
test('生成的预设去掉 delegation，挂上 handoff 与 workbench', () => { /* 断言插件 id 列表 */ });
test('追加到 profile 不改动其他行和专用预设块，再跑一次 changed=false', () => {});
test('块被手改时报错，但 main.cjs 的包装只记日志', () => { /* 只测函数抛错；main.cjs 的 try/catch 靠代码审查 */ });
test('restoreSpecializedPresets 对含 workbench 块的 profile 仍然通过', () => { /* 证明新块不会触发 Managed preset block differs */ });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/workbench-preset.test.mjs`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现 `scripts/workbench-preset.mjs`，改 `src/main.cjs`**

与 `task-capabilities.mjs` 共用的 `document`、`yamlAt`、原子写入逻辑直接从那个文件 `export` 出来复用，不复制。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/workbench-preset.test.mjs tests/task-capabilities.test.mjs tests/specialized-presets.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/workbench-preset.mjs scripts/task-capabilities.mjs src/main.cjs tests/workbench-preset.test.mjs
git commit -m "feat: math-workbench 预设独立托管块，启动时安装，失败不阻塞"
```

### Task 8: 隔离 Host 实测、回归、备份与部署

**Files:**
- Create: `_tok/handoff-live/`（合成仓库和运行记录，放在桌面仓库外，不提交）
- Modify: 无源码改动；只在发现缺陷时回到对应任务修。

- [ ] **Step 1: 建隔离环境**

把 `DSH_HOME` 和 `DSH_DESKTOP_USER_DATA` 都指向 `D:\deepseek harness\_tok\handoff-live\home` 与 `...\userdata`，从个人 profile **复制**（不是链接）`cordis.patch.yml` 和 `.credentials.yaml` 进去。不复制 `profiles/node_modules`，让桌面自己建 junction。
Expected: 启动日志出现 `added task capability combinations` 或迁移日志，以及 workbench 预设安装日志；`--dump-config` 预设列表含 `task`、`math-workbench`，不含 `task-00`～`task-0f`。

- [ ] **Step 2: 找 bug 场景**

合成仓库：一个小 Node 包，埋 2 个 bug（一个边界条件、一个异步未 await），带一个会失败的 `npm test`。主代理选 `magpie / workbuddy-ai/gpt-6-astra`，提示“测试失败，找原因并修好”。
Expected: 同一条助手消息里至少 2 个 `delegate role=explore`；账本有对应 start/end 行且回执通过 schema；最终 `npm test` 通过；主代理在说“完成”前自己跑过 `npm test`（看会话记录里的工具调用顺序）。

- [ ] **Step 3: 搭框架再填充场景**

主代理先写好接口文件，再派 2 个 `implement`（各一个文件）和 1 个 `review`。另外让主代理在同一条消息里给两个 `implement` 写同一个文件。
Expected: 第二个冲突交接返回写明占用者的错误；review 回执有 `verdict`；账本无违规。

- [ ] **Step 4: Workbench 场景**

选“数学建模 Workbench”，跑 `mm_project_init` → 建模阶段一项 → `mm_gate M1 prepare` → `delegate role=review` → `mm_gate record review=<结果>`。
Expected: `state.json` 里 M1 有回执，状态是 PASS/FAIL/BLOCKED 之一。

- [ ] **Step 5: 开关场景**

Run: `node scripts/verify-task-tool-switches.mjs`（Task 5 已改为覆盖新开关）
Expected: 首轮前关闭时 schema 被移除，首轮后关闭时 schema 数量不变且调用被拒。

- [ ] **Step 6: 全量回归**

Run: `cd plugins/dsh-mathmodel && npm test`，然后 `cd ../.. && npm test`
Expected: 全部 PASS，只有 `tests/fusion-latest-transport.test.mjs` 失败（改动前就失败），在结果里单独列出。

- [ ] **Step 7: 备份并部署**

备份 `~/.dsh-mathmodel/profiles/mathmodel/cordis.patch.yml`（后缀 `.bak-handoff-<时间>`）和安装目录里 `@deepseek-harness/dsh-mathmodel` 整个包目录（复制，不移动）。部署前先问用户，得到同意后再按现有发布流程覆盖安装，然后启动真实桌面。
Expected: 桌面启动无异常；预设下拉只有一个“任务”加三个专用预设、standard 和“数学建模 Workbench”。

- [ ] **Step 8: 真实 GUI 跑一次找 bug 场景**

在真实桌面新建“任务”会话，用 Step 2 的合成仓库再跑一次。
Expected: 与 Step 2 相同。

- [ ] **Step 9: Commit**

```bash
git add -A plugins/dsh-mathmodel scripts src tests docs/superpowers
git commit -m "chore: 交接插件、任务预设合并、Workbench 修复的实测记录"
```
