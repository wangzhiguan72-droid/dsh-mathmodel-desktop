# 专用 Agent 预设迁移（DSH 0.2.0-rc.2）

旧 `mathmodel`、`imagegen`、`editable-ppt` 入口来自 `数学建模/_repos/metamath-harness` 的 `HEAD:.dsh/.agent-presets/<id>/agent.cordis.yml`。旧版是完整 Agent-plane 配置；0.2.0-rc.2 将预设声明放在 profile patch 内，由 `@deepseek-ai/dsh-agent-preset` 的 `config.plugins` 挂载。直接把旧文件追加到宿主会重复注册工具和服务。

`scripts/restore-specialized-presets.mjs` 读取指定运行时的 `@deepseek-ai/dsh-web-app/presets/standard.patch.yml`，复制其完整 `config.plugins`，仅设置三个新预设的 ID、顺序（20–22）和 Persona `prefix` / `suffix`。旧 `imagegen` Persona 与旧 standard 完全相同；这是原定义的事实，不额外假设生图专用工具。脚本把 `!!js` 条件原样保留。生成结果嵌套在三个独立的预设声明内，不在宿主全局插入工具。

预览（默认输出 JSON，`yaml` 字段是可审阅的 patch）：

```powershell
node scripts/restore-specialized-presets.mjs --runtime-root 'C:\Users\Administrator\AppData\Local\Programs\dsh-mathmodel-desktop\resources\runtime\host\node_modules' --profile-patch 'C:\path\to\profile.cordis.patch.yml'
```

只看生成的 YAML 可加 `--format yaml`。确认运行时版本和目标 profile 后，加 `--apply` 写入。脚本在写入前按当前文件名创建带时间戳的 `.bak-specialized-*` 备份；保持原有内容、注释和换行格式，在文件尾追加带标记的配置块。重复执行不会改文件或增加备份。若已有同 ID 的非托管预设，或托管块被手工改动，脚本报错并停止，需人工检查冲突，不会覆盖。

定向验证：`node --test tests/specialized-presets.test.mjs`。测试检查完整 standard 插件列表、三个 Persona 契约、`!!js` 条件、原 profile 保留、备份、幂等和 ID 冲突保护。配置层验证通过后，还须在实际安装桌面重启后检查预设选择和各预设会话实际加载；本脚本本身不证明 UI 或会话运行时结果。

桌面包的 `src/main.cjs` 在选定 profile seed/reseed 后、Host 启动前自动调用同一迁移函数。仅有桌面 seed 标记的 profile 会被修改；默认 `mathmodel` 与其他由桌面 seed 的自定义 profile 都适用，用户自管且没有标记的 profile 不会被迁移。`electron-builder.yml` 将脚本收入 `app.asar`，所以新装和升级到此包的受管 profile 都走备份、冲突检测和幂等流程。手动命令只用于审阅或修复。

Host 首启可能重新换行 Persona 文本，也可能在托管结束标记前写入独立的插件设置行。重启检查按 YAML 结构比较三个预设，保留 `!!js` 标签语义，并允许三个预设之后的无关设置行；预设内容或标签被改动时仍会停止且不覆盖用户文件。
