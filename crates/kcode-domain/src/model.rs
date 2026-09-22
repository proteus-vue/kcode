//! 领域模型：Thread / Turn / Item / Approval。
//!
//! # 与协议的两处关键区分
//!
//! 1. **协议状态 ≠ 展示状态。** 协议 `TurnStatus` 只有 4 个值
//!    （`inProgress` / `completed` / `interrupted` / `failed`），而 UI 需要区分
//!    「运行中」「等待审批」等中间态。后者由事件流**派生**，不是协议字段。
//!    若把派生状态当作协议状态去找，会白费功夫。
//!
//! 2. **`declined` 是一等状态。** 用户拒绝后 Item 状态为 `declined`，
//!    与 `completed` 语义完全不同（命令根本没执行）。必须独立建模，
//!    否则 UI 会把「已拒绝」显示成「已完成」。

use crate::changeset::FileChangeEntry;
use serde::{Deserialize, Serialize};

/// 协议 `TurnStatus` 的取值（实测 4 值）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TurnStatus {
    InProgress,
    Completed,
    Interrupted,
    Failed,
}

impl TurnStatus {
    pub fn from_protocol(s: &str) -> Option<Self> {
        match s {
            "inProgress" => Some(Self::InProgress),
            "completed" => Some(Self::Completed),
            "interrupted" => Some(Self::Interrupted),
            "failed" => Some(Self::Failed),
            _ => None,
        }
    }

    pub fn is_terminal(self) -> bool {
        !matches!(self, Self::InProgress)
    }
}

/// UI 展示状态：由事件流派生，**不是协议字段**。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnDisplayStatus {
    /// 协议 `inProgress`，且当前无待决审批。
    Running,
    /// 协议 `inProgress`，但有审批请求待用户决策——侧栏排序的最高优先级。
    AwaitingApproval,
    /// 协议终态映射。
    Completed,
    Interrupted,
    Failed,
    /// 子进程异常退出，无法确定真实状态。绝不静默当作成功或失败。
    Unknown,
}

impl TurnDisplayStatus {
    /// 侧栏排序权重：数值越小越靠前。
    ///
    /// 排序依据是「待用户操作」，不是最近活动时间。
    pub fn sort_rank(self) -> u8 {
        match self {
            TurnDisplayStatus::AwaitingApproval => 0,
            TurnDisplayStatus::Running => 1,
            TurnDisplayStatus::Failed => 2,
            TurnDisplayStatus::Completed => 3,
            TurnDisplayStatus::Interrupted => 4,
            TurnDisplayStatus::Unknown => 5,
        }
    }
}

/// Item 生命周期状态。
///
/// `Declined` 是实测确认的官方取值（`CommandExecutionStatus` 与
/// `PatchApplyStatus` 均为 `inProgress` / `completed` / `failed` / `declined`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ItemStatus {
    InProgress,
    Completed,
    Failed,
    /// 用户拒绝，**操作未执行**。
    Declined,
}

impl ItemStatus {
    pub fn from_protocol(s: &str) -> Option<Self> {
        match s {
            "inProgress" => Some(Self::InProgress),
            "completed" => Some(Self::Completed),
            "failed" => Some(Self::Failed),
            "declined" => Some(Self::Declined),
            _ => None,
        }
    }

    pub fn is_terminal(self) -> bool {
        !matches!(self, Self::InProgress)
    }
}

