# 复用 OpenAI Codex app-server 构建 Tauri 2 Agent 桌面端：协议、安全与工程实现调研

## 摘要：推荐采用“后端托管 app-server 子进程”的分层架构

截至 **2026 年 9 月 20 日**，openai/codex 已经形成一条明确的集成栈：`codex-rs/core` 负责 Agent loop、工具执行、上下文、沙箱与审批；`app-server` 将这套能力转换为面向客户端的双向 JSON-RPC；TUI、VS Code 扩展和第三方客户端都可以建立在这一层之上。[1][2] 因此，Tauri 2 项目没有必要自研 Agent 内核，也不宜直接绑定仍可能快速变化的 core 内部类型；推荐方案是 **Tauri Rust 后端长期托管 `codex app-server` 子进程，前端通过类型化命令订阅持久会话与增量事件**。

首选传输方式是 **stdio 上的 JSONL**。JSON-RPC 2.0 消息可以在线路上省略 `jsonrpc` 字段；每个换行对应一条消息。WebSocket 和 Unix socket 虽然可用，但官方明确将其标记为实验性且不建议用于生产环境。最小集成链路为 `initialize → initialized → thread/start → turn/start → 流式通知 → approval request → allow/deny → turn/completed`。持久线程、可恢复轮次以及服务器主动发起审批，是 app-server 相对普通“请求—响应”CLI 封装的关键差异。[2][3]

安全方面，Codex 的核心价值是“默认隔离、显式授权、可审批”，而不是无条件限制 Agent。macOS 使用 Seatbelt；Linux 当前主线优先采用 `bwrap` 只读根命名空间，并在进程内附加 seccomp 网络过滤，旧版 Landlock 仅在满足等价条件时回退；Windows 仍为实验性，且无法可靠阻止已具有写权限目录中的文件操作。[6][7] 截至本报告日期，仓库公开安全公告已确认 **CVE-2025-59532（GHSA-w5fx-fh39-j5rw）**：受影响版本为 Codex CLI `0.2.0–0.38.0`、IDE 扩展 `≤0.4.11`，修复版本分别为 CLI `0.39.0`、扩展 `0.4.12`。该漏洞会使模型生成的 `cwd` 被当作可写根，突破预期工作区边界。[13]

综合判断，实现策略应明确分为两层：

1. **第一层：进程级兼容性。**  
   使用 Python SDK 或自行实现的 JSONL 客户端验证协议；锁定 CLI 版本，生成 schema，并使用持久线程、恢复、中断、审批和网络策略运行冒烟测试。

2. **第二层：产品级隔离。**  
   使用独立工作区、专用低权限用户或容器、`read-only` 或 `workspace-write`、最小可写根、强制 `on-request` 审批，以及防外泄代理；同时固化 `codex` 二进制版本，禁止把 `--dangerously-bypass-approvals-and-sandbox` 作为常规配置。

---

## 1. Codex 开放的是 Agent 执行层，模型与托管云服务仍不可自行替换

**结论：openai/codex 开源了 Agent harness 及其集成面，但 Codex 模型、云端托管服务和部分前端并未随之开放。** 对第三方桌面端而言，可复用边界是 core、app-server、CLI、exec、MCP server 和官方 SDK；授权、版本锁定与安全审计必须先于功能开发。

仓库为 <https://github.com/openai/codex>，公开 LICENSE 为 **Apache License 2.0**。该许可允许修改和再分发，并附带专利授权，但依赖项、商标、上游商标、模型服务条款及 OpenAI 数据政策仍须分别检查，不能因主仓库采用 Apache-2.0 就默认所有关联组件均可商用。[4]

截至本次调研，仓库仍处于高频提交状态。GitHub 页面可见 2026 年 9 月 20 日的 TUI 提交，以及 2026 年 9 月 19 日的 Windows 沙箱提交；主仓库描述仍为“在终端中运行的轻量级编码代理”。[4] 这意味着仓库目录、协议常量和 CLI 行为都可能快速演进。任何产品都应锁定提交、发布版本和生成后的协议 schema，而不能只按网络文章中的方法名或字段名长期开发。

Star、Fork 与贡献者数量会随时间变化，本调研不把它们视为协议事实。部署前应以 GitHub API、特定 tag 或软件物料清单（SBOM）重新核验，避免在版本信息不完整时比较性能、活跃度或流行度。

| 边界 | 开源状态 | 工程含义 | 证据口径 |
|---|---|---|---|
| `codex-rs/core`、`protocol` | 仓库内 Rust 源码 | 真正的 Agent loop、执行、上下文与策略引擎 | 官方源码树、官方文章 [1] |
| `codex-rs/app-server`、`app-server-protocol` | 开源 | 稳定集成面；仍可能演进 | 官方 README [2] |
| `codex-rs/tui`、`codex-cli`、exec、`mcp-server` | 开源 | TUI 和 CLI 是协议客户端参考实现 | 官方文章、仓库目录 [1] |
| `sdk/typescript`、`sdk/python` | 官方 SDK | 可直接启动本地运行时，但受 SDK 版本节奏约束 | 官方 SDK 文档 [10] |
| Codex 模型权重、训练代码 | 未随该仓库开源 | 必须接入 OpenAI 模型或兼容 provider | 官方平台定位 [1] |
| Codex Cloud、托管运行时、macOS Desktop App、IDE 扩展实现 | 产品层并非完全开源 | 不能把前端资源、云功能或私有服务当作可复用组件 | 官方文章 [1] |

