# 0.1.5 本地交付记录

本记录为历史交付。当前本机及最新安装包已统一为 0.1.6，见 [0.1.6 交付记录](delivery-build-0.1.6.md)。

## 2026-10-17 本机覆盖升级完成

本机原安装为 0.1.3。核对后确认 `dist/release-0.1.5/` 的既有成品与当前源码一致，复用该成品完成覆盖安装；没有重新编译或发布远端发行版。原桌面快捷方式继续指向 `C:/Users/Administrator/AppData/Local/Programs/dsh-mathmodel-desktop/DeepSeek 数学建模版.exe`，程序版本和 Windows 安装记录均为 0.1.5。

- 新鲜测试：桌面端 246/246、数学建模插件 163/163 通过，无跳过。
- 成品与源码核对：36 个插件文件、5 个应用文件、101 个源码/构建输入以及 Fusion 预构建锁和资产通过；Fusion 核验不等同于从源码编译的证明。
- ZIP 全部 CRC、关键文件字节比对、NSIS 外层及独立抽取的内层全部 CRC 通过。完整收据见 `dist/release-0.1.5/verification.json`，哈希见同目录 `SHA256SUMS.txt`。
- 安装器退出码 0。安装后的 31,737 个文件逐个 SHA-256 与解包成品一致。
- 实际安装启动检查通过：16 种能力预设可用，三项专用预设完整，Fusion 活跃，Web 家族 12 个组件，降级数 0；验证没有发送模型请求。
- 原有会话、工作区记录、凭据、导入设置、hooks 等 94 个受保护文件，在安装前后及实际启动后字节一致。

本次备份和安装收据目录为 `dist/personal-upgrade-0.1.5-2026-10-16T17-44-57-407Z/`（目录时间为 UTC，操作日期为北京时间 2026-10-17）。包含 `application-0.1.3/` 旧程序、经过摘要验证的个人数据快照、安装器退出收据、`installed-payload-verification.json` 和 `installed-live-verification.json`。个人数据快照按现有快照规则排除 Electron 的 `desktop-updates` 下载缓存；原缓存未删除。该备份包含私人配置，留在本机，不作为发行资产。

安装包：`dist/release-0.1.5/dsh-mathmodel-desktop-0.1.5-win-x64.exe`，SHA-256 为 `2a1a7a1a4a5de9e4a771830ce584ffe82f1fd3364b8463827664816028352f31`。

以下保留首次打包前计划，其中“待执行”状态仅代表当时记录，不代表本次交付状态。

## 首次打包前记录

0.1.4 候选及其证据保留在 `dist/release-0.1.4/`。当前源码的桌面 package 与 lock 已升到 0.1.5；发行脚本默认 0.1.5，并继续支持显式选择历史 0.1.4、0.1.3 和 bridge。首次 0.1.0 bootstrap 仍只接受原有 0.1.3 目标。本文件是打包前记录，不代表已有 0.1.5 安装器或通过成品验收。

待打包范围包括任务前四类能力的 16 种组合、会话首轮冻结与冷恢复配置检查、凭据和连接错误的安全处理，以及本轮源码修复。自动重修是隔离代码评测工具中的流程，尚未成为桌面通用自动修复功能。缓存、费用与代码质量的真实请求结果须单独报告，并注明样本数、提供方 usage、计价假设及失败任务；安装器本身不能证明这些收益。

源码阶段的发行路线回归：`node --test --test-concurrency=1 tests/release-publication.test.mjs tests/update-feed.test.mjs tests/bootstrap-installed-desktop.test.mjs`，33/33 通过。新增 0.1.5 路线测试先在旧代码因 Unsupported desktop release version 失败，修后通过；覆盖 0.1.2 先到 bridge、bridge/0.1.3/0.1.4 到 0.1.5、0.1.5 不重复提示。打包后的全部验证结果、真实哈希和隔离启动收据待补，不沿用 0.1.4 的值。

## 待执行的本地成品步骤

在全部源码修复和测试结束后，构建到新目录，不覆盖 0.1.4：

