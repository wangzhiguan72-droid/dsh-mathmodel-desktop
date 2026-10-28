# 任务前能力组合（源码工作区）

## 2026-10-22 本任务扩展开关

2026-10-28 更新：首轮后关闭只由执行守卫拒绝调用、保留 schema，以免打断前缀缓存；首轮前仍移除 schema。见[工具开关与缓存](tool-switch-cache-2026-10-28.md)。

能力面板顶部新增 Skills、MCP、任务板工具开关及 Fusion 模型切换。它们与下方首轮前的四项基础组合分开保存：本任务及所属子任务均空闲时可调整，关闭项从正常任务的模型工具目录移除，并有执行守卫；不会卸载全局插件或修改共享 SKILL.md。子任务继承并同步父任务开关。运行中或等待交互时拒绝修改。

MCP 展示实际服务名、已发布工具数量和工具名称；当前本机 academic-search 发布 16 项。已发布工具不等同于每个上游数据源均可访问。Skills 的完整正文按需加载，但技能目录也占上下文；关闭不会删除已进入旧对话的内容，新任务关闭可以避免初始目录。Agent 自身注册的同名工具不受原生目录过滤影响，仍由执行守卫阻止，界面会提示。

Fusion 开启/关闭通过原生模型选择，不发送消息；关闭时使用用户选择的普通模型，原生行为会同时更新新任务默认模型。已加载 Fusion、Auto、Teams 插件不代表当前任务正在使用它们。原全局插件冻结与 Host 漂移验证保留，开关不重签已有快照。

本机已备份并同步工作区种子、安装目录种子、活动 profile 的必要文件。真实 Host 对照验证：84→50 个模型工具；关闭后无 skill、MCP 与任务板工具，另一个任务不变，重新开启恢复目录；投影持久化与原生模型选择通过。无模型对话请求，测试会话已归档。证据在 `dist/task-tool-switches/installed-verification.json`，回归日志在同目录；部署脚本 `scripts/deploy-task-tool-switches.mjs`，验收脚本 `scripts/verify-task-tool-switches.mjs`。

2026-10-15：空白任务输入栏中的「能力组合」按钮不要求开启官方开发者工具。四个复选项可自由组合；确认通过 Host 服务选择官方预设并持久化能力快照，不发送用户消息。当前工作区与 staged runtime 已包含代码；此前 `dist/release-0.1.4` 是第一项工作的交付快照，没有被覆盖，个人安装也没有改变。

第二项已完成源码、本地运行时、隔离验收及 6 次真实 DeepSeek 请求复验；第三项已完成首轮 10 次请求的缓存、成本、质量对照。详见[真实请求报告](deepseek-cache-cost-quality-2026-10-15.md)。

第三项后续已完成四类代码任务的 16 次随机交叉交付、51 次真实请求；基础 7/8、全开 8/8，失败与中断实验均保留。见[代码交叉实测](deepseek-code-cache-cost-quality-2026-10-16.md)，不据单次差异推断普遍收益。

| 可选项 | 实际影响 |
| --- | --- |
| 联网检索 | 挂载或移除官方 `tool-web`，控制 `web_search` / `web_fetch` |
| Skills | 挂载或移除 `skill-filesystem` 与 `tool-skill`，控制会话技能目录和 `skill` 工具；不删除技能文件 |
| 子代理与工作流 | 挂载或移除官方 delegation group，控制 `list_agents`、`workflow`、`subagent_fork` 等；不能因此声称启动了 Teams |
| 外部视觉与生图 | 按作用域隐藏 `vision_analyze` / `image_generate` / `editable_ppt_image`，并设置执行 guard；官方本地 `read_image` 保留 |

生成 `task-00` 至 `task-0f` 的 16 个固定身份预设。文件、终端、计划、压缩、询问与权限保持官方实现。旧的 standard、数学建模、生图及 PPT 预设保持原样。组合采用通用编程 Persona，并不限制任务领域。

第一轮已经开始（包括仍在运行的首轮）时，官方服务端返回 `agent-preset/locked`；前端也禁止应用。选择消息写入官方 Session projection，恢复时使用已选预设，不能只看最早的 header。开始首轮与点击确认发生竞争时，显示服务端拒绝，不偷偷修改任务。

仅有桌面种子标记的 profile 会在启动时补齐这些定义。迁移先验证候选 YAML，再备份、追加；不覆盖已有个人行。重复启动无修改；预设身份冲突、管理标记损坏、单独覆写管理预设时拒绝改写。保留 `!!js` 平台表达式，避免错误地同时打开 Bash 与 PowerShell。

## 验证与边界

