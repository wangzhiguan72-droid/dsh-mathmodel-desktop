# Git Graph 与 NSIS 专项验证

2026-10-04—05，继续处理初轮验证留下的 Git Graph 自动隔离兼容警告，以及 NSIS 实际安装、卸载的验证缺口。保持桌面版本 0.1.0、Harness 0.1.5-rc.3、全家桶 0.3.23，没有新增依赖或个人预设。

## 修复

Git Graph 0.3.23 把数据控制器 `workspaces` 当成导航服务。rc.3 已将 `startSession` 与 `connectWorkspace` 放在 `uiWorkspace`，因此原实现主动禁用自动隔离。暂存脚本现在分别使用两个服务，并注入导航服务；隐式工作区选择遵循当前会话与最近使用的工作区。补丁同时覆盖独立 Git Graph 包和全家桶内嵌副本，按名称、版本与唯一源码锚点校验，未知版本直接失败。只修改待分发载荷，不修改个人 Profile。

NSIS 前置检查修复了三处问题：

- 临时切换到 64 位注册表后用 `SetRegView lastused` 恢复构建器的原视图。
- VC 提示增加 `/SD IDNO`，缺依赖时静默安装不会等待对话框，也不会打开下载链接。
- 32 位 NSIS 使用 `Sysnative` 检查 x64 VC DLL，避免 `System32` 被 WOW64 重定向到 x86 DLL。

真实安装探针进一步暴露长路径问题：默认安装根目录下最长文件达到 261 字符，中文空格测试目录下有 22 个文件超过 259 字符。构建器先解压到临时目录再调用 `CopyFiles`，失败后重复复制，并最终调用不报告错误的解压插件；首轮测试因此超时，不能计为通过。半成品没有注册表身份或卸载器，已按精确测试路径、载荷哈希、无活动进程和无目录链接的条件清理，正式安装基线不变。

新的窄包装保留构建器的归档调度，只替换 7z 解压宏，使用扩展路径直接解压，随后恢复原输出目录。真实锁文件探针发现：原插件允许三个入口都成功写入，但另一个文件保持旧内容，安装器仍返回 0。现嵌入构建器已有的 7-Zip 程序，通过 `nsExec::ExecToStack` 检查进程退出码，任何非零状态都中止安装；同时清除并验证必需入口，防止旧文件掩盖失败。没有增加依赖。生命周期测试另对全部载荷逐一核对文件集合、长度和 SHA256。

卸载删除改为使用扩展路径逐层枚举，遇到 reparse point 仅移除链接，不进入目标目录。构建器的更新移动逻辑仍保留；检测到安装树含链接时，更新在移动前安全退出。小型真实 NSIS 回归覆盖短路径、超过 260 字符的文件、输出目录恢复、损坏归档及旧入口拒绝、被锁的非入口文件拒绝、安装树内 junction 的外部文件保留。未修改系统长路径策略或升级编译器。
验证脚本新增独立测试名称、GUID、快捷方式及更新缓存身份，并在启动安装器前核验真实 NSIS 编译参数与成品哈希。已安装 EXE 的首次启动、重启、迁移仍运行完整 Profile。Profile 动作从应用日志读取，缺日志直接失败；失败清理核验原进程句柄与创建时间，避免仅按数字 PID 终止进程。

## Git 实测

在验证脚本创建的临时仓库中启用 `autoIsolate: true` 和 `autoBaseline: current`。通过实际完整 Profile 界面的“新会话”按钮创建工作树并切换到 `wt/s-mutq82w8`；主仓库与工作树 HEAD 均为 `24b28d0753c27a22a34b32e39ac6ce80a8c079cf`。从该工作区再次新建会话后，Git 仍只有主仓库和一个隔离工作树，没有嵌套创建。

临时 Profile、暂存载荷和最终解包目录中的两个 Git 客户端文件 SHA256 完全一致。移除测试诊断后，在新浏览器页复核：0 条 warning、0 条 error，没有填写 API Key、发送消息或调用模型。临时页面与应用已正常退出，临时状态中的认证 URL 已清除。

