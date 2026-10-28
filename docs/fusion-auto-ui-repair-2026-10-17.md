# 0.1.5 本机 Fusion 设置与 Auto 权限修复

后续已将本修复纳入 0.1.6 安装包，并完成本机覆盖安装及桌面快捷方式启动验收，见 [0.1.6 交付记录](delivery-build-0.1.6.md)。下文保留 0.1.5 热修阶段的历史状态。

本记录针对已安装的 0.1.5，修复已应用并重启本机桌面应用。没有覆盖或重做 `dist/release-0.1.5/` 原始 ZIP/NSIS；使用该旧安装包重新安装后，须重新部署本修复。源码与 staged runtime 已同步 Fusion 修复，后续构建会包含它。Sandbox Auto 为本机额外安装的可选插件，不属于原始安装包。

## Fusion

实际 Host 向新页面提供 Fusion 客户端，新的页面可显示设置入口，原截图中入口缺失与旧页面状态相符。另在真实浏览器中复现兼容错误 `cannot get property remote.session without inject`：Fusion 的输入栏贡献调用 rc.2 `modelDirectories.directoryFor()`，该方法通过调用者的 Cordis 作用域访问 `sessions`、`remote.session`，而 Fusion 没有声明这些依赖。修复补齐根作用域及模型目录注入作用域的依赖，并同步 `src/client/index.ts` 与 vendored `lib/client.js`。

`tests/fusion-client-scope.test.mjs` 先复现缺少注入再修复，覆盖严格作用域、目录访问、设置注册与输入栏注册。结合迁移、staging 回归共 7/7 通过。prebuilt lock 已更新，保留“非完整源码编译证明”的来源说明；未声称恢复上游完整构建工具链。

修复部署到源码 staged runtime、已安装应用的种子和当前活动 profile。原文件在 `dist/fusion-auto-ui-repair/` 内有备份。重启后打开“设置 → Fusion”，已实际渲染 Lead 和 Sidekick 配置页，浏览器错误数为 0。

## Auto 权限

此前 RPC 的官方 Auto `installed=false` 表示组合包未挂载，不是物理文件缺失。官方 `@deepseek-ai/dsh-experimental-auto-review@0.2.0-rc.2` 已经随安装包提供，本次通过官方插件管理服务启用；组件 `include:auto-review` 活跃，权限目录出现 `auto`。

第三方 `@nanmicoder/dsh-auto-mode@0.2.0` 是不同模式。本地已归档源码明确支持宿主 0.2.0-rc.2，预构建输入输出校验通过，五项直接解析的宿主包版本一致。标准插件安装首次因现有 pnpm `virtual-store-dir-max-length` 不匹配失败，并恢复包清单。随后使用本地已验证预构建文件进行有备份的离线部署，在 profile 清单添加本地包依赖，并通过官方 `setBundleEnabled` 挂载；没有重建既有依赖。`include:auto-permission-mode` 活跃，权限目录出现独立 `sandbox-auto`。

两者分别为：

| 菜单 | 权限身份 | 文件边界 |
| --- | --- | --- |
| Auto review EXP | `auto` | 官方实现使用 `danger-full-access`，每项工具由模型授权审查 |
| 沙箱自动审批 | `sandbox-auto` | `workspace-write + ask`，采用归档插件的策略 |

默认权限保持 `workspace-write`，没有批量修改用户会话权限。仅让菜单可选，不代表用户已选择相应模式。普通自定义工具在归档插件中可能直接放行；不能将本次安装验收表述为完整安全审计。

对实际安装的 Sandbox Auto 预构建模块执行 5 项不产生工具副作用的策略检查：普通项目读取/写入允许，DSH_HOME 凭据覆盖和根目录删除拒绝，持久终端要求审查，全部通过。该检查不是模型分类、真实沙箱执行或全面审批行为验收。本次没有付费模型请求。

## 重启后验收

重启前确认没有运行任务，重启后 Host 可达。真实浏览器打开同一已安装 Host：Fusion 配置页、官方 Auto、沙箱自动审批均可见，未发现页面异常。桌面主窗口重新出现。截图和收据：

- `dist/fusion-auto-ui-repair/fusion-settings.png`
- `dist/fusion-auto-ui-repair/permission-menu.png`
- `dist/fusion-auto-ui-repair/browser-verification.json`
- `dist/fusion-auto-ui-repair/sandbox-policy-check.json`
- `dist/fusion-auto-ui-repair/installed-state-before-restart.json`
- `dist/fusion-auto-ui-repair/regression-tests.log`

官方 Auto 和第三方 Sandbox Auto 仍是两套不同策略；第三方版本已停止维护。启用插件不会自动把任何现有会话切换到 Auto。
