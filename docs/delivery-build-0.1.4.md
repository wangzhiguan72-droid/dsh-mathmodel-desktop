# 0.1.4 交付与构建修复

执行范围：第一项交付与构建；后续能力组合、模型基准和权限恢复负例另行处理。

计划与验收：

1. 为新载荷分配 0.1.4，package/lock 一致；保留 0.1.3 历史发布与首次 bootstrap 的身份。
2. 新版 feed 保留 0.1.3-bridge.1 基线，升级到 0.1.4；验证 0.1.2 先走 bridge、bridge/0.1.3 走 0.1.4、0.1.4 不重复提示。
3. Fusion 本地源码/构建产物必须一致且强制暂存，缺构建前提或源文件变更时阻断；运行时依赖资源完整，拒绝越界链接。
4. 排查 NSIS 全套测试超时，验证针对性与全套结果，保留首次失败证据。
5. 本地构建 Windows ZIP/NSIS，生成精确 SHA-256 清单、feed 和发布计划；用隔离 home 检查成品。生产安装和远程发布不由此文档自行授权。

已建立 0.1.4 发布路线回归：旧客户端的迁移桥仍在；更新器的高版本判断保持原样，避免同版不同内容破坏发行身份。新增用例先因 Unsupported desktop release version 失败，修复后通过。

历史默认发布 API 继续保留 0.1.3 以兼容旧调用；CLI 默认指向 0.1.4，历史发布须显式传 --version。首次 0.1.0 bootstrap 保留原来经验证的 0.1.3 目标，不扩大它的升级范围。

## 构建与门禁

`node scripts/build-runtime.mjs --local-only` 不运行 pnpm，不下载宿主；它验证已有暂存内核与锁定版本一致，重建 mathmodel，强制刷新 mathmodel 与 Fusion，再更新载荷时间。首次准备运行时仍使用完整 prepare-runtime。

Fusion 的当前副本没有上游构建脚本或工具链。`scripts/fusion-prebuilt-lock.json` 只封存当前 src/lib 哈希，明确不是源码编译证明。源码或 lib 漂移会阻断构建；恢复正规重编译流程后应独立验证再审查新封存记录。全部 14 个 package.files 条目（含 LICENSE、双语说明与兼容文档）随插件刷新。

npm 的 pack/dist/dist:win/dist:mac 构建入口自动刷新本地插件；直接调用 electron-builder 时，afterPack 仍在复制前只读验证源码封存与暂存资产。回归覆盖陈旧 lib、源码漂移、缺失资源及 junction，失败时输出目录的现有内容不变。

本机成品命令（复用 npm 已安装的同版本 Electron 44.1.1）：

```powershell
$env:ELECTRON_BUILDER_COMPRESSION_LEVEL = '1'
npm run dist:win -- --config.electronDist=node_modules/electron/dist --config.directories.output=dist/release-0.1.4
```

首轮默认下载构建失败于 GitHub 连接 ETIMEDOUT；原始 build.log 与 build-first-attempt.log 保留。改用本地 Electron 不变更 Electron 版本、不关闭完整性校验。

## 验证记录

- 初轮完整默认串行回归 159/159，日志 `desktop-tests.log`；最终代码完整串行回归 **163/163**，0 失败、0 跳过，日志 `dist/release-0.1.4/desktop-tests-final.log`。最终定向回归 **35/35**，日志 `final-targeted-tests.log`。
- NSIS 三文件并行及串行均 5/5；未复现原 short.exe 超时，未修改超时或生产安装逻辑。默认测试使用 test-concurrency=1，避免同时运行多个编译/安装夹具；不认定资源竞争是此前失败的唯一根因。
- 独立代码审查发现的许可证资源遗漏和历史 CLI 默认目录问题已修复；语法、package/lock 0.1.4 一致性、相关 diff 空白检查通过。
- 0.1.4 成品及隔离启动结果以最终回执为准，不用上述源码测试代替。

## 成品阶段发现并修复的问题

1. electron-builder 在 ZIP 完成后给 NSIS 增加 `resources/elevate.exe`。静态验收已核对这一精确差异，但历史 releaseFiles 要求 ZIP/解包文件数相等，导致真实发布计划失败。新增先失败的回归，再限定只允许唯一该文件且数量严格差 1；任意其它路径或数量仍失败。
2. 默认的新 7z 编码器为四个 node-pty ARM64 辅助文件使用旧解码器不支持的自动过滤方法。真实 ARM64 DLL 的小型回归复现默认失败与 BCJ 成功；Windows afterPack 默认选择 BCJ，用户显式选择仍保留。此前候选及失败回执在 `first-codec-candidate/` 和日志中保留。

兼容安装器由同一已通过三阶段启动的 win-unpacked 重建，ZIP 内容保持原样。重建命令显式设置 ELECTRON_BUILDER_7Z_FILTER=BCJ 和压缩等级 1，并使用 electron-builder 的 --prepackaged，只重建 NSIS；标准全量构建由 afterPack 自动设置兼容默认值。

隔离程序检查 `package-smoke-receipt.json` 三阶段均通过：first=seed、restart=leave、relocated=reseed，5 shared packages、11 active family rows、0 degraded；用户 patch 保留、原 host 文件保持一致。没有覆盖个人安装或读取个人凭据。

## 最终候选

最终输出：`dist/release-0.1.4/`。`verification.json` 已通过 ZIP 全项完整性、21 个关键文件字节比对、NSIS 外层完整性以及独立抽取内层的全项 CRC/完整文件清单核验；解包 31,735 文件，ZIP 31,734 文件，唯一安装器专用差异为 elevate.exe。

最终 NSIS SHA-256：`281b9ba43baa52bd03fad398919a6182682b05a5309a76d448f2283979918b7c`。

ZIP SHA-256：`2395afb10cacdb6414ec83de63f2c127330c853557b304bbc0c17fc4cd1f0372`。

`desktop-update.json` 使用升级准备版基线和 0.1.4 目标的实际 ZIP 大小/哈希；`publication-plan.json` 本地验证五项发布资产通过。总回执为 `delivery-summary.json`。安装器实际签名状态 NotSigned，是本地候选，尚未公开发布或替换个人安装。没有将这些结果写成真实 NSIS 覆盖安装已验收。

第一项完成的是本地发行身份、构建防线、候选与验收。Fusion 原包的源码重编译工具链仍缺失，该限制与哈希封存证据同时保留。下一项为任务开始前的能力组合。
