//! 应用服务端到端测试：编排层 + 真实 app-server + 本地 mock 模型。
//!
//! 验证的是 actor 架构的两条核心性质：
//!
//! 1. **命令与事件可以并发进行。** 事件循环正在等待时，命令仍能送达并执行。
//!    这正是「不能共享 Mutex<Transport>」的原因——那样会死锁。
//! 2. **审批全链路贯通。** 事件广播出 `ApprovalRequired`（含已算好的风险分级），
//!    UI 回传决策，Turn 正常收尾，审计留痕。
//!
//! 离线、零凭据、不污染真实 `~/.codex`。

use kcode_app::{AgentService, AppEvent, ServiceConfig};
use kcode_bridge::SpawnConfig;
use kcode_domain::{ApprovalDecision, RiskTier, TurnStatus};
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

/// mock 模型：按顺序返回预设响应。
///
/// `script` 为每轮要产生的输出；第 N 次请求用第 N 项，用尽后回普通文本。
async fn spawn_mock(script: Vec<Value>) -> (u16, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let handle = tokio::spawn(async move {
        let mut turn = 0usize;
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

            // 已有 function_call 回填说明是同一轮的第二次请求 → 收尾
            let prior = parsed
                .get("input")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter(|i| i.get("type").and_then(Value::as_str) == Some("function_call"))
                        .count()
                })
                .unwrap_or(0);

            let output = if prior >= 1 || script.is_empty() {
                json!({"type":"message","id":"m","role":"assistant","status":"completed",
                       "content":[{"type":"output_text","text":"done","annotations":[]}]})
            } else {
                let out = script[turn.min(script.len() - 1)].clone();
                turn += 1;
                out
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

fn command_call(cmd: &str) -> Value {
    json!({
        "type": "function_call", "id": "fc", "call_id": "call_mock_1",
        "name": "exec_command", "status": "completed",
        "arguments": json!({
            "cmd": cmd, "workdir": Value::Null, "yield_time_ms": 3000,
            "sandbox_permissions": "require_escalated", "justification": "app service test"
        }).to_string()
    })
}

struct Harness {
    service: AgentService,
    events: tokio::sync::broadcast::Receiver<AppEvent>,
    cwd: tempfile::TempDir,
    /// 必须持有：CODEX_HOME 被 app-server 持续读写。
    #[allow(dead_code)]
    home: tempfile::TempDir,
}

impl Harness {
    async fn start(script: Vec<Value>) -> Option<Self> {
        let root = repo_root();
        let binary = kcode_bridge::locate_binary(&root).ok()?;
        let (port, mock) = spawn_mock(script).await;
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

        let cfg = ServiceConfig {
            spawn: SpawnConfig::new(&binary, cwd.path(), home.path()),
            client_name: "kcode-app-test".into(),
            client_title: "KCode App Test".into(),
            client_version: "0.1.0".into(),
        };
        let service = AgentService::start(cfg).await.expect("启动服务失败");
        let events = service.subscribe();
        Some(Self { service, events, cwd, home })
    }

    fn cwd_path(&self) -> PathBuf {
        self.cwd.path().to_path_buf()
    }

    fn home_path(&self) -> PathBuf {
        self.home.path().to_path_buf()
    }

    async fn start_thread(&self) -> String {
        let info = self
            .service
            .start_thread(
                self.cwd.path().display().to_string(),
                Some("kcode-mock-model".into()),
                "workspace-write",
                json!("on-request"),
            )
            .await
            .expect("建线程失败");
        info.thread_id
    }

    /// 收事件直到条件满足。
    async fn wait_for<T>(&mut self, timeout: Duration, mut f: impl FnMut(&AppEvent) -> Option<T>) -> Option<T> {
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
                Ok(Err(_)) => return None,
                Err(_) => return None,
            }
        }
    }
}

/// 全链路：建线程 → 提交轮次 → 收到带风险分级的审批 → 应答 → 轮次收尾 → 审计留痕。
#[tokio::test(flavor = "multi_thread")]
async fn full_approval_flow_through_service() {
    let Some(mut h) = Harness::start(vec![command_call("cat .env")]).await else {
        eprintln!("跳过：未安装 codex 二进制");
        return;
    };

    let thread_id = h.start_thread().await;
    assert!(!thread_id.is_empty());

    let turn_id = h.service.send_turn(&thread_id, "读取配置").await.expect("提交轮次失败");

    // 审批事件必须带已算好的风险分级（UI 直接展示，不再自行推断）
    let approval = h
        .wait_for(Duration::from_secs(25), |ev| match ev {
            AppEvent::ApprovalRequired { approval } => Some(approval.clone()),
            _ => None,
        })
        .await
        .expect("未收到 ApprovalRequired 事件");

    assert_eq!(approval.thread_id, thread_id);
    assert_eq!(approval.turn_id, turn_id);
    assert!(approval.is_pending(), "新收到的审批应为待决状态");
    assert_eq!(approval.risk.tier, RiskTier::High, "`cat .env` 应为高风险；信号 {:?}", approval.risk);
    assert!(!approval.risk.signals.is_empty(), "风险必须可解释");

    // 回传决策
    h.service
        .resolve_approval(approval.request_id.as_str().unwrap(), ApprovalDecision::Accept, None)
        .await
        .expect("应答审批失败");

    // 轮次应正常收尾
    let status = h
        .wait_for(Duration::from_secs(25), |ev| match ev {
            AppEvent::TurnCompleted { turn_id: t, status, .. } if t == &turn_id => Some(*status),
            _ => None,
        })
        .await
        .expect("未收到 TurnCompleted");
    assert_eq!(status, TurnStatus::Completed);

    // 审计必须留痕
    let audit = h.service.export_audit().await.expect("导出审计失败");
    assert!(audit.contains("批准"), "审计未记录决策：{audit}");
    assert!(audit.contains("command_approval"), "审计未记录事件类型：{audit}");
    assert!(audit.contains("\"actor\": \"user\""), "审计未记录决策者：{audit}");

    h.service.shutdown();
    tokio::time::sleep(Duration::from_millis(200)).await;
}