- 桌面完整回归：169/169，覆盖构建、迁移、能力预设和外部事件持久化兼容；迁移、预设、staging 与兼容专项另跑 14/14。
- 插件含前端选择、首轮竞争、Host 快照、子代理继承和并存任务作用域回归：154/154。插件语法检查通过。
- 官方真实 Cordis / ToolRuntime 验证了作用域隔离、晚注册、同名 scoped shadow 的执行 guard，以及官方首轮锁定代码。
- 隔离临时 Host 激活全部 16 个组合，读取实际模型工具 schemas、重复读取的 SHA-256，并创建 16 个空白会话验证 Skills 可见性。收据位于 `dist/task-capabilities-receipt.json`；没有模型请求、API Key 或个人安装修改。
- 官方空白会话选择 RPC 已实测成功（`task-00` → `task-0f`）。隔离 Host 另验证冷重启恢复、持久首轮锁、插件管理拒绝、实际步骤钩子的配置漂移拒绝/恢复放行，以及不同组合任务并存。首轮边界由测试探针追加，不代表发送了真实模型请求。
- Edge 真实界面已点击四项选择并确认，组合更新而输入框未发送；再用探针记录首轮，面板显示「已按任务快照锁定」，全部复选框和确认只读。截图见 `task-capabilities-locked.png`。修复了皮肤透明背景导致的弹窗不可读问题。
- 最终界面收据 `dist/task-capabilities-ui-receipt.json` 保存已确认预设 `task-0b`、服务端 `locked=true / matches=true`、截图 SHA-256 和测试计数；Host 收据为 `dist/task-capabilities-receipt.json`。临时 Host 已关闭，样本与日志保留供复核。
- schema 重复读取一致只是本地静态证据；第三项另外使用提供方实际 usage 检验缓存与费用，不能用哈希相同代替命中率。

## Host 状态与任务冻结

Fusion、Teams、Auto、MCP、任务板通过现有插件管理配置，能力面板展示未安装、未启用、加载中、加载失败和插件已加载。MCP 显示外部连接尚未验证；任务板显示实际发布工具数量。模块加载不代表外部服务已连接或某项业务功能可执行。

确认时记录所选预设、配置摘要、全局工具 schemas 摘要和扩展清单到 Session projection。摘要包含托管任务预设、相关插件的解析后配置、profile 依赖及 Fusion 的模型配置/授权策略，不保存原始配置和凭据。预览后工具或配置变化会拒绝确认，要求刷新。

插件管理变更与确认共享串行门禁；正式变更在官方文件锁内再检查首轮边界。任一已加载任务开始后，即使空闲，也拒绝插件安装、移除、启停等变更。需要调整全局扩展时，先结束并卸载受影响任务，再配置新的空白任务。

受管组合在每个步骤、模型请求发出前、工具执行前检查确认快照。外部编辑或重启后配置不匹配会暂停，恢复原配置后可重试。独立会话不能借用快照；只有内核确认归属且预设一致的原生子代理可继承父任务快照。Fusion 动态子任务工具不计入根全局目录，保留正常委派行为。

任务作用域内的配置不计入全局指纹，创建另一种组合不会让旧任务失效。Host 首次打开图像设置时可能迁移旧连接配置；若快照早于该迁移，配置变化会按设计暂停该任务。正常界面应在设置初始化后确认；已有任务不会被静默重签快照。

冷恢复验收发现固定版本 `Session.append` 没有转发外部事件的 `ignorable` 标记。构建脚本现在对 staged Host 做有源码形状检查的幂等补丁，只转发显式 `true`；未标记未知事件仍被官方存储校验拒绝。快照事件使用该官方兼容机制，受管预设在 Host 守卫缺失时拒绝步骤。此前失败的隔离样本不用于验收。

这项检查约束 Host 中可观察的能力配置，不冻结外部服务自身，也不是网络或操作系统安全沙箱。文件、终端和付费调用仍使用原有权限系统。「任务 · 基础」仍可能继承已确认的全局扩展工具。第三项小样本已观察到实际缓存；通用任务的费用和质量收益仍待更广泛验证。

源码入口：`scripts/task-capabilities.mjs`、插件的 `src/capabilities.js`、`src/host-capabilities.js`、`src/host-freeze-policy.js`、`src/client-bundle.cjs`；启动接线 `src/main.cjs`；打包接线 `electron-builder.yml` 与插件构建脚本。未加入新 npm 依赖。

复现：

```powershell
node scripts/build-runtime.mjs --local-only
node --test tests/task-capabilities.test.mjs tests/specialized-presets.test.mjs tests/local-plugin-staging.test.mjs
node --test tests/session-external-events.test.mjs
node scripts/verify-task-capabilities.mjs
cd plugins/dsh-mathmodel
npm test
```

隔离 Host 检查会保留自己的临时 profile、收据和日志，便于检查。它在完成或失败时只终止自己创建的 Host 进程。
