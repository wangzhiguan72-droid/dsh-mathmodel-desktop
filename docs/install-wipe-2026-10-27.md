# 2026-10-27 安装目录内核依赖被清空：排查与修复方案

本记录只读排查，未改动安装目录。

## 现象

`C:\Users\Administrator\AppData\Local\Programs\dsh-mathmodel-desktop\resources\runtime\host\node_modules` 下 549 个包目录中有 405 个被清空：目录还在，里面的文件全没了。目录修改时间集中在 2026-10-27 21:28:44 至 21:29:26（+08:00），按字母顺序依次清空，前后约 42 秒。与 `release-0.1.7-final/win-unpacked` 相比，安装目录缺 25,936 个文件，全部在这 405 个包里；剩下的 15,445 个文件逐一比对哈希，没有一个不一致。`profile-web`、`app.asar`、exe 都没被动过。被清空的包里有 `@deepseek-ai/dsh`（含 `lib/bin.js`）和 `dsh-agent-loop`，所以宿主现在无法启动。

## 原因

`~/.dsh-mathmodel/profiles/node_modules` 里有 481 个目录联接（junction），都指向安装目录的 `host/node_modules`。被清空的 405 个包，恰好都是这些联接的目标；没有联接指向的 144 个包全部完好。所以这次清空是某个递归删除沿着联接进入了安装目录，删光了目标里的文件。这类删除包括 `rm -rf`、PowerShell 5.1 的 `Remove-Item -Recurse` 和 Electron 的 `fs.rm`；`src/runtime.cjs:512` 的注释写的就是这个风险。被删的是联接的某一份副本，不是 `~/.dsh-mathmodel` 本身，因为它的 481 个联接都还在。

没查到是哪个工具执行的删除。Claude Code、Kimi Code、Codex 在这个时间段都没有删除记录。10-22 旧版清理清单里列出的若干目录现在已经不在了，包括 `personal-upgrade-0.1.5-…`、`desktop-updates-verified`、`legacy-bootstrap-fixture-…`、`桌面壳稳定备份-20260918`、`~/.dsh-desktop-bootstrap-backups`。其中带个人数据备份的目录很可能含有同样的联接副本，但目录已删，无法确认。`%APPDATA%\dsh-mathmodel-desktop\desktop-updates` 的修改时间是 21:17:57，可以作为一条线索。

## 仍有风险的副本

`dist/install-0.1.6-verification` 和 `dist/install-0.1.7-verification` 各自保存着同样的 481 个联接，都指向安装目录。用上面那几种递归删除去删其中任何一个，会再清空一次安装目录。删之前必须先逐个解除联接，例如对每个联接执行 `cmd /c rmdir`，或者用 `runtime.cjs:516-528` 那种基于 lstat 的删除。

## 可用的恢复来源

| 来源 | 状态 |
|---|---|
| `dist/release-0.1.7-final/win-unpacked` | 与当前安装同为 0.2.1-rc.2 内核，SHA256SUMS 四项全部校验通过，可直接作为补齐来源 |
| `dist/release-0.1.7-final/*.exe` / `*.zip` | 哈希校验通过，可完整重装 |
| `dist/release-0.1.8` | rc.4 内核，版本跨度大，不建议作为这次修复的来源 |
| `%TEMP%\ns*.tmp\old-install` | 只有 NSIS 测试夹具，每份 1 个文件，没有用处 |
| `.dsh-previous-*`、`host-stable`、稳定版快照 | 都不存在 |

## 修复方案（推荐 A）

**A. 只补齐缺失的文件。** 从 `release-0.1.7-final/win-unpacked` 把这 25,936 个文件复制回安装目录：只补缺的，不覆盖已有文件。这样有意改过的 8 个文件会保留下来，包括 10-21 部署的工具开关、10-22 的启动修复 `app.asar`、`startup-cache.cjs` 和卸载器。步骤：
1. 确认没有安装目录下的进程在运行；
2. 补齐文件，并写下补齐清单和哈希回执；
3. 重新比对一遍，要求缺失为 0、哈希不一致为 0；
4. 用桌面快捷方式启动，确认宿主 RPC 可达；
5. 再做这次的工具开关部署，并跑一遍安装环境的开关验收。

**B. 用 0.1.7 安装包重装。** 会经过旧卸载器，过程更长，而且那 8 个有意的改动要重新部署。只有 A 失败时才用。

**C. 直接装 0.1.8。** 这会换成新内核，超出这次修复的范围。

无论选哪个方案，都应先处理掉上面两份带联接的副本，或者给它们加上明确标记，免得再有人用递归删除去删它们。
