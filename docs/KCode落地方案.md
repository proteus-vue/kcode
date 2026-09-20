# KCode 落地方案（修正版）

> 技术栈：**Tauri 2（Rust + React/TypeScript）**
> Agent 内核：**复用 OpenAI 开源 `codex app-server` 协议（Apache-2.0），不自研 Agent loop**
> 安全模型：**严格沙箱 + 显式审批 + 全程审计 + 零静默外发**
> 锁定基线：**codex CLI 0.155.1**（安全下限 0.39.0）
> 版本：v2.0 ｜ 2026-09-20
>
> **本版与 v1.0 的差异**：全部协议细节已用 `codex app-server generate-json-schema` 与真实进程握手重新核对。
> 逐条勘误见 [`协议勘误与修正.md`](./协议勘误与修正.md)，协议细节以自动生成的 [`protocol-facts.md`](./protocol-facts.md) 为准。
> v1.0 原文保留在 [`archive/`](./archive/) 作为溯源。

---

## 0. 这份文档怎么用

这是一份**实现规格书**。与 v1.0 的关键区别：**协议部分不再是推断，而是实测**。

- 文档中所有方法名、字段名、枚举值均来自锁定版本 0.155.1 的实测产物，标注为 `[实测]`。
- 标注 `[产品决策]` 的是实现方自主设计，不受上游约束。
- 标注 `[自研]` 的是**协议不提供、必须自己写**的能力——v1.0 曾把这些误当作协议字段。
- 遇到协议疑问，**先查 `docs/protocol-facts.md`**，不要凭记忆或二手资料。

**开工前先跑**（本仓库已配置好，无需额外安装）：

```bash
npm install
npm test          # 版本基线 + 端到端契约（离线、零凭据）
```

`npm test` 通过即代表 Phase 0 完成。

---

## 1. 项目定位

### 1.1 做什么

一个**本地优先、可审计、可恢复**的 AI 编程 Agent 桌面控制台。复刻的不是 Codex 某个窗口的外观，而是它的产品机制：

> 让 Agent 在**明确边界内**长期运行，让用户始终能够**看见、审批、纠正、接管**。

### 1.2 不做什么（MVP 明确排除）

| 排除项 | 原因 |
|---|---|
| 自研 Agent loop / 工具调度 | 复用 `codex app-server` |
| 云端 runtime | 需自有后端与容器，Phase 4 |
| 手机远程控制 | 需 relay 与设备配对，Phase 4 |
| 自实现模型推理 | 只做客户端，模型由用户自选 provider |
| **任何形式的遥测 / 工作区快照上传** | 见第 6 章红线 |

### 1.3 安全立场的表述原则

本项目以「**你能验证我在做什么**」为卖点，因此安全叙事必须遵守与协议同等严格的标准：

> **只写能给出来源、或能由本仓库脚本验证的断言。**

架构级约束是本项目**自身的设计承诺**，成立与否不依赖任何外部事故案例，因此不需要引用竞品事件背书。第 6 章据此重写。

---

## 2. 总体架构

### 2.1 分层

```
L3  展示层   React 18 + TypeScript（WebView）
             ── 只接收领域状态，绝不拼接原始 JSON-RPC
L2  领域层   Rust DomainStore
             ── Thread / Turn / Item / Permission / ChangeSet / Automation
L1  适配层   Rust ProtocolAdapter + JsonlTransport
             ── 管理 app-server 子进程，翻译协议，吸收版本漂移
L0  宿主层   Tauri 2 窗口、进程、文件系统、keychain、通知
```

**核心边界：前端不直接依赖官方 wire type。** app-server 被官方标记为 `[experimental]`，本项目的核对已经证实：从声称的 0.39.0 基线到当前 0.155.1，协议变化极大（v1 审批方法整体 deprecated、v2 Item 体系上线）。适配层的职责就是吸收这些变化。

### 2.2 进程模型

```
┌─────────────────────────────────────────────┐
│ Tauri Main Process (Rust)                   │
│                                             │
│  CodexBridge                                │
│   ├─ ChildProcess  (codex app-server --stdio)
│   │    stdin  ← JSONL 请求                  │
│   │    stdout → JSONL 响应/通知/审批请求     │
│   │    stderr → 日志                        │
│   ├─ JsonlCodec                             │
│   ├─ SessionStore   (thread/turn 游标)      │
│   ├─ EventLog       (SQLite WAL，事件溯源)  │
│   └─ PolicyGate     (默认 deny + 审计)      │
│                                             │
│  ProjectWorkspaceService (git/worktree)     │
│  RiskClassifier     [自研]                  │
│  CredentialVault      (keychain)            │
└──────────────┬──────────────────────────────┘
               │ Tauri commands + events（类型化）
┌──────────────▼──────────────────────────────┐
│ WebView (React)                             │
└─────────────────────────────────────────────┘
```

**关键决策：Rust 后端独占 app-server 的 stdin/stdout。** 不要用 WebView 直接 spawn 子进程，那会丢掉统一的日志、崩溃恢复、版本管理与生命周期控制。

### 2.3 技术选型

| 层 | 选型 | 理由 |
|---|---|---|
| 桌面壳 | Tauri 2 | 体积小、原生手感，一套代码覆盖三平台 |
| 前端 | React 18 + TypeScript + Vite | 流式 UI 组件复用度高 |
| 状态 | Zustand（前端）+ SQLite/WAL（Rust 事件日志） | 前端轻量，持久化交后端 |
| 传输 | **stdio JSONL** | 官方标记 WebSocket 为 experimental 且不建议生产 `[实测]` |
| Diff | `diff` crate（Rust 侧计算）+ 自研 hunk 渲染 | 避免前端重解析补丁 |
| Git | `git2` / `git` CLI | worktree、diff、merge |
| 凭据 | OS keychain | 不落明文 |
| 命令输出 | xterm.js 或自研虚拟终端 | 长输出需虚拟滚动 |

### 2.4 二进制管理（v1.0 缺失，必须补齐）

app-server 是**外部进程依赖**，其版本管理与应用自身发布同等重要：

- **锁定**：作为 npm 依赖固定精确版本（`@openai/codex: 0.155.1`），`package-lock.json` 入库。
- **校验**：启动时校验二进制 SHA256 与 `codex.lock.json` 一致（`scripts/verify-codex-version.sh`）。
- **安全下限**：`0.39.0`（CVE-2025-59532 修复版本）。低于此版本会因沙箱路径配置缺陷，把模型生成的 `cwd` 当作可写根，突破工作区边界（High，CVSS 8.6）。
- **隔离状态目录**：为每个应用实例或测试指定独立 `CODEX_HOME`，避免污染用户真实 `~/.codex`。`initialize` 响应会回传实际生效的 `codexHome`，**必须校验它等于预期值**。
  > 这条同时是安全属性：它保证 app-server 不使用用户全局配置中的宽松策略。

---

## 3. 交互范式（需复刻的产品机制）

### 3.1 四级信息架构

**Project 是安全边界，Thread 是任务边界，二者不可混用。**

