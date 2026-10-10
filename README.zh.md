# dsh-mathmodel-desktop — DeepSeek 数学建模版桌面端

基于官方 `dsh-desktop` Electron 壳的**通用编程 Harness 桌面发行版**；“数学建模版”是发行代号，并非用途限制。当前 0.1.3 源码内置官方 DeepSeek Harness（`@deepseek-ai/dsh` `0.2.0-rc.2`）、Web 插件家族 `0.4.5`、独立 Node.js 运行时与 **dsh-mathmodel 扩展**，不需要预装 Node、npm 或 dsh CLI。0.2.0-rc.2 是官方发布候选版本；历史已发布的桌面 0.1.2 内核仍为 0.1.5-rc.3。

## 数学建模能力（dsh-mathmodel 0.1.1）

精华插件 `@deepseek-harness/dsh-mathmodel`（随本发行版内置于 `plugins/dsh-mathmodel`，以 `file:` 依赖装入 profile）：

- 手动 Skill 卡片（扫描 `~/.dsh-mathmodel/skills/*/mathmodel-card.yml`，动态清单，点击"确定"只写草稿不发送）
- 依赖预检（Python 科学计算包、XeLaTeX、latexmk、Draw.io、Poppler）
- 视觉理解与受控生图（凭据 allowlist、付费确认、预算与数量上限、错误信息脱敏）
- 图片转可编辑 PPT 专用生图链路（`editable_ppt_image`，Codex 后端防线）
- 版本门失败关闭：`src/version.js` 白名单保留旧版，并加入 `0.2.0-rc.2`。

配套数学建模 skills（`~/.dsh-mathmodel/skills/`，可通过链接共享实际技能库）：math-paper-cn、国赛摘要、单问深研求解、HTML 论文图、image-to-editable-ppt、ultramath 模型库等。

## 功能

- 双击启动：当 `~/.dsh-mathmodel/profiles/mathmodel` 缺失时用内置 profile 种子初始化，用内置 Node 运行时在专用回环端口段 3082-3181 启动自己的 dsh 宿主，等 GUI 就绪后加载宿主打印的带 token URL（认证门每次进程启动签发一次性 token；会话 cookie 保存在应用窗口内）。
- 独立宿主、端口有保证：应用始终运行自己的内置宿主——不会附着到已有 GUI，也绝不占用原生 `dsh web` CLI 默认端口 3080/3081。优先使用专用端口段 3082-3181（跨启动地址稳定），段满时回退到系统分配端口。桌面实例与你自己的 `dsh web` 并存运行，各自持有独立的 GUI 会话。
- 桌面版默认独占 `~/.dsh-mathmodel`，可用 `DSH_HOME` 覆盖：由本应用播种的 profile 带 `.dsh-desktop-seed.json` 标记，内置运行时版本变化时会被重新播种；没有该标记的 profile 视为用户自管，永不触碰。用户的 `cordis.patch.yml` 层在重新播种后保留。
- 单实例：第二次启动只会聚焦已有窗口。关闭窗口即退出应用，并优雅停止由它启动的宿主。
- 应用内插件管理开箱可用：`dsh plugin add/remove` 转发给安装在内置 Node 运行时里的 pnpm。

## 仓库布局

| 路径 | 内容 |
| --- | --- |
| `src/` | Electron 主进程（`main.cjs`）、可测试纯函数（`runtime.cjs`）、preload、启动页与错误页 |
| `plugins/dsh-mathmodel/` | 精华数学建模插件源码（Host、Client、卡片注册、凭据、预检、视觉与生图） |
| `runtime/host/` | 锁定 `@deepseek-ai/dsh@0.2.0-rc.2` 的宿主运行时载荷 |
| `runtime/profile-web/` | web profile 种子：`dsh-base` + `dsh-web-app` + `dsh-web-all` + `dsh-mathmodel`（`cordis.patch.yml` 接线：ui-skill 禁用，mathmodel/mathmodel-tools 插入） |
| `scripts/` | Node/pnpm 下载校验（sha256）、运行时构建暂存、afterPack 载荷拷贝 |

## 构建

```sh
npm install              # electron + electron-builder
npm run prepare-runtime  # 下载 Node 发行版 + pnpm + 安装并暂存宿主/profile 载荷
npm run dist:win         # dist/*.exe（nsis）+ *.zip
```

`npm start` 基于已暂存的 `resources/runtime/` 以未打包形态运行，供开发调试。

运行时暂存完成后再打包。分发 Profile 的 patch 使用受版本控制的 `build/profile.cordis.patch.yml`，hooks 和技能目录按所选 `DSH_HOME` 解析。本次构建的卸载器保留个人 Harness 数据及外部技能目录。已有安装的覆盖升级需单独验证，因为会调用原版本的卸载器。

暂存不分发根 `.pnpm` store，实际依赖和嵌套目录仍完整复制。Windows 隧道二进制可复用 `runtime/cache/cloudflared-windows-amd64.exe`，删除该缓存后重建会重新从官方源下载。

Windows 解包产物可用 `npm run verify:win` 验证，也可用 `npm run verify:win -- dist/rc3-final-verified/win-unpacked` 指定构建目录。该命令在临时 home 中启动实际 EXE，检查完整 Profile、首次播种、重启、搬动应用后的重新播种及用户 patch 保留；技能使用脚本生成的夹具，子进程环境仅含必要系统变量及临时目录。临时验证材料保留供排查，退出时清除浏览器认证 URL。

