//! 应用服务：编排适配层与领域层，向前端暴露稳定的领域 API。
//!
//! # 为什么单独成层
//!
//! 这一层承载全部业务编排，且**不依赖 Tauri**——因此可以用真实 app-server
//! 完整测试，不必拉起桌面壳。Tauri 只做一层极薄的命令转发。
//!
//! # 为什么不共享 `Mutex<JsonlTransport>`
//!
//! app-server 是单连接：写请求、读事件、应答审批必须串行化。若用
//! `Mutex<JsonlTransport>`，读事件会长期持锁（它要 await 下一条事件），
//! 命令与审批应答将永远拿不到锁——直接死锁。
//!
//! 这里用 owner 任务独占 transport，并把**读侧拆出去**（[`JsonlTransport::take_inbound`]），
//! 于是 `select!` 可以在同一个循环里同时等待「新命令」与「新事件」：
//!
//! ```text
//!   UI ──command──▶ mpsc ──┐
//!                          ├──▶ owner 循环 ──▶ app-server (stdio)
//!   UI ◀──event── broadcast ┘
//! ```
//!
//! 两种输入天然串行，且没有任何锁跨越 await。

use kcode_bridge::{
    InboundReceiver, Incoming, JsonlTransport, RequestId, SpawnConfig,
};
use kcode_domain::{
    event_kind, Approval, ApprovalDecision, ApprovalScope, AuditEntry, EventLog, EventRecord,
    Item, ItemStatus, Projector, Result as DomainResult, TurnStatus, TurnStatus as TS,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{broadcast, mpsc, oneshot};

/// 前端可见的领域事件。
///
/// UI 唯一的状态来源——**不暴露任何官方 wire type**。协议字段变化只影响本层投影，
/// 不会穿透到前端。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum AppEvent {
    #[serde(rename_all = "camelCase")]
    ThreadStarted {
        thread_id: String,
        cwd: String,
    },
    #[serde(rename_all = "camelCase")]
    TurnStarted {
        thread_id: String,
        turn_id: String,
    },
    /// 终端输出增量（来自 `command/exec/outputDelta`）。
    ///
    /// 与 Item 流式分开：终端是用户自己发起的命令，生命周期不挂在
    /// 任何线程/轮次上，混进 item 流会让它被线程切换清掉。
    #[serde(rename_all = "camelCase")]
    TerminalDelta {
        process_id: String,
        /// 已解码的文本（协议的 deltaBase64 在这里解掉，前端不碰 base64）。
        text: String,
        /// 该流是否因超出上限被截断（协议只在最后一帧置位）。
        cap_reached: bool,
    },
    /// 终端进程退出。
    #[serde(rename_all = "camelCase")]
    TerminalExited {
        process_id: String,
        exit_code: Option<i32>,
    },
    /// Item 增量，upsert 语义（同一 id 的后续事件覆盖先前状态）。
    ///
    /// `completed` 是关键字段：实测协议顺序为
    /// `item/started` → N 条流式 delta → `item/completed`，
    /// 且**只有 completed 才带完整文本**。
    /// 前端据此决定何时清空流式缓冲——若在 started 就清，
    /// 随后的增量会全部丢失（这是一个实际踩过的错误）。
    #[serde(rename_all = "camelCase")]
    ItemUpserted {
        thread_id: String,
        turn_id: String,
        item: Item,
        completed: bool,
    },
    /// 需要用户决策。**UI 必须响应，否则 Turn 永久挂起。**
    #[serde(rename_all = "camelCase")]
    ApprovalRequired {
        approval: Approval,
    },
    /// 审批已被解决（本端或其他客户端应答、或服务端超时）。
    ///
    /// 对应协议 `serverRequest/resolved`。多窗口场景靠它收敛状态，
    /// 否则某个窗口会一直显示「等待审批」。
    #[serde(rename_all = "camelCase")]
    ApprovalResolved {
        request_id: String,
        thread_id: String,
    },
    #[serde(rename_all = "camelCase")]
    TurnCompleted {
        thread_id: String,
        turn_id: String,
        status: TurnStatus,
        /// 该轮耗时（毫秒）。协议 `Turn.durationMs` 原样带出，未知时为 None。
        ///
        /// **由协议给出而不是本地计时**：本地从 `turn/started` 起算会把网络
        /// 往返与排队时间也算进去，而用户想知道的是「这轮实际工作了多久」。
        ///
        /// 单位陷阱：协议里 `startedAt` / `completedAt` 是**秒**，只有
        /// `durationMs` 是毫秒——两者混用会差 1000 倍。
        #[serde(default)]
        duration_ms: Option<i64>,
    },
    #[serde(rename_all = "camelCase")]
    OutputDelta {
        thread_id: String,
        item_id: String,
        delta: String,
    },
    /// **模型输出的流式增量**（正文 / 推理 / 计划）。
    ///
    /// 不处理这些通知的后果：回复以整块形式在轮次末尾突然出现，
    /// 用户看不到「正在生成」的过程——这是与成熟客户端最直观的体感差异。
    #[serde(rename_all = "camelCase")]
    TextDelta {
        thread_id: String,
        item_id: String,
        turn_id: String,
        channel: TextChannel,
        delta: String,
    },
    /// 文件变更集更新（含逐文件 diff）。
    ///
    /// `origin` 区分**已提议**（审批中，未落盘）与**已应用**（已写入工作区）——
    /// 二者混用会让用户拒绝后仍看到「已变更」。
    #[serde(rename_all = "camelCase")]
    ChangeSetUpdated {
        thread_id: String,
        turn_id: String,
        change_set: kcode_domain::ChangeSet,
    },
    /// 整轮统一 diff 更新（含 `diff --git` 与文件头）。
    ///
    /// `perFile` 是按文件切分后的结果：整轮 diff 是**多个 `diff --git`
    /// 段落首尾相接**，直接解析会把多个文件的行混在一起。逐文件展示
    /// 必须用切分结果。
    #[serde(rename_all = "camelCase")]
    TurnDiffUpdated {
        thread_id: String,
        turn_id: String,
        parsed: kcode_domain::ParsedDiff,
        per_file: Vec<kcode_domain::FileDiffSlice>,
    },
    #[serde(rename_all = "camelCase")]
    Error {
        message: String,
    },
    /// **护栏警告**（协议 `guardianWarning`）。
    ///
    /// 上游的循环/异常检测触发时推给我们。丢掉它的后果最严重：
    /// 模型正在原地打转、上游已经判定异常，而界面上什么都不显示——
    /// 用户只能看着它一直转下去，既不知道发生了什么，也没有依据决定
    /// 是否该中断。**这条通知是「上游刹车已介入」的唯一可见信号。**
    #[serde(rename_all = "camelCase")]
    GuardianWarning {
        thread_id: String,
        message: String,
    },
    /// 线程 token 用量更新（协议 `thread/tokenUsage/updated`）。
    ///
    /// 提供上下文余量的唯一数据来源。没有它，「接近上限」这件事
    /// 对用户完全不可见——直到某轮突然失败。
    #[serde(rename_all = "camelCase")]
    TokenUsageUpdated {
        thread_id: String,
        turn_id: String,
        usage: ThreadTokenUsage,
    },
    /// 子进程退出。活动轮次须标记为 unknown，**绝不静默当作成功或失败**。
    #[serde(rename_all = "camelCase")]
    ProcessExited {
        code: Option<i32>,
    },
}

/// 单次计量的 token 明细（协议 `TokenUsageBreakdown`）。
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsageBreakdown {
    pub input_tokens: i64,
    #[serde(default)]
    pub cached_input_tokens: i64,
    pub output_tokens: i64,
    #[serde(default)]
    pub reasoning_output_tokens: i64,
    pub total_tokens: i64,
}

/// 线程级 token 用量（协议 `ThreadTokenUsage`）。
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadTokenUsage {
    /// 最近一轮的用量——**上下文占用按它估算**（见前端 `contextRemaining`）。
    pub last: TokenUsageBreakdown,
    /// 线程累计用量（跨轮累加）。用于回答「这个任务一共花了多少」。
    pub total: TokenUsageBreakdown,
    /// 模型上下文窗口大小。协议可能不给，此时无法算余量。
    ///
    /// 缺失时**显式序列化为 `null`**（不跳过字段）：漏字段在 TS 侧是
    /// `undefined`，与 `null` 不是一回事，容易在 `??` 之外的地方踩空。
    #[serde(default)]
    pub model_context_window: Option<i64>,
}

/// 模糊文件搜索命中的一条结果（协议 `fuzzyFileSearch`）。
///
/// 用于输入框的 `@` 引用：模型看不到工作区，用户必须能把具体文件
/// 指给它，而手打路径既慢又容易错。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMatch {
    pub path: String,
    /// 文件名（不含目录），UI 主行显示它。
    pub file_name: String,
    /// `"file"` 或 `"directory"`——目录要显示成可继续深入的形态。
    pub match_type: String,
    /// 匹配得分（越大越相关）。服务端已排序，这里原样透传供 UI 兜底。
    pub score: u32,
    /// 命中字符在文件名中的下标。UI 可选地高亮它们。
    #[serde(default)]
    pub indices: Vec<u32>,
}

/// 一个可用技能（来自 `skills/list`）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    pub name: String,
    pub description: String,
    pub path: String,
    /// `user` 或 `repo`——决定它是全局技能还是项目内技能。
    pub scope: String,
    pub enabled: bool,
}

/// 一个可用插件（来自 `plugin/list`）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    pub id: String,
    pub name: String,
    pub marketplace: String,
    pub installed: bool,
    pub enabled: bool,
    pub description: Option<String>,
}

/// 可选模型。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOption {
    pub id: String,
    pub display_name: String,
    pub is_default: bool,
    /// 支持的推理强度档位（若 provider 给出）。
    pub reasoning_efforts: Vec<String>,
    pub default_effort: Option<String>,
}

/// 审批与沙箱的档位组合，对应 Codex 权限下拉里的三档。
///
/// **为什么把两者绑成一档而不是分开选**：协议里 `sandbox` 与
/// `approvalPolicy` 是两个独立参数，但只有特定的组合才有实际意义——
/// 单独把 sandbox 设成 `danger-full-access` 而审批仍是严格模式，
/// 或者反过来，都会产生用户无法从界面预判的行为。Codex 的界面
/// 同样只给三档，这里与它对齐。
///
/// 三档的语义（来自实测与协议文档）：
/// - `ReadOnly`：可读任意文件，改动与联网都要审批。最保守。
/// - `WorkspaceWrite`：工作区内可自由写入，越界与联网需审批。默认。
/// - `FullAccess`：不受限制地访问网络与文件。**危险**。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionMode {
    ReadOnly,
    WorkspaceWrite,
    FullAccess,
}

