//! **跨语言线格式契约测试。**
//!
//! # 为什么需要单独一层测试
//!
//! 前端（TypeScript）按 camelCase 读字段，Rust 按 snake_case 写字段。
//! 这个差异**不产生任何编译错误**——只会让前端拿到 `undefined`。
//! Rust 侧的值断言全绿，UI 却什么都不显示。
//!
//! 本项目已在三处踩到它：
//!
//! 1. `ItemBody` 的变体字段（`exit_code` → 前端读 `exitCode` 得到 undefined）
//! 2. `AppEvent` 的变体字段（事件名对了，载荷字段没对）
//! 3. `Approval` 等嵌套结构体（外层修了，内层没修）
//!
//! 根因是 serde 的 `rename_all` **作用域很窄**：
//! - 写在 enum 容器上 → 只重命名**变体名**，不碰变体内部字段
//! - 写在 struct 上 → 只作用于**该 struct 自己的**字段，不含嵌套类型
//!
//! 因此本测试对**所有会跨语言传输的类型**逐个断言线格式，作为兜底防线。
//! 新增任何交给前端的类型，都必须在这里登记。

use kcode_app::AppEvent;
use kcode_domain::{
    Approval, ApprovalDecision, ApprovalScope, ChangeSet, Item, ItemBody, ItemStatus,
    RiskAssessment, RiskSignal, RiskTier, Thread, ThreadStatus, Turn, TurnStatus,
};
use serde_json::json;

/// 递归收集 JSON 对象中所有键名，用于检测 snake_case 漏网。
fn all_keys(v: &serde_json::Value, out: &mut Vec<String>) {
    match v {
        serde_json::Value::Object(map) => {
            for (k, val) in map {
                out.push(k.clone());
                all_keys(val, out);
            }
        }
        serde_json::Value::Array(arr) => {
            for item in arr {
                all_keys(item, out);
            }
        }
        _ => {}
    }
}

/// 断言序列化结果中不含 snake_case 字段。
///
/// 允许的白名单：协议原样透传的枚举值（如 `read_only` 这类协议取值本身
/// 就是 snake_case，它们出现在 **值** 而非 **键** 的位置，不受影响）。
fn assert_no_snake_case_keys(value: &serde_json::Value, what: &str) {
    let mut keys = Vec::new();
    all_keys(value, &mut keys);
    let bad: Vec<&String> = keys
        .iter()
        .filter(|k| k.contains('_') && !k.starts_with('_'))
        .collect();
    assert!(
        bad.is_empty(),
        "{what} 的线上报文含 snake_case 键: {bad:?}\n\
         完整报文: {}\n\
         原因：serde 的 rename_all 只作用于它所在的那一层——\
         enum 容器上只改变体名，struct 上只管自己的字段，嵌套类型需各自标注。",
        serde_json::to_string_pretty(value).unwrap_or_default()
    );
}

#[test]
fn item_body_wire_format_is_camel_case() {
    let variants = vec![
        ItemBody::UserMessage { text: "hi".into() },
        ItemBody::AgentMessage { text: "hi".into() },
        ItemBody::Reasoning { text: "thinking".into() },
        ItemBody::Plan { text: "plan".into() },
        ItemBody::CommandExecution {
            command: "npm test".into(),
            cwd: Some("/w".into()),
            status: ItemStatus::Declined,
            exit_code: None,
            aggregated_output: None,
            duration_ms: Some(12),
        },
        ItemBody::FileChange {
            status: ItemStatus::Completed,
            changes: vec![kcode_domain::FileChangeEntry {
                path: "a.rs".into(),
                kind: kcode_domain::FileChangeKind::Update { move_path: None },
                diff: "@@ -1 +1 @@\n-a\n+b\n".into(),
            }],
        },
        ItemBody::ToolCall {
            server: Some("mcp".into()),
            tool: "search".into(),
            args_summary: None,
            result_summary: None,
        },
        ItemBody::WebSearch { query: "q".into() },
        ItemBody::ImageView { path: "/i.png".into() },
        ItemBody::ContextCompaction,
        ItemBody::CollabAgent { description: "sub".into() },
        ItemBody::Other { protocol_type: "future".into() },
    ];

    for body in variants {
        let v = serde_json::to_value(&body).unwrap();
        assert_no_snake_case_keys(&v, &format!("ItemBody::{body:?}"));
        assert!(v.get("kind").is_some(), "缺少 kind 判别字段: {v}");
    }
}