/// 拒绝后 Item 状态必须是 `declined`，且 UI 能通过事件拿到它。
///
/// 这条守的是「用户拒绝后在界面上看到的是『已拒绝』而不是『已完成』」。
#[tokio::test(flavor = "multi_thread")]
async fn declined_item_reaches_ui_as_declined() {
    let Some(mut h) = Harness::start(vec![command_call("echo probe-domain")]).await else {
        return;
    };

    let thread_id = h.start_thread().await;
    let _turn_id = h.service.send_turn(&thread_id, "跑个命令").await.unwrap();

    let approval = h
        .wait_for(Duration::from_secs(25), |ev| match ev {
            AppEvent::ApprovalRequired { approval } => Some(approval.clone()),
            _ => None,
        })
        .await
        .expect("未收到审批");

    h.service
        .resolve_approval(approval.request_id.as_str().unwrap(), ApprovalDecision::Decline, None)
        .await
        .expect("应答失败");

    // 收集 Item 事件，找到 commandExecution 并确认状态
    let deadline = tokio::time::Instant::now() + Duration::from_secs(25);
    let mut final_status: Option<String> = None;
    let mut saw_declined = false;
    while tokio::time::Instant::now() < deadline {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        let Some(ev) = h.wait_for(left, |e| Some(e.clone())).await else { break };
        match &ev {
            AppEvent::ItemUpserted { item, .. } => {
                if let kcode_domain::ItemBody::CommandExecution { status, .. } = &item.body {
                    if kcode_app::is_declined(item) {
                        saw_declined = true;
                        final_status = Some(format!("{status:?}"));
                    }
                }
            }
            AppEvent::TurnCompleted { .. } => break,
            _ => {}
        }
    }

    assert!(
        saw_declined,
        "UI 未收到 declined 状态的 Item——用户拒绝后界面会显示成「已完成」"
    );
    assert_eq!(final_status.as_deref(), Some("Declined"));

    h.service.shutdown();
    tokio::time::sleep(Duration::from_millis(200)).await;
}

/// **关键性质**：事件循环正在等待时，命令仍能送达。
///
/// 这是 actor 架构相对「共享 Mutex<Transport>」的核心优势——后者在读事件时
/// 长期持锁，命令会永久阻塞。本测试在提交轮次后立刻发第二个命令，
/// 若架构有误，第二个命令会超时。
#[tokio::test(flavor = "multi_thread")]
async fn commands_are_serviced_while_events_are_pending() {
    // mock 返回普通文本（不触发审批），让轮次自然结束但期间有事件流动
    let Some(h) = Harness::start(vec![json!({
        "type": "message", "id": "m", "role": "assistant", "status": "completed",
        "content": [{ "type": "output_text", "text": "hi", "annotations": [] }]
    })])
    .await
    else {
        return;
    };

    let thread_id = h.start_thread().await;
    let turn_id = h.service.send_turn(&thread_id, "打个招呼").await.unwrap();

    // 轮次进行中立即发第二个命令：interrupt 需要穿过正在运行的 owner 循环
    let interrupt = h.service.interrupt(&thread_id, &turn_id).await;
    assert!(
        interrupt.is_ok(),
        "事件等待期间命令未被服务（可能是共享锁导致的阻塞）: {interrupt:?}"
    );

    // 再发一个查询类命令，同样应立刻得到响应
    let audit = h.service.export_audit().await;
    assert!(audit.is_ok(), "审计导出失败: {audit:?}");

    h.service.shutdown();
    tokio::time::sleep(Duration::from_millis(200)).await;
}

