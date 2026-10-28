# 桌面插件与适配核验（2026-10-10）

## 结论

`@linxin666/dsh-web-all` 已适配 DeepSeek Harness 桌面架构。这个桌面版由 Electron `BrowserWindow` 加载本机 DSH Web host；“Web UI”描述插件的前端形态，不表示它只能在外部浏览器使用。当前安装 profile 为 DSH `0.2.0-rc.2` + `dsh-web-all 0.4.5`，符合该插件的版本要求，且聚合插件在桌面设置页为启用状态。

桌面窗口中打开任务看板成功，渲染了项目筛选、搜索栏和各状态列。这证明了桌面 WebView 中至少一个全家桶页面可运行；还不能据此说所有子插件都已逐一实测。

## 已有适配和本轮修复

- Electron 通过本机 loopback HTTP host 加载主界面，renderer 开启 `contextIsolation`、禁用 `nodeIntegration` 和 sandbox。
- 更新入口检测桌面受限桥 `window.desktopUpdates`，并交由桌面更新器处理；构建产物会对 web-all 与 update 服务应用配套补丁。
- Git Graph 的构建步骤已按目标 DSH workspace API 做兼容处理或形状校验。
- 旧审计担心升级后会话遥测 loader ID 改名而使隐私禁用失效；当前内核 `dsh-base/cordis.patch.yml` 仍注册 `id: session-telemetry-otel`，与桌面用户 patch 的 `disabled: true` 精确一致，因此这个具体风险已排除。`dsh-host-product-telemetry-otel` 与 `dsh-client-product-analytics` 包虽存在于 host 磁盘，但本轮在当前 profile 的 patch 文件中未找到对应 loader 行；是否有其他启动路径使用它们仍未确认。
- 旧交接担心 `dsh-mathmodel` 与 0.2.0-rc.2 的预设 API 不兼容；当前插件 peer 范围已包含 `0.2.0-rc.2`，源码/依赖清单中也没有 `agent-presets` 或新预设 registry 的直接引用。这排除了直接依赖断裂，不能替代 Remote、Slot、Input Trigger、Conversation、Preset 五类完整行为回归。
- 本轮发现 SSH/xterm OSC 8 链接先打开空窗口、再设置地址，与桌面壳“只把带目标地址的 HTTP(S) 新窗口转交系统浏览器”的策略不兼容。构建补丁已覆盖全家桶捆绑入口和独立 `dsh-ssh` 包，把链接改成带目标地址且设置 `noopener,noreferrer` 的打开调用；没有放宽 Electron 新窗口或 Node 权限。

## 仍未完成的核验

- 当前全家桶的 `/api/dsh-web-all/rows` 只列 shell 隔离行，不包括 community plugins、pet、preset center、skin center 等直连行；普通桌面启动也未执行完整的插件健康检查。更新启动验证通过不能代表这些直连模块的每个页面都正常。
- 初次核验只打开了任务看板；后续逐项检查已补充插件详情、模型设置与远程访问设置。Git Graph 的会话内分支控件仍未在目标工作区的会话中实际点击；SSH、liangshen、skill explorer 仍关闭，因而其页面路径未测。
- 全家桶内 SSH、liangshen、skill explorer 默认采用按需开启策略；不应把“包含在聚合包”说成“当前均已激活”。
- 官方 AgentTeams 与 Auto Review 包随桌面 host 安装，但当前 profile patch 没有把它们插入加载链；桌面插件页的两个开关均关闭。AgentTeams 实际调用路径因此还没有在本 profile 中验证。
- `hooks-claude-code` 已接入当前 profile，配置指向现存的绝对路径 `hooks.json`；文件包含一个 `PreToolUse` command hook。此前有隔离 smoke，但当前桌面会话中的真实工具调用触发仍缺证据。
- Claude Code 能力对照表曾因汇总任务返回 403 而未交付；八项 legacy 测试仍是历史断言缺口。完整第三方组合、真实付费模型链路和性能前后基准也没有新的实测证据。

## 本轮验证

