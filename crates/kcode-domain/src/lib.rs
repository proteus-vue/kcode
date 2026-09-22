//! # kcode-domain
//!
//! KCode 领域层（L2）：把协议报文投影为稳定的领域状态。
//!
//! 前端只消费本 crate 的类型，不直接接触官方 wire type——协议被官方标记为
//! experimental，字段随时可能变，隔离层是唯一能让 UI 契约稳定的办法。
//!
//! ## 模块职责
//!
//! | 模块 | 职责 |
//! |---|---|
//! | [`model`] | Thread / Turn / Item / Approval 领域类型与状态机 |
//! | [`risk`] | 客户端风险分级（协议不提供此能力，必须自研） |
//! | [`project`] | 协议报文 → 领域对象 |
//! | [`log`] | 事件溯源持久化（SQLite WAL）与审计日志 |
//!
//! ## 两条贯穿全局的约束
//!
//! 1. **风险分级只影响展示与排序，不参与放行决策。** 强制边界来自沙箱与
//!    `writable_roots`，不来自字符串匹配（见 [`risk`] 模块文档）。
//! 2. **`declined` 与 `completed` 严格区分。** 前者表示用户拒绝、操作未执行。

pub mod changeset;
pub mod error;
pub mod log;
pub mod model;
pub mod project;
pub mod redact;
pub mod risk;

pub use error::Result;
pub use log::{AuditEntry, EventLog, EventRecord};
pub use changeset::{
    parse_unified_diff, split_multi_file_diff, ChangeOrigin, ChangeSet, DiffHunk, DiffLine, DiffLineKind, DiffStats,
    FileChangeEntry, FileChangeKind, FileDecision, FileDecisionRecord, FileDiffSlice, ParsedDiff,
    ReviewState,
};
pub use model::{
    Approval, ApprovalDecision, ApprovalScope, Item, ItemBody, ItemStatus, Thread, ThreadStatus,
    Turn, TurnDisplayStatus, TurnStatus,
};
pub use project::Projector;
pub use redact::{is_sensitive_key, redact, Redaction};
pub use risk::{RiskAssessment, RiskInput, RiskSignal, RiskTier};

/// 事件日志中使用的领域事件种类名。
///
/// 集中定义避免各处拼写不一致——这些字符串会落库，拼错会导致重放时漏掉事件。
pub mod event_kind {
    pub const THREAD_STARTED: &str = "thread_started";
    pub const THREAD_ARCHIVED: &str = "thread_archived";
    pub const THREAD_UNARCHIVED: &str = "thread_unarchived";
    pub const TURN_STARTED: &str = "turn_started";
    pub const TURN_COMPLETED: &str = "turn_completed";
    pub const ITEM_STARTED: &str = "item_started";
    pub const ITEM_COMPLETED: &str = "item_completed";
    pub const APPROVAL_REQUESTED: &str = "approval_requested";
    pub const APPROVAL_RESOLVED: &str = "approval_resolved";
    pub const SERVER_REQUEST_RESOLVED: &str = "server_request_resolved";
    pub const PROCESS_EXITED: &str = "process_exited";
    /// 护栏警告（上游循环/异常检测）。**必须落库**——事故复盘时
    /// 「上游当时有没有示警」是第一个要回答的问题。
    pub const GUARDIAN_WARNING: &str = "guardian_warning";
    /// 线程 token 用量快照。
    pub const TOKEN_USAGE: &str = "token_usage";
    /// 上下文压缩（协议已标记 deprecated，由 `contextCompaction` item 取代；
    /// 这里保留落库路径，使审计日志不丢事件）。
    pub const CONTEXT_COMPACTED: &str = "context_compacted";
    /// 用户对某个变更文件的接受/拒绝决策（需持久化）。
    pub const CHANGE_FILE_DECISION: &str = "change_file_decision";
}