| 层级 | 职责 | UI 表达 | 协议原语 `[实测]` |
|---|---|---|---|
| **Project** | 锚定仓库/目录、信任等级、模型、权限 profile、Skills/MCP | 项目切换器；显示分支/worktree、信任状态 | 本地项目 + config 层 |
| **Thread** | 单一任务的持久对话与跨轮上下文 | 可命名、置顶、搜索、分组、归档、恢复、fork | `thread/start` `thread/resume` `thread/fork` `thread/archive` `thread/unarchive` `thread/delete` `thread/search` |
| **Turn** | 用户一次输入触发的连续工作 | 折叠时间线、状态、耗时/token、停止/重试 | `turn/start` `turn/steer` `turn/interrupt` |
| **ChangeSet** | 一个 Turn 产生的文件变更及审阅结论 | 文件树、逐文件 Diff、接受/拒绝、行内评论 | `fileChange` Item 聚合 |

Project 至少绑定：工作目录或 worktree 路径、信任等级、默认模型与 reasoning effort、sandbox 与 approval profile、AGENTS.md/Skills/MCP 配置、当前分支与 Git 健康状态。

> `[实测]` 另有 `thread/queue/*`（任务队列）、`thread/attachment/*`（持久附件，fork 时自动复制）、`thread/goal/*`（目标）、`thread/section/*`（分组）等能力，Phase 2 可选择性接入。

### 3.2 桌面三栏布局

```
┌────────────────┬──────────────────────────────┬───────────────────────┐
│ Projects       │ Thread messages / turn log    │ Review & Context      │
│ + Add Project  │ ─ User prompt                 │ Files / Tree          │
│ › repo-a       │   Agent reasoning/plan        │  Diff (split/unified) │
│   • Fix login  │   Tool: read/search/test      │  Inline comments      │
│   • Add OAuth  │   ⚠ Approval required         │ Approval detail       │
│ › repo-b       │   Command output              │ Terminal              │
│ Threads        │   File changes                │ Git / PR              │
│ Skills         │ ─ User follow-up              │                       │
│ Automations    │ Composer                      │                       │
└────────────────┴──────────────────────────────┴───────────────────────┘
```

**侧栏排序的第一依据是「待用户操作」，不是最近活动时间：**

```
等待审批 > 运行中且可介入 > 失败 > 最近完成 > 已暂停
```

每个 Thread 行至少显示：标题/自动摘要、仓库与 worktree、模型、最后更新、变更文件数、审批/失败状态徽标。

### 3.3 核心任务闭环（7 阶段）

```
提交 → 规划/探索 → 预览命令或变更 → 审批（如需） → 执行 → 测试/验证 → 结果 & ChangeSet → 审阅 → 提交/PR → 多轮追问
```

| 阶段 | 用户动作 | UI 应显示 | 协议映射 `[实测]` |
|---|---|---|---|
| 1. 创建任务 | 选 Project；选 Local/Worktree；输入目标，可附文件/截图 | 运行模式、模型、effort、权限预设、base branch | `thread/start`（`cwd`/`sandbox`/`approvalPolicy`） |
| 2. 规划 | 无需显式点「计划」 | 计划摘要、受影响模块、验证策略、风险 | `plan` Item、`turn/plan/updated` 通知、reasoning Item |
| 3. 审批 | 查看命令、目录、网络、文件写入、作用域 | 命令、环境变量脱敏、差异预览、决策按钮 | `item/*/requestApproval`（**见 3.4**） |
| 4. 执行 | 可中途停止、追加追问、降低权限 | 实时命令输出、测试进度、token/时间 | `item/commandExecution/outputDelta`、`item/*/delta` |
| 5. 审阅 | 检查 Diff、写评论、接受/拒绝 | 文件树、逐行 Diff、测试/lint 状态、冲突风险 | `fileChange` Item、`turn/diff/updated` |
| 6. 合入 | Commit、Push、Create PR 或继续迭代 | Commit 分组、PR 模板、目标分支、CI 链接 | Git 工具调用（先成 ChangeSet 再原子操作） |
| 7. 追问 | 引用某行/评论/计划分支 | 引用锚点、相关文件、fork 提示 | `turn/steer`；长上下文触发 `thread/compact/start` 或 `thread/fork` |

### 3.4 审批范式（严格模式下的核心）

#### 审批模态框必须回答五个问题

| 必答问题 | 最低展示内容 | 数据来源 |
|---|---|---|
| 做什么 | 完整命令或工具参数，**环境变量默认脱敏** | `params.command` / `params.commandActions` `[实测]` |
| 为什么 | Agent 目标、相关计划步骤、审批原因 | `params.reason`（模型自述）`[实测]` |
| 在哪里 | 工作目录、git root、worktree、目标文件 | `params.cwd`、`params.environmentId` `[实测]` |
| 影响多大 | 写入/删除/网络/凭据/破坏性操作等风险 | **`RiskClassifier` 客户端推断** `[自研]` |
| 如何决策 | 见下方决策矩阵 | `CommandExecutionApprovalDecision` `[实测]` |
| 如何追溯 | 完整 `threadId / turnId / itemId` | 三者均为 params 必填字段 `[实测]` |

#### 决策矩阵（`[实测]` 修正）

v1.0 设计的「Allow once / Allow for profile / Deny / Edit command」四按钮**与协议不符**。实测 `CommandExecutionApprovalDecision` 有 6 个变体：

| 协议决策 | 语义 | UI 建议标签 |
|---|---|---|
| `"accept"` | 批准本次，命令**提权执行** | 批准 |
| `"acceptForSession"` | 批准，本会话同类不再询问 | 本会话内总是批准 |
| `{"acceptWithExecpolicyAmendment": {...}}` | 批准，并落盘 execpolicy 规则 | 批准并记住此命令 |
| `{"applyNetworkPolicyAmendment": {...}}` | 为该 host 落盘持久网络规则 | 允许/拒绝此域名 |
| `"decline"` | 拒绝，**命令完全不执行**，Turn 继续 | 拒绝 |
| `"cancel"` | 拒绝，**命令完全不执行**，并立即中断 Turn | 拒绝并停止 |

文件变更审批（`FileChangeApprovalDecision`）为 4 值：`accept` / `acceptForSession` / `decline` / `cancel`。

**必须注意的三点**：

1. **「Edit command」不是协议决策值**——是纯客户端功能（改写命令后重新发起），标为 `[自研]`，工作量独立估算。
2. **`decline` 与 `cancel` 都阻止执行，区别仅在 Turn 是否中断。** 两者语义必须区分，否则用户拒绝一次命令时会意外终止整个 Turn。
3. **`declined` 是一个独立的 Item 状态，必须渲染。** `CommandExecutionStatus` 与 `PatchApplyStatus` 的实测枚举为 `["inProgress", "completed", "failed", "declined"]`。若 UI 不处理 `declined`，用户拒绝后会看到一张「已完成」的命令卡片，无法分辨命令究竟跑没跑。