/// Item 类别。协议 `ThreadItem` 有 19 种变体，这里归并为 UI 需要的粒度。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ItemBody {
    #[serde(rename_all = "camelCase")]
    UserMessage {
        text: String,
        /// userMessage 的 `content[]` 里带的本地图片路径（协议 `localImage`）。
        ///
        /// **必须保留**：服务端会把我们发出去的图片原样回显在 userMessage 里，
        /// 只取 text 的话，时间线上用户看到自己那条消息是「纯文字」——
        /// 而图片确实是发出去、模型也确实看到了，界面与现实不符。
        /// 有没有图片也是理解「模型为什么这样回答」的关键线索。
        #[serde(default)]
        images: Vec<String>,
    },
    #[serde(rename_all = "camelCase")]
    AgentMessage { text: String },
    #[serde(rename_all = "camelCase")]
    Reasoning { text: String },
    #[serde(rename_all = "camelCase")]
    Plan { text: String },
    #[serde(rename_all = "camelCase")]
    CommandExecution {
        command: String,
        cwd: Option<String>,
        status: ItemStatus,
        exit_code: Option<i64>,
        aggregated_output: Option<String>,
        duration_ms: Option<i64>,
    },
    #[serde(rename_all = "camelCase")]
    FileChange {
        status: ItemStatus,
        /// 变更文件路径列表（含变更类型）。
        changes: Vec<FileChangeEntry>,
    },
    #[serde(rename_all = "camelCase")]
    ToolCall {
        server: Option<String>,
        tool: String,
        args_summary: Option<String>,
        result_summary: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    WebSearch { query: String },
    #[serde(rename_all = "camelCase")]
    ImageView { path: String },
    ContextCompaction,
    /// 协作/子 Agent 活动。
    #[serde(rename_all = "camelCase")]
    CollabAgent { description: String },
    /// 其余协议变体（hookPrompt / sleep / imageGeneration / reviewMode 等）的兜底。
    #[serde(rename_all = "camelCase")]
    Other { protocol_type: String },
}

/// 一个可渲染单元。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub turn_id: String,
    pub body: ItemBody,
    /// 创建时间（毫秒）。
    pub created_at_ms: i64,
}

impl Item {
    /// 该 Item 是否代表一次「被拒绝的操作」。
    pub fn is_declined(&self) -> bool {
        match &self.body {
            ItemBody::CommandExecution { status, .. } | ItemBody::FileChange { status, .. } => {
                *status == ItemStatus::Declined
            }
            _ => false,
        }
    }

    /// 该 Item 是否产生了文件变更（用于聚合 ChangeSet）。
    pub fn file_changes(&self) -> &[FileChangeEntry] {
        match &self.body {
            ItemBody::FileChange { changes, .. } => changes,
            _ => &[],
        }
    }
}

/// 一次用户输入触发的连续工作。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub id: String,
    pub thread_id: String,
    pub status: TurnStatus,
    pub started_at_ms: Option<i64>,
    pub completed_at_ms: Option<i64>,
    pub duration_ms: Option<i64>,
    pub items: Vec<Item>,
}

impl Turn {
    /// 由协议状态 + 是否存在待决审批，派生出 UI 展示状态。
    ///
    /// 这是「协议状态 ≠ 展示状态」的落点：`awaiting_approval` 无法从协议
    /// 单字段读出，只能结合待决审批集合推导。
    pub fn display_status(&self, has_pending_approval: bool) -> TurnDisplayStatus {
        match self.status {
            TurnStatus::InProgress if has_pending_approval => TurnDisplayStatus::AwaitingApproval,
            TurnStatus::InProgress => TurnDisplayStatus::Running,
            TurnStatus::Completed => TurnDisplayStatus::Completed,
            TurnStatus::Interrupted => TurnDisplayStatus::Interrupted,
            TurnStatus::Failed => TurnDisplayStatus::Failed,
        }
    }
}

/// 审批请求的处理结果。
///
/// 6 个取值与协议 `CommandExecutionApprovalDecision` 一一对应。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum ApprovalDecision {
    /// 批准本次。
    Accept,
    /// 批准，本会话同类不再询问。
    AcceptForSession,
    /// 批准并落盘 execpolicy 规则。
    AcceptWithExecpolicyAmendment,
    /// 为该 host 落盘持久网络策略。
    ApplyNetworkPolicyAmendment,
    /// 拒绝；**操作不执行**，Turn 继续。
    Decline,
    /// 拒绝；**操作不执行**，并中断 Turn。
    Cancel,
}

impl ApprovalDecision {
    /// 协议线上取值。用于构造应答报文。
    pub fn to_protocol_value(&self) -> serde_json::Value {
        match self {
            ApprovalDecision::Accept => serde_json::json!("accept"),
            ApprovalDecision::AcceptForSession => serde_json::json!("acceptForSession"),
            ApprovalDecision::Decline => serde_json::json!("decline"),
            ApprovalDecision::Cancel => serde_json::json!("cancel"),
            ApprovalDecision::AcceptWithExecpolicyAmendment => {
                serde_json::json!({ "acceptWithExecpolicyAmendment": { "execpolicy_amendment": [] } })
            }
            ApprovalDecision::ApplyNetworkPolicyAmendment => {
                serde_json::json!({ "applyNetworkPolicyAmendment": { "network_policy_amendment": {} } })
            }
        }
    }