![实际自动隔离工作区及 wt 分支](rc3-git-auto-isolation.jpg)

机器可读证据见 [git-auto-isolation.json](../dist/rc3-final-verified/git-auto-isolation.json)。回归还覆盖关闭隔离、创建失败回退、注册失败回滚、重复点击合并、卸载钩子恢复、未知服务形状和全家桶内嵌副本，共 10 项。

## 复现安装与卸载

先成功完成运行时暂存，再分别生成正式解包应用和独立身份测试应用。下列命令在仓库根目录执行；测试身份的打包参数必须完整，生命周期脚本不会接受正式安装包。

```powershell
npm run pack -- --win --x64 --config.directories.output=dist/nsis-final-verified --config.electronDist=node_modules/electron/dist --config.appId=com.deepseek.harness.mathmodel.nsis-verify-20261004 '--config.productName=DeepSeek 数学建模版 安装验证' '--config.executableName=DeepSeek 数学建模版 安装验证' --config.extraMetadata.name=dsh-mathmodel-desktop-nsis-verify-20261004 '--config.nsis.shortcutName=DeepSeek 数学建模版 安装验证'
node scripts/build-windows-install-fixture.mjs dist/nsis-final-verified/win-unpacked dist/nsis-final-verified
node scripts/verify-windows-install.mjs dist/nsis-final-verified/dsh-mathmodel-desktop-nsis-verify-20261004-0.1.0-win-x64.exe dist/nsis-final-verified/win-unpacked
```

测试目录与身份已存在时脚本会拒绝覆盖。测试安装到独立持久验证目录下的 `中文 空格 安装目录`，验证实际文件、HKCU 注册表、桌面和开始菜单快捷方式、更新缓存及应用启动，再调用生成的卸载器。卸载后要求安装目录、测试注册表与快捷方式消失，同时保留 AppData、Profile、Electron 数据和外部技能目录中的哨兵文件。个人正式安装的注册表、快捷方式与更新缓存会在安装、卸载、测试清理后逐次比对。

验证器也修复了实测暴露的三项问题：ZIP 与 7z 分别用不同字段标识目录，现按两种真实格式解析，并逐项报告文件集合差异，避免巨大断言差异耗尽内存；进程检查限制到已启动的应用与已观察的子进程族，先请求正常退出，再核验进程身份；MSIX 下 AppData 创建会重定向到应用缓存，清理现锁定创建时的实际路径及精确文件内容，不放宽普通安装目录的归属检查。

第二轮的全量安装文件核对及三阶段界面加载通过，但末尾 PowerShell 检查报 `0x800705AF`，整轮没有计为成功。生成的卸载器已删除安装，随后按文件内容与哈希只清理测试身份的虚拟化哨兵和缓存，正式安装基线保留。两轮失败证据分别见 [first-attempt-failure.json](../dist/nsis-final-verified/first-attempt-failure.json) 和 [second-attempt-failure.json](../dist/nsis-final-verified/second-attempt-failure.json)。后续生命周期证据保存在独立的持久验证目录，避免依赖可被清理的 Temp。

第三轮核对全部安装文件通过，持久测试根目录中有 1,994 个路径超过 259 字符，最长 332 字符。启动检查发现 Windows PowerShell 将 JSON PID 数组保留成嵌套数组，拼出无效的多 PID 查询，报 `0x80041017`。改为显式整数数组后，真实父子进程的首次与重复多 PID 查询回归通过；该失败轮次已正常卸载并清理测试身份，个人安装基线不变，见 [third-attempt-failure.json](../dist/nsis-final-verified/third-attempt-failure.json)。

第四轮捕获安装成功但少一个文件（43,558 / 43,559）的失败，未计为成功；卸载后按精确安装包 SHA256 清理测试缓存，见 [fourth-attempt-failure.json](../dist/nsis-final-verified/fourth-attempt-failure.json)。旧包移入 `partial-extraction-rejected-20261005`，更换具有退出状态的解压方式后重建。验证器提前固定测试缓存的实际路径，并将 stdout 回调异常纳入 Promise 拒绝路径，等待原始子进程结束后进入外层清理；真实子进程回归验证清理标记写入后才报告异常。