> **架构边界判断：** app-server 应被视为“产品可依赖的 Agent 控制协议”，而不是“可随意复制的内部 RPC”。OpenAI 在 2026 年 8 月的平台化说明中进一步明确了开源层是 harness 与集成面，模型访问和托管服务则保持分离。[16] 即使 app-server 源码可见，也应把协议视为上游契约：除非已经审阅具体版本的 `app-server-protocol`，否则不要依赖未公开字段。

安装方式可分为三类：

- **`npm install -g @openai/codex`**：适合前端工具链和持续集成；
- **`brew install --cask codex`**：适合 macOS 用户；
- **`cargo install` 或源码构建**：适合审计、冻结版本和修改 fork。

官方 Python SDK 安装命令为 `pip install openai-codex`；TypeScript SDK 包名为 `@openai/codex-sdk`。[10] Tauri 项目不建议让 WebView 直接 `spawn` 并逐行解析 Codex：浏览器与 Node 环境不同，同时会失去统一日志、崩溃恢复、版本管理和进程生命周期控制。更合理的方式是由 Tauri 后端独占 stdin/stdout。

---

## 2. core 是 Agent 状态机，app-server 是有状态的客户端边界

**结论：core 负责“如何运行 Agent”，app-server 负责“客户端如何观察和控制 Agent”。** 二者不能混为一谈：直接嵌入 core 能减少进程边界，却会把应用与快速变化的 Rust 内部 API 耦合；通过 app-server 集成则牺牲少量性能，换取线程、恢复、事件和审批的产品级语义。

仓库顶层结构大致为 `codex-cli/`、`codex-rs/`、`sdk/`、`docs/`、`bazel/`。其中：

- `codex-rs/core`：Agent loop、模型调用、工具调度、执行、上下文压缩、事件与审批；
- `codex-rs/app-server`：JSON-RPC 端点、连接、线程 worker、事件映射；
- `codex-rs/app-server-protocol`：跨版本类型与方法定义；
- `codex-rs/tui`：终端 UI；
- `codex-rs/cli`：CLI 入口；
- `codex-rs/linux-sandbox`：Linux 沙箱辅助实现；
- `codex-rs/exec`：有界执行入口；
- `mcp-server`：实验性 MCP 表面；
- `sdk/{typescript,python}`：官方 SDK。[1][2]

官方协议目录包含 `v1.rs`、`v2/`、`common.rs`、`event_mapping.rs`、`item_builders.rs`、`thread_history.rs` 等文件。[5] 这表明协议并非一组临时 JSON 示例，而是围绕以下对象持续演进：

- `Thread`：持久会话；
- `Turn`：单次用户请求及其后续 Agent 工作；
- `Item`：消息、命令、补丁、工具调用等原子单元；
- 事件映射与历史投影：把 core 内部状态转换为客户端可用的稳定表示。

```text
Tauri UI（WebView）
   ⇄ Tauri commands / events（类型化）
Rust CodexBridge
   ├─ ChildProcess：stdin / stdout / stderr / 退出码
   ├─ JsonlCodec：id、method、params、result、error、notification
   ├─ SessionStore：thread_id、active turn、事件游标、草稿补丁
   └─ PolicyGate：默认 deny、审批去重、操作审计
codex app-server
   └─ core：LLM client → tool calls → exec → sandbox → events
```

core 的 Agent loop 可按以下状态机理解：

```text
submit(text/attachments)
  → 组装系统提示、AGENTS.md、仓库上下文、工具与策略
  → model inference
  → 文本 delta / tool_use（exec、apply_patch、mcp、web 等）
  → 工具前审批（如策略要求）
  → 执行并捕获输出、diff、退出码、网络结果
  → 更新 transcript、上下文压缩、下一轮推理
  → turn/completed 或错误终止
```

源码中并未存在一个名为 `Agent::run_one_turn` 的稳定公共函数签名。因此，上述流程属于**架构推断**，必须结合所锁定版本的 `codex-rs/core/src/agent` 进一步验证。对于 Tauri 产品，这种不稳定性正是应通过 app-server 隔离的原因：应用只承诺遵守协议，不直接依赖 core 内部结构。

app-server 的“对外性”来自四个产品级能力：

1. 长期连接只执行一次 `initialize`；
2. 支持线程创建、恢复、分叉、列表、归档和删除；
3. 把 Agent 进度转换为可重放的项目事件流；
4. 允许服务器暂停活动轮次，并将审批请求发送给客户端。

官方明确指出，app-server 用于驱动富客户端，典型例子是 Codex VS Code 扩展。[2] 普通 CLI 执行通常只需要标准输入、输出和退出码；富客户端还必须处理会话恢复、实时 diff、命令审批、取消、模型切换和本地历史。若这些能力通过各自独立的临时命令实现，容易形成竞态和状态分裂。app-server 将它们收敛到一个有状态连接中，正是其适合作为桌面端内核边界的原因。

---

## 3. stdio JSONL 应作为唯一生产级传输，协议版本必须随 CLI 锁定

**结论：stdio 是默认且最稳妥的传输路径；WebSocket 与 Unix socket 只应在受控实验中使用。** 官方已明确标记 app-server 命令及 WebSocket 传输为实验性，不推荐用于生产负载。[2][3] 因此，Tauri 方案不应基于“本地 HTTP 更方便”转向网络监听，而应维持后端对子进程的独占控制。

官方说明原文为：

> codex app-server supports bidirectional communication using JSON-RPC 2.0 messages (with the `"jsonrpc":"2.0"` header omitted on the wire).

