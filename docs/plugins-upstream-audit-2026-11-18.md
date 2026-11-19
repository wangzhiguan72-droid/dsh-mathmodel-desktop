# 交接与协作插件选择性更新（2026-11-18）

## 结果

实际桌面版仍为 0.2.0，内核仍为 0.2.1-rc.5。源码、构建输入、staged 种子、实际安装种子、活动 profile 和用户本地插件源已同步以下选择性更新。没有重装内核或覆盖用户会话、凭据、预设配置和 Fusion SQLite 状态。

| 插件 | 更新前 | 联网核实的上游 | 本次采用 |
| --- | --- | --- | --- |
| Fusion | 0.2.8，实际为 28125d8 基线加本地注入修复 | 0.2.11 / 8f974287 | 0.2.11+mathmodel.1；择取 7 个 Host 源文件及对应产物，保留客户端注入 |
| Agent Teams | 0.1.27 加 rc.5 适配 | 0.1.30 / 4354b0f6 | 0.1.29+mathmodel.1；采用协作可靠性修复，保留精确兼容边界 |
| Context | 0.78.2 | npm 0.85.1；main 另有 9e221195 | 0.78.2+mathmodel.1；只借鉴注册参数透传与工具归属修复 |
| Auto Mode | 0.2.0 加本地 rc.5 适配 | 0.2.0，deprecated / archived | 保留；没有可借鉴的新维护版 |

上游内核 `latest=0.2.2-rc.1`、`next=0.2.2-rc.3`。本次插件仍适配当前 rc.5，未把内核迁移混入插件热修。0.2.2 的子代理树接口变化需要单独迁移与验证自建交接层，不能只放宽版本白名单。

## 保留与借鉴的边界

自建 `delegate`、角色路线、写入互斥、结构化回执、`handoff_ledger` 和 Workbench 门禁保留。它是当前任务流程的交接协议；Fusion 提供 Lead/Sidekick 双模型流程，Teams 提供成员、任务依赖和消息协作，Context 提供上下文可视化。三个第三方插件不能替代该协议；Fusion 还需选择相应模型入口才会执行其流程，不能仅因全局加载便声称每次任务都使用了它。

Fusion 的有价值差异是首轮工具注册先于快照、按真实目录项验证空范围、避免规划回复被当成实现完成、继续任务保留输入边界、模型切换后终止旧路由保活，以及相应兼容修复。上游客户端仍缺 `sessions` / `remote` / `remote.session` 双层注入，所以本地客户端源码和构建结果保持原修复。兼容范围明确包含 rc.5 并排除未经验证的 0.2.2。

Teams 选取 v0.1.29 的输出上限失败结算、备用模型恢复事务、按会话隔离活动轮询、后台审计，以及文件内容复核。0.1.30 主要为新内核增加树接口；本次不引入。没有采用上游 DSH peer `*` 策略，保留 rc.5 的精确适配声明。源文件与预构建分发文件一起保留，便于后续复核。

Context 没有跟随 209 个源文件的大范围 UI/数据层重写，也没有移除“全部时间”筛选。仅移植 `735dee19` 的完整参数与 receiver 转发，以及 `9e221195` 的 traced receiver 工具归属判断；后者当时尚未发布到 npm。新增可审查的 attribution 源文件，并对原 minified Host 产物做两处定点修改。

当前仍保留 Context 旧数据层：大型 Windows 会话冷折叠可能阻塞宿主；上游对应 worker / cache 修复依赖更大重构，本次没有声称解决此问题。自建交接守卫对终端命令写文件的既有覆盖限制也未改变。

## 更新前备份与部署

在修改任何插件前，已复制并逐文件校验 40 组备份，合计 2,048 个文件、36,632,450 字节：

`dist/plugin-upgrade-audit-20261117/backup-receipt.json`

备份涵盖原插件源码/产物、构建与安装种子、活动 profile 插件、用户本地插件源、相关清单/锁文件、构建脚本，以及 Fusion 数据库。它是本次插件更新范围的备份，不是全程序、全部会话或个人数据快照。

部署收据为 `dist/plugin-upgrade-audit-20261117/deployment.json`，记录 1,186 个文件写入的前后 SHA-256。Fusion 三个 SQLite 相关文件与备份逐字一致。安装目录仅替换插件分发文件及相应依赖/锁记录；桌面壳、内核、活动 profile 的 YAML 配置没有更换。新建 Context 本地源，活动依赖改为 `file:..\..\plugins\dsh-context`，后续重建与包管理安装会沿用本地补丁。

