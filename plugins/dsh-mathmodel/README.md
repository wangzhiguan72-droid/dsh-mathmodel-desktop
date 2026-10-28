# DeepSeek Harness Mathmodel 插件

这是 DeepSeek Harness 的外置数学建模插件，当前包含 `0.1.5-rc.3` 启动适配与自动化契约检查。它在不改官方安装包的前提下，增加手动 Skill 卡片、右上角可收缩技能说明、依赖预检、视觉理解和受控生图工具。

卡片点击“确定”只把结构化 Prompt 写入输入框，不会发送消息。用户可以继续编辑，并自行决定何时发送。

桌面工作区另提供任务前能力组合：联网、Skills、子代理/工作流、外部视觉/生图共 16 种组合；确认 Host 扩展状态后保存任务快照，首轮后禁止插件管理变更，并在恢复、请求及工具执行前检测配置差异。MCP 的插件加载与外部连接状态分别说明。实现与验收范围见 [任务能力记录](../../docs/task-capabilities.md)；此前冻结的安装包不随源码修改更新。

## 目录

- `src/`：Host、Client、卡片注册、凭据、预检、视觉与生图实现。
- `test/`：可复现的版本、卡片、交互、Remote、安全和工具测试；`test/environment/` 保存需显式运行的真实环境与历史契约检查。
- `scripts/build.mjs`：把源码和类型声明复制到 `lib/`。
- `scripts/run-paper-e2e.py`：调用真实 Draw.io 与 XeLaTeX 的论文链路验收。
- `$DSH_HOME/skills/*/mathmodel-card.yml`：真实卡片清单；桌面版默认 home 是 `~/.dsh-mathmodel`，UI 动态扫描。
- `$DSH_HOME/profiles/mathmodel/cordis.patch.yml`：桌面版 Profile 接线，可通过 `DSH_PROFILE` 覆盖名称。
- `$DSH_HOME/.agent-presets/`：用户维护的自定义预设；mathmodel、imagegen、editable-ppt 三个历史预设不随本插件分发。

## 安装与验证

在 PowerShell 中运行默认测试，无需个人技能库、预设或已安装的 dsh：

```powershell
Set-Location <项目根目录>\plugins\dsh-mathmodel
npm ci
npm test
npm run check
```

环境检查按范围显式运行：

| 命令 | 范围与前提 |
| --- | --- |
| `npm run test:harness` | 暂存的官方 rc.3 API 与当前桌面 Profile 接线 |
| `npm run test:skills` | 真实技能库、卡片内容与当前视觉安全契约 |
| `npm run test:environment` | 上述两组 + 本机 Python、TeX、Draw.io、Poppler 预检 |
| `npm run test:legacy` | 原样保留的个人预设、订阅 0.6.0 补丁、旧视觉契约；缺少真实材料或契约已变时明确失败 |
| `npm run test:e2e:editable-ppt` | 技能目录中的 editppt CLI 源码 + Python/Pillow + 假供应商模拟 PPT 链路；可用 `EDITPPT_EXE` 指定已安装 CLI，缺少依赖时失败 |

`test:environment` 验证当前部署环境，不包含 `test:legacy` 或 PPT E2E，不能代替这些检查。路径默认与桌面壳一致：`DSH_HOME` 默认为 `~/.dsh-mathmodel`，`DSH_PROFILE` 默认为 `mathmodel`。可分别用 `DSH_SKILL_ROOT`、`DSH_TEST_PROFILE_ROOT` 指定集成材料；`DSH_TEST_RUNTIME_ROOT` 指向待检查的 host `node_modules`，显式路径无效时不会回退到另一份内核。`DSH_AGENT_PRESETS_ROOT` 可指定官方预设包根目录。

桌面开发环境从项目根运行 `npm start`，使用已暂存的 `resources/runtime/`。无需在仓库根建立 `.dsh/`。在真实会话输入 `/math-paper-cn` 应出现卡片；确认后输入框保留草稿，不自动发送。

论文真实链路单独运行：

```powershell
Set-Location <项目根目录>\plugins\dsh-mathmodel
npm run e2e:paper
```

证据写入 `Overall-goal/goal-1/evidence/task-021/`，不会调用付费生图服务。

## 日常升级

1. 先备份插件目录和实际桌面 Profile 的 `package.json`、`cordis.patch.yml`；从项目根调试内置宿主时将 `DSH_HOME` 设为实际桌面 home（默认 `~/.dsh-mathmodel`）。
2. 更新插件源码；若 DSH 版本变化，先修改并验证 `src/version.js`，不要直接放宽版本门。
3. 运行 `npm ci && npm test`，确认测试全绿后再构建 Profile。
4. 在 Web Profile 中运行 `pnpm install --offline` 和 `pnpm peers check`。
5. 运行 `node resources/runtime/host/node_modules/@deepseek-ai/dsh/lib/bin.js --profile mathmodel --dump-config`，确认官方 `ui-skill` 已禁用且 `dsh-mathmodel` 只出现一次。
6. 重启 Web 服务，并复测卡片、零发送草稿、普通 Skill 和技能说明面板。

