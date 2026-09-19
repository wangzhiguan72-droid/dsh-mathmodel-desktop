---
name: plugin-adaptation
description: 官方 DeepSeek Harness 升级后，检测并适配本地插件（版本白名单、API 改名、依赖解析、编码等），适用于桌面端与网页版
---

# 插件适配（官方 Harness 升级后）

当官方 `@deepseek-ai/dsh` 升级到新版本后，本地插件报版本不兼容、模块缺导出、依赖解析失败时，按以下顺序排查适配。

## 1. 版本白名单（最常见的第一道门）

插件（dsh-mathmodel、dsh-api-key-pool、dsh-opencode-session 等）带失败关闭白名单：

- 找到 `plugins/<插件>/src/version.js`（及 `lib/version.js`）里的 `SUPPORTED_DSH_VERSIONS`；
- 把新版本号加进数组（src 和 lib 都改，或改 src 后重新构建）；
- 有构建脚本的插件在插件目录里 `npm run build`；
- dsh-opencode-session 的兼容门是「版本 + 函数指纹」双校验：新版本若函数未变，直接加 `{version, hash}` 对；函数变了则重新采集指纹（`createHash('sha256').update(Adapter.prototype.streamWithSnapshot.toString())`）。

## 2. 宿主 API 改名（第二道门：模块缺导出）

报 `does not provide an export named 'X'` 时，是宿主把 API 改名/移除了：

- 对照宿主自带插件（`host/node_modules/@deepseek-ai/` 下同功能的官方插件）怎么调用新 API；
- 已知案例：`dsh-settings` 的独立函数 `installSettingsSection(ctx, ns, ...)` 变成了 `SettingsProvider` 实例方法 `settings.installSection(ctx, ns, ...)`，需配合 `ctx.inject(['settings'], (settingsCtx) => { ... })`；
- 修改插件 src 后重新构建，并刷新 profile 的插件副本。

## 3. 依赖解析失败（No matching version）

registry 上全是 prerelease 版本时，semver 不允许非预发布区间匹配预发布版本：

- 在 profile 的 `package.json` 里加 `pnpm.overrides` 把对应包钉到实际存在的版本（优先与宿主同版本）；
- **pnpm 9 只读 package.json 的 `pnpm.overrides`，不读 pnpm-workspace.yaml 里的 overrides**（那是 pnpm 10 的行为），写在两处会导致 frozen 安装报配置不匹配；
- 也可用自动循环：解析失败 → `npm view <pkg> versions --json` 查存在的版本 → 加 override → 重试。

## 4. lockfile 钉住旧阵容

`--no-frozen-lockfile` 仍复用 lockfile 里满足区间的旧钉版。要得到纯新版本阵容：删除 `node_modules` 和 `pnpm-lock.yaml` 后全新安装。

## 5. hoisted 布局（pnpm 9 不读 workspace 的 nodeLinker）

pnpm-workspace.yaml 里写 `nodeLinker: hoisted` 对 pnpm 9 无效，须写入 `.npmrc`（`node-linker=hoisted`）。宿主运行时需要扁平 hoisted 布局（模块回退按扁平路径建链接）。

## 6. 补丁哈希与换行符

frozen 安装报 "overrides/patchedDependencies 配置不匹配" 时：git 的 autocrlf 把补丁文件转成 CRLF，pnpm 按磁盘字节算哈希与 lockfile 不符。把补丁文件转回 LF（`tr -d '\r'`）即可。

## 7. 符号链接 EPERM（Windows）

模块回退 heal 报 EPERM：开启 Windows 开发者模式（注册表 `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock\AllowDevelopmentWithoutDevLicense = 1`）。注意 PowerShell 的 `New-Item -ItemType Junction` 走挂载点 API 不需要权限，而 node 的 symlinkSync 需要该标志。

## 8. profile 回退链接的精确目标

宿主 heal 校验 `readlinkSync(link) === entry.packageDir` 字符串精确匹配（含斜杠方向与大小写）。手工重建链接时用与 heal 相同的 anchor（host 内 dsh 包的 package.json）+ `createRequire(anchor).resolve.paths(dep)` 解析目标，用 PowerShell junction 创建。

## 9. PowerShell 脚本 BOM（Windows）

无 BOM 的 UTF-8 脚本含中文时，PowerShell 5.1 按 GBK 误读导致解析崩溃（中文句号末字节吞掉引号）。给脚本补 BOM（`EF BB BF`）。

## 10. 快捷方式引号丢失

.lnk 的 Arguments 里带空格 + 中文的引号路径，双击时引号被破坏（路径按空格截断）。绕开：启动器用 `%~dp0`（cmd）或放到 ASCII 路径的带 BOM .ps1 里，.lnk 目标与参数保持纯 ASCII。

## 11. 升级前先停服务

升级全局包前，先停掉所有 `dsh` 相关 node 进程，否则 EBUSY（koffi.node 等原生模块被锁）。

## 12. 验证清单

启动无报错（Error / failed to import / 不兼容 均为 0）→ 白名单通过 → UI 完整渲染 → 工作区选择正常 → 会话在侧边栏可见。