需要回退时，应先退出本机数学建模版，再按备份收据恢复对应插件目录和清单/锁文件，并按部署收据删除原先不存在的新增分发文件。不要恢复其他会话目录，也不要用旧版发行包覆盖全部用户目录。本次未进行故障注入式回滚演练。

## 构建保留与验证

`scripts/stage-reviewed-plugins.mjs` 与 `scripts/reviewed-plugin-lock.json` 将 Teams/Context 的已审查源文件、产物及 worker 入口封存；构建时刷新，打包前核验。Fusion 沿用原有 source/lib lock。封存哈希证明当前分发文件完整性，不证明已用本机工具链从全部源码重建。

| 验证 | 结果 | 证据 |
| --- | --- | --- |
| 新增行为回归，更新前/后 | 原版 5 项失败；修复后 5 项通过 | `regressions-before.log`、`targeted-tests.log` |
| 插件适配、迁移、staging、Auto 兼容 | 23/23 | `targeted-tests.log` |
| Teams 输出限制、回退、轮询、审计及兼容分支 | 79/79 | `teams-tests.log` |
| 桌面完整回归 | 307 项，305 通过、2 跳过、0 失败 | `desktop-tests.log` |
| 自建交接与 Workbench | 33/33 | `handoff-tests.log` |
| 分发 JavaScript 语法 | 43 文件通过 | 本轮实际执行 `node --check` |
| pnpm 冻结锁文件校验 | 通过，供给策略 86 条目通过 | `lock-validation.log` |
| 实际安装程序隔离启动 | 三个目标插件 active；所有已启用插件无非 active 项；WebAll 降级为空 | `installed-smoke.json` |
| 前端重载 | 0 个捕获到的 Runtime 异常；页面渲染；任务/Workbench 预设无损坏 | `installed-smoke.json`、`installed-smoke.png` |

证据日志均位于 `dist/plugin-upgrade-audit-20261117/`。首次 Teams 复测缺少上游测试 worker 夹具，补齐夹具后 79 项全过，没有因此更改产品逻辑。pnpm 离线校验首次因缺缓存元数据失败，改为联网冻结校验后通过，没有安装新依赖或执行包生命周期脚本。

隔离启动使用实际安装的 EXE 与空白 HOME/DSH_HOME，没有复制用户凭据或发送模型请求，完成后正常退出。它验证载入、配置及页面启动，不代替真实模型的完整消息→工具→响应交接实验，也不证明所有插件页面与外部服务功能均完成端到端测试。本轮未重打或发布公开安装包。

最终复核 1,186 个已部署文件哈希全部一致，源码与种子封存校验通过，未发现安装程序目录下的残留测试进程。自动审批拒绝了删除本轮生成的 `.pnpm-store` 缓存目录（仅返回 `blocked by policy`）；该缓存保留，没有重试删除，也不影响更新结果。

## 上游证据

联网版本再次核实于 2026-11-18（北京时间），版本渠道未变。隔离上游 checkout、原始 npm 元数据及核对过 SHA-512 的 tarball 位于 `D:/deepseek harness/_upstream-20261117-audit/research/`。

- [Fusion 真实基线到最新源码差异](https://github.com/aa2246740/dsh-model-fusion/compare/28125d823886b1fa258fb8d71c3f260791cd5df5...8f97428754cd950a2aa8abf31e36d1409264cb9e)
- [Teams v0.1.29 修复说明](https://github.com/NanmiCoder/dsh-agent-teams/blob/v0.1.29/release-notes/v0.1.29.md)；[v0.1.30 新树接口说明](https://github.com/NanmiCoder/dsh-agent-teams/blob/v0.1.30/release-notes/v0.1.30.md)
- [Context 注册参数修复](https://github.com/bowenliang123/dsh-context/commit/735dee19a4bab9feffbcac3748ca7fd3e65bc102)；[工具归属修复](https://github.com/bowenliang123/dsh-context/commit/9e221195ac7c02cff9a21311dda6d61f50cf50d3)
- [Auto Mode 退役提交](https://github.com/NanmiCoder/dsh-auto-mode/commit/907d663b7d65e3fcd9f328c598dee03772cac18b)
- [DSH registry 版本渠道](https://registry.npmjs.org/@deepseek-ai%2Fdsh)
