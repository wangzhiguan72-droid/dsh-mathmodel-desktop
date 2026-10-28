# 2026-10-22 启动诊断与模型目录恢复

对象为本机 MetaMath Harness / DeepSeek 数学建模版 0.1.7，独立官方 DeepSeek Harness 未修改。

## 模型目录故障

17:22 启动时 `llm-pi-ai` 的配置校验失败，错误指向 `providers.magpie.models[33].reasoningEfforts`。当前内核仅接受 `off/minimal/low/medium/high/xhigh/max`，新增 Magpie 列表有 3 个 `ultra` 键和 4 个 `none` 键。整个自定义适配器拒绝激活，模型目录只剩 DeepSeek 和 Fusion。

原有十组供应商、模型与凭据引用均仍在。备份原始 `cordis.patch.yml` 后，移除不支持的 ultra 别名，将 none 的公开键改成 off，同时保留供应商 wire 值 none。没有修改模型 ID、地址或凭据，也没有用旧备份覆盖当前配置。候选配置通过安装内核的 Config 校验，HMR 后真实模型目录恢复十组自定义供应商；重启后再次通过。

恢复包含 AAA-qianwen（qwen3.8-max/flash/27b）、aaa-glm、aaa-deepseek、wanzhao-gptzhuanshugui、wanhzao-gptzhuanshupianyi、晚照-破甲deepseek。只验收模型目录和适配器状态，没有发送付费模型测试请求。

原配置备份：`C:/Users/Administrator/.dsh-mathmodel/profiles/mathmodel/cordis.patch.yml.bak-provider-efforts-2026-10-22T09-31-50-034Z`。

## 启动耗时

现场进程记录：主程序 17:22:17，Host 17:22:21，学术检索 Python 17:23:53，页面进程 17:23:56。主要等待属于 Host 的插件树整体就绪；不能将此前约92秒都算给稍后才启动的 MCP。模型校验故障与该次长延迟之间没有因果实验证据。

启用临时逐插件探针后，未启用 Node 编译缓存的一次启动约21秒。预设为内核的 eager 注册，多组插件、预设与会话服务需完整加载；记录中的多个插件时长重叠，不能相加。缓存准备后的探针复测约13秒。

修复在 Host 启动环境中默认启用内置 Node 编译缓存，保留自定义缓存目录和禁用变量。缓存按本机 Node 版本与源码管理；预加载器在3/10/30秒主动flush，避免Windows结束进程树时尚未写入。缓存异常不阻止Host启动，不保持进程存活。没有关闭MCP/Skills/插件，没有更改默认模型。

桌面日志新增阶段耗时与ISO时间，保留Host原始token URL行供认证解析。正式安装壳第一次复测约47.9秒，随后一次日志累计14.650秒，Host等待13.118秒；最后一次独立正常启动累计30.276秒，Host等待27.221秒。因此只能确认已启用缓存并观察到重复启动改善，仍有明显波动，不能保证冷启动或系统繁忙时固定在15秒。

临时修改的官方bin.js已逐字恢复；永久修改仅为有备份的桌面壳启动代码、计时辅助模块和Host缓存辅助文件。仍为0.1.7，本次未升级内核。当前profile种子标记保持10月17日，未重新覆盖用户配置。

## 更新机制

今天检查前无新的应用内安装任务。现有最后成功更新收据是10月10日，当前0.1.7安装文件来自10月17日。自动检查在GUI就绪后启动，下载/安装需要界面确认；检查失败不等于安装成功。今天凌晨同一聊天执行过本机开关修复，该修改不是自动更新。

## 验收与证据

- 45项相关回归通过，覆盖键修复、缓存行为、启动时标、runtime、更新门禁与本地插件staging；相关脚本语法检查通过。
- 真实模型目录 `dist/startup-repair-20261022/model-recovery.json`，适配器active，无目录失败。
- 正常启动日志 `dist/startup-repair-20261022/final-startup.log`，累计14.650秒；最后一次30.276秒见 `last-startup.log`，最新模型目录复查见 `final-models.json`。
- 临时插件计时 `startup-timings.jsonl`、`cache-first.jsonl`、`cache-warm.jsonl`；均不含插件配置与凭据。
- 安装壳备份和部署校验 `dist/startup-repair-20261022/shell-2b6b03fe-4b73-470a-86a1-42970a8b3712/receipt.json`。归档中其他文件逐字比对不变。

复现：`node scripts/repair-provider-efforts.mjs`只检查，`--apply`备份后修复已知别名；新未知键拒绝改写。修复脚本不会打印供应商配置中的秘密值。
