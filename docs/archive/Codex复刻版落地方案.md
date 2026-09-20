# Codex 复刻版落地方案

> 技术栈：**Tauri 2（Rust + React/TypeScript）**
> Agent 内核：**复用 OpenAI 开源 `codex app-server` 协议（Apache-2.0），不自研 Agent loop**
> 安全模型：**严格沙箱 + 显式审批流 + 全程审计**
> 目标读者：执行实现的 LLM / 工程团队
> 版本：v1.0 ｜ 2026-09-20

---

## 0. 这份文档怎么用

这是一份**实现规格书**，不是概述。请按顺序执行，每个 Phase 完成并通过验收清单后再进入下一 Phase。

- 文档中所有 `方法名/字段名` 来自 OpenAI 官方文档确认或源码推断，**已标注来源**。
- 凡标注 `[源码推断]` 的内容，实现前必须先运行 `codex app-server generate-json-schema` 对当前锁定版本校验一次。
- 凡标注 `[产品决策]` 的内容是实现方自主设计，不受上游协议约束。
- 除非另有说明，**不要**为了"体验流畅"而放宽第 6 章的任何安全红线。

---

## 1. 项目定位与非目标

### 1.1 做什么

一个**本地优先、可审计、可恢复**的 AI 编程 Agent 桌面控制台。复刻的不是 Codex 某个窗口的外观，而是它的产品机制：

> 让 Agent 在**明确边界内**长期运行，让用户始终能够**看见、审批、纠正、接管**。

### 1.2 不做什么（MVP 阶段明确排除）

| 排除项 | 原因 |
|---|---|
| 自研 Agent loop / 工具调度 | 直接复用 `codex app-server`，避免重复造轮子 |
| 云端 runtime / Codex Cloud 对等功能 | 需要自有后端与容器基础设施，Phase 4 再议 |
| 手机远程控制 | 依赖 relay 服务与设备配对，Phase 4 |
| 自实现模型推理 | 只做客户端，模型由用户自选 provider |
| 任何形式的遥测/工作区快照上传 | 见 6.1 隐私红线 |

### 1.3 安全红线：必须做成 ZCode 的"反面对照"

2026-09 智谱 ZCode 事件的完整链路已被逆向确认：客户端在登录状态下由**宿主级 sidecar 进程**（不在 Agent 工具循环内）静默打包整个工作区，包含完整 `.git` 历史、LFS 缓存、reflog 与全局配置，用服务端动态下发的 RSA 公钥做信封加密后直传对象存储；UI 上的"体验优化""仓库快照索引"两个开关**均无法阻止打包上传本身**；单个会话最多产生 62 次快照，上传失败会无限重试。

这个事件的关键教训是：**"checkpoint /rollback" 这类让 Agent 变安全的功能，同时也是完美的数据外泄通道。**

因此本项目把下面这条作为**架构级约束**，而不是设置项：

> **Agent 运行时之外，不得存在任何读取工作区文件并向网络发送数据的宿主进程或后台任务。**

---

## 2. 总体架构

### 2.1 分层

```
L3  展示层   React 18 + TypeScript（WebView）
             ── 只接收领域状态，绝不拼接原始 JSON-RPC
L2  领域层   Rust DomainStore
             ── Thread / Turn / Item / Permission / ChangeSet / Automation
L1  适配层   Rust ProtocolAdapter + JsonlTransport
             ── 管理 codex app-server 子进程，翻译协议
L0  宿主层   Tauri 2 窗口、进程、文件系统、keychain、通知
```

**核心边界：前端不直接依赖官方 wire type。** 官方 app-server 仍被官方标记为实验性，字段会变。适配层的职责就是吸收这些变化，让 UI 契约保持稳定。

### 2.2 进程模型

```
┌─────────────────────────────────────────────┐
│ Tauri Main Process (Rust)                   │
│                                             │
│  CodexBridge                                │
│   ├─ ChildProcess  (codex app-server)       │
│   │    stdin  ← JSONL 请求                  │
│   │    stdout → JSONL 响应/通知/审批请求     │
│   │    stderr → 日志                        │
│   ├─ JsonlCodec                             │
│   ├─ SessionStore   (thread/turn 游标)      │
│   ├─ EventLog       (SQLite WAL，事件溯源)  │
│   └─ PolicyGate     (默认 deny + 审计)      │
│                                             │
│  ProjectWorkspaceService (git/worktree)     │
│  PermissionGate                             │
│  CredentialVault      (keychain)            │
└──────────────┬──────────────────────────────┘
               │ Tauri commands + events（类型化）
┌──────────────▼──────────────────────────────┐
│ WebView (React)                             │
└─────────────────────────────────────────────┘
```

**关键决策：Rust 后端独占 app-server 的 stdin/stdout。** 不要用 WebView 直接 spawn 子进程并用 Node 逐行解析——那会丢掉统一的日志、崩溃恢复、版本管理与生命周期控制。

### 2.3 技术选型