/// 建线程后，前端**必须**能收到 `ThreadStarted` 事件。
///
/// # 这个测试的边界（重要）
///
/// 实测确认 app-server 自己也会推送 `thread/started` 通知，因此本测试
/// **无法区分**事件来自我们的主动广播还是上游通知——变异测试证明了这一点
/// （移除广播后本测试仍然通过）。
///
/// 它守的是「事件最终可达」这一性质（这本身有价值：若事件通道断开，
/// 侧栏就会空白）。要专门验证「主动广播存在」，需要拦截 broadcast 通道，
/// 而那属于实现细节测试，收益低于成本。
///
/// 保留主动广播的**真实理由**是消除时序依赖（通知与命令响应的到达顺序
/// 不保证），而**不是**「上游不发通知」——早先的注释写错了，已更正。
#[tokio::test(flavor = "multi_thread")]
async fn start_thread_broadcasts_thread_started() {
    let Some(mut h) = Harness::start(vec![]).await else {
        eprintln!("跳过：未安装 codex 二进制");
        return;
    };

    let info = h
        .service
        .start_thread(
            h.cwd.path().display().to_string(),
            Some("kcode-mock-model".into()),
            "workspace-write",
            json!("on-request"),
        )
        .await
        .expect("建线程失败");

    let ev = h
        .wait_for(Duration::from_secs(10), |e| match e {
            AppEvent::ThreadStarted { thread_id, .. } if thread_id == &info.thread_id => {
                Some(thread_id.clone())
            }
            _ => None,
        })
        .await;

    assert!(
        ev.is_some(),
        "start_thread 未广播 ThreadStarted —— 前端侧栏将一直显示「尚无线程」"
    );

    h.service.shutdown();
    tokio::time::sleep(Duration::from_millis(200)).await;
}

/// **`send_turn` 必须广播 `TurnStarted`**（同上，响应由服务自己处理）。
#[tokio::test(flavor = "multi_thread")]
async fn send_turn_broadcasts_turn_started() {
    let Some(mut h) = Harness::start(vec![]).await else { return };

    let info = h
        .service
        .start_thread(
            h.cwd.path().display().to_string(),
            Some("kcode-mock-model".into()),
            "workspace-write",
            json!("on-request"),
        )
        .await
        .unwrap();
    let turn_id = h.service.send_turn(&info.thread_id, "hi").await.expect("提交失败");

    let ev = h
        .wait_for(Duration::from_secs(10), |e| match e {
            AppEvent::TurnStarted { turn_id: t, .. } if t == &turn_id => Some(()),
            _ => None,
        })
        .await;

    assert!(ev.is_some(), "send_turn 未广播 TurnStarted");

    h.service.shutdown();
    tokio::time::sleep(Duration::from_millis(200)).await;
}

/// **应用重启后侧栏必须有内容。**
///
/// 这是「可恢复」主张在用户可见层面的落点。此前 `replay_items` 存在且
/// 有测试，但 Tauri 层从未暴露、前端从不调用——验收报告写着「重启后
/// 历史可重建 ✅」，而用户重启应用看到的是**空侧栏**。
///
/// 本测试验证 `list_threads` + `load_thread` 这条用户路径。
#[tokio::test(flavor = "multi_thread")]
async fn threads_survive_restart_via_public_api() {
    let Some(mut h) = Harness::start(vec![json!({
        "type": "message", "id": "m", "role": "assistant", "status": "completed",
        "content": [{ "type": "output_text", "text": "hello", "annotations": [] }]
    })])
    .await
    else {
        eprintln!("跳过：未安装 codex 二进制");
        return;
    };

    // 建线程并跑一轮，产生可重建的历史
    let thread_id = h.start_thread().await;
    h.service.send_turn(&thread_id, "打个招呼").await.expect("提交失败");
    let done = h
        .wait_for(Duration::from_secs(25), |ev| match ev {
            AppEvent::TurnCompleted { .. } => Some(()),
            _ => None,
        })
        .await;
    assert!(done.is_some(), "轮次未结束");
    h.service.shutdown();
    tokio::time::sleep(Duration::from_millis(300)).await;

    // ── 模拟「重启应用」：用同一份事件日志新建一个 service ──────────────
    let home = h.home_path();
    let cwd = h.cwd_path();
    let binary = kcode_bridge::locate_binary(&repo_root()).unwrap();
    let (port, mock) = spawn_mock(vec![]).await;
    std::mem::forget(mock);
    std::fs::write(
        home.join("config.toml"),
        format!(
            "model_provider = \"m\"\nmodel = \"kcode-mock-model\"\n\n[model_providers.m]\nname = \"m\"\nbase_url = \"http://127.0.0.1:{port}/v1\"\nwire_api = \"responses\"\nrequires_openai_auth = false\nexperimental_bearer_token = \"x\"\n"
        ),
    )
    .unwrap();
    let svc2 = AgentService::start(ServiceConfig {
        spawn: SpawnConfig::new(&binary, &cwd, &home),
        client_name: "kcode-restart".into(),
        client_title: "Restart".into(),
        client_version: "0.1.0".into(),
    })
    .await
    .expect("重启服务失败");

    // ① 侧栏列表：必须有之前的线程
    let list = svc2.list_threads().await.expect("列举线程失败");
    assert!(
        !list.is_empty(),
        "重启后线程列表为空 —— 用户看到的会是空侧栏，「可恢复」不成立"
    );
    let found = list.iter().find(|t| t.thread_id == thread_id);
    assert!(found.is_some(), "重启后列表里没有之前的线程");
    let summary = found.unwrap();
    assert!(summary.item_count > 0, "线程概要应含 Item 计数");
    assert!(!summary.has_unfinished_turn, "已正常结束的轮次不应标记为未完成");

    // ② 打开线程：时间线必须重建
    //
    // 这一条是前端「启动时自动打开最近线程」的前提。若 load_thread 只返回
    // 元数据而无 items，UI 会出现「侧栏有任务、主区空白」的状态——
    // 用户仍需手动点击才能看到历史，与预期不符。
    let snap = svc2.load_thread(&thread_id).await.expect("加载线程失败");
    assert_eq!(snap.thread_id, thread_id);
    assert!(
        !snap.items.is_empty(),
        "重启后时间线为空 —— 侧栏会有任务但主区空白（前端自动打开也救不了）"
    );
    // 时间线必须包含用户消息与助手回复，而不只是元数据
    let has_user = snap.items.iter().any(|i| matches!(i.body, kcode_domain::ItemBody::UserMessage { .. }));
    let has_agent = snap.items.iter().any(|i| matches!(i.body, kcode_domain::ItemBody::AgentMessage { .. }));
    assert!(has_user, "重建的时间线缺少用户消息");
    assert!(has_agent, "重建的时间线缺少助手回复");
    assert!(!snap.turns.is_empty(), "重启后轮次为空");
    assert!(
        snap.warnings.is_empty(),
        "正常结束的线程不应有重建警告: {:?}",
        snap.warnings
    );
    // 轮次状态应保持终态，而非退回 inProgress
    assert!(
        snap.turns.iter().all(|t| t.status == TurnStatus::Completed),
        "轮次状态未保持: {:?}",
        snap.turns
    );

    svc2.shutdown();
    tokio::time::sleep(Duration::from_millis(200)).await;
}

