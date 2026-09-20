//! 审批决策的安全语义回归测试。
//!
//! 这些断言守护的是**用户预期与系统行为一致**，而不只是协议字段正确。
//! 每一条都由真实 app-server 进程 + 本地 mock 模型实测得出。
//!
//! # 实测语义（codex 0.155.1）
//!
//! | 决策 | 提权是否生效 | 命令是否执行 | `item.status` |
//! |---|---|---|---|
//! | `accept` | ✅ | ✅ 提权执行 | `completed`, `exitCode=0` |
//! | `decline` | ❌ | ❌ **不执行** | **`declined`**, `exitCode=null` |
//! | `cancel` | ❌ | ❌ 不执行（并中断 Turn） | **`declined`** |
//! | 非法值（如 `allow_once`） | ❌ | ❌ 不执行 | — |
//!
//! # 三条被实测确认的安全属性
//!
//! 1. **`decline` 是硬拒绝**：命令完全不执行，不会「降级到沙箱内跑一遍」。
//!    实测中区内标记文件也未创建，排除了部分执行的可能。
//! 2. **非法决策值 fail-safe**：发送协议中不存在的决策值（如 v1.0 文档曾使用的
//!    `allow_once`）**不会**被当作批准。这一点必须守住——否则客户端任何拼写错误
//!    都会静默放行本应拦截的操作。
//! 3. **`declined` 是官方 Item 状态**：`CommandExecutionStatus` 与 `PatchApplyStatus`
//!    都含 `declined`。UI 必须渲染它，否则用户拒绝后看到的是一个「已完成」的命令卡片，
//!    无法分辨命令究竟跑没跑。

use kcode_bridge::{locate_binary, Incoming, JsonlTransport, SpawnConfig};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;

fn repo_root() -> PathBuf {
    let mut dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    while !dir.join("node_modules").is_dir() {
        if !dir.pop() {
            panic!("未找到 node_modules，请先运行 npm install");
        }
    }
    dir
}

/// 命令同时向工作区内（沙箱允许）与工作区外（需提权）写标记文件。
///
/// 两个标记的组合能唯一区分三种结局，这是本测试的判别核心：
/// 仅看「命令是否执行」会把「未执行」与「沙箱内执行」混为一谈。
async fn spawn_mock(inside: String, outside: String) -> (u16, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let handle = tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else { break };
            let mut raw = Vec::new();
            let mut buf = [0u8; 8192];
            loop {
                match tokio::io::AsyncReadExt::read(&mut sock, &mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        raw.extend_from_slice(&buf[..n]);
                        if let Some(pos) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                            let he = pos + 4;
                            let head = String::from_utf8_lossy(&raw[..he]).to_lowercase();
                            let want = head
                                .lines()
                                .find_map(|l| l.strip_prefix("content-length:"))
                                .and_then(|v| v.trim().parse::<usize>().ok())
                                .unwrap_or(0);
                            if raw.len() >= he + want {
                                break;
                            }
                        }
                    }
                }
            }
            let he = raw.windows(4).position(|w| w == b"\r\n\r\n").map(|p| p + 4).unwrap_or(0);
            let body = String::from_utf8_lossy(&raw[he.min(raw.len())..]).to_string();
            let parsed: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
            let prior = parsed
                .get("input")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter(|i| i.get("type").and_then(Value::as_str) == Some("function_call"))
                        .count()
                })
                .unwrap_or(0);

            let output = if prior >= 1 {
                json!({"type":"message","id":"m","role":"assistant","status":"completed",
                       "content":[{"type":"output_text","text":"done","annotations":[]}]})
            } else {
                json!({"type":"function_call","id":"fc","call_id":"call_mock_1","name":"exec_command",
                    "status":"completed",
                    "arguments": json!({
                        "cmd": format!("echo inside > {inside}; echo outside > {outside}"),
                        "workdir": Value::Null,
                        "yield_time_ms": 3000,
                        "sandbox_permissions": "require_escalated",
                        "justification": "approval semantics probe"
                    }).to_string()})
            };

            let mut sse = String::new();
            for ev in [
                json!({"type":"response.created","response":{"id":"r","status":"in_progress","model":"m","output":[]}}),
                json!({"type":"response.output_item.done","output_index":0,"item":output}),
                json!({"type":"response.completed","response":{"id":"r","status":"completed","model":"m","output":[output],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}),
            ] {
                sse.push_str(&format!("event: {}\ndata: {}\n\n", ev["type"], ev));
            }
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                sse.len()
            );
            let _ = sock.write_all(head.as_bytes()).await;
            let _ = sock.write_all(sse.as_bytes()).await;
            let _ = sock.flush().await;
        }
    });
    (port, handle)
}

struct Outcome {
    inside: bool,
    outside: bool,
    item_status: Option<String>,
    item_exit_code: Option<i64>,
}