> **审批语义已由测试守护**：`crates/codex-bridge/tests/approval_semantics.rs` 实测确认 `decline` 是**硬拒绝**（连沙箱内降级执行都不会发生），且非法决策值 fail-safe（不会被当作批准）。这四条断言的探测方法见 [`协议勘误与修正.md`](./协议勘误与修正.md) 第 3.10 节。

#### 风险分级是自研模块（`[自研]`，v1.0 误判）

**协议中不存在任何 risk 字段。** 审批参数只提供原始事实。风险分级必须自行实现：

```
RiskClassifier 输入：command / commandActions / cwd / networkApprovalContext / grantRoot
               输出：low | moderate | high | critical
```

分级原则：

- 低风险（读文件、grep、只读 git）→ 默认放行或批量处理
- 中风险（工作区内写、装依赖、跑测试）→ 批量确认
- 高风险（工作区外写入、删除、网络外发、sudo、凭据访问、`git push --force`）→ **单独阻塞，强制确认**

**硬约束：推断结果只影响展示与排序，不得作为放行依据。** 强制边界来自沙箱与 `writable_roots`，不来自分类器。

**与官方机制的关系**：协议提供了 `approvalsReviewer: "auto_review"`（官方子代理预审，见 Phase 2），自研分级器应与之互补——自研负责**本地快速分级与 UI 排序**，官方负责**带上下文的深度预审**。

#### 作用域与审计

「Always allow」必须记录**作用域**：当前 Thread / 当前 Project / 当前 Profile / 全局。禁止存在「全局永久 never」。自动批准也要写审计日志。

### 3.5 Diff / Review 范式

**数据来源（`[实测]`）**：协议有两个 diff 通道，可用性不同，不可混用：

| 通道 | 格式 | 可用性 | 用途 |
|---|---|---|---|
| `turn/diff/updated` 通知 | 标准 unified diff | **稳定**，有变更即推送 | **审阅面板主数据源** |
| `fileChange` Item 的 `changes[]` | 逐文件 `{path, kind, diff}` | 条件性，并非所有变更都产生该 Item | 更精细的逐文件视图（有则用） |

`changes[].diff` 的内容**随 kind 变化**（`add`/`delete` 是完整内容而非 diff，
`update` 是不含文件头的 hunk），因此**不能统一按 diff 解析**——
否则新增/删除文件会显示为「+0 -0」。详见勘误表 3.12。

**「已提议」与「已应用」必须分离。** 状态机：

```
proposed → user_reviewing → accepted_partial | accepted_all | rejected | edited
                                                        ↓
                                            committed → PR_open | merged
```

文件树按变更类型分组：added / modified / deleted / renamed / conflicting / generated，同时显示风险标签、评论数、测试状态。逐文件至少支持：打开 Diff、跳到某行、行内评论、单文件接受/拒绝、撤销变更、外部编辑器打开。

行级评论发送前区分「仅作上下文」与「要求修改」；后者自动追加为下一轮用户指令。

> 撤销变更可使用 `thread/revert`（0.155.1 中 `thread/rollback` 仍存在，但上游 main 分支已建议改用 `thread/revert`；以锁定版本 schema 为准）。

### 3.6 Worktree 并行范式

**Worktree 不是高级 Git 命令，是并行 Agent 之间最基础的安全边界。** 新建 Thread 时把运行模式明确分三档：

1. **Current working tree** —— 快速调试、小范围修改
2. **New worktree** —— 功能开发、实验性重构、长任务（**推荐默认**）
3. **Cloud runtime** —— Phase 4

创建面板同步显示：base branch、目标分支/worktree 名、路径、当前 Git 状态、已有未提交变更、风险。

并行 Agent 不能只是多个标签页：同一 Project 下允许多个 active Thread，但每个 Thread 必须绑定独立 worktree 或明确标记为共享工作区。合并前强制：更新 base → 跑验证 → 生成冲突报告 → 三方 Diff → 必要时交回人工。

### 3.7 扩展机制三层

| 能力 | 位置 | 触发 | UI 表达 |
|---|---|---|---|
| 项目规则 | `AGENTS.md`、`.codex/`、`.agents/` | 自动加载 | Settings 里「已加载指令」预览与优先级 |
| 可复用流程 | `SKILL.md` + scripts/references | 显式调用或 description 隐式匹配 | Skills 列表、依赖检查、运行入口 |
| 外部工具 | MCP server | Agent 工具调用 | Servers 列表、工具/资源、连接状态 |
| 一次性命令 | 内置 slash command | 用户输入 `/` | Command palette |

加载层级：`~/.codex/AGENTS.md` → 仓库根/嵌套 `AGENTS.md` → 全局与仓库 Skills → `.agents/skills`。

MVP 最小 slash 命令集：`/review` `/plan` `/explain` `/test` `/commit` `/pr` `/fork` `/permissions` `/skill`。每个命令映射到可回放的领域动作，**不是在前端拼接自由文本**。

> `[实测]` 协议提供 `review/start` 方法（启动代码审查）、`skills/list`、`plugin/list` 等，可直接复用而非自行拼装提示词。

### 3.8 Automations

不是「聊天 + cron」，是独立领域对象：

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

必须提供「先在普通聊天里试跑」入口，每次 run 映射为可恢复 Thread，避免变成无法审计的幽灵脚本。

> `[实测]` `thread/queue/*` 提供了官方的任务排队原语，Automation 的调度层可基于它实现而不是自建队列。

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
    codex_home: PathBuf,                                 // 校验用：必须等于预期隔离目录
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

### 4.2 TypeScript 侧领域类型（`[实测]` 修正版）

v1.0 的 `TurnStatus` 有 9 个值，但**协议只有 4 个**。多出的状态是客户端的**派生展示状态**，不是协议状态——这个区分很重要，否则会去协议里找不存在的字段。

```ts
// ── 与协议一一对应的部分 ──────────────────────────────
type TurnStatus = 'inProgress' | 'completed' | 'interrupted' | 'failed';  // [实测] 4 值

// 协议 ThreadItem 共 19 种 [实测]，领域层做归并
type Item =
  | UserMessage          // userMessage
  | AgentMessage         // agentMessage
  | Reasoning            // reasoning
  | Plan                 // plan
  | CommandRun           // commandExecution: status, command, aggregatedOutput, exitCode, durationMs
  | FileChange           // fileChange: changes, status
  | ToolCall             // mcpToolCall / dynamicToolCall / functionCallOutput
  | WebSearch            // webSearch
  | ImageView            // imageView / imageGeneration
  | ContextCompaction    // contextCompaction
  | CollabAgent          // collabAgentToolCall / subAgentActivity
  | ApprovalRequest      // 由 item/*/requestApproval 派生，非 ThreadItem 原生
;

// ── 客户端派生的展示状态（不要试图在协议里找）────────────
type TurnDisplayStatus =
  | 'running' | 'awaiting_approval' | 'verifying'      // 由 Item 流 + 是否有待决审批推导
  | 'completed' | 'interrupted' | 'failed'             // 由 TurnStatus 映射
  | 'unknown';                                          // 子进程异常退出时的兜底

type RiskTier = 'low' | 'moderate' | 'high' | 'critical';  // [自研] RiskClassifier 产出
```

