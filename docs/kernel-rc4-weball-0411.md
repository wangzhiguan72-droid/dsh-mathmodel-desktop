# 内核 0.2.1-rc.4 与 Web 家族 0.4.11 适配（2026-10-28）

## 来源

- 官方内核 `@deepseek-ai/dsh@0.2.1-rc.4`（npm `next`，2026-10-26）。`latest` 仍是 rc.2；GitHub 最高 tag 为 `dsh-v0.2.1-rc.3`（`1f81c047`）。
- `@linxin666/dsh-web-all@0.4.11`（https://github.com/zhu1090093659/dsh-web ，tag `v0.4.11`），要求 `engines.dsh >=0.2.1-rc.3`。
- 第三方插件上游均无 rc.3+ 版本：auto-mode 已归档（最后 0.2.0）；better-browser 停在 0.3.6（2026-08）；model-fusion 0.2.8 的 peer 仍是 `<0.2.1`。因此三者都在本地适配。

## 内核闭包

host 安装后 298 个 `@deepseek-ai` 包统一为 rc.4。rc.2→rc.4 的类型差异只在 UI 会话/导航注释与新增 `dsh-client-ui-entry-customization`；Auto 与 Kimi 实际导入的 `dsh-llm`、`dsh-session`、`dsh-tools`、`dsh-working-directory` 运行代码逐字节相同。

## 适配改动

| 位置 | 改动 |
| --- | --- |
| `runtime/host`、`runtime/profile-web` | 钉到 rc.4 与 0.4.11，`dsh-typert-protocol` override 同步 |
| `plugins/dsh-mathmodel` | 白名单、peer、typert 协议加 rc.4；修正过期的 Typert 调用数断言（rc.2 实测也是 25） |
| `plugins/dsh-auto-mode` | 精确版本门加 rc.4；实时工作目录守卫从“等于 rc.2”改为 rc.2/rc.4 都启用，避免在新内核上静默失效；重封 vendor 锁 |
| `plugins/dsh-better-browser` | `engines.dsh` 与 3 个 peer 加 rc.4；重封 vendor 锁 |
| `plugins/dsh-model-fusion` | `engines.dsh` 加 rc.4（宿主按 `engines.dsh` 判定，否则整包被跳过）；src/lib 未改，构建锁不变 |
| 构建补丁 | 0.4.11 聚合包只是加载器，不再内嵌 Git Graph、更新入口和终端：Git Graph 只校验独立包；更新入口只补 `dsh-update`；终端外链只补 `dsh-ssh`，聚合包若重新内嵌终端则失败关闭 |
| 健康门 | 0.4.11 删除了 `/api/dsh-web-all/rows`；升级启动、打包验收、安装后核验改读 plugin manager 清单，按实测 22 个必需行 + 3 个可选行判定 |

## 验证

- 桌面测试 286/287 通过，1 项跳过（只在装有 0.4.7 聚合包时有意义）。
- 数学建模插件默认测试 171/171，环境测试 5 通过、2 项跳过（针对旧内核）。
- 全新 home 实际启动：25 行家族中 23 行 active（ssh、skill-explorer 默认关），0 降级，日志无导入/版本/跳过错误，24 个预设无损坏。
- 用户真实 profile 副本演练：0.1.7 种子触发 reseed，Fusion、两种 Auto、Kimi、数学建模全部 active，健康门通过，24 个预设无损坏。原 profile 未改动。

## 未完成

- 未打安装包、未运行 `verify:win`、未覆盖安装本机，桌面版本号仍是 0.1.7。
- 未做 Kimi 浏览器真实导航、付费模型对话等在线验证。
- `test:skills` 有 1 项既有失败：共享技能目录里的 `claude-vision-skill/SKILL.md`（2026-09-30）与断言文案不符，与本次内核无关。
- 回滚：旧 host/profile/staged 运行时在 `runtime-backup-rc2-047/`。