impl PermissionMode {
    /// 协议里的 `sandbox` 取值（v2 的 SandboxMode 枚举）。
    pub fn sandbox(self) -> &'static str {
        match self {
            Self::ReadOnly => "read-only",
            Self::WorkspaceWrite => "workspace-write",
            Self::FullAccess => "danger-full-access",
        }
    }

    /// 协议里的 `approvalPolicy` 取值。
    ///
    /// 注意是 `"on-request"`（连字符），不是 camelCase 的 `onRequest`——
    /// 实测该枚举的取值就是带连字符的字面量。
    pub fn approval_policy(self) -> &'static str {
        match self {
            Self::ReadOnly | Self::WorkspaceWrite => "on-request",
            Self::FullAccess => "never",
        }
    }

    /// 从 `permissionProfile/list` 返回的 profile id 还原。
    ///
    /// id 形如 `":read-only"` / `":workspace"` / `":danger-full-access"`
    /// （带冒号前缀，且 workspace 档的名字与 SandboxMode 不一致——
    /// 实测如此，不能想当然地按 SandboxMode 去匹配）。
    pub fn from_profile_id(id: &str) -> Option<Self> {
        let bare = id.trim_start_matches(':');
        match bare {
            "read-only" => Some(Self::ReadOnly),
            "workspace" | "workspace-write" => Some(Self::WorkspaceWrite),
            "danger-full-access" => Some(Self::FullAccess),
            _ => None,
        }
    }
}

/// 目录项（工作台「文件」用）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub is_directory: bool,
    pub is_file: bool,
}

/// 终端命令的启动结果。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecStarted {
    pub process_id: String,
    /// 输出是否已被服务端截断上限保护（提示用户「输出太多」）。
    pub output_capped: bool,
}

/// 一个可选的权限档位（来自 `permissionProfile/list`）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionProfile {
    /// 协议返回的原始 id，原样回传用于切换。
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    /// 当前生效的 requirements 是否允许选择该档位。
    ///
    /// 为 false 时 UI 必须置灰——**不能让它看起来能点**。
    pub allowed: bool,
    /// 对应的档位；无法识别时为 None（UI 只展示不提供切换）。
    pub mode: Option<PermissionMode>,
}

/// 当前设置快照，供设置界面展示。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSnapshot {
    /// 当前权限档位（由 config 的 sandbox_mode 推导）。
    pub mode: PermissionMode,
    /// config 里的模型与 provider 名。
    pub model: Option<String>,
    pub model_provider: Option<String>,
    /// 已配置的 provider 名列表（config 的 `model_providers` 表的键）。
    pub providers: Vec<String>,
    /// 可用档位及其 allowed 状态。
    pub profiles: Vec<PermissionProfile>,
    /// 配置文件路径（用户需要知道改动写到了哪里）。
    pub config_path: Option<String>,
}

/// 流式文本的通道。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TextChannel {
    /// 模型给用户的正文（`item/agentMessage/delta`）。
    AgentMessage,
    /// 推理正文（`item/reasoning/textDelta`）。
    Reasoning,
    /// 推理摘要（`item/reasoning/summaryTextDelta`）。
    ReasoningSummary,
    /// 计划（`item/plan/delta`）。
    Plan,
}

