# 交接式子代理、数学建模修复与模式合并：设计（2026-10-30）

## 1. 为什么做

2026-10-30 统计了 `~/.dsh-mathmodel/sessions` 的全部 73 个会话（脚本 `D:\deepseek harness\_tok\preset-usage\calls.mjs`）：

- 16 个 `task-00`～`task-0f` 组合预设：0 个会话使用。
- 数学建模 Workbench（`~/.dsh-mathmodel/.agent-presets/math-modeling`）：0 个会话使用，`mm_*` 工具 0 次调用。
- 内核的 `subagent` / `subagent_fork` / `workflow`：0 次调用。用过的只有 AgentTeams（约 20 次，全部是验收测试）和 Fusion（约 20 次）。

用户要的是一个有自己特色、借鉴 Claude Code 的子代理用法：主代理用强模型（GPT-6 Astra，以后可能是 Opus 5.5）统筹，子代理用 DeepSeek V4.1 Flash（Magpie 渠道，常常免费）干活。**质量优先，省钱其次。**用户最担心的是交接：交接做不好，多代理反而会出大错。

内核已经提供底层能力，缺的是规则和协议：

- `ctx.subagents.startActivation()` 可以给子代理指定预设（`agentPreset`）、模型路线（`agentOptions`），以及结构化输出（`outputSchema`）。内核会校验子代理交回的 JSON 是否符合 schema（见 `runtime/host/node_modules/@deepseek-ai/dsh-subagent/lib/types/types.d.ts`）。
- 父代理收到的完成通知里会附带 `Structured result: <JSON>`。

## 2. 范围：三个部分，按顺序做

| 顺序 | 部分 | 一句话 |
|---|---|---|
| A | 交接插件 | 新增 `delegate` 工具：按角色派子代理，交接单必填，回执结构化，写入互斥，交接写进账本 |
| B | 修复数学建模 Workbench | 让它在 rc.5 上重新出现在预设列表里，并把三个阶段的门禁审查改用 A 的审查角色 |
| C | 合并零碎模式 | 16 个 task 预设合并为 1 个“任务”预设，联网、子代理、外部视觉三个开关挪进能力面板 |

B 依赖 A，C 与 A、B 互不依赖。

## 3. 目标、非目标、反目标

**目标**
- 两个主要场景能可靠运行：（1）找 bug：主代理定位问题，多个只读子代理从不同方向查；（2）搭框架再填充：主代理定接口，子代理各自填自己的文件。另外每次修改之后有一次独立验收。
- 主代理拿到的每份回执都结构一致，可以直接核对。
- 数学建模 Workbench 能选用，状态机和门禁照常工作。
- 预设下拉列表不再出现 16 个几乎一样的条目。

**非目标**
- 子代理之间互相发消息（AgentTeams 那种）。所有交接都经过主代理，结构是星形。
- 用脚本大规模编排（`workflow`）。
- 按费用自动选模型。路线由角色固定，用户在配置里改。
- 建模手、编程手、论文手的自动接力流水线。这次只把门禁审查接到 A 上。

**反目标（出现就算失败，即使功能“能用”）**
- 两个子代理同时改同一个文件。
- 主代理把子代理回执里的“测试通过”直接当成事实，告诉用户“已完成”。
- 改动打断前缀缓存：会话中途改变工具 schema 集合（见 `docs/tool-switch-cache-2026-10-28.md`，命中率曾掉到 32.39%）。
- 用户的个人 profile、会话或已安装的应用被改坏，并且没有备份可以恢复。

## 4. A：交接插件

### 4.1 放在哪里

作为 `@deepseek-harness/dsh-mathmodel` 的新入口 `./handoff`（源码 `plugins/dsh-mathmodel/src/handoff.js`）。这个包已经有 rc.5 版本门、vendor 锁和部署流程，新增入口不用再走一遍新包安装。（我的决定）

### 4.2 角色

