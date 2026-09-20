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
    tokio::time::sleep(Duration::from_secs(2)).await;

    // 不过滤：应至少返回两个
    let all = h.service.list_threads_remote(None).await.expect("列举失败");
    assert!(all.len() >= 2, "应返回至少 2 个线程，实际 {}", all.len());
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