enum Command {
    StartThread {
        cwd: String,
        model: Option<String>,
        sandbox: String,
        approval_policy: Value,
        reply: oneshot::Sender<Result<ThreadInfo, String>>,
    },
    SendTurn {
        thread_id: String,
        text: String,
        model: Option<String>,
        effort: Option<String>,
        /// 附加的本地图片绝对路径（协议 `localImage`）。
        images: Vec<String>,
        reply: oneshot::Sender<Result<String, String>>,
    },
    Steer {
        thread_id: String,
        turn_id: String,
        text: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Interrupt {
        thread_id: String,
        turn_id: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    ResolveApproval {
        request_id: String,
        decision: ApprovalDecision,
        scope: Option<ApprovalScope>,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// 重命名线程（协议 `thread/name/set`）。
    SetThreadName {
        thread_id: String,
        name: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// 归档 / 取消归档线程（协议 `thread/archive` 与 `thread/unarchive`）。
    ArchiveThread {
        thread_id: String,
        archived: bool,
        reply: oneshot::Sender<Result<(), String>>,
    },
    ExportAudit {
        reply: oneshot::Sender<Result<String, String>>,
    },
    /// 从事件日志枚举历史线程（应用启动时填充侧栏）。
    ListThreads {
        reply: oneshot::Sender<Result<Vec<ThreadSummary>, String>>,
    },
    /// 从事件日志重建单个线程（打开线程时调用）。
    LoadThread {
        thread_id: String,
        reply: oneshot::Sender<Result<ThreadSnapshot, String>>,
    },
    /// 列出可用模型（来自当前 provider）。
    ListModels {
        reply: oneshot::Sender<Result<Vec<ModelOption>, String>>,
    },
    /// 列出线程（可按关键词搜索）。
    ///
    /// **走服务端而非只读本地日志**：`thread/list` 支持 `searchTerm`，
    /// 且能返回本机其它入口创建的线程（CLI、IDE 扩展）——只读我们
    /// 自己的事件日志会漏掉它们。
    ListThreadsRemote {
        search_term: Option<String>,
        reply: oneshot::Sender<Result<Vec<ThreadSummary>, String>>,
    },
    /// 列出当前工作区可见的技能。
    ListSkills {
        cwd: String,
        reply: oneshot::Sender<Result<Vec<SkillInfo>, String>>,
    },
    /// 模糊搜索工作区文件（协议 `fuzzyFileSearch`），供输入框 `@` 引用。
    FuzzySearchFiles {
        cwd: String,
        query: String,
        reply: oneshot::Sender<Result<Vec<FileMatch>, String>>,
    },
    /// 触发上下文压缩（协议 `thread/compact/start`）。
    CompactThread {
        thread_id: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// 列出插件市场与已安装插件。
    ListPlugins {
        reply: oneshot::Sender<Result<Vec<PluginInfo>, String>>,
    },
    /// 读取当前设置（config + 权限档位）。
    ReadSettings {
        reply: oneshot::Sender<Result<SettingsSnapshot, String>>,
    },
    /// 持久化权限档位到 config.toml。
    SetPermissionMode {
        mode: PermissionMode,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// 列出目录的直接子项（工作台「文件」用）。
    ReadDirectory {
        path: String,
        reply: oneshot::Sender<Result<Vec<DirEntry>, String>>,
    },
    /// 启动一个终端命令（工作台「终端」用）。输出经
    /// `AppEvent::TerminalDelta` 流式推送。
    ExecStart {
        process_id: String,
        command: Vec<String>,
        cwd: Option<String>,
        reply: oneshot::Sender<Result<ExecStarted, String>>,
    },
    /// 向运行中的终端进程写 stdin。
    ExecWrite {
        process_id: String,
        data: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// 终止终端进程。
    ExecTerminate {
        process_id: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// 记录用户对某个变更文件的接受/拒绝决策。
    ///
    /// **必须持久化**：只存内存的后果是刷新即丢，用户会以为自己
    /// 的审阅结论从未被记录——而审阅是本产品的核心承诺之一。
    DecideFile {
        thread_id: String,
        turn_id: String,
        path: String,
        decision: kcode_domain::FileDecision,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Shutdown,
}

/// 事件日志的互斥包装：
/// `rusqlite::Connection` 是 `Send` 但不是 `Sync`（内部含 `RefCell`），
/// 因此必须先包一层互斥才能跨 await 传递引用。
type LogMutex = tokio::sync::Mutex<EventLog>;

/// 从事件日志重建的线程概要（应用启动时用于填充侧栏）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSummary {
    pub thread_id: String,
    pub cwd: String,
    /// 线程创建时间（毫秒）。
    pub created_at_ms: i64,
    /// 最后一条事件的时间（用于「最近活动」排序）。
    pub last_event_ms: i64,
    pub item_count: usize,
    pub turn_count: usize,
    /// 是否存在未完成的轮次（崩溃残留）。
    ///
    /// 有值时应由 UI 提示「该轮次结果未知」，而**不是**当作成功或失败。
    pub has_unfinished_turn: bool,
    /// 服务端给出的首条消息摘要（`thread/list` 的 `preview`）。
    ///
    /// 比从事件日志派生更准：本地日志可能只有部分历史。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    /// 用户或系统给线程起的名字。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

/// 单轮次的快照状态。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnSnapshot {
    pub turn_id: String,
    pub status: TurnStatus,
    /// 该轮耗时（毫秒）。从 `turn_completed` 事件载荷里的 `turn.durationMs` 取。
    ///
    /// **必须重建**：整轮耗时只在 `turn/completed` 那一帧的载荷里出现一次，
    /// 不从这里带出来的话，应用重启后所有历史轮次的耗时就永久丢失了。
    #[serde(default)]
    pub duration_ms: Option<i64>,
}

/// 从事件日志重建的完整线程快照。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSnapshot {
    pub thread_id: String,
    pub cwd: String,
    pub turns: Vec<TurnSnapshot>,
    pub items: Vec<Item>,
    /// 各轮次的变更集（含已持久化的用户决策）。
    ///
    /// 不重建它的后果：重启后 Diff 审阅面板是空的，用户会以为自己
    /// 之前的审阅结论没被记录。
    pub change_sets: Vec<kcode_domain::ChangeSet>,
    /// 重建过程中的问题（如无法反序列化的历史载荷）。
    ///
    /// **不静默丢弃**——历史不完整时必须让用户知道，否则他会以为
    /// 这就是全部记录。
    pub warnings: Vec<String>,
}

/// 线程对外摘要。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadInfo {
    pub thread_id: String,
    pub cwd: String,
    pub model: Option<String>,
    pub sandbox: Option<Value>,
    pub approval_policy: Option<Value>,
}

/// 服务句柄，可克隆。
#[derive(Clone)]
pub struct AgentService {
    tx: mpsc::UnboundedSender<Command>,
    events: broadcast::Sender<AppEvent>,
    /// app-server 子进程 PID。
    pid: Option<u32>,
    /// 事件日志路径。
    log_path: std::path::PathBuf,
}

pub struct ServiceConfig {
    pub spawn: SpawnConfig,
    pub client_name: String,
    pub client_title: String,
    pub client_version: String,
}

impl AgentService {
    /// 启动服务：拉起 app-server、握手、打开事件日志、启动 owner 循环。
    pub async fn start(cfg: ServiceConfig) -> Result<Self, String> {
        let mut transport = JsonlTransport::spawn(&cfg.spawn)
            .await
            .map_err(|e| format!("启动 app-server 失败: {e}"))?;

        transport
            .initialize(
                &cfg.client_name,
                &cfg.client_title,
                &cfg.client_version,
                Some(cfg.spawn.codex_home.as_path()),
            )
            .await
            .map_err(|e| format!("握手失败: {e}"))?;

        // 用 tokio::Mutex 包裹：rusqlite::Connection 是 Send 但不是 Sync
        // （内部有 RefCell），因此 &EventLog 无法跨 await 传递——owner_loop 的
        // future 会不再 Send。Mutex<EventLog> 在 T: Send 时是 Sync。
        // 同步 DB 调用本就不该裸放在 async 上下文里，加锁同时也把它收敛到了一处。
        let log_path = cfg.spawn.codex_home.join("kcode-events.db");
        let log = Arc::new(tokio::sync::Mutex::new(
            EventLog::open(&log_path).map_err(|e| format!("打开事件日志失败: {e}"))?,
        ));
        let projector = Projector::new(cfg.spawn.cwd.clone());

        let inbound = transport
            .take_inbound()
            .ok_or_else(|| "读侧已被取出".to_owned())?;

        let pid = transport.pid();

        let (tx, rx) = mpsc::unbounded_channel();
        let (events, _) = broadcast::channel(1024);
        let events_for_loop = events.clone();

        tokio::spawn(owner_loop(
            transport,
            inbound,
            rx,
            events_for_loop,
            log,
            projector,
            cfg.spawn.codex_home.clone(),
            cfg.spawn.cwd.clone(),
        ));

        Ok(Self { tx, events, pid, log_path })
    }

    pub fn subscribe(&self) -> broadcast::Receiver<AppEvent> {
        self.events.subscribe()
    }

    /// app-server 子进程 PID（用于验收测试模拟崩溃）。
    pub fn pid(&self) -> Option<u32> {
        self.pid
    }

    /// 事件日志路径（崩溃恢复验收需在重启后读取同一份日志）。
    pub fn event_log_path(&self) -> std::path::PathBuf {
        self.log_path.clone()
    }

    async fn call<T>(
        &self,
        build: impl FnOnce(oneshot::Sender<Result<T, String>>) -> Command,
    ) -> Result<T, String> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(build(reply))
            .map_err(|_| "服务已停止".to_owned())?;
        rx.await.map_err(|_| "服务未响应".to_owned())?
    }

    pub async fn start_thread(
        &self,
        cwd: impl Into<String>,
        model: Option<String>,
        sandbox: impl Into<String>,
        approval_policy: Value,
    ) -> Result<ThreadInfo, String> {
        let (cwd, sandbox) = (cwd.into(), sandbox.into());
        self.call(|reply| Command::StartThread { cwd, model, sandbox, approval_policy, reply })
            .await
    }

    pub async fn send_turn(
        &self,
        thread_id: impl Into<String>,
        text: impl Into<String>,
    ) -> Result<String, String> {
        self.send_turn_with(thread_id, text, None, None).await
    }

    /// 提交轮次，可指定模型与推理强度覆盖。
    pub async fn send_turn_with(
        &self,
        thread_id: impl Into<String>,
        text: impl Into<String>,
        model: Option<String>,
        effort: Option<String>,
    ) -> Result<String, String> {
        self.send_turn_full(thread_id, text, model, effort, Vec::new()).await
    }

    /// 提交轮次，并附带本地图片作为上下文（协议 `localImage`）。
    ///
    /// 图片以**路径**而非字节传输：协议提供 `localImage`（本地路径）与
    /// `image`（URL）两种，没有内嵌 base64 的形式。因此前端贴图后要先落盘，
    /// 这里只转发路径——好处是不必把图片塞进 JSON-RPC 报文（大图会让
    /// 单条消息几十 MB，读写都变慢）。
    pub async fn send_turn_full(
        &self,
        thread_id: impl Into<String>,
        text: impl Into<String>,
        model: Option<String>,
        effort: Option<String>,
        images: Vec<String>,
    ) -> Result<String, String> {
        let (thread_id, text) = (thread_id.into(), text.into());
        self.call(|reply| Command::SendTurn { thread_id, text, model, effort, images, reply })
            .await
    }

    pub async fn steer(
        &self,
        thread_id: impl Into<String>,
        turn_id: impl Into<String>,
        text: impl Into<String>,
    ) -> Result<(), String> {
        let (thread_id, turn_id, text) = (thread_id.into(), turn_id.into(), text.into());
        self.call(|reply| Command::Steer { thread_id, turn_id, text, reply }).await
    }

    pub async fn interrupt(
        &self,
        thread_id: impl Into<String>,
        turn_id: impl Into<String>,
    ) -> Result<(), String> {
        let (thread_id, turn_id) = (thread_id.into(), turn_id.into());
        self.call(|reply| Command::Interrupt { thread_id, turn_id, reply }).await
    }

    /// 回应用户决策。
    ///
    /// `request_id` 用 [`request_id_key`] 生成。最终发出的是对该协议请求 id 的
    /// 普通 JSON-RPC 响应——**协议里没有 `approval/resolve` 方法**。
    pub async fn resolve_approval(
        &self,
        request_id: impl Into<String>,
        decision: ApprovalDecision,
        scope: Option<ApprovalScope>,
    ) -> Result<(), String> {
        let request_id = request_id.into();
        self.call(|reply| Command::ResolveApproval { request_id, decision, scope, reply })
            .await
    }

    /// 重命名线程（协议 `thread/name/set`）。
    ///
    /// 名字由服务端持久化——本地改完不写回服务端，重启后就消失。
    pub async fn set_thread_name(
        &self,
        thread_id: impl Into<String>,
        name: impl Into<String>,
    ) -> Result<(), String> {
        let (thread_id, name) = (thread_id.into(), name.into());
        self.call(|reply| Command::SetThreadName { thread_id, name, reply }).await
    }

    /// 归档或取消归档线程（协议 `thread/archive` / `thread/unarchive`）。
    ///
    /// 归档不是删除：线程仍可用 `thread/list` 找回（协议二者区分）。
    pub async fn archive_thread(
        &self,
        thread_id: impl Into<String>,
        archived: bool,
    ) -> Result<(), String> {
        let thread_id = thread_id.into();
        self.call(|reply| Command::ArchiveThread { thread_id, archived, reply }).await
    }

    pub async fn export_audit(&self) -> Result<String, String> {
        self.call(|reply| Command::ExportAudit { reply }).await
    }

    /// 枚举历史线程。
    ///
    /// **这是「可恢复」在 UI 上成立的前提**：进程内状态在重启后消失，
    /// 而事件日志不会——前端启动时必须调用本方法才能看到既有线程。
    pub async fn list_threads(&self) -> Result<Vec<ThreadSummary>, String> {
        self.call(|reply| Command::ListThreads { reply }).await
    }

    /// 列出线程，可按关键词过滤（服务端搜索）。
    ///
    /// **走服务端而非只读本地日志**：`thread/list` 支持 `searchTerm`，
    /// 且能返回本机其它入口创建的线程（CLI、IDE 扩展）——只读我们自己的
    /// 事件日志会漏掉它们。
    pub async fn list_threads_remote(
        &self,
        search_term: Option<String>,
    ) -> Result<Vec<ThreadSummary>, String> {
        self.call(|reply| Command::ListThreadsRemote { search_term, reply }).await
    }

    /// 列出当前工作区可见的技能（`skills/list`）。
    ///
    /// 必须传工作区：技能分 user 与 repo 两个作用域，后者依赖 cwd 才能发现。
    pub async fn list_skills(&self, cwd: impl Into<String>) -> Result<Vec<SkillInfo>, String> {
        let cwd = cwd.into();
        self.call(|reply| Command::ListSkills { cwd, reply }).await
    }

    /// 列出插件市场与已安装插件（`plugin/list`）。
    pub async fn list_plugins(&self) -> Result<Vec<PluginInfo>, String> {
        self.call(|reply| Command::ListPlugins { reply }).await
    }

    /// 模糊搜索工作区文件（`fuzzyFileSearch`）。
    ///
    /// `roots` 取工作区本身：让服务端在沙箱边界内搜索，而不是让前端
    /// 自己遍历——后者会绕过沙箱配置，也会把大目录拖进 UI 线程。
    pub async fn fuzzy_search_files(
        &self,
        cwd: impl Into<String>,
        query: impl Into<String>,
    ) -> Result<Vec<FileMatch>, String> {
        let (cwd, query) = (cwd.into(), query.into());
        self.call(|reply| Command::FuzzySearchFiles { cwd, query, reply }).await
    }

    /// 请求压缩该线程的上下文（`thread/compact/start`）。
    ///
    /// 压缩由服务端执行，我们只负责发起；完成情况通过事件流回传。
    pub async fn compact_thread(&self, thread_id: impl Into<String>) -> Result<(), String> {
        let thread_id = thread_id.into();
        self.call(|reply| Command::CompactThread { thread_id, reply }).await
    }

    /// 重建单个线程的时间线与轮次状态。
    pub async fn load_thread(&self, thread_id: impl Into<String>) -> Result<ThreadSnapshot, String> {
        let thread_id = thread_id.into();
        self.call(|reply| Command::LoadThread { thread_id, reply }).await
    }

    /// 记录文件级审阅决策（持久化到事件日志）。
    pub async fn decide_file(
        &self,
        thread_id: impl Into<String>,
        turn_id: impl Into<String>,
        path: impl Into<String>,
        decision: kcode_domain::FileDecision,
    ) -> Result<(), String> {
        let (thread_id, turn_id, path) = (thread_id.into(), turn_id.into(), path.into());
        self.call(|reply| Command::DecideFile { thread_id, turn_id, path, decision, reply })
            .await
    }

    /// 列出当前 provider 实际可用的模型。
    ///
    /// **由 app-server 回答而非硬编码**：模型集合取决于 provider 与登录方式，
    /// 硬编码一份列表在切换 provider 后必然过期。
    pub async fn list_models(&self) -> Result<Vec<ModelOption>, String> {
        self.call(|reply| Command::ListModels { reply }).await
    }

    /// 读取当前设置（config + 权限档位）。
    pub async fn read_settings(&self) -> Result<SettingsSnapshot, String> {
        self.call(|reply| Command::ReadSettings { reply }).await
    }

    /// 持久化权限档位。写入 config.toml，对所有新线程生效。
    pub async fn set_permission_mode(&self, mode: PermissionMode) -> Result<(), String> {
        self.call(|reply| Command::SetPermissionMode { mode, reply }).await
    }

    /// 列出目录的直接子项（工作台「文件」）。
    pub async fn read_directory(&self, path: impl Into<String>) -> Result<Vec<DirEntry>, String> {
        let path = path.into();
        self.call(|reply| Command::ReadDirectory { path, reply }).await
    }

    /// 启动终端命令。输出经事件通道流式推送。
    pub async fn exec_start(
        &self,
        process_id: impl Into<String>,
        command: Vec<String>,
        cwd: Option<String>,
    ) -> Result<ExecStarted, String> {
        let process_id = process_id.into();
        self.call(|reply| Command::ExecStart { process_id, command, cwd, reply })
            .await
    }

    pub async fn exec_write(
        &self,
        process_id: impl Into<String>,
        data: impl Into<String>,
    ) -> Result<(), String> {
        let (process_id, data) = (process_id.into(), data.into());
        self.call(|reply| Command::ExecWrite { process_id, data, reply }).await
    }

    pub async fn exec_terminate(&self, process_id: impl Into<String>) -> Result<(), String> {
        let process_id = process_id.into();
        self.call(|reply| Command::ExecTerminate { process_id, reply }).await
    }

    /// 请求停机。owner 循环会终止子进程并广播 `ProcessExited`。
    pub fn shutdown(&self) {
        let _ = self.tx.send(Command::Shutdown);
    }
}

/// 读取设置：config + 权限档位。
///
/// 传 `cwd` 会额外解析项目层配置（settings.json 之类），这对本项目是
/// 正确的——我们正是想知道「在这个工作区里实际生效的设置是什么」。
///
/// **config.toml 非法时 `config/read` 会整体失败**（-32603），此时这里
/// 返回 Err 而不是退化成默认值。不能静默：界面显示一套并不生效的默认
/// 权限档位，比显示读取失败危险得多——用户会据此判断 Agent 的行为边界。
/// 该错误由 `read_settings` 的调用方（前端）呈现给用户。
async fn read_settings(
    transport: &mut JsonlTransport,
    codex_home: &std::path::Path,
    cwd: &std::path::Path,
) -> Result<SettingsSnapshot, String> {
    let cfg = transport
        .request("config/read", json!({ "cwd": cwd }))
        .await
        .map_err(|e| format!("读取配置失败：{e}"))?
        .get("config")
        .cloned()
        .unwrap_or(Value::Null);

    let model = cfg.get("model").and_then(Value::as_str).map(str::to_owned);
    let model_provider = cfg
        .get("model_provider")
        .and_then(Value::as_str)
        .map(str::to_owned);

    // provider 名列表：`model_providers` 是 config 里的未类型化表
    // （schema 里 Config 是 additionalProperties: true）
    let providers: Vec<String> = cfg
        .get("model_providers")
        .and_then(Value::as_object)
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default();

    // 当前档位由 sandbox_mode 推导；它是 null 时用工作区可写（后端默认）
    let mode = cfg
        .get("sandbox_mode")
        .and_then(Value::as_str)
        .and_then(|s| match s {
            "read-only" => Some(PermissionMode::ReadOnly),
            "workspace-write" => Some(PermissionMode::WorkspaceWrite),
            "danger-full-access" => Some(PermissionMode::FullAccess),
            _ => None,
        })
        .unwrap_or(PermissionMode::WorkspaceWrite);

    let profiles = match transport.request("permissionProfile/list", json!({})).await {
        Ok(v) => v
            .get("data")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|p| {
                        let id = p.get("id").and_then(Value::as_str)?.to_owned();
                        let mode = PermissionMode::from_profile_id(&id);
                        // 名字缺省时用档位的中文名，避免界面出现 ":workspace" 这种原始 id
                        let name = p
                            .get("description")
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                            .unwrap_or_else(|| match mode {
                                Some(PermissionMode::ReadOnly) => "只读".to_owned(),
                                Some(PermissionMode::WorkspaceWrite) => "工作区可写".to_owned(),
                                Some(PermissionMode::FullAccess) => "完全访问".to_owned(),
                                None => id.clone(),
                            });
                        Some(PermissionProfile {
                            id,
                            name,
                            description: None,
                            allowed: p.get("allowed").and_then(Value::as_bool).unwrap_or(false),
                            mode,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default(),
        // 权限档位列表拿不到不该让整个设置页失败——config 部分仍然可用
        Err(_) => Vec::new(),
    };

    Ok(SettingsSnapshot {
        mode,
        model,
        model_provider,
        providers,
        profiles,
        // 配置文件路径按约定推导（app-server 的 config.toml 就在 CODEX_HOME 下）。
        // 不向协议索取：实测 config/read 的 origins 是空对象，读不到来源路径；
        // 而写入响应里的 filePath 只有写的时候才有。展示给用户是为了让他
        // 能自己去核对，所以宁可给约定值也不要留空。
        config_path: Some(
            codex_home
                .join("config.toml")
                .to_string_lossy()
                .into_owned(),
        ),
    })
}

/// 把权限档位写入 config.toml。
///
/// 走 `config/value/write` 而不是自己改文件：该接口**会先校验整份配置**
/// 再落盘，任何一处非法都会整体拒绝且文件不变（实测）。自己改文件
/// 则可能写出一份 app-server 拒绝加载的配置，用户下次启动直接失败。
///
/// 写两个键：`sandbox_mode` 与 `approval_policy`。两者必须同时写——
/// 只改一个是本项目界面上出现过的问题：档位显示变了但实际审批行为没变。
async fn write_permission_mode(
    transport: &mut JsonlTransport,
    mode: PermissionMode,
) -> Result<(), String> {
    for (key, value) in [
        ("sandbox_mode", json!(mode.sandbox())),
        ("approval_policy", json!(mode.approval_policy())),
    ] {
        let res = transport
            .request(
                "config/value/write",
                json!({ "keyPath": key, "mergeStrategy": "replace", "value": value }),
            )
            .await
            .map_err(|e| format!("写入 {key} 失败：{e}"))?;
        // 协议以 success 字段或 error 对象表达失败，两者都要判
        if res.get("error").is_some() {
            let msg = res
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("配置校验未通过");
            return Err(format!("写入 {key} 被拒绝：{msg}"));
        }
    }
    Ok(())
}

/// 把协议层请求 id 转成前端可传递的字符串键。
///
/// 数值与字符串加前缀区分，避免 `1` 与 `"1"` 相撞。
pub fn request_id_key(id: &RequestId) -> String {
    id.key()
}

/// 从字符串键还原协议层 id，用于原样回传。
pub fn request_id_from_key(key: &str) -> RequestId {
    match key.split_once(':') {
        Some(("n", n)) => RequestId::Num(n.parse().unwrap_or(0)),
        Some(("s", s)) => RequestId::Str(s.to_owned()),
        _ => RequestId::Str(key.to_owned()),
    }
}

/// owner 循环：独占 transport，交替处理命令与事件。
///
/// 参数多是有意的：每一项都是 actor 拥有的**独占**资源（transport、两条消息
/// 通道、事件广播、日志、投影器、两个路径）。打包成结构体只是把同样的字段
/// 换个地方写，反而掩盖了「它们被同一个循环独占」这件事。
#[allow(clippy::too_many_arguments)]
async fn owner_loop(
    mut transport: JsonlTransport,
    mut inbound: InboundReceiver,
    mut rx: mpsc::UnboundedReceiver<Command>,
    events: broadcast::Sender<AppEvent>,
    log: Arc<LogMutex>,
    projector: Projector,
    codex_home: std::path::PathBuf,
    workspace: std::path::PathBuf,
) {
    // 待决审批：request_id 键 → (方法名, Approval)
    let mut pending: HashMap<String, (String, Approval)> = HashMap::new();

    loop {
        tokio::select! {
            // 分支一：新命令。处理期间事件会积压在无界通道里，稍后消费。
            cmd = rx.recv() => match cmd {
                None | Some(Command::Shutdown) => {
                    transport.shutdown().await.ok();
                    let _ = events.send(AppEvent::ProcessExited { code: None });
                    break;
                }
                Some(c) => {
                    handle_command(c, &mut transport, &log, &mut pending, &events, &codex_home, &workspace)
                        .await;
                }
            },

            // 分支二：新事件。通道关闭即子进程已退出——必须显式告知前端，
            // 让活动轮次被标记为 unknown。
            ev = inbound.recv() => match ev {
                None => {
                    let _ = events.send(AppEvent::ProcessExited { code: None });
                    break;
                }
                Some(ev) => {
                    handle_incoming(ev, &projector, &log, &events, &mut pending).await;
                }
            },
        }
    }
}

async fn handle_command(
    cmd: Command,
    transport: &mut JsonlTransport,
    log: &Arc<LogMutex>,
    pending: &mut HashMap<String, (String, Approval)>,
    events: &broadcast::Sender<AppEvent>,
    codex_home: &std::path::Path,
    workspace: &std::path::Path,
) {
    let emit = |e: AppEvent| {
        let _ = events.send(e);
    };

    match cmd {
        Command::StartThread { cwd, model, sandbox, approval_policy, reply } => {
            let params = json!({
                "cwd": cwd,
                "approvalPolicy": approval_policy,
                // 关键：thread/start 的 sandbox 是字符串枚举，
                // 而 turn/start 的 sandboxPolicy 是对象——两者形态不同。
                "sandbox": sandbox,
                "model": model,
            });
            match transport.request("thread/start", params).await {
                Ok(result) => {
                    let thread_id = result["thread"]["id"].as_str().unwrap_or_default().to_owned();
                    let info = ThreadInfo {
                        thread_id: thread_id.clone(),
                        cwd: result["cwd"].as_str().unwrap_or_default().to_owned(),
                        model: result["model"].as_str().map(str::to_owned),
                        sandbox: result.get("sandbox").cloned(),
                        approval_policy: result.get("approvalPolicy").cloned(),
                    };
                    record(log, event_kind::THREAD_STARTED, Some(&thread_id), None, None, result).await;

                    // 主动广播一次 ThreadStarted。
                    //
                    // 实测（codex 0.155.1）：app-server **也会**推送
                    // `thread/started` 通知，因此这里存在重复。
                    // 保留主动广播的理由是**消除时序依赖**：命令响应与通知
                    // 到达顺序不保证，若前端在通知到达前就依赖状态（例如
                    // 立即启用输入框），会有一个短暂的窗口不可用。
                    //
                    // 归约对同一 thread 是幂等的，重复广播无副作用。
                    let _ = events.send(AppEvent::ThreadStarted {
                        thread_id: thread_id.clone(),
                        cwd: info.cwd.clone(),
                    });
                    let _ = reply.send(Ok(info));
                }
                Err(e) => {
                    let _ = reply.send(Err(e.to_string()));
                }
            }
        }

        Command::SendTurn { thread_id, text, model, effort, images, reply } => {
            // 文本在前、图片在后：模型的阅读顺序与用户「先说事、再给材料」
            // 的顺序一致，也让纯文本轮次的报文与改动前逐字节相同。
            let mut input = vec![json!({ "type": "text", "text": text })];
            for path in &images {
                input.push(json!({ "type": "localImage", "path": path }));
            }
            let mut params = json!({
                "threadId": thread_id,
                "input": input,
            });
            // 逐轮可覆盖模型与推理强度（协议在 turn/start 上支持）
            if let Some(m) = model {
                params["model"] = json!(m);
            }
            if let Some(e) = effort {
                params["effort"] = json!(e);
            }
            match transport.request("turn/start", params).await {
                Ok(result) => {
                    // 响应只表示「轮次已被接受」，不代表完成；后续状态一律来自事件。
                    let turn_id = result["turn"]["id"].as_str().unwrap_or_default().to_owned();
                    record(log, event_kind::TURN_STARTED, Some(&thread_id), Some(&turn_id), None, result).await;
                    // 同理主动广播 TurnStarted（app-server 也会推 turn/started，
                    // 这里的目的是不等通知、立即让前端进入「运行中」状态）。
                    let _ = events.send(AppEvent::TurnStarted {
                        thread_id: thread_id.clone(),
                        turn_id: turn_id.clone(),
                    });
                    let _ = reply.send(Ok(turn_id));
                }
                Err(e) => {
                    let _ = reply.send(Err(e.to_string()));
                }
            }
        }

        Command::Steer { thread_id, turn_id, text, reply } => {
            let params = json!({
                "threadId": thread_id,
                "turnId": turn_id,
                "input": [{ "type": "text", "text": text }],
            });
            let out = transport
                .request("turn/steer", params)
                .await
                .map(|_| ())
                .map_err(|e| e.to_string());
            let _ = reply.send(out);
        }

        Command::Interrupt { thread_id, turn_id, reply } => {
            let params = json!({ "threadId": thread_id, "turnId": turn_id });
            let out = match transport.request("turn/interrupt", params).await {
                Ok(_) => Ok(()),
                // 对已结束的轮次，协议返回 -32600 "no active turn to interrupt"。
                // 这不是故障而是「轮次已结束」的正常表达——折叠为成功，
                // 调用方无需区分「刚结束」与「本来就结束」。
                Err(kcode_bridge::BridgeError::Rpc { code: -32600, .. }) => Ok(()),
                Err(e) => Err(e.to_string()),
            };
            let _ = reply.send(out);
        }

        Command::SetThreadName { thread_id, name, reply } => {
            let params = json!({ "threadId": thread_id, "name": name });
            let out = match transport.request("thread/name/set", params).await {
                Ok(_) => Ok(()),
                Err(e) => Err(e.to_string()),
            };
            let _ = reply.send(out);
        }

        Command::ArchiveThread { thread_id, archived, reply } => {
            // 归档与取消归档是两个方法名（协议未用布尔参数区分）。
            let method = if archived { "thread/archive" } else { "thread/unarchive" };
            let params = json!({ "threadId": thread_id });
            let out = match transport.request(method, params).await {
                Ok(_) => Ok(()),
                Err(e) => Err(e.to_string()),
            };
            let _ = reply.send(out);
        }

        Command::CompactThread { thread_id, reply } => {
            let params = json!({ "threadId": thread_id });
            let out = match transport.request("thread/compact/start", params).await {
                Ok(_) => Ok(()),
                Err(e) => Err(e.to_string()),
            };
            let _ = reply.send(out);
        }

        Command::FuzzySearchFiles { cwd, query, reply } => {
            let params = json!({ "query": query, "roots": [cwd] });
            let out = match transport.request("fuzzyFileSearch", params).await {
                Ok(result) => {
                    // 注意：`fuzzyFileSearch` 的字段是 **snake_case**
                    // （`file_name` / `match_type`），与协议里多数方法的
                    // camelCase 不同——实测报文如此，schema 的
                    // FuzzyFileSearchResult 定义也写作 file_name。
                    // 读成 fileName 不会报错，只会让文件名静默变空串。
                    let arr = result
                        .get("files")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                    Ok(arr
                        .iter()
                        .filter_map(|m| {
                            let path = m.get("path")?.as_str()?.to_owned();
                            Some(FileMatch {
                                path,
                                file_name: m
                                    .get("file_name")
                                    .and_then(Value::as_str)
                                    .unwrap_or_default()
                                    .to_owned(),
                                match_type: m
                                    .get("match_type")
                                    .and_then(Value::as_str)
                                    .unwrap_or("file")
                                    .to_owned(),
                                score: m.get("score").and_then(Value::as_u64).unwrap_or(0) as u32,
                                indices: m
                                    .get("indices")
                                    .and_then(Value::as_array)
                                    .map(|a| {
                                        a.iter()
                                            .filter_map(Value::as_u64)
                                            .map(|n| n as u32)
                                            .collect()
                                    })
                                    .unwrap_or_default(),
                            })
                        })
                        .collect())
                }
                Err(e) => Err(e.to_string()),
            };
            let _ = reply.send(out);
        }

        Command::ResolveApproval { request_id, decision, scope, reply } => {
            let Some((method, approval)) = pending.remove(&request_id) else {
                let _ = reply.send(Err(format!("未知的审批请求: {request_id}")));
                return;
            };

            // 响应体形态因方法而异：权限审批回填权限集，命令/文件审批回 decision。
            let body = if method == "item/permissions/requestApproval" {
                kcode_bridge::approval_response(&method, "")
            } else {
                json!({ "decision": decision.to_protocol_value() })
            };

            let proto_id = request_id_from_key(&request_id);
            match transport.respond(&proto_id, body).await {
                Ok(()) => {
                    // 审计：人工与自动都要留痕，否则事后无法回答「为什么放行了」。
                    //
                    // **写入前必须脱敏**：摘要记的是命令原文，而命令里常带密钥
                    // （`curl -H "Authorization: Bearer sk-..."`、`export AWS_SECRET_...
                    // =...`）。审计日志被设计成可导出、可分享给他人排查，
                    // 一旦原样落库，一次误操作就把凭据永久写进了可外传的产物。
                    let redacted = kcode_domain::redact(&approval.summary);
                    if !redacted.is_clean() {
                        record(
                            log,
                            "audit_redaction_applied",
                            Some(&approval.thread_id),
                            Some(&approval.turn_id),
                            Some(&approval.item_id),
                            json!({ "maskedCount": redacted.masked_count }),
                        )
                        .await;
                    }
                    let summary = if redacted.is_clean() {
                        approval.summary.clone()
                    } else {
                        format!("{}（已脱敏 {} 处）", redacted.text, redacted.masked_count)
                    };
                    let _ = log.lock().await.append_audit(
                        &AuditEntry::new("command_approval", "user", summary, now_ms())
                            .with_risk(approval.risk.tier.label_zh())
                            .with_decision(decision.label_zh())
                            .with_scope(scope_str(scope))
                            .with_thread(
                                &approval.thread_id,
                                Some(&approval.turn_id),
                                Some(&approval.item_id),
                            ),
                    );
                    record(
                        log,
                        event_kind::APPROVAL_RESOLVED,
                        Some(&approval.thread_id),
                        Some(&approval.turn_id),
                        Some(&approval.item_id),
                        json!({
                            "decision": decision.label_zh(),
                            "interruptsTurn": decision.interrupts_turn(),
                        }),
                    ).await;
                    emit(AppEvent::ApprovalResolved {
                        request_id: request_id.clone(),
                        thread_id: approval.thread_id.clone(),
                    });
                    let _ = reply.send(Ok(()));
                }
                Err(e) => {
                    let _ = reply.send(Err(e.to_string()));
                }
            }
        }

        Command::ExportAudit { reply } => {
            let out = log.lock().await.export_audit_json().map_err(|e| e.to_string());
            let _ = reply.send(out);
        }

        Command::DecideFile { thread_id, turn_id, path, decision, reply } => {
            let rec = kcode_domain::FileDecisionRecord {
                turn_id: turn_id.clone(),
                path: path.clone(),
                decision,
                decided_at_ms: now_ms(),
            };
            let guard = log.lock().await;
            let out = guard
                .append(&EventRecord {
                    seq: 0,
                    thread_id: Some(thread_id.clone()),
                    turn_id: Some(turn_id.clone()),
                    item_id: None,
                    ts_ms: now_ms(),
                    kind: event_kind::CHANGE_FILE_DECISION.to_owned(),
                    raw_json: serde_json::to_string(&rec).unwrap_or_default(),
                    payload: serde_json::to_value(&rec).unwrap_or(Value::Null),
                })
                .map(|_| ())
                .map_err(|e| e.to_string());
            drop(guard);
            let _ = reply.send(out);
        }

        Command::ReadDirectory { path, reply } => {
            let out = match transport
                .request("fs/readDirectory", json!({ "path": path }))
                .await
            {
                Ok(v) => Ok(v
                    .get("entries")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(|e| {
                                Some(DirEntry {
                                    name: e.get("fileName")?.as_str()?.to_owned(),
                                    is_directory: e
                                        .get("isDirectory")
                                        .and_then(Value::as_bool)
                                        .unwrap_or(false),
                                    is_file: e.get("isFile").and_then(Value::as_bool).unwrap_or(false),
                                })
                            })
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default()),
                Err(e) => Err(format!("读取目录失败：{e}")),
            };
            let _ = reply.send(out);
        }

        Command::ExecStart { process_id, command, cwd, reply } => {
            // 空 argv 会被协议拒绝，这里先挡住并给出可读原因
            if command.is_empty() {
                let _ = reply.send(Err("命令不能为空".to_owned()));
            } else {
                let mut params = json!({
                    "command": command,
                    "processId": process_id,
                    // **tty: true 是必须的**，它隐含 streamStdin + streamStdoutStderr。
                    // 实测：不传这些标志时 command/exec 只返回一次性缓冲输出，
                    // 全程没有任何 outputDelta——长命令期间界面一片空白，
                    // 直到结束才一次性显示。终端场景必须是 tty。
                    "tty": true,
                    "size": { "rows": 24, "cols": 100 },
                });
                if let Some(dir) = cwd {
                    params["cwd"] = json!(dir);
                }

                // **不 await 完成**：command/exec 的响应在进程退出时才返回，
                // 在这里 await 会把 owner 循环卡住整条命令的时长——期间
                // 审批应答、事件分发全部停摆。改为后台等待，结果经事件通道发。
                let ev = events.clone();
                let pid = process_id.clone();
                // 先把请求发出去，再在后台等结果
                let waiting = match transport.request_detached("command/exec", params).await {
                    Ok(f) => f,
                    Err(e) => {
                        let _ = reply.send(Err(format!("启动终端失败：{e}")));
                        return;
                    }
                };
                tokio::spawn(async move {
                    match waiting.await {
                        Ok(v) => {
                            let code = v.get("exitCode").and_then(Value::as_i64).map(|c| c as i32);
                            let _ = ev.send(AppEvent::TerminalExited { process_id: pid, exit_code: code });
                        }
                        Err(e) => {
                            let _ = ev.send(AppEvent::Error { message: format!("终端命令失败：{e}") });
                            let _ = ev.send(AppEvent::TerminalExited {
                                process_id: pid,
                                exit_code: None,
                            });
                        }
                    }
                });
                let _ = reply.send(Ok(ExecStarted {
                    process_id,
                    output_capped: false,
                }));
            }
        }

        Command::ExecWrite { process_id, data, reply } => {
            let out = transport
                .request(
                    "command/exec/write",
                    json!({ "processId": process_id, "data": data }),
                )
                .await
                .map(|_| ())
                .map_err(|e| format!("写入终端失败：{e}"));
            let _ = reply.send(out);
        }

        Command::ExecTerminate { process_id, reply } => {
            let out = transport
                .request("command/exec/terminate", json!({ "processId": process_id }))
                .await
                .map(|_| ())
                .map_err(|e| format!("终止终端失败：{e}"));
            let _ = reply.send(out);
        }

        Command::ReadSettings { reply } => {
            let out = read_settings(transport, codex_home, workspace).await;
            let _ = reply.send(out);
        }

        Command::SetPermissionMode { mode, reply } => {
            let out = write_permission_mode(transport, mode).await;
            let _ = reply.send(out);
        }

        Command::ListModels { reply } => {
            let out = match transport.request("model/list", json!({})).await {
                Ok(result) => {
                    let items = result
                        .get("data")
                        .or_else(|| result.get("models"))
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                    let opts: Vec<ModelOption> = items
                        .iter()
                        .filter_map(|m| {
                            let id = m.get("id").or_else(|| m.get("model"))?.as_str()?.to_owned();
                            let display_name = m
                                .get("displayName")
                                .and_then(Value::as_str)
                                .unwrap_or(&id)
                                .to_owned();
                            let efforts: Vec<String> = m
                                .get("supportedReasoningEfforts")
                                .and_then(Value::as_array)
                                .map(|a| {
                                    a.iter()
                                        .filter_map(|e| {
                                            e.as_str().map(str::to_owned).or_else(|| {
                                                e.get("effort").and_then(Value::as_str).map(str::to_owned)
                                            })
                                        })
                                        .collect()
                                })
                                .unwrap_or_default();
                            // 隐藏模型不展示
                            if m.get("hidden").and_then(Value::as_bool).unwrap_or(false) {
                                return None;
                            }
                            Some(ModelOption {
                                id,
                                display_name,
                                is_default: m.get("isDefault").and_then(Value::as_bool).unwrap_or(false),
                                reasoning_efforts: efforts,
                                default_effort: m
                                    .get("defaultReasoningEffort")
                                    .and_then(Value::as_str)
                                    .map(str::to_owned),
                            })
                        })
                        .collect();
                    Ok(opts)
                }
                Err(e) => Err(e.to_string()),
            };
            let _ = reply.send(out);
        }

        Command::ListSkills { cwd, reply } => {
            let out = match transport.request("skills/list", json!({ "cwds": [cwd] })).await
            {
                Ok(result) => {
                    // 响应结构：{ data: [{ cwd, skills: [...] }] }
                    let mut out = Vec::new();
                    for entry in result
                        .get("data")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default()
                    {
                        for sk in entry
                            .get("skills")
                            .and_then(Value::as_array)
                            .cloned()
                            .unwrap_or_default()
                        {
                            let Some(name) = sk.get("name").and_then(Value::as_str) else { continue };
                            out.push(SkillInfo {
                                name: name.to_owned(),
                                description: sk
                                    .get("description")
                                    .and_then(Value::as_str)
                                    .unwrap_or_default()
                                    .to_owned(),
                                path: sk
                                    .get("path")
                                    .and_then(Value::as_str)
                                    .unwrap_or_default()
                                    .to_owned(),
                                scope: sk
                                    .get("scope")
                                    .and_then(Value::as_str)
                                    .unwrap_or("unknown")
                                    .to_owned(),
                                enabled: sk.get("enabled").and_then(Value::as_bool).unwrap_or(true),
                            });
                        }
                    }
                    out.sort_by(|a, b| a.name.cmp(&b.name));
                    Ok(out)
                }
                Err(e) => Err(e.to_string()),
            };
            let _ = reply.send(out);
        }

        Command::ListPlugins { reply } => {
            let out = match transport.request("plugin/list", json!({})).await {
                Ok(result) => {
                    // 响应结构：{ marketplaces: [{ name, plugins: [...] }] }
                    let mut out = Vec::new();
                    for mp in result
                        .get("marketplaces")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default()
                    {
                        let mkt = mp
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown")
                            .to_owned();
                        for pl in mp
                            .get("plugins")
                            .and_then(Value::as_array)
                            .cloned()
                            .unwrap_or_default()
                        {
                            let Some(id) = pl.get("id").and_then(Value::as_str) else { continue };
                            out.push(PluginInfo {
                                id: id.to_owned(),
                                name: pl
                                    .get("name")
                                    .and_then(Value::as_str)
                                    .unwrap_or(id)
                                    .to_owned(),
                                marketplace: mkt.clone(),
                                installed: pl
                                    .get("installed")
                                    .and_then(Value::as_bool)
                                    .unwrap_or(false),
                                enabled: pl.get("enabled").and_then(Value::as_bool).unwrap_or(false),
                                description: pl
                                    .get("description")
                                    .and_then(Value::as_str)
                                    .map(str::to_owned),
                            });
                        }
                    }
                    Ok(out)
                }
                Err(e) => Err(e.to_string()),
            };
            let _ = reply.send(out);
        }

        Command::ListThreadsRemote { search_term, reply } => {
            let mut params = json!({ "limit": 100 });
            if let Some(t) = &search_term {
                if !t.trim().is_empty() {
                    params["searchTerm"] = json!(t.trim());
                }
            }
            let out = match transport.request("thread/list", params).await {
                Ok(result) => {
                    // 用本地日志补齐 item/turn 计数与未完成标记——
                    // thread/list 只给元数据，不含这些统计。
                    let guard = log.lock().await;
                    let local = summarize_threads(&guard).unwrap_or_default();
                    drop(guard);

                    let arr = result
                        .get("data")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                    let mut out: Vec<ThreadSummary> = arr
                        .iter()
                        .filter_map(|t| {
                            let id = t.get("id")?.as_str()?.to_owned();
                            let from_local = local.iter().find(|l| l.thread_id == id);
                            Some(ThreadSummary {
                                thread_id: id,
                                cwd: t
                                    .get("cwd")
                                    .and_then(Value::as_str)
                                    .unwrap_or_default()
                                    .to_owned(),
                                created_at_ms: t
                                    .get("createdAt")
                                    .and_then(Value::as_i64)
                                    .unwrap_or(0),
                                last_event_ms: t
                                    .get("recencyAt")
                                    .or_else(|| t.get("updatedAt"))
                                    .and_then(Value::as_i64)
                                    .unwrap_or(0),
                                item_count: from_local.map(|l| l.item_count).unwrap_or(0),
                                turn_count: from_local.map(|l| l.turn_count).unwrap_or(0),
                                has_unfinished_turn: from_local
                                    .map(|l| l.has_unfinished_turn)
                                    .unwrap_or(false),
                                // 服务端提供的摘要——比从事件日志猜更准
                                preview: t
                                    .get("preview")
                                    .and_then(Value::as_str)
                                    .map(str::to_owned),
                                name: t.get("name").and_then(Value::as_str).map(str::to_owned),
                                model: t.get("model").and_then(Value::as_str).map(str::to_owned),
                            })
                        })
                        .collect();
                    // 保持服务端顺序（按 recencyAt 降序）
                    out.sort_by_key(|t| std::cmp::Reverse(t.last_event_ms));
                    Ok(out)
                }
                Err(e) => Err(e.to_string()),
            };
            let _ = reply.send(out);
        }

        Command::ListThreads { reply } => {
            let guard = log.lock().await;
            let out = summarize_threads(&guard).map_err(|e| e.to_string());
            drop(guard);
            let _ = reply.send(out);
        }

        Command::LoadThread { thread_id, reply } => {
            let guard = log.lock().await;
            let out = load_thread_snapshot(&guard, &thread_id).map_err(|e| e.to_string());
            drop(guard);
            let _ = reply.send(out);
        }

        Command::Shutdown => unreachable!("Shutdown 由 owner_loop 直接处理"),
    }
}

async fn handle_incoming(
    ev: Incoming,
    projector: &Projector,
    log: &Arc<LogMutex>,
    events: &broadcast::Sender<AppEvent>,
    pending: &mut HashMap<String, (String, Approval)>,
) {
    let emit = |e: AppEvent| {
        let _ = events.send(e);
    };

    match ev {
        // ── 服务端请求：审批必须回应，否则 Turn 永久挂起 ──────────────
        Incoming::ServerRequest { id, method, params } => {
            let is_approval = method.ends_with("/requestApproval")
                || method == "execCommandApproval"
                || method == "applyPatchApproval";

            if is_approval {
                let key = request_id_key(&id);
                let approval = projector.project_approval(&method, &json!(key), &params);
                record(
                    log,
                    event_kind::APPROVAL_REQUESTED,
                    Some(&approval.thread_id),
                    Some(&approval.turn_id),
                    Some(&approval.item_id),
                    serde_json::to_value(&approval).unwrap_or(Value::Null),
                ).await;
                pending.insert(key, (method, approval.clone()));

                // 文件变更审批的 params 里直接带 changes（含 diff）——
                // 这是**尚未落盘**的提议，与 Item 完成后的「已应用」区分开。
                if let Some(changes) = params.get("changes") {
                    let synthetic = json!({ "type": "fileChange", "changes": changes });
                    if let Some(cs) = projector.change_set_from_item(
                        &approval.thread_id,
                        &approval.turn_id,
                        &synthetic,
                        kcode_domain::ChangeOrigin::Proposed,
                    ) {
                        if !cs.files.is_empty() {
                            emit(AppEvent::ChangeSetUpdated {
                                thread_id: approval.thread_id.clone(),
                                turn_id: approval.turn_id.clone(),
                                change_set: cs,
                            });
                        }
                    }
                }

                emit(AppEvent::ApprovalRequired { approval });
            } else {
                // 其他服务端请求（MCP elicitation、工具调用等）本轮不处理，
                // 但要留下记录——静默丢弃会让问题无从排查。
                record(
                    log,
                    "unhandled_server_request",
                    None,
                    None,
                    None,
                    json!({ "method": method, "params": params }),
                ).await;
                emit(AppEvent::Error {
                    message: format!("收到暂未处理的服务端请求：{method}"),
                });
            }
        }

        Incoming::Response { .. } => {
            // owner 循环内的请求均由 request() 内部消费响应，不会走到这里。
        }

        // ── 通知 ──────────────────────────────────────────────────────
        Incoming::Notification { method, params } => match method.as_str() {
            "thread/started" => {
                let thread_id = params["thread"]["id"].as_str().unwrap_or_default().to_owned();
                let cwd = params["thread"]["cwd"].as_str().unwrap_or_default().to_owned();
                record(log, event_kind::THREAD_STARTED, Some(&thread_id), None, None, params).await;
                emit(AppEvent::ThreadStarted { thread_id, cwd });
            }

            "turn/started" => {
                let thread_id = params["threadId"].as_str().unwrap_or_default().to_owned();
                let turn_id = params["turn"]["id"].as_str().unwrap_or_default().to_owned();
                emit(AppEvent::TurnStarted { thread_id, turn_id });
            }

            "item/started" | "item/completed" => {
                let thread_id = params["threadId"].as_str().unwrap_or_default().to_owned();
                let turn_id = params["turnId"].as_str().unwrap_or_default().to_owned();
                let item = projector.project_item(&thread_id, &turn_id, &params["item"]);
                let kind = if method == "item/completed" {
                    event_kind::ITEM_COMPLETED
                } else {
                    event_kind::ITEM_STARTED
                };
                record(
                    log,
                    kind,
                    Some(&thread_id),
                    Some(&turn_id),
                    Some(&item.id),
                    serde_json::to_value(&item).unwrap_or(Value::Null),
                ).await;
                emit(AppEvent::ItemUpserted {
                    thread_id,
                    turn_id,
                    item,
                    completed: method == "item/completed",
                });
            }

            // ── 流式文本：正文 / 推理 / 计划 ────────────────────────────
            //
            // 协议把流式内容分散在四个通知里，字段名基本一致（params.delta），
            // 但 item 标识可能来自 itemId 或 item.id。统一投影为 TextDelta，
            // 由前端按 channel 决定渲染位置。
            m if m.ends_with("/delta")
                && (m.starts_with("item/agentMessage")
                    || m.starts_with("item/reasoning")
                    || m.starts_with("item/plan")) =>
            {
                let channel = if m.starts_with("item/agentMessage") {
                    TextChannel::AgentMessage
                } else if m.starts_with("item/reasoning/summary") {
                    TextChannel::ReasoningSummary
                } else if m.starts_with("item/reasoning") {
                    TextChannel::Reasoning
                } else {
                    TextChannel::Plan
                };
                let thread_id = params["threadId"].as_str().unwrap_or_default().to_owned();
                let item_id = params["itemId"]
                    .as_str()
                    .or_else(|| params["item"]["id"].as_str())
                    .unwrap_or_default()
                    .to_owned();
                let turn_id = params["turnId"].as_str().unwrap_or_default().to_owned();
                let delta = params.get("delta").and_then(Value::as_str).unwrap_or_default().to_owned();
                if !delta.is_empty() {
                    emit(AppEvent::TextDelta { thread_id, item_id, turn_id, channel, delta });
                }
            }

            "item/commandExecution/outputDelta" | "item/fileChange/outputDelta" => {
                let thread_id = params["threadId"].as_str().unwrap_or_default().to_owned();
                let item_id = params["itemId"].as_str().unwrap_or_default().to_owned();
                let delta = params.get("delta").and_then(Value::as_str).unwrap_or_default().to_owned();
                emit(AppEvent::OutputDelta { thread_id, item_id, delta });
            }

            // 整轮的统一 diff（含 diff --git / 文件头 / @@ 头）。
            // 逐文件审阅用 fileChange Item 的结构化 changes；
            // 这一条用于总览与冲突判断。
            "turn/diff/updated" => {
                let thread_id = params["threadId"].as_str().unwrap_or_default().to_owned();
                let turn_id = params["turnId"].as_str().unwrap_or_default().to_owned();
                let diff = params.get("diff").and_then(Value::as_str).unwrap_or_default();
                let parsed = projector.parse_turn_diff(diff);
                let per_file = kcode_domain::split_multi_file_diff(diff)
                    .into_iter()
                    .map(|(path, d)| kcode_domain::FileDiffSlice { path, diff: d })
                    .collect::<Vec<_>>();
                record(
                    log,
                    "turn_diff_updated",
                    Some(&thread_id),
                    Some(&turn_id),
                    None,
                    json!({ "hunks": parsed.hunks.len(), "warnings": parsed.warnings.len() }),
                )
                .await;
                emit(AppEvent::TurnDiffUpdated { thread_id, turn_id, parsed, per_file });
            }

            "turn/completed" => {
                let thread_id = params["threadId"].as_str().unwrap_or_default().to_owned();
                let turn = &params["turn"];
                let turn_id = turn["id"].as_str().unwrap_or_default().to_owned();
                let status = Projector::project_turn_status(turn).unwrap_or(TurnStatus::Failed);
                // 整轮耗时由协议给出（`Turn.durationMs`，毫秒）。缺字段时
                // 如实为 None —— 不用本地时间戳凑一个，那会把网络与排队
                // 时间算成「工作时长」，比不显示更误导。
                let duration_ms = turn.get("durationMs").and_then(Value::as_i64);
                record(log, event_kind::TURN_COMPLETED, Some(&thread_id), Some(&turn_id), None, params).await;
                emit(AppEvent::TurnCompleted { thread_id, turn_id, status, duration_ms });
            }

            // 审批被解决（本端/其他客户端应答，或服务端超时）。多窗口收敛靠它。
            "serverRequest/resolved" => {
                let request_id = params
                    .get("requestId")
                    .map(|v| match v.as_u64() {
                        Some(n) => format!("n:{n}"),
                        None => format!("s:{}", v.as_str().unwrap_or_default()),
                    })
                    .unwrap_or_default();
                let thread_id = params["threadId"].as_str().unwrap_or_default().to_owned();
                pending.remove(&request_id);
                record(
                    log,
                    event_kind::SERVER_REQUEST_RESOLVED,
                    Some(&thread_id),
                    None,
                    None,
                    params,
                ).await;
                emit(AppEvent::ApprovalResolved { request_id, thread_id });
            }

            // 终端输出增量。base64 在这里解掉——协议层细节不该穿透到前端。
            "command/exec/outputDelta" => {
                let process_id = params
                    .get("processId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                let b64 = params
                    .get("deltaBase64")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let cap_reached = params
                    .get("capReached")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                use base64::Engine as _;
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(b64)
                    .unwrap_or_default();
                // 终端输出常含非法 UTF-8 的字节（二进制输出、被截断的
                // 多字节字符）。用 lossy 而不是丢弃整块——丢一块会让
                // 用户以为命令没输出。
                let text = String::from_utf8_lossy(&bytes).into_owned();
                if !text.is_empty() || cap_reached {
                    emit(AppEvent::TerminalDelta { process_id, text, cap_reached });
                }
            }

            "error" | "warning" => {
                let message = params
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or(&method)
                    .to_owned();
                emit(AppEvent::Error { message });
            }

            // 护栏警告：上游的循环/异常检测已介入。
            // 落库 + 推送——这是「刹车已踩下」的唯一可见信号，丢了等于瞒报。
            "guardianWarning" => {
                let thread_id = params
                    .get("threadId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                let message = params
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("上游检测到异常执行模式")
                    .to_owned();
                record(log, event_kind::GUARDIAN_WARNING, Some(&thread_id), None, None, params)
                    .await;
                emit(AppEvent::GuardianWarning { thread_id, message });
            }

            // token 用量：只推送不落库——每轮一条的频度会让审计日志膨胀，
            // 而它不承载安全语义（成本统计另走 export_audit 的汇总）。
            "thread/tokenUsage/updated" => {
                let thread_id = params
                    .get("threadId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                let turn_id = params
                    .get("turnId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                let usage = parse_token_usage(&params["tokenUsage"]);
                emit(AppEvent::TokenUsageUpdated { thread_id, turn_id, usage });
            }

            // 上下文压缩通知。协议已标记 deprecated（改由 `contextCompaction`
            // item 承载），但**不能因此静默丢弃**：老版本 app-server 仍会推，
            // 且「上下文被压缩过」是解释后续行为变化的关键事实，落库备查。
            "thread/compacted" => {
                let thread_id = params
                    .get("threadId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                let turn_id = params
                    .get("turnId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                record(
                    log,
                    event_kind::CONTEXT_COMPACTED,
                    Some(&thread_id),
                    Some(&turn_id),
                    None,
                    params,
                )
                .await;
            }

            _ => {}
        },
    }
}

/// 从协议载荷解析 token 用量。
///
/// 各字段缺失时取 0（协议把多数计数标为 required，但 `modelContextWindow`
/// 可空——它缺失时前端就无法计算余量，这一点必须原样传递而不是猜一个值）。
fn parse_token_usage(v: &Value) -> ThreadTokenUsage {
    fn breakdown(v: &Value) -> TokenUsageBreakdown {
        let n = |k: &str| v.get(k).and_then(Value::as_i64).unwrap_or(0);
        TokenUsageBreakdown {
            input_tokens: n("inputTokens"),
            cached_input_tokens: n("cachedInputTokens"),
            output_tokens: n("outputTokens"),
            reasoning_output_tokens: n("reasoningOutputTokens"),
            total_tokens: n("totalTokens"),
        }
    }
    ThreadTokenUsage {
        last: breakdown(v.get("last").unwrap_or(&Value::Null)),
        total: breakdown(v.get("total").unwrap_or(&Value::Null)),
        model_context_window: v.get("modelContextWindow").and_then(Value::as_i64),
    }
}

fn scope_str(scope: Option<ApprovalScope>) -> &'static str {
    match scope {
        Some(ApprovalScope::Turn) => "turn",
        Some(ApprovalScope::Session) => "session",
        Some(ApprovalScope::Project) => "project",
        Some(ApprovalScope::Once) | None => "once",
    }
}

async fn record(
    log: &Arc<LogMutex>,
    kind: &str,
    thread_id: Option<&str>,
    turn_id: Option<&str>,
    item_id: Option<&str>,
    payload: Value,
) {
    let _ = log.lock().await.append(&EventRecord {
        seq: 0,
        thread_id: thread_id.map(str::to_owned),
        turn_id: turn_id.map(str::to_owned),
        item_id: item_id.map(str::to_owned),
        ts_ms: now_ms(),
        kind: kind.to_owned(),
        raw_json: payload.to_string(),
        payload,
    });
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 从事件日志重放某线程的全部 Item（upsert 语义）。
///
/// 崩溃恢复的基础：UI 启动时先重放本地事件，再订阅后续增量，
/// 因此无需向 app-server 重新请求整个历史。
pub fn replay_items(log: &EventLog, thread_id: &str) -> DomainResult<Vec<Item>> {
    let mut items: Vec<Item> = Vec::new();
    for rec in log.events_for_thread(thread_id)? {
        if rec.kind == event_kind::ITEM_STARTED || rec.kind == event_kind::ITEM_COMPLETED {
            if let Ok(item) = serde_json::from_value::<Item>(rec.payload) {
                if let Some(slot) = items.iter_mut().find(|i| i.id == item.id) {
                    *slot = item;
                } else {
                    items.push(item);
                }
            }
        }
    }
    Ok(items)
}

/// 从事件日志枚举全部线程概要，按最近活动降序。
///
/// 这是「应用重启后侧栏有内容」的实现基础——进程内状态会丢，
/// 事件日志不会。
pub fn summarize_threads(log: &EventLog) -> DomainResult<Vec<ThreadSummary>> {
    use std::collections::HashMap;

    struct Acc {
        cwd: String,
        first_ms: i64,
        last_ms: i64,
        items: std::collections::HashSet<String>,
        turns: std::collections::HashSet<String>,
        completed_turns: std::collections::HashSet<String>,
    }

    let mut acc: HashMap<String, Acc> = HashMap::new();
    // 事件按 seq 升序返回，因此首次遇到即为创建时间
    for rec in log.all_events()? {
        let Some(tid) = rec.thread_id.clone() else { continue };
        let e = acc.entry(tid).or_insert_with(|| Acc {
            cwd: String::new(),
            first_ms: rec.ts_ms,
            last_ms: rec.ts_ms,
            items: Default::default(),
            turns: Default::default(),
            completed_turns: Default::default(),
        });
        e.last_ms = e.last_ms.max(rec.ts_ms);

        match rec.kind.as_str() {
            k if k == event_kind::THREAD_STARTED => {
                // 两种记录形态：命令响应（cwd 在顶层）与通知（在 thread.cwd）
                let cwd = rec
                    .payload
                    .get("cwd")
                    .and_then(Value::as_str)
                    .or_else(|| rec.payload.get("thread").and_then(|t| t.get("cwd")).and_then(Value::as_str))
                    .unwrap_or_default();
                if !cwd.is_empty() {
                    e.cwd = cwd.to_owned();
                }
            }
            k if k == event_kind::ITEM_STARTED || k == event_kind::ITEM_COMPLETED => {
                if let Some(id) = rec.item_id.clone() {
                    e.items.insert(id);
                }
            }
            k if k == event_kind::TURN_STARTED => {
                if let Some(id) = rec.turn_id.clone() {
                    e.turns.insert(id);
                }
            }
            k if k == event_kind::TURN_COMPLETED => {
                if let Some(id) = rec.turn_id.clone() {
                    e.turns.insert(id.clone());
                    e.completed_turns.insert(id);
                }
            }
            _ => {}
        }
    }

    let mut out: Vec<ThreadSummary> = acc
        .into_iter()
        .map(|(thread_id, a)| ThreadSummary {
            thread_id,
            cwd: a.cwd,
            created_at_ms: a.first_ms,
            last_event_ms: a.last_ms,
            item_count: a.items.len(),
            turn_count: a.turns.len(),
            // 有轮次开始但无对应完成事件 → 崩溃残留
            has_unfinished_turn: a.turns.iter().any(|t| !a.completed_turns.contains(t)),
            // 本地路径拿不到服务端摘要，留空由调用方回退到事件日志派生
            preview: None,
            name: None,
            model: None,
        })
        .collect();
    out.sort_by_key(|t| std::cmp::Reverse(t.last_event_ms));
    Ok(out)
}

/// 从事件日志重建单个线程的完整快照。
///
/// 重建是**幂等**的：同一份日志重复调用结果一致，因此可以安全地在
/// 每次打开线程时调用，而不只是在启动时。
pub fn load_thread_snapshot(log: &EventLog, thread_id: &str) -> DomainResult<ThreadSnapshot> {
    let events = log.events_for_thread(thread_id)?;
    let mut warnings = Vec::new();
    let mut cwd = String::new();
    let mut items: Vec<Item> = Vec::new();
    let mut turns: Vec<TurnSnapshot> = Vec::new();

    for rec in &events {
        match rec.kind.as_str() {
            k if k == event_kind::THREAD_STARTED => {
                let c = rec
                    .payload
                    .get("cwd")
                    .and_then(Value::as_str)
                    .or_else(|| rec.payload.get("thread").and_then(|t| t.get("cwd")).and_then(Value::as_str));
                if let Some(c) = c {
                    if !c.is_empty() {
                        cwd = c.to_owned();
                    }
                }
            }
            k if k == event_kind::ITEM_STARTED || k == event_kind::ITEM_COMPLETED => {
                match serde_json::from_value::<Item>(rec.payload.clone()) {
                    Ok(item) => {
                        // upsert：同 id 的后续事件覆盖先前状态
                        if let Some(slot) = items.iter_mut().find(|i| i.id == item.id) {
                            *slot = item;
                        } else {
                            items.push(item);
                        }
                    }
                    Err(e) => warnings.push(format!("第 {} 条事件无法重建为 Item：{e}", rec.seq)),
                }
            }
            k if k == event_kind::TURN_STARTED || k == event_kind::TURN_COMPLETED => {
                if let Some(tid) = rec.turn_id.clone() {
                    let turn_obj = rec.payload.get("turn");
                    let status = if k == event_kind::TURN_COMPLETED {
                        turn_obj
                            .and_then(|t| t.get("status"))
                            .and_then(Value::as_str)
                            .and_then(TurnStatus::from_protocol)
                            .unwrap_or(TurnStatus::Failed)
                    } else {
                        TurnStatus::InProgress
                    };
                    let duration_ms =
                        turn_obj.and_then(|t| t.get("durationMs")).and_then(Value::as_i64);
                    match turns.iter_mut().find(|t| t.turn_id == tid) {
                        Some(slot) => {
                            slot.status = status;
                            // 只在有值时覆盖：turns 列表里先出现的是
                            // turn_started（无耗时），后出现 turn_completed（有）
                            if duration_ms.is_some() {
                                slot.duration_ms = duration_ms;
                            }
                        }
                        None => turns.push(TurnSnapshot { turn_id: tid, status, duration_ms }),
                    }
                }
            }
            _ => {}
        }
    }

    // 崩溃残留：仍为 InProgress 的轮次无法确认结果
    for t in turns.iter_mut() {
        if t.status == TurnStatus::InProgress {
            t.status = TurnStatus::Failed;
            warnings.push(format!(
                "轮次 {} 无完成记录（可能因崩溃中断），结果未知",
                t.turn_id
            ));
        }
    }

    // ── 重建变更集 ────────────────────────────────────────────────────
    //
    // 从 fileChange Item 聚合，再叠加已持久化的用户决策。
    // 不重建的后果：重启后审阅面板空白，用户以为自己的审阅结论丢了。
    let mut change_sets: Vec<kcode_domain::ChangeSet> = Vec::new();
    let mut decisions: Vec<kcode_domain::FileDecisionRecord> = Vec::new();

    for rec in &events {
        match rec.kind.as_str() {
            k if k == event_kind::ITEM_COMPLETED => {
                // fileChange Item 的 payload 是投影后的 Item，其中 body.changes 带 diff
                let Ok(item) = serde_json::from_value::<Item>(rec.payload.clone()) else { continue };
                if let kcode_domain::ItemBody::FileChange { changes, .. } = &item.body {
                    if changes.is_empty() {
                        continue;
                    }
                    let tid = rec.turn_id.clone().unwrap_or_default();
                    match change_sets.iter_mut().find(|c| c.turn_id == tid) {
                        Some(cs) => cs.upsert_files(changes.clone()),
                        None => {
                            let mut cs = kcode_domain::ChangeSet::new(
                                thread_id,
                                &tid,
                                kcode_domain::ChangeOrigin::Applied,
                            );
                            cs.upsert_files(changes.clone());
                            change_sets.push(cs);
                        }
                    }
                }
            }
            k if k == event_kind::CHANGE_FILE_DECISION => {
                if let Ok(d) = serde_json::from_value::<kcode_domain::FileDecisionRecord>(rec.payload.clone()) {
                    decisions.push(d);
                }
            }
            _ => {}
        }
    }

    // 叠加决策（按时间顺序，后者覆盖前者）
    decisions.sort_by_key(|d| d.decided_at_ms);
    for d in &decisions {
        if let Some(cs) = change_sets.iter_mut().find(|c| c.turn_id == d.turn_id) {
            cs.decide_file(&d.path, d.decision);
        }
    }

    Ok(ThreadSnapshot {
        thread_id: thread_id.to_owned(),
        cwd,
        turns,
        items,
        change_sets,
        warnings,
    })
}

/// 判断某轮次是否应被标记为 `unknown`。
///
/// 崩溃恢复的关键：活动轮次**绝不能**静默当作成功。宁可显示「未知」让用户核对，
/// 也不要给出错误的确定性。
pub fn should_mark_unknown(last_status: TurnStatus, process_alive: bool) -> bool {
    matches!(last_status, TS::InProgress) && !process_alive
}

/// Item 是否代表「用户拒绝的操作」——UI 渲染分支的依据。
pub fn is_declined(item: &Item) -> bool {
    matches!(
        &item.body,
        kcode_domain::ItemBody::CommandExecution { status: ItemStatus::Declined, .. }
            | kcode_domain::ItemBody::FileChange { status: ItemStatus::Declined, .. }
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcode_domain::ItemBody;

    #[test]
    fn request_id_key_roundtrips() {
        for id in [RequestId::Num(7), RequestId::Str("srv-1".into())] {
            let key = request_id_key(&id);
            assert_eq!(request_id_from_key(&key), id);
        }
    }

    #[test]
    fn numeric_and_string_request_ids_do_not_collide() {
        assert_ne!(
            request_id_key(&RequestId::Num(1)),
            request_id_key(&RequestId::Str("1".into()))
        );
    }

    #[test]
    fn running_turn_of_dead_process_must_be_unknown() {
        // 崩溃恢复核心不变式：进程没了而轮次还在跑 → 状态未知，
        // 不能当作成功，也不能当作失败。
        assert!(should_mark_unknown(TS::InProgress, false));
        assert!(!should_mark_unknown(TS::InProgress, true));
        // 已有终态的不受影响
        assert!(!should_mark_unknown(TS::Completed, false));
        assert!(!should_mark_unknown(TS::Failed, false));
    }

    #[test]
    fn declined_items_are_detected_for_ui_branching() {
        let declined = Item {
            id: "i".into(),
            turn_id: "t".into(),
            created_at_ms: 0,
            body: ItemBody::CommandExecution {
                command: "rm -rf /".into(),
                cwd: None,
                status: ItemStatus::Declined,
                exit_code: None,
                aggregated_output: None,
                duration_ms: None,
            },
        };
        assert!(is_declined(&declined));

        let completed = Item {
            body: ItemBody::CommandExecution {
                command: "ls".into(),
                cwd: None,
                status: ItemStatus::Completed,
                exit_code: Some(0),
                aggregated_output: None,
                duration_ms: None,
            },
            ..declined.clone()
        };
        assert!(!is_declined(&completed));
    }

    #[test]
    fn app_event_serializes_with_camel_case() {
        // 前端契约：事件字段名必须是 camelCase
        let ev = AppEvent::TurnCompleted {
            thread_id: "th".into(),
            turn_id: "tu".into(),
            status: TurnStatus::Completed,
            duration_ms: Some(6500),
        };
        let v = serde_json::to_value(&ev).unwrap();
        assert_eq!(v["type"], "turnCompleted");
        assert!(v.get("threadId").is_some(), "keys: {v}");
        assert!(v.get("turnId").is_some(), "keys: {v}");
        assert!(v.get("thread_id").is_none(), "不应出现 snake_case");
        // 整轮耗时：前端按毫秒直接展示，字段名与单位都要钉住
        assert_eq!(v["durationMs"], 6500, "耗时必须是毫秒且 camelCase：{v}");

        let ev2 = AppEvent::ApprovalRequired {
            approval: Approval {
                request_id: json!("n:0"),
                method: "item/commandExecution/requestApproval".into(),
                thread_id: "th".into(),
                turn_id: "tu".into(),
                item_id: "i".into(),
                started_at_ms: 1,
                summary: "ls".into(),
                cwd: None,
                reason: None,
                risk: kcode_domain::RiskAssessment {
                    tier: kcode_domain::RiskTier::Low,
                    signals: vec![],
                },
                decision: None,
                scope: None,
            },
        };
        let v2 = serde_json::to_value(&ev2).unwrap();
        assert_eq!(v2["type"], "approvalRequired");
        assert!(v2["approval"].get("requestId").is_some(), "keys: {}", v2["approval"]);
        assert!(v2["approval"].get("startedAtMs").is_some(), "keys: {}", v2["approval"]);
    }

    #[test]
    fn token_usage_parses_full_payload() {
        let payload = json!({
            "last": {
                "inputTokens": 1200, "cachedInputTokens": 800,
                "outputTokens": 300, "reasoningOutputTokens": 50,
                "totalTokens": 1500
            },
            "total": {
                "inputTokens": 5000, "cachedInputTokens": 2000,
                "outputTokens": 900, "reasoningOutputTokens": 120,
                "totalTokens": 5900
            },
            "modelContextWindow": 200000
        });
        let u = parse_token_usage(&payload);
        assert_eq!(u.last.input_tokens, 1200);
        assert_eq!(u.last.cached_input_tokens, 800);
        assert_eq!(u.last.output_tokens, 300);
        assert_eq!(u.last.reasoning_output_tokens, 50);
        assert_eq!(u.last.total_tokens, 1500);
        assert_eq!(u.total.total_tokens, 5900);
        assert_eq!(u.model_context_window, Some(200_000));
    }

    #[test]
    fn token_usage_missing_fields_degrade_to_zero_not_panic() {
        // 协议演进中字段可能缺席。此时应退化为 0（余量算不出 → 前端不显示），
        // 而不是 panic 掉整个通知分发——那会连带丢掉后续所有事件。
        let u = parse_token_usage(&json!({}));
        assert_eq!(u.last.total_tokens, 0);
        assert_eq!(u.total.total_tokens, 0);
        // 窗口缺失必须如实为 None：猜一个值会让「余量」显示错误的比例。
        assert_eq!(u.model_context_window, None);

        // 半截载荷（只有 last）同样不应崩
        let half = parse_token_usage(&json!({ "last": { "inputTokens": 5, "outputTokens": 1, "totalTokens": 6 } }));
        assert_eq!(half.last.total_tokens, 6);
        assert_eq!(half.total.total_tokens, 0);
    }

    #[test]
    fn token_usage_window_zero_is_preserved() {
        // 0 与 None 语义不同：0 表示「协议明确说窗口是 0」（异常但已知），
        // None 表示「协议没说」。用 unwrap_or(0) 会把两者混为一谈。
        let u = parse_token_usage(&json!({ "modelContextWindow": 0 }));
        assert_eq!(u.model_context_window, Some(0));
    }
}
