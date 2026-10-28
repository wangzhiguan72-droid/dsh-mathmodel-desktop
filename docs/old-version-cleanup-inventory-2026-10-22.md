# DeepSeek 数学建模版旧版本清理清单（2026-10-22）

当前运行版：桌面 0.1.7 / 内核 0.2.1-rc.2。本次仅盘点，没有删除。
空间为文件逻辑大小（GiB），不跟随符号链接或目录联接，不代表实际可释放磁盘块的精确值。

## 旧版发行包与候选副本

| 内容 | 路径（相对于 D:/deepseek harness/dsh-mathmodel-desktop/dist） | 大小 GiB | 建议 |
|---|---|---:|---|
| 上一个正式交付版 0.1.6，含 EXE、ZIP、解包目录 | release-0.1.6 | 2.044 | 不需要回退 0.1.6 时可清理 |
| 0.1.5 失败测试副本 | failed-0.1.5-first-smoke | 1.288 | 可清理历史测试副本 |
| 0.1.6 标签的新版内核过渡候选 | kernel-latest-candidate | 1.123 | 可清理，非当前安装 |
| 目录名为 0.1.7、实际 app.asar 版本为 0.1.6 的候选 | release-0.1.7 | 1.123 | 可清理，勿与 final 混淆 |
| 0.1.4 发行记录 | release-0.1.4 | 小于 0.001 | 安装包已在 10/19 清理，剩日志与收据 |
| 0.1.5 发行记录 | release-0.1.5 | 小于 0.001 | 安装包已在 10/19 清理，剩日志与收据 |

以上四个主要旧版/候选副本合计约 **5.578 GiB**。当前应用运行不需要这些副本；删除后不能直接用它们重装或回退。
迁移回归测试现已使用 tests/fixtures/task-capabilities-0.1.6.yml 固定夹具，不再读取 release-0.1.6 目录。

## 更早的版本记录与验证残留

历史版本顺序为 0.1.0 → 0.1.1 → 0.1.2 → 0.1.3-bridge.1 → 0.1.3 → 0.1.4 → 0.1.5 → 0.1.6 → 当前 0.1.7。
以下已不是完整的历史安装包集合，主要是升级验证、提取载荷、源代码快照或备份，不能把目录名视为可运行版本证明：

| 内容 | dist 下目录 | 大小 GiB |
|---|---|---:|
| 早期更新验证（涉及 0.1.1～0.1.3） | desktop-updates-verified | 5.485 |
| 早期 bootstrap 验证夹具 | legacy-bootstrap-fixture-e8886fdc-e5f2-4b4c-801d-098d4ef7f14e | 1.995 |
| 0.1.2 更新入口验证残留 | update-entry-fixed-0.1.2 | 1.602 |
| 0.1.3 过渡版验证残留 | updater-bridge-0.1.3-bridge.1 | 1.167 |
| 0.1.3 内核升级验证残留 | kernel-upgrade-0.1.3 | 0.883 |
| 早期 rc3 最终验收残留 | rc3-final-verified | 0.625 |
| alpha.4 内核研究工作目录 | kernel-0.2.1-alpha.4-work | 0.536 |
| 早期 NSIS 验证载荷 | nsis-final-verified | 0.313 |

这些历史验证目录当前运行无需使用；清理会失去历史重验材料。其中一些目录带有联接或测试数据，实际删除需仅处理列出的目录本身，不递归进入联接目标。

另有早期独立运行时备份 `D:/deepseek harness/桌面壳稳定备份-20260918`，实测 **4.142 GiB**、425,679 个文件，内核标记 `0.1.2-rc.1`。这是旧运行时副本，不是当前安装；无需恢复该早期环境时可清理。加上上述四个主要旧版/候选副本，约 **9.720 GiB**。

## 不混入旧程序清理的个人数据备份

- D:/deepseek harness/dsh-mathmodel-desktop/dist/install-0.1.6-verification（约 0.274 GiB）
- D:/deepseek harness/dsh-mathmodel-desktop/dist/personal-upgrade-0.1.5-2026-10-16T17-44-57-407Z（约 0.254 GiB）
- C:/Users/Administrator/.dsh-desktop-bootstrap-backups（0.439 GiB）
- C:/Users/Administrator/.dsh-desktop-update-backups（0.482 GiB）
- D:/deepseek harness/backup-profile-mathmodel-20261002-150115
- D:/deepseek harness/插件安装备份-20260921
- D:/deepseek harness/插件安装备份-20260930（目录内包含“官方桌面”，不是单纯数学建模版旧程序）

这些备份可能包含个人配置、会话、凭据或其他版本的数据恢复材料，应与旧安装包分开决定。不要删除其中链接指向的现有共享技能或插件目录。

## 应保留

- 当前安装：C:/Users/Administrator/AppData/Local/Programs/dsh-mathmodel-desktop
- 当前个人数据：C:/Users/Administrator/.dsh-mathmodel
- 当前桌面数据：C:/Users/Administrator/AppData/Roaming/dsh-mathmodel-desktop
- 当前正式安装包：D:/deepseek harness/dsh-mathmodel-desktop/dist/release-0.1.7-final（2.229 GiB）
- 今天修复原件与收据：dist/audit-20261022、dist/startup-repair-20261022、dist/task-tool-switches
- 项目源码及构建依赖：src、plugins、runtime、resources、node_modules；不要因为包含旧版本字符串就整体删除。

独立的 C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness 不是数学建模版旧版本，不属于本清理清单。
