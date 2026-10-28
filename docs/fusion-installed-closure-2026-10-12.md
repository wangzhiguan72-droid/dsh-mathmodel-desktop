# Fusion 安装版闭环记录（2026-10-12，10-13 桌面复查完成）

本轮目标是在原安装路径覆盖桌面程序，再验证实际安装版。用户明确核心范围是 DeepSeek 数学建模和软件开发；生图及订阅桥列为可选能力，不为本轮新增依赖、登录流程或使用新提供的生图凭据。桌面版本号仍为 0.1.3；以载荷时间及哈希确认升级。

## 实际安装与保留数据

原安装树及个人数据已备份。早期 NSIS 覆盖退出 2，ZIP 恢复记录保留。诊断定位安装根目录移除失败，隔离回归复现父安装器工作目录占用。修复后在原安装路径实际 NSIS 覆盖退出 **0**，见 [安装回执](../dist/fusion-installed-verification/closure-fixed-nsis-result.json)；对应首启、重启及最终接口检查通过。ZIP 成功未作为 NSIS 成功证据。

随后发现 Fusion 旧手工 loader 与 bundle 开关脱节：关闭开关仍运行。现改为官方 bundle 管理唯一 loader，迁移保留原配置及备份；关闭时插件行消失、接口 404，开启时唯一实例 active、接口 200，见[最终安装版开关回执](../dist/fusion-installed-verification/closure-final-fusion-toggle.json)。该次验证通过认证 Host RPC，未声称原生点击成功。普通重启不重新启用用户已关闭的 Fusion。

包含全部修复的最终 NSIS 已在原路径覆盖成功，退出 **0**，见[最终安装回执](../dist/fusion-installed-verification/closure-final-nsis-result.json)。实际安装载荷时间为 `2026-10-12T03:03:06.833Z`，app.asar SHA-256 为 `ed2243134918af6844fc6caa14d6f6b3b2aa59ba0738bbfc05997c834d11aa6a`。[首启](../dist/fusion-installed-verification/closure-installed-first.json)、[重启](../dist/fusion-installed-verification/closure-installed-restart.json)、[最终核对](../dist/fusion-installed-verification/closure-installed-final.json)均通过，Fusion、loader、SSH、Git Graph 等九个运行时关键文件逐一与最终载荷哈希相同，0 degraded，Fusion 配对 revision=1 保留。监听地址实查为 `127.0.0.1:3082`。

10-12 的原生点击曾被前台 DevEco Testing 窗口遮挡，当次[受控重启回执](../dist/fusion-installed-verification/closure-final-launch-restart.json)保留 gracefulExit=false，不改写历史结果。10-13 用户将 DSH 显示到前台后，最终安装版的[原生点击复查](../dist/fusion-installed-verification/closure-final-native-ui-20261013.json)全部完成：Fusion 关闭/开启、SSH 页面与取消新增表单、技能中心搜索、任务看板五列、远程访问、三种专业预设、梁神拨杆、Git Graph 切分支及已有 worktree 管理列表。Git Graph 在专用验证仓库切到 verification-alt 并切回 main，两次由 Git 命令确认；此前创建的 worktree 在桌面管理列表中可见，未新增或删除工作树。

最终版又通过原生 Alt+F4 正常退出，确认安装程序进程族全部结束后重新打开，见[正常重启回执](../dist/fusion-installed-verification/closure-final-graceful-restart-20261013.json)。重启后桌面已加载，标准模式、默认 Flash low、Fusion 配对 revision=1、原组件开关均保留，0 degraded，运行会话为零。SSH 和 Skill Explorer 临时启用后需刷新桌面前端才显示导航，检查后均恢复关闭。首次窗口枚举曾见短暂 Error 窗口，内容未能读取、随即消失；此次正常重启未复现，不对该瞬时窗口作根因结论。

## 五组闭环

| 项目 | 已有运行证据 | 当前边界 |
| --- | --- | --- |
| Git Graph | 合成 Git 仓库桌面切分支/切回 main，桌面创建 worktree 与新会话；[回执](../dist/fusion-installed-verification/git-graph-ui.json) | 未操作用户原有仓库分支 |
| Hooks | 新安装版实际 write 触发 PreToolUse，exit 2 阻断、目标文件未创建；[新回执](../dist/fusion-installed-verification/closure-hook-path.json)。此前另验证授权后 exit 0 写入 | 只验证指定 PreToolUse shell command 路径 |
| Teams、Auto Review、关闭页面 | 实际成员/消息/共享任务完成；Auto 模式 fixture 写入；SSH 表单、技能搜索、梁神拨杆桌面操作；[UI 记录](../dist/fusion-installed-verification/optional-ui-observations.json) | Auto 原始决定不持久化；没有真实远程 SSH 主机；测试开关已恢复 |
| 性能、Claude、legacy、组合 | [Claude 对照表](claude-capability-comparison-2026-10-11.md)、三对基准及[五种插件组合](../dist/fusion-installed-verification/plugin-combinations.json)全部完成，组合均 0 degraded，真实 Teams/Auto 调用通过；[legacy 映射](legacy-acceptance-mapping-2026-10-12.md)保留原失败 | 本次 Fusion 更慢；不声称 Claude 等价或 legacy 8/8；未验证的订阅生图和识图按最新范围为可选能力 |
| 临时密钥副本清理 | 用户授权的三个 Temp 目录和 fusion-smoke.txt 已永久删除，精确路径存在性均为 false；[删除回执](../dist/fusion-installed-verification/cleanup-receipt.json)、[最终复查](../dist/fusion-installed-verification/closure-final-summary.json) | 文件系统永久删除，未承诺存储介质安全擦除 |

