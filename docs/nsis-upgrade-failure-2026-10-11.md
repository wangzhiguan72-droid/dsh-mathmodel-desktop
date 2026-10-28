# 2026-10-11 NSIS 覆盖升级失败诊断

## 2026-10-12 实际首错与根因回归

装入带诊断的卸载器后，实际覆盖的首错为 `stage=remove-directory`，路径是整个已安装根目录，见 `dist/fusion-installed-verification/closure-diagnostic-nsis-first-failure.log`。该分支未采集 Win32 错误码，不能据此断言具体系统错误。

现有 builder 的 `installer.nsi` 在 `.onInit` 先执行 `SetOutPath $INSTDIR`，而覆盖随后调用旧卸载器；父安装器会持有安装目录作为当前工作目录。新增隔离回归完整复现这个顺序：父安装器持有目录时，子卸载器删除根目录失败、退出 2、原文件回滚；插入生产 `customInit`（切换到 `$TEMP`）后，同一子卸载器退出 0、安装目录消失。`tests/nsis-update-rollback.test.mjs` 两项测试通过，原长路径、文件共享锁、junction 保护仍通过。

修复在 `build/installer.nsh` 的 `customInit` 释放父安装器工作目录。已用相同 `win-unpacked` 重建 NSIS，桌面载荷和 ZIP 保持相同；该修复包在真实原安装路径覆盖退出 **0**，见 [实际回执](../dist/fusion-installed-verification/closure-fixed-nsis-result.json)，对应首启、重启和最终接口检查通过。这是实际覆盖证据，独立于隔离回归。随后包含 Fusion bundle 管理修复的最终包也实际覆盖退出 **0**，见[最终回执](../dist/fusion-installed-verification/closure-final-nsis-result.json)，实际首启和重启的关键文件哈希、插件服务均通过。10-13 又补齐最终版正常退出重启与原生点击复查，具体证据及验收边界见[安装版闭环记录](fusion-installed-closure-2026-10-12.md)。

生产身份的 `0.1.3` 候选安装器以 `/S /currentuser /D=C:\Users\Administrator\AppData\Local\Programs\dsh-mathmodel-desktop` 覆盖原安装，最终退出码为 `2`。原目录恢复为旧载荷，`VERSION.json` 的旧构建时间仍为 `2026-10-09T20:24:22.689Z`。机器回执是 `dist/fusion-installed-verification/nsis-install-result.json`；调用没有 stdout/stderr。监测到旧卸载器五次把文件移入 `nsg*.tmp\old-install` 再回滚，单次最多约 31,218 个文件。没有记录首个失败路径或 Windows 错误码，因此**不能把文件占用、权限或路径问题中的任一个宣布为根因**。

候选安装器通过 electron-builder 的 `uninstallOldVersion` 从注册表读取旧版 `UninstallString`，复制旧卸载器到临时目录，并最多执行五次；它不会使用新包内嵌的卸载器升级旧目录。相关调用在 `node_modules/app-builder-lib/templates/nsis/include/installUtil.nsh:142,215-239`。旧卸载器按 `build/installer.nsh:105-153` 递归搬迁文件；`build/installer.nsh:188-222` 在搬迁或清理失败时尝试回滚并退出码 `2`。原安装旧卸载器 SHA-256 为 `2F2B5830663335C3BA6CBB8E117330501A07C61395C186BE85772F5EA8768317`；新候选内嵌卸载器为 `656BB5CEC9F5C9FF5C87F14EDA129B721D21B060619F63602A29BACD37F73AD7`。两者大小均为 221,330 字节，同属 NSIS 3 Unicode，但旧二进制并非候选二进制。

完整旧安装备份有 31,550 个文件、0 个 reparse point。按真实安装路径计算，最长文件路径为 257 字符，按观察到的临时目标路径计算为 255 字符；普通的链接预检和 260 字符限制未能解释这次失败。隔离探针 `scripts/nsis-upgrade-diagnostic.mjs` 把备份复制到新建的 Temp 目录，编译仅含 `customRemoveFiles` 的 NSIS 卸载器，并以同一位置的 `MoveFileW(...)?e` 记录源路径、目标路径和 Win32 错误。完整隔离运行的结果为退出码 `0`、失败日志为空、旧目录删除成功。随后在同一隔离目录制造独占锁文件，探针退出码为 `2`，成功回滚，日志给出该文件和 `win32=32`（共享冲突）。这证明诊断捕获可靠，不证明生产现场也存在共享冲突。探针不调用注册表或实际安装路径。现有 `tests/nsis-update-rollback.test.mjs:50` 另覆盖锁文件、长路径和 junction，本次重跑为 1 test、0 fail；其合成夹具不能替代真实旧版覆盖安装。

早期诊断阶段用已校验 ZIP 完整切换程序树，保留原安装身份和个人数据；该恢复路径不调用旧卸载器。最终 NSIS 根因修复及实际覆盖成功见本文开头。`build/installer.nsh` 已为**后续生成**的卸载器加入首错日志：搬迁分支用 `MoveFileW(...)?e` 同时捕获结果和 Win32 错误，其他已知失败分支记录操作和路径。日志位于 `%TEMP%\dsh-mathmodel-nsis-upgrade-failure.log`，采用无 BOM UTF-16LE，失败后保留，下一次卸载尝试开始时清除旧日志。锁文件、Unicode 长路径、junction 的隔离回归验证日志在卸载进程退出后可读取，锁文件给出 `win32=32`。这项代码变更不能改变已安装的旧卸载器，因此不能把它当作本次原始失败的根因修复；只有安装了包含此钩子的版本后，下一次 NSIS 覆盖才会产生新日志。单独在原 `Rename` 失败之后调用 `GetLastError` 的锁文件试验返回 `80`，而同一次 `MoveFileW(...)?e` 返回正确的 `32`，所以不能用前者判因。对原旧卸载器直接跑隔离树若成功，仍会执行内嵌的注册表与快捷方式删除段，因此没有这样做。

诊断产生了 `C:\Users\ADMINI~1\AppData\Local\Temp\dsh-ni-Peby8q`（含锁文件夹具，现有 8 个文件）、`C:\Users\ADMINI~1\AppData\Local\Temp\dsh-nsis-analysis-candidate-20261011`（1 个文件）和 `C:\Users\ADMINI~1\AppData\Local\Temp\dsh-nsis-analysis-kernel-20261011`（1 个文件）。对这三个精确路径的 PowerShell 范围校验后清理被自动安全审查以 `blocked by policy` 拒绝，故目录尚留在 Temp。