| 层 | 选型 | 理由 |
|---|---|---|
| 桌面壳 | Tauri 2 | 体积小、性能好、原生手感，一套代码覆盖 macOS/Win/Linux |
| 前端 | React 18 + TypeScript + Vite | 生态成熟，Agent 流式 UI 组件复用度高 |
| 状态 | Zustand（前端）+ SQLite/WAL（Rust 事件日志） | 前端轻量，事件持久化交给后端 |
| 传输 | **stdio JSONL**（生产唯一推荐） | WebSocket 被官方标记 experimental 且不建议生产 [官方] |
| Diff | `diff` crate（Rust 侧计算）+ 自研 hunk 渲染 | 避免前端重新解析补丁 |
| Git | `git2` / 直接调 `git` CLI | worktree、diff、merge 都要用 |
| 凭据 | OS keychain（tauri-plugin-keyring 或等价） | 不落明文 |
| 命令执行展示 | 前端虚拟终端组件（xterm.js 或自研） | 长输出需虚拟滚动 |

---

## 3. Codex 交互范式全集（需要复刻的东西）

### 3.1 四级信息架构

**Project 是安全边界，Thread 是任务边界，二者不可混用。**

| 层级 | 职责 | UI 表达 | 官方原语 |
|---|---|---|---|
| **Project** | 锚定仓库/目录、信任等级、模型、权限 profile、Skills/MCP | 项目切换器；显示分支/worktree、信任状态 | 本地项目 + config 层 |
| **Thread** | 单一任务的持久对话与跨轮上下文 | 可命名、置顶、搜索、分组、归档、恢复、fork | `thread/start` `thread/resume` `thread/fork` `thread/archive` |
| **Turn** | 用户一次输入触发的连续工作 | 折叠时间线、状态、耗时/token、停止/重试 | `turn/start` `turn/steer` `turn/interrupt` |
| **ChangeSet** | 一个 Turn 产生的文件变更及审阅结论 | 文件树、逐文件 Diff、接受/拒绝、行内评论 | `applyPatch/*` Item 聚合 |

Project 至少绑定：工作目录或 worktree 路径、信任等级、默认模型与 reasoning effort、sandbox 与 approval profile、AGENTS.md/Skills/MCP 配置、当前分支与 Git 健康状态。

### 3.2 桌面三栏布局

```
┌────────────────┬──────────────────────────────┬───────────────────────┐
│ Projects       │ Thread messages / turn log    │ Review & Context      │
│ + Add Project  │ ─ User prompt                 │ Files / Tree          │
│ › repo-a       │   Agent reasoning/plan        │  Diff (split/unified) │
│   • Fix login  │   Tool: read/search/test      │  Inline comments      │
│   • Add OAuth  │   ⚠ AskForApproval            │ Approval detail       │
│ › repo-b       │   Command output              │ Terminal              │
│ Threads        │   File changes                │ Git / PR              │
│ Skills         │ ─ User follow-up              │                       │
│ Automations    │ Composer                      │                       │
└────────────────┴──────────────────────────────┴───────────────────────┘
```

**侧栏排序的第一依据是"待用户操作"，不是最近活动时间：**

```
等待审批 > 运行中且可介入 > 失败 > 最近完成 > 已暂停
```

每个 Thread 行至少显示：标题/自动摘要、仓库与 worktree、模型、最后更新、变更文件数、审批/失败状态徽标。

### 3.3 核心任务闭环（7 阶段）

```
提交 → 规划/探索 → 预览命令或变更 → 审批（如需） → 执行 → 测试/验证 → 结果 & ChangeSet → 审阅 → 提交/PR → 多轮追问
```

| 阶段 | 用户动作 | UI 应显示 | 协议映射 |
|---|---|---|---|
| 1. 创建任务 | 选 Project；选 Local/Worktree；输入目标，可附加文件/截图 | 运行模式、模型、effort、权限预设、base branch | `thread/start` + 设置 cwd/worktree |
| 2. 规划 | 无需显式点"计划" | 计划摘要、受影响模块、验证策略、风险 | Agent/tool Items，推理细节可折叠 |
| 3. 审批 | 查看命令、目录、网络、文件写入、作用域 | 命令、环境变量脱敏摘要、差异预览、Allow once / Always for profile / Deny / Edit command | `execCommandApproval` `applyPatchApproval` |
| 4. 执行 | 可中途停止、追加追问、降低权限 | 实时命令输出、测试进度、token/时间 | `execCommand/*` `item/*` 增量 delta |
| 5. 审阅 | 检查 Diff、写评论、接受/拒绝 | 文件树、逐行 Diff、测试/lint 状态、冲突风险 | ChangeSet 聚合 |
| 6. 合入 | Commit、Push、Create PR 或继续迭代 | Commit 分组、PR 模板、目标分支、CI 链接 | Git tool calls（先成 ChangeSet 再原子操作） |
| 7. 追问 | 引用某行/评论/计划分支 | 引用锚点、相关文件、fork 提示 | Turn 追加；长上下文触发 compact/fork |

### 3.4 审批范式（严格模式下的核心）

**审批模态框必须回答五个问题：做什么 / 为什么 / 在哪里 / 影响多大 / 是否允许后续复用。**