- `tests/web-all-desktop-links.test.mjs`：5 项通过，覆盖用户确认、聚合包与独立 SSH 包的桌面打开参数、构建补丁幂等，以及上游结构变化时失败关闭。
- 补丁函数针对当前仓库固定的 `dsh-web-all 0.4.5` 与 `dsh-ssh 0.4.5` 客户端源码完成匹配；并已接入 runtime staging 与 Windows 成品验证。
- 没有安装/升级已发布桌面程序，也没有切换 AgentTeams、Auto Review 或全家桶内部开关。

## 2026-10-10 继续逐项检查

- **V3→V4 迁移：已有独立凭据，已确认通过。** `dist/kernel-upgrade-0.1.3/real-session-migration-verification.json` 的 7 项检查全通过；`personal-kernel-independent-check.json` 独立确认 7 个会话文件逐字节一致、3 个连接保留、健康启动且版本为 0.1.3。完整备份保留在本机。本轮核对了回执，没有重跑迁移。
- **全家桶/桌面容器：已证实。** 正在运行的已安装客户端是 0.1.3，窗口地址为 `http://127.0.0.1:3082/`，profile 使用 DSH `0.2.0-rc.2` 和 `dsh-web-all 0.4.5`。桌面内插件页能显示聚合包详情及全部 20 个组件，显示 17 个运行、3 个停用；对应停用项为 SSH、liangshen、Skill Explorer。聚合包开启。任务看板在 Electron 窗口中能渲染五个状态列和筛选控件，各列当前均为 0 条任务。
- **全家桶健康接口：部分可证实。** `GET /api/dsh-web-all/degraded` 返回空降级列表；`GET /api/dsh-web-all/rows` 返回 11 个壳管理子包。它不列出 community plugins、pet、preset center、skin center 等直连包；这些包在桌面插件详情页显示为运行中，因此不能把 rows 数量当作 20 个组件的总数。
- **模型能力：适用条件已满足，真实调用失败。** 当前 profile 已配置自定义 `llm-pi-ai` 提供方 `AAA-qianwen`（route `aaa`），模型目录列出 `qwen3.8-max`、`qwen3.8-flash`、`qwen3.8-27b`；因此模型能力插件的适用对象现已存在，桌面设置卡片也能展开。桌面会话中可选择 `qwen3.8-max`，但一次最小请求在自动重试 5 次后失败，错误为 `Stream ended without finish_reason` / `TRANSPORT`，没有收到助手回复。能力档位草稿未保存；故障具体位于提供方、适配器还是传输层仍未定位。
- **远程访问：桌面设置页可用，尚未启用。** Web 插件设置中的远程访问表单可在 Electron 内展开；绑定状态为 `127.0.0.1:3082`，显示当前仅本机可访问。启用、自动公网隧道、局域网绑定等均为“继承”，没有生成配对码或开启隧道。未更改这些设置。
- **Git Graph：加载已证实，交互未证实。** 桌面详情页把该子组件列为运行中，壳健康接口也列出其客户端包；随包源码会向会话输入区注册分支控件。`methmath harness` 工作区当前没有会话，因此本轮没有点击分支选择、切分支或创建 worktree；这类会改变仓库/会话状态的功能仍需在适合的会话中单独验证。
- **SSH 桌面链接兼容：构建侧已修复，运行侧未启用。** 核对到独立 `dsh-ssh 0.4.5` 也有相同空窗口 OSC 8 链接处理。补丁现同时适配独立包与全家桶客户端，构建会对两边的版本和源码形状做校验，Windows 成品检查也要求独立 SSH 文件包含修复。对当前工作区的定向验证为 5 项通过；当前已安装桌面程序未重新打包，且 SSH 子组件关闭，所以还不能声称已安装版运行验证完成。
- **其他待核验项仍未闭环。** 当前 profile 的 session telemetry 行被禁用。Claude 能力对照表、八项 legacy 测试和全套组合回归仍未补齐；AAA-qianwen 的付费模型请求已有失败实测，但没有成功的完整模型链路；性能提升仍无前后基准可证。

## 2026-10-10 AAA-qianwen 桌面调用实测

