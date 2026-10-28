# DSH 桌面版与 Claude Code 能力对照（2026-10-11）

本表回答“具备哪些能力、边界在哪里”，不作产品优劣或性能等价结论。DSH 基线为桌面 **0.1.3**、内核 **0.2.0-rc.2**、web-all **0.4.5**、候选 Fusion **0.2.6**。Claude 一侧为 2026-10-11 检索的官方在线文档，覆盖 CLI 与 Desktop；没有在本机安装或运行 Claude 对照测试，也未固定单一 Claude 二进制版本。

“已有实测”列引用 [此前桌面审计](desktop-plugin-audit-2026-10-10.md) 的具体阶段；本次文档核验只读取本地包文档/代码和官方网页。覆盖安装后的运行结果由主线升级验收回执另行证明，本表不预先认定通过。

| 能力 | DSH 当前包实现与边界 | Claude Code 官方能力 | 已有实测与验收边界 |
| --- | --- | --- | --- |
| 模型 / provider | `llm-pi-ai` 支持多 provider、OpenAI-compatible gateway、自托管地址及自定义模型目录；和直接 DeepSeek route 可共存。[D1] | 可配置 Claude 模型/别名，支持 Anthropic 直接接入及 Bedrock、Claude Platform on AWS、Google Cloud Agent Platform、Foundry 等部署渠道。官方这些渠道描述不能推导为任意非 Claude 模型兼容。[模型配置](https://code.claude.com/docs/en/model-config)、[部署渠道](https://code.claude.com/docs/en/third-party-integrations) | 旧版桌面曾失败于缺 `/v1` 的 Qwen endpoint；后续审计记录修正后 `qwen3.8-flash` 回复成功，隔离 Fusion 的 max/flash 链路成功。只证明所测配置，不证明全部 provider/model。 |
| AgentTeams | 实验包提供 Lead、命名 teammate、持久消息、共享任务及依赖；需 team service、tool 包和持久存储一起接线。共享工作目录，不支持成员各自独立目录或多进程协调。[D2] | 实验性、默认关闭；显式启用后支持独立上下文的 teammates、共享任务、消息及 in-process/split-pane 展示，仍有恢复、协调与关闭限制。[Agent teams](https://code.claude.com/docs/en/agent-teams) | 此前已安装版开关关闭，不能认定调用链通过。安装后应证明创建成员、消息和任务领取/完成，而非只检查包存在。 |
| Auto Review / 工具权限审查 | `dsh-experimental-auto-review` 在 native/PTC 内层工具执行前使用当前 agent 的 provider/model 审查；允许后按 Full access 执行，拒绝按 approval policy 处理，技术故障不执行。默认关闭且为实验能力。[D3] | 对应能力是 **auto permission mode**：classifier 审查动作；具体可用性取决于模型、组织和版本，不能由名称推断策略一致。[Permission modes](https://code.claude.com/docs/en/permission-modes) | 此前关闭；需升级后选中 Auto 并取得真实审查决策与工具结果。插件已启用与会话已选中 Auto 是两件事。 |
| 代码 / PR review | Auto Review 是授权审查，不是代码质量 review。Fusion 的 Lead 有结果复核，但这是其任务流程。[D3][D8] | 官方另有本地 `/code-review` 和 GitHub 自动 PR Code Review；后者当前为 Team/Enterprise 的研究预览，需单独设置。[Code Review](https://code.claude.com/docs/en/code-review) | 没有 DSH 与 Claude 同题代码 review 的质量对照；不能将 Auto Review 开关作为覆盖此能力的证明。 |
| hooks | Claude 桥仅运行 **shell-form command**；`http`、`mcp_tool`、`prompt`、`agent` 跳过。支持七类事件的部分语义，具体边界见下节。[D4] | 当前官方文档列五类 handler，支持范围因事件而异；拥有更多生命周期事件及分层配置。[Hooks reference](https://code.claude.com/docs/en/hooks) | 已有 `PreToolUse` 配置和隔离 smoke；此前桌面会话真实工具触发未取证。需升级后记录 `hook/invoked` / `hook/result` 与实际工具行为。 |
| Git 分支 / worktree | Git Graph 提供分支切换、新建 worktree 并注册 workspace、新会话与管理入口；分支控件只在有 cwd 的 **空白 Git 会话** 显示。auto-isolation / agent tool 为可选项。[D5] | CLI `--worktree`、子代理 worktree 隔离和 Desktop 新会话 worktree 均有官方支持；worktree 隔离文件编辑但仍共享 Git 仓库历史。[Worktrees](https://code.claude.com/docs/en/worktrees) | 此前插件运行中但目标会话未出现控件，尚未切分支/创建 worktree。需在合成 Git 仓库逐项取证，不能以“已加载”代替。 |
| MCP | `dsh-mcp-client` 可将 MCP 工具接入模型，文档支持 stdio 与 Streamable HTTP；另有资源包。[D6] | 支持远程 HTTP 与本地 stdio MCP，配置作用域、认证及其他能力以官方文档为准。[MCP](https://code.claude.com/docs/en/mcp) | 本表仅确认包能力，未新运行任何 MCP server；不能据此认定每个连接、认证方式或协议扩展兼容。 |
| Skills | 文件系统 provider 发现目录 `SKILL.md` 或平铺 Markdown，支持项目/用户/自定义 roots、按需加载及目录监视；桌面 mathmodel 卡片接管原 skill UI。[D7][D9] | 支持 `SKILL.md`、用户/项目/插件等作用域、显式或模型调用；其 frontmatter、命名及发现规则以官方定义为准。[Skills](https://code.claude.com/docs/en/skills) | 此前桌面说明页显示 78 个 Skill。这证明目录可呈现，不代表 78 项全部执行，也不证明 Claude-specific frontmatter 和插件约定全部兼容。 |
| Desktop | Electron 加载本机 DSH Web host；插件 UI 运行于桌面窗口。候选同时提供 NSIS / ZIP。[D9][D10] | Claude Desktop 提供 Code 会话及本地、SSH 等环境入口。[Desktop](https://code.claude.com/docs/en/desktop) | 此前桌面任务看板五列、插件详情和远程面板已打开；候选静态校验通过。二者均不能代替旧安装目录覆盖升级后的回归。 |
| 远程访问 | remote-web-ui 通过配对设备、受控远程通道和可配置 LAN / tunnel 暴露本机 Web GUI；具体网络暴露取决于设置。[D11] | Remote Control 让本机会话通过 Anthropic 服务与 web/mobile 同步，仅出站 HTTPS，不开放本机入站端口。[Remote Control](https://code.claude.com/docs/en/remote-control) | 此前 DSH 仅监听 `127.0.0.1`、无公网地址；只证明面板与本机绑定，未证明外部设备配对或公网连接。两者连接拓扑不等同。 |
| SSH | 独立 `dsh-ssh` 是远程 Linux 运维插件：终端、SFTP、端口转发与六个 agent tools。桌面 OSC 8 链接已有构建修复。[D12] | Desktop SSH 环境在远程 Linux/macOS 运行 Claude Code，并以桌面为界面；支持远端会话/worktree。[Desktop SSH](https://code.claude.com/docs/en/desktop#ssh-sessions) | 此前 DSH SSH 关闭；链接补丁定向测试 5/5 仅证明补丁行为，不证明远程认证、命令、文件传输或把整个 DSH agent 移到远端。 |
| Fusion | 独立插件把 Lead / Sidekick 组合呈现为一个模型入口，包含委派、验收、Lead 复核与返工；复用 DSH provider。[D8] | Claude 的模型配置与 agent teams 可分配模型和角色；本次所查官方页面没有证明存在与此插件完全相同的跨 provider Lead/Sidekick 验收协议。[模型配置](https://code.claude.com/docs/en/model-config)、[Agent teams](https://code.claude.com/docs/en/agent-teams) | 隔离 smoke 记录一次 `COMPLETED / verified`；候选含 0.2.6 和 loader。覆盖安装后的模型入口、委派和复核由本轮正式桌面验收另证。 |
| 性能 / 成本 | 插件 README 的外部题库实验是作者报告；本机一次 smoke 无同题基线、重复样本或实际账单。[D8][D10] | 本次未测 Claude 性能、成本、质量。 | **不宣称更快、更便宜、质量相当或超越。** 后续 A/B 必须固定任务、验收、模型、网络条件，并记录成功率、端到端时间、token 和账单口径。 |

## hooks 迁移时必须保留的边界

以下来自当前 **0.2.0-rc.2** 桥的包文档及打包 JS [D4]，不是完整 Claude 兼容承诺：

- 支持映射 `SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`Stop`、`SubagentStart`、`SubagentStop`；后者只能观察。不要因配置 JSON 可解析就认为其他事件会执行。
- `PreToolUse` 的 `deny` / `ask` 有效；`allow` 不会预先授权，`updatedInput` 只记录警告而不改写工具输入，`defer` 不支持。hook 成功退出本身也不证明工具被改写。
- `transcript_path` 为空字符串；依赖 Claude transcript 文件、父子会话 ID 约定或完整 payload 字段的脚本需另行适配。
- 桥在加载时读取单个 `configPath`，匹配 handler 串行执行；不提供 Claude 的分层配置/live reload，且 `async`、`once` 等 command 选项不能假定生效。
- 包 README 对 `SessionStart` 是否等待首轮存在矛盾表述（实现说明与限制段不同）；本表不推断上下文必定进入首次模型请求，需以运行证据确认。

## 本地证据索引

以下为随当前工作区解析到的包文档/代码，可能在重新构建后变化；它们证明实现声明和构建输入，不独立证明正在运行的安装目录载荷。

- [D1：llm-pi-ai](../runtime/host/node_modules/@deepseek-ai/dsh-llm-pi-ai/README.md)
- [D2：AgentTeams](../runtime/host/node_modules/@deepseek-ai/dsh-experimental-agent-team/README.md)
- [D3：Auto Review](../runtime/host/node_modules/@deepseek-ai/dsh-experimental-auto-review/README.md)
- [D4：hooks 桥文档](../runtime/host/node_modules/@deepseek-ai/dsh-hooks-claude-code/README.md)、[打包实现](../runtime/host/node_modules/@deepseek-ai/dsh-hooks-claude-code/lib/index.js)
- [D5：Git Graph](../runtime/profile-web/node_modules/@linxin666/dsh-client-ui-git-graph/README.md)、[桌面构建兼容检查](../scripts/patch-git-graph.mjs)
- [D6：MCP client](../runtime/host/node_modules/@deepseek-ai/dsh-mcp-client/README.md)
- [D7：Skill filesystem](../runtime/host/node_modules/@deepseek-ai/dsh-skill-filesystem/README.md)
- [D8：Fusion 文档](../plugins/dsh-model-fusion/README.md)、[版本](../plugins/dsh-model-fusion/package.json)
- [D9：桌面说明](../README.zh.md)、[profile 接线](../build/profile.cordis.patch.yml)、[桌面版本](../package.json)
- [D10：此前桌面/隔离审计](desktop-plugin-audit-2026-10-10.md)、[候选包静态回执](../dist/fusion-release-candidate/verification.json)
- [D11：Remote Web UI](../runtime/profile-web/node_modules/@linxin666/dsh-remote-web-ui/README.md)
- [D12：SSH](../runtime/profile-web/node_modules/@linxin666/dsh-ssh/README.md)、[链接回归用例](../tests/web-all-desktop-links.test.mjs)

## 覆盖安装后的补充证据（2026-10-12 更新）

表中的“此前”指原始审计时点。主线已用校验后的候选 ZIP 覆盖实际安装目录，以下为随后新增的运行证据：

- Git Graph：桌面合成 Git 会话切换分支、切回 main，并由桌面创建 worktree 和新会话；见 [Git UI 回执](../dist/fusion-installed-verification/git-graph-ui.json)。
- Hooks：实际模型工具链出现 PreToolUse block(exit 2)，目标文件不存在；恢复工作区写权限后 pass(exit 0)，fixture 写入成功。Windows PowerShell command 显式传递 Node 退出码；见 [实际路径回执](../dist/fusion-installed-verification/installed-feature-paths.json)。
- AgentTeams：成员执行合成算术任务，内部消息送达，共享任务完成。Auto Review：Auto 权限下实际写入 fixture；插件不持久化原始审查决定，因此只证明允许执行路径，不能宣称完整风险分类审计。两个实验 bundle 测后恢复关闭。
- 可选页面：SSH 配置表单、Skill Explorer 搜索和梁神拨杆已在桌面操作，三个插件测后恢复关闭；见 [UI 观察](../dist/fusion-installed-verification/optional-ui-observations.json)。没有可用远程 SSH 主机，本次未测试真实远程连接。
- 八项 legacy 原契约测试已执行且仍有失败，订阅桥服务缺失仍是实际能力缺口；见 [订阅服务缺口](subscription-bridge-gap-2026-10-11.md)。不把新版模型能力或替代契约测试冒充旧契约通过。

## 版本与验收口径

Claude 官网是滚动文档，CLI、Desktop、部署渠道与订阅能力不能混为一版；例如当前权限页明确含 v2.1.283+ 行为，而 AgentTeams 仍标注 experimental。本表保留检索日期和直接页面链接，不以旧教程覆盖当前官方限制，也未采用第三方转载作为证据。

该对照项的完成条件是：各指定能力有来源、可识别的版本及实现/实测区分。升级安装、五项运行闭环、八项 legacy 测试、完整插件组合和性能 A/B 各自需要自己的验收回执；本表完成不意味着那些项目已通过。