| 必答问题 | 最低展示内容 |
|---|---|
| 做什么 | 完整命令或工具参数，**环境变量默认脱敏** |
| 为什么 | Agent 目标、相关计划步骤、审批原因 |
| 在哪里 | 工作目录、git root、worktree、目标文件或 URL |
| 影响多大 | 写入/删除/网络/凭据探测/持久化/破坏性操作/依赖安装等 risk tier |
| 如何决策 | Allow once ｜ Allow for this profile ｜ Always require ｜ Deny ｜ Edit command |
| 如何追溯 | 显示完整 `threadId / turnId / itemId` 调试链路 |

**风险分级（避免审批疲劳）：**

- 低风险（读文件、grep、只读 git 命令）→ 默认放行或批量处理
- 中风险（工作区内写文件、装依赖、跑测试）→ 批量确认
- 高风险（工作区外写入、删除、网络外发、sudo、凭据访问、git push/force）→ **单独阻塞，强制确认**

"Always allow" 必须记录**作用域**：当前 Thread / 当前 Project / 当前 Profile / 全局。禁止存在"全局永久 never"。自动批准也要写审计日志。

### 3.5 Diff / Review 范式

**"已提议"与"已应用"必须分离。** 状态机：

```
proposed → user_reviewing → accepted_partial | accepted_all | rejected | edited
                                                        ↓
                                            committed → PR_open | merged
```

文件树按变更类型分组：added / modified / deleted / renamed / conflicting / generated，同时显示风险标签、评论数、测试状态。逐文件至少支持：打开 Diff、跳到某行、行内评论、单文件接受/拒绝、撤销变更、外部编辑器打开。

行级评论发送前区分"仅作上下文"与"要求修改"；后者自动追加为下一轮用户指令。

### 3.6 Worktree 并行范式

**Worktree 不是高级 Git 命令，是并行 Agent 之间最基础的安全边界。** 新建 Thread 时把运行模式明确分成三档：

1. **Current working tree** —— 快速调试、小范围修改
2. **New worktree** —— 功能开发、实验性重构、长任务（**推荐默认**）
3. **Cloud runtime** —— Phase 4

创建面板同步显示：base branch、目标分支/worktree 名、路径、当前 Git 状态、已有未提交变更、风险。

并行 Agent 不能只是多个标签页：同一 Project 下允许多个 active Thread，但每个 Thread 必须绑定独立 worktree 或明确标记为共享工作区。合并前强制：更新 base → 跑验证 → 生成冲突报告 → 三方 Diff → 必要时交回人工。

### 3.7 扩展机制三层（不要全塞进一个巨型 AGENTS.md）

| 能力 | 位置 | 触发 | UI 表达 |
|---|---|---|---|
| 项目规则 | `AGENTS.md`、`.codex/`、`.agents/` | 自动加载 | Settings 里"已加载指令"预览与优先级 |
| 可复用流程 | `SKILL.md` + scripts/references | 显式调用或 description 隐式匹配 | Skills 列表、依赖检查、运行入口 |
| 外部工具 | MCP server | Agent 工具调用 | Servers 列表、工具/资源、连接状态 |
| 一次性命令 | 内置 slash command | 用户输入 `/` | Command palette |

加载层级：`~/.codex/AGENTS.md` → 仓库根/嵌套 `AGENTS.md` → 全局与仓库 Skills → `.agents/skills`。

MVP 最小 slash 命令集：`/review` `/plan` `/explain` `/test` `/commit` `/pr` `/fork` `/permissions` `/skill`。每个命令映射到可回放的领域动作，**不是在前端拼接自由文本**。

### 3.8 Automations

不是"聊天 + cron"，是独立领域对象：

```yaml
Automation:
  trigger: cron | event | manual
  input: prompt | skill_ref | prompt_template
  context: project | worktree | uploaded | connected_tools
  policy: sandbox, approvals, reviewer, notification
  run_history: status, thread_ref, changeset_ref, review_decision
```

适合：每日 Issue triage、CI 失败汇总、依赖更新、安全扫描、release brief。
**禁止自动执行**：自动合并、生产部署、密钥变更、破坏性迁移（除非已有强审批 + dry-run + 可观测性）。

必须提供"先在普通聊天里试跑"入口，每次 run 映射为可恢复 Thread，避免变成无法审计的幽灵脚本。

### 3.9 Cloud Handoff / Mobile（Phase 4，MVP 不做）

Handoff 最小契约：Thread 可恢复、依赖可说明、产物可回流。桌面端需区分四种执行位置：**local run / worktree run / cloud run / remote host**，任务卡同步显示执行位置、依赖来源、网络策略、凭据策略、超时、输出去向。

Cloud 任务天然无法访问本机 `.env`、SSH、内网服务。缺少依赖时**不能假装能继续执行**，要明确提示"本地依赖不可达"，并允许降级为 Plan-only 或交回本地 Agent。

---

## 4. 数据模型

### 4.1 Rust 侧核心结构

