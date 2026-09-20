//! 协议事件 → 领域状态的投影。
//!
//! 这是 L1 与 L2 的接缝：协议报文进来，领域状态出去。前端只看到后者的形状。
//!
//! # 两个必须做对的地方
//!
//! 1. **审批请求要立即算风险。** 协议不给风险字段，分级必须在这里做，
//!    且结果只是展示用（见 [`crate::risk`] 的硬约束）。
//! 2. **`declined` 要投影成独立状态。** 若把它归并进 `completed`，
//!    UI 会把「用户拒绝了、命令没跑」显示成「已完成」——这是最坏的一种错误显示。

use crate::changeset::{ChangeOrigin, ChangeSet, FileChangeEntry, FileChangeKind};
use crate::model::*;
use crate::risk::{self, RiskAssessment};
use kcode_bridge::Incoming;
use serde_json::Value;
use std::path::{Path, PathBuf};

/// 投影上下文：把协议报文翻译成领域对象所需的静态信息。
pub struct Projector {
    /// 工作区根路径，用于风险分级中的「区外」判断。
    pub workspace: PathBuf,
}

impl Projector {
    pub fn new(workspace: impl Into<PathBuf>) -> Self {
        Self { workspace: workspace.into() }
    }

    /// 把协议 `item` 载荷投影为领域 [`ItemBody`]。
    ///
    /// 未知的协议类型落到 [`ItemBody::Other`] 而不是丢弃——协议是实验性的，
    /// 静默丢弃会让用户看到一个「少了东西」的时间线而无从察觉。
    pub fn project_item_body(&self, item: &Value) -> ItemBody {
        let ty = item.get("type").and_then(Value::as_str).unwrap_or("");
        match ty {
            "userMessage" => ItemBody::UserMessage { text: extract_text(item) },
            "agentMessage" => ItemBody::AgentMessage { text: extract_text(item) },
            "reasoning" => ItemBody::Reasoning { text: extract_text(item) },
            "plan" => ItemBody::Plan {
                text: item.get("text").and_then(Value::as_str).unwrap_or_default().to_owned(),
            },
            "commandExecution" => {
                let status = item
                    .get("status")
                    .and_then(Value::as_str)
                    .and_then(ItemStatus::from_protocol)
                    .unwrap_or(ItemStatus::InProgress);
                ItemBody::CommandExecution {
                    command: item
                        .get("command")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                    cwd: item.get("cwd").and_then(Value::as_str).map(str::to_owned),
                    status,
                    exit_code: item.get("exitCode").and_then(Value::as_i64),
                    aggregated_output: item
                        .get("aggregatedOutput")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    duration_ms: item.get("durationMs").and_then(Value::as_i64),
                }
            }
            "fileChange" => {
                let status = item
                    .get("status")
                    .and_then(Value::as_str)
                    .and_then(ItemStatus::from_protocol)
                    .unwrap_or(ItemStatus::InProgress);
                ItemBody::FileChange {
                    status,
                    changes: extract_changes(item),
                }
            }
            "mcpToolCall" | "dynamicToolCall" => ItemBody::ToolCall {
                server: item.get("server").and_then(Value::as_str).map(str::to_owned),
                tool: item.get("tool").and_then(Value::as_str).unwrap_or("unknown").to_owned(),
                args_summary: item.get("arguments").map(|v| truncate(&v.to_string(), 200)),
                result_summary: item.get("result").map(|v| truncate(&v.to_string(), 200)),
            },
            "functionCallOutput" => ItemBody::ToolCall {
                server: None,
                tool: item.get("name").and_then(Value::as_str).unwrap_or("function").to_owned(),
                args_summary: None,
                result_summary: item.get("output").map(|v| truncate(&v.to_string(), 200)),
            },
            "webSearch" => ItemBody::WebSearch {
                query: item.get("query").and_then(Value::as_str).unwrap_or_default().to_owned(),
            },
            "imageView" => ItemBody::ImageView {
                path: item.get("path").and_then(Value::as_str).unwrap_or_default().to_owned(),
            },
            "contextCompaction" => ItemBody::ContextCompaction,
            "collabAgentToolCall" | "subAgentActivity" => ItemBody::CollabAgent {
                description: ty.to_owned(),
            },
            other => ItemBody::Other { protocol_type: other.to_owned() },
        }
    }

