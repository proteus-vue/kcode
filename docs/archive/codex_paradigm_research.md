# OpenAI Codex 交互范式研究：面向 Tauri 2 + App Server 复刻的产品与 UI 实现指南

## 摘要：Codex 的核心不是聊天窗口，而是受版本库约束、可审批、可恢复的多 Agent 运行时

截至 **2026 年 9 月**，Codex 已不是单一的“聊天式 AI 编程工具”，而是由 **Codex harness/core + App Server** 支撑的多端 Agent 系统：本地能力集中于 Codex CLI，协作入口覆盖 VS Code 等 IDE、Web/Cloud，macOS/Windows 桌面端则承担了多项目、多线程、多 Agent 并行、Review 与 Automations 的“指挥台”角色；移动端可以继续、引导、审批和执行结果审阅。[1][3]

Codex 桌面端最关键的范式迁移，是把 AI 从“侧边聊天面板”提升为**受版本库隔离、权限审批、流式事件和可恢复上下文约束的长期任务运行时**。对复刻产品而言，真正需要复用的不是某一种具体布局，而是三项底层能力：

1. **以 Thread/Turn/Item 统一建模会话、工作单元和事件。** Thread 承载跨轮上下文与持久历史；Turn 对应用户一次输入触发的连续工作；Item 是用户消息、Agent 消息、命令运行、文件变更、工具调用和审批请求等可渲染单元。[1]
2. **把权限与状态显式化。** `sandbox_mode`、`approval_policy` 和 Granular 审批必须成为一等 UI 状态，而非隐藏设置。[5][6]
3. **将 Git 隔离前置为并行 Agent 的协作前提。** Worktree、分支、Diff Review 和 PR 不应只是“任务完成后附加的 Git 操作”，而应贯穿任务创建、执行、切换、合并与回滚的整个生命周期。[3]

OpenAI 官方将 App Server 定位为**实验性深度集成接口**，其中 WebSocket 明确标注为“experimental and unsupported for production workloads”。因此，复刻产品的长期架构宜采用 **“官方 App Server 适配器 + 自有稳定领域 API”** 的双层结构：底层可调用官方协议，上层则定义不被官方版本演进直接破坏的 UI 契约。[1]

对于桌面端的具体图标、快捷键、菜单文案及个别右键行为，公开官方材料未提供可机器核验的完整规范。本报告将其标注为**实测/社区推断**，可用于原型设计，但不建议作为最终兼容性承诺。

## 1. Codex 已形成五端协同的产品矩阵，但只有桌面端完整承担任务编排职责

**Codex 的统一性来自共享 harness，而不是各端分别重写 Agent 逻辑。** 其中，CLI 是开源、可本地执行和可嵌入的内核；桌面端是集成度最高的编排界面；IDE 与 Cloud 分别优化编辑器内协作和异步执行；移动端则负责跨设备状态延续与审批。

官方说明指出，Web、CLI、IDE 扩展和 macOS 桌面应用都基于同一 Codex harness；App Server 通过双向 JSON-RPC 将这一内核暴露给富客户端，覆盖认证、会话历史、审批和流式 Agent 事件。[1] 因此，Tauri 复刻产品不应把 CLI 视为“外部命令模拟器”，而应将其作为本地 Agent 运行时：通过 stdio 或 Unix socket 管理长生命周期的 App Server 进程，并将 UI 操作转换为稳定的领域方法。

<!-- 图片来源说明：原始链接是带签名的临时地址，含云账号标识，
     已在首次推送到公开仓库前去掉查询串。图片需重新签名才能访问。 -->