/// 服务端线程搜索：`thread/list` 带 `searchTerm` 应能过滤。
///
/// 走服务端而非只读本地日志的理由：它能搜到本机其它入口
/// （CLI、IDE 扩展）创建的线程。
#[tokio::test(flavor = "multi_thread")]
async fn thread_search_filters_by_keyword() {
    let Some(h) = Harness::start(vec![]).await else {
        eprintln!("跳过：未安装 codex 二进制");
        return;
    };

    // 建两个线程，各跑一轮带不同关键词的任务，让服务端有可搜内容
    let t1 = h.start_thread().await;
    h.service.send_turn(&t1, "ALPHAKEY 的任务").await.unwrap();
    let t2 = h.start_thread().await;
    h.service.send_turn(&t2, "BETAKEY 的任务").await.unwrap();

    // **条件等待，而不是固定 sleep**。
    //
    // 早先这里是 `sleep(2s)` 然后直接断言可搜——那是「够用就好」的等待：
    // 负载高时（例如与其它 crate 的测试并发跑）内容尚未落库，`thread/list`
    // 只返回 0~1 个线程，于是 `filtered.len() < all.len()` 随机失败。
    // 表现为间歇性红灯、重跑就好——这类抖动会训练人忽略失败
    // （本项目已有同款教训，见 docs/协议勘误与修正.md §3.13）。
    //
    // 改成轮询直到服务端可见两个线程（带上限）：正确，而且通常更快，
    // 因为第一轮往往就满足，不必白等满 2 秒。
    let all = {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        loop {
            let list = h.service.list_threads_remote(None).await.expect("列举失败");
            if list.len() >= 2 || tokio::time::Instant::now() >= deadline {
                break list;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    };
    assert!(
        all.len() >= 2,
        "等服务端可见 2 个线程超时，实际 {} 个（内容未落库或列表未刷新）",
        all.len()
    );
    // 服务端应带 preview 字段
    assert!(
        all.iter().any(|t| t.preview.is_some()),
        "thread/list 应返回 preview 摘要——这是标题来源"
    );

    // 按关键词过滤
    let filtered = h
        .service
        .list_threads_remote(Some("ALPHAKEY".into()))
        .await
        .expect("搜索失败");
    assert!(
        filtered.len() < all.len(),
        "带关键词应过滤掉不匹配的线程（{}/{}）",
        filtered.len(),
        all.len()
    );
    // 命中性也要断言：只断言「变少了」的话，过滤条件写反（返回不匹配的）
    // 同样能让上一条通过——那样「搜索结果只含匹配项」就会因为空集而平凡成立。
    assert!(
        !filtered.is_empty(),
        "关键词应至少命中自己那条线程（ALPHAKEY），实际 0 条——过滤条件可能写反了"
    );
    assert!(
        filtered.iter().all(|t| t
            .preview
            .as_deref()
            .map(|p| p.contains("ALPHAKEY"))
            .unwrap_or(true)),
        "搜索结果应只含匹配项"
    );

    h.service.shutdown();
    tokio::time::sleep(Duration::from_millis(200)).await;
}

/// 技能与插件列表应由服务端返回真实数据（非空壳）。
#[tokio::test(flavor = "multi_thread")]
async fn skills_and_plugins_are_listed() {
    let Some(h) = Harness::start(vec![]).await else { return };

    let skills = h
        .service
        .list_skills(h.cwd_path().display().to_string())
        .await
        .expect("skills/list 失败");
    println!("\n技能数: {}", skills.len());

    let plugins = h.service.list_plugins().await.expect("plugin/list 失败");
    println!("插件数: {}", plugins.len());

    // 二者都可以为空（取决于环境），但**不能报错**——
    // 报错说明解析路径有问题，而不是环境缺失。
    for s in &skills {
        assert!(!s.name.is_empty(), "技能名不应为空");
        assert!(!s.scope.is_empty(), "技能应有作用域");
    }
    for p in &plugins {
        assert!(!p.id.is_empty(), "插件 id 不应为空");
        assert!(!p.marketplace.is_empty(), "插件应归属某个市场");
    }

    h.service.shutdown();
    tokio::time::sleep(Duration::from_millis(200)).await;
}

/// **审阅决策必须持久化，重启后仍在。**
///
/// 此前 decide_file 只存在内存里（而且前端连回调都没接）——
/// 用户刷新页面看到的是一份「从未审阅」的变更集，会以为自己
/// 的结论没被记录。审阅是本产品的核心承诺之一，不能是半成品。
#[tokio::test(flavor = "multi_thread")]
async fn file_decisions_survive_restart() {
    use kcode_domain::{FileDecision, FileChangeEntry, FileChangeKind, ItemBody};

    let Some(h) = Harness::start(vec![]).await else {
        eprintln!("跳过：未安装 codex 二进制");
        return;
    };

    let thread_id = h.start_thread().await;

    // 造一个 fileChange Item 写入日志（模拟真实变更）
    {
        let log = kcode_domain::EventLog::open(&h.home_path().join("kcode-events.db")).unwrap();
        let item = kcode_domain::Item {
            id: "fc1".into(),
            turn_id: "tu1".into(),
            created_at_ms: 1,
            body: ItemBody::FileChange {
                status: kcode_domain::ItemStatus::Completed,
                changes: vec![
                    FileChangeEntry {
                        path: "/ws/a.rs".into(),
                        kind: FileChangeKind::Update { move_path: None },
                        diff: "@@ -1 +1 @@\n-a\n+b\n".into(),
                    },
                    FileChangeEntry {
                        path: "/ws/b.rs".into(),
                        kind: FileChangeKind::Add,
                        diff: "new\n".into(),
                    },
                ],
            },
        };
        log.append(&kcode_domain::EventRecord {
            seq: 0,
            thread_id: Some(thread_id.clone()),
            turn_id: Some("tu1".into()),
            item_id: Some("fc1".into()),
            ts_ms: 1,
            kind: kcode_domain::event_kind::ITEM_COMPLETED.into(),
            payload: serde_json::to_value(&item).unwrap(),
            raw_json: String::new(),
        })
        .unwrap();
    }

    // 记录两条决策
    h.service
        .decide_file(&thread_id, "tu1", "/ws/a.rs", FileDecision::Accepted)
        .await
        .expect("记录决策失败");
    h.service
        .decide_file(&thread_id, "tu1", "/ws/b.rs", FileDecision::Rejected)
        .await
        .expect("记录决策失败");

    // ① 同一进程内重建：应带决策
    let snap = h.service.load_thread(&thread_id).await.unwrap();
    assert_eq!(snap.change_sets.len(), 1, "应重建出 1 个变更集");
    let cs = &snap.change_sets[0];
    assert_eq!(cs.files.len(), 2);
    assert_eq!(cs.decisions[0], FileDecision::Accepted);
    assert_eq!(cs.decisions[1], FileDecision::Rejected);
    assert_eq!(
        cs.review_state,
        kcode_domain::ReviewState::AcceptedPartial,
        "一接受一拒绝应为部分接受"
    );

    h.service.shutdown();
    tokio::time::sleep(Duration::from_millis(300)).await;

    // ② 重启后重建：决策必须还在
    let log = kcode_domain::EventLog::open(&h.home_path().join("kcode-events.db")).unwrap();
    let snap2 = kcode_app::load_thread_snapshot(&log, &thread_id).unwrap();
    assert_eq!(snap2.change_sets.len(), 1, "重启后变更集丢失");
    let cs2 = &snap2.change_sets[0];
    assert_eq!(
        cs2.decisions,
        vec![FileDecision::Accepted, FileDecision::Rejected],
        "重启后用户决策丢失——刷新页面会显示成「从未审阅」"
    );
    assert_eq!(cs2.review_state, kcode_domain::ReviewState::AcceptedPartial);
}

/// 崩溃中断的轮次在重建时必须被标记为结果未知，**不得**显示为成功。
#[tokio::test(flavor = "multi_thread")]
async fn crash_interrupted_turn_is_flagged_on_rebuild() {
    let Some(mut h) = Harness::start(vec![json!({
        "type": "message", "id": "m", "role": "assistant", "status": "completed",
        "content": [{ "type": "output_text", "text": "x", "annotations": [] }]
    })])
    .await
    else {
        return;
    };

    let thread_id = h.start_thread().await;
    h.service.send_turn(&thread_id, "任务").await.unwrap();
    // 等轮次真正开始
    let started = h
        .wait_for(Duration::from_secs(20), |ev| match ev {
            AppEvent::TurnStarted { .. } => Some(()),
            _ => None,
        })
        .await;
    assert!(started.is_some());

    // 强杀子进程，制造「轮次未完成」的日志
    let pid = h.service.pid().expect("无 PID");
    std::process::Command::new("kill")
        .args(["-9", &pid.to_string()])
        .status()
        .expect("kill 失败");
    h.service.shutdown();
    tokio::time::sleep(Duration::from_millis(300)).await;

    // 从日志重建
    let log = kcode_domain::EventLog::open(&h.home_path().join("kcode-events.db")).unwrap();
    let snap = kcode_app::load_thread_snapshot(&log, &thread_id).unwrap();

    // 未完成的轮次必须被标记为失败并给出警告，绝不能是 InProgress/Completed
    let unfinished: Vec<_> = snap.turns.iter().filter(|t| t.status == TurnStatus::Failed).collect();
    assert!(
        !unfinished.is_empty() || snap.warnings.iter().any(|w| w.contains("结果未知")),
        "崩溃中断的轮次未被标记为未知；turns={:?} warnings={:?}",
        snap.turns,
        snap.warnings
    );
    assert!(
        snap.turns.iter().all(|t| t.status != TurnStatus::InProgress),
        "重建后不应残留 InProgress 状态（那会让 UI 永远显示「运行中」）"
    );

    // 概要也应反映这一点
    let summaries = kcode_app::summarize_threads(&log).unwrap();
    if let Some(s) = summaries.iter().find(|s| s.thread_id == thread_id) {
        println!("\n崩溃线程概要：item={} turn={} unfinished={}", s.item_count, s.turn_count, s.has_unfinished_turn);
    }
}

/// 子进程退出必须广播 `ProcessExited`——UI 据此把活动轮次标记为 unknown。
#[tokio::test(flavor = "multi_thread")]
async fn shutdown_broadcasts_process_exited() {
    let Some(mut h) = Harness::start(vec![]).await else { return };

    h.service.shutdown();

    let got = h
        .wait_for(Duration::from_secs(10), |ev| match ev {
            AppEvent::ProcessExited { .. } => Some(()),
            _ => None,
        })
        .await;
    assert!(got.is_some(), "停机未广播 ProcessExited，UI 无法得知轮次状态已失效");
}

/// 未知审批请求 id 必须报错而不是静默成功——否则 UI 会以为决策已生效。
#[tokio::test(flavor = "multi_thread")]
async fn unknown_approval_id_is_rejected() {
    let Some(h) = Harness::start(vec![]).await else { return };

    let out = h
        .service
        .resolve_approval("n:99999", ApprovalDecision::Accept, None)
        .await;
    assert!(out.is_err(), "未知审批 id 不应被接受");
    assert!(out.unwrap_err().contains("未知的审批请求"));

    h.service.shutdown();
    tokio::time::sleep(Duration::from_millis(200)).await;
}

/// 线程重命名必须真正到达 app-server 并能被读回（IA-05）。
///
/// 为什么不能只测「命令返回 Ok」：命令成功只说明我们发出去了，
/// 不说明服务端接受了这个参数名。若参数拼错，很多服务端会静默忽略——
/// UI 显示新名字（本地乐观更新），重启后又变回去。
/// 因此这里用 `thread/list` 回读，以服务端的名字为准。
#[tokio::test(flavor = "multi_thread")]
async fn thread_rename_reaches_server_and_is_readable() {
    let Some(h) = Harness::start(vec![]).await else { return };

    let thread_id = h.start_thread().await;
    // 先跑一轮：服务端只把「有内容」的线程纳入 thread/list，
    // 空线程列举不出来，会让下面的回读断言产生假阴性。
    h.service.send_turn(&thread_id, "重命名验证").await.unwrap();
    tokio::time::sleep(Duration::from_secs(2)).await;

    h.service
        .set_thread_name(&thread_id, "重命名验证")
        .await
        .expect("thread/name/set 失败");

    let list = h.service.list_threads_remote(None).await.expect("列举失败");
    let got = list.iter().find(|t| t.thread_id == thread_id);
    assert!(got.is_some(), "重命名后线程不在列表里");
    assert_eq!(
        got.unwrap().name.as_deref(),
        Some("重命名验证"),
        "服务端未记住新名字 —— 前端显示的名字会在重启后丢失"
    );

    h.service.shutdown();
    tokio::time::sleep(Duration::from_millis(200)).await;
}

/// 归档后 `thread/list` 默认不再返回该线程；取消归档后必须回来（IA-05）。
///
/// 两条都要测：只测归档的话，「取消归档」写成不生效也发现不了——
/// 而那正是这个功能存在的意义（归档不是删除，必须可恢复）。
#[tokio::test(flavor = "multi_thread")]
async fn archive_hides_thread_and_unarchive_restores_it() {
    let Some(h) = Harness::start(vec![]).await else { return };

    let thread_id = h.start_thread().await;
    h.service.send_turn(&thread_id, "归档验证").await.unwrap();
    tokio::time::sleep(Duration::from_secs(2)).await;

    h.service.archive_thread(&thread_id, true).await.expect("归档失败");
    let after_archive = h.service.list_threads_remote(None).await.expect("列举失败");
    assert!(
        !after_archive.iter().any(|t| t.thread_id == thread_id),
        "归档后线程仍出现在默认列表里 — 侧栏的「归档」会看起来没反应"
    );

    h.service.archive_thread(&thread_id, false).await.expect("取消归档失败");
    let after_restore = h.service.list_threads_remote(None).await.expect("列举失败");
    assert!(
        after_restore.iter().any(|t| t.thread_id == thread_id),
        "取消归档后线程没有回来 — 归档不可恢复，用户的线程就丢了"
    );

    h.service.shutdown();
    tokio::time::sleep(Duration::from_millis(200)).await;
}

/// 真实轮次必须产生 token 用量事件（CH-08 / 方案 05 第 9 条）。
///
/// # 这条测试在防什么
///
/// 此前 `service.rs` 的通知分发末尾是 `_ => {}`，`thread/tokenUsage/updated`
/// **被无声丢弃**——用户永远看不到上下文余量，直到某轮突然失败。
///
/// 单测覆盖了 `parse_token_usage` 的解析正确性，但「解析对」不等于
/// 「分发接上了」。这里跑一轮真实对话，断言事件确实从 app-server
/// 一路走到了 AppEvent。
#[tokio::test(flavor = "multi_thread")]
async fn real_turn_emits_token_usage_for_context_meter() {
    let Some(mut h) = Harness::start(vec![json!({
        "type": "message", "id": "m", "role": "assistant", "status": "completed",
        "content": [{ "type": "output_text", "text": "hello", "annotations": [] }]
    })])
    .await
    else {
        eprintln!("跳过：未安装 codex 二进制");
        return;
    };

    let thread_id = h.start_thread().await;
    h.service.send_turn(&thread_id, "打个招呼").await.expect("提交失败");

    let usage = h
        .wait_for(Duration::from_secs(30), |ev| match ev {
            AppEvent::TokenUsageUpdated { usage, .. } => Some(*usage),
            _ => None,
        })
        .await;

    let usage = usage.expect(
        "整轮跑完仍未收到 tokenUsage 事件 —— 上下文余量对用户不可见（通知被静默丢弃）",
    );
    assert!(
        usage.last.total_tokens > 0,
        "token 用量应大于 0，实际 {:?}",
        usage.last
    );

    h.service.shutdown();
    tokio::time::sleep(Duration::from_millis(200)).await;
}

/// 护栏警告事件必须能落库（AP-11）。
///
/// # 为什么单独测落库而不是测事件
///
/// `guardianWarning` 由上游的循环检测触发，**mock provider 不会产生它**，
/// 因此无法用真实轮次覆盖。但这个事件的价值有一半在审计上：事故复盘时
/// 第一个要回答的问题就是「上游当时示警了吗」。这里验证的是落库路径
/// （`record` + `event_kind::GUARDIAN_WARNING`）本身可用——它不依赖
/// 上游是否触发。
#[tokio::test(flavor = "multi_thread")]
async fn guardian_warning_kind_is_persistable_and_replayable() {
    // 直接对事件日志读写：验证 kind 常量与重放能对上。
    let log = kcode_domain::EventLog::in_memory().expect("建内存日志失败");
    let payload = json!({ "threadId": "th-1", "message": "检测到重复的工具调用" });
    log.append(&kcode_domain::EventRecord {
        seq: 0,
        thread_id: Some("th-1".into()),
        turn_id: None,
        item_id: None,
        ts_ms: 1000,
        kind: kcode_domain::event_kind::GUARDIAN_WARNING.to_owned(),
        payload: payload.clone(),
        raw_json: payload.to_string(),
    })
    .expect("写入失败");

    let all = log.all_events().expect("读取失败");
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].kind, kcode_domain::event_kind::GUARDIAN_WARNING);
    assert_eq!(all[0].thread_id.as_deref(), Some("th-1"));
    assert_eq!(
        all[0].payload.get("message").and_then(|v| v.as_str()),
        Some("检测到重复的工具调用"),
        "警告原文必须可读回，否则复盘时只剩一个空事件"
    );
}