本轮不覆盖交互式安装、所有用户安装、已有版本覆盖升级或更新回滚。升级会调用既有版本的旧卸载器，本次新钩子不能改变旧卸载器行为；更新分支的构建器移动逻辑也未做长路径实测，不能据本轮宣称升级安全。
## 验证结果

正式解包 EXE 已通过首次启动、原目录重启和迁移后的重新播种检查：动作分别为 `seed`、`leave`、`reseed`；每阶段共享 5 个官方包、加载 13 个全家桶模块、degraded 为 0。迁移后用户 patch 保留，原宿主的 84 个共享文件哈希不变。无认证 URL 的回执见 [package-smoke.json](../dist/rc3-final-verified/package-smoke.json)。

正式 NSIS 与 ZIP 已通过成品完整性检查。ZIP 和解包目录均有 43,559 个文件，文件集合完全一致，所有 ZIP 条目 CRC 通过，11 个关键文件 SHA256 一致，包含两个 Git 客户端副本。NSIS 外层 `7z t` 通过，包含 335,544,712 字节的 x64 应用载荷；内层归档已独立抽出，43,559 个文件 CRC 全部通过，SHA512 与封装前归档完全一致；文件集合也与解包目录一致，见 [nsis-payload-integrity.json](../dist/rc3-final-verified/nsis-payload-integrity.json)。

| 正式产物 | 字节数 |
| --- | ---: |
| [Windows NSIS](../dist/rc3-final-verified/dsh-mathmodel-desktop-0.1.0-win-x64.exe) | 336,174,240 |
| [Windows ZIP](../dist/rc3-final-verified/dsh-mathmodel-desktop-0.1.0-win-x64.zip) | 412,687,120 |

SHA256 见 [SHA256SUMS.txt](../dist/rc3-final-verified/SHA256SUMS.txt)，完整结果见 [verification.json](../dist/rc3-final-verified/verification.json)。正式与测试身份应用的 7 个源码文件、7 个关键运行时文件及两个 NSIS 钩子哈希一致，见 [production-payload-parity.json](../dist/nsis-final-verified/production-payload-parity.json)。运行时 `builtAt` 为 `2026-10-04T10:49:53.2281758Z`。

独立身份 NSIS 的完整生命周期于北京时间 2026-10-05 03:36 完成，未跳过应用检查。全部 43,559 个安装文件逐一核对文件集合、长度与 SHA256；载荷共 1,170,716,025 字节，其中 1,994 个文件路径超过 259 字符，最长 332 字符。HKCU 注册表、桌面和开始菜单快捷方式、更新缓存均正确。

已安装 EXE 首次启动、重启和迁移后三阶段动作依次为 `seed`、`leave`、`reseed`；每阶段共享 5 个官方包、加载 13 个模块、0 个降级插件，并通过正常退出及所属进程族消失检查。迁移后用户 patch 保留，原宿主 84 个共享文件的哈希不变。内置 Node / npm / pnpm 分别为 24.20.0 / 11.19.0 / 11.24.0，见 [installed-package-smoke.json](../dist/nsis-final-verified/installed-package-smoke.json)。

真实卸载器删除了测试安装目录、注册表和两个快捷方式；安装树内指向外部技能目录的 junction 只移除链接，AppData、Profile、Electron 数据与外部技能目录的四个哨兵文件全部保留。随后按实际路径和精确内容清理测试身份的 AppData 哨兵与更新缓存，个人正式安装基线在安装、卸载、清理后均保持一致。完整回执见 [lifecycle-verification.json](../dist/nsis-final-verified/lifecycle-verification.json)，对应测试安装包 SHA256 为 `18536aa1795e919878351b5cd6c463813954fbc37bfd8b37ea2e389f8282d5d3`。

最终桌面回归为 52/52，无失败或跳过；脚本语法及 `git diff --check` 通过。上文列出的覆盖升级、更新回滚、交互式和所有用户安装仍是未验证范围。