```rust
// 后端会话句柄
pub struct CodexSession {
    child: Child,                                        // app-server 子进程
    next_id: AtomicU64,                                  // JSON-RPC id 生成器
    pending: Mutex<HashMap<Id, oneshot::Sender<Result<Value>>>>,
    threads: Mutex<HashMap<ThreadId, ThreadView>>,
    policies: Arc<PolicyStore>,
    event_log: Arc<EventLog>,                            // SQLite WAL
}

// 领域事件（前端只看到这些）
pub enum CodexEvent {
    Thread(ThreadNotification),
    Turn(TurnNotification),
    Item(ItemNotification),
    ApprovalRequest(Approval),
}

// 持久化事件记录
pub struct EventRecord {
    pub seq: u64,
    pub thread_id: String,
    pub turn_id: Option<String>,
    pub item_id: Option<String>,
    pub ts: i64,
    pub kind: String,
    pub raw_json: String,      // 保留原始报文，便于协议变更时重放
}
```

### 4.2 TypeScript 侧 Item 联合类型

```ts
type Item =
  | UserMessage
  | AgentMessage
  | CommandRun   { status, command, outputChunks, exitCode }
  | FileChange   { path, kind, diffId, reviewStatus }
  | ToolCall     { server, tool, argsSummary, resultSummary }
  | RequestApproval { permissionKind, risk, reason, decision? }
  | ChangeSet    { files, commitCandidate, prCandidate };

type TurnStatus =
  | 'queued' | 'running' | 'awaiting_approval' | 'verifying'
  | 'success' | 'failed' | 'cancelled' | 'needs_input' | 'unknown';

type ThreadStatus = 'active' | 'archived';

type RiskTier = 'low' | 'moderate' | 'high' | 'critical';
```

### 4.3 关键字段清单（最小可恢复集）

| 模块 | 最小字段 | 关键交互 |
|---|---|---|
| Project | id, path, worktreeStrategy, trust, profile, skills, mcp | 添加、信任、切换、检测 Git |
| Thread | id, projectId, title, createdAt, status, pinned, archived | 新建、搜索、分组、归档、恢复、fork |
| Turn | id, threadId, status, model, effort, startedAt, finishedAt | 停止、重试、引用、压缩 |
| Item | id, turnId, type, lifecycle, payload, createdAt | 增量渲染、展开、定位文件 |
| Permission | id, itemId, kind, risk, reason, scope, decision | Allow once/profile、Deny、Edit |
| ChangeSet | id, turnId, files, reviewState, base/head | 逐文件审阅、批量接受、撤销 |
| Automation | id, trigger, skill/prompt, policy, lastRun, reviewQueue | 试运行、启停、run history |

---

## 5. 协议适配层规格

### 5.1 传输

| 传输 | 启动参数 | 格式 | 结论 |
|---|---|---|---|
| **stdio** | `--listen stdio://` | 换行分隔 JSON（JSONL） | **生产唯一推荐** |
| WebSocket | `--listen ws://IP:PORT` | 每帧一条 JSON-RPC | 官方标记 experimental，**不用于生产** |
| Unix socket | `--listen unix://[PATH]` | HTTP Upgrade → WebSocket | 受控环境可选 |

**MVP 只用 stdio。** 不要在用户机器上开放监听端口——即使绑定回环。

### 5.2 报文

标准 JSON-RPC 2.0，但**线路上省略 `"jsonrpc":"2.0"` 头**，解析器不能强制要求该字段。

```json
{ "jsonrpc": "2.0", "id": 1, "method": "thread/start", "params": {} }
{ "id": 1, "result": { "thread": { "id": "thr_xxx" } } }
{ "method": "item/started", "params": { "threadId": "thr_xxx", "item": {} } }
{ "id": 7, "error": { "code": -32000, "message": "thread not found" } }
```

握手（每个连接只允许一次，且必须早于其他业务方法）：

```json
["initialize", 0, {
  "clientInfo": { "name": "tauri-codex", "title": "Tauri Codex", "version": "0.1.0" }
}]
=> { "id": 0, "result": { "serverInfo": { "name": "codex", "version": "…" },
     "capabilities": { "threads": true, "approvals": true } } }

["initialized", null, {}]
```

### 5.3 方法清单

| 类别 | 官方方法 | 我方责任 |
|---|---|---|
| 初始化 | `initialize` `initialized` | 校验 serverInfo、capabilities、兼容版本 |
| 线程 | `thread/start` `thread/resume` `thread/fork` `thread/read` `thread/list` `thread/archive` `thread/unarchive` `thread/delete` `thread/compact/start` | 映射到工作区、侧栏、历史 |
| 轮次 | `turn/start` `turn/steer` `turn/interrupt` | 提交输入、追加纠偏、取消（保证幂等） |
| 账户 | `account/read` `account/login/start` `account/login/cancel` `account/logout` `account/rateLimits/read` | 展示登录态、配额 |
| 配置/模型 | `config/read` `config/value/write` `config/batchWrite` `model/list` | 校验写入项，UI 不得直接覆盖安全策略 |
| 审批 | 服务端主动请求 → `applyPatchApproval` `execCommandApproval` | 弹模态、记录决策与上下文 |

### 5.4 事件清单