支持方式如下：[2]

| 传输 | 启动参数 | 线路格式 | 推荐等级 |
|---|---|---|---|
| stdio | `--listen stdio://` / `--stdio` | 换行分隔 JSON（JSONL） | **生产首选** |
| WebSocket | `--listen ws://IP:PORT` | 每 WebSocket 文本帧一条 JSON-RPC | 实验性，不建议生产 |
| Unix socket | `--listen unix://[PATH]` | 使用 HTTP Upgrade，再承载 WebSocket | 受控环境可选 |
| 关闭 | `--listen off` | 不暴露本地传输 | 子进程嵌入时合理 |

WebSocket 还提供 `GET /readyz` 与 `GET /healthz` 探针，但带有 Origin 头的请求会被拒绝并返回 403。远程连接支持多种认证方式，包括 `capability-token`、`signed-bearer-token` 和共享密钥。[2] 这些机制存在，并不意味着桌面端应在用户机器上开放监听端口。即使绑定本地回环，也应把连接控制、版本固定和凭据管理放在后端。

### 3.1 报文遵循 JSON-RPC 2.0，但线路上可能省略 `jsonrpc`

**结论：客户端应按标准 JSON-RPC 实现，但解析器不能强制要求每条消息都包含 `jsonrpc:"2.0"`。** 消息通过数字或字符串 `id` 关联请求与响应；通知没有 `id`；服务器主动发起的审批同样使用请求形式。

最小字段模型如下：

```json
{ "jsonrpc": "2.0", "id": 1, "method": "thread/start", "params": { } }
{ "id": 1, "result": { "thread": { "id": "thr_xxx" } } }
{ "method": "item/started", "params": { "threadId": "thr_xxx", "item": {} } }
{ "id": 7, "error": { "code": -32000, "message": "thread not found" } }
```

> 上述 `thread/start` 属于**官方文档确认的方法名**；其 `params`、响应字段及 `item` 结构仍应以所锁定版本的 `generate-json-schema` 输出为准。[2][3]

初始化是最关键的不变量。每个连接只允许在调用其他业务方法前发送一次 `initialize`；客户端随后发送 `initialized` 通知。推荐携带客户端名称、标题和版本，便于问题排查、版本兼容与灰度发布。

```json
["initialize", 0, {
  "clientInfo": { "name": "tauri-codex", "title": "Tauri Codex", "version": "0.1.0" }
}]
=> { "id": 0, "result": { "serverInfo": { "name": "codex", "version": "…" },
     "capabilities": { "threads": true, "approvals": true } } }

["initialized", null, {}]
```

### 3.2 实现顺序应固定为连接、握手、会话、轮次、审批与恢复

**结论：状态投影应只依赖服务器事件，不能依赖前端对 Agent 行为的隐式假设。** 每条消息都必须具备稳定类型、关联键和持久化游标，否则断开重连后无法重建会话视图。

建议流程为：

1. 创建一对唯一 `id` 生成器与待响应 `Map`；
2. 按行解析 stdout，并将请求、响应和通知分别路由；
3. 先完成 `initialize`/`initialized`；
4. 执行 `thread/start`、`thread/resume` 或 `thread/fork`；
5. 通过 `turn/start` 提交输入；
6. 将 `item/*` 增量投影到消息、命令、补丁和状态；
7. 在活动轮次中对审批请求返回决策；
8. 将事件追加到本地 history store，以支持重连和 UI 恢复。

<!-- 图片来源说明：原始链接是带签名的临时地址，含云账号标识，
     已在首次推送到公开仓库前去掉查询串。图片需重新签名才能访问。 -->