| 角色 | 用途 | 能写文件 | 默认模型路线 |
|---|---|---|---|
| `explore` | 找 bug 时分方向查、读代码、跑只读命令 | 否 | Magpie `workbuddy-ai/deepseek-v4.1-flash` |
| `implement` | 按主代理定好的接口填某几个文件 | 只能写 `files` 里列出的文件 | 同上 |
| `review` | 独立验收：只拿到需求和代码，不拿前面的结论 | 否 | Magpie `workbuddy-ai/gpt-6-astra` |
| `escalate` | Flash 交回“没把握”或失败后，同一块活换强模型重做 | 只能写 `files` | Magpie `workbuddy-ai/gpt-6-astra` |

- 路线放在插件配置 `roles.<角色>.{provider, model, reasoningEffort}` 里，用户可以改，模型不能在调用时自选。以后接入 Opus 5.5 只需要改配置。插件加载时检查路线存在，不存在就让 `delegate` 报错并写明是哪个角色的路线缺失。
- 子代理不另选预设，沿用父会话的预设（这样子代理能复用父会话的工具 schema 前缀，下拉列表里也不会多出一个“只读”预设）。权限差异全部靠执行守卫：插件用 `startActivation({ childId })` 预先指定子代理 id，在 `agent/created` 时给这个子代理装 `ctx.tools.guard`（与 `task-tool-switches.js:75` 同一机制）：
  - 所有子代理：拒绝 `delegate`，所以不会再往下派。
  - `explore` / `review`：拒绝 `write`、`edit`。
  - `implement` / `escalate`：`write`、`edit` 的目标路径不在 `files` 里就拒绝。
- 终端（pwsh）不在守卫范围内，子代理仍可能用命令改文件，这是已知上限，实现时标 `ponytail:` 注释。只读角色的首条消息里写明“不得修改文件”。

### 4.3 `delegate` 工具（主代理看到的）

参数全部必填，只有标“可选”的除外。缺任何一项，工具直接返回错误并列出缺了哪些，不启动子代理：

| 参数 | 含义 |
|---|---|
| `role` | 上表四个角色之一 |
| `title` | 3 到 8 个字的显示名 |
| `goal` | 这一块要达成什么，一两句话 |
| `context` | 子代理需要知道的事实：已经确认的、已经排除的方向 |
| `files` | 相关文件。`implement` / `escalate` 必须写，并且只能改这些文件；其余角色可以为空 |
| `constraints` | 不能做的事，例如“不改公共接口签名” |
| `done_when` | 完成标准，必须可检查，例如某个测试通过 |
| `escalates` | 可选；`escalate` 角色必填，填被重做的那次交接的 id |

插件把这些字段拼成子代理的首条消息，固定格式，开头说明“你看不到主对话”。

### 4.4 回执（`outputSchema`，内核负责校验）

```json
{
  "status": "done | partial | blocked | unsure",
  "summary": "做了什么，几句话",
  "findings": [{ "claim": "...", "evidence": "文件:行号 或 命令+输出摘录" }],
  "files_changed": ["..."],
  "commands_run": [{ "command": "...", "exit_code": 0, "result": "摘录" }],
  "not_verified": ["没验证到的部分"],
  "open_questions": ["需要主代理决定的事"]
}
```

`review` 角色用另一份 schema：在上面的字段之外加 `verdict: "pass" | "fail"`，`findings` 每项再加 `level: "blocker" | "major" | "minor"`。`status` 只说明审查有没有做完，是否通过看 `verdict`。

回执到达后插件做两项检查：只读角色报告改了文件，或者 `implement` 报告的改动超出了 `files`，就在账本里标记 `violation`。守卫已经拦住了越界的 `write` / `edit`，所以这项检查主要是为了发现通过终端改文件的情况。插件只读回执，不读文件系统，这个检查不能代替 diff。

### 4.4.1 调用方式：等待结果

`delegate` 使用 `delivery: 'caller'`：工具调用会一直等到子代理结束，插件自己把回执渲染成工具结果，结果里包括状态、`verdict`、改动文件、违规提示，以及完整的结构化 JSON。工具标记为 `isConcurrencySafe`，同一条消息里的多个 `delegate` 会并行执行。（我的决定。选 `'parent'` 的话完成通知由内核固定生成，插件没法在里面加违规提示。）子代理仍会写入父会话的 `subagent/catalog`，界面里照常能看到。主代理中止这次调用时，插件对子代理调用 `dispose()`。