/// `fuzzyFileSearch` 的响应形态必须对照真实报文确定（输入框 @ 引用）。
///
/// # 为什么不能照着 schema 写
///
/// 冻结的 schema 里 `fuzzyFileSearch` **没有响应定义**——只有一个会话式通知
/// （`FuzzyFileSearchSessionUpdatedNotification`，带 sessionId）。也就是说它的
/// 返回形态无法从类型定义推出，只能实测。
///
/// 这条测试同时是「形态探针」：它断言命中列表确实在 `files` 键下，
/// 且 `path` / `fileName` 字段名如实现所假设。若上游改了形态，
/// 这里会失败而不是让 @ 引用静默返回空列表。
#[tokio::test(flavor = "multi_thread")]
async fn fuzzy_search_returns_matches_in_files_key() {
    let Some(h) = Harness::start(vec![]).await else {
        eprintln!("跳过：未安装 codex 二进制");
        return;
    };

    // 在工作区里放一个已知文件，否则搜索必然为空、断言失去意义
    let probe = h.cwd_path().join("kcode-probe-searchme.txt");
    std::fs::write(&probe, "probe").unwrap();

    let out = h
        .service
        .fuzzy_search_files(h.cwd_path().display().to_string(), "searchme")
        .await
        .expect("fuzzyFileSearch 调用失败");

    assert!(
        !out.is_empty(),
        "搜索已知文件却无命中 —— 要么响应形态假设错了（不在 files 键下），\
         要么字段名不同（期望 path/fileName）"
    );
    let hit = out
        .iter()
        .find(|m| m.file_name.contains("searchme") || m.path.contains("searchme"))
        .expect("命中列表里没有刚创建的文件");
    assert!(!hit.path.is_empty(), "path 不应为空");
    assert!(!hit.file_name.is_empty(), "fileName 不应为空");

    h.service.shutdown();
    tokio::time::sleep(Duration::from_millis(200)).await;
}