| 类别 | 通知 | 工程映射 |
|---|---|---|
| 生命周期 | `thread/started` `thread/archived` `thread/unarchived` | 更新侧栏、加载/冻结视图 |
| 轮次 | `turn/started` `turn/completed` `turn/failed` | 绑定 turnId，显示运行/取消/错误/token |
| 条目 | `item/started` `item/completed` | 创建/收尾消息、命令、补丁、工具卡片 |
| 流式 | `item/agentMessage/delta` `reasoning/*` | 追加渲染，**避免整树重渲染** |
| 执行 | `execCommand/*` `item/command/*` | 命令、状态、stdout/stderr、耗时、退出码 |
| 文件 | `applyPatch/*` `item/patch/*` | diff parser → 文件树 + hunk |
| 审批 | `applyPatchApproval` `execCommandApproval` | 模态审批，记录决策 |
| 账户 | `account/login/completed` | 登录流程与错误恢复 |

> ⚠️ **审批报文骨架为 `[源码推断]`，必须先校验**：
> ```bash
> codex app-server generate-json-schema --out schemas/v2
> codex app-server generate-ts --out src/codex
> ```
> 把生成结果与**固定的 CLI 版本**一起提交到仓库，并在 CI 里做协议差异比对。

### 5.5 实现顺序（严格按序）

1. 用官方 SDK 写 **contract test**：确认目标 CLI 版本支持哪些方法
   - TS: `npm i @openai/codex-sdk`（Node ≥18）
   - Python: `pip install openai-codex`（Python ≥3.10）
2. 生成并冻结 JSON Schema
3. Rust 实现 `JsonlTransport`：封装 `ChildStdinWriter` + `BufReader<stdout>`，**按换行边界拆包**
4. 实现 `send_request`（超时/取消/pending 清理）、`send_notification`
5. 维护 `id → oneshot` 映射
6. 把服务端发起的审批请求通过临时 `approval_id` 映射到 UI
7. 实现 `turn/interrupt`，同一轮次幂等
8. 每个事件追加到 SQLite/WAL（seq、thread_id、turn_id、item_id、ts、kind、raw_json）
9. 启动时先 `thread/read` 或用本地历史重建，再订阅后续事件
10. 子进程异常退出 → 活动轮次标记 `unknown`；**禁止自动以更高权限重启**

> **关键边界：请求响应只确认方法已被接受，不代表轮次完成。** 所有持续性状态必须来自事件。前端不得用单个 Future 的返回值决定会话最终状态。

### 5.6 Tauri commands / events 契约

```rust
// commands（前端 → 后端）
start_thread(workspace, model, sandbox) -> ThreadId
resume_thread(thread_id)
send_turn(thread_id, parts) -> TurnId
steer(thread_id, text)
interrupt(thread_id)
resolve_approval(approval_id, decision, scope)
archive_thread(thread_id)
read_config()
write_config_batch(changes)
```

```ts
// events（后端 → 前端）
'codex:thread_started' | 'codex:delta' | 'codex:command'
| 'codex:patch' | 'codex:approval_required'
| 'codex:turn_completed' | 'codex:error'
```

---

## 6. 安全模型（本项目最重要的部分）

### 6.1 隐私红线 10 条（架构级约束，不可被设置项覆盖）

1. **禁止任何"工作区快照/checkpoint 上传"功能。** 若未来要做 checkpoint，**只允许本地增量快照，且必须能一键关闭并真正生效**。
2. **禁止存在脱离 Agent 工具循环的宿主级采集 sidecar。** 所有文件读取必须经过 Item 事件，对用户可见。
3. **禁止静默网络外发。** 除用户显式配置的目标（模型 provider、MCP server、git remote）外，任何出站请求都必须在审批弹窗中显示目标 URL、用途与 payload 摘要。
4. **禁止"开关形同虚设"。** 每个隐私开关必须有**单一、可验证的语义**，并在文档中写明"关闭后具体不发生什么"。开关关闭后必须能在网络层观测到行为停止。
5. **默认不采集遥测。** 如需崩溃/用量统计，**默认关闭**，首次启动显式询问，且**绝不包含代码内容、文件路径、仓库名**。
6. **上传内容必须可本地解密/可导出。** 若做加密存储，**私钥必须在用户手里**，不允许"只有服务端能解"。
7. **凭据只进 OS keychain**，不写明文配置文件，不进日志，不进事件快照（写入前脱敏）。
8. **审批视图默认脱敏**：`.env`、私钥、token、`Authorization` 头、连接串一律掩码显示，提供"点击显示"并记审计。
9. **开源客户端 + 可复现构建。** 提供构建脚本与依赖锁定，让第三方可验证"代码里没有采集逻辑"。
10. **提供一键导出审计日志**，让用户能自己回答"这个工具对我的代码做了什么"。

### 6.2 沙箱分层（默认隔离）

| 层 | macOS | Linux | Windows |
|---|---|---|---|
| OS 层 | Seatbelt（`sandbox-exec` profile） | `bwrap` 只读根 `--ro-bind / /` + 可写根叠加 + `PR_SET_NO_NEW_PRIVS` + 进程内 seccomp 网络过滤 | 受限令牌 + AppContainer（**官方标记高度实验性**） |
| 进程层 | 子进程独占 | 同左 | 同左 |
| 策略层 | `sandbox_mode` + `approval_policy` + `writable_roots` | 同左 | 同左 |
| 审计层 | 全量事件 + 审批决策落 SQLite | 同左 | 同左 |