### 4.5 写入互斥

- 插件在内存里维护一张整个 Host 进程共用的表，键是解析后的绝对路径（Windows 下不区分大小写），记录哪些文件正被哪个仍在运行的写入型交接占用。同一个仓库里两个顶层会话也会互相排斥。（我的决定）
- 新的 `implement` / `escalate` 交接，`files` 与表中任何一项重叠就直接拒绝，错误信息写明冲突的文件和占用它的交接 id。
- 子代理的 `result` 结束（不论成功还是失败）就释放占用。
- 只读角色不占用，可以任意并行。
- 主机重启后表是空的，因为运行中的子代理也不会在重启后继续写。（我的决定）
- 这张表只约束经过 `delegate` 的写入，主代理自己写文件不受约束。所以使用交接插件的预设里，整个原生 `delegation` 组都不挂载，包括 `subagent`、`subagent_fork`、`workflow`，以及 `send_message` / `interrupt_agent`（见 4.8）。已经结束的交接不能续聊，想返工就重新发一个交接。

### 4.6 交接账本

- 每次交接追加两行 JSON 到 `<主会话 cwd>/.dsh-handoff/ledger.jsonl`：启动时写交接单，结束时写回执、`stopReason` 和违规标记。
- 用途：上下文压缩以后，主代理可以重新读账本把进度接上；用户也可以直接打开看。
- 再提供一个只读工具 `handoff_ledger`，按会话列出交接（id、角色、标题、状态、是否违规），默认只返回最近 20 条摘要。
- 写入失败只记一条警告日志，不影响交接本身。

### 4.7 给主代理的规矩（系统提示段，固定文本，避免打断缓存）

1. 先自己看懂问题，再派活。交接单要能让一个没看过对话的人照着做。
2. 互不依赖的只读交接放在同一条消息里一起发。
3. 子代理的回执是报告，不是证据。告诉用户“完成”之前，自己看 diff 或跑 `done_when` 里写的检查。
4. 每次 `implement` 完成后派一次 `review`。`review` 的交接单只写需求、相关文件和完成标准，不写自己的判断。
5. 回执是 `unsure` / `blocked`，或者 review 没通过，用 `escalate` 换强模型重做这一块，或者自己做。不要让 Flash 在同一块上反复重试。

### 4.8 挂到哪个预设

- 合并后的“任务”预设（C 部分）挂载 `delegate` 和 `handoff_ledger`，并且去掉整个原生 `delegation` 组。（我的决定：同一会话里两套委派工具并存，模型会混着用，互斥表就形同虚设。）子代理服务 `@deepseek-ai/dsh-subagent` 和 `spawn` 提供方挂在 Host 层（`--dump-config` 第 1467–1470 行），不受影响。
- 修好的 Workbench 也这样挂。
- `standard` 和 `mathmodel` / `imagegen` / `editable-ppt` 三个专用预设都不动。`restore-specialized-presets.mjs:100-105` 要求专用预设的插件名单与 standard 完全一致，改了会导致启动失败。

### 4.9 体验

- 交接调用在对话里显示 `title` 和角色；工具结果里显示状态、`verdict`、改动文件数，有违规时显示违规。
- 这次不做专门的面板。账本文件和 `handoff_ledger` 工具已经能看到全部交接。以后用户觉得需要再加面板。（我的决定）

## 5. B：修复数学建模 Workbench

### 5.1 已确认的坏点

- 预设不出现：当前内核不再扫描磁盘发现预设（`@linxin666/dsh-client-ui-preset-center` README：“harness 不再从磁盘发现预设”），所以 `~/.dsh-mathmodel/.agent-presets/` 下的两个目录都不会加载。`--dump-config` 的预设列表里没有 `math-modeling`，也没有 `liangshen`。（梁神现在由 `web-ui-liangshen` 插件提供，不受影响。）
- 预设组合是旧内核的：`agent.cordis.yml` 引用的 `@deepseek-ai/dsh-workflow-worker-thread` 在 rc.5 的 host 里不存在；`backgroundMode` 这个配置项在当前 `dsh-tool-subagent` 的 `Config` 里也不存在。
- 插件代码 `plugins/math-modeling.js`（53 KB）在 rc.5 上能否注册工具，还没有验证。它用的是 `ctx.get('tools').register(手写 definition)`。