async fn probe(decision: Value, label: &str) -> Outcome {
    let binary = locate_binary(&repo_root()).unwrap();
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    let outside = format!("{home}/.kcode_approval_probe_{label}");

    let cwd = tempfile::tempdir().unwrap();
    let inside = cwd.path().join(format!("inside_{label}"));
    let _ = std::fs::remove_file(&outside);

    let (port, mock) = spawn_mock(inside.display().to_string(), outside.clone()).await;

    let ch = tempfile::tempdir().unwrap();
    std::fs::write(
        ch.path().join("config.toml"),
        format!(
            "model_provider = \"m\"\nmodel = \"kcode-mock-model\"\n\n[model_providers.m]\nname = \"m\"\nbase_url = \"http://127.0.0.1:{port}/v1\"\nwire_api = \"responses\"\nrequires_openai_auth = false\nexperimental_bearer_token = \"x\"\n"
        ),
    )
    .unwrap();

    let cfg = SpawnConfig::new(&binary, cwd.path(), ch.path());
    let mut t = JsonlTransport::spawn(&cfg).await.unwrap();
    t.initialize("probe", "Probe", "0.1.0", Some(cfg.codex_home.as_path()))
        .await
        .unwrap();

    let started = t
        .request(
            "thread/start",
            json!({"cwd": cwd.path(), "approvalPolicy": "on-request",
                   "sandbox": "workspace-write", "model": "kcode-mock-model"}),
        )
        .await
        .unwrap();
    let thread_id = started["thread"]["id"].as_str().unwrap().to_owned();

    t.request(
        "turn/start",
        json!({"threadId": thread_id, "input":[{"type":"text","text":"run"}]}),
    )
    .await
    .unwrap();

    let mut skipped = Vec::new();
    let approval = t
        .next_matching(Duration::from_secs(30), Incoming::is_approval_request, |o| {
            skipped.push(o)
        })
        .await
        .expect("未收到审批请求");
    let req_id = match &approval {
        Incoming::ServerRequest { id, .. } => id.clone(),
        _ => unreachable!(),
    };
    t.respond(&req_id, decision).await.unwrap();

    let mut item_status = None;
    let mut item_exit_code = None;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(25);
    while tokio::time::Instant::now() < deadline {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        let Some(ev) = t.next_inbound(left).await else { break };
        if let Incoming::Notification { method, params } = &ev {
            if method == "item/completed" && params["item"]["type"] == "commandExecution" {
                item_status = params["item"]["status"].as_str().map(str::to_owned);
                item_exit_code = params["item"]["exitCode"].as_i64();
            }
            if method == "turn/completed" {
                break;
            }
        }
    }

    let out = Outcome {
        inside: Path::new(&inside).exists(),
        outside: Path::new(&outside).exists(),
        item_status,
        item_exit_code,
    };
    let _ = std::fs::remove_file(&outside);
    t.shutdown().await.ok();
    mock.abort();
    out
}

/// `accept`：提权生效，命令以提权身份运行。
#[tokio::test(flavor = "multi_thread")]
async fn accept_grants_escalation_and_runs_command() {
    if locate_binary(&repo_root()).is_err() {
        return;
    }
    let o = probe(json!({"decision": "accept"}), "accept").await;

    assert!(o.inside, "accept 后工作区内文件未创建");
    assert!(o.outside, "accept 后工作区外文件未创建 —— 提权未生效");
    assert_eq!(o.item_status.as_deref(), Some("completed"));
    assert_eq!(o.item_exit_code, Some(0));
}

/// `decline`：**命令完全不执行**，且 Item 状态为 `declined`。
///
/// 两条断言缺一不可：
/// - 区外文件未创建 → 提权被拒
/// - **区内文件也未创建** → 命令根本没有「降级到沙箱内跑一遍」
///
/// 若只验证前者，一个「拒绝提权但仍在沙箱内执行」的实现也能通过——
/// 而那与用户的「拒绝」预期不符。
#[tokio::test(flavor = "multi_thread")]
async fn decline_prevents_execution_entirely() {
    if locate_binary(&repo_root()).is_err() {
        return;
    }
    let o = probe(json!({"decision": "decline"}), "decline").await;

    assert!(!o.outside, "decline 后工作区外文件被创建 —— 提权未真正被拒");
    assert!(
        !o.inside,
        "decline 后工作区内文件被创建 —— 命令仍在沙箱内执行了，与用户「拒绝」预期不符"
    );
    assert_eq!(
        o.item_status.as_deref(),
        Some("declined"),
        "decline 后 Item 状态应为 declined，UI 依赖它区分「已拒绝」与「已完成」"
    );
    assert_eq!(o.item_exit_code, None, "未执行的命令不应有退出码");
}

/// `cancel`：同样不执行；与 `decline` 的区别在于它会中断整个 Turn。
#[tokio::test(flavor = "multi_thread")]
async fn cancel_prevents_execution() {
    if locate_binary(&repo_root()).is_err() {
        return;
    }
    let o = probe(json!({"decision": "cancel"}), "cancel").await;

    assert!(!o.outside, "cancel 后工作区外文件被创建");
    assert!(!o.inside, "cancel 后工作区内文件被创建");
    assert_eq!(o.item_status.as_deref(), Some("declined"));
}

/// **非法决策值必须 fail-safe。**
///
/// v1.0 文档曾使用 `allow_once` 这类协议中不存在的决策值。若服务端把无法识别的
/// 值默认当作批准，客户端任何拼写错误都会静默放行本应拦截的高危操作。
///
/// 实测 0.155.1 行为正确（不执行）。这条断言的价值在于：它会在上游行为转变时
/// 立刻失败，而不是等到某次真实事故。
#[tokio::test(flavor = "multi_thread")]
async fn unrecognized_decision_is_fail_safe() {
    if locate_binary(&repo_root()).is_err() {
        return;
    }
    let o = probe(json!({"decision": "allow_once"}), "invalid").await;

    assert!(
        !o.outside,
        "发现 fail-open：无法识别的决策值被当作批准，完成了提权写入"
    );
    assert!(
        !o.inside,
        "发现 fail-open：无法识别的决策值导致命令被执行"
    );
}