构建用 `runtime/profile-web` 通过本地 `file:` 依赖接入插件。只修改源码但不执行 `npm run build` 时，正在运行的 Web 服务仍可能加载旧的 `lib/client.js`。

## 快速回滚

回滚不需要删除插件。在 `$DSH_HOME/profiles/mathmodel/cordis.patch.yml` 中恢复官方 Skill UI，并禁用外置插件：

```yaml
- id: ui-skill
  name: '@deepseek-ai/dsh-client-ui-skill'
  disabled: false

- insert:
    - id: mathmodel
      name: '@deepseek-harness/dsh-mathmodel'
      disabled: true
```

随后重启桌面宿主。确认恢复后，再决定是否把 Profile 文件还原到升级前备份。不要删除 `$DSH_HOME/skills`，其中可能包含用户维护的 Skill。

## 新增卡片 Skill

1. 在 `$DSH_HOME/skills/<skill-name>/SKILL.md` 中设置：

```yaml
disable-model-invocation: true
user-invocable: true
```

2. 在同一目录新增 `mathmodel-card.yml`，目录名与 `skill` 必须一致：

```yaml
schema: dsh.mathmodel.card/v1
skill: example-skill
title: 示例卡片
summary: 用一句话解释这个 Skill 能做什么。
category: 论文工具
fields:
  - id: source_path
    label: 材料路径
    type: path
    required: true
help:
  purpose: 说明用途
  inputs: [材料路径]
  outputs: [可编辑草稿]
  limits: [不自动发送]
  dependencies: [无]
prompt: |
  /example-skill
  材料路径：{{source_path}}
```

3. 运行 `npm test`。严格 schema 会拒绝未知字段、错误类型、目录不一致和缺失必填值。
4. 重启 Web 服务或新建会话，输入 `/example-skill` 验证卡片。新增合规 sidecar 不需要修改 Client UI。

## 新增生图供应商

供应商不是只改一张卡片即可完成。至少同步修改并测试：

- `src/security/credentials.js`：凭据引用 allowlist，只返回“是否配置”，不得返回值。
- `src/security/provider-settings.js` 与 `src/host.js`：普通设置 schema、默认顺序和 HTTPS 地址限制。
- `src/image/adapters.js`：请求、异步轮询和结果归一化。
- `src/image/service.js`：数量、预算、付费确认、下载落盘和元数据脱敏。
- `src/tool-contracts.js`：若工具入参发生变化，同步严格契约。
- `test/`：增加 mock 成功、失败、取消、临时 URL 下载、秘密脱敏和路径边界测试。

任何供应商都必须同时满足健康检查、任务数量上限和用户明确付费确认；否则回退到提示词，不进行 live 调用。

### Codex/Grok 订阅生图

两类订阅生图只通过 Host service `subscriptionSessions` 获取会话快照。OAuth 登录、刷新和凭据落盘统一由提供 `subscriptionSessions` 的订阅插件管理；具体版本和配套补丁需由安装环境验证，历史 0.6.0 断言保留在 `test:legacy`；本插件不直接读取或改写订阅凭据文件，也不会接收 `refreshToken`。401 时最多请求一次强制刷新并重试一次。Profile 必须保持 `registerImageTool: false`，由本插件独占全局 `image_generate`；订阅插件的 `x_search` 与 `video_generate` 保持启用。

### 图片转可编辑 PPT 专用生图（`editable_ppt_image`）

图片转可编辑 PPT 的图像链路专用工具（可由用户自建 `editable-ppt` 预设调用），实现集中在 `src/image/capabilities.js`（三层 Codex 识别 + 协议能力矩阵）、`src/image/connections.js`（`describeActiveForTool` / `resolveForEditablePpt`）与 `src/image/service.js`（`editablePptImage` 严格入口）：

- `action:"status"`：只读“设置 → 模型 → 生图模型”的当前连接，要求存在、凭据已配置且验证 `ready`，返回连接 ID/名称/模板/模型/协议与能力矩阵；这是任务开始时的唯一锁定动作，零付费、零网络。
- `action:"generate"/"edit"`：必须显式携带锁定的 `connectionId`；固定单张输出、确定性 `outputPath`（已存在即失败，不自动改名）、工作区路径边界与 25 MB/MIME 防御；`edit` 携带 1–4 张参考图与可选 mask；成功时同目录写 `<name>.dsh-image.json` 非敏感元数据（哈希、协议、模型、时间，绝不含 Prompt 正文/Base URL/Key/Token）。
- Codex 防线：`codex-subscription` 模板、`codex-images` 验证协议或 ChatGPT Codex 直连端点任一命中，即在任何凭据解析与付费调用前返回 `codex_backend_forbidden`；`grok-images` 等不支持编辑的协议对 edit/mask/quality 返回 `capability_unsupported`，不静默忽略。
- 失败策略：仅对网络/5xx 做最多 2 次指数退避重试；401/403、400/404、429 直接失败；一切失败不切换连接、不提供 `ai-draw-skills` 提示词回退、不降低质量门禁；所有错误信息先经 `redactText` 并同时屏蔽凭据值与 Base URL。
- 凭据边界：真实 Key 只在 Host 进程内解析并随请求发送；工具输出、状态描述、元数据与登记链路（`editppt image import --metadata-file`）均零秘密。通用 `image_generate` 的行为、schema 与回退提示保持原样，不受影响。

