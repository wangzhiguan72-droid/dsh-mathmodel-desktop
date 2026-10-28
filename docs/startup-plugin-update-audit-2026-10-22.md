# MetaMath Harness / DeepSeek 数学建模版核验（2026-10-22）

## 对象和版本

桌面两个快捷方式 `MetaMath Harness.lnk`、`DeepSeek 数学建模版.lnk` 均指向 `C:/Users/Administrator/AppData/Local/Programs/dsh-mathmodel-desktop/DeepSeek 数学建模版.exe`。独立的官方 DeepSeek Harness 安装未修改。

本机桌面 0.1.7，内核 `@deepseek-ai/dsh@0.2.1-rc.2`，WebAll 0.4.7，数学建模插件 0.1.1。实时核对 [npm 官方元数据](https://registry.npmjs.org/@deepseek-ai%2Fdsh)，`latest`、`next` 与最高已发布版本均为 0.2.1-rc.2；[对应 GitHub 提交](https://github.com/deepseek-ai/deepseek-harness/tree/687f282e8625c6b8d11ff58211a90524be2e4317)与 tag 一致。这是发布候选版，不称为无预发布后缀的稳定版。本次未更换内核，无新版本迁移。

## 启动实测及性能边界

当前正常安装的本轮首个启动，桌面启动计时至 GUI loaded 为 **16.027 秒**，其中 Host 等待 **14.844 秒**、页面加载 **0.598 秒**。此前当天真实日志有 83.615、96.861、117.809 秒的启动，等待主要在 Host 插件树就绪。不能只用重复启动的较短样本声称冷启动已经解决。

保留真实 profile、全部插件与模型配置，用单独空 Node 编译缓存目录进行诊断：Host 至 ready 加 500ms 为 30.085 秒；同一目录再次启动 34.995 秒；原有缓存目录 31.188 秒。这些样本带逐插件计时，且最初探针含定时 flush，不能与无探针的 GUI 启动直接对比，也不等于重启 Windows 后的磁盘冷启动。移除探针额外 flush 后的诊断样本为 28.035 秒，原有 flush 实际只占 13ms 和 0ms，未证明它是主要瓶颈。

同时运行安装器全量回归时，GUI loaded 为 79.652 秒、Host 阶段 69.160 秒；停止回归后的另一启动仍为 81.136 秒，因此不能将所有延迟简单归因于回归负载。直接启动相同 Host、使用现有缓存且不装插件计时探针的一次样本为 23.262 秒。多个插件生命周期重叠，不能累加为总耗时。

进一步在桌面真正派生的 Host 上临时采集 CPU profile：实际 Node 为 v24.20.0、缓存目录正确、没有禁用缓存、没有 NODE_OPTIONS 干扰。这次 GUI loaded 为 34.161 秒。采样中的 internalModuleStat、lstat、readFileUtf8、existsSync 分别约 3.726、2.217、1.834、1.586 秒，Cordis get 约 1.541 秒，spawnSync 约 1.510 秒；ESM/CJS 编译函数自身采样合计约 0.527 秒。提示剩余开销主要涉及模块解析、文件 I/O 和 eager 插件初始化，而不是仅源码编译。该样本并非最慢启动的 CPU 记录，不能据此证明 80～118 秒波动的全部因果。原始记录为 `actual-host.cpuprofile`，摘要为 `cpu-summary.json`。临时启动探针随后撤除，缓存预加载文件与备份逐字一致。

现有优化仍有效配置：Host 启用 Node 编译缓存、按 Node 版本区分缓存、保留显式禁用开关；缓存写入失败不阻断启动。自动更新检查在 GUI loaded 后触发，不在首屏等待链上。此次没有关闭 MCP/Skills/插件、降低模型或添加常驻预热进程，也未调整杀毒保护。现有测量没有提供进一步无损提速的可靠证据，因此未实施猜测性优化。后续值得单独评估的是内核 eager 插件初始化与文件读取；只有证明延迟初始化不会影响工具和预设完整性后才能采用。

最终部署后的无探针正常启动为 **32.674 秒**，Host 阶段 31.117 秒，页面加载 0.911 秒（`delivered-startup.log`）；这仍不能证明冷启动已稳定提速。最终真实健康检查再次通过（`delivered-health.json`），随后结束本轮创建的隐藏测试实例，不留后台诊断进程。

证据：`dist/audit-20261022/startup-stages.json`、`host-*-result.json`、`host-*.jsonl`。计时仅记录阶段、插件名和耗时，不记录插件配置或凭据。

## 插件完整性

- 实际在线 pluginManager：242 个条目；数学建模、Fusion、WebAll、Auto、Kimi 均 enabled/active；失败 0。
- `/api/dsh-web-all/degraded` 返回 HTTP 200，降级 0；实际 shell 子插件 13 项。
- 数学建模安装文件：34 个 JS 全部语法检查通过，8 个声明入口均存在。
- 与原 0.1.7 发行包的 4 处差异对应此前 10 月 22 日任务工具开关热修复；活动 profile、安装种子和工作区 staged runtime 三处相应文件哈希一致。
- 数学建模插件默认测试 171/171 通过。两项旧环境断言已修正：Typert 新增接口后为 25 项；Profile 按 YAML 结构区分插入、覆盖和预设内 ID。实际安装内核与 profile 的相关环境测试 3/3 通过。

没有发送付费模型请求。因此以上证明载入、接口、文件和测试层面的健康，不代表所有供应商生成、生图、论文编译与浏览器外部交互均完成端到端实测。

## 一键更新修复与渠道

发现并修复真实缺陷：`src/runtime.cjs` 的 `hasCompleteWebFamily` 只接受 0.4.5/0.3.23，而当前升级启动确认传入 0.4.7，导致健康新版被误拒绝。依据随包 0.4.7 的 `/rows` 和配置，显式添加对应规则：移除已退役 model-capabilities，识别 liangshen 与 Windows 的 win-bash，保留指定可选项。未知版本、缺失、重复和多余插件仍拒绝。

先复现新测试失败，再修复；相关 runtime、健康门及更新启动测试 27/27 通过。后续保留本项目既有的 liangshen 可选 UI 规则，用户关闭它不会被误判缺失。部署后真实运行清单通过新健康门，失败与降级均为 0（`dist/audit-20261022/final-live-health.json`）。

安装壳仅替换 `src/runtime.cjs`，其余 21 个归档文件逐字一致；桌面版本仍为 0.1.7。部署前原壳完整保存在：

`D:/deepseek harness/dsh-mathmodel-desktop/dist/audit-20261022/update-health-50dab7ab-fdab-457c-b0aa-768b3573c562/app.asar.before`

最终部署收据：`dist/audit-20261022/deployment.json`；首轮收据另保留为 `deployment-first.json`，两次壳均有原件备份。未覆盖用户 profile、凭据和会话，未重新播种 profile；原内核与全部插件保留。

[默认更新清单](https://github.com/wangzhiguan72-droid/dsh-mathmodel-desktop/releases/latest/download/desktop-update.json)在线返回 HTTP 200，默认 `autoCheck=true`，无用户覆盖设置。实际窗口中更新按钮唯一且可见，更新桥三个方法存在，状态为 `current`、版本 0.1.7，7 项检查通过（`update-live.json`）。线上最高桌面版目前仅 0.1.3，本机 0.1.7 不降级。未来新内核需要整包适配与发行；此按钮不会绕过插件验证直接更新 npm 内核。本次没有更高桌面发行版可供下载、安装验证，也没有发布新的公开发行包。

旧 `last-successful-update.json` 为 10 月 10 日的 0.1.3，旧目录已不存在。对当前版本的只读回滚预检明确拒绝版本不匹配，不能把它当作当前可用的完整回滚点。现有更新策略保留旧程序目录，在会话格式变化时备份数据；同格式更新的完整配置恢复仍需额外一致快照。本轮原壳备份只用于撤销此次单文件壳修复，不冒充全程序和个人数据快照。

## 回归状态

全量桌面回归首轮 283 项，282 通过、1 项旧版预设迁移测试失败。根因为测试将会变化的当前安装目录当作固定的 0.1.6 旧版：当前安装与新运行时已经相同，正确的幂等结果不应发生迁移。现从保留的 0.1.6 发行版提取固定旧托管块，其哈希精确匹配产品现有迁移白名单 `732f70039fac7f21dbc6557c56fe5e102ede059673539399665ce036d9290af1`；没有修改白名单或迁移产品逻辑。

最终定向回归：更新/启动 69/69、迁移与最终健康门 33/33、插件默认 171/171、真实环境 3/3，零跳过。对应日志为 `targeted-tests.log`、`migration-health-tests.log`、`plugin-tests.log`、`environment-tests.log`。全量首轮的唯一失败已有通过的针对性复测，未重复耗时的全部安装器测试。

源码工作区本来已有大量未提交修改，本轮未提交、重置或覆盖这些工作。改动范围为 0.4.7 健康门、对应回归与旧断言修复、当前核验文档，以及有备份的安装壳修复。