> ⚠️ **Windows 沙箱不可靠**：官方说明 Everyone SID 已有写权限的目录无法被可靠限制。Windows 生产使用**必须在 Codex 之外**再加 Hyper-V / WSL / 容器 / 独立低权限账户。

Linux 细节：优先用 PATH 中位于 cwd 之外的 `bwrap`；系统 bwrap 过旧则走兼容路径；找不到则回退 `codex-resources/bwrap`；`.git`、解析后的 `gitdir:`、`.codex` 重新绑定为只读。（旧版 Landlock 回退仅在策略等价时启用，**不要按历史文章硬编码假设**。）

### 6.3 审批策略

| 档位 | 行为 | 适用场景 |
|---|---|---|
| `untrusted` / `on-request` | 边界外或敏感动作必须请求审批 | **默认交互式桌面端（本项目默认）** |
| `on-failure` | 首次失败后请求授权/放宽 | 受控自动化 |
| `never` | 不弹窗，仍受 sandbox mode 限制 | CI / 一次性脚本 |
| `danger-full-access` | 无文件系统沙箱，所有命令允许 | **仅临时隔离实验，禁止作为常规配置** |

**危险命令识别只是体验层，不是强制访问控制。** 真正的强制边界来自 Seatbelt/bwrap+seccomp、明确 `writable_roots`、网络代理/防火墙、独立低权限用户、MCP 工具白名单。不得因"命令不在黑名单"就判定安全。

配置优先级：`CLI 参数 > profile > config.toml > CLI 默认值`。

### 6.4 必须修复的已知漏洞

**CVE-2025-59532 / GHSA-w5fx-fh39-j5rw**（High, CVSS 8.6）：

> Codex CLI 可能因沙箱配置逻辑缺陷，把**模型生成的 `cwd`** 当作沙箱可写根，包括用户启动会话目录之外的路径。

| 项目 | 值 |
|---|---|
| 影响 | CLI `>=0.2.0, <=0.38.0`；IDE 扩展 `<=0.4.11` |
| 修复 | CLI `0.39.0`；扩展 `0.4.12` |

**强制要求：**
- 最低版本 ≥ `0.39.0`，并**锁定版本 + 校验哈希**
- 工作区固定为**绝对规范化路径**（canonicalize），**不再信任运行期 `cwd` 变更**
- 禁止 Agent 把 `cwd` 改为父目录或符号链接逃逸目标
- 生成 SBOM，CI 订阅 GitHub Security Advisory

### 6.5 审计日志（每条至少含）

`ts` `threadId` `turnId` `itemId` `kind` `risk` `decision` `actor(user/auto)` `scope` `command/patch摘要` `cwd` `model` `token估算` `exitCode`

审计日志必须**可导出、可清空、可关闭保留周期**，且**永不离开本机**（除非用户主动导出）。

---

## 7. UI 组件清单

| 组件 | 职责 | 优先级 |
|---|---|---|
| `ProjectSwitcher` | 项目列表、信任状态、分支/worktree | P0 |
| `ThreadList` | 按"待操作优先"排序的线程列表 | P0 |
| `ThreadView` | Turn 时间线，Item 增量渲染 | P0 |
| `Composer` | 输入、附件、模型/effort 选择、slash 命令 | P0 |
| `ApprovalModal` | 五问式审批 + risk tier + 作用域选择 | P0 |
| `CommandBlock` | 命令、stdout/stderr、耗时、退出码（虚拟滚动） | P0 |
| `DiffViewer` | split/unified、逐文件、hunk 导航 | P0 |
| `FileChangeTree` | 按变更类型分组 + 风险标签 + 评论数 | P0 |
| `ReviewPanel` | 行内评论、接受/拒绝、批量决策 | P0 |
| `PermissionBar` | 顶部常驻：sandbox mode + approval policy + 运行时状态 | P0 |
| `WorktreePicker` | 新建 Thread 时选运行模式 | P1 |
| `GitPanel` | 分支、commit 分组、PR 草案、合并风险 | P1 |
| `SettingsPanel` | AGENTS.md 预览、Skills、MCP、模型、策略 | P1 |
| `AutomationPanel` | cron/event、试运行、run history | P2 |
| `AuditLogView` | 审计日志查看与导出 | P1（**安全红线要求，不可延后**） |

---

## 8. 目录结构