![建议采用后端托管子进程与 stdio JSONL 的 Tauri 2 架构](https://one-agent-prod-1343551737.cos.ap-guangzhou.myqcloud.com/artifacts/0628/bdtjt8eJo0vSUCv9/0QJaOVZirY4/task-c607ae74fc4eeef3e6c393b72aa1c277/.rendered/_assets/dr%3Acodex-appserver/fig_tauri_architecture.png)

*图 1：Tauri 2 的建议边界。前端只接触领域事件；Rust 后端独占 app-server 的 stdin/stdout。数据来源：OpenAI app-server 官方文档 [2]。*

原始生命周期数据可下载：[protocol_lifecycle.csv](/data/workspace/dr:codex-appserver/protocol_lifecycle.csv)。

![协议生命周期：初始化、线程、轮次、审批与完成](https://one-agent-prod-1343551737.cos.ap-guangzhou.myqcloud.com/artifacts/0628/bdtjt8eJo0vSUCv9/0QJaOVZirY4/task-c607ae74fc4eeef3e6c393b72aa1c277/.rendered/_assets/dr%3Acodex-appserver/fig_protocol_lifecycle.png)

*图 2：协议状态机。审批可以在活动轮次任意暂停点出现，因此客户端必须始终具备响应能力。数据来源：OpenAI app-server 官方文档 [2][3]。*

官方列出的核心生命周期原语与操作方法包括：[3]

| 生命周期 | 官方方法/通知 | 客户端责任 |
|---|---|---|
| 初始化 | `initialize`、`initialized` | 校验 serverInfo、capabilities 与兼容版本 |
| 线程 | `thread/start`、`thread/resume`、`thread/fork`、`thread/read`、`thread/list`、`thread/archive`、`thread/delete` | 将线程映射到工作区、标签页和历史记录 |
| 轮次 | `turn/start`、`turn/steer`、`turn/interrupt` | 将输入提交给指定 `threadId`，并支持追加与取消 |
| 账户 | `account/read`、`account/login/start`、`account/login/cancel`、`account/logout`、`account/rateLimits/read` | 展示登录状态、配额和取消登录流程 |
| 配置与模型 | `config/read`、`config/value/write`、`config/batchWrite`、`model/list` | 校验写入项，避免 UI 直接覆盖安全策略 |
| 审批 | 服务器主动请求 | 展示风险并响应 `allow`/`deny`；高频操作必须可批量拒绝 |

官方文档还说明，持久线程可在 `thread/start` 时接受 `daybreakEnabled`，但前提是启用 `experimentalApi`；其响应及 `thread/started` 通知都会回传初始选择。[18] 这进一步说明：产品不应把实验字段直接放入稳定 UI，而应通过能力协商控制是否暴露。

### 3.3 事件投影必须区分普通通知与可改变控制流的审批请求

**结论：`item/*` 用于描述已经发生或正在发生的进度，`approval/*` 则要求客户端决策。** 把审批请求误当成普通通知，会导致轮次静默挂起；把工具输出直接覆盖用户草稿，则可能造成状态丢失。

| 类别 | 方法或通知 | 工程映射 |
|---|---|---|
| 生命周期 | `thread/started`、`thread/archived`、`thread/unarchived` | 更新会话侧栏、加载或冻结视图 |
| 轮次 | `turn/started`、`turn/completed`、`turn/failed` | 绑定 `turnId`，显示运行、取消、错误与 token 用量 |
| 条目生命周期 | `item/started`、`item/completed` | 创建或收尾消息、命令、补丁和工具卡片 |
| 流式内容 | `item/agentMessage/delta`、`reasoning/*`（存在能力时） | 追加到受控 Markdown/代码视图，避免整树重渲染 |
| 执行 | `execCommand/*`、`item/command/*` | 展示命令、状态、stdout/stderr、持续时间和退出码 |
| 文件与补丁 | `applyPatch/*`、`item/patch/*` | 通过 diff parser 渲染文件树和 hunk |
| 审批 | 服务器请求 `applyPatchApproval`、`execCommandApproval` | 弹出模态审批，记录决策与上下文 |
| 账户 | `account/login/completed`、登录相关通知 | 驱动登录流程与错误恢复 |

以下审批报文属于**源码推断的骨架**，并非逐字节规范：

```json
// server → client
["$approvalId", {
  "method": "applyPatchApproval",
  "params": {
    "threadId": "thr_xxx",
    "turnId": "trn_xxx",
    "approvalId": "apr_xxx",
    "type": "patch",
    "summary": "edit src/main.rs",
    "diff": "@@ -10,3 +10,4 @@ ...",
    "risk": "moderate",
    "options": ["allow_once", "allow_always", "deny"]
  }
}]

// client → server
["approval/resolve", "$reqId", {
  "approvalId": "apr_xxx",
  "decision": "allow_once",
  "scope": "thread"
}]
```

实际字段名必须以当前版本的 `codex app-server generate-json-schema` 为准。官方 README 明确说明，可通过该命令生成 JSON Schema，也可为 TypeScript 生成类型定义。[2] 产品化工作流应自动化以下过程：

```bash
codex app-server generate-json-schema --out schemas/v2
codex app-server generate-ts --out src/codex
```

随后，在 CI 中将生成结果与固定 CLI 版本一起提交、比对和审批。这样既可保留类型安全，也能及时发现协议变更。

---

## 4. 官方 SDK 适合验证闭环，长期产品应迁移到生成 schema 与 JSONL

**结论：官方 SDK 是验证功能与快速建立原型的低风险入口；但 Tauri 2 的稳定路径仍是 Rust JSONL 客户端。** SDK 的运行时依赖、版本节奏和异常模型可能与 Tauri 应用不同，不应未经封装直接嵌入长期运行的后端。

TypeScript SDK 要求 Node.js 18 及以上，安装命令为 `npm install @openai/codex-sdk`。官方示例为：[10]

```ts
const codex = new Codex();
const thread = codex.startThread();
const result = await thread.run("诊断并修复 CI 失败");
console.log(result.finalResponse);

const existing = codex.resumeThread(threadId);
await existing.run("继续上次的修改");
```

Python SDK 要求 Python 3.10 及以上，安装命令为 `pip install openai-codex`。它控制本地 app-server 的 JSON-RPC，并且官方构建会关联固定 CLI 运行时。[10] 典型用法为：

```python
from openai_codex import Codex, Sandbox

with Codex() as codex:
    thread = codex.thread_start(model="gpt-5.6-terra", sandbox=Sandbox.workspace_write)
    result = thread.run("Make a plan to diagnose and fix the CI failures")
```

官方 Python SDK 还支持异步运行：

```python
import asyncio
from openai_codex import AsyncCodex

async def main() -> None:
    async with AsyncCodex() as codex:
        thread = await codex.thread_start(model="gpt-5.6-terra")
        result = await thread.run("Implement the plan")
        print(result.final_response)

asyncio.run(main())
```

`sandbox` 可在 `thread_start` 或后续 `run/turn` 中设置，并可取 `read_only`、`workspace_write`、`full_access`；不传值时使用服务器默认。[10] 这种高层封装隐藏了 child lifecycle、背压和部分错误恢复，因此适合 CI 与脚本。

对于 Tauri 后端，长期运行和细粒度控制更重要。建议按以下优先级实现：

1. 使用 Python SDK 编写 contract test，确认目标 CLI 版本支持哪些方法；
2. 生成并冻结 JSON Schema；
3. 使用 Rust 实现 `JsonlTransport`；
4. 为审批、中断和历史回放建立领域事件；
5. 只在一次性自动化场景中直接调用 SDK。

### 4.1 内嵌 core 的耦合收益不足以抵消短期稳定性成本

| 维度 | ① Rust 内嵌 core crate | ② Tauri 后端托管 app-server JSONL | 建议 |
|---|---|---|---|
| 性能与类型 | 零进程，直接调用 Rust 类型 | 一次 JSON 编解码，进程边界清晰 | core 成熟后可评估① |
| 升级 | core API 变化会直接破坏构建 | 只依赖冻结后的协议版本 | **MVP 选②** |
| 线程/恢复 | 需自行暴露状态机 | 已提供完整生命周期 | 选② |
| 审批/取消 | 需自行桥接事件 | approval request 是协议一等能力 | 选② |
| 多语言客户端 | 仅 Rust | 任意可解析 JSONL 的客户端 | 选② |
| 极致定制 | 可修改 loop、context、tools | 受协议边界限制 | 成熟后可选① |

**最终推荐架构为“SDK 验证 + app-server 产品化”。** SDK 用于建立最小闭环，生成 schema 并运行契约测试；Tauri 后端再托管 `codex app-server` 子进程。其收益不只是技术洁癖：它允许独立升级 Node/Python 与 Rust 运行时，也允许在不升级前端的情况下替换底层 CLI。

---

## 5. 安全模型以工作区隔离为默认防线，审批则负责处理边界内的例外

**结论：文件系统策略与人工审批必须协同工作，任何一侧都不能替代另一侧。** 只读或工作区可写限制文件系统范围；审批控制高风险动作；网络策略与 MCP 工具边界限制数据外泄和额外能力。把 Agent 放到宿主机并全局批准命令，会把分层防御退化成单一审批弹窗。

官方 SDK 的沙箱预设与 core 策略相对应：[10]

| 预设 | 语义 |
|---|---|
| `read_only` | 只允许读取，不允许写入 |
| `workspace_write` | 允许在工作区及已配置可写根中写入 |
| `full_access` | 不做文件系统访问限制 |
| 未设置 | 使用服务器配置默认值 |

Linux 当前优先实现如下：[6]

- 优先使用 `PATH` 中位于当前工作目录之外的 `bwrap`；
- 若系统 `bwrap` 过旧，使用不带 `--argv0` 的兼容路径；
- 若未找到 `bwrap`，回退到 Codex 随附的 `codex-resources/bwrap`；
- 使用 bubblewrap 时，文件系统默认通过 `--ro-bind / /` 只读；
- 在可写根之上叠加可写绑定；
- 将 `.git`、已解析的 `gitdir:` 和 `.codex` 重新绑定为只读；
- 设置 `PR_SET_NO_NEW_PRIVS`；
- 在进程内安装 seccomp 网络过滤。

官方 Linux sandbox README 还说明，旧版 Landlock fallback 仅在拆分文件系统策略经 `cwd` 解析后等价于 legacy model 时才使用。[6] 因此，较早资料中“Codex Linux 一定是 Landlock + seccomp”的说法已经不能完整描述当前主线。架构判断应以所安装二进制和实际启动日志为准，而不能只依赖历史文章。

macOS 使用 Apple Seatbelt，通过 `sandbox-exec` 加载与 sandbox mode 对应的 profile，在操作系统层限制文件和网络。[7] Windows 使用受限令牌与 AppContainer 相关机制，并为已请求的路径附加能力；网络禁用则依赖代理环境变量与常见网络工具的占位实现。官方仍将其标记为高度实验性，因为 Everyone SID 已具有写权限的目录无法可靠被限制。[7]

> **安全结论：** Linux 和 macOS 的强制边界强于 Windows。若目标是 Windows 生产桌面端，应在 Codex 之外增加 Hyper-V、WSL、容器或独立低权限账户，而不能把实验性 Windows 沙箱当作充分隔离。

### 5.1 审批策略应固定为 `on-request`，而非追求“零点击”

**结论：审批配置是产品安全策略，不是用户偏好开关。** Tauri 应用至少应支持策略读取、工作区级覆盖、管理员锁定与审计导出；默认交互模式应为 `on-request`。

Codex 常见档位如下：[7][8]

| 档位 | 行为 | 适用场景 |
|---|---|---|
| `untrusted` / `on-request` | 边界外或敏感动作必须请求审批 | 默认交互式桌面端 |
| `on-failure` | 初始尝试失败后请求授权或放宽策略 | 受控自动化 |
| `never` | 不弹窗；仍受 sandbox mode 限制 | CI 或一次性脚本 |
| `danger-full-access` | 不做文件系统沙箱；所有命令允许 | 仅临时、隔离的实验 |

危险命令识别主要服务于“是否需要审批”，并不等同于强制访问控制。模型生成的命令可能被前缀规则、策略文件和命令分类逻辑识别。若策略或执行失败后的放宽逻辑允许重试，原本被拒绝的命令仍可能以更宽松条件运行。[8]

因此，自定义命令分类器应只作为体验层。真正的强制边界必须来自：

- Seatbelt / `bwrap` + seccomp；
- 明确的 `writable_roots`；
- 网络代理或防火墙；
- 独立的低权限用户；
- MCP 工具白名单。

不得因“命令不在黑名单中”就推断其安全。

### 5.2 CVE-2025-59532 证明工作区边界必须由客户端固化

**结论：该漏洞的关键不是模型“生成了危险命令”，而是策略边界本身被模型可控的 `cwd` 影响。** 它证明客户端必须预先决定工作目录和可写根，并不再信任 Agent 在运行中提出的路径。

公开公告原文为：[13]

> Due to a bug in the sandbox configuration logic, Codex CLI could treat a model-generated `cwd` as the sandbox’s writable root, including paths outside of the folder where the user started their session.

| 项目 | 信息 |
|---|---|
| 公告 | GHSA-w5fx-fh39-j5rw / CVE-2025-59532 |
| 严重性 | High，CVSS 8.6 |
| 影响范围 | Codex CLI `>=0.2.0, <=0.38.0`；IDE 扩展 `<=0.4.11` |
| 修复版本 | Codex CLI `0.39.0`；IDE 扩展 `0.4.12` |
| 后果 | 突破工作区边界，允许在 Codex 进程权限范围内任意写入与命令执行 |
| 限制 | 网络禁用策略不受影响 |
| 修复方式 | canonicalize/validate，将策略边界固定为用户启动会话的位置，而不是模型生成的 `cwd` |

截至本报告日期，仓库安全公告页面可确认存在这一条公开 advisory。[12] 这不能证明不存在其他未公开风险，也不能证明已修复版本绝对免疫，但足以支持以下强制要求：

- 使用 `>=0.39.0`；
- 锁定版本；
- 生成 SBOM；
- 订阅 GitHub Security Advisory；
- CI 自动检测已知漏洞；
- 产品首次启动时校验二进制版本与哈希；
- 默认将工作区设置为绝对规范化路径；
- 禁止 Agent 将 `cwd` 修改为父目录或符号链接逃逸目标；
- 高风险操作始终保留审批记录。

---

## 6. 凭据应由后端单点管理，第三方兼容模型必须限制在可信边界内

**结论：ChatGPT 登录与 API key 是两种不同安全域，桌面端应明确区分身份、组织、数据保留和计费策略。** Tauri 不应自行实现登录 UI，更不应复制或长期缓存密钥；应由 Codex 管理凭据，应用只触发流程并读取必要状态。

官方认证文档说明：[9]

- 本地 Codex 支持 ChatGPT 订阅登录和 API key；
- ChatGPT 登录会打开浏览器，登录后由浏览器回传凭据；
- CLI 使用 `codex login`；
- API key 可通过 `printenv OPENAI_API_KEY | codex login --with-api-key` 配置；
- `codex login status` 查看当前状态；
- `codex logout` 清除当前凭据。

凭据通常位于用户配置目录下的 Codex 状态目录，具体位置会随版本和平台变化，本报告不将其硬编码到产品中。后端应：

- 仅在后端调用 `codex login`；
- 不读取原始 token；
- 使用 keychain 存储用户选择的登录方式；
- 只保存 `account/read` 所返回的脱敏状态；
- 在启动页显示当前身份、workspace 或 organization 以及额度；
- 对“重置身份”执行完整登出，而不是只清除 UI 状态。

ChatGPT 身份和 API key 的安全属性不同：

| 登录方式 | 主要用途 | 数据与控制域 |
|---|---|---|
| ChatGPT 订阅登录 | 订阅访问、托管 workspace、管理员策略 | ChatGPT workspace、RBAC、企业保留与驻留设置 |
| API key | 按用量计费的程序化访问 | API organization 的保留和数据共享设置 |

官方明确：ChatGPT 桌面端、CLI 和 IDE 扩展都支持这两种本地登录方式；使用 API key 时按标准 API 价格计费，并可能失去部分依赖 ChatGPT workspace 或云端服务的功能。[9]

对自托管模型或第三方 provider，可行路径是配置 **OpenAI API 兼容 endpoint**。技术上通常通过设置 `base_url`、模型别名和 API key 实现，但上游并不保证所有 ChatGPT-only 插件、托管功能或企业能力都可移植。具体字段仍须以目标版本配置 schema 为准。

如果目标是 OpenRouter 或其他兼容网关，应设置：

- 受控环境变量或加密配置中的 `OPENAI_API_KEY`；
- provider base URL；
- 明确的模型白名单；
- 企业租户限制；
- 网络出口限制；
- 凭据轮换；
- 使用追踪；
- 不允许同一配置同时访问未知 provider。

“兼容 OpenAI 接口”并不意味着可以安全替换 Codex 后端：

- 未知 provider 可能缺少响应模式、工具调用格式或流式事件；
- 数据可能离开 OpenAI 边界；
- 可能改变配额、内容安全与数据保留策略；
- Agent 可能通过 MCP 或网络工具接触更多敏感上下文。

因此，第三方模型适合用于受控实验或内部工具，不适合未经评估就成为默认生产路径。

---

## 7. MVP 应优先覆盖持久会话、审批、中断和断线恢复

**结论：最小产品不是“能发一条消息”，而是能在崩溃、审批和取消后恢复一致状态。** 第一版必须覆盖会话生命周期、增量渲染、显式授权和进程管理；MCP、插件、计划模式和实验字段应在能力协商完成后再开放。

MCP server 列表、能力发现、协作模式、用户验证、`rollout/compress` 等能力可逐步接入，但必须按以下原则隔离：

- 使用 `capabilities` 控制可见性；
- 通过 feature flag 管理实验能力；
- 严格区分稳定字段与 `experimentalApi`；
- 避免将内部字段直接写入稳定数据库 schema；
- 所有外部来源的工具描述均按不可信内容渲染。

### 7.1 第一版后端状态

```rust
struct CodexSession {
    child: Child,
    next_id: AtomicU64,
    pending: Mutex<HashMap<Id, Sender<Result<Value>>>>,
    threads: Mutex<HashMap<ThreadId, ThreadView>>,
    policies: Arc<PolicyStore>,
}

enum CodexEvent {
    Thread(ThreadNotification),
    Turn(TurnNotification),
    Item(ItemNotification),
    ApprovalRequest(Approval),
}
```

`CodexBridge` 应暴露以下 Tauri commands：

- `start_thread(workspace, model, sandbox)`；
- `resume_thread(thread_id)`；
- `send_turn(thread_id, parts)`；
- `steer(thread_id, text)`；
- `interrupt(thread_id)`；
- `resolve_approval(approval_id, decision, scope)`；
- `archive_thread(thread_id)`；
- `read_config()`；
- `write_config_batch(changes)`。

前端通过 `tauri::Event` 接收以下事件：

- `codex:thread_started`；
- `codex:delta`；
- `codex:command`；
- `codex:patch`；
- `codex:approval_required`；
- `codex:turn_completed`；
- `codex:error`。

命令处理流程为：

```text
invoke("send_turn")
 → CodexBridge.send("turn/start", …)
 → await response
 → 立即返回 thread/turn 标识
 → 后续所有通知异步 emit
```

这一设计的关键边界是：**请求响应只确认方法已被接受，不代表轮次已经完成。** 所有持续性状态都必须来自事件。前端不得根据 `run()` 风格的单个 Future 决定会话最终状态。

### 7.2 实现顺序

1. 封装 `ChildStdinWriter` 和 `BufReader<stdout>`，以换行边界拆包；
2. 实现 `send_request` 超时、取消与 `pending` 清理；
3. 实现 `send_notification`；
4. 维护 `id → oneshot`；
5. 将服务器请求通过临时 `approval_id` 映射到 UI；
6. 实现 `turn/interrupt`，并对同一轮次保证幂等；
7. 将每个事件追加到 SQLite/WAL，保存 `thread_id`、`turn_id`、`item_id`、序号、时间戳和原始 JSON；
8. 启动时先调用 `thread/read` 或本地历史重建，再订阅后续事件；
9. 子进程异常退出时，标记活动轮次 `unknown`；
10. 禁止自动以更高权限重启，必须由用户确认。

断线恢复不能只依赖服务器历史。客户端本地也应保留事件游标，以便在 app-server 进程重启后重建会话视图。若服务器历史不可用，至少应保留可读的失败状态，而不是静默覆盖已有补丁。

### 7.3 UI 必须围绕“正在形成的结果”组织

**结论：传统聊天框不足以表达 Agent 工作单元。** UI 应围绕 Thread、Turn、Item 和 Approval 四个对象建模，而不是把所有输出拼接为纯文本。

每个 Turn 应包含：

- 用户消息；
- Agent 消息 delta；
- 计划；
- 命令开始与结束；
- 命令日志；
- 补丁；
- 审批；
- token 用量；
- 错误；
- 完成状态。

文件变更应先写入临时草案，再由用户审查后提交。即便 Agent 拥有写权限，也不应跳过 diff 审核。

推荐桌面端默认策略为：

- 默认 `read-only` 或 `workspace-write`；
- 明确配置 `writable_roots`；
- Git 目录默认只读；
- 网络默认受限；
- 所有命令、补丁和 `full_access` 请求都走 `on-request`；
- “始终允许”必须限制到精确命令前缀、当前线程或工作区；
- 禁止全局永久 `never`；
- 禁止将 `--dangerously-bypass-approvals-and-sandbox` 设为常规配置。

---

## 8. 社区案例验证了协议路线，但不能替代最新源码核验

**结论：公开实现普遍验证了“包装子进程、复用 JSON-RPC、在宿主应用中渲染事件”的可行路径，但 fork 与旧文章不能代替目标版本的源码审阅。** 安装前必须核对依赖、许可证、更新状态和沙箱实现。

典型复刻通常具备以下结构：

- 前端线程侧栏；
- 流式 Markdown；
- 终端/命令视图；
- diff 视图；
- 权限弹窗；
- 配置页；
- 通过 npx、npm 全局包或 cargo 启动 `codex`；
- 读取 JSONL；
- 将事件转换为前端状态。

GitHub 搜索可见的相关项目类型包括：

- `codex-desktop`；
- `codex-gui`；
- 集成 `codex-mcp-server` 的 Agent UI；
- 将 `codex-core` 嵌入 Tauri 的 fork。

这些名称变化较快，本报告不将特定 GitHub star 数、维护状态或未审计仓库写成事实。接入前应重点检查：

- 是否锁定 CLI 版本；
- 是否实现 `interrupt` 和审批；
- 是否处理子进程泄漏；
- 是否具备事件持久化；
- 是否支持历史恢复；
- 是否限制工作区与网络；
- 是否允许任意 `danger-full-access`；
- 是否完整处理升级与异常重启。

最可信的“参考客户端”仍是官方 TUI 和 VS Code 扩展。官方说明指出，TUI 历史上曾作为直接调用 core Rust 类型的原生客户端，而现代富客户端主要通过 app-server 接入；VS Code 扩展与 macOS Desktop App 则作为官方产品直接使用该接口。[1]

这说明两条路径都存在：

- **同进程 core：** 开发效率高，但升级耦合强；
- **app-server：** 多一层进程，但接口更清晰。

对第三方产品，后者的可维护性更强。若未来官方将 TUI 完全迁移到 app-server，则直接耦合 core 的长期维护成本还会进一步上升。

---

## 9. 最终决策：锁定版本、默认隔离、显式审批、持续审计

**结论：应把 app-server 作为 Agent 控制面，把 OS 沙箱作为执行强制面，把审计与恢复作为产品面。** 三者缺一，都会让“复用 Codex”退化为仅封装一个命令执行器。

协议不是普通 CLI 文本流，而是一个围绕 Thread、Turn、Item 与审批建立的有状态控制协议。官方明确将 app-server 定位为驱动 Codex VS Code 扩展等富客户端的接口，并提供 `initialize`、线程、轮次、账户、配置、模型、MCP 和审批能力。[2][3]

WebSocket 和 Unix socket 可以用于实验，但官方明确标记 app-server 命令与 WebSocket 传输为实验性，不建议用于生产工作负载。[2] 对 Tauri 2 而言，最稳健的落地方式仍是 Rust 后端长期托管 `codex app-server` 子进程，前端只处理领域事件与用户授权。

安全检查表如下：

- [ ] 锁定并校验 `codex` 二进制，最低版本不低于已修复 CVE 的版本；
- [ ] 固定工作区绝对路径，不再信任运行期 `cwd` 变更；
- [ ] 默认采用 `read-only` 或 `workspace-write`，并最小化 `writable_roots`；
- [ ] 保护 `.git`、`.codex` 等敏感路径；
- [ ] 默认 `on-request`；禁止“始终允许所有命令”；
- [ ] 对所有 `execCommandApproval`、`applyPatchApproval` 展示完整命令、diff、来源和影响范围；
- [ ] 使用独立低权限账户或容器，作为 Linux/macOS 的第二层防御；
- [ ] Windows 仅用于隔离充分的环境；
- [ ] 将每次 allow/deny、命令、patch、模型、token 估算和退出码写入审计日志；
- [ ] 冻结 `generate-json-schema` 输出，并建立协议差异 CI；
- [ ] 正确处理 `turn/interrupt`、子进程崩溃和重新连接；
- [ ] 第三方 provider 必须经过 endpoint、模型、数据和凭据风险评估。

**若只能在两项能力之间排序，优先级应为“默认隔离 + 显式审批”高于“多模型兼容”。** Codex 的 Agent 会读写文件、执行命令并访问网络，其风险不来自模型名称，而来自工具与执行边界。只有先固化工作区、进程和系统层隔离，再逐步开放 MCP、插件与第三方模型，桌面端才是在复用成熟 Agent 内核，而不是把不受控命令执行器包装成聊天界面。

---

## 数据来源

[1] **Unlocking the Codex harness: how we built the App Server（OpenAI）**  
https://developers.openai.com/codex/app-server/how-we-built-the-app-server/

[2] **Codex App Server 官方文档**  
https://developers.openai.com/codex/app-server/

[3] **Codex App Server 嵌入产品与协议集成**  
https://www.codex-docs.com/docs/app-server

[4] **openai/codex 仓库主页**  
https://github.com/openai/codex

[5] **openai/codex：`codex-rs/app-server-protocol/src/protocol` 目录**  
https://github.com/openai/codex/tree/main/codex-rs/app-server-protocol/src/protocol

[6] **Codex Linux Sandbox README**  
https://github.com/openai/codex/blob/main/codex-rs/linux-sandbox/README.md

[7] **Codex Sandbox 文档**  
https://github.com/openai/codex/blob/main/docs/sandbox.md

[8] **Codex Sandboxing（GitHub Gist 技术材料）**  
https://gist.github.com/

[9] **Codex Authentication（OpenAI Developers）**  
https://developers.openai.com/codex/authentication/

[10] **Codex SDK（OpenAI Developers）**  
https://developers.openai.com/codex/sdk/

[11] **OpenAI open-sourced the agent loop, not the model（DEV Community）**  
https://dev.to/breachprotocol/openai-open-sourced-the-agent-loop-not-the-model-59ih

[12] **openai/codex Security Advisories**  
https://github.com/openai/codex/security/advisories

[13] **GHSA-w5fx-fh39-j5rw：Sandbox bypass due to bug in path configuration logic**  
https://github.com/openai/codex/security/advisories/GHSA-w5fx-fh39-j5rw

[14] **National Vulnerability Database：CVE-2025-59532**  
https://nvd.nist.gov/vuln/detail/CVE-2025-59532

[15] **Codex as a platform: build on the open agent harness（OpenAI Developers）**  
https://developers.openai.com/codex/codex-as-a-platform/

[16] **OpenAI open-sourced the agent loop, not the model（补充链接）**  
https://dev.to/breachprotocol/openai-open-sourced-the-agent-loop-not-the-model-59ih

[17] **Codex 开源 Harness、DSH 推“一切皆插件”：Agent 时代真正在争的，是模型的“神经系统”**  
https://blog.csdn.net/caelus_mv/article/details/164050257

[18] **OpenAI Codex：Persistent threads and experimental APIs**  
https://developers.openai.com/codex/app-server/how-we-built-the-app-server/

[19] **openai/codex 主仓库 LICENSE**  
https://github.com/openai/codex/blob/main/LICENSE

[20] **openai/codex：`codex-rs/app-server` 目录**  
https://github.com/openai/codex/tree/main/codex-rs/app-server

[21] **openai/codex：`codex-rs/core/src/agent` 目录**  
https://github.com/openai/codex/tree/main/codex-rs/core/src/agent