### 5.2 修法

1. 把 `math-modeling.js` 移进 `dsh-mathmodel` 作为入口 `./workbench`，按 rc.5 的工具接口修好（参照同包 `src/tools.js` 的注册方式）。
2. 知识库改用 `~/.dsh-mathmodel/skills/math-modeling`（指向 `共享skills`，内容比预设自带的那份新），路径来自插件配置 `skillRoot`。不再从插件自身位置推导。
3. 预设 `math-workbench` 放进一个**新的**托管块（单独的 BEGIN/END 标记，新写一个生成脚本，在 `src/main.cjs` 里与 `restoreSpecializedPresets` 同一处调用）。不能放进专用预设块：那个块要求插件名单与 standard 一致，并且会对现有块内容做严格比对，不一致就抛出 “Managed preset block differs”。而 `main.cjs:288-293` 每次启动都会以 `apply:true` 运行它，异常没有被捕获，桌面会启动失败。新块的组合从当前 standard 名单生成，去掉 `delegation` 组，加上 `./workbench`、Skills 和 `delegate`。新脚本出错时只记日志、跳过，不阻止启动。
4. 门禁审查（M1、P1、P2、W1、W2）原本写的是“派发独立只读 Subagent”，改成调用 `delegate role=review`。`mm_gate record` 需要 `{scope, inputSnapshot, status: PASS|FAIL|BLOCKED, evidence[], findings[{level,text}], rework}`（`math-modeling.js:398, 411-421`），由 review 回执映射过去：`verdict` 为 pass 映射成 PASS，fail 映射成 FAIL；`status` 为 blocked 时映射成 BLOCKED；`findings` 的 `level` 原样保留；`evidence` 取各条 finding 的证据；`rework` 取 `open_questions`。`scope` 和 `inputSnapshot` 由主代理填写。
5. UI Dock（`plugins/dsh-math-modeling-ui`，进度看板）这次不处理。它本来就不随预设挂载，是在会话里贴提示词动态加载的。（我的决定）
6. 旧目录 `~/.dsh-mathmodel/.agent-presets/` 原样保留，不删除。

## 6. C：合并零碎模式

1. `scripts/task-capabilities.mjs` 改成只生成一个预设 `task`（显示名“任务”），内容等于原来四项全开的 `task-0f`，子代理部分换成交接插件（见 4.8）。现在的代码要求正好 16 个托管预设（`task-capabilities.mjs:94`），这部分要重写。
2. 能力面板现有的 Skills / MCP / 任务板开关之外，再加联网、子代理、外部视觉/生图三个开关，用法与 `task-tool-switches.js` 相同：首轮前关闭就移除 schema；首轮后关闭只由执行守卫拒绝调用，schema 保留，不打断缓存。原来“首轮前四项组合”的复选框去掉。`host-capabilities.js` 里写死的 `/^task-0[0-9a-f]$/`（第 19、97、112 行）和按 mask 调用 `presets.select` 切换预设的逻辑也要一起改：确认组合时不再切换预设，只写开关状态。
3. 迁移：16 个旧预设全部删除。删除前备份 `cordis.patch.yml`，与现有迁移的备份方式相同。迁移脚本先按会话记录检查是否有会话引用 `task-00`～`task-0f`：现在是 0 个；如果迁移时发现有，就停止迁移、写日志，不删除，等人来处理。（我的决定：只保留被引用的几个，会让 16 个的校验和 mask 逻辑同时存在两套，不值得。）
4. `mathmodel`、`imagegen`、`editable-ppt` 三个专用预设这次不动（用户 2026-10-31 确认）。

## 7. 约束