- profile 配置声明 `api: openai-completions`、`apiKeyEnv: AAA_API_KEY`，并登记三个 `qwen3.8-*` 模型。凭据文件中存在 `AAA_API_KEY` 条目；本次检查没有读取或输出密钥值。桌面模型设置页显示提供方已配置，模型选择器列出这三个模型。
- 模型能力扩展区对三个模型均可显示；编辑器可选择“不声明”“无推理”或显式推理档位。测试期间只查看了编辑状态并重置未保存草稿，没有写入能力声明。
- 在桌面新会话选择 `qwen3.8-max`，发送一条 `只回复：QWEN-OK`。应用自动重试至 5/5，随后显示 `Stream ended without finish_reason`，分类 `TRANSPORT`；没有助手输出。此结果证实请求进入桌面模型调用链，但不能证明提供方服务健康。
- 轨迹显示本次未附加文件或历史会话正文；Harness 自动加入的运行上下文包含当前工作区路径 `D:\2026国创赛\2027` 及通用运行策略。先前把请求描述为“完全没有工作区内容”不准确，后续外发测试应先检查轨迹实际携带的上下文。
- 未再重试，也未更改模型能力、提供方或凭据设置。提供方/适配器/流传输的具体故障原因仍未确定。

## 2026-10-11 多模型方案比较与 Fusion 实测

- **方案结论：优先采用 `dsh-model-fusion`。** 它是为 DeepSeek Harness 编写的 DSH 插件，复用现有模型目录和 provider route，负责 Lead/Sidekick 分工、委派、复核与状态记录；与现有 `llm-pi-ai` 的 `AAA-qianwen` 提供方互补，不会另造一套模型接入层。`oh-my-opencode` 和 `oh-my-pi` 分别依赖 OpenCode/Bun 与独立 pi-ai 运行时，不能整包直接塞进 DSH；可借鉴它们的按任务选模型、角色覆盖和显式回退设计。
- **仓库接线已落地，正式桌面 profile 未切换。** 插件源码/分发文件位于 `plugins/dsh-model-fusion`，构建 profile patch 增加该 loader 和 DSH_HOME 下的 SQLite 路径；本地 `runtime/profile-web` 依赖指向工作区包，离线安装成功。没有重启或改写用户当前 `mathmodel` profile，也没有提交或暂存改动。
- **桌面 host、设置 UI 和模型目录通过隔离环境核验。** Fusion 页面可读取 AAA 的 qwen3.8-max/flash 目录并保存 Lead/Sidekick 组合；模型选择器能选中 `Fusion · 自动`。随后在隔离 DSH_HOME 发起一次纯 smoke 任务，任务实际模型为 Lead `aaa/qwen3.8-max`、Sidekick `aaa/qwen3.8-flash`。时间线显示 Sidekick 创建文件、Lead 读取并复核，`fusion_review_result` 接受，任务状态 `COMPLETED / verified`，最终回复 `SMOKE_OK`。这与用户提供的 qwen3.8-flash 桌面成功截图一起，证明修正 `/v1` endpoint 后的 Qwen 路由已工作。
- **Fusion 统计（本次单任务，不等于价格账单）：** 8 次原生模型请求，其中 Lead qwen3.8-max 4 次（含 1 次会话标题请求），Sidekick qwen3.8-flash 3 次；16,154 输入 token、33,792 cache-read token（5 次请求报告）、1,473 输出 token。桌面显示耗时 1 分 31 秒、速率约 38 tok/s。服务未提供可核验的实际美元账单，节省率也不可用。小型文件创建任务体现了委派/复核链路，但不能证明性能提升；该任务的委派与复核开销较高，性能结论仍需同题单模型基线和多轮真实任务对照。
- **隔离偏差与残留：** 虽然临时 host 与 profile 在 Temp 下，桌面会话的运行时上下文实际指向 `C:\Users\Administrator\Documents\deepseek-harness\default-workspace`，不符合预期的临时空工作区。Smoke 文件 `fusion-smoke.txt` 已核验内容为 `SMOKE_OK`，写入和 Lead 复读均只涉及该文件；它仍留在该 default-workspace。三份临时 Fusion 根目录也尚未清除，其中 live-smoke profile 保存了本次所需的 `AAA_API_KEY` 副本。用户已授权再次尝试清理，但 exec 安全审查仍以 `blocked by policy` 拒绝；当前 CUA 也没有可操作的 Windows 文件管理器窗口。只读复查确认 smoke 文件、三份目录及凭据副本仍存在；三个隔离 host 已停止，端口 3091–3093 均不再监听。不能声称清理完成，需要恢复可用文件操作通道或由用户在本机清理这些精确路径。
- **性能/成本结论：未证实提升。** 这次只有一次简单烟测，没有单模型对照、质量盲评或同题重复测量；不能将 38 tok/s 或缓存命中率解读为相对原版的提升，也不能从插件统计推算真实费用。

