# 八项 legacy 与当前验收映射

原始 legacy 实测为 **0 通过、8 失败**。整体环境回归 **42 项：32 通过、9 失败、1 跳过**。保留原结果，不通过修改旧测试或制造凭据文件取得绿色结果。

| 历史断言 | 失败原因 | 当前证据与缺口 |
| --- | --- | --- |
| editable-ppt Persona | 旧物理 preset 文件不存在 | 当前公共 registry 的 Persona 声明匹配；实际空白会话及原生 UI 选择成功，重启后声明仍匹配 |
| editable-ppt roster | 同一旧文件不存在 | 当前声明为 19 个插件行、无重复 ID，roster 匹配；未观察挂载后的工具目录 |
| mathmodel roster | 旧物理 preset 文件不存在 | 当前声明为 19 个插件行、无重复 ID；实际空白会话及原生 UI 选择成功，重启后声明仍匹配 |
| imagegen roster | 旧物理 preset 文件不存在 | 当前声明为 19 个插件行、无重复 ID；实际空白会话及原生 UI 选择成功；未执行生图任务 |
| mathmodel Persona | 旧物理 preset 文件不存在 | 公共 registry 的中文 Persona 声明匹配；实际会话选择及重启配置已验证，未发模型提示以证明 Persona 实际接收 |
| 订阅插件 0.6.0 bridge | 旧补丁及实际服务缺失 | 历史可选订阅桥缺失，resolver 返回 subscription_service_unavailable；按用户最新范围不新增 provider、依赖或登录流程，不作为核心发布阻断项 |
| Vision 独占 vision_analyze | 当前 Skill 与旧正则契约不同 | 历史可选契约差异；当前静态技能检查通过，官方已注册工具为 read_image，实际识图未验证，不作为核心发布阻断项 |
| 旧 Vision .env fixture | .env 不存在 | 新契约不读取 Skill .env，不制造凭据文件；实际识图未验证，按最新范围列为可选能力 |

额外的 profile 失败为旧正则数到 3 处 mathmodel ID（remove、insert 与 preset config）；不能据此认定存在三份运行实例。rc.3 专用用例在 rc.2 跳过。

证据：[环境回执](../dist/fusion-installed-verification/installed-environment-tests.json)、[八项日志](../dist/fusion-installed-verification/installed-legacy.tap.log)、[当前技能 28/28 日志](../dist/fusion-installed-verification/installed-skills.tap.log)、[迁移回执](../dist/fusion-installed-verification/specialized-preset-apply.json)、[迁移说明](specialized-presets-migration.md)、[订阅服务缺口](subscription-bridge-gap-2026-10-11.md)。

环境测试指向实际安装官方 runtime、真实 profile/home/skills，插件入口哈希与仓库相同并可导入，30 文件语法检查通过。

三种预设的[公共 registry 与实际会话选择](../dist/fusion-installed-verification/closure-specialized-presets.json)、[重启后配置](../dist/fusion-installed-verification/closure-specialized-presets-restart.json)、[原生 UI 选择](../dist/fusion-installed-verification/closure-preset-ui.json)均通过。三种预设均 broken=false，Persona、roster 和完整声明匹配。mountedToolCatalogObserved=false、modelPromptSent=false；这些证据证明配置、入口和选择，不能替代实际 PPT、生图任务或模型接收 Persona 的证明。

用户在 2026-10-12 明确产品核心是 DeepSeek 数学建模与软件开发，生图为可选能力。本轮不引入订阅 provider 或使用新提供的生图凭据。

最终包已实际 NSIS 覆盖退出 0，三种预设的[公共 registry 与新实际会话选择](../dist/fusion-installed-verification/closure-final-specialized-presets.json)、[最终包正常重启配置](../dist/fusion-installed-verification/closure-ui-specialized-presets-restart-20261013.json)再次通过。10-13 已补齐最终包[三种预设的原生点击选择](../dist/fusion-installed-verification/closure-final-native-ui-20261013.json)，此前的前台遮挡已解决，结束时恢复标准预设且没有发送模型提示。原 legacy 失败统计不变，不将配置及入口检查写成实际 PPT/生图任务通过。其余验收范围见[安装版闭环记录](fusion-installed-closure-2026-10-12.md)。