![Codex 的统一架构](https://one-agent-prod-1343551737.cos.ap-guangzhou.myqcloud.com/artifacts/0628/bdtjt8eJo0vSUCv9/0QJaOVZirY4/task-c607ae74fc4eeef3e6c393b72aa1c277/.rendered/_assets/dr%3Acodex_paradigm_research/fig_architecture.png)

*图 1：Codex 的统一内核是 harness + App Server；各端负责不同交互密度与部署形态。数据来源：OpenAI《Unlocking the Codex harness: how we built the App Server》[1]。*

### 1.1 产品矩阵与复用边界

| 形态 | 2025—2026 定位与核心动作 | 主要交互对象 | 内核/协议复用 | 开源状态与复刻边界 |
|---|---|---|---|---|
| **Codex CLI** | 本地终端 TUI/exec；读取代码库、编辑、运行命令、流式输出，可作为无头 Agent | 终端、键盘、shell、本地文件系统 | 包含 TUI、exec 和 app-server；是 harness 的 Rust 实现入口 | CLI 及 App Server 以 Apache 2.0 开源。**推荐优先复用，而非重新实现 Agent loop。**[2] |
| **Codex Desktop** | macOS/Windows；以项目组织 Thread，并行 Agent、Worktree、变更审阅、Terminal、Skills、Automations | 窗口、侧栏、Diff、审批弹窗、Git 状态 | 本地通常启动 App Server 子进程并维持双向通道 | 桌面应用本身并非开源；UI/产品编排应复刻，不应假设可直接取得其私有源码。 |
| **IDE 扩展** | VS Code/Cursor/Windsurf 等编辑器上下文；本地改文件、实时 Diff，并可把较大任务委派至云端 | 编辑器选区、侧边面板、Source Control、Cloud task | 复用同一 harness；官方明确存在 Local↔Cloud handoff | 扩展形态依赖各自宿主 API；兼容性不应只按“是否基于 VS Code 内核”判断。[7][8] |
| **Cloud / Web** | `chatgpt.com/codex` 或 GitHub PR；在隔离环境运行任务，交付 PR、Review 或报告 | 浏览器、任务列表、远程执行状态 | 远端容器运行 App Server，前端经 HTTP/SSE 通信 | 复刻时不建议伪造云端沙盒；应优先对接现有 CLI/App Server，并在自有后端补充 Cloud runtime。 |
| **Mobile Remote** | 通过 ChatGPT 移动端连接 Mac/Windows 主机，启动、跟踪、纠偏、审批和审阅结果 | 手机列表、任务详情、命令/Diff/测试结果卡片 | 登录态与活动会话通过 relay 同步 | 官方能力受账号、地区和 workspace 灰度限制；适合作为后续 Phase，不应列为 MVP 阻塞项。[4] |

### 1.2 五端分工不是功能重复，而是控制密度与执行位置不同

**CLI 的核心价值是可脚本化和可嵌入；桌面端的核心价值是任务编排；IDE 强调低摩擦编辑；Cloud 强调异步隔离；移动端则强调关键时刻介入。** 五种形态若只是把聊天框迁移到不同载体，并不会形成产品协同。

桌面发布说明将 Codex App 定义为“agents 的 command center”：Agent 在按项目组织的独立 Thread 中运行，用户可以在任务之间切换而不丢失上下文，审阅 Agent 变更、在 Diff 上评论，或打开编辑器手动修改。[3] 这意味着桌面端并非“把终端包进 WebView”，而是对 Thread、工作区、权限、版本库状态和人工决策进行统一编排。

IDE 的价值在于把上下文限制在光标、选区、当前文件和编辑器 Source Control；Cloud 的价值是脱离本机、异步执行并把结果沉淀为 PR；移动端则不是完整 IDE，而是对**关键时刻**负责：继续、改方向、批准和恢复执行。[4][7]

因此，复刻产品的 MVP 不应追求一次性复制五端，而应建立以下分层：

- **L0：Tauri 宿主。** 负责窗口、项目管理、视图状态和设备能力。
- **L1：Agent 运行时。** 管理 App Server 进程生命周期、能力协商和事件路由。
- **L2：领域 API。** 定义 Thread、Turn、Item、Permission、ChangeSet 和 Run 等业务对象。
- **L3：展示适配。** 分别适配桌面、移动和远程控制所需的不同视图密度。

这种分层既能保留官方 CLI 的行为连续性，也能避免 UI 直接绑定官方内部事件格式。

## 2. Desktop 应围绕“项目—线程—工作单元—变更集”组织，而非堆叠聊天历史

**桌面端最值得复刻的是任务树与版本库状态耦合，而不是三栏布局本身。** 项目负责锚定工作区，Thread 负责保存任务目标与上下文，Turn 承载一次执行，ChangeSet 承载可审阅的副作用；只有将这些对象解耦，才能安全支持并行、恢复、回滚和跨设备续跑。

官方桌面发布材料确认：Agent 在按项目组织的独立 Thread 中运行，内置 Worktree 支持，用户可以审阅变更、评论 Diff，并在编辑器中进行人工修改。[3] App Server 则进一步定义了会话的持久化原语：`thread/start`、`thread/resume`、`thread/fork`、`thread/archive`、`thread/unarchive`、`thread/delete` 和 `thread/compact/start`。[1]

### 2.1 推荐采用四级信息架构

| 层级 | 职责 | 最低 UI 表达 | 对应官方原语 |
|---|---|---|---|
| Project | 锚定仓库/目录、Skills、MCP、默认 profile | 项目切换器；显示信任状态、分支/worktree、最近活跃 | 本地项目、配置层 [6] |
| Thread | 单一任务对话与跨轮上下文 | 可命名、置顶、搜索、分组、归档和恢复 | Thread [1] |
| Turn | 用户一次输入触发的连续工作 | 折叠时间线、状态、成本/耗时、停止与重试 | Turn [1] |
| ChangeSet / Review | 一个 Turn 内产生的文件变更及审阅结论 | 文件树、逐文件 Diff、接受/拒绝、评论 | fileChange Item [1] |

**项目是安全边界，Thread 是任务边界，二者不能混用。** Project 至少应绑定：

- 工作目录或 Worktree 路径；
- 项目信任等级；
- 默认模型及 reasoning effort；
- Sandbox 与 Approval profile；
- AGENTS.md、Skills 和 MCP 配置；
- 当前分支与 Git 健康状态。

Thread 则应保存任务目标、约束、已采纳的历史决策和最终结论。官方已经提供 fork、archive 和 resume，因此“一个任务一条对话”只能作为默认建议；产品还必须允许从某个历史 Turn 分叉，避免无关追问持续污染主上下文。[1]

### 2.2 左中右布局适合 MVP，但任务状态必须进入侧栏排序

```
┌────────────────┬──────────────────────────────┬───────────────────────┐
│ Projects       │ Thread messages / turn log    │ Review & Context      │
│ + Add Project  │ ─ User prompt                 │ Files / Tree          │
│ › repo-a       │   Agent reasoning/plan        │  Diff (split/unified) │
│   • Fix login  │   Tool: read/search/test      │  Inline comments      │
│   • Add OAuth  │   ⚠ AskForApproval           │ Approval detail       │
│ › repo-b       │   Command output              │ Terminal              │
│ Threads        │   File changes                │ Git / PR              │
│ Skills         │ ─ User follow-up              │                       │
│ Automations    │ Composer                      │                       │
└────────────────┴──────────────────────────────┴───────────────────────┘
```

**侧栏排序的第一依据应是待用户操作，而不是最近活动时间。** 建议的排序优先级为：

`等待审批 > 运行中且可介入 > 失败 > 最近完成 > 已暂停`

其后才按项目、时间或自定义分组组织。每个 Thread 行至少显示以下信息：

- 标题或自动摘要；
- 仓库与 worktree；
- 模型；
- 最后更新；
- 变更文件数；
- 审批/失败等状态徽标。

并行 Agent 不能只表现为多个标签页。同一 Project 下允许多个 active Thread，但每个 Thread 必须绑定独立 worktree 或明确标记为共享工作区。恢复、归档和删除也应表现为显式菜单动作，并与底层 `thread/*` 方法一一对应。[1]

### 2.3 Worktree 应从执行细节提升为任务创建选项

**Worktree 不是高级 Git 命令，而是并行 Agent 之间最基础的安全边界。** OpenAI 表示，多个 Agent 可以在同一仓库中工作，每个 Agent 使用隔离的代码副本；桌面端提供内置 Worktree 支持。[3]

在“New Thread”创建流程中，建议将运行模式明确分为：

1. **Current working tree。** 适用于快速调试和小范围修改。
2. **New worktree。** 适用于功能开发、实验性重构和长期任务。
3. **Cloud runtime。** 适用于需要远程执行或隔离环境的任务。

创建面板应同步显示 base branch、目标分支或 worktree 名称、路径、当前 Git 状态、已有未提交变更和风险。`headless` 后台任务应在侧栏保持常驻状态，并支持通知与快速切换，而不是被隐藏在普通终端窗口中。

**Diff 审阅必须把“已提议”与“已应用”分离。** 推荐状态机为：

```
proposed → user_reviewing → accepted_partial | accepted_all | rejected | edited
                                                        ↓
                                            committed → PR_open | merged
```

文件树应按变更类型分组，包括 added、modified、deleted、renamed、conflicting 和 generated，并同时显示风险标签、review 评论数和测试状态。逐文件操作至少需要支持：

- 打开 Diff；
- 跳到某一行；
- 添加行内评论；
- 接受或拒绝单个文件；
- 撤销变更；
- 在外部编辑器打开。

行级评论在发送前应明确区分“仅作上下文”与“要求修改”；后者可以自动追加为下一轮用户指令。官方最佳实践确认，用户可以点击某一行提供反馈，并切换 Diff 面板直接审阅本地变更。[9]

## 3. 任务、审批与合入必须构成闭环，暂停期间不能丢失可追溯上下文

**Codex 的核心控制流不是线性对话，而是“Turn 执行—Permission 中断—用户恢复”的可重放状态机。** UI 的关键职责不是在事件发生时展示动画，而是确保审批、命令、输出、文件变更和后续指令始终可以回到同一上下文。

App Server 将命令、文件变更和工具调用统一描述为 Item；审批请求包括 `itemId`、`threadId`、`turnId`、可选 `reason` 和 `grantRoot`。服务端发起请求时暂停当前 Turn，客户端返回 allow 或 deny 后执行才继续。[1] 因此，每条审批记录都应可追溯到具体 Item、命令、调用工具、作用目录、权限策略和 Turn。

![信任与审批策略](https://one-agent-prod-1343551737.cos.ap-guangzhou.myqcloud.com/artifacts/0628/bdtjt8eJo0vSUCv9/0QJaOVZirY4/task-c607ae74fc4eeef3e6c393b72aa1c277/.rendered/_assets/dr%3Acodex_paradigm_research/fig_trust.png)

*图 2：Codex 默认不是“全放开”或“全禁止”，而是通过沙盒与审批组合限制副作用。数据来源：OpenAI《Agent approvals & security》《Config》[5][6]。*

### 3.1 推荐主任务流：把计划、风险和变更分阶段呈现

```
提交 → 规划/探索 → 预览命令或变更 → 审批（如需） → 执行 → 测试/验证 → 结果 & ChangeSet → 审阅 → 提交/PR → 多轮追问
```

| 阶段 | 用户动作 | UI 应显示 | 系统反馈/协议映射 |
|---|---|---|---|
| 1. 创建任务 | 选择 Project；选择 Local/Worktree/Cloud；输入目标并附加文件或截图 | 运行模式、模型、effort、权限预设、base branch | `thread/start`；设置 cwd/worktree [1] |
| 2. 规划 | 不要求每次都显式点击“计划” | 计划摘要、受影响模块、验证策略、风险 | Agent/tool Items；建议保留展开/折叠的推理细节 |
| 3. 审批 | 查看命令、目录、网络、文件写入和作用域 | 命令、环境变量脱敏摘要、差异预览、Allow once / Always for profile / Deny / Edit command | `requestApproval`；返回 allow/deny [1][5] |
| 4. 执行 | 可中途停止、追加追问或降低权限 | 实时命令输出、测试进度、token/时间提示 | command/fileChange/tool Items，增量 delta [1] |
| 5. 审阅 | 检查 Diff、写评论、接受或拒绝 | 文件树、逐行 Diff、测试/lint 状态、冲突风险 | ChangeSet 聚合；可映射到 `fileChange` Item [1][9] |
| 6. 合入 | Commit、Push、Create PR 或继续迭代 | Commit 分组、PR 模板、目标分支、CI 链接 | Git tool calls；建议先形成 ChangeSet，再执行原子 Git 操作 |
| 7. 追问 | 引用某行、评论、计划分支或上下文 | 引用锚点、相关文件、fork 提示 | Turn 追加；长上下文可触发 compact/fork [1] |

**审批模态框必须回答五个问题：做什么、为什么、在哪里、影响多大、是否允许后续复用。**

| 必答问题 | 最低展示内容 |
|---|---|
| 做什么 | 完整命令或工具参数，环境变量默认脱敏 |
| 为什么 | Agent 目标、相关计划步骤和审批原因 |
| 在哪里 | 工作目录、git root、worktree、目标文件或 URL |
| 影响多大 | 写入、删除、网络、凭据探测、持久化、破坏性操作和依赖安装等风险 |
| 如何决策 | Allow once、Allow for this profile、Always require approval、Deny、Edit command |
| 如何追溯 | 显示完整 `reasoningId/turnId/itemId` 调试链路 |

官方 Granular policy 已覆盖 sandbox、exec policy、MCP、request_permissions 和 skill-script 审批类别；Desktop 还支持自动审查，状态包括 Reviewing、Approved、Denied、Aborted 或 Timed out，并可附带风险级别。[5] 因此，自建 UI 至少应把 **risk tier、reviewer 意见和 user authorization required** 设置为可扩展字段，而不是只显示“允许/拒绝”。

### 3.2 Cloud Handoff 是执行位置迁移，不应让用户重新描述任务

**Handoff 的最小契约是 Thread 可恢复、依赖可说明、产物可回流。** 官方在 2025 年更新中明确表示，开发者可以在本地与 Codex 配对，再把任务委派到云端异步执行，且不丢失状态；IDE 也支持在本地打开云端任务。[8]

可执行任务必须包含：

- Thread 历史或紧凑化后的上下文；
- 仓库快照或 checkout 能力；
- AGENTS.md、Skills 和 MCP 依赖；
- 模型及 reasoning effort；
- 显式 output contract，例如 PR、Issue、Diff、Report 或 Artifact。

因此，桌面端应分别显示 **local run、worktree run、cloud run 和 remote host** 四种执行位置，并在任务卡中同步以下信息：

- 执行位置；
- 依赖来源；
- 网络策略；
- 凭据策略；
- 超时；
- 输出去向。

Cloud 任务从定义上无法天然访问本机数据库、`.env`、SSH 或内网服务。若缺少这些依赖，产品不应假装可以继续执行，而应明确提示“本地依赖不可达”，并允许降级为 Plan-only、上传必要上下文，或交回本地 Agent。

### 3.3 移动远程执行仍由主机负责，跨端同步的是事件与决策

**移动端是控制面，而不是独立执行环境。** 官方流程包括：选择已连接计算机和项目，描述任务；在工作发生时继续引导；审查请求命令和操作；检查结果中的响应、修改文件、Diff 和测试。[4]

连接使用二维码配对，主机必须保持唤醒、在线并运行 Codex。由此可见，移动端至少需要：

- 设备信任管理；
- 任务列表；
- Thread 详情；
- 审批详情；
- 实时日志；
- Diff 摘要；
- 评论/指令输入；
- 关键操作确认。

适合 Phase 2 的能力包括后台通知、watch、断线重连和敏感操作二次确认；不适合作为早期目标的则包括大文件 Diff 编辑、复杂 merge 冲突处理和完整 IDE 替代。

### 3.4 Automations 必须把触发器、运行上下文和审阅队列分开建模

**Automations 不是普通聊天加 cron，而是“触发—隔离运行—产物审阅”的独立领域对象。** 官方 Scheduled tasks 可以由固定周期或受支持的应用事件触发，并可与 Skills 组合；桌面端中的定时任务可以在项目目录或隔离 worktree 中运行本地项目，但要求计算机保持开机且应用持续运行。[10]

适合自动化的任务包括每日 Issue triage、CI 失败汇总、依赖更新、安全扫描和 release brief；不适合自动合并、生产部署、密钥变更或破坏性迁移，除非已经存在强审批、dry-run 与可观测性保障。

建议采用以下数据模型：

```
Automation:
  trigger: cron | event | manual
  input: prompt | skill_ref | prompt_template
  context: project | worktree | uploaded | connected_tools
  policy: sandbox, approvals, reviewer, notification
  run_history: status, thread_ref, changeset_ref, review_decision
```

官方建议先在正常聊天中测试提示词，再创建定时任务，并持续观察最初几次运行。[10] 自建产品应强制保留相同的试运行入口，同时将每次 run 映射为可恢复 Thread，避免定时任务变成无法审计的“幽灵脚本”。

## 4. App Server 应驱动领域状态，Tauri 只负责宿主、生命周期与渲染

**App Server 复刻策略应是“紧耦合于官方协议，但松耦合于官方内部事件”。** Tauri 侧负责进程、配置、文件和原生能力；Agent 适配器负责翻译协议；领域层则把事件规约为稳定 UI 状态。

官方说明，App Server 支持 JSON-RPC 2.0 和 JSONL over stdio；Unix socket 也可用于本地集成，WebSocket 则用于远程场景。服务器可以主动发起请求，例如等待用户批准；Thread/Turn/Item 是其核心会话模型。[1]

Tauri 2 的主进程中，建议按以下方式组织：

- `AgentRuntimeService`：管理官方二进制版本、下载、更新、启动参数和崩溃恢复；
- `AppServerTransport`：处理 stdio/Unix socket JSON-RPC；
- `ProtocolAdapter`：将官方事件映射为内部领域事件；
- `DomainStore`：管理 Thread、Turn、Item、ChangeSet、Permission 和 Run；
- `ProjectWorkspaceService`：管理 Project、Git、Worktree、信任和锁；
- `PermissionGate`：执行沙盒、审批、自动审查和审计日志；
- `WebView IPC Bridge`：通过受控命令向前端暴露状态。

前端只接收领域状态，不直接拼接原始 JSON-RPC。这一边界可以防止官方协议字段变化直接破坏 UI。

![任务闭环](https://one-agent-prod-1343551737.cos.ap-guangzhou.myqcloud.com/artifacts/0628/bdtjt8eJo0vSUCv9/0QJaOVZirY4/task-c607ae74fc4eeef3e6c393b72aa1c277/.rendered/_assets/dr%3Acodex_paradigm_research/fig_task_flow.png)

*图 3：Codex 的任务闭环应被设计为可恢复状态机；审批拒绝和指令纠偏都是正常分支。数据来源：OpenAI App Server 与 Agent approvals [1][5]；交互编排为本报告建议。*

### 4.1 事件模型建议：以 Item lifecycle 驱动增量渲染

官方 Item 具有明确生命周期：`started`、可选的流式 `delta` 和 `completed`。[1] 复刻产品不应将原始事件直接写入全局数组，而应按 `itemId` 执行 upsert：

```ts
type Item =
  | UserMessage
  | AgentMessage
  | CommandRun { status, command, outputChunks, exitCode }
  | FileChange { path, kind, diffId, reviewStatus }
  | ToolCall { server, tool, argsSummary, resultSummary }
  | RequestApproval { permissionKind, risk, reason, decision? }
  | ChangeSet { files, commitCandidate, prCandidate };
```

Turn 状态应至少包括：

```
queued → running → awaiting_approval → running → verifying → success | failed | cancelled | needs_input
```

Thread 状态应至少包括：

```
active → archived
```

恢复时应按 Thread → Turn → Item 的顺序增量重放，而不是重新请求整个历史。对命令输出、推理内容和 Diff 采用分段分页；长时间任务还应定期生成检查点摘要，以降低重连和滚动成本。

### 4.2 官方协议用于对接，稳定领域 API 用于产品演化

| 层级 | 推荐职责 | 稳定性策略 |
|---|---|---|
| 官方 App Server | 启动 core、驱动 Agent loop、传递认证、历史和审批 | 跟随 OpenAI 发布；标记为 experimental [1] |
| Compatibility Shim | 把 `thread/*`、`turn/*`、`item/*`、`requestApproval` 映射为内部事件 | 增加 schema 版本、未知字段保留和降级处理 |
| Product API | `createTask`、`forkTask`、`reviewFile`、`decidePermission`、`createChangeSet`、`mergeToMain` 等 | Tauri 产品长期维护的稳定契约 |
| UI State | ThreadViewModel、DiffViewModel、PermissionViewModel | 不直接依赖官方 wire type |

官方明确指出，WebSocket transport 属于 experimental，且 unsupported for production workloads。[1] 因此，MVP 应优先使用 stdio 或 Unix socket；只有在具备 TLS、身份认证和授权体系后，才实现远程 Agent 控制。

`--remote` 虽然支持 `ws://`、`wss://`、Unix socket 及自定义路径，但官方同时警告：**plain WebSocket 只适用于 localhost 或 SSH 端口转发场景。** 这说明“能够连接”不等于“安全可用于生产”。[1]

## 5. 安全模型必须进入主界面，策略、配置与运行时状态不能分散管理

**权限不是设置在启动前一次性确定，而是在整个任务生命周期中持续变化。** 每次权限升级都应可审计、可恢复，并清楚区分“当前允许”“未来自动允许”和“项目级策略”。

官方建议，版本控制目录默认采用 `workspace-write + on-request`；无版本控制目录默认 `read-only`；系统还可能要求显式信任工作目录。默认 workspace-write 并不意味着全开放，`.git`、`.agents` 和 `.codex` 等受保护路径仍保持只读。[5]

配置优先级为：

```
CLI 参数 > profile > config.toml > CLI 默认值
```

配置可以存在于用户目录、项目目录或 profile 专属文件。[6]

### 5.1 权限面板应同时展示静态策略与动态状态

| 配置/动作 | 官方语义 | 推荐 UI 控制 |
|---|---|---|
| `sandbox_mode` | `read-only` / `workspace-write` / `danger-full-access` | Project 设置中的 run mode；运行时顶部状态条 [6] |
| `approval_policy` | `never` / `on-request` / `untrusted` / `granular` | 每个 Thread 的 approval preset；高风险动作强制提示 [5] |
| Granular policy | 可分别控制 sandbox、exec、MCP、request_permissions、skill-script | 设置页按类别管理；变更写入 profile [5] |
| `approvals_reviewer` | `user` 或 `auto_review` | 桌面端可显示 reviewer 状态、风险与授权结论 [5] |
| `network_access` | workspace-write 默认禁止出站 | 每次网络请求显示目标、用途和审批原因 [6] |
| `model` / `model_reasoning_effort` | 模型选择；reasoning 可为 `minimal`/`low`/`medium`/`high` | Composer 旁模型选择器；effort 归入高级运行选项 [6] |

UI 至少应区分：

- **静态：** 项目策略、profile、管理员要求；
- **动态：** 当前 cwd、worktree、grantRoot、MCP server 和网络状态。

“Always allow”不能只记录当前命令字符串，还应明确作用域，例如：

- 当前 Thread；
- 当前 Project；
- 当前 Profile；
- 全局。

自动批准仍应记录审计日志。反之，临时“Full Access”必须显示倒计时、适用范围和后续恢复策略。

### 5.2 AGENTS.md、Skills 和 MCP 分别承担规则、流程与外部能力

**三者必须分层，不能把所有团队知识塞进一个巨型 AGENTS.md。** 官方加载层级包括：

- `~/.codex/AGENTS.md`；
- 仓库根或嵌套目录中的 `AGENTS.md`；
- 全局及仓库 Skills；
- 位于 `.agents/skills` 的仓库技能。[11]

AGENTS.md 应聚焦项目事实和工作协议，例如技术栈、目录约定、测试命令、lint/format、禁止事项和 PR 规范。Skills 适合封装重复流程，通常包含 `SKILL.md`，以及可选的 scripts、references 和 assets。MCP 则连接本地仓库之外的能力，例如 Figma、Linear、GitHub 和内部知识库。[11]

| 能力 | 建议位置 | 触发方式 | UI 表达 |
|---|---|---|---|
| Project rules | `AGENTS.md`、`.codex/`、`.agents/` | 自动加载 | Settings 中的“已加载指令”预览与优先级 |
| Reusable workflow | `SKILL.md` + scripts/references | 显式调用或按 description 隐式匹配 | Skills 列表、依赖检查、运行入口 [11] |
| External tools/context | MCP server | Agent 工具调用 | Servers 列表、工具/资源、连接状态和 OAuth |
| One-off command | 内置 slash command | 用户输入 `/` | Command palette、参数表单、可发现性 |

官方 SKILL 示例说明，技能可以像 commit 流程一样封装操作步骤：按 feat、test、docs、refactor、chore 等逻辑分组，再生成聚焦、可审阅的提交。[11] 这表明 Skill 的正确产品形态是“可组合工作流包”，而不是另一套散落的提示词文件。

Skill 定义应包含：

- `name` 和 `description`；
- 输入 schema；
- 前置条件；
- 所需 MCP；
- 建议权限；
- 输出；
- 失败重试策略。

若 Skill 包含脚本，还应明确其执行的 sandbox 与 approval 类别。[5][11]

### 5.3 Slash commands 应兼顾效率与可审计性

官方已确认桌面端可使用 `/review` 和 `/personality`，CLI 还存在 `/status`、`/permissions` 等交互命令。但 Codex 的公开稳定命令清单随版本变化，不能据此推断不存在其他命令。

建议 MVP 提供以下一组最小命令：

| 命令 | 用途 |
|---|---|
| `/review` | 按 base branch、uncommitted changes、commit 或自定义 review instructions 审查 |
| `/plan` | 强制进入只读规划 |
| `/explain` | 解释当前 Diff 或 Turn |
| `/test` | 按 AGENTS.md 运行验证 |
| `/commit` | 分组提交 |
| `/pr` | 生成 PR |
| `/fork` | 从当前 Turn 分叉 |
| `/permissions` | 查看当前策略 |
| `/skill` | 选择或触发 Skill |

`/review` 官方支持 base branch、uncommitted changes、commit 和自定义审查指令；团队还可以通过 `code_review.md` 配合 AGENTS.md 统一规范。[9] 自建产品应将每个 slash command 映射到可回放的领域动作，而不是在前端直接拼接自由文本。

## 6. Codex 的差异化不在于多 Agent，而在于把隔离、控制与延续做成默认结构

**Codex 相对 Cursor、Cline、Claude Code 和 Devin 的核心差异，可以概括为三项：统一 harness 与多端状态延续、原生系统沙盒与细粒度 approval、Worktree 成为并行任务默认边界。** 这些能力共同把 Agent 从“连续对话”转变为“可管理的长期工作单元”。

| 产品 | 官方交互重点 | Codex 最值得借鉴的差异 | 不宜简单复制之处 |
|---|---|---|---|
| **Codex** | Thread/Turn/Item、App Server、worktree、桌面 Review、Mobile relay、Automations | 多端共享 harness；OS 级 sandbox + 审批；任务/版本库隔离 | 桌面私有 UI、云端 runtime 细节未公开 |
| **Cursor** | Agent 面板、实时 Diff、子 Agent、后台/Cloud Agents、checkpoint | “应用编辑”与编辑器 Source Control 深度结合；多模型比较 | 每款产品都应有自己的 checkpoint 与 apply 语义，不能机械照搬 [12] |
| **Cline** | Plan/Act、每步编辑/命令审批、checkpoint、MCP、浏览器 | 强 human-in-the-loop 对高信任需求有价值 | Codex 的 Granular 审批更加类别化，不必每个动作都阻塞 [5] |
| **Claude Code** | Skills、hooks、subagents、MCP、session 命令 | 项目知识与自动化生命周期值得参考 | Codex 的 App Server 明确把审批和线程持久化纳入协议 [1] |
| **Devin** | 长任务、checkpoint/sub-task、云端隔离、issue 驱动 | 任务结果的可验证性、子任务拆分和 PR/Issue 衔接 | 不应照搬“全托管 VM”或具体远程 UX [13] |

### 6.1 差异一：统一 Agent 协议把会话、审批和持久化变成跨端语言

**App Server 使 Codex 从“能在多个界面里聊天”升级为“能在多个端恢复同一任务”。** 对 Tauri 复刻产品而言，这意味着前端不再是唯一事实源。App Server 可以存在于本地子进程、Web worker 或远程容器中，只要保持 Thread/Turn/Item 和请求/响应语义，桌面、Web 与移动端就可以共享事件流。[1]

Cursor 等编辑器虽然也在强化 Agent 面板、后台任务和 Cloud Agents，但 Codex 的独特之处在于，App Server 从设计之初就将审批、流式事件和会话历史纳入面向客户端的协议。[1][12]

### 6.2 差异二：安全控制是任务状态的一部分，而不是启动前的复选框

**Codex 的 trust、sandbox、approval 和 auto-review 共同形成“权限时间线”。** 读写范围、网络、MCP、Skill 脚本和自动审批各自可配置；Desktop 还会把自动审查结论显示给用户。[5]

复制“每步都弹窗”并不能提高安全性，反而会造成审批疲劳。更有效的做法是将风险分级：

- 低风险操作默认放行或批量处理；
- 中风险操作批量确认；
- 高风险操作单独阻塞；
- 所有权限升级进入审计日志。

关键不在弹窗数量，而在于任何时候都能回答：**当前 Agent 为什么拥有这项能力、能力从哪里来、将持续多久。**

### 6.3 差异三：Worktree 是并行 Agent 的默认协作前提

**Codex 将同一仓库的多个 Agent 明确置于隔离代码副本中，避免并行探索直接污染主分支。** 官方桌面说明强调，多个 Agent 可以在同一仓库中工作，每个 Agent 使用隔离副本，桌面端内置 Worktree 支持。[3]

这一范式直接改变产品信息架构：

- Project 列表需要展示分支和 worktree；
- Thread 列表需要展示执行位置；
- Review 面板需要展示来源分支；
- Git 面板需要展示 merge、rebase 和冲突风险。

Cursor 也采用自动 worktree，但 Codex 的优势在于将同一模型同时贯穿 CLI、IDE、Desktop 和云端，使并行任务与版本库隔离成为一致的基础原语。[3][12]

### 6.4 差异四：Automations 与 Skills 使 Agent 从临场对话转向组织流程

**Codex 将可重复工作流沉淀为 Skill，再将 Skill 接入定时或事件触发的 Automation，使 Agent 不再只是“用户在线时的一次回答”。** 官方使用案例包括 issue triage、CI 失败汇总、release brief 和周期检查。[3][10]

相比之下，传统 IDE Agent 仍以“当前编辑器状态 + 单次任务”为中心。复刻产品不应一开始追求“让 Agent 自己发明新任务”，而应先提供：

- 明确的触发器；
- 可审计的运行历史；
- 稳定的输入上下文；
- 产物 Review；
- 失败告警与人工接管入口。

## 7. 最大风险不是功能不足，而是把协议、任务状态与 AI 输出过度承诺为确定结果

**复刻时必须把“实验性协议”“异步执行”“模型非确定性”和“远程控制风险”视为一等约束。** 任何隐藏这些不确定性的设计，短期看似流畅，长期都会增加任务不可恢复、状态不一致和安全事故风险。

### 7.1 App Server 仍处于实验性阶段，版本绑定必须显式化

官方明确将 WebSocket transport 标记为 experimental 且 unsupported for production，App Server 本身也是深度集成接口。[1] 因此：

- 必须锁定 CLI/App Server 版本；
- 协议适配层需要记录 schema 版本；
- 未知字段必须保留，避免静默丢弃；
- 应提供离线检测和自动降级；
- 提供可导出的最小复现包，包含配置脱敏副本、Thread 摘要和运行日志。

“Tauri 调用官方 app-server”不能被视为无版本约束的长期稳定承诺。

### 7.2 并行任务的价值来自隔离，风险也来自隔离后的集成成本

**N 个并行 Agent 并不等于 N 倍产出。** 其真实收益取决于任务边界是否清晰、worktree/branch 是否可以独立验证，以及最终是否能够安全合并。

如果多个 Thread 修改同一模块、共享依赖状态或相互等待，UI 应显示：

- 相关任务；
- 依赖关系；
- 冲突文件；
- 预计合并风险。

建议在合并前强制执行：

1. 更新 base；
2. 运行项目验证；
3. 生成冲突报告；
4. 提供三方 Diff；
5. 必要时将冲突交回人工处理。

官方虽然提供 worktree 隔离，但没有承诺自动解决所有合并问题。[3] 因此，自建产品不应把“多个 Agent 同时完成”包装成确定性的多路合并能力。

### 7.3 Agent 输出必须可验证、可回滚，不能只展示“任务完成”

官方最佳实践要求 Agent 编写或运行测试、执行 lint/type check、确认最终结果并审阅 Diff，用户也可以在桌面 Diff 面板中审阅变更。[9]

自建产品应在 Turn 结束时强制展示验证矩阵：

| 验证项 | 最低展示内容 |
|---|---|
| 构建 | 是否执行、命令、结果、日志入口 |
| 测试 | 命令、通过/失败、覆盖范围（如有） |
| Lint/Format | 规则集、问题数量、是否自动修复 |
| 类型检查 | 命令、错误数量 |
| 安全扫描 | 工具、发现项和严重级别 |
| 手动验收 | 需要用户确认的命令或 URL |

如果验证没有运行，应明确标记为 `unverified`。同时应为 ChangeSet 提供快照、撤回和 discard worktree 的能力。

### 7.4 远程控制的风险不在“能否连接”，而在凭据与可信设备边界

**Remote 的控制面与数据面必须分离。** 官方只允许连接自有且可信的设备，并要求主机保持唤醒、在线和运行 Codex。[4]

MVP 不建议通过 Tauri 直接暴露本地 Agent Server。至少应增加：

- 设备配对；
- 短期令牌；
- TLS；
- 授权代理；
- 速率限制；
- 命令白名单；
- 敏感操作二次确认；
- 审计记录；
- 一键吊销。

审批视图必须默认脱敏 `.env`、私钥、token 和 `Authorization` 等数据。自动审批只能适用于经过策略约束的低风险操作，不能因为“用户曾经允许过”就无限延续授权。

### 7.5 已知用户体验风险应按产品阶段处理，而不是通过隐藏复杂度解决

| 风险 | 表现 | 推荐处理 |
|---|---|---|
| 上下文膨胀 | Thread 越往后越容易跑题或遗忘约束 | 明确 compact/fork；把长期规则放入 AGENTS.md；展示 context 摘要 [1][11] |
| 审批疲劳 | 每步弹窗导致用户盲目允许 | 按类别 Granular 审批，组合 skill 与 allow-for-profile，高风险单独确认 [5] |
| Diff 信息过载 | 大范围生成难以逐文件审阅 | 分组、聚焦风险文件、支持 AI review、允许按目录批量决策 |
| 云/本地上下文断裂 | Cloud 缺少本地服务或密钥 | 明确输出契约、依赖检查、Plan-only 降级；禁止静默失败 [8] |
| Worktree 合并摩擦 | 多分支测试后难以集成 | 显示 merge 风险、base 更新和冲突预览 [3] |
| 模型/版本漂移 | 结果不稳定，难以复现 | 记录 model、effort、CLI version、skills/mcp 快照和 seed 上下文 |

这些风险背后存在共同原则：**用户需要看见 Agent 的边界，而不是只看见它的输出。** 进度、失败、权限升级、上下文压缩、合并冲突和验证缺失都应成为明确状态，而不是通过 UI 简化被隐藏。

## 8. MVP 应先交付可恢复的任务闭环，再扩展 Cloud、Mobile 与自动编排

**开发顺序应从“可运行的本地任务闭环”开始，而不是先复制全部端点和界面。** 第一阶段的目标是证明 Thread、审批、ChangeSet 和 Git 状态可以端到端恢复；后续再增加 Cloud runtime、Mobile relay 和 Automation orchestrator。

### 8.1 Phase 1：先证明“最小闭环 + 可恢复”

建议交付范围：

1. Tauri 2 窗口、项目向导和信任提示；
2. 通过 stdio/Unix socket 管理 App Server 生命周期；
3. Thread/Turn/Item 领域模型与事件溯源；
4. Composer、流式消息、命令输出和停止/重试；
5. `read-only`/`workspace-write` 权限状态条；
6. 命令、文件写入和网络审批；
7. 文件树、Diff、行内评论、接受/拒绝；
8. Worktree 创建与分支状态；
9. Commit/PR 草案；
10. `thread/archive`、`thread/resume`、`thread/fork`、崩溃恢复和导出。

Phase 1 完成后，一个典型用户路径应能够端到端运行：

> 选择 Project → 创建 Worktree → 输入任务 → 审阅审批 → 实时观察执行 → 检查验证与 Diff → 评论 → 接受部分文件 → Commit → Push/PR → 归档 Thread。

这一路径覆盖项目、执行、权限、审阅、版本控制和恢复，是后续扩展的基础。

### 8.2 Phase 2：补齐团队规范、Cloud runtime 与可观测性

第二阶段建议增加：

- AGENTS.md 编辑器、优先级预览和校验；
- Skills 安装、依赖检查、运行与权限声明；
- MCP 列表、OAuth、工具发现、启用/禁用和审计；
- Model/effort/verbosity 选择器；
- Granular approvals 和自动审查；
- `/review`、`/plan`、`/test`、`/commit`、`/pr` 等命令面板；
- Cloud handoff、输出回传和本地继续；
- Automations 的 cron/event、试运行和审阅队列；
- 后台通知、日志、token/耗时、cost estimation 和诊断。

这些能力的共同目标是让 Agent 从个人助手演变为团队流程的一部分。其前提不是功能数量，而是每项能力都可以被配置、审计、恢复和禁用。

### 8.3 Phase 3：再进入 Mobile remote 与跨端 relay

第三阶段应遵循官方成熟度顺序：[4][10]

1. 先实现桌面端 Automations 与本地项目执行；
2. 再设计受保护的移动端状态同步；
3. 最后实现远程审批和设备管控。

移动端 MVP 可只支持：

- 设备配对；
- 任务列表；
- 详情；
- 审批；
- 评论/指令；
- 通知。

复杂 Diff 编辑、merge 冲突处理和长时间日志浏览仍应回到桌面端。由于 remote、操作系统和发布状态仍在快速变化，截至 2026 年 9 月，不应把完整移动 IDE 作为首发承诺。[4]

### 8.4 组件清单：优先实现能够支撑状态恢复的最小字段集

| 模块 | 最小字段/方法 | 关键交互 |
|---|---|---|
| Project | id、path、worktreeStrategy、trust、profile、skills、mcp | 添加、信任、切换、检测 Git |
| Thread | id、projectId、title、createdAt、status、pinned、archived | 新建、搜索、分组、归档、恢复、fork |
| Turn | id、threadId、status、model、effort、startedAt、finishedAt | 停止、重试、引用、压缩 |
| Item | id、turnId、type、lifecycle、payload、createdAt | 增量渲染、展开、定位文件 |
| Permission | id、itemId、kind、risk、reason、scope、decision | Allow once / profile、Deny、Edit |
| ChangeSet | id、turnId、files、reviewState、base/head | 逐文件审阅、批量接受、撤销 |
| Automation | id、trigger、skill/prompt、policy、lastRun、reviewQueue | 试运行、启用/暂停、run history |

这套清单的重点不是字段数量，而是对象边界能否支撑恢复、审计与合并。只要这些状态稳定，即使官方协议发生字段调整，也可以通过适配层继续兼容。

## 结论：应复刻“受约束的长期任务运行时”，而不是某个具体聊天窗口

Codex 在 2025—2026 年形成的产品范式，可以概括为：**一个共享 Agent harness，一套 Thread/Turn/Item 事件语言，多种按场景分布的交互表面。**

桌面端最重要的产品决策，是将 Thread、Git 隔离、Diff Review、权限审批、多 Agent 并行和 Automations 组合成可持续监督的开发控制台。其价值不在于“AI 响应更快”，而在于任务可以被创建、中断、审批、恢复、验证、合并和归档。

对于 Tauri 2 复刻产品，建议遵循以下实现原则：

1. **官方 CLI/App Server 是 Agent 内核，不是 UI 模拟对象。** 应长期运行并翻译事件，而不是临时调用 CLI。
2. **Tauri 负责原生宿主与进程边界，领域 API 负责产品稳定性。** 前端不应直接耦合官方 wire type。
3. **Thread/Turn/Item 是所有视图的统一状态源。** 流式输出、审批、命令、工具、Diff 和评论都应进入同一可恢复事件流。
4. **Git worktree、sandbox、Granular approval 和 review 是首要交互。** 安全控制与版本控制不是设置页附属项，而是主界面的常态状态。
5. **Cloud、Mobile 和 Automations 应按成熟度分阶段实现。** 先完成本地任务闭环，再扩展执行位置、跨端 relay 与自动编排。

最终需要复制的不是 Codex 某个窗口的具体外观，而是其产品机制：**让 Agent 在明确边界内长期运行，让用户始终能够看见、审批、纠正和接管。**

## 数据来源

1. **Unlocking the Codex harness: how we built the App Server**  
   https://developers.openai.com/codex/app-server/

2. **OpenAI Codex（GitHub 仓库）**  
   https://github.com/openai/codex

3. **Introducing the Codex app**  
   https://openai.com/index/introducing-the-codex-app/

4. **Codex Remote：通过手机远程启动、引导和审查编码任务**  
   https://developers.openai.ac.cn/codex/remote/

5. **Agent approvals & security**  
   https://developers.openai.com/codex/security/

6. **Codex Config**  
   https://developers.openai.com/codex/reference/config/

7. **Codex IDE 扩展（Visual Studio Marketplace）**  
   https://marketplace.visualstudio.com/items?itemName=OpenAI.chatgpt

8. **OpenAI Codex 更新：本地与云端无缝协作**  
   https://openai.com/chatgpt/enterprise/b/codex-updates/

9. **Codex Best practices**  
   https://developers.openai.com/codex/best-practices/

10. **Scheduled tasks**  
    https://developers.openai.com/codex/scheduled-tasks/

11. **Customization / Skills**  
    https://developers.openai.com/codex/customization/

12. **Cursor Agent 模式**  
    https://docs.cursor.com/agent

13. **Devin Prompting**  
    https://docs.devin.ai/learn-about-devin/prompting

14. **《从海外模型看国内基础模型》— Codex 产品时间线与能力演进材料**  
    https://ima.qq.com/wiki/?shareId=8a49e04a576a6e6ea5043b9b4c8c4e04cfb0e5a709a264c3f09d8ee12873ad33&mediaId=pdf_9bd3e3a6c63721a75a4ea0151f8cd8a1_2808f98039e8e6cc0c5ba057dd680ceb7461198219994053&action=openDetailDrawer&webFrom=10000171

15. **Codex 桌面端新手使用教程（CSDN）**  
    https://blog.csdn.net/Cacode92/article/details/162394947

16. **Codex Desktop 官方文档页（检索时未能成功抓取，未作为正文事实依据）**  
    https://developers.openai.com/codex/desktop/

17. **Codex Advanced Config 官方文档页（检索时未能成功抓取，未作为正文事实依据）**  
    https://developers.openai.com/codex/reference/advanced-config/

18. **Agent approvals & security（检索记录中的重复条目）**  
    https://developers.openai.com/codex/security/

19. **Codex Desktop 文档页（检索记录中的重复地址）**  
    https://developers.openai.com/codex/desktop/

20. **Codex Advanced Config 文档页（检索记录中的重复地址）**  
    https://developers.openai.com/codex/reference/advanced-config/