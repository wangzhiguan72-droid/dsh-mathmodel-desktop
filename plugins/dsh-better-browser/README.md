<div align="center">

# 🌐 dsh-better-browser

### *让 Agent 使用你已经登录的真实浏览器。*

[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4D6BFE)](https://github.com/deepseek-ai)
[![Version](https://img.shields.io/badge/version-0.3.6-4D6BFE)](package.json)
[![Node.js](https://img.shields.io/badge/Node.js-22.19%2B-4D6BFE)](package.json)
[![License](https://img.shields.io/badge/license-BSD--3--Clause-4D6BFE)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/titanwings/dsh-better-browser?style=social)](https://github.com/titanwings/dsh-better-browser/stargazers)

<br>

<table>
<tr><td align="left">

🔐 &nbsp;需要 Agent 操作已经登录的网站，又不想复制 Cookie 或重新登录？<br>
🧭 &nbsp;需要导航、点击、填写、截图和网络检查组成一条完整工作流？<br>
🧠 &nbsp;希望浏览器状态留在本机，而不是不断塞进模型上下文？

</td></tr>
</table>

### ✨ dsh-better-browser 把用户真实浏览器变成 13 个 Agent 工具。

通过本机 Kimi WebBridge 复用登录态、已有标签页和活动会话；DSH 负责模型工具，
浏览器状态继续留在浏览器里。

**真实浏览器 + 本地桥接 + 13 个工具 → Agent 可执行的完整浏览器工作流**

<br>

[为什么需要它](#why) · [核心能力](#features) · [安装](#install) · [快速开始](#quick-start) · [工具](#tools) · [安全边界](#safety)

[English](README.en.md) · **简体中文**

<br>

![dsh-better-browser：让 Agent 使用真实浏览器](docs/social-preview.png)

</div>

---

<a id="why"></a>

## 🎯 为什么需要 dsh-better-browser

无头浏览器适合隔离测试，却无法自然复用你正在使用的登录态、Cookie、标签页和
站点会话。`dsh-better-browser` 连接 Kimi WebBridge 的本地守护进程，让 DSH
中的 Agent 操作**用户自己的浏览器**。

| | 无头浏览器 | dsh-better-browser |
| --- | --- | --- |
| 登录态 | 通常需要重新登录或注入凭据 | 复用用户浏览器现有状态 |
| 标签页 | 工具独立维护 | 使用真实标签页与标签组 |
| 浏览器状态 | 容易进入工具输出或模型上下文 | 保留在浏览器与本地守护进程 |
| 适合场景 | 隔离测试、抓取 | 登录后工作流、真实页面检查 |

本插件不包含浏览器驱动代码。真正的浏览器操作由 Kimi WebBridge 守护进程和
浏览器扩展完成；本插件只把它的本地协议适配为 DSH 模型工具。

---

<a id="features"></a>

## ✨ 核心能力

### 🌍 操作用户真实浏览器

导航页面、读取无障碍快照、点击、填写与执行 JavaScript，同时保留登录状态和
已经打开的标签页。

### 🔎 看见页面之外的证据

Agent 可以截图、检查网络活动、上传文件并保存 PDF，不必把整个浏览器状态放进
模型请求。

### 🗂️ 一个任务，一个标签组

稳定的 `session` 名把同一任务的标签页归到一起。不同任务互不混用，用户仍然
可以在自己的浏览器中看见并接管全过程。

### 🔌 零 DSH Core Patch

插件作为 Cordis bundle 安装，注册稳定的 `webbridge` 行与 13 个
`webbridge_*` 工具；卸载 bundle 即可移除能力。

---

<a id="install"></a>

## ⚡ 安装

### 1. 安装 Kimi WebBridge

Kimi WebBridge 是月之暗面的独立产品，本仓库不包含它的守护进程或浏览器扩展。
请先参考 Kimi 官方[产品页](https://www.kimi.com/zh-hans/products/kimi-webbridge)与
[帮助中心](https://www.kimi.com/help/kimi-webbridge)：

```bash
curl -fsSL https://cdn.kimi.com/webbridge/install.sh | bash
kimi-webbridge status   # 期望看到 "extension_connected": true
```

同时需要从官方商店安装 **Kimi WebBridge** 扩展：

- [Google Chrome](https://chromewebstore.google.com/detail/kimi-webbridge/fldmhceldgbpfpkbgopacenieobmligc)
- [Microsoft Edge](https://microsoftedge.microsoft.com/addons/detail/kimi-webbridge/bnlffdbcfnanfbknnlaflhlhkocccckg)

安装并启用扩展后保持浏览器运行，再执行 `kimi-webbridge status`。只有
`"extension_connected": true` 才表示浏览器、守护进程和本插件的完整链路已就绪。

### 2. 安装 DSH 插件

```bash
dsh plugin --profile web add github:titanwings/dsh-better-browser#v0.3.6
```

重启 `dsh web` 并刷新页面。模型随后即可看到 `webbridge_*` 工具。守护进程未
运行时，工具会返回 `daemon_unreachable`，不会静默降级。

---

<a id="quick-start"></a>

## 🚀 快速开始

安装完成后，可以直接让 Agent：

> 使用我的真实浏览器打开 GitHub，找到当前仓库的 Issues，检查最新三个问题，
> 不要关闭我已有的标签页。

Agent 会为任务选择稳定的 session，依次导航、读取页面并执行交互。浏览器动作
采用排他调度，不会并行修改共享标签页。

```text
navigate → snapshot → click/fill → snapshot → screenshot/network
```

标签页只会在用户明确要求时关闭；任务结束不会自动清理用户浏览器。

---

<a id="tools"></a>

## 🧰 13 个浏览器工具

| 工具 | 用途 |
| --- | --- |
| `webbridge_navigate` | 打开 URL，并为任务设置标签组标题 |
| `webbridge_find_tab` | 重新选择任务标签页或借用当前活动标签 |
| `webbridge_snapshot` | 读取页面无障碍树与 `@e` 元素引用 |
| `webbridge_click` | 按 `@e` 引用或 CSS selector 点击 |
| `webbridge_fill` | 填写 input、textarea 或 contenteditable |
| `webbridge_evaluate` | 在页面中运行同步或异步 JavaScript |
| `webbridge_screenshot` | 截取页面或指定元素并返回文件路径 |
| `webbridge_list_tabs` | 列出当前 session 的标签页 |
| `webbridge_network` | 启停并检查网络活动 |
| `webbridge_upload` | 通过文件输入上传调用 Agent 工作区内的文件 |
| `webbridge_save_as_pdf` | 将当前页面保存为 PDF |
| `webbridge_close_tab` | 关闭 session 的当前标签页 |
| `webbridge_close_session` | 关闭 session 的全部标签页 |

---

<a id="safety"></a>

## 🛡️ 会话与安全边界

- **一个任务 = 一个 session = 一个标签组。** 每次调用保持相同 session 名。
- **关闭由用户发起。** 只有用户明确要求时才关闭标签页或整个 session。
- **浏览器动作串行执行。** 所有工具声明 `isConcurrencySafe=false`，避免共享
  标签页发生交错修改。
- **主机路径限制在授权范围内。** 上传文件必须在调用 Agent 的工作区内；插件会
  解析规范路径并拒绝符号链接逃逸。截图和 PDF 路径只接受 WebBridge 专用临时目录。
- **导航只允许 Web Origin。** `navigate` 与 `find_tab` 仅接受绝对 `http`/`https`
  URL，拒绝本地文件与脚本协议。
- **本地优先不等于零风险。** Agent 操作的是真实登录会话；发送消息、提交表单、
  发布内容等动作仍应遵守 DSH 的确认与权限策略。
- **模型能看到下一步所需证据。** `snapshot` 无障碍树、标签页、network detail
  以及截图/PDF 路径会随 `summary` 一起进入工具结果；单次模型可见内容最多
  32,000 字符，超出时会明确标记截断。

---

## 🔧 技术细节

<details>
<summary><strong>配置</strong></summary>

<br>

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `baseUrl` | `http://127.0.0.1:10086` | 守护进程的 http/https 地址 |
| `timeoutMs` | `30000` | 单次工具调用超时预算（毫秒） |

```yaml
- id: webbridge
  config:
    baseUrl: http://127.0.0.1:10086
    timeoutMs: 30000
```

非法 URL 或非正整数超时会在插件挂载时响亮失败。

</details>

<details>
<summary><strong>从旧名称升级</strong></summary>

<br>

已经安装旧包的 profile 需要先移除，再安装新版本：

```bash
dsh plugin --profile web remove @dsh-external/dsh-kimi-browser
dsh plugin --profile web add github:titanwings/dsh-better-browser#v0.3.6
```

`@dsh-external/dsh-better-browser` 包身份、`webbridge` 行 id、全部工具名和配置字段
保持稳定。GitHub 仓库归属变化不会改变 Cordis bundle 身份。

</details>

<details>
<summary><strong>当前限制</strong></summary>

<br>

- 严格检查 `event.isTrusted` 的站点可能忽略合成 click/fill。
- snapshot、click、fill 与 evaluate 只作用于顶层 frame，不穿透跨域 iframe。
- screenshot 返回守护进程写入的临时文件路径，需要 Read 工具查看。
- 标签组由守护进程维护；重启守护进程会清空它们。

</details>

<details>
<summary><strong>开发与测试</strong></summary>

<br>

DSH 官方包尚未发布到公共 npm，开发工具链需要一个 DSH 源码 checkout：

```bash
pnpm link:dsh -- /path/to/dsh
pnpm typecheck
pnpm test
pnpm build
pnpm check
```

测试覆盖守护进程客户端、13 个工具、Cordis 生命周期、配置校验和 Loader 冒烟。
设置 `KIMI_WEBBRIDGE_IT=1` 可对真实守护进程运行集成测试。

</details>

---

## 📄 License 与 WebBridge 边界

本插件使用 BSD-3-Clause，见 [LICENSE](LICENSE)。它只兼容 Kimi WebBridge
协议，不包含 Kimi 的守护进程、扩展或代码。Kimi WebBridge 是月之暗面的产品
与商标，需根据 Kimi 自身条款另行安装和使用。
