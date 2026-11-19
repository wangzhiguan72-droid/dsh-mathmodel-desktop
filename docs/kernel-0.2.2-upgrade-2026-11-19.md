# DSH 0.2.2 及自建插件适配记录

目标内核固定为 **@deepseek-ai/dsh@0.2.2-rc.3**（预览版）。不使用会漂移的 `next` 标签；全部 330 个官方 DSH 包保持同一版本。数学建模版应用编号也已同步为 0.2.2-rc.3。

升级前完整备份：`D:/deepseek harness/backups-20261118-kernel-022-rc3/backup.json`。已校验完整安装目录 43,036 个文件、工作区源码 812 个文件，以及 DSH_HOME / Electron 用户数据的快照摘要。旧应用和旧 profile 在切换时还会保留原目录。

## 最终适配

| 部件 | 版本 / 处理 |
| --- | --- |
| 数学建模及交接 | 0.1.2；展平 startActivation，保留预留 childId、caller 交付及结构化回执；取消时等 disposer 完成再释放写锁 |
| Fusion | 0.2.11+mathmodel.2；Host 从本地源码重新编译；新版 scoped NativeToolExecutor、工具批次执行及精确 activation 回收；保留客户端 sessions/remote/remote.session 注入 |
| Teams | 0.1.30+mathmodel.2；择取具名树交付及分支停止适配，保留严格 peer 矩阵和之前的失败结算修复 |
| Context | 0.85.1+mathmodel.2；采用适配 Session v4 / 具名树的数据层，保留参数透传及 traced receiver 调用归属修复 |
| Sandbox Auto | 0.2.0；保留自建策略，只扩展经过验证的 rc.3 版本与实时工作目录接入 |
| 桌面 Web 插件 | WebAll 0.4.19；显式保留被聚合包拆出的 Git Graph 0.4.14、更新入口 0.4.15、Remote UI 0.4.19；保留桌面更新与外链适配 |

自建持久化记录使用官方 `appendPluginRecord` 写入 `plugin:mathmodel/*`，并兼容官方迁移后的旧记录名。新内核保持官方原始实现，不再套用旧 Session.append 补丁。插件管理器冻结保护透传新版第四个身份参数，配置摘要读取新版 effectiveConfig。对 rc.5 生成的三个专用角色预设增加精确哈希迁移；先验证与备份版本完全相同，只更新标准插件清单，手改的 Persona 仍被拒绝。

## 验证证据

证据目录：`D:/deepseek harness/_kernel-022-rc3-20261118/` 与本仓库 `dist/kernel-022-rc3-audit/`。

- 桌面全量回归：310 项，308 通过、2 个旧版本专用用例跳过；随后新增 0.4.19 真实清单健康检查和 2 个 rc.5 预设迁移用例通过；连同数学建模与 Teams，604 项检查通过，另 2 项旧版用例跳过。
- 数学建模插件：211 项全部通过，包含新版展平参数和异步取消清理回归。
- Teams：82 项全部通过，包含真实新版服务 receiver、分支回收、FIFO 交付及 HMR 守卫。
- Fusion 严格 TypeScript 检查通过；TypeScript 7.0.2 / tsdown 0.23.7 生成 Host 与声明，源码和产物分别锁定摘要。客户端保留已修复产物。
- 真实完整 Host 的本地模型桩验证：主代理 → delegate → 新版原生子代理 → scoped structured_output → 回执/账本结算；会话版本 4，无残留子代理，无违规。没有外部模型请求。
- 旧会话备份副本：78 个会话、2,516 个事件可读，3 个需要迁移的会话经官方后端迁移，无失败；原始会话未被这项测试修改。
- 当前用户配置的副本：任务及工作台预设迁移通过，完整 profile 合成成功，没有遗漏的用户自装依赖。
- Windows 完整应用已构建并部署，53,605 个文件复制后逐项校验。预设迁移修复使用 electron-builder 重建匹配的 EXE/ASAR，先备份两文件再部署，差异单独留档。安装版五个核心插件激活、Context 页面打开，渲染异常为 0；最终现用配置验收见 `live-profile-verification.json`。
- `git diff --check`、修改脚本语法检查通过。

官方版本与接口依据：[rc.3 发布](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.3)，官方源码固定在 `38a6a5c965aa99ab525161efb7cc5cf1fe62fced`；原始 npm 发布物及完整接口审计见证据目录 `research/UPGRADE-ADAPTATION.md`、`research/VERIFICATION.json`。

## 恢复与边界

本次没有发送真实付费模型请求，实际模型服务可用性不由本地桩测试证明。Teams 的树交付适配涉及经过审计的内部管理器，因此只支持声明中固定的内核组合。会话跨格式回退必须同时恢复升级前应用与数据快照；不要仅替换成旧内核后打开新会话。

## 最终本机验收

2026-11-19：实际安装内核 0.2.2-rc.3；当前用户配置启动通过，五个核心插件全部 active、无降级项，任务/工作台预设正常，78 个历史会话可列出、运行中会话为 0，验收应用正常关闭。14 条既有用户配置逐项保留。Windows 卸载程序保留并校验。完整结论及部署索引：`D:/deepseek harness/_kernel-022-rc3-20261118/UPGRADE-COMPLETE.json`。

应用编号同步：源码清单及锁文件、重建后的 EXE/ASAR、Windows 已安装应用显示均更新为 0.2.2-rc.3。安装版实际界面及 IPC 版本读数均通过验证，渲染异常为 0；增量备份与验收记录：`D:/deepseek harness/backups-20261119-app-version-022-rc3/`。
