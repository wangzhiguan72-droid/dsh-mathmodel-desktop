# 更新待办（2026-10-09）

最新 Windows 验证见 [Git Graph 与 NSIS 后续实测](docs/windows-git-graph-nsis-followup.md)：Git Graph 实际自动隔离已通过；NSIS 修复静默前置检查、长路径解压、部分写入失败误报成功与链接安全卸载。独立测试身份的新装、三阶段启动和真实卸载全部通过，43,559 个安装文件逐一核对，用户数据与个人安装基线保留。

桌面 0.1.1 已加入左下角更新提示、下载和安装分别确认、个人更新源设置与恢复上一版。完整应用内 ZIP 升级、真实宿主启动后崩溃的自动恢复、手动回退均已实测；恢复后的整树摘要与原目录一致，个人数据哨兵保留。桌面测试 114/114，最终 ZIP 与 NSIS 内外层校验通过，详见 [桌面更新与回滚证据](docs/desktop-updates-verification.md)。旧 0.1.0 首次迁移由 `scripts/bootstrap-installed-desktop.mjs` 在原路径自动完成；隔离夹具通过失败恢复和成功启动，本机个人安装也已迁移至 0.1.1，原快捷方式与技能联接保留，新 GUI 正常运行。v0.1.0 线上 Release 已有，但尚无桌面更新清单；0.1.1 成品及清单仍未发布，应用内检查尚不能发现这版更新。下列条目保留首轮历史记录。

发布预检工具 `node scripts/publish-desktop-release.mjs --plan` 已对本地五项资产实跑通过；远端发布需待源码提交、标签和公开发布授权到位。发布逻辑的 14 项离线测试通过，尚未执行线上发布。

当前暂存内核与 VERSION.json 均为 `@deepseek-ai/dsh@0.1.5-rc.3`，插件版本门与可选 peer 白名单已同步。

- 默认测试与显式环境测试已分离；历史预设/订阅断言原样保留在 `test:legacy`，不得将缺失材料视为已验证。
- 品牌源码快照按 LF 计算，保留原 SHA256；图标标准落点为 `src/assets/MetaMath-Harness.ico`。
- 本机 Draw.io 用户安装路径探测已补齐。
- rc.3 标准预设的 Persona 重复注册已修复：桌面启动统一本应用播种 profile 与 host 的官方模块身份，保留原包备份；版本冲突与路径越界提前报错，转换失败整批回滚。
- 隔离浏览器已通过 Remote、Slot、Input Trigger、Conversation 草稿写入与 Preset 切换检查；本轮未验证完整第三方插件组合或已安装 Electron 包。
- 可编辑 PPT 模拟 E2E 使用现有技能目录的真实 CLI 源码运行，单页、双页并发、页内串行和零秘密扫描均通过；未调用付费供应商。
- 桌面测试 31/31、插件默认测试 134/134、环境测试 34/34、PPT 模拟 E2E 1/1 通过；历史套件的 8 项缺口继续明确报告。

详细实测与限制见 [测试与适配记录](docs/test-fixtures-rc3.md)。本次不执行 0.2.0 内核升级；个人安装的首次迁移与备份结果见 [桌面更新与回滚证据](docs/desktop-updates-verification.md)。