## 本轮代码与检查

- loader 将 hooks 插件放入正确的 insert 配置；实际 Windows guard command 显式传递 Node 退出码。
- 自动迁移三种专业预设，保留原配置和备份，脚本收入 app.asar。打包重启发现 Host 重写 YAML 格式及追加设置的误判，现改为比较三个预设结构并保留 `!!js` 条件。
- NSIS 诊断捕获实际根目录移除失败；新增父子安装器回归证明工作目录占用会触发相同失败，`customInit` 切到 Temp 后成功。首错日志没有该分支的 Win32 值，不据此声称系统错误码。长路径、共享锁回滚、junction 保护继续通过。
- Fusion 使用 bundle 唯一 loader，旧手工 insert 迁为配置 override；保留显式关闭状态，拒绝歧义配置，备份并在写入失败时恢复。
- 最新桌面完整测试 **157/157**，见 [测试日志](../dist/fusion-installed-verification/closure-final-bundle-desktop-tests.log)，Fusion 与专业预设迁移定向检查 **10/10**。此前失败产物和检查记录保留。

三种专业预设在最终安装版通过[公共 registry 与实际空白会话选择](../dist/fusion-installed-verification/closure-final-specialized-presets.json)、[实际桌面选择](../dist/fusion-installed-verification/closure-final-native-ui-20261013.json)及[正常重启后配置](../dist/fusion-installed-verification/closure-ui-specialized-presets-restart-20261013.json)；未声称实际 PPT 或生图任务成功。五种组合与真实 Teams/Auto 调用及 Hooks 阻断均已在最终安装版重新执行通过。当前真实原状态是 SSH 关闭、梁神开启、Skill Explorer 关闭，Teams/Auto Review 关闭，默认 DeepSeek Flash low；最终复查确认恢复此状态，运行会话为零。

## 基准结果

[真实安装版三对回执](../dist/fusion-installed-verification/installed-fusion-benchmark-a3d283d4-9732-4973-bebb-656d6abd9991.json)：三对均正常完成，六个 fixture 各 5/5 测试通过；三次 Fusion 均有委派、worker、自动检查、Lead 复核及 verified。第 1 对的公开 stage 判据已更正并保留原请求证据，未重复该样本。

| 对次 | 原生 Pro | Fusion Pro/Flash |
| --- | --- | --- |
| 1 | 27.018 秒 | 65.363 秒 |
| 2 | 26.031 秒 | 96.408 秒 |
| 3 | 25.997 秒 | 43.958 秒 |
| 均值 | 26.349 秒 | 68.576 秒 |

这组样本 Fusion 更慢，**未证明速度提升**。session 事件口径输出 token 合计为 baseline 6,586、Fusion 14,229；没有可靠金额数据，不据此声称省钱。基准运行期间同机有构建负载，仅为本次合成任务的观测，不代表普遍性能或旧版整机前后提升。

最终输出目录为 `dist/fusion-release-closure-20261012-final`，NSIS 与 ZIP 的[静态校验](../dist/fusion-release-closure-20261012-final/verification.json)、[SHA-256 清单](../dist/fusion-release-closure-20261012-final/SHA256SUMS.txt)和[隔离三阶段检查](../dist/fusion-installed-verification/closure-final-package-smoke.json)均通过。最初 level 9 压缩人为停止以缩短构建等待，原日志和[重试说明](../dist/fusion-installed-verification/closure-final-compression-retry.json)保留；使用同一已验收载荷以 level 1 重建 NSIS 的构建退出 0，ZIP 保持原内容。静态校验未独立抽出 NSIS 嵌套载荷；实际安装后的关键文件哈希核对另行通过。安装器为**未签名内部候选包**。

此前实际成功的包是 `fusion-release-closure-20261012-nsis-fix`，不能混用两者哈希。用户不需要寻找 Windows 解锁入口；本轮未绕过登录或安全验证。最终当前状态见[汇总回执](../dist/fusion-installed-verification/closure-final-summary.json)。