真实 NSIS 生命周期由 `scripts/build-windows-install-fixture.mjs` 与 `scripts/verify-windows-install.mjs` 验证：构建同一源码与安装钩子的独立测试名称、GUID 和快捷方式，先核验编译身份与文件哈希，再静默安装到中文含空格目录、运行已安装 EXE 的三阶段检查并卸载。具体命令和结果见 [Git Graph 与 NSIS 专项验证](docs/windows-git-graph-nsis-followup.md)。

自动验证设置 `DSH_DESKTOP_USER_DATA` 隔离 Electron 数据、日志和崩溃记录，设置 `DSH_DESKTOP_HEADLESS=1` 隐藏窗口。普通启动无需这些变量。

## 日常升级

Windows 桌面版 0.1.2 起将 Harness 原有的左下角更新按钮接入桌面更新流程。发现新桌面版本时按钮突出显示，点击查看说明；确认后自动下载，校验完成后另行确认安装和重启。桌面端的这个按钮不再执行 pnpm 更新。更新源在“桌面更新 → 更新设置”中配置，也可关闭启动时检查。

0.1.3 的内核升级改变会话格式 V3→V4，因此默认清单对旧客户端先提供 0.1.3-bridge.1，再由升级准备版提供 0.1.3。程序自动完成两个步骤的下载、校验和安装，每步仍由你确认，无需手动解压或寻找官方包。格式升级前备份 home 和 Electron userData，启动失败恢复旧程序和旧数据；手动回滚先保留新版数据副本。发布与本机验证状态见[更新证据](docs/desktop-updates-verification.md)。以后新的官方内核仍需维护者适配、构建并发布新版桌面包，才会进入这个更新入口。

新版本通过 HTTPS 下载并验证 SHA-256、文件大小、应用身份及版本。退出旧进程后切换完整应用目录；新版宿主、插件和 GUI 验证失败时自动恢复此前版本。菜单“恢复上一个版本”使用经校验的完整旧程序，跨会话格式时同步恢复匹配的数据快照。

旧 0.1.0 没有接入应用内更新。此前首次迁移使用当时的 `scripts/bootstrap-installed-desktop.mjs` 自动完成：核验 0.1.1 ZIP 和 NSIS 成品，备份个人数据，在原安装路径切换完整应用目录，保持桌面快捷方式目标不变；不运行可能删除个人数据的旧卸载器。隔离夹具的失败恢复和成功启动均已通过，本机原有个人安装已迁移至 0.1.1 并通过 GUI 健康检查，旧程序及个人数据备份保留。这是首次迁移的历史记录；当前引导脚本只接受旧 0.1.0 安装，目标已改为经验证的 0.1.2 成品。本机个人安装随后已通过完整目录切换升级至 0.1.2，启动健康检查和更新助手退出后的 GUI 存活均通过。[v0.1.2 发行版](https://github.com/wangzhiguan72-droid/dsh-mathmodel-desktop/releases/tag/v0.1.2)已公开发布并取代未发布的 0.1.1 候选包；用户无需手动解压 ZIP。

```sh
node scripts/update-kernel.mjs --check   # 只读取本地锁定的版本
```

维护者修改内核版本后，需回归插件版本门、重新构建和验证完整安装包，再发布这个桌面发行版。旧维护脚本的无参、`--auto`、`--plugins`、`--rollback` 已拒绝执行，避免未经验证地改写内核或个人配置。

已发布的 v0.1.2 对应源码提交 `7c1a31e89d1582b73bb8fa20f67e595c23b833d2`。维护者可运行 `node scripts/publish-desktop-release.mjs --plan`，在本地校验 ZIP、NSIS、更新清单、校验表和发布说明；此模式不读取凭据，也不写入 GitHub。详见[发布验证](docs/desktop-updates-verification.md#发布边界)。

更新与回滚的实现和实测范围见 [桌面更新验证](docs/desktop-updates-verification.md)。

## 安全模型

- dsh 宿主只绑定回环地址（`127.0.0.1`）；窗口无 Node 集成，preload 运行在沙箱中；导航限制在回环地址，外部链接交给系统浏览器。
- 内置 Node 发行版在构建时按官方 SHASUMS256.txt 校验；内置 pnpm 的 tarball 按 npm registry 完整性元数据校验。
- 插件凭据只在 Host 进程内解析；工具输出、元数据与登记链路零秘密。

## 已知限制

- 未签名构建：Windows 有 SmartScreen 提示（更多信息 → 仍要运行）。
- 数学建模论文工具链（Python 科学计算、XeLaTeX、Draw.io、Poppler）不在安装包内，由插件的依赖预检在本机检测。
- 远程隧道（`dsh-remote-web-ui`）开箱可用 Windows x64 的 cloudflared 二进制。

测试分层、环境路径与 rc.3 回归证据见 [测试与适配记录](docs/test-fixtures-rc3.md)。自定义 mathmodel/imagegen/editable-ppt 预设由用户维护，不随插件分发。

完整 Profile 与 Windows 包的验证命令和结果见 [Windows 分发验证](docs/windows-rc3-verification.md)。