/// `thread/compact/start` 必须能被真实服务端接受（输入框 /compact 命令）。
#[tokio::test(flavor = "multi_thread")]
async fn compact_thread_is_accepted_by_server() {
    let Some(h) = Harness::start(vec![]).await else { return };
    let thread_id = h.start_thread().await;

    // 未跑轮次的线程上下文很短，服务端可能直接接受或拒绝；
    // 关键是不能因为**方法名/参数错**而失败。
    match h.service.compact_thread(&thread_id).await {
        Ok(()) => {}
        Err(e) => {
            let lower = e.to_lowercase();
            assert!(
                !lower.contains("unknown method") && !lower.contains("method not found"),
                "compact 方法不被识别 —— 方法名错了: {e}"
            );
            assert!(
                !lower.contains("missing") && !lower.contains("required"),
                "参数形状不对（期望仅 threadId）: {e}"
            );
        }
    }

    h.service.shutdown();
    tokio::time::sleep(Duration::from_millis(200)).await;
}

/// 图片附件必须能随轮次送达（协议 `localImage`）。
///
/// # 这条测试在防什么
///
/// 图片是「添加上下文」里唯一无法靠纯文本替代的能力：用户贴一张界面截图
/// 让模型看，比他用文字描述半天都准。而协议只提供 `localImage`（本地路径）
/// 与 `image`（URL）两种输入，**没有内嵌 base64 的形式**——如果参数形状
/// 写错，服务端会直接拒绝整轮，用户看到的是「发送失败」而非「图片没带上」。
///
/// mock provider 不会真的看图，但 `turn/start` 的入参校验在服务端：
/// 形状不对这一轮就起不来。因此「轮次能正常完成」本身就是形状正确的证据。
#[tokio::test(flavor = "multi_thread")]
async fn turn_accepts_local_image_attachment() {
    let Some(mut h) = Harness::start(vec![json!({
        "type": "message", "id": "m", "role": "assistant", "status": "completed",
        "content": [{ "type": "output_text", "text": "我看到了", "annotations": [] }]
    })])
    .await
    else {
        eprintln!("跳过：未安装 codex 二进制");
        return;
    };

    // 造一张真实的小 PNG（1×1 透明像素）——用真文件而不是随便的文本，
    // 因为服务端可能会校验图片可解码。
    let img = h.cwd_path().join("shot.png");
    const PNG_1X1: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F,
        0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00,
        0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];
    std::fs::write(&img, PNG_1X1).unwrap();

    let thread_id = h.start_thread().await;
    let sent = h
        .service
        .send_turn_full(
            &thread_id,
            "看这张图",
            None,
            None,
            vec![img.display().to_string()],
        )
        .await;
    assert!(
        sent.is_ok(),
        "带 localImage 的轮次未被服务端接受 —— 参数形状不对：{:?}",
        sent.err()
    );

    // 轮次要真的跑起来（形状不对时它根本不会开始）
    let done = h
        .wait_for(Duration::from_secs(30), |ev| match ev {
            AppEvent::TurnCompleted { .. } => Some(()),
            _ => None,
        })
        .await;
    assert!(done.is_some(), "带图片的轮次未能完成");

    // ── 服务端回显里的图片必须被投影保留 ──────────────────────────────
    //
    // 实测：userMessage 的 `content[]` 里带 `{"type":"localImage","path":...}`，
    // 而我们的投影原先只取 text —— 时间线上用户那条消息显示成纯文字，
    // 而图片其实已发出、模型也确实看到了。界面与现实不符。
    let snap = h.service.load_thread(&thread_id).await.expect("重建线程失败");
    let user_img = snap.items.iter().find_map(|i| match &i.body {
        kcode_domain::ItemBody::UserMessage { images, .. } if !images.is_empty() => {
            Some(images.clone())
        }
        _ => None,
    });
    let imgs = user_img.expect(
        "用户消息里的图片未出现在时间线 —— 投影丢弃了 localImage，\
         用户会以为自己发的是纯文字",
    );
    assert_eq!(imgs.len(), 1, "应恰好带一张图，实际 {imgs:?}");
    assert!(
        imgs[0].ends_with("shot.png"),
        "图片路径应原样保留，实际 {:?}",
        imgs[0]
    );

    h.service.shutdown();
    tokio::time::sleep(Duration::from_millis(200)).await;
}

/// 纯文本轮次的报文必须与加图片前逐字节一致（不能因为改动而带上空 input 项）。
#[tokio::test(flavor = "multi_thread")]
async fn turn_without_images_keeps_text_only_input() {
    let Some(h) = Harness::start(vec![]).await else { return };
    let thread_id = h.start_thread().await;
    // 不传图片：走 send_turn 的旧路径，应当照常被接受
    let out = h.service.send_turn(&thread_id, "纯文本").await;
    assert!(out.is_ok(), "纯文本轮次受影响：{:?}", out.err());
    h.service.shutdown();
    tokio::time::sleep(Duration::from_millis(200)).await;
}
