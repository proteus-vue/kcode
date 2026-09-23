//! 领域层与真实 app-server 的端到端集成测试。
//!
//! 验证的是**完整链路**：协议报文 → 投影 → 领域状态 → 事件日志。
//! 前面的 `session.rs` 单测验证投影逻辑本身，这里验证它在真实进程下也成立——
//! 尤其是那些容易在「想象中」成立的假设（例如 `declined` 真的会出现、
//! 审批请求的字段真的齐全）。
//!
//! 离线、零凭据、不污染真实 `~/.codex`。

use kcode_bridge::{locate_binary, Incoming, JsonlTransport, SpawnConfig};
use kcode_domain::{
    event_kind, ApprovalDecision, EventLog, EventRecord, Projector, TurnStatus,
};
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

/// mock 模型：返回一条需要提权的命令调用。
async fn spawn_mock(command: String) -> (u16, tokio::task::JoinHandle<()>) {
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
                        "cmd": command,
                        "workdir": Value::Null,
                        "yield_time_ms": 3000,
                        "sandbox_permissions": "require_escalated",
                        "justification": "domain integration test"
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

struct Harness {
    transport: JsonlTransport,
    cwd: tempfile::TempDir,
    log: EventLog,
    projector: Projector,
    console: Vec<Incoming>,
    _home: tempfile::TempDir,
}

impl Harness {
    async fn start(command: &str) -> Option<Self> {
        let binary = locate_binary(&repo_root()).ok()?;
        let (port, mock) = spawn_mock(command.to_owned()).await;
        // mock 任务随测试结束中止即可
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

        let cfg = SpawnConfig::new(&binary, cwd.path(), home.path());
        let mut transport = JsonlTransport::spawn(&cfg).await.unwrap();
        transport
            .initialize("kcode-domain-test", "KCode", "0.1.0", Some(cfg.codex_home.as_path()))
            .await
            .unwrap();

        let projector = Projector::new(cwd.path());
        Some(Self {
            transport,
            log: EventLog::in_memory().unwrap(),
            projector,
            console: Vec::new(),
            cwd,
            _home: home,
        })
    }

    fn record(&self, kind: &str, payload: Value, raw: String, thread: Option<&str>, turn: Option<&str>, item: Option<&str>) {
        let _ = self.log.append(&EventRecord {
            seq: 0,
            thread_id: thread.map(str::to_owned),
            turn_id: turn.map(str::to_owned),
            item_id: item.map(str::to_owned),
            ts_ms: 0,
            kind: kind.to_owned(),
            payload,
            raw_json: raw,
        });
    }

    /// 跑一轮：建线程、提交轮次、投影事件，直到轮次收尾。
    async fn run_turn(
        &mut self,
        decision: Option<ApprovalDecision>,
    ) -> (String, String, Option<kcode_domain::Approval>, TurnStatus) {
        self.run_turn_with_timeout(decision, Duration::from_secs(30)).await
    }

    /// 带观察超时的版本：未应答审批的用例不需要干等满 30 秒。
    async fn run_turn_with_timeout(
        &mut self,
        decision: Option<ApprovalDecision>,
        observe_for: Duration,
    ) -> (String, String, Option<kcode_domain::Approval>, TurnStatus) {
        let started = self
            .transport
            .request(
                "thread/start",
                json!({"cwd": self.cwd.path(), "approvalPolicy": "on-request",
                       "sandbox": "workspace-write", "model": "kcode-mock-model"}),
            )
            .await
            .unwrap();
        let thread_id = started["thread"]["id"].as_str().unwrap().to_owned();
        self.record(event_kind::THREAD_STARTED, started.clone(), started.to_string(), Some(&thread_id), None, None);

        let turn_resp = self
            .transport
            .request(
                "turn/start",
                json!({"threadId": thread_id, "input":[{"type":"text","text":"run"}]}),
            )
            .await
            .unwrap();
        let turn_id = turn_resp["turn"]["id"].as_str().unwrap().to_owned();
        self.record(event_kind::TURN_STARTED, turn_resp.clone(), turn_resp.to_string(), Some(&thread_id), Some(&turn_id), None);

        let mut approval_out = None;
        let mut final_status = TurnStatus::InProgress;

        let deadline = tokio::time::Instant::now() + observe_for;
        while tokio::time::Instant::now() < deadline {
            let left = deadline.saturating_duration_since(tokio::time::Instant::now());
            let Some(ev) = self.transport.next_inbound(left).await else { break };

            // ── 服务端请求：投影为领域 Approval，并（可选地）应答 ──────
            if let Incoming::ServerRequest { id, method, params } = &ev {
                if ev.is_approval_request() {
                    let approval = self.projector.project_approval(method, &json!(id.key()), params);
                    self.record(
                        event_kind::APPROVAL_REQUESTED,
                        serde_json::to_value(&approval).unwrap(),
                        ev.to_string_debug(),
                        Some(&approval.thread_id),
                        Some(&approval.turn_id),
                        Some(&approval.item_id),
                    );
                    if let Some(d) = &decision {
                        self.transport
                            .respond(id, approval_response_for(method, d))
                            .await
                            .unwrap();
                        self.log
                            .append_audit(
                                &kcode_domain::AuditEntry::new(
                                    "command_approval",
                                    "user",
                                    approval.summary.clone(),
                                    0,
                                )
                                .with_risk(approval.risk.tier.label_zh())
                                .with_decision(d.label_zh()),
                            )
                            .unwrap();
                    }
                    approval_out = Some(approval);
                }
                continue;
            }

            if let Incoming::Notification { method, params } = &ev {
                match method.as_str() {
                    "item/started" | "item/completed" => {
                        let turn = params["turnId"].as_str().unwrap_or(&turn_id);
                        let item = self.projector.project_item(&thread_id, turn, &params["item"]);
                        let kind = if method == "item/started" {
                            event_kind::ITEM_STARTED
                        } else {
                            event_kind::ITEM_COMPLETED
                        };
                        self.record(
                            kind,
                            serde_json::to_value(&item).unwrap(),
                            params.to_string(),
                            Some(&thread_id),
                            Some(turn),
                            Some(&item.id),
                        );
                    }
                    "serverRequest/resolved" => {
                        self.record(
                            event_kind::SERVER_REQUEST_RESOLVED,
                            params.clone(),
                            params.to_string(),
                            Some(&thread_id),
                            Some(&turn_id),
                            None,
                        );
                    }
                    "turn/completed" => {
                        final_status = Projector::project_turn_status(&params["turn"])
                            .unwrap_or(TurnStatus::Failed);
                        self.record(
                            event_kind::TURN_COMPLETED,
                            params.clone(),
                            params.to_string(),
                            Some(&thread_id),
                            Some(&turn_id),
                            None,
                        );
                        self.console.push(ev);
                        // **不立刻 break**：`turn/completed` 与各个 item 的
                        // `item/completed` 之间**没有顺序保证**，高负载下命令项的
                        // 完成事件可能晚于此到达。原先一收到 turn/completed 就
                        // 退出循环，于是断言「未找到完成的 commandExecution item」
                        // 间歇失败（本机与 CI 都出现过，单独重跑就好——
                        // 这类抖动会训练人忽略红灯）。
                        //
                        // **条件等待**（而不是固定宽限期）：轮询直到「已收到
                        // 结束的 commandExecution item」或超时。
                        //
                        // 一开始写成固定 500ms，高负载下仍会失败——因为负载高时
                        // 迟到可能超过这个数。固定时长是在赌延迟上界，而正确的
                        // 判据是「目标状态是否出现」。这与本项目一贯的等待纪律
                        // 一致：条件探测 + 上限，而不是 sleep（见 §3.13 的同类
                        // 教训：夹具不确定性会同时制造假阴性与假阳性）。
                        let grace = tokio::time::Instant::now() + Duration::from_secs(10);
                        loop {
                            // 已收到结束的命令项 → 不必再等
                            let seen_done = self
                                .log
                                .all_events()
                                .map(|evs| {
                                    evs.iter().any(|e| {
                                        e.kind == event_kind::ITEM_COMPLETED
                                            && e.payload["body"]["kind"].as_str()
                                                == Some("commandExecution")
                                    })
                                })
                                .unwrap_or(false);
                            if seen_done {
                                break;
                            }
                            let left = grace.saturating_duration_since(tokio::time::Instant::now());
                            if left.is_zero() {
                                break;
                            }
                            let Some(next) = self.transport.next_inbound(left).await else { break };
                            if let Incoming::Notification { method, params } = &next {
                                if method == "item/started" || method == "item/completed" {
                                    let turn = params["turnId"].as_str().unwrap_or(&turn_id);
                                    let item =
                                        self.projector.project_item(&thread_id, turn, &params["item"]);
                                    let kind = if method == "item/started" {
                                        event_kind::ITEM_STARTED
                                    } else {
                                        event_kind::ITEM_COMPLETED
                                    };
                                    self.record(
                                        kind,
                                        serde_json::to_value(&item).unwrap(),
                                        params.to_string(),
                                        Some(&thread_id),
                                        Some(turn),
                                        Some(&item.id),
                                    );
                                }
                            }
                            self.console.push(next);
                        }
                        break;
                    }
                    _ => {}
                }
            }
            self.console.push(ev);
        }

        (thread_id, turn_id, approval_out, final_status)
    }
}

/// 按审批方法选择正确的响应体。
fn approval_response_for(method: &str, d: &ApprovalDecision) -> Value {
    if method == "item/permissions/requestApproval" {
        json!({ "permissions": {}, "scope": "turn" })
    } else {
        json!({ "decision": d.to_protocol_value() })
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn approval_projects_to_domain_with_risk_and_audit() {
    let Some(mut h) = Harness::start("cat .env").await else {
        eprintln!("跳过：未安装 codex 二进制");
        return;
    };

    let (thread_id, turn_id, approval, status) = h.run_turn(Some(ApprovalDecision::Accept)).await;

    let a = approval.expect("未捕获到审批请求");
    assert_eq!(a.thread_id, thread_id);
    assert_eq!(a.turn_id, turn_id);
    assert!(!a.item_id.is_empty(), "itemId 必须存在（可追溯性依赖它）");
    assert!(a.is_pending() || a.decision.is_none());

    // 风险分级必须在投影时就完成，且 `cat .env` 应被判为阻塞级
    assert!(
        a.risk.is_blocking(),
        "`cat .env` 应触发高风险；实际 {:?}",
        a.risk
    );
    assert!(
        !a.risk.signals.is_empty(),
        "风险判定必须附带可解释的信号（UI 要回答「为什么」）"
    );

    assert_eq!(status, TurnStatus::Completed);

    // 事件日志应完整记录本轮
    let events = h.log.events_for_thread(&thread_id).unwrap();
    let kinds: Vec<&str> = events.iter().map(|e| e.kind.as_str()).collect();
    for expected in [event_kind::THREAD_STARTED, event_kind::TURN_STARTED, event_kind::APPROVAL_REQUESTED, event_kind::TURN_COMPLETED] {
        assert!(kinds.contains(&expected), "事件日志缺少 {expected}；实际 {kinds:?}");
    }

    // 审计必须留痕，且自动/人工都要记
    let audit = h.log.audit_entries().unwrap();
    assert!(!audit.is_empty(), "审批必须写入审计日志");
    assert_eq!(audit[0].actor, "user");
    assert!(audit[0].risk_tier.is_some(), "审计应含风险等级");

    h.transport.shutdown().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn declined_item_projects_as_declined_not_completed() {
    let Some(mut h) = Harness::start("echo outside > /tmp/kcode_domain_decline_probe").await else {
        return;
    };

    let (_thread, _turn, _approval, _status) = h.run_turn(Some(ApprovalDecision::Decline)).await;

    // 从事件日志里找 commandExecution item，验证状态是 declined
    let events = h.log.all_events().unwrap();
    let mut saw_declined = false;
    let mut saw_command_item = false;
    for e in &events {
        if e.kind == event_kind::ITEM_COMPLETED {
            let body_type = e.payload.get("body").and_then(|b| b.get("kind")).and_then(Value::as_str);
            if body_type == Some("commandExecution") {
                saw_command_item = true;
                let status = e.payload["body"]["status"].as_str().unwrap_or("");
                assert_eq!(
                    status, "declined",
                    "被拒绝的命令投影后状态应为 declined，实际 `{status}`；\
                     若这里是 completed，UI 会把「未执行」显示成「已完成」"
                );
                saw_declined = true;
            }
        }
    }
    assert!(saw_command_item, "未在事件日志中找到 commandExecution item");
    assert!(saw_declined, "未观察到 declined 状态");
    let _ = std::fs::remove_file("/tmp/kcode_domain_decline_probe");

    h.transport.shutdown().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn accepted_command_completes_with_exit_code() {
    let Some(mut h) = Harness::start("echo hello-domain").await else { return };

    let (_t, _u, _a, status) = h.run_turn(Some(ApprovalDecision::Accept)).await;
    assert_eq!(status, TurnStatus::Completed);

    let events = h.log.all_events().unwrap();
    let cmd_items: Vec<_> = events
        .iter()
        .filter(|e| {
            (e.kind == event_kind::ITEM_COMPLETED || e.kind == event_kind::ITEM_STARTED)
                && e.payload["body"]["kind"].as_str() == Some("commandExecution")
        })
        .collect();

    let completed: Vec<_> = cmd_items
        .iter()
        .filter(|e| e.kind == event_kind::ITEM_COMPLETED)
        .collect();
    assert!(!completed.is_empty(), "未找到完成的 commandExecution item");
    // 取最后一条：命令可能先以 inProgress 收尾（yield），再真正完成
    let last = completed.last().unwrap();
    assert_eq!(last.payload["body"]["status"], "completed");
    // 字段名必须是 camelCase——这条断言曾经抓出 serde 变体字段未重命名的真实缺陷
    assert_eq!(
        last.payload["body"]["exitCode"], 0,
        "exitCode 缺失或为 null；若这里是 Null，检查投影是否取了正确字段名。         原始载荷: {}",
        last.raw_json
    );
    assert!(last.payload["body"]["exitCode"].is_number());

    h.transport.shutdown().await.ok();
}

/// 未决审批时不响应，验证超时后不会把状态误判为完成。
#[tokio::test(flavor = "multi_thread")]
async fn unanswered_approval_does_not_report_success() {
    let Some(mut h) = Harness::start("echo probe").await else { return };

    // decision=None：捕获审批但不应答。
    // 只需观察数秒即可确认「没有任何收尾事件到来」——协议不会在未解决审批时
    // 推进轮次，因此无需干等满 30 秒（那会让 CI 白花 30 秒）。
    let (_t, _u, approval, status) = h
        .run_turn_with_timeout(None, Duration::from_secs(4))
        .await;

    assert!(approval.is_some(), "应捕获到审批请求");
    assert!(
        status != TurnStatus::Completed || approval.is_some(),
        "未应答的审批不应导致 Turn 被判定为顺利完成"
    );
    // 关键：状态必须停留在 inProgress（或明确失败），绝不能静默变成 completed
    assert!(
        matches!(status, TurnStatus::InProgress | TurnStatus::Failed | TurnStatus::Interrupted),
        "未应答审批时状态不应是 {status:?}"
    );

    h.transport.shutdown().await.ok();
}

/// 兜底：`Incoming` 无 Display，测试里用的调试输出辅助。
trait IncomingDebugExt {
    fn to_string_debug(&self) -> String;
}

impl IncomingDebugExt for Incoming {
    fn to_string_debug(&self) -> String {
        format!("{self:?}")
    }
}