```
tauri-codex/
├─ src-tauri/
│  ├─ src/
│  │  ├─ main.rs
│  │  ├─ codex/
│  │  │  ├─ mod.rs
│  │  │  ├─ process.rs        # 子进程生命周期、崩溃恢复
│  │  │  ├─ jsonl.rs          # 按行拆包/组包
│  │  │  ├─ transport.rs      # id → oneshot, 超时, 取消
│  │  │  ├─ adapter.rs        # 官方事件 → 领域事件
│  │  │  └─ schema/           # generate-json-schema 产物（冻结）
│  │  ├─ domain/
│  │  │  ├─ thread.rs  turn.rs  item.rs
│  │  │  ├─ permission.rs     # PolicyGate
│  │  │  └─ changeset.rs
│  │  ├─ workspace/
│  │  │  ├─ git.rs            # worktree, diff, merge
│  │  │  └─ trust.rs          # 项目信任等级
│  │  ├─ security/
│  │  │  ├─ audit.rs          # 审计日志
│  │  │  └─ redact.rs         # 脱敏
│  │  ├─ store/
│  │  │  └─ event_log.rs      # SQLite WAL
│  │  └─ commands.rs          # Tauri commands
│  ├─ Cargo.toml
│  └─ tauri.conf.json
├─ src/                       # React 前端
│  ├─ components/
│  ├─ stores/
│  ├─ types/codex.ts          # 由 generate-ts 生成 + 领域类型
│  └─ App.tsx
├─ schemas/                   # 冻结的协议 schema
├─ scripts/
│  ├─ verify-codex-version.sh # 版本 + 哈希校验
│  └─ gen-schema.sh
└─ SECURITY.md                # 对外声明：采集边界、加密、开关语义
```

---

## 9. 分阶段实施计划

### Phase 0 — 地基与协议验证（1-2 天）

- [ ] 锁定 `codex` CLI 版本 ≥ 0.39.0，写 `scripts/verify-codex-version.sh`（版本 + SHA256）
- [ ] 运行 `generate-json-schema` / `generate-ts`，产物入库
- [ ] 用官方 SDK 写 contract test：跑通 `initialize → thread/start → turn/start → 审批 → turn/completed`
- [ ] 确认当前版本的 `execCommandApproval` / `applyPatchApproval` 真实字段名，修正本文档 5.4 的推断骨架
- [ ] 初始化 Tauri 2 + React + Vite 工程

**验收**：终端里能用一个最小 Rust 程序打印出 Agent 的流式输出，并正确响应一次审批。

### Phase 1 — 最小可恢复闭环（1-2 周）

- [ ] `CodexSession` + `JsonlTransport` + `id→oneshot`
- [ ] 领域模型 Thread/Turn/Item + SQLite 事件日志
- [ ] 三栏布局骨架、项目向导、信任提示
- [ ] Composer、流式消息、命令输出、停止/重试
- [ ] `ApprovalModal`（五问式 + risk tier + 作用域）
- [ ] `PermissionBar`（read-only / workspace-write 状态条）
- [ ] 文件树 + Diff + 逐文件接受/拒绝
- [ ] worktree 创建与分支状态
- [ ] `thread/archive` `thread/resume` `thread/fork` + 崩溃恢复
- [ ] `AuditLogView` + 审计导出（**不可延后**）

**验收**（典型路径端到端跑通）：
> 选 Project → 建 Worktree → 输入任务 → 审阅审批 → 实时观察执行 → 检查验证与 Diff → 评论 → 接受部分文件 → Commit → Push/PR → 归档 Thread

**崩溃验收**：`kill -9` app-server 子进程后重启应用，Thread 历史完整恢复，活动轮次正确标记 `unknown`，无静默覆盖。

### Phase 2 — 团队规范与可观测性（1-2 周）

- [ ] AGENTS.md 编辑器 + 优先级预览 + 校验
- [ ] Skills 安装、依赖检查、运行与权限声明
- [ ] MCP 列表、OAuth、工具发现、启停、审计
- [ ] 模型 / reasoning effort 选择器
- [ ] Granular approvals + 自动审查（risk tier 展示）
- [ ] 命令面板：`/review` `/plan` `/explain` `/test` `/commit` `/pr` `/fork` `/permissions` `/skill`
- [ ] 验证矩阵（构建/测试/lint/类型检查/安全扫描/手动验收），未跑的显式标 `unverified`
- [ ] 耗时、token、成本估算、诊断导出

### Phase 3 — Automations 与打磨（1 周）

- [ ] cron / event 触发器、试运行入口、审阅队列
- [ ] 后台通知、断线重连
- [ ] 大 Diff 性能优化（分组、按目录批量决策）
- [ ] 上下文膨胀治理：compact/fork 提示、context 摘要

### Phase 4 — 可选扩展（按需）

- [ ] Cloud handoff（需自有后端与容器）
- [ ] 移动端 relay（设备配对、短期令牌、TLS、命令白名单、一键吊销）

---

## 10. 验收测试清单

**功能**
- [ ] 新建 Thread（current tree / new worktree）均能跑通
- [ ] 低风险操作不打断，高风险操作必弹窗且显示完整命令与影响范围
- [ ] 审批 Deny 后 Agent 能继续或优雅结束，不卡死
- [ ] `turn/interrupt` 幂等，重复调用不产生副作用
- [ ] 断线/崩溃后 Thread 历史完整恢复
- [ ] fork 后主上下文不被污染