### 4.2.1 Item 状态值（`[实测]`）

```
CommandExecutionStatus = 'inProgress' | 'completed' | 'failed' | 'declined'
PatchApplyStatus       = 'inProgress' | 'completed' | 'failed' | 'declined'
```

**`declined` 必须被 UI 特判。** 它表示用户拒绝了该操作、命令未执行；若归并进「completed」，
用户拒绝后看到的是一张「已完成」卡片，无法分辨命令究竟跑没跑（详见 3.4 节）。

### 4.3 关键字段清单（最小可恢复集）

| 模块 | 最小字段 | 关键交互 |
|---|---|---|
| Project | id, path, worktreeStrategy, trust, profile, skills, mcp, codexHome | 添加、信任、切换、检测 Git |
| Thread | id, projectId, title, createdAt, status, pinned, archived, **forkedFromId** | 新建、搜索、分组、归档、恢复、fork |
| Turn | id, threadId, status, model, effort, startedAt, finishedAt | 停止、重试、引用、压缩 |
| Item | id, turnId, type, lifecycle, payload, createdAt | 增量渲染、展开、定位文件 |
| Permission | id, requestId, itemId, kind, **decision**(6 值), scope, reason | 批准/本会话批准/规则持久化/拒绝/拒绝并停止 |
| ChangeSet | id, turnId, files, reviewState, base/head | 逐文件审阅、批量接受、撤销 |
| Automation | id, trigger, skill/prompt, policy, lastRun, reviewQueue | 试运行、启停、run history |

---

## 5. 协议适配层规格（全部 `[实测]`）

> 本节是 v1.0 修正幅度最大的部分。核对发现 v1.0 的审批方法名、握手形态、响应字段、事件前缀均有偏差。

### 5.1 传输

| 传输 | 启动参数 | 格式 | 结论 |
|---|---|---|---|
| **stdio** | `--stdio`（等价 `--listen stdio://`） | 换行分隔 JSON（JSONL） | **生产唯一推荐** |
| WebSocket | `--listen ws://IP:PORT` | 每帧一条 JSON-RPC | 官方标记 experimental，不用于生产 |
| Unix socket | `--listen unix://[PATH]` | HTTP Upgrade → WebSocket | 受控环境可选 |

**MVP 只用 stdio。** 不要在用户机器上开放监听端口——即使绑定回环。官方对整个 `app-server` 命令标注了 `[experimental]`。

### 5.2 报文形态（v1.0 此处错误）

**线路格式是 JSON 对象，不是数组定位形式。**

```json
// 请求
{ "method": "thread/start", "id": 1, "params": { } }

// 响应
{ "id": 1, "result": { "thread": { "id": "..." } } }
{ "id": 7, "error": { "code": -32600, "message": "..." } }

// 通知（无 id）
{ "method": "item/started", "params": { } }
```

标准 JSON-RPC 2.0，但**线路上省略 `"jsonrpc":"2.0"` 头**。解析器不能强制要求该字段，且必须容忍字段顺序任意。

#### 握手（`[实测]` 修正）

```json
// client → server（对象形态，非数组）
{ "method": "initialize", "id": 1, "params": {
    "clientInfo": { "name": "kcode", "title": "KCode", "version": "0.1.0" },
    "capabilities": { "experimentalApi": true }
}}

// server → client：注意字段名与 v1.0 文档完全不同
{ "id": 1, "result": {
    "userAgent": "kcode/0.155.1 (Mac OS 26.5.0; arm64) dumb (kcode; 0.1.0)",
    "codexHome": "/Users/.../.kcode/state",
    "platformFamily": "unix",
    "platformOs": "macos"
}}

// client → server：无 params 字段
{ "method": "initialized" }
```

**四个必须遵守的不变量**：

1. 每个连接只允许在业务方法前发送一次 `initialize`。
2. **响应中不存在 `serverInfo` 与 `capabilities`**——v1.0 的示例是错的。
3. 能力协商在**请求侧**：`capabilities.experimentalApi` 主动申请实验 API；`capabilities.optOutNotificationMethods` 可抑制不需要的通知（桌面端性能抓手）。
4. **必须校验 `codexHome` 等于预期的隔离目录**，这是「app-server 是否使用了我们的策略配置」的可验证证据。

### 5.3 方法清单（`[实测]` 汇总：客户端→服务端共 102 个）

| 类别 | 方法 | 我方责任 |
|---|---|---|
| 初始化 | `initialize` | 校验 `codexHome`、平台信息；申请 `experimentalApi` |
| 线程 | `thread/start` `thread/resume` `thread/fork` `thread/read` `thread/list` `thread/search` `thread/archive` `thread/unarchive` `thread/delete` `thread/compact/start` `thread/revert` `thread/name/set` `thread/metadata/update` | 映射到工作区、侧栏、历史 |
| 轮次 | `turn/start` `turn/steer` `turn/interrupt` | 提交输入、追加纠偏、取消 |
| 账户 | `account/read` `account/login/start` `account/login/cancel` `account/logout` `account/rateLimits/read` `account/usage/read` | 展示登录态、配额 |
| 配置/模型 | `config/read` `config/value/write` `config/batchWrite` `configRequirements/read` `model/list` `permissionProfile/list` | 校验写入项，UI 不得直接覆盖安全策略 |
| 审查 | `review/start` | 启动代码审查 |
| 扩展 | `skills/list` `plugin/list` `plugin/read` `mcpServerStatus/list` `hooks/list` | Skills/MCP/Hooks 管理 |
| 执行通道 | `command/exec` `command/exec/write` `command/exec/terminate` `command/exec/resize` | 独立流式执行（终端面板） |
| 文件系统 | `fs/readFile` `fs/writeFile` `fs/readDirectory` `fs/getMetadata` `fs/watch` 等 | 受控文件操作，需与沙箱策略对齐 |

> `[实测]` 完整 102 项清单见 `docs/protocol-facts.md`。**不要照抄本文档，以生成物为准。**

### 5.4 事件清单（`[实测]` 修正）

v1.0 使用的 `execCommand/*`、`applyPatch/*` 前缀在协议中**零命中**。实际命名：