## 2026-10-11 已安装版桌面控制与 Windows 候选包核验

- **桌面控制已连通。** 通过 Windows Computer Use 枚举并绑定正在运行的“DeepSeek 数学建模版”窗口，地址为 `http://127.0.0.1:3082/`。本节的页面状态来自实际桌面截图和控件树，不是截图转述或裸 HTTP 猜测。
- **插件 profile 状态已逐项读到。** 官方 AgentTeams 与 Auto Review 开关均关闭；已安装的 `@linxin666/dsh-web-all@0.4.5` 总开关开启。详情页显示 20 个组件中 17 个运行、3 个关闭：`web-ui-ssh`、`web-ui-liangshen`、`web-ui-skill-explorer`。其余可见子项包括 Git Graph、任务看板、远程 Web UI、模型能力、皮肤中心、宠物、社区插件与预设中心，均显示运行中。没有改动任何开关。
- **页面交互实测。** 从桌面插件详情实际打开任务看板，五个状态列正常显示、当前均为 0 个任务；从侧边栏实际打开远程访问面板，提示只绑定 `127.0.0.1` 且未配置公网地址。Skill 说明侧栏显示 78 个 Skill。当前桌面对话选择器显示 `qwen3.8-flash`，已有成功回复也明确标注该模型。
- **Git Graph 仍有一个真实 UI 缺口。** Git Graph 子组件显示运行中；我在 `methmath harness` 下创建了一个空白检查会话，但其中没有出现分支控件，因此没有切换分支或创建 worktree。当前结论为“插件载入，但目标 workspace 的会话路由尚未证实”，不能写成已通过交互验证。检查留下一个空白会话。
- **hooks 触发仍未证实。** 试图在空白会话输入合成 `Write-Output` 探针时，截图能看到输入区，但计算机控制返回的焦点仍是根文档；为避免误输，没有发送消息。profile 中 `PreToolUse` hook 的配置存在，但桌面实际工具调用触发尚未拿到证据。
- **完整 Windows 候选分发包已生成。** `dist/fusion-release-candidate` 同时有 NSIS 安装器、ZIP 和 `win-unpacked`；构建使用本机 Electron 44.1.1 缓存，没有替换或安装到当前桌面版。静态回执 `verification.json` 通过：21 个必需文件、31,735 个解包文件、31,734 个 ZIP 文件；ZIP CRC 与 17 个关键文件字节比较通过；NSIS 结构、294,415,204 字节的内嵌 payload 和外层完整性检查通过。SHA-256 见同目录 `SHA256SUMS.txt`。
- **正式候选包包含本轮接线。** 候选 payload 的 `VERSION.json` 为 DSH `0.2.0-rc.2` + `dsh-web-all 0.4.5`，构建时间 `2026-10-10T17:14:33.196Z`；包含 `dsh-model-fusion@0.2.6` 和对应 profile loader，独立 `dsh-ssh 0.4.5` 也含桌面安全的链接打开调用。内置 Windows 验证器对解包副本完成 `first / restart / relocated` 三阶段：每阶段均为 GUI loaded、5 个 shared packages、11 个 active family rows、0 degraded，最终 receipt 在临时 fixture 目录。
- **当前安装版仍旧。** 正在使用的桌面安装目录仍为旧 payload（构建时间 `2026-10-09T20:24:22.689Z`），没有 Fusion 包/loader，独立 SSH 客户端也没有新链接修复。因此这次确认的是“新候选包已经打好并通过隔离验证”，不是“已安装版已升级并实测”。没有执行安装器。
- **未闭环项目保持未闭环。** AgentTeams / Auto Review 的实际调用仍受关闭状态阻挡；SSH、liangshen、Skill Explorer 页面路径未测；hooks 实际触发、Git Graph 分支/工作树交互、完整第三方组合回归、Claude Code 能力对照表、八项 legacy 测试和性能 A/B 基准仍未完成。Fusion 单次隔离 smoke 只能证明一次委派/复核链路成功，不代表性能提升。
