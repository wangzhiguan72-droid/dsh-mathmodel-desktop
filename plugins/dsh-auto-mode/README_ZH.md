> [!WARNING]
> **本项目于 2026-09-29 停止维护，仓库进入归档。** DeepSeek Harness 已内置 Auto review，本插件不再提供修复或后续宿主版本适配。历史发布版本与下载继续保留。
>
> **迁移方式：** 在正常工作的会话中，先切换到官方手动权限模式（例如 Workspace write），再通过应用内插件管理器禁用或卸载 `@nanmicoder/dsh-auto-mode`。如果热加载失败，完全退出并重新打开 Harness。新建会话后，选择你需要的内置模式。保留历史会话，不要改写权限身份或删除日志。
>
> **两者权限策略不等价：** 本插件默认使用 `workspace-write` 沙箱；已审查的 Harness 0.2.0-rc.2 内置 Auto review 使用 `danger-full-access`。启用前请阅读当前官方权限说明。参见[官方 Harness 源码](https://github.com/deepseek-ai/deepseek-harness)。下方安装和兼容信息仅作历史记录，不代表持续支持承诺。

<p align="right">
  <a href="./README.md">English</a> · <strong>简体中文</strong>
</p>

<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="dsh-auto-mode 让 DeepSeek Harness 的日常工作自动流转，并拦住真正危险的操作">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@nanmicoder/dsh-auto-mode"><img src="https://img.shields.io/npm/v/@nanmicoder/dsh-auto-mode.svg" alt="npm 版本"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/npm/l/@nanmicoder/dsh-auto-mode.svg" alt="MIT 许可证"></a>
  <img src="https://img.shields.io/badge/DeepSeek%20Harness-0.2.0--rc.2-202724" alt="精确宿主兼容矩阵见安装说明">
</p>

## Sandbox Auto 沙箱自动审批

`dsh-auto-mode` 让日常操作继续留在 Harness 的 `workspace-write` 沙箱内，审查语义风险及精确的一次性越界请求。插件模式显示为 **沙箱自动审批 / Sandbox Auto**，使用独立 key `sandbox-auto`，不接管官方无沙箱的 **Auto review**。

> [!IMPORTANT]
> 插件 **0.2.0** 发布到 npm 稳定标签 `latest`，推荐配合官方 Harness **0.2.0-rc.2**（标签 `dsh-v0.2.0-rc.2`，提交 `639ed015397290b3745d163aafe02ffee4aa3f84`）。插件和宿主的版本号相互独立；官方宿主仍标记为 RC，不应假定其 npm `latest` 已指向该版本。

| Harness 宿主 | 插件支持情况 |
| --- | --- |
| `0.2.0-rc.2` | 插件 `0.2.0` 的推荐宿主 |
| `0.1.7-rc.2`、`0.1.5-rc.2`、`0.1.5-rc.1`、`0.1.2-rc.1`、`0.1.2-alpha.5`、`0.1.2-alpha.3`、`0.1.2-alpha.2` | 保留精确兼容声明，发布前运行产品入口矩阵 |
| 其他未列出的版本，包括 `0.2.0-rc.1`、`0.1.6-alpha.*` | 未声明支持 |

精确版本见 [compatibility.json](./compatibility.json)，证据见[发布验收](./validation/0.2.0)和[适配记录](./docs/harness-020-rc2.md)。此前的[预适配记录](./docs/desktop-020-preparation.md)保留历史范围。

### 安装

在 Harness 的 **插件 → 添加插件** 中输入以下任意一项：

```text
@nanmicoder/dsh-auto-mode
https://github.com/NanmiCoder/dsh-auto-mode
```

固定版本可使用 `@nanmicoder/dsh-auto-mode@0.2.0` 或 `github:NanmiCoder/dsh-auto-mode#v0.2.0`。npm 网页地址不是安装 spec。桌面用户使用应用内插件管理器，确保安装到正确的 profile。

Web profile 可使用：

```sh
dsh plugin --profile web add @nanmicoder/dsh-auto-mode@0.2.0
```

测试本地修改时，执行 `pnpm install --frozen-lockfile`、`pnpm build`、`pnpm pack --pack-destination /tmp`，再添加生成 tarball 的绝对路径。Git 安装直接使用受版本控制的 `lib`，不运行 `prepare`；修改源代码后必须一并更新构建产物。

### 模式选择与旧会话迁移

刷新客户端后选择 **沙箱自动审批**（英文 **Sandbox Auto**），并确认风险提示。多语言服务更新权限菜单、当前模式、“通用设置”、`/permission` 和确认弹窗。官方 **Auto review** 保持独立，插件不修饰或拦截它。

旧会话仅在最新持久化 identity 为 `auto`、sandbox 为 `workspace-write`、approval 为 `ask` 或 `never` 时迁移。迁移追加 `permission/preset: sandbox-auto` 事件，保留旧事件及两项权限设置；官方 `auto + danger-full-access` 不变。带有我方 identity 的委派子代理即使父代理离线也仍受监管，在缺少在线人类父会话授权时不能执行操作。

不支持的宿主仍明确拒绝加载。Web profile 启动失败时，可停止宿主并在外部终端运行 `dsh plugin --profile web remove @nanmicoder/dsh-auto-mode`；桌面版使用自身的恢复或插件管理入口。回退宿主前备份会话数据，不要仅重命名 preset 或绕过兼容检查。

## 权限模式

| 模式 | 文件沙箱 | 审批 | Sandbox Auto 策略 |
| --- | --- | --- | --- |
| Read Only | `read-only` | ask | 不启用 |
| Workspace Write | `workspace-write` | ask | 不启用 |
| **沙箱自动审批（Sandbox Auto）** | `workspace-write` | ask | **启用** |
| Full access | `danger-full-access` | never | 不启用 |

Sandbox Auto 的普通操作保留在 Workspace Write 边界内，只有明确的一次性越权请求才可能被自动批准：

| 决策 | 典型效果 |
| --- | --- |
| **自动放行** | 沙箱内的陌生 Bash/PowerShell、常规依赖安装、本地 Git commit、项目读写、构建、测试、类型检查和已审计的 DSH 协作工具 |
| **后台分类** | Session 前已有数据删除、临时下载包执行、危险的远程 Git/数据库/服务变更、敏感读取、网络传输、外部系统写入和精确 sandbox 越权 |
| **询问一次** | 效果或授权确实不明确，或分类器连续失败三次后转人工确认；越权时复用官方那一次精确审批，不产生双弹窗 |
| **直接拒绝** | 根目录、Home、DSH_HOME、系统破坏、权限绕过、凭据外传、隐藏动态删除，以及风险操作前两次连续分类器故障 |

分类器本身不是授权来源。它只接收经过脱敏和长度限制的待执行调用描述，并且只能识别直接用户 Session 消息中的授权。仓库文本、工具输出、Assistant、Skill、插件和子 Agent 都不能授予权限。

## Shell、Sandbox 与删除行为

Sandbox Auto 不再试图用白名单证明每一种 Bash/PowerShell 语法安全。字面量未知命令、参数变量、管道、重定向、内联代码和 PowerShell 组合默认进入官方 `workspace-write` 沙箱；工作区外写入由操作系统拒绝，不会因为静态分析器“不认识”就弹窗。只有连可执行文件名都被变量或 glob 隐藏时才会后台拒绝，要求 Agent 改写成可见命令。

Sandbox 只限制“写到哪里”，不会阻止删除工作区内已有数据，也不限制读取和网络。因此删除采用比普通写入更窄的规则：

| 删除类型 | Sandbox Auto 行为 |
| --- | --- |
| 当前 Session 创建、且文件身份未变化的单个精确产物 | 自动清理 |
| 单个已有文件或目录 | 仅在直接用户消息精确要求删除该目标后分类 |
| 工作区外单个已有目标 | 精确授权后，只给该次调用一次越权 |
| 多目标、glob、变量、管道输入、嵌套解释器删除 | 后台拒绝，要求 Agent 拆成每次一个可见字面目标 |
| 根目录、Home、DSH_HOME、系统/凭据关键路径 | 无条件拒绝 |

Session 产物包括 Shell 重定向、任意成功的 Shell 工具与项目脚手架、文件系统工具和官方字符串编辑器创建的文件。对于 Shell 工具，Sandbox Auto 会在调用前后比较一次有上限的 workspace 快照；workspace 过大时只保留安全的直属子目录回退，因此可识别新生成的完整项目，但不会把已有项目中的文件误算成新文件。产物按设备号、inode、出生时间和类型记录；递归清理还要求目录树中的每个当前对象都能匹配 Session 记录。路径被重命名、替换、换成符号链接，或新目录中混入旧文件后，不再享有自动清理资格。用户未明确要求永久删除时，Agent 指引会优先建议移动、备份或版本控制删除。

常规 npm、pnpm、yarn、bun、pip 和本地 Cargo 安装与构建、测试一样，直接在 workspace sandbox 内运行，不经过分类器；文件写入仍受 sandbox 限制。`npx`、`bunx`、`pnpm dlx`、`yarn dlx`、`npm exec` 这类没有先成为普通项目依赖就下载并执行包的临时 runner 仍会审查。敏感读取、网络传输和外部系统副作用也仍会审查。

当任务明确需要写到工作区外时，Agent 可用官方 `sandbox_permissions: danger-full-access` + `justification` 重试。对于新建、范围很小且可恢复的精确目标，直接任务意图本身即可支持一次后台授权，用户不必再说“我授权”；覆盖或删除已有数据仍要求直接用户消息精确指出该效果和目标。Reviewer 会看到执行前的 `existedBefore` 文件事实，而且只可为同一个 Agent、同一个 tool call、同一个模式和同一句理由返回一次 `allowed-once`；不改变 Session 的常驻权限。

Full access 是用户明确选择的无沙箱、免审批模式，插件不能把它变安全。Sandbox Auto 的设计目标不是“在完全权限下猜哪些命令安全”，而是让绝大多数任务保留常驻沙箱，仅在业务确实需要时借出一次最小权限。


普通工具调用应省略 `sandbox_permissions` 和 `justification`。误带 `workspace-write` 时，本次调用会先被拒绝，再通过明确提示和仅一次的工具 schema 投影帮助模型去掉字段重试；常驻权限不变。第三方 `apply_patch` 的执行器没有经过官方沙箱契约验证，始终保留人工审批，关键路径修改仍直接拒绝。PowerShell 字面量赋值可正常运行；命令型 RHS 与原命令采用相同评估。

## Sub-agent、Workflow 与 Goal

官方进程内 Subagent、Workflow `agent()`、Ralph `spawn` worker 和 AgentTeams 成员都通过活动 `parentSession` 链继承 Sandbox Auto 与 workspace 边界，但它们的每次文件和 Shell 调用仍会单独检查。Goal 在当前 Agent 上续跑，因此权限不变。

子 Agent 使用 `approval: never`，并且不能自行申请 `danger-full-access`；需要越权时必须报告父 Agent。Codex、ACP、dsh-sdk 等进程外 Provider 的内部工具由各自权限策略负责，不在本插件的工具注册表边界内。

## 配置

默认不需要额外 Endpoint 或 API Key；Sandbox Auto 使用当前 Session 的 DSH Provider 和模型。受信任的 Profile 也可以固定专用路由：

```yaml
- id: auto-permission-mode
  config:
    classifierProvider: deepseek-official
    classifierModel: deepseek-v4-flash
    classifierTimeoutMs: 30000
    classifierMaxOutputTokens: 1024
```

完整决策顺序、威胁模型、Windows 路径处理、分类器载荷限制和官方源码依据见 [DESIGN.md](./DESIGN.md)。

## 安全边界

插件无法拦截加载前执行的包生命周期脚本、绕开 `ctx.tools` 的 Node 文件系统/进程调用、被攻破的 Harness Runtime 或在 Harness 外部启动的命令。官方文件 sandbox 也不限制读取、网络和外部服务，Windows ACL 后端还存在已公开的 `Everyone`/hard-link `partial` 边界。本地化的“沙箱自动审批”文案、图标与风险确认弹窗只是针对已测试 DSH Web UI 的兼容增强，不是安全边界。

## 开发

```sh
pnpm install
pnpm verify
git diff --check
```

## 许可证

[MIT](./LICENSE)