| 类别 | 通知 | 工程映射 |
|---|---|---|
| 生命周期 | `thread/started` `thread/archived` `thread/unarchived` `thread/closed` `thread/deleted` `thread/status/changed` | 更新侧栏、加载/冻结视图 |
| 轮次 | `turn/started` `turn/completed` | 绑定 turnId，显示运行/取消/错误/token |
| 条目 | `item/started` `item/completed` | 创建/收尾消息、命令、补丁、工具卡片 |
| 流式 | `item/agentMessage/delta` `item/reasoning/textDelta` `item/reasoning/summaryTextDelta` `item/plan/delta` | 追加渲染，**避免整树重渲染** |
| 执行 | `item/commandExecution/outputDelta` `item/commandExecution/terminalInteraction` | 命令、stdout/stderr、耗时、退出码 |
| 文件 | `item/fileChange/outputDelta` `item/fileChange/patchUpdated` `turn/diff/updated` | diff parser → 文件树 + hunk |
| 审批 | **`item/commandExecution/requestApproval`** `item/fileChange/requestApproval` `item/permissions/requestApproval` | 模态审批（**服务端请求，非通知**） |
| 审批辅助 | `item/autoApprovalReview/started` `item/autoApprovalReview/completed` `autoApprovalReview/strictReviewRequired` `serverRequest/resolved` | 自动审查状态；请求已解决收敛 |
| 用量 | `thread/tokenUsage/updated` | token/成本展示 |
| 账户 | `account/login/completed` `account/updated` `account/rateLimits/updated` | 登录流程与配额 |

> 完整 82 项通知清单见 `docs/protocol-facts.md`。

### 5.5 审批往返（`[实测]` 核心修正）

**审批是服务端发起的 JSON-RPC 请求，客户端直接回应同一 `id`。v1.0 文档中的 `approval/resolve` 方法不存在。**

```jsonc
// 1. server → client：服务端发起审批（注意顶层有 id，这是请求不是通知）
{ "method": "item/commandExecution/requestApproval", "id": 0,
  "params": {
    "threadId": "01a0bc97-...",     // 必填
    "turnId":   "01a0bc97-...",     // 必填
    "itemId":   "call_mock_1",      // 必填
    "startedAtMs": 1789870448319,   // 必填
    "command": "echo kcode-approval-probe",
    "cwd": "/path/to/workspace",
    "commandActions": [ /* 解析后的命令结构 */ ],
    "reason": "kcode contract test: verify approval round-trip",
    "networkApprovalContext": null,
    "grantRoot": null,
    "approvalId": null
  }}

// 2. client → server：就是普通 JSON-RPC 响应，无额外包装
{ "id": 0, "result": { "decision": "accept" } }
```

**不同审批方法用不同的响应体**：

| 审批方法 | 响应体 |
|---|---|
| `item/commandExecution/requestApproval` | `{ "decision": "accept" \| ... }` |
| `item/fileChange/requestApproval` | `{ "decision": "accept" \| ... }` |
| `item/permissions/requestApproval` | `{ "permissions": {...}, "scope": "turn"\|"session", "strictAutoReview"?: bool }` |

**生命周期收敛**：服务端在请求被解决后广播 `serverRequest/resolved`（含 `requestId` + `threadId`）。多窗口、超时竞争、或审批被其他客户端抢先应答时，靠这个通知收敛本地待决状态——**v1.0 未提及，但多客户端场景下必需**。

**实测验证**：`scripts/contract-test.mjs` 端到端跑通「mock 模型返回提权命令 → 服务端发起审批 → 客户端应答 `accept` → `turn/completed`」，全程离线、零凭据、不污染真实 `~/.codex`。

### 5.6 沙箱与审批参数（`[实测]` 易踩坑）

**同样的策略意图，在两个方法上用不同形态**：

| 方法 | 字段 | 形态 |
|---|---|---|
| `thread/start` | `sandbox` | 字符串：`"read-only"` \| `"workspace-write"` \| `"danger-full-access"` |
| `turn/start` | `sandboxPolicy` | 对象：`{"type":"workspaceWrite","writableRoots":[],"networkAccess":false,...}` |

对象形态的 `type` 可选：`dangerFullAccess` / `readOnly` / `externalSandbox` / `workspaceWrite`。

审批策略 `approvalPolicy` 两处同名，取值：

```
"untrusted" | "on-request" | "never"
| { "granular": { sandbox_approval, rules, skill_approval, request_permissions, mcp_elicitations } }
```

`approvalsReviewer`（两处同名）：

```
"user" | "auto_review" | "guardian_subagent"
```

**适配层必须接受两种沙箱形态并统一为内部领域模型**，否则「创建线程」与「提交轮次」的策略会不一致。

### 5.7 实现顺序（严格按序）

1. **跑通契约测试**（本仓库已提供）：确认握手、方法、审批字段与锁定版本一致
2. 生成并冻结 JSON Schema + TS 绑定（`scripts/gen-schema.sh`）
3. Rust 实现 `JsonlTransport`：封装 stdin writer + `BufReader<stdout>`，**按换行边界拆包**
4. 实现 `send_request`（超时/取消/pending 清理）、`send_notification`
5. 维护 `id → oneshot` 映射
6. **区分两类入站消息**：有 `id` + 有 `method` 是服务端请求（审批）；有 `id` 无 `method` 是响应；无 `id` 是通知
7. 服务端请求按 `id` 直接回应（**不存在 `approval/resolve`**）；同时订阅 `serverRequest/resolved` 做状态收敛
8. 实现 `turn/interrupt`，注意需 `threadId` + `turnId`，且对已结束的 Turn 返回 `-32600`
9. 每个事件追加到 SQLite/WAL（seq、thread_id、turn_id、item_id、ts、kind、raw_json）
10. 启动时先 `thread/read` 或用本地历史重建，再订阅后续事件
11. 子进程异常退出 → 活动轮次标记 `unknown`；**禁止自动以更高权限重启**

> **关键边界：请求响应只确认方法已被接受，不代表轮次完成。**
> 实测证据：`turn/start` 立即返回 `turn.id`，而状态推进（`inProgress` → `completed`）只能从事件流获得。
> **前端不得用单个 Future 的返回值决定会话最终状态。**

### 5.8 Tauri commands / events 契约

```rust
// commands（前端 → 后端）
start_thread(workspace, model, sandbox, approval_policy) -> ThreadId
resume_thread(thread_id)
send_turn(thread_id, parts) -> TurnId
steer(thread_id, text)
interrupt(thread_id, turn_id)
resolve_approval(request_id, method, decision)   // method 决定响应体形态
archive_thread(thread_id)
read_config()
write_config_batch(changes)
```

```ts
// events（后端 → 前端）
'kcode:thread_started' | 'kcode:delta' | 'kcode:command'
| 'kcode:patch' | 'kcode:approval_required' | 'kcode:approval_resolved'
| 'kcode:turn_completed' | 'kcode:error'
```

---

## 6. 安全模型

### 6.1 隐私红线（架构级约束，不可被设置项覆盖）

以下约束是**本项目自身的架构承诺**，每条都对应可验证手段：

1. **禁止任何「工作区快照 / checkpoint 上传」功能。** 若未来做 checkpoint，**只允许本地增量快照，且必须能一键关闭并真正生效**。
2. **禁止存在脱离 Agent 工具循环的宿主级采集 sidecar。** 所有文件读取必须经过 Item 事件，对用户可见。
3. **禁止静默网络外发。** 除用户显式配置的目标（模型 provider、MCP server、git remote）外，任何出站请求都必须在审批弹窗中显示目标 URL、用途与 payload 摘要。
4. **禁止「开关形同虚设」。** 每个隐私开关必须有**单一、可验证的语义**：
   - 在 `SECURITY.md` 写明「关闭后具体不发生什么」；
   - 每条开关配一条自动化验证：关闭后由抓包或文件系统监控确认行为停止；
   - **开关的关闭路径必须有代码级测试**，而不只测 UI 状态——「开关只存在于配置 schema、采集链中无拦截分支」是可复现的失败模式。