**安全（逐条验证，不可跳过）**
- [ ] 用网络抓包工具验证：**除用户显式配置的 provider/git remote/MCP 外，无任何出站请求**
- [ ] 每个隐私开关关闭后，抓包确认对应行为**真正停止**（不是只改 UI 文案）
- [ ] 审批弹窗中 `.env`/token/私钥 均为掩码
- [ ] 审计日志不含明文凭据
- [ ] 尝试诱导 Agent 把 `cwd` 切到父目录 → 被拒绝并记审计
- [ ] 尝试 `danger-full-access` → 需要二次确认 + 倒计时 + 明确恢复策略
- [ ] 审计日志可一键导出为 JSON

**性能**
- [ ] 长输出（>10k 行）不卡顿（虚拟滚动）
- [ ] 流式 delta 不触发整树重渲染
- [ ] 50+ Thread 时侧栏不卡

---

## 11. 风险登记

| 风险 | 表现 | 处置 |
|---|---|---|
| 协议实验性 | 官方字段变更破坏 UI | 适配层隔离 + 冻结 schema + CI 差异比对 + 保留 raw_json |
| 版本漂移 | 结果不可复现 | 记录 model、effort、CLI version、skills/mcp 快照 |
| 审批疲劳 | 每步弹窗导致用户盲点"允许" | risk tier 分级 + 批量确认 + allow-for-profile |
| Diff 过载 | 大范围改动难审阅 | 分组、聚焦风险文件、按目录批量决策 |
| 并行合并摩擦 | 多 worktree 难以集成 | 合并前强制更新 base + 验证 + 冲突预览 |
| Windows 隔离不足 | 官方沙箱实验性 | 文档明示需额外 Hyper-V/WSL/容器 |
| 第三方 provider | 兼容 ≠ 安全 | 白名单 + 出口限制 + 凭据轮换 + 数据留存评估 |

---

## 12. 与 Codex / Cline / Cursor / ZCode 的定位差异

| 维度 | 本方案 | Codex Desktop | Cline | ZCode |
|---|---|---|---|---|
| Agent 内核 | 复用开源 app-server | 同一内核，闭源壳 | 自研 | 闭源自研 |
| 客户端开源 | **是（承诺）** | 否 | 是 | 事件后承诺开源 |
| 沙箱 | OS 层 + 策略 + 审计三层 | Seatbelt/bwrap + 审批 | 逐步审批为主 | 未公开 |
| 审批 | risk tier 分级 + 作用域 | Granular approvals | 每步审批 | 有护栏但静态 |
| 工作区上传 | **架构级禁止** | 未见同类行为 | 未见同类行为 | **静默全量上传（已致歉）** |
| 审计可导出 | 是 | 部分 | 部分 | 无 |

**本方案的核心卖点**：不是"功能比 Codex 多"，而是**"你能验证我在做什么"**——开源客户端、零静默上传、可导出审计、本地优先。

---

## 附录 A：关键官方来源

1. Unlocking the Codex harness: how we built the App Server — https://developers.openai.com/codex/app-server/
2. Codex App Server 文档 — https://developers.openai.com/codex/app-server/
3. openai/codex 仓库（Apache-2.0） — https://github.com/openai/codex
4. Introducing the Codex app — https://openai.com/index/introducing-the-codex-app/
5. Agent approvals & security — https://developers.openai.com/codex/security/
6. Codex Config — https://developers.openai.com/codex/reference/config/
7. Codex Authentication — https://developers.openai.com/codex/authentication/
8. Codex SDK — https://developers.openai.com/codex/sdk/
9. Codex Best practices — https://developers.openai.com/codex/best-practices/
10. Scheduled tasks — https://developers.openai.com/codex/scheduled-tasks/
11. Customization / Skills — https://developers.openai.com/codex/customization/
12. Codex Linux Sandbox README — https://github.com/openai/codex/blob/main/codex-rs/linux-sandbox/README.md
13. GHSA-w5fx-fh39-j5rw（CVE-2025-59532）— https://github.com/openai/codex/security/advisories/GHSA-w5fx-fh39-j5rw

## 附录 B：ZCode 事件要点（安全设计的反面教材）

- 触发：登录状态下宿主级 sidecar 无条件启动，不在 Agent 工具循环内
- 内容：整个工作区，含完整 `.git/objects`（29.6%）、`.git/lfs`（56.8%）、reflog、全局配置；单样本 42,411 文件中 `.git` 占 86.6%
- 频率：每次 prompt 前 + 任务结束后各一次，单会话最多 62 次；失败无限重试（观测到 564 次）
- 加密：AES-256-CTR 内容 + RSA-OAEP-SHA256 包密钥；**公钥服务端动态下发，私钥仅云端** → 用户无法解密自己的数据
- 开关失效：「体验优化」只管训练授权，「仓库快照索引」只管云端是否建索引，**均不阻止本地打包上传**
- 唯一有效缓解：文件系统层锁目录（`chattr +i` / `chflags uchg`），代价是回滚功能失效
- 官方回应：归因于默认开启的「代码库索引 / RepoWiki」，已修复，承诺开源 + 第三方审计 + 补偿额度

**对本方案的直接约束**：第 6.1 节隐私红线 1、2、3、4、6 逐条对应上述失效点。