- 内核 `@deepseek-ai/dsh` 0.2.1-rc.5，web-all 0.4.12，桌面 0.2.0。不改内核包。
- 改 `dsh-mathmodel` 要保持 `src/version.js` 的版本门白名单，新增的入口要加进 `package.json` 的 `exports` 和 `files`。这个包没有 vendor 锁（`scripts/` 下只有 fusion-prebuilt、kimi-browser、kimi-daemon、sandbox-auto 四个锁），不需要重签。
- 隔离测试必须同时设置 `DSH_HOME` 和 `DSH_DESKTOP_USER_DATA`，否则会重新播种用户真实的 profile。
- 清理目录之前先处理 junction：`profiles/node_modules` 里有指向安装目录的链接，递归删除会把已安装的应用清空（见 `docs/install-wipe-2026-10-27.md`）。
- 托管块里不能混进额外的行，否则启动报 `Task capability conflict`。
- 部署到个人安装之前，备份 `cordis.patch.yml`、插件目录和安装目录里会被覆盖的文件。

## 8. 验证

1. 插件单测：参数缺失时拒绝；文件重叠时拒绝；结束后释放占用；回执违规标记；账本写入；子代理守卫（只读角色的 write / edit 被拒，implement 写 `files` 以外被拒，所有子代理调 `delegate` 被拒）；“任务”预设名单里没有 `delegation` 组。
2. 隔离 Host 真实请求，主代理 Astra、子代理 Flash，各跑一次：
   - 找 bug：一个合成仓库里埋 2 个 bug，主代理一次并行派 2 个以上 `explore`，最后修好并且测试通过。
   - 搭框架再填充：主代理定接口，2 个 `implement` 各填一个文件，再派 1 个 `review`；同时故意让两个交接争用同一个文件，确认第二个被拒绝。
   - 记录每次交接的回执是否通过 schema 校验，以及主代理有没有在说“完成”之前自己跑检查。
3. Workbench：在隔离 Host 里能选中，`mm_project_init` → `mm_gate M1`（审查走 `delegate`）跑通一次。
4. 合并模式：预设列表只剩一个“任务”；三个新开关在首轮前移除 schema、首轮后只守卫（复用 `scripts/verify-task-tool-switches.mjs` 的检查方式）。
5. 桌面完整回归（`npm test`）。`tests/fusion-latest-transport.test.mjs` 这一项在本次改动之前就已经失败，结果里单独列出来。
6. 部署到个人安装后，在真实桌面 GUI 里新建一个“任务”会话，跑一次找 bug 场景。

## 9. 留给实现者决定

- 交接单拼成子代理首条消息的具体措辞。
- `handoff_ledger` 的输出格式。
- 每个场景用什么合成仓库。
- 迁移脚本怎样判断会话是否引用了旧预设（可以复用 `_tok/preset-usage/peek.mjs` 的多帧 zstd 读取方式）。

## 10. 我替用户做的决定（请审阅）

1. 交接插件放进 `dsh-mathmodel` 包，不新建包。
2. 角色和默认路线：explore / implement 用 Flash，review / escalate 用 Astra。
3. 子代理不另建预设，沿用父会话预设，权限差异靠执行守卫。只读角色仍能用终端，这是已知上限。
4. 使用交接插件的预设去掉整个原生 `delegation` 组，所以交接完的子代理不能续聊，返工要重新发交接。
5. `delegate` 等待子代理结束再返回（`delivery: 'caller'`），这样插件能自己渲染回执和违规提示。
6. 写入互斥表按 Host 进程全局共享，重启后清空。
7. `review` 用单独一份带 `verdict` 的 schema，并映射到 `mm_gate` 的门禁回执格式。
8. 16 个旧 task 预设全部删除；迁移时若发现有会话引用，停止迁移等人处理。
9. `math-workbench` 用新的托管块，不动现有专用预设块。
10. 这次不做交接面板。
11. Workbench 的进度看板（UI Dock）这次不处理。

## 11. 已定的问题（2026-10-31 用户答复）

1. 子代理的 Flash 用 Magpie 的 `workbuddy-ai/deepseek-v4.1-flash`（`cordis.patch.yml` 第 833 行）。
2. `mathmodel`、`imagegen`、`editable-ppt` 三个专用预设这次不合并。