5. **默认不采集遥测。** 需崩溃/用量统计时**默认关闭**，首次启动显式询问，且**绝不包含代码内容、文件路径、仓库名**。
   > 实测：app-server 自身的遥测即为默认关闭，需显式 opt-in。本项目遵循同一标准。
6. **上传内容必须可本地解密 / 可导出。** 若做加密存储，**私钥必须在用户手里**，不允许「只有服务端能解」。
7. **凭据只进 OS keychain**，不写明文配置文件，不进日志，不进事件快照（写入前脱敏）。
8. **审批视图默认脱敏**：`.env`、私钥、token、`Authorization` 头、连接串一律掩码显示，提供「点击显示」并记审计。
9. **开源客户端 + 可复现构建。** 提供构建脚本与依赖锁定，让第三方可验证「代码里没有采集逻辑」。
10. **提供一键导出审计日志**，让用户能自己回答「这个工具对我的代码做了什么」。

> **关于竞品案例的引用纪律**：本方案不引用任何未经一手验证的事故数字。若需在对外材料中提及行业案例，只保留「曾有工具因默认开启的代码库索引功能发生工作区数据外发，厂商已致歉并承诺开源与第三方审计」这一层，并标注为**媒体报道的二手转述**。理由见 [`协议勘误与修正.md`](./协议勘误与修正.md) 第 4 节——对一个以「可审计」为卖点的产品，引用不可验证的数字是最不该有的弱点。

### 6.2 沙箱分层（默认隔离）

| 层 | macOS | Linux | Windows |
|---|---|---|---|
| OS 层 | Seatbelt（`sandbox-exec` profile） | `bwrap` 只读根 `--ro-bind / /` + 可写根叠加 + `PR_SET_NO_NEW_PRIVS` + 进程内 seccomp 网络过滤 | 受限令牌 + AppContainer（**官方标记高度实验性**） |
| 进程层 | 子进程独占 + 独立 `CODEX_HOME` | 同左 | 同左 |
| 策略层 | `sandbox` / `sandboxPolicy` + `approvalPolicy` + `writableRoots` | 同左 | 同左 |
| 审计层 | 全量事件 + 审批决策落 SQLite | 同左 | 同左 |

> **Windows 沙箱不可靠**：官方说明 Everyone SID 已有写权限的目录无法被可靠限制。Windows 生产使用**必须在 Codex 之外**再加 Hyper-V / WSL / 容器 / 独立低权限账户。

Linux 细节：优先用 PATH 中位于 cwd 之外的 `bwrap`；系统 bwrap 过旧则走兼容路径；找不到则回退 `codex-resources/bwrap`；`.git`、解析后的 `gitdir:`、`.codex` 重新绑定为只读。

### 6.3 审批策略

**注意分类：`sandbox mode` 与 `approval policy` 是两个独立维度。** v1.0 6.3 节曾把 `danger-full-access` 误列入审批档位。

| sandbox mode `[实测]` | 行为 |
|---|---|
| `read-only` | 只读；可选独立 `networkAccess` |
| `workspace-write` | 工作区及配置可写根内可写；`.git`/`.codex`/`.agents` 仍只读 |
| `danger-full-access` | 无文件系统沙箱，**仅临时隔离实验，禁止作常规配置** |

| approval policy `[实测]` | 行为 | 适用 |
|---|---|---|
| `untrusted` | 除显式规则允许外全部需要审批 | 未信任项目 |
| `on-request` | 模型决定何时请求审批 | **默认交互式桌面端** |
| `granular` | 按 5 个分类开关细粒度控制 | 降低审批疲劳 |
| `never` | 不弹窗，仍受 sandbox 限制 | CI / 一次性脚本 |

> `on-failure` **不是独立枚举值**，只是 `OnRequest` 的 serde alias。

**危险命令识别只是体验层，不是强制访问控制。** 真正的强制边界来自 Seatbelt / `bwrap`+seccomp、明确 `writable_roots`、网络代理或防火墙、独立低权限用户、MCP 工具白名单。**不得因「命令不在黑名单」就判定安全。**

配置优先级：`CLI 参数 > profile > config.toml > CLI 默认值`。

### 6.4 必须修复的已知漏洞

**CVE-2025-59532 / GHSA-w5fx-fh39-j5rw**（High, CVSS 8.6）：

> Codex CLI 可能因沙箱配置逻辑缺陷，把**模型生成的 `cwd`** 当作沙箱可写根，包括用户启动会话目录之外的路径。

| 项目 | 值 |
|---|---|
| 影响 | CLI `>=0.2.0, <=0.38.0`；IDE 扩展 `<=0.4.11` |
| 修复 | CLI `0.39.0`；扩展 `0.4.12` |
| 限制 | 网络禁用策略不受影响 |

**强制要求**：
- **安全下限** `0.39.0`（不可低于），**开发基线** `0.155.1`（本仓库锁定）
- **锁定版本 + 校验哈希**（`codex.lock.json` + `scripts/verify-codex-version.sh`）
- 工作区固定为**绝对规范化路径**（canonicalize），**不再信任运行期 `cwd` 变更**
- 禁止 Agent 把 `cwd` 改为父目录或符号链接逃逸目标
- 生成 SBOM，CI 订阅 GitHub Security Advisory

### 6.5 审计日志（每条至少含）

`ts` `threadId` `turnId` `itemId` `requestId` `kind` `risk`（自研分级） `decision` `actor(user/auto)` `scope` `command/patch摘要` `cwd` `model` `token估算` `exitCode`

审计日志必须**可导出、可清空、可关闭保留周期**，且**永不离开本机**（除非用户主动导出）。

---

## 7. UI 组件清单

| 组件 | 职责 | 优先级 |
|---|---|---|
| `ProjectSwitcher` | 项目列表、信任状态、分支/worktree | P0 |
| `ThreadList` | 按「待操作优先」排序的线程列表 | P0 |
| `ThreadView` | Turn 时间线，Item 增量渲染 | P0 |
| `Composer` | 输入、附件、模型/effort 选择、slash 命令 | P0 |
| `ApprovalModal` | 五问式审批 + risk tier + **6 值决策矩阵** | P0 |
| `CommandBlock` | 命令、stdout/stderr、耗时、退出码（虚拟滚动） | P0 |
| `DiffViewer` | split/unified、逐文件、hunk 导航 | P0 |
| `FileChangeTree` | 按变更类型分组 + 风险标签 + 评论数 | P0 |
| `ReviewPanel` | 行内评论、接受/拒绝、批量决策 | P0 |
| `PermissionBar` | 顶部常驻：sandbox mode + approval policy + 运行时状态 | P0 |
| `RiskClassifier`（非 UI） | 客户端风险推断 `[自研]` | P0 |
| `AuditLogView` | 审计日志查看与导出 | P1（**安全红线要求，不可延后**） |
| `WorktreePicker` | 新建 Thread 时选运行模式 | P1 |
| `GitPanel` | 分支、commit 分组、PR 草案、合并风险 | P1 |
| `SettingsPanel` | AGENTS.md 预览、Skills、MCP、模型、策略 | P1 |
| `AutoReviewBadge` | `auto_review` 状态与结论展示 | P2 |
| `AutomationPanel` | cron/event、试运行、run history | P2 |

