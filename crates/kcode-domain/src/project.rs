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
            "userMessage" => ItemBody::UserMessage {
                text: extract_text(item),
                images: extract_local_images(item),
            },
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
            // ── MCP 工具调用 ──────────────────────────────────────────
            //
            // **不能与 dynamicToolCall 合并成一条 arm**：两者字段名不同
            // （`server` vs `namespace`、`result` vs `contentItems`），
            // 合并会让其中一种的字段永远读不到——而那正是早先发生过的事
            // （连 `result` 都只取了 MCP 的形态）。
            //
            // 参数与结果一律存**完整内容**：早先用 `truncate(..., 200)` 在投影期
            // 截断，展开也看不全，而那正是用户想看细节的时刻。截断交给显示层。
            "mcpToolCall" => ItemBody::ToolCall {
                server: item.get("server").and_then(Value::as_str).map(str::to_owned),
                tool: item.get("tool").and_then(Value::as_str).unwrap_or("未知工具").to_owned(),
                args_summary: item.get("arguments").map(pretty_json),
                // MCP 的 result 是 `{ content, structuredContent, _meta }`：
                // 只取前两项，`_meta` 是给程序用的元数据（游标、追踪 id），
                // dump 给用户是纯噪音且往往很占地方。
                result_summary: item.get("result").and_then(format_mcp_result),
                status: item.get("status").and_then(Value::as_str).map(str::to_owned),
                error: item
                    .get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                read_only: item.get("readOnlyHint").and_then(Value::as_bool),
                duration_ms: item.get("durationMs").and_then(Value::as_i64),
            },
            // ── 动态工具（非 MCP）───────────────────────────────────────
            //
            // 命名空间字段叫 `namespace`、结果在 `contentItems`，
            // 且**没有 error 字段**——失败只能从 `success: false` 推断。
            "dynamicToolCall" => ItemBody::ToolCall {
                server: item.get("namespace").and_then(Value::as_str).map(str::to_owned),
                tool: item.get("tool").and_then(Value::as_str).unwrap_or("未知工具").to_owned(),
                args_summary: item.get("arguments").map(pretty_json),
                result_summary: item.get("contentItems").map(pretty_json),
                status: item.get("status").and_then(Value::as_str).map(str::to_owned),
                // 协议没给原因。**如实说明「失败但无原因」比留空强**：
                // 留空会让它看起来像还没跑完，而用户需要知道它已经失败了。
                error: match item.get("success").and_then(Value::as_bool) {
                    Some(false) => Some("调用失败（协议未给出原因）".to_owned()),
                    _ => None,
                },
                read_only: None,
                duration_ms: item.get("durationMs").and_then(Value::as_i64),
            },
            // 模型的函数输出（无独立状态：它必然是某次调用已完成的结果）。
            "functionCallOutput" => ItemBody::ToolCall {
                server: None,
                tool: item.get("name").and_then(Value::as_str).unwrap_or("函数").to_owned(),
                args_summary: None,
                result_summary: item.get("output").map(pretty_json),
                status: None,
                error: None,
                read_only: None,
                duration_ms: None,
            },
            "webSearch" => ItemBody::WebSearch {
                query: item.get("query").and_then(Value::as_str).unwrap_or_default().to_owned(),
            },
            "imageView" => ItemBody::ImageView {
                path: item.get("path").and_then(Value::as_str).unwrap_or_default().to_owned(),
            },
            "contextCompaction" => ItemBody::ContextCompaction,
            // 两个形状不同的协作 item 都归到这里，但**字段各自解析**——
            // 早先只存协议类型名（`ty`），界面于是显示「协作：collabAgentToolCall」：
            // 既是内部术语泄漏，又把「谁在干什么、什么状态」全丢了。
            "collabAgentToolCall" | "subAgentActivity" => ItemBody::CollabAgent {
                source: ty.to_owned(),
                tool: item.get("tool").and_then(Value::as_str).map(str::to_owned),
                status: item.get("status").and_then(Value::as_str).map(str::to_owned),
                receiver_thread_ids: item
                    .get("receiverThreadIds")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(Value::as_str)
                            .map(str::to_owned)
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default(),
                agents: extract_agent_states(item),
                prompt: item.get("prompt").and_then(Value::as_str).map(str::to_owned),
                activity_kind: item.get("kind").and_then(Value::as_str).map(str::to_owned),
                agent_thread_id: item
                    .get("agentThreadId")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                agent_path: item.get("agentPath").and_then(Value::as_str).map(str::to_owned),
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

/// 从 `content[]` 里取出本地图片路径（协议 `localImage`）。
///
/// 服务端会把我们发出去的图片原样回显在 userMessage 的 content 里，
/// 因此**时间线能据此还原「这条消息带了哪几张图」**。
/// 只支持 `localImage`（我们发出去的就是这种）；`image`（URL）是外部图片，
/// 这里不处理以免把网络地址当成本地路径。
fn extract_local_images(item: &Value) -> Vec<String> {
    item.get("content")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter(|c| c.get("type").and_then(Value::as_str) == Some("localImage"))
                .filter_map(|c| c.get("path").and_then(Value::as_str).map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
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

/// 从 `collabAgentToolCall` item 中抽取各子代理的状态表。
///
/// 协议形状是 `agentsStates: { [threadId]: { status, message } }`——是个**映射**，
/// 而 UI 需要的是稳定顺序的列表（映射在 JSON 里没有顺序保证，直接遍历会让
/// 「派了 3 个子代理」的展示顺序每次都可能不同）。这里按 threadId 排序成 Vec。
fn extract_agent_states(item: &Value) -> Vec<AgentState> {
    let Some(map) = item.get("agentsStates").and_then(Value::as_object) else {
        return Vec::new();
    };
    let mut out: Vec<AgentState> = map
        .iter()
        .map(|(thread_id, v)| AgentState {
            thread_id: thread_id.clone(),
            // 兜底用中文：这个值会直接出现在界面上（`agentStatusLabel`
            // 对未识别的取值是原样返回的），漏出英文 `unknown` 是黑话。
            status: v
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("未知")
                .to_owned(),
            message: v.get("message").and_then(Value::as_str).map(str::to_owned),
        })
        .collect();
    out.sort_by(|a, b| a.thread_id.cmp(&b.thread_id));
    out
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

/// 把 MCP 的 `result` 渲染成可读文本。
///
/// 协议形状：`{ content: [...], structuredContent: ..., _meta: ... }`。
///
/// 与 `pretty_json` 的差别在于**按语义取正文**：MCP 的 content 项形如
/// `{ type: "text", text: "..." }`，直接 dump 会把真正要读的文字埋进
/// 花括号与转义里（`{"type":"text","text":"构建通过\n"}`）；这里取 `text`
/// 字段，让结果区读起来就是一段文本。未知类型保留结构化形式，不猜。
fn format_mcp_result(result: &Value) -> Option<String> {
    let obj = result.as_object()?;
    let mut parts: Vec<String> = Vec::new();

    match obj.get("content") {
        Some(Value::Array(items)) => {
            for it in items {
                parts.push(render_content_item(it));
            }
        }
        Some(other) => parts.push(pretty_json(other)),
        None => {}
    }
    if let Some(sc) = obj.get("structuredContent").filter(|v| !v.is_null()) {
        parts.push(pretty_json(sc));
    }

    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n"))
    }
}

/// 渲染 MCP content 数组里的一项：有 `text` 就取它，否则保留结构。
fn render_content_item(item: &Value) -> String {
    if let Some(text) = item.get("text").and_then(Value::as_str) {
        return text.to_owned();
    }
    pretty_json(item)
}

/// 把 JSON 值渲染成可读文本（缩进两格）；不是 JSON 就原样返回字符串。
///
/// 为什么格式化而不是 `to_string()`：MCP 的参数与结果都是嵌套 JSON，
/// 压成一行既难读也难复制（用户会把它贴进另一个工具里用）。缩进后
/// 一眼能看出结构，而这正是「展开看细节」时想要的东西。
fn pretty_json(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => serde_json::to_string_pretty(other).unwrap_or_else(|_| other.to_string()),
    }
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

    /// MCP 调用的状态与错误**必须保留**。
    ///
    /// 这是「失败隐形」的根因：协议在失败时 `result` 为 null，
    /// 若投影不取 `error`，界面上一次失败的调用与「还在跑」完全一样，
    /// 而且没有任何可展开的内容——用户只会觉得「这个工具没反应」。
    #[test]
    fn projects_mcp_call_status_and_error() {
        let p = Projector::new("/ws");
        let item = json!({
            "type": "mcpToolCall",
            "id": "m1",
            "server": "github",
            "tool": "create_issue",
            "status": "failed",
            "arguments": { "title": "x" },
            "result": null,
            "error": { "message": "403 Forbidden" },
            "readOnlyHint": false,
            "durationMs": 830
        });
        match &p.project_item_body(&item) {
            ItemBody::ToolCall { tool, status, error, read_only, duration_ms, result_summary, .. } => {
                assert_eq!(tool, "create_issue");
                assert_eq!(status.as_deref(), Some("failed"));
                assert_eq!(error.as_deref(), Some("403 Forbidden"), "失败原因必须保留");
                assert_eq!(*read_only, Some(false));
                assert_eq!(*duration_ms, Some(830));
                assert!(result_summary.is_none(), "失败时本就没有结果");
            }
            other => panic!("应投影为 ToolCall：{other:?}"),
        }
    }

    /// `readOnlyHint: true` 要能透出——用户在批准前需要知道它不改东西。
    #[test]
    fn projects_mcp_read_only_hint() {
        let p = Projector::new("/ws");
        let item = json!({
            "type": "mcpToolCall", "id": "m2", "server": "fs", "tool": "read_file",
            "status": "inProgress", "arguments": {}, "readOnlyHint": true
        });
        match &p.project_item_body(&item) {
            ItemBody::ToolCall { read_only, .. } => assert_eq!(*read_only, Some(true)),
            other => panic!("{other:?}"),
        }
    }

    /// MCP 的 result 按语义渲染：取 content 里的正文、丢掉 `_meta`。
    #[test]
    fn mcp_result_is_rendered_by_semantics_not_dumped() {
        let p = Projector::new("/ws");
        let item = json!({
            "type": "mcpToolCall", "id": "m3", "server": "fs", "tool": "read",
            "status": "completed", "arguments": {},
            "result": {
                "content": [
                    { "type": "text", "text": "构建通过" },
                    { "type": "text", "text": "0 warnings" }
                ],
                "structuredContent": { "ok": true },
                "_meta": { "cursor": "SECRET-INTERNAL-CURSOR", "traceId": "abc" }
            }
        });
        let body = p.project_item_body(&item);
        let ItemBody::ToolCall { result_summary, .. } = &body else { panic!("{body:?}") };
        let out = result_summary.as_deref().unwrap_or("");
        // 正文直接可读，而不是埋进 {"type":"text","text":"…"} 里
        assert!(out.contains("构建通过"), "应取 text 正文：{out}");
        assert!(out.contains("0 warnings"));
        assert!(out.contains("ok"), "structuredContent 应保留");
        // `_meta` 是给程序看的元数据，不该 dump 给用户
        assert!(!out.contains("SECRET-INTERNAL-CURSOR"), "_meta 不该展示：{out}");
        assert!(!out.contains("traceId"));
    }

    /// 动态工具与 MCP 的字段名**不同**，必须各自解析。
    #[test]
    fn projects_dynamic_tool_call_with_its_own_field_names() {
        let p = Projector::new("/ws");
        let item = json!({
            "type": "dynamicToolCall",
            "id": "d1",
            "namespace": "custom_ns",
            "tool": "do_thing",
            "status": "failed",
            "success": false,
            "arguments": { "a": 1 },
            "contentItems": [{ "type": "text", "text": "boom" }],
            "durationMs": 42
        });
        match &p.project_item_body(&item) {
            ItemBody::ToolCall { server, tool, status, error, result_summary, duration_ms, .. } => {
                // 命名空间字段叫 namespace（不是 server）——合并成一条 arm 会读不到
                assert_eq!(server.as_deref(), Some("custom_ns"), "应读 namespace");
                assert_eq!(tool, "do_thing");
                assert_eq!(status.as_deref(), Some("failed"));
                // 协议没给原因，但要如实说明「失败了」而不是留空
                assert!(error.is_some(), "success=false 必须转成可见的失败说明");
                assert!(result_summary.is_some(), "结果在 contentItems 里");
                assert_eq!(*duration_ms, Some(42));
            }
            other => panic!("{other:?}"),
        }
    }

    /// 缺 tool 名时的兜底必须是中文（它会直接显示在时间线上）。
    #[test]
    fn missing_tool_name_falls_back_to_chinese() {
        let p = Projector::new("/ws");
        let item = json!({ "type": "mcpToolCall", "id": "m4", "server": "x", "status": "completed" });
        match &p.project_item_body(&item) {
            ItemBody::ToolCall { tool, .. } => {
                assert_eq!(tool, "未知工具", "不该漏出英文 unknown");
            }
            other => panic!("{other:?}"),
        }
    }

    /// 子代理信息**必须解析成可用字段**，而不是协议类型名。
    ///
    /// 这条测试守的是一个真实缺陷：早先 `CollabAgent` 只存一个 description，
    /// 而填进去的是 `item["type"]`——界面直接显示「协作：collabAgentToolCall」。
    /// 既是内部术语泄漏，又把「谁在干、什么状态」全丢了。
    #[test]
    fn projects_collab_agent_tool_call_fields() {
        let p = Projector::new("/ws");
        // 形状取自协议 CollabAgentToolCall（字段名与类型按 schema 构造）
        let item = json!({
            "type": "collabAgentToolCall",
            "id": "c1",
            "tool": "spawnAgent",
            "status": "inProgress",
            "senderThreadId": "th-main",
            "receiverThreadIds": ["th-sub-1", "th-sub-2"],
            "prompt": "调研一下这个协议",
            "model": null,
            "reasoningEffort": null,
            "agentsStates": {
                "th-sub-2": { "status": "running", "message": null },
                "th-sub-1": { "status": "completed", "message": "done" }
            }
        });
        let body = p.project_item_body(&item);
        match &body {
            ItemBody::CollabAgent {
                source, tool, status, receiver_thread_ids, agents, prompt, ..
            } => {
                assert_eq!(source, "collabAgentToolCall");
                assert_eq!(tool.as_deref(), Some("spawnAgent"));
                assert_eq!(status.as_deref(), Some("inProgress"));
                assert_eq!(receiver_thread_ids.len(), 2, "两个对端代理都要保留");
                assert_eq!(prompt.as_deref(), Some("调研一下这个协议"));
                assert_eq!(agents.len(), 2);
                // 排序保证展示稳定：JSON 映射本身无序，直接遍历会让顺序随机
                assert_eq!(agents[0].thread_id, "th-sub-1", "应按 threadId 排序");
                assert_eq!(agents[0].status, "completed");
                assert_eq!(agents[0].message.as_deref(), Some("done"));
                assert_eq!(agents[1].status, "running");
            }
            other => panic!("应投影为 CollabAgent：{other:?}"),
        }
    }

    /// `subAgentActivity` 是另一种形状，字段名完全不同——必须各自解析。
    #[test]
    fn projects_sub_agent_activity_fields() {
        let p = Projector::new("/ws");
        let item = json!({
            "type": "subAgentActivity",
            "id": "a1",
            "kind": "completed",
            "agentThreadId": "th-sub-9",
            "agentPath": "/root/agents/sub-9"
        });
        match &p.project_item_body(&item) {
            ItemBody::CollabAgent {
                source,
                activity_kind,
                agent_thread_id,
                agent_path,
                tool,
                agents,
                ..
            } => {
                assert_eq!(source, "subAgentActivity");
                assert_eq!(activity_kind.as_deref(), Some("completed"));
                assert_eq!(agent_thread_id.as_deref(), Some("th-sub-9"));
                assert_eq!(agent_path.as_deref(), Some("/root/agents/sub-9"));
                // 这两个字段只属于 collabAgentToolCall，此处应为空——
                // 若解析时错用了同一组字段名，这里会非空
                assert!(tool.is_none(), "subAgentActivity 没有 tool 字段");
                assert!(agents.is_empty(), "subAgentActivity 没有 agentsStates");
            }
            other => panic!("应投影为 CollabAgent：{other:?}"),
        }
    }

    /// 缺失 `agentsStates` 时不应 panic，也不该编造代理。
    #[test]
    fn collab_agent_without_agents_states_is_empty_not_fabricated() {
        let p = Projector::new("/ws");
        let item = json!({
            "type": "collabAgentToolCall",
            "id": "c2",
            "tool": "wait",
            "status": "completed",
            "senderThreadId": "th-main",
            "receiverThreadIds": []
        });
        match &p.project_item_body(&item) {
            ItemBody::CollabAgent { agents, receiver_thread_ids, .. } => {
                assert!(agents.is_empty(), "没有状态表就不该造出代理");
                assert!(receiver_thread_ids.is_empty());
            }
            other => panic!("应投影为 CollabAgent：{other:?}"),
        }
    }
}