配套契约测试：`test/editable-ppt-image.test.mjs`（单元/安全）、`test/environment/skills/editable-ppt-contract.test.mjs`（Worker/Skill 静态契约）、`test/environment/legacy/editable-ppt-contract.test.mjs`（历史 Persona）、`test/environment/e2e/editable-ppt-e2e-sim.test.mjs`（fake 供应商模拟 E2E，含双页并发与零秘密扫描）。`editppt` CLI 侧的 `dsh-current` 契约、运行级阻断与 metadata 校验测试位于 `$DSH_HOME/skills/image-to-editable-ppt/cli/tests/`。

## 百炼视觉配置

在 `/claude-vision-skill` 卡片中按引导把百炼 Key 写入 DSH 受管凭据。Key 不要粘贴进聊天或补充要求。固定模型为：

- 主模型：`qwen3.7-plus`
- 回退模型：`qwen3.7-flash-2026-07-15`

旧 Skill 目录中的 `.env` 保留原位，但本插件和改造后的 `vision.js` 不读取它。

四种生图 Key 可在 `/ai-draw-skills` 卡片中通过受管凭据控件分别设置或清除；供应商顺序、模型名和自定义 Base URL 由 DSH 设置页的 `mathmodel-providers` 命名空间管理。自定义地址必须是有效 HTTPS URL（仅本机测试允许 HTTP），配置地址时必须同时填写自定义模型名。

## 常见故障

### 页面显示 Failed to load plugins

先运行：

```powershell
Set-Location <项目根目录>\plugins\dsh-mathmodel
npm run build
npm test
```

然后完整重启桌面宿主，不要只刷新浏览器。若错误包含 `remote.mathmodelCredentials without inject`，说明仍加载了旧 Client 构建物。

### `/` 菜单只有命令，没有 Skill

检查浏览器控制台与服务 stderr；再运行 `node resources/runtime/host/node_modules/@deepseek-ai/dsh/lib/bin.js --profile mathmodel --dump-config`，确认外置插件已加载且官方 `ui-skill` 没有同时注册。卡片清单还必须满足手动 frontmatter 和严格 sidecar schema。

### 点击确定后没有草稿

必填字段为空会失败关闭；草稿在打开卡片后被用户或其他组件改动时，CAS 保护会拒绝覆盖。重新输入 `/skill-name` 打开卡片即可。

### 依赖状态不是“本机依赖已就绪”

预检只读取环境，不会替用户改系统。分别验证 `python`、科学计算包、`xelatex`、`latexmk`、Draw.io 和 Poppler；修复环境后重启服务。

### 生图没有执行

这是安全默认值。检查凭据状态、供应商健康、单次数量、论文任务总上限和“允许付费调用”是否同时满足。不要通过代码绕过门禁。

## 发布前检查清单

- `npm test` 全部通过。
- `npm run test:environment` 在目标机器通过；它不包含历史契约或 PPT E2E。普通单元测试不依赖完整论文工具链。
- 使用历史自定义预设/订阅补丁的发行环境还需单独跑 `npm run test:legacy`，缺失材料不能视为验证通过。
- PPT 集成环境单独跑 `npm run test:e2e:editable-ppt`。
- `npm run e2e:paper` 生成真实 Draw.io 与中文 PDF。
- `pnpm peers check` 无问题。
- `node resources/runtime/host/node_modules/@deepseek-ai/dsh/lib/bin.js --profile mathmodel --dump-config` 成功。
- 真实浏览器控制台错误为 0，服务 stderr 为空。
- 卡片确认不调用发送接口；普通 Skill 仍为字面草稿。
- 源码、Prompt、日志和元数据不含 Key。
- 没有修改官方 `node_modules` 或官方 Preset。

## 兼容性

版本门接受 `0.1.1-rc.2`、`0.1.2-rc.1`、`0.1.5-rc.1`、`0.1.5-rc.2`、`0.1.5-rc.3`，要求 Node.js 22 及以上。保持失败关闭策略，不接受未列入白名单的版本。后续内核升级须先完成 Remote、Slot、Input Trigger、Conversation、Preset 回归，再更新白名单和 peerDependencies。

客户端入口测试执行插件真实 bundle，服务/DOM 边界使用可观测夹具；官方预设发现、读取、选中投影另由实际 rc.3 包验证。这些检查不能单独证明完整浏览器兼容性。实际运行证据与剩余限制见 [测试与适配记录](../../docs/test-fixtures-rc3.md)。
