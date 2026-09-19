# dsh-mathmodel-desktop — DeepSeek 数学建模版桌面端

基于官方 `dsh-desktop` Electron 壳的**数学建模专属桌面发行版**：把最新版 DeepSeek Harness（`@deepseek-ai/dsh` `0.1.5-rc.1`）Web GUI 变成可安装的 Windows 桌面应用，内置独立 Node.js 运行时、dsh 宿主和预装好的数学建模 profile（官方 web bundle + dsh-web 插件全家桶 + **dsh-mathmodel 数学建模插件**），开箱即用——不需要预装 Node、npm 或 dsh CLI。

## 数学建模能力（dsh-mathmodel 0.1.1）

精华插件 `@deepseek-harness/dsh-mathmodel`（随本发行版内置于 `plugins/dsh-mathmodel`，以 `file:` 依赖装入 profile）：

- `mathmodel` 模式 + 手动 Skill 卡片（扫描 `~/.dsh/skills/*/mathmodel-card.yml`，动态清单，点击"确定"只写草稿不发送）
- 依赖预检（Python 科学计算包、XeLaTeX、latexmk、Draw.io、Poppler）
- 视觉理解与受控生图（凭据 allowlist、付费确认、预算与数量上限、错误信息脱敏）
- 图片转可编辑 PPT 专用生图链路（`editable_ppt_image`，Codex 后端防线）
- 版本门失败关闭：`src/version.js` 白名单 `0.1.1-rc.2 / 0.1.2-rc.1 / 0.1.5-rc.1`

配套数学建模 skills（`~/.dsh/skills/`，与 dsh CLI 共享）：math-paper-cn、国赛摘要、单问深研求解、HTML 论文图、image-to-editable-ppt、ultramath 模型库等。

## 功能

- 双击启动：当 `~/.dsh/profiles/web` 缺失时用内置 profile 种子初始化，用内置 Node 运行时在专用回环端口段 3082-3181 启动自己的 dsh 宿主，等 GUI 就绪后加载宿主打印的带 token URL（认证门每次进程启动签发一次性 token；会话 cookie 保存在应用窗口内）。
- 独立宿主、端口有保证：应用始终运行自己的内置宿主——不会附着到已有 GUI，也绝不占用原生 `dsh web` CLI 默认端口 3080/3081。优先使用专用端口段 3082-3181（跨启动地址稳定），段满时回退到系统分配端口。桌面实例与你自己的 `dsh web` 并存运行，各自持有独立的 GUI 会话。
- 与已有 dsh 安装共享 `~/.dsh`：由本应用播种的 profile 带 `.dsh-desktop-seed.json` 标记，内置运行时版本变化时会被重新播种；没有该标记的 profile 视为用户自管，永不触碰。用户的 `cordis.patch.yml` 层在重新播种后保留。
- 单实例：第二次启动只会聚焦已有窗口。关闭窗口即退出应用，并优雅停止由它启动的宿主。
- 应用内插件管理开箱可用：`dsh plugin add/remove` 转发给安装在内置 Node 运行时里的 pnpm。

## 仓库布局

| 路径 | 内容 |
| --- | --- |
| `src/` | Electron 主进程（`main.cjs`）、可测试纯函数（`runtime.cjs`）、preload、启动页与错误页 |
| `plugins/dsh-mathmodel/` | 精华数学建模插件源码（Host、Client、卡片注册、凭据、预检、视觉与生图） |
| `runtime/host/` | 锁定 `@deepseek-ai/dsh@0.1.5-rc.1` 的宿主运行时载荷 |
| `runtime/profile-web/` | web profile 种子：`dsh-base` + `dsh-web-app` + `dsh-web-all` + `dsh-mathmodel`（`cordis.patch.yml` 接线：ui-skill 禁用，mathmodel/mathmodel-tools 插入） |
| `scripts/` | Node/pnpm 下载校验（sha256）、运行时构建暂存、afterPack 载荷拷贝 |

## 构建

```sh
npm install              # electron + electron-builder
npm run prepare-runtime  # 下载 Node 发行版 + pnpm + 安装并暂存宿主/profile 载荷
npm run dist:win         # dist/*.exe（nsis）+ *.zip
```

`npm start` 基于已暂存的 `resources/runtime/` 以未打包形态运行，供开发调试。

## 日常升级

- **更新内核**（稳定版备份 + 更新提醒）：
  ```sh
  node scripts/update-kernel.mjs --check    # 只检查 npm 最新版
  node scripts/update-kernel.mjs            # 备份稳定版 -> 更新 -> 写 UPDATE-REMINDER.md
  node scripts/update-kernel.mjs --rollback # 回滚到上一稳定版备份
  ```
  工作期间始终使用当前稳定版；更新脚本会把上一稳定版整体备份到
  `resources/runtime/host-stable`，拉取 npm 最新内核，并在根目录写
  `UPDATE-REMINDER.md` 提醒适配（dsh-mathmodel 版本门 + 回归清单）。

- **手动升级**：
  1. 改 `runtime/host/package.json` 的 `@deepseek-ai/dsh` 版本，并同步 `plugins/dsh-mathmodel/src/version.js` 白名单（先回归 Remote、Slot、Input Trigger、Conversation 与 Preset 行为，不要直接放宽版本门）。
  2. `npm run prepare-runtime && npm run dist:win`。
  3. 更新前备份 profile 的 `package.json` 与 `cordis.patch.yml`；插件失效可用旧版本号钉回。

## 安全模型

- dsh 宿主只绑定回环地址（`127.0.0.1`）；窗口无 Node 集成，preload 运行在沙箱中；导航限制在回环地址，外部链接交给系统浏览器。
- 内置 Node 发行版在构建时按官方 SHASUMS256.txt 校验；内置 pnpm 的 tarball 按 npm registry 完整性元数据校验。
- 插件凭据只在 Host 进程内解析；工具输出、元数据与登记链路零秘密。

## 已知限制

- 未签名构建：Windows 有 SmartScreen 提示（更多信息 → 仍要运行）。
- 数学建模论文工具链（Python 科学计算、XeLaTeX、Draw.io、Poppler）不在安装包内，由插件的依赖预检在本机检测。
- 远程隧道（`dsh-remote-web-ui`）开箱可用 Windows x64 的 cloudflared 二进制。