---

## 8. 目录结构

```
kcode/
├─ docs/
│  ├─ KCode落地方案.md            # 本文档
│  ├─ protocol-facts.md          # 自动生成，协议对账基准
│  ├─ 协议勘误与修正.md            # 勘误记录与依据
│  └─ archive/                   # v1.0 原始材料（溯源用）
├─ schemas/                      # 冻结的协议 schema（313 文件）
├─ src/types/protocol/           # generate-ts 产物（721 文件）
├─ scripts/
│  ├─ verify-codex-version.sh    # 版本 + 哈希校验（安全基线）
│  ├─ gen-schema.sh              # schema 生成 / 漂移检测
│  ├─ protocol-facts.mjs         # 协议事实清单生成
│  ├─ contract-test.mjs          # 端到端契约测试（Phase 0 验收）
│  └─ mock-provider.mjs          # 本地 mock provider（离线测试）
├─ src-tauri/
│  └─ src/
│     ├─ main.rs
│     ├─ codex/
│     │  ├─ process.rs           # 子进程生命周期、崩溃恢复
│     │  ├─ jsonl.rs             # 按行拆包/组包
│     │  ├─ transport.rs         # id → oneshot, 超时, 取消
│     │  └─ adapter.rs           # 官方事件 → 领域事件
│     ├─ domain/
│     │  ├─ thread.rs  turn.rs  item.rs
│     │  ├─ permission.rs        # PolicyGate
│     │  ├─ risk.rs              # RiskClassifier [自研]
│     │  └─ changeset.rs
│     ├─ workspace/
│     │  ├─ git.rs               # worktree, diff, merge
│     │  └─ trust.rs             # 项目信任等级
│     ├─ security/
│     │  ├─ audit.rs             # 审计日志
│     │  └─ redact.rs            # 脱敏
│     ├─ store/
│     │  └─ event_log.rs         # SQLite WAL
│     └─ commands.rs             # Tauri commands
├─ src/                          # React 前端
├─ .github/workflows/            # CI：协议漂移 + 契约测试
├─ codex.lock.json               # CLI 版本+哈希锁定
└─ SECURITY.md                   # 对外声明：采集边界、开关语义
```

---

## 9. 分阶段实施计划

### Phase 0 — 地基与协议验证 ✅ **已完成**

| 验收项 | 执行方式 | 状态 |
|---|---|---|
| 锁定 CLI 版本（≥ 安全下限）+ 记录哈希 | `bash scripts/verify-codex-version.sh` | ✅ 0.155.1 |
| 生成并冻结 schema + TS 绑定 | `bash scripts/gen-schema.sh` | ✅ 313 + 721 文件 |
| 协议漂移检测可用 | `bash scripts/gen-schema.sh --check` | ✅ 篡改可检出 |
| 协议事实清单入库 | `node scripts/protocol-facts.mjs` | ✅ 102/82/10 |
| 握手 → 建线程 → 提交轮次 | `node scripts/contract-test.mjs` | ✅ |
| **服务端审批 → 客户端应答 → 轮次收尾** | 同上（本地 mock provider） | ✅ 22/22 通过 |
| 全程离线、零凭据、不污染真实 `~/.codex` | 同上（`CODEX_HOME` 隔离 + `codexHome` 校验） | ✅ |
| 确认审批真实字段名 | `docs/protocol-facts.md` | ✅ 已修正 |

**下一步**：初始化 Tauri 2 + React + Vite 工程；把 `contract-test.mjs` 的 22 项断言移植为 Rust 单测（用例来源已就绪）。

### Phase 1 — 最小可恢复闭环（1-2 周）

- [ ] `CodexSession` + `JsonlTransport` + `id→oneshot`
- [ ] **三类入站消息正确分流**（响应 / 服务端请求 / 通知）
- [ ] 领域模型 Thread/Turn/Item + SQLite 事件日志
- [ ] 三栏布局骨架、项目向导、信任提示
- [ ] Composer、流式消息、命令输出、停止/重试
- [ ] `ApprovalModal`（五问式 + **6 值决策矩阵** + 作用域）
- [ ] `RiskClassifier` `[自研]`（按 3.4 分级原则）
- [ ] `PermissionBar`（sandbox mode + approval policy 状态条）
- [ ] 文件树 + Diff + 逐文件接受/拒绝
- [ ] worktree 创建与分支状态
- [ ] `thread/archive` `thread/resume` `thread/fork` + 崩溃恢复
- [ ] `AuditLogView` + 审计导出（**不可延后**）

**验收**（典型路径端到端跑通）：
> 选 Project → 建 Worktree → 输入任务 → 审阅审批 → 实时观察执行 → 检查验证与 Diff → 评论 → 接受部分文件 → Commit → Push/PR → 归档 Thread

**崩溃验收**：`kill -9` app-server 子进程后重启应用，Thread 历史完整恢复，活动轮次正确标记 `unknown`，无静默覆盖。

### Phase 2 — 团队规范与可观测性（1-2 周）

- [ ] AGENTS.md 编辑器 + 优先级预览 + 校验
- [ ] Skills 安装、依赖检查、运行与权限声明（`skills/list`）
- [ ] MCP 列表、OAuth、工具发现、启停、审计（`mcpServerStatus/list`）
- [ ] 模型 / reasoning effort 选择器（`model/list`）
- [ ] **Granular approvals**（5 分类开关）——官方降疲劳方案
- [ ] **`auto_review` 自动审查**（`approvalsReviewer` + `item/autoApprovalReview/*`）
- [ ] 命令面板：`/review` `/plan` `/explain` `/test` `/commit` `/pr` `/fork` `/permissions` `/skill`
- [ ] 验证矩阵（构建/测试/lint/类型检查/安全扫描），未跑的显式标 `unverified`
- [ ] 耗时、token、成本估算、诊断导出（`thread/tokenUsage/updated`）

### Phase 3 — Automations 与打磨（1 周）

- [ ] cron / event 触发器、试运行入口、审阅队列（可基于 `thread/queue/*`）
- [ ] 后台通知、断线重连
- [ ] 大 Diff 性能优化（分组、按目录批量决策）
- [ ] 上下文膨胀治理：compact/fork 提示、context 摘要

### Phase 4 — 可选扩展

- [ ] 远程控制（`remoteControl/*`，需 TLS + 设备配对后才可开放）
- [ ] Cloud handoff（需自有后端与容器）
- [ ] 语音（`thread/realtime/*`）

