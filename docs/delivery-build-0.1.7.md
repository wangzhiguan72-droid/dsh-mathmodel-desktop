# 0.1.7：DSH 0.2.1-rc.2 与 Kimi 浏览器接入

## 目标与来源

用户最初指定 alpha.4，随后明确要求最新版。2026-10-17 对 npm 与 Git tag 核对：最高已发布内核为 `0.2.1-rc.2`，Git tag `dsh-v0.2.1-rc.2` 对应 `687f282e8625c6b8d11ff58211a90524be2e4317`。npm 的稳定标签 `latest` 仍是 `0.2.0-rc.2`，`next` 指向 `0.2.1-rc.2`，因此本版精确固定版本而不依赖浮动标签。

- 官方内核：https://github.com/deepseek-ai/deepseek-harness/tree/687f282e8625c6b8d11ff58211a90524be2e4317
- Kimi 官方 Windows 安装程序：https://cdn.kimi.com/webbridge/install.ps1
- Kimi 官方浏览器桥二进制：版本 v2.0.24，SHA-256 `2a904cacff1ae94e8424e6746dc6ecb421d9073f955d9661fa8581ab65c0a973`。源码树 `scripts/kimi-daemon-lock.json` 与包内 provenance 记录来源，构建校验固定缓存。
- DSH 社区适配插件：`@dsh-external/dsh-better-browser@0.3.6`，上游 https://github.com/titanwings/dsh-better-browser ，固定 commit `506493224a21510c3f9cc7329a17e84af20879dc`。本地补充精确 DSH 兼容声明，发行文件由 `scripts/kimi-browser-vendor-lock.json` 校验。

这是 Chrome/Edge 真实浏览器控制，包含 13 个 `webbridge_*` 工具，不是 Windows 全桌面操控，也不会更换推理模型为 Kimi。浏览器扩展需由浏览器载入；本机已有官方扩展，已确认连接。安装官方守护程序时使用 `-NoSkill`，未改动其他 Agent 的技能目录。

## 适配

1. 内核闭包中 297 个 DSH 包核对为同一 `0.2.1-rc.2`。显式补齐官方允许范围内 npm 默认解析到旧版的 peer 包；补入 profile 显式使用的 hooks bridge，避免安装了却不能解析。
2. Web 家族升级 0.4.7，适配 Git Graph、桌面更新入口和终端外链的已审查补丁。保留旧构建目录，使用干净 profile 安装，避免旧顶层 hoist 目录遮挡新版。
3. 数学建模插件更新协议和兼容声明，真实内核 API 契约验证通过。16 项任务能力预设识别新标准工具目录；已知旧托管区块经指纹核验、备份后迁移，未知用户改动仍拒绝覆盖。
4. 专职预设保留数学建模、生图、PPT 角色内容，移除新版已不再提供的 `{{cwd}}` 模板；已知旧区块同样备份迁移，保留追加配置。
5. Fusion 由已移除的子代理 start/startContinuable 接口迁移到 startActivation，采用预留 child identity、对应结果投递和定向释放，scope 保留 Worker 工具上限。源码与 vendored lib 镜像修改，并更新完整性锁；这仍不是上游完整 TypeScript 工具链重编译证明。
6. Sandbox Auto 本地兼容分支增加精确 0.2.1-rc.2，按当前 workingDirectory 服务而非历史 header.cwd 判定相对路径，审查前确保目录恢复；缺服务时失败关闭。它仍是停止维护的第三方插件，和官方 Auto review 不等价，默认权限保持 workspace-write。
7. Kimi 适配插件作为可管理 bundle 内置，剔除开发依赖与链接，打包包含官方桥程序。桌面启动复用已运行的桥，未运行时尝试启动随包二进制；未连接扩展时明确记录等待状态。

## 验证与交付状态

源码回归：桌面 269/269、数学建模插件 163/163、迁移/权限/新 API/Kimi 专项通过。新包验收严格拒绝插件导入失败、兼容跳过、导出缺失与降级。最终安装和快捷方式验收以 `dist/install-0.1.7-verification/` 收据为准；安装包与哈希位于 `dist/release-0.1.7-final/`。

Kimi 已执行真实、独立标签组的 `navigate(https://www.example.com/)` 与 `snapshot`，返回 Example Domain；仅调用本地浏览器桥，无付费模型请求。结果保留在 `dist/kernel-latest-work/kimi-live-proof.json`。用户浏览器标签未自动关闭。

本版无远端发布。成本、缓存收益、模型质量与完整安全审计不属于本次安装验收结论。

## 最终本机交付

0.1.7 EXE 与 ZIP 均已完整验证并实际覆盖安装，退出码 0。41,385 个安装文件逐个 SHA-256 与成品相同，94 个受保护会话/工作区/凭据/设置文件在安装前后及启动后保持原样。两个数学建模桌面快捷方式均指向 0.1.7.0 主程序，通过原快捷方式实际启动，运行内核为 0.2.1-rc.2，数学建模、Fusion、两种 Auto、Kimi 均 active，16 种任务预设完整，零插件降级。

真实浏览器 UI 验证 Fusion 设置与两种 Auto 可见，前端异常为 0。新版设置入口位于侧栏底部“更多 → 设置”。已安装 Kimi 适配器的 13 项工具可用，实际导航后页面快照含 Example Domain。验证中 Chrome/Edge 扩展连接曾交替，出现 debugger 未附着、超时；重连后最终快照通过，记录保留在 `kimi-installed-tools.json`，不据此承诺浏览器桥永不掉线。

| 安装包 | SHA-256 |
| --- | --- |
| dsh-mathmodel-desktop-0.1.7-win-x64.exe | 32b576b3f6648034ae52dd2032f33858b48e74b73402ba928d390750c187b799 |
| dsh-mathmodel-desktop-0.1.7-win-x64.zip | 253b81bca2ea0f21b1e8b0072c24853c06a4dac20b34d26242d896147853dccf |

原始失败候选和空缓存安装器已隔离，不作为交付包。最终交付目录为 `dist/release-0.1.7-final/`。