    /// 该决策是否批准了操作。
    ///
    /// **唯一可用于判断「是否放行」的入口**——不要在其他地方按字符串比较，
    /// 否则新增决策值时容易漏改。
    pub fn is_approving(&self) -> bool {
        !matches!(self, ApprovalDecision::Decline | ApprovalDecision::Cancel)
    }

    /// 该决策是否应中断当前 Turn。
    ///
    /// `Cancel` 与 `Decline` 都阻止执行，区别仅在此——UI 必须区分，
    /// 否则用户拒绝一条命令时会意外终止整个 Turn。
    pub fn interrupts_turn(&self) -> bool {
        matches!(self, ApprovalDecision::Cancel)
    }

    /// 供 UI 展示的中文标签。
    pub fn label_zh(&self) -> &'static str {
        match self {
            ApprovalDecision::Accept => "批准",
            ApprovalDecision::AcceptForSession => "本会话内总是批准",
            ApprovalDecision::AcceptWithExecpolicyAmendment => "批准并记住此命令",
            ApprovalDecision::ApplyNetworkPolicyAmendment => "应用网络策略",
            ApprovalDecision::Decline => "拒绝",
            ApprovalDecision::Cancel => "拒绝并停止",
        }
    }

    pub fn from_protocol(s: &str) -> Option<Self> {
        match s {
            "accept" => Some(Self::Accept),
            "acceptForSession" => Some(Self::AcceptForSession),
            "decline" => Some(Self::Decline),
            "cancel" => Some(Self::Cancel),
            "acceptWithExecpolicyAmendment" => Some(Self::AcceptWithExecpolicyAmendment),
            "applyNetworkPolicyAmendment" => Some(Self::ApplyNetworkPolicyAmendment),
            _ => None,
        }
    }
}

/// 审批作用的范围。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalScope {
    /// 仅此次。
    Once,
    /// 当前 Turn。
    Turn,
    /// 当前 Thread（协议 `scope: "session"`）。
    Session,
    /// 当前项目。
    Project,
}

/// 审批请求（服务端发起，等待用户决策）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Approval {
    /// 协议层请求 id。回应时必须原样带回——**不存在 `approval/resolve` 方法**。
    pub request_id: serde_json::Value,
    /// 协议方法名，决定响应体形态。
    pub method: String,
    pub thread_id: String,
    pub turn_id: String,
    pub item_id: String,
    pub started_at_ms: i64,
    /// 命令文本（命令审批）或变更摘要（文件审批）。
    pub summary: String,
    pub cwd: Option<String>,
    /// 模型给出的自述原因。仅供参考，不作为分级依据。
    pub reason: Option<String>,
    /// 客户端推断的风险分级（`RiskClassifier` 产出）。
    pub risk: crate::risk::RiskAssessment,
    /// 决策结果；`None` 表示尚未决策。
    pub decision: Option<ApprovalDecision>,
    pub scope: Option<ApprovalScope>,
}

impl Approval {
    pub fn is_pending(&self) -> bool {
        self.decision.is_none()
    }

    /// 协议层请求 id 的字符串键，用于回传决策。
    ///
    /// 形如 `n:0` / `s:abc`；数值与字符串加前缀区分，避免 `1` 与 `"1"` 相撞。
    pub fn request_key(&self) -> String {
        match &self.request_id {
            serde_json::Value::String(s) => s.clone(),
            other => other.to_string(),
        }
    }
}

/// 线程状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThreadStatus {
    Active,
    Archived,
}

/// 一个任务线程。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    pub id: String,
    pub project_id: String,
    pub title: Option<String>,
    pub status: ThreadStatus,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    /// fork 来源线程 id（协议 `forkedFromId`）。
    pub forked_from_id: Option<String>,
    /// 工作区绝对路径。
    pub cwd: String,
    pub turns: Vec<Turn>,
}