---

## 10. 验收测试清单

**功能**
- [ ] 新建 Thread（current tree / new worktree）均能跑通
- [ ] 低风险操作不打断，高风险操作必弹窗且显示完整命令与影响范围
- [ ] 审批 `decline` 后 Turn 继续，`cancel` 后 Turn 中断
- [ ] 审批被第二个客户端应答时，本端经 `serverRequest/resolved` 正确收敛
- [ ] 断线/崩溃后 Thread 历史完整恢复
- [ ] fork 后主上下文不被污染

**安全（逐条验证，不可跳过）**
- [ ] 用抓包工具验证：**除用户显式配置的 provider / git remote / MCP 外，无任何出站请求**
- [ ] 每个隐私开关关闭后，抓包确认对应行为**真正停止**（不是只改 UI 文案）
- [ ] **隐私开关的关闭路径有代码级测试**（不依赖 UI 状态）
- [ ] 审批弹窗中 `.env` / token / 私钥 均为掩码
- [ ] 审计日志不含明文凭据
- [ ] 尝试诱导 Agent 把 `cwd` 切到父目录 → 被拒绝并记审计
- [ ] 尝试 `danger-full-access` → 需要二次确认 + 倒计时 + 明确恢复策略
- [ ] 审计日志可一键导出为 JSON
- [ ] 启动时 `codexHome` 校验失败 → 拒绝启动并提示

**性能**
- [ ] 长输出（>10k 行）不卡顿（虚拟滚动）
- [ ] 流式 delta 不触发整树重渲染
- [ ] 50+ Thread 时侧栏不卡

**协议（CI 自动执行）**
- [ ] `verify-codex-version.sh` 通过（安全基线 + 哈希）
- [ ] `gen-schema.sh --check` 无漂移
- [ ] `protocol-facts.md` 与当前 schema 一致
- [ ] `contract-test.mjs` 全部断言通过

---

## 11. 风险登记

| 风险 | 表现 | 处置 |
|---|---|---|
| 协议实验性 | 官方字段变更破坏 UI | 适配层隔离 + 冻结 schema + CI 差异比对 + 保留 raw_json。**本次核对已实证该风险真实存在**（v1 审批方法整体 deprecated） |
| 版本漂移 | 结果不可复现 | 记录 model、effort、CLI version、skills/mcp 快照；`codex.lock.json` 哈希锁定 |
| **风险分级误判** | 自研分类器漏判导致高危操作被静默放行 | **推断结果不参与放行决策**；强制边界只来自沙箱 |
| 审批疲劳 | 每步弹窗导致用户盲点「允许」 | granular 分类开关 + `acceptForSession` + `acceptWithExecpolicyAmendment` + `auto_review` |
| Diff 过载 | 大范围改动难审阅 | 分组、聚焦风险文件、按目录批量决策 |
| 并行合并摩擦 | 多 worktree 难以集成 | 合并前强制更新 base + 验证 + 冲突预览 |
| Windows 隔离不足 | 官方沙箱实验性 | 文档明示需额外 Hyper-V/WSL/容器 |
| 第三方 provider | 兼容 ≠ 安全 | 白名单 + 出口限制 + 凭据轮换 + 数据留存评估 |
| **叙事可信度** | 引用不可验证的事故数字被指正，损害「可审计」主张 | 只写能给出来源或能由本仓库脚本验证的断言（见 1.3 与 6.1） |

---

## 12. 定位差异

| 维度 | 本方案 | Codex Desktop | Cline | Cursor |
|---|---|---|---|---|
| Agent 内核 | 复用开源 app-server | 同一内核，闭源壳 | 自研 | 自研 |
| 客户端开源 | **是（承诺）** | 否 | 是 | 否 |
| 沙箱 | OS 层 + 策略 + 审计三层 | Seatbelt/bwrap + 审批 | 逐步审批为主 | 内置沙箱 |
| 审批 | risk tier（自研）+ 协议 6 值决策 + granular + auto_review | Granular approvals | 每步审批 | 自动 + 审批 |
| 协议可验证性 | **schema 冻结 + 漂移 CI + 契约测试** | 不公开 | 不适用 | 不适用 |
| 审计可导出 | 是 | 部分 | 部分 | 无 |
| 工作区上传 | **架构级禁止** | 未见同类行为 | 未见同类行为 | 未见同类行为 |

**本方案的核心卖点**：不是「功能比 Codex 多」，而是**「你能验证我在做什么」**——开源客户端、零静默上传、可导出审计、本地优先，且**协议行为由 CI 持续验证**。

---

## 附录 A：本仓库的验证资产

| 资产 | 作用 | 命令 |
|---|---|---|
| `scripts/verify-codex-version.sh` | CLI 版本 + SHA256 校验，安全基线检查 | `npm run verify:codex` |
| `scripts/gen-schema.sh` | 生成/冻结/检测 schema 与 TS 绑定漂移 | `npm run gen:schema` / `npm run check:drift` |
| `scripts/protocol-facts.mjs` | 从冻结 schema 生成协议事实清单 | `node scripts/protocol-facts.mjs` |
| `scripts/contract-test.mjs` | 端到端协议契约测试（22 项断言） | `npm run contract` |
| `scripts/mock-provider.mjs` | 本地 mock model provider（SSE 流式子集） | 由契约测试自动启动 |
| `.github/workflows/protocol-contract.yml` | CI：三道闸门 + 每周版本漂移检查 | 自动 |
| `codex.lock.json` | CLI 版本 + 哈希锁定记录 | — |
| `docs/protocol-facts.md` | 协议对账基准（自动生成） | — |

**全部离线**：契约测试不需要 API key、不访问外网、不污染真实 `~/.codex`（`CODEX_HOME` 隔离 + `codexHome` 回传校验）。

## 附录 B：关键官方来源

1. Codex App Server 文档 — https://developers.openai.com/codex/app-server/
2. Unlocking the Codex harness: how we built the App Server — https://developers.openai.com/codex/app-server/how-we-built-the-app-server/
3. openai/codex 仓库（Apache-2.0） — https://github.com/openai/codex
4. Agent approvals & security — https://developers.openai.com/codex/security/
5. Codex Config — https://developers.openai.com/codex/reference/config/
6. Codex Authentication — https://developers.openai.com/codex/authentication/
7. Codex SDK — https://developers.openai.com/codex/sdk/
8. Codex Linux Sandbox README — https://github.com/openai/codex/blob/main/codex-rs/linux-sandbox/README.md
9. GHSA-w5fx-fh39-j5rw（CVE-2025-59532）— https://github.com/openai/codex/security/advisories/GHSA-w5fx-fh39-j5rw
10. openai/codex Security Advisories — https://github.com/openai/codex/security/advisories

> 注：官方文档站 `developers.openai.com` 对自动抓取返回 403。本项目的协议事实**不依赖文档站**，全部来自锁定版本 CLI 的生成产物与实测握手——这也是更可靠的对账方式。
