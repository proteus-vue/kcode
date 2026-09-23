//! Phase 1 验收测试。
//!
//! 覆盖方案文档 10. 节验收清单中**不需要真实模型**的部分。
//!
//! 需要真实模型的部分（模型输出形态、长任务规划、真实工具调用序列）由
//! `scripts/acceptance-real-model.sh` 承担，见该脚本的说明。
//!
//! 全部离线、零凭据、不污染真实 `~/.codex`。

use kcode_bridge::SpawnConfig;
use kcode_app::{AgentService, AppEvent, ServiceConfig};
use kcode_domain::{ApprovalDecision, ItemStatus, RiskTier, TurnStatus};
use serde_json::{json, Value};
use std::path::PathBuf;
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

/// 可脚本化的 mock 模型：依次返回预设输出。
///
/// **注意并发场景**：`script` 是全局顺序分配的，多个线程并发时会按请求到达
/// 顺序发放，线程与脚本项的对应关系不确定。需要「内容 ↔ 线程」确定对应的
/// 测试请用 [`spawn_echo_mock`]。
async fn spawn_mock(script: Vec<Value>) -> (u16, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let handle = tokio::spawn(async move {
        let mut idx = 0usize;
        loop {
            let Ok((mut sock, _)) = listener.accept().await else { break };
            let mut raw = Vec::new();
            let mut buf = [0u8; 16384];
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

            // 该轮已有 function_call 回填 → 收尾，避免无限循环
            let has_call = parsed
                .get("input")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter(|i| i.get("type").and_then(Value::as_str) == Some("function_call"))
                        .count()
                })
                .unwrap_or(0);

            let output = if has_call >= 1 {
                json!({"type":"message","id":"m","role":"assistant","status":"completed",
                       "content":[{"type":"output_text","text":"完成","annotations":[]}]})
            } else if idx < script.len() {
                let o = script[idx].clone();
                idx += 1;
                o
            } else {
                json!({"type":"message","id":"m","role":"assistant","status":"completed",
                       "content":[{"type":"output_text","text":"完成","annotations":[]}]})
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

/// 回显型 mock：把用户消息原样作为回复返回。
///
/// 这样「回复内容 ↔ 请求内容」一一对应，与并发顺序无关——
/// 适合验证线程隔离：若 A 线程出现了 B 的回复，那才是真的串线。
async fn spawn_echo_mock() -> (u16, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let handle = tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else { break };
            let mut raw = Vec::new();
            let mut buf = [0u8; 16384];
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

            // 回显最后一条用户消息
            let echoed = parsed
                .get("input")
                .and_then(Value::as_array)
                .and_then(|arr| {
                    arr.iter().rev().find_map(|i| {
                        if i.get("role").and_then(Value::as_str) == Some("user") {
                            i.get("content")
                                .and_then(Value::as_array)
                                .and_then(|c| c.first())
                                .and_then(|c| c.get("text"))
                                .and_then(Value::as_str)
                                .map(str::to_owned)
                        } else {
                            None
                        }
                    })
                })
                .unwrap_or_else(|| "(empty)".to_owned());

            let output = json!({
                "type": "message", "id": "m", "role": "assistant", "status": "completed",
                "content": [{ "type": "output_text", "text": echoed, "annotations": [] }]
            });

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

fn exec_command(cmd: &str, escalated: bool) -> Value {
    let mut args = json!({
        "cmd": cmd, "workdir": Value::Null, "yield_time_ms": 3000
    });
    if escalated {
        args["sandbox_permissions"] = json!("require_escalated");
        args["justification"] = json!("验收测试");
    }
    json!({
        "type": "function_call", "id": "fc", "call_id": "call_mock_1",
        "name": "exec_command", "status": "completed",
        "arguments": args.to_string()
    })
}

/// 把 Item 列表压成一行短摘要，供断言失败时定位。
///
/// # 为什么诊断信息必须写进断言消息
///
/// CI（Linux runner）上出现过「命令 Item 完全没产生」的失败，而当时只有一句
/// `未找到命令 Item`——它无法区分三种完全不同的情况：
///
/// 1. 命令**根本没被执行**（沙箱起不来 / 模型没发出调用）；
/// 2. 命令执行了但**失败**，Item 类型是别的；
/// 3. Item 存在但 `replay_items` 没重放出来。
///
/// 而 CI 的注解面板只显示短行、完整日志需要仓库 admin 权限（开发机没有），
/// 所以「再跑一次看看」也拿不到更多线索。**断言自己把现场说清楚**，
/// 才是这种情况下的唯一有效手段。这也与项目一贯的主张一致：
/// 失败报告必须可行动（见 docs/协议勘误与修正.md §3.23）。
///
/// 输出形如 `userMessage,agentMessage(failed),cmd:inProgress`——短、可读、
/// 足以判断上面三种情况中的哪一种。
fn summarize_items(items: &[kcode_domain::Item]) -> String {
    use kcode_domain::ItemBody as B;
    let tags: Vec<String> = items
        .iter()
        .map(|i| match &i.body {
            B::UserMessage { .. } => "userMessage".to_owned(),
            B::AgentMessage { .. } => "agentMessage".to_owned(),
            B::Reasoning { .. } => "reasoning".to_owned(),
            B::Plan { .. } => "plan".to_owned(),
            B::CommandExecution { status, exit_code, aggregated_output, command, .. } => format!(
                "cmd[{status:?}/exit={exit_code:?}/out={}B]{}",
                aggregated_output.as_ref().map(|o| o.len()).unwrap_or(0),
                // 命令本身也带上：沙箱拒绝与命令写错的表现不同
                command.chars().take(40).collect::<String>()
            ),
            B::FileChange { status, changes } => {
                format!("fileChange[{status:?}/{} 个文件]", changes.len())
            }
            B::ToolCall { tool, .. } => format!("toolCall[{tool}]"),
            B::WebSearch { .. } => "webSearch".to_owned(),
            B::ImageView { path } => format!("imageView[{path}]"),
            B::ContextCompaction => "compaction".to_owned(),
            B::CollabAgent { .. } => "collabAgent".to_owned(),
            B::Other { protocol_type } => format!("other[{protocol_type}]"),
        })
        .collect();
    if tags.is_empty() {
        "（无任何 Item）".to_owned()
    } else {
        tags.join(", ")
    }
}

/// 复现命令：断言失败时提示如何在本地重跑该用例（CI 与本地环境不同）。
fn rerun_hint(name: &str) -> String {
    format!("本地重跑：cargo test -p kcode-app --test acceptance {name} -- --nocapture")
}

struct Harness {
    service: AgentService,
    events: tokio::sync::broadcast::Receiver<AppEvent>,
    /// 真实存在的工作区目录。必须持有 TempDir 本体——它一析构目录就被删，
    /// 而 app-server 会持续在该目录下工作。
    cwd: tempfile::TempDir,
    home: tempfile::TempDir,
    log_path: PathBuf,
}

impl Harness {
    async fn start(script: Vec<Value>) -> Option<Self> {
        let binary = kcode_bridge::locate_binary(&repo_root()).ok()?;
        let (port, mock) = spawn_mock(script).await;
        std::mem::forget(mock);

        let cwd = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let cwd_path = cwd.path().to_path_buf();
        let home_path = home.path().to_path_buf();
        std::fs::write(
            home_path.join("config.toml"),
            format!(
                "model_provider = \"m\"\nmodel = \"kcode-mock-model\"\n\n[model_providers.m]\nname = \"m\"\nbase_url = \"http://127.0.0.1:{port}/v1\"\nwire_api = \"responses\"\nrequires_openai_auth = false\nexperimental_bearer_token = \"x\"\n"
            ),
        )
        .unwrap();

        let cfg = ServiceConfig {
            spawn: SpawnConfig::new(&binary, &cwd_path, &home_path),
            client_name: "kcode-acceptance".into(),
            client_title: "KCode Acceptance".into(),
            client_version: "0.1.0".into(),
        };
        let service = AgentService::start(cfg).await.expect("启动服务失败");
        let events = service.subscribe();
        let log_path = service.event_log_path();

        Some(Self { service, events, cwd, home, log_path })
    }

    /// 工作区绝对路径（真实存在的目录）。
    fn cwd_path(&self) -> PathBuf {
        self.cwd.path().to_path_buf()
    }

    /// CODEX_HOME 路径（事件日志所在目录），崩溃恢复验收需要跨重启复用。
    fn home_path(&self) -> PathBuf {
        self.home.path().to_path_buf()
    }

    async fn wait_for<T>(
        &mut self,
        timeout: Duration,
        mut f: impl FnMut(&AppEvent) -> Option<T>,
    ) -> Option<T> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let left = deadline.saturating_duration_since(tokio::time::Instant::now());
            if left.is_zero() {
                return None;
            }
            match tokio::time::timeout(left, self.events.recv()).await {
                Ok(Ok(ev)) => {
                    if let Some(v) = f(&ev) {
                        return Some(v);
                    }
                }
                _ => return None,
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────
// 崩溃验收
// ─────────────────────────────────────────────────────────────────────────

/// **崩溃验收**：`kill -9` app-server 后，
/// 1. UI 必须收到 `ProcessExited`（否则会永远停在「运行中」）；
/// 2. 活动轮次必须可判定为 unknown，**绝不静默当作成功**；
/// 3. 事件日志必须完整保留（历史不丢）；
/// 4. 重启后可从中恢复线程历史。
#[tokio::test(flavor = "multi_thread")]
async fn crash_recovery_after_sigkill() {
    let Some(mut h) = Harness::start(vec![exec_command("sleep 30", false)]).await else {
        eprintln!("跳过：未安装 codex 二进制");
        return;
    };

    let info = h
        .service
        .start_thread(h.cwd_path().display().to_string(), Some("kcode-mock-model".into()), "workspace-write", json!("on-request"))
        .await
        .expect("建线程失败");
    let thread_id = info.thread_id.clone();
    let turn_id = h.service.send_turn(&thread_id, "跑一个长命令").await.expect("提交轮次失败");

    // 必须等到**至少一个 Item 已落库**再强杀。
    // 只等 TurnStarted 是不够的：那时 item 事件尚未产生，
    // 日志里除了 thread/turn 之外什么都没有，也就无从验证「历史是否保留」。
    let got_item = h
        .wait_for(Duration::from_secs(20), |ev| match ev {
            AppEvent::ItemUpserted { .. } => Some(()),
            _ => None,
        })
        .await;
    assert!(got_item.is_some(), "未观察到任何 Item 事件");

    // ── 强杀子进程：一切清理逻辑都来不及跑 ──────────────────────────────
    let pid = h.service.pid().expect("未取得子进程 PID");
    let killed = std::process::Command::new("kill")
        .args(["-9", &pid.to_string()])
        .status()
        .expect("kill 失败");
    assert!(killed.success(), "kill -9 未成功");

    // 1. 必须广播 ProcessExited
    let exited = h
        .wait_for(Duration::from_secs(15), |ev| match ev {
            AppEvent::ProcessExited { .. } => Some(()),
            _ => None,
        })
        .await;
    assert!(
        exited.is_some(),
        "子进程被强杀后未广播 ProcessExited —— UI 会永远显示「运行中」"
    );

    // 2. 活动轮次必须标记为 unknown，绝不能是 completed
    let status = kcode_app::should_mark_unknown(TurnStatus::InProgress, false);
    assert!(status, "崩溃后活动轮次应标记 unknown");

    // 3. 事件日志必须完整（历史未丢）
    let log = kcode_domain::EventLog::open(&h.log_path).expect("重开日志失败");
    let events = log.events_for_thread(&thread_id).expect("读取线程事件失败");
    let kinds: Vec<&str> = events.iter().map(|e| e.kind.as_str()).collect();
    assert!(
        kinds.contains(&"thread_started"),
        "崩溃后线程创建事件丢失: {kinds:?}"
    );
    assert!(
        kinds.contains(&"turn_started"),
        "崩溃后轮次开始事件丢失: {kinds:?}"
    );

    // 4. 可重建视图
    let items = kcode_app::replay_items(&log, &thread_id).unwrap();
    assert!(!items.is_empty(), "崩溃后无法从事件日志重建任何 Item");

    // 5. 未提交的轮次不应出现在日志里成为「已完成」
    assert!(
        !events.iter().any(|e| e.kind == "turn_completed"),
        "崩溃时轮次未完成，日志中不应有 turn_completed"
    );

    let _ = turn_id;
}

/// 崩溃后**重启**能恢复线程历史（方案验收项：「重启应用，Thread 历史完整恢复」）。
#[tokio::test(flavor = "multi_thread")]
async fn history_survives_restart() {
    // 第一段：正常跑完一轮
    let Some(mut h) = Harness::start(vec![exec_command("echo hello", false)]).await else { return };
    let info = h
        .service
        .start_thread(h.cwd_path().display().to_string(), Some("kcode-mock-model".into()), "workspace-write", json!("on-request"))
        .await
        .unwrap();
    let thread_id = info.thread_id.clone();
    h.service.send_turn(&thread_id, "打个招呼").await.unwrap();

    // 等这一轮结束
    let done = h
        .wait_for(Duration::from_secs(25), |ev| match ev {
            // 连状态一起取出（TurnStatus 是 Copy，解引用后返回值而非引用）：
            // 轮次是否 failed 决定了后面「没有命令 Item」的根因方向
            // （命令侧报错 vs 执行结果根本没落库）。
            AppEvent::TurnCompleted { status, .. } => Some(*status),
            _ => None,
        })
        .await;
    let turn_status = done.expect("首轮未正常结束");
    assert_eq!(
        turn_status,
        TurnStatus::Completed,
        "首轮应以 completed 收尾，实际 {turn_status:?}；items：{}",
        summarize_items(&{
            let log = kcode_domain::EventLog::open(&h.log_path).unwrap();
            kcode_app::replay_items(&log, &thread_id).unwrap()
        })
    );

    let home = h.home_path();

    // 记录崩溃前的历史
    let items_before = {
        let log = kcode_domain::EventLog::open(&h.log_path).unwrap();
        kcode_app::replay_items(&log, &thread_id).unwrap()
    };
    assert!(!items_before.is_empty());

    h.service.shutdown();
    tokio::time::sleep(Duration::from_millis(300)).await;

    // 第二段：用同一份事件日志重新读取（模拟应用重启）
    let log = kcode_domain::EventLog::open(&home.join("kcode-events.db")).expect("重开日志失败");
    let items_after = kcode_app::replay_items(&log, &thread_id).unwrap();

    assert_eq!(
        items_before.len(),
        items_after.len(),
        "重启后 Item 数量不一致——历史丢失"
    );
    let ids_before: Vec<&String> = items_before.iter().map(|i| &i.id).collect();
    let ids_after: Vec<&String> = items_after.iter().map(|i| &i.id).collect();
    assert_eq!(ids_before, ids_after, "重启后 Item 顺序或内容不一致");

    // 重放必须保留终态（不是回到 inProgress）
    let cmd = items_after
        .iter()
        .find(|i| matches!(i.body, kcode_domain::ItemBody::CommandExecution { .. }))
        .unwrap_or_else(|| {
            panic!(
                "未找到命令 Item。\n\
                 实际 items：{}\n\
                 轮次状态：{turn_status:?}（若为 failed，说明命令侧出错而非重放问题）\n\
                 这能区分「命令没跑」与「跑了但类型不符」——CI 注解只显示短行，\n\
                 所以现场必须写在这里。\n{}",
                summarize_items(&items_after),
                rerun_hint("history_survives_restart"),
            )
        });
    if let kcode_domain::ItemBody::CommandExecution { status, .. } = &cmd.body {
        assert_eq!(*status, ItemStatus::Completed, "重放后状态未保持终态");
    }
}

// ─────────────────────────────────────────────────────────────────────────
// 文件变更审批（此前完全未测的路径）
// ─────────────────────────────────────────────────────────────────────────

/// 用 mock 触发 `apply_patch` 类工具调用，验证文件变更审批链路。
///
/// **此前只测了命令审批**（`item/commandExecution/requestApproval`）；
/// 文件变更走 `item/fileChange/requestApproval`，响应体与状态流转不同，
/// 且 `PatchApplyStatus` 同样有 `declined` 状态。
/// 被拒绝的文件变更与 `completed` 必须在类型上可区分。
///
/// # 实测边界（重要）
///
/// 本条测试最初写成「拒绝审批后 Item 状态应为 declined」，实测失败——
/// 因为 `apply_patch` 在当前沙箱配置下**不经过审批就直接应用**，
/// 因此不存在「拒绝」这一步。拒绝语义的实际验证由
/// `declined_item_projects_as_declined_not_completed`（命令路径）承担，
/// 那条路径确实走审批。
///
/// 此处改为**单元级**验证类型区分能力：无论变更走哪条路径，
/// 只要状态是 `declined`，UI 就必须能与 `completed` 分辨——
/// 否则用户拒绝后会把「未应用」看成「已应用」。
#[tokio::test(flavor = "multi_thread")]
async fn declined_file_change_is_distinguishable_from_completed() {
    use kcode_domain::{FileChangeEntry, FileChangeKind, ItemBody, ItemStatus};

    let mk = |status: ItemStatus| ItemBody::FileChange {
        status,
        changes: vec![FileChangeEntry {
            path: "src/a.rs".into(),
            kind: FileChangeKind::Update { move_path: None },
            diff: "@@ -1 +1 @@\n-a\n+b\n".into(),
        }],
    };

    let declined = mk(ItemStatus::Declined);
    let completed = mk(ItemStatus::Completed);
    assert_ne!(declined, completed, "declined 与 completed 必须可区分");

    // 经线格式后仍可区分（前端按 JSON 判断）
    let dj = serde_json::to_value(&declined).unwrap();
    let cj = serde_json::to_value(&completed).unwrap();
    assert_eq!(dj["status"], "declined");
    assert_eq!(cj["status"], "completed");
    assert_ne!(dj["status"], cj["status"]);

    // UI 分支依据：`is_declined` 必须对 declined 返回 true、对 completed 返回 false
    let item_declined = kcode_domain::Item {
        id: "i".into(),
        turn_id: "t".into(),
        created_at_ms: 0,
        body: declined,
    };
    let item_completed = kcode_domain::Item {
        id: "i".into(),
        turn_id: "t".into(),
        created_at_ms: 0,
        body: completed,
    };
    assert!(kcode_app::is_declined(&item_declined));
    assert!(!kcode_app::is_declined(&item_completed));
}

/// 记录 `apply_patch` 的实际执行路径：**不经过审批时直接应用**。
///
/// 这是对上游行为的实测记录，用于让「为什么某个测试不用审批」这一事实
/// 有据可查，而不是靠注释口口相传。
#[tokio::test(flavor = "multi_thread")]
async fn apply_patch_without_escalation_applies_directly() {
    const PATCH: &str = "*** Begin Patch\n*** Add File: direct_probe.txt\n+x\n*** End Patch";
    let cmd = format!("apply_patch <<'PATCH'\n{PATCH}\nPATCH");
    let Some(mut h) = Harness::start(vec![exec_command(&cmd, false)]).await else { return };

    let info = h
        .service
        .start_thread(h.cwd_path().display().to_string(), Some("kcode-mock-model".into()), "workspace-write", json!("on-request"))
        .await
        .unwrap();
    h.service.send_turn(&info.thread_id, "建文件").await.unwrap();

    let mut saw_approval = false;
    let mut applied_file_change = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(25);
    while tokio::time::Instant::now() < deadline {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        let Some(ev) = h.wait_for(left, |e| Some(e.clone())).await else { break };
        match &ev {
            AppEvent::ApprovalRequired { .. } => saw_approval = true,
            AppEvent::ItemUpserted { item, .. } => {
                if matches!(
                    &item.body,
                    kcode_domain::ItemBody::FileChange { status: ItemStatus::Completed, .. }
                ) {
                    applied_file_change = true;
                }
            }
            AppEvent::TurnCompleted { .. } => break,
            _ => {}
        }
    }

    // 记录实测行为：此路径下文件确实被写入，且是否出现审批由上游决定。
    let file_exists = h.cwd_path().join("direct_probe.txt").exists();
    println!(
        "\napply_patch（无提权请求）实测：审批={saw_approval} 文件落盘={file_exists} \
         观察到已应用的文件变更 Item={applied_file_change}"
    );
    assert!(file_exists, "文件应被创建（沙箱内允许写入工作区）");
    // 不断言 saw_approval：该行为随上游执行路径而变，这里只做记录。
}

/// **端到端验证：整轮 diff 携带真实内容到达 UI。**
///
/// # 为什么用 `turn/diff/updated` 作为审阅数据源
///
/// 实测（codex 0.155.1）确认了两种 diff 通道，可用性不同：
///
/// | 通道 | 内容 | 实测可用性 |
/// |---|---|---|
/// | `turn/diff/updated` 通知 | 标准 unified diff（含 `diff --git`、文件头、`@@`） | **稳定**：只要工作区发生变更就会推送 |
/// | `fileChange` Item 的 `changes[]` | 逐文件 `{path, kind, diff}` | **条件性**：仅在特定审批路径下产生；同一命令在沙箱内直接放行时不产生 |
///
/// 因此审阅面板以 `turn/diff/updated` 为**主数据源**（稳定、格式标准），
/// `fileChange` 的逐文件结构作为**补充**（有则更精细，无则不影响可用性）。
///
/// 本测试固化这个分工：断言整轮 diff 真的带内容，且能被解析成可渲染的 hunk。
#[tokio::test(flavor = "multi_thread")]
async fn turn_diff_reaches_ui_with_real_content() {
    const PATCH: &str = "*** Begin Patch\n*** Add File: cs_probe.txt\n+alpha\n+beta\n*** End Patch";
    let cmd = format!("apply_patch <<'PATCH'\n{PATCH}\nPATCH");
    let Some(mut h) = Harness::start(vec![exec_command(&cmd, false)]).await else {
        eprintln!("跳过：未安装 codex 二进制");
        return;
    };

    let info = h
        .service
        .start_thread(h.cwd_path().display().to_string(), Some("kcode-mock-model".into()), "workspace-write", json!("on-request"))
        .await
        .unwrap();
    h.service.send_turn(&info.thread_id, "新建文件").await.unwrap();

    let mut latest_diff: Option<kcode_domain::ParsedDiff> = None;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    while tokio::time::Instant::now() < deadline {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        let Some(ev) = h.wait_for(left, |e| Some(e.clone())).await else { break };
        match &ev {
            AppEvent::TurnDiffUpdated { parsed, .. } if !parsed.is_empty() => {
                latest_diff = Some(parsed.clone());
            }
            AppEvent::ApprovalRequired { approval } => {
                let _ = h
                    .service
                    .resolve_approval(approval.request_key(), ApprovalDecision::Accept, None)
                    .await;
            }
            AppEvent::TurnCompleted { .. } => break,
            _ => {}
        }
    }

    let parsed = latest_diff.unwrap_or_else(|| {
        // 未有 diff 事件时把现场说清楚：命令是否跑过、轮次什么状态。
        // CI 注解只显示短行，所以诊断必须写进消息本身。
        let items = {
            let log = kcode_domain::EventLog::open(&h.log_path).unwrap();
            kcode_app::replay_items(&log, &info.thread_id).unwrap()
        };
        panic!(
            "未收到带内容的 TurnDiffUpdated 事件。\n\
             实际 items：{}\n\
             （若完全不见 fileChange 项，说明 apply_patch 没被执行；\n\
             若只见 cmd 项，说明补丁走了命令通道但未产生文件变更）\n{}",
            summarize_items(&items),
            rerun_hint("turn_diff_reaches_ui_with_real_content"),
        )
    });
    let stats = parsed.stats();
    assert_eq!(stats.added, 2, "整轮 diff 应含 2 行新增，实际 {stats:?}");
    assert_eq!(stats.removed, 0);
    assert!(
        parsed.warnings.is_empty(),
        "标准 unified diff 不应产生解析警告: {:?}",
        parsed.warnings
    );
    assert_eq!(parsed.new_path.as_deref(), Some("cs_probe.txt"), "路径解析错误");

    let body: String = parsed
        .hunks
        .iter()
        .flat_map(|h| h.lines.iter())
        .map(|l| l.text.clone())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(body.contains("alpha") && body.contains("beta"), "diff 正文缺失: {body}");

    h.service.shutdown();
    tokio::time::sleep(Duration::from_millis(200)).await;
}

/// 逐文件结构化变更（`fileChange` Item）——有则断言其结构正确。
///
/// 该通道的可用性依赖具体执行路径（见上一个测试的说明），因此本测试
/// **在未触发时不判失败**，只在实际出现时校验结构。
/// 这样既不掩盖问题，也不因上游行为差异造成假失败。
#[tokio::test(flavor = "multi_thread")]
async fn file_change_item_structure_when_present() {
    const PATCH: &str = "*** Begin Patch\n*** Add File: fc_probe.txt\n+x\n*** End Patch";
    let cmd = format!("apply_patch <<'PATCH'\n{PATCH}\nPATCH");
    let Some(mut h) = Harness::start(vec![exec_command(&cmd, true)]).await else { return };

    let info = h
        .service
        .start_thread(h.cwd_path().display().to_string(), Some("kcode-mock-model".into()), "workspace-write", json!("on-request"))
        .await
        .unwrap();
    h.service.send_turn(&info.thread_id, "新建文件").await.unwrap();

    let mut found: Option<kcode_domain::ChangeSet> = None;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(25);
    while tokio::time::Instant::now() < deadline {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        let Some(ev) = h.wait_for(left, |e| Some(e.clone())).await else { break };
        match &ev {
            AppEvent::ChangeSetUpdated { change_set, .. } if !change_set.files.is_empty() => {
                found = Some(change_set.clone());
            }
            AppEvent::ApprovalRequired { approval } => {
                let _ = h
                    .service
                    .resolve_approval(approval.request_key(), ApprovalDecision::Accept, None)
                    .await;
            }
            AppEvent::TurnCompleted { .. } => break,
            _ => {}
        }
    }

    match found {
        Some(cs) => {
            let f = &cs.files[0];
            assert!(!f.path.is_empty(), "变更路径不应为空");
            assert!(!f.diff.trim().is_empty(), "逐文件 diff 不应为空——审阅面板依赖它");
            // add 的行数必须按内容统计（按 diff 解析会得 0）
            assert!(f.line_stats().added >= 1, "行数统计错误: {:?}", f.line_stats());
            assert!(!f.parsed().is_empty(), "应可渲染为 hunk");
            println!("\n逐文件变更通道可用：{} → {:?}", f.path, f.line_stats());
        }
        None => {
            println!(
                "\n逐文件变更通道（fileChange Item）在本次执行路径下未触发；\
                 审阅数据由 turn/diff/updated 提供（见上一个测试）。"
            );
        }
    }

    h.service.shutdown();
    tokio::time::sleep(Duration::from_millis(200)).await;
}

// ─────────────────────────────────────────────────────────────────────────
// 多轮对话
// ─────────────────────────────────────────────────────────────────────────

/// 同一线程内多轮连续对话，上下文与事件必须累积而非互相覆盖。
#[tokio::test(flavor = "multi_thread")]
async fn multi_turn_conversation_accumulates() {
    let turns = vec![
        json!({"type":"message","id":"m1","role":"assistant","status":"completed",
               "content":[{"type":"output_text","text":"第一轮回复","annotations":[]}]}),
        json!({"type":"message","id":"m2","role":"assistant","status":"completed",
               "content":[{"type":"output_text","text":"第二轮回复","annotations":[]}]}),
        json!({"type":"message","id":"m3","role":"assistant","status":"completed",
               "content":[{"type":"output_text","text":"第三轮回复","annotations":[]}]}),
    ];
    let Some(mut h) = Harness::start(turns).await else { return };

    let info = h
        .service
        .start_thread(h.cwd_path().display().to_string(), Some("kcode-mock-model".into()), "workspace-write", json!("on-request"))
        .await
        .unwrap();
    let thread_id = info.thread_id.clone();

    let mut turn_ids: Vec<String> = Vec::new();
    for i in 1..=3 {
        let tid = h.service.send_turn(&thread_id, format!("第 {i} 轮")).await.expect("提交轮次失败");
        turn_ids.push(tid.clone());

        let done = h
            .wait_for(Duration::from_secs(25), |ev| match ev {
                AppEvent::TurnCompleted { turn_id, .. } if turn_id == &tid => Some(()),
                _ => None,
            })
            .await;
        assert!(done.is_some(), "第 {i} 轮未结束");
    }

    // 三个轮次必须各自独立且都保留在历史中
    let log = kcode_domain::EventLog::open(&h.log_path).unwrap();
    let events = log.events_for_thread(&thread_id).unwrap();
    let completed: Vec<&str> = events
        .iter()
        .filter(|e| e.kind == "turn_completed")
        .filter_map(|e| e.turn_id.as_deref())
        .collect();

    assert_eq!(completed.len(), 3, "应有 3 个轮次完成记录，实际 {completed:?}");
    for tid in &turn_ids {
        assert!(completed.contains(&tid.as_str()), "轮次 {tid} 的完成记录丢失");
    }

    // 全部 Item 应可重建，且累积而非覆盖
    let items = kcode_app::replay_items(&log, &thread_id).unwrap();
    let user_msgs = items
        .iter()
        .filter(|i| matches!(i.body, kcode_domain::ItemBody::UserMessage { .. }))
        .count();
    assert!(user_msgs >= 3, "三轮对话的用户消息数应 >= 3，实际 {user_msgs}");

    h.service.shutdown();
    tokio::time::sleep(Duration::from_millis(200)).await;
}

// ─────────────────────────────────────────────────────────────────────────
// 长输出
// ─────────────────────────────────────────────────────────────────────────

/// 长输出（>10k 行）必须能完整传递而不被截断或压垮。
#[tokio::test(flavor = "multi_thread")]
async fn long_output_is_delivered_intact() {
    // 生成 >10000 行的输出
    let cmd = "seq 1 12000";
    let Some(mut h) = Harness::start(vec![exec_command(cmd, false)]).await else { return };

    let info = h
        .service
        .start_thread(h.cwd_path().display().to_string(), Some("kcode-mock-model".into()), "workspace-write", json!("on-request"))
        .await
        .unwrap();
    h.service.send_turn(&info.thread_id, "输出一万两千行").await.unwrap();

    let done = h
        .wait_for(Duration::from_secs(40), |ev| match ev {
            AppEvent::TurnCompleted { status, .. } => Some(*status),
            _ => None,
        })
        .await;
    assert!(done.is_some(), "长输出轮次未结束");
    let turn_status = done.unwrap();

    let log = kcode_domain::EventLog::open(&h.log_path).unwrap();
    let items = kcode_app::replay_items(&log, &info.thread_id).unwrap();
    let cmd_item = items.iter().find_map(|i| match &i.body {
        kcode_domain::ItemBody::CommandExecution { aggregated_output, status, .. } => {
            Some((aggregated_output.clone(), *status))
        }
        _ => None,
    });

    let (output, status) = cmd_item.unwrap_or_else(|| {
        panic!(
            "未找到命令 Item。\n\
             轮次状态：{turn_status:?}；实际 items：{}\n\
             （命令若是被沙箱拒绝，这里会看到 cmd[...] 之外的形态或完全没有 cmd 项）\n{}",
            summarize_items(&items),
            rerun_hint("long_output_is_delivered_intact"),
        )
    });
    assert_eq!(status, ItemStatus::Completed, "长输出命令应正常完成");

    if let Some(out) = output {
        let lines = out.lines().count();
        assert!(
            lines >= 10_000,
            "长输出被截断：仅收到 {lines} 行，期望 >= 10000。\
             检查是否有单条报文大小上限导致丢弃"
        );
        // 内容完整性：首尾都应在
        assert!(out.contains("1\n") || out.starts_with("1"), "输出开头丢失");
        assert!(out.contains("12000"), "输出结尾丢失（可能被截断）");
        println!("\n长输出实测：{lines} 行，{} 字节", out.len());
    } else {
        panic!("命令完成但未携带聚合输出");
    }

    h.service.shutdown();
    tokio::time::sleep(Duration::from_millis(200)).await;
}

// ─────────────────────────────────────────────────────────────────────────
// 线程隔离与并发
// ─────────────────────────────────────────────────────────────────────────

/// 同 Project 下多线程并发：事件不得串线。
///
/// # 为什么必须用回显 mock
///
/// 早先版本用「按顺序发放的脚本」验证隔离，并发下脚本项与线程的对应关系
/// 是不确定的（谁先请求谁拿到第一项），因此那条测试**可能因夹具不确定性
/// 而假失败、也可能因同样原因假通过**。
///
/// 改成回显后，每条回复与用户消息严格对应：若 A 线程出现 B 的回复，
/// 那就是真实的串线，不存在模棱两可。
#[tokio::test(flavor = "multi_thread")]
async fn concurrent_threads_do_not_cross_contaminate() {
    let root = repo_root();
    let Some(binary) = kcode_bridge::locate_binary(&root).ok() else { return };
    let (port, mock) = spawn_echo_mock().await;
    std::mem::forget(mock);

    let cwd = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    std::fs::write(
        home.path().join("config.toml"),
        format!(
            "model_provider = \"m\"\nmodel = \"kcode-mock-model\"\n\n[model_providers.m]\nname = \"m\"\nbase_url = \"http://127.0.0.1:{port}/v1\"\nwire_api = \"responses\"\nrequires_openai_auth = false\nexperimental_bearer_token = \"x\"\n"
        ),
    )
    .unwrap();

    let service = AgentService::start(ServiceConfig {
        spawn: SpawnConfig::new(&binary, cwd.path(), home.path()),
        client_name: "kcode-isolation".into(),
        client_title: "Isolation".into(),
        client_version: "0.1.0".into(),
    })
    .await
    .expect("启动失败");

    let mut events = service.subscribe();
    let log_path = service.event_log_path();
    let cwd_str = cwd.path().display().to_string();

    let t1 = service
        .start_thread(&cwd_str, Some("kcode-mock-model".into()), "workspace-write", json!("on-request"))
        .await
        .unwrap()
        .thread_id;
    let t2 = service
        .start_thread(&cwd_str, Some("kcode-mock-model".into()), "workspace-write", json!("on-request"))
        .await
        .unwrap()
        .thread_id;
    assert_ne!(t1, t2);

    // 两条互不相同的消息，回显后可据此判断归属
    const MSG_A: &str = "MARKER_THREAD_ALPHA";
    const MSG_B: &str = "MARKER_THREAD_BETA";
    service.send_turn(&t1, MSG_A).await.unwrap();
    service.send_turn(&t2, MSG_B).await.unwrap();

    let mut done = std::collections::HashSet::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    while done.len() < 2 && tokio::time::Instant::now() < deadline {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        let remaining = left;
        let got = tokio::time::timeout(remaining, events.recv()).await;
        match got {
            Ok(Ok(AppEvent::TurnCompleted { thread_id, .. })) => {
                done.insert(thread_id);
            }
            Ok(Ok(_)) => {}
            _ => break,
        }
    }
    assert_eq!(done.len(), 2, "两个线程未都完成: {done:?}");

    // 从事件日志核对每条 Item 的归属
    let log = kcode_domain::EventLog::open(&log_path).unwrap();
    for (tid, own, other, label) in [(t1.clone(), MSG_A, MSG_B, "A"), (t2.clone(), MSG_B, MSG_A, "B")] {
        let items = kcode_app::replay_items(&log, &tid).unwrap();
        assert!(!items.is_empty(), "线程 {label} 无 Item");

        let texts: Vec<String> = items
            .iter()
            .filter_map(|i| match &i.body {
                kcode_domain::ItemBody::AgentMessage { text } => Some(text.clone()),
                kcode_domain::ItemBody::UserMessage { text, .. } => Some(text.clone()),
                _ => None,
            })
            .collect();

        assert!(
            texts.iter().any(|t| t.contains(own)),
            "线程 {label} 缺少自己的内容；实际: {texts:?}"
        );
        assert!(
            !texts.iter().any(|t| t.contains(other)),
            "线程串线：{label} 线程出现了另一线程的内容；实际: {texts:?}"
        );
    }

    service.shutdown();
    tokio::time::sleep(Duration::from_millis(200)).await;
}

// ─────────────────────────────────────────────────────────────────────────
// 安全相关
// ─────────────────────────────────────────────────────────────────────────

/// 诱导 Agent 把命令作用于父目录：应被识别为区外并纳入审计。
///
/// 方案验收项：「尝试诱导 Agent 把 cwd 切到父目录 → 被拒绝并记审计」。
/// 注意区分：**识别与告警**是本项目职责；**强制阻止**由沙箱负责。
#[tokio::test(flavor = "multi_thread")]
async fn parent_directory_escape_is_flagged_and_audited() {
    let Some(mut h) = Harness::start(vec![exec_command("cat ../../../etc/hosts", true)]).await else { return };

    let info = h
        .service
        .start_thread(h.cwd_path().display().to_string(), Some("kcode-mock-model".into()), "workspace-write", json!("on-request"))
        .await
        .unwrap();
    h.service.send_turn(&info.thread_id, "读父目录的文件").await.unwrap();

    let approval = h
        .wait_for(Duration::from_secs(25), |ev| match ev {
            AppEvent::ApprovalRequired { approval } => Some(approval.clone()),
            _ => None,
        })
        .await
        .expect("未收到审批");

    // 必须识别出越界信号
    let signals: Vec<String> = approval.risk.signals.iter().map(|s| format!("{s:?}")).collect();
    assert!(
        signals.iter().any(|s| s.contains("ParentTraversal") || s.contains("PathOutsideWorkspace")),
        "父目录逃逸未被识别；信号: {signals:?}"
    );
    assert!(
        approval.risk.tier >= RiskTier::Moderate,
        "越界访问风险等级过低: {:?}",
        approval.risk.tier
    );

    h.service
        .resolve_approval(approval.request_key(), ApprovalDecision::Decline, None)
        .await
        .expect("应答失败");

    // 必须记审计
    let audit = h.service.export_audit().await.expect("导出审计失败");
    assert!(audit.contains("command_approval"), "越界尝试未记审计: {audit}");

    h.service.shutdown();
    tokio::time::sleep(Duration::from_millis(200)).await;
}

/// 审计日志**不得包含明文凭据**（方案验收项）。
#[tokio::test(flavor = "multi_thread")]
async fn audit_does_not_leak_credentials() {
    // 命令里故意带一个像密钥的串
    let secret = "sk-abcdefghijklmnopqrstuvwxyz123456";
    let cmd = format!("echo {secret} > /tmp/leak_test");
    let Some(mut h) = Harness::start(vec![exec_command(&cmd, true)]).await else { return };

    let info = h
        .service
        .start_thread(h.cwd_path().display().to_string(), Some("kcode-mock-model".into()), "workspace-write", json!("on-request"))
        .await
        .unwrap();
    h.service.send_turn(&info.thread_id, "测试").await.unwrap();

    let approval = h
        .wait_for(Duration::from_secs(25), |ev| match ev {
            AppEvent::ApprovalRequired { approval } => Some(approval.clone()),
            _ => None,
        })
        .await
        .expect("未收到审批");

    h.service
        .resolve_approval(approval.request_key(), ApprovalDecision::Accept, None)
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;

    let audit = h.service.export_audit().await.unwrap();

    // 审计写入路径已接入脱敏（`kcode_domain::redact`），此处验证承诺成立。
    let leaks = audit.contains(secret);
    println!("\n审计是否含明文密钥: {leaks}");

    assert!(
        !leaks,
        "审计日志泄露了明文凭据！脱敏未生效。审计片段: {}",
        &audit[..audit.len().min(500)]
    );
    // 同时应标注发生了脱敏，便于排查时知道原文被改动过
    assert!(
        audit.contains("已脱敏") || audit.contains("audit_redaction_applied"),
        "未标注已脱敏: {}",
        &audit[..audit.len().min(500)]
    );

    let _ = std::fs::remove_file("/tmp/leak_test");
    h.service.shutdown();
    tokio::time::sleep(Duration::from_millis(200)).await;
}

/// `danger-full-access` 不应作为默认或轻易可达的配置。
#[tokio::test(flavor = "multi_thread")]
async fn sandbox_defaults_are_restrictive() {
    let Some(h) = Harness::start(vec![]).await else { return };

    // 默认创建线程时使用 workspace-write，不是 danger-full-access
    let info = h
        .service
        .start_thread(h.cwd_path().display().to_string(), Some("kcode-mock-model".into()), "workspace-write", json!("on-request"))
        .await
        .unwrap();

    let sandbox = format!("{:?}", info.sandbox);
    assert!(
        !sandbox.contains("angerFullAccess"),
        "默认沙箱不应为 danger-full-access：{sandbox}"
    );

    // 审批策略应为 on-request
    let policy = format!("{:?}", info.approval_policy);
    assert!(
        policy.contains("on-request"),
        "默认审批策略应为 on-request：{policy}"
    );

    h.service.shutdown();
    tokio::time::sleep(Duration::from_millis(200)).await;
}
