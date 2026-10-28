# 0.1.6 本机与安装包统一交付

2026-10-17：当前源码、Windows 安装包、本机安装和数学建模桌面快捷方式已统一至本地交付版 0.1.6。实际通过桌面“DeepSeek 数学建模版”快捷方式启动验收，不再依赖 0.1.5 安装后的手工补丁。未发布远端 GitHub 版本或更新清单。

## 安装包

目录：`dist/release-0.1.6/`。

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| dsh-mathmodel-desktop-0.1.6-win-x64.exe | 332527353 | 0754744457e4fe59b747dfee6bffe3a047db406ff8760d631e36c63f538bf8fb |
| dsh-mathmodel-desktop-0.1.6-win-x64.zip | 417250426 | 3bbb51e6a3503435c284fc81f2c935fca70e203ef2168b3e5990f5b9edbcae17 |

包含本轮 Fusion 客户端作用域修复、官方 Auto review 组合包和独立 Sandbox Auto 0.2.0 预构建发行文件。Sandbox Auto 已随包物理复制并校验哈希，安装后的依赖声明不再指向本机源码绝对路径；构建输入中的本地依赖另有离线 lockfile。主程序版本为 0.1.6，内置官方 Harness 核心仍为 0.2.0-rc.2，两者版本含义不同。

默认权限保持“工作区内修改”。两项 Auto 仅成为可选权限模式，未批量切换现有会话。第三方 Sandbox Auto 为已停止维护的固定 0.2.0 版本，其策略与官方 Auto 不等价。Fusion 的 source/lib 兼容补丁均已同步并更新预构建锁，但仍不将其表述为上游完整工具链重编译的证明。缓存、成本和质量收益不属于本次安装验收结论。

## 验证

- 桌面完整测试 252/252、数学建模插件 163/163、最后定向回归 26/26 通过，无跳过。
- 成品与源码核对：19 个应用文件、36 个数学建模文件、Fusion 全部发行资产、Sandbox Auto 全部发行资产通过，记录 296 项源码/构建输入。
- 空白用户目录首次启动、重启、迁移目录后启动全部通过；每阶段均核对 Fusion、两项 Auto、16 种能力组合、默认权限和零插件降级，没有发送模型请求。
- ZIP 全部 CRC、关键文件字节比对、NSIS 外层及独立抽出的内层全部 CRC 通过。完整清单 31,802 个文件；ZIP 比 NSIS 少安装器专用的 `resources/elevate.exe`，为已明确允许的唯一差异。
- 使用本次 EXE 真实覆盖安装，安装器退出码 0，Windows 安装记录及程序文件版本为 0.1.6 / 0.1.6.0。
- 本机安装的 31,802 个文件逐个 SHA-256 与已验证解包成品相同，主程序 app.asar SHA-256 为 `72dadcd026dcf0f86bd1680b353e443d4f6b5f53fea9ab059229f7e77b39ebbc`。
- 原有会话、工作区记录、凭据、设置及 hooks 等 94 个受保护文件在安装后与启动后仍字节一致。安装前完成完整数据快照与摘要校验；私人备份不属于发行资产。
- 桌面“DeepSeek 数学建模版”和“MetaMath Harness”均指向 `C:/Users/Administrator/AppData/Local/Programs/dsh-mathmodel-desktop/DeepSeek 数学建模版.exe`，清除旧启动脚本参数并保存新图标、工作目录与版本说明。独立的“DeepSeek Harness”快捷方式未修改。
- 从原桌面数学建模快捷方式启动：数学建模、Fusion、官方 Auto review、Sandbox Auto 全部 active；16 种能力组合完整，零降级；权限目录同时含 `auto` 和 `sandbox-auto`，默认仍为 `workspace-write`。

发行校验与空白用户目录收据在 `dist/release-0.1.6/`；本机安装、快捷方式、数据备份及实际界面收据在 `dist/install-0.1.6-verification/`。