```powershell
$env:ELECTRON_BUILDER_COMPRESSION_LEVEL = '1'
npm run dist:win -- --config.electronDist=node_modules/electron/dist --config.directories.output=dist/release-0.1.5
```

`scripts/verify-windows-artifacts.mjs` 能直接检查 ZIP 全部 CRC、关键文件字节比对及 NSIS 外层。若要在回执中标记内层 NSIS 完整性，还须先独立抽出 `$PLUGINSDIR/app-64.7z`，对其执行 `7z t`，并在新目录建立与安装器 SHA-256 绑定的 `nsis-payload-integrity.json`；该脚本只**读取和核验**这一证明，不负责抽取或生成。旧 0.1.4 目录有证明文件和抽取日志，但未找到专用的自动生成脚本。可在打包完成后执行以下 PowerShell 命令生成证明（运行前确认新目录尚无同名证明）：

```powershell
$release = 'dist/release-0.1.5'
$installer = Join-Path $release 'dsh-mathmodel-desktop-0.1.5-win-x64.exe'
$sevenZip = 'node_modules/electron-winstaller/vendor/7z.exe'
$extract = Join-Path $release 'nsis-payload-check'
New-Item -ItemType Directory -Path $extract -ErrorAction Stop | Out-Null
& $sevenZip x -y "-o$extract" $installer '$PLUGINSDIR/app-64.7z'
if ($LASTEXITCODE -ne 0) { throw 'NSIS payload extraction failed' }
$payload = Join-Path $extract '$PLUGINSDIR/app-64.7z'
& $sevenZip t $payload
if ($LASTEXITCODE -ne 0) { throw 'NSIS payload integrity check failed' }
$proof = [ordered]@{
  ok = $true
  installerSha256 = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
  payload = 'nsis-payload-check/$PLUGINSDIR/app-64.7z'
  sha512 = (Get-FileHash -LiteralPath $payload -Algorithm SHA512).Hash.ToLowerInvariant()
}
$proofPath = Join-Path $release 'nsis-payload-integrity.json'
if (Test-Path -LiteralPath $proofPath) { throw 'Nested proof already exists' }
[IO.File]::WriteAllText($proofPath, ($proof | ConvertTo-Json) + "`n", [Text.UTF8Encoding]::new($false))
```

随后运行：

```powershell
node scripts/verify-windows-artifacts.mjs dist/release-0.1.5
```

从已验证的 ZIP 生成两跳更新源。基线是既有 bridge ZIP，目标是新的 0.1.5 ZIP；文件大小和 SHA-256 由工具现场计算：

```powershell
node scripts/create-update-feed.mjs `
  --zip dist/updater-bridge-0.1.3-bridge.1/dsh-mathmodel-desktop-0.1.3-bridge.1-win-x64.zip `
  --version 0.1.3-bridge.1 `
  --url https://github.com/wangzhiguan72-droid/dsh-mathmodel-desktop/releases/download/v0.1.3-bridge.1/dsh-mathmodel-desktop-0.1.3-bridge.1-win-x64.zip `
  --notes-file dist/updater-bridge-0.1.3-bridge.1/release-notes-0.1.3-bridge.1.txt `
  --upgrade-zip dist/release-0.1.5/dsh-mathmodel-desktop-0.1.5-win-x64.zip `
  --upgrade-version 0.1.5 `
  --upgrade-min-version 0.1.3-bridge.1 `
  --upgrade-url https://github.com/wangzhiguan72-droid/dsh-mathmodel-desktop/releases/download/v0.1.5/dsh-mathmodel-desktop-0.1.5-win-x64.zip `
  --upgrade-notes-file dist/release-0.1.5/release-notes-0.1.5.txt `
  --out dist/release-0.1.5/desktop-update.json
node scripts/publish-desktop-release.mjs --plan --bridge-dir dist/updater-bridge-0.1.3-bridge.1
```

发布计划仅做本地五项资产校验；没有执行 `--publish`。还需验证成品隔离启动、完整测试和费用质量评测，再填写实际收据和限制。
