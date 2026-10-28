# 首轮后关闭工具：改为只靠执行守卫（2026-10-28）

## 改动

`plugins/dsh-mathmodel/src/task-tool-switches.js` 新增 `mathmodelToolSwitchWire` 投影，记录模型可见的工具 schema 集合：

- 首轮前：与开关选择一致，关闭即移除 schema（`ctx.tools.restrict`），与原行为相同。
- 首轮后（会话出现 `turn/start`）：只放宽不收窄。关闭工具只由已有执行守卫拒绝调用，schema 保留；重新开启会恢复对应 schema。
- 子任务的可见集合同时包含父任务已提供的 schema，便于 fork 复用继承前缀。

投影由会话事件重放得出，恢复会话后结果相同。能力面板说明文字同步修改。

## 真实请求对照

协议 `tool-switch-cache-{restrict|guard}-v1`（`scripts/live-capability-benchmark.mjs --run --stage=3 --switch-cache=<arm>`）：每个会话确认 `task-0f`，第一轮发合成前缀 + 题目；`toggle` 组在两轮之间空闲时关闭 Skills，`control` 组不动；测第二轮第一个请求。每组 3 对，顺序 control/toggle、toggle/control、control/toggle。`deepseek-flash`、thinking 关闭、两组均无工具调用，12/12 请求完整终止计量，答案 24/24 正确。两次运行的插件文件哈希分别记录在收据里。

| 第二轮请求 | 旧版 restrict | 新版 guard |
| --- | --- | --- |
| control 命中率（3 次） | 99.51% ×3 | 99.51%、99.52%、99.52% |
| toggle 命中率（3 次） | **32.39%**、98.54%、98.54% | 99.51%、99.51%、99.52% |
| toggle 后工具 schema | 86 个，skill 已移除，工具哈希变化 | 87 个，skill 保留，工具哈希不变 |
| 该运行 12 次请求估算 | ¥0.05579 | ¥0.01017 |

旧版第一次关闭后，第二轮请求只命中 9,088 tokens，18,971 tokens 未命中。之后两次 toggle 只有 411 tokens 未命中，原因是三个会话的合成前缀完全相同，第一次已把 86 工具版本的前缀写进了提供方缓存。真实对话历史各不相同，每次中途关闭都会像第一次那样，从被改动的工具位置起重算后面全部历史。新版 toggle 与 control 无差异。

费用为官方文档价格估算（Flash 非高峰 ¥1 / ¥0.02 / ¥4 每百万未命中 / 命中 / 输出），不是账户扣费。旧版运行费用主要来自那一次未命中及首个冷请求，两组费用差不代表普遍降本比例。

证据：[旧版收据](../dist/live-stage3-2026-10-27T19-20-03-888Z/receipt.json)、[新版收据](../dist/live-stage3-2026-10-27T19-30-51-124Z/receipt.json)，同目录下有逐请求 `provider-audit.jsonl`。两次运行的临时凭据已删除。

## 边界

- 首轮后关闭的工具 schema 仍占每次请求的 schema token（命中时按缓存价）；模型仍可能尝试调用，会得到“当前任务已关闭此工具”的拒绝结果。需要彻底不加载，应在新任务首轮前关闭。
- 样本只覆盖关闭 Skills（1 个 schema）；MCP、任务板一次移除多个 schema，旧版的损失只会更大，但未单独实测。
- 只测了 `deepseek-flash`（`toolUpdate: addition-only`）。

## 验证

- 插件测试 172/172（新增首轮后保留 schema、守卫拦截、重开放宽、重放一致的回归）。
- 桌面测试 285/287 通过、1 跳过、1 失败：`tests/fusion-latest-transport.test.mjs` 期待 Fusion 0.2.8 bundle，当前 `plugins/dsh-model-fusion` 为 0.2.6；该测试文件在本次改动前已被修改，与本改动无关。日志 `dist/tool-switch-cache-full-tests.log`。
- 已执行 `node scripts/build-runtime.mjs --local-only` 更新暂存运行时；个人安装目录与安装包未更新。
