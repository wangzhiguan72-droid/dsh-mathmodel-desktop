# Windows rc.3 分发验证

以下保留初轮分发验证的历史结果。Git Graph 自动隔离和 NSIS 实际安装、卸载的后续修复与实测见 [专项验证记录](windows-git-graph-nsis-followup.md)，最新产物位于 `dist/rc3-final-verified`。

2026-10-04，延续测试夹具与 rc.3 交接工作。本轮范围为完整 Profile、运行时重建和 Windows 分发；不升级 0.2.0，不新增个人预设。

## 本轮修改

- 分发 Profile 使用受版本控制的 `build/profile.cordis.patch.yml`。hooks 与 skills 通过 `dshHomePath` 解析，避免指向构建者账户；已有用户 patch 在 reseed 时仍保留。
- 实际迁移测试复现 reseed 过滤过宽：插件内部的 `cordis.patch.yml` 也被跳过，导致官方 Profile 无法启动。过滤现在只作用于 seed 顶层的用户 patch 和备份；回归先复现失败，再同时验证用户配置保留与插件 overlay 更新。
- 归档与解包目录的比对进一步发现：Electron 的递归 `rmSync` 会沿 framework junction 删除原安装目录的 84 个共享模块文件；仅使用 `original-fs.rmSync` 仍能复现。重新播种改用原生 `lstat` 检查，链接直接 unlink，实际目录逐层清理；真实 Electron 回归先 RED 后 GREEN。包级检查新增原 host 共享文件的 SHA256 前后比对，不能仅凭迁移后的应用能启动而判定安全。
- NSIS 自定义卸载不删除 Harness 个人目录，明确设置 `deleteAppDataOnUninstall: false`。回归先复现原删除指令，再验证新策略；没有执行实际安装或卸载。
- pnpm 安装设置 `CI=true`，避免非交互构建遇到重建确认后跳过安装。显式设置 hoisted 布局与锁文件对应的 peer 策略；配置或锁文件不匹配时直接报错，不反复重试同一错误。
- host 残留的根 `.pnpm` store 含 498 个旧包目录和依赖 junction，解引用复制会展开成冗余文件树。暂存仅过滤这一根目录，保留安装源、活跃包链接目标及嵌套依赖；回归先复现冗余 store 入包失败，再验证正确过滤。
- 官方 Windows cloudflared 下载保存在被忽略的 `runtime/cache`，Profile 重建可复用，避免暂存替换后被网络超时阻断。此次复用本轮首次官方下载的 2026.9.3，SHA256 为 `f096265ec2fcbe9bb6e2d64268db167ced3fcbb83d894bdb9e2fcdb26f2ea7e2`。
- 本地被忽略的 `runtime/profile-web/package.json` 补上锁文件已有的 `dsh-better-sidebar: 0.19.1` 覆盖声明，没有更改该依赖版本。`runtime/` 与 `resources/` 仍是本机构建输入和产物，不将依赖闭包强制纳入 Git。
- `DSH_DESKTOP_USER_DATA` 在 Electron ready 和单实例锁之前隔离 userData、sessionData、logs、crashDumps。`DSH_DESKTOP_HEADLESS=1` 支持后台验证；普通启动行为不变。
- 新增实际解包 EXE 验证命令与只读产物检查。验证自行生成技能卡片、workspace 和空 hooks，只向子进程传系统及临时目录环境；通过 OS 身份核对本次进程树，退出时清除临时认证 URL。
- 进程身份采集失败的异常分支使用原始 `ChildProcess` 句柄退出并等待结束，不按未核验的数字 PID 终止进程。
- 验证脚本同时识别退出码与信号退出；进程树按 PID、父 PID 和创建时间核验，父子创建时间也需符合先后关系。退出等待按身份匹配，失败清理只终止逐个核验的 PID；诊断保留原始错误并隐藏认证地址，清理异常不会遮住启动异常。