#[test]
fn item_and_turn_wire_format_is_camel_case() {
    let item = Item {
        id: "i1".into(),
        turn_id: "t1".into(),
        created_at_ms: 1234,
        body: ItemBody::CommandExecution {
            command: "ls".into(),
            cwd: None,
            status: ItemStatus::Completed,
            exit_code: Some(0),
            aggregated_output: Some("ok".into()),
            duration_ms: None,
        },
    };
    let v = serde_json::to_value(&item).unwrap();
    assert_no_snake_case_keys(&v, "Item");
    assert!(v.get("turnId").is_some(), "keys: {v}");
    assert!(v.get("createdAtMs").is_some(), "keys: {v}");

    let turn = Turn {
        id: "t1".into(),
        thread_id: "th1".into(),
        status: TurnStatus::Completed,
        started_at_ms: Some(1),
        completed_at_ms: Some(2),
        duration_ms: Some(1),
        items: vec![item],
    };
    let vt = serde_json::to_value(&turn).unwrap();
    assert_no_snake_case_keys(&vt, "Turn");
    for k in ["threadId", "startedAtMs", "completedAtMs", "durationMs"] {
        assert!(vt.get(k).is_some(), "Turn 缺少 {k}；keys: {:?}", vt.as_object().map(|o| o.keys().collect::<Vec<_>>()));
    }
}

#[test]
fn approval_wire_format_is_camel_case() {
    // Approval 是审批弹窗的数据源，字段最多、最易漏
    let approval = Approval {
        request_id: json!("n:0"),
        method: "item/commandExecution/requestApproval".into(),
        thread_id: "th".into(),
        turn_id: "tu".into(),
        item_id: "i".into(),
        started_at_ms: 1234,
        summary: "cat .env".into(),
        cwd: Some("/w".into()),
        reason: Some("读取配置".into()),
        risk: RiskAssessment {
            tier: RiskTier::High,
            signals: vec![RiskSignal::CredentialAccess { target: ".env".into() }],
        },
        decision: Some(ApprovalDecision::Decline),
        scope: Some(ApprovalScope::Turn),
    };
    let v = serde_json::to_value(&approval).unwrap();
    assert_no_snake_case_keys(&v, "Approval");
    for k in ["requestId", "threadId", "turnId", "itemId", "startedAtMs"] {
        assert!(v.get(k).is_some(), "Approval 缺少 {k}；keys: {:?}", v.as_object().map(|o| o.keys().collect::<Vec<_>>()));
    }
}

#[test]
fn thread_and_changeset_wire_format_is_camel_case() {
    let th = Thread {
        id: "th".into(),
        project_id: "p".into(),
        title: Some("任务".into()),
        status: ThreadStatus::Active,
        created_at_ms: 1,
        updated_at_ms: 2,
        forked_from_id: Some("parent".into()),
        cwd: "/w".into(),
        turns: vec![],
    };
    let v = serde_json::to_value(&th).unwrap();
    assert_no_snake_case_keys(&v, "Thread");
    for k in ["projectId", "createdAtMs", "updatedAtMs", "forkedFromId"] {
        assert!(v.get(k).is_some(), "Thread 缺少 {k}");
    }

    let cs = ChangeSet::new("th", "t", kcode_domain::ChangeOrigin::Proposed);
    let vc = serde_json::to_value(&cs).unwrap();
    assert_no_snake_case_keys(&vc, "ChangeSet");
    assert!(vc.get("turnId").is_some() && vc.get("reviewState").is_some(), "keys: {vc}");
}

