# 0.1.9：dsh-context、Agent Teams 与 Fusion 0.2.8（内核 0.2.1-rc.4）

0.1.8 只升级内核（见 `kernel-rc4-weball-0411.md`），按原样构建、验收。本文三项插件放进 0.1.9。

## 状态

- 已改：`tests/fusion-latest-transport.test.mjs`（适配上游 0.2.8 的代码结构，见下）；`plugins/dsh-model-fusion`（0.2.8）与重封的 `scripts/fusion-prebuilt-lock.json`；`scripts/verify-windows-artifacts.mjs` 的 Fusion 版本断言改为 0.2.8；新增 `plugins/dsh-agent-teams`（rc.4 适配产物解包）；`runtime/profile-web/package.json` 与 `pnpm-lock.yaml`（加入两个插件，只新增条目）。
- 测试：桌面 288/289（1 项原有跳过），`plugins/dsh-mathmodel` 172/172。
- 未改：`package.json` 版本号；运行时尚未重建。
- 准备好的材料都在仓库外 `D:\deepseek harness\_upstream-20261028\`。

## dsh-context 0.78.0

上游 npm 最新版（10-28 从 0.77.0 升上来，只是 Token 卡片新增工具调用/推理/回答分类；依赖要求不变，锁文件只改了 dsh-context 几行），`engines.dsh` 为 `>=0.2.0-rc.2 || >=0.2.1-rc.2`，只拒绝低于 0.2.0-rc.2 的内核，rc.4 不需要改。用户原 profile 里是 0.73.3，插件管理器日志显示 `pnpm add dsh-context` 失败过（`ERR_PNPM_VIRTUAL_STORE_DIR_MAX_LENGTH_DIFF`），所以改为直接放进 `runtime/profile-web` 种子。

## Agent Teams 0.1.27（本地适配 rc.4）

上游 0.1.27 按精确版本声明支持的宿主，最高 rc.3，rc.4 宿主会在安装前拒绝它。

- 审计：Agent Teams 导入的 26 个官方包，rc.3→rc.4 只有 `dsh-client-ui-conversation` 有变化（View 标签提示文案、删除 `session.moreViewsCurrent` 文案），Agent Teams 不用这两处。不需要改代码。
- 改动（`_upstream-20261028/dsh-agent-teams`，分支 `compat/rc4`）：`compatibility.json` 加 rc.4（preview）；用上游 `scripts/compatibility.mjs --write-peers` 重新生成 21 个 peer 声明；`compatibility.test.mjs`、`harness-validation.test.mjs` 各加 rc.4。版本号保持 0.1.27，以免上游 README/发布检查失败。
- 验证：typecheck、build、兼容性测试 23/23。上游真实宿主运行器 `harness-runtime-verify.mjs --host-version 0.2.1-rc.4`：11 项全部通过，包括通过 rc.4 插件管理器真实安装。产物 SHA-256 `bd7e04836af6b132e4d91f6b806cbbfb2d08a35560de9c6e91ee3e2094c912eb`。
- 首次运行有两项失败，在 rc.2 上同样失败，与 rc.4 无关：本机全局 pnpm 是 9.15.9（上游用 10.33.0），插件管理器报 `ERR_PNPM_ADDING_TO_ROOT`；测试读到了本机 `~/.claude/skills` 等用户技能，提示词断言不匹配。换 pnpm 10.33.0、使用空用户目录后通过。

## Fusion 0.2.8（GitHub main）

npm 上的 0.2.8 peer 仍是 `<0.2.1`，不能用。GitHub main（`28125d8`，2026-10-26）版本号同为 0.2.8，`engines.dsh` 为 `>=0.2.0-rc.1 <0.2.1-0 || >=0.2.1-rc.2 <0.3.0-0`，已包含 0.2.1 子代理接口迁移（`startActivation`/`drainChildren`，按函数是否存在选择），本地 0.2.6 补丁可以去掉。

- 保留桌面修复：上游客户端仍缺 `sessions`、`remote`、`remote.session` 注入（`fusion-auto-ui-repair-2026-10-17.md`）。`_upstream-20261028/swap-fusion.mjs` 在复制后把这两行补回 `lib/client.js` 与 `src/client/index.ts`。
- 测试调整：`fusion-latest-transport.test.mjs` 前两项行为测试不变，只多载入 `subagent-seam.ts` 区段（上游传输类调用其中的 `requireSubagentMethod`）。第三项仍检查同一个保证（Worker 工具上限为配置的 `workerTools`），改为检查上游的实现路径：0.2.1 下 implement 模式的 `readOnlyTools` 返回 `workerTools`，Worker scope 用 `restrict({ allow })` 生效。这些测试针对 0.2.8，换包前对 0.2.6 会失败。
- 换包后需重封 `scripts/fusion-prebuilt-lock.json`。lib 仍是上游预构建产物，不是本机从 src 编译。
- 备份：当前本地 0.2.6 在 `_upstream-20261028/backup-plugins-dsh-model-fusion-0.2.6-local/`，锁文件副本在同目录 `.lock.json`。

## 已知问题（沿用 0.1.8）

dsh-liangshen 保持 dsh-web-all 0.4.11 自带版本，不在本地移植 dsh-web `16d0e1ac8`。0.4.11 的 `paging.mjs` 中 `replayActivations` 只读 `tool/call`，默认 ptc 展示下 `tool_activate` 激活不了 `mcp__*` 命名空间。只影响配置了 MCP 服务器的梁神预设。修复随上游 dsh-web 0.4.12 单独升级。见 `dist/release-0.1.8/BASELINE.md`。

## 剩余步骤

1. 运行 `swap-fusion.mjs`，重封 Fusion 锁。
2. 把 dsh-context 0.78.0 与 Agent Teams 产物加入 `runtime/profile-web`（依赖与 `dsh.profile.bundles`）。
3. ✅ 版本号改为 0.1.9（`package.json`、`package-lock.json`，以及 `bootstrap-installed-desktop.mjs`、`verify-windows-artifacts.mjs` 的版本白名单），重建运行时。必须跑完整的 `build-runtime.mjs`：`--local-only` 只复制清单，不会安装 dsh-context 和 Agent Teams。
4. ✅ 桌面测试 288/289 通过（1 个跳过，0 失败）。用隔离的 DSH_HOME 做无头启动：247 个插件中 216 个 active，31 个未启用，已启用但未 active 的为 0；dsh-model-fusion、dsh-context、@nanmicoder/dsh-agent-teams 均为 active。日志见 `_upstream-20261028/boot-0.1.9-host.log`。
5. ✅ `publish-desktop-release.mjs` 的 `CURRENT_VERSION` 与 `tests/release-publication.test.mjs` 改为 0.1.9（0.1.8 保留为历史发布计划）；dsh-context 升到 0.78.0 后重建运行时，桌面测试 289/290 通过（1 个跳过，0 失败）。`dist:win` 产出 `dsh-mathmodel-desktop-0.1.9-win-x64.exe` 与 `.zip`，包内 dsh-context 为 0.78.0；`verify:win` 通过，first/restart/relocated 三轮均为 0 个降级插件。