`original-fs` 是 [Electron 内置的原始文件系统接口](https://www.electronjs.org/docs/latest/tutorial/asar-archives#treating-an-asar-archive-as-a-normal-file)，没有引入新依赖或切换全局 `process.noAsar`。上述递归删除副作用是在 Windows/Electron 44.1.1 中的本轮实测；同一个真实 Electron 回归也验证外部 profile/profiles junction 在写入前被拒绝。

## 复现命令

```powershell
npm run build-runtime
npm run pack -- --win --x64 --config.directories.output=dist/rc3-verified --config.electronDist=node_modules/electron/dist
$env:ELECTRON_BUILDER_COMPRESSION_LEVEL = '1'
$env:ELECTRON_BUILDER_7ZIP_PATH = (Resolve-Path 'node_modules/electron-winstaller/vendor/7z-x64.exe').Path
npm run dist:win -- --prepackaged dist/rc3-verified/win-unpacked --config.directories.output=dist/rc3-verified
npm run verify:win -- dist/rc3-verified/win-unpacked
node scripts/verify-windows-artifacts.mjs dist/rc3-verified
```

打包必须在运行时重建成功退出后执行。本轮下载 Electron 遇到 GitHub 超时，转用已安装的同版本 Electron 44.1.1；该选项仅用于本次命令，没有改变项目默认下载策略。

默认归档使用的构建缓存 7za 实际报告 x86，在压缩约 1.1 GiB 解包载荷时返回 Windows 资源不足。复现命令用现有 electron-builder 依赖附带的 64 位 7-Zip 16.04 和较低压缩级别；不新增依赖或修改供应商工具。`--prepackaged` 归档完成的应用目录，不再次替换运行载荷。

实际退出检查通过临时 Electron 数据目录中的标记触发本应用 `app.quit()`。监听仅在验证变量、隐藏窗口、显式数据目录三项同时启用时存在，普通启动不设置；本轮首次普通 `taskkill` 未能关闭隐藏窗口，脚本明确失败并清理自有进程后改用该机制重跑。

`build-runtime` 已成功退出，实际 VERSION：

```json
{
  "host": "@deepseek-ai/dsh@0.1.5-rc.3",
  "webAll": "@linxin666/dsh-web-all@0.3.23",
  "builtAt": "2026-10-03T19:43:44.838Z"
}
```

Windows 包内工具链实测为 Node `v24.20.0`、npm `11.19.0`、pnpm `11.24.0`，三阶段均执行版本命令并成功退出。安装日志中的可选 `cpu-features` 本地编译失败未阻断 pnpm 安装。

## 验证状态

源码：桌面壳测试 35/35、插件默认测试 134/134、插件语法检查均通过。最终分发目录中的官方运行时/Profile 检查 5/5 通过。

修复后的 Windows EXE 已通过三阶段启动和退出检查：

| 阶段 | Profile 行为 | 官方共享包 | 默认全家桶行 | degraded |
| --- | --- | --- | --- | --- |
| 首次启动 | seed | 5 | 13 | 0 |
| 原目录重启 | leave，seededAt 不变 | 5 | 13 | 0 |
| 应用复制到新目录后启动 | reseed，seededAt 更新，用户 patch 保留 | 5 | 13 | 0 |

13 行是全家桶默认启用的模块；5 个可选模块沿用上游禁用配置，没有为通过检查而缩减本轮 Profile。每一阶段都检查 GUI 已加载、官方共享模块指向当前 host 的同一实体，并通过实际 `app.quit()` 结束自有应用和宿主进程。原安装目录的 84 个共享文件在首启、重启和迁移后 SHA256 均保持一致，用户 patch 保留。验证结束后，临时 state 中的 URL 与 PID 已移除。无认证信息的回执保存在 [package-smoke.json](../dist/rc3-verified/package-smoke.json)。

在迁移后的完整 Profile 中进行浏览器回归：标准会话创建成功，输入 `/package-smoke-card` 出现夹具技能候选，选择后打开卡片并阻断输入；取消恢复原草稿，确认仅写入 `dsh.mathmodel.request/v1` 草稿；标准 → 极简 → 标准切换前后草稿完全一致。没有填写 API Key、发送消息或调用模型。临时 browser tab 与测试应用已关闭。

控制台实测 0 条 error、1 条 warning：Git Graph 0.3.23 检测到 rc.3 的 workspaces 服务形状变化，禁用可选自动隔离并回退到官方新建会话行为。定向源码检查确认这是第三方的显式兼容保护：它寻找 `workspaces.startSession`，rc.3 由 `uiWorkspace.startSession` 提供该方法。自动隔离默认关闭，不影响本轮卡片与预设结果；自动创建工作树的功能仍未适配，手动创建工作树入口也未实测。没有修改第三方源码或静音警告。

![完整 Profile 标准预设与已写入的草稿](rc3-full-profile.jpg)

修复后的 NSIS 与 ZIP 已成功生成，并通过成品完整性检查。解包目录共 43,559 个文件，ZIP 共 43,558 个文件；唯一差异为 `resources/elevate.exe`，electron-builder 的 NSIS `CopyElevateHelper` 在 ZIP 完成后加入该安装器提权助手，其 PE 文件头已验证。其余文件集合一致，全部 ZIP 条目的 CRC 检查通过，9 个关键文件的 SHA256 与解包目录一致。`app.asar` 中主进程及 runtime 源码、Profile patch 均与当前源码一致。

| 产物 | 字节数 |
| --- | ---: |
| [Windows NSIS 安装包](../dist/rc3-verified/dsh-mathmodel-desktop-0.1.0-win-x64.exe) | 336,214,409 |
| [Windows ZIP](../dist/rc3-verified/dsh-mathmodel-desktop-0.1.0-win-x64.zip) | 412,627,143 |

完整 SHA256 见 [SHA256SUMS.txt](../dist/rc3-verified/SHA256SUMS.txt)，机器可读检查结果见 [verification.json](../dist/rc3-verified/verification.json)。NSIS 被识别为有效 PE/NSIS，包含 335,544,217 字节的 x64 应用载荷，外层归档通过 `7z t`；没有独立提取核验嵌套载荷，也没有执行安装或卸载。

历史材料的 8 项断言仍保留在显式 legacy 套件。付费模型、真实论文生产链路、macOS、NSIS 安装及卸载不属于本轮实测。