#[test]
fn app_events_wire_format_is_camel_case() {
    let events = vec![
        AppEvent::ThreadStarted { thread_id: "th".into(), cwd: "/w".into() },
        AppEvent::TurnStarted { thread_id: "th".into(), turn_id: "tu".into() },
        AppEvent::ItemUpserted {
            thread_id: "th".into(),
            turn_id: "tu".into(),
            item: Item {
                id: "i".into(),
                turn_id: "tu".into(),
                created_at_ms: 0,
                body: ItemBody::Other { protocol_type: "x".into() },
            },
            completed: true,
        },
        AppEvent::ApprovalRequired {
            approval: Approval {
                request_id: json!("n:0"),
                method: "m".into(),
                thread_id: "th".into(),
                turn_id: "tu".into(),
                item_id: "i".into(),
                started_at_ms: 1,
                summary: "s".into(),
                cwd: None,
                reason: None,
                risk: RiskAssessment { tier: RiskTier::Low, signals: vec![] },
                decision: None,
                scope: None,
            },
        },
        AppEvent::ApprovalResolved { request_id: "n:0".into(), thread_id: "th".into() },
        AppEvent::TurnCompleted {
            thread_id: "th".into(),
            turn_id: "tu".into(),
            status: TurnStatus::Completed,
        },
        AppEvent::OutputDelta {
            thread_id: "th".into(),
            item_id: "i".into(),
            delta: "out".into(),
        },
        AppEvent::Error { message: "boom".into() },
        AppEvent::ProcessExited { code: Some(1) },
    ];

    for ev in events {
        let v = serde_json::to_value(&ev).unwrap();
        assert_no_snake_case_keys(&v, &format!("AppEvent::{ev:?}"));
        // 事件名必须是 camelCase 的 tag
        let tag = v["type"].as_str().unwrap_or_default();
        assert!(!tag.contains('_'), "事件 tag 应为 camelCase，实际 `{tag}`");
        assert!(
            !tag.is_empty() && tag.chars().next().unwrap().is_ascii_lowercase(),
            "事件 tag 应以小写字母开头，实际 `{tag}`"
        );
    }
}

/// ChangeSet 与 ParsedDiff 的线格式。
///
/// 这两个类型承载审阅面板的全部数据，字段名错一处就会让 diff 区域空白。
#[test]
fn changeset_wire_format_is_camel_case() {
    use kcode_domain::{ChangeOrigin, ChangeSet, FileChangeKind, FileDecision};

    let mut cs = ChangeSet::new("th", "tu", ChangeOrigin::Proposed);
    cs.upsert_files(vec![kcode_domain::FileChangeEntry {
        path: "/ws/src/main.rs".into(),
        kind: FileChangeKind::Update { move_path: Some("renamed.rs".into()) },
        diff: "@@ -1 +1 @@\n-a\n+b\n".into(),
    }]);
    // 只有一个文件且被接受 → 状态应是 acceptedAll（而非 underReview）
    cs.decide_file("/ws/src/main.rs", FileDecision::Accepted);

    let v = serde_json::to_value(&cs).unwrap();
    assert_no_snake_case_keys(&v, "ChangeSet");
    for k in ["turnId", "threadId", "reviewState"] {
        assert!(v.get(k).is_some(), "ChangeSet 缺少 {k}；keys: {:?}", v.as_object().map(|o| o.keys().collect::<Vec<_>>()));
    }
    assert_eq!(v["origin"], "proposed");
    assert_eq!(v["reviewState"], "acceptedAll");

    // 文件项的字段
    let f = &v["files"][0];
    assert!(f.get("path").is_some());
    assert!(f.get("diff").is_some());
    assert_no_snake_case_keys(f, "FileChangeEntry");
    // 重命名的 movePath 必须可读
    assert_eq!(f["kind"]["movePath"], "renamed.rs", "kind: {}", f["kind"]);
    assert_eq!(f["kind"]["type"], "update");
}