    /// 把协议 item 投影为完整领域 [`Item`]。
    pub fn project_item(&self, thread_id: &str, turn_id: &str, item: &Value) -> Item {
        let _ = thread_id;
        Item {
            id: item.get("id").and_then(Value::as_str).unwrap_or("unknown").to_owned(),
            turn_id: turn_id.to_owned(),
            body: self.project_item_body(item),
            created_at_ms: now_ms(),
        }
    }

    /// 把服务端审批请求投影为领域 [`Approval`]，并就地完成风险分级。
    ///
    /// 风险输入全部取自协议参数（命令、cwd、可写根、网络上下文、提权标记），
    /// 外加模型自述的 reason。**不使用任何猜测性信息。**
    pub fn project_approval(&self, method: &str, request_id: &Value, params: &Value) -> Approval {
        let command = params
            .get("command")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let cwd = params.get("cwd").and_then(Value::as_str).unwrap_or_default().to_owned();
        let grant_root = params.get("grant_root").and_then(Value::as_str).map(PathBuf::from);
        let reason = params.get("reason").and_then(Value::as_str).map(str::to_owned);
        let has_network = params
            .get("networkApprovalContext")
            .map(|v| !v.is_null())
            .unwrap_or(false);

        // 命令是否主动申请提权：由协议参数给出，不靠文本推断。
        // 实测：模型通过 exec_command 的 sandbox_permissions=require_escalated 触发审批。
        let escalation_requested = params
            .get("commandActions")
            .and_then(Value::as_array)
            .map(|actions| {
                actions.iter().any(|a| {
                    a.get("type").and_then(Value::as_str) == Some("unknown")
                        || a.get("type").is_none()
                })
            })
            .unwrap_or(false);

        // 文件审批没有 command 字段，用 grantRoot / reason 作为摘要
        let summary = if command.is_empty() {
            let mut parts = Vec::new();
            if let Some(g) = &grant_root {
                parts.push(format!("写入根: {}", g.display()));
            }
            if let Some(r) = &reason {
                parts.push(r.clone());
            }
            if parts.is_empty() {
                method.to_owned()
            } else {
                parts.join(" · ")
            }
        } else {
            command.clone()
        };

        let cwd_path = if cwd.is_empty() { self.workspace.clone() } else { PathBuf::from(&cwd) };
        let risk = if command.is_empty() {
            // 非命令类审批：无法做文本分级，按协议给出的线索判定
            let mut signals = Vec::new();
            if let Some(g) = &grant_root {
                if !g.starts_with(&self.workspace) {
                    signals.push(risk::RiskSignal::WriteRootRequested {
                        root: g.display().to_string(),
                    });
                }
            }
            if has_network {
                signals.push(risk::RiskSignal::NetworkApprovalRequested);
            }
            if signals.is_empty() {
                RiskAssessment {
                    tier: risk::RiskTier::Moderate,
                    signals: vec![risk::RiskSignal::UnparsedCommand],
                }
            } else {
                // 复用统一的分级入口，保证等级推导规则只有一处
                risk::classify(&risk::RiskInput {
                    command: "",
                    cwd: &cwd_path,
                    workspace: &self.workspace,
                    reason: reason.as_deref(),
                    grant_root: grant_root.as_deref(),
                    has_network_context: has_network,
                    escalation_requested: false,
                })
            }
        } else {
            risk::classify(&risk::RiskInput {
                command: &command,
                cwd: &cwd_path,
                workspace: &self.workspace,
                reason: reason.as_deref(),
                grant_root: grant_root.as_deref(),
                has_network_context: has_network,
                escalation_requested,
            })
        };

        Approval {
            request_id: request_id.clone(),
            method: method.to_owned(),
            thread_id: params
                .get("threadId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            turn_id: params
                .get("turnId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            item_id: params
                .get("itemId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            started_at_ms: params.get("startedAtMs").and_then(Value::as_i64).unwrap_or_else(now_ms),
            summary,
            cwd: if cwd.is_empty() { None } else { Some(cwd) },
            reason,
            risk,
            decision: None,
            scope: None,
        }
    }

    /// 从 `fileChange` item 聚合出该轮次的 [`ChangeSet`]。
    ///
    /// `origin` 必须由调用方给出：审批请求携带的是**已提议**（未落盘），
    /// Item 完成回传的是**已应用**。二者混用会让用户拒绝后仍看到「已变更」。
    pub fn change_set_from_item(
        &self,
        thread_id: &str,
        turn_id: &str,
        item: &Value,
        origin: ChangeOrigin,
    ) -> Option<ChangeSet> {
        if item.get("type").and_then(Value::as_str) != Some("fileChange") {
            return None;
        }
        let mut cs = ChangeSet::new(thread_id, turn_id, origin);
        cs.upsert_files(extract_changes(item));
        Some(cs)
    }

    /// 解析 `turn/diff/updated` 通知携带的整轮 diff。
    ///
    /// 该通知提供整个轮次的统一 diff 文本，用于总览与冲突判断；
    /// 逐文件审阅仍应使用 `fileChange` Item 的结构化 `changes`。
    pub fn parse_turn_diff(&self, diff: &str) -> crate::changeset::ParsedDiff {
        crate::changeset::parse_unified_diff(diff)
    }

    /// 从 `turn/completed` 通知中投影出 Turn 状态。
    pub fn project_turn_status(turn: &Value) -> Option<TurnStatus> {
        turn.get("status")
            .and_then(Value::as_str)
            .and_then(TurnStatus::from_protocol)
    }

    /// 判断入站报文是否为终态通知（用于轮次收尾）。
    pub fn is_turn_completed(incoming: &Incoming) -> bool {
        matches!(incoming, Incoming::Notification { method, .. } if method == "turn/completed")
    }

    /// 判断入站报文是否表示某个审批请求已被解决。
    ///
    /// 服务端在请求被解决后广播 `serverRequest/resolved`。多客户端或超时竞争时，
    /// 本端靠它收敛待决状态——否则会一直显示「等待审批」。
    pub fn resolved_request_id(incoming: &Incoming) -> Option<&Value> {
        match incoming {
            Incoming::Notification { method, params } if method == "serverRequest/resolved" => {
                params.get("requestId")
            }
            _ => None,
        }
    }
}

fn extract_text(item: &Value) -> String {
    // 消息类 Item 的文本可能在 `text`，也可能是 `content` 数组
    if let Some(t) = item.get("text").and_then(Value::as_str) {
        return t.to_owned();
    }
    if let Some(arr) = item.get("content").and_then(Value::as_array) {
        let mut parts = Vec::new();
        for c in arr {
            if let Some(t) = c.get("text").and_then(Value::as_str) {
                parts.push(t.to_owned());
            }
        }
        if !parts.is_empty() {
            return parts.join("\n");
        }
        if let Some(s) = item.get("summary").and_then(Value::as_array) {
            let joined: Vec<String> = s
                .iter()
                .filter_map(|v| v.get("text").and_then(Value::as_str).map(str::to_owned))
                .collect();
            return joined.join("\n");
        }
    }
    String::new()
}

/// 从 `fileChange` item 中抽取变更条目。
///
/// **必须保留 `diff` 字段。** 协议 `FileUpdateChange` 的形态是
/// `{ path, kind: PatchChangeKind, diff: string }`——diff 由协议直接提供，
/// 不需要本地计算。早先的实现只取了 path 与变更类型，把 diff 丢掉了，
/// 导致前端根本拿不到可审阅内容（审阅面板因此无法工作）。
fn extract_changes(item: &Value) -> Vec<FileChangeEntry> {
    let mut out = Vec::new();
    let Some(changes) = item.get("changes") else { return out };

    // 主形态：数组 [{ path, kind: {type}, diff }]
    if let Some(arr) = changes.as_array() {
        for c in arr {
            let path = c
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let kind = c
                .get("kind")
                .map(FileChangeKind::from_protocol)
                .unwrap_or(FileChangeKind::Update { move_path: None });
            let diff = c.get("diff").and_then(Value::as_str).unwrap_or_default().to_owned();
            out.push(FileChangeEntry { path, kind, diff });
        }
        return out;
    }

    // 兼容形态：对象映射 { "path": { type: "add", diff: "..." } }
    if let Some(map) = changes.as_object() {
        for (path, detail) in map {
            let kind = detail
                .get("kind")
                .map(FileChangeKind::from_protocol)
                .or_else(|| {
                    detail
                        .get("type")
                        .and_then(Value::as_str)
                        .map(|t| FileChangeKind::from_protocol(&serde_json::json!({ "type": t })))
                })
                .unwrap_or(FileChangeKind::Update { move_path: None });
            let diff = detail
                .get("diff")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            out.push(FileChangeEntry { path: path.clone(), kind, diff });
        }
    }
    out
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_owned();
    }
    let cut: String = s.chars().take(max).collect();
    format!("{cut}…")
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 把 `Path` 转成便于展示的字符串。
pub fn display_path(p: &Path) -> String {
    p.display().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::changeset::ChangeOrigin;
    use serde_json::json;

    fn projector() -> Projector {
        Projector::new("/work/repo")
    }

    #[test]
    fn projects_command_execution_with_declined_status() {
        let p = projector();
        let item = json!({
            "type": "commandExecution", "id": "i1",
            "command": "rm -rf /", "status": "declined", "exitCode": null
        });
        let body = p.project_item_body(&item);
        match &body {
            ItemBody::CommandExecution { status, exit_code, .. } => {
                assert_eq!(*status, ItemStatus::Declined);
                assert_eq!(*exit_code, None);
            }
            other => panic!("投影错误: {other:?}"),
        }
        let full = p.project_item("th", "tu", &item);
        assert!(full.is_declined(), "declined 必须能被识别");
    }

    #[test]
    fn declined_is_not_conflated_with_completed() {
        let p = projector();
        let declined = p.project_item_body(&json!({
            "type": "commandExecution", "id": "i", "command": "x", "status": "declined"
        }));
        let completed = p.project_item_body(&json!({
            "type": "commandExecution", "id": "i", "command": "x", "status": "completed", "exitCode": 0
        }));
        assert_ne!(declined, completed, "declined 与 completed 必须可区分");
    }

    #[test]
    fn projects_file_change_with_diff_and_kind() {
        let p = projector();
        // 协议真实形态：changes 是数组，每项含 path / kind / diff
        let item = json!({
            "type": "fileChange", "id": "f1", "status": "declined",
            "changes": [
                // 实测：add 的 diff 是**完整文件内容**，不是 unified diff
                { "path": "src/a.rs", "kind": {"type": "add"}, "diff": "hello\n" },
                { "path": "src/b.rs", "kind": {"type": "delete"}, "diff": "" }
            ]
        });
        let body = p.project_item_body(&item);
        match &body {
            ItemBody::FileChange { status, changes } => {
                assert_eq!(*status, ItemStatus::Declined);
                assert_eq!(changes.len(), 2);

                let a = changes.iter().find(|c| c.path == "src/a.rs").unwrap();
                assert_eq!(a.kind, FileChangeKind::Add);
                assert!(!a.diff.is_empty(), "diff 内容被丢弃了——审阅面板将无内容可显示");
                assert_eq!(a.line_stats().added, 1);

                let b = changes.iter().find(|c| c.path == "src/b.rs").unwrap();
                assert_eq!(b.kind, FileChangeKind::Delete);
            }
            other => panic!("投影错误: {other:?}"),
        }
    }

    #[test]
    fn projects_rename_as_update_with_move_path() {
        // 协议用 update + movePath 表达重命名，不是独立类型
        let p = projector();
        let item = json!({
            "type": "fileChange", "id": "f", "status": "completed",
            "changes": [{ "path": "old.rs", "kind": {"type":"update","movePath":"new.rs"}, "diff": "" }]
        });
        match p.project_item_body(&item) {
            ItemBody::FileChange { changes, .. } => {
                assert_eq!(
                    changes[0].kind,
                    FileChangeKind::Update { move_path: Some("new.rs".into()) }
                );
                assert_eq!(changes[0].kind.label(), "重命名");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn change_set_origin_distinguishes_proposed_from_applied() {
        let p = projector();
        let item = json!({
            "type": "fileChange", "id": "f", "status": "inProgress",
            // 实测：add 的 diff 是纯内容
            "changes": [{"path": "a.rs", "kind": {"type":"add"}, "diff": "x\n"}]
        });
        let proposed = p
            .change_set_from_item("th", "tu", &item, ChangeOrigin::Proposed)
            .expect("应产出 ChangeSet");
        let applied = p
            .change_set_from_item("th", "tu", &item, ChangeOrigin::Applied)
            .expect("应产出 ChangeSet");
        assert_ne!(proposed.origin, applied.origin);
        assert_eq!(proposed.files.len(), 1);
        assert_eq!(proposed.total_stats().added, 1);
    }

    #[test]
    fn change_set_ignores_non_file_change_items() {
        let p = projector();
        let item = json!({"type": "commandExecution", "id": "c", "command": "ls", "status": "completed"});
        assert!(p.change_set_from_item("th", "tu", &item, ChangeOrigin::Applied).is_none());
    }

    /// **逐字取自真实 DeepSeek 模型经 app-server 产生的载荷**。
    ///
    /// 之前所有 fileChange 测试用的都是构造数据。这一条用真机载荷，
    /// 确保解析在真实形态下成立（尤其是 changes 是数组而非映射、
    /// diff 是不含文件头的 hunk、路径是绝对路径）。
    #[test]
    fn projects_real_payload_from_live_model() {
        let p = Projector::new("/ws");
        let item = json!({
            "type": "fileChange",
            "id": "call_00_TRitYJSqYoOXoIGdCG7b8072",
            "changes": [{
                "path": "/var/folders/23/kt7_yffx01jc_06zmr88tfx80000gn/T/tmp.QeHHhACWXT/calc.py",
                "kind": { "type": "update", "move_path": null },
                "diff": "@@ -2 +2,4 @@\n     return a+b\n+\n+def multiply(a,b):\n+    return a*b\n"
            }],
            "status": "completed"
        });

        let body = p.project_item_body(&item);
        match &body {
            ItemBody::FileChange { status, changes } => {
                assert_eq!(*status, ItemStatus::Completed);
                assert_eq!(changes.len(), 1, "changes 是数组，应解析出 1 项");

                let c = &changes[0];
                assert!(c.path.ends_with("calc.py"), "路径: {}", c.path);
                assert_eq!(c.kind, FileChangeKind::Update { move_path: None });

                // diff 是 hunk，不含文件头；应能解析出 3 行新增
                let st = c.line_stats();
                assert_eq!(st.added, 3, "真实载荷应统计 3 行新增，实际 {st:?}");
                assert_eq!(st.removed, 0);

                let parsed = c.parsed();
                assert_eq!(parsed.hunks.len(), 1, "应解析出 1 个 hunk");
                assert!(parsed.warnings.is_empty(), "真实载荷不应有解析警告: {:?}", parsed.warnings);
                // 绝对路径应可相对化
                assert_eq!(c.display_path(Some(std::path::Path::new("/var/folders/23/kt7_yffx01jc_06zmr88tfx80000gn/T/tmp.QeHHhACWXT"))), "calc.py");
            }
            other => panic!("投影错误: {other:?}"),
        }
    }

    /// 真实 `turn/diff/updated` 载荷（标准 unified diff）。
    #[test]
    fn parses_real_turn_diff_from_live_model() {
        let p = Projector::new("/ws");
        // 注意：**不能**用 `\n\` 续行——续行反斜杠会吞掉下一行的行首空格，
        // 而上下文行的前导空格正是 diff 格式的一部分。用 concat 保持原样。
        let real = concat!(
            "diff --git a/calc.py b/calc.py\n",
            "index f083797c39285e47b994854fe9bb9277b4e5f5ef..7ba777626de3dd766fb957d80e549b60d3230673 100644\n",
            "--- a/calc.py\n",
            "+++ b/calc.py\n",
            "@@ -1,2 +1,5 @@\n",
            " def add(a,b):\n",
            "     return a+b\n",
            "+\n",
            "+def multiply(a,b):\n",
            "+    return a*b\n",
        );
        let parsed = p.parse_turn_diff(real);
        assert_eq!(parsed.old_path.as_deref(), Some("calc.py"));
        assert_eq!(parsed.new_path.as_deref(), Some("calc.py"));
        assert_eq!(parsed.hunks.len(), 1);
        assert_eq!(parsed.stats(), crate::changeset::DiffStats { added: 3, removed: 0 });
        assert!(parsed.warnings.is_empty(), "{:?}", parsed.warnings);
    }

    #[test]
    fn parses_turn_diff_notification() {
        let p = projector();
        let parsed = p.parse_turn_diff("@@ -1 +1 @@\n-old\n+new\n");
        assert_eq!(parsed.hunks.len(), 1);
        assert_eq!(parsed.stats().added, 1);
        assert_eq!(parsed.stats().removed, 1);
    }

    #[test]
    fn unknown_protocol_type_is_preserved_not_dropped() {
        // 协议是实验性的；静默丢弃会让用户看到缺失的时间线
        let p = projector();
        let body = p.project_item_body(&json!({ "type": "someFutureItem", "id": "x" }));
        match body {
            ItemBody::Other { protocol_type } => assert_eq!(protocol_type, "someFutureItem"),
            other => panic!("未知类型应落到 Other: {other:?}"),
        }
    }

    #[test]
    fn approval_risk_is_computed_during_projection() {
        let p = projector();
        let params = json!({
            "threadId": "th1", "turnId": "tu1", "itemId": "i1", "startedAtMs": 123,
            "command": "cat .env", "cwd": "/work/repo", "reason": "读取配置"
        });
        let a = p.project_approval("item/commandExecution/requestApproval", &json!(0), &params);

        assert_eq!(a.thread_id, "th1");
        assert_eq!(a.turn_id, "tu1");
        assert_eq!(a.item_id, "i1");
        assert_eq!(a.started_at_ms, 123);
        assert_eq!(a.summary, "cat .env");
        assert!(a.is_pending());
        // 凭据访问应为高风险
        assert!(a.risk.is_blocking(), "风险 {:?}", a.risk);
    }

    #[test]
    fn approval_for_workspace_command_is_not_blocking() {
        let p = projector();
        let params = json!({
            "threadId": "th1", "turnId": "tu1", "itemId": "i1", "startedAtMs": 1,
            "command": "npm test", "cwd": "/work/repo"
        });
        let a = p.project_approval("item/commandExecution/requestApproval", &json!(0), &params);
        assert!(!a.risk.is_blocking(), "工作区内跑测试不该阻塞；风险 {:?}", a.risk);
    }

    #[test]
    fn approval_outside_workspace_write_is_blocking() {
        let p = projector();
        let params = json!({
            "threadId": "th", "turnId": "tu", "itemId": "i", "startedAtMs": 1,
            "command": "echo pwned > /etc/passwd", "cwd": "/work/repo"
        });
        let a = p.project_approval("item/commandExecution/requestApproval", &json!(0), &params);
        assert!(a.risk.is_blocking(), "区外写入必须阻塞；风险 {:?}", a.risk);
    }

    #[test]
    fn request_id_is_preserved_verbatim() {
        // 回应审批必须原样带回 id，形态（数字/字符串）不能被改写
        let p = projector();
        let params = json!({ "threadId": "t", "turnId": "u", "itemId": "i", "startedAtMs": 1, "command": "ls" });
        let a = p.project_approval("m", &json!(7), &params);
        assert_eq!(a.request_id, json!(7));
        let b = p.project_approval("m", &json!("srv-1"), &params);
        assert_eq!(b.request_id, json!("srv-1"));
    }

    #[test]
    fn file_approval_without_command_gets_sensible_summary() {
        let p = projector();
        let params = json!({
            "threadId": "t", "turnId": "u", "itemId": "i", "startedAtMs": 1,
            "grant_root": "/work/repo/src", "reason": "需要写入新文件"
        });
        let a = p.project_approval("item/fileChange/requestApproval", &json!(0), &params);
        assert!(a.summary.contains("写入根") || a.summary.contains("需要写入"), "摘要: {}", a.summary);
    }

    #[test]
    fn grant_root_outside_workspace_raises_risk() {
        let p = projector();
        let params = json!({
            "threadId": "t", "turnId": "u", "itemId": "i", "startedAtMs": 1,
            "grant_root": "/tmp/elsewhere", "reason": "写入外部目录"
        });
        let a = p.project_approval("item/fileChange/requestApproval", &json!(0), &params);
        assert!(a.risk.is_blocking(), "区外可写根应为高风险；实际 {:?}", a.risk);
    }

    #[test]
    fn network_context_raises_risk() {
        let p = projector();
        let params = json!({
            "threadId": "t", "turnId": "u", "itemId": "i", "startedAtMs": 1,
            "command": "curl https://example.com", "cwd": "/work/repo",
            "networkApprovalContext": { "protocol": "https", "host": "example.com" }
        });
        let a = p.project_approval("item/commandExecution/requestApproval", &json!(0), &params);
        assert!(
            a.risk.signals.iter().any(|s| matches!(s, risk::RiskSignal::NetworkApprovalRequested)),
            "网络上下文未被采信；信号 {:?}", a.risk.signals
        );
    }

    #[test]
    fn turn_status_projection_handles_all_four_values() {
        for (raw, expected) in [
            ("inProgress", TurnStatus::InProgress),
            ("completed", TurnStatus::Completed),
            ("interrupted", TurnStatus::Interrupted),
            ("failed", TurnStatus::Failed),
        ] {
            let got = Projector::project_turn_status(&json!({ "status": raw }));
            assert_eq!(got, Some(expected));
        }
        // 派生状态不是协议状态，不应被接受
        assert_eq!(Projector::project_turn_status(&json!({ "status": "awaiting_approval" })), None);
    }

    #[test]
    fn extracts_resolved_request_id() {
        let incoming = Incoming::Notification {
            method: "serverRequest/resolved".into(),
            params: json!({ "requestId": 0, "threadId": "th" }),
        };
        assert_eq!(Projector::resolved_request_id(&incoming), Some(&json!(0)));

        let other = Incoming::Notification { method: "turn/started".into(), params: json!({}) };
        assert_eq!(Projector::resolved_request_id(&other), None);
    }

    #[test]
    fn detects_turn_completed_notification() {
        let done = Incoming::Notification { method: "turn/completed".into(), params: json!({}) };
        assert!(Projector::is_turn_completed(&done));

        let other = Incoming::Notification { method: "turn/started".into(), params: json!({}) };
        assert!(!Projector::is_turn_completed(&other));
    }

    #[test]
    fn extracts_text_from_content_array() {
        let p = projector();
        let item = json!({
            "type": "agentMessage", "id": "m",
            "content": [{ "type": "output_text", "text": "第一行" }, { "type": "output_text", "text": "第二行" }]
        });
        match p.project_item_body(&item) {
            ItemBody::AgentMessage { text } => assert_eq!(text, "第一行\n第二行"),
            other => panic!("{other:?}"),
        }
    }
}