impl Thread {
    /// 侧栏排序键：先按「待用户操作」，再按最近更新。
    pub fn sort_key(&self, pending_approvals: &[Approval]) -> (u8, i64) {
        let has_pending = pending_approvals
            .iter()
            .any(|a| a.thread_id == self.id && a.is_pending());

        let rank = self
            .turns
            .iter()
            .filter(|t| !t.status.is_terminal())
            .map(|t| t.display_status(has_pending).sort_rank())
            .min()
            .unwrap_or_else(|| {
                // 无活动轮次：取最近一轮的终态排序位
                self.turns
                    .last()
                    .map(|t| t.display_status(false).sort_rank())
                    .unwrap_or(3)
            });

        (rank, -self.updated_at_ms)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_turn_status_maps_exactly_four_values() {
        assert_eq!(TurnStatus::from_protocol("inProgress"), Some(TurnStatus::InProgress));
        assert_eq!(TurnStatus::from_protocol("completed"), Some(TurnStatus::Completed));
        assert_eq!(TurnStatus::from_protocol("interrupted"), Some(TurnStatus::Interrupted));
        assert_eq!(TurnStatus::from_protocol("failed"), Some(TurnStatus::Failed));
        // 旧方案文档里的 9 值并非协议取值；这些必须不被接受
        for bogus in ["queued", "running", "awaiting_approval", "verifying", "cancelled", "needs_input"] {
            assert_eq!(TurnStatus::from_protocol(bogus), None, "`{bogus}` 不是协议状态");
        }
    }

    #[test]
    fn declined_is_a_first_class_item_status() {
        assert_eq!(ItemStatus::from_protocol("declined"), Some(ItemStatus::Declined));
        assert!(ItemStatus::Declined.is_terminal());
        assert_ne!(ItemStatus::Declined, ItemStatus::Completed);
    }

    /// 前端契约回归：`ItemBody` 的线上字段名必须是 camelCase。
    ///
    /// 这个测试守的是一个真实踩过的坑：带 tag 的枚举上写 `rename_all = "camelCase"`
    /// 只重命名**变体名**，不会重命名变体内部的字段。于是 `exit_code` 会原样序列化成
    /// `exit_code`，前端按 `exitCode` 读取就永远拿到 undefined——而单测若不校验线格式
    /// 就发现不了，因为 `status`/`command` 这类单词字段两种写法恰好一致，掩盖了问题。
    #[test]
    fn item_body_serializes_with_camel_case_field_names() {
        let item = ItemBody::CommandExecution {
            command: "npm test".into(),
            cwd: Some("/w".into()),
            status: ItemStatus::Completed,
            exit_code: Some(0),
            aggregated_output: Some("ok".into()),
            duration_ms: Some(57),
        };
        let v = serde_json::to_value(&item).unwrap();

        assert_eq!(v["kind"], "commandExecution", "变体名应为 camelCase");
        for field in ["exitCode", "aggregatedOutput", "durationMs"] {
            assert!(
                v.get(field).is_some(),
                "缺少字段 `{field}`；实际键: {:?}。多词字段必须在变体上显式标注 \
                 rename_all——容器级属性不会作用到变体内部字段。",
                v.as_object().map(|o| o.keys().collect::<Vec<_>>())
            );
        }
        assert_eq!(v["exitCode"], 0);
        assert_eq!(v["durationMs"], 57);
        for bad in ["exit_code", "aggregated_output", "duration_ms"] {
            assert!(v.get(bad).is_none(), "字段 `{bad}` 未按 camelCase 序列化");
        }

        // 其余含多词字段的变体同样校验
        let tool = serde_json::to_value(ItemBody::ToolCall {
            server: Some("mcp".into()),
            tool: "search".into(),
            args_summary: Some("{}".into()),
            result_summary: None,
        })
        .unwrap();
        assert!(tool.get("argsSummary").is_some(), "keys: {tool}");

        let file = serde_json::to_value(ItemBody::FileChange {
            status: ItemStatus::Declined,
            changes: vec![],
        })
        .unwrap();
        assert_eq!(file["kind"], "fileChange");
        assert_eq!(file["status"], "declined");

        let other = serde_json::to_value(ItemBody::Other { protocol_type: "x".into() }).unwrap();
        assert!(other.get("protocolType").is_some(), "keys: {other}");
    }

    #[test]
    fn awaiting_approval_is_derived_not_protocol() {
        let turn = Turn {
            id: "t1".into(),
            thread_id: "th1".into(),
            status: TurnStatus::InProgress,
            started_at_ms: None,
            completed_at_ms: None,
            duration_ms: None,
            items: vec![],
        };
        assert_eq!(turn.display_status(false), TurnDisplayStatus::Running);
        assert_eq!(turn.display_status(true), TurnDisplayStatus::AwaitingApproval);
    }

    #[test]
    fn awaiting_approval_outranks_running_in_sort() {
        assert!(
            TurnDisplayStatus::AwaitingApproval.sort_rank()
                < TurnDisplayStatus::Running.sort_rank()
        );
        assert!(TurnDisplayStatus::Running.sort_rank() < TurnDisplayStatus::Failed.sort_rank());
        assert!(TurnDisplayStatus::Failed.sort_rank() < TurnDisplayStatus::Completed.sort_rank());
    }

    #[test]
    fn decline_and_cancel_both_block_but_only_cancel_interrupts() {
        assert!(!ApprovalDecision::Decline.is_approving());
        assert!(!ApprovalDecision::Cancel.is_approving());
        assert!(!ApprovalDecision::Decline.interrupts_turn());
        assert!(ApprovalDecision::Cancel.interrupts_turn());

        assert!(ApprovalDecision::Accept.is_approving());
        assert!(!ApprovalDecision::Accept.interrupts_turn());
        assert!(ApprovalDecision::AcceptForSession.is_approving());
    }

    #[test]
    fn decision_serializes_to_protocol_values() {
        assert_eq!(ApprovalDecision::Accept.to_protocol_value(), serde_json::json!("accept"));
        assert_eq!(ApprovalDecision::Decline.to_protocol_value(), serde_json::json!("decline"));
        assert_eq!(ApprovalDecision::Cancel.to_protocol_value(), serde_json::json!("cancel"));
        assert_eq!(
            ApprovalDecision::AcceptForSession.to_protocol_value(),
            serde_json::json!("acceptForSession")
        );
        // 复合决策是对象形态，不是字符串
        assert!(ApprovalDecision::AcceptWithExecpolicyAmendment
            .to_protocol_value()
            .is_object());
    }

    #[test]
    fn decision_roundtrips_through_protocol() {
        for d in [
            ApprovalDecision::Accept,
            ApprovalDecision::AcceptForSession,
            ApprovalDecision::Decline,
            ApprovalDecision::Cancel,
        ] {
            let s = d.to_protocol_value().as_str().unwrap().to_owned();
            assert_eq!(ApprovalDecision::from_protocol(&s), Some(d));
        }
    }

    #[test]
    fn item_reports_declined_state() {
        let item = Item {
            id: "i1".into(),
            turn_id: "t1".into(),
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
        assert!(item.is_declined());
    }

    #[test]
    fn thread_sorting_prioritizes_pending_approval() {
        let mk = |id: &str, updated: i64, status: TurnStatus| Thread {
            id: id.into(),
            project_id: "p".into(),
            title: None,
            status: ThreadStatus::Active,
            created_at_ms: 0,
            updated_at_ms: updated,
            forked_from_id: None,
            cwd: "/w".into(),
            turns: vec![Turn {
                id: format!("{id}-t"),
                thread_id: id.into(),
                status,
                started_at_ms: None,
                completed_at_ms: None,
                duration_ms: None,
                items: vec![],
            }],
        };

        // b 更新更晚，但 a 有待决审批 → a 必须排在前
        let a = mk("a", 100, TurnStatus::InProgress);
        let b = mk("b", 999, TurnStatus::InProgress);

        let pending = vec![Approval {
            request_id: serde_json::json!(0),
            method: "item/commandExecution/requestApproval".into(),
            thread_id: "a".into(),
            turn_id: "a-t".into(),
            item_id: "i".into(),
            started_at_ms: 0,
            summary: "ls".into(),
            cwd: None,
            reason: None,
            risk: crate::risk::RiskAssessment { tier: crate::risk::RiskTier::Low, signals: vec![] },
            decision: None,
            scope: None,
        }];

        assert!(a.sort_key(&pending) < b.sort_key(&pending), "待审批的线程应排在更前");
    }
}