#[test]
fn parsed_diff_wire_format_is_camel_case() {
    use kcode_domain::parse_unified_diff;
    let d = parse_unified_diff(
        "--- a/f.rs\n+++ b/f.rs\n@@ -1,2 +1,2 @@\n ctx\n-old\n+new\n",
    );
    let v = serde_json::to_value(&d).unwrap();
    assert_no_snake_case_keys(&v, "ParsedDiff");
    for k in ["oldPath", "newPath"] {
        assert!(v.get(k).is_some(), "ParsedDiff 缺少 {k}");
    }
    let h = &v["hunks"][0];
    assert_no_snake_case_keys(h, "DiffHunk");
    for k in ["oldStart", "oldCount", "newStart", "newCount"] {
        assert!(h.get(k).is_some(), "DiffHunk 缺少 {k}；keys: {:?}", h.as_object().map(|o| o.keys().collect::<Vec<_>>()));
    }
    let line = &h["lines"][0];
    assert_no_snake_case_keys(line, "DiffLine");
    assert!(line.get("oldLine").is_some() && line.get("newLine").is_some());
}

#[test]
fn app_event_changeset_variants_wire_format() {
    use kcode_domain::{ChangeOrigin, ChangeSet, parse_unified_diff};

    let cs = ChangeSet::new("th", "tu", ChangeOrigin::Applied);
    let ev = AppEvent::ChangeSetUpdated {
        thread_id: "th".into(),
        turn_id: "tu".into(),
        change_set: cs,
    };
    let v = serde_json::to_value(&ev).unwrap();
    assert_eq!(v["type"], "changeSetUpdated");
    assert_no_snake_case_keys(&v, "AppEvent::ChangeSetUpdated");

    let ev2 = AppEvent::TurnDiffUpdated {
        thread_id: "th".into(),
        turn_id: "tu".into(),
        parsed: parse_unified_diff("@@ -1 +1 @@\n-a\n+b\n"),
        per_file: vec![kcode_domain::FileDiffSlice {
            path: "a.rs".into(),
            diff: parse_unified_diff("@@ -1 +1 @@\n-a\n+b\n"),
        }],
    };
    let v2 = serde_json::to_value(&ev2).unwrap();
    assert_eq!(v2["type"], "turnDiffUpdated");
    assert_no_snake_case_keys(&v2, "AppEvent::TurnDiffUpdated");
    // 逐文件切分结果必须可读——整轮 diff 是多段拼接，前端靠它做逐文件展示
    assert!(v2.get("perFile").is_some(), "缺少 perFile；keys: {v2}");
    assert_eq!(v2["perFile"][0]["path"], "a.rs");
}

/// 反向校验：本测试的检查器本身有效。
///
/// 若 `assert_no_snake_case_keys` 对含 snake_case 的输入不报错，
/// 上面所有断言都是空转——这类「测试的测试」是必要的。
#[test]
fn snake_case_detector_actually_detects() {
    let bad = json!({ "thread_id": "x", "nested": { "turn_id": "y" } });
    let mut keys = Vec::new();
    all_keys(&bad, &mut keys);
    let found: Vec<&String> = keys.iter().filter(|k| k.contains('_')).collect();
    assert_eq!(found.len(), 2, "检查器应能同时发现顶层与嵌套的 snake_case 键");

    let good = json!({ "threadId": "x", "nested": { "turnId": "y" } });
    let mut keys2 = Vec::new();
    all_keys(&good, &mut keys2);
    assert!(
        keys2.iter().all(|k| !k.contains('_')),
        "检查器不应误报 camelCase"
    );
}